// Simuliert ein komplettes Spiel mit N Spielern gegen den laufenden Server
// PORT=8099 N=5 [LLM=http://localhost:8111] [MODE=suggest|chat|bot] node _sim.mjs
// Fuer MODE=bot den Server mit BOT_MIN_DELAY_MS=100 BOT_MAX_DELAY_MS=300 starten, sonst dauert es lange.
import WebSocket from 'ws';
const PORT = process.env.PORT || 8099, N = Number(process.env.N || 5), LLM = process.env.LLM || '', MODE = process.env.MODE || 'suggest';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bots = [];
function mk(i) {
  const b = { i, ws: new WebSocket(`ws://localhost:${PORT}`), state: null, id: null, log: [] };
  b.ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'joined') { b.id = m.you; b.token = m.token; b.code = m.code; } else if (m.type === 'state') b.state = m; else b.log.push(m); });
  b.send = (m) => b.ws.send(JSON.stringify(m));
  return b;
}
const host = () => bots.find(b => b.state?.you.isHost);
const phase = () => host().state.phase;
async function waitFor(fn, what, ms = 5000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error(`timeout waiting ${what}, phase=${phase()}`); await sleep(20); } }
const waitPhase = (p, ms) => waitFor(() => phase() === p, p, ms);
const allDone = () => host().state.players.filter(p => p.alive).every(p => p.done);
const log = (...a) => console.log(...a);
const assert = (c, msg) => { if (!c) { console.error('ASSERT FAIL:', msg); process.exitCode = 1; } };

for (let i = 0; i < N; i++) bots.push(mk(i));
await Promise.all(bots.map(b => new Promise(r => b.ws.on('open', r))));
bots[0].send({ type: 'create' }); await sleep(150);
for (const b of bots.slice(1)) { b.send({ type: 'join', code: bots[0].code }); await sleep(30); }
await sleep(200);
log('Lobby:', host().state.players.map(p => p.name + (p.isHost ? '*' : '')).join(', '));
assert(!bots[1].state.llm, 'Nicht-Host darf llm-Config nicht sehen');

if (LLM) {
  host().send({ type: 'host', action: 'setLLM', url: LLM, model: '' });
  await sleep(300); // "teste ..."-Broadcast abwarten, sonst sieht man noch den alten Status
  await waitFor(() => host().state.llm?.status === 'ok' || /Fehler|nicht/.test(host().state.llm?.status || ''), 'llm test', 15000);
  log('LLM status:', host().state.llm.status, host().state.llm.model);
  assert(host().state.llm.status === 'ok', 'LLM sollte ok sein');
}
if (MODE !== 'suggest') {
  host().send({ type: 'host', action: 'setKiMode', mode: MODE }); await sleep(150);
  assert(host().state.kiMode === MODE, 'kiMode sollte ' + MODE + ' sein');
  if (MODE === 'bot') {
    assert(host().state.players.length === N + 1, 'Bot-Sitz sollte in der Liste sein');
    assert(!host().state.players.some(p => p.isBot !== undefined), 'isBot darf in der Spielerliste nicht sichtbar sein');
    log('Bot-Sitz:', host().state.players.find(p => !bots.some(b => b.id === p.id))?.name);
  }
}

host().send({ type: 'host', action: 'startGame' }); await waitPhase('r1_answer');

