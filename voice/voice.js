// Hichgah voice recording page. A pack (voice/packs/<name>.pack, made by voice/tools/voice make) holds the
// lines to record, encrypted with a password; the pack's file name comes from the same password, so
// nothing can be listed or read without it. Recordings are kept in this browser (IndexedDB) until the
// person sends them as one zip (recordings.json + WAV files), which `voice import` puts into the app.

import {
  enc, packName, decryptPack, splitParts, isNew, batchBySize, stamp, when, downsample, peakOf, verdict, wavBytes, zip, safe,
} from './core.js';

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

async function openPack(password) {
  const name = await packName(password);
  const res = await fetch(`packs/${name}.pack`, { cache: 'no-store' });
  if (res.status === 404) throw new Error('wrong');
  if (!res.ok) throw new Error('network');
  return decryptPack(password, await res.json());
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

const PART_SIZE = 20;            // lines per part (a script can set partSize)
const state = {
  password: '',
  pack: null,
  scriptIndex: 0,
  lang: null,
  group: null,        // null = every group
  hideDone: false,
  meta: new Map(),    // `${app}|${lang}/${id}` -> {seconds, at, text, sentAt?}
  notes: new Map(),
  part: 0,            // index into partsFor() of the part open
  index: 0,           // the line open in the recorder, within the part
  session: new Set(), // keys recorded since the page opened
};
const keyOf = (script, line) => `${script.app}|${line.lang}/${line.id}`;
const script = () => state.pack.scripts[state.scriptIndex];
const langs = (s) => [...new Set(s.lines.map((l) => l.lang))];
const has = (s, l) => state.meta.has(keyOf(s, l));
const recordedCount = (s, lines) => lines.filter((l) => has(s, l)).length;
const allLines = () => state.pack.scripts.flatMap((s) => s.lines.map((l) => [s, l]));
const unsent = () => allLines().filter(([s, l]) => isNew(state.meta.get(keyOf(s, l)))).length;
const firstVisit = () => localStorage.getItem(`hichgah-voice-welcomed-${state.pack.made}-${state.pack.person}`) !== '1';
const markWelcomed = () => localStorage.setItem(`hichgah-voice-welcomed-${state.pack.made}-${state.pack.person}`, '1');

// Every group of the current language, cut into parts of about PART_SIZE lines (core.js splitParts).
function partsFor(s = script(), lang = state.lang) {
  return splitParts(s.lines.filter((l) => l.lang === lang), s.partSize || PART_SIZE);
}
const totalParts = () => state.pack.scripts.reduce((n, sc) => n + langs(sc).reduce((m, l) => m + partsFor(sc, l).length, 0), 0);
const partLabel = (p) => (p.of > 1 ? `${p.group} · part ${p.n} of ${p.of}` : p.group);
const partDone = (s, p) => p.lines.every((l) => has(s, l));
const nextPartIndex = (s, parts, from = 0) => {
  for (let i = 0; i < parts.length; i++) {
    const j = (from + i) % parts.length;
    if (!partDone(s, parts[j]) && (!state.group || parts[j].group === state.group)) return j;
  }
  return -1;
};

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
  state.session = new Set();
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
        el('div', { class: 'count', text: `1 / ${partsFor()[0]?.lines.length || 1}` }),
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
      el('p', { text: `Your ${total} lines are cut into ${totalParts()} part${totalParts() === 1 ? '' : 's'} of about 20 lines `
        + '(around 5 minutes each). Do one part, take a break, come back another day: the page remembers where you stopped, '
        + 'and Continue takes you there.' }),
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
        el('li', {}, 'Send whenever you like: after each part, after each session, or once at the end. Each time, only the '
          + 'new recordings are sent. A big batch comes as a few files of at most 15 MB, so they fit in a message.')),
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

// ---------- the list of parts ----------

// Views: list -> part -> recorder; the phone's back button goes up one level.
function go(view, replace = false) {
  if (replace) history.replaceState({ view }, '');
  else if (history.state?.view !== view) history.pushState({ view }, '');
}
window.addEventListener('popstate', (e) => {
  if (!state.pack) return;
  if (recorder.active) recorder.stop();
  const view = e.state?.view;
  if (view === 'rec') showRecorder();
  else if (view === 'part') showPart();
  else showList();
});

