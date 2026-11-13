/**
 * VPlayer · Vane — 3D Lanyard Music Pass & Interactive Stage (`public/src/lanyard.js`)
 *
 * Pure Vanilla ES Module port of React Bits `<Lanyard />` combined with the
 * exact laminated PVC card, guilloche portal, satin wave backplate, and 3D woven
 * strap UI/textures from https://github.com/fanhuayishiy/ai-crew-pass
 * (`https://badge.fhysy.com/characters/doubao/`), adapted 100% for VPlayer music
 * playback without any AI model names or descriptions.
 *
 * Interactive Physics Gestures (Main Stage & Modal):
 * 1. Horizontal Fling to Skip (`甩动切歌`): Drag/fling the card left or right
 *    past threshold to trigger `next()` / `prev()` with spring rebound.
 * 2. Vertical Pull-Cord Play/Pause (`下拉挂绳播放/暂停`): Pull the card straight
 *    down to stretch the woven strap and release to toggle playback.
 * 3. Tap to Flip (`轻点翻面`): Spins the card 180° between Front (Cover + Live
 *    Lyric Quote + Progress Ring) and Back (5-Line Live Lyrics + Audio Specs).
 * 4. Double-Tap to Favorite (`双击红心收藏`).
 */

const CARD_SIZES = {
  portrait: [1.6, 2.25],
  landscape: [2.25, 1.6],
};
const ANCHORS = { left: 0.27, center: 0.5, right: 0.73 };
const THICKNESS = 0.018;
const BEVEL = 0.007;
const JOINTS = 4;
const NODE_WEIGHT = 1 / 0.05;
const MAX_STEP = 1 / 960;
// A slow frame has a larger dt, which used to mean more substeps, which made
// the next frame slower still. Capping the count trades a little rigidity on a
// bad frame for not spiralling.
const MAX_SUBSTEPS = 20;
// Seconds of no touch before the idle breeze fades out and the loop is allowed
// to go to sleep. Without this the sway kept a full 60fps redraw running for as
// long as the page was open.
const IDLE_SETTLE_MS = 5000;
const IDLE_FADE_MS = 1500;
const ITERATIONS = 2;
const FOV = 24;
const STRAP_WIDTH = 0.36;
const RING_RADIUS = 0.095;
const FACE_WIDTH = 420;
const FLIP_SPIN = 9;

/**
 * The 9 signature colorways & material palettes extracted directly from
 * `fanhuayishiy/ai-crew-pass`, stripped of all AI character names/descriptions
 * so only the pure editorial UI and color textures remain.
 */
export const PASS_THEMES = {
  crimson: {
    id: 'crimson',
    name: '绯红',
    enName: 'VANE',
    serial: 'NO. VP-01',
    strapWord: 'VANE AUDIO',
    themeColor: '#b9343c',
    accentColor: '#e0314b',
    paperColor: '#f8f3f4',
    inkColor: '#27171b',
    hairColor: '#4a2e2b',
    scarfColor: '#d92b43',
  },
  cobalt: {
    id: 'cobalt',
    name: '深海',
    enName: 'VANE',
    serial: 'NO. VP-02',
    strapWord: 'VANE AUDIO',
    themeColor: '#4964a0',
    accentColor: '#3b66c4',
    paperColor: '#f3f5fa',
    inkColor: '#162033',
    hairColor: '#26334d',
    scarfColor: '#4964a0',
  },
  lavender: {
    id: 'lavender',
    name: '雾紫',
    enName: 'VANE',
    serial: 'NO. VP-03',
    strapWord: 'VANE AUDIO',
    themeColor: '#9b86bc',
    accentColor: '#8465b5',
    paperColor: '#f7f5fa',
    inkColor: '#221b2e',
    hairColor: '#372e45',
    scarfColor: '#8b6fc0',
  },
  terracotta: {
    id: 'terracotta',
    name: '陶土',
    enName: 'VANE',
    serial: 'NO. VP-04',
    strapWord: 'VANE AUDIO',
    themeColor: '#ba7159',
    accentColor: '#c96442',
    paperColor: '#faf5f2',
    inkColor: '#291c17',
    hairColor: '#52362a',
    scarfColor: '#c96442',
  },
  amethyst: {
    id: 'amethyst',
    name: '星紫',
    enName: 'VANE',
    serial: 'NO. VP-05',
    strapWord: 'VANE AUDIO',
    themeColor: '#9161c6',
    accentColor: '#7c4dff',
    paperColor: '#f6f3fb',
    inkColor: '#211730',
    hairColor: '#36234d',
    scarfColor: '#7c4dff',
  },
  indigo: {
    id: 'indigo',
    name: '群青',
    enName: 'VANE',
    serial: 'NO. VP-06',
    strapWord: 'VANE AUDIO',
    themeColor: '#6669b3',
    accentColor: '#565add',
    paperColor: '#f4f4fa',
    inkColor: '#1b1c30',
    hairColor: '#2b2d52',
    scarfColor: '#565add',
  },
  moonstone: {
    id: 'moonstone',
    name: '月岩',
    enName: 'VANE',
    serial: 'NO. VP-07',
    strapWord: 'VANE AUDIO',
    themeColor: '#7779ad',
    accentColor: '#5e619e',
    paperColor: '#f4f5f9',
    inkColor: '#1d1e2e',
    hairColor: '#2c2e47',
    scarfColor: '#6366a6',
  },
  slate: {
    id: 'slate',
    name: '钛灰',
    enName: 'VANE',
    serial: 'NO. VP-08',
    strapWord: 'VANE AUDIO',
    themeColor: '#575f75',
    accentColor: '#435373',
    paperColor: '#f3f5f8',
    inkColor: '#191d26',
    hairColor: '#282d38',
    scarfColor: '#435373',
  },
  amber: {
    id: 'amber',
    name: '流金',
    enName: 'VANE',
    serial: 'NO. VP-09',
    strapWord: 'VANE AUDIO',
    themeColor: '#ac884b',
    accentColor: '#b8862d',
    paperColor: '#f9f6f0',
    inkColor: '#261f12',
    hairColor: '#3d311b',
    scarfColor: '#b8862d',
  },
};

export const THEME_ORDER = [
  'crimson',
  'cobalt',
  'lavender',
  'terracotta',
  'amethyst',
  'indigo',
  'moonstone',
  'slate',
  'amber',
];

// Backwards-compatible alias mapping old keys and new keys to pure style presets
export const AI_CREW_CHARACTERS = {
  ...PASS_THEMES,
  doubao: PASS_THEMES.crimson,
  deepseek: PASS_THEMES.cobalt,
  gpt: PASS_THEMES.lavender,
  claude: PASS_THEMES.terracotta,
  gemini: PASS_THEMES.amethyst,
  qwen: PASS_THEMES.indigo,
  kimi: PASS_THEMES.moonstone,
  glm: PASS_THEMES.slate,
  grok: PASS_THEMES.amber,
};

export const FINISHES = {
  glossy: {
    label: '高定原卡',
    theme: 'light-pvc',
    roughness: 0.16,
    metalness: 0.04,
    clearcoat: 1,
    foil: 0.0,
    sheen: 0.65,
  },
  holographic: {
    label: '全息闪卡',
    theme: 'light-pvc',
    roughness: 0.24,
    metalness: 0.08,
    clearcoat: 1,
    foil: 0.85,
    sheen: 0.92,
  },
  metallic: {
    label: '流光银卡',
    theme: 'light-pvc',
    roughness: 0.28,
    metalness: 0.35,
    clearcoat: 0.9,
    foil: 0.32,
    sheen: 0.88,
  },
  matte: {
    label: '暗夜黑金',
    theme: 'dark-obsidian',
    roughness: 0.45,
    metalness: 0.18,
    clearcoat: 0.7,
    foil: 0.25,
    sheen: 0.6,
  },
};

export const FINISH_ORDER = ['glossy', 'holographic', 'metallic', 'matte'];

const METALS = {
  silver: { color: '#d9dce2', hi: '#ffffff', mid: '#c4cad4', lo: '#5e6472' },
  gold: { color: '#d8a24a', hi: '#fae5a8', mid: '#d49b3b', lo: '#6e4d16' },
  graphite: { color: '#4d4f55', hi: '#9498a3', mid: '#565963', lo: '#222428' },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;

const hexToRgb = (hex) => {
  const clean = String(hex || '#b9343c').replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const num = parseInt(full, 16) || 0xb9343c;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
};

// These run many times per frame with a handful of distinct inputs, so the
// parsed strings are memoised. The cache is tiny and bounded.
const colourCache = new Map();
const memoColour = (key, build) => {
  let v = colourCache.get(key);
  if (v === undefined) {
    if (colourCache.size > 256) colourCache.clear();
    v = build();
    colourCache.set(key, v);
  }
  return v;
};

const rgbaFromHex = (hex, alpha = 1) =>
  memoColour(`a|${hex}|${alpha}`, () => {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  });

const darkenHex = (hex, factor = 0.7) =>
  memoColour(`d|${hex}|${factor}`, () => {
    const { r, g, b } = hexToRgb(hex);
    return `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`;
  });

/* ---------------------- Lightweight 3D Math Primitives -------------------- */

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone() {
    return new Vec3(this.x, this.y, this.z);
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }
  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  divideScalar(s) {
    return this.multiplyScalar(s !== 0 ? 1 / s : 0);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  length() {
    return Math.hypot(this.x, this.y, this.z);
  }
  setLength(l) {
    return this.normalize().multiplyScalar(l);
  }
  normalize() {
    const l = this.length();
    return l > 1e-12 ? this.divideScalar(l) : this.set(0, 0, 0);
  }
  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  set(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }
  identity() {
    return this.set(0, 0, 0, 1);
  }
  copy(q) {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }
  clone() {
    return new Quat(this.x, this.y, this.z, this.w);
  }
  invert() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w);
    if (l < 1e-12) return this.identity();
    this.x /= l;
    this.y /= l;
    this.z /= l;
    this.w /= l;
    return this;
  }
  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }
  multiply(q) {
    return this.multiplyQuaternions(this, q);
  }
  premultiply(q) {
    return this.multiplyQuaternions(q, this);
  }
  multiplyQuaternions(a, b) {
    const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    return this;
  }
}

export const cardLayout = (orientation = 'portrait', cornerRadius = 0.3) => {
  const [width, height] = CARD_SIZES[orientation] || CARD_SIZES.portrait;
  const radius = mix(0.03, Math.min(width, height) * 0.2, clamp(cornerRadius, 0, 1));
  const slot = { width: 0.34, height: 0.07, y: height / 2 - 0.13 };
  const ringY = height / 2 - 0.055;
  return { width, height, radius, slot, ringY, hangY: ringY + RING_RADIUS };
};

/* ----------------------- XPBD Rope & Rigid Body Physics ------------------- */

const scratch = {
  a: new Vec3(),
  b: new Vec3(),
  c: new Vec3(),
  d: new Vec3(),
  e: new Vec3(),
  f: new Vec3(),
  g: new Vec3(),
  pin: new Vec3(),
  q: new Quat(),
  r: new Quat(),
};

