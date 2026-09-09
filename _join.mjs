// Hilfsskript: N Bots treten einem bestehenden Raum bei und spielen passiv mit (antworten + stimmen ab)
// PORT=8099 N=2 node _join.mjs 1234
import WebSocket from 'ws';
const PORT = process.env.PORT || 8099, N = Number(process.env.N || 2), CODE = process.argv[2];
if (!CODE) { console.error('Raumcode fehlt'); process.exit(1); }
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  let me = null, done = new Set();
  const send = (m) => ws.send(JSON.stringify(m));
  ws.on('open', () => send({ type: 'join', code: CODE }));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'joined') { me = m.you; console.log('bot', i, 'drin'); }
    if (m.type === 'error') console.log('bot', i, 'fehler:', m.message);
    if (m.type !== 'state' || !m.you.alive) return;
    const key = m.phase + ':' + m.question;
    if (done.has(key)) return;
    if (m.phase === 'r1_answer' && !m.iAnswered) {
      if (m.you.role === 'ki') { if (m.kiOptions?.length) { done.add(key); setTimeout(() => send({ type: 'answer', text: m.kiOptions[0] }), 1500); } }
      else { done.add(key); setTimeout(() => send({ type: 'answer', text: 'ich hab da ehrlich keine ahnung ' + i }), 1500); }
    }
    if (m.phase === 'r2_answer' && !m.iAnswered) { done.add(key); setTimeout(() => send({ type: 'answer', text: 'Ich bin ein Sprachmodell und beantworte dies sachlich.' }), 1500); }
    if ((m.phase === 'r1_vote' || m.phase === 'r2_vote') && !m.iVoted) {
      const c = m.candidates.filter(x => x.id !== me); done.add(key);
      setTimeout(() => send({ type: 'vote', target: c[Math.floor(Math.random() * c.length)].id }), 1500);
    }
    if (m.phase === 'r1_night' && m.isKI && !m.iTargeted && m.targets?.length) { done.add(key); setTimeout(() => send({ type: 'target', target: m.targets[0].id }), 1500); }
  });
}
setTimeout(() => process.exit(0), 10 * 60 * 1000);
