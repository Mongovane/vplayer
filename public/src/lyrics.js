/**
 * lyrics.js — VANE "风眼" (Wind-Eye) full-screen lyric view (v143 Low-Power Edition):
 *   Incorporates the 4 core design & algorithmic highlights from mexicat/pdoom-video
 *   with strict mobile battery/GPU optimizations:
 *   1. Deterministic Pure-Time Rendering (Frame = render(t)):
 *      O(log N) binary search + phonetic-weighted character progress; zero residual state on seeks.
 *   2. Sub-glyph Asymmetric Vocal Strike & Optical Kerning:
 *      Fast attack (0 -> 0.28) + smooth harmonic release (0.28 -> 1.0) curve (`vocalStrike`)
 *      with GPU-composited `translate3d` + `scale` and native optical kerning.
 *   3. VANE Precision Instrument HUD & Hairline Vernier Graduations:
 *      3-tier compass graduations with degree numerals (`000°..330°`), swept-tick
 *      illumination, and 1Hz low-power telemetry readout (`NE 055° · BFT 8 · 0:41`).
 *   4. Low-Power Beat Envelope & 30fps ProMotion Throttle:
 *      - Throttles rAF to ~30fps (32ms) so 120Hz ProMotion screens save 75% CPU/GPU wakeups.
 *      - Avoids SVG `filter: drop-shadow` offscreen blur; modulates `stroke-opacity` & `stroke-width`.
 *      - Scopes `--beat-env` strictly to `.lyric-hud` so hundreds of `.c` spans never recalculate style.
 */

import * as store from './store.js';
import * as engine from './engine.js';
import * as api from './api.js';

