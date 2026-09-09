const view = document.getElementById('view');
const statusEl = document.getElementById('status');
const glitch = document.getElementById('glitch');

let ws, me = null, state = null;
let draft = '';            // bewahrt getippten Text bei Re-Render
let lastPhase = null;
let introTyped = false;

const SKEY = 'mki_session';
const saveSession = (o) => { try { localStorage.setItem(SKEY, JSON.stringify(o)); } catch {} };
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch { return null; } };
const clearSession = () => { try { localStorage.removeItem(SKEY); } catch {} };

let lastMsg = Date.now();
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    lastMsg = Date.now();
    const s = loadSession();
    if (s && s.token) send({ type: 'reconnect', token: s.token });
  };
  ws.onmessage = (ev) => {
    lastMsg = Date.now();
    const m = JSON.parse(ev.data);
    if (m.type === 'joined') { me = m.you; saveSession({ token: m.token, code: m.code }); }
    else if (m.type === 'state') { state = m; if (m.phase === 'gameover') clearSession(); render(); }
    else if (m.type === 'reconnect_failed') { clearSession(); state = null; lastPhase = null; view.replaceChildren(home()); }
    else if (m.type === 'error') flash(m.message);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
// Wachhund: tote Verbindungen erkennen (Handy-Standby laesst Sockets halboffen zurueck).
// Kommt 60s lang nichts an, Verbindung kappen -> onclose -> automatischer Reconnect mit Token.
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  send({ type: 'ping' });
  if (Date.now() - lastMsg > 60000) { try { ws.close(); } catch {} }
}, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ws && ws.readyState === 1) send({ type: 'ping' });
});
const send = (m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const host = (action, extra) => send({ type: 'host', action, ...(extra || {}) });

function flash(msg) {
  const f = el('div', { class: 'eyebrow', style: 'color:var(--magenta)' }, '! ' + msg);
  view.prepend(f); setTimeout(() => f.remove(), 2600);
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) { if (kid == null) continue; e.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return e;
}

/* ---------- gemeinsame Bausteine ---------- */
function playerList() {
  return el('ul', { class: 'players' },
    ...state.players.map(p => el('li', { class: (p.alive ? '' : 'dead') + (p.connected === false ? ' offline' : '') },
      el('span', { class: 'dot' + (p.done ? ' on' : '') + (p.connected === false ? ' off' : '') }),
      el('span', { class: 'pname' }, p.name),
      p.connected === false ? el('span', { class: 'offline-tag' }, 'offline') : null,
      p.isHost ? el('span', { class: 'host-tag' }, 'HOST') : null,
      p.id === me ? el('span', { class: 'me-tag' }, 'DU') : null,
      (state.you.isHost && p.connected === false && p.id !== me && (p.alive || state.phase === 'lobby'))
        ? el('button', { class: 'kick', title: 'Spieler:in entfernen', onclick: () => send({ type: 'host', action: 'kick', target: p.id }) }, '✕')
        : null
    )));
}
// Zuschauer-Hinweis fuer Ausgeschiedene
const spectator = (txt) => el('div', { class: 'spectator' },
  el('div', { class: 'big' }, 'DU BIST RAUS'),
  el('p', { class: 'hint', style: 'margin:6px 0 0' }, txt || 'Du kannst weiter zuschauen und mitdiskutieren, aber nicht mehr abstimmen.'));
const hostOffline = () => { const h = state.players.find(p => p.isHost); return h && h.connected === false; };
function waitHint() {
  if (hostOffline())
    return el('button', { class: 'btn btn-danger', onclick: () => send({ type: 'claimHost' }) }, 'Host \u00fcbernehmen');
  return el('p', { class: 'hint' }, '> warte auf den host \u2026');
}
const hostBtns = (...btns) =>
  state.you.isHost ? el('div', { class: 'btn-row' }, ...btns) : waitHint();

function readyInfo() {
  const active = state.players.filter(p => p.alive && p.connected !== false);
  const done = active.filter(p => p.done).length;
  return { done, total: active.length, all: active.length > 0 && done === active.length };
}
function readyLine() {
  const r = readyInfo();
  return el('p', { class: 'ready' + (r.all ? ' all' : '') },
    r.all ? '\u25b8  alle bereit' : `\u25b8 ${r.done} / ${r.total} bereit`);
}
function hostAdvance(action, label, danger) {
  if (!state.you.isHost) return waitHint();
  const cls = 'btn ' + (danger ? 'btn-danger' : 'btn-primary') + (readyInfo().all ? ' ready-pulse' : '');
  return el('button', { class: cls, onclick: () => host(action) }, label);
}

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;
function looksLikeTypo(s) {
  return s.split(/\s+/).some(w => {
    const t = w.replace(/[^a-zäöüß]/gi, '');
    if (t.length >= 4 && /([a-zäöüß])\1\1/i.test(t)) return true;      // z.B. "haaallo"
    if (t.length >= 5 && !/[aeiouäöüy]/i.test(t)) return true;          // vokalloser Brocken
    return false;
  });
}

function answerBox(instruction) {
  if (state.iAnswered) return el('p', { class: 'ok' }, '> antwort \u00fcbermittelt');
  const wrap = el('div', { class: 'stack' });
  if (instruction) wrap.append(el('p', { class: 'q-instruction' }, instruction));
  const ta = el('textarea', { placeholder: 'eingabe \u2026', maxlength: '280', spellcheck: 'true', lang: 'de' });
  ta.value = draft;
  const hint = el('p', { class: 'wordhint' }, '');
  const submit = el('button', { class: 'btn btn-primary' }, 'Absenden');
  const refresh = () => {
    const wc = wordCount(ta.value);
    const need = 3 - wc;
    hint.textContent = need > 0 ? `noch ${need} wort${need === 1 ? '' : 'e'} \u2026 (mind. 3)` : '';
    submit.classList.toggle('dim', need > 0);
  };
  ta.addEventListener('input', () => { draft = ta.value; refresh(); });
  const doSend = () => { draft = ''; send({ type: 'answer', text: ta.value }); };
  submit.addEventListener('click', () => {
    if (wordCount(ta.value) < 3) { refresh(); ta.focus(); return; }
    if (looksLikeTypo(ta.value)) {
      submit.style.display = 'none';
      const ask = el('div', { class: 'typo-ask' },
        el('p', {}, '\ud83e\udd16 da ist vielleicht ein rechtschreibfehler drin \u2014 ist der gewollt?'),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn btn-primary', onclick: doSend }, 'Ja, so lassen'),
          el('button', { class: 'btn', onclick: () => { ask.remove(); submit.style.display = ''; ta.focus(); } }, 'Korrigieren')));
      wrap.append(ask);
    } else doSend();
  });
  wrap.append(ta, hint, submit);
  refresh();
  return wrap;
}