const applyInverseInertia = (body, vector, out) => {
  scratch.r.copy(body.quaternion).invert();
  out.copy(vector).applyQuaternion(scratch.r);
  out.set(
    out.x * body.inverseInertia.x,
    out.y * body.inverseInertia.y,
    out.z * body.inverseInertia.z
  );
  return out.applyQuaternion(body.quaternion);
};

const rotateBody = (q, w) => {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  q.x += 0.5 * (w.x * qw + w.y * qz - w.z * qy);
  q.y += 0.5 * (w.y * qw + w.z * qx - w.x * qz);
  q.z += 0.5 * (w.z * qw + w.x * qy - w.y * qx);
  q.w += 0.5 * (-w.x * qx - w.y * qy - w.z * qz);
  q.normalize();
};

const bodyWeight = (body, r, normal) => {
  const rn = scratch.c.crossVectors(r, normal);
  return 1 / body.mass + rn.dot(applyInverseInertia(body, rn, scratch.d));
};

const pushBody = (body, r, impulse) => {
  body.position.addScaledVector(impulse, 1 / body.mass);
  rotateBody(body.quaternion, applyInverseInertia(body, scratch.e.crossVectors(r, impulse), scratch.f));
};

const solveSegment = (sim, i, h, phys) => {
  const { nodes, body } = sim;
  const a = nodes[i];
  const wa = i === 0 ? 0 : NODE_WEIGHT;
  const last = i === JOINTS - 1;
  const r = scratch.g;
  let b = nodes[i + 1];
  if (last) {
    r.copy(body.hang).applyQuaternion(body.quaternion);
    b = scratch.b.copy(body.position).add(r);
  }
  const delta = scratch.a.subVectors(b, a);
  const length = delta.length();
  const stretch = length - sim.rest;
  if (stretch <= 0 || length < 1e-9) return;
  const normal = delta.divideScalar(length);
  const wb = last ? bodyWeight(body, r, normal) : NODE_WEIGHT;
  const rate = (length - sim.lengths[i]) / h;
  const tension =
    phys.hold * Math.tanh((phys.stiffness * stretch) / phys.hold) +
    phys.spring * stretch +
    phys.bandDamping * Math.max(0, rate);
  const room = tension * h * h - sim.impulses[i];
  if (room <= 0) return;
  const lambda = Math.min(stretch / (wa + wb), room);
  sim.impulses[i] += lambda;
  if (wa) a.addScaledVector(normal, lambda * wa);
  if (last) pushBody(body, r, normal.multiplyScalar(-lambda));
  else b.addScaledVector(normal, -lambda * wb);
};

const solvePin = (body, grab, target) => {
  const r = scratch.g.copy(grab.local).applyQuaternion(body.quaternion);
  const delta = scratch.a.copy(target).sub(body.position).sub(r);
  const distance = delta.length();
  if (distance < 1e-9) return;
  const normal = delta.divideScalar(distance);
  const lambda = distance / bodyWeight(body, r, normal);
  pushBody(body, r, normal.multiplyScalar(lambda));
};

export const createSimulation = () => {
  const vectors = () => Array.from({ length: JOINTS + 1 }, () => new Vec3());
  return {
    nodes: vectors(),
    previous: vectors(),
    velocities: vectors(),
    lengths: new Float64Array(JOINTS),
    impulses: new Float64Array(JOINTS),
    rest: 1,
    anchor: new Vec3(),
    body: {
      position: new Vec3(),
      previous: new Vec3(),
      velocity: new Vec3(),
      quaternion: new Quat(),
      previousQuaternion: new Quat(),
      angular: new Vec3(),
      mass: 1,
      inverseInertia: new Vec3(1, 1, 1),
      hang: new Vec3(),
    },
    grab: null,
    turn: 0,
    twist: 0,
    twistRaw: 0,
    calm: 0,
  };
};

export const configureSimulation = (sim, layout, length) => {
  sim.rest = length / JOINTS;
  const { width, height } = layout;
  const body = sim.body;
  const t = THICKNESS + BEVEL * 2;
  body.mass = 1;
  body.inverseInertia.set(
    12 / (height * height + t * t),
    12 / (width * width + t * t),
    12 / (width * width + height * height)
  );
  body.hang.set(0, layout.hangY, 0);
};

export const placeHanging = (sim, layout, intro) => {
  const { nodes, previous, velocities, body, anchor } = sim;
  nodes[0].copy(anchor);
  for (let i = 1; i <= JOINTS; i++) {
    nodes[i].copy(nodes[i - 1]);
    if (intro) nodes[i].x += sim.rest * 0.82;
    else nodes[i].y -= sim.rest;
  }
  body.quaternion.identity();
  if (intro) body.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.34);
  body.hang.set(0, layout.hangY, 0);
  const offset = scratch.a.copy(body.hang).applyQuaternion(body.quaternion);
  body.position.copy(nodes[JOINTS]).sub(offset);
  body.previous.copy(body.position);
  body.previousQuaternion.copy(body.quaternion);
  body.velocity.set(0, 0, 0);
  body.angular.set(0, 0, 0);
  for (let i = 0; i <= JOINTS; i++) {
    previous[i].copy(nodes[i]);
    velocities[i].set(0, 0, 0);
  }
  sim.lengths.fill(sim.rest);
  sim.turn = 0;
  sim.twist = 0;
  sim.twistRaw = 0;
  sim.calm = 0;
};

export const stepSimulation = (sim, dt, phys, time) => {
  const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / MAX_STEP - 1e-6)));
  const h = dt / steps;
  const { nodes, previous, velocities, body } = sim;
  const windX = phys.breeze * (Math.sin(time * 0.53) * 0.7 + Math.sin(time * 1.31 + 1.7) * 0.3) * 3;
  const windZ = phys.breeze * Math.sin(time * 0.37 + 0.6) * 2;
  const grab = sim.grab;
  const pin = scratch.pin;
  const nodeDrag = Math.exp(-phys.nodeDrag * h);
  const linearDrag = Math.exp(-phys.linearDrag * h);
  const angularDrag = Math.exp(-phys.angularDrag * h);

  for (let s = 0; s < steps; s++) {
    for (let i = 1; i < JOINTS; i++) {
      const v = velocities[i];
      v.y -= phys.gravity * h;
      v.x += windX * h;
      v.z += windZ * h;
      previous[i].copy(nodes[i]);
      nodes[i].addScaledVector(v, h);
    }
    body.previous.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    const q = body.quaternion;
    if (grab) {
      const turn = scratch.q.copy(grab.rotation).multiply(scratch.r.copy(q).invert());
      if (turn.w < 0) turn.set(-turn.x, -turn.y, -turn.z, -turn.w);
      const torque = scratch.a.set(turn.x, turn.y, turn.z).multiplyScalar(2 * phys.grip);
      torque.addScaledVector(body.angular, -phys.gripDamping);
      body.angular.addScaledVector(applyInverseInertia(body, torque, scratch.b), h);
    }
    const up = scratch.a.set(0, 1, 0).applyQuaternion(q);
    const front = scratch.b.set(-up.x * up.z, -up.y * up.z, 1 - up.z * up.z);
    if (front.lengthSq() > 1e-3) {
      const facing = scratch.d.set(0, 0, 1).applyQuaternion(q);
      const raw = Math.atan2(scratch.e.crossVectors(front, facing).dot(up), front.dot(facing));
      let turned = raw - sim.twistRaw;
      if (turned > Math.PI) turned -= Math.PI * 2;
      else if (turned < -Math.PI) turned += Math.PI * 2;
      sim.twist += turned;
      sim.twistRaw = raw;
    }
    if (!grab) {
      const spin = body.angular.dot(up);
      body.angular.addScaledVector(up, (phys.twist * (sim.turn - sim.twist) - phys.twistDamping * spin) * h);
    }
    body.velocity.y -= phys.gravity * h;
    body.velocity.x += windX * 0.35 * h;
    body.velocity.z += windZ * 0.35 * h;
    body.position.addScaledVector(body.velocity, h);
    rotateBody(body.quaternion, scratch.f.copy(body.angular).multiplyScalar(h));
    sim.impulses.fill(0);
    if (grab) pin.lerpVectors(grab.from, grab.target, (s + 1) / steps);
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      for (let i = 0; i < JOINTS; i++) solveSegment(sim, i, h, phys);
      if (grab) solvePin(body, grab, pin);
    }
    for (let i = 1; i < JOINTS; i++) {
      const v = velocities[i].subVectors(nodes[i], previous[i]).divideScalar(h).multiplyScalar(nodeDrag);
      v.multiplyScalar(1 / (1 + phys.nodeAir * v.length() * h));
    }
    body.velocity.subVectors(body.position, body.previous).divideScalar(h);
    const dq = scratch.q.copy(body.previousQuaternion).invert().premultiply(body.quaternion);
    body.angular.set(dq.x, dq.y, dq.z).multiplyScalar((2 / h) * (dq.w < 0 ? -1 : 1));
    const normal = scratch.a.set(0, 0, 1).applyQuaternion(body.quaternion);
    const across = body.velocity.dot(normal);
    const along = scratch.b.copy(body.velocity).addScaledVector(normal, -across);
    along.multiplyScalar(1 / (1 + phys.air * along.length() * h));
    body.velocity
      .copy(along)
      .addScaledVector(normal, across / (1 + phys.broadside * Math.abs(across) * h))
      .multiplyScalar(linearDrag);
    body.angular.multiplyScalar(angularDrag / (1 + phys.spinAir * body.angular.length() * h));
    if (body.velocity.lengthSq() > 3600) body.velocity.setLength(60);
    if (body.angular.lengthSq() > 1600) body.angular.setLength(40);
    nodes[JOINTS].copy(body.hang).applyQuaternion(body.quaternion).add(body.position);
    for (let i = 0; i < JOINTS; i++) sim.lengths[i] = nodes[i].distanceTo(nodes[i + 1]);
  }
  if (grab) grab.from.copy(grab.target);
  let energy = body.velocity.lengthSq() + body.angular.lengthSq() * 0.3;
  for (let i = 1; i < JOINTS; i++) energy += velocities[i].lengthSq() * 0.05;
  sim.calm = energy < 2e-4 ? sim.calm + dt : 0;
};

/* ---------- Card Face Synthesizer (Front PVC / Back Satin Lyrics) -------- */

const roundRectPath = (ctx, x, y, w, h, r) => {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
};

