const API_BASE = window.location.origin;
const qs = (id) => document.getElementById(id);

function setError(msg) {
  const el = qs("error");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
}

function render(rows) {
  const tbody = qs("tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.team}</td>
      <td>${r.points_1x2}</td>
      <td>${r.bonus}</td>
      <td>${r.coach_points}</td>
      <td><strong>${r.total_round}</strong></td>
    `;
    tbody.appendChild(tr);
  }
  qs("table").hidden = false;
}

async function load() {
  setError(null);
  qs("table").hidden = true;

  const matchday = Number(qs("matchday").value || 1);
  const res = await fetch(`${API_BASE}/api/rounds/${matchday}/scoreboard`);
  const data = await res.json();

  if (!res.ok || data.error) {
    setError(data.error || JSON.stringify(data));
    return;
  }

  qs("meta").textContent = `Scoreboard matchday ${data.matchday}`;
  render(data.rows || []);
}

qs("load").addEventListener("click", load);
