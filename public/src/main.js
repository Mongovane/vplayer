/**
 * main.js — assembly.
 *
 * Every module above is independent; this file is the only place that knows
 * both the DOM and the store, and it is deliberately the only place that does.
 */

import * as store from './store.js';
import * as api from './api.js';
import * as engine from './engine.js';
import * as dial from './dial.js';
import * as lyrics from './lyrics.js';
import * as offline from './offline.js';
import { TrackList } from './list.js';

const $ = (id) => document.getElementById(id);

const el = {
  station: $('station'),
  stationRead: $('stationRead'),
  title: $('trackTitle'),
  artist: $('trackArtist'),
  fault: $('trackFault'),
  qualityChip: $('qualityChip'),
  qualityText: $('qualityText'),
  beaufort: $('beaufort'),
  sourceChip: $('sourceChip'),
  resolverChip: $('resolverChip'),
  idChip: $('idChip'),
  idText: $('idText'),
  copyIdBtn: $('copyIdBtn'),
  playBtn: $('playBtn'),
  playIcon: $('playIcon'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  modeBtn: $('modeBtn'),
  modeIcon: $('modeIcon'),
  panelBtn: $('panelBtn'),
  panel: $('panel'),
  panelHandle: $('panelHandle'),
  miniTitle: $('miniTitle'),
  miniPlay: $('miniPlay'),
  miniPlayIcon: $('miniPlayIcon'),
  miniNext: $('miniNext'),
  queueCount: $('queueCount'),
  toast: $('toast'),
  settingsScrim: $('settingsScrim'),
  settingsBtn: $('settingsBtn'),
  settingsClose: $('settingsClose'),
  qualityOptions: $('qualityOptions'),
  fileInput: $('fileInput'),
  playlistInput: $('playlistInput'),
  loadPlaylistBtn: $('loadPlaylistBtn'),
  shuffleBtn: $('shuffleBtn'),
  searchInput: $('searchInput'),
  searchNote: $('searchNote'),
  lyricTicker: $('lyricTicker'),
  tickerNow: $('tickerNow'),
  tickerNext: $('tickerNext'),
  storageRow: $('storageRow'),
  offlineUsage: $('offlineUsage'),
  offlinePersistBtn: $('offlinePersistBtn'),
  offlineClearBtn: $('offlineClearBtn'),
  libraryRow: $('libraryRow'),
  libraryUsage: $('libraryUsage'),
  libraryPruneBtn: $('libraryPruneBtn'),
  searchBtn: $('searchBtn'),
  sourcePick: $('sourcePick'),
  cloudBtn: $('cloudBtn'),
  syncLamp: $('syncLamp'),
  cloudScroller: $('cloudScroller'),
  cloudEmpty: $('cloudEmpty'),
  cloudSaveBtn: $('cloudSaveBtn'),
  cloudRefreshBtn: $('cloudRefreshBtn'),
  cloudAuthBtn: $('cloudAuthBtn'),
  authScrim: $('authScrim'),
  authClose: $('authClose'),
  authUser: $('authUser'),
  authPass: $('authPass'),
  authInvite: $('authInvite'),
  authInviteWrap: $('authInviteWrap'),
  authSubmit: $('authSubmit'),
  authToggle: $('authToggle'),
};

/* ------------------------------- installation ------------------------------- */

/**
 * Chromium fires beforeinstallprompt and lets us defer it; iOS fires nothing and
 * has no API, so the button only appears where it can actually do something.
 * Offering an inert "install" button on iOS would be worse than offering none.
 */
let deferredInstall = null;

function initInstall() {
  const row = $('installRow');
  const btn = $('installBtn');
  if (!row || !btn) return;

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    row.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    row.hidden = true;
    toast('已添加到主屏幕');
  });

  btn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    deferredInstall = null;
    row.hidden = true;
    if (outcome === 'dismissed') toast('已取消');
  });
}

/* -------------------------------- cursor aura ------------------------------- */

/**
 * A light that trails the cursor. Two details matter: it is driven from a single
 * rAF rather than from the pointermove handler, so a fast mouse can't queue up
 * layout work; and it lerps toward the pointer instead of snapping, which is
 * what makes it read as a trailing light rather than a second cursor.
 */
function initCursorAura() {
  const aura = $('cursorAura');
  if (!aura || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let tx = 0;
  let ty = 0;
  let x = 0;
  let y = 0;
  let live = false;
  let frame = 0;

  const tick = () => {
    frame = requestAnimationFrame(tick);
    // Critically damped enough to trail without feeling laggy.
    x += (tx - x) * 0.22;
    y += (ty - y) * 0.22;
    aura.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  };

  window.addEventListener(
    'pointermove',
    (e) => {
      // Touch already has a finger on the glass; a glow under it is noise.
      if (e.pointerType === 'touch') return;
      tx = e.clientX;
      ty = e.clientY;
      if (!live) {
        live = true;
        x = tx;
        y = ty;
        aura.classList.add('is-on');
        frame = requestAnimationFrame(tick);
      }
      aura.classList.toggle('is-hot', Boolean(e.target.closest?.('#dial')));
    },
    { passive: true }
  );

  document.addEventListener('pointerleave', () => {
    aura.classList.remove('is-on');
    live = false;
    cancelAnimationFrame(frame);
  });

  window.addEventListener('blur', () => aura.classList.remove('is-on'));
}

/* ----------------------------------- toast ---------------------------------- */

let toastTimer = 0;
function toast(message, tone = 'info') {
  el.toast.textContent = message;
  el.toast.dataset.tone = tone;
  el.toast.classList.add('is-open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-open'), 3200);
}

