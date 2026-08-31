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
| Full Font Awesome: 100 KB CSS + 924 KB webfonts | ~1 MB for a few dozen glyphs | 15 Phosphor glyphs + 1 bespoke, vendored inline, ~3 KB |
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

## Storage: two tiers, for two different problems

They are often conflated. They solve different things and neither substitutes
for the other.

**R2 + D1 — the library.** Not offline: a copy on Cloudflare is unreachable when
the phone has no signal. What it fixes is *stability*. Upstream urls expire and
their CDNs answer 503, which is the failure that has cost the most debugging
here. A track in the library plays from a url that does neither, for every
device.

The split is not arbitrary. D1 cannot hold the audio: a query response is capped
and cannot be range-read, so a 40 MB FLAC stored as a row could not be seeked
through. R2 serves byte ranges natively and its egress is free. What D1 is good
at is what eviction needs — ordering by last use and summing sizes.

```bash
wrangler r2 bucket create vplayer-audio
npm run db:init                     # applies schema.sql
```

The S3 API endpoint the dashboard shows is for external S3-compatible clients.
The binding reaches the bucket inside the account, so no endpoint, access key or
region belongs in `wrangler.toml`.

Without both bindings `/api/library` answers 501 and the client hides its
controls, so this is entirely optional.

**Keep the bucket private unless you have a reason not to.** Setting
`R2_PUBLIC_BASE` to an `r2.dev` url makes the browser fetch from R2 directly —
one less hop and no Worker CPU per byte — but public access means anyone holding
an object url can fetch that file. Object keys carry a random suffix so the
library cannot be enumerated by guessing song ids, which it otherwise trivially
could be, but a url that leaks stays valid until the object is deleted. Left
unset, every byte goes through `/api/library/audio/:id` with range support and
the bucket stays closed.

**IndexedDB — offline.** The only tier that works with no signal. The W bearing
is the library: everything held on this device, browsable and playable without
searching for it again. Launching with nothing to resume opens there rather than
on an empty queue.

Local files can be imported from the same view — anything DRM-free. `.kgm`,
`.kgma`, `.ncm`, `.qmc*` and friends are encrypted containers and will not
decode; export them to MP3 or FLAC from the app that downloaded them first.
Titles come from ID3 or FLAC tags where present, from the filename otherwise,
and only the first 256 KB is read to find them.

What a PWA can and cannot do here, compared to a native music app:

| | Native app | This |
|---|---|---|
| Where | app sandbox, usually DRM-wrapped | IndexedDB, plain blobs |
| Size | free disk | a browser-managed quota. `navigator.storage.estimate()` is shown in settings; Chrome and Android are generous, Safari much less so |
| Survives force-quit | yes | **yes** — force-quitting never clears it |
| Survives reboot | yes | yes |
| Can be reclaimed | no | yes, unless persistence is granted |
| Background download | yes | no; the app must stay open |
| Bounded size | user picks per-playlist | a ceiling in settings, LRU-evicted |

The device store has a ceiling, set in settings (512M / 2G / 8G / unlimited,
default 2G). Past it the least recently played tracks are dropped to make room,
so it settles where you put it rather than growing until the browser starts
refusing writes — which surfaces as a download failing with nothing said.

Downloads fold into disk-backed Blobs every 4 MB rather than accumulating the
whole file in the JS heap. Holding a 100 MB master in the heap is enough to get a
tab killed on a phone, and it happens per download regardless of how little is
stored.

Force-quitting the app does not clear anything. What does: clearing browser
website data, deleting the installed PWA, storage pressure while unpersisted,
and — for a plain Safari tab rather than an installed PWA — Safari's clearing of
data from sites not visited in seven days. Installing to the home screen and
granting persistence removes both of the last two, which is why persistence is
requested after the first download and its state is shown in settings. Blobs are
played through `URL.createObjectURL`, not Cache Storage: a blob url gets native
byte-range handling for free, whereas a cached Response has to be sliced by hand
in the service worker — reading the whole file into memory on every seek —
because Cache Storage matching ignores Range.

Downloading uses both, each for what it is good at: the server copies the track
into R2 first so its url stops expiring, then the device pulls that stable copy
down. Removing clears both. `navigator.storage.persist()` is requested after the
first successful download, so the browser stops treating the files as
discardable.