const seenQ = new Set();
let round = 0;
while (true) {
  round++;
  const ki = bots.filter(b => b.state.you.role === 'ki');
  const q = host().state.question;
  assert(!seenQ.has(q), 'Frage wiederholt sich: ' + q); seenQ.add(q);
  log(`\n== R1 Frage ${round}: "${q}"  KI=${ki.map(b => b.state.you.name).join('/') || '(nur Bot)'}`);
  const kiAlive = ki.find(b => b.state.you.alive);
  if (kiAlive) {
    await waitFor(() => kiAlive.state.kiPending === false && kiAlive.state.kiOptions?.length, 'ki options', 15000);
    log('KI-Optionen:', kiAlive.state.kiOptions);
    assert(kiAlive.state.kiOptions.length >= 2, 'KI braucht Optionen');
    if (MODE === 'chat') {
      assert(kiAlive.state.kiChatOn === true, 'kiChatOn sollte an sein');
      kiAlive.send({ type: 'kiChat', text: 'mach was mit pizza' });
      await waitFor(() => (kiAlive.state.kiChat || []).length >= 2 && !kiAlive.state.kiBusy, 'chat reply', 15000);
      log('Chat:', kiAlive.state.kiChat);
      assert(kiAlive.state.kiChat[1].role === 'assistant', 'Chat-Antwort fehlt');
    }
  }
  for (const b of bots) {
    if (!b.state.you.alive) continue;
    if (b.state.you.role === 'ki') b.send({ type: 'answer', text: MODE === 'chat' ? b.state.kiChat[1].content : b.state.kiOptions[0] });
    else b.send({ type: 'answer', text: `antwort von ${b.state.you.name} halt so` });
  }
  // Toter Spieler versucht zu antworten -> muss ignoriert werden
  const dead = bots.find(b => !b.state.you.alive);
  if (dead) dead.send({ type: 'answer', text: 'ich bin tot aber rede' });
  await waitFor(allDone, 'alle antworten (inkl. Bot)', 4000).catch(e => assert(false, e.message));
  if (dead) assert(!host().state.players.find(p => p.id === dead.id).done, 'Toter darf nicht als done gelten');
  host().send({ type: 'host', action: 'toDiscuss' }); await waitPhase('r1_discuss');
  const order1 = host().state.answers.map(a => a.name).join(',');
  log('Antworten:', host().state.answers.map(a => `${a.name}: ${a.text.slice(0, 30)}`).join(' | '));
  host().send({ type: 'host', action: 'toVote' }); await waitPhase('r1_vote');
  const cands = host().state.candidates;
  for (const b of bots) if (b.state.you.alive) { const c = cands.filter(x => x.id !== b.id); b.send({ type: 'vote', target: c[Math.floor(Math.random() * c.length)].id }); }
  await waitFor(allDone, 'alle stimmen (inkl. Bot)', 4000).catch(e => assert(false, e.message));
  const order2 = host().state.answers.map(a => a.name).join(',');
  assert(order1 === order2, `Antwort-Reihenfolge hat sich geaendert: ${order1} -> ${order2}`);
  host().send({ type: 'host', action: 'resolveDay' }); await sleep(150);
  if (phase() === 'r1_night') {
    for (const b of ki) if (b.state.you.alive) { log('KI targets:', b.state.targets?.map(t => t.name)); if (b.state.targets?.length) b.send({ type: 'target', target: b.state.targets[0].id }); }
    await waitFor(() => host().state.nightReady === true, 'nightReady', 4000).catch(e => assert(false, e.message));
    assert(host().state.players.every(p => !p.done), 'Nachts darf kein done-Status sichtbar sein');
    host().send({ type: 'host', action: 'resolveNight' });
  }
  await waitPhase('r1_result');
  const s = host().state;
  log('Ergebnis: tag=', s.dayOut, 'nacht=', s.nightOut, 'winner=', s.winner, 'kiSource=', s.kiSource, 'alive=', s.players.filter(p => p.alive).map(p => p.name));
  if (LLM) assert(s.kiSource === 'llm', 'kiSource sollte llm sein');
  if (s.winner) {
    if (MODE === 'bot') assert(s.roles.some(r => r.isBot && r.role === 'ki'), 'Reveal sollte den Bot als KI zeigen');
    break;
  }
  host().send({ type: 'host', action: 'nextR1' }); await waitPhase('r1_answer');
  if (round > 10) throw new Error('R1 endet nicht');
}

host().send({ type: 'host', action: 'startR2' }); await waitPhase('r2_intro');
if (MODE === 'chat') {
  assert(host().state.players.length === N + 1, 'Chat-Modus: NULL sollte in R2 als Bot-Sitz beitreten');
  assert(host().state.botJoined, 'Chat-Modus: botJoined-Hinweis fehlt im Intro');
}
host().send({ type: 'host', action: 'r2Begin' }); await waitPhase('r2_answer');
round = 0;
while (true) {
  round++;
  log(`\n== R2 Frage ${round}: "${host().state.question}"`);
  for (const b of bots) if (b.state.you.alive) b.send({ type: 'answer', text: `Ich bin eine Maschine ${b.state.you.name}` });
  await waitFor(allDone, 'R2 antworten (inkl. Bot)', 4000).catch(e => assert(false, e.message));
  host().send({ type: 'host', action: 'toR2Vote' }); await waitPhase('r2_vote');
  if (round === 1 && MODE === 'bot') log('Bot-Antwort R2:', host().state.answers.find(a => !bots.some(b => b.state.you.name === a.name))?.text);
  const cands = host().state.candidates;
  for (const b of bots) if (b.state.you.alive) { const c = cands.filter(x => x.id !== b.id); b.send({ type: 'vote', target: c[Math.floor(Math.random() * c.length)].id }); }
  await waitFor(allDone, 'R2 stimmen (inkl. Bot)', 4000).catch(e => assert(false, e.message));
  host().send({ type: 'host', action: 'resolveR2' }); await sleep(200);
  const s = host().state;
  log('phase=', s.phase, 'out=', s.r2Out, 'alive=', s.players.filter(p => p.alive).map(p => p.name), 'winner=', s.winner);
  if (s.phase === 'gameover') break;
  host().send({ type: 'host', action: 'nextR2' }); await waitPhase('r2_answer');
  if (round > 15) throw new Error('R2 endet nicht');
}
log('\nGAMEOVER standings:', host().state.standings);
log('Protokoll-Eintraege:', (host().state.history || []).length);
assert((host().state.history || []).length > 0, 'Protokoll sollte am Ende da sein');
assert(host().state.history.some(h => h.runde === 1 && h.tag.length), 'R1-Stimmen fehlen im Protokoll');
assert(host().state.history.some(h => h.runde === 1 && h.nacht.length) || !host().state.history.some(h => h.nachtRaus), 'Nacht-Wahlen fehlen im Protokoll');
assert(host().state.roles?.length, 'Rollen fehlen im Gameover');
if (MODE === 'bot') assert(host().state.standings.some(s => s.isBot), 'Endstand sollte den Bot markieren');
const errs = bots.flatMap(b => b.log.filter(m => m.type === 'error'));
log('Fehlermeldungen:', errs);
for (const b of bots) b.ws.close();
log(process.exitCode ? '\n*** FEHLER ***' : '\n*** ALLES OK ***');
process.exit(process.exitCode || 0);
