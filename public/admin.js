const $ = (id) => document.getElementById(id);

const socket = io();
let adminSessionCode = "";
let playerCount = 0;
let currentPhase = "Waiting";

function roleLabel(role) {
  if (role === "ai") return "🤖 KI";
  if (role === "prompt_ai") return "🧠 Prompt-AI";
  if (role === "human") return "🙂 Mensch";
  return "—";
}

function renderRoleList(players = [], roundType = null) {
  const root = $("adminRoleList");
  if (!root) return;
  if (!players.length) {
    root.textContent = "Keine Spieler in dieser Session.";
    return;
  }
  root.innerHTML = "";
  for (const player of players) {
    const row = document.createElement("div");
    row.className = "admin-role-row";
    const status = player.alive ? "" : " (raus)";
    row.textContent = `${player.avatar || "🙂"} ${player.name || "Spieler"}: ${roleLabel(player.role)}${status}`;
    root.appendChild(row);
  }
  if (roundType === "detect_human") {
    const hint = document.createElement("div");
    hint.className = "muted";
    hint.textContent = "Modus B: Keine echte KI. Prompt-AI bekommt Vorschläge.";
    root.appendChild(hint);
  }
}

function normalize(code) {
  const c = (code || "").trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(c) ? c : "";
}

function setAdminUIState({ sessionCode, phase, count, error }) {
  if (typeof sessionCode !== "undefined") {
    $("adminSessionStatus").textContent = sessionCode || "—";
  }
  if (typeof count !== "undefined") {
    $("adminPlayerCount").textContent = String(count);
  }
  if (typeof phase !== "undefined") {
    $("adminPhase").textContent = phase || "Waiting";
  }
  if (typeof error !== "undefined") {
    $("adminError").textContent = error || "";
  }
}

function getSessionCode() {
  const code = normalize($("code").value);
  if (!code) {
    setAdminUIState({ error: "Session-Code ungültig (3–8 Zeichen A-Z/0-9)." });
    return null;
  }
  setAdminUIState({ error: "" });
  return code;
}

function updateButtons() {
  const code = getSessionCode();
  const hasPlayers = playerCount >= 3;
  const canStart = Boolean(code) && hasPlayers;
  $("btnStartDetectAI").disabled = !canStart;
  $("btnStartDetectHuman").disabled = !canStart;

  const inLobby = currentPhase === "LOBBY" || currentPhase === "Waiting";
  $("btnReveal").disabled = !code || inLobby || currentPhase !== "ANSWERING";
  $("btnVoting").disabled = !code || currentPhase !== "REVEAL";
  $("btnResolve").disabled = !code || (currentPhase !== "VOTING" && currentPhase !== "TIEBREAK");
}

function watchSession() {
  const code = normalize($("code").value);
  if (!code) {
    adminSessionCode = "";
    setAdminUIState({ sessionCode: "—", phase: "Waiting", count: 0 });
    renderRoleList([]);
    updateButtons();
    return;
  }
  if (code === adminSessionCode) return;
  adminSessionCode = code;
  playerCount = 0;
  currentPhase = "Waiting";
  socket.emit("admin_watch", { sessionCode: adminSessionCode });
  setAdminUIState({ sessionCode: adminSessionCode, count: playerCount, phase: currentPhase });
  renderRoleList([]);
  updateButtons();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || ("HTTP " + res.status));
  return data;
}

async function handleAction(path, payload) {
  try {
    setAdminUIState({ error: "" });
    await api(path, payload);
  } catch (err) {
    setAdminUIState({ error: `API-Fehler: ${err.message}` });
  }
}

$("code").addEventListener("input", () => {
  watchSession();
});

$("btnStartDetectAI").onclick = async () => {
  const sessionCode = getSessionCode();
  if (!sessionCode) return;
  await handleAction("/api/admin/start", { sessionCode, roundType: "detect_ai" });
};

$("btnStartDetectHuman").onclick = async () => {
  const sessionCode = getSessionCode();
  if (!sessionCode) return;
  await handleAction("/api/admin/start", { sessionCode, roundType: "detect_human" });
};

$("btnReveal").onclick = async () => {
  const sessionCode = getSessionCode();
  if (!sessionCode) return;
  await handleAction("/api/admin/reveal", { sessionCode });
};

$("btnVoting").onclick = async () => {
  const sessionCode = getSessionCode();
  if (!sessionCode) return;
  await handleAction("/api/admin/voting", { sessionCode });
};

$("btnResolve").onclick = async () => {
  const sessionCode = getSessionCode();
  if (!sessionCode) return;
  await handleAction("/api/admin/resolve", { sessionCode });
};

socket.on("phase_update", (state) => {
  if (!adminSessionCode) return;
  currentPhase = state.phase || currentPhase;
  setAdminUIState({ phase: currentPhase });
  updateButtons();
});

socket.on("players_update", (state) => {
  if (!adminSessionCode) return;
  playerCount = Array.isArray(state.players) ? state.players.length : playerCount;
  setAdminUIState({ count: playerCount });
  updateButtons();
});

socket.on("admin_state", (state) => {
  if (!adminSessionCode) return;
  if (state?.phase) {
    currentPhase = state.phase;
    setAdminUIState({ phase: currentPhase });
  }
  const players = Array.isArray(state?.players) ? state.players : [];
  playerCount = players.length;
  setAdminUIState({ count: playerCount });
  renderRoleList(players, state?.roundType || null);
  updateButtons();
});

setAdminUIState({ sessionCode: "—", count: 0, phase: "Waiting", error: "" });
renderRoleList([]);
updateButtons();