/* ------------------------------- panel routing ------------------------------ */

const VIEWS = ['lyrics', 'queue', 'search', 'cloud'];
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

function showView(name) {
  if (!VIEWS.includes(name)) name = 'lyrics';
  for (const v of VIEWS) {
    $(`view${v[0].toUpperCase()}${v.slice(1)}`).hidden = v !== name;
    $(`tab${v[0].toUpperCase()}${v.slice(1)}`).setAttribute('aria-selected', String(v === name));
  }
  store.set({ view: name });
  if (name === 'queue') queueList.render(true);
  if (name === 'search') searchList.render(true);
}

function raisePanel(up) {
  if (!isNarrow()) return;
  el.panel.classList.toggle('is-up', up);
  el.panelBtn.setAttribute('aria-label', up ? 'Close queue' : 'Open queue');
}

/* ------------------------------- readout paint ------------------------------ */

function paintBeaufort(force) {
  const bars = el.beaufort.children;
  if (bars.length !== 6) {
    el.beaufort.textContent = '';
    for (let i = 0; i < 6; i++) {
      const bar = document.createElement('i');
      bar.style.height = `${5 + i * 1.8}px`;
      el.beaufort.append(bar);
    }
  }
  const lit = force == null ? 0 : Math.round((force / 12) * 6);
  [...el.beaufort.children].forEach((bar, i) => bar.classList.toggle('on', i < lit));
}

function paintTicker() {
  const s = store.get();
  const lines = s.lyrics;
  if (!lines.length) {
    el.lyricTicker.hidden = true;
    return;
  }
  el.lyricTicker.hidden = false;
  const i = s.lyricIndex;
  el.tickerNow.textContent = i >= 0 ? lines[i]?.words || '' : lines[0]?.words || '';
  el.tickerNext.textContent = lines[i + 1]?.trans || lines[i + 1]?.words || '';
}

function paintReadout() {
  const s = store.get();
  const t = s.track;

  el.title.textContent = t?.name || 'Nothing on the air';
  el.miniTitle.textContent = t ? `${t.name} · ${t.artist}` : 'Nothing on the air';
  el.artist.textContent = t?.artist || 'Load a playlist or search to begin';
  document.title = t ? `${t.name} · ${t.artist}` : 'VPlayer · Vane';

  const level = t?.level || api.resolveQuality(s.quality);
  el.qualityText.textContent = t ? s.levelLabel || api.labelOf(level) : 'bft —';
  paintBeaufort(t ? api.forceOf(level) : null);

  el.sourceChip.textContent = t ? api.SOURCE_NAME[api.sourceOf(t.id)] || t.source || '—' : '—';

  el.idChip.hidden = !t;
  if (t) el.idText.textContent = String(t.id);

  const usingFallback = s.resolver === 'lx';
  el.resolverChip.hidden = !s.fallbackAvailable;
  el.resolverChip.textContent = usingFallback ? '备用源' : '主源';
  el.resolverChip.setAttribute('aria-pressed', String(usingFallback));

  el.fault.hidden = !s.playbackError;
  el.fault.textContent = s.playbackError;

  el.stationRead.textContent = s.playlistName
    ? `${s.playlistName} · ${s.tracks.length} tracks`
    : s.tracks.length
      ? `${s.tracks.length} tracks`
      : 'no signal';

  el.queueCount.textContent = s.tracks.length ? String(s.tracks.length) : '';
  el.station.dataset.loading = String(s.loading);
}

function paintTransport() {
  const { playing, mode } = store.get();
  const icon = playing ? '#i-pause' : '#i-play';
  el.playIcon.querySelector('use').setAttribute('href', icon);
  el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  el.miniPlayIcon.querySelector('use').setAttribute('href', icon);
  el.miniPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');

  const modeIcon = { sequence: '#i-seq', random: '#i-shuffle', single: '#i-single' }[mode];
  el.modeIcon.querySelector('use').setAttribute('href', modeIcon);
  el.modeBtn.setAttribute('aria-pressed', String(mode !== 'sequence'));
  el.modeBtn.title = { sequence: '顺序播放', random: '随机播放', single: '单曲循环' }[mode];
}

/* --------------------------------- storage ---------------------------------- */

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

async function refreshOfflineIds() {
  const rows = await offline.list();
  store.set({ offlineIds: new Set(rows.map((r) => r.id)) });
  queueList.render(true);
  searchList.render(true);
  return rows;
}

