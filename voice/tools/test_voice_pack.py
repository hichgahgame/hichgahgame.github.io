"""Tests for voice_pack.py. Run from the site repo:
    voice/tools/.venv/bin/python -m unittest discover -s voice/tools -p 'test_*.py'
Audio conversion needs macOS afconvert (those tests are skipped elsewhere).
"""
import array
import contextlib
import csv
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_pack as v  # noqa: E402

HAS_AFCONVERT = shutil.which('afconvert') is not None


def tone(seconds, rate=24000, level=0.5, silence=0.0):
    """Mono 16-bit samples: `silence` s quiet, a 440 Hz tone, `silence` s quiet."""
    quiet = [0] * int(silence * rate)
    sound = [int(level * 32767 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(int(seconds * rate))]
    return array.array('h', quiet + sound + quiet)


def wav_bytes(samples, rate=24000, channels=1):
    out = io.BytesIO()
    with wave.open(out, 'wb') as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return out.getvalue()


def run(*args):
    """Runs the command line; returns what it printed."""
    out = io.StringIO()
    with mock.patch.object(sys, 'argv', ['voice', *args]), contextlib.redirect_stdout(out):
        v.main()
    return out.getvalue()


class Project:
    """A throwaway app with a voice script: wav and m4a lines, an onImport step, two languages."""

    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix='voice-app-')
        os.makedirs(os.path.join(self.dir, 'tool'))
        os.makedirs(os.path.join(self.dir, 'assets'))
        with open(os.path.join(self.dir, 'assets', 'recorded.json'), 'w') as f:
            f.write('{\n  "old": "x"\n}\n')
        self.script = {
            'format': v.SCRIPT_FORMAT, 'app': 'testapp', 'title': 'Test app', 'guide': 'Warm and clear.',
            'languages': {'fa': 'فارسی', 'en': 'English'},
            'audio': {'format': 'm4a', 'sampleRate': 24000, 'bitrate': 48000},
            'afterImport': 'make script',
            'lines': [
                {'lang': 'fa', 'id': 'cat', 'text': 'گُربه', 'group': 'words', 'dest': 'assets/fa/cat.wav', 'recorded': True},
                {'lang': 'fa', 'id': 'dog', 'text': 'سَگ', 'group': 'words', 'dest': 'assets/fa/dog.m4a', 'recorded': False,
                 'maxSeconds': 3},
                {'lang': 'en', 'id': 'cat', 'text': 'Cat', 'group': 'words', 'dest': 'assets/en/cat.wav', 'recorded': False},
                {'lang': 'fa', 'id': 'hello', 'text': 'سلام!', 'group': 'sentences', 'dest': 'assets/fa/hello.wav',
                 'recorded': False, 'onImport': [{'json': 'assets/recorded.json', 'set': 'hello', 'value': '{text}'}]},
            ],
        }
        self.write()

    def write(self):
        with open(os.path.join(self.dir, 'tool', 'testapp.voice.json'), 'w', encoding='utf-8') as f:
            json.dump(self.script, f, ensure_ascii=False)

    def path(self, *p):
        return os.path.join(self.dir, *p)

    def recordings_zip(self, folder, name, clips, notes=(), exported='2026-11-25T12:00:00Z'):
        """A zip as the page makes it: clips = [(lang, id, text, samples, recordedAt)]."""
        path = os.path.join(folder, name)
        entries = []
        with zipfile.ZipFile(path, 'w') as z:
            for lang, id_, text, samples, at in clips:
                file = f'testapp/{lang}/{id_}.wav'
                z.writestr(file, wav_bytes(samples))
                entries.append({'app': 'testapp', 'lang': lang, 'id': id_, 'text': text, 'file': file,
                                'recordedAt': at, 'seconds': len(samples) / 24000})
            z.writestr('recordings.json', json.dumps({
                'format': v.RECORDINGS_FORMAT, 'exported': exported, 'person': 'Sara', 'clips': entries,
                'notes': [{'app': 'testapp', 'lang': 'fa', 'id': i, 'text': t, 'note': n} for i, t, n in notes]}))
        return path

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.app = Project()

    def tearDown(self):
        self.app.close()

    def test_finds_the_script_in_a_project_folder(self):
        self.assertEqual(v.find_script(self.app.dir), self.app.path('tool', 'testapp.voice.json'))
        self.assertEqual(v.load_script(self.app.dir)['app'], 'testapp')

    def test_refuses_broken_scripts(self):
        self.app.script['lines'].append(dict(self.app.script['lines'][0]))
        self.app.write()
        with self.assertRaises(SystemExit):
            v.load_script(self.app.dir)
        self.app.script['lines'].pop()
        self.app.script['lines'][0] = {**self.app.script['lines'][0], 'text': ''}
        self.app.write()
        with self.assertRaises(SystemExit):
            v.load_script(self.app.dir)
        self.app.script['format'] = 'something/else'
        self.app.write()
        with self.assertRaises(SystemExit):
            v.load_script(self.app.dir)

    def test_filters_combine(self):
        s = v.load_script(self.app.dir)
        ids = lambda lines: [f"{l['lang']}/{l['id']}" for l in lines]
        self.assertEqual(ids(v.pick(s, [], [], [], False)), ['fa/cat', 'fa/dog', 'en/cat', 'fa/hello'])
        self.assertEqual(ids(v.pick(s, ['fa'], [], [], False)), ['fa/cat', 'fa/dog', 'fa/hello'])
        self.assertEqual(ids(v.pick(s, [], ['Sentences'], [], False)), ['fa/hello'])     # group names ignore case
        self.assertEqual(ids(v.pick(s, ['fa'], ['words'], [], True)), ['fa/dog'])       # --missing
        self.assertEqual(ids(v.pick(s, [], [], ['c*', 'hello'], False)), ['fa/cat', 'en/cat', 'fa/hello'])
        self.assertEqual(ids(v.pick(s, ['en'], ['sentences'], [], False)), [])

    def test_status_counts_per_language_and_group(self):
        out = run('status', self.app.dir)
        self.assertIn('fa  words', out)
        self.assertRegex(out, r'fa  words\s+1 / 2')