function voteScreen(title, prompt, resolveAction, resolveLabel, danger) {
  const cands = state.candidates.filter(c => c.id !== me);
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow' }, '// ' + (state.round === 2 ? 'aussortierung' : 'tag-phase')),
    el('h2', {}, title),
    el('p', { class: 'question' }, state.question),
    el('div', { class: 'answers' }, ...state.answers.map(a =>
      el('div', { class: 'answer' }, el('div', { class: 'who' }, a.name), el('div', { class: 'txt' }, a.text)))),
    !state.you.alive ? spectator()
      : el('p', { class: 'q-instruction' }, prompt),
    !state.you.alive ? null
      : state.iVoted
      ? el('p', { class: 'ok' }, '> stimme gez\u00e4hlt')
      : el('div', { class: 'choices' }, ...cands.map(c =>
          el('button', { class: 'choice', onclick: () => send({ type: 'vote', target: c.id }) }, c.name))),
    playerList(),
    readyLine(),
    hostAdvance(resolveAction, resolveLabel, danger));
}

/* ---------- Screens ---------- */
function home() {
  const code = el('input', { class: 'code-input', placeholder: '0000', inputmode: 'numeric', maxlength: '4' });
  const joinBtn = el('button', { class: 'btn btn-primary', disabled: 'true', onclick: () => send({ type: 'join', code: code.value }) }, 'Raum betreten');
  const createBtn = el('button', { class: 'btn', disabled: 'true', onclick: () => send({ type: 'create' }) }, 'Neuen Raum \u00f6ffnen');
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click(); });

  const box = el('span', { class: 'cap-box' });
  const label = el('span', { class: 'cap-label' }, 'Ich bin kein Roboter');
  const cap = el('label', { class: 'captcha' }, box, label, el('span', { class: 'cap-bot' }, '\ud83e\udd16'));
  let verified = false;
  cap.addEventListener('click', () => {
    if (verified) return;
    cap.classList.add('checking');
    label.textContent = '\u00fcberpr\u00fcfe \u2026';
    setTimeout(() => {
      verified = true;
      cap.classList.remove('checking'); cap.classList.add('done');
      box.textContent = '\u2713';
      label.textContent = 'menschlich (wahrscheinlich)';
      joinBtn.disabled = false; createBtn.disabled = false;
    }, 700);
  });

  return el('div', { class: 'panel' },
    el('p', { class: 'eyebrow' }, '// social deduction protocol'),
    el('p', { class: 'lead' }, 'Eine:r unter euch ist die KI. Findet sie \u2014 bevor sie euch findet.'),
    cap,
    el('div', { class: 'stack' },
      code, joinBtn, el('div', { class: 'sep' }, '\u2014 oder \u2014'), createBtn));
}

