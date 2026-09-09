const socket = io();
const $ = (id) => document.getElementById(id);

let myId = null;
let myName = "";
let myAvatar = "🙂";
let currentSessionCode = "";
let sessionCode = "";
let players = [];
let selectedAvatar = "🙂";
let promptOptions = [];
let questionMasterId = null;
let isSpectator = false;
let isGameOver = false;
let isPromptAI = false;
let myRole = "human";
let aiSuggestions = [];
let aiShownOptions = [];
let selectedAiAnswer = "";
let currentPhase = "";
let tiebreakCandidates = null;
let tiebreakEndsAt = null;
let tiebreakTimerId = null;

const avatars = ["🙂","😺","🦊","🐸","🦄","🤖","👾","🧠","🐙","🦖"];

function pickRandom(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = $("themeToggle");
  if (toggle) toggle.textContent = theme === "dark" ? "Dark" : "Light";
}

const savedTheme = localStorage.getItem("theme") || "dark";
applyTheme(savedTheme);
const toggleButton = $("themeToggle");
if (toggleButton) {
  toggleButton.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", nextTheme);
    applyTheme(nextTheme);
  });
}

function showOverlay({ tone = "mint", tag = "", title = "", sub = "", ms = 1400 }) {
  const overlay = $("overlay");
  const overlayTag = $("overlayTag");
  const overlayTitle = $("overlayTitle");
  const overlaySub = $("overlaySub");
  if (!overlay || !overlayTag || !overlayTitle || !overlaySub) return;
  overlayTag.textContent = tag;
  overlayTitle.textContent = title;
  overlaySub.textContent = sub;
  overlay.classList.remove("hidden", "overlay--mint", "overlay--event");
  overlay.classList.add(tone === "event" ? "overlay--event" : "overlay--mint");
  overlay.setAttribute("aria-hidden", "false");
  window.clearTimeout(showOverlay._timeoutId);
  showOverlay._timeoutId = window.setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }, ms);
}

function setDot(state) {
  const dot = $("dot");
  dot.classList.remove("ok","warn","bad");
  dot.classList.add(state);
}
function setStatus(text, state="warn") {
  $("status").textContent = text;
  setDot(state);
}
function setJoinHint(text) {
  $("joinHint").textContent = text || "";
}
function setPromptAIBanner(visible) {
  const banner = $("promptAIBanner");
  if (!banner) return;
  banner.classList.toggle("hidden", !visible);
}
function showWarning(text) {
  const toast = $("warningToast");
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove("hidden");
  window.clearTimeout(showWarning._timeoutId);
  showWarning._timeoutId = window.setTimeout(() => {
    toast.classList.add("hidden");
  }, 2000);
}
function setTiebreakBanner(visible) {
  const banner = $("tiebreakBanner");
  if (!banner) return;
  banner.classList.toggle("hidden", !visible);
}
function setTiebreakTimer(text) {
  const timer = $("tiebreakTimer");
  if (!timer) return;
  if (text) {
    timer.textContent = text;
    timer.classList.remove("hidden");
  } else {
    timer.classList.add("hidden");
  }
}
function setLobbyMeta() {
  $("roomStatus").textContent = sessionCode ? `· Lobby: ${sessionCode}` : "";
  $("playerCount").textContent = (sessionCode && players?.length >= 0) ? `· Spieler: ${players.length}` : "";
  const lobbyCode = $("lobbyCode");
  const lobbyCount = $("lobbyCount");
  if (lobbyCode) lobbyCode.textContent = sessionCode || "—";
  if (lobbyCount) lobbyCount.textContent = String(players.length || 0);
}

function updateMeBadge() {
  const meBadge = $("meBadge");
  if (!meBadge) return;
  meBadge.innerHTML = "";
  const avatar = document.createElement("div");
  avatar.className = "lobby-avatar";
  avatar.textContent = myAvatar || selectedAvatar || "🙂";
  const name = document.createElement("div");
  name.className = "lobby-name";
  name.textContent = myName || "Spieler";
  meBadge.appendChild(avatar);
  meBadge.appendChild(name);
}

function showGame() {
  $("joinScreen").classList.add("hidden");
  $("lobbyScreen").classList.add("hidden");
  $("game").classList.remove("hidden");
}
function showJoinScreen() {
  $("game").classList.add("hidden");
  $("lobbyScreen").classList.add("hidden");
  $("joinScreen").classList.remove("hidden");
}
function showLobbyScreen() {
  $("game").classList.add("hidden");
  $("joinScreen").classList.add("hidden");
  $("lobbyScreen").classList.remove("hidden");
}

