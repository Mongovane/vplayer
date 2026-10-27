/**
 * lyrics.js — the timed lyric column with GPU-smooth flowing wave tide & manual seek aim line.
 *
 * Behaviour worth naming: when you scroll the lyrics yourself, auto-follow
 * releases for four seconds and shows a centre aim line with the cue timestamp.
 * Tapping a line (or the aim pill) seeks to it. Long-pressing a line opens the
 * nautical lyric postcard generator for that line.
 */

import * as store from './store.js';
import * as engine from './engine.js';

let root = null;
let seekBar = null;
let seekBtn = null;
let sharedWave = null;
let nodes = [];
let follow = true;
let releaseTimer = 0;
let lastActive = -1;
let seekTargetIdx = -1;
let holdTimer = 0;
let holdFired = false;

/** mm:ss for a lyric line's cue point. */
function stamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function getSharedWave() {
  if (sharedWave) return sharedWave;
  const beam = document.createElement('span');
  beam.className = 'lyric__beam';
  beam.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('i');
  fill.className = 'lyric__beam-fill';
  beam.append(fill);
  sharedWave = beam;
  return beam;
}

function build(lines) {
  root.textContent = '';
  nodes = [];
  hideSeekBar();

  if (!lines.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<strong>没有歌词</strong>这首歌上游没有提供';
    root.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  lines.forEach((line, i) => {
    const el = document.createElement('p');
    el.className = 'lyric';
    el.dataset.index = String(i);

    const time = document.createElement('span');
    time.className = 'lyric__time';
    time.textContent = stamp(line.time);
    el.append(time);

    const body = document.createElement('span');
    body.className = 'lyric__body';

    // Inline character-by-character shimmer spans — textContent only for safety.
    const main = document.createElement('span');
    main.className = 'lyric__words';
    const rawWords = String(line.words || '');
    const chars = Array.from(rawWords);
    const totalChars = Math.max(1, chars.length);
    const charDurRatio = Math.max(0.14, Math.min(0.32, 2.2 / totalChars));
    chars.forEach((ch, idx) => {
      const span = document.createElement('span');
      span.className = 'lyric__ch';
      span.textContent = ch;
      const pos = totalChars > 1 ? idx / totalChars : 0;
      span.style.setProperty('--ch-pos', pos.toFixed(4));
      span.style.setProperty('--ch-dur', charDurRatio.toFixed(4));
      main.append(span);
    });
    body.append(main);

    // Romanisation sits above the translation: it reads with the original line,
    // the translation reads after it.
    for (const [text, cls] of [
      [line.roma, 'lyric__roma'],
      [line.trans, 'lyric__trans'],
    ]) {
      if (!text) continue;
      const side = document.createElement('span');
      side.className = cls;
      side.textContent = text;
      body.append(side);
    }

    el.append(body);
    frag.append(el);
    nodes.push(el);
  });

  root.append(frag);
  lastActive = -1;
}

function attachWaveToActive(index) {
  const s = store.get();
  const el = nodes[index];
  if (!el || !s.lyrics[index]) return;
  const start = s.lyrics[index].time || 0;
  const nextTime = s.lyrics[index + 1]?.time ?? (s.duration > start ? s.duration : start + 4);
  const total = Math.max(0.8, Math.min(12.0, nextTime - start));
  const elapsedInLine = Math.max(0, Math.min(total - 0.05, (s.elapsed || start) - start));
  const remain = Math.max(0.6, total - elapsedInLine);
  el.style.setProperty('--lyric-dur', `${total.toFixed(2)}s`);
  el.style.setProperty('--lyric-delay', `${(-elapsedInLine).toFixed(2)}s`);
  el.style.setProperty('--lyric-remain', `${remain.toFixed(2)}s`);

  const words = el.querySelector('.lyric__words');
  if (words) {
    words.classList.remove('is-streaming');
    void words.offsetWidth;
    words.classList.add('is-streaming');
    const wave = getSharedWave();
    wave.classList.remove('is-flowing');
    words.after(wave);
    void wave.clientWidth;
    wave.classList.add('is-flowing');
  }
}

function highlight(index) {
  if (index === lastActive) return;

  // Clear the previous neighbourhood before lighting the new one.
  for (const offset of [-1, 0, 1]) {
    const prevNode = nodes[lastActive + offset];
    if (prevNode) {
      prevNode.classList.remove('is-active', 'is-near');
      prevNode.style.removeProperty('--lyric-dur');
      prevNode.style.removeProperty('--lyric-delay');
      prevNode.style.removeProperty('--lyric-remain');
      prevNode.querySelector('.lyric__words')?.classList.remove('is-streaming');
    }
  }

  nodes[index - 1]?.classList.add('is-near');
  nodes[index + 1]?.classList.add('is-near');

  const el = nodes[index];
  if (el) {
    el.classList.add('is-active');
    attachWaveToActive(index);
    if (follow) {
      root.scrollTo({
        top: el.offsetTop - root.clientHeight / 2 + el.offsetHeight / 2,
        behavior: 'smooth',
      });
    }
  }
  lastActive = index;
}

function hideSeekBar() {
  if (seekBar) seekBar.hidden = true;
  if (seekTargetIdx >= 0 && nodes[seekTargetIdx]) {
    nodes[seekTargetIdx].classList.remove('is-seek-target');
  }
  seekTargetIdx = -1;
}

function updateSeekTarget() {
  if (!root || !nodes.length || follow) return;
  const center = root.scrollTop + root.clientHeight / 2;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const mid = n.offsetTop + n.offsetHeight / 2;
    const d = Math.abs(mid - center);
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
  const line = store.get().lyrics[bestIdx];
  if (line && seekBar && seekBtn) {
    seekBar.hidden = false;
    seekBtn.textContent = `▶ ${stamp(line.time)} · 跳播`;
  }
}

function releaseFollow() {
  if (!store.get().lyrics.length) return;
  follow = false;
  updateSeekTarget();
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    follow = true;
    hideSeekBar();
    highlightNow();
  }, 4000);
}