const drawLucideScissors = (ctx, x, y, size, color) => {
  const s = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 2 * s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Lucide Scissors: two rings at (6,6) r=3 and (6,18) r=3, blades crossing to (20,4) and (20,20)
  ctx.beginPath();
  ctx.arc(6 * s, 6 * s, 3 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(6 * s, 18 * s, 3 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(8.12 * s, 8.12 * s);
  ctx.lineTo(20 * s, 20 * s);
  ctx.moveTo(20 * s, 4 * s);
  ctx.lineTo(8.12 * s, 15.88 * s);
  ctx.stroke();
  ctx.restore();
};

const drawFourPointStar = (ctx, cx, cy, r, color) => {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx, cy, cx + r, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy + r);
  ctx.quadraticCurveTo(cx, cy, cx - r, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy - r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};

const drawCrewAvatarIllustration = (ctx, cx, cy, r, themePreset, isOwner) => {
  const themeColor = themePreset?.themeColor || '#b9343c';
  const hairColor = themePreset?.hairColor || '#4a2e2b';
  const scarfColor = themePreset?.scarfColor || themeColor;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  const bg = ctx.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, r);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.58, rgbaFromHex(themeColor, 0.14));
  bg.addColorStop(1, rgbaFromHex(themeColor, 0.28));
  ctx.fillStyle = bg;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  ctx.strokeStyle = rgbaFromHex(themeColor, 0.18);
  ctx.lineWidth = 1.5;
  for (let rr = r * 0.45; rr <= r * 0.92; rr += r * 0.22) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#1f2028';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.78, r * 0.62, r * 0.48, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffe8df';
  ctx.fillRect(cx - r * 0.11, cy + r * 0.12, r * 0.22, r * 0.26);
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.08, r * 0.31, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = hairColor;
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.14, r * 0.34, Math.PI * 0.88, Math.PI * 2.12);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.33, cy - r * 0.15);
  ctx.quadraticCurveTo(cx, cy - r * 0.32, cx + r * 0.33, cy - r * 0.12);
  ctx.lineTo(cx + r * 0.28, cy - r * 0.42);
  ctx.lineTo(cx - r * 0.28, cy - r * 0.42);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = isOwner ? '#d8a24a' : '#2b2d38';
  ctx.lineWidth = r * 0.075;
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.1, r * 0.37, Math.PI * 1.08, Math.PI * 1.92);
  ctx.stroke();

  ctx.fillStyle = '#261a19';
  ctx.beginPath();
  ctx.arc(cx - r * 0.11, cy - r * 0.06, r * 0.032, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.11, cy - r * 0.06, r * 0.032, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c95b5b';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.03, r * 0.065, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  ctx.fillStyle = scarfColor;
  roundRectPath(ctx, cx - r * 0.28, cy + r * 0.22, r * 0.56, r * 0.2, r * 0.09);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.06, cy + r * 0.36);
  ctx.lineTo(cx + r * 0.24, cy + r * 0.36);
  ctx.lineTo(cx + r * 0.29, cy + r * 0.86);
  ctx.lineTo(cx + r * 0.08, cy + r * 0.86);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
};

/**
 * Paints the front or back face of the VPlayer 3D Music Pass Card onto a 2D canvas,
 * replicating the exact UI/texture of https://github.com/fanhuayishiy/ai-crew-pass
 * while displaying VPlayer's music cover, live progress arc, and synchronized lyrics.
 */
const fitCardText = (ctx, text, maxWidth) => {
  const str = String(text || '').trim();
  if (!str || !maxWidth || typeof ctx.measureText !== 'function') return str;
  if (ctx.measureText(str).width <= maxWidth) return str;
  let lo = 1;
  let hi = str.length;
  let best = str.slice(0, 1) + '…';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = str.slice(0, mid) + '…';
    if (ctx.measureText(cand).width <= maxWidth) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
};

