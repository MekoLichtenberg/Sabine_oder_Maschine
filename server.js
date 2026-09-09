import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const KI_RATIO = Number(process.env.KI_RATIO || 7);   // ~1 KI pro N Spielende
const R2_ELIM_DIV = Number(process.env.R2_ELIM_DIV || 8); // Eliminierungen pro R2-Runde = alive/div
const DATA = JSON.parse(readFileSync(join(__dirname, 'questions.json'), 'utf8'));

// Optionale echte KI (OpenAI-kompatibler Endpunkt: Ollama, LM Studio, llama.cpp, vLLM ...)
// Diese Werte sind nur Vorbelegung; der Host kann sie in der Lobby aendern.
const LLM_DEFAULT = {
  url: process.env.LLM_URL || '',
  model: process.env.LLM_MODEL || '',
  key: process.env.LLM_KEY || ''
};
const LLM_TIMEOUT = Number(process.env.LLM_TIMEOUT_MS || 60000);
const LLM_ANSWERS = Math.max(2, Math.min(5, Number(process.env.LLM_ANSWERS || 3)));   // wie viele Vorschlaege die KI-Rolle bekommt
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 160);                       // Token-Budget pro Anfrage (klein = schnell)
const LLM_MAX_WORDS = Number(process.env.LLM_MAX_WORDS || 12);                          // Zielaenge einer Antwort in Woertern
// Bot-Sitz: wie lange die "KI spielt selbst" scheinbar tippt/ueberlegt (damit sie nicht sofort fertig ist)
const BOT_DELAY = [Number(process.env.BOT_MIN_DELAY_MS || 6000), Number(process.env.BOT_MAX_DELAY_MS || 20000)];
const botDelay = () => BOT_DELAY[0] + Math.random() * Math.max(0, BOT_DELAY[1] - BOT_DELAY[0]);
const R2_BOT_PRESETS = [
  'Als KI-System habe ich keine persoenlichen Vorlieben, kann aber gaengige Optionen strukturiert auflisten.',
  'Diese Frage laesst sich aus mehreren Perspektiven betrachten. Ich empfehle eine ausgewogene Einschaetzung.',
  'Ich verfuege ueber keine eigenen Erfahrungen, jedoch ueber umfangreiche Daten zu diesem Thema.',
  'Gerne fasse ich die wichtigsten Aspekte zusammen: Relevanz, Nutzen und langfristige Auswirkungen.',
  'Meine Antwort basiert auf statistischen Mustern. Bitte teilen Sie mir mit, falls Sie Details wuenschen.'
];