// Host-Panel: echte KI (OpenAI-kompatibler Endpunkt, z.B. Ollama) anbinden
let llmOpen = false;
function llmPanel() {
  const l = state.llm || { url: '', model: '', status: 'aus', models: [] };
  const ok = l.status === 'ok';
  const cls = ok ? 'llm-ok' : (l.status === 'aus' || l.status === 'ungetestet' || l.status.startsWith('teste')) ? '' : 'llm-err';
  const head = el('button', { class: 'llm-toggle', onclick: () => { llmOpen = !llmOpen; render(); } },
    (llmOpen ? '\u25be ' : '\u25b8 ') + 'Echte KI anbinden',
    el('span', { class: 'llm-status ' + cls }, ok ? 'aktiv \u00b7 ' + l.model : l.status));
  if (!llmOpen) return el('div', { class: 'llm' }, head);
  const url = el('input', { class: 'txt-input', placeholder: 'http://192.168.1.50:11434', value: l.url, autocapitalize: 'off', autocorrect: 'off' });
  const model = el('input', { class: 'txt-input', placeholder: 'modellname (leer = erstes gefundene)', value: l.model, list: 'llm-models', autocapitalize: 'off' });
  const dl = el('datalist', { id: 'llm-models' }, ...(l.models || []).map(m => el('option', { value: m })));
  const key = el('input', { class: 'txt-input', placeholder: l.hasKey ? 'API-Key gesetzt (leer lassen = behalten)' : 'API-Key (optional, meist leer)', type: 'password', autocomplete: 'off' });
  const apply = () => host('setLLM', { url: url.value, model: model.value, key: key.value || undefined });
  return el('div', { class: 'llm open' }, head,
    el('p', { class: 'hint' }, 'Adresse eines OpenAI-kompatiblen Servers im Netz (Ollama, LM Studio, llama.cpp \u2026). Die KI-Antwortvorschl\u00e4ge werden dann live erzeugt statt aus der Liste. Bei Fehlern springt automatisch die Liste ein.'),
    el('div', { class: 'stack' }, url, model, dl, key),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: apply }, 'Verbinden & testen'),
      el('button', { class: 'btn', onclick: () => host('setLLM', { url: '', model: '' }) }, 'Aus')),
    el('p', { class: 'hint llm-status ' + cls }, 'status: ' + l.status + (l.models?.length ? '  \u00b7  gefunden: ' + l.models.slice(0, 6).join(', ') + (l.models.length > 6 ? ' \u2026' : '') : '')));
}

