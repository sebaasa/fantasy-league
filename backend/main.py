from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
import os
import time
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.db import connect, init_db

LEAGUE_NAME = "Narren Uiengaardinho MoreSwagPrinsCent-KempJagers"
COMPETITION_CODE = "DED"  # Eredivisie in football-data.org

# simpele in-memory cache om rate-limits te sparen
_cache = {}  # key -> (ts, data)

def cache_get(key: str, max_age: int):
    item = _cache.get(key)
    if not item:
        return None
    ts, data = item
    if time.time() - ts > max_age:
        return None
    return data

def cache_set(key: str, data):
    _cache[key] = (time.time(), data)

app = FastAPI(title=LEAGUE_NAME)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def _startup():
    init_db()

@app.get("/api/meta")
def meta():
    return {"league_name": LEAGUE_NAME, "teams": get_teams()}

@app.get("/api/teams")
def get_teams():
    conn = connect()
    rows = conn.execute("SELECT id, name FROM teams ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/rounds/{matchday}")
def create_round(matchday: int, season: int | None = None):
    conn = connect()
    conn.execute(
        "INSERT OR IGNORE INTO rounds(matchday, season) VALUES (?, ?)",
        (matchday, season),
    )
    conn.commit()
    round_row = conn.execute("SELECT * FROM rounds WHERE matchday = ?", (matchday,)).fetchone()
    conn.close()
    return dict(round_row)

@app.get("/api/rounds")
def list_rounds():
    conn = connect()
    rows = conn.execute("SELECT * FROM rounds ORDER BY matchday DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/rounds/{matchday}/sync")