function sendButtons() {
  const fresh = unsent();
  const notes = freshNotes();
  const any = allLines().some(([s, l]) => has(s, l));
  const label = fresh ? `Send new recordings (${fresh})` : notes ? `Send your notes (${notes})` : any ? 'Everything is sent ✓' : 'Send recordings';
  return [
    el('button', { class: 'send', disabled: !fresh && !notes, text: label, onclick: () => showSend('new') }),
    any && !fresh ? el('button', { class: 'link', text: 'Send everything again', onclick: () => showSend('all') }) : null,
    lastSent() ? el('p', { class: 'muted small center', text: `Last sent ${when(lastSent())}` }) : null,
  ];
}

function showList() {
  const s = script();
  const parts = partsFor();
  const all = parts.flatMap((p) => p.lines);
  const done = recordedCount(s, all);
  const next = nextPartIndex(s, parts);
  const groups = [...new Set(parts.map((p) => p.group))];
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

  const shown = parts.map((p, i) => [p, i]).filter(([p]) => (!state.group || p.group === state.group) && !(state.hideDone && partDone(s, p)));
  const list = el('ul', { class: 'lines parts' }, shown.map(([p, i]) => {
    const n = recordedCount(s, p.lines);
    const complete = n === p.lines.length;
    return el('li', {}, el('button', {
      class: 'line' + (complete ? ' done' : ''),
      'aria-label': `${partLabel(p)}, ${n} of ${p.lines.length} recorded`,
      onclick: () => openPart(i),
    },
    el('span', { class: 'state', text: complete ? '✓' : '' }),
    el('span', { class: 'what' },
      el('span', { class: 'part-name', text: partLabel(p) }),
      el('span', { class: 'mini' }, el('span', { style: `width:${(100 * n) / p.lines.length}%` }))),
    el('span', { class: 'part-count', text: `${n} / ${p.lines.length}` })));
  }));

  go('list', true);
  show(header(),
    el('div', { class: 'top' },
      el('div', {}, el('h1', { text: s.title }),
        state.pack.person ? el('div', { class: 'muted small', text: `For ${state.pack.person}` }) : null),
      langPick),
    scriptTabs,
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.length), 'aria-valuenow': String(done) },
      el('span', { style: `width:${all.length ? (100 * done) / all.length : 0}%` })),
    el('p', { class: 'muted small', text: done === all.length && all.length
      ? `All ${all.length} lines recorded. Thank you!`
      : `${done} of ${all.length} recorded, in ${parts.length} part${parts.length === 1 ? '' : 's'}` + (state.session.size ? ` · ${state.session.size} this session` : '') }),
    el('div', { class: 'actions' },
      next >= 0 ? el('button', { class: 'primary', onclick: () => openPart(next, true) },
        el('span', { text: done ? 'Continue: ' : 'Start: ' }), el('span', { text: partLabel(parts[next]) })) : null,
      sendButtons()),
    groups.length > 1 ? el('div', { class: 'chips', role: 'group', 'aria-label': 'Groups' },
      chip('All', null), groups.map((g) => chip(g, g))) : null,
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: state.hideDone, onchange: (e) => { state.hideDone = e.target.checked; showList(); } }),
      'Hide the finished parts'),
    shown.length ? list : el('p', { class: 'muted', text: 'Nothing left here. 🎉' }),
    el('div', { class: 'row nav' },
      el('button', { class: 'link', text: 'How it works', onclick: () => showWelcome(1) }),
      el('button', { class: 'link', text: 'Lock this page', onclick: lock })));
}

// A part: its lines, and the way into the recorder. `straightIn` opens the first line not recorded yet.
function openPart(i, straightIn = false) {
  state.part = i;
  go('part');
  if (straightIn) {
    const p = partsFor()[i];
    openRecorder(Math.max(0, p.lines.findIndex((l) => !has(script(), l))));
  } else {
    showPart();
  }
}

