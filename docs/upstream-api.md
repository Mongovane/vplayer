# Upstream API contract

Transcribed from the published docs at `https://api.chksz.com/docs/<endpoint>.html`,
endpoint by endpoint. Consumed **only** by `functions/api/[[path]].js`; the browser
talks to our own `/api/*` and never to the upstream.

Base: `https://api.chksz.com/api` · Auth: `?apikey=` appended server-side from the
`MUSIC_API_KEY` secret. **Required on every endpoint** — 401 without it.

## Endpoint map

| Upstream | Methods | Our route |
|---|---|---|
| `/api/163_music` | GET / POST | `/api/song` (NetEase branch) |
| `/api/163_search` | GET / POST | `/api/search?source=163` |
| `/api/163_lyric` | GET / POST | `/api/lyric` |
| `/api/163_playlist` | GET / POST | `/api/playlist` |
| `/api/qq_music` | GET | `/api/search?source=qq`, `/api/song` (QQ branch) |
| `/api/kugou_music` | GET | `/api/search?source=kg`, `/api/song` (KuGou branch) |

---

## `/api/163_music`

`id` (required) · `level` (default `jymaster`) · `type` (`json`/`text`/`down`) · `apikey`

Levels: `standard` `exhigh` `lossless` `hires` `jymaster` `sky` `jyeffect`.
**There is no `higher` level** — an earlier version of this client offered one.

```json
{ "code": 200, "data": { "id": 1315196858, "url": "…", "br": 999000,
  "level": "lossless", "size": 34567890, "md5": "…",
  "name": "海底", "artist": "一支榴莲", "album": "独", "picUrl": "…" } }
```

`data.level` is the tier actually served and may be below what was requested —
NetEase downgrades silently. The badge reads from the response, not the request.

Don't use `type=down`: it redirects the browser straight to the upstream CDN,
bypassing our relay and re-exposing the upstream host that the CSP was tightened
to hide.

## `/api/163_search`

`keyword` (required) · `limit` (default 100) · `offset` (default 0) · `apikey`

```json
{ "code": 200, "data": [ { "id": 1315196858, "name": "海底",
  "artists": "一支榴莲", "album": "独", "picUrl": "…" } ] }
```

`artists` is a **pre-joined string**, not the array the raw NetEase API returns.
Pagination via `offset` is available and not yet wired into the client.

## `/api/163_lyric`

`id` (required) · `apikey`

```json
{ "code": 200, "data": { "lrc": "…", "tlyric": "…", "romalrc": "…", "klyric": "" } }
```

Three timed tracks. They are merged in `parseLyrics()` **by timestamp within 40 ms**,
never by line index — the tracks disagree on blank lines, and index matching drifts
a verse and never recovers. `klyric` (karaoke word timing) is not used.

## `/api/163_playlist`

`id` (required) · `apikey`

```json
{ "data": { "id": 5202687076, "name": "…", "coverImgUrl": "…", "trackCount": 100,
  "creator": { "nickname": "…" },
  "tracks": [ { "id": 123456, "name": "…", "ar": [{ "name": "歌手" }],
                "al": { "name": "专辑", "picUrl": "…" } } ] } }
```

Tracks use raw NetEase shorthand: `ar` for artists, `al` for album. Note this differs
from `163_search`, which pre-joins into `artists`/`album`.

## `/api/qq_music`

GET only. `msg` or `mid` (one required) · `n` (result index 1–50) · `num`/`g` (count
1–50) · `size` · `type` · `apikey`. Passing `mid` ignores `msg`, `n`, `num`.

Search:
```json
{ "code": 200, "count": 5, "list": [ { "n": 1, "name": "…", "singer": "…",
  "album": "…", "pay": "[收费]", "mid": "0039MnYb0qxYhV" } ] }
```

Detail (flat — **not** nested under `data`):
```json
{ "code": 200, "name": "…", "singer": "…", "album": "…", "url": "…",
  "cover": "…", "lrc": "[00:00.00]歌词", "interval": "3:28",
  "mid": "…", "bitrate": "flac", "format": "flac" }
```