async function paintStorage() {
  if (!offline.available()) return;
  el.storageRow.hidden = false;
  const u = await offline.usage();
  const room = u.quota ? ` · 本机可用约 ${mb(Math.max(0, u.quota - u.used))}` : '';
  el.offlineUsage.textContent = u.count ? `${u.count} 首 · ${mb(u.bytes)}${room}` : `还没有离线曲目${room}`;

  if (!store.get().libraryAvailable) return;
  el.libraryRow.hidden = false;
  try {
    const lib = await api.library();
    el.libraryUsage.textContent = `${lib.tracks.length} 首 · ${mb(lib.totalBytes)} / ${mb(lib.quotaBytes)}`;
  } catch {
    el.libraryUsage.textContent = '读取失败';
  }
}

/**
 * Two tiers, used for what each is actually good for. The server copies the
 * track into R2 first, so its url stops expiring for every device; the phone
 * then pulls that stable copy down for offline. Without a library configured it
 * downloads straight from whatever resolved.
 */
async function downloadTrack(item) {
  const id = String(item.id);
  if (!offline.available()) {
    toast('这个浏览器不支持离线存储', 'error');
    return;
  }

  toast(`准备 ${item.name}…`);
  try {
    if (store.get().libraryAvailable) {
      await api.libraryIngest(id, store.get().quality).catch((err) => {
        // A library failure is not fatal: fall through to a direct download.
        console.warn('[library] ingest failed, downloading direct', err);
      });
    }

    const song = await api.song(id, store.get().quality);
    let lastShown = 0;
    const record = await offline.save(song, {
      onProgress: (received, total) => {
        const now = performance.now();
        if (now - lastShown < 200) return;
        lastShown = now;
        toast(total ? `${item.name} · ${Math.round((received / total) * 100)}%` : `${item.name} · ${mb(received)}`);
      },
    });

    // Only worth asking once there is something to lose.
    offline.requestPersistence();
    await refreshOfflineIds();
    paintStorage();
    toast(`已离线 · ${record.name || item.name} · ${mb(record.bytes)}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/**
 * Symmetry with downloadTrack: that writes both tiers, so this clears both. The
 * server copy is shared across devices, so removing it here removes it
 * everywhere — which is what a single-listener library should do, and why the
 * button says 文件 rather than 本机.
 */
async function removeOffline(item) {
  await offline.remove(item.id);
  if (store.get().libraryAvailable) {
    await api.libraryRemove(item.id).catch((err) => console.warn('[library] delete failed', err));
  }
  await refreshOfflineIds();
  paintStorage();
  toast(`已删除 · ${item.name}`);
}

/* ---------------------------------- queue ----------------------------------- */

const queueList = new TrackList({
  scroller: $('queueScroller'),
  sizer: $('queueSizer'),
  items: () => store.get().tracks,
  currentIndex: () => store.get().index,
  onActivate: (_item, index) => {
    engine.playIndex(index).catch((err) => toast(err.message, 'error'));
    if (isNarrow()) raisePanel(false);
  },
  actions: (item) => {
    const cached = store.get().offlineIds.has(String(item.id));
    return [
      cached
        ? { icon: 'cached', label: '已离线，点击删除文件', run: removeOffline }
        : { icon: 'download', label: '下载到设备', run: downloadTrack },
      {
        icon: 'trash',
        label: '从队列移除',
        confirm: true,
        run: (_i, index) => removeAt(index),
      },
    ];
  },
});

function removeAt(index) {
  const s = store.get();
  const tracks = s.tracks.filter((_, i) => i !== index);
  let nextIdx = s.index;
  if (index < s.index) nextIdx -= 1;
  else if (index === s.index) nextIdx = Math.min(index, tracks.length - 1);
  store.set({ tracks, index: nextIdx });
  queueList.render(true);
}

function loadTracks(tracks, { name = '', id = null, autoplay = true } = {}) {
  store.set({ tracks, index: -1, playlistName: name, playlistId: id });
  queueList.render(true);
  showView('queue');
  if (autoplay && tracks.length) engine.playIndex(0).catch((err) => toast(err.message, 'error'));
}

/* --------------------------------- search ----------------------------------- */

const searchList = new TrackList({
  scroller: $('searchScroller'),
  sizer: $('searchSizer'),
  items: () => store.get().results,
  onActivate: (item) => {
    const s = store.get();
    // Tapping the same result again should return to it, not stack another
    // copy — the queue is a queue, not a click log.
    const existing = s.tracks.findIndex((t) => String(t.id) === String(item.id));
    if (existing >= 0) {
      engine.playIndex(existing).catch((err) => toast(err.message, 'error'));
      queueList.scrollTo(existing);
      if (isNarrow()) raisePanel(false);
      return;
    }

    const at = s.index >= 0 ? s.index + 1 : s.tracks.length;
    const tracks = [...s.tracks];
    tracks.splice(at, 0, item);
    store.set({ tracks });
    queueList.render(true);
    engine.playIndex(at).catch((err) => toast(err.message, 'error'));
    toast(`正在播放 ${item.name}`);
  },
  actions: () => [
    {
      icon: 'plus',
      label: '加到队列末尾',
      run: (item) => {
        const tracks = store.get().tracks;
        if (tracks.some((t) => String(t.id) === String(item.id))) {
          toast(`队列里已经有 ${item.name}`);
          return;
        }
        store.set({ tracks: [...tracks, item] });
        queueList.render(true);
        toast(`已加入队列 · ${item.name}`);
      },
    },
  ],
});

let searchAbort = null;

/**
 * Results keyed by source + query. Switching between NETEASE/QQ/KUGOU on the
 * same query costs at most one upstream call per source, and switching back is
 * free — the upstream is quota-metered, so re-billing for a tab click is not
 * acceptable. Bounded so a long session can't grow it without limit.
 */
const searchCache = new Map();
const CACHE_LIMIT = 40;
const CACHE_TTL = 5 * 60 * 1000;

const cacheKey = (source, query) => `${source}\u0000${query}`;

function readCache(source, query) {
  const hit = searchCache.get(cacheKey(source, query));
  if (!hit) return null;
  // Entries expire rather than offering a "force refresh" control: staying
  // fresh matters less than not re-billing a metered API for a tab click, and
  // a bounded staleness window gets both without adding a button.
  if (Date.now() - hit.at > CACHE_TTL) {
    searchCache.delete(cacheKey(source, query));
    return null;
  }
  return hit.items;
}

function writeCache(source, query, items) {
  if (searchCache.size >= CACHE_LIMIT) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(cacheKey(source, query), { items, at: Date.now() });
}

const SOURCE_LABEL = { 163: '网易云', qq: 'QQ 音乐', kg: '酷狗' };

/** Inline state for the results panel. Passing null clears it. */
function setSearchNote(title, detail) {
  if (!title) {
    el.searchNote.hidden = true;
    return;
  }
  el.searchNote.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = title;
  el.searchNote.append(strong);
  if (detail) el.searchNote.append(document.createTextNode(detail));
  el.searchNote.hidden = false;
}

async function runSearch() {
  const query = el.searchInput.value.trim();
  if (!query) return;

  const source = store.get().source;
  const cached = readCache(source, query);
  if (cached) {
    setSearchNote(null);
    store.set({ results: cached, searching: false });
    searchList.render(true);
    $('searchScroller').scrollTop = 0;
    return;
  }

  // A bare id is a direct request to play, not a search.
  if (/^(\d{5,}|qq:.+|kg:.+)$/.test(query)) {
    const item = { id: query, name: `曲目 ${query}`, artist: '解析中…', cover: '' };
    store.set({ tracks: [...store.get().tracks, item] });
    const index = store.get().tracks.length - 1;
    queueList.render(true);
    engine.playIndex(index).catch((err) => toast(err.message, 'error'));
    return;
  }

  searchAbort?.abort();
  searchAbort = new AbortController();
  store.set({ searching: true });
  el.searchBtn.textContent = '…';

  try {
    const items = await api.search(query, source, searchAbort.signal);
    // An empty result isn't cached: upstreams here go through transient
    // outages, and a 5 minute sticky "no results" would outlast most of them.
    if (items.length) writeCache(source, query, items);
    store.set({ results: items, searching: false });
    searchList.render(true);
    $('searchScroller').scrollTop = 0;
    setSearchNote(items.length ? null : `${SOURCE_LABEL[source]}没有匹配的结果`, items.length ? '' : '换个关键词，或者切到别的音源');
  } catch (err) {
    if (err.name === 'AbortError') return;
    store.set({ searching: false, results: [] });
    searchList.render(true);
    // Leaving the previous source's rows on screen under a different tab is
    // worse than showing nothing — it reads as though this source answered.
    const breaker = /熔断|503|连续失败/.test(err.message);
    setSearchNote(
      breaker ? `${SOURCE_LABEL[source]}上游正在恢复` : `${SOURCE_LABEL[source]}搜索失败`,
      breaker ? '这一路暂时不可用，过一会儿再试，或者换个音源' : err.message
    );
  } finally {
    el.searchBtn.textContent = '搜';
  }
}

/* --------------------------- playlist ingestion ----------------------------- */

async function loadPlaylistFromInput() {
  const raw = el.playlistInput.value.trim();
  const id = api.extractPlaylistId(raw);
  if (!id) {
    toast('没认出歌单 ID，可以直接粘分享链接', 'error');
    return;
  }

  el.loadPlaylistBtn.textContent = '…';
  try {
    const pl = await api.playlist(id, {
      onFresh: (fresh) => {
        store.set({ tracks: fresh.tracks });
        queueList.render(true);
        toast('歌单已在后台更新');
      },
    });
    loadTracks(pl.tracks, { name: pl.name, id: pl.id });
    el.playlistInput.value = '';
    toast(`${pl.name} · ${pl.tracks.length} 首`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    el.loadPlaylistBtn.textContent = '载入';
  }
}

async function ingestFile(file) {
  if (!file) return;
  try {
    const parsed = api.normalizeImport(await file.text());
    loadTracks(parsed.tracks, { name: parsed.name });
    closeScrim(el.settingsScrim);
    toast(`${parsed.name} · ${parsed.tracks.length} 首`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* --------------------------------- shuffle ---------------------------------- */

function shuffleQueue() {
  const s = store.get();
  if (s.tracks.length < 2) return;

  const current = s.tracks[s.index] ?? null;
  const rest = s.tracks.filter((_, i) => i !== s.index);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  // The playing track stays put at the top so the shuffle doesn't interrupt it.
  const tracks = current ? [current, ...rest] : rest;
  store.set({ tracks, index: current ? 0 : -1 });
  queueList.render(true);
  queueList.scrollTo(0, 'auto');
  toast('队列已打乱');
}

/* --------------------------------- settings --------------------------------- */

function buildQualityOptions() {
  el.qualityOptions.textContent = '';
  for (const q of api.QUALITY) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'opt';
    btn.setAttribute('aria-pressed', String(q.level === store.get().quality));
    btn.dataset.level = q.level;

    const force = document.createElement('span');
    force.className = 'gauge gauge--brass';
    force.style.width = '46px';
    force.style.flex = 'none';
    force.textContent = q.bft == null ? 'auto' : `bft ${q.bft}`;

    const body = document.createElement('span');
    body.className = 'opt__body';
    body.innerHTML = '<span class="opt__name"></span><span class="opt__note"></span>';
    body.querySelector('.opt__name').textContent = q.name;
    body.querySelector('.opt__note').textContent = q.note;

    btn.append(force, body);
    btn.addEventListener('click', () => selectQuality(q.level));
    el.qualityOptions.append(btn);
  }
}

async function selectQuality(level) {
  const s = store.get();
  if (level === s.quality) return;
  store.set({ quality: level });
  el.qualityOptions.querySelectorAll('.opt').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.level === level))
  );

  // Re-resolve the current track at the new level, keeping the playhead.
  if (s.track && s.index >= 0) {
    const at = store.get().elapsed;
    const wasPlaying = s.playing;
    try {
      await engine.playIndex(s.index);
      engine.seek(at);
      if (!wasPlaying) engine.element().pause();
      toast(`已切到 ${api.labelOf(level)}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  paintReadout();
}

/* ----------------------------------- scrims --------------------------------- */

function openScrim(scrim) {
  scrim.classList.add('is-open');
  scrim.querySelector('input, button')?.focus({ preventScroll: true });
}
function closeScrim(scrim) {
  scrim.classList.remove('is-open');
}

/* ----------------------------------- cloud ---------------------------------- */

let authMode = 'login';

function paintCloud() {
  const s = store.get();
  el.syncLamp.dataset.state = s.syncState;
  el.cloudAuthBtn.textContent = s.user ? '退出' : '登录';

  if (!s.user) {
    el.cloudScroller.textContent = '';
    el.cloudScroller.append(el.cloudEmpty);
    el.cloudEmpty.innerHTML = '<strong>未登录</strong>登录后歌单会跨设备同步，本地草稿可稍后上传';
    return;
  }

  if (!s.cloudLists.length) {
    el.cloudScroller.textContent = '';
    el.cloudScroller.append(el.cloudEmpty);
    el.cloudEmpty.innerHTML = '<strong>云端还没有歌单</strong>用「保存当前」把这条队列存上去';
    return;
  }

  el.cloudScroller.textContent = '';
  for (const pl of s.cloudLists) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.position = 'relative';
    row.style.height = '56px';
    row.innerHTML = `
      <span class="row__ord num"></span>
      <span class="row__art" style="display:grid;place-items:center">
        <svg viewBox="0 0 256 256" width="16" height="16" style="color:var(--gust-dim)"><use href="#i-cloud"/></svg>
      </span>
      <span class="row__meta"><span class="row__name"></span><span class="row__sub"></span></span>
      <span class="row__tail"></span>`;
    row.querySelector('.row__ord').textContent = pl.id;
    row.querySelector('.row__name').textContent = pl.name || '未命名歌单';
    row.querySelector('.row__sub').textContent =
      `${pl.trackCount ?? pl.tracks?.length ?? 0} 首 · ${
        { local: '仅本地', dirty: '待上传', cloud: '已同步', public: '只读分享' }[pl.syncState] || '已同步'
      }`;
    row.addEventListener('click', () => openCloudList(pl.id));
    el.cloudScroller.append(row);
  }
}

async function openCloudList(id) {
  try {
    store.set({ syncState: 'live' });
    const pl = await api.cloud.detail(id);
    loadTracks(pl.tracks || [], { name: pl.name, id: pl.id });
    toast(`${pl.name} · ${pl.tracks?.length ?? 0} 首`);
  } catch (err) {
    store.set({ syncState: 'error' });
    toast(err.message, 'error');
  }
}

async function refreshCloud() {
  if (!api.cloud.authed) return;
  try {
    store.set({ cloudLists: await api.cloud.list(), syncState: 'live' });
  } catch (err) {
    store.set({ syncState: 'error' });
    toast(err.message, 'error');
  }
  paintCloud();
}

async function saveCurrentToCloud() {
  const s = store.get();
  if (!api.cloud.authed) {
    openScrim(el.authScrim);
    return;
  }
  if (!s.tracks.length) {
    toast('队列是空的', 'error');
    return;
  }
  try {
    store.set({ syncState: 'dirty' });
    const pl = await api.cloud.create(s.playlistName || `队列 ${new Date().toLocaleDateString()}`, s.tracks);
    store.set({ syncState: 'live' });
    toast(`已保存到云端 · ${pl.id}`);
    refreshCloud();
  } catch (err) {
    store.set({ syncState: 'error' });
    toast(err.message, 'error');
  }
}

async function submitAuth() {
  const username = el.authUser.value.trim();
  const password = el.authPass.value;
  if (!username || !password) {
    toast('用户名和密码都要填', 'error');
    return;
  }
  el.authSubmit.textContent = '…';
  try {
    const user =
      authMode === 'login'
        ? await api.cloud.login(username, password)
        : await api.cloud.register(username, password, el.authInvite.value.trim());
    store.set({ user, syncState: 'live' });
    closeScrim(el.authScrim);
    el.authPass.value = '';
    toast(`欢迎回来，${user?.username || username}`);
    refreshCloud();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    el.authSubmit.textContent = authMode === 'login' ? '登录' : '注册';
  }
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  el.authInviteWrap.hidden = authMode === 'login';
  el.authSubmit.textContent = authMode === 'login' ? '登录' : '注册';
  el.authToggle.textContent = authMode === 'login' ? '没有账号？注册' : '已有账号？登录';
  $('authTitle').textContent = authMode === 'login' ? '登录' : '注册';
}

/* ------------------------------- panel gesture ------------------------------ */

/**
 * On narrow screens the panel is dragged up from the bottom edge. Threshold is
 * distance-or-velocity so a quick flick works as well as a slow pull.
 */
function bindPanelDrag() {
  let startY = 0;
  let startT = 0;
  let offset = 0;
  let active = false;

  /**
   * Read the peek height from CSS rather than repeating 64 here. On a phone it
   * also carries the home-indicator inset, and a drag that disagrees with the
   * transform by that much feels like the sheet slipping.
   */
  const peek = () => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--peek');
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 64;
  };
  const collapsed = () => el.panel.clientHeight - peek();

  el.panelHandle.addEventListener('pointerdown', (e) => {
    if (!isNarrow()) return;
    active = true;
    startY = e.clientY;
    startT = performance.now();
    el.panel.classList.add('is-dragging');
    el.panelHandle.setPointerCapture(e.pointerId);
  });

  el.panelHandle.addEventListener('pointermove', (e) => {
    if (!active) return;
    const base = el.panel.classList.contains('is-up') ? 0 : collapsed();
    offset = Math.max(0, Math.min(collapsed(), base + (e.clientY - startY)));
    el.panel.style.transform = `translateY(${offset}px)`;
  });

  const end = () => {
    if (!active) return;
    active = false;
    el.panel.classList.remove('is-dragging');
    el.panel.style.transform = '';

    const wasUp = el.panel.classList.contains('is-up');
    const moved = Math.abs(offset - (wasUp ? 0 : collapsed()));

    // A press that never moved is a tap, and a tap on the handle should toggle.
    // Previously it fell through the distance and velocity tests and did
    // nothing, so the only way down was a deliberate drag.
    if (moved < 6) {
      raisePanel(!wasUp);
      return;
    }

    const velocity = moved / Math.max(1, performance.now() - startT);
    const travelled = wasUp ? offset : collapsed() - offset;
    raisePanel(velocity > 0.6 ? !wasUp : travelled > collapsed() * 0.4 ? !wasUp : wasUp);
  };
  el.panelHandle.addEventListener('pointerup', end);
  el.panelHandle.addEventListener('pointercancel', end);
  el.panelHandle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      raisePanel(!el.panel.classList.contains('is-up'));
    }
  });

  // Reaching the handle from inside a scrolled lyric column means scrolling all
  // the way back up first. The mini bar sits directly under it and is always
  // visible while the sheet is raised, so its title doubles as a way down.
  el.miniTitle.addEventListener('click', () => raisePanel(false));
}

