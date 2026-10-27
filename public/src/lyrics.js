/**
 * lyrics.js — VANE "风眼" (Wind-Eye) full-screen lyric view (v139):
 *   - 1.75x background compass dial (.dialbg) peeking from bottom-right with live
 *     golden ticks (#lyricDialTicks), progress arc (#lyricDialArc), and rotating needle (#lyricDialNeedle).
 *   - Centered small-to-large typography via GPU transform:scale(1.38) (zero layout
 *     reflow, zero line-wrap jump, and zero whole-list style invalidation flash).
 *   - 60fps per-character progress (--c) & upward bounce/float (--g = sin(v * π)),
 *     mutating only the 1–2 characters currently in transition per frame.
 *   - Centered three-dot golden interlude indicator (p.lyric.gap) between long vocal gaps.
 *   - Two-line header readout: "曲名 · 歌手" + live golden monospace "NE 051° · 0:35".
 */

import * as store from './store.js';
import * as engine from './engine.js';

const DIR = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cl = (x) => Math.max(0, Math.min(1, x));

let overlay = null;
let root = null;
let seekBar = null;
let seekBtn = null;
let bearingEl = null;
let dialTicksEl = null;
let dialArcEl = null;
let dialNeedleEl = null;

/** Display items: each is either a lyric line or a 3-dot interlude { gap: true }. */
let items = [];
let nodes = [];
let follow = true;
let releaseTimer = 0;
let activeIdx = -1;
let seekTargetIdx = -1;
let holdTimer = 0;
let holdFired = false;
let rafId = 0;
let lastSec = -1;
let lastDegInt = -1;

/** mm:ss for a lyric line's cue point. */
function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function buildDialTicks() {
  if (!dialTicksEl) return;
  let h = '';
  for (let i = 0; i < 72; i++) {
    const m = i % 6 === 0;
    const a = (i * 5 * Math.PI) / 180;
    const r1 = m ? 168 : 176;
    const r2 = 188;
    const x1 = (200 + Math.sin(a) * r1).toFixed(2);
    const y1 = (200 - Math.cos(a) * r1).toFixed(2);
    const x2 = (200 + Math.sin(a) * r2).toFixed(2);
    const y2 = (200 - Math.cos(a) * r2).toFixed(2);
    h += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#d4a94a" stroke-opacity="${m ? 0.7 : 0.3}" stroke-width="${m ? 2 : 1.2}"/>`;
  }
  dialTicksEl.innerHTML = h;
}

function anchor() {
  return (root?.clientHeight || 600) * 0.34;
}

function updateAnchorPadding() {
  if (!root) return;
  const a = anchor();
  root.style.paddingTop = `${Math.round(a)}px`;
  document.documentElement.style.setProperty('--ay', `${Math.round((root.offsetTop || 64) + a)}px`);
}

function scrollToIndex(i, smooth = true) {
  if (!root || i < 0 || !nodes[i]) return;
  const p = nodes[i];
  root.scrollTo({
    top: Math.max(0, p.offsetTop - anchor() + p.offsetHeight * 0.5),
    behavior: smooth ? 'smooth' : 'auto',
  });
}

function currentPlaybackTime() {
  const s = store.get();
  const audio = engine.element?.();
  if (audio && !audio.paused && !engine.holdingSession?.() && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
    return audio.currentTime;
  }
  return Number(s.elapsed) || 0;
}

function resetItemChars(item) {
  if (!item || !item.cs) return;
  for (let k = 0; k < item.cs.length; k++) {
    const c = item.cs[k];
    if (c._v === 0 && c._g === 0) continue;
    c._v = 0;
    c._g = 0;
    if (item.gap) {
      c.style.opacity = '';
      c.style.transform = '';
    } else {
      c.style.removeProperty('--c');
      c.style.removeProperty('--g');
    }
  }
}