class PackTests(unittest.TestCase):
    def setUp(self):
        self.app = Project()
        self.packs = tempfile.mkdtemp(prefix='voice-packs-')
        self.patch = mock.patch.multiple(v, PACKS=self.packs, LABELS=os.path.join(self.packs, '.labels.json'))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.app.close()
        shutil.rmtree(self.packs, ignore_errors=True)

    def test_encryption_round_trip_and_names(self):
        pack = v.encrypt('a-long-password', {'hello': 'سلام'})
        self.assertEqual(pack['format'], v.PACK_FORMAT)
        self.assertEqual(v.decrypt('a-long-password', pack), {'hello': 'سلام'})
        with self.assertRaises(Exception):
            v.decrypt('another-password', pack)
        self.assertNotIn('سلام', json.dumps(pack, ensure_ascii=False))
        self.assertEqual(v.pack_name('a-long-password'), v.pack_name('a-long-password'))
        self.assertNotEqual(v.pack_name('a-long-password'), v.pack_name('a-long-passwore'))
        self.assertNotEqual(v.encrypt('p', {})['salt'], v.encrypt('p', {})['salt'])

    def test_generated_passwords(self):
        p = v.new_password()
        self.assertRegex(p, r'^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){3}$')
        self.assertNotEqual(p, v.new_password())

    def test_make_writes_only_the_chosen_lines_and_replaces_by_password(self):
        with mock.patch.dict(os.environ, {'VOICE_PACK_PASSWORD': 'test-password-123'}):
            out = run('make', self.app.dir, '--lang', 'fa', '--missing', '--person', 'Sara', '--message', 'Hi')
            self.assertIn('Wrote', out)
            name = v.pack_name('test-password-123')
            pack = json.load(open(os.path.join(self.packs, name + '.pack')))
            content = v.decrypt('test-password-123', pack)
            self.assertEqual(content['person'], 'Sara')
            self.assertEqual(content['message'], 'Hi')
            lines = content['scripts'][0]['lines']
            self.assertEqual([l['id'] for l in lines], ['dog', 'hello'])
            self.assertNotIn('dest', lines[0], 'paths in the app stay out of the pack')
            self.assertNotIn('onImport', lines[1])
            self.assertEqual(json.load(open(v.LABELS))[name]['lines'], 2)
            self.assertIn('Replaced', run('make', self.app.dir, '--id', 'cat'))
            self.assertIn('fa/cat', run('show', os.path.join(self.packs, name + '.pack')))
            self.assertIn(name, run('list'))
            run('remove', name)
            self.assertFalse(os.path.exists(os.path.join(self.packs, name + '.pack')))

    def test_make_refuses_short_passwords_and_empty_selections(self):
        with mock.patch.dict(os.environ, {'VOICE_PACK_PASSWORD': 'short'}), self.assertRaises(SystemExit):
            run('make', self.app.dir)
        with mock.patch.dict(os.environ, {'VOICE_PACK_PASSWORD': 'long-enough-pass'}), self.assertRaises(SystemExit):
            run('make', self.app.dir, '--group', 'nothing')

    def test_new_password_prints_a_one_tap_link(self):
        out = run('make', self.app.dir, '--new-password')
        password = out.split('Password: ')[1].split()[0]
        self.assertIn(f'{v.PAGE}#key={password}', out)
        self.assertTrue(os.path.exists(os.path.join(self.packs, v.pack_name(password) + '.pack')))


