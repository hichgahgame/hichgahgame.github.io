// Hichgah voice recording page. A pack (voice/packs/<name>.pack, made by voice/tools/voice make) holds the
// lines to record, encrypted with a password; the pack's file name comes from the same password, so
// nothing can be listed or read without it. Recordings are kept in this browser (IndexedDB) until the
// person sends them as one zip (recordings.json + WAV files), which `voice import` puts into the app.

const ITERATIONS = 310000;                       // as voice_pack.py
const NAME_SALT = 'hichgah-voice-pack-name/1';
const MAX_SECONDS = 30;                          // a recording stops by itself after this
const SKIP_START = 0.1;                          // seconds dropped at the start (the tap on the button)
const SECONDS_PER_LINE = 15;                     // for the time estimate: read, record, listen
const KEY_STORE = 'hichgah-voice-key';
const app = document.getElementById('app');

// ---------- small helpers ----------

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function icon(name) {
  const paths = {
    mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M8 21h8',
    stop: 'M7 7h10v10H7z',
    play: 'M8 5l11 7-11 7z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name]);
  const filled = name !== 'mic';
  p.setAttribute('fill', filled ? 'currentColor' : 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', filled ? '1' : '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

const enc = (s) => new TextEncoder().encode(s);
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const rtl = (lang) => ['fa', 'ar', 'he', 'ur'].includes(lang);
const minutes = (n) => Math.max(5, Math.ceil((n * SECONDS_PER_LINE) / 60 / 5) * 5);

function say(text, lang, cls) {
  return el('span', { class: cls, lang, dir: rtl(lang) ? 'rtl' : 'ltr', text });
}

function picture(script, line, cls) {
  if (line.image && script.images?.[line.image]) {
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(script.images[line.image]);
    return el('span', { class: cls, 'aria-hidden': 'true' }, el('img', { src, alt: '' }));
  }
  if (line.picture) return el('span', { class: cls, 'aria-hidden': 'true', text: line.picture });
  return null;
}

// ---------- crypto ----------

async function pbkdf2(password, salt, bytes, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, bytes * 8);
  return new Uint8Array(bits);
}

async function openPack(password) {
  const name = hex(await pbkdf2(password, enc(NAME_SALT), 16));
  const res = await fetch(`packs/${name}.pack`, { cache: 'no-store' });
  if (res.status === 404) throw new Error('wrong');
  if (!res.ok) throw new Error('network');
  const pack = await res.json();
  const raw = await pbkdf2(password, b64(pack.salt), 32, pack.iterations);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(pack.iv) }, key, b64(pack.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- storage (IndexedDB): clips = WAV bytes, meta = {seconds, at, text}, notes = {note, text, at} ----------

let db;
function openDb() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open('hichgah-voice', 1);
    r.onupgradeneeded = () => ['clips', 'meta', 'notes'].forEach((s) => r.result.createObjectStore(s));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((ok, fail) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req && req.result);
    t.onerror = () => fail(t.error);
    t.onabort = () => fail(t.error);
  });
}
const dbGet = (s, k) => tx(s, 'readonly', (st) => st.get(k));
const dbPut = (s, k, v) => tx(s, 'readwrite', (st) => st.put(v, k));
const dbDel = (s, k) => tx(s, 'readwrite', (st) => st.delete(k));
async function dbAll(store) {
  const keys = await tx(store, 'readonly', (st) => st.getAllKeys());
  const values = await tx(store, 'readonly', (st) => st.getAll());
  return new Map(keys.map((k, i) => [k, values[i]]));
}

// ---------- state ----------

