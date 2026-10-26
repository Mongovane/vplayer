/**
 * dial.js — the signature control.
 *
 * One widget replaces three from the old build: album art, progress bar, and
 * the canvas visualiser. A full revolution is the length of the track, so the
 * pointer's bearing *is* the playhead. Dragging it seeks. The turbine hub
 * carries the cover and freezes mid-rotation on pause, because a stopped vane
 * holds its bearing rather than snapping back to north.
 */

import * as store from './store.js';
import * as engine from './engine.js';
import { coverUrl } from './api.js';

const C = 170; // dial centre in viewBox units
const R_ARC = 163;
const R_BARB = 169;
const TICKS = 72;
const BARBS = 48;
const BLADES = 8;
const R_HUB = 94; // cover disc (inset ~27%)
const R_DEADZONE = 94;

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const fmtBearing = (deg) => {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  const dir = DIRS[Math.round(d / 45) % 8];
  return `${dir} ${String(d).padStart(3, '0')}°`;
};

const polar = (deg, radius) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + Math.cos(a) * radius, C + Math.sin(a) * radius];
};

let els = {};
let spin = 0; // turbine angle, accumulated only while playing
let lastFrame = 0;
let dragging = false;
let settling = false;

/**
 * Gestures on the hub. The ring already owns drag-to-seek, so a swipe there
 * would fight it — but the dead centre does nothing, and the split matches what
 * the two parts mean: the ring is time, the cover is the song.
 */
const SWIPE_MIN = 48;
const SWIPE_MAX_OFF_AXIS = 40;
let gesture = null;
let lastHubTap = 0;
let hubTapTimer = 0;
let settleTimer = 0;
let barbNodes = [];
let raf = 0;

/* --------------------------------- geometry -------------------------------- */

function buildTicks() {
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 72; i++) {
    const major = i % 6 === 0;
    const deg = i * 5;
    const [x1, y1] = polar(deg, major ? 142 : 148);
    const [x2, y2] = polar(deg, 159);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('class', major ? 'dial__tick dial__tick--major' : 'dial__tick');
    frag.append(line);
  }
  for (let i = 0; i < 12; i++) {
    const deg = i * 30;
    const [x1, y1] = polar(deg, 102);
    const [x2, y2] = polar(deg, 109);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('class', 'dial__tick--inner');
    frag.append(line);
  }
  els.ticks.append(frag);
}

function buildBlades() {
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < BLADES; i++) {
    const base = i * (360 / BLADES);
    const [x1, y1] = polar(base, R_HUB);
    const [x2, y2] = polar(base + 26, R_HUB);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', `M${C} ${C} L${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} Z`);
    p.setAttribute('class', 'dial__blade');
    frag.append(p);
  }
  els.blades.append(frag);
}

function buildBarbs() {
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  barbNodes = [];
  for (let i = 0; i < BARBS; i++) {
    const line = document.createElementNS(ns, 'line');
    const [x1, y1] = polar(i * (360 / BARBS), R_BARB);
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x1.toFixed(2));
    line.setAttribute('y2', y1.toFixed(2));
    line.setAttribute('class', 'dial__barb');
    frag.append(line);
    barbNodes.push({ node: line, deg: i * (360 / BARBS), level: 0 });
  }
  els.barbs.append(frag);
}

/* ---------------------------------- drawing -------------------------------- */

function drawArc(deg) {
  if (deg < 0.4) {
    els.arc.setAttribute('d', '');
    return;
  }
  if (deg >= 359.6) {
    // A full circle can't be drawn as one arc; two halves avoid the degenerate case.
    els.arc.setAttribute(
      'd',
      `M ${C} ${C - R_ARC} A ${R_ARC} ${R_ARC} 0 1 1 ${C} ${C + R_ARC} A ${R_ARC} ${R_ARC} 0 1 1 ${C} ${C - R_ARC}`
    );
    return;
  }
  const [x, y] = polar(deg, R_ARC);
  els.arc.setAttribute(
    'd',
    `M ${C} ${C - R_ARC} A ${R_ARC} ${R_ARC} 0 ${deg > 180 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`
  );
}

function drawVane(deg) {
  els.vane.setAttribute('transform', `rotate(${deg.toFixed(2)} ${C} ${C})`);
}

/**
 * Barbs read the spectrum when the analyser is live; otherwise they idle at a
 * flat minimum so the bezel never looks broken.
 */
let windPhase = 0;

/**
 * The outer ring while sound is playing.
 *
 * Where an analyser is available the barbs follow the spectrum. Where it is not
 * — iOS, where routing through Web Audio would cost background playback — they
 * follow a travelling wave instead. That is wind, not sound: deliberately smooth
 * and periodic so it never passes itself off as a reading of the audio, while
 * still saying at a glance that something is playing, which a dead ring did not.
 */