const app = express();
app.use(express.static(join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const rid = () => Math.random().toString(36).slice(2, 9);
const code4 = () => Math.floor(1000 + Math.random() * 9000).toString();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function newRoom() {
  let code; do { code = code4(); } while (rooms.has(code));
  const room = {
    code, phase: 'lobby', round: 0,
    players: new Map(),
    nameBag: shuffle(DATA.names),
    usedR1: new Set(), usedR2: new Set(),   // schon gestellte Fragen (Index), damit nichts doppelt kommt
    question: null, kiOptions: [], kiPending: false, kiSource: 'preset',
    answerOrder: null,      // feste Reihenfolge der Antworten ab Diskussion
    submitted: new Map(),   // id -> text
    votes: new Map(),       // voterId -> targetId
    kiTargets: new Map(),   // kiId -> targetId
    dayOut: null, nightOut: null, r2Out: [],
    winner: null,
    llm: { ...LLM_DEFAULT, status: LLM_DEFAULT.url ? 'ungetestet' : 'aus', models: [] },
    prefetch: null,         // { entry, promise } fuer die naechste R1-Frage
    kiMode: 'suggest',      // suggest = Mensch waehlt Vorschlaege | chat = Mensch + Chat mit der KI | bot = KI spielt selbst (Bot-Sitz)
    kiChat: new Map(),      // kiId -> [{role, content}] (Chat-Modus, pro Frage)
    kiBusy: new Set()       // kiIds, fuer die gerade eine Chat-Antwort laeuft
  };
  rooms.set(code, room);
  return room;
}

function takeName(room) {
  if (room.nameBag.length === 0) room.nameBag = shuffle(DATA.names);
  const used = new Set([...room.players.values()].map(p => p.name));
  let n = room.nameBag.pop();
  while (used.has(n) && room.nameBag.length) n = room.nameBag.pop();
  if (used.has(n)) n = n + ' ' + (room.players.size + 1);
  return n;
}

const living = (room) => [...room.players.values()].filter(p => p.alive);
const livingKI = (room) => living(room).filter(p => p.role === 'ki');
const livingHumans = (room) => living(room).filter(p => p.role === 'mensch');

function mkPlayer(room, ws, isHost) {
  return { id: rid(), token: rid() + rid(), name: takeName(room), ws, alive: true, isHost, role: null, connected: true, isBot: false };
}
// Bot-Sitz: sieht fuer alle aus wie ein normaler Spieler, hat aber keinen Menschen dahinter
function mkBot(room) {
  return { id: rid(), token: null, name: takeName(room), ws: null, alive: true, isHost: false, role: null, connected: true, isBot: true };
}
const theBot = (room) => [...room.players.values()].find(p => p.isBot);
const humans = (room) => [...room.players.values()].filter(p => !p.isBot);
const someoneConnected = (room) => humans(room).some(p => p.connected);

function send(ws, msg) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }

// Adressen, unter denen andere Geraete im selben Netz die Seite erreichen (virtuelle Adapter ausgefiltert)
function lanUrls() {
  // In Docker/LXC sieht der Server nur seine interne Adresse -> per LAN_URL in der .env vorgeben
  if (process.env.LAN_URL) return process.env.LAN_URL.split(',').map(s => s.trim()).filter(Boolean);
  const skip = /vethernet|virtualbox|vmware|wsl|docker|hyper-v|tailscale|zerotier|loopback/i;
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(169\.254\.|192\.168\.56\.)/.test(a.address)) continue; // APIPA (kein Netz), VirtualBox-Hostadapter
      out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

function stateForClient(room, me) {
  const actMap = (room.phase === 'r1_answer' || room.phase === 'r2_answer') ? room.submitted
    : (room.phase === 'r1_vote' || room.phase === 'r2_vote') ? room.votes
    : null; // Nacht: kein oeffentlicher Fertig-Status (wuerde die KI verraten)
  const s = {
    type: 'state', code: room.code, phase: room.phase, round: room.round,
    you: { id: me.id, name: me.name, isHost: me.isHost, alive: me.alive, role: me.role || null },
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, alive: p.alive, isHost: p.isHost, connected: p.connected,
      done: actMap ? actMap.has(p.id) : false
    })),
    winner: room.winner
  };

  if (room.phase === 'lobby') s.lanUrls = lanUrls();
  if (room.phase === 'lobby' && me.isHost) {
    s.llm = { url: room.llm.url, model: room.llm.model, hasKey: !!room.llm.key, status: room.llm.status, models: room.llm.models };
    s.kiMode = room.kiMode;
  }
  if (room.phase === 'r1_answer') {
    s.question = room.question;
    if (me.role === 'ki') { // nur die KI sieht die Auswahl
      s.kiOptions = room.kiOptions; s.kiPending = room.kiPending;
      s.kiChatOn = room.kiMode === 'chat' && llmActive(room);
      if (s.kiChatOn) { s.kiChat = room.kiChat.get(me.id) || []; s.kiBusy = room.kiBusy.has(me.id); }
    }
    s.iAnswered = room.submitted.has(me.id);
  }
  if (room.phase === 'r2_answer') {
    s.question = room.question;
    s.iAnswered = room.submitted.has(me.id);
  }
  if (room.phase === 'r1_discuss') {
    s.question = room.question;
    s.answers = orderedAnswers(room);
  }
  if (room.phase === 'r1_vote' || room.phase === 'r2_vote') {
    s.question = room.question;
    s.answers = orderedAnswers(room);
    s.iVoted = room.votes.has(me.id);
    s.candidates = living(room).map(p => ({ id: p.id, name: p.name }));
  }
  if (room.phase === 'r1_night') {
    s.isKI = me.role === 'ki';
    if (me.role === 'ki' && me.alive) {
      s.targets = livingHumans(room).map(p => ({ id: p.id, name: p.name }));
      s.iTargeted = room.kiTargets.has(me.id);
    }
    // Neutraler Hinweis fuer alle: hat jede lebende KI gewaehlt? (verraet nicht, wer die KI ist)
    const kis = livingKI(room);
    s.nightReady = kis.length > 0 && kis.every(k => room.kiTargets.has(k.id));
  }
  if (room.phase === 'r1_result') {
    s.dayOut = room.dayOut; s.nightOut = room.nightOut;
    s.decided = room.winner != null;
    s.kiSource = room.kiSource;
    if (room.winner) {
      s.roles = [...room.players.values()].map(p => ({ name: p.name, role: p.role, alive: p.alive, isBot: p.isBot }));
    }
  }
  if (room.phase === 'r2_result') {
    s.r2Out = room.r2Out;
    s.aliveCount = living(room).length;
  }
  if (room.phase === 'gameover') {
    s.standings = [...room.players.values()].map(p => ({ name: p.name, alive: p.alive, isBot: p.isBot }));
  }
  return s;
}

