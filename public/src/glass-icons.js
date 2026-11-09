/**
 * React Bits <GlassIcons /> — Vanilla ES Module port for VPlayer (#rail).
 *
 * Features:
 * - Procedural rounded-box SDF bevel normal map, specular rim shine map, and
 *   inner shade map (`buildMaps`) with SVG `<feDisplacementMap>` refraction.
 * - Optional WebGL2 refractive glass shader (`VERTEX` / `FRAGMENT`) with
 *   chromatic dispersion, frost LOD blur, and Fresnel rim lighting.
 * - 16-channel second-order damped spring physics (`drive` + `poseOf`) for
 *   tilted colored backplates (`plate="tilt"`), press/lift hover response,
 *   and icon glyph parallax.
 * - Mobile-first resting 3D tilt so the signature layered glass-over-color-plate
 *   aesthetic is immediately visible on iOS PWA touchscreens, expanding further
 *   when a tab is active (`on` / `aria-current="true"`) or touched/hovered.
 */

export const GRADIENTS = {
  blue: 'linear-gradient(135deg, #2563eb, #3b82f6)',
  purple: 'linear-gradient(135deg, #7c3aed, #8b5cf6)',
  red: 'linear-gradient(135deg, #dc2626, #ef4444)',
  indigo: 'linear-gradient(135deg, #4338ca, #6366f1)',
  orange: 'linear-gradient(135deg, #ea580c, #f97316)',
  green: 'linear-gradient(135deg, #059669, #10b981)',
  teal: 'linear-gradient(135deg, #0d9488, #14b8a6)',
  pink: 'linear-gradient(135deg, #db2777, #ec4899)',
  graphite: 'linear-gradient(135deg, #1f242d, #3a414d)',
  silver: 'linear-gradient(135deg, #9ca3af, #e5e7eb)',
  gold: 'linear-gradient(135deg, #b4822c, #e5be67)',
};

export const THEMES = {
  dark: {
    '--gi-label': 'rgba(242, 237, 226, 0.86)',
    '--gi-shadow-plate': '0 10px 22px -6px rgba(0, 0, 0, 0.56), 0 3px 8px -2px rgba(0, 0, 0, 0.36)',
    '--gi-shadow-glass': '0 12px 26px -6px rgba(0, 0, 0, 0.62), 0 4px 10px -2px rgba(0, 0, 0, 0.42)',
    '--gi-edge-top': 'rgba(255, 255, 255, 0.46)',
    '--gi-edge-bottom': 'rgba(255, 255, 255, 0.14)',
    '--gi-inner-glow': 'rgba(255, 255, 255, 0.1)',
  },
  light: {
    '--gi-label': 'rgba(15, 23, 42, 0.82)',
    '--gi-shadow-plate': '0 12px 24px -6px rgba(15, 23, 42, 0.22), 0 4px 10px -2px rgba(15, 23, 42, 0.12)',
    '--gi-shadow-glass': '0 14px 30px -6px rgba(15, 23, 42, 0.2), 0 5px 12px -2px rgba(15, 23, 42, 0.1)',
    '--gi-edge-top': 'rgba(255, 255, 255, 0.88)',
    '--gi-edge-bottom': 'rgba(15, 23, 42, 0.12)',
    '--gi-inner-glow': 'rgba(255, 255, 255, 0.55)',
  },
};