function applyDistanceClasses(centerIdx, prevCenterIdx) {
  const touched = new Set();
  if (prevCenterIdx >= 0) {
    for (let d = -3; d <= 3; d++) {
      const idx = prevCenterIdx + d;
      if (idx >= 0 && idx < nodes.length) touched.add(idx);
    }
  }
  if (centerIdx >= 0) {
    for (let d = -3; d <= 3; d++) {
      const idx = centerIdx + d;
      if (idx >= 0 && idx < nodes.length) touched.add(idx);
    }
  }
  for (const idx of touched) {
    const p = nodes[idx];
    if (!p) continue;
    const dist = centerIdx >= 0 ? Math.abs(idx - centerIdx) : 99;
    const isOn = dist === 0;
    p.classList.toggle('on', isOn);
    p.classList.toggle('is-active', isOn);
    p.classList.toggle('is-near', dist === 1);
    p.classList.toggle('is-mid', dist === 2);
    if (!isOn && idx === prevCenterIdx) {
      resetItemChars(items[idx]);
    }
  }
}

function build(rawLines) {
  if (!root) return;
  root.textContent = '';
  items = [];
  nodes = [];
  activeIdx = -1;
  hideSeekBar();
  updateAnchorPadding();

  if (!rawLines || !rawLines.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<strong>没有歌词</strong>这首歌上游没有提供';
    root.append(empty);
    return;
  }

  const s = store.get();
  const trackDur = Number(s.duration) || Number(s.track?.duration) || 0;

  const firstTime = Number(rawLines[0]?.time) || 0;
  if (firstTime >= 4.5) {
    items.push({
      gap: true,
      time: 0,
      end: Math.max(0.8, firstTime - 0.25),
      rawIndex: 0,
      cs: [],
    });
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const start = Number(line.time) || 0;
    const nextStart =
      i + 1 < rawLines.length
        ? Number(rawLines[i + 1].time) || start + 4
        : trackDur > start
          ? trackDur
          : start + 5;
    const span = Math.max(0.8, nextStart - start);
    const words = String(line.words || '').trim();

    if (!words || /^(\/\/|~+|…+|\.+|music|间奏|纯音乐)$/i.test(words)) {
      if (span >= 2.5) {
        items.push({
          gap: true,
          time: start,
          end: Math.max(start + 0.8, nextStart - 0.2),
          rawIndex: i,
          cs: [],
        });
      }
      continue;
    }

    const charCount = Array.from(words).length;
    const naturalVocalDur = Math.max(1.6, Math.min(7.2, 2.0 + charCount * 0.18));
    const hasLongInterlude = i + 1 < rawLines.length && span - naturalVocalDur >= 5.0 && span >= 8.0;
    const lineEnd = hasLongInterlude
      ? start + naturalVocalDur
      : Math.max(start + 0.5, nextStart - Math.min(0.35, span * 0.12));

    items.push({
      gap: false,
      time: start,
      end: lineEnd,
      words,
      roma: line.roma || '',
      trans: line.trans || '',
      rawIndex: i,
      cs: [],
    });

    if (hasLongInterlude) {
      items.push({
        gap: true,
        time: lineEnd + 0.15,
        end: Math.max(lineEnd + 1.0, nextStart - 0.25),
        rawIndex: Math.min(rawLines.length - 1, i + 1),
        cs: [],
      });
    }
  }

  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => {
    const p = document.createElement('p');
    p.dataset.i = String(idx);
    p.dataset.index = String(item.rawIndex ?? idx);

    if (item.gap) {
      p.className = 'lyric gap';
      p.setAttribute('aria-label', '间奏');
      for (let k = 0; k < 3; k++) {
        const dot = document.createElement('i');
        dot._v = 0;
        dot._g = 0;
        p.append(dot);
        item.cs.push(dot);
      }
    } else {
      p.className = 'lyric';
      const body = document.createElement('span');
      body.className = 'lyric__body';

      const main = document.createElement('span');
      main.className = 'lyric__words';
      for (const ch of Array.from(item.words)) {
        const span = document.createElement('span');
        span.className = 'c lyric__ch';
        span.textContent = ch;
        span._v = 0;
        span._g = 0;
        main.append(span);
        item.cs.push(span);
      }
      body.append(main);

      for (const [text, cls] of [
        [item.roma, 'lyric__roma'],
        [item.trans, 'lyric__trans'],
      ]) {
        if (!text) continue;
        const side = document.createElement('small');
        side.className = cls;
        side.textContent = text;
        body.append(side);
      }

      p.append(body);
    }

    frag.append(p);
    nodes.push(p);
  });

  root.append(frag);
  paintFrame(currentPlaybackTime(), true);
}