Search carries **no artwork**; covers only arrive on resolve. Lyrics ride along with
resolve, so `/api/song` forwards them and the client skips a second round trip.

## `/api/kugou_music`

GET only. `msg` or `id` (one required) · `n` (1–50) · `size` · `type` · `apikey`.
Passing `id` takes priority over `msg`.

Search:
```json
{ "code": 200, "keyword": "晴天", "total": 20,
  "list": [ { "n": 1, "id": "48C685F6…", "name": "晴天",
              "singer": "歌手", "album": "专辑", "duration": 176 } ] }
```

Detail (flat, same shape as QQ but keyed by `id`):
```json
{ "code": 200, "name": "…", "singer": "…", "album": "…", "url": "…/song.flac",
  "cover": "", "lrc": "", "interval": "2:56", "bitrate": "flac",
  "format": "flac", "id": "48C685F6…" }
```

Errors: `400` neither `msg` nor `id` · `401` bad key · `405` non-GET ·
`403`/`429` rate limited · `502`/`504` upstream timeout.

---

## Quality: two ladders

NetEase takes `level`; QQ and KuGou take `size` from a shorter native ladder. The
client speaks NetEase's vocabulary and the Function maps outward.

| client `level` | qq/kg `size` |
|---|---|
| `standard` | `128k` |
| `exhigh` | `320k` |
| `lossless` | `flac` |
| `hires` | `hires` |
| `jyeffect` `sky` `jymaster` | `master` |

**QQ and KuGou do no alias or downgrade mapping server-side.** Requesting `master`
on a track that has none fails outright rather than returning something lower. Since
NetEase *does* degrade silently, leaving this unhandled would make the two native
sources fail constantly for anyone with a high quality setting. `resolveWithDowngrade`
walks `master → hires → flac → 320k → 128k` until one resolves, and the badge shows
`已降级` so the listener sees why they landed below their setting.

## What was wrong before

The QQ and KuGou mappings were inherited from the original CPlayer build and never
verified. Symptoms were every artist reading 未知艺术家, every cover broken, and
resolve returning `404 未找到匹配的歌曲`.

| | assumed | actual |
|---|---|---|
| qq/kg search item | `SongName` `SingerName` `AlbumName` `Image` | `name` `singer` `album` (no artwork) |
| qq search id | `item.id` | `item.mid` |
| qq/kg detail | nested under `data` | flat at top level |
| kg detail fields | `songName` `singerName` `albumImage` `bitRate` `extName` | `name` `singer` `cover` `bitrate` `format` |
| qq quality | parsed from `F000`/`M800` filename prefix | `size` request param, `format` in response |
| qq/kg quality support | "not requestable" | fully requestable |
| kg audio | always http, always relay | usually https; relay only when `http://` |

## The docs are a guide, not the wire

`163_search` is documented as returning `data: [...]`, and the live endpoint has
also been seen returning the songs under `data.songs` and `result.songs`. The
original build probed all three; a rewrite that trusted the documented shape alone
returned an empty list, which at the UI is indistinguishable from "no matches".

Normalisers here should therefore **prefer the documented shape and keep fallbacks**
for the ones previously observed. This applies to `163_search` and `163_playlist`;
the QQ and KuGou shapes have so far matched their docs exactly.

## Fallback resolver: lx-music-api-server

Configured with two Pages secrets. When either is missing the whole path is
inert and the client hides its switch.

| Secret | Example |
|---|---|
| `LX_API_URL` | `http://host:9866` |
| `LX_API_KEY` | the server's configured request key |

```
GET {LX_API_URL}/url/{source}/{songId}/{quality}
X-Request-Key: {LX_API_KEY}
-> { "code": 0, "data": "https://…/song.flac" }
```

Source codes `wy` NetEase · `tx` QQ · `kg` KuGou (`kw` Kuwo and `mg` Migu exist
upstream but this player has no catalogue for them). Qualities `128k` `320k`
`flac` `flac24bit`.

Result codes: `0` ok · `1` IP blocked · `2` no url for this track · `4` remote
server error · `5` rate limited · `6` bad parameters.