function highlightNow() {
  const { lyricIndex } = store.get();
  if (lyricIndex >= 0) {
    lastActive = -1; // force a re-centre after follow resumes
    highlight(lyricIndex);
  }
}

export function sync() {
  follow = true;
  clearTimeout(releaseTimer);
  hideSeekBar();
  highlightNow();
}

export function init() {
  root = document.getElementById('lyrics');
  seekBar = document.getElementById('lyricSeekBar');
  seekBtn = document.getElementById('lyricSeekBtn');

  if (seekBtn) {
    seekBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = seekTargetIdx;
      const time = store.get().lyrics[idx]?.time;
      if (Number.isFinite(time)) {
        engine.seek(time);
      }
      follow = true;
      clearTimeout(releaseTimer);
      hideSeekBar();
      highlightNow();
    });
  }

  root.addEventListener('pointerdown', (e) => {
    const line = e.target.closest('.lyric');
    if (!line) return;
    holdFired = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdFired = true;
      const i = Number(line.dataset.index);
      root.dispatchEvent(new CustomEvent('lyric:postcard', { detail: { index: i } }));
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
    const i = Number(line.dataset.index);
    const time = store.get().lyrics[i]?.time;
    if (Number.isFinite(time)) {
      engine.seek(time);
      follow = true;
      clearTimeout(releaseTimer);
      hideSeekBar();
    }
  });

  // Only user-driven scrolling releases follow; programmatic scrollTo does not
  // fire wheel/touchmove, so this stays clean.
  root.addEventListener('wheel', releaseFollow, { passive: true });
  root.addEventListener('touchmove', releaseFollow, { passive: true });
  root.addEventListener('scroll', () => {
    if (!follow) updateSeekTarget();
  }, { passive: true });

  let lastSyncElapsed = 0;
  store.on('lyrics', (s) => build(s.lyrics));
  store.on('lyricIndex', (s) => {
    lastSyncElapsed = s.elapsed || 0;
    highlight(s.lyricIndex);
  });
  store.on('elapsed', (s) => {
    const cur = s.elapsed || 0;
    if (Math.abs(cur - lastSyncElapsed) > 0.85 && lastActive >= 0) {
      attachWaveToActive(lastActive);
    }
    lastSyncElapsed = cur;
  });
  store.on('playing', (s) => {
    if (root) root.dataset.playing = String(Boolean(s.playing));
  });
}