const state = {
  password: '',
  pack: null,
  scriptIndex: 0,
  lang: null,
  group: null,        // null = every group
  onlyLeft: false,
  meta: new Map(),    // `${app}|${lang}/${id}` -> {seconds, at, text}
  notes: new Map(),
  index: 0,           // the line open in the recorder, in the filtered list
};
const keyOf = (script, line) => `${script.app}|${line.lang}/${line.id}`;
const script = () => state.pack.scripts[state.scriptIndex];
const langs = (s) => [...new Set(s.lines.map((l) => l.lang))];
function linesFor(s, { lang = state.lang, group = state.group, onlyLeft = state.onlyLeft } = {}) {
  return s.lines.filter((l) => l.lang === lang && (!group || l.group === group) && (!onlyLeft || !state.meta.has(keyOf(s, l))));
}
const recordedCount = (s, lines) => lines.filter((l) => state.meta.has(keyOf(s, l))).length;
const allLines = () => state.pack.scripts.flatMap((s) => s.lines.map((l) => [s, l]));
const firstVisit = () => localStorage.getItem(`hichgah-voice-welcomed-${state.pack.made}-${state.pack.person}`) !== '1';
const markWelcomed = () => localStorage.setItem(`hichgah-voice-welcomed-${state.pack.made}-${state.pack.person}`, '1');

function show(...nodes) {
  stopPlayback();
  app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
  window.scrollTo(0, 0);
}

function header() {
  return el('div', { class: 'mark' },
    el('img', { src: '../brand/logo/hichgah-app-icon.svg', alt: '' }),
    el('span', { text: 'Hichgah · voice recording' }));
}

// ---------- lock ----------

function showLock(error = '') {
  const input = el('input', {
    type: 'password', id: 'pw', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-label': 'Password', placeholder: 'Password',
  });
  const remember = el('input', { type: 'checkbox', checked: true });
  const button = el('button', { class: 'primary wide', type: 'submit', text: 'Open' });
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      button.disabled = true;
      button.replaceChildren(el('span', { class: 'busy', 'aria-hidden': 'true' }), 'Opening…');
      await unlock(input.value.trim(), remember.checked);
    },
  },
  el('p', {}, el('label', { for: 'pw', class: 'muted', text: 'Type the password you were sent.' })),
  input,
  el('label', { class: 'check' }, remember, 'Remember it on this device'),
  error ? el('p', { class: 'error', role: 'alert', text: error }) : null,
  button);
  show(header(),
    el('h1', { text: 'Record voices for a children’s game' }),
    el('p', { class: 'muted', text: 'This private page lets you read and record the words and sentences of a Hichgah game, '
      + 'on your phone or computer. Nothing is uploaded: you send the recordings yourself when you are done.' }),
    el('div', { class: 'card' }, form));
  input.focus();
}

async function unlock(password, remember) {
  try {
    state.pack = await openPack(password);
  } catch (e) {
    localStorage.removeItem(KEY_STORE);
    return showLock(e.message === 'wrong'
      ? 'That password doesn’t open anything. Check it and try again (it is case-sensitive).'
      : 'The page couldn’t reach the internet. Check the connection and try again.');
  }
  state.password = password;
  if (remember) localStorage.setItem(KEY_STORE, password); else localStorage.removeItem(KEY_STORE);
  db = db || await openDb();
  state.meta = await dbAll('meta');
  state.notes = await dbAll('notes');
  state.scriptIndex = 0;
  state.lang = langs(script())[0];
  navigator.storage?.persist?.();
  if (firstVisit()) showWelcome(0); else showList();
}

function lock() {
  localStorage.removeItem(KEY_STORE);
  state.pack = null;
  showLock();
}

// ---------- welcome (onboarding) ----------

const STEPS = 5;

