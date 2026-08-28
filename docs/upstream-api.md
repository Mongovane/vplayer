# Upstream API contract

Everything here is consumed **only** by `functions/api/[[path]].js`. The browser never
calls these directly — it talks to our own `/api/*`, and the Function translates.

Base: `https://api.chksz.com/api`
Auth: `?apikey=` appended server-side from the `MUSIC_API_KEY` secret. Optional; the
upstream also allows an Origin allowlist, but that breaks when the deploy hostname
changes, so setting the key is recommended.

## Status of each endpoint

| Upstream | Methods | Our route | Wired |
|---|---|---|---|
| `/api/163_music` | GET / POST | `/api/song` (netease branch) | yes |
| `/api/163_search` | GET / POST | `/api/search?source=163` | yes |
| `/api/163_lyric` | GET / POST | `/api/lyric` | yes |
| `/api/163_playlist` | GET / POST | `/api/playlist` | yes |
| `/api/qq_music` | GET | `/api/search?source=qq`, `/api/song` (qq branch) | yes |
| `/api/kugou_music` | GET | `/api/search?source=kg`, `/api/song` (kg branch) | yes |

---

## `/api/163_music` — 音乐解析

Audio URL plus song detail. Tops out at 超清母带.

| Param | Notes |
|---|---|
| `id` | NetEase song id (bare digits) |
| `level` | `standard` `higher` `exhigh` `lossless` `hires` `jyeffect` `sky` `jymaster` |

Response `{ code: 200, data: {…} | [{…}] }` — the Function unwraps either shape. Fields
used: `id url name artist picUrl level br|bitrate`.

Two behaviours to keep in mind:

- The upstream may **downgrade silently** (`hires` → `lossless`) when a song has no source
  at the requested level. `data.level` is the level actually served, which is why the
  readout reads from the response rather than from the request.
- URLs come back `http:` and are upgraded to `https:` before they reach the client.

The endpoint also supports 纯文本 and 直接跳转 return modes. We only use JSON; the
redirect mode would bypass our relay and leak the upstream host to the browser.

## `/api/163_search` — 搜索歌曲

| Param | Notes |
|---|---|
| `keyword` | query |
| `limit` | we send 30 |

Response shape is inconsistent across versions — songs have appeared at `data`,
`data.songs`, and `result.songs`. The Function probes all three.

**Not yet wired:** the endpoint supports pagination. `/api/search` currently returns a
single page of 30. Adding it means threading an `offset` through `search()` in
`functions/api/[[path]].js`, `api.search()` in `public/src/api.js`, and an
infinite-scroll hook on the search `TrackList`.

## `/api/163_lyric` — 歌词获取

| Param | Notes |
|---|---|
| `id` | NetEase song id |

Returns `data.lrc` (original), `data.tlyric` (translation), and a romanisation track whose
field name has varied — the Function accepts `data.romalrc` or `data.rlyric`.

All three are merged into one timeline in `parseLyrics()`, matched **by timestamp within
40 ms**, not by line index. Index matching drifts once the tracks disagree on blank lines
and never recovers.

## `/api/163_playlist` — 歌单详情

| Param | Notes |
|---|---|
| `id` | playlist id |

Track array has appeared at `data.tracks`, `playlist.tracks`, `tracks`, and bare `data`.
Per-track artist fields vary between `artists`, `artist`, and `ar`. The Function
normalises all of them. Cached at the edge for 5 minutes; the client additionally serves
it from IndexedDB first and refreshes in the background.

## `/api/qq_music` — QQ 音乐点歌

GET only. Two modes:

| Mode | Params |
|---|---|
| search | `msg`, `num` |
| resolve | `mid` (song mid) |

Resolve returns `url name artists album cover lyric.text`. **Lyrics arrive with the
resolve call**, so `/api/song` forwards them and the client skips a second round trip.

Quality is not requestable. It is read back from the filename prefix in the URL:
`F000` FLAC · `M800` 320K · `C600` 192K · `C400`/`C200` 128K M4A. Reading the prefix is
deliberate — the generic bitrate inference used for NetEase gets misled by random
characters in the QQ vkey.

## `/api/kugou_music` — 酷狗音乐点歌

GET only. Two modes:

| Mode | Params |
|---|---|
| search | `msg` |
| resolve | `id` (song hash) |

Resolve returns `{ code: 200, data: { url songName singerName albumImage bitRate extName lyrics } }`.
Lyrics ride along here too.

**The audio CDN is http-only with an invalid certificate.** It must be relayed or the
browser blocks it as mixed content. We relay through our own `/api/stream`, which is
Range-aware and streams the body through without buffering — so seeking inside a large
FLAC still works. (The original build used the upstream's `/kg_stream` for this; owning
the relay removes a dependency and lets us control caching.)

---

## Song id scheme

Wire-compatible with the original build, so existing cloud playlists and shared links keep
working:

| Form | Source |
|---|---|
| bare digits, e.g. `1901371647` | NetEase |
| `qq:<mid>` | QQ |
| `kg:<hash>` | KuGou |

`sourceOf(id)` derives the source; the Function and the client each have a copy, because
the client needs it for badge rendering without a round trip.

## Diagnosing a broken deploy

`GET /api/health` answers without needing the UI:

```json
{ "ok": true, "function": "reachable", "keyConfigured": true,
  "origin": "https://…", "upstream": "ok", "upstreamError": null }
```

| Symptom | Meaning |
|---|---|
| HTML instead of JSON | the Function was never invoked — see the routing gotcha below |
| `keyConfigured: false` | `MUSIC_API_KEY` is unset for this environment, or the deploy predates it |
| `upstream: "failed"` + 401/403 | key rejected, or no key and this `origin` is not on the upstream allowlist |

Environment variables do **not** apply to existing deployments. After adding one,
retry the latest deployment or push again.

## Routing gotcha

`public/_routes.json` decides which requests invoke a Function. **`exclude` takes
precedence over `include`**, so an entry of `/*` in `exclude` disables Functions
entirely — including paths listed in `include`. Leave `exclude` empty and let
`include` do the narrowing:

```json
{ "version": 1, "include": ["/api/*"], "exclude": [] }
```

Symptom when this is wrong: `/api/anything` returns HTTP 200 with the SPA's HTML,
and the client reports a JSON parse failure rather than a 404.

## Adding an endpoint

1. Add a branch in `onRequest` in `functions/api/[[path]].js`, returning `json({ ok: true, … })`.
2. Normalise the upstream shape **in the Function**, not the client — upstream field drift
   should never reach `public/src`.
3. Add a thin caller in `public/src/api.js` via `call(path, params)`.
4. If the response is cacheable, decide between edge cache (`cache-control` on the
   response) and IndexedDB (`cacheGet`/`cachePut`). Playlists use both; lyrics use
   IndexedDB only; song URLs use neither, because they expire.
