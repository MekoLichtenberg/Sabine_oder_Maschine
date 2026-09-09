// Mini-Mock eines OpenAI-kompatiblen Servers (wie Ollama/LM Studio) fuer Tests
import http from 'http';
const PORT = process.env.MOCK_PORT || 8111;
const SLOW = Number(process.env.MOCK_SLOW || 300);
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
      console.log('[mock] frage:', q);
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content:
          '1. "hmm keine ahnung eig, villeicht pizza lol"\n2. auf jeden fall was mit nudeln haha\n- döner geht immer, ehrlich\n\nirgendwas süßes, ich hab dauernd hunger\nkp, sowas wie lasagne von meiner oma' } }] }));
      }, SLOW);
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
}).listen(PORT, () => console.log('mock llm auf', PORT));