function showWelcome(step) {
  const s = script();
  const total = allLines().length;
  const titles = state.pack.scripts.map((x) => x.title).join(' and ');
  const dots = el('div', { class: 'dots', 'aria-label': `Step ${step + 1} of ${STEPS}` },
    [...Array(STEPS)].map((_, i) => el('span', { class: i === step ? 'on' : '' })));
  const next = (label = 'Next') => el('button', { class: 'primary wide', text: label,
    onclick: () => (step + 1 < STEPS ? showWelcome(step + 1) : finishWelcome()) });
  const back = step > 0 ? el('button', { class: 'quiet', text: 'Back', onclick: () => showWelcome(step - 1) }) : null;
  const skip = el('button', { class: 'link', text: 'Skip the introduction', onclick: finishWelcome });
  let body;

  if (step === 0) {
    const name = state.pack.person ? `Hello ${state.pack.person}!` : 'Hello!';
    body = [
      el('h1', { text: name }),
      el('p', { text: `Thank you for lending your voice to ${titles}, a Hichgah game for children. `
        + 'Children will hear your voice when they play: every word, letter and sentence you record here is played '
        + 'in the game.' }),
      el('div', { class: 'card facts' },
        fact(String(total), total === 1 ? 'line to record' : 'lines to record'),
        fact(`about ${minutes(total)} min`, 'in total; stop and come back any time'),
        fact(langs(s).map((l) => s.languages?.[l] || l).join(', '), 'language')),
      state.pack.message ? el('div', { class: 'message', text: state.pack.message }) : null,
      el('p', { class: 'muted', text: 'The next few screens show how it works. It takes about two minutes.' }),
    ];
  } else if (step === 1) {
    const line = s.lines.find((l) => l.lang === state.lang) || s.lines[0];
    body = [
      el('h2', { text: 'What you will see' }),
      el('p', { text: 'One line at a time, like this one from your list. Read the line out loud, as it is written.' }),
      el('div', { class: 'card preview recorder', 'aria-hidden': 'true' },
        el('div', { class: 'count', text: `1 / ${linesFor(s, { group: null, onlyLeft: false }).length}` }),
        el('span', { class: 'group', text: line.group }),
        picture(s, line, 'picture'),
        el('div', {}, say(line.text, line.lang, 'say')),
        line.direction ? el('p', { class: 'direction', text: line.direction }) : null,
        el('div', { class: 'controls' },
          el('span', { class: 'mic fake' }, icon('mic')),
          el('span', { class: 'play fake' }, icon('play')))),
      el('ul', { class: 'legend' },
        s.lines.some((l) => l.picture || l.image) ? el('li', {}, el('b', { text: 'The picture' }), ' shows what the word means.') : null,
        el('li', {}, el('b', { text: 'The small grey line' }), ' says how to say it: the reading in Latin letters, '
          + 'its meaning, or a tip such as “just the sound”.'),
        el('li', {}, el('b', { text: 'The purple button' }), ' records; ', el('b', { text: 'the round one' }),
          ' beside it plays your recording back.')),
    ];
  } else if (step === 2) {
    body = [
      el('h2', { text: 'How to record a line' }),
      el('ol', { class: 'steps' },
        el('li', {}, 'Tap the ', el('b', { text: 'purple microphone' }), '. It turns red while it listens.'),
        el('li', {}, 'Wait a moment, say the line once, wait a moment, then tap the ', el('b', { text: 'red square' }), ' to stop.'),
        el('li', {}, 'Your recording plays back straight away. Not happy? Just record it again: the new one replaces it.'),
        el('li', {}, 'Tap ', el('b', { text: 'Next' }), '. A green tick marks each line you have recorded.'),
        el('li', {}, 'Something looks wrong (a typo, a word that sounds odd)? Tap ', el('b', { text: 'Add a note' }),
          ' and tell us. Notes are sent with the recordings.')),
      el('p', { class: 'muted', text: 'You don’t have to go in order or finish in one go: the list shows what is left, '
        + 'and you can filter it by group.' }),
    ];
  } else if (step === 3) {
    body = [
      el('h2', { text: 'Your voice, and a quick test' }),
      s.guide ? el('div', { class: 'message', text: s.guide }) : null,
      el('ul', { class: 'legend' },
        el('li', { text: 'A quiet room, no music or TV; soft furnishings help (a bedroom is better than a kitchen).' }),
        el('li', { text: 'Hold the phone 20 to 30 cm from your mouth, and keep the same distance for every line.' }),
        el('li', { text: 'Speak as you would to a 5-year-old: warm, clear, a little slow. Not a whisper, not a shout.' })),
      micTest(),
    ];
  } else {
    body = [
      el('h2', { text: 'When you are done' }),
      el('ol', { class: 'steps' },
        el('li', {}, 'Tap ', el('b', { text: 'Send recordings' }), ' on the list. It makes one file with everything you recorded.'),
        el('li', {}, 'Send that file to the person who gave you the password, the way you usually talk: WhatsApp '
          + '(as a document), Telegram, email or Google Drive.'),
        el('li', {}, 'You can send part of it now and the rest later: each file has everything recorded so far.')),
      el('div', { class: 'card' },
        el('p', {}, el('b', { text: 'Your recordings stay on this device, in this browser, until you send them.' })),
        el('p', { class: 'muted', text: 'Nothing is uploaded and nobody else can hear them. Keep using the same browser '
          + '(not a private window), and don’t clear its browsing data until you have sent the file.' })),
    ];
  }

  show(header(), dots, ...body,
    el('div', { class: 'actions' }, el('div', { class: 'row' }, back, next(step + 1 < STEPS ? 'Next' : 'Start recording'))),
    step + 1 < STEPS ? skip : null);
}

