// Tests for voice/core.js (the page's logic): node --test voice/tests/*.test.mjs
// Two tests talk to Python: a pack made by voice_pack.py must open here, and a zip made here must open there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packName, decryptPack, splitParts, isNew, batchBySize, stamp, when, downsample, peakOf, verdict, wavBytes, crc32, zip, safe,
} from '../core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(here, '..', 'tools');
const venvPython = path.join(tools, '.venv', 'bin', 'python');
const hasVenv = fs.existsSync(venvPython);

function python(code, exe = 'python3') {
  const r = spawnSync(exe, ['-c', code], { cwd: tools, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

test('a pack made by voice_pack.py opens with the same password, and only with it', { skip: !hasVenv && 'no voice/tools/.venv' }, async () => {
  const content = { format: 'hichgah-voice-pack-content/1', person: 'Sara', scripts: [{ app: 'x', lines: [{ id: 'a', text: 'گُربه' }] }] };
  const out = JSON.parse(python(`import json, voice_pack as v
print(json.dumps({"name": v.pack_name("pässword-1234"), "pack": v.encrypt("pässword-1234", json.loads(${JSON.stringify(JSON.stringify(content))}))}))`, venvPython));
  assert.equal(await packName('pässword-1234'), out.name);
  assert.match(out.name, /^[0-9a-f]{32}$/);
  assert.deepEqual(await decryptPack('pässword-1234', out.pack), content);
  await assert.rejects(decryptPack('wrong-password', out.pack));
  assert.notEqual(await packName('another-password'), out.name);
});

test('parts: about the size asked, never across groups, evened out', () => {
  const lines = [
    ...Array.from({ length: 109 }, (_, i) => ({ id: `w${i}`, group: 'words' })),
    ...Array.from({ length: 23 }, (_, i) => ({ id: `s${i}`, group: 'sounds' })),
    { id: 'one', group: 'single' },
  ];
  const parts = splitParts(lines, 20);
  const words = parts.filter((p) => p.group === 'words');
  assert.deepEqual(words.map((p) => p.lines.length), [22, 22, 22, 22, 21]);
  assert.deepEqual(words.map((p) => [p.n, p.of]), [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
  assert.deepEqual(parts.filter((p) => p.group === 'sounds').map((p) => p.lines.length), [23]);
  assert.deepEqual(parts.at(-1), { group: 'single', n: 1, of: 1, lines: [{ id: 'one', group: 'single' }] });
  assert.deepEqual(parts.flatMap((p) => p.lines), lines, 'every line once, in order');
  for (const p of parts) assert.ok(p.lines.every((l) => l.group === p.group));
  assert.deepEqual(splitParts([], 20), []);
});

test('new = never sent, or recorded again after sending', () => {
  assert.equal(isNew(undefined), false);
  assert.equal(isNew({ at: '2026-11-25T10:00:00Z' }), true);
  assert.equal(isNew({ at: '2026-11-25T10:00:00Z', sentAt: '2026-11-25T11:00:00Z' }), false);
  assert.equal(isNew({ at: '2026-11-25T12:00:00Z', sentAt: '2026-11-25T11:00:00Z' }), true);
});

test('batches stay under the size, keep the order, and a big item goes alone', () => {
  const sizes = [6, 3, 2, 9, 12, 1];
  const batches = batchBySize(sizes, (n) => n, 10);
  assert.deepEqual(batches, [[6, 3], [2], [9], [12], [1]]);
  assert.deepEqual(batches.flat(), sizes);
  assert.deepEqual(batchBySize([], (n) => n, 10), []);
  assert.deepEqual(batchBySize([1, 2, 3], (n) => n, 100), [[1, 2, 3]]);
});

test('times: file names sort in order, and people read "today", "yesterday" or a date', () => {
  assert.equal(stamp(new Date(2026, 10, 5, 9, 7)), '2026-11-05-0907');
  assert.ok(stamp(new Date(2026, 10, 5, 9, 7)) < stamp(new Date(2026, 10, 5, 14, 0)));
  const now = new Date(2026, 10, 25, 15, 0);
  assert.match(when(new Date(2026, 10, 25, 14, 32).toISOString(), now), /^today /);
  assert.match(when(new Date(2026, 10, 24, 23, 59).toISOString(), now), /^yesterday /);
  assert.doesNotMatch(when(new Date(2026, 10, 20, 8, 0).toISOString(), now), /today|yesterday/);
  assert.equal(when('', now), '');
});

test('48 kHz is halved by averaging; 22.05 kHz is kept', () => {
  const s = Float32Array.from([0, 1, 0.5, 0.5, -1, 0]);
  const half = downsample(s, 48000);
  assert.equal(half.rate, 24000);
  assert.deepEqual([...half.samples], [0.5, 0.5, -0.5]);
  assert.equal(downsample(s, 22050).samples, s);
  assert.equal(peakOf(Float32Array.from([0.1, -0.7, 0.3])), 0.699999988079071);
});

test('takes: silent and very short ones are refused, quiet and loud ones warned about', () => {
  assert.equal(verdict({ seconds: 1, peak: 0.5 }).ok, true);
  assert.equal(verdict({ seconds: 0.2, peak: 0.5 }).silent, true);
  assert.equal(verdict({ seconds: 1, peak: 0.01 }).silent, true);
  assert.deepEqual([verdict({ seconds: 1, peak: 0.05 }).ok, verdict({ seconds: 1, peak: 0.05 }).silent], [false, undefined]);
  assert.equal(verdict({ seconds: 1, peak: 1 }).ok, false);
});

test('crc32 has the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a zip made here, with a WAV and a Farsi name, opens in Python', async () => {
  const rate = 24000;
  const tone = Float32Array.from({ length: rate / 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const wav = new Uint8Array(wavBytes(tone, rate));
  const json = new TextEncoder().encode(JSON.stringify({ hello: 'سلام' }));
  const blob = zip([{ name: 'recordings.json', data: json }, { name: 'app/fa/گربه.wav', data: wav }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-zip-'));
  const file = path.join(dir, 'x.zip');
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const out = JSON.parse(python(`import zipfile, wave, io, json, sys
z = zipfile.ZipFile(${JSON.stringify(file)})
w = wave.open(io.BytesIO(z.read("app/fa/گربه.wav")))
print(json.dumps({"bad": z.testzip(), "names": z.namelist(), "json": json.loads(z.read("recordings.json")),
  "wav": [w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()]}))`));
  assert.equal(out.bad, null, 'every CRC matches');
  assert.deepEqual(out.names, ['recordings.json', 'app/fa/گربه.wav']);
  assert.deepEqual(out.json, { hello: 'سلام' });
  assert.deepEqual(out.wav, [1, 2, rate, rate / 2]);
  fs.rmSync(dir, { recursive: true });
});

test('file-name pieces keep letters of any script', () => {
  assert.equal(safe('Sara Ahmadi'), 'Sara_Ahmadi');
  assert.equal(safe('سارا/../x'), 'سارا_.._x');
  assert.equal(safe('word_core_cat'), 'word_core_cat');
});