def sync_round_matches(matchday: int, season: int | None = None):
    token = os.getenv("FOOTBALL_DATA_TOKEN")
    if not token:
        raise HTTPException(400, "Missing FOOTBALL_DATA_TOKEN environment variable.")

    # ensure round exists
    round_obj = create_round(matchday, season)
    round_id = round_obj["id"]

    key = f"matches_{matchday}_{season or 'current'}"
    cached = cache_get(key, max_age=300)
    if cached:
        matches_json = cached
    else:
        url = f"https://api.football-data.org/v4/competitions/{COMPETITION_CODE}/matches"
        headers = {"X-Auth-Token": token}
        params = {"matchday": matchday}
        if season is not None:
            params["season"] = season
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code == 403:
            raise HTTPException(403, "403 from football-data.org (token/plan/rate-limit).")
        r.raise_for_status()
        matches_json = r.json()
        cache_set(key, matches_json)

    conn = connect()

    inserted = 0
    updated = 0

    for m in matches_json.get("matches", []):
        api_match_id = m.get("id")
        utc_date = m.get("utcDate")
        status = m.get("status")
        home = (m.get("homeTeam") or {}).get("name")
        away = (m.get("awayTeam") or {}).get("name")

        score = (m.get("score") or {}).get("fullTime") or {}
        score_home = score.get("home")
        score_away = score.get("away")

        existing = conn.execute(
            "SELECT id FROM matches WHERE api_match_id = ?",
            (api_match_id,),
        ).fetchone()

        if existing:
            conn.execute(
                """UPDATE matches
                   SET round_id=?, utc_date=?, status=?, home=?, away=?, score_home=?, score_away=?
                   WHERE api_match_id=?""",
                (round_id, utc_date, status, home, away, score_home, score_away, api_match_id),
            )
            updated += 1
        else:
            conn.execute(
                """INSERT INTO matches(round_id, api_match_id, utc_date, status, home, away, score_home, score_away)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (round_id, api_match_id, utc_date, status, home, away, score_home, score_away),
            )
            inserted += 1

    conn.commit()
    conn.close()

    return {"round": round_obj, "inserted": inserted, "updated": updated}

@app.get("/api/rounds/{matchday}/matches")
def get_round_matches(matchday: int):
    conn = connect()
    round_row = conn.execute("SELECT id FROM rounds WHERE matchday=?", (matchday,)).fetchone()
    if not round_row:
        conn.close()
        raise HTTPException(404, "Round not found. Create it first.")
    round_id = round_row["id"]

    rows = conn.execute(
        """SELECT m.*, o.odd_1, o.odd_x, o.odd_2
           FROM matches m
           LEFT JOIN odds o ON o.match_id = m.id
           WHERE m.round_id = ?
           ORDER BY utc_date ASC""",
        (round_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.put("/api/matches/{match_id}/odds")
def set_odds(match_id: int, odd_1: float | None = None, odd_x: float | None = None, odd_2: float | None = None):
    conn = connect()
    # upsert
    conn.execute(
        """INSERT INTO odds(match_id, odd_1, odd_x, odd_2)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(match_id) DO UPDATE SET
             odd_1=excluded.odd_1,
             odd_x=excluded.odd_x,
             odd_2=excluded.odd_2""",
        (match_id, odd_1, odd_x, odd_2),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/rounds/{matchday}/predictions/{team_name}")
def set_team_predictions(matchday: int, team_name: str, picks: list[dict]):
    """
    picks = [{"match_id": 123, "pick": "1"}, ...] exact 5 items
    """
    if len(picks) != 5:
        raise HTTPException(400, "Each team must submit exactly 5 picks.")

    conn = connect()
    round_row = conn.execute("SELECT id FROM rounds WHERE matchday=?", (matchday,)).fetchone()
    if not round_row:
        conn.close()
        raise HTTPException(404, "Round not found. Create/sync it first.")
    round_id = round_row["id"]

    team = conn.execute("SELECT id FROM teams WHERE name=?", (team_name,)).fetchone()
    if not team:
        conn.close()
        raise HTTPException(404, "Unknown team.")
    team_id = team["id"]

    match_ids = [p.get("match_id") for p in picks]
    if len(set(match_ids)) != 5:
        conn.close()
        raise HTTPException(400, "Duplicate match_id in picks.")
    # make sure match belongs to round
    q = "SELECT id FROM matches WHERE round_id=? AND id IN (%s)" % ",".join(["?"] * 5)
    found = conn.execute(q, (round_id, *match_ids)).fetchall()
    if len(found) != 5:
        conn.close()
        raise HTTPException(400, "All picks must be matches from this round.")

    # replace existing picks for those matches
    for p in picks:
        pick = p.get("pick")
        if pick not in ("1", "X", "2"):
            conn.close()
            raise HTTPException(400, "pick must be '1', 'X', or '2'.")
        conn.execute(
            """INSERT INTO predictions(round_id, team_id, match_id, pick)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(round_id, team_id, match_id) DO UPDATE SET pick=excluded.pick""",
            (round_id, team_id, p["match_id"], pick),
        )

    conn.commit()
    conn.close()
    return {"ok": True}

@app.put("/api/rounds/{matchday}/coach/{team_name}")
def set_coach_points(matchday: int, team_name: str, points: int):
    conn = connect()
    round_row = conn.execute("SELECT id FROM rounds WHERE matchday=?", (matchday,)).fetchone()
    if not round_row:
        conn.close()
        raise HTTPException(404, "Round not found.")
    round_id = round_row["id"]

    team = conn.execute("SELECT id FROM teams WHERE name=?", (team_name,)).fetchone()
    if not team:
        conn.close()
        raise HTTPException(404, "Unknown team.")
    team_id = team["id"]

    conn.execute(
        """INSERT INTO coach_points(round_id, team_id, points)
           VALUES (?, ?, ?)
           ON CONFLICT(round_id, team_id) DO UPDATE SET points=excluded.points""",
        (round_id, team_id, points),
    )
    conn.commit()
    conn.close()
    return {"ok": True}

def outcome(score_home, score_away):
    if score_home is None or score_away is None:
        return None
    if score_home > score_away:
        return "1"
    if score_home < score_away:
        return "2"
    return "X"

def odd_for_pick(row, pick):
    # row has odd_1, odd_x, odd_2
    return {"1": row["odd_1"], "X": row["odd_x"], "2": row["odd_2"]}.get(pick)

@app.get("/api/rounds/{matchday}/scoreboard")
def scoreboard(matchday: int):
    conn = connect()
    round_row = conn.execute("SELECT id FROM rounds WHERE matchday=?", (matchday,)).fetchone()
    if not round_row:
        conn.close()
        raise HTTPException(404, "Round not found.")
    round_id = round_row["id"]

    teams = conn.execute("SELECT id, name FROM teams").fetchall()

    # load matches + odds
    matches = conn.execute(
        """SELECT m.*, o.odd_1, o.odd_x, o.odd_2
           FROM matches m
           LEFT JOIN odds o ON o.match_id = m.id
           WHERE m.round_id=?""",
        (round_id,),
    ).fetchall()

    # predictions
    preds = conn.execute(
        """SELECT p.team_id, p.match_id, p.pick
           FROM predictions p
           WHERE p.round_id=?""",
        (round_id,),
    ).fetchall()

    preds_by_team = {}
    for p in preds:
        preds_by_team.setdefault(p["team_id"], []).append(p)

    coach = conn.execute(
        "SELECT team_id, points FROM coach_points WHERE round_id=?",
        (round_id,),
    ).fetchall()
    coach_by_team = {c["team_id"]: c["points"] for c in coach}

    # calculate 1X2 points = sum(correct ? odd : 0)
    results = []
    for t in teams:
        team_id = t["id"]
        picks = preds_by_team.get(team_id, [])
        points_1x2 = 0.0

        for p in picks:
            m = next((mm for mm in matches if mm["id"] == p["match_id"]), None)
            if not m:
                continue
            out = outcome(m["score_home"], m["score_away"])
            if out is None:
                continue  # match not finished -> no points yet
            if p["pick"] == out:
                odd = odd_for_pick(m, p["pick"])
                if odd is not None:
                    points_1x2 += float(odd)

        results.append({
            "team": t["name"],
            "points_1x2": round(points_1x2, 3),
            "coach_points": int(coach_by_team.get(team_id, 0)),
        })

    # weekly bonus: +2 split among top scorers of 1X2
    if results:
        max_score = max(r["points_1x2"] for r in results)
        winners = [r for r in results if r["points_1x2"] == max_score]
        bonus_each = 0.0
        if max_score > 0 and len(winners) > 0:
            bonus_each = 2.0 / len(winners)

        for r in results:
            r["bonus"] = round(bonus_each if r["points_1x2"] == max_score and max_score > 0 else 0.0, 3)
            r["total_round"] = round(r["points_1x2"] + r["bonus"] + r["coach_points"], 3)

    conn.close()

    # sort: total_round desc
    results.sort(key=lambda r: r["total_round"], reverse=True)
    return {"matchday": matchday, "rows": results}
@app.get("/api/rounds/{matchday}/predictions")
def get_predictions(matchday: int):
    conn = connect()
    round_row = conn.execute("SELECT id FROM rounds WHERE matchday=?", (matchday,)).fetchone()
    if not round_row:
        conn.close()
        raise HTTPException(404, "Round not found.")
    round_id = round_row["id"]

    rows = conn.execute(
        """SELECT t.name AS team, p.match_id, p.pick
           FROM predictions p
           JOIN teams t ON t.id = p.team_id
           WHERE p.round_id = ?
           ORDER BY t.name ASC, p.match_id ASC""",
        (round_id,),
    ).fetchall()
    conn.close()

    # return grouped by team (handig voor admin)
    grouped = {}
    for r in rows:
        grouped.setdefault(r["team"], []).append({"match_id": r["match_id"], "pick": r["pick"]})
    return {"matchday": matchday, "predictions": grouped}


@app.get("/api/rounds/{matchday}/coach")
def get_coach_points(matchday: int):
    conn = connect()
    round_row = conn.execute("SELECT id FROM rounds WHERE matchday=?", (matchday,)).fetchone()
    if not round_row:
        conn.close()
        raise HTTPException(404, "Round not found.")
    round_id = round_row["id"]

    rows = conn.execute(
        """SELECT t.name AS team, c.points
           FROM coach_points c
           JOIN teams t ON t.id = c.team_id
           WHERE c.round_id = ?
           ORDER BY t.name ASC""",
        (round_id,),
    ).fetchall()
    conn.close()

    return {
        "matchday": matchday,
        "coach_points": {r["team"]: r["points"] for r in rows},
    }

BASE_DIR = Path(__file__).resolve().parent.parent

app.mount(
    "/",
    StaticFiles(directory=BASE_DIR / "frontend", html=True),
    name="frontend",
)