export const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_scene;
uniform vec2 u_canvasSize;
uniform vec4 u_rect;
uniform float u_radius;
uniform float u_refraction;
uniform float u_bevel;
uniform float u_dispersion;
uniform float u_frost;
uniform float u_shine;
uniform vec3 u_tint;
uniform float u_tintOpacity;
uniform vec2 u_mouse;
uniform float u_hover;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  vec2 itemPx = u_rect.zw;
  vec2 halfSize = itemPx * 0.5;
  vec2 p = (v_uv - 0.5) * itemPx;
  float r = clamp(u_radius, 0.0, min(halfSize.x, halfSize.y));
  float d = sdRoundBox(p, halfSize, r);
  float aa = 1.2;
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha <= 0.001) discard;

  float bevelPx = mix(8.0, min(halfSize.x, halfSize.y) * 0.92, clamp(u_bevel, 0.02, 1.0));
  float edgeFactor = smoothstep(-bevelPx, 0.0, d);
  float eps = 1.5;
  float dx = sdRoundBox(p + vec2(eps, 0.0), halfSize, r) - sdRoundBox(p - vec2(eps, 0.0), halfSize, r);
  float dy = sdRoundBox(p + vec2(0.0, eps), halfSize, r) - sdRoundBox(p - vec2(0.0, eps), halfSize, r);
  vec2 grad = normalize(vec2(dx, dy) + vec2(1e-5));

  float curve = pow(edgeFactor, 1.65);
  float lens = -0.18 * (1.0 - edgeFactor);
  vec2 offsetPx = grad * (curve * u_refraction * bevelPx * 0.85 + lens * length(p) * u_refraction);

  vec2 itemCenterTopLeft = u_rect.xy + vec2(v_uv.x, 1.0 - v_uv.y) * u_rect.zw;
  vec2 baseUv = vec2(itemCenterTopLeft.x / u_canvasSize.x, 1.0 - itemCenterTopLeft.y / u_canvasSize.y);
  vec2 offsetUv = vec2(offsetPx.x, -offsetPx.y) / u_canvasSize;

  float lod = u_frost * 4.2;
  float disp = u_dispersion * (0.35 + 0.65 * edgeFactor);
  vec2 rUv = clamp(baseUv + offsetUv * (1.0 + disp * 0.28), 0.002, 0.998);
  vec2 gUv = clamp(baseUv + offsetUv, 0.002, 0.998);
  vec2 bUv = clamp(baseUv + offsetUv * (1.0 - disp * 0.28), 0.002, 0.998);

  vec3 refracted;
  if (lod > 0.05) {
    vec2 texel = (1.5 + u_frost * 6.5) / u_canvasSize;
    vec3 acc = vec3(0.0);
    float wSum = 0.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        vec2 o = vec2(float(x), float(y)) * texel;
        float w = (x == 0 && y == 0) ? 2.0 : (x == 0 || y == 0) ? 1.0 : 0.6;
        vec3 s;
        s.r = textureLod(u_scene, clamp(rUv + o, 0.002, 0.998), lod).r;
        s.g = textureLod(u_scene, clamp(gUv + o, 0.002, 0.998), lod).g;
        s.b = textureLod(u_scene, clamp(bUv + o, 0.002, 0.998), lod).b;
        acc += s * w;
        wSum += w;
      }
    }
    refracted = acc / wSum;
  } else {
    refracted.r = texture(u_scene, rUv).r;
    refracted.g = texture(u_scene, gUv).g;
    refracted.b = texture(u_scene, bUv).b;
  }

  vec3 glass = mix(refracted, u_tint, u_tintOpacity);
  float nz = sqrt(max(0.01, 1.0 - clamp(edgeFactor * 0.92, 0.0, 0.92)));
  vec3 normal = normalize(vec3(grad * edgeFactor * 0.9, nz));
  vec3 light1 = normalize(vec3(-0.6, 0.68, 0.42));
  vec3 light2 = normalize(vec3(0.58, -0.62, 0.52));
  float spec1 = pow(max(dot(normal, light1), 0.0), 28.0) * edgeFactor;
  float spec2 = pow(max(dot(normal, light2), 0.0), 36.0) * edgeFactor * 0.45;
  float fresnel = pow(edgeFactor, 3.0) * 0.32;
  float rimPx = smoothstep(-2.4, -0.4, d);
  float rimDir = 0.55 + 0.45 * clamp(dot(grad, vec2(-0.707, 0.707)), -1.0, 1.0);
  float rim = rimPx * rimDir * 0.55;

  vec2 mouseVec = (v_uv - u_mouse) * itemPx;
  float mouseSpot = exp(-dot(mouseVec, mouseVec) / (itemPx.x * itemPx.x * 0.35)) * u_hover * 0.14;

  vec3 lit = glass
    + vec3(1.0) * (spec1 * 1.15 + spec2 + fresnel + rim) * u_shine
    + vec3(1.0) * mouseSpot * u_shine;

  float bodyShadow = (1.0 - edgeFactor) * 0.03;
  lit -= bodyShadow;
  fragColor = vec4(lit, alpha);
}`;

const mapCache = new Map();

export function buildMaps(size, radius, bevel) {
  const key = `${size}:${radius.toFixed(1)}:${bevel.toFixed(2)}`;
  if (mapCache.has(key)) return mapCache.get(key);

  const w = Math.max(64, Math.min(256, Math.round(size * 2)));
  const scale = w / Math.max(1, size);
  const half = w * 0.5;
  const r = Math.max(2, Math.min(half - 2, radius * scale));
  const bevelPx = (0.08 + Math.max(0.02, Math.min(1, bevel)) * 0.4) * w;

  if (typeof document === 'undefined') {
    const empty = { refractionUrl: '', shineUrl: '', shadeUrl: '' };
    mapCache.set(key, empty);
    return empty;
  }

  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = w;
    return c;
  };

  const cRef = makeCanvas();
  const cShine = makeCanvas();
  const cShade = makeCanvas();
  const gRef = cRef.getContext?.('2d');
  const gShine = cShine.getContext?.('2d');
  const gShade = cShade.getContext?.('2d');

  if (!gRef || !gShine || !gShade || typeof gRef.createImageData !== 'function') {
    const empty = { refractionUrl: '', shineUrl: '', shadeUrl: '' };
    mapCache.set(key, empty);
    return empty;
  }

  const refImg = gRef.createImageData(w, w);
  const shineImg = gShine.createImageData(w, w);
  const shadeImg = gShade.createImageData(w, w);
  const refD = refImg.data;
  const shineD = shineImg.data;
  const shadeD = shadeImg.data;

  const sdf = (px, py) => {
    const qx = Math.abs(px) - (half - r);
    const qy = Math.abs(py) - (half - r);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
  };

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      const d = sdf(px, py);
      const idx = (y * w + x) * 4;

      if (d > 1.5) {
        refD[idx] = 128;
        refD[idx + 1] = 128;
        refD[idx + 2] = 128;
        refD[idx + 3] = 255;
        continue;
      }

      const gx = sdf(px + 1, py) - sdf(px - 1, py);
      const gy = sdf(px, py + 1) - sdf(px, py - 1);
      const gl = Math.hypot(gx, gy) || 1;
      const nx = gx / gl;
      const ny = gy / gl;

      const t = Math.max(0, Math.min(1, 1 + d / bevelPx));
      const edge = t * t * (3 - 2 * t);
      const dome = -0.14 * (1 - edge) * (Math.hypot(px, py) / half);
      const mag = Math.pow(edge, 1.45) * 0.92 + dome;

      refD[idx] = Math.round(Math.max(0, Math.min(255, 128 + nx * mag * 127)));
      refD[idx + 1] = Math.round(Math.max(0, Math.min(255, 128 + ny * mag * 127)));
      refD[idx + 2] = 128;
      refD[idx + 3] = 255;

      const rimBand = Math.max(0, 1 - Math.abs(d + 1.4) / 2.0);
      const bevelBand = Math.pow(edge, 2.2) * (1 - Math.pow(edge, 8));
      const topLeft = Math.max(0, (-nx * 0.68 - ny * 0.73) * 0.5 + 0.5);
      const bottomRight = Math.max(0, (nx * 0.65 + ny * 0.76) * 0.5 + 0.5);
      const spec = Math.pow(topLeft, 5) * 0.92 + Math.pow(bottomRight, 6) * 0.45;
      const shineA = Math.min(1, (bevelBand * spec * 1.35 + rimBand * (0.35 + 0.65 * spec)) * 0.95);
      shineD[idx] = 255;
      shineD[idx + 1] = 255;
      shineD[idx + 2] = 255;
      shineD[idx + 3] = Math.round(shineA * 255);

      const bottom = Math.max(0, ny * 0.6 + nx * 0.3);
      const innerShadow = Math.pow(edge, 1.8) * (0.28 + 0.55 * bottom);
      const outerCrease = Math.max(0, 1 - Math.abs(d + bevelPx * 0.72) / (bevelPx * 0.45)) * 0.14;
      const shadeA = Math.min(1, innerShadow * 0.42 + outerCrease);
      shadeD[idx] = 10;
      shadeD[idx + 1] = 14;
      shadeD[idx + 2] = 26;
      shadeD[idx + 3] = Math.round(shadeA * 255);
    }
  }

  gRef.putImageData(refImg, 0, 0);
  gShine.putImageData(shineImg, 0, 0);
  gShade.putImageData(shadeImg, 0, 0);

  let out;
  try {
    out = {
      refractionUrl: cRef.toDataURL(),
      shineUrl: cShine.toDataURL(),
      shadeUrl: cShade.toDataURL(),
    };
  } catch {
    out = { refractionUrl: '', shineUrl: '', shadeUrl: '' };
  }
  mapCache.set(key, out);
  return out;
}

export function poseOf(plate, hover, active, x, y, tilt, spread, parallax, isSelected = false) {
  let bx = 0;
  let by = 0;
  let br = 0;
  let bs = 1;
  let btx = 0;
  let bty = 0;
  let gx = 0;
  let gy = 0;
  let gr = 0;
  let gs = 1;
  let gtx = 0;
  let gty = 0;
  let ix = 0;
  let iy = 0;
  let is = 1;

  // On touch / mobile bar, maintain a subtle resting 3D layered tilt so the
  // colored backplate is always visible behind the frosted refractive glass,
  // and fan out to full tilt when selected (`isSelected`) or hovered/pressed (`active`).
  const engaged = active || isSelected;
  const effSpread = active ? spread : isSelected ? spread * 0.88 : spread * 0.42;
  const effTilt = active ? tilt : isSelected ? tilt * 0.85 : tilt * 0.42;

  if (plate === 'tilt') {
    bx = 16 * effSpread;
    by = -2 * effSpread;
    br = effTilt * 0.55;
    btx = (engaged ? 8 : 3) * effSpread - y * 6 * parallax;
    bty = (engaged ? -10 : -4) * effSpread + x * 6 * parallax;
    gx = -6 * effSpread + x * 6 * parallax;
    gy = -8 * effSpread + y * 6 * parallax;
    gtx = -y * (engaged ? 10 : 3) * parallax;
    gty = x * (engaged ? 10 : 3) * parallax;
  } else if (plate === 'split') {
    bx = -18 * effSpread - x * 6 * parallax;
    by = 12 * effSpread - y * 6 * parallax;
    br = -effTilt * 0.35;
    gx = 12 * effSpread + x * 8 * parallax;
    gy = -12 * effSpread + y * 8 * parallax;
    gr = effTilt * 0.2;
    gtx = -y * 8 * parallax;
    gty = x * 8 * parallax;
  } else if (plate === 'stack') {
    by = 10 * effSpread;
    bs = 1 - 0.06 * effSpread;
    gy = -10 * effSpread + y * 5 * parallax;
    gx = x * 5 * parallax;
    gs = 1 + (engaged ? 0.04 : 0.01) * effSpread;
    gtx = -y * 9 * parallax;
    gty = x * 9 * parallax;
  } else if (plate === 'orbit') {
    const ox = (active ? x : 0.65) || 0.65;
    const oy = (active ? y : -0.55) || -0.55;
    bx = -ox * 22 * effSpread;
    by = -oy * 22 * effSpread;
    br = ox * effTilt * 0.45;
    gx = ox * 8 * effSpread;
    gy = oy * 8 * effSpread;
    gtx = -oy * 11 * parallax;
    gty = ox * 11 * parallax;
  }

  if (active) {
    if (hover === 'lift') {
      gy -= 6;
      gs *= 1.05;
      is = 1.08;
    } else if (hover === 'press') {
      gy += 2;
      gs *= 0.97;
      bs *= 1.02;
      is = 0.95;
    } else if (hover === 'magnetic') {
      gx += x * 10 * parallax;
      gy += y * 10 * parallax;
      bx += x * 5 * parallax;
      by += y * 5 * parallax;
      is = 1.06;
    } else if (hover === 'flip') {
      gty += 18 * (x >= 0 ? 1 : -1);
      gtx -= 8;
      gs *= 1.04;
      is = 1.08;
    }
  } else if (isSelected) {
    gy -= 2.5;
    gs *= 1.03;
    is = 1.05;
  }

  ix = x * (active ? 6 : 2) * parallax;
  iy = y * (active ? 6 : 2) * parallax;

  return { bx, by, br, bs, btx, bty, gx, gy, gr, gs, gtx, gty, ix, iy, is };
}

export function drive(s, target, dt, k = 240, c = 22) {
  let moving = false;
  for (const key of Object.keys(target)) {
    const x = s.p[key] ?? 0;
    const v = s.v[key] ?? 0;
    const goal = target[key];
    const f = -k * (x - goal) - c * v;
    const nv = v + f * dt;
    const nx = x + nv * dt;
    s.v[key] = nv;
    s.p[key] = nx;
    if (Math.abs(nx - goal) > 0.002 || Math.abs(nv) > 0.01) moving = true;
  }
  return moving;
}

const DEFAULT_COLOR_BY_KEY = {
  lyrics: 'indigo',
  queue: 'blue',
  search: 'teal',
  library: 'red',
  charts: 'orange',
};

let uidCounter = 0;

/**
 * Enhance `#rail` with the React Bits `<GlassIcons />` component while keeping
 * full compatibility with existing VPlayer DOM contracts and quick actions.
 */