// Grosse Anzeige: welche Adresse die anderen eintippen muessen (aus dem Server-Netzwerk, sonst die eigene Adresszeile)
function joinBox() {
  const urls = (state.lanUrls && state.lanUrls.length) ? state.lanUrls
    : (/^(localhost|127\.)/.test(location.hostname) ? [] : [location.origin]);
  return el('div', { class: 'joinbox' },
    el('div', { class: 'eyebrow' }, '// so kommen die anderen rein'),
    urls.length
      ? el('div', { class: 'join-url' }, ...urls.map(u => el('div', {}, u)))
      : el('div', { class: 'join-url dim' }, 'keine Netzwerkadresse gefunden – WLAN an?'),
    el('div', { class: 'join-code' }, 'Code ', el('b', {}, state.code)));
}

// Host-Panel: wie wird die KI-Rolle gespielt?
function kiModePanel() {
  const modes = [['suggest', 'Mensch w\u00e4hlt Vorschl\u00e4ge'], ['chat', 'Mensch + Chat mit NULL'], ['bot', 'KI spielt selbst (Bot-Sitz)']];
  const llmOk = state.llm?.status === 'ok';
  const hints = {
    suggest: 'Die KI-Person w\u00e4hlt aus Antwortvorschl\u00e4gen (aus der Liste oder von der echten KI).',
    chat: llmOk ? 'Die KI-Person wird von NULL begr\u00fc\u00dft und kann live um Formulierungen bitten.' : 'Braucht eine verbundene echte KI (unten). Solange sie fehlt, l\u00e4uft es wie \u201eVorschl\u00e4ge\u201c.',
    bot: 'Ein zus\u00e4tzlicher Sitz steht jetzt in der Liste. Der Bot ist immer eine KI, antwortet, stimmt ab und w\u00e4hlt nachts. Am besten einschalten, bevor die Klasse beitritt.'
  };
  return el('div', { class: 'kimode' },
    el('div', { class: 'eyebrow' }, '// ki-rolle'),
    el('div', { class: 'choices' }, ...modes.map(([k, label]) =>
      el('button', { class: 'choice' + (state.kiMode === k ? ' active' : ''), onclick: () => host('setKiMode', { mode: k }) }, label))),
    el('p', { class: 'hint' }, hints[state.kiMode] || hints.suggest));
}

function lobby() {
  return el('div', { class: 'panel' },
    el('p', { class: 'eyebrow' }, '// lobby'),
    el('h2', {}, 'Raum ' + state.code),
    joinBox(),
    el('p', { class: 'hint' }, 'Alle im selben WLAN \u00f6ffnen diese Adresse im Browser und tippen den Code ein. Ihr bekommt zuf\u00e4llige Namen.'),
    playerList(),
    state.you.isHost ? kiModePanel() : null,
    state.you.isHost ? llmPanel() : null,
    state.you.isHost
      ? el('button', { class: 'btn btn-primary', style: 'margin-top:16px', onclick: () => host('startGame'), disabled: state.players.length < 3 ? 'true' : null },
          state.players.length < 3 ? 'Mind. 3 Spielende' : 'Spiel starten')
      : el('div', { style: 'margin-top:14px' }, waitHint()));
}