function showPart() {
  const s = script();
  const p = partsFor()[state.part];
  if (!p) return showList();
  const n = recordedCount(s, p.lines);
  const first = p.lines.findIndex((l) => !has(s, l));
  const list = el('ul', { class: 'lines' }, p.lines.map((line, i) => {
    const k = keyOf(s, line);
    const done = state.meta.has(k);
    return el('li', {}, el('button', {
      class: 'line' + (done ? ' done' : ''),
      'aria-label': `${line.text}, ${done ? 'recorded' : 'not recorded yet'}`,
      onclick: () => openRecorder(i),
    },
    el('span', { class: 'state', text: done ? '✓' : '' }),
    picture(s, line, 'pic'),
    el('span', { class: 'what' }, say(line.text, line.lang, 'say'),
      line.direction ? el('span', { class: 'sub', text: line.direction }) : null),
    state.notes.has(k) ? el('span', { class: 'flag', text: 'note' }) : null));
  }));
  show(
    el('div', { class: 'top' },
      el('button', { class: 'link', text: '‹ All parts', onclick: () => history.back() }),
      el('span', { class: 'count muted', text: `${n} / ${p.lines.length}` })),
    el('h1', { text: partLabel(p) }),
    el('div', { class: 'progress' }, el('span', { style: `width:${(100 * n) / p.lines.length}%` })),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', text: first < 0 ? 'Listen again from the start' : (n ? 'Continue this part' : 'Record this part'),
        onclick: () => openRecorder(Math.max(0, first)) })),
    list);
}

// ---------- the recorder ----------

let wakeLock = null;

function openRecorder(index) {
  state.index = index;
  go('rec');
  navigator.wakeLock?.request('screen').then((w) => { wakeLock = w; }).catch(() => {});
  showRecorder();
}

function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function showRecorder(message) {
  const s = script();
  const part = partsFor()[state.part];
  if (!part) return showList();
  const lines = part.lines;
  const line = lines[state.index];
  const k = keyOf(s, line);
  const meta = state.meta.get(k);
  const note = state.notes.get(k);

  const status = el('p', { class: 'status', role: 'status' });
  const setStatus = (text, cls = '') => { status.className = 'status ' + cls; status.textContent = text; };
  if (message) setStatus(message.text, message.cls);
  else if (meta) setStatus(`Recorded ✓ ${meta.seconds.toFixed(1)} s · ${when(meta.at)}${meta.sentAt && meta.sentAt >= meta.at ? ' · sent' : ''}. Record again to replace it.`, 'good');
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
      state.session.add(k);
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
  const saveNote = async () => {
    const text = noteText.value.trim();
    if (text === (state.notes.get(k)?.note || '')) return;
    if (text) {
      const n = { note: text, text: line.text, at: new Date().toISOString() };
      state.notes.set(k, n);
      await dbPut('notes', k, n);
    } else {
      state.notes.delete(k);
      await dbDel('notes', k);
    }
  };
  noteText.oninput = () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 400); };
  const noteBox = el('div', { class: 'note-box', hidden: !note }, noteText);
  const noteButton = el('button', { class: 'link', text: note ? 'Your note' : 'Add a note about this line',
    onclick: () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteText.focus(); } });

  const leave = async (then) => { if (recorder.active) await recorder.stop(); clearTimeout(noteTimer); await saveNote(); then(); };
  const step = (d) => leave(() => { state.index += d; showRecorder(); });
  const last = state.index + 1 >= lines.length;
  show(
    el('div', { class: 'top' },
      el('button', { class: 'link', text: '‹ Part', onclick: () => leave(() => { releaseWake(); history.back(); }) }),
      el('span', { class: 'count muted', text: `${state.index + 1} / ${lines.length}` })),
    el('div', { class: 'card recorder' },
      el('span', { class: 'group', text: partLabel(part) }),
      picture(s, line, 'picture'),
      el('div', {}, say(line.text, line.lang, 'say')),
      line.direction ? el('p', { class: 'direction', text: line.direction }) : null,
      el('div', { class: 'controls' }, mic, play),
      meter,
      status,
      noteButton,
      noteBox),
    el('div', { class: 'row nav' },
      el('button', { class: 'quiet', text: 'Previous', disabled: state.index === 0, onclick: () => step(-1) }),
      last
        ? el('button', { class: 'primary', text: 'Finish the part', onclick: () => leave(showPartDone) })
        : el('button', { class: meta ? 'primary' : 'quiet', text: 'Next', onclick: () => step(1) })),
    el('div', { class: 'center' }, el('button', { class: 'link', text: 'Take a break', onclick: () => leave(showBreak) })));
}

document.addEventListener('keydown', (e) => {
  // On a computer: space records / stops.
  if (e.target.matches('textarea, input, select')) return;
  const mic = app.querySelector('.recorder .mic:not(.fake)');
  if (!mic) return;
  if (e.code === 'Space') { e.preventDefault(); mic.click(); }
});