function renderLobbyPlayers(list) {
  const lobbyPlayers = $("lobbyPlayers");
  if (!lobbyPlayers) return;
  lobbyPlayers.innerHTML = "";
  for (const player of list) {
    const row = document.createElement("div");
    row.className = `lobby-row${player.id === myId ? " me" : ""}`;
    const chip = document.createElement("div");
    chip.className = "lobby-avatar";
    chip.textContent = player.avatar || "🙂";
    const name = document.createElement("div");
    name.className = "lobby-name";
    name.textContent = player.name || "Spieler";
    row.appendChild(chip);
    row.appendChild(name);
    lobbyPlayers.appendChild(row);
  }
}

function renderPromptPicker() {
  const picker = $("promptPicker");
  const optionsRoot = $("promptOptions");
  const hint = $("promptPickerHint");
  if (!picker || !optionsRoot || !hint) return;
  const isQM = myId && myId === questionMasterId;
  optionsRoot.innerHTML = "";
  if (!isQM) {
    hint.textContent = "QM wählt eine Frage…";
    return;
  }
  if (!promptOptions.length) {
    hint.textContent = "Optionen werden geladen…";
    return;
  }
  hint.textContent = "";
  for (const option of promptOptions) {
    const btn = document.createElement("button");
    btn.className = "prompt-option";
    btn.textContent = option.prompt;
    btn.onclick = () => socket.emit("choose_prompt", { promptId: option.id });
    optionsRoot.appendChild(btn);
  }
}

function setSpectatorMode(enabled) {
  isSpectator = enabled;
  const answerInput = $("answer");
  const sendButton = $("sendAnswer");
  if (answerInput) answerInput.disabled = enabled;
  if (sendButton) sendButton.disabled = enabled;
  if (enabled) {
    $("answerInfo").textContent = "Du bist Zuschauer.";
  }
}

function setGameOverState(enabled) {
  isGameOver = enabled;
  const answerInput = $("answer");
  const sendButton = $("sendAnswer");
  if (answerInput) answerInput.disabled = enabled;
  if (sendButton) sendButton.disabled = enabled;
  const voteInfo = $("voteInfo");
  const voteList = $("voteList");
  if (enabled) {
    if (voteInfo) voteInfo.textContent = "Spiel beendet.";
    if (voteList) voteList.innerHTML = "";
  }
}

function playSystemErrorGlitch() {
  const overlay = $("systemError");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("glitching");
  window.clearTimeout(playSystemErrorGlitch._timeoutId);
  playSystemErrorGlitch._timeoutId = window.setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("glitching");
  }, 1500);
}

function startTiebreakCountdown(endsAt) {
  tiebreakEndsAt = endsAt;
  window.clearInterval(tiebreakTimerId);
  const tick = () => {
    if (!tiebreakEndsAt) return;
    const remainingMs = tiebreakEndsAt - Date.now();
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    if (seconds <= 0) {
      setTiebreakTimer("");
      window.clearInterval(tiebreakTimerId);
      tiebreakTimerId = null;
      return;
    }
    setTiebreakTimer(`Countdown: ${seconds}s`);
  };
  tick();
  tiebreakTimerId = window.setInterval(tick, 250);
}

function clearTiebreakState() {
  tiebreakCandidates = null;
  tiebreakEndsAt = null;
  setTiebreakBanner(false);
  setTiebreakTimer("");
  window.clearInterval(tiebreakTimerId);
  tiebreakTimerId = null;
}

function showModeTransition(survivalRounds) {
  const overlay = $("modeTransition");
  const target = $("modeTargetRound");
  if (!overlay || !target) return;

  target.textContent = String(survivalRounds ?? "?");
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  window.clearTimeout(showModeTransition._timeoutId);
  showModeTransition._timeoutId = window.setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }, 1800);
}

function renderAiOptions() {
  const panel = $("aiPanel");
  const box = $("aiOptions");
  const sendButton = $("sendAnswer");
  if (!panel || !box || !sendButton) return;

  box.innerHTML = "";
  selectedAiAnswer = "";

  for (const txt of aiShownOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-option-btn";
    btn.textContent = txt;
    btn.onclick = () => {
      selectedAiAnswer = txt;
      for (const b of box.querySelectorAll(".ai-option-btn")) b.classList.remove("selected");
      btn.classList.add("selected");
      const answerEl = $("answer");
      if (answerEl) answerEl.value = txt;
      sendButton.disabled = false;
    };
    box.appendChild(btn);
  }

  sendButton.disabled = true;
}