export function initGlassIcons(railEl, options = {}) {
  if (!railEl) return null;

  const size = options.size ?? 44;
  const roundness = options.roundness ?? 0.58;
  const refraction = options.refraction ?? 0.8;
  const bevel = options.bevel ?? 0.6;
  const dispersion = options.dispersion ?? 0.15;
  const frost = options.frost ?? 0.22;
  const shine = options.shine ?? 0.88;
  const tint = options.tint ?? '#dfdfdf';
  const tintOpacity = options.tintOpacity ?? 0.18;
  const iconColor = options.iconColor ?? '#ffffff';
  const plate = options.plate ?? 'tilt';
  const tilt = options.tilt ?? 26;
  const spread = options.spread ?? 0.44;
  const hover = options.hover ?? 'press';
  const parallax = options.parallax ?? 1;
  const theme = options.theme ?? 'dark';

  const uid = `gi-${++uidCounter}`;
  const radius = Math.round(
    size * (0.14 + Math.max(0, Math.min(1, roundness)) * 0.36)
  );
  const maps = buildMaps(size, radius, bevel);
  const frostPx = Math.round(2 + Math.max(0, Math.min(1, frost)) * 22);
  const scalePx = Math.round(Math.max(0, Math.min(1, refraction)) * 38);
  const dispPx = Math.round(Math.max(0, Math.min(1, dispersion)) * 5);

  railEl.classList.add('glass-icons', 'dock');
  railEl.dataset.plate = plate;
  railEl.dataset.theme = theme;

  const themeVars = THEMES[theme] || THEMES.dark;
  for (const [k, v] of Object.entries(themeVars)) {
    railEl.style.setProperty(k, v);
  }
  railEl.style.setProperty('--gi-size', `${size}px`);
  railEl.style.setProperty('--gi-radius', `${radius}px`);
  railEl.style.setProperty('--gi-icon-color', iconColor);

  // Inject SVG displacement filter for refractive glass edge bending
  let filterSvg = railEl.querySelector('.gi-svg-defs');
  if (!filterSvg && typeof document !== 'undefined') {
    filterSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    filterSvg.setAttribute('class', 'gi-svg-defs');
    filterSvg.setAttribute('width', '0');
    filterSvg.setAttribute('height', '0');
    filterSvg.setAttribute('aria-hidden', 'true');
    if (maps.refractionUrl) {
      filterSvg.innerHTML = `<defs><filter id="${uid}-refract" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feImage href="${maps.refractionUrl}" x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="none" result="dispMap"/><feDisplacementMap in="SourceGraphic" in2="dispMap" scale="${scalePx}" xChannelSelector="R" yChannelSelector="G" result="displaced"/><feGaussianBlur in="displaced" stdDeviation="${(frost * 5.5).toFixed(2)}" result="frosted"/></filter></defs>`;
    }
    if (typeof railEl.prepend === 'function') railEl.prepend(filterSvg); else if (typeof railEl.insertBefore === 'function') railEl.insertBefore(filterSvg, railEl.firstChild); else railEl.appendChild?.(filterSvg);
  }

  const buttons = Array.from(railEl.querySelectorAll('button'));
  const itemsMeta = buttons.map((btn, idx) => {
    const key = btn.dataset.flip ? 'lyrics' : btn.dataset.view || `item-${idx}`;
    const colorName = options.colors?.[key] || DEFAULT_COLOR_BY_KEY[key] || 'blue';
    const plateBg = GRADIENTS[colorName] || colorName;

    const svgIcon = btn.querySelector('svg.rail__icon') || btn.querySelector('svg');
    const labelSpan = btn.querySelector('.rail__label');
    const labelText =
      labelSpan?.textContent?.trim() || btn.getAttribute('aria-label') || key;

    btn.classList.add('gi-item', 'dock-item');
    btn.dataset.giKey = key;
    btn.dataset.giColor = colorName;

    let stage = btn.querySelector('.gi-stage');
    if (!stage) {
      stage = document.createElement('span');
      stage.className = 'gi-stage dock-tile';

      const backEl = document.createElement('span');
      backEl.className = 'gi-back';
      backEl.style.background = plateBg;

      const frontEl = document.createElement('span');
      frontEl.className = 'gi-front dock-face';
      frontEl.style.backdropFilter = `blur(${frostPx}px) saturate(${(1.35 + refraction * 0.55).toFixed(2)})`;
      frontEl.style.webkitBackdropFilter = `blur(${frostPx}px) saturate(${(1.35 + refraction * 0.55).toFixed(2)})`;

      const tintEl = document.createElement('span');
      tintEl.className = 'gi-tint';
      tintEl.style.background = tint;
      tintEl.style.opacity = String(tintOpacity);

      const shineEl = document.createElement('span');
      shineEl.className = 'gi-shine';
      if (maps.shineUrl) shineEl.style.backgroundImage = `url(${maps.shineUrl})`;
      shineEl.style.opacity = String(shine);

      const shadeEl = document.createElement('span');
      shadeEl.className = 'gi-shade';
      if (maps.shadeUrl) shadeEl.style.backgroundImage = `url(${maps.shadeUrl})`;
      shadeEl.style.opacity = String(0.5 + bevel * 0.5);

      const rimEl = document.createElement('span');
      rimEl.className = 'gi-rim';
      rimEl.style.opacity = String(shine);
      if (dispPx > 0) {
        rimEl.style.boxShadow = `inset ${dispPx}px 0 ${dispPx * 2}px rgba(255, 90, 120, ${(dispersion * 0.38).toFixed(2)}), inset ${-dispPx}px 0 ${dispPx * 2}px rgba(70, 190, 255, ${(dispersion * 0.38).toFixed(2)}), inset 0 1.2px 0 rgba(255, 255, 255, ${(0.55 * shine).toFixed(2)}), inset 0 -1px 0 rgba(255, 255, 255, ${(0.18 * shine).toFixed(2)})`;
      } else {
        rimEl.style.boxShadow = `inset 0 1.2px 0 rgba(255, 255, 255, ${(0.58 * shine).toFixed(2)}), inset 0 -1px 0 rgba(255, 255, 255, ${(0.18 * shine).toFixed(2)}), inset 1px 0 0 rgba(255, 255, 255, ${(0.22 * shine).toFixed(2)}), inset -1px 0 0 rgba(255, 255, 255, ${(0.22 * shine).toFixed(2)})`;
      }

      const glyphEl = document.createElement('span');
      glyphEl.className = 'gi-glyph';
      if (svgIcon) glyphEl.appendChild(svgIcon);

      frontEl.append(tintEl, shineEl, shadeEl, rimEl, glyphEl);
      stage.append(backEl, frontEl);
      if (typeof btn.prepend === 'function') btn.prepend(stage); else if (typeof btn.insertBefore === 'function') btn.insertBefore(stage, btn.firstChild); else btn.appendChild?.(stage);
    }

    if (labelSpan) {
      labelSpan.className = 'rail__label gi-label dock-caption';
      labelSpan.textContent = labelText;
    }

    let dotEl = btn.querySelector('.gi-dot');
    if (!dotEl) {
      dotEl = document.createElement('span');
      dotEl.className = 'gi-dot dock-dot';
      dotEl.setAttribute('aria-hidden', 'true');
      btn.appendChild(dotEl);
    }

    const backEl = stage.querySelector('.gi-back');
    const frontEl = stage.querySelector('.gi-front');
    const glyphEl = stage.querySelector('.gi-glyph');
    const shineEl = stage.querySelector('.gi-shine');

    const isSelected =
      btn.classList.contains('on') || btn.getAttribute('aria-current') === 'true';
    const initPose = poseOf(plate, hover, false, 0, 0, tilt, spread, parallax, isSelected);

    const state = {
      active: false,
      x: 0,
      y: 0,
      p: { ...initPose, mx: 0.5, my: 0.5, mh: 0 },
      v: {},
    };

    const applyPose = (p) => {
      if (backEl) {
        backEl.style.transform = `translate3d(${p.bx.toFixed(2)}px, ${p.by.toFixed(2)}px, 0) rotateX(${p.btx.toFixed(2)}deg) rotateY(${p.bty.toFixed(2)}deg) rotateZ(${p.br.toFixed(2)}deg) scale(${p.bs.toFixed(3)})`;
      }
      if (frontEl) {
        frontEl.style.transform = `translate3d(${p.gx.toFixed(2)}px, ${p.gy.toFixed(2)}px, 12px) rotateX(${p.gtx.toFixed(2)}deg) rotateY(${p.gty.toFixed(2)}deg) rotateZ(${p.gr.toFixed(2)}deg) scale(${p.gs.toFixed(3)})`;
      }
      if (glyphEl) {
        glyphEl.style.transform = `translate3d(${p.ix.toFixed(2)}px, ${p.iy.toFixed(2)}px, 8px) scale(${p.is.toFixed(3)})`;
      }
      if (shineEl) {
        const spotX = (50 + p.ix * 4).toFixed(1);
        const spotY = (30 + p.iy * 4).toFixed(1);
        shineEl.style.backgroundPosition = `${spotX}% ${spotY}%`;
      }
    };

    applyPose(state.p);

    return {
      key,
      index: idx,
      btn,
      stage,
      backEl,
      frontEl,
      glyphEl,
      shineEl,
      state,
      applyPose,
    };
  });

  let rafId = 0;
  let lastT = 0;

  const tick = (now) => {
    const dt = lastT ? Math.min(0.032, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    let anyMoving = false;

    for (const item of itemsMeta) {
      const s = item.state;
      const isSelected =
        item.btn.classList.contains('on') ||
        item.btn.getAttribute('aria-current') === 'true';
      const target = {
        ...poseOf(
          plate,
          hover,
          s.active,
          s.x,
          s.y,
          tilt,
          spread,
          parallax,
          isSelected
        ),
        mx: s.active ? s.x * 0.5 + 0.5 : 0.5,
        my: s.active ? 0.5 - s.y * 0.5 : 0.5,
        mh: s.active ? 1 : isSelected ? 0.65 : 0,
      };
      if (drive(s, target, dt)) anyMoving = true;
      item.applyPose(s.p);
    }

    if (anyMoving) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
      lastT = 0;
    }
  };

  const kick = () => {
    if (!rafId && typeof requestAnimationFrame === 'function') {
      lastT = 0;
      rafId = requestAnimationFrame(tick);
    } else {
      // Immediate synchronous fallback for environments without rAF
      for (const item of itemsMeta) {
        const isSelected =
          item.btn.classList.contains('on') ||
          item.btn.getAttribute('aria-current') === 'true';
        const pose = poseOf(
          plate,
          hover,
          item.state.active,
          item.state.x,
          item.state.y,
          tilt,
          spread,
          parallax,
          isSelected
        );
        Object.assign(item.state.p, pose);
        item.applyPose(item.state.p);
      }
    }
  };

  const cleanups = [];
  itemsMeta.forEach((item) => {
    const { btn, state } = item;

    const onEnter = (e) => {
      state.active = true;
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && e.clientX !== undefined) {
        state.x = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width - 0.5) * 2));
        state.y = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height - 0.5) * 2));
      }
      kick();
    };

    const onMove = (e) => {
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && e.clientX !== undefined) {
        state.active = true;
        state.x = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width - 0.5) * 2));
        state.y = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height - 0.5) * 2));
        kick();
      }
    };

    const onLeave = () => {
      state.active = false;
      state.x = 0;
      state.y = 0;
      kick();
    };

    const onClick = () => {
      // Brief spring pulse on tap/click
      state.v.gy = (state.v.gy || 0) - 95;
      state.v.gs = (state.v.gs || 0) + 1.4;
      kick();
    };

    btn.addEventListener('pointerenter', onEnter);
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerleave', onLeave);
    btn.addEventListener('pointercancel', onLeave);
    btn.addEventListener('click', onClick);

    cleanups.push(() => {
      btn.removeEventListener('pointerenter', onEnter);
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerleave', onLeave);
      btn.removeEventListener('pointercancel', onLeave);
      btn.removeEventListener('click', onClick);
    });
  });

  // Observe class/attribute changes on the 5 rail buttons (`on` / `aria-current`)
  // so switching panels or opening lyrics immediately animates the active glass icon.
  let observer = null;
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => kick());
    for (const item of itemsMeta) {
      observer.observe(item.btn, {
        attributes: true,
        attributeFilter: ['class', 'aria-current'],
      });
    }
  }

  return {
    refresh: kick,
    setBadge() {},
    hop(idxOrKey) {
      const target = itemsMeta.find(
        (m) => m.index === idxOrKey || m.key === idxOrKey
      );
      if (!target) return;
      target.state.v.gy = -120;
      target.state.v.gs = 1.6;
      kick();
    },
    destroy() {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
      observer?.disconnect();
      cleanups.forEach((fn) => fn());
    },
  };
}
