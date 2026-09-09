// Mini-Mock eines OpenAI-kompatiblen Servers (wie Ollama/LM Studio) fuer Tests.
// Liefert abwechselnd verschiedene Antwortformate, so wie echte Modelle es tun.
import http from 'http';
const PORT = process.env.MOCK_PORT || 8111;
const SLOW = Number(process.env.MOCK_SLOW || 300);
const FORMATS = [
  '1. "hmm keine ahnung eig, villeicht pizza lol"\n2. auf jeden fall was mit nudeln haha\n- döner geht immer, ehrlich\n\nirgendwas süßes, ich hab dauernd hunger\nkp, sowas wie lasagne von meiner oma',
  // alles in einer Zeile, nummeriert, abgeschnitten (so kam es von Apertus)
  '1. Gute alte Pizza, knusprig und saftig, einfach perfekt! 2. Nudelsalat mit viel frischem Gemüs',
  // Gedankenblock + Aufzaehlung mit Bindestrichen in einer Zeile
  '<think>Der Nutzer will drei Antworten.</think>Hier sind drei Antworten: - pizza mit extra käse - döner vom laden um die ecke - was meine mutter kocht'
];
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'smollm2:1.7b' }, { id: 'qwen2.5:3b' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const q = JSON.parse(body).messages.at(-1).content;
      const content = FORMATS[n++ % FORMATS.length];
      console.log('[mock] frage:', q, '| format', (n - 1) % FORMATS.length);
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      }, SLOW);
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
}).listen(PORT, () => console.log('mock llm auf', PORT));
