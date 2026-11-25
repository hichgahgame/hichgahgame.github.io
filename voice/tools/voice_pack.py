#!/usr/bin/env python3
"""Hichgah voice packs: send lines to a voice person anywhere, get their recordings back into the app.

    voice make <script or project> [--lang fa] [--group "letter names"] [--id 'word_core_*'] [--missing]
               [--person "Sara"] [--message "..."] [--new-password]
    voice show <pack file>            decrypt a pack and list what is in it
    voice list                        the packs on the site (from the local labels file)
    voice remove <pack name>          delete a pack from the site
    voice status <script or project>  recorded / total per language and group
    voice import <recordings.zip> [--project DIR] [--dry-run]

A *script* (`*.voice.json`, format hichgah-voice-script/1) is written by each app's own tool and lists
every line it could record: {lang, id, text, group, direction, picture|image, dest, recorded, onImport}.
`make` picks some of its lines, encrypts them with a password (PBKDF2-SHA256 + AES-256-GCM) and writes
`voice/packs/<name>.pack`, where the name is also derived from the password: the page finds the pack
from the password alone, and nobody can list or read the packs without one. Push the site to publish it.

The voice person opens https://hichgahgame.github.io/voice/, types the password, records, and sends back
one zip (recordings.json + WAV files). `import` trims the silence, evens out loudness, converts each clip
to the format the app wants (macOS afconvert) and puts it at the line's `dest` in the app's project,
then applies the line's `onImport` steps (for example noting the recorded text in a JSON file).

Setup once: python3.14 -m venv voice/tools/.venv && voice/tools/.venv/bin/pip install cryptography
(`voice/tools/voice` does this by itself.) The password can also come from $VOICE_PACK_PASSWORD.
"""
import argparse
import array
import base64
import datetime
import fnmatch
import getpass
import glob
import hashlib
import io
import json
import math
import os
import secrets
import subprocess
import sys
import tempfile
import wave
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(os.path.dirname(HERE))          # hichgahgame.github.io
PACKS = os.path.join(SITE, 'voice', 'packs')
LABELS = os.path.join(PACKS, '.labels.json')           # gitignored: which pack is whose
HICHGAH = os.path.dirname(SITE)                         # the folder holding every hichgah repo
PAGE = 'https://hichgahgame.github.io/voice/'

SCRIPT_FORMAT = 'hichgah-voice-script/1'
PACK_FORMAT = 'hichgah-voice-pack/1'
CONTENT_FORMAT = 'hichgah-voice-pack-content/1'
RECORDINGS_FORMAT = 'hichgah-voice-recordings/1'
ITERATIONS = 310_000                                    # the page uses the same (voice.js)
NAME_SALT = b'hichgah-voice-pack-name/1'
LINE_FIELDS = ('lang', 'id', 'text', 'group', 'direction', 'picture', 'image', 'maxSeconds')

# Tidying (as farsi-apps/tools/tidy_voice.py): keep 0.08 s before and 0.15 s after the speech,
# speech at about -18 dBFS, peaks at most -1 dBFS, 10 ms fades.
LEAD_S, TAIL_S, WIN_S = 0.08, 0.15, 0.02
TARGET_RMS, PEAK_CAP = 0.12, 0.89


# ---------- scripts ----------

def find_script(path):
    """A script file, or the one *.voice.json inside a project's tool folder."""
    if os.path.isfile(path):
        return path
    found = []
    for folder in ('tool', 'tools', 'Tool', 'Tools'):
        found += glob.glob(os.path.join(path, folder, '**', '*.voice.json'), recursive=True)
    found = sorted({(os.stat(f).st_dev, os.stat(f).st_ino): f for f in found}.values())  # tool/ = Tool/ on macOS
    if len(found) != 1:
        sys.exit(f'{path}: expected one tool/**/*.voice.json, found {len(found)}')
    return found[0]


def load_script(path):
    path = find_script(path)
    script = json.load(open(path, encoding='utf-8'))
    if script.get('format') != SCRIPT_FORMAT:
        sys.exit(f'{path}: not a {SCRIPT_FORMAT} script')
    keys = set()
    for line in script['lines']:
        for field in ('lang', 'id', 'text', 'group'):
            if not line.get(field):
                sys.exit(f'{path}: a line has no {field}: {line}')
        key = f"{line['lang']}/{line['id']}"
        if key in keys:
            sys.exit(f'{path}: {key} is listed twice')
        keys.add(key)
    script['_path'] = path
    return script


