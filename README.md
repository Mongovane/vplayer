# VPlayer

A weather-vane instrument panel for music. **Angle carries time.**

A refactor of [ChKSz/VPlayer](https://github.com/ChKSz/VPlayer) (`cloud-sync` branch) — same
music sources, same cloud-sync protocol, rebuilt as a modular app that deploys to
Cloudflare Pages with the API key server-side.

```
42 MB, 1 HTML file, 6572 lines   →   108 KB, 7 modules, ~2400 lines
```

---

## Why the rewrite

The original worked, and parts of its data layer were genuinely well designed — the
prefix-based multi-source dispatch (`qq:`, `kg:`, bare digits) and the cloud-sync state
machine (`local`/`dirty`/`cloud`/`public` with `version`/`baseVersion` optimistic
concurrency) are both kept intact here. The problems were structural:

| Problem in the original | What it cost | Fix |
|---|---|---|
| `index.html` at 312 KB / 6572 lines — styles, markup, and all logic in one file | `CLAUDE.md` instructed contributors to *grep for `function name`* to navigate | Seven ES modules with one job each |
| `fonts/` at 41 MB — four 11 MB full-coverage Noto Sans SC TTFs | Repo unclonable on slow links; nothing on the critical path needed them | Zero webfonts. System stack + monospace numerals |
| `js/tailwindcss.js`, 400 KB of runtime JIT | Render-blocking CSS compilation in the browser on every load | Hand-written CSS with a real token layer |
| Full Font Awesome: 100 KB CSS + 924 KB webfonts | ~1 MB for a few dozen glyphs | 15 Lucide glyphs vendored inline, ~2 KB |
| Separate desktop and mobile DOM trees | Two virtual scrollers (`vsCreateItem` / `mCreateItem`), two search views, two cloud views, every change made twice | One responsive DOM, one `TrackList` |
| ColorThief writing the cover's dominant colour into `--primary-color` | Every surface changed hue per track; no visual constant to recognise | Only `--wind` is tinted, clamped in oklch. Brass never moves |
| API key in `localStorage`, upstream called direct from the page | Key readable in devtools; upstream needed an Origin allowlist to compensate | Pages Function holds the key; the browser only talks to its own origin |
| Service worker precaching `index.html` under a manual `CACHE_NAME` | Docs told contributors to bump a constant by hand and tick "Update on reload" | Network-first navigation. The trap is gone, not documented |
| ~20 mutable module-level globals as the state layer | Adding a view meant knowing which globals to poke | Subscribe-by-key store |

## The Vane design language

The brief asked for `vane` as the identity. It's used as structure, not decoration:

- **Bearing is the playhead.** A full revolution is the track. There is no progress bar
  anywhere in the stylesheet. Drag the pointer, or arrow-key it, to seek.
- **The turbine holds the cover** and freezes mid-rotation on pause — a stopped vane keeps
  its bearing instead of snapping back to north.
- **Wind barbs are the spectrum**, drawn as meteorological barbs around the bezel, fed by
  a lazily-constructed `AnalyserNode`.
- **Quality is wind force.** The eight-level ladder maps onto Beaufort 2–12: `standard` is
  light breeze, `jymaster` is hurricane.
- **Bearings are navigation.** N lyrics · E queue · S search · W cloud.
- **Volume rides the dial** — scroll over it, or `+`/`-`. No slider competes with the pointer.
- **Brass is constant.** `--brass` is the brand and never responds to artwork. `--wind` is the
  single cover-reactive channel, clamped to `oklch(clamp(0.62,l,0.78) clamp(0.07,c,0.15) h)`
  so a dark or muddy sleeve can't wash out the panel.

Palette: `--ink #0A0D10` · `--slate #1A2128` · `--brass #C8A24A` · `--wind #6FC5D6` ·
`--paper #ECEFF1` · `--gust #8FA3B0`. Motion uses one curve, `--ease-gust`, plus
`--ease-settle` for the pointer's overshoot on track change.

Upstream endpoint contract, response quirks, and how to add a new one:
[`docs/upstream-api.md`](docs/upstream-api.md).

## Architecture

```
functions/api/[[path]].js   Pages Function — the only thing that knows the upstream
public/
  index.html                semantic shell + icon sprite
  styles/vane.css           tokens, layout, dial, rows
  src/
    store.js                state; subscribe by key
    api.js                  same-origin client, IndexedDB cache, LRC parsing
    engine.js               audio path, Media Session, wake lock, analyser, tinting
    dial.js                 the VaneDial
    list.js                 one virtual scroller (queue + results)
    lyrics.js               timed lyric column
    main.js                 assembly — the only file that knows both DOM and store
  sw.js  manifest.webmanifest  _headers  _routes.json
docs/upstream-api.md        the upstream contract, kept next to the code that uses it
```

Two behaviours worth naming, both carried forward because the original had them right:

**Audio first.** `playIndex` resolves the playable URL and hands it to the element before
touching lyrics or artwork, so nothing blocks sound.

**Monotonic request tokens.** Skipping fast used to let a slow response for track 3
overwrite the state of track 5. Every async step re-checks that it is still the newest
request before it writes.

And one that's new: scrolling the lyrics yourself releases auto-follow for four seconds.
The original re-centred on every `timeupdate`, so reading ahead was impossible.

### API surface

The browser makes same-origin calls only. `functions/api/[[path]].js` fans them out:

| Route | Purpose |
|---|---|
| `/api/search?q=&source=163\|qq\|kg` | unified search across the three sources |
| `/api/song?id=&level=` | playable URL + metadata; QQ/KuGou lyrics ride along |
| `/api/lyric?id=` | LRC + translation |
| `/api/playlist?id=` | NetEase playlist, edge-cached 5 min |
| `/api/stream?url=` | Range-aware audio relay (KuGou's CDN is http-only) |
| `/api/image?url=` | cover relay; gives CORS so colour lifting works |
| `/api/sync/*` | passthrough to the sync service, protocol unchanged |

The stream relay passes the upstream body straight through rather than buffering, so
seeking inside a 200 MB FLAC still works.

## Deploy

```bash
npm install
wrangler pages project create vplayer          # once
wrangler pages secret put MUSIC_API_KEY --project-name=vplayer
npm run deploy
```

Local development:

```bash
cp .dev.vars.example .dev.vars   # add your key
npm run dev                      # wrangler pages dev, Functions included
```

`wrangler.toml` sets `pages_build_output_dir = "public"`, so a Git-connected project needs
no build command — leave it blank and set the output directory to `public`.

`_routes.json` restricts the Function to `/api/*`; everything else is served as a static
asset and never invokes a worker. `_headers` ships a CSP that has no `unsafe-eval` and no
third-party origins in `connect-src`, which is only possible because the upstream now sits
behind the Function.

`MUSIC_API_KEY` is optional — without it the Function still forwards requests, and the
upstream's Origin allowlist applies as before. Set it to stop depending on that.

## Keyboard

| Key | Action |
|---|---|
| `Space` | play / pause |
| `j` · `k` | next · previous |
| `m` | cycle sequence → random → single |
| `/` | jump to search |
| `1`–`4` | lyrics · queue · search · cloud |
| `+` · `-` | volume |
| `←` `→` (dial focused) | seek 5 s; `Shift` for 30 s |
| `Esc` | close overlays |

## Compatibility notes

- `color-mix()` and relative `oklch(from …)` are used for the tint clamp. Both are
  Baseline 2023–24; a browser without them falls back to the literal `--wind` default,
  which is the intended colour anyway.
- `prefers-reduced-motion` stops the turbine and all transitions.
- The dial is a real `role="slider"` with `aria-valuetext` announcing percentage and
  bearing, and is fully keyboard-operable.
- Playlists render cache-first from IndexedDB, then refresh in the background.

## Carried over unchanged

Cloud-sync wire protocol (six-character short ids, `version`/`baseVersion` optimistic
concurrency, the four sync states), song-id prefix scheme, quality level names, and the
`playlist.js` / JSON import formats — including legacy files that assign
`window.LOCAL_PLAYLIST`. Existing accounts and shared links keep working.

## Third-party

Icons are [Lucide](https://lucide.dev) v1.34 (ISC), vendored into the sprite in
`index.html` rather than loaded from a CDN so the CSP can keep
`default-src 'self'`.

## Licence

MIT, as the original. Copyright ChKSz; this refactor preserves that notice.

The player ships no audio and claims no rights to any third-party music, lyrics, or
artwork.