function paintDialAndHeader(t) {
  const s = store.get();
  const dur = Math.max(1, Number(s.duration) || Number(s.track?.duration) || 190);
  const deg = cl(t / dur) * 360;
  const degInt = Math.round(deg * 2);

  if (degInt !== lastDegInt) {
    lastDegInt = degInt;
    if (dialNeedleEl) {
      dialNeedleEl.setAttribute('transform', `rotate(${deg.toFixed(1)} 200 200)`);
    }
    if (dialArcEl) {
      dialArcEl.setAttribute('stroke-dasharray', `${deg.toFixed(1)} 360`);
    }
  }

  const sec = Math.floor(t);
  if (sec !== lastSec && bearingEl) {
    lastSec = sec;
    const dir = DIR[Math.round(deg / 45) % 8];
    const degText = String(Math.round(deg) % 360).padStart(3, '0');
    bearingEl.textContent = `${dir} ${degText}° · ${stamp(t)}`;
  }
}

function paintFrame(t, forceScroll = false) {
  paintDialAndHeader(t);
  if (!items.length || !nodes.length) return;

  let i = 0;
  for (let j = 0; j < items.length; j++) {
    if (t + 0.08 >= items[j].time) i = j;
    else break;
  }

  if (i !== activeIdx || forceScroll) {
    const first = activeIdx < 0 || forceScroll;
    const prevIdx = activeIdx;
    activeIdx = i;

    if (first && prevIdx >= 0 && prevIdx !== i) {
      resetItemChars(items[prevIdx]);
    }
    applyDistanceClasses(i, prevIdx);

    if (follow) {
      scrollToIndex(i, !first);
    }
  }

  const cur = items[i];
  if (!cur || !cur.cs.length) return;
  const p = cl((t - cur.time) / Math.max(0.25, cur.end - cur.time));
  const n = cur.cs.length;
  for (let k = 0; k < n; k++) {
    const c = cur.cs[k];
    const v = cl(p * n - k);
    const g = v > 0 && v < 1 ? Math.sin(v * Math.PI) : 0;
    if (Math.abs(v - (c._v ?? -1)) < 0.004 && Math.abs(g - (c._g ?? -1)) < 0.004) {
      continue;
    }
    c._v = v;
    c._g = g;
    if (cur.gap) {
      c.style.opacity = (0.25 + 0.75 * v).toFixed(3);
      c.style.transform = `scale(${(1 + 0.35 * g).toFixed(3)})`;
    } else {
      c.style.setProperty('--c', v.toFixed(3));
      c.style.setProperty('--g', g.toFixed(3));
    }
  }
}

function tickFrame() {
  rafId = 0;
  if (!overlay || !overlay.classList.contains('is-open')) return;
  paintFrame(currentPlaybackTime(), false);
  if (store.get().playing && !engine.holdingSession?.()) {
    rafId = requestAnimationFrame(tickFrame);
  }
}

function ensureLoop() {
  if (!rafId && overlay && overlay.classList.contains('is-open')) {
    rafId = requestAnimationFrame(tickFrame);
  }
}

function hideSeekBar() {
  if (seekBar) {
    seekBar.hidden = true;
    seekBar.classList.remove('on');
  }
  if (seekTargetIdx >= 0 && nodes[seekTargetIdx]) {
    nodes[seekTargetIdx].classList.remove('is-seek-target');
  }
  seekTargetIdx = -1;
}

function updateSeekTarget() {
  if (!root || !nodes.length || follow) return;
  const y = root.scrollTop + anchor();
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const d = Math.abs(n.offsetTop + n.offsetHeight * 0.5 - y);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (seekTargetIdx !== bestIdx) {
    if (seekTargetIdx >= 0 && nodes[seekTargetIdx]) {
      nodes[seekTargetIdx].classList.remove('is-seek-target');
    }
    seekTargetIdx = bestIdx;
    nodes[bestIdx]?.classList.add('is-seek-target');
  }
  const item = items[bestIdx];
  if (item && seekBar && seekBtn) {
    const show = bestIdx !== activeIdx;
    seekBar.hidden = !show;
    seekBar.classList.toggle('on', show);
    seekBtn.textContent = `▶ ${stamp(item.time)} · 跳播`;
  }
}