function fact(big, small) {
  return el('div', { class: 'fact' }, el('b', { text: big }), el('span', { class: 'muted', text: small }));
}

function finishWelcome() {
  markWelcomed();
  stopTest();
  showList();
}

// A test recording, never saved: checks the microphone works and the level is right.
let testTake = null;
function micTest() {
  const status = el('p', { class: 'status', text: 'Try the microphone: tap it, say your name, tap it again.' });
  const meter = el('div', { class: 'meter' }, el('span'));
  const play = el('button', { class: 'play', 'aria-label': 'Play the test', disabled: true, onclick: () => playWav(testTake.wav) }, icon('play'));
  const mic = el('button', { class: 'mic', 'aria-label': 'Test the microphone' }, icon('mic'));
  mic.onclick = async () => {
    if (recorder.active) {
      const take = await recorder.stop();
      mic.classList.remove('on');
      mic.replaceChildren(icon('mic'));
      if (!take) return;
      testTake = take;
      play.disabled = false;
      const v = verdict(take);
      status.className = 'status ' + (v.ok ? 'good' : 'warn');
      status.textContent = v.ok ? 'That sounds right. You are ready.' : v.text;
      playWav(take.wav);
      return;
    }
    try {
      status.className = 'status';
      status.textContent = 'Allow the microphone if the browser asks…';
      await recorder.start(meter.firstChild);
      mic.classList.add('on');
      mic.replaceChildren(icon('stop'));
      status.textContent = 'Listening… tap again to stop.';
    } catch (e) {
      status.className = 'status warn';
      status.textContent = micError(e);
    }
  };
  return el('div', { class: 'card recorder' }, el('div', { class: 'controls' }, mic, play), meter, status);
}
function stopTest() { if (recorder.active) recorder.stop(); }

// ---------- the list ----------

