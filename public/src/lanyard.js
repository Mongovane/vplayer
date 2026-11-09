/**
 * VPlayer · Vane — 3D Holographic Lanyard Component (`public/src/lanyard.js`)
 *
 * Pure Vanilla ES Module port of React Bits `<Lanyard />`:
 * https://shadcnregistry.com/react-bits/lanyard-js-tw
 *
 * Features:
 * 1. Full XPBD 4-joint rope & 3D rigid-body quaternion physics simulation
 *    (gravity, breeze, damping, elasticity, pointer grab/stretch/throw, and
 *    click/tap 180-degree spin flip).
 * 2. Dual-engine architecture:
 *    - Instant zero-dependency Canvas 3D + Holographic Foil Shader engine
 *      (works 100% offline in 0ms inside PWA / Airplane Mode / JSDOM).
 *    - Optional Three.js WebGL upgrade when `useWebGL: true` and Three.js is
 *      available via `window.THREE` or CDN.
 * 3. Strict iOS Lock Screen & AirPods isolation:
 *    - Never touches `<audio>`, `navigator.mediaSession`, or Web Audio API.
 *    - Automatically stops `requestAnimationFrame` when `document.hidden`
 *      (`document.visibilityState === 'hidden'`) or when destroyed.
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
const ITERATIONS = 2;
const SAMPLES = 48;
const FOV = 24;
const STRAP_WIDTH = 0.36;
const RING_RADIUS = 0.095;
const EYELET_RADIUS = 0.036;
const CLAMP_BODY = 0.15;
const FACE_WIDTH = 720;
const FLIP_SPIN = 9;

export const FINISHES = {
  holographic: { label: '全息闪卡', roughness: 0.3, metalness: 0, clearcoat: 1, foil: 1.0, sheen: 0.9 },
  metallic: { label: '拉丝金属', roughness: 0.36, metalness: 0.75, clearcoat: 0.5, foil: 0.35, sheen: 0.85 },
  glossy: { label: '镜面高光', roughness: 0.42, metalness: 0, clearcoat: 1, foil: 0.0, sheen: 0.75 },
  matte: { label: '磨砂哑光', roughness: 0.85, metalness: 0, clearcoat: 0, foil: 0.0, sheen: 0.2 },
};

export const FINISH_ORDER = ['holographic', 'metallic', 'glossy', 'matte'];

const METALS = {
  silver: { color: '#d9dce2', hi: '#f5f7fa', lo: '#6e737d' },
  gold: { color: '#d8a24a', hi: '#f5df9e', lo: '#7d591d' },
  graphite: { color: '#4d4f55', hi: '#8b8f99', lo: '#232529' },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;

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
    if (intro) nodes[i].x += sim.rest * 0.85;
    else nodes[i].y -= sim.rest;
  }
  body.quaternion.identity();
  if (intro) body.quaternion.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI * 0.36);
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
  const steps = Math.max(1, Math.ceil(dt / MAX_STEP - 1e-6));
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

/* --------------------- VPlayer Card Face 2D Synthesizer ------------------- */

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

/**
 * Paints the front or back face of the VPlayer 3D Pass Card onto a 2D canvas.
 * Supports both `'song'` mode (album cover + lyrics + bearing) and
 * `'identity'` mode (Station Owner / Crew Member / Voyager pass).
 */
