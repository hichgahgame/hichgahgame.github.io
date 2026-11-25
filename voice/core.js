// The voice page's logic that needs no page: packs (crypto), WAV and zip files, parts, batches, times.
// voice.js imports it; voice/tests/core.test.mjs tests it with Node (`node --test voice/tests/*.test.mjs`).

export const ITERATIONS = 310000;                // as voice_pack.py
export const NAME_SALT = 'hichgah-voice-pack-name/1';

export const enc = (s) => new TextEncoder().encode(s);
export const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- packs ----------

export async function pbkdf2(password, salt, bytes, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, bytes * 8);
  return new Uint8Array(bits);
}

/** The pack's file name (without .pack): derived from the password, so packs can't be listed. */
export async function packName(password) {
  return hex(await pbkdf2(password, enc(NAME_SALT), 16));
}

/** Decrypts a pack file's JSON ({salt, iv, data, iterations}); throws on a wrong password. */
export async function decryptPack(password, pack) {
  const raw = await pbkdf2(password, b64(pack.salt), 32, pack.iterations);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(pack.iv) }, key, b64(pack.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- parts and sending ----------

/**
 * Cuts lines into parts: never across groups, each about `size` lines (a group's parts evened out).
 * Returns [{group, n, of, lines}].
 */
export function splitParts(lines, size) {
  const groups = new Map();
  for (const l of lines) {
    if (!groups.has(l.group)) groups.set(l.group, []);
    groups.get(l.group).push(l);
  }
  const parts = [];
  for (const [group, list] of groups) {
    const count = Math.max(1, Math.round(list.length / size));
    const each = Math.ceil(list.length / count);
    for (let i = 0; i < count; i++) {
      const chunk = list.slice(i * each, (i + 1) * each);
      if (chunk.length) parts.push({ group, n: i + 1, of: count, lines: chunk });
    }
  }
  return parts;
}

/** A recording not sent yet, or re-recorded after it was sent. */
export const isNew = (meta) => Boolean(meta && (!meta.sentAt || meta.sentAt < meta.at));

/** Groups items into batches of at most `max` bytes each (an item bigger than `max` gets a batch of its own). */
export function batchBySize(items, sizeOf, max) {
  const batches = [[]];
  let size = 0;
  for (const it of items) {
    const n = sizeOf(it);
    if (size + n > max && batches.at(-1).length) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1).push(it);
    size += n;
  }
  return batches[0].length ? batches : [];
}

// ---------- times ----------

const pad = (n) => String(n).padStart(2, '0');

/** Local date and time for file names, sorting in order: 2026-11-25-1432. */
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

/** "today 14:32", "yesterday 09:05", "25 Nov 14:32", in the person's own time zone. */
export function when(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

// ---------- audio ----------

/** Halves 44.1/48 kHz to 22.05/24 kHz (plenty for speech; half the size). Lower rates are kept. */
export function downsample(samples, rate) {
  if (rate < 44100) return { samples, rate };
  const half = new Float32Array(samples.length >> 1);
  for (let i = 0; i < half.length; i++) half[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
  return { samples: half, rate: rate / 2 };
}

export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/** Whether a take is usable: {ok} or {ok: false, silent?, text}. Silent takes are not saved. */
export function verdict(take) {
  if (take.seconds < 0.3) return { ok: false, silent: true, text: 'That was very short. Tap, say the line, then tap again.' };
  if (take.peak < 0.02) return { ok: false, silent: true, text: 'I couldn’t hear anything. Is the microphone covered, or muted?' };
  if (take.peak < 0.08) return { ok: false, text: 'Quite quiet. Come a little closer, or speak up a little.' };
  if (take.peak > 0.99) return { ok: false, text: 'A bit loud: it may crackle. Hold the phone a little further away.' };
  return { ok: true };
}

/** Float samples (-1..1) -> a mono 16-bit PCM WAV file (ArrayBuffer). */
export function wavBytes(samples, rate) {
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

// ---------- zip (stored: WAV barely compresses) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** [{name, data: Uint8Array}] -> a zip Blob (UTF-8 names). */
export function zip(files, now = new Date()) {
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

/** A safe file-name piece (letters of any script, digits, . _ -). */
export const safe = (s) => s.replace(/[^\p{L}\p{N}._-]+/gu, '_');