/* -------------------------------- keyboard ---------------------------------- */

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        engine.toggle();
        break;
      case 'j':
        engine.next();
        break;
      case 'k':
        engine.prev();
        break;
      case 'm':
        cycleMode();
        break;
      case '=':
      case '+':
        nudgeVolume(0.05);
        break;
      case '-':
      case '_':
        nudgeVolume(-0.05);
        break;
      case '/':
        e.preventDefault();
        showView('search');
        raisePanel(true);
        el.searchInput.focus();
        break;
      case 'Escape':
        [el.settingsScrim, el.authScrim].forEach(closeScrim);
        raisePanel(false);
        break;
      default:
        if (/^[1-4]$/.test(e.key)) showView(VIEWS[Number(e.key) - 1]);
    }
  });
}

/**
 * Volume has no chrome of its own — it rides the dial. Scrolling over the dial
 * or pressing +/- adjusts it, and the readout borrows the toast rather than
 * adding a slider that would compete with the pointer for attention.
 */
function nudgeVolume(delta) {
  engine.setVolume(store.get().volume + delta);
  const pct = Math.round(store.get().volume * 100);
  toast(`音量 ${pct}%`);
}

function cycleMode() {
  const order = ['sequence', 'random', 'single'];
  const next = order[(order.indexOf(store.get().mode) + 1) % order.length];
  store.set({ mode: next });
  toast({ sequence: '顺序播放', random: '随机播放', single: '单曲循环' }[next]);
}