function drawBarbs(playing, dt) {
  const data = playing ? engine.spectrum() : null;
  if (playing && !data) windPhase += dt * 1.6;

  const half = barbNodes.length / 2;
  for (let i = 0; i < barbNodes.length; i++) {
    const b = barbNodes[i];
    let target = 1.5;

    if (data) {
      // Fold the spectrum symmetrically so both halves of the dial mirror.
      const bin = Math.floor(((i < half ? i : barbNodes.length - i) / half) * (data.length * 0.7));
      target = 2 + (data[bin] / 255) * 18;
    } else if (playing) {
      // Two gusts of different periods travelling round the ring.
      const a = (i / barbNodes.length) * Math.PI * 2;
      const gust = Math.sin(a * 3 - windPhase) * 0.6 + Math.sin(a * 5 + windPhase * 0.7) * 0.4;
      target = 3 + (gust + 1) * 5;
    }

    b.level += (target - b.level) * 0.22;
    const [x2, y2] = polar(b.deg, R_BARB + b.level);
    b.node.setAttribute('x2', x2.toFixed(2));
    b.node.setAttribute('y2', y2.toFixed(2));
  }
}

/**
 * Frames are only worth spending when something is actually moving. The loop
 * used to run forever — 48 barb attributes rewritten every frame while paused,
 * which costs nothing visible and real battery on a phone. It now stops once
 * the ring has settled and is woken by whatever changed.
 */
let idleFrames = 0;

export function wake() {
  idleFrames = 0;
  if (!raf) {
    lastFrame = 0;
    raf = requestAnimationFrame(frame);
  }
}

function frame(ts) {
  const s = store.get();
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0;
  lastFrame = ts;

  const settled = barbNodes.every((b) => Math.abs(b.level - 1.5) < 0.05);
  // Face-down there is nothing to draw, whatever is playing.
  const visible = !els.svg.closest('.dialwrap')?.classList.contains('is-flipped');
  const busy = visible && (s.playing || dragging || settling || !settled);
  // A short grace period keeps a fresh pause from cutting the ring's decay off.
  idleFrames = busy ? 0 : idleFrames + 1;
  if (idleFrames > 12) {
    raf = 0;
    return;
  }
  raf = requestAnimationFrame(frame);

  // The turbine only turns while sound is coming out.
  if (s.playing) {
    spin = (spin + dt * 20) % 360;
    els.hub.setAttribute('transform', `rotate(${spin.toFixed(2)} ${C} ${C})`);
  }

  // While the pointer is settling into a new bearing, the CSS transition owns
  // the transform. Writing it again every frame would restart the transition
  // 60 times a second, which reads as the needle juddering rather than swinging.
  if (!dragging && !settling) {
    const deg = store.bearing();
    drawArc(deg);
    drawVane(deg);
  }

  drawBarbs(s.playing, dt);
}

/* -------------------------------- interaction ------------------------------ */

function bearingFromEvent(e) {
  const rect = els.svg.getBoundingClientRect();
  const x = e.clientX - rect.left - rect.width / 2;
  const y = e.clientY - rect.top - rect.height / 2;
  return ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360;
}

/** Distance from the dial centre, in viewBox units. */
function radiusFromEvent(e) {
  const rect = els.svg.getBoundingClientRect();
  const x = e.clientX - rect.left - rect.width / 2;
  const y = e.clientY - rect.top - rect.height / 2;
  // The viewBox is 384 wide and drawn into rect.width, so scale back.
  const scale = 384 / (rect.width || 1);
  return Math.hypot(x, y) * scale;
}

function announce(deg) {
  const pct = Math.round((deg / 360) * 100);
  els.svg.setAttribute('aria-valuenow', String(pct));
  els.svg.setAttribute('aria-valuetext', `${pct} percent, bearing ${Math.round(deg)} degrees`);
}