// The end of a part: on to the next one, send, or rest.
function showPartDone() {
  releaseWake();
  const s = script();
  const parts = partsFor();
  const p = parts[state.part];
  const n = recordedCount(s, p.lines);
  const left = p.lines.length - n;
  const next = nextPartIndex(s, parts, state.part + 1);
  go('list', true);
  show(header(),
    el('h1', { text: left ? `${partLabel(p)}: almost there` : `${partLabel(p)}: done 🎉` }),
    el('p', { text: left
      ? `${n} of ${p.lines.length} recorded. ${left} line${left === 1 ? ' is' : 's are'} left in this part: you can come back to ${left === 1 ? 'it' : 'them'} any time.`
      : `All ${p.lines.length} lines of this part are recorded. Thank you!` }),
    el('div', { class: 'actions' },
      left ? el('button', { class: 'quiet', text: 'Back to this part', onclick: () => openPart(state.part) }) : null,
      next >= 0 ? el('button', { class: 'primary', onclick: () => openPart(next, true) },
        el('span', { text: 'Next: ' }), el('span', { text: partLabel(parts[next]) })) : null,
      sendButtons(),
      el('button', { class: 'quiet', text: 'Take a break', onclick: showBreak })));
}

// A break: what this session did, and how to come back.
function showBreak() {
  releaseWake();
  const s = script();
  const all = partsFor().flatMap((p) => p.lines);
  const done = recordedCount(s, all);
  go('list', true);
  show(header(),
    el('h1', { text: 'Time for a break' }),
    el('div', { class: 'card facts' },
      fact(String(state.session.size), state.session.size === 1 ? 'line recorded this session' : 'lines recorded this session'),
      fact(`${done} of ${all.length}`, 'recorded in total'),
      unsent() ? fact(String(unsent()), 'not sent yet') : null),
    el('p', { text: 'Everything is saved on this device. To carry on later, open the same link (or this page) in the same browser '
      + 'and tap Continue: it opens where you stopped.' }),
    el('p', { class: 'muted', text: 'You can send what you have now, or send it all at the end. Each time, only the new recordings are sent.' }),
    el('div', { class: 'actions' }, sendButtons(), el('button', { class: 'quiet', text: 'Back to the list', onclick: showList })));
}

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
    const { samples, rate: outRate } = downsample(all.subarray(Math.min(all.length, Math.round(SKIP_START * rate))), rate);
    return { wav: wavBytes(samples, outRate), seconds: samples.length / outRate, peak: peakOf(samples) };
  },
};

function micError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'The microphone is blocked. Allow it for this page in the browser’s settings (the icon next to the address), then try again.';
  }
  if (e && e.name === 'NotFoundError') return 'No microphone was found on this device.';
  return 'The microphone didn’t start. Close other apps that use it, reload the page and try again.';
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

const maxFile = () => Number(localStorage.getItem('hichgah-voice-test-max-file')) || 15 * 1048576;   // per zip: fits email and messaging apps (tests lower it)

// One or more zips of the recordings (mode 'new': only those not sent yet; 'all': everything), each with its own
// recordings.json, so each file imports on its own. Notes go in the first.
async function buildZips(mode) {
  const items = [];
  const notes = [];
  for (const [s, line] of allLines()) {
    const k = keyOf(s, line);
    const meta = state.meta.get(k);
    if (meta && (mode === 'all' || isNew(meta))) items.push({ s, line, k, meta });
    const n = state.notes.get(k);
    if (n) notes.push({ app: s.app, lang: line.lang, id: line.id, text: line.text, note: n.note });
  }
  const apps = [...new Set(state.pack.scripts.map((s) => s.app))].join('-');
  const base = `${apps}-voice${state.pack.person ? '-' + safe(state.pack.person) : ''}-${stamp()}`;   // local date and time: sorts in order
  const loaded = [];
  for (const it of items) {
    const wav = await dbGet('clips', it.k);
    if (wav) loaded.push({ ...it, wav });
  }
  const batches = batchBySize(loaded, (it) => it.wav.byteLength, maxFile());
  if (!batches.length) batches.push([]);   // notes only
  // Each send gets the next number (kept per pack), so files never share a name: …-send3.zip, …-send4-1of2.zip.
  const counter = `hichgah-voice-sends-${state.pack.made}-${state.pack.person}`;
  const send = Number(localStorage.getItem(counter) || 0) + 1;
  localStorage.setItem(counter, String(send));
  return batches.map((batch, i) => {
    const files = [];
    const clips = batch.map(({ s, line, meta, wav }) => {
      const file = `${safe(s.app)}/${safe(line.lang)}/${safe(line.id)}.wav`;
      files.push({ name: file, data: new Uint8Array(wav) });
      return { app: s.app, lang: line.lang, id: line.id, text: meta.text, file, recordedAt: meta.at, seconds: meta.seconds };
    });
    const manifest = {
      format: 'hichgah-voice-recordings/1', exported: new Date().toISOString(),
      person: state.pack.person || '', packMade: state.pack.made, send,
      part: batches.length > 1 ? `${i + 1} of ${batches.length}` : '', clips, notes: i === 0 ? notes : [],
    };
    files.unshift({ name: 'recordings.json', data: enc(JSON.stringify(manifest, null, 1)) });
    const name = `${base}-send${send}${batches.length > 1 ? `-${i + 1}of${batches.length}` : ''}.zip`;
    return { file: new File([zip(files)], name, { type: 'application/zip' }), keys: batch.map((b) => b.k), clips: clips.length };
  });
}

