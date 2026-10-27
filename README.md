# hichgahgame.github.io

The public Hichgah website, served by GitHub Pages from `main` at https://hichgahgame.github.io/.
Push to `main` and the change is live in about a minute.

```
index.html                 studio home page: lists every game
style.css                  shared styles (all pages link it)
app-ads.txt                AdMob seller line, shared by every game (one per developer website)
<game>/index.html          the game's page      → https://hichgahgame.github.io/<game>/
<game>/privacy/index.html  its privacy policy   → https://hichgahgame.github.io/<game>/privacy/
```

Use the game's repo name, lowercase, for `<game>` (for example `wonderlings`, `dogify`,
`cookie-jump-and-duck`). Once a store listing uses one of these URLs, it must never change.

## Adding a game

1. Copy `wonderlings/` to `<game>/`. Rewrite the game page and the privacy policy so they describe
   **that** game: its package id, effective date, and whether it shows ads, needs internet or stores anything.
   Never reuse another game's policy unchanged.
2. Add a `<li class="card game">` for it in `index.html`, under "Our games".
3. If the game uses AdMob with the same publisher account, `app-ads.txt` already covers it. A different
   ad network adds its own line to that file.
4. Push. Then paste `https://hichgahgame.github.io/<game>/privacy/` into Play Console > App content >
   Privacy policy, and set Store listing > Contact details > Website to `https://hichgahgame.github.io/`.

Before releasing a game version that changes how it handles data, update its policy here **first**,
together with that game's Play Console Data safety answers.