function updateAnsweringUI() {
  const isAnswering = currentPhase === "ANSWERING";
  const isAI = myRole === "ai";
  const panel = $("aiPanel");
  const answerEl = $("answer");
  const submitBtn = $("sendAnswer");
  if (!panel || !answerEl || !submitBtn) return;

  if (isAnswering && isAI && !isSpectator && !isGameOver) {
    panel.classList.remove("hidden");
    answerEl.disabled = true;
    answerEl.classList.add("hidden");
    if (!aiSuggestions.length) {
      socket.emit("request_ai_suggestions");
    }
    submitBtn.disabled = !selectedAiAnswer;
    return;
  }

  panel.classList.add("hidden");
  answerEl.disabled = isSpectator || isGameOver;
  answerEl.classList.remove("hidden");
  if (!isSpectator && !isGameOver) submitBtn.disabled = false;
}

function updateUI(state) {
  currentPhase = state.phase;
  $("phase").textContent = state.phase;
  $("round").textContent = String(state.roundNumber || 0);
  $("prompt").textContent = state.prompt || "Warte…";

  $("answerBox").classList.toggle("hidden", state.phase !== "ANSWERING");
  $("revealBox").classList.toggle("hidden", state.phase !== "REVEAL");
  $("voteBox").classList.toggle("hidden", state.phase !== "VOTING" && state.phase !== "TIEBREAK");
  $("resultBox").classList.toggle("hidden", state.phase !== "RESULT");

  questionMasterId = state.questionMasterId || null;
  if (state.phase === "LOBBY") {
    showLobbyScreen();
  } else {
    showGame();
  }

  const promptPicker = $("promptPicker");
  if (state.phase === "PICK_PROMPT") {
    $("prompt").textContent = "Warte — QM wählt eine Frage…";
    if (promptPicker) promptPicker.classList.remove("hidden");
    renderPromptPicker();
  } else {
    if (promptPicker) promptPicker.classList.add("hidden");
    if (state.phase !== "ANSWERING") promptOptions = [];
  }
  if (state.phase === "ANSWERING" && isSpectator) {
    setSpectatorMode(true);
  }
  if (state.phase === "GAME_OVER") {
    setGameOverState(true);
  }

  if (state.phase === "VOTING") renderVoteTargets();
  if (state.phase === "TIEBREAK") {
    setTiebreakBanner(true);
    if (state.tiebreak?.endsAt) startTiebreakCountdown(state.tiebreak.endsAt);
    if (state.tiebreak?.candidates) tiebreakCandidates = state.tiebreak.candidates;
    renderVoteTargets();
  }
  if (state.phase !== "TIEBREAK") {
    clearTiebreakState();
  }

  updateAnsweringUI();
}

function renderVoteTargets() {
  if (isGameOver) return;
  const list = $("voteList");
  list.innerHTML = "";
  const candidates = currentPhase === "TIEBREAK" && Array.isArray(tiebreakCandidates)
    ? players.filter(p => p.alive && tiebreakCandidates.includes(p.id))
    : players.filter(p => p.alive && p.id !== myId);
  const aliveOthers = candidates;
  if (!aliveOthers.length) {
    $("voteInfo").textContent = "Keine Ziele verfügbar.";
    return;
  }
  $("voteInfo").textContent = "";
  for (const p of aliveOthers) {
    const btn = document.createElement("button");
    btn.className = "target";
    btn.textContent = `${p.avatar || "🙂"}  ${p.name}`;
    btn.onclick = () => socket.emit("submit_vote", { targetId: p.id });
    list.appendChild(btn);
  }
}

// Socket events
socket.on("connect", () => {
  myId = socket.id;
  setStatus("Verbunden", "ok");
});
socket.on("disconnect", () => setStatus("Verbindung getrennt", "bad"));
socket.on("connect_error", () => setStatus("Keine Verbindung zum Server", "bad"));