export function paintVPlayerPassCard(canvas, side, meta = {}, coverImage = null, finishKey = 'glossy') {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const w = canvas.width || 720;
  const h = canvas.height || 1012;
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const themeKey = meta.themeId || meta.characterId || 'crimson';
  const themePreset = AI_CREW_CHARACTERS[themeKey] || PASS_THEMES.crimson;
  const isOwner = meta.role === 'owner';
  const darkFront = finishKey === 'matte';
  const brandColor = meta.themeColor || themePreset.themeColor || '#b9343c';
  const accentColor = meta.accentColor || themePreset.accentColor || '#e0314b';
  const gold = '#d8a24a';
  const progress = clamp(Number(meta.progress) || 0, 0, 1);

  if (side === 'front') {
    // 1. Crisp Laminated White Paper PVC Surface (crispFront=true)
    const bgGrad = ctx.createLinearGradient(0, 0, w, h);
    if (darkFront) {
      bgGrad.addColorStop(0, '#171b24');
      bgGrad.addColorStop(0.5, '#10131b');
      bgGrad.addColorStop(1, '#0a0d13');
    } else {
      bgGrad.addColorStop(0, '#ffffff');
      bgGrad.addColorStop(0.6, '#fcfafb');
      bgGrad.addColorStop(1, themePreset.paperColor || '#f7f1f3');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Subtle technical grid pattern on front card
    ctx.strokeStyle = darkFront ? 'rgba(255, 255, 255, 0.035)' : rgbaFromHex(brandColor, 0.055);
    ctx.lineWidth = 1;
    const step = Math.round(w / 12);
    for (let x = step; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = step; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Soft ambient aura behind circular portal
    const cx = w * 0.5;
    const cy = h * 0.34;
    const portalR = w * 0.245;
    const aura = ctx.createRadialGradient(cx, cy, portalR * 0.15, cx, cy, portalR * 1.55);
    aura.addColorStop(0, darkFront ? 'rgba(216, 162, 74, 0.22)' : rgbaFromHex(brandColor, 0.22));
    aura.addColorStop(1, rgbaFromHex(brandColor, 0));
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, w, h);

    // Top horizontal lanyard slot cutout
    const slotW = w * 0.21;
    const slotH = h * 0.025;
    const slotX = (w - slotW) / 2;
    const slotY = h * 0.032;
    ctx.fillStyle = darkFront ? '#090b10' : '#ebe4e6';
    roundRectPath(ctx, slotX, slotY, slotW, slotH, slotH / 2);
    ctx.fill();
    ctx.strokeStyle = darkFront ? 'rgba(216, 162, 74, 0.45)' : rgbaFromHex(brandColor, 0.28);
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. Top Header: Brand Mark Left + "MUSIC PASS ///" Right
    ctx.fillStyle = brandColor;
    ctx.font = `800 ${Math.round(w * 0.048)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(String(meta.headerLeft || 'Vane Audio'), w * 0.078, h * 0.114);

    ctx.fillStyle = darkFront ? 'rgba(255, 255, 255, 0.72)' : '#3f3f46';
    ctx.font = `700 ${Math.round(w * 0.029)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.textAlign = 'right';
    ctx.fillText('CREW PASS', w * 0.835, h * 0.11);

    // Triple diagonal accent stripes (///)
    ctx.strokeStyle = brandColor;
    ctx.lineWidth = Math.max(3, w * 0.0055);
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const sx = w * 0.855 + i * (w * 0.022);
      const sy = h * 0.112;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + w * 0.014, sy - h * 0.022);
      ctx.stroke();
    }

    // 3. Central Circular Portal with Concentric Guilloche Rings & Live Progress Arc
    ctx.strokeStyle = darkFront ? 'rgba(216, 162, 74, 0.28)' : rgbaFromHex(brandColor, 0.24);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, portalR + w * 0.052, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, portalR + w * 0.028, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Live playback progress arc along the outer guilloche ring
    if (progress > 0.002) {
      ctx.save();
      ctx.strokeStyle = brandColor;
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + progress * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, portalR + w * 0.028, startAngle, endAngle);
      ctx.stroke();
      ctx.restore();
    }

    // Guilloche crosshair ticks
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const r1 = portalR + w * 0.042;
      const r2 = portalR + w * 0.062;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
    }

    // Sparkling 4-point stars around portal
    drawFourPointStar(ctx, cx - portalR - w * 0.045, cy - portalR * 0.55, w * 0.022, brandColor);
    drawFourPointStar(ctx, cx + portalR + w * 0.048, cy - portalR * 0.35, w * 0.018, gold);
    drawFourPointStar(ctx, cx + portalR + w * 0.035, cy + portalR * 0.62, w * 0.024, brandColor);
    drawFourPointStar(ctx, cx - portalR - w * 0.032, cy + portalR * 0.52, w * 0.016, gold);

    if (coverImage && coverImage.complete !== false && (coverImage.naturalWidth > 0 || coverImage.width > 0)) {
      const iw = coverImage.naturalWidth || coverImage.width;
      const ih = coverImage.naturalHeight || coverImage.height;
      const scale = Math.max((portalR * 2) / iw, (portalR * 2) / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, portalR, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(coverImage, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    } else {
      drawCrewAvatarIllustration(ctx, cx, cy, portalR, themePreset, isOwner);
    }

    // Crisp portal rim
    ctx.strokeStyle = brandColor;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.arc(cx, cy, portalR, 0, Math.PI * 2);
    ctx.stroke();

    // 4. Track / Pass Title + Pill Tag + Artist Subtitle
    const tagText = String(meta.tagPill || `+ ${meta.badge || 'HI-RES'}`).slice(0, 14);
    ctx.font = `700 ${Math.round(w * 0.027)}px ui-monospace, SFMono-Regular, monospace`;
    const tagW = ctx.measureText(tagText).width + w * 0.052;
    const tagH = h * 0.036;
    const tagX = w - w * 0.075 - tagW;
    const tagY = h * 0.55;
    ctx.fillStyle = brandColor;
    roundRectPath(ctx, tagX, tagY, tagW, tagH, tagH / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(tagText, tagX + tagW / 2, tagY + tagH * 0.71);

    ctx.textAlign = 'left';
    ctx.fillStyle = darkFront ? '#f8fafc' : (themePreset.inkColor || '#18181b');
    ctx.font = `800 ${Math.round(w * 0.064)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    const maxTitleW = Math.max(w * 0.46, tagX - w * 0.095);
    ctx.fillText(fitCardText(ctx, meta.title || 'Nothing on the air', maxTitleW), w * 0.078, h * 0.582);

    ctx.fillStyle = darkFront ? '#94a3b8' : '#3f3f46';
    ctx.font = `600 ${Math.round(w * 0.038)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(fitCardText(ctx, meta.artist || 'Vane Studio · 左右甩牌切歌 / 下拉暂停', w * 0.84), w * 0.078, h * 0.631);

    // 5. Live Lyric Quote Box with Signature Cloud-Ribbon Motif
    const boxX = w * 0.075;
    const boxY = h * 0.662;
    const boxW = w * 0.85;
    const boxH = h * 0.155;
    ctx.fillStyle = darkFront ? 'rgba(255, 255, 255, 0.045)' : rgbaFromHex(brandColor, 0.055);
    roundRectPath(ctx, boxX, boxY, boxW, boxH, w * 0.032);
    ctx.fill();
    ctx.strokeStyle = darkFront ? 'rgba(216, 162, 74, 0.26)' : rgbaFromHex(brandColor, 0.22);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    roundRectPath(ctx, boxX, boxY, boxW, boxH, w * 0.032);
    ctx.clip();
    const ribGrad = ctx.createLinearGradient(boxX + boxW * 0.55, boxY, boxX + boxW, boxY + boxH);
    ribGrad.addColorStop(0, rgbaFromHex(brandColor, 0.02));
    ribGrad.addColorStop(0.5, rgbaFromHex(brandColor, 0.18));
    ribGrad.addColorStop(1, 'rgba(216, 162, 74, 0.25)');
    ctx.fillStyle = ribGrad;
    ctx.beginPath();
    ctx.moveTo(boxX + boxW * 0.52, boxY + boxH);
    ctx.bezierCurveTo(
      boxX + boxW * 0.65,
      boxY + boxH * 0.25,
      boxX + boxW * 0.82,
      boxY + boxH * 0.85,
      boxX + boxW * 1.05,
      boxY + boxH * 0.15
    );
    ctx.lineTo(boxX + boxW * 1.05, boxY + boxH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Perforated Lyric Ticket Stub header & side punch notches
    ctx.save();
    ctx.strokeStyle = darkFront ? 'rgba(216, 162, 74, 0.32)' : rgbaFromHex(brandColor, 0.26);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(boxX + w * 0.025, boxY + boxH * 0.22);
    ctx.lineTo(boxX + boxW - w * 0.025, boxY + boxH * 0.22);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = darkFront ? '#0d1017' : (themePreset.paperColor || '#f8f3f4');
    ctx.beginPath();
    ctx.arc(boxX, boxY + boxH * 0.22, w * 0.015, -Math.PI / 2, Math.PI / 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(boxX + boxW, boxY + boxH * 0.22, w * 0.015, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.fill();
    ctx.stroke();
    const scSize = Math.round(w * 0.028);
    drawLucideScissors(ctx, boxX + w * 0.034, boxY + boxH * 0.055, scSize, brandColor);
    ctx.fillStyle = brandColor;
    ctx.font = `700 ${Math.round(w * 0.021)}px ui-monospace, SFMono-Regular, "PingFang SC", monospace`;
    ctx.textAlign = 'left';
    ctx.fillText('LYRIC TICKET · 深拉铭牌撕下歌词票', boxX + w * 0.072, boxY + boxH * 0.158);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = darkFront ? '#f1f5f9' : '#18181b';
    ctx.font = `700 ${Math.round(w * 0.038)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    const qMainFit = fitCardText(ctx, meta.lyric || '左右甩动铭牌切歌 · 下拉挂绳播放或暂停', boxW - w * 0.11);
    ctx.fillText(`“${qMainFit}”`, boxX + w * 0.038, boxY + boxH * 0.56);

    ctx.fillStyle = darkFront ? '#cbd5e1' : '#52525b';
    ctx.font = `600 ${Math.round(w * 0.03)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    const qSubFit = fitCardText(ctx, meta.tlyric || '轻点铭牌翻面查看实时歌词 · 双击红心收藏', boxW - w * 0.08);
    ctx.fillText(qSubFit, boxX + w * 0.038, boxY + boxH * 0.84);

    // 6. Bottom Barcode & Serial Footer
    const bcX = w * 0.078;
    const bcY = h * 0.852;
    const bcH = h * 0.072;
    const bars = [3, 1.5, 4.5, 2, 1.5, 3.5, 2, 4, 1.5, 2.5, 3.5, 1.5, 3, 2];
    let curX = bcX;
    ctx.fillStyle = brandColor;
    bars.forEach((bw, idx) => {
      const wPx = bw * (w * 0.0042);
      if (idx % 2 === 0) {
        ctx.fillRect(curX, bcY, wPx, bcH);
      }
      curX += wPx + w * 0.003;
    });

    const serialX = curX + w * 0.026;
    ctx.fillStyle = darkFront ? '#e2e8f0' : '#18181b';
    ctx.font = `700 ${Math.round(w * 0.026)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillText(
      fitCardText(ctx, meta.serialLine || `VANE AUDIO PASS · ${themePreset.serial}`, w * 0.92 - serialX),
      serialX,
      bcY + bcH * 0.44
    );

    ctx.fillStyle = brandColor;
    ctx.font = `700 ${Math.round(w * 0.024)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(
      fitCardText(ctx, meta.footerTag || '左右甩牌切歌 · 下拉播放 · 轻点翻面', w * 0.92 - serialX),
      serialX,
      bcY + bcH * 0.86
    );
  } else {
    // BACK SIDE: Satin-finish Deep Brand Shade overlaid with Liquid Metallic Wave Ribbons
    const bgGrad = ctx.createLinearGradient(0, 0, w * 0.6, h);
    bgGrad.addColorStop(0, darkenHex(brandColor, 0.36));
    bgGrad.addColorStop(0.5, darkenHex(brandColor, 0.22));
    bgGrad.addColorStop(1, '#0c070a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    const rib1 = ctx.createLinearGradient(0, h * 0.35, w, h * 0.85);
    rib1.addColorStop(0, rgbaFromHex(accentColor, 0.42));
    rib1.addColorStop(0.5, 'rgba(245, 195, 110, 0.32)');
    rib1.addColorStop(1, rgbaFromHex(brandColor, 0.14));
    ctx.fillStyle = rib1;
    ctx.beginPath();
    ctx.moveTo(-w * 0.1, h * 0.62);
    ctx.bezierCurveTo(w * 0.28, h * 0.44, w * 0.62, h * 0.78, w * 1.1, h * 0.52);
    ctx.lineTo(w * 1.1, h * 0.74);
    ctx.bezierCurveTo(w * 0.68, h * 0.94, w * 0.32, h * 0.6, -w * 0.1, h * 0.82);
    ctx.closePath();
    ctx.fill();

    const rib2 = ctx.createLinearGradient(w, h * 0.25, 0, h * 0.95);
    rib2.addColorStop(0, 'rgba(216, 162, 74, 0.28)');
    rib2.addColorStop(0.6, rgbaFromHex(accentColor, 0.26));
    rib2.addColorStop(1, 'rgba(255, 255, 255, 0.04)');
    ctx.fillStyle = rib2;
    ctx.beginPath();
    ctx.moveTo(w * 0.45, h * 0.18);
    ctx.bezierCurveTo(w * 0.92, h * 0.32, w * 0.55, h * 0.68, w * 1.05, h * 0.86);
    ctx.lineTo(w * 1.05, h * 1.02);
    ctx.bezierCurveTo(w * 0.42, h * 0.82, w * 0.72, h * 0.42, w * 0.25, h * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    drawFourPointStar(ctx, w * 0.82, h * 0.22, w * 0.022, '#fae5a8');
    drawFourPointStar(ctx, w * 0.74, h * 0.28, w * 0.014, '#ffffff');
    drawFourPointStar(ctx, w * 0.86, h * 0.58, w * 0.025, '#fae5a8');
    drawFourPointStar(ctx, w * 0.16, h * 0.72, w * 0.016, '#ffffff');

    const slotW = w * 0.21;
    const slotH = h * 0.025;
    const slotX = (w - slotW) / 2;
    const slotY = h * 0.032;
    ctx.fillStyle = '#070406';
    roundRectPath(ctx, slotX, slotY, slotW, slotH, slotH / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(250, 229, 168, 0.38)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(w * 0.046)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('Vane Audio', w * 0.082, h * 0.114);

    ctx.fillStyle = 'rgba(250, 229, 168, 0.9)';
    ctx.font = `700 ${Math.round(w * 0.028)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.textAlign = 'right';
    ctx.fillText(`MUSIC PASS // ${themePreset.serial}`, w * 0.918, h * 0.112);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(w * 0.066)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(fitCardText(ctx, meta.title || 'Angle carries time.', w * 0.83), w * 0.082, h * 0.205);

    ctx.fillStyle = 'rgba(255, 236, 240, 0.92)';
    ctx.font = `600 ${Math.round(w * 0.037)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(fitCardText(ctx, meta.artist || 'Vane Studio', w * 0.83), w * 0.082, h * 0.258);

    const tags = Array.isArray(meta.tags) && meta.tags.length
      ? meta.tags
      : [meta.badge || 'FLAC', 'HI-RES', 'SWING SKIP', 'VANE'];
    let tx = w * 0.082;
    const ty = h * 0.292;
    const th = h * 0.039;
    ctx.font = `700 ${Math.round(w * 0.025)}px ui-monospace, SFMono-Regular, monospace`;
    for (const tag of tags.slice(0, 4)) {
      const tw = ctx.measureText(tag).width + w * 0.044;
      if (tx + tw > w * 0.92) break;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      roundRectPath(ctx, tx, ty, tw, th, th / 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(tag, tx + tw / 2, ty + th * 0.71);
      tx += tw + w * 0.016;
    }
    ctx.textAlign = 'left';

    const lines = Array.isArray(meta.lyricsLines) && meta.lyricsLines.length
      ? meta.lyricsLines.slice(0, 4)
      : [
          `正在播放：${meta.title || 'VPlayer · Vane'}`,
          `演唱歌手：${meta.artist || 'Vane Studio'}`,
          '手势控制：左右甩牌切歌 · 下拉挂绳暂停/播放',
          '双面铭牌：轻点卡片翻面 · 双击卡片红心收藏',
        ];

    let y = h * 0.405;
    lines.forEach((ln, idx) => {
      drawFourPointStar(ctx, w * 0.102, y - h * 0.012, w * 0.016, idx === 0 ? '#fae5a8' : '#ffffff');
      ctx.fillStyle = idx === 0 ? '#fae5a8' : 'rgba(255, 245, 247, 0.95)';
      ctx.font = `${idx === 0 ? 700 : 600} ${Math.round(w * 0.038)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      const text = fitCardText(ctx, ln, w * 0.77);
      ctx.fillText(text, w * 0.135, y);
      y += h * 0.074;
    });

    const cbX = w * 0.082;
    const cbY = h * 0.735;
    const cbW = w * 0.836;
    const cbH = h * 0.175;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.11)';
    roundRectPath(ctx, cbX, cbY, cbW, cbH, w * 0.032);
    ctx.fill();
    ctx.strokeStyle = 'rgba(250, 229, 168, 0.42)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.fillStyle = '#fae5a8';
    ctx.font = `700 ${Math.round(w * 0.027)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillText('LIVE LYRIC · 实时同步词谱', cbX + w * 0.04, cbY + cbH * 0.33);

    const catchphrase = String(meta.lyric || '左右甩动铭牌切歌 · 下拉挂绳播放或暂停').replace(/^[“"]|[”"]$/g, '');
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(w * 0.041)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(`“${fitCardText(ctx, catchphrase, cbW - w * 0.08)}”`, cbX + w * 0.04, cbY + cbH * 0.74);
  }

  ctx.restore();
}

/* ---------------- Built-in Interactive 3D Canvas Lanyard ------------------ */

const loadImage = (cache, resolvedMap, url) => {
  if (!url || typeof Image === 'undefined') return Promise.resolve(null);
  const ready = resolvedMap?.get(url);
  if (ready) return Promise.resolve(ready);
  const cached = cache.get(url);
  if (cached) return cached;
  const attempt = (useCors) =>
    new Promise((resolve) => {
      const img = new Image();
      if (useCors) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  const promise = attempt(true).then((img) => {
    if (img) {
      resolvedMap?.set(url, img);
      return img;
    }
    return attempt(false).then((fallbackImg) => {
      if (fallbackImg) {
        resolvedMap?.set(url, fallbackImg);
        return fallbackImg;
      }
      cache.delete(url);
      return null;
    });
  });
  cache.set(url, promise);
  return promise;
};

/**
 * Mounts the interactive 3D Lanyard Pass inside `container`.
 * Supports full gesture callbacks (`onFlingNext`, `onFlingPrev`, `onPullToggle`, `onDoubleTap`).
 */
export async function mountLanyard(container, initialOptions = {}) {
  if (!container) throw new Error('mountLanyard requires a valid DOM container');

  const settings = {
    frontImage: undefined,
    backImage: undefined,
    imageFit: 'cover',
    cardColor: '#ffffff',
    orientation: 'portrait',
    finish: 'glossy',
    cornerRadius: 0.3,
    size: 0.62,
    anchor: 'center',
    strapLength: 0.4,
    strapImage: undefined,
    strapColor: '#b9343c',
    strapWidth: 0.68,
    metal: 'silver',
    gravity: 1,
    damping: 0.5,
    elasticity: 0.55,
    breeze: 0.45,
    interactive: true,
    intro: true,
    transparentStage: false,
    cardMeta: null,
    onFlingNext: null,
    onFlingPrev: null,
    onPullToggle: null,
    onDoubleTap: null,
    ...initialOptions,
  };

  const doc = container.ownerDocument || document;
  const stageCanvas = doc.createElement('canvas');
  stageCanvas.className = 'vp-lanyard-canvas';
  stageCanvas.setAttribute('aria-hidden', 'true');
  container.replaceChildren(stageCanvas);

  const frontCanvas = doc.createElement('canvas');
  const backCanvas = doc.createElement('canvas');
  frontCanvas.width = FACE_WIDTH;
  frontCanvas.height = Math.round((FACE_WIDTH * 2.25) / 1.6);
  backCanvas.width = frontCanvas.width;
  backCanvas.height = frontCanvas.height;

  const imageCache = new Map();
  const resolvedImages = new Map();
  const images = { front: null, back: null };
  let loadedFrontUrl = undefined;
  let loadedBackUrl = undefined;
  const sim = createSimulation();
  let layout = cardLayout(settings.orientation, settings.cornerRadius);
  const view = { width: 320, height: 420, dpr: 1 };

  let raf = 0;
  let last = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let time = 0;
  let visible = true;
  let alive = true;
  let placed = false;
  let press = null;
  let lastTapAt = 0;
  let gestureHint = '';
  let imageToken = 0;
  let flingBoostUntil = 0;
  let lastPaintedProgress = -1;
  let pendingUpdateTimer = 0;
  let lastCardRect = { x: 0, y: 0, w: 0, h: 0 };
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let lastActiveAt = clock();
  let windGain = 1;
  let imagesVersion = 0;
  let facesSig = '';
  const facesDirty = { front: true, back: true };
  const staticLayer = { key: '', canvas: null };
  const shadowSprite = { canvas: null, w: 0, h: 0, pad: 0, dpr: 0 };
  const touch = () => {
    lastActiveAt = clock();
    windGain = 1;
  };

  const reducedMotion =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false);

  const physics = () => {
    const gravity = 40 * clamp(settings.gravity, 0, 3);
    const weight = Math.max(gravity, 20);
    const springy = clamp(settings.elasticity, 0, 1);
    const settle = clamp(settings.damping, 0, 1);
    return {
      gravity,
      hold: weight * mix(2.2, 5.5, springy),
      stiffness: weight * 10 * JOINTS,
      spring: weight * mix(0.1, 0.4, springy) * JOINTS,
      bandDamping: weight * mix(0.3, 0.08, springy) * JOINTS,
      linearDrag: 0.25 * Math.pow(16, settle),
      angularDrag: 0.5 * Math.pow(12, settle),
      air: 0.15,
      broadside: 0.5,
      spinAir: 0.03,
      nodeDrag: 2,
      nodeAir: 0.2,
      twist: 30,
      twistDamping: 3,
      grip: 40,
      gripDamping: 6,
      breeze: reducedMotion ? 0 : clamp(settings.breeze, 0, 1) * windGain,
    };
  };

  const getViewSpace = () => {
    const aspect = view.width / Math.max(1, view.height);
    let viewHeight = layout.height / clamp(settings.size, 0.15, 0.9);
    const minimumWidth = layout.width / 0.72;
    if (viewHeight * aspect < minimumWidth) viewHeight = minimumWidth / aspect;
    const viewWidth = viewHeight * aspect;
    const camZ = viewHeight / 2 / Math.tan((FOV * Math.PI) / 360);
    return { viewWidth, viewHeight, camZ };
  };

  const project3D = (pt, vs) => {
    const dz = Math.max(0.5, vs.camZ - pt.z);
    const scale = (vs.camZ / dz) * (view.height / vs.viewHeight);
    return {
      x: view.width * 0.5 + pt.x * scale,
      y: view.height * 0.5 - pt.y * scale,
      scale,
    };
  };

  const unprojectDelta = (dxPx, dyPx, vs) => {
    const pxPerUnit = view.height / vs.viewHeight;
    return {
      dx: dxPx / pxPerUnit,
      dy: -dyPx / pxPerUnit,
    };
  };

  const frameView = () => {
    const vs = getViewSpace();
    const anchorX = ((ANCHORS[settings.anchor] ?? 0.5) - 0.5) * vs.viewWidth;
    const anchorY = vs.viewHeight / 2 + 0.16;
    const cardTop = vs.viewHeight / 2 - vs.viewHeight * mix(0.11, 0.36, clamp(settings.strapLength, 0, 1));
    const hangTop = cardTop + (layout.hangY - layout.height / 2);
    sim.anchor.set(anchorX, anchorY, 0);
    configureSimulation(sim, layout, Math.max(0.45, anchorY - hangTop));
    sim.nodes[0].copy(sim.anchor);
    sim.previous[0].copy(sim.anchor);
  };

  const faceMeta = () =>
    settings.cardMeta || {
      themeId: 'crimson',
      title: 'VPlayer · Vane',
      artist: 'Vane Studio',
      badge: 'HI-RES',
    };

  const paintFace = (side) => {
    const meta = faceMeta();
    if (side === 'front') {
      paintVPlayerPassCard(frontCanvas, 'front', meta, images.front, settings.finish);
    } else {
      paintVPlayerPassCard(backCanvas, 'back', meta, images.back || images.front, settings.finish);
    }
    facesDirty[side] = false;
  };

  const facingFront = () => scratch.c.set(0, 0, 1).applyQuaternion(sim.body.quaternion).z >= 0;

  /**
   * Mark the card faces stale and repaint the one that is showing. The other is
   * repainted by render() only if and when it turns toward the viewer, so a
   * lyric-line change costs one 420x590 repaint instead of two. Nothing is
   * repainted at all when neither the content nor the images changed.
   */
  const paintFaces = () => {
    layout = cardLayout(settings.orientation, settings.cornerRadius);
    const w = FACE_WIDTH;
    const h = Math.round((FACE_WIDTH * layout.height) / layout.width);
    let resized = false;
    if (frontCanvas.width !== w || frontCanvas.height !== h) {
      frontCanvas.width = w;
      frontCanvas.height = h;
      backCanvas.width = w;
      backCanvas.height = h;
      resized = true;
    }
    let metaKey = '';
    try {
      // Progress is quantised to the same 2.5% step setProgress() uses, so a
      // sub-step change in the ring does not defeat the unchanged-content skip.
      metaKey = JSON.stringify(settings.cardMeta || null, (k, v) =>
        k === 'progress' && typeof v === 'number' ? Math.round(v * 40) : v
      );
    } catch {
      metaKey = String(Math.random());
    }
    const sig = `${imagesVersion}|${settings.finish}|${settings.orientation}|${metaKey}`;
    if (!resized && sig === facesSig) return false;
    facesSig = sig;
    facesDirty.front = true;
    facesDirty.back = true;
    paintFace(facingFront() ? 'front' : 'back');
    return true;
  };

  // The grid, oversized watermark and vertical status line never move, yet used
  // to be re-stroked (30+ separate paths) on every frame. They live on their
  // own canvas now and are redrawn only when something they show changes.
  const getStaticLayer = (brandColor, watermarkText, statusText) => {
    const key = [
      view.width, view.height, view.dpr, brandColor, watermarkText, statusText,
      settings.transparentStage ? 1 : 0,
    ].join('|');
    if (staticLayer.canvas && (staticLayer.key === key || sim.grab || Date.now() < flingBoostUntil)) return staticLayer.canvas;
    const cv = staticLayer.canvas || doc.createElement('canvas');
    const c = cv.getContext?.('2d');
    if (!c) return null;
    cv.width = Math.round(view.width * view.dpr);
    cv.height = Math.round(view.height * view.dpr);
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.clearRect(0, 0, view.width, view.height);
    if (!settings.transparentStage) {
      c.strokeStyle = rgbaFromHex(brandColor, 0.065);
      c.lineWidth = 1;
      c.beginPath();
      for (let x = 24; x < view.width; x += 24) {
        c.moveTo(x, 0);
        c.lineTo(x, view.height);
      }
      for (let y = 24; y < view.height; y += 24) {
        c.moveTo(0, y);
        c.lineTo(view.width, y);
      }
      c.stroke();
    }
    c.fillStyle = rgbaFromHex(brandColor, 0.075);
    c.font = `900 ${Math.round(view.width * 0.21)}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(watermarkText, view.width * 0.5, view.height * 0.52);
    c.save();
    c.translate(view.width - 13, view.height * 0.5);
    c.rotate(Math.PI / 2);
    c.fillStyle = rgbaFromHex(brandColor, 0.72);
    c.font = '700 10px ui-monospace, SFMono-Regular, "PingFang SC", monospace';
    c.textAlign = 'center';
    c.fillText(`\u25CF ${statusText}`, 0, 0);
    c.restore();
    staticLayer.key = key;
    staticLayer.canvas = cv;
    return cv;
  };

  // A 34px shadowBlur on a card-sized path, recomputed every frame, was the
  // single costliest call in the loop on phones. The blurred silhouette is
  // rendered once into a sprite and re-used (scaled a little as the card moves
  // nearer or further). Offsets and blur are device pixels, as they were
  // when drawn directly.
  const SHADOW_BLUR = 34;
  const getShadowSprite = (cardW, cardH, rad) => {
    const dpr = view.dpr;
    const sp = shadowSprite;
    if (sp.canvas && sp.dpr === dpr) {
      const k = cardW / sp.w;
      if (k > 0.85 && k < 1.18 && Math.abs(cardH / sp.h - k) < 0.08) return sp;
    }
    const cv = sp.canvas || doc.createElement('canvas');
    const c = cv.getContext?.('2d');
    if (!c) return null;
    const padDev = SHADOW_BLUR * 2 + 40;
    const wDev = Math.ceil(cardW * dpr + padDev * 2);
    const hDev = Math.ceil(cardH * dpr + padDev * 2);
    cv.width = wDev;
    cv.height = hDev;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, wDev, hDev);
    const off = wDev + 100;
    c.shadowColor = 'rgba(28, 16, 20, 0.24)';
    c.shadowBlur = SHADOW_BLUR;
    c.shadowOffsetX = off;
    c.shadowOffsetY = 0;
    c.fillStyle = '#000';
    roundRectPath(c, padDev - off, padDev, cardW * dpr, cardH * dpr, rad * dpr);
    c.fill();
    sp.canvas = cv;
    sp.w = cardW;
    sp.h = cardH;
    sp.pad = padDev / dpr;
    sp.dpr = dpr;
    return sp;
  };

  const render = () => {
    const ctx = stageCanvas.getContext?.('2d');
    if (!ctx) return;

    const meta = settings.cardMeta || {};
    const themeKey = meta.themeId || meta.characterId || 'crimson';
    const themePreset = AI_CREW_CHARACTERS[themeKey] || PASS_THEMES.crimson;
    const brandColor = meta.themeColor || settings.strapColor || themePreset.themeColor || '#b9343c';
    const strapWord = String(meta.strapWord || themePreset.strapWord || 'VANE AUDIO').toUpperCase();
    const watermarkText = String(meta.watermark || 'VANE');
    const statusText = String(meta.statusLine || `${meta.badge || 'HI-RES'} · ${themePreset.serial}`);

    const dpr = view.dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);

    // 0. Technical grid, watermark and status line (cached layer)
    const layerCanvas = getStaticLayer(brandColor, watermarkText, statusText);
    if (layerCanvas) ctx.drawImage(layerCanvas, 0, 0, view.width, view.height);

    const vs = getViewSpace();
    const metalLook = METALS[settings.metal] || METALS.silver;
    const finishLook = FINISHES[settings.finish] || FINISHES.glossy;

    // 1. Project rope nodes and draw 3D Woven Lanyard Strap
    const projNodes = sim.nodes.map((n) => project3D(n, vs));
    const p0 = projNodes[0];
    const pLast = projNodes[JOINTS];
    const strapPxW = Math.max(20, STRAP_WIDTH * clamp(settings.strapWidth, 0.4, 2) * (view.height / vs.viewHeight) * 0.88);

    ctx.save();
    ctx.strokeStyle = rgbaFromHex(brandColor, 0.18);
    ctx.lineWidth = strapPxW + 4;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p0.x + 5, p0.y + 7);
    for (let i = 1; i <= JOINTS; i++) {
      const prev = projNodes[i - 1];
      const cur = projNodes[i];
      const mx = (prev.x + cur.x) * 0.5 + 5;
      const my = (prev.y + cur.y) * 0.5 + 7;
      ctx.quadraticCurveTo(prev.x + 5, prev.y + 7, mx, my);
    }
    ctx.lineTo(pLast.x + 5, pLast.y + 7);
    ctx.stroke();

    const strapGrad = ctx.createLinearGradient(p0.x - strapPxW * 0.6, p0.y, pLast.x + strapPxW * 0.6, pLast.y);
    strapGrad.addColorStop(0, darkenHex(brandColor, 0.82));
    strapGrad.addColorStop(0.5, brandColor);
    strapGrad.addColorStop(1, darkenHex(brandColor, 0.85));
    ctx.strokeStyle = strapGrad;
    ctx.lineWidth = strapPxW;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i <= JOINTS; i++) {
      const prev = projNodes[i - 1];
      const cur = projNodes[i];
      const mx = (prev.x + cur.x) * 0.5;
      const my = (prev.y + cur.y) * 0.5;
      ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    }
    ctx.lineTo(pLast.x, pLast.y);
    ctx.stroke();

    const dxStrap = pLast.x - p0.x;
    const dyStrap = pLast.y - p0.y;
    const lenStrap = Math.hypot(dxStrap, dyStrap) || 1;
    const nxStrap = -dyStrap / lenStrap;
    const nyStrap = dxStrap / lenStrap;
    const seamOffset = strapPxW * 0.37;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 1.1;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(p0.x + nxStrap * seamOffset * dir, p0.y + nyStrap * seamOffset * dir);
      for (let i = 1; i <= JOINTS; i++) {
        const prev = projNodes[i - 1];
        const cur = projNodes[i];
        const mx = (prev.x + cur.x) * 0.5 + nxStrap * seamOffset * dir;
        const my = (prev.y + cur.y) * 0.5 + nyStrap * seamOffset * dir;
        ctx.quadraticCurveTo(
          prev.x + nxStrap * seamOffset * dir,
          prev.y + nyStrap * seamOffset * dir,
          mx,
          my
        );
      }
      ctx.lineTo(pLast.x + nxStrap * seamOffset * dir, pLast.y + nyStrap * seamOffset * dir);
      ctx.stroke();
    }

    ctx.save();
    const midIdx = Math.floor(JOINTS / 2);
    const segA = projNodes[0];
    const segB = projNodes[JOINTS];
    const angle = Math.atan2(segB.y - segA.y, segB.x - segA.x);
    const midX = (segA.x + segB.x + projNodes[midIdx].x) / 3;
    const midY = (segA.y + segB.y + projNodes[midIdx].y) / 3;
    ctx.translate(midX, midY);
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(237, 243, 251, 0.92)';
    ctx.font = `700 ${Math.max(8, Math.round(strapPxW * 0.34))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(strapWord, 0, 0);
    ctx.restore();
    ctx.restore();

    // 2. Metallic Silver Clamp & Split Ring at hang node
    ctx.save();
    ctx.translate(pLast.x, pLast.y);
    const axisX = p0.x - pLast.x;
    const axisY = p0.y - pLast.y;
    const strapAngle = Math.atan2(axisX, -axisY);
    ctx.rotate(strapAngle * 0.45);

    const clampW = strapPxW * 1.18;
    const clampH = Math.max(11, strapPxW * 0.48);
    const clampGrad = ctx.createLinearGradient(-clampW / 2, 0, clampW / 2, 0);
    clampGrad.addColorStop(0, metalLook.lo);
    clampGrad.addColorStop(0.32, metalLook.hi);
    clampGrad.addColorStop(0.66, metalLook.mid);
    clampGrad.addColorStop(1, metalLook.lo);
    ctx.fillStyle = clampGrad;
    roundRectPath(ctx, -clampW / 2, -clampH * 0.85, clampW, clampH, 3.5);
    ctx.fill();

    ctx.strokeStyle = metalLook.mid;
    ctx.lineWidth = Math.max(2.6, strapPxW * 0.13);
    ctx.beginPath();
    ctx.arc(0, clampH * 0.36, Math.max(6.5, strapPxW * 0.3), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 3. 3D Rigid Body Card Transformation
    const body = sim.body;
    const q = body.quaternion;
    const right = scratch.a.set(1, 0, 0).applyQuaternion(q);
    const up = scratch.b.set(0, 1, 0).applyQuaternion(q);
    const normal = scratch.c.set(0, 0, 1).applyQuaternion(q);

    const centerProj = project3D(body.position, vs);
    const cardPxW = layout.width * centerProj.scale;
    const cardPxH = layout.height * centerProj.scale;
    const cosYaw = right.x;
    const sinTilt = up.x;
    const pitchScale = clamp(Math.hypot(up.x, up.y), 0.74, 1.04);
    const isFront = normal.z >= 0;
    const faceSign = isFront ? 1 : -1;
    const horizScale = Math.max(0.06, Math.abs(cosYaw)) * (cosYaw * faceSign >= 0 ? 1 : -1);

    lastCardRect = {
      x: centerProj.x - cardPxW * 0.5,
      y: centerProj.y - cardPxH * 0.5,
      w: cardPxW,
      h: cardPxH,
    };

    ctx.save();
    ctx.translate(centerProj.x, centerProj.y);

    const rollAngle = Math.atan2(-right.y * faceSign, Math.max(0.08, Math.abs(right.x)));
    ctx.rotate(clamp(rollAngle, -0.65, 0.65));
    ctx.transform(horizScale, sinTilt * 0.18, -sinTilt * 0.12, pitchScale, 0, 0);

    const rad = Math.min(cardPxW, cardPxH) * mix(0.04, 0.13, clamp(settings.cornerRadius, 0, 1));

    ctx.save();
    const sh = getShadowSprite(cardPxW, cardPxH, rad);
    if (sh) {
      const k = cardPxW / sh.w;
      ctx.drawImage(
        sh.canvas,
        -cardPxW / 2 - sh.pad * k + (-normal.x * 16) / view.dpr,
        -cardPxH / 2 - sh.pad * k + 18 / view.dpr,
        (sh.canvas.width / view.dpr) * k,
        (sh.canvas.height / view.dpr) * k
      );
    } else {
      ctx.shadowColor = 'rgba(28, 16, 20, 0.24)';
      ctx.shadowBlur = SHADOW_BLUR;
      ctx.shadowOffsetX = -normal.x * 16;
      ctx.shadowOffsetY = 18;
    }
    ctx.fillStyle = isFront && finishLook.theme === 'light-pvc' ? '#ffffff' : '#12080d';
    roundRectPath(ctx, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH, rad);
    ctx.fill();
    ctx.restore();

    const edgeShift = clamp(-normal.x * 7.5, -6.5, 6.5);
    if (Math.abs(edgeShift) > 0.5) {
      ctx.fillStyle = isFront && finishLook.theme === 'light-pvc' ? '#e3dce0' : metalLook.lo;
      roundRectPath(ctx, -cardPxW / 2 + edgeShift, -cardPxH / 2 + 1.5, cardPxW, cardPxH, rad);
      ctx.fill();
    }

    ctx.save();
    roundRectPath(ctx, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH, rad);
    ctx.clip();

    const faceSide = isFront ? 'front' : 'back';
    if (facesDirty[faceSide]) paintFace(faceSide);
    const activeFace = isFront ? frontCanvas : backCanvas;
    ctx.drawImage(activeFace, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH);

    const viewAngle = Math.atan2(normal.x, Math.max(0.05, Math.abs(normal.z))) + normal.y * 0.8 + time * 0.3;
    if (finishLook.foil > 0) {
      const holoGrad = ctx.createLinearGradient(
        -cardPxW * 0.6 + Math.sin(viewAngle) * cardPxW * 0.45,
        -cardPxH * 0.6,
        cardPxW * 0.6 + Math.cos(viewAngle) * cardPxW * 0.45,
        cardPxH * 0.6
      );
      const baseAlpha = isFront && finishLook.theme === 'light-pvc' ? 0.12 : 0.16;
      const alpha = (baseAlpha + Math.abs(normal.x) * 0.2) * finishLook.foil;
      holoGrad.addColorStop(0, `rgba(255, 85, 165, ${alpha.toFixed(3)})`);
      holoGrad.addColorStop(0.25, `rgba(80, 215, 255, ${(alpha * 1.1).toFixed(3)})`);
      holoGrad.addColorStop(0.5, `rgba(255, 220, 115, ${(alpha * 0.95).toFixed(3)})`);
      holoGrad.addColorStop(0.75, `rgba(130, 255, 195, ${(alpha * 1.05).toFixed(3)})`);
      holoGrad.addColorStop(1, `rgba(195, 115, 255, ${alpha.toFixed(3)})`);
      ctx.globalCompositeOperation = isFront && finishLook.theme === 'light-pvc' ? 'source-over' : 'screen';
      ctx.fillStyle = holoGrad;
      ctx.fillRect(-cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (finishLook.sheen > 0) {
      const sheenX = normal.x * cardPxW * 0.9;
      const sheenGrad = ctx.createLinearGradient(
        sheenX - cardPxW * 0.38,
        -cardPxH * 0.5,
        sheenX + cardPxW * 0.38,
        cardPxH * 0.5
      );
      const sAlpha = 0.2 * finishLook.sheen;
      sheenGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
      sheenGrad.addColorStop(0.5, `rgba(255, 255, 255, ${sAlpha.toFixed(3)})`);
      sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = sheenGrad;
      ctx.fillRect(-cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH);
    }

    ctx.restore();

    ctx.strokeStyle = isFront && finishLook.theme === 'light-pvc'
      ? rgbaFromHex(brandColor, 0.22)
      : 'rgba(250, 229, 168, 0.45)';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH, rad);
    ctx.stroke();

    ctx.restore();

    // 5. Live Gesture Action Pill Overlay when dragging past fling/pull threshold
    if (gestureHint) {
      ctx.save();
      ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      const gw = ctx.measureText(gestureHint).width + 24;
      const gh = 28;
      const gx = (view.width - gw) * 0.5;
      const gy = view.height * 0.14;
      ctx.fillStyle = brandColor;
      roundRectPath(ctx, gx, gy, gw, gh, 14);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(gestureHint, view.width * 0.5, gy + gh * 0.52);
      ctx.restore();
    }

    ctx.restore();
  };

  const tick = (now) => {
    raf = 0;
    if (!alive || doc.hidden || doc.visibilityState === 'hidden' || !visible) return;
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
    last = now;
    time += dt;
    const idleFor = clock() - lastActiveAt;
    windGain = idleFor < IDLE_SETTLE_MS ? 1 : Math.max(0, 1 - (idleFor - IDLE_SETTLE_MS) / IDLE_FADE_MS);
    const current = physics();
    stepSimulation(sim, dt, current, time);
    const body = sim.body;
    if (!Number.isFinite(body.position.x + body.position.y + body.position.z + body.quaternion.w)) {
      sim.grab = null;
      placeHanging(sim, layout, false);
    }
    render();
    const resting =
      !sim.grab && windGain === 0 && (sim.calm > 1.2 || idleFor > IDLE_SETTLE_MS + IDLE_FADE_MS + 8000);
    if (visible && !doc.hidden && doc.visibilityState !== 'hidden' && !resting) {
      raf = requestAnimationFrame(tick);
    }
  };

  const start = () => {
    if (raf || !visible || !alive || doc.hidden || doc.visibilityState === 'hidden') return;
    sim.calm = 0;
    last = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (typeof requestAnimationFrame === 'function') {
      raf = requestAnimationFrame(tick);
    }
  };

  const flip = () => {
    touch();
    const body = sim.body;
    const up = scratch.a.set(0, 1, 0).applyQuaternion(body.quaternion);
    const direction = sim.turn > 0 ? -1 : 1;
    sim.turn = sim.turn === 0 ? Math.PI * direction : 0;
    body.angular.addScaledVector(up, FLIP_SPIN * direction);
    start();
  };

  const triggerTrackTransition = (direction = 'next') => {
    const sign = direction === 'prev' ? 1 : -1;
    touch();
    flingBoostUntil = Date.now() + 260;
    sim.body.velocity.x = clamp(sim.body.velocity.x + sign * 3.2, -9, 9);
    sim.body.velocity.y = clamp(sim.body.velocity.y + 1.1, -6, 6);
    const up = scratch.a.set(0, 1, 0).applyQuaternion(sim.body.quaternion);
    sim.body.angular.addScaledVector(up, FLIP_SPIN * 0.85 * sign);
    start();
  };

  const apply = () => {
    touch();
    layout = cardLayout(settings.orientation, settings.cornerRadius);
    frameView();
    const firstPlace = !placed;
    if (firstPlace) {
      placeHanging(sim, layout, settings.intro && !reducedMotion);
      placed = true;
    }
    const token = ++imageToken;
    const targetFront = settings.frontImage;
    const targetBack = settings.backImage;
    const hasAsyncImage = Boolean((targetFront || targetBack) && typeof Image !== 'undefined');
    if (hasAsyncImage) {
      const readyFront = targetFront ? resolvedImages.get(targetFront) : null;
      const readyBack = targetBack ? resolvedImages.get(targetBack) : null;
      if (targetFront !== loadedFrontUrl) images.front = readyFront || null;
      if (targetBack !== loadedBackUrl) images.back = readyBack || null;
      if (!targetFront || readyFront) loadedFrontUrl = targetFront;
      if (!targetBack || readyBack) loadedBackUrl = targetBack;
      imagesVersion++;
      paintFaces();
      render();
      start();
      if ((targetFront && !readyFront) || (targetBack && !readyBack)) {
        Promise.all([
          loadImage(imageCache, resolvedImages, targetFront),
          loadImage(imageCache, resolvedImages, targetBack),
        ]).then(([front, back]) => {
          if (!alive || token !== imageToken) return;
          images.front = front;
          images.back = back;
          loadedFrontUrl = targetFront;
          loadedBackUrl = targetBack;
          imagesVersion++;
          paintFaces();
          render();
          start();
        });
      }
    } else {
      images.front = null;
      images.back = null;
      loadedFrontUrl = targetFront;
      loadedBackUrl = targetBack;
      imagesVersion++;
      paintFaces();
      render();
      start();
    }
  };

  const hitTestCard = (clientX, clientY) => {
    const rect = stageCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const pad = 28;
    return (
      x >= lastCardRect.x - pad &&
      x <= lastCardRect.x + lastCardRect.w + pad &&
      y >= lastCardRect.y - pad &&
      y <= lastCardRect.y + lastCardRect.h + pad
    );
  };

  const PULL_TOGGLE_PX = 56;
  const PULL_TEAR_PX = 118;

  const onPointerDown = (event) => {
    if (!settings.interactive || (event.button != null && event.button > 0)) return;
    if (!hitTestCard(event.clientX, event.clientY)) return;
    touch();
    const rect = stageCanvas.getBoundingClientRect();
    const vs = getViewSpace();
    const relX = event.clientX - rect.left - (lastCardRect.x + lastCardRect.w * 0.5);
    const relY = event.clientY - rect.top - (lastCardRect.y + lastCardRect.h * 0.5);
    const { dx, dy } = unprojectDelta(relX, relY, vs);
    const worldHit = new Vec3(sim.body.position.x + dx, sim.body.position.y + dy, sim.body.position.z);
    const nowMs = Date.now();
    sim.grab = {
      local: new Vec3(dx, dy, 0).applyQuaternion(sim.body.quaternion.clone().invert()),
      rotation: sim.body.quaternion.clone(),
      from: worldHit.clone(),
      target: worldHit.clone(),
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: nowMs,
      vxPx: 0,
      vyPx: 0,
      originWorld: worldHit.clone(),
      pullStage: 0,
    };
    press = { x: event.clientX, y: event.clientY, time: nowMs };
    gestureHint = '';
    stageCanvas.setPointerCapture?.(event.pointerId);
    stageCanvas.style.cursor = 'grabbing';
    event.preventDefault?.();
    start();
  };

  const onPointerMove = (event) => {
    if (!settings.interactive) return;
    if (sim.grab) {
      touch();
      const dxPx = event.clientX - sim.grab.startX;
      const dyPx = event.clientY - sim.grab.startY;
      const nowMs = Date.now();
      const dtMs = Math.max(8, nowMs - sim.grab.lastAt);
      sim.grab.vxPx = ((event.clientX - sim.grab.lastX) / dtMs) * 1000;
      sim.grab.vyPx = ((event.clientY - sim.grab.lastY) / dtMs) * 1000;
      sim.grab.lastX = event.clientX;
      sim.grab.lastY = event.clientY;
      sim.grab.lastAt = nowMs;

      if (press && Math.hypot(dxPx, dyPx) > 8) {
        press = null;
      }

      const canFling = Boolean(settings.onFlingNext || settings.onFlingPrev);
      const canPull = Boolean(settings.onPullToggle);
      const canTear = Boolean(settings.onTearTicket);
      if (canFling && Math.abs(dxPx) > 48 && Math.abs(dxPx) > Math.abs(dyPx) * 1.1) {
        gestureHint = dxPx < 0 ? '⟪ 松手切下一首' : '松手切上一首 ⟫';
        sim.grab.pullStage = 0;
      } else if (canTear && dyPx > PULL_TEAR_PX && Math.abs(dxPx) < 64) {
        if (sim.grab.pullStage !== 2) {
          sim.grab.pullStage = 2;
          try { navigator.vibrate?.(12); } catch {}
        }
        gestureHint = '⇣ 松手撕下当前歌词票';
      } else if (canPull && dyPx > PULL_TOGGLE_PX && Math.abs(dxPx) < 52) {
        if (sim.grab.pullStage === 0) {
          sim.grab.pullStage = 1;
          try { navigator.vibrate?.(6); } catch {}
        } else {
          sim.grab.pullStage = 1;
        }
        gestureHint = canTear ? '⇣ 松手暂停/播放 · 继续下拉撕歌词票' : '⇣ 松手暂停 / 播放';
      } else {
        gestureHint = '';
        sim.grab.pullStage = 0;
      }

      const vs = getViewSpace();
      const { dx, dy } = unprojectDelta(dxPx, dyPx, vs);
      sim.grab.target.set(
        sim.grab.originWorld.x + dx,
        sim.grab.originWorld.y + dy,
        sim.grab.originWorld.z + clamp(dx * 0.25, -0.35, 0.35)
      );
      start();
      return;
    }
    if (event.pointerType !== 'touch') {
      stageCanvas.style.cursor = hitTestCard(event.clientX, event.clientY) ? 'grab' : '';
    }
  };

  const onPointerUp = (event) => {
    if (!sim.grab) return;
    touch();
    const grabInfo = sim.grab;
    sim.grab = null;
    gestureHint = '';

    const dxPx = (event.clientX ?? grabInfo.lastX) - grabInfo.startX;
    const dyPx = (event.clientY ?? grabInfo.lastY) - grabInfo.startY;
    const vxPx = grabInfo.vxPx || 0;

    // 1. Horizontal Fling to Skip (甩动切歌)
    if (
      (Math.abs(dxPx) > 52 || Math.abs(vxPx) > 380) &&
      Math.abs(dxPx) > Math.abs(dyPx) * 1.1
    ) {
      try { navigator.vibrate?.(12); } catch {}
      if (dxPx < 0) {
        triggerTrackTransition('next');
        settings.onFlingNext?.();
      } else {
        triggerTrackTransition('prev');
        settings.onFlingPrev?.();
      }
      press = null;
      stageCanvas.releasePointerCapture?.(event.pointerId);
      stageCanvas.style.cursor = '';
      start();
      return;
    }

    // 2a. Stage 2 Deep Vertical Pull (> 118px) -> Tear Lyric Ticket (继续拉长撕歌词票)
    if (settings.onTearTicket && dyPx > PULL_TEAR_PX && Math.abs(dxPx) < 64) {
      try { navigator.vibrate?.([14, 28, 18]); } catch {}
      sim.body.velocity.y += 3.0;
      settings.onTearTicket();
      press = null;
      stageCanvas.releasePointerCapture?.(event.pointerId);
      stageCanvas.style.cursor = '';
      start();
      return;
    }

    // 2b. Stage 1 Normal Vertical Pull (56..118px) -> Toggle Play/Pause (短下拉播放/暂停)
    if (settings.onPullToggle && dyPx > PULL_TOGGLE_PX && Math.abs(dxPx) < 52) {
      try { navigator.vibrate?.(10); } catch {}
      sim.body.velocity.y += 2.4;
      settings.onPullToggle();
      press = null;
      stageCanvas.releasePointerCapture?.(event.pointerId);
      stageCanvas.style.cursor = '';
      start();
      return;
    }

    // 3. Tap to Flip / Double-Tap to Favorite
    if (press && Date.now() - press.time < 420) {
      const nowTap = Date.now();
      if (settings.onDoubleTap && nowTap - lastTapAt < 280) {
        lastTapAt = 0;
        try { navigator.vibrate?.(14); } catch {}
        settings.onDoubleTap();
      } else {
        lastTapAt = nowTap;
        flip();
      }
    }
    press = null;
    stageCanvas.releasePointerCapture?.(event.pointerId);
    stageCanvas.style.cursor = '';
    start();
  };

  stageCanvas.addEventListener('pointerdown', onPointerDown);
  stageCanvas.addEventListener('pointermove', onPointerMove);
  stageCanvas.addEventListener('pointerup', onPointerUp);
  stageCanvas.addEventListener('pointercancel', onPointerUp);
  stageCanvas.addEventListener('lostpointercapture', onPointerUp);

  const resize = () => {
    const cw = Math.max(240, container.clientWidth || 310);
    const ch = Math.max(280, container.clientHeight || 360);
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    view.width = cw;
    view.height = ch;
    view.dpr = dpr;
    stageCanvas.width = Math.round(cw * dpr);
    stageCanvas.height = Math.round(ch * dpr);
    apply();
  };

  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);

  const onVisibility = () => {
    if (doc.hidden || doc.visibilityState === 'hidden') {
      if (raf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    } else if (visible) {
      start();
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);

  resize();

  return {
    setProgress(prog) {
      if (!alive || !settings.cardMeta) return;
      const clamped = clamp(Number(prog) || 0, 0, 1);
      settings.cardMeta.progress = clamped;
      // Never repaint 2D face canvases while user is dragging or during fling animation,
      // and throttle progress ring repaints to >= 2.5% steps to keep 60/120fps physics silky smooth.
      if (sim.grab || Date.now() < flingBoostUntil) return;
      if (Math.abs(clamped - lastPaintedProgress) < 0.025) return;
      lastPaintedProgress = clamped;
      if (paintFaces() && !raf) render();
    },
    update(nextProps = {}) {
      if (!alive) return;
      Object.assign(settings, nextProps);
      const frontChanged = settings.frontImage !== loadedFrontUrl;
      const backChanged = settings.backImage !== loadedBackUrl;
      if (frontChanged || backChanged) {
        const readyFront = settings.frontImage ? resolvedImages.get(settings.frontImage) : null;
        const readyBack = settings.backImage ? resolvedImages.get(settings.backImage) : null;
        if (frontChanged) {
          images.front = readyFront || null;
          if (!settings.frontImage || readyFront) loadedFrontUrl = settings.frontImage;
        }
        if (backChanged) {
          images.back = readyBack || null;
          if (!settings.backImage || readyBack) loadedBackUrl = settings.backImage;
        }
        imagesVersion++;
        if (settings.frontImage && !readyFront) {
          loadImage(imageCache, resolvedImages, settings.frontImage);
        }
        if (settings.backImage && !readyBack) {
          loadImage(imageCache, resolvedImages, settings.backImage);
        }
      }
      const runUpdate = () => {
        pendingUpdateTimer = 0;
        if (!alive) return;
        lastPaintedProgress = settings.cardMeta?.progress ?? 0;
        if (
          settings.frontImage === loadedFrontUrl &&
          settings.backImage === loadedBackUrl &&
          images.front !== undefined &&
          placed
        ) {
          layout = cardLayout(settings.orientation, settings.cornerRadius);
          if (paintFaces() && !raf) render();
          return;
        }
        apply();
      };
      const waitMs = flingBoostUntil - Date.now();
      if (waitMs > 16) {
        clearTimeout(pendingUpdateTimer);
        pendingUpdateTimer = setTimeout(runUpdate, waitMs);
        return;
      }
      runUpdate();
    },
    flip() {
      if (!alive) return;
      flip();
    },
    triggerTrackTransition(dir = 'next') {
      if (!alive) return;
      triggerTrackTransition(dir);
    },
    cycleFinish() {
      if (!alive) return 'glossy';
      const idx = FINISH_ORDER.indexOf(settings.finish);
      const next = FINISH_ORDER[(idx + 1) % FINISH_ORDER.length];
      settings.finish = next;
      paintFaces();
      render();
      start();
      return next;
    },
    getFinish() {
      return settings.finish;
    },
    getFinishLabel() {
      return (FINISHES[settings.finish] || FINISHES.glossy).label;
    },
    isFlipped() {
      return sim.turn !== 0;
    },
    getSimulation() {
      return sim;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      clearTimeout(pendingUpdateTimer);
      if (raf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
      raf = 0;
      resizeObserver?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      stageCanvas.removeEventListener('pointerdown', onPointerDown);
      stageCanvas.removeEventListener('pointermove', onPointerMove);
      stageCanvas.removeEventListener('pointerup', onPointerUp);
      stageCanvas.removeEventListener('pointercancel', onPointerUp);
      stageCanvas.removeEventListener('lostpointercapture', onPointerUp);
      if (stageCanvas.parentNode) stageCanvas.parentNode.removeChild(stageCanvas);
    },
  };
}

/* ---------------- React Bits GLSL Holographic Foil Shaders ---------------- */

export const FOIL_VERTEX_HEAD = `
varying vec2 vFoilUv;
varying vec3 vFoilX;
varying vec3 vFoilY;
`;

export const FOIL_VERTEX_BODY = `
vFoilUv = uv;
vFoilX = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
vFoilY = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
`;

export const FOIL_FRAGMENT_HEAD = `
uniform float foilStrength;
uniform float foilAspect;
uniform vec3 foilKey;
uniform vec3 foilFill;
uniform vec3 foilTop;
varying vec2 vFoilUv;
varying vec3 vFoilX;
varying vec3 vFoilY;

float foilHash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float foilBump(float t, float center, float width) {
  float x = (t - center) / width;
  return max(0.0, 1.0 - x * x);
}

vec3 foilSpectrum(float t) {
  return vec3(
    foilBump(t, 0.82, 0.32) + 0.4 * foilBump(t, 0.02, 0.12),
    foilBump(t, 0.5, 0.26),
    foilBump(t, 0.18, 0.24)
  );
}

vec3 foilGrating(float u, float spacing) {
  vec3 color = vec3(0.0);
  for (int m = 1; m <= 2; m++) {
    float order = float(m);
    float t = (spacing * abs(u) / order - 0.38) / 0.32;
    color += foilSpectrum(t) / order;
  }
  return color;
}

vec3 foilShard(vec2 p) {
  vec2 base = floor(p);
  float best = 9.0;
  float edge = 9.0;
  vec2 id = base;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = base + vec2(float(i), float(j));
      vec2 site = cell + vec2(foilHash(cell), foilHash(cell + 7.31)) * 0.9 + 0.05;
      float d = length(site - p);
      if (d < best) {
        edge = best;
        best = d;
        id = cell;
      } else if (d < edge) {
        edge = d;
      }
    }
  }
  return vec3(foilHash(id + 3.17), foilHash(id + 11.73), edge - best);
}
`;

export const FOIL_FRAGMENT_BODY = `
if (foilStrength > 0.0) {
  vec3 foilView = normalize(vViewPosition);
  vec3 foilNormal = normalize(normal);
  vec2 foilP = vec2(vFoilUv.x, vFoilUv.y * foilAspect);
  vec3 shard = foilShard(foilP * 26.0);
  vec2 ray = foilP - vec2(-1.6, 2.6 * foilAspect);
  float angle = atan(ray.y, ray.x) + (shard.x - 0.5) * 0.16;
  vec3 grating = normalize(vFoilX * cos(angle) + vFoilY * sin(angle));
  float spacing = 1.7 * (0.95 + shard.y * 0.1);
  vec3 rainbow = foilGrating(dot(foilKey + foilView, grating), spacing);
  rainbow += 0.6 * foilGrating(dot(foilTop + foilView, grating), spacing);
  rainbow *= 0.8 + 0.2 * smoothstep(0.0, 0.04, shard.z);
  rainbow = max(rainbow - 0.35 * min(rainbow.r, min(rainbow.g, rainbow.b)), 0.0);
  vec2 grid = foilP * 64.0;
  vec2 cell = floor(grid);
  vec2 jitter = vec2(foilHash(cell + 1.7), foilHash(cell + 9.2));
  float flake = smoothstep(0.32, 0.06, length(fract(grid) - jitter * 0.6 - 0.2)) * step(0.45, foilHash(cell + 4.4));
  vec3 facet = normalize(foilNormal + (vFoilX * (jitter.x - 0.5) + vFoilY * (jitter.y - 0.5)) * 0.8);
  float glint = pow(max(dot(reflect(-foilKey, facet), foilView), 0.0), 28.0);
  glint += 0.7 * pow(max(dot(reflect(-foilTop, facet), foilView), 0.0), 28.0);
  float fine = 1.0 - smoothstep(0.35, 0.9, max(fwidth(grid.x), fwidth(grid.y)));
  vec3 sparkle = flake * glint * fine * (vec3(0.7) + foilGrating(dot(foilKey + foilView, grating) + jitter.x * 0.4, spacing));
  float ink = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float foil = foilStrength * (0.08 + 0.92 * smoothstep(0.04, 0.7, ink));
  float facing = clamp(dot(foilNormal, foilView), 0.0, 1.0);
  float tint = clamp(dot(rainbow, vec3(0.4)), 0.0, 1.0);
  outgoingLight = outgoingLight * (1.0 - foil * (0.3 + 0.32 * tint)) + (rainbow * 0.62 * (0.4 + 0.6 * facing) + sparkle * 1.6) * foil;
}
`;

export function injectFoilShader(shader, foilUniforms) {
  Object.assign(shader.uniforms, foilUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${FOIL_VERTEX_HEAD}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${FOIL_VERTEX_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FOIL_FRAGMENT_HEAD}`)
    .replace('#include <opaque_fragment>', `${FOIL_FRAGMENT_BODY}\n#include <opaque_fragment>`);
}

export default mountLanyard;