def pick(script, langs, groups, ids, missing):
    groups = [g.lower() for g in groups]
    lines = []
    for line in script['lines']:
        if langs and line['lang'] not in langs:
            continue
        if groups and line['group'].lower() not in groups:
            continue
        if ids and not any(fnmatch.fnmatchcase(line['id'], p) for p in ids):
            continue
        if missing and line.get('recorded'):
            continue
        lines.append(line)
    return lines


# ---------- crypto ----------

def pack_name(password):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), NAME_SALT, ITERATIONS, 16).hex()


def encrypt(password, content):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, ITERATIONS, 32)
    data = AESGCM(key).encrypt(iv, json.dumps(content, ensure_ascii=False).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {'format': PACK_FORMAT, 'kdf': 'PBKDF2-SHA256', 'iterations': ITERATIONS,
            'salt': b64(salt), 'iv': b64(iv), 'data': b64(data)}


def decrypt(password, pack):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = hashlib.pbkdf2_hmac('sha256', password.encode(), base64.b64decode(pack['salt']), pack['iterations'], 32)
    return json.loads(AESGCM(key).decrypt(base64.b64decode(pack['iv']), base64.b64decode(pack['data']), None))


def new_password():
    alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'   # no 0/o, 1/l/i
    return '-'.join(''.join(secrets.choice(alphabet) for _ in range(4)) for _ in range(4))


def ask_password(confirm):
    if os.environ.get('VOICE_PACK_PASSWORD'):
        return os.environ['VOICE_PACK_PASSWORD']
    password = getpass.getpass('Password: ')
    if confirm and getpass.getpass('Again: ') != password:
        sys.exit('The passwords differ.')
    return password


def labels():
    return json.load(open(LABELS)) if os.path.exists(LABELS) else {}


# ---------- commands ----------

def cmd_make(a):
    scripts = [load_script(s) for s in a.script]
    if a.new_password:
        password = new_password()
    else:
        password = ask_password(confirm=True)
        if len(password) < 12:
            sys.exit('Use at least 12 characters (or --new-password for a generated one).')
    content = {'format': CONTENT_FORMAT, 'made': datetime.date.today().isoformat(),
               'person': a.person or '', 'message': a.message or '', 'scripts': []}
    summary = []
    for script in scripts:
        lines = pick(script, a.lang, a.group, a.id, a.missing)
        if not lines:
            continue
        images = script.get('images', {})
        used = {l['image'] for l in lines if l.get('image')}
        content['scripts'].append({
            'app': script['app'], 'title': script['title'], 'guide': script.get('guide', ''),
            'languages': script.get('languages', {}),
            'images': {k: v for k, v in images.items() if k in used},
            'lines': [{k: l[k] for k in LINE_FIELDS if l.get(k)} for l in lines],
        })
        groups = {}
        for l in lines:
            groups[l['group']] = groups.get(l['group'], 0) + 1
        summary.append(f"  {script['title']}: {len(lines)} lines " + ', '.join(f'{g} {n}' for g, n in groups.items()))
    if not content['scripts']:
        sys.exit('No lines match that selection.')
    name = pack_name(password)
    os.makedirs(PACKS, exist_ok=True)
    path = os.path.join(PACKS, name + '.pack')
    replaced = os.path.exists(path)
    json.dump(encrypt(password, content), open(path, 'w'))
    tags = labels()
    tags[name] = {'person': a.person or '', 'made': content['made'], 'apps': [s['app'] for s in content['scripts']],
                  'lines': sum(len(s['lines']) for s in content['scripts'])}
    json.dump(tags, open(LABELS, 'w'), ensure_ascii=False, indent=2)
    print(('Replaced' if replaced else 'Wrote') + f' {os.path.relpath(path, SITE)}')
    print('\n'.join(summary))
    if a.new_password:
        print(f'\nPassword: {password}')
    print(f'Link:     {PAGE}' + (f'#key={password}' if a.new_password else ''))
    print('Push the site repo to publish it. Send the link and password to the voice person only.')


def cmd_show(a):
    password = ask_password(confirm=False)
    path = a.pack if os.path.exists(a.pack) else os.path.join(PACKS, a.pack.removesuffix('.pack') + '.pack')
    content = decrypt(password, json.load(open(path)))
    print(f"For {content['person'] or '(no name)'}, made {content['made']}")
    for s in content['scripts']:
        print(f"{s['title']} ({s['app']}): {len(s['lines'])} lines")
        for l in s['lines']:
            print(f"  {l['lang']}/{l['id']}  [{l['group']}]  {l['text']}")


def cmd_list(a):
    on_site = {f.removesuffix('.pack') for f in os.listdir(PACKS) if f.endswith('.pack')} if os.path.isdir(PACKS) else set()
    tags = labels()
    for name in sorted(on_site):
        t = tags.get(name, {})
        print(f"{name}  {t.get('person', '?'):14} {t.get('made', ''):10}  {','.join(t.get('apps', []))}  {t.get('lines', '')} lines")
    if not on_site:
        print('No packs on the site.')


def cmd_remove(a):
    name = a.name.removesuffix('.pack')
    path = os.path.join(PACKS, name + '.pack')
    if not os.path.exists(path):
        sys.exit(f'No pack {name}')
    os.remove(path)
    tags = labels()
    tags.pop(name, None)
    json.dump(tags, open(LABELS, 'w'), ensure_ascii=False, indent=2)
    print(f'Removed {name}. Push the site repo to take it offline.')


def cmd_status(a):
    script = load_script(a.script)
    table = {}
    for l in script['lines']:
        row = table.setdefault((l['lang'], l['group']), [0, 0])
        row[0] += 1 if l.get('recorded') else 0
        row[1] += 1
    for (lang, group), (done, total) in sorted(table.items()):
        print(f'{lang}  {group:20} {done:4} / {total}')


# ---------- import ----------

def tidy(samples, rate):
    win = max(1, int(rate * WIN_S))
    rms = [math.sqrt(sum(x * x for x in samples[i:i + win]) / win) for i in range(0, len(samples) - win, win)]
    if not rms or max(rms) < 300:          # about -40 dBFS: nothing was said
        return None
    loud = [i for i, r in enumerate(rms) if r > max(rms) * 0.1]
    start = max(0, loud[0] * win - int(rate * LEAD_S))
    end = min(len(samples), (loud[-1] + 1) * win + int(rate * TAIL_S))
    clip = samples[start:end]
    speech = rms[loud[0]:loud[-1] + 1]
    level = math.sqrt(sum(r * r for r in speech) / len(speech)) / 32768
    peak = max(abs(x) for x in clip) / 32768
    gain = min(TARGET_RMS / level, PEAK_CAP / peak)
    fade = max(1, int(rate * 0.01))
    out = array.array('h', (max(-32768, min(32767, int(x * gain * min(1.0, i / fade, (len(clip) - 1 - i) / fade))))
                            for i, x in enumerate(clip)))
    return out


def encode(wav_path, dest, audio):
    rate = audio.get('sampleRate')
    if dest.endswith('.m4a'):
        args = ['-f', 'm4af', '-d', f'aac@{rate}' if rate else 'aac', '-b', str(audio.get('bitrate', 48000))]
    elif dest.endswith('.wav'):
        args = ['-f', 'WAVE', '-d', f'LEI16@{rate}' if rate else 'LEI16']
    else:
        sys.exit(f'{dest}: only .m4a and .wav are supported')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    subprocess.run(['afconvert', *args, wav_path, dest], check=True)


def write_json_like(path, data, original_text):
    """Writes JSON in the style the file already had: its indent, key order and final newline."""
    indent = 2
    for line in original_text.splitlines()[1:]:
        if line.strip():
            indent = len(line) - len(line.lstrip()) or None
            break
    keys = list(json.loads(original_text).keys()) if original_text.strip() else []
    if keys == sorted(keys):
        data = dict(sorted(data.items()))
    text = json.dumps(data, ensure_ascii=False, indent=indent)
    open(path, 'w', encoding='utf-8').write(text + ('\n' if original_text.endswith('\n') or not original_text else ''))


def apply_steps(project, steps, recorded_text, dry):
    for step in steps:
        path = os.path.join(project, step['json'])
        original = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
        data = json.loads(original) if original.strip() else {}
        if 'set' in step:
            data[step['set']] = step.get('value', '{text}').replace('{text}', recorded_text)
        elif 'delete' in step:
            data.pop(step['delete'], None)
        if not dry:
            write_json_like(path, data, original)


def cmd_import(a):
    z = zipfile.ZipFile(a.zip)
    rec = json.loads(z.read('recordings.json'))
    if rec.get('format') != RECORDINGS_FORMAT:
        sys.exit('Not a Hichgah voice recordings zip')
    apps = sorted({c['app'] for c in rec['clips']} | {n['app'] for n in rec.get('notes', [])})
    if a.project and len(apps) > 1:
        sys.exit(f'This zip has several apps ({", ".join(apps)}): leave out --project')
    who = rec.get('person') or 'someone'
    print(f"Recordings by {who}, sent {rec.get('exported', '?')[:16]}: {len(rec['clips'])} clips")
    notes = []
    with tempfile.TemporaryDirectory() as tmp:
        for app in apps:
            project = a.project or os.path.join(HICHGAH, app)
            script = load_script(project)
            if script['app'] != app:
                sys.exit(f"{script['_path']} is {script['app']}, not {app}")
            lines = {f"{l['lang']}/{l['id']}": l for l in script['lines']}
            audio = script.get('audio', {})
            placed = 0
            for clip in (c for c in rec['clips'] if c['app'] == app):
                key = f"{clip['lang']}/{clip['id']}"
                line = lines.get(key)
                if line is None:
                    print(f'  skipped {key}: not in the script any more')
                    continue
                if line['text'] != clip['text']:
                    print(f'  note {key}: recorded «{clip["text"]}», the app now says «{line["text"]}»')
                with wave.open(io.BytesIO(z.read(clip['file']))) as w:
                    rate = w.getframerate()
                    if w.getnchannels() != 1 or w.getsampwidth() != 2:
                        sys.exit(f"{clip['file']}: expected mono 16-bit")
                    samples = array.array('h', w.readframes(w.getnframes()))
                clean = tidy(samples, rate)
                if clean is None:
                    print(f'  skipped {key}: the clip is silent')
                    continue
                seconds = len(clean) / rate
                limit = line.get('maxSeconds')
                warn = f'  (longer than {limit} s!)' if limit and seconds > limit else ''
                dest = os.path.join(project, line['dest'])
                existed = os.path.exists(dest)
                print(f"  {'replaced' if existed else 'new     '} {line['dest']}  {seconds:.2f} s{warn}")
                if not a.dry_run:
                    tmp_wav = os.path.join(tmp, 'clip.wav')
                    with wave.open(tmp_wav, 'wb') as w:
                        w.setnchannels(1)
                        w.setsampwidth(2)
                        w.setframerate(rate)
                        w.writeframes(clean.tobytes())
                    encode(tmp_wav, dest, audio)
                apply_steps(project, line.get('onImport', []), clip['text'], a.dry_run)
                placed += 1
            print(f"{script['title']}: {placed} clips {'would be ' if a.dry_run else ''}placed in {project}")
            if placed and script.get('afterImport'):
                print(f"  next, in {project}: {script['afterImport']}")
            notes += [n for n in rec.get('notes', []) if n['app'] == app]
    if notes:
        print(f'\nNotes from {who}:')
        for n in notes:
            print(f"  {n['app']} {n['lang']}/{n['id']}  «{n['text']}»\n      {n['note']}")
        if not a.dry_run:
            path = os.path.splitext(a.zip)[0] + '-notes.txt'
            with open(path, 'w', encoding='utf-8') as f:
                for n in notes:
                    f.write(f"{n['app']} {n['lang']}/{n['id']}\t{n['text']}\t{n['note']}\n")
            print(f'(saved in {path})')


def main():
    p = argparse.ArgumentParser(prog='voice', description=__doc__.split('\n')[0])
    sub = p.add_subparsers(dest='cmd', required=True)
    m = sub.add_parser('make', help='make an encrypted pack of lines to record')
    m.add_argument('script', nargs='+', help='a *.voice.json script or an app project folder')
    m.add_argument('--lang', action='append', default=[])
    m.add_argument('--group', action='append', default=[], help='a group name (repeatable)')
    m.add_argument('--id', action='append', default=[], help="an id or glob, e.g. 'word_core_*' (repeatable)")
    m.add_argument('--missing', action='store_true', help='only lines the app has no recording of')
    m.add_argument('--person', help='who records it (shown to them, and in `voice list`)')
    m.add_argument('--message', help='a note shown when the pack opens')
    m.add_argument('--new-password', action='store_true', help='generate a password and a one-tap link')
    s = sub.add_parser('show', help='decrypt a pack and list its lines')
    s.add_argument('pack')
    sub.add_parser('list', help='the packs on the site')
    r = sub.add_parser('remove', help='delete a pack from the site')
    r.add_argument('name')
    st = sub.add_parser('status', help='what is recorded already')
    st.add_argument('script')
    i = sub.add_parser('import', help='put the recordings from a zip into the app')
    i.add_argument('zip')
    i.add_argument('--project', help='the app folder (default: the sibling folder named after the app)')
    i.add_argument('--dry-run', action='store_true')
    a = p.parse_args()
    {'make': cmd_make, 'show': cmd_show, 'list': cmd_list, 'remove': cmd_remove,
     'status': cmd_status, 'import': cmd_import}[a.cmd](a)


if __name__ == '__main__':
    main()