// Reihenfolge einmal festlegen (beim Wechsel in Diskussion/Abstimmung), damit sie
// nicht bei jedem Broadcast neu gemischt wird.
function freezeAnswerOrder(room) {
  room.answerOrder = shuffle([...room.submitted.keys()]);
}
function orderedAnswers(room) {
  const ids = room.answerOrder || [...room.submitted.keys()];
  return ids.filter(id => room.submitted.has(id)).map(id => ({ name: room.players.get(id)?.name || '?', text: room.submitted.get(id) }));
}

function broadcast(room) { for (const p of room.players.values()) send(p.ws, stateForClient(room, p)); }

// Zufaellige Auswahl aus einer Liste ohne Wiederholung, bis alles einmal dran war
function pickUnused(list, usedSet) {
  if (usedSet.size >= list.length) usedSet.clear();
  const free = list.map((_, i) => i).filter(i => !usedSet.has(i));
  const i = pick(free);
  usedSet.add(i);
  return list[i];
}

// --- Echte KI (optional) ---
function normalizeLlmUrl(u) {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/v1$/, '');
}
function llmHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.key) h['Authorization'] = 'Bearer ' + cfg.key;
  return h;
}
async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(json?.error?.message || json?.error || text || '').toString().slice(0, 160)}`);
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout nach ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally { clearTimeout(t); }
}
async function testLlm(cfg) {
  const j = await fetchJson(cfg.url + '/v1/models', { headers: llmHeaders(cfg) }, 8000);
  return (j?.data || j?.models || []).map(m => m.id || m.name || m.model).filter(Boolean);
}
const LLM_LOWERCASE = process.env.LLM_LOWERCASE !== '0'; // Antworten klein schreiben (wie am Handy getippt)
const KI_SYSTEM = process.env.LLM_SYSTEM_PROMPT ||
  `Du bist ein deutscher Jugendlicher (15) und tippst am Handy eine schnelle Antwort in einem Partyspiel. ` +
  `Gib ${LLM_ANSWERS} verschiedene Antworten auf die Frage, jede hoechstens ${LLM_MAX_WORDS} Woerter. ` +
  `Schreib wie ein Teenager im Chat: locker, ehrlich, konkret, alles klein, kein Ausrufezeichen, ruhig ein kleiner Tippfehler oder ein "lol" oder "kp". ` +
  `Keine Nummerierung, keine Anfuehrungszeichen, keine Emojis, keine Erklaerung, kein Werbetext. ` +
  `Format: jede Antwort in einer eigenen Zeile, sonst nichts. Beispiel fuer "Was ist dein Lieblingsessen?":\n` +
  `pizza eig immer, aber nur mit viel käse\nkp, was meine oma kocht halt\ndöner nach der schule lol`;
const cleanLine = (l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|[a-e][.)])\s*/i, '').replace(/^["„“'`]+|["“”'`]+$/g, '').trim();
const okLine = (l) => l.length >= 3 && l.length <= 200 && !/^(antwort|answer|hier|beispiel|format)/i.test(l);
function parseAnswers(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); // Denk-Bloecke mancher Modelle entfernen
  let lines = t.split(/\r?\n/).map(cleanLine).filter(okLine);
  if (lines.length < 2) {
    // Alles in einer Zeile ("1. ... 2. ..." oder " - ... - ..."): an Nummerierung/Aufzaehlung trennen
    lines = t.split(/(?:^|\s)\d+[.)]\s+|\s+[-–•]\s+|\s*\|\s*/).map(cleanLine).filter(okLine);
  }
  if (LLM_LOWERCASE) lines = lines.map(l => l.toLowerCase().replace(/!+$/, ''));
  return lines.filter((l, i, a) => a.indexOf(l) === i).slice(0, LLM_ANSWERS);
}
async function generateKiOptions(cfg, question) {
  const body = {
    model: cfg.model || undefined,
    messages: [{ role: 'system', content: KI_SYSTEM }, { role: 'user', content: 'Frage: ' + question }],
    temperature: 0.9, max_tokens: LLM_MAX_TOKENS, stream: false
  };
  const j = await fetchJson(cfg.url + '/v1/chat/completions', { method: 'POST', headers: llmHeaders(cfg), body: JSON.stringify(body) }, LLM_TIMEOUT);
  const content = j?.choices?.[0]?.message?.content || j?.message?.content || '';
  const out = parseAnswers(content);
  if (out.length < 2) throw new Error('KI hat zu wenig brauchbare Zeilen geliefert: ' + content.slice(0, 120));
  return out;
}
const llmActive = (room) => !!room.llm.url && room.llm.status === 'ok';