function bindDrag() {
  const svg = els.svg;

  svg.addEventListener('pointerdown', (e) => {
    const navNode = e.target.closest?.('[data-dial-nav]');
    if (navNode) return;
    if (radiusFromEvent(e) < R_DEADZONE) {
      gesture = { x: e.clientX, y: e.clientY, t: performance.now() };
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      return;
    }
    if (!store.get().duration) return;
    dragging = true;
    settling = false;
    els.vane.classList.remove('is-settling');
    clearTimeout(settleTimer);
    svg.classList.add('is-dragging');
    svg.setPointerCapture(e.pointerId);
    const deg = bearingFromEvent(e);
    drawArc(deg);
    drawVane(deg);
    announce(deg);
  });

  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const deg = bearingFromEvent(e);
    drawArc(deg);
    drawVane(deg);
    announce(deg);
    els.elapsed.textContent = fmt((deg / 360) * store.get().duration);
    els.bearing.textContent = fmtBearing(deg);
  });

  const finish = (e) => {
    if (gesture) {
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      const dt = performance.now() - gesture.t;
      const quick = dt < 700;
      gesture = null;

      if (quick && Math.abs(dx) > SWIPE_MIN && Math.abs(dy) < SWIPE_MAX_OFF_AXIS) {
        // Swiping the cover the way the queue runs: left reveals what is next.
        if (dx < 0) engine.next();
        else engine.prev();
        navigator.vibrate?.(8);
        return;
      }
      // A clean tap on the cover hub turns the instrument over to its lyric
      // face; a double-tap favourites the playing track with a heart burst.
      if (dt < 350 && Math.hypot(dx, dy) < 10) {
        const now = performance.now();
        if (now - lastHubTap < 270) {
          clearTimeout(hubTapTimer);
          lastHubTap = 0;
          navigator.vibrate?.(12);
          svg.dispatchEvent(new CustomEvent('dial:doubletap'));
        } else {
          lastHubTap = now;
          clearTimeout(hubTapTimer);
          hubTapTimer = setTimeout(() => {
            lastHubTap = 0;
            svg.dispatchEvent(new CustomEvent('dial:tap'));
          }, 240);
        }
        return;
      }
    }

    if (!dragging) return;
    dragging = false;
    svg.classList.remove('is-dragging');
    engine.seekBearing(bearingFromEvent(e));
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', () => {
    dragging = false;
    gesture = null;
    svg.classList.remove('is-dragging');
  });

  // Hover preview. Dragging owns the pointer, so this only runs when idle.
  svg.addEventListener('pointermove', (e) => {
    if (dragging || e.pointerType === 'touch') return;
    const { duration } = store.get();
    if (!duration) return;
    if (radiusFromEvent(e) < R_DEADZONE) {
      els.ghost.classList.remove('is-on');
      els.tip.hidden = true;
      return;
    }
    const deg = bearingFromEvent(e);
    els.ghost.setAttribute('transform', `rotate(${deg.toFixed(2)} ${C} ${C})`);
    els.ghost.classList.add('is-on');

    const host = els.tip.offsetParent?.getBoundingClientRect();
    if (host) {
      els.tip.style.left = `${e.clientX - host.left}px`;
      els.tip.style.top = `${e.clientY - host.top}px`;
    }
    els.tip.textContent = fmt((deg / 360) * duration);
    els.tip.hidden = false;
  });

  const clearPreview = () => {
    els.ghost.classList.remove('is-on');
    els.tip.hidden = true;
  };
  svg.addEventListener('pointerleave', clearPreview);
  svg.addEventListener('pointermove', (e) => {
    if (dragging) return;
    svg.style.cursor = radiusFromEvent(e) < R_DEADZONE ? 'default' : 'grab';
  });
  svg.addEventListener('pointerdown', clearPreview);

  // Keyboard: the dial is a slider, so arrows nudge and Home/End jump.
  svg.addEventListener('keydown', (e) => {
    const { duration, elapsed } = store.get();
    if (!duration) return;
    const step = e.shiftKey ? 30 : 5;
    const map = {
      ArrowRight: elapsed + step,
      ArrowUp: elapsed + step,
      ArrowLeft: elapsed - step,
      ArrowDown: elapsed - step,
      Home: 0,
      End: duration - 1,
    };
    if (!(e.key in map)) return;
    e.preventDefault();
    engine.seek(map[e.key]);
  });
}

/* ----------------------------------- cover --------------------------------- */

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

const loadedDialCovers = new Set();
let coverReqId = 0;
let lastCoverUrl = '';

const HUES = [195, 150, 225, 20, 275, 95, 340, 200];
export function trackHue(t) {
  if (!t) return 195;
  if (typeof t.h === 'number') return t.h;
  const str = String(t.name || t.id || '');
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum = (sum * 31 + str.charCodeAt(i)) >>> 0;
  return HUES[sum % HUES.length];
}

function updateCoverHue(img, fallbackHue) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    r /= 64; g /= 64; b /= 64;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 12) return;
    const dl = mx - mn;
    const h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
    const deg = Math.round((h * 60 + 360) % 360);
    document.documentElement.style.setProperty('--h', String(deg));
  } catch {
    document.documentElement.style.setProperty('--h', String(fallbackHue));
  }
}