function engageManualScroll() {
  if (!items.length) return;
  follow = false;
  if (root) root.classList.add('is-scrolling');
  clearTimeout(releaseTimer);
}

function releaseManualScroll(immediate = false) {
  clearTimeout(releaseTimer);
  const restore = () => {
    follow = true;
    if (root) root.classList.remove('is-scrolling');
    hideSeekBar();
    if (activeIdx >= 0) scrollToIndex(activeIdx, true);
  };
  if (immediate) restore();
  else releaseTimer = setTimeout(restore, 3000);
}

export function sync() {
  follow = true;
  if (root) root.classList.remove('is-scrolling');
  clearTimeout(releaseTimer);
  hideSeekBar();
  updateAnchorPadding();
  lastSec = -1;
  lastDegInt = -1;
  paintFrame(currentPlaybackTime(), true);
  ensureLoop();
}

export function init() {
  overlay = document.getElementById('lyricOverlay');
  root = document.getElementById('lyrics');
  seekBar = document.getElementById('lyricSeekBar');
  seekBtn = document.getElementById('lyricSeekBtn');
  bearingEl = document.getElementById('lyricBearing');
  dialTicksEl = document.getElementById('lyricDialTicks');
  dialArcEl = document.getElementById('lyricDialArc');
  dialNeedleEl = document.getElementById('lyricDialNeedle');

  buildDialTicks();
  updateAnchorPadding();

  if (seekBtn) {
    seekBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = seekTargetIdx;
      const time = items[idx]?.time;
      if (Number.isFinite(time)) {
        engine.seek(time);
      }
      releaseManualScroll(true);
      paintFrame(currentPlaybackTime(), true);
      ensureLoop();
    });
  }

  root.addEventListener('pointerdown', (e) => {
    const line = e.target.closest('.lyric');
    if (!line || line.classList.contains('gap')) return;
    holdFired = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdFired = true;
      const rawIdx = Number(line.dataset.index);
      root.dispatchEvent(new CustomEvent('lyric:postcard', { detail: { index: rawIdx } }));
    }, 520);
  }, { passive: true });

  const cancelHold = () => clearTimeout(holdTimer);
  root.addEventListener('pointerup', cancelHold, { passive: true });
  root.addEventListener('pointercancel', cancelHold, { passive: true });
  root.addEventListener('pointermove', cancelHold, { passive: true });

  root.addEventListener('click', (e) => {
    if (holdFired) {
      holdFired = false;
      e.stopPropagation();
      return;
    }
    const line = e.target.closest('.lyric');
    if (!line) return;
    const idx = Number(line.dataset.i);
    const time = items[idx]?.time;
    if (Number.isFinite(time)) {
      engine.seek(time);
      releaseManualScroll(true);
      paintFrame(time, true);
      ensureLoop();
    }
  });

  ['touchstart', 'wheel'].forEach((ev) => {
    root.addEventListener(ev, engageManualScroll, { passive: true });
  });
  ['touchend', 'touchcancel', 'wheel'].forEach((ev) => {
    root.addEventListener(ev, () => releaseManualScroll(false), { passive: true });
  });
  root.addEventListener('scroll', () => {
    if (!follow) updateSeekTarget();
  }, { passive: true });

  window.addEventListener('resize', () => {
    updateAnchorPadding();
    if (follow && activeIdx >= 0) scrollToIndex(activeIdx, false);
  }, { passive: true });

  store.on('lyrics', (s) => build(s.lyrics));
  store.on('lyricIndex', () => {
    paintFrame(currentPlaybackTime(), false);
    ensureLoop();
  });
  store.on(['elapsed', 'duration'], (s) => {
    if (overlay && overlay.classList.contains('is-open')) {
      paintFrame(currentPlaybackTime(), false);
      ensureLoop();
    } else {
      paintDialAndHeader(Number(s.elapsed) || 0);
    }
  });
  store.on('playing', (s) => {
    if (root) root.dataset.playing = String(Boolean(s.playing));
    if (s.playing) ensureLoop();
  });
}