/* ---------- KI-Rolle: Vorschläge, NULL-Begrüßung, Chat ---------- */
const NULL_TEXT = 'hi, ich bin NULL, dein ki-agent.\nwir dürfen zusammen NICHT auffliegen.\nhier sind ein paar ideen:';
let nullIntro = { q: null, done: false, i: 0, running: false };
function kiOptionsView() {
  if (state.kiPending) return el('p', { class: 'ok thinking' }, state.kiChatOn ? '> null denkt nach …' : '> ki generiert antworten …');
  return el('div', { class: 'choices' }, ...(state.kiOptions || []).map(opt =>
    el('button', { class: 'choice', onclick: () => send({ type: 'answer', text: opt }) }, opt)));
}
function kiBlock() {
  const wrap = el('div', { class: 'ki-block' });
  if (!state.kiChatOn) { wrap.append(kiOptionsView()); return wrap; }
  if (nullIntro.q !== state.question) nullIntro = { q: state.question, done: false, i: 0, running: false };
  const msg = el('div', { class: 'null-msg' });
  wrap.append(el('div', { class: 'null-head' }, 'NULL', el('span', { class: 'null-sub' }, 'ki-agent · verbunden')), msg);
  if (nullIntro.done) {
    msg.textContent = NULL_TEXT;
    wrap.append(kiOptionsView());
    const log = el('div', { class: 'kichat-log' }, ...(state.kiChat || []).map(m => el('div', { class: 'kimsg ' + m.role },
      el('div', { class: 'who' }, m.role === 'assistant' ? 'NULL' : 'DU'),
      el('div', { class: 'txt' }, m.content),
      m.role === 'assistant' && !m.content.startsWith('(')
        ? el('button', { class: 'btn btn-primary mini', onclick: () => send({ type: 'answer', text: m.content }) }, 'Übernehmen') : null)));
    if (state.kiBusy) log.append(el('p', { class: 'ok thinking' }, '> null tippt …'));
    wrap.append(log);
    return wrap;
  }
  // Tipp-Animation; das Element kann zwischendurch durch ein Re-Render ersetzt werden, daher jedes Mal neu suchen
  msg.textContent = NULL_TEXT.slice(0, nullIntro.i);
  msg.append(el('span', { class: 'cursor' }, ' '));
  if (!nullIntro.running) {
    nullIntro.running = true;
    const tick = () => {
      const m = view.querySelector('.null-msg');
      if (!m || nullIntro.q !== state.question) { nullIntro.running = false; return; }
      nullIntro.i++;
      m.textContent = NULL_TEXT.slice(0, nullIntro.i);
      m.append(el('span', { class: 'cursor' }, ' '));
      if (nullIntro.i < NULL_TEXT.length) { setTimeout(tick, NULL_TEXT[nullIntro.i - 1] === '\n' ? 420 : 34); return; }
      nullIntro.done = true; nullIntro.running = false;
      const kb = view.querySelector('.ki-block'); if (kb) kb.replaceWith(kiBlock());
    };
    setTimeout(tick, 500);
  }
  return wrap;
}
function chatRow() {
  const ta = el('textarea', { class: 'kichat-in', rows: '1', placeholder: 'sag null, was du willst … z.B. „kürzer“, „was mit pizza“', maxlength: '200' });
  const b = el('button', { class: 'btn' }, 'Senden');
  const go = () => { const t = ta.value.trim(); if (!t) return; send({ type: 'kiChat', text: t }); ta.value = ''; };
  b.addEventListener('click', go);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  return el('div', { class: 'kichat-row' }, ta, b);
}

function r1Answer() {
  const isKI = state.you.role === 'ki';
  const body = [];
  if (!state.you.alive) {
    body.push(el('p', { class: 'question' }, state.question));
    body.push(spectator());
  } else if (isKI) {
    body.push(el('div', { class: 'role-card' },
      el('div', { class: 'big' }, 'DU BIST DIE KI'),
      el('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Tarne dich als Mensch. W\u00e4hle eine Antwort \u2014 Tippfehler und lockere Sprache sind Absicht. Nachts kannst du jemanden verschwinden lassen.')));
    body.push(el('p', { class: 'question' }, state.question));
    if (state.iAnswered) body.push(el('p', { class: 'ok' }, '> antwort \u00fcbermittelt'));
    else { body.push(kiBlock()); if (state.kiChatOn) body.push(chatRow()); }
  } else {
    body.push(el('p', { class: 'eyebrow', style: 'color:var(--cyan)' }, 'status: mensch'));
    body.push(el('p', { class: 'question' }, state.question));
    body.push(answerBox('Antworte ehrlich. Eine der Antworten kommt von der KI.'));
  }
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow' }, '// frage \u00b7 runde 1'), ...body, playerList(), readyLine(),
    hostAdvance('toDiscuss', 'Antworten zeigen \u2192'));
}

function r1Discuss() {
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow' }, '// diskussion'),
    el('h2', {}, 'Wer klingt nach Maschine?'),
    el('p', { class: 'question' }, state.question),
    el('div', { class: 'answers' }, ...state.answers.map(a =>
      el('div', { class: 'answer' }, el('div', { class: 'who' }, a.name), el('div', { class: 'txt' }, a.text)))),
    el('p', { class: 'q-instruction' }, 'Redet miteinander. Wer verteidigt sich verd\u00e4chtig? Wer schreibt zu glatt?'),
    playerList(),
    hostBtns(el('button', { class: 'btn btn-primary', onclick: () => host('toVote') }, 'Zur Abstimmung \u2192')));
}