**It returns a url and nothing else** — no search, no metadata, no lyrics. So it
can only ever be a second opinion on playback. `/api/song` tries the primary
first and falls back on failure; `?via=lx` skips the primary. Either way the
response carries nulls for metadata and the client keeps whatever the search
result already knew.

Note this repo's LX-source scripts are LX Music *client* sources, not an HTTP
API — they run in the player's sandbox and call a server like the above. The
contract here was read from `nya.js`, the unobfuscated reference script.

## QQ resolve omits documented fields

Verified live: `/qq_music?mid=…` returns `url`, `cover`, `interval` and `format`
but **not** `name`, `singer` or `lrc`, despite all three appearing in its
documented response. A track resolved this way played correctly at FLAC with
artwork and a 4:58 duration while showing 未知歌曲 / 未知艺术家 and no lyrics.

So `/api/song` returns `null` for absent metadata rather than a placeholder, and
the client merges field by field, keeping whatever the search result already
knew. Never spread a resolve response wholesale over a track — its gaps will
erase good data.

Lyrics have no such fallback: if QQ omits `lrc`, there are none. Borrowing them
by title-matching against NetEase would be a feature, not a fix.

## Upstream failure modes

These are the upstream's own states, not client bugs, and they come and go:

| Response | Meaning | Handling |
|---|---|---|
| `code 404` / `未找到匹配的歌曲` on search | genuinely no match, **or** the upstream's own backend failed to return a list | treated as an empty result, not an error |
| `code 503` / `上游连续失败，链路正在熔断恢复` | upstream circuit breaker open; that source is down for a while | surfaced as "上游正在恢复", suggest another source |
| `code 404` on resolve | the id no longer resolves | genuine failure, reported |

Observed: `source=qq&q=龙卷风` returned 404 while `source=qq&q=jay` returned 30 rows
correctly mapped, minutes apart. Per-keyword 404s on search are therefore not
evidence of a mapping bug — check a second keyword before changing any code.

## Diagnosing a broken deploy

`GET /api/health` answers without needing the UI:

```json
{ "ok": true, "function": "reachable", "keyConfigured": true,
  "origin": "https://…", "upstream": "ok", "upstreamError": null }
```

| Symptom | Meaning |
|---|---|
| HTML instead of JSON | the Function was never invoked — see routing below |
| `keyConfigured: false` | `MUSIC_API_KEY` unset for this environment, or the deploy predates it |
| `upstream: "failed"` + 401 | key rejected or absent |

Environment variables do **not** apply to existing deployments. After adding one,
retry the latest deployment or push again.

## Service worker staleness

`sw.js` serves css and js **network-first**, deliberately. An earlier version used
stale-while-revalidate for them, which leaves the running app exactly one deploy
behind: the page paints the cached copy and only fetches the new one for next
time. During active development that makes every change look like it did not
ship, and it wasted two debugging rounds — a `transform-box` fix was verified
present in the deployed stylesheet while `getComputedStyle` in the page still
reported the old value.

`_headers` sets `Cache-Control: no-cache` on `/styles/*` and `/src/*` for the same
reason: those filenames carry no content hash, so any `max-age` hides a deploy
until it expires.

If the page still looks stale after a deploy, the old service worker is still in
control for one load. Hard reload, or unregister it under
DevTools → Application → Service Workers.

## Routing gotcha

`public/_routes.json` decides which requests invoke a Function. **`exclude` takes
precedence over `include`**, so `/*` in `exclude` disables Functions entirely —
including paths listed in `include`. Leave `exclude` empty:

```json
{ "version": 1, "include": ["/api/*"], "exclude": [] }
```

## Song id scheme

Wire-compatible with the original build, so existing cloud playlists and shared links
keep working: bare digits = NetEase, `qq:<mid>`, `kg:<id>`.

## Adding an endpoint

1. Add a branch in `onRequest`, returning `json({ ok: true, … })`.
2. Normalise the upstream shape **in the Function**. Field drift must never reach
   `public/src` — that is exactly how the QQ/KuGou breakage went unnoticed.
3. Add a thin caller in `public/src/api.js` via `call(path, params)`.
4. Choose caching deliberately: playlists use edge + IndexedDB, lyrics use IndexedDB
   only, song URLs use neither because they expire.