function setCover(url) {
  const curTrack = store.get().track;
  const baseHue = trackHue(curTrack);
  document.documentElement.style.setProperty('--h', String(baseHue));
  const cvEl = document.getElementById('dialCv');
  if (!url) {
    coverReqId += 1;
    els.svg?.classList.remove('has-cover');
    els.cover.removeAttribute('href');
    if (cvEl) cvEl.style.backgroundImage = '';
    lastCoverUrl = '';
    return;
  }
  const full = coverUrl(url, 512);
  if (full === lastCoverUrl && els.cover.getAttribute('href') === full) {
    return;
  }
  lastCoverUrl = full;
  const reqId = ++coverReqId;

  if (loadedDialCovers.has(full)) {
    els.cover.setAttribute('href', full);
    els.svg?.classList.add('has-cover');
    return;
  }

  // Show the crisp inline SVG vector emblem (#dialFallbackArt + #dialBlades)
  // while the 512px cover decodes, then reveal the cover without a blank flash.
  els.svg?.classList.remove('has-cover');
  els.cover.setAttribute('href', full);

  if (typeof Image === 'function') {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedDialCovers.add(full);
      if (reqId === coverReqId) {
        els.svg?.classList.add('has-cover');
        updateCoverHue(img, baseHue);
      }
    };
    img.onerror = () => {
      if (reqId === coverReqId) {
        els.svg?.classList.remove('has-cover');
        els.cover.removeAttribute('href');
        lastCoverUrl = '';
      }
    };
    img.src = full;
  }
}

function bindCoverFallback() {
  els.cover.addEventListener('load', () => {
    const href = els.cover.getAttribute('href');
    if (href) {
      loadedDialCovers.add(href);
      els.svg?.classList.add('has-cover');
    }
  });
  els.cover.addEventListener('error', () => {
    els.svg?.classList.remove('has-cover');
    els.cover.removeAttribute('href');
    lastCoverUrl = '';
  });
}

/**
 * On track change the pointer swings to the new bearing and settles. The
 * transition drives it for the duration; the frame loop stands off until then.
 */
function settle() {
  settling = true;
  els.vane.classList.add('is-settling');
  const deg = store.bearing();
  drawArc(deg);
  drawVane(deg);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    els.vane.classList.remove('is-settling');
    settling = false;
  }, 700);
}

/* ------------------------------------ init --------------------------------- */

export function init() {
  els = {
    svg: document.getElementById('dial'),
    ticks: document.getElementById('dialTicks'),
    barbs: document.getElementById('dialBarbs'),
    blades: document.getElementById('dialBlades'),
    arc: document.getElementById('dialArc'),
    hub: document.getElementById('dialHub'),
    vane: document.getElementById('dialVane'),
    ghost: document.getElementById('dialGhost'),
    tip: document.getElementById('dialTip'),
    cover: document.getElementById('dialCover'),
    elapsed: document.getElementById('elapsed'),
    bearing: document.getElementById('bearing'),
    duration: document.getElementById('duration'),
  };

  buildTicks();
  buildBlades();
  buildBarbs();
  bindDrag();
  bindCoverFallback();

  let showRemaining = false;
  try {
    showRemaining = localStorage.getItem('vplayer:clockRemain') === '1';
  } catch {}
  const paintDuration = (s) => {
    if (showRemaining && s.duration > 0) {
      els.duration.textContent = `-${fmt(Math.max(0, s.duration - s.elapsed))}`;
      els.duration.title = '点击切换为总时长';
    } else {
      els.duration.textContent = fmt(s.duration);
      els.duration.title = '点击切换为剩余时长';
    }
  };
  if (els.duration) {
    els.duration.style.cursor = 'pointer';
    els.duration.addEventListener('click', (e) => {
      e.stopPropagation();
      showRemaining = !showRemaining;
      try {
        localStorage.setItem('vplayer:clockRemain', showRemaining ? '1' : '0');
      } catch {}
      paintDuration(store.get());
    });
  }

  store.on(['elapsed', 'duration'], () => {
    if (dragging) return;
    const s = store.get();
    els.elapsed.textContent = fmt(s.elapsed);
    paintDuration(s);
    const deg = store.bearing();
    els.bearing.textContent = fmtBearing(deg);
    announce(deg);
  });

  store.on('track', () => {
    const t = store.get().track;
    setCover(t?.cover);
    settle();
  });

  // Anything that can put the dial in motion has to be able to restart the loop.
  store.on(['playing', 'elapsed', 'duration', 'track'], wake);
  els.svg.addEventListener('pointerdown', wake);
  els.svg.addEventListener('pointermove', wake);

  wake();
}

export function stop() {
  cancelAnimationFrame(raf);
}