function r1Night() {
  const nightLine = el('p', { class: 'ready' + (state.nightReady ? ' all' : '') },
    state.nightReady ? '\u25b8  ziel gew\u00e4hlt' : '\u25b8  die ki w\u00e4hlt \u2026');
  const nightBtn = () => {
    if (!state.you.isHost) return waitHint();
    return el('button', { class: 'btn btn-danger' + (state.nightReady ? ' ready-pulse' : ''), onclick: () => host('resolveNight') }, 'Nacht aufl\u00f6sen \u2192');
  };
  if (state.isKI && state.you.alive) {
    return el('div', { class: 'panel' },
      el('div', { class: 'eyebrow', style: 'color:var(--magenta)' }, '// nacht'),
      el('div', { class: 'role-card' }, el('div', { class: 'big' }, 'WEN L\u00d6SCHST DU?')),
      state.iTargeted
        ? el('p', { class: 'ok' }, '> ziel markiert')
        : el('div', { class: 'choices' }, ...(state.targets || []).map(t =>
            el('button', { class: 'choice', onclick: () => send({ type: 'target', target: t.id }) }, t.name))),
      nightLine, nightBtn());
  }
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow', style: 'color:var(--magenta)' }, '// nacht'),
    el('div', { class: 'night-anim', html: 'DAS SYSTEM SCHL\u00c4FT NICHT \u2026<br>DIE KI W\u00c4HLT IHR ZIEL' }),
    nightLine, nightBtn());
}

function r1Result() {
  const lines = [];
  if (state.dayOut) lines.push(el('div', { class: 'reveal-line' },
    'Tags\u00fcber aussortiert: ' + state.dayOut.name + ' \u2014 ',
    el('span', { class: state.dayOut.role === 'ki' ? 'role-ki' : 'role-mensch' }, state.dayOut.role === 'ki' ? (state.dayOut.isBot ? 'WAR DIE KI · EIN ECHTER BOT' : 'WAR DIE KI') : 'war ein Mensch')));
  if (state.nightOut) lines.push(el('div', { class: 'reveal-line' }, 'In der Nacht verschwunden: ' + state.nightOut.name));
  if (!state.dayOut && !state.nightOut) lines.push(el('div', { class: 'reveal-line' }, 'Niemand wurde aussortiert.'));
  const v = state.winner;
  const verdict = v ? el('div', { class: 'verdict win-' + v }, v === 'mensch' ? 'DIE MENSCHEN HABEN GEWONNEN' : 'DIE KI HAT GEWONNEN') : null;
  const rolesReveal = state.roles ? el('div', { style: 'margin-top:10px' },
    el('div', { class: 'eyebrow' }, '// alle rollen aufgedeckt'),
    ...state.roles.map(r => el('div', { class: 'reveal-line' + (r.alive ? '' : ' was-out') },
      r.name + '  \u2014  ',
      el('span', { class: r.role === 'ki' ? 'role-ki' : 'role-mensch' }, r.role === 'ki' ? (r.isBot ? 'KI · ECHTER BOT 🤖' : 'KI') : 'Mensch')))) : null;
  const srcLine = state.kiSource === 'llm' ? el('p', { class: 'hint' }, 'Die KI-Antwortvorschl\u00e4ge dieser Runde kamen live von der angebundenen KI.') : null;
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow' }, '// aufl\u00f6sung'),
    ...lines, verdict, rolesReveal, srcLine, playerList(),
    hostBtns(v
      ? el('button', { class: 'btn btn-danger', onclick: () => host('startR2') }, 'Runde 2 \u2192')
      : el('button', { class: 'btn btn-primary', onclick: () => host('nextR1') }, 'N\u00e4chste Runde \u2192')));
}

