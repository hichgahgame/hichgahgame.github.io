# hichgahgame.github.io

The public Hichgah website, served by GitHub Pages from `main` at https://hichgahgame.github.io/.
Push to `main` and the change is live in about a minute.

```
index.html                 studio home page (home.css): approach, ages, games, promises
style.css                  shared styles (all pages link it); imports brand/tokens.css
favicon.svg, favicon-32.png, apple-touch-icon.png   the Hichgah mark in browser tabs and on home screens
brand/                     the brand kit: tokens, logo, guide page → https://hichgahgame.github.io/brand/
app-ads.txt                AdMob seller line, shared by every game (one per developer website)
motion.js                  pauses the autoplaying gameplay videos for visitors who prefer reduced motion
<game>/index.html          the game's page      → https://hichgahgame.github.io/<game>/
<game>/theme.css           the game's colours (light and dark), used by its page and privacy policy
<game>/media/              icon (256px), 4 screenshots (540x960 JPEG), gameplay.mp4 + poster.jpg
<game>/privacy/index.html  its privacy policy   → https://hichgahgame.github.io/<game>/privacy/
tools/frames-to-mp4.swift  turns a folder of PNG frames into the gameplay MP4 (macOS, nothing to install)
```

Gameplay videos are rendered frame by frame by each game's capture test (Cookie:
`ScreenshotCapture.CaptureVideo`; Wonderlings: `ScreenshotTests.Video_PuzzleSolve`), then encoded:
`swift tools/frames-to-mp4.swift <frames folder> 30 <game>/media/gameplay.mp4 1200`.
Keep each video under about 3 MB.

Use the game's repo name, lowercase, for `<game>` (for example `wonderlings`, `dogify`,
`cookie-jump-and-duck`). Once a store listing uses one of these URLs, it must never change.

## Brand

`brand/tokens.json` is the single source of the Hichgah look: colours (each hue has base, deep,
soft and night shades), gradients, shared game meanings (star, reward, success, ...), fonts, radii,
spacing and motion. Change it there, never in the generated files, then:

```sh
python3 brand/build.py        # checks text contrast (WCAG AA), writes brand/tokens.css and the Unity C#
brand/render-logo.sh          # only after changing a logo SVG: PNGs, favicons, game copies
brand/sync-unity.sh           # copies Assets/Hichgah/Brand/ into every game beside this repo
```

Games use `Hichgah.Brand` (`HichgahColors.Game.Star`, `HichgahGradients.Now`, `HichgahMotion.Calm`, ...)
and the logo PNGs in `Assets/Hichgah/Brand/Logo/`. Each game keeps its own world colours; the
brand covers what should feel the same everywhere: the logo, stars, rewards, buttons, motion.

## Adding a game

1. Copy `wonderlings/` to `<game>/`. Set the game's colours in `theme.css`, replace `media/`, and
   rewrite the skills section. Rewrite the game page and the privacy policy so they describe
   **that** game: its package id, effective date, and whether it shows ads, needs internet or stores anything.
   Never reuse another game's policy unchanged.
2. Add a `<li class="card game">` for it in `index.html`, under "Our games".
3. If the game uses AdMob with the same publisher account, `app-ads.txt` already covers it. A different
   ad network adds its own line to that file.
4. Push. Then paste `https://hichgahgame.github.io/<game>/privacy/` into Play Console > App content >
   Privacy policy, and set Store listing > Contact details > Website to `https://hichgahgame.github.io/`.

Before releasing a game version that changes how it handles data, update its policy here **first**,
together with that game's Play Console Data safety answers.
