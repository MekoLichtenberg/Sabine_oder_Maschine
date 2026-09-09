import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));

const prompts = JSON.parse(fs.readFileSync("./prompts.json", "utf8"));
const NAME_POOL = [
  "Sabine","Harald","Godfrey","Peter","Charlotte","Gregory",
  "Gerda","Uwe","Renate","Günther","Waltraud","Norbert",
  "Brunhilde","Ingrid","Rüdiger","Horst","Elke","Manfred",
  "Karin","Dieter","Bernd","Hannelore","Heinz","Gudrun",
  "Rolf","Lieselotte","Erwin","Bärbel","Jürgen","Monika"
];
const BAD_WORDS = [
  "fuck",
  "motherfucker",
  "shit",
  "bitch",
  "cunt",
  "asshole",
  "bastard",
  "dick",
  "cock",
  "pussy",
  "slut",
  "whore",
  "arsch",
  "arschloch",
  "fotze",
  "wichser",
  "hurensohn",
  "ficken",
  "schlampe",
  "scheiße",
  "scheisse",
  "fotze",
  "cunt",
  "goonen",
  "goon",
  "Hitler",
  "Nazi",
  "Kanake",
  "Nigger",
  "Neger",
  "Talahon"
];
const badRx = new RegExp(`\\b(${BAD_WORDS.join("|")})\\b`, "gi");

const sessions = new Map();        // sessionCode -> sessionState
const socketSession = new Map();   // socketId -> sessionCode
const adminSession = new Map();    // socketId -> sessionCode

function normalizeSessionCode(code) {
  if (typeof code !== "string") return "";
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(c)) return "";
  return c;
}

function createSession() {
  return {
    phase: "LOBBY",      // LOBBY | PICK_PROMPT | ANSWERING | REVEAL | VOTING | RESULT
    questionMasterId: null,
    promptOptions: [],
    promptId: null,
    promptText: "",
    roundNumber: 0,
    roundType: null,
    didSystemError: false,
    promptAIId: null,
    survivalRounds: 0,
    tiebreak: null,
    strikes: new Map(),
    players: new Map(),  // id -> {name, avatar}
    alive: new Set(),
    roles: new Map(),    // id -> role
    answers: new Map(),  // id -> text
    votes: new Map(),    // voterId -> targetId
  };
}

function getSession(code) {
  if (!sessions.has(code)) sessions.set(code, createSession());
  return sessions.get(code);
}

function publicState(session) {
  const state = {
    phase: session.phase,
    roundNumber: session.roundNumber,
    promptId: session.promptId,
    prompt: session.promptText || "",
    questionMasterId: session.questionMasterId || null,
    players: [...session.players.entries()].map(([id, p]) => ({
      id, name: p.name, avatar: p.avatar, alive: session.alive.has(id)
    }))
  };
  if (session.tiebreak) {
    state.tiebreak = {
      candidates: session.tiebreak.candidates,
      endsAt: session.tiebreak.endsAt
    };
  }
  if (session.phase === "PICK_PROMPT") {
    state.promptOptionsCount = session.promptOptions.length;
  }
  return state;
}

function emitToRoom(sessionCode, event, payload) {
  io.to(sessionCode).emit(event, payload);
}

function emitToAdmins(sessionCode, event, payload) {
  for (const [socketId, code] of adminSession.entries()) {
    if (code !== sessionCode) continue;
    io.to(socketId).emit(event, payload);
  }
}

/* Roundtype? write test */

function adminState(sessionCode) {
  const session = sessions.get(sessionCode);
  if (!session) {
    return {
      phase: "LOBBY",
      roundType: null,
      players: []
    };
  }
  const players = [...session.players.entries()].map(([id, player]) => {
    const role = session.roundType === "detect_human" && session.promptAIId === id
      ? "prompt_ai"
      : (session.roles.get(id) || null);
    return {
      id,
      name: player.name,
      avatar: player.avatar,
      alive: session.alive.has(id),
      role
    };
  });
  return {
    phase: session.phase,
    roundType: session.roundType || null,
    players
  };
}

function emitAdminState(sessionCode) {
  emitToAdmins(sessionCode, "admin_state", adminState(sessionCode));
}

function validateAnswer(text) {
  if (typeof text !== "string") return { ok: false, reason: "invalid" };
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.length > 150) return { ok: false, reason: "too_long" };
  const parts = t.split(/[.!?]+/).map(s=>s.trim()).filter(Boolean);
  if (parts.length > 1) return { ok: false, reason: "too_many_sentences" };
  return { ok: true, text: t };
}