function showList() {
  const s = script();
  const all = linesFor(s, { group: null, onlyLeft: false });
  const done = recordedCount(s, all);
  const shown = linesFor(s);
  const sending = allLines().filter(([sc, l]) => state.meta.has(keyOf(sc, l))).length;

  const groups = [...new Set(all.map((l) => l.group))];
  const chip = (label, value) => el('button', {
    class: 'chip', 'aria-pressed': String(state.group === value), text: label,
    onclick: () => { state.group = value; showList(); },
  });

  const scriptTabs = state.pack.scripts.length > 1 ? el('div', { class: 'chips' }, state.pack.scripts.map((x, i) =>
    el('button', { class: 'chip', 'aria-pressed': String(i === state.scriptIndex), text: x.title,
      onclick: () => { state.scriptIndex = i; state.lang = langs(x)[0]; state.group = null; showList(); } }))) : null;
  const langPick = langs(s).length > 1 ? el('select', { 'aria-label': 'Language',
    onchange: (e) => { state.lang = e.target.value; state.group = null; showList(); } },
  langs(s).map((l) => el('option', { value: l, selected: l === state.lang, text: s.languages?.[l] || l }))) : null;

  const firstLeft = shown.findIndex((l) => !state.meta.has(keyOf(s, l)));
  const list = el('ul', { class: 'lines' }, shown.map((line, i) => {
    const k = keyOf(s, line);
    const has = state.meta.has(k);
    return el('li', {}, el('button', {
      class: 'line' + (has ? ' done' : ''),
      'aria-label': `${line.text}, ${has ? 'recorded' : 'not recorded yet'}`,
      onclick: () => openRecorder(i),
    },
    el('span', { class: 'state', text: has ? '✓' : '' }),
    picture(s, line, 'pic'),
    el('span', { class: 'what' }, say(line.text, line.lang, 'say'),
      el('span', { class: 'sub', text: [line.group, line.direction].filter(Boolean).join(' · ') })),
    state.notes.has(k) ? el('span', { class: 'flag', text: 'note' }) : null));
  }));

  show(header(),
    el('div', { class: 'top' },
      el('div', {}, el('h1', { text: s.title }),
        state.pack.person ? el('div', { class: 'muted small', text: `For ${state.pack.person}` }) : null),
      langPick),
    scriptTabs,
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.length), 'aria-valuenow': String(done) },
      el('span', { style: `width:${all.length ? (100 * done) / all.length : 0}%` })),
    el('p', { class: 'muted small', text: done === all.length && all.length
      ? `All ${all.length} lines recorded. Thank you! Send them when you are ready.`
      : `${done} of ${all.length} recorded` }),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', disabled: !shown.length, text: firstLeft >= 0 ? (done ? 'Continue recording' : 'Start recording') : 'Listen again from the start',
        onclick: () => openRecorder(Math.max(0, firstLeft)) }),
      el('button', { class: 'send', disabled: !sending, text: sending ? `Send recordings (${sending})` : 'Send recordings',
        onclick: showSend })),
    groups.length > 1 ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Groups' },
      chip('All', null), groups.map((g) => chip(g, g))) : null,
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: state.onlyLeft, onchange: (e) => { state.onlyLeft = e.target.checked; showList(); } }),
      'Only the lines not recorded yet'),
    shown.length ? list : el('p', { class: 'muted', text: 'Nothing left here. 🎉' }),
    el('div', { class: 'row nav' },
      el('button', { class: 'link', text: 'How it works', onclick: () => showWelcome(1) }),
      el('button', { class: 'link', text: 'Lock this page', onclick: lock })));
}

// ---------- the recorder ----------

let wakeLock = null;
let filtered = [];

function openRecorder(index) {
  filtered = linesFor(script());
  state.index = index;
  if (history.state?.view !== 'rec') history.pushState({ view: 'rec' }, '');
  navigator.wakeLock?.request('screen').then((w) => { wakeLock = w; }).catch(() => {});
  showRecorder();
}

function leaveRecorder() {
  if (recorder.active) recorder.stop();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (history.state?.view === 'rec') history.back(); else showList();
}

window.addEventListener('popstate', () => {
  if (!state.pack) return;
  if (recorder.active) recorder.stop();
  showList();
});

