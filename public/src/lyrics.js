/**
 * lyrics.js — the timed lyric column.
 *
 * Behaviour worth naming: when you scroll the lyrics yourself, auto-follow
 * releases for four seconds. The old build re-centred on every timeupdate, so
 * reading ahead was impossible. Tapping a line seeks to it.
 */

import * as store from './store.js';
import * as engine from './engine.js';

let root = null;
let nodes = [];
let follow = true;
let releaseTimer = 0;
let lastActive = -1;

/** mm:ss for a lyric line's cue point. */
function stamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function build(lines) {
  root.textContent = '';
  nodes = [];

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

    // textContent only — lyrics are untrusted upstream text.
    const main = document.createElement('span');
    main.textContent = line.words;
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

function highlight(index) {
  if (index === lastActive) return;
  if (nodes[lastActive]) nodes[lastActive].classList.remove('is-active');
  const el = nodes[index];
  if (el) {
    el.classList.add('is-active');
    if (follow) {
      root.scrollTo({
        top: el.offsetTop - root.clientHeight / 2 + el.offsetHeight / 2,
        behavior: 'smooth',
      });
    }
  }
  lastActive = index;
}

function releaseFollow() {
  follow = false;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    follow = true;
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

export function init() {
  root = document.getElementById('lyrics');

  root.addEventListener('click', (e) => {
    const line = e.target.closest('.lyric');
    if (!line) return;
    const i = Number(line.dataset.index);
    const time = store.get().lyrics[i]?.time;
    if (Number.isFinite(time)) {
      engine.seek(time);
      follow = true;
      clearTimeout(releaseTimer);
    }
  });

  // Only user-driven scrolling releases follow; programmatic scrollTo does not
  // fire wheel/touchmove, so this stays clean.
  root.addEventListener('wheel', releaseFollow, { passive: true });
  root.addEventListener('touchmove', releaseFollow, { passive: true });

  store.on('lyrics', (s) => build(s.lyrics));
  store.on('lyricIndex', (s) => highlight(s.lyricIndex));
}
