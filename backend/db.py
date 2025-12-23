import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "app.db"

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  matchday INTEGER UNIQUE NOT NULL,
  season INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  api_match_id INTEGER UNIQUE,
  utc_date TEXT,
  status TEXT,
  home TEXT,
  away TEXT,
  score_home INTEGER,
  score_away INTEGER,
  FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE
);

-- Handmatig invulbare odds (Unibet) per match
CREATE TABLE IF NOT EXISTS odds (
  match_id INTEGER PRIMARY KEY,
  odd_1 REAL,
  odd_x REAL,
  odd_2 REAL,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  pick TEXT NOT NULL CHECK (pick IN ('1','X','2')),
  UNIQUE(round_id, team_id, match_id),
  FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
);

-- Coach van het jaar: handmatig punten per ronde per team
CREATE TABLE IF NOT EXISTS coach_points (
  round_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(round_id, team_id),
  FOREIGN KEY(round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);
"""

TEAM_NAMES = [
  "Roovertjes",
  "Narren United",
  "TripleB",
  "MML9878",
  "MarTim Lol",
  "Oddsjagers",
  "Verlult",
]

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db():
    conn = connect()
    conn.executescript(SCHEMA)
    # seed teams
    for name in TEAM_NAMES:
        conn.execute("INSERT OR IGNORE INTO teams(name) VALUES (?)", (name,))
    conn.commit()
    conn.close()