async function showRecorder(message) {
  const s = script();
  const line = filtered[state.index];
  const k = keyOf(s, line);
  const meta = state.meta.get(k);
  const note = state.notes.get(k);

  const status = el('p', { class: 'status', role: 'status' });
  const setStatus = (text, cls = '') => { status.className = 'status ' + cls; status.textContent = text; };
  if (message) setStatus(message.text, message.cls);
  else if (meta) setStatus(`Recorded ✓ (${meta.seconds.toFixed(1)} s). Record again to replace it.`, 'good');
  else setStatus('Not recorded yet');

  const meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, el('span'));
  const play = el('button', { class: 'play', 'aria-label': 'Play my recording', disabled: !meta,
    onclick: async () => { const wav = await dbGet('clips', k); if (wav) playWav(wav); } }, icon('play'));
  const mic = el('button', { class: 'mic', 'aria-label': 'Record' }, icon('mic'));
  mic.onclick = async () => {
    if (recorder.active) {
      const take = await recorder.stop();
      if (!take) return showRecorder();
      const v = verdict(take);
      if (!v.ok && v.silent) return showRecorder({ text: v.text, cls: 'warn' });
      await dbPut('clips', k, take.wav);
      const m = { seconds: take.seconds, at: new Date().toISOString(), text: line.text };
      await dbPut('meta', k, m);
      state.meta.set(k, m);
      const long = line.maxSeconds && take.seconds > line.maxSeconds + 1.2;   // the importer trims the pauses
      await showRecorder(long
        ? { text: `Recorded, but it is long (${take.seconds.toFixed(1)} s). Try a shorter take, with shorter pauses.`, cls: 'warn' }
        : v.ok ? { text: 'Recorded ✓ Listen, then tap Next.', cls: 'good' } : { text: v.text, cls: 'warn' });
      playWav(take.wav);
      return;
    }
    stopPlayback();
    try {
      setStatus('Allow the microphone if the browser asks…');
      await recorder.start(meter.firstChild, () => mic.click());
      mic.classList.add('on');
      mic.setAttribute('aria-label', 'Stop');
      mic.replaceChildren(icon('stop'));
      play.disabled = true;
      setStatus('Listening… say the line, then tap ■');
    } catch (e) {
      setStatus(micError(e), 'warn');
    }
  };

  const noteText = el('textarea', { 'aria-label': 'Note', dir: 'auto', placeholder: 'For example: a typo, a word that sounds odd, a better way to say it…' });
  noteText.value = note?.note || '';
  let noteTimer;
  noteText.oninput = () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      const text = noteText.value.trim();
      if (text) {
        const n = { note: text, text: line.text, at: new Date().toISOString() };
        state.notes.set(k, n);
        await dbPut('notes', k, n);
      } else {
        state.notes.delete(k);
        await dbDel('notes', k);
      }
    }, 400);
  };
  const noteBox = el('div', { class: 'note-box', hidden: !note }, noteText);
  const noteButton = el('button', { class: 'link', text: note ? 'Your note' : 'Add a note about this line',
    onclick: () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteText.focus(); } });

  const go = (d) => { if (recorder.active) recorder.stop(); clearTimeout(noteTimer); noteText.oninput(); state.index += d; showRecorder(); };
  show(
    el('div', { class: 'top' },
      el('button', { class: 'link', text: '‹ All lines', onclick: leaveRecorder }),
      el('span', { class: 'count muted', text: `${state.index + 1} / ${filtered.length}` })),
    el('div', { class: 'card recorder' },
      el('span', { class: 'group', text: line.group }),
      picture(s, line, 'picture'),
      el('div', {}, say(line.text, line.lang, 'say')),
      line.direction ? el('p', { class: 'direction', text: line.direction }) : null,
      el('div', { class: 'controls' }, mic, play),
      meter,
      status,
      noteButton,
      noteBox),
    el('div', { class: 'row nav' },
      el('button', { class: 'quiet', text: 'Previous', disabled: state.index === 0, onclick: () => go(-1) }),
      state.index + 1 < filtered.length
        ? el('button', { class: meta ? 'primary' : 'quiet', text: 'Next', onclick: () => go(1) })
        : el('button', { class: 'primary', text: 'Done', onclick: leaveRecorder })));
}

document.addEventListener('keydown', (e) => {
  // On a computer: space records / stops, arrows move between lines.
  if (e.target.matches('textarea, input, select')) return;
  const mic = app.querySelector('.recorder .mic:not(.fake)');
  if (!mic) return;
  if (e.code === 'Space') { e.preventDefault(); mic.click(); }
});

