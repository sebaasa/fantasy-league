const API_BASE = window.location.origin;
const qs = (id) => document.getElementById(id);

const ADMIN_AUTH_KEY = "fantasy_admin_auth_v1";
const ADMIN_AUTH_TTL_MS = 12 * 60 * 60 * 1000;

function isAdminAuthed() {
  const raw = localStorage.getItem(ADMIN_AUTH_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data.ts !== "number") return false;
    return (Date.now() - data.ts) < ADMIN_AUTH_TTL_MS;
  } catch {
    return false;
  }
}

function enforceAdminAuth() {
  if (isAdminAuthed()) return true;
  const returnTo = encodeURIComponent("admin.html");
  window.location.href = `./admin-login.html?return=${returnTo}`;
  return false;
}

if (!enforceAdminAuth()) {
  throw new Error("Admin auth required.");
}

qs("apiBaseLabel").textContent = API_BASE;

let teams = [];
let matches = []; // from /api/rounds/{matchday}/matches

function setError(msg) {
  const el = qs("error");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
}

function setOk(msg) {
  const el = qs("ok");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
  setTimeout(() => { el.hidden = true; el.textContent = ""; }, 2500);
}

function setStatus(msg) {
  qs("statusText").textContent = msg;
}

function getMatchday() {
  return Number(qs("matchday").value || 1);
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const errMsg = (data && (data.detail || data.error)) ? (data.detail || data.error) : `${res.status} ${res.statusText}`;
    throw new Error(errMsg);
  }
  return data;
}

function fmtDate(utc) {
  if (!utc) return "";
  try {
    const d = new Date(utc);
    return d.toLocaleString();
  } catch {
    return utc;
  }
}

function matchLabel(m) {
  return `${m.home} vs ${m.away}`;
}

function outcomeFromScore(m) {
  if (m.score_home == null || m.score_away == null) return "";
  if (m.score_home > m.score_away) return "1";
  if (m.score_home < m.score_away) return "2";
  return "X";
}

// ---------- Init ----------