/* ---------------------------------- session --------------------------------- */

const SESSION_KEY = 'vplayer:session';

function saveSession() {
  const s = store.get();
  if (!s.tracks.length) return;
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        name: s.playlistName,
        id: s.playlistId,
        index: s.index,
        elapsed: Math.floor(s.elapsed),
        // Cap the stored queue: a 5000-track playlist would blow the quota.
        tracks: s.tracks.slice(0, 800),
      })
    );
  } catch {
    /* quota — the session is a convenience */
  }
}

async function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved?.tracks?.length) return false;

  store.set({
    tracks: saved.tracks,
    playlistName: saved.name || '',
    playlistId: saved.id || null,
    index: -1,
  });
  queueList.render(true);

  // Load but do not autoplay: browsers block it, and starting sound on open is
  // rude. The dial shows where the listener left off.
  const index = Math.max(0, Math.min(saved.index ?? 0, saved.tracks.length - 1));
  try {
    await engine.playIndex(index);
    engine.element().pause();
    if (saved.elapsed > 0) engine.seek(saved.elapsed);
  } catch {
    /* the track may have expired upstream */
  }
  return true;
}

/* ------------------------------------ boot ---------------------------------- */

function bindEvents() {
  el.playBtn.addEventListener('click', () => engine.toggle());
  el.nextBtn.addEventListener('click', () => engine.next());
  el.prevBtn.addEventListener('click', () => engine.prev());
  el.modeBtn.addEventListener('click', cycleMode);
  el.miniPlay.addEventListener('click', () => engine.toggle());
  el.miniNext.addEventListener('click', () => engine.next());

  el.panelBtn.addEventListener('click', () => {
    if (isNarrow()) {
      const up = !el.panel.classList.contains('is-up');
      raisePanel(up);
      if (up) showView('queue');
    } else {
      showView(store.get().view === 'queue' ? 'search' : 'queue');
    }
  });

  document.querySelectorAll('.rose__tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      // Tapping the tab you are already on collapses the sheet, the way a tab
      // bar scrolls to top on a second tap. It is the closest control to the
      // thumb when the sheet is up.
      if (isNarrow() && store.get().view === tab.dataset.view && el.panel.classList.contains('is-up')) {
        raisePanel(false);
        return;
      }
      showView(tab.dataset.view);
      raisePanel(true);
    });
  });

  el.loadPlaylistBtn.addEventListener('click', loadPlaylistFromInput);
  el.playlistInput.addEventListener('keydown', (e) => e.key === 'Enter' && loadPlaylistFromInput());
  el.shuffleBtn.addEventListener('click', shuffleQueue);

  el.searchBtn.addEventListener('click', runSearch);
  el.searchInput.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());
  el.sourcePick.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-source]');
    if (!btn) return;
    store.set({ source: btn.dataset.source });
    el.sourcePick.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn))
    );
    // Not a forced search: if this source already answered this query, the
    // cached list renders instantly and no request is made.
    if (el.searchInput.value.trim()) runSearch();
  });

  el.lyricTicker.addEventListener('click', () => {
    showView('lyrics');
    raisePanel(true);
  });

  el.offlinePersistBtn.addEventListener('click', async () => {
    const ok = await offline.requestPersistence();
    toast(ok ? '已获得常驻存储，系统不会自动清理' : '浏览器拒绝了常驻请求');
  });

  el.offlineClearBtn.addEventListener('click', async () => {
    await offline.clear();
    await refreshOfflineIds();
    paintStorage();
    toast('离线文件已清空');
  });

  el.libraryPruneBtn.addEventListener('click', async () => {
    try {
      const r = await api.libraryPrune();
      toast(r.evicted.length ? `已清理 ${r.evicted.length} 首` : '库容量还在限额内');
      paintStorage();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.settingsBtn.addEventListener('click', () => {
    openScrim(el.settingsScrim);
    paintStorage();
  });
  el.settingsClose.addEventListener('click', () => closeScrim(el.settingsScrim));
  el.settingsScrim.addEventListener('click', (e) => e.target === el.settingsScrim && closeScrim(el.settingsScrim));
  el.fileInput.addEventListener('change', (e) => ingestFile(e.target.files?.[0]));

  el.cloudBtn.addEventListener('click', () => {
    showView('cloud');
    raisePanel(true);
    refreshCloud();
  });
  el.cloudRefreshBtn.addEventListener('click', refreshCloud);
  el.cloudSaveBtn.addEventListener('click', saveCurrentToCloud);
  el.cloudAuthBtn.addEventListener('click', () => {
    if (store.get().user) {
      api.cloud.logout();
      store.set({ user: null, cloudLists: [], syncState: 'off' });
      paintCloud();
      toast('已退出登录');
    } else {
      openScrim(el.authScrim);
    }
  });

  el.authClose.addEventListener('click', () => closeScrim(el.authScrim));
  el.authScrim.addEventListener('click', (e) => e.target === el.authScrim && closeScrim(el.authScrim));
  el.authSubmit.addEventListener('click', submitAuth);
  el.authToggle.addEventListener('click', toggleAuthMode);
  el.authPass.addEventListener('keydown', (e) => e.key === 'Enter' && submitAuth());

  el.resolverChip.addEventListener('click', async () => {
    const s = store.get();
    const next = s.resolver === 'lx' ? 'auto' : 'lx';
    store.set({ resolver: next });
    toast(next === 'lx' ? '直接走备用源解析' : '主源优先，失败时自动回退备用源');

    // Re-resolve the current track so the switch is audible now rather than at
    // the next song, keeping the playhead where it was.
    if (s.track && s.index >= 0) {
      const at = store.get().elapsed;
      const wasPlaying = s.playing;
      try {
        await engine.playIndex(s.index);
        engine.seek(at);
        if (!wasPlaying) engine.element().pause();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  el.copyIdBtn.addEventListener('click', async () => {
    const id = store.get().track?.id;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(String(id));
      toast('已复制曲目 ID');
    } catch {
      toast('剪贴板不可用', 'error');
    }
  });

  // Drag a playlist file anywhere onto the window.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) ingestFile(file);
  });

  $('dial').addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      nudgeVolume(e.deltaY > 0 ? -0.04 : 0.04);
    },
    { passive: false }
  );

  window.addEventListener('beforeunload', saveSession);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveSession());
}

