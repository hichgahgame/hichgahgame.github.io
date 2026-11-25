# Voice packs: recording voices remotely

`https://hichgahgame.github.io/voice/` is a private recording page for the people who voice Hichgah's
games, wherever they live. You choose the lines, lock them with a password and send the person a link.
They record on their phone or computer and send back one file, and one command puts the clips into the app.

- **Password protection:** the lines are encrypted (PBKDF2-SHA256, 310,000 rounds, AES-256-GCM). A pack's
  file name is also derived from the password, so without it nobody can find a pack or read it. The page
  itself is public but shows nothing without a password, and search engines are told not to index it.
- **Nothing is uploaded:** recordings stay in the person's browser (IndexedDB) until they send the zip
  themselves (WhatsApp as a document, Telegram, email, Drive).
- **Onboarding:** the first time a pack opens, five short screens greet the person by name. They show
  how many lines there are and about how long it takes, a real line from their list as an example, how
  to record, the app's voice guide with a microphone test (never saved), and how to send. "How it works"
  on the list opens them again.

## Workflow

```sh
VOICE=../hichgahgame.github.io/voice/tools/voice     # from an app's folder (sets up its venv on first use)

$VOICE status .                                       # what is recorded, per language and group
$VOICE make . --group "app sentences" --missing --person "Sara" --new-password
#   writes voice/packs/<name>.pack and prints a password and a one-tap link (…/voice/#key=…)
cd ../hichgahgame.github.io && git add voice/packs && git commit -m "Voice pack" && git push
#   send the person the link (or the page and the password)

$VOICE import ~/Downloads/kalamak-voice-Sara-2026-11-25.zip --dry-run    # look first
$VOICE import ~/Downloads/kalamak-voice-Sara-2026-11-25.zip              # then place the clips
```

**Choosing lines** (`make`), with every filter repeatable: `--lang fa`, `--group "letter names"`,
`--id 'word_core_*'` (globs), `--missing` (only lines the app has no clip for). Several apps can go in one
pack: `make ../kalamak ../mystery-sand`. Without `--new-password` it asks for one (at least 12
characters) or reads `$VOICE_PACK_PASSWORD`. Making a pack again with the same password replaces it,
and the person's recordings so far are kept.

**Other commands:** `show <pack>` (decrypt and list), `list` (the packs here, with who they are for, from
the local `.labels.json`), `remove <name>` (then push to take it offline).

**Importing** trims the silence (0.08 s before, 0.15 s after), sets the speech to about -18 dBFS with
peaks at most -1 dBFS (as `farsi-apps/tools/tidy_voice.py`), converts with macOS `afconvert` to the
script's `audio` format and writes each clip to its line's `dest`. Then it applies the line's `onImport`
steps, prints the person's notes (also saved beside the zip) and prints the app's `afterImport`
command. The app is the sibling folder named after the script's `app`, or `--project DIR`.

## Adding an app

The app writes a script, `tool/<app>.voice.json` (or under `Tools/`), from its own data:

```json
{
  "format": "hichgah-voice-script/1",
  "app": "kalamak", "title": "Kalamak",
  "guide": "Warm, slow and clear, like reading to a 5-year-old…",
  "languages": {"fa": "فارسی"},
  "audio": {"format": "m4a", "sampleRate": 24000, "bitrate": 48000},
  "afterImport": "flutter test tool/voice_script_test.dart",
  "images": {"apple": "<svg …>"},
  "lines": [
    {"lang": "fa", "id": "word_core_cat", "text": "گُربه", "group": "words", "direction": "gorbe: cat",
     "picture": "🐈", "dest": "assets/packs/core/voice/cat.m4a", "recorded": true, "maxSeconds": 3,
     "onImport": [{"json": "assets/voice/ui/fa/recorded.json", "set": "cat", "value": "{text}"}]}
  ]
}
```

- `lang` + `id` must be unique.
- `dest` is relative to the app folder; it must end in `.m4a` or `.wav`.
- `recorded` drives `--missing`.
- `picture` is an emoji. `image` names an SVG in `images`, shown as a picture (never as a page).
- `maxSeconds` makes the page warn about long takes.
- `onImport` steps edit a JSON file in the app:
  - `{"json", "set", "value"}`: `{text}` becomes the text that was recorded.
  - `{"json", "delete"}`: for example, drop a text-to-speech placeholder from its manifest.
  - Each file keeps its indent, key order and final newline.

Kalamak's script comes from `kalamak/tool/voice_script.dart`.