export function paintVPlayerPassCard(canvas, side, meta = {}, coverImage = null) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const w = canvas.width || 720;
  const h = canvas.height || 1012;
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  const isIdentity = meta.kind === 'identity';
  const accent = meta.accent || (isIdentity && meta.role === 'owner' ? '#e4b965' : '#d8a24a');
  const subAccent = meta.subAccent || '#84b4c8';

  // 1. Deep Nautical Obsidian Base Gradient
  const grad = ctx.createLinearGradient(0, 0, w * 0.4, h);
  if (side === 'front') {
    grad.addColorStop(0, '#141b24');
    grad.addColorStop(0.52, '#0c1017');
    grad.addColorStop(1, '#07090d');
  } else {
    grad.addColorStop(0, '#0f151d');
    grad.addColorStop(0.5, '#121822');
    grad.addColorStop(1, '#07090d');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // 2. Brass & Horizon Inner Frame
  ctx.strokeStyle = 'rgba(216, 162, 74, 0.34)';
  ctx.lineWidth = Math.max(2, w * 0.0032);
  roundRectPath(ctx, w * 0.048, h * 0.085, w * 0.904, h * 0.865, w * 0.035);
  ctx.stroke();

  // Top Lanyard Slot Cutout Bezel
  const slotW = w * 0.22;
  const slotH = h * 0.028;
  const slotX = (w - slotW) / 2;
  const slotY = h * 0.034;
  ctx.fillStyle = '#040608';
  roundRectPath(ctx, slotX, slotY, slotW, slotH, slotH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(216, 162, 74, 0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 3. Telemetry Header Bar
  ctx.fillStyle = accent;
  ctx.font = `600 ${Math.round(w * 0.025)}px ui-monospace, SFMono-Regular, monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(String(meta.badge || 'VANE // HOLOGRAPHIC PASS').toUpperCase(), w * 0.088, h * 0.132);

  ctx.fillStyle = subAccent;
  ctx.textAlign = 'right';
  ctx.fillText(String(meta.bearingText || 'BRG 000°'), w * 0.912, h * 0.132);

  if (side === 'front') {
    const cx = w / 2;
    const cy = h * 0.385;
    const discR = w * 0.285;

    // Compass rings around cover/emblem
    ctx.strokeStyle = 'rgba(132, 180, 200, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, discR + w * 0.048, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(216, 162, 74, 0.32)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, discR + w * 0.018, 0, Math.PI * 2);
    ctx.stroke();

    if (coverImage && (coverImage.complete !== false) && (coverImage.naturalWidth > 0 || coverImage.width > 0)) {
      const iw = coverImage.naturalWidth || coverImage.width;
      const ih = coverImage.naturalHeight || coverImage.height;
      const scale = Math.max((discR * 2) / iw, (discR * 2) / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, discR, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(coverImage, cx - dw / 2, cy - dh / 2, dw, dh);
      ctx.restore();
    } else {
      // Nautical Vinyl / Compass Emblem
      const discGrad = ctx.createRadialGradient(cx, cy, discR * 0.1, cx, cy, discR);
      discGrad.addColorStop(0, '#222b38');
      discGrad.addColorStop(0.65, '#10151d');
      discGrad.addColorStop(1, '#080b10');
      ctx.fillStyle = discGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, discR, 0, Math.PI * 2);
      ctx.fill();

      // Vinyl grooves
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      for (let r = discR * 0.35; r < discR * 0.92; r += discR * 0.09) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Center brass medallion
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, cy, discR * 0.24, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#090c10';
      ctx.font = `700 ${Math.round(w * 0.044)}px ui-monospace, SFMono-Regular, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isIdentity ? (meta.roleCode || 'VIP') : 'VANE', cx, cy);
      ctx.textBaseline = 'alphabetic';
    }

    // Track / Identity Title & Subtitle
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f4efe4';
    ctx.font = `700 ${Math.round(w * 0.052)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    const title = String(meta.title || 'VPlayer · Vane').slice(0, 22);
    ctx.fillText(title, w / 2, h * 0.665);

    ctx.fillStyle = '#9aa8b8';
    ctx.font = `500 ${Math.round(w * 0.033)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    const artist = String(meta.artist || 'Marine Instrument Audio').slice(0, 30);
    ctx.fillText(artist, w / 2, h * 0.715);

    // Highlight lyric / role quote
    const quote = String(meta.lyric || meta.subtitle || '').trim();
    if (quote) {
      ctx.fillStyle = accent;
      ctx.font = `600 ${Math.round(w * 0.032)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      const clipped = quote.length > 26 ? `${quote.slice(0, 25)}…` : quote;
      ctx.fillText(`“${clipped}”`, w / 2, h * 0.785);
    }

    const subQuote = String(meta.tlyric || meta.statsLine || '').trim();
    if (subQuote) {
      ctx.fillStyle = 'rgba(242, 237, 226, 0.62)';
      ctx.font = `400 ${Math.round(w * 0.026)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      const clippedSub = subQuote.length > 32 ? `${subQuote.slice(0, 31)}…` : subQuote;
      ctx.fillText(clippedSub, w / 2, h * 0.83);
    }

    // Bottom Pass Pill
    ctx.fillStyle = 'rgba(216, 162, 74, 0.14)';
    roundRectPath(ctx, w * 0.18, h * 0.875, w * 0.64, h * 0.046, h * 0.023);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.font = `600 ${Math.round(w * 0.022)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillText(String(meta.footerTag || 'TAP TO FLIP · DRAG TO SWING'), w / 2, h * 0.905);
  } else {
    // Back Face: Bilingual Lyrics / Telemetry Log
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f4efe4';
    ctx.font = `700 ${Math.round(w * 0.044)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(String(meta.title || 'VPlayer · Vane').slice(0, 22), w * 0.095, h * 0.21);

    ctx.fillStyle = '#8fa0b3';
    ctx.font = `500 ${Math.round(w * 0.029)}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.fillText(String(meta.artist || 'Vane Marine Audio').slice(0, 32), w * 0.095, h * 0.252);

    ctx.strokeStyle = 'rgba(216, 162, 74, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w * 0.095, h * 0.282);
    ctx.lineTo(w * 0.905, h * 0.282);
    ctx.stroke();

    const lines = Array.isArray(meta.lyricsLines) && meta.lyricsLines.length
      ? meta.lyricsLines.slice(0, 7)
      : [
          meta.lyric || 'Angle carries time · 角度承载时间',
          meta.tlyric || '拖拽挂绳体验 XPBD 物理惯性摆动',
          '轻点卡片正反面触发 180° 翻转',
          'Holographic Foil · 全息闪卡光栅',
          'iOS 锁屏与后台自动休眠零耗电',
        ];

    let y = h * 0.345;
    lines.forEach((ln, idx) => {
      const isHighlight = idx === 0;
      ctx.fillStyle = isHighlight ? accent : 'rgba(242, 237, 226, 0.82)';
      ctx.font = `${isHighlight ? 600 : 400} ${Math.round(w * (isHighlight ? 0.033 : 0.029))}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
      const text = String(ln || '').trim();
      const clipped = text.length > 26 ? `${text.slice(0, 25)}…` : text;
      ctx.fillText(clipped, w * 0.095, y);
      y += h * 0.068;
    });

    // Telemetry grid box at bottom of back card
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    roundRectPath(ctx, w * 0.095, h * 0.81, w * 0.81, h * 0.1, w * 0.02);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = subAccent;
    ctx.font = `600 ${Math.round(w * 0.023)}px ui-monospace, SFMono-Regular, monospace`;
    ctx.fillText(String(meta.serialLine || 'PASS // VANE-HOLO-V152'), w * 0.125, h * 0.852);
    ctx.fillStyle = 'rgba(242, 237, 226, 0.55)';
    ctx.fillText(String(meta.dateLine || new Date().toISOString().slice(0, 10)), w * 0.125, h * 0.888);
  }

  ctx.restore();
}