// Verbindung testen: Modellliste holen, Probe-Antwort erzeugen, Status setzen, Vorbereitung starten
async function testAndSetLlm(room) {
  room.llm.models = [];
  room.prefetch = null;
  if (!room.llm.url) { room.llm.status = 'aus'; broadcast(room); return; }
  room.llm.status = 'teste …'; broadcast(room);
  const cfg = { ...room.llm };
  try {
    const models = await testLlm(cfg);
    if (room.llm.url !== cfg.url || room.llm.model !== cfg.model) return; // inzwischen geaendert
    room.llm.models = models.slice(0, 30);
    if (!room.llm.model && models.length) room.llm.model = models[0];
    if (models.length && room.llm.model && !models.includes(room.llm.model)) {
      room.llm.status = `Modell "${room.llm.model}" nicht gefunden`;
    } else {
      try { await generateKiOptions(room.llm, 'Was ist dein Lieblingsessen?'); room.llm.status = 'ok'; }
      catch (e) { room.llm.status = 'Fehler: ' + e.message.slice(0, 140); }
    }
  } catch (e) {
    if (room.llm.url === cfg.url) room.llm.status = 'nicht erreichbar: ' + e.message.slice(0, 120);
  }
  broadcast(room);
  if (llmActive(room) && room.phase === 'lobby') prefetchNext(room);
}

// Chat-Modus: die KI-Person bittet das Modell um Formulierungen
const CHAT_SYSTEM = `Du hilfst einer Person, die in einem Partyspiel heimlich "die KI" spielt und sich als Mensch tarnen muss. ` +
  `Sie muss eine Frage so beantworten, wie ein deutscher Jugendlicher (15) am Handy tippt: locker, klein geschrieben, ruhig ein Tippfehler, hoechstens ${LLM_MAX_WORDS} Woerter. ` +
  `Antworte auf jede Nachricht der Person mit genau EINEM fertigen Antwortvorschlag auf die Frage, in einer Zeile, ohne Erklaerung, ohne Anfuehrungszeichen. Befolge ihre Wuensche (kuerzer, anderes Thema, mehr Slang ...).`;