// ---------- recording ----------

const WORKLET = `class Grab extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('grab', Grab);`;

const recorder = {
  active: false,
  ctx: null,
  worklet: false,
  async start(meterBar, onLimit) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    const ctx = this.ctx;
    const source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.chunks = [];
    this.stream = stream;
    this.peak = 0;
    const take = (data) => {
      this.chunks.push(data);
      let p = 0;
      for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
      this.level = p;
    };
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      if (!this.worklet) {
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
        this.worklet = true;
      }
      this.node = new AudioWorkletNode(ctx, 'grab');
      this.node.port.onmessage = (e) => take(e.data);
    } else {
      this.node = ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    source.connect(this.node);
    this.node.connect(sink);
    this.source = source;
    this.active = true;
    this.started = performance.now();
    const tick = () => {
      if (!this.active) { meterBar.style.width = '0'; return; }
      this.shown = Math.max(this.level || 0, (this.shown || 0) * 0.9);   // rises at once, falls gently
      meterBar.style.width = `${Math.min(100, Math.sqrt(this.shown) * 110)}%`;
      if ((performance.now() - this.started) / 1000 > MAX_SECONDS) { onLimit ? onLimit() : this.stop(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  async stop() {
    if (!this.active) return null;
    this.active = false;
    await new Promise((r) => setTimeout(r, 120));      // the last samples still in the worklet
    this.source.disconnect();
    this.node.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());  // the microphone light goes off between lines
    const rate = this.ctx.sampleRate;
    let length = 0;
    for (const c of this.chunks) length += c.length;
    const all = new Float32Array(length);
    let at = 0;
    for (const c of this.chunks) { all.set(c, at); at += c.length; }
    let samples = all.subarray(Math.min(all.length, Math.round(SKIP_START * rate)));
    let outRate = rate;
    if (rate >= 44100) {                               // halve: 22.05 / 24 kHz is plenty for speech
      const half = new Float32Array(samples.length >> 1);
      for (let i = 0; i < half.length; i++) half[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
      samples = half;
      outRate = rate / 2;
    }
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    return { wav: wavBytes(samples, outRate), seconds: samples.length / outRate, peak };
  },
};

function verdict(take) {
  if (take.seconds < 0.3) return { ok: false, silent: true, text: 'That was very short. Tap, say the line, then tap again.' };
  if (take.peak < 0.02) return { ok: false, silent: true, text: 'I couldn’t hear anything. Is the microphone covered, or muted?' };
  if (take.peak < 0.08) return { ok: false, text: 'Quite quiet. Come a little closer, or speak up a little.' };
  if (take.peak > 0.99) return { ok: false, text: 'A bit loud: it may crackle. Hold the phone a little further away.' };
  return { ok: true };
}

function micError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'The microphone is blocked. Allow it for this page in the browser’s settings (the icon next to the address), then try again.';
  }
  if (e && e.name === 'NotFoundError') return 'No microphone was found on this device.';
  return 'The microphone didn’t start. Close other apps that use it, reload the page and try again.';
}

function wavBytes(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

let player = null;
function playWav(wav) {
  stopPlayback();
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  player = new Audio(url);
  player.onended = () => URL.revokeObjectURL(url);
  player.play().catch(() => {});
}
function stopPlayback() {
  if (player) { player.pause(); player = null; }
}

// ---------- sending (one zip) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {     // [{name, data: Uint8Array}] -> Blob; stored (WAV barely compresses)
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, 0, true); head.setUint16(10, time, true); head.setUint16(12, date, true);
    head.setUint32(14, crc, true); head.setUint32(18, f.data.length, true); head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    parts.push(head, name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

const safe = (s) => s.replace(/[^\p{L}\p{N}._-]+/gu, '_');

async function buildZip() {
  const files = [];
  const clips = [];
  const notes = [];
  for (const [s, line] of allLines()) {
    const k = keyOf(s, line);
    const meta = state.meta.get(k);
    if (meta) {
      const wav = await dbGet('clips', k);
      if (wav) {
        const file = `${safe(s.app)}/${safe(line.lang)}/${safe(line.id)}.wav`;
        files.push({ name: file, data: new Uint8Array(wav) });
        clips.push({ app: s.app, lang: line.lang, id: line.id, text: meta.text, file, recordedAt: meta.at, seconds: meta.seconds });
      }
    }
    const n = state.notes.get(k);
    if (n) notes.push({ app: s.app, lang: line.lang, id: line.id, text: line.text, note: n.note });
  }
  const manifest = {
    format: 'hichgah-voice-recordings/1', exported: new Date().toISOString(),
    person: state.pack.person || '', packMade: state.pack.made, clips, notes,
  };
  files.unshift({ name: 'recordings.json', data: enc(JSON.stringify(manifest, null, 1)) });
  const day = new Date().toISOString().slice(0, 10);
  const apps = [...new Set(state.pack.scripts.map((s) => s.app))].join('-');
  const name = `${apps}-voice${state.pack.person ? '-' + safe(state.pack.person) : ''}-${day}.zip`;
  return { blob: zip(files), name, clips: clips.length, notes: notes.length };
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function showSend() {
  show(header(), el('h1', { text: 'Send recordings' }), el('p', {}, el('span', { class: 'busy' }), ' Packing your recordings…'));
  const { blob, name, clips, notes } = await buildZip();
  const file = new File([blob], name, { type: 'application/zip' });
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  const mb = (blob.size / 1048576).toFixed(1);
  const status = el('p', { class: 'status', role: 'status' });
  show(header(),
    el('h1', { text: 'Send recordings' }),
    el('div', { class: 'card' },
      el('p', {}, el('b', { text: `${clips} recording${clips === 1 ? '' : 's'}` }),
        notes ? ` and ${notes} note${notes === 1 ? '' : 's'}` : '', ` in one file (${mb} MB):`),
      el('p', { class: 'small muted', dir: 'ltr', text: name }),
      el('div', { class: 'actions' },
        canShare ? el('button', { class: 'send', text: 'Share the file…', onclick: async () => {
          try { await navigator.share({ files: [file], title: name }); status.textContent = 'Sent. Thank you!'; status.className = 'status good'; }
          catch (e) { if (e.name !== 'AbortError') { download(blob, name); status.textContent = 'Saved to your downloads instead.'; } }
        } }) : null,
        el('button', { class: canShare ? 'quiet' : 'send', text: 'Save the file', onclick: () => {
          download(blob, name);
          status.textContent = 'Saved. Now attach it to a message (WhatsApp as a document, Telegram, email or Drive).';
          status.className = 'status good';
        } })),
      status),
    el('p', { class: 'muted', text: 'Send it to the person who gave you the password. Your recordings stay here too: '
      + 'you can keep recording and send again later (each file has everything so far).' }),
    el('button', { class: 'link', text: '‹ Back to the list', onclick: showList }));
}

// ---------- start ----------

// A link with #key=… opened while the page is already open (only the # changes): open that pack.
window.addEventListener('hashchange', () => {
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (!key) return;
  history.replaceState(null, '', location.pathname);
  if (recorder.active) recorder.stop();
  unlock(key, true);
});

(async function start() {
  if (!window.crypto?.subtle) {
    show(header(), el('p', { class: 'error', text: 'This browser can’t open the page. Please use an up-to-date Chrome, Safari or Firefox.' }));
    return;
  }
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('key');
  if (fromLink) history.replaceState(null, '', location.pathname);   // the password doesn't stay in the address bar
  const saved = fromLink || localStorage.getItem(KEY_STORE);
  if (saved) {
    show(header(), el('p', {}, el('span', { class: 'busy' }), ' Opening…'));
    await unlock(saved, true);
  } else {
    showLock();
  }
})();