async function init() {
  setError(null);
  setStatus("Loading teams…");
  try {
    teams = await apiFetch("/api/teams");
    buildPredictionsUI();
    buildCoachUI();
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
}

init();

// ---------- Round actions ----------

qs("btnSync").addEventListener("click", async () => {
  setError(null);
  setOk(null);
  const matchday = getMatchday();
  setStatus(`Syncing matchday ${matchday}…`);
  try {
    const data = await apiFetch(`/api/rounds/${matchday}/sync`, { method: "POST" });
    setOk(`Synced matchday ${matchday} (inserted: ${data.inserted}, updated: ${data.updated})`);
    setStatus("Loading matches…");
    await loadMatches();
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
});

qs("btnLoad").addEventListener("click", async () => {
  setError(null);
  setOk(null);
  setStatus("Loading matches…");
  try {
    await loadMatches();
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
});

qs("btnScoreboard").addEventListener("click", async () => {
  setError(null);
  setOk(null);
  const matchday = getMatchday();
  setStatus(`Fetching scoreboard matchday ${matchday}…`);
  try {
    const data = await apiFetch(`/api/rounds/${matchday}/scoreboard`);
    const top = data.rows?.[0];
    setOk(top ? `Top: ${top.team} (${top.total_round})` : "Geen scoreboard data.");
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
});

qs("btnLogout").addEventListener("click", () => {
  localStorage.removeItem(ADMIN_AUTH_KEY);
  window.location.href = "./admin-login.html";
});

// ---------- Matches & Odds ----------

async function loadMatches() {
  const matchday = getMatchday();
  matches = await apiFetch(`/api/rounds/${matchday}/matches`);

  renderMatchesTable();
  refreshMatchDropdowns();

  // NEW: load existing values after matches are available (so dropdowns can select match_id)
  try {
    await loadExistingCoachPoints();
  } catch (_) { /* ignore if none yet */ }

  try {
    await loadExistingPredictions();
  } catch (_) { /* ignore if none yet */ }
}

async function loadExistingCoachPoints() {
  const matchday = getMatchday();
  const data = await apiFetch(`/api/rounds/${matchday}/coach`);

  const map = data.coach_points || {};
  for (const t of teams) {
    const input = document.querySelector(`input[data-coach="${cssEscape(t.name)}"]`);
    if (input) input.value = (map[t.name] ?? 0);
  }
}

async function loadExistingPredictions() {
  const matchday = getMatchday();
  const data = await apiFetch(`/api/rounds/${matchday}/predictions`);

  const preds = data.predictions || {};

  // Clear all selects first
  for (const t of teams) {
    for (let slot = 0; slot < 5; slot++) {
      const ms = document.querySelector(`select.matchSelect[data-team="${cssEscape(t.name)}"][data-slot="${slot}"]`);
      const ps = document.querySelector(`select.pickSelect[data-team="${cssEscape(t.name)}"][data-slot="${slot}"]`);
      if (ms) ms.value = "";
      if (ps) ps.value = "1";
    }
  }

  // Fill with existing picks (first 5, ordered as returned)
  for (const t of teams) {
    const arr = preds[t.name] || [];
    for (let i = 0; i < Math.min(arr.length, 5); i++) {
      const ms = document.querySelector(`select.matchSelect[data-team="${cssEscape(t.name)}"][data-slot="${i}"]`);
      const ps = document.querySelector(`select.pickSelect[data-team="${cssEscape(t.name)}"][data-slot="${i}"]`);
      if (ms) ms.value = String(arr[i].match_id);
      if (ps) ps.value = arr[i].pick;
    }
  }
}

function renderMatchesTable() {
  const table = qs("matchesTable");
  const tbody = qs("matchesTbody");
  const noMatches = qs("noMatches");

  tbody.innerHTML = "";

  if (!matches || matches.length === 0) {
    table.hidden = true;
    noMatches.hidden = false;
    return;
  }

  noMatches.hidden = true;
  table.hidden = false;

  for (const m of matches) {
    const tr = document.createElement("tr");

    const odd1 = (m.odd_1 ?? "").toString();
    const oddx = (m.odd_x ?? "").toString();
    const odd2 = (m.odd_2 ?? "").toString();

    tr.innerHTML = `
      <td>${m.id}</td>
      <td>${matchLabel(m)}</td>
      <td>${fmtDate(m.utc_date)}</td>
      <td>${m.status ?? ""}</td>
      <td>${m.score_home ?? ""} - ${m.score_away ?? ""} <span class="small">${outcomeFromScore(m)}</span></td>
      <td><input data-odd="1" data-id="${m.id}" value="${odd1}" placeholder="e.g. 1.85" /></td>
      <td><input data-odd="x" data-id="${m.id}" value="${oddx}" placeholder="e.g. 3.60" /></td>
      <td><input data-odd="2" data-id="${m.id}" value="${odd2}" placeholder="e.g. 4.20" /></td>
      <td><button class="btn-secondary" data-save-odds="${m.id}">Save odds</button></td>
    `;

    tbody.appendChild(tr);
  }

  // wire buttons
  tbody.querySelectorAll("button[data-save-odds]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const matchId = btn.getAttribute("data-save-odds");
      await saveOddsForMatch(Number(matchId));
    });
  });
}

async function saveOddsForMatch(matchId) {
  setError(null);
  setOk(null);

  const inputs = qs("matchesTbody").querySelectorAll(`input[data-id="${matchId}"]`);
  let o1 = null, ox = null, o2 = null;

  inputs.forEach(inp => {
    const kind = inp.getAttribute("data-odd");
    const v = inp.value.trim();
    const num = v === "" ? null : Number(v);
    if (v !== "" && Number.isNaN(num)) return;

    if (kind === "1") o1 = num;
    if (kind === "x") ox = num;
    if (kind === "2") o2 = num;
  });

  const q = new URLSearchParams();
  if (o1 !== null) q.set("odd_1", String(o1));
  if (ox !== null) q.set("odd_x", String(ox));
  if (o2 !== null) q.set("odd_2", String(o2));

  setStatus(`Saving odds for match ${matchId}…`);
  try {
    await apiFetch(`/api/matches/${matchId}/odds?${q.toString()}`, { method: "PUT" });
    setOk(`Odds saved for match ${matchId}`);
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
}

// ---------- Predictions UI ----------

function buildPredictionsUI() {
  const wrap = qs("predictionsWrap");
  wrap.innerHTML = "";

  for (const t of teams) {
    const card = document.createElement("div");
    card.className = "mutedbox";

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div><strong>${t.name}</strong></div>
        <button class="btn-secondary" data-save-team="${t.name}">Opslaan</button>
      </div>
      <div class="small" style="margin:6px 0 10px 0;">Kies 5 matches + pick.</div>

      <div class="grid" data-team-grid="${t.name}">
        ${[0,1,2,3,4].map(i => `
          <div class="row">
            <label>
              Match
              <select data-team="${t.name}" data-slot="${i}" class="matchSelect">
                <option value="">— kies match —</option>
              </select>
            </label>
            <label>
              Pick
              <select data-team="${t.name}" data-slot="${i}" class="pickSelect">
                <option value="1">1</option>
                <option value="X">X</option>
                <option value="2">2</option>
              </select>
            </label>
          </div>
        `).join("")}
      </div>
      <div class="small" data-team-hint="${t.name}" style="margin-top:10px;"></div>
    `;

    wrap.appendChild(card);
  }

  // wire save buttons
  wrap.querySelectorAll("button[data-save-team]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const teamName = btn.getAttribute("data-save-team");
      await saveTeamPredictions(teamName);
    });
  });
}

function refreshMatchDropdowns() {
  // fill all match dropdowns with loaded matches
  const selects = document.querySelectorAll("select.matchSelect");
  selects.forEach(sel => {
    const current = sel.value;
    sel.innerHTML = `<option value="">— kies match —</option>`;
    for (const m of matches) {
      const opt = document.createElement("option");
      opt.value = String(m.id);
      opt.textContent = `#${m.id} — ${matchLabel(m)} (${fmtDate(m.utc_date)})`;
      sel.appendChild(opt);
    }
    // try restore if still exists
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }
  });
}