/* ---------------- Built-in Interactive 3D Canvas Lanyard ------------------ */

const loadImage = (cache, url) => {
  if (!url || typeof Image === 'undefined') return Promise.resolve(null);
  const cached = cache.get(url);
  if (cached) return cached;
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  cache.set(url, promise);
  return promise;
};

/**
 * Mounts the interactive 3D Holographic Lanyard inside `container`.
 * Works 100% offline with zero external dependencies using the exact XPBD
 * rope + rigid-body physics and holographic foil grating shader logic.
 */
export async function mountLanyard(container, initialOptions = {}) {
  if (!container) throw new Error('mountLanyard requires a valid DOM container');

  const settings = {
    frontImage: undefined,
    backImage: undefined,
    imageFit: 'cover',
    cardColor: '#10151d',
    orientation: 'portrait',
    finish: 'holographic',
    cornerRadius: 0.3,
    size: 0.62,
    anchor: 'center',
    strapLength: 0.44,
    strapImage: undefined,
    strapColor: '#12161f',
    strapWidth: 0.68,
    metal: 'gold',
    gravity: 1,
    damping: 0.5,
    elasticity: 0.55,
    breeze: 0.45,
    interactive: true,
    intro: true,
    cardMeta: null,
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
  const images = { front: null, back: null };
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
  let imageToken = 0;
  let lastCardRect = { x: 0, y: 0, w: 0, h: 0 };

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
      breeze: reducedMotion ? 0 : clamp(settings.breeze, 0, 1),
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
    const scale = ( vs.camZ / dz ) * (view.height / vs.viewHeight);
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
    const cardTop = vs.viewHeight / 2 - vs.viewHeight * mix(0.12, 0.38, clamp(settings.strapLength, 0, 1));
    const hangTop = cardTop + (layout.hangY - layout.height / 2);
    sim.anchor.set(anchorX, anchorY, 0);
    configureSimulation(sim, layout, Math.max(0.45, anchorY - hangTop));
    sim.nodes[0].copy(sim.anchor);
    sim.previous[0].copy(sim.anchor);
  };

  const paintFaces = () => {
    layout = cardLayout(settings.orientation, settings.cornerRadius);
    const w = FACE_WIDTH;
    const h = Math.round((FACE_WIDTH * layout.height) / layout.width);
    if (frontCanvas.width !== w || frontCanvas.height !== h) {
      frontCanvas.width = w;
      frontCanvas.height = h;
      backCanvas.width = w;
      backCanvas.height = h;
    }
    const meta = settings.cardMeta || {
      title: 'VPlayer · Vane',
      artist: 'Holographic Music Pass',
      badge: 'VANE // HOLOGRAPHIC PASS',
    };
    paintVPlayerPassCard(frontCanvas, 'front', meta, images.front);
    paintVPlayerPassCard(backCanvas, 'back', meta, images.back || images.front);
  };

  const render = () => {
    const ctx = stageCanvas.getContext?.('2d');
    if (!ctx) return;

    const dpr = view.dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);

    const vs = getViewSpace();
    const metalLook = METALS[settings.metal] || METALS.gold;
    const finishLook = FINISHES[settings.finish] || FINISHES.holographic;

    // 1. Project rope nodes and draw woven lanyard strap
    const projNodes = sim.nodes.map((n) => project3D(n, vs));
    const p0 = projNodes[0];
    const pLast = projNodes[JOINTS];
    const strapPxW = Math.max(14, STRAP_WIDTH * clamp(settings.strapWidth, 0.4, 2) * (view.height / vs.viewHeight) * 0.78);

    // Strap shadow
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.lineWidth = strapPxW + 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p0.x + 4, p0.y + 6);
    for (let i = 1; i <= JOINTS; i++) {
      const prev = projNodes[i - 1];
      const cur = projNodes[i];
      const mx = (prev.x + cur.x) * 0.5 + 4;
      const my = (prev.y + cur.y) * 0.5 + 6;
      ctx.quadraticCurveTo(prev.x + 4, prev.y + 6, mx, my);
    }
    ctx.lineTo(pLast.x + 4, pLast.y + 6);
    ctx.stroke();

    // Main woven strap body
    const strapGrad = ctx.createLinearGradient(p0.x - strapPxW, p0.y, pLast.x + strapPxW, pLast.y);
    strapGrad.addColorStop(0, '#181e29');
    strapGrad.addColorStop(0.5, '#0e121a');
    strapGrad.addColorStop(1, '#1a212e');
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

    // Brass edge stitching on strap
    ctx.strokeStyle = 'rgba(216, 162, 74, 0.42)';
    ctx.lineWidth = Math.max(1.2, strapPxW * 0.08);
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 2. Metallic Clamp & Ring at hang node
    ctx.save();
    ctx.translate(pLast.x, pLast.y);
    const axisX = p0.x - pLast.x;
    const axisY = p0.y - pLast.y;
    const strapAngle = Math.atan2(axisX, -axisY);
    ctx.rotate(strapAngle * 0.45);

    const clampW = strapPxW * 1.18;
    const clampH = Math.max(10, strapPxW * 0.52);
    const clampGrad = ctx.createLinearGradient(-clampW / 2, 0, clampW / 2, 0);
    clampGrad.addColorStop(0, metalLook.lo);
    clampGrad.addColorStop(0.45, metalLook.hi);
    clampGrad.addColorStop(1, metalLook.lo);
    ctx.fillStyle = clampGrad;
    roundRectPath(ctx, -clampW / 2, -clampH * 0.85, clampW, clampH, 4);
    ctx.fill();

    // Metallic split ring
    ctx.strokeStyle = metalLook.hi;
    ctx.lineWidth = Math.max(2.5, strapPxW * 0.14);
    ctx.beginPath();
    ctx.arc(0, clampH * 0.35, Math.max(6, strapPxW * 0.32), 0, Math.PI * 2);
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
    const pitchScale = clamp(Math.hypot(up.x, up.y), 0.72, 1.04);
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

    // Roll & tilt matrix from 3D quaternion basis vectors
    const rollAngle = Math.atan2(-right.y * faceSign, Math.max(0.08, Math.abs(right.x)));
    ctx.rotate(clamp(rollAngle, -0.65, 0.65));
    ctx.transform(horizScale, sinTilt * 0.18, -sinTilt * 0.12, pitchScale, 0, 0);

    const rad = Math.min(cardPxW, cardPxH) * mix(0.03, 0.14, clamp(settings.cornerRadius, 0, 1));

    // Drop shadow behind 3D card
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetX = -normal.x * 18;
    ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#07090d';
    roundRectPath(ctx, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH, rad);
    ctx.fill();
    ctx.restore();

    // 3D Card Edge Bevel Thickness when turned at an angle
    const edgeShift = clamp(-normal.x * 7, -6, 6);
    if (Math.abs(edgeShift) > 0.6) {
      ctx.fillStyle = metalLook.lo;
      roundRectPath(ctx, -cardPxW / 2 + edgeShift, -cardPxH / 2 + 1.5, cardPxW, cardPxH, rad);
      ctx.fill();
    }

    // Clip card body and draw active face texture
    ctx.save();
    roundRectPath(ctx, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH, rad);
    ctx.clip();

    const activeFace = isFront ? frontCanvas : backCanvas;
    ctx.drawImage(activeFace, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH);

    // 4. Holographic Foil Grating & Dynamic Specular Glint Overlay
    const viewAngle = Math.atan2(normal.x, Math.max(0.05, Math.abs(normal.z))) + normal.y * 0.8 + time * 0.25;
    if (finishLook.foil > 0) {
      const holoGrad = ctx.createLinearGradient(
        -cardPxW * 0.6 + Math.sin(viewAngle) * cardPxW * 0.4,
        -cardPxH * 0.6,
        cardPxW * 0.6 + Math.cos(viewAngle) * cardPxW * 0.4,
        cardPxH * 0.6
      );
      const alpha = (0.14 + Math.abs(normal.x) * 0.24) * finishLook.foil;
      holoGrad.addColorStop(0, `rgba(255, 90, 180, ${alpha.toFixed(3)})`);
      holoGrad.addColorStop(0.25, `rgba(90, 220, 255, ${(alpha * 1.15).toFixed(3)})`);
      holoGrad.addColorStop(0.5, `rgba(250, 220, 110, ${(alpha * 0.95).toFixed(3)})`);
      holoGrad.addColorStop(0.75, `rgba(130, 255, 190, ${(alpha * 1.1).toFixed(3)})`);
      holoGrad.addColorStop(1, `rgba(190, 120, 255, ${alpha.toFixed(3)})`);
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = holoGrad;
      ctx.fillRect(-cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH);
      ctx.globalCompositeOperation = 'source-over';
    }

    if (finishLook.sheen > 0) {
      const sheenX = normal.x * cardPxW * 0.85;
      const sheenGrad = ctx.createLinearGradient(
        sheenX - cardPxW * 0.35,
        -cardPxH * 0.5,
        sheenX + cardPxW * 0.35,
        cardPxH * 0.5
      );
      const sAlpha = 0.16 * finishLook.sheen;
      sheenGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
      sheenGrad.addColorStop(0.5, `rgba(255, 255, 255, ${sAlpha.toFixed(3)})`);
      sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = sheenGrad;
      ctx.fillRect(-cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH);
    }

    ctx.restore();

    // Outer specular rim
    ctx.strokeStyle = finishLook.foil > 0
      ? 'rgba(228, 185, 101, 0.52)'
      : 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, -cardPxW / 2, -cardPxH / 2, cardPxW, cardPxH, rad);
    ctx.stroke();

    ctx.restore();
    ctx.restore();
  };

  const tick = (now) => {
    raf = 0;
    if (!alive || doc.hidden || doc.visibilityState === 'hidden' || !visible) return;
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000));
    last = now;
    time += dt;
    const current = physics();
    stepSimulation(sim, dt, current, time);
    const body = sim.body;
    if (!Number.isFinite(body.position.x + body.position.y + body.position.z + body.quaternion.w)) {
      sim.grab = null;
      placeHanging(sim, layout, false);
    }
    render();
    const resting = sim.calm > 1.2 && !sim.grab && current.breeze === 0;
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
    const body = sim.body;
    const up = scratch.a.set(0, 1, 0).applyQuaternion(body.quaternion);
    const direction = sim.turn > 0 ? -1 : 1;
    sim.turn = sim.turn === 0 ? Math.PI * direction : 0;
    body.angular.addScaledVector(up, FLIP_SPIN * direction);
    start();
  };

  const apply = () => {
    layout = cardLayout(settings.orientation, settings.cornerRadius);
    frameView();
    if (!placed) {
      placeHanging(sim, layout, settings.intro && !reducedMotion);
      placed = true;
    }
    const token = ++imageToken;
    Promise.all([
      loadImage(imageCache, settings.frontImage),
      loadImage(imageCache, settings.backImage),
    ]).then(([front, back]) => {
      if (!alive || token !== imageToken) return;
      images.front = front;
      images.back = back;
      paintFaces();
      render();
      start();
    });
    paintFaces();
    render();
    start();
  };

  const hitTestCard = (clientX, clientY) => {
    const rect = stageCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const pad = 24;
    return (
      x >= lastCardRect.x - pad &&
      x <= lastCardRect.x + lastCardRect.w + pad &&
      y >= lastCardRect.y - pad &&
      y <= lastCardRect.y + lastCardRect.h + pad
    );
  };

  const onPointerDown = (event) => {
    if (!settings.interactive || (event.button != null && event.button > 0)) return;
    if (!hitTestCard(event.clientX, event.clientY)) return;
    const rect = stageCanvas.getBoundingClientRect();
    const vs = getViewSpace();
    const relX = event.clientX - rect.left - (lastCardRect.x + lastCardRect.w * 0.5);
    const relY = event.clientY - rect.top - (lastCardRect.y + lastCardRect.h * 0.5);
    const { dx, dy } = unprojectDelta(relX, relY, vs);
    const worldHit = new Vec3(sim.body.position.x + dx, sim.body.position.y + dy, sim.body.position.z);
    sim.grab = {
      local: new Vec3(dx, dy, 0).applyQuaternion(sim.body.quaternion.clone().invert()),
      rotation: sim.body.quaternion.clone(),
      from: worldHit.clone(),
      target: worldHit.clone(),
      startX: event.clientX,
      startY: event.clientY,
      originWorld: worldHit.clone(),
    };
    press = { x: event.clientX, y: event.clientY, time: Date.now() };
    stageCanvas.setPointerCapture?.(event.pointerId);
    stageCanvas.style.cursor = 'grabbing';
    event.preventDefault?.();
    start();
  };

  const onPointerMove = (event) => {
    if (!settings.interactive) return;
    if (sim.grab) {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
        press = null;
      }
      const vs = getViewSpace();
      const { dx, dy } = unprojectDelta(
        event.clientX - sim.grab.startX,
        event.clientY - sim.grab.startY,
        vs
      );
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
    sim.grab = null;
    if (press && Date.now() - press.time < 420) {
      flip();
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
    const cw = Math.max(260, container.clientWidth || 310);
    const ch = Math.max(320, container.clientHeight || 400);
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
    update(nextProps = {}) {
      if (!alive) return;
      Object.assign(settings, nextProps);
      apply();
    },
    flip() {
      if (!alive) return;
      flip();
    },
    cycleFinish() {
      if (!alive) return 'holographic';
      const idx = FINISH_ORDER.indexOf(settings.finish);
      const next = FINISH_ORDER[(idx + 1) % FINISH_ORDER.length];
      settings.finish = next;
      render();
      start();
      return next;
    },
    getFinish() {
      return settings.finish;
    },
    getFinishLabel() {
      return (FINISHES[settings.finish] || FINISHES.holographic).label;
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

export default mountLanyard;

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