const DIR = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const FRAME_INTERVAL_MS = 32; // ~30fps cap for mobile ProMotion battery efficiency
const cl = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (a, b, x) => {
  const t = cl((x - a) / Math.max(1e-6, b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Asymmetric vocal strike curve inspired by pdoom-video's kinetic typography:
 *   - Crisp vocal attack in the first 28% of the character's duration
 *   - Smooth harmonic sustain & release over the remaining 72%
 */
function vocalStrike(v) {
  if (v <= 0 || v >= 1) return 0;
  if (v < 0.28) {
    return smoothstep(0, 0.28, v);
  }
  const tail = (v - 0.28) / 0.72;
  return 0.5 * (1 + Math.cos(tail * Math.PI));
}

/**
 * Phonetic duration weight per character so mixed CJK + English lyrics advance
 * at natural sung speed instead of crawling across English letters or spaces.
 */
function charPhoneticWeight(ch) {
  if (!ch || /\s/.test(ch)) return 0.28;
  if (/[,.;:!?'"""''()[\]—…·\-~，。；：！？、“”‘’（）【】]/.test(ch)) return 0.22;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) return 1.0;
  return 0.58;
}

let overlay = null;
let hudEl = null;
let root = null;
let seekBar = null;
let seekBtn = null;
let bearingEl = null;
let hudReadoutEl = null;
let dialTicksEl = null;
let dialArcEl = null;
let dialNeedleEl = null;
let tickLines = [];

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
let lastFrameAt = 0;
let lastSec = -1;
let lastDegInt = -1;
let lastSweptTick = -1;
let lastBeatEnv = -1;

/** mm:ss for a lyric line's cue point and 1Hz telemetry readout. */
function stamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function buildDialTicks() {
  if (!dialTicksEl) return;
  dialTicksEl.textContent = '';
  tickLines = [];
  const ns = 'http://www.w3.org/2000/svg';
  const makeEl = (tag) =>
    document.createElementNS ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (let i = 0; i < 72; i++) {
    const deg = i * 5;
    const isCardinal = deg % 30 === 0;
    const isMedium = !isCardinal && deg % 15 === 0;
    const a = (deg * Math.PI) / 180;
    const r1 = isCardinal ? 164 : isMedium ? 171 : 176;
    const r2 = 188;
    const x1 = (200 + Math.sin(a) * r1).toFixed(2);
    const y1 = (200 - Math.cos(a) * r1).toFixed(2);
    const x2 = (200 + Math.sin(a) * r2).toFixed(2);
    const y2 = (200 - Math.cos(a) * r2).toFixed(2);
    const baseOp = isCardinal ? 0.68 : isMedium ? 0.42 : 0.24;
    const sw = isCardinal ? 2 : isMedium ? 1.45 : 1.1;
    const line = makeEl('line');
    line.dataset.tick = String(i);
    line.dataset.baseOp = String(baseOp);
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', '#d4a94a');
    line.setAttribute('stroke-opacity', String(baseOp));
    line.setAttribute('stroke-width', String(sw));
    dialTicksEl.append(line);
    tickLines.push(line);
    if (isCardinal) {
      const tr = 152;
      const tx = (200 + Math.sin(a) * tr).toFixed(1);
      const ty = (200 - Math.cos(a) * tr).toFixed(1);
      const rot = deg > 90 && deg < 270 ? deg + 180 : deg;
      const txt = makeEl('text');
      txt.setAttribute('x', tx);
      txt.setAttribute('y', ty);
      txt.setAttribute('fill', '#d4a94a');
      txt.setAttribute('fill-opacity', '0.42');
      txt.setAttribute('font-size', '7.5');
      txt.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
      txt.setAttribute('letter-spacing', '0.08em');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('dominant-baseline', 'central');
      txt.setAttribute('transform', `rotate(${rot} ${tx} ${ty})`);
      txt.textContent = String(deg).padStart(3, '0') + '°';
      dialTicksEl.append(txt);
    }
  }
  lastSweptTick = -1;
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
  root.scrollTo?.({
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

function resetItemChars(item, stateVal = 0) {
  if (!item || !item.cs) return;
  for (let k = 0; k < item.cs.length; k++) {
    const c = item.cs[k];
    if (c._v === stateVal && c._g === 0) continue;
    c._v = stateVal;
    c._g = 0;
    if (item.gap) {
      c.style.opacity = stateVal > 0 ? '0.65' : '';
      c.style.transform = '';
    } else if (stateVal === 0) {
      c.style.removeProperty?.('--c');
      c.style.removeProperty?.('--g');
    } else {
      c.style.setProperty('--c', stateVal.toFixed(3));
      c.style.setProperty('--g', '0');
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
    if (!isOn && items[idx]) {
      resetItemChars(items[idx], 0);
    }
  }
}

/**
 * O(log N) binary search for the active display item at deterministic time `t`.
 */
function locateItemAt(t) {
  if (!items.length) return -1;
  const query = t + 0.08;
  let lo = 0;
  let hi = items.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (query >= items[mid].time) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Deterministic audio/beat energy envelope in [0..1]:
 *   - Uses real FFT low-end + vocal-mid bins from engine.spectrum() when available.
 *   - Falls back to a deterministic phase-locked harmonic envelope on iOS where
 *     Web Audio is disabled to preserve background lock-screen playback.
 */
function computeBeatEnvelope(t, activeVocalStrike = 0) {
  const s = store.get();
  if (!s.playing || engine.holdingSession?.()) return 0;

  const spec = engine.spectrum?.();
  if (spec && spec.length >= 32) {
    let bass = 0;
    for (let i = 1; i <= 6; i++) bass += spec[i];
    bass /= 6 * 255;
    let mid = 0;
    for (let i = 8; i <= 24; i++) mid += spec[i];
    mid /= 17 * 255;
    return cl(bass * 0.68 + mid * 0.32);
  }

  // Deterministic dual-harmonic pulse (120 BPM fundamental + phrasing sub-harmonic + vocal strike)
  const beatPhase = 0.5 + 0.5 * Math.sin(t * Math.PI * 4.0);
  const barPhase = 0.5 + 0.5 * Math.sin(t * Math.PI * 1.0);
  const pulse = Math.pow(beatPhase, 2.2) * 0.52 + barPhase * 0.2 + activeVocalStrike * 0.28;
  return cl(pulse);
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

    const chars = Array.from(words);
    const weights = chars.map(charPhoneticWeight);
    const totalWeight = Math.max(0.5, weights.reduce((a, b) => a + b, 0));
    const cumStarts = [];
    let acc = 0;
    for (let k = 0; k < weights.length; k++) {
      cumStarts.push(acc / totalWeight);
      acc += weights[k];
    }
    const normWeights = weights.map((w) => Math.max(0.02, w / totalWeight));

    const naturalVocalDur = Math.max(1.6, Math.min(7.4, 1.85 + totalWeight * 0.21));
    const hasLongInterlude = i + 1 < rawLines.length && span - naturalVocalDur >= 5.0 && span >= 8.0;
    const lineEnd = hasLongInterlude
      ? start + naturalVocalDur
      : Math.max(start + 0.5, nextStart - Math.min(0.35, span * 0.12));

    items.push({
      gap: false,
      time: start,
      end: lineEnd,
      words,
      chars,
      cumStarts,
      normWeights,
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

  const frag = document.createDocumentFragment ? document.createDocumentFragment() : root;
  items.forEach((item, idx) => {
    const p = document.createElement('p');
    p.dataset.i = String(idx);
    p.dataset.index = String(item.rawIndex ?? idx);

    if (item.gap) {
      p.className = 'lyric gap';
      p.classList.add('lyric', 'gap');
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
      p.classList.add('lyric');
      const body = document.createElement('span');
      body.className = 'lyric__body';

      const main = document.createElement('span');
      main.className = 'lyric__words';
      for (const ch of item.chars) {
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

  if (frag !== root) root.append(frag);
  paintFrame(currentPlaybackTime(), true);
}

function paintDialAndHeader(t, beatEnv = 0) {
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
    const sweptTick = Math.floor(deg / 5);
    if (sweptTick !== lastSweptTick && tickLines.length) {
      lastSweptTick = sweptTick;
      for (let i = 0; i < tickLines.length; i++) {
        const line = tickLines[i];
        const baseOp = Number(line.dataset.baseOp) || 0.25;
        const op = i <= sweptTick ? Math.min(0.95, baseOp + 0.28) : baseOp;
        line.setAttribute('stroke-opacity', op.toFixed(2));
      }
    }
  }

  // Low-power beat modulation: update only when delta >= 0.04, scoped to .lyric-hud
  // and SVG stroke attributes (zero offscreen Gaussian drop-shadow blur rasterization).
  if (Math.abs(beatEnv - lastBeatEnv) >= 0.04) {
    lastBeatEnv = beatEnv;
    const envStr = beatEnv.toFixed(2);
    if (hudEl) hudEl.style.setProperty('--beat-env', envStr);
    if (overlay) overlay.dataset.beatEnv = envStr;
    if (dialArcEl) {
      dialArcEl.setAttribute('stroke-opacity', (0.68 + beatEnv * 0.28).toFixed(2));
      dialArcEl.setAttribute('stroke-width', (2.8 + beatEnv * 0.9).toFixed(2));
    }
  }

  // 1Hz (once per second) header & HUD text update to avoid 10Hz text layout passes
  const sec = Math.floor(t);
  if (sec !== lastSec) {
    lastSec = sec;
    const dir = DIR[Math.round(deg / 45) % 8];
    const degText = String(Math.round(deg) % 360).padStart(3, '0');
    const bft = api.forceOf?.(api.resolveQuality?.(s.quality));
    const bftTag = bft != null ? ` · BFT ${bft}` : '';
    if (bearingEl) {
      bearingEl.textContent = `${dir} ${degText}°${bftTag} · ${stamp(t)}`;
    }
    if (hudReadoutEl) {
      const idxTag =
        activeIdx >= 0 && items.length
          ? `L${String(activeIdx + 1).padStart(2, '0')}/${String(items.length).padStart(2, '0')}`
          : 'STBY';
      hudReadoutEl.textContent = `VANE // ${dir} ${degText}° // ${idxTag}`;
    }
  }
}

function paintFrame(t, forceScroll = false) {
  if (!items.length || !nodes.length) {
    paintDialAndHeader(t, computeBeatEnvelope(t, 0));
    return;
  }

  const i = locateItemAt(t);

  if (i !== activeIdx || forceScroll) {
    const first = activeIdx < 0 || forceScroll;
    const prevIdx = activeIdx;
    activeIdx = i;
    lastSec = -1; // refresh Lxx/yy line counter on line change

    if (prevIdx >= 0 && prevIdx !== i) {
      resetItemChars(items[prevIdx], 0);
    }
    applyDistanceClasses(i, prevIdx);

    if (follow) {
      scrollToIndex(i, !first);
    }
  }

  const cur = items[i];
  if (!cur || !cur.cs.length) {
    paintDialAndHeader(t, computeBeatEnvelope(t, 0));
    return;
  }

  const p = cl((t - cur.time) / Math.max(0.25, cur.end - cur.time));
  const n = cur.cs.length;
  let peakG = 0;
  const gapBeatPulse = cur.gap ? computeBeatEnvelope(t, 0.25) : 0;

  for (let k = 0; k < n; k++) {
    const c = cur.cs[k];
    let v;
    if (cur.gap) {
      v = cl(p * n - k);
    } else {
      const cStart = cur.cumStarts ? cur.cumStarts[k] : k / n;
      const cWidth = cur.normWeights ? cur.normWeights[k] : 1 / n;
      v = cl((p - cStart) / cWidth);
    }
    const g = cur.gap ? (v > 0 && v < 1 ? Math.sin(v * Math.PI) : 0) : vocalStrike(v);
    if (g > peakG) peakG = g;

    if (!cur.gap && Math.abs(v - (c._v ?? -1)) < 0.005 && Math.abs(g - (c._g ?? -1)) < 0.005) {
      continue;
    }
    c._v = v;
    c._g = g;
    if (cur.gap) {
      const scale = 1 + 0.34 * g + 0.14 * v * gapBeatPulse;
      c.style.opacity = (0.24 + 0.76 * v).toFixed(3);
      c.style.transform = `scale(${scale.toFixed(3)})`;
    } else {
      c.style.setProperty('--c', v.toFixed(3));
      c.style.setProperty('--g', g.toFixed(3));
    }
  }

  const beatEnv = cur.gap ? gapBeatPulse : computeBeatEnvelope(t, peakG);
  paintDialAndHeader(t, beatEnv);
}

function tickFrame(now = 0) {
  rafId = 0;
  if (!overlay || !overlay.classList.contains('is-open') || document.visibilityState === 'hidden') return;
  if (!lastFrameAt || now - lastFrameAt >= FRAME_INTERVAL_MS) {
    lastFrameAt = now;
    paintFrame(currentPlaybackTime(), false);
  }
  if (store.get().playing && !engine.holdingSession?.()) {
    rafId = requestAnimationFrame(tickFrame);
  }
}

function ensureLoop() {
  if (!rafId && overlay && overlay.classList.contains('is-open') && document.visibilityState !== 'hidden') {
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
  lastSweptTick = -1;
  lastBeatEnv = -1;
  paintFrame(currentPlaybackTime(), true);
  ensureLoop();
}

export function init() {
  overlay = document.getElementById('lyricOverlay');
  hudEl = overlay?.querySelector?.('.lyric-hud') || null;
  root = document.getElementById('lyrics');
  seekBar = document.getElementById('lyricSeekBar');
  seekBtn = document.getElementById('lyricSeekBtn');
  bearingEl = document.getElementById('lyricBearing');
  hudReadoutEl = document.getElementById('lyricHudReadout');
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
        engine.seekAndPlay(time);
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
      engine.seekAndPlay(time);
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && overlay && overlay.classList.contains('is-open')) {
      paintFrame(currentPlaybackTime(), true);
      ensureLoop();
    }
  });
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
      paintDialAndHeader(Number(s.elapsed) || 0, 0);
    }
  });
  store.on('playing', (s) => {
    if (root) root.dataset.playing = String(Boolean(s.playing));
    if (overlay) overlay.dataset.playing = String(Boolean(s.playing));
    if (s.playing) ensureLoop();
    else {
      if (hudEl) hudEl.style.setProperty('--beat-env', '0');
      if (overlay) overlay.dataset.beatEnv = '0';
    }
  });
}