function countByTarget(map) {
  const counts = {};
  for (const targetId of map.values()) counts[targetId] = (counts[targetId] || 0) + 1;
  return counts;
}

function resolvePlurality(counts) {
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  let max = -1;
  let best = [];
  for (const [id, c] of entries) {
    if (c > max) { max = c; best = [id]; }
    else if (c === max) best.push(id);
  }
  return best[Math.floor(Math.random() * best.length)];
}

function getTopCandidates(counts) {
  const entries = Object.entries(counts);
  if (!entries.length) return { topCount: 0, topIds: [] };
  let topCount = -1;
  let topIds = [];
  for (const [id, count] of entries) {
    if (count > topCount) {
      topCount = count;
      topIds = [id];
    } else if (count === topCount) {
      topIds.push(id);
    }
  }
  return { topCount, topIds };
}

function pickUniqueName(session) {
  const taken = new Set([...session.players.values()].map(p => (p.name || "").toLowerCase()));
  const pool = [...NAME_POOL].sort(() => Math.random() - 0.5);
  for (const name of pool) {
    if (!taken.has(name.toLowerCase())) return name;
  }
  let i = 1;
  while (true) {
    const name = `Sabine-${i++}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function rerollNames(session) {
  const pool = [...NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let fallbackIndex = 1;
  for (const id of session.players.keys()) {
    const newName = pool.shift() || `Sabine-${fallbackIndex++}`;
    const player = session.players.get(id);
    if (player) player.name = newName;
  }
}

function samplePrompts(count) {
  const pool = [...prompts];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length)).map(p => ({ id: p.id, prompt: p.prompt }));
}

function chooseQuestionMaster(session) {
  const playerIds = [...session.players.keys()];
  if (!playerIds.length) return null;
  const currentIndex = session.questionMasterId
    ? playerIds.indexOf(session.questionMasterId)
    : -1;
  if (currentIndex === -1) {
    return playerIds[Math.floor(Math.random() * playerIds.length)];
  }
  const nextIndex = (currentIndex + 1) % playerIds.length;
  return playerIds[nextIndex];
}

function aiCountForPlayers(count) {
  if (count <= 1) return 0;
  if (count <= 6) return 1;
  if (count <= 14) return 2;
  if (count <= 20) return 3;
  return 3 + Math.floor((count - 21) / 6) + 1;
}

function computeWinState(session) {
  if (session.roles.size === 0) return "none";
  const alive = [...session.alive];
  const aiAlive = alive.filter(id => session.roles.get(id) === "ai");
  const humanAlive = alive.filter(id => session.roles.get(id) !== "ai");
  if (alive.length === 0) return "none";
  if (aiAlive.length === 0) return "humans_win";
  if (humanAlive.length === 0) return "ais_win";
  return "none";
}

function clearTiebreak(session) {
  if (session.tiebreak?.timeoutId) {
    clearTimeout(session.tiebreak.timeoutId);
  }
  session.tiebreak = null;
}

function resolveTiebreak(session, code) {
  if (!session.tiebreak) return;
  const candidates = session.tiebreak.candidates;
  const counts = countByTarget(session.votes);
  const filtered = {};
  for (const id of candidates) {
    if (counts[id]) filtered[id] = counts[id];
  }
  const { topIds } = getTopCandidates(filtered);
  let kickedId = null;
  if (!topIds.length) {
    kickedId = candidates[Math.floor(Math.random() * candidates.length)];
  } else if (topIds.length === 1) {
    kickedId = topIds[0];
  } else {
    kickedId = topIds[Math.floor(Math.random() * topIds.length)];
  }
  clearTiebreak(session);
  applyRoundResolution(session, code, kickedId, counts);
}

function applyRoundResolution(session, code, kickedId, counts) {
  if (kickedId && session.players.has(kickedId)) {
    session.alive.delete(kickedId);
    io.to(kickedId).emit("you_were_kicked");
  }

  const kickedWasAI = kickedId ? session.roles.get(kickedId) === "ai" : false;
  if (session.roundType === "detect_ai"
      && session.roundNumber === 1
      && kickedWasAI
      && !session.didSystemError) {
    session.didSystemError = true;
    emitToRoom(code, "system_error", { reason: "ai_caught_round1" });
    rerollNames(session);
    emitToRoom(code, "players_update", publicState(session));
  }

  if (session.roundType === "detect_human" && session.roundNumber >= session.survivalRounds) {
    const aliveHumans = session.alive.size;
    const winState = aliveHumans >= 3 ? "humans_win" : "humans_lose";
    session.phase = "GAME_OVER";
    emitToRoom(code, "game_over", { winState, mode: "detect_human" });
    emitToRoom(code, "phase_update", publicState(session));
    emitToRoom(code, "players_update", publicState(session));
    emitAdminState(code);
    return;
  }
/* ########### REFACTOR ############# double win state? */
  const winState = computeWinState(session);
  if (winState !== "none") {
    session.phase = "GAME_OVER";
    emitToRoom(code, "game_over", { winState, mode: "detect_ai" });
    emitToRoom(code, "phase_update", publicState(session));
    emitToRoom(code, "players_update", publicState(session));
    emitAdminState(code);
    return;
  }

  session.phase = "RESULT";
  const result = { kickedId, counts };
  emitToRoom(code, "round_result", result);
  emitToRoom(code, "phase_update", publicState(session));
  emitToRoom(code, "players_update", publicState(session));
  emitAdminState(code);
}

function getPromptById(promptId) {
  return prompts.find(p => p.id === promptId) || null;
}


/* Array lenght = 0? werden alle gezeigt?*/

function getAiSuggestionsForPrompt(promptId) {
  const prompt = getPromptById(promptId);
  if (!prompt) return [];
  const arr = Array.isArray(prompt.botAnswers) ? [...prompt.botAnswers] : [];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 5);
}

function calcSurvivalRounds(playerCount) {
  return Math.max(4, playerCount - 2);
}

// ---- API ----
app.get("/api/prompts", (_req, res) => {
  res.json(prompts.map(p => ({ id: p.id, prompt: p.prompt })));
});

app.post("/api/admin/start", (req, res) => {
  const { sessionCode, roundType } = req.body || {};
  const code = normalizeSessionCode(sessionCode);
  if (!code) return res.status(400).json({ ok:false, error:"Invalid sessionCode" });

  const session = getSession(code);
  clearTiebreak(session);
  if (roundType) {
    session.roundNumber = 0;
  }
  session.questionMasterId = chooseQuestionMaster(session);
  session.phase = "PICK_PROMPT";
  session.roundType = roundType || null;
  session.didSystemError = false;
  session.promptAIId = null;
  session.survivalRounds = 0;
  session.tiebreak = null;
  session.strikes.clear();
  session.promptOptions = samplePrompts(3);
  session.promptId = null;
  session.promptText = "";
  session.roundNumber += 1;
  session.answers.clear();
  session.votes.clear();
  session.alive = new Set(session.players.keys());
  session.roles.clear();
  const eligibleIds = [...session.alive];
  if (roundType === "detect_ai") {
    const aiCount = Math.min(aiCountForPlayers(eligibleIds.length), eligibleIds.length);
    for (let i = eligibleIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligibleIds[i], eligibleIds[j]] = [eligibleIds[j], eligibleIds[i]];
    }
    const aiSet = new Set(eligibleIds.slice(0, aiCount));
    for (const id of eligibleIds) {
      session.roles.set(id, aiSet.has(id) ? "ai" : "human");
    }
    for (const [id, role] of session.roles.entries()) {
      io.to(id).emit("role_secret", { role });
    }
  }
if (roundType === "detect_human") {
  session.survivalRounds = calcSurvivalRounds(eligibleIds.length);
/* falsche Berechnung für Menge an survivron? n-2?  */

  // alle sind human in Mode B -> KI feuert trotzdem?
  for (const id of eligibleIds) session.roles.set(id, "human");

  // WICHTIG: Role-Reset an ALLE Clients (sonst bleiben sie "ai" aus Modus A) #### nochmal testen ####
  for (const id of eligibleIds) {
    io.to(id).emit("role_secret", { role: "human" });
  }

  // genau einer ist die Prompt-AI (bekommt Suggestions), für mode B ausschalten?
  if (eligibleIds.length) {
    session.promptAIId = eligibleIds[Math.floor(Math.random() * eligibleIds.length)];
    io.to(session.promptAIId).emit("role_secret", { role: "prompt_ai" });
  }

  io.to(code).emit("mode_transition", { survivalRounds: session.survivalRounds });
}

  emitToRoom(code, "phase_update", publicState(session));
  if (session.questionMasterId) {
    io.to(session.questionMasterId).emit("prompt_options", { options: session.promptOptions });
  }
  emitToRoom(code, "answers_count", { count: 0 });
  emitToRoom(code, "votes_count", { count: 0 });
  emitAdminState(code);

  res.json({ ok:true });
});

app.post("/api/admin/reveal", (req, res) => {
  const { sessionCode } = req.body || {};
  const code = normalizeSessionCode(sessionCode);
  if (!code) return res.status(400).json({ ok:false, error:"Invalid sessionCode" });

  const session = getSession(code);
  session.phase = "REVEAL";

const reveal = [];
for (const [id, txt] of session.answers.entries()) {
  if (!session.alive.has(id)) continue;

  const p = session.players.get(id); // <-- Spieler-Daten holen
  reveal.push({
    id,
    name: p?.name || "???",
    avatar: p?.avatar || null,
    text: txt
  });
}


  for (let i = reveal.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [reveal[i], reveal[j]] = [reveal[j], reveal[i]];
  }

  emitToRoom(code, "reveal_answers", { reveal, ...publicState(session) });
  emitToRoom(code, "phase_update", publicState(session));
  emitAdminState(code);
  res.json({ ok:true });
});

app.post("/api/admin/voting", (req, res) => {
  const { sessionCode } = req.body || {};
  const code = normalizeSessionCode(sessionCode);
  if (!code) return res.status(400).json({ ok:false, error:"Invalid sessionCode" });

  const session = getSession(code);
  session.phase = "VOTING";
  session.votes.clear();
  emitToRoom(code, "phase_update", publicState(session));
  emitToRoom(code, "votes_count", { count: 0 });
  emitAdminState(code);
  res.json({ ok:true });
});

app.post("/api/admin/resolve", (req, res) => {
  const { sessionCode } = req.body || {};
  const code = normalizeSessionCode(sessionCode);
  if (!code) return res.status(400).json({ ok:false, error:"Invalid sessionCode" });

  const session = getSession(code);
  if (session.phase === "TIEBREAK") {
    resolveTiebreak(session, code);
    emitAdminState(code);
    return res.json({ ok:true, status:"tiebreak_resolved" });
  }
  const counts = countByTarget(session.votes);
  const { topCount, topIds } = getTopCandidates(counts);
  if (topCount > 0 && topIds.length > 1) {
    const shuffled = [...topIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const candidates = shuffled.slice(0, 2);
    clearTiebreak(session);
    session.phase = "TIEBREAK";
    session.tiebreak = {
      candidates,
      endsAt: Date.now() + 10000,
      timeoutId: setTimeout(() => resolveTiebreak(session, code), 10000)
    };
    session.votes.clear();
    emitToRoom(code, "tiebreak_start", {
      candidates,
      endsAt: session.tiebreak.endsAt
    });
    emitToRoom(code, "phase_update", publicState(session));
    emitToRoom(code, "votes_count", { count: 0 });
    emitAdminState(code);
    return res.json({ ok:true, status:"tiebreak_started" });
  }
  const kickedId = resolvePlurality(counts);

  applyRoundResolution(session, code, kickedId, counts);
  res.json({ ok:true });
});

// ---- Socket.IO ----
io.on("connection", (socket) => {
  socket.emit("connected", { id: socket.id });

  socket.on("admin_watch", ({ sessionCode }) => {
    const code = normalizeSessionCode(sessionCode);
    if (!code) return;
    const prev = adminSession.get(socket.id);
    if (prev && prev !== code) {
      socket.leave(prev);
    }
    adminSession.set(socket.id, code);
    socket.join(code);
    socket.emit("admin_state", adminState(code));
  });

  socket.on("join", ({ sessionCode, avatar }) => {
    const code = normalizeSessionCode(sessionCode);
    if (!code) return socket.emit("join_rejected", { reason: "invalid_session" });

    const session = getSession(code);
    const assignedName = pickUniqueName(session);

    socket.join(code);
    socketSession.set(socket.id, code);

    session.players.set(socket.id, { name: assignedName, avatar: avatar || "🙂" });
    session.alive.add(socket.id);

    socket.emit("join_accepted", { sessionCode: code, assignedName });
    socket.emit("phase_update", publicState(session));
    emitToRoom(code, "players_update", publicState(session));
    emitAdminState(code);
    if (session.phase === "PICK_PROMPT" && session.questionMasterId === socket.id) {
      socket.emit("prompt_options", { options: session.promptOptions });
    }
  });

  socket.on("submit_answer", ({ text }) => {
    const code = socketSession.get(socket.id);
    if (!code) return;
    const session = sessions.get(code);
    if (!session || session.phase === "GAME_OVER") return;
    if (session.phase !== "ANSWERING") return;
    if (!session.alive.has(socket.id)) {
      socket.emit("action_rejected", { reason: "eliminated" });
      return;
    }

    const v = validateAnswer(text);
    if (!v.ok) return socket.emit("answer_rejected", v);

    let clean = v.text;
    const hasBadWords = badRx.test(clean);
    badRx.lastIndex = 0;
    if (hasBadWords) {
      clean = clean.replace(badRx, "***");
      const strikes = (session.strikes.get(socket.id) || 0) + 1;
      session.strikes.set(socket.id, strikes);
      socket.emit("flagged", { strikes, reason: "profanity" });
      if (strikes >= 2) {
        session.alive.delete(socket.id);
        emitToRoom(code, "players_update", publicState(session));
        socket.emit("eliminated", { reason: "strikes" });
        emitAdminState(code);
      }
    }

    session.answers.set(socket.id, clean);
    socket.emit("answer_accepted");
    emitToRoom(code, "answers_count", { count: session.answers.size });
  });

  socket.on("submit_vote", ({ targetId }) => {
    const code = socketSession.get(socket.id);
    if (!code) return;
    const session = sessions.get(code);
    if (!session || session.phase === "GAME_OVER") return;
    if (session.phase !== "VOTING" && session.phase !== "TIEBREAK") return;
    if (!session.alive.has(socket.id)) {
      socket.emit("action_rejected", { reason: "eliminated" });
      return;
    }
    if (!session.alive.has(targetId)) return;
    if (targetId === socket.id) return;
    if (session.phase === "TIEBREAK") {
      if (!session.tiebreak?.candidates.includes(targetId)) return;
    }

    session.votes.set(socket.id, targetId);
    emitToRoom(code, "votes_count", { count: session.votes.size });
    if (session.phase === "TIEBREAK" && session.votes.size >= session.alive.size) {
      resolveTiebreak(session, code);
    }
  });

  socket.on("choose_prompt", ({ promptId }) => {
    const code = socketSession.get(socket.id);
    if (!code) return;
    const session = sessions.get(code);
    if (!session || session.phase !== "PICK_PROMPT") return;
    if (socket.id !== session.questionMasterId) return;
    const chosen = session.promptOptions.find(p => p.id === promptId);
    if (!chosen) return;

    session.promptId = chosen.id;
    session.promptText = chosen.prompt;
    session.phase = "ANSWERING";
    session.promptOptions = [];

    emitToRoom(code, "phase_update", publicState(session));
  });

  socket.on("request_ai_suggestions", () => {
    const code = socketSession.get(socket.id);
    if (!code) return;
    const session = sessions.get(code);
    if (!session || !session.promptId) return;
    const role = session.roles.get(socket.id);
    const canUseAsModeA = session.roundType === "detect_ai" && role === "ai";
    const canUseAsModeB = session.roundType === "detect_human" && socket.id === session.promptAIId;
    if (!canUseAsModeA && !canUseAsModeB) return;
    const suggestions = getAiSuggestionsForPrompt(session.promptId);
    socket.emit("ai_suggestions", { suggestions });
  });

  socket.on("disconnect", () => {
    const code = socketSession.get(socket.id);
    if (code) {
      const session = sessions.get(code);
      socketSession.delete(socket.id);
      if (!session) return;

      session.players.delete(socket.id);
      session.alive.delete(socket.id);
      session.answers.delete(socket.id);
      session.votes.delete(socket.id);
      session.strikes.delete(socket.id);

      emitToRoom(code, "players_update", publicState(session));
      emitAdminState(code);
      if (session.phase === "PICK_PROMPT" && session.questionMasterId === socket.id) {
        session.questionMasterId = chooseQuestionMaster(session);
        emitToRoom(code, "phase_update", publicState(session));
        if (session.questionMasterId) {
          io.to(session.questionMasterId).emit("prompt_options", { options: session.promptOptions });
        }
      }
      if (session.players.size === 0) sessions.delete(code);
      return;
    }

    if (adminSession.has(socket.id)) {
      adminSession.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KI-Werwolf (clean) läuft auf http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin.html`);
});