// Notes written or changed since the last send (all notes go with every send; this only enables the button).
const freshNotes = () => [...state.notes.values()].filter((n) => !lastSent() || n.at > lastSent()).length;
const sentKey = () => `hichgah-voice-last-sent-${state.pack.made}-${state.pack.person}`;
const lastSent = () => localStorage.getItem(sentKey());

async function markSent(keys) {
  localStorage.setItem(sentKey(), new Date().toISOString());
  const now = new Date().toISOString();
  for (const k of keys) {
    const m = state.meta.get(k);
    if (!m) continue;
    m.sentAt = now;
    await dbPut('meta', k, m);
  }
}

function download(file) {
  const a = el('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function showSend(mode) {
  releaseWake();
  go('list', true);
  show(header(), el('h1', { text: 'Send recordings' }), el('p', {}, el('span', { class: 'busy' }), ' Packing your recordings…'));
  const zips = await buildZips(mode);
  const files = zips.map((z) => z.file);
  const total = zips.reduce((n, z) => n + z.clips, 0);
  const notes = state.notes.size;
  const canShare = navigator.canShare && navigator.canShare({ files });
  const mb = (files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1);
  const status = el('p', { class: 'status', role: 'status' });
  const sent = async (keys, text) => {
    await markSent(keys);
    status.className = 'status good';
    status.textContent = text;
  };
  const many = files.length > 1;
  show(header(),
    el('h1', { text: mode === 'all' ? 'Send everything again' : 'Send new recordings' }),
    el('div', { class: 'card' },
      el('p', {}, el('b', { text: `${total} recording${total === 1 ? '' : 's'}` }),
        notes ? ` and ${notes} note${notes === 1 ? '' : 's'}` : '',
        many ? ` in ${files.length} files (${mb} MB in all, at most 15 MB each):` : ` in one file (${mb} MB):`),
      el('ul', { class: 'files small muted' }, files.map((f) => el('li', { dir: 'ltr', text: f.name }))),
      el('div', { class: 'actions' },
        canShare ? el('button', { class: 'send', text: many ? `Share the ${files.length} files…` : 'Share the file…', onclick: async () => {
          try {
            await navigator.share({ files, title: files[0].name });
            await sent(zips.flatMap((z) => z.keys), 'Sent. Thank you!');
          } catch (e) {
            if (e.name !== 'AbortError') { status.className = 'status warn'; status.textContent = 'Sharing didn’t work here: save the file instead.'; }
          }
        } }) : null,
        zips.map((z, i) => el('button', { class: canShare || i > 0 ? 'quiet' : 'send',
          text: many ? `Save file ${i + 1} of ${files.length}` : 'Save the file', onclick: async (e) => {
            download(z.file);
            e.currentTarget.textContent = many ? `Saved file ${i + 1} ✓` : 'Saved ✓';
            await sent(z.keys, 'Saved. Now attach it to a message (WhatsApp as a document, Telegram, email or Drive).');
          } }))),
      status),
    el('p', { class: 'muted', text: `Send ${many ? 'them' : 'it'} to the person who gave you the password. Your recordings stay here too. `
      + 'Next time, only what you record after this is sent (“Send everything again” is on the list if a file gets lost).' }),
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