socket.on("join_accepted", (p) => {
  setJoinHint("");
  setStatus("Lobby betreten – warte auf Start…", "ok");
  if (p?.sessionCode) sessionCode = p.sessionCode;
  if (p?.assignedName) myName = p.assignedName;
  currentSessionCode = sessionCode;
  promptOptions = [];
  setSpectatorMode(false);
  setGameOverState(false);
  isPromptAI = false;
  myRole = "human";
  aiSuggestions = [];
  aiShownOptions = [];
  selectedAiAnswer = "";
  clearTiebreakState();
  setPromptAIBanner(false);
  showLobbyScreen();
  setLobbyMeta();
  const lobbyStatus = $("lobbyStatus");
  updateMeBadge();
  if (lobbyStatus) {
    lobbyStatus.textContent = "Lobby beigetreten — warte auf nächste Frage…";
  }
  showOverlay({
    tone: "mint",
    tag: "CONNECTED",
    title: "LOBBY",
    sub: "Warte auf Start…",
    ms: 900
  });
});

socket.on("prompt_options", ({ options }) => {
  promptOptions = options || [];
  renderPromptPicker();
});

socket.on("role_secret", ({ role }) => {
  myRole = role || "human";
  if (role === "prompt_ai") {
    isPromptAI = true;
    setPromptAIBanner(true);
    showOverlay({
      tone: "event",
      tag: "ROLLE",
      title: "PROMPT-AI",
      sub: "Du bekommst Vorschläge.",
      ms: 1800
    });
  } else if (role === "ai") {
    isPromptAI = false;
    setPromptAIBanner(false);
    showOverlay({
      tone: "event",
      tag: "ROLLE",
      title: "DU BIST DIE KI",
      sub: "Bleib unauffällig.",
      ms: 1800
    });
  } else if (role === "human") {
    isPromptAI = false;
    setPromptAIBanner(false);
    showOverlay({
      tone: "mint",
      tag: "ROLLE",
      title: "DU BIST MENSCH",
      sub: "Finde die KI.",
      ms: 1600
    });
  } else {
    isPromptAI = false;
    setPromptAIBanner(false);
  }
  updateAnsweringUI();
});

socket.on("you_were_kicked", () => {
  setSpectatorMode(true);
  showOverlay({
    tone: "event",
    tag: "EJECTED",
    title: "RAUSGEKICKT",
    sub: "Zuschauer-Modus aktiv.",
    ms: 1400
  });
});

socket.on("game_over", ({ winState }) => {
  setGameOverState(true);
  if (winState === "humans_win") {
    showOverlay({
      tone: "mint",
      tag: "SIEG",
      title: "MENSCHEN GEWINNEN",
      sub: "KI entlarvt!",
      ms: 2000
    });
  } else if (winState === "ais_win") {
    showOverlay({
      tone: "event",
      tag: "ALARM",
      title: "KIS GEWINNEN",
      sub: "Alle infiziert oder raus.",
      ms: 2000
    });
  }
  if (winState === "humans_lose") {
    showOverlay({
      tone: "event",
      tag: "VERLOREN",
      title: "MENSCHEN VERLIEREN",
      sub: "Zu wenige haben überlebt.",
      ms: 2000
    });
  }
});

socket.on("mode_transition", ({ survivalRounds }) => {
  showModeTransition(survivalRounds);
});

socket.on("ai_suggestions", ({ suggestions }) => {
  aiSuggestions = Array.isArray(suggestions) ? suggestions : [];
  aiShownOptions = pickRandom(aiSuggestions, 3);
  renderAiOptions();
  updateAnsweringUI();
});

socket.on("tiebreak_start", ({ candidates, endsAt }) => {
  tiebreakCandidates = candidates || null;
  currentPhase = "TIEBREAK";
  setTiebreakBanner(true);
  if (endsAt) startTiebreakCountdown(endsAt);
  renderVoteTargets();
});

socket.on("system_error", () => {
  playSystemErrorGlitch();
});

socket.on("flagged", ({ strikes }) => {
  showWarning(`WARNUNG (${strikes}/2): Sprache gefiltert.`);
});

socket.on("eliminated", () => {
  setSpectatorMode(true);
  showOverlay({
    tone: "event",
    tag: "EJECTED",
    title: "RAUSGEKICKT",
    sub: "Du bist jetzt Zuschauer.",
    ms: 1400
  });
});

socket.on("action_rejected", ({ reason }) => {
  if (reason === "eliminated") {
    setSpectatorMode(true);
    updateAnsweringUI();
  }
});