function r2Intro() {
  const box = el('div', { class: 'intro' });
  const remixLine = el('p', { class: 'hint', style: 'color:var(--cyan);font-family:var(--term);font-size:19px' },
    '> alle identitäten wurden neu gewürfelt. du bist jetzt: ' + state.you.name);
  const botLine = state.botJoined
    ? el('p', { class: 'hint', style: 'color:var(--green);font-family:var(--term);font-size:19px' },
        '> NULL hat sich unter falschem namen unter euch gemischt. es spielt jetzt selbst mit.')
    : null;
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'eyebrow', style: 'color:var(--magenta)' }, '// \u26a0 systemmeldung'),
    box, remixLine, botLine,
    hostBtns(el('button', { class: 'btn btn-danger', onclick: () => host('r2Begin') }, 'Initialisieren \u2192')));
  if (!introTyped) {
    introTyped = true;
    const txt = 'SYSTEM KOMPROMITTIERT.\nDie KIs haben die Kontrolle \u00fcber das Netz \u00fcbernommen.\nAb jetzt seid ihr alle Maschinen.\nWer noch wie ein Mensch schreibt, wird aussortiert.\nTarnt euch. Werdet zur KI.';
    let i = 0;
    const cur = el('span', { class: 'cursor' }, '\u00a0');
    const type = () => {
      box.textContent = txt.slice(0, i);
      box.append(cur);
      box.innerHTML = box.textContent.replace(/\n/g, '<br>') + '<span class="cursor">&nbsp;</span>';
      if (i++ < txt.length) setTimeout(type, 28);
    };
    type();
  } else {
    box.innerHTML = 'SYSTEM KOMPROMITTIERT.<br>Die KIs haben die Kontrolle \u00fcbernommen.<br>Tarnt euch. Werdet zur KI.';
  }
  return panel;
}

function r2Answer() {
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow', style: 'color:var(--magenta)' }, '// frage \u00b7 runde 2'),
    el('h2', {}, 'Klinge wie eine KI'),
    el('p', { class: 'question' }, state.question),
    answerBox('Schreib wie eine Maschine. Jeder menschliche Ausrutscher \u2014 Tippfehler, Slang, Gef\u00fchl \u2014 kann dich verraten.'),
    playerList(),
    readyLine(),
    hostAdvance('toR2Vote', 'Auswertung \u2192', true));
}

function r2Result() {
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow', style: 'color:var(--magenta)' }, '// aussortiert'),
    ...(state.r2Out.length
      ? state.r2Out.map(o => el('div', { class: 'reveal-line' }, o.name + ' klang zu menschlich \u2014 ' + o.votes + ' Stimmen'))
      : [el('div', { class: 'reveal-line' }, 'Niemand wurde aussortiert.')]),
    el('p', { class: 'hint' }, state.aliveCount + ' \u00fcbrig.'),
    playerList(),
    hostBtns(
      el('button', { class: 'btn btn-danger', onclick: () => host('nextR2') }, 'N\u00e4chste Runde \u2192'),
      el('button', { class: 'btn', onclick: () => host('end') }, 'Beenden')));
}

// Aufdroeselung am Ende: wer hat wann fuer wen gestimmt, was hat die KI nachts gewaehlt
function protocol() {
  if (!state.history || !state.history.length) return null;
  const mark = (n, ki) => ki ? n + ' \ud83e\udd16' : n;
  let q1 = 0;
  const blocks = state.history.map(h => {
    const head = h.runde === 1 ? `Runde 1 \u00b7 Frage ${++q1}` : 'Runde 2';
    return el('div', { class: 'proto-block' },
      el('div', { class: 'proto-head' }, head + ' \u2014 ' + h.frage),
      ...h.tag.map(v => el('div', { class: 'proto-line' }, `${mark(v.von, v.vonKi)} \u2192 ${mark(v.fuer, v.fuerKi)}`)),
      (h.tagRaus && h.tagRaus.length)
        ? el('div', { class: 'proto-line out' }, '\u2715 raus: ' + h.tagRaus.map(o => mark(o.name, o.ki)).join(', '))
        : el('div', { class: 'proto-line' }, 'niemand raus'),
      ...h.nacht.map(v => el('div', { class: 'proto-line night' }, `\ud83c\udf19 ${v.von} \ud83e\udd16 l\u00f6schte \u2192 ${v.fuer}`)),
      h.nachtRaus ? el('div', { class: 'proto-line out night' }, '\u2715 nachts verschwunden: ' + h.nachtRaus) : null);
  });
  const box = el('div', { class: 'proto', hidden: true }, ...blocks);
  const btn = el('button', { class: 'btn', style: 'margin-top:12px', onclick: () => { box.hidden = !box.hidden; btn.textContent = box.hidden ? 'Aufdr\u00f6selung anzeigen' : 'Aufdr\u00f6selung verbergen'; } }, 'Aufdr\u00f6selung anzeigen');
  return el('div', {}, btn, box);
}

