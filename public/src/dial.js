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
const R_ARC = 157;
const R_BARB = 151;
const TICKS = 60;
const BARBS = 48;
const BLADES = 8;
const R_HUB = 122; // cover disc, flush with the inner bezel

const polar = (deg, radius) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + Math.cos(a) * radius, C + Math.sin(a) * radius];
};

let els = {};
let spin = 0; // turbine angle, accumulated only while playing
let lastFrame = 0;
let dragging = false;
let settling = false;
let settleTimer = 0;
let barbNodes = [];
let raf = 0;

/* --------------------------------- geometry -------------------------------- */

function buildTicks() {
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < TICKS; i++) {
    const major = i % 5 === 0;
    const [x1, y1] = polar(i * (360 / TICKS), major ? 133 : 140);
    const [x2, y2] = polar(i * (360 / TICKS), 148);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('class', major ? 'dial__tick dial__tick--major' : 'dial__tick');
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
function drawBarbs(playing) {
  const data = playing ? engine.spectrum() : null;
  for (let i = 0; i < barbNodes.length; i++) {
    const b = barbNodes[i];
    let target = 1.5;
    if (data) {
      // Fold the spectrum symmetrically so both halves of the dial mirror.
      const half = barbNodes.length / 2;
      const bin = Math.floor(((i < half ? i : barbNodes.length - i) / half) * (data.length * 0.7));
      target = 2 + (data[bin] / 255) * 22;
    }
    b.level += (target - b.level) * 0.32; // ease so the ring breathes rather than flickers
    const [x2, y2] = polar(b.deg, R_BARB + b.level);
    b.node.setAttribute('x2', x2.toFixed(2));
    b.node.setAttribute('y2', y2.toFixed(2));
  }
}

function frame(ts) {
  raf = requestAnimationFrame(frame);
  const s = store.get();
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0;
  lastFrame = ts;

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

  drawBarbs(s.playing);
}

/* -------------------------------- interaction ------------------------------ */

function bearingFromEvent(e) {
  const rect = els.svg.getBoundingClientRect();
  const x = e.clientX - rect.left - rect.width / 2;
  const y = e.clientY - rect.top - rect.height / 2;
  return ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360;
}

function announce(deg) {
  const pct = Math.round((deg / 360) * 100);
  els.svg.setAttribute('aria-valuenow', String(pct));
  els.svg.setAttribute('aria-valuetext', `${pct} percent, bearing ${Math.round(deg)} degrees`);
}

function bindDrag() {
  const svg = els.svg;

  svg.addEventListener('pointerdown', (e) => {
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
    els.bearing.textContent = `${String(Math.round(deg)).padStart(3, '0')}°`;
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    svg.classList.remove('is-dragging');
    engine.seekBearing(bearingFromEvent(e));
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', () => {
    dragging = false;
    svg.classList.remove('is-dragging');
  });

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

function setCover(url) {
  if (!url) {
    els.cover.removeAttribute('href');
    return;
  }
  els.cover.setAttribute('href', coverUrl(url, 220));
}

/** A cover that fails to load leaves the hub as bare metal rather than a gap. */
function bindCoverFallback() {
  els.cover.addEventListener('error', () => els.cover.removeAttribute('href'));
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

  store.on(['elapsed', 'duration'], () => {
    if (dragging) return;
    const s = store.get();
    els.elapsed.textContent = fmt(s.elapsed);
    els.duration.textContent = fmt(s.duration);
    const deg = store.bearing();
    els.bearing.textContent = `${String(Math.round(deg)).padStart(3, '0')}°`;
    announce(deg);
  });

  store.on('track', () => {
    const t = store.get().track;
    setCover(t?.cover);
    settle();
  });

  raf = requestAnimationFrame(frame);
}

export function stop() {
  cancelAnimationFrame(raf);
}
