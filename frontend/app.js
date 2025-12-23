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

  rows.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${r.team}</td>
      <td>${r.points_1x2}</td>
      <td>${r.bonus}</td>
      <td>${r.coach}</td>
      <td><strong>${r.total}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  qs("table").hidden = false;
}

async function load() {
  setError(null);
  qs("table").hidden = true;

  const res = await fetch(`${API_BASE}/api/season/standings`);
  const data = await res.json();

  if (!res.ok) {
    setError(data?.detail || data?.error || `Error ${res.status}`);
    return;
  }

  render(data.rows || []);
}

qs("reload").addEventListener("click", load);
load();