class AudioTests(unittest.TestCase):
    def test_trims_silence_and_evens_out_loudness(self):
        rate = 24000
        clean = v.tidy(tone(0.5, rate, level=0.05, silence=0.6), rate)
        self.assertAlmostEqual(len(clean) / rate, 0.5 + v.LEAD_S + v.TAIL_S, delta=0.05)
        peak = max(abs(x) for x in clean) / 32768
        self.assertLessEqual(peak, v.PEAK_CAP + 0.001)
        self.assertGreater(peak, 0.15, 'a quiet take is brought up')
        self.assertLess(abs(clean[0]) + abs(clean[-1]), 200, 'it fades in and out')

    def test_a_silent_clip_is_refused(self):
        self.assertIsNone(v.tidy(array.array('h', [3, -2] * 12000), 24000))
        self.assertIsNone(v.tidy(array.array('h'), 24000))


class JsonStepTests(unittest.TestCase):
    def test_keeps_each_files_style(self):
        d = tempfile.mkdtemp()
        try:
            two = os.path.join(d, 'two.json')
            open(two, 'w').write('{\n  "a": "1",\n  "c": "3"\n}\n')
            v.apply_steps(d, [{'json': 'two.json', 'set': 'b', 'value': '{text}'}], 'سلام', dry=False)
            self.assertEqual(open(two).read(), '{\n  "a": "1",\n  "b": "سلام",\n  "c": "3"\n}\n')
            one = os.path.join(d, 'one.json')
            open(one, 'w').write('{\n "fa/x": {\n  "text": "x"\n },\n "fa/y": 1\n}')
            v.apply_steps(d, [{'json': 'one.json', 'delete': 'fa/x'}], '', dry=False)
            self.assertEqual(open(one).read(), '{\n "fa/y": 1\n}')
            v.apply_steps(d, [{'json': 'one.json', 'delete': 'fa/y'}], '', dry=True)
            self.assertIn('fa/y', open(one).read(), 'a dry run changes nothing')
        finally:
            shutil.rmtree(d)


