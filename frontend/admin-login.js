const ADMIN_PASSWORD = "change-me";
const ADMIN_AUTH_KEY = "fantasy_admin_auth_v1";
const ADMIN_AUTH_TTL_MS = 12 * 60 * 60 * 1000;

const qs = (id) => document.getElementById(id);

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

function getReturnTarget() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("return") || "admin.html";
  if (value.includes("..") || value.includes("://") || value.startsWith("/")) {
    return "admin.html";
  }
  return value;
}

function setError(msg) {
  const el = qs("error");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.textContent = msg;
}

if (isAdminAuthed()) {
  window.location.href = `./${getReturnTarget()}`;
}

qs("loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  setError(null);

  const password = qs("password").value.trim();
  if (!password) {
    setError("Vul het wachtwoord in.");
    return;
  }

  if (password !== ADMIN_PASSWORD) {
    setError("Onjuist wachtwoord.");
    return;
  }

  localStorage.setItem(ADMIN_AUTH_KEY, JSON.stringify({ ts: Date.now() }));
  window.location.href = `./${getReturnTarget()}`;
});