socket.on("join_rejected", ({ reason }) => {
  const map = {
    invalid_session: "Code 3–8 Zeichen (A-Z/0-9).",
  };
  setJoinHint(map[reason] || "Join abgelehnt.");
  setStatus("Join fehlgeschlagen", "bad");
});

socket.on("phase_update", (state) => {
  updateUI(state);
  players = state.players || players;
  setLobbyMeta();
});

socket.on("players_update", (state) => {
  players = state.players || [];
  setLobbyMeta();
  renderLobbyPlayers(players);
  const me = players.find(p => p.id === myId);
  if (me && me.name && me.name !== myName) {
    myName = me.name;
    updateMeBadge();
  }
});

socket.on("answers_count", ({ count }) => {
  $("answerInfo").textContent = `Antworten: ${count}`;
});

socket.on("votes_count", ({ count }) => {
  $("voteInfo").textContent = `Votes: ${count}`;
});

socket.on("reveal_answers", ({ reveal }) => {
  const list = $("revealList");
  list.innerHTML = "";
  for (const item of reveal || []) {
    const div = document.createElement("div");
    div.className = "reveal";
    div.textContent = item.text;
    list.appendChild(div);
  }
});

socket.on("round_result", ({ kickedId }) => {
  const kicked = players.find(p => p.id === kickedId);
  $("resultText").textContent = kicked ? `${kicked.name} wurde rausgewählt.` : "Niemand wurde rausgewählt.";
  if (kickedId && kickedId === myId) {
    showOverlay({
      tone: "event",
      tag: "EJECTED",
      title: "RAUSGEKICKT",
      sub: "Du bist jetzt Zuschauer.",
      ms: 1400
    });
  }
});

// UI handlers
function renderAvatars() {
  const root = $("avatars");
  root.innerHTML = "";
  for (const a of avatars) {
    const b = document.createElement("button");
    b.className = "avatar";
    b.textContent = a;
    b.onclick = () => {
      selectedAvatar = a;
      [...root.querySelectorAll(".avatar")].forEach(x => x.classList.remove("selected"));
      b.classList.add("selected");
    };
    root.appendChild(b);
  }
  const first = root.querySelector(".avatar");
  if (first) first.click();
}

$("joinBtn").onclick = () => {
  const code = ($("code").value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(code)) {
    setJoinHint("Bitte gültigen Code eingeben.");
    setStatus("Fehlt noch was…", "warn");
    return;
  }
  myAvatar = selectedAvatar;
  sessionCode = code;
  currentSessionCode = code;
  setLobbyMeta();
  setJoinHint("Join wird gesendet…");
  setStatus(`Join zu ${code}…`, "warn");
  socket.emit("join", { sessionCode: code, avatar: selectedAvatar });
};

$("sendAnswer").onclick = () => {
  const answerEl = $("answer");
  let text = (answerEl?.value || "").trim();
  if (myRole === "ai" && currentPhase === "ANSWERING") {
    text = (selectedAiAnswer || "").trim();
  }
  if (!text) return;
  socket.emit("submit_answer", { text });
};

socket.on("answer_accepted", () => {
  $("answerInfo").textContent = "Gesendet ✅";
  $("answer").value = "";
  if (myRole === "ai") {
    selectedAiAnswer = "";
    const box = $("aiOptions");
    if (box) {
      for (const btn of box.querySelectorAll(".ai-option-btn")) btn.classList.remove("selected");
    }
    const submitBtn = $("sendAnswer");
    if (submitBtn) submitBtn.disabled = true;
  }
});
socket.on("answer_rejected", (v) => {
  const map = {
    empty: "Bitte etwas schreiben.",
    too_long: "Zu lang (max 150).",
    too_many_sentences: "Nur 1 Satz bitte.",
    invalid: "Ungültig.",
    eliminated: "Du bist raus."
  };
  $("answerInfo").textContent = map[v.reason] || "Abgelehnt.";
});

renderAvatars();
setLobbyMeta();
setStatus("Nicht verbunden", "warn");
showJoinScreen();

window.__debugOverlayKi = () => showOverlay({
  tone: "mint",
  tag: "ROLE",
  title: "DU BIST DIE KI",
  sub: "Handle mit Bedacht.",
  ms: 1400
});
window.__debugOverlayInfect = () => showOverlay({
  tone: "event",
  tag: "ALERT",
  title: "INFIZIERT",
  sub: "Halte dich bedeckt.",
  ms: 1400
});