Playback order is device, then library, then upstream, then the LX fallback.

Two things worth knowing about download speed:

- The device pulls once, directly, and the library copy is fetched by the server
  on its own time. Awaiting the ingest first meant the same file moved twice in
  series with no progress shown during the first leg.
- `fetch()` needs CORS to read a body where an `<audio>` element does not, so a
  url that plays fine can be undownloadable depending on the CDN. A failed
  direct attempt retries through `/api/stream`, which is same-origin.

Downloads have their own quality tier, defaulting to 轻风 (128k, roughly 4 MB a
track). Keeping a whole library at master quality is not what downloading is
for — having it available offline is. Raise the tier for the few tracks that
deserve it. Each option shows what four minutes actually costs, since storage is
the entire point of the setting.

A downloaded copy always wins at playback, whatever the playback tier is set to.
The badge says which file you are hearing, so a 128k copy under a 飓风 setting is
visible rather than silent. To hear a stored track at a higher tier, delete it
and download it again at that tier.

Progress shows on the track's own row — a bar along its bottom edge, with the
percentage replacing the index. A toast at the bottom of the screen was both far
from the song it described and gone before the download finished.

Downloads run one at a time. In parallel they split the same connection, so
everything crawled and nothing completed — worse on every measure except the
appearance of activity.

**One thing to be clear about:** the library makes durable copies of audio on
storage you own, which is a different act from relaying a stream. The storage
bill and whatever else follows from that are yours.

## Lyrics

The current line and the next sit under the artist name, always visible, because
most of the time you want to know where you are rather than read the whole song.
Tapping opens the full column — one tap, from anywhere, instead of dragging the
sheet up and switching tabs. This is roughly what NetEase and QQ do by putting
lyrics on the now-playing surface itself rather than behind navigation.

Inside the full column, lines carry their cue time, tapping one seeks to it, and
scrolling releases auto-follow for four seconds so you can read ahead.

## Interaction decisions worth knowing

Several of these exist because the obvious behaviour was wrong:

- **The dial has a dead centre.** Presses within r=96 do not seek. The bearing of
  a point near the centre is numerically meaningless, and the centre is where the
  artwork is — so on a phone the natural "look at the cover" tap was jumping the
  playhead somewhere arbitrary. A drag that begins outside may travel inward.
- **Space and Enter are ignored when a button has focus.** The button already
  responds to them, so the shortcut fired playback twice after any mouse click on
  the transport.
- **Escape closes one layer.** Dismissing a dialog and collapsing the sheet on
  the same press meant losing two things when you meant to lose one.
- **You cannot delete the offline copy of the track you are hearing.** Deleting
  the blob revokes the object url the element is playing from. It refuses rather
  than breaking the audio quietly.
- **Leaving with a download in flight prompts.** Downloads have no resume.
- **Tapping the tab you are on collapses the sheet**, the way a tab bar responds
  to a second tap. It is the closest control to the thumb.

## On a phone

Installable: the manifest carries maskable icons and two shortcuts (search,
queue) that open straight into a view via `?view=`. The install button appears in
settings only where `beforeinstallprompt` fires — iOS has no such API, and an
inert button would be worse than none.

Layout notes, all of which were bugs before they were features:

- Safe-area insets are honoured on all four edges, not just the bottom, because
  a landscape notch eats into the sides.
- The collapsed sheet's peek height is a CSS variable the drag handler reads,
  so the gesture and the transform agree even once a home indicator is added to
  the number.
- Raised, the sheet covers the transport, so it carries a mini play/next bar.
- Landscape phones are wide and very short; the dial shrinks and the deck goes
  two-column so the transport stays reachable.
- Every control clears 44px.

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

Icons are [Phosphor](https://phosphoricons.com) (MIT), `fill` weight — solid,
rounded shapes rather than hairline strokes. Vendored into the sprite in
`index.html` rather than loaded from a CDN so the CSP can keep
`default-src 'self'`. The vane's mark is bespoke: supplied as artwork, traced to
bezier curves with potrace, rotated upright and normalised onto the same 24-unit
grid as the rest of the sprite.

## Licence

MIT, as the original. Copyright ChKSz; this refactor preserves that notice.

The player ships no audio and claims no rights to any third-party music, lyrics, or
artwork.