@unittest.skipUnless(HAS_AFCONVERT, 'needs macOS afconvert')
class ImportTests(unittest.TestCase):
    def setUp(self):
        self.app = Project()
        self.inbox = tempfile.mkdtemp(prefix='voice-inbox-')

    def tearDown(self):
        self.app.close()
        shutil.rmtree(self.inbox, ignore_errors=True)

    def test_a_zip_from_the_page_lands_in_the_app(self):
        z = self.app.recordings_zip(self.inbox, 'a.zip', [
            ('fa', 'cat', 'گُربه', tone(0.6, silence=0.4), '2026-11-25T12:00:00Z'),
            ('fa', 'dog', 'سَگ', tone(4.0), '2026-11-25T12:01:00Z'),
            ('fa', 'hello', 'سلام', tone(1.0), '2026-11-25T12:02:00Z'),     # the app's text has changed since
            ('fa', 'gone', 'رفته', tone(0.5), '2026-11-25T12:03:00Z'),
            ('en', 'cat', 'Cat', array.array('h', [0] * 24000), '2026-11-25T12:04:00Z'),
        ], notes=[('cat', 'گُربه', 'Typo here?')])
        out = run('import', z, '--project', self.app.dir)
        with wave.open(self.app.path('assets', 'fa', 'cat.wav')) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, 24000))
            self.assertLess(w.getnframes() / 24000, 1.0, 'the silence was trimmed')
        info = subprocess.run(['afinfo', self.app.path('assets', 'fa', 'dog.m4a')], capture_output=True, text=True).stdout
        self.assertIn('24000 Hz, aac', info)
        self.assertIn('longer than 3 s', out)
        self.assertIn('skipped fa/gone: not in the script', out)
        self.assertIn('skipped en/cat: the clip is silent', out)
        self.assertFalse(os.path.exists(self.app.path('assets', 'en', 'cat.wav')))
        self.assertIn('recorded «سلام», the app now says «سلام!»', out)
        self.assertEqual(json.load(open(self.app.path('assets', 'recorded.json'))), {'hello': 'سلام', 'old': 'x'},
                         'onImport notes the text as recorded')
        self.assertIn('Typo here?', out)
        self.assertIn('Typo here?', open(os.path.join(self.inbox, 'a-notes.txt'), encoding='utf-8').read())
        self.assertIn('next, in', out)
        self.assertIn('make script', out)

    def test_dry_run_changes_nothing(self):
        z = self.app.recordings_zip(self.inbox, 'a.zip', [('fa', 'hello', 'سلام!', tone(0.5), '2026-11-25T12:00:00Z')])
        out = run('import', z, '--project', self.app.dir, '--dry-run')
        self.assertIn('would be placed', out)
        self.assertFalse(os.path.exists(self.app.path('assets', 'fa', 'hello.wav')))
        self.assertNotIn('hello', open(self.app.path('assets', 'recorded.json')).read())

    def test_several_zips_keep_the_newest_take_of_each_line(self):
        old, new = tone(0.5), tone(1.5)
        self.app.recordings_zip(self.inbox, 'send2.zip', [('fa', 'cat', 'گُربه', new, '2026-11-25T14:00:00Z')])
        self.app.recordings_zip(self.inbox, 'send1.zip', [('fa', 'cat', 'گُربه', old, '2026-11-25T10:00:00Z'),
                                                          ('fa', 'dog', 'سَگ', old, '2026-11-25T10:00:00Z')])
        out = run('import', self.inbox, '--project', self.app.dir)              # a folder of zips
        self.assertIn('2 lines in 2 sources', out)
        with wave.open(self.app.path('assets', 'fa', 'cat.wav')) as w:
            self.assertGreater(w.getnframes() / 24000, 1.4, 'the 14:00 take won')
        self.assertTrue(os.path.exists(self.app.path('assets', 'fa', 'dog.m4a')))

    def test_a_folder_of_studio_files(self):
        studio = os.path.join(self.inbox, 'studio')
        os.makedirs(os.path.join(studio, 'fa'))
        stereo = array.array('h', [s for x in tone(0.5, 44100) for s in (x, x)])
        open(os.path.join(studio, 'fa', 'cat.wav'), 'wb').write(wav_bytes(stereo, 44100, channels=2))
        open(os.path.join(studio, 'hello.wav'), 'wb').write(wav_bytes(tone(0.5)))
        open(os.path.join(studio, 'cat.wav'), 'wb').write(wav_bytes(tone(0.5)))     # fa or en? ambiguous
        open(os.path.join(studio, 'notes.txt'), 'w').write('ignored')
        out = run('import', studio, '--project', self.app.dir)
        self.assertIn('2 files match', out)
        self.assertIn('skipped cat.wav: several languages', out)
        with wave.open(self.app.path('assets', 'fa', 'cat.wav')) as w:
            self.assertEqual((w.getnchannels(), w.getframerate()), (1, 24000), 'stereo 44.1 kHz became the app format')
        self.assertTrue(os.path.exists(self.app.path('assets', 'fa', 'hello.wav')))
        out = run('import', studio, '--project', self.app.dir, '--lang', 'en', '--dry-run')
        self.assertIn('assets/en/cat.wav', out)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.app = Project()
        self.out = tempfile.mkdtemp(prefix='voice-export-')

    def tearDown(self):
        self.app.close()
        shutil.rmtree(self.out, ignore_errors=True)

    def test_one_sheet(self):
        run('export', self.app.dir, '--lang', 'fa', '--out', self.out)
        rows = list(csv.DictReader(open(os.path.join(self.out, 'lines.csv'), encoding='utf-8-sig')))
        self.assertEqual([r['file'] for r in rows], ['fa/cat.wav', 'fa/dog.wav', 'fa/hello.wav'])
        self.assertEqual(rows[0]['text'], 'گُربه')
        self.assertTrue(open(os.path.join(self.out, 'lines.csv'), 'rb').read().startswith(b'\xef\xbb\xbf'), 'BOM for Excel')
        md = open(os.path.join(self.out, 'lines.md'), encoding='utf-8').read()
        self.assertIn('Warm and clear.', md)
        self.assertIn('## sentences', md)
        self.assertIn('| `fa/dog.wav` | سَگ |', md)

    def test_in_parts(self):
        out = run('export', self.app.dir, '--chunk', '3', '--out', self.out)
        self.assertEqual(sorted(os.listdir(self.out)),
                         ['part01-lines.csv', 'part01-lines.md', 'part02-lines.csv', 'part02-lines.md'])
        self.assertIn('(part 2 of 2)', open(os.path.join(self.out, 'part02-lines.md'), encoding='utf-8').read())
        self.assertIn('4 lines', out)


if __name__ == '__main__':
    unittest.main()