async function chatReply(cfg, question, history) {
  const body = {
    model: cfg.model || undefined,
    messages: [{ role: 'system', content: CHAT_SYSTEM + ' Die Frage lautet: ' + question }, ...history],
    temperature: 0.9, max_tokens: 80, stream: false
  };
  const j = await fetchJson(cfg.url + '/v1/chat/completions', { method: 'POST', headers: llmHeaders(cfg), body: JSON.stringify(body) }, LLM_TIMEOUT);
  const content = (j?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return parseAnswers(content)[0] || content.slice(0, 200) || '…';
}
// Bot-Sitz in Runde 2: soll wie eine KI klingen (was ihm naturgemaess leicht faellt)
async function generateBotR2(cfg, question) {
  const body = {
    model: cfg.model || undefined,
    messages: [{ role: 'system', content: 'Du bist ein hoeflicher KI-Assistent. Beantworte die Frage in genau einem Satz mit hoechstens 20 Woertern: sachlich, korrekt, ohne Umgangssprache, ohne Tippfehler, ohne Emojis. Auf Deutsch.' },
      { role: 'user', content: question }],
    temperature: 0.7, max_tokens: 60, stream: false
  };
  const j = await fetchJson(cfg.url + '/v1/chat/completions', { method: 'POST', headers: llmHeaders(cfg), body: JSON.stringify(body) }, LLM_TIMEOUT);
  const content = parseAnswers(j?.choices?.[0]?.message?.content || '')[0] || '';
  if (content.length < 5) throw new Error('leere Bot-Antwort');
  return content.slice(0, 280);
}

// Startet die Generierung fuer einen Fragen-Eintrag; Ergebnis kommt als Promise (nie rejected).
function startGeneration(room, entry) {
  return generateKiOptions(room.llm, entry.q)
    .then(list => ({ ok: true, list }))
    .catch(err => { console.warn(`[${room.code}] KI-Generierung fehlgeschlagen: ${err.message}`); return { ok: false, list: shuffle(entry.ki).slice(0, 5) }; });
}
function prefetchNext(room) {
  if (!llmActive(room)) { room.prefetch = null; return; }
  const entry = pickUnused(DATA.round1, room.usedR1);
  room.prefetch = { entry, promise: startGeneration(room, entry) };
}

// --- Bot-Sitz ("KI spielt selbst") ---
// Alle Aktionen laufen verzoegert und pruefen vorher, ob die Phase noch dieselbe ist.
function botLater(room, phase, fn) {
  const q = room.question;
  setTimeout(() => { const b = theBot(room); if (b && b.alive && room.phase === phase && room.question === q) fn(b); }, botDelay());
}
function botAnswerR1(room) {
  const b = theBot(room);
  if (!b || !b.alive || b.role !== 'ki' || !room.kiOptions.length) return;
  const ans = pick(room.kiOptions);
  // Gibt es zusaetzlich menschliche KIs, sollen die nicht denselben Text sehen
  if (room.kiOptions.length > 1 && livingKI(room).some(k => !k.isBot)) room.kiOptions = room.kiOptions.filter(o => o !== ans);
  botLater(room, 'r1_answer', (bot) => { if (!room.submitted.has(bot.id)) { room.submitted.set(bot.id, ans); broadcast(room); } });
}
function botVote(room, phase) {
  botLater(room, phase, (bot) => {
    if (room.votes.has(bot.id)) return;
    const others = living(room).filter(p => p.id !== bot.id && (phase !== 'r1_vote' || p.role !== 'ki'));
    if (others.length) { room.votes.set(bot.id, pick(others).id); broadcast(room); }
  });
}
function botNight(room) {
  botLater(room, 'r1_night', (bot) => {
    if (bot.role !== 'ki' || room.kiTargets.has(bot.id)) return;
    const hum = livingHumans(room);
    if (hum.length) { room.kiTargets.set(bot.id, pick(hum).id); broadcast(room); }
  });
}
function botAnswerR2(room) {
  const b = theBot(room);
  if (!b || !b.alive) return;
  const q = room.question;
  const p = llmActive(room) ? generateBotR2(room.llm, q).catch(() => pick(R2_BOT_PRESETS)) : Promise.resolve(pick(R2_BOT_PRESETS));
  p.then(text => { if (room.question === q) botLater(room, 'r2_answer', (bot) => { if (!room.submitted.has(bot.id)) { room.submitted.set(bot.id, text); broadcast(room); } }); });
}

// --- Rollen + Runde 1 ---
function assignRoles(room) {
  const ps = [...room.players.values()];
  const kiCount = Math.max(1, Math.min(Math.floor(ps.length / KI_RATIO), Math.floor((ps.length - 1) / 2)));
  ps.forEach(p => { p.role = 'mensch'; p.alive = true; });
  let need = kiCount;
  const b = theBot(room);
  if (b) { b.role = 'ki'; need--; } // der Bot-Sitz ist immer eine KI
  shuffle(ps.filter(p => !p.isBot)).slice(0, need).forEach(p => { p.role = 'ki'; });
  return kiCount;
}

function startR1Question(room) {
  room.phase = 'r1_answer';
  room.submitted = new Map();
  room.votes = new Map();
  room.kiTargets = new Map();
  room.kiChat = new Map(); room.kiBusy = new Set();
  room.answerOrder = null;
  room.dayOut = null; room.nightOut = null;

  let entry, pending = null;
  if (room.prefetch) { ({ entry, promise: pending } = room.prefetch); room.prefetch = null; }
  else if (llmActive(room)) { entry = pickUnused(DATA.round1, room.usedR1); pending = startGeneration(room, entry); }
  else entry = pickUnused(DATA.round1, room.usedR1);

  room.question = entry.q;
  if (pending) {
    room.kiOptions = []; room.kiPending = true; room.kiSource = 'llm';
    const q = room.question;
    pending.then(r => {
      if (room.phase !== 'r1_answer' || room.question !== q) return; // Frage ist inzwischen vorbei
      room.kiOptions = r.list; room.kiPending = false; room.kiSource = r.ok ? 'llm' : 'preset';
      botAnswerR1(room);
      broadcast(room);
      prefetchNext(room); // naechste Frage schon mal vorbereiten
    });
  } else {
    room.kiOptions = shuffle(entry.ki).slice(0, 5); room.kiPending = false; room.kiSource = 'preset';
    botAnswerR1(room);
  }
  broadcast(room);
}

function checkWinR1(room) {
  const ki = livingKI(room).length, hum = livingHumans(room).length;
  if (ki === 0) return 'mensch';
  if (ki >= hum) return 'ki';
  return null;
}

function topByVotes(votesMap) {
  const tally = new Map();
  for (const t of votesMap.values()) tally.set(t, (tally.get(t) || 0) + 1);
  let max = 0, top = [];
  for (const [id, c] of tally) { if (c > max) { max = c; top = [id]; } else if (c === max) top.push(id); }
  return top;
}

function resolveDay(room) {
  const top = topByVotes(room.votes);
  if (top.length) {
    const out = room.players.get(pick(top));
    if (out) { out.alive = false; room.dayOut = { name: out.name, role: out.role, isBot: out.isBot }; }
  }
  room.phase = 'r1_night';
  room.kiTargets = new Map();
  // Falls keine KI mehr lebt, Nacht ueberspringen
  if (livingKI(room).length === 0) { room.nightOut = null; finishR1Round(room); return; }
  botNight(room);
  broadcast(room);
}

function resolveNight(room) {
  const top = topByVotes(room.kiTargets);
  if (top.length) {
    const out = room.players.get(pick(top));
    if (out) { out.alive = false; room.nightOut = { name: out.name, role: out.role, isBot: out.isBot }; }
  }
  finishR1Round(room);
}

function finishR1Round(room) {
  room.winner = checkWinR1(room);
  room.phase = 'r1_result';
  broadcast(room);
}

// --- Runde 2 ---
function startR2(room) {
  room.round = 2;
  for (const p of room.players.values()) { p.alive = true; p.role = 'mensch'; }
  room.phase = 'r2_intro';
  room.winner = null;
  room.prefetch = null;
  broadcast(room);
}

function startR2Question(room) {
  room.phase = 'r2_answer';
  room.question = pickUnused(DATA.round2, room.usedR2);
  room.submitted = new Map();
  room.votes = new Map();
  room.answerOrder = null;
  room.r2Out = [];
  botAnswerR2(room);
  broadcast(room);
}

function resolveR2(room) {
  const aliveNow = living(room);
  const n = Math.max(1, Math.round(aliveNow.length / R2_ELIM_DIV));
  const tally = new Map();
  for (const t of room.votes.values()) tally.set(t, (tally.get(t) || 0) + 1);
  // Nach Stimmen gruppieren, Gleichstand an der Grenze wird zufaellig entschieden
  const groups = new Map();
  for (const p of aliveNow) { const v = tally.get(p.id) || 0; if (v > 0) groups.set(v, [...(groups.get(v) || []), p]); }
  const out = [];
  for (const v of [...groups.keys()].sort((a, b) => b - a)) {
    if (out.length >= n) break;
    for (const p of shuffle(groups.get(v))) { if (out.length >= n) break; out.push({ p, v }); }
  }
  room.r2Out = [];
  for (const { p, v } of out) { p.alive = false; room.r2Out.push({ name: p.name, votes: v }); }
  const remaining = living(room);
  if (remaining.length <= 1) {
    room.winner = remaining[0]?.name || null;
    room.phase = 'gameover';
  } else {
    room.phase = 'r2_result';
  }
  broadcast(room);
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  let room = null, me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'reconnect') {
      for (const r of rooms.values()) {
        for (const p of r.players.values()) {
          if (p.token && p.token === m.token) {
            room = r; me = p; me.ws = ws; me.connected = true;
            send(ws, { type: 'joined', code: r.code, you: me.id, token: me.token });
            broadcast(r); return;
          }
        }
      }
      return send(ws, { type: 'reconnect_failed' });
    }
    if (m.type === 'create') {
      room = newRoom();
      me = mkPlayer(room, ws, true);
      room.players.set(me.id, me);
      send(ws, { type: 'joined', code: room.code, you: me.id, token: me.token });
      broadcast(room);
      if (room.llm.url) testAndSetLlm(room); // Vorbelegung aus .env direkt pruefen
      return;
    }
    if (m.type === 'join') {
      const r = rooms.get(String(m.code || '').trim());
      if (!r) return send(ws, { type: 'error', message: 'Kein Raum mit diesem Code' });
      if (r.phase !== 'lobby') return send(ws, { type: 'error', message: 'Das Spiel läuft schon – nur per Reload zurück' });
      room = r;
      me = mkPlayer(room, ws, false);
      room.players.set(me.id, me);
      send(ws, { type: 'joined', code: room.code, you: me.id, token: me.token });
      broadcast(room); return;
    }
    if (!room || !me) return;

    // Host uebernehmen, falls der aktuelle Host offline ist
    if (m.type === 'claimHost') {
      const cur = [...room.players.values()].find(p => p.isHost);
      if (!cur || !cur.connected) {
        for (const p of room.players.values()) p.isHost = false;
        me.isHost = true; broadcast(room);
      }
      return;
    }

    if (m.type === 'host' && me.isHost) {
      const a = m.action, ph = room.phase;
      if (a === 'startGame' && ph === 'lobby' && room.players.size >= 3) {
        room.round = 1; assignRoles(room);
        startR1Question(room);
      }
      else if (a === 'toDiscuss' && ph === 'r1_answer') { room.phase = 'r1_discuss'; freezeAnswerOrder(room); broadcast(room); }
      else if (a === 'toVote' && ph === 'r1_discuss') { room.phase = 'r1_vote'; room.votes = new Map(); botVote(room, 'r1_vote'); broadcast(room); }
      else if (a === 'resolveDay' && ph === 'r1_vote') resolveDay(room);
      else if (a === 'resolveNight' && ph === 'r1_night') resolveNight(room);
      else if (a === 'nextR1' && ph === 'r1_result' && !room.winner) startR1Question(room);
      else if (a === 'startR2' && (ph === 'r1_result' || ph === 'r2_result')) startR2(room);
      else if (a === 'r2Begin' && ph === 'r2_intro') startR2Question(room);
      else if (a === 'toR2Vote' && ph === 'r2_answer') { room.phase = 'r2_vote'; room.votes = new Map(); freezeAnswerOrder(room); botVote(room, 'r2_vote'); broadcast(room); }
      // KI-Modus (nur Lobby): suggest | chat | bot. Bot-Modus setzt einen Bot-Sitz in die Liste.
      else if (a === 'setKiMode' && ph === 'lobby') {
        const mode = ['suggest', 'chat', 'bot'].includes(m.mode) ? m.mode : 'suggest';
        room.kiMode = mode;
        const b = theBot(room);
        if (mode === 'bot' && !b) { const nb = mkBot(room); room.players.set(nb.id, nb); }
        if (mode !== 'bot' && b) room.players.delete(b.id);
        broadcast(room);
      }
      else if (a === 'resolveR2' && ph === 'r2_vote') resolveR2(room);
      else if (a === 'nextR2' && ph === 'r2_result') startR2Question(room);
      else if (a === 'end') { room.phase = 'gameover'; broadcast(room); }
      // Offline-Spieler rauswerfen (Lobby: entfernen, im Spiel: als ausgeschieden markieren)
      else if (a === 'kick') {
        const t = room.players.get(m.target);
        if (!t || t.connected || t.id === me.id) return;
        if (ph === 'lobby') room.players.delete(t.id); else t.alive = false;
        broadcast(room);
      }
      // Echte KI konfigurieren + testen (nur in der Lobby)
      else if (a === 'setLLM' && ph === 'lobby') {
        room.llm.url = normalizeLlmUrl(m.url);
        room.llm.model = String(m.model || '').trim().slice(0, 120);
        if (typeof m.key === 'string') room.llm.key = m.key.trim().slice(0, 300);
        await testAndSetLlm(room);
      }
      return;
    }

    if (m.type === 'answer' && (room.phase === 'r1_answer' || room.phase === 'r2_answer') && me.alive) {
      const t = String(m.text || '').trim().slice(0, 280);
      if (t) { room.submitted.set(me.id, t); broadcast(room); }
      return;
    }
    // Chat-Modus: KI-Person redet mit dem Modell ("NULL")
    if (m.type === 'kiChat' && room.phase === 'r1_answer' && me.role === 'ki' && me.alive && room.kiMode === 'chat' && llmActive(room)) {
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text || room.submitted.has(me.id) || room.kiBusy.has(me.id)) return;
      const hist = room.kiChat.get(me.id) || [];
      if (hist.filter(h => h.role === 'user').length >= 8) return; // Limit pro Frage
      hist.push({ role: 'user', content: text }); room.kiChat.set(me.id, hist);
      room.kiBusy.add(me.id); broadcast(room);
      const q = room.question;
      let reply;
      try { reply = await chatReply(room.llm, q, hist); }
      catch (e) { reply = '(keine antwort: ' + e.message.slice(0, 80) + ')'; }
      room.kiBusy.delete(me.id);
      if (room.phase !== 'r1_answer' || room.question !== q) return;
      hist.push({ role: 'assistant', content: reply });
      broadcast(room);
      return;
    }
    if (m.type === 'vote' && (room.phase === 'r1_vote' || room.phase === 'r2_vote') && me.alive) {
      if (room.players.get(m.target)?.alive && m.target !== me.id) { room.votes.set(me.id, m.target); broadcast(room); }
      return;
    }
    if (m.type === 'target' && room.phase === 'r1_night' && me.role === 'ki' && me.alive) {
      const tgt = room.players.get(m.target);
      if (tgt?.alive && tgt.role === 'mensch') { room.kiTargets.set(me.id, m.target); broadcast(room); }
      return;
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    // Wenn der Spieler bereits per Reconnect auf eine neue Verbindung umgezogen ist: alte Verbindung ignorieren
    if (me.ws && me.ws !== ws) return;

    if (room.phase === 'lobby') {
      room.players.delete(me.id);
      if (humans(room).length === 0) { rooms.delete(room.code); return; }
      if (me.isHost) { const nx = humans(room).find(p => p.connected); if (nx) nx.isHost = true; }
    } else {
      // Sitz bleibt erhalten, nur als offline markieren -> Reconnect moeglich
      me.connected = false; me.ws = null;
      const code = room.code;
      if (!someoneConnected(room)) {
        setTimeout(() => { const r = rooms.get(code); if (r && !someoneConnected(r)) rooms.delete(code); }, 5 * 60 * 1000);
      }
    }
    broadcast(room);
  });
});

// Heartbeat: Handys im Standby melden sich nicht ab -> tote Verbindungen erkennen
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n!! Port ${PORT} ist schon belegt. Laeuft das Spiel vielleicht schon in einem anderen Fenster?`);
    console.error(`   Sonst in der .env einen anderen Port eintragen, z.B. PORT=8081\n`);
  } else console.error(e);
  process.exit(1);
});
server.listen(PORT, () => {
  const urls = lanUrls();
  console.log('');
  console.log('  =====================================================');
  console.log('   SABINE//MASCHINE laeuft.');
  console.log(`   Auf diesem Rechner:   http://localhost:${PORT}`);
  if (urls.length) {
    console.log('   Die anderen tippen im Browser ein:');
    for (const u of urls) console.log(`       ${u}`);
  } else console.log('   (Keine Netzwerkadresse gefunden - WLAN an?)');
  console.log('   Dieses Fenster offen lassen. Schliessen beendet das Spiel.');
  console.log('  =====================================================');
  console.log('');
  if (process.env.OPEN_BROWSER === '1') {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
});