function bindStore() {
  store.on(
    [
      'track',
      'tracks',
      'loading',
      'levelLabel',
      'playlistName',
      'quality',
      'resolver',
      'fallbackAvailable',
      'playbackError',
    ],
    paintReadout
  );
  store.on(['playing', 'mode'], paintTransport);
  store.on(['lyrics', 'lyricIndex'], paintTicker);
  store.on(['index'], () => {
    queueList.render(true);
    if (store.get().view === 'queue') queueList.scrollTo(store.get().index);
  });
  store.on(['user', 'cloudLists', 'syncState'], paintCloud);
}

async function boot() {
  engine.init();
  dial.init();
  lyrics.init();
  buildQualityOptions();
  bindEvents();
  bindStore();
  bindPanelDrag();
  bindKeys();
  initCursorAura();
  initInstall();

  el.sourcePick.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.source === store.get().source))
  );
  showView(store.get().view);
  paintReadout();
  paintTransport();

  // Shared links: ?playlist= / ?song= / ?q=
  const params = new URLSearchParams(location.search);
  const sharedPlaylist = params.get('playlist');
  const sharedSong = params.get('song');
  const sharedQuery = params.get('q');
  // Manifest shortcuts open straight into a view.
  const sharedView = params.get('view');
  if (sharedView && VIEWS.includes(sharedView)) {
    showView(sharedView);
    raisePanel(true);
  }

  if (sharedPlaylist) {
    el.playlistInput.value = sharedPlaylist;
    await loadPlaylistFromInput();
  } else if (sharedSong) {
    el.searchInput.value = sharedSong;
    showView('search');
    await runSearch();
  } else if (sharedQuery) {
    el.searchInput.value = sharedQuery;
    showView('search');
    await runSearch();
  } else {
    const restored = await restoreSession();
    if (!restored) showView('queue');
  }

  if (api.cloud.authed) {
    api.cloud
      .me()
      .then((user) => {
        store.set({ user, syncState: 'live' });
        refreshCloud();
      })
      .catch(() => {
        api.cloud.logout();
        store.set({ syncState: 'off' });
      });
  }

  // Config only, no upstream probe — this is free and tells us whether the
  // fallback resolver exists, which decides if its switch is shown at all.
  api
    .health()
    .then((h) =>
      store.set({
        fallbackAvailable: Boolean(h.fallbackConfigured),
        libraryAvailable: Boolean(h.libraryConfigured),
      })
    )
    .catch(() => {});

  refreshOfflineIds().catch(() => {});

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot().catch((err) => {
  console.error('[vane] boot failed', err);
  toast('启动失败，看看控制台', 'error');
});
