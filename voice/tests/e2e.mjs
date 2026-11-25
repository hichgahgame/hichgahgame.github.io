// End-to-end test of the voice page in headless Chrome with a fake microphone (macOS):
//   node voice/tests/e2e.mjs [screenshots-folder]
// It makes a throwaway app and pack, then goes through the page as a voice person would: wrong password, the
// link, the welcome and its mic test, parts, recording, a note, a break, sending (one file, then several),
// re-recording, reloading. Then it imports every zip into the throwaway app with `voice import`.
// Needs Google Chrome, Python 3 and voice/tools/.venv (made by voice/tools/voice). Exit code 1 on a failure.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..', '..');
const voiceTool = path.join(site, 'voice', 'tools', 'voice');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shots = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-e2e-'));
const downloads = path.join(tmp, 'downloads');
const project = path.join(tmp, 'voice-e2e');
const password = `e2e-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const port = 8700 + Math.floor(Math.random() * 200);
const devtools = port + 1000;
const children = [];
let packName = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a throwaway app ----------

function makeApp() {
  fs.mkdirSync(path.join(project, 'tool'), { recursive: true });
  fs.mkdirSync(downloads);
  const words = Array.from({ length: 45 }, (_, i) => ({
    lang: 'en', id: `word${String(i + 1).padStart(2, '0')}`, text: `Word ${i + 1}`, group: 'words',
    direction: `say “word ${i + 1}”`, picture: '🐈', dest: `assets/en/word${String(i + 1).padStart(2, '0')}.wav`, recorded: false,
  }));
  const sentences = ['سلام!', 'آفرین!', 'دوباره امتحان کن.', 'حالا تو بگو.', 'خداحافظ!'].map((text, i) => ({
    lang: 'fa', id: `sentence${i + 1}`, text, group: 'sentences', dest: `assets/fa/sentence${i + 1}.wav`, recorded: false,
  }));
  const script = {
    format: 'hichgah-voice-script/1', app: 'voice-e2e', title: 'Voice test app', guide: 'Warm and clear.',
    languages: { en: 'English', fa: 'فارسی' }, audio: { format: 'wav', sampleRate: 22050 }, lines: [...words, ...sentences],
  };
  fs.writeFileSync(path.join(project, 'tool', 'voice-e2e.voice.json'), JSON.stringify(script));
  const r = spawnSync(voiceTool, ['make', project, '--person', 'Tester', '--message', 'An end-to-end test.'],
    { env: { ...process.env, VOICE_PACK_PASSWORD: password }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  packName = r.stdout.match(/packs\/([0-9a-f]{32})\.pack/)[1];
}

// ---------- browser ----------

let ws;
let id = 0;
const waiting = new Map();
const errors = [];
const cdp = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  waiting.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});
async function ev(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(`${expression}\n${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
  return r.result.result.value;
}
async function until(expression, what, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await ev(expression)) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const buttons = () => ev(`[...document.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim())`);
async function click(label) {
  const ok = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b =>
    (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)} || b.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`No enabled button "${label}" among: ${(await buttons()).join(' | ')}`);
  await sleep(150);
}
const text = () => ev('document.querySelector("main").innerText');
const h1 = () => ev('document.querySelector("h1")?.textContent || ""');
let shot = 0;
async function screenshot(name) {
  if (!shots) return;
  await sleep(300);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${String(++shot).padStart(2, '0')}-${name}.png`), Buffer.from(r.result.data, 'base64'));
}
async function record(ms = 1100) {
  await click('Record');
  await sleep(ms);
  await click('Stop');
  await until(`document.querySelector('.status.good, .status.warn')`, 'the take to be saved');
}
const downloaded = () => fs.readdirSync(downloads).filter((f) => f.endsWith('.zip')).sort();
async function waitForDownloads(n) {
  for (let i = 0; i < 50 && downloaded().length < n; i++) await sleep(100);
  assert.equal(downloaded().length, n, `downloads: ${downloaded().join(', ')}`);
}

async function startBrowser() {
  children.push(spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: site, stdio: 'ignore' }));
  children.push(spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${devtools}`, `--user-data-dir=${path.join(tmp, 'chrome')}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' }));
  let targets;
  for (let i = 0; i < 60 && !targets; i++) {
    await sleep(250);
    targets = await fetch(`http://127.0.0.1:${devtools}/json/list`).then((r) => r.json()).catch(() => null);
  }
  assert.ok(targets, 'Chrome started');
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails).slice(0, 400));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${port}/voice/`).then((r) => r.ok).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error('the local server did not start');
}

// ---------- the walk-through ----------

const steps = [];
async function step(name, fn) {
  await fn();
  steps.push(name);
  console.log(`✔ ${name}`);
}

async function main() {
  makeApp();
  await startBrowser();
  const page = `http://127.0.0.1:${port}/voice/`;

  await step('a wrong password is refused, and says so', async () => {
    await cdp('Page.navigate', { url: page });
    await until(`!!document.querySelector('#pw')`, 'the lock screen');
    await screenshot('lock');
    await ev(`document.querySelector('#pw').value = 'not-the-password'; document.querySelector('form').requestSubmit(); 1`);
    await until(`!!document.querySelector('.error')`, 'the error');
    assert.match(await text(), /doesn’t open anything/);
  });

  await step('the link opens the pack and takes the password out of the address', async () => {
    await cdp('Page.navigate', { url: `${page}?fresh#key=${password}` });
    await until(`!!document.querySelector('.dots')`, 'the welcome');
    assert.equal(await ev('location.hash'), '');
    assert.equal(await h1(), 'Hello Tester!');
    const t = await text();
    assert.match(t, /50\s+lines to record/);
    assert.match(t, /An end-to-end test\./);
    await screenshot('welcome-1');
  });

  await step('the welcome shows a real line, explains parts and tests the microphone (not saved)', async () => {
    await click('Next');
    assert.match(await text(), /Word 1/);
    assert.match(await text(), /The picture/);
    await screenshot('welcome-2');
    await click('Next');
    assert.match(await text(), /cut into 3 parts/);
    await click('Next');
    assert.match(await text(), /Warm and clear\./);
    await click('Test the microphone');
    await sleep(1200);
    await click('Test the microphone');
    await until(`document.querySelector('.status.good, .status.warn')`, 'the test verdict');
    await screenshot('welcome-4');
    await click('Next');
    assert.match(await text(), /only the new recordings are sent/);
    await click('Start recording');
    await until(`!!document.querySelector('.parts')`, 'the list of parts');
    assert.equal(await ev('document.querySelectorAll(".line.done").length'), 0, 'the mic test saved nothing');
  });

  await step('the list: parts of about 20, never across groups, filters', async () => {
    const parts = await ev(`[...document.querySelectorAll('.part-name')].map(e => e.textContent)`);
    assert.deepEqual(parts, ['words · part 1 of 2', 'words · part 2 of 2']);
    assert.match(await text(), /0 of 45 recorded, in 2 parts/);
    await screenshot('list');
  });

  await step('Continue opens the first part; record, re-record, move on, add a note', async () => {
    await click('Start:');
    await until(`!!document.querySelector('.recorder .mic')`, 'the recorder');
    assert.equal(await ev(`document.querySelector('.count').textContent`), '1 / 23');
    await record();
    await screenshot('recorded');
    await record();                                         // record again: replaces
    await click('Next');
    await record();
    await click('Add a note about this line');
    await ev(`(() => { const t = document.querySelector('textarea'); t.value = 'Typo? «Word 2»'; t.dispatchEvent(new Event('input')); })()`);
    await sleep(700);
    await click('Next');
    await record();
    // Chrome's fake microphone is a full-scale beep, so the page says "a bit loud": the take is still saved.
    assert.equal(await ev(`document.querySelector('.play').disabled`), false, 'the take was saved');
  });

  await step('a break sums up the session', async () => {
    await click('Take a break');
    assert.equal(await h1(), 'Time for a break');
    assert.match(await text(), /3\s+lines recorded this session/);
    assert.match(await text(), /3\s+not sent yet/);
    await screenshot('break');
  });

  await step('sending: only new recordings, numbered and time-stamped; then "everything is sent"', async () => {
    await click('Send new recordings (3)');
    await until(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Save the file')`, 'the send screen');
    assert.match(await text(), /3 recordings and 1 note in one file/);
    await click('Save the file');
    await waitForDownloads(1);
    assert.match(downloaded()[0], /^voice-e2e-voice-Tester-\d{4}-\d\d-\d\d-\d{4}-send1\.zip$/);
    await click('‹ Back to the list');
    assert.ok((await buttons()).includes('Everything is sent ✓'));
    assert.match(await text(), /Last sent today/);
  });

  await step('the back button goes up a level; Continue resumes at the first line not recorded', async () => {
    await click('Continue:');
    await until(`!!document.querySelector('.recorder .mic')`, 'the recorder');
    assert.equal(await ev(`document.querySelector('.count').textContent`), '4 / 23');
    await cdp('Runtime.evaluate', { expression: 'history.back()' });
    await sleep(500);
    assert.equal(await h1(), 'words · part 1 of 2');
  });

  await step('finishing a part early: "almost there", with the next part offered', async () => {
    await ev(`[...document.querySelectorAll('ul.lines .line')].at(-1).click(); 1`);
    await until(`!!document.querySelector('.recorder .mic')`, 'the recorder');
    await record();
    await click('Finish the part');
    assert.match(await h1(), /almost there/);
    assert.ok((await buttons()).some((b) => b.startsWith('Next: words · part 2 of 2') || b.startsWith('Next:')));
    await screenshot('part-done');
  });

  await step('a re-recorded line counts as new; a big batch is split into several files', async () => {
    await click('Back to this part');
    await ev(`document.querySelector('ul.lines .line').click(); 1`);   // line 1, sent already
    await until(`!!document.querySelector('.recorder .mic')`, 'the recorder');
    await record();
    await ev(`localStorage.setItem('hichgah-voice-test-max-file', '40000'); 1`);
    await click('Take a break');
    await click('Send new recordings (2)');
    await until(`[...document.querySelectorAll('button')].some(b => b.textContent.startsWith('Save file'))`, 'several files');
    assert.match(await text(), /2 recordings and 1 note in 2 files/);
    await screenshot('send-several');
    for (const n of [1, 2]) await click(`Save file ${n} of 2`);
    await waitForDownloads(3);
    assert.match(downloaded().join(' '), /send2-1of2\.zip.*send2-2of2\.zip/);
    await ev(`localStorage.removeItem('hichgah-voice-test-max-file'); 1`);
  });

  await step('a reload keeps the password, the recordings and the progress', async () => {
    await cdp('Page.reload');
    await until(`!!document.querySelector('.parts')`, 'the list after reloading');
    assert.match(await text(), /4 of 45 recorded/);   // lines 1, 2, 3 and 23 (line 1 twice)
  });

  await step('the other language and the right-to-left lines', async () => {
    await ev(`(() => { const s = document.querySelector('select'); s.value = 'fa'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(200);
    assert.deepEqual(await ev(`[...document.querySelectorAll('.part-name')].map(e => e.textContent)`), ['sentences']);
    await click('Start:');
    await until(`!!document.querySelector('.recorder .say')`, 'the recorder');
    assert.equal(await ev(`document.querySelector('.recorder .say').dir`), 'rtl');
    await screenshot('farsi');
  });

  await step('voice import puts every zip into the app, keeping the newest take', async () => {
    const r = spawnSync(voiceTool, ['import', downloads, '--project', project], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /4 lines in 3 sources/);
    assert.match(r.stdout, /Typo\? «Word 2»/);
    const placed = fs.readdirSync(path.join(project, 'assets', 'en')).sort();
    assert.deepEqual(placed, ['word01.wav', 'word02.wav', 'word03.wav', 'word23.wav']);
  });

  assert.deepEqual(errors, [], 'no errors on the page');
}

function cleanUp() {
  for (const c of children) c.kill();
  if (packName) spawnSync(voiceTool, ['remove', packName], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(() => {
  console.log(`\n${steps.length} steps passed`);
  cleanUp();
  process.exit(0);
}).catch((e) => {
  console.error(`\n✖ ${e.stack || e}`);
  if (errors.length) console.error('Page errors:\n' + errors.join('\n'));
  cleanUp();
  process.exit(1);
});