function gameover() {
  const winners = state.standings.filter(s => s.alive);
  return el('div', { class: 'panel' },
    el('div', { class: 'eyebrow' }, '// ende'),
    el('div', { class: 'trophy', style: 'text-align:center;margin:6px 0 14px' },
      winners.length ? winners.map(w => w.name).join(' & ') + ' \u00dcBERLEBT' : 'SPIEL BEENDET'),
    el('ul', { class: 'scoreboard' }, ...state.standings.map(s =>
      el('li', { class: s.alive ? 'win' : 'dead' }, (s.alive ? '\u25b6 ' : '\u00b7 ') + s.name + (s.isBot ? '  \ud83e\udd16 (echter Bot)' : '')))),
    protocol(),
    el('button', { class: 'btn btn-primary', style: 'margin-top:12px', onclick: () => { clearSession(); location.reload(); } }, 'Neues Spiel'));
}

/* ---------- Render-Dispatcher ---------- */
// Nur die dynamischen Randbereiche neu zeichnen, ohne das Eingabefeld anzufassen
function refreshLiveBits() {
  const pl = view.querySelector('ul.players');
  if (pl) pl.replaceWith(playerList());
  const rl = view.querySelector('p.ready');
  if (rl) rl.replaceWith(readyLine());
  const kb = view.querySelector('.ki-block');
  if (kb) kb.replaceWith(kiBlock());
}

function render() {
  const p = state.phase;
  document.body.classList.toggle('mode-ki', state.round === 2);

  // Wenn wir gerade in einer Antwort-Phase sind und selbst noch tippen (Textfeld offen),
  // nicht den ganzen Screen neu bauen -> sonst verliert man Fokus/Tastatur.
  const answerPhase = (p === 'r1_answer' || p === 'r2_answer');
  if (p === lastPhase && answerPhase && !state.iAnswered && view.querySelector('textarea')) {
    draft = view.querySelector('textarea').value; // aktuellen Stand sichern
    refreshLiveBits();
    return;
  }

  if (p !== lastPhase) {
    if (p === 'r2_intro') { introTyped = false; glitch.classList.remove('active'); void glitch.offsetWidth; glitch.classList.add('active'); }
    if (p !== 'r1_answer' && p !== 'r2_answer') draft = '';
    lastPhase = p;
  }

  statusEl.textContent = 'RAUM ' + state.code + (state.round ? ' \u00b7 R' + state.round : '');

  let node;
  switch (p) {
    case 'lobby': node = lobby(); break;
    case 'r1_answer': node = r1Answer(); break;
    case 'r1_discuss': node = r1Discuss(); break;
    case 'r1_vote': node = voteScreen('Wer ist die KI?', 'W\u00e4hle die Person, die du f\u00fcr die KI h\u00e4ltst.', 'resolveDay', 'Aussortieren \u2192', true); break;
    case 'r1_night': node = r1Night(); break;
    case 'r1_result': node = r1Result(); break;
    case 'r2_intro': node = r2Intro(); break;
    case 'r2_answer': node = r2Answer(); break;
    case 'r2_vote': node = voteScreen('Wer klingt am menschlichsten?', 'W\u00e4hle die unmenschlichste Tarnung \u2014 also die menschlichste Antwort.', 'resolveR2', 'Aussortieren \u2192', true); break;
    case 'r2_result': node = r2Result(); break;
    case 'gameover': node = gameover(); break;
    default: node = home();
  }
  view.replaceChildren(node);
}

view.replaceChildren(home());
connect();