async function saveTeamPredictions(teamName) {
  setError(null);
  setOk(null);

  const matchday = getMatchday();

  // gather 5 slots
  const matchSelects = document.querySelectorAll(`select.matchSelect[data-team="${cssEscape(teamName)}"]`);
  const pickSelects = document.querySelectorAll(`select.pickSelect[data-team="${cssEscape(teamName)}"]`);

  const picks = [];
  for (let i = 0; i < 5; i++) {
    const ms = [...matchSelects].find(s => Number(s.getAttribute("data-slot")) === i);
    const ps = [...pickSelects].find(s => Number(s.getAttribute("data-slot")) === i);
    const matchId = ms?.value ? Number(ms.value) : null;
    const pick = ps?.value || "1";
    picks.push({ match_id: matchId, pick });
  }

  // validation: exactly 5 chosen and unique
  const chosen = picks.filter(p => p.match_id != null);
  const hint = qs("predictionsWrap").querySelector(`[data-team-hint="${cssEscape(teamName)}"]`);

  if (chosen.length !== 5) {
    hint.textContent = `Je hebt ${chosen.length}/5 matches gekozen.`;
    throwUIError(`Team "${teamName}": kies precies 5 matches.`);
    return;
  }
  const ids = chosen.map(p => p.match_id);
  if (new Set(ids).size !== 5) {
    hint.textContent = "Dubbele match gekozen. Kies 5 unieke matches.";
    throwUIError(`Team "${teamName}": picks bevatten dubbele matches.`);
    return;
  }

  hint.textContent = "";

  setStatus(`Saving predictions for ${teamName} (matchday ${matchday})…`);
  try {
    await apiFetch(
      `/api/rounds/${matchday}/predictions/${encodeURIComponent(teamName)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chosen),
      }
    );
    setOk(`Predictions saved: ${teamName}`);
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
}

function throwUIError(msg) {
  setError(msg);
  setStatus("Error");
}

// CSS.escape polyfill-ish for team names in selectors
function cssEscape(str) {
  // use browser native if present
  if (window.CSS && CSS.escape) return CSS.escape(str);
  return str.replace(/"/g, '\\"');
}

// ---------- Coach points UI ----------

function buildCoachUI() {
  const wrap = qs("coachWrap");
  wrap.innerHTML = "";

  for (const t of teams) {
    const box = document.createElement("div");
    box.className = "mutedbox";
    box.innerHTML = `
      <div><strong>${t.name}</strong></div>
      <label style="margin-top:8px;">
        Coach punten
        <input type="number" min="0" step="1" value="0" data-coach="${t.name}" />
      </label>
      <div style="margin-top:10px;">
        <button class="btn-secondary" data-save-coach="${t.name}">Opslaan</button>
      </div>
    `;
    wrap.appendChild(box);
  }

  wrap.querySelectorAll("button[data-save-coach]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const teamName = btn.getAttribute("data-save-coach");
      await saveCoach(teamName);
    });
  });

  qs("btnSaveAllCoach").addEventListener("click", saveAllCoach);
}

async function saveCoach(teamName) {
  setError(null);
  setOk(null);

  const matchday = getMatchday();
  const input = document.querySelector(`input[data-coach="${cssEscape(teamName)}"]`);
  const points = Number(input?.value ?? 0);

  if (Number.isNaN(points) || points < 0) {
    setError(`Coachpunten ongeldig voor ${teamName}`);
    return;
  }

  setStatus(`Saving coach points for ${teamName}…`);
  try {
    await apiFetch(`/api/rounds/${matchday}/coach/${encodeURIComponent(teamName)}?points=${encodeURIComponent(points)}`, {
      method: "PUT",
    });
    setOk(`Coach points saved: ${teamName}`);
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
}

async function saveAllCoach() {
  setError(null);
  setOk(null);

  const matchday = getMatchday();
  setStatus(`Saving all coach points (matchday ${matchday})…`);

  try {
    for (const t of teams) {
      const input = document.querySelector(`input[data-coach="${cssEscape(t.name)}"]`);
      const points = Number(input?.value ?? 0);
      await apiFetch(`/api/rounds/${matchday}/coach/${encodeURIComponent(t.name)}?points=${encodeURIComponent(points)}`, {
        method: "PUT",
      });
    }
    setOk("All coach points saved.");
    setStatus("Ready");
  } catch (e) {
    setError(e.message);
    setStatus("Error");
  }
}
