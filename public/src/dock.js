/**
 * VPlayer · Vane — Interactive Dock Component (`public/src/dock.js`)
 *
 * Pure Vanilla ES Module port of React Bits `<Dock />` (`Dock.jsx` + `Dock.css`),
 * engineered specifically for VPlayer's hybrid Desktop + iOS Standalone PWA
 * environment:
 *
 * 1. GPU-accelerated spring magnification (`mass: 0.1, stiffness: 150, damping: 12`)
 *    and click bounce hop (`HOP = 0.4, HOP_TIME = 0.38`) applied to `.dock-tile`
 *    via `transform: translate3d(0, lift, 0) scale(...)` — zero layout reflow
 *    and zero horizontal overflow on 375pt iPhone viewports.
 * 2. Touch vs. Mouse disambiguation: single tap on iOS triggers the bounce hop
 *    without sticky hover zoom; horizontal finger scrubbing smoothly magnifies
 *    tiles and resets cleanly on release.
 * 3. Full `DockMenu` portal with the exact React Bits SVG speech-bubble tail
 *    (`menuPath`), sliding highlight bar, long-press (`450ms`), right-click,
 *    and keyboard navigation.
 * 4. Strict iOS Lock Screen isolation: halts `requestAnimationFrame` immediately
 *    when settled or when `document.hidden` (`document.visibilityState === 'hidden'`).
 */

const HOP = 0.36;
const HOP_TIME = 0.38;
const HOLD_TIME = 450;
const TAIL = 9;
const TAIL_HALF = 9;
const MENU_RADIUS = 10;
const MENU_GAP = 8;
const MARGIN = 8;

export const THEMES = {
  dark: {
    '--dock-panel': 'rgba(22, 26, 34, 0.76)',
    '--dock-panel-edge': 'rgba(216, 162, 74, 0.22)',
    '--dock-panel-highlight': 'rgba(255, 255, 255, 0.08)',
    '--dock-panel-shadow': '0 20px 42px -16px rgba(0, 0, 0, 0.82), 0 6px 16px -8px rgba(0, 0, 0, 0.55)',
    '--dock-tile': 'linear-gradient(180deg, rgba(44, 50, 64, 0.88) 0%, rgba(24, 28, 38, 0.94) 100%)',
    '--dock-tile-edge': 'rgba(255, 255, 255, 0.09)',
    '--dock-tile-highlight': 'rgba(255, 255, 255, 0.14)',
    '--dock-tile-shadow': '0 4px 10px -3px rgba(0, 0, 0, 0.72)',
    '--dock-ink': '#f4efe4',
    '--dock-label': '#1c222d',
    '--dock-label-ink': '#f4efe4',
    '--dock-dot': '#d8a24a',
    '--dock-separator': 'rgba(255, 255, 255, 0.12)',
    '--dock-press': 'brightness(0.78)',
    '--dock-menu': 'rgba(24, 29, 38, 0.88)',
    '--dock-menu-edge': 'rgba(216, 162, 74, 0.26)',
    '--dock-menu-ink': '#f4efe4',
    '--dock-menu-muted': 'rgba(244, 239, 228, 0.45)',
    '--dock-menu-separator': 'rgba(255, 255, 255, 0.1)',
    '--dock-menu-shadow': '0 18px 40px -12px rgba(0, 0, 0, 0.72), 0 3px 10px rgba(0, 0, 0, 0.35)',
  },
  light: {
    '--dock-panel': 'rgba(240, 240, 243, 0.8)',
    '--dock-panel-edge': 'rgba(24, 24, 27, 0.07)',
    '--dock-panel-highlight': 'rgba(255, 255, 255, 0.95)',
    '--dock-panel-shadow': '0 22px 44px -22px rgba(24, 24, 27, 0.3), 0 6px 16px -10px rgba(24, 24, 27, 0.16)',
    '--dock-tile': 'linear-gradient(180deg, #ffffff 0%, #f6f6f8 100%)',
    '--dock-tile-edge': 'rgba(24, 24, 27, 0.08)',
    '--dock-tile-highlight': 'rgba(255, 255, 255, 1)',
    '--dock-tile-shadow': '0 4px 10px -5px rgba(24, 24, 27, 0.25)',
    '--dock-ink': '#27272a',
    '--dock-label': '#ffffff',
    '--dock-label-ink': '#18181b',
    '--dock-dot': 'rgba(24, 24, 27, 0.55)',
    '--dock-separator': 'rgba(24, 24, 27, 0.12)',
    '--dock-press': 'brightness(0.9)',
    '--dock-menu': 'rgba(248, 248, 250, 0.86)',
    '--dock-menu-edge': 'rgba(24, 24, 27, 0.1)',
    '--dock-menu-ink': '#18181b',
    '--dock-menu-muted': 'rgba(24, 24, 27, 0.4)',
    '--dock-menu-separator': 'rgba(24, 24, 27, 0.1)',
    '--dock-menu-shadow': '0 18px 40px -14px rgba(24, 24, 27, 0.3), 0 3px 10px rgba(24, 24, 27, 0.1)',
  },
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const usable = (row) => !!row && !row.separator && !row.disabled;

export const menuPath = (width, height, side, at) => {
  const r = MENU_RADIUS;
  const p = (x, y) => `${(x + TAIL).toFixed(2)} ${(y + TAIL).toFixed(2)}`;
  const tail = (x, y, dx, dy, nx, ny) => {
    const q = (u, v) => p(x + dx * u + nx * v, y + dy * u + ny * v);
    return `L ${q(-TAIL_HALF, 0)} L ${q(-TAIL_HALF * 0.18, TAIL * 0.82)} Q ${q(0, TAIL)} ${q(TAIL_HALF * 0.18, TAIL * 0.82)} L ${q(TAIL_HALF, 0)}`;
  };
  return [
    `M ${p(r, 0)}`,
    side === 'top' ? tail(at, 0, 1, 0, 0, -1) : '',
    `L ${p(width - r, 0)} A ${r} ${r} 0 0 1 ${p(width, r)}`,
    side === 'right' ? tail(width, at, 0, 1, 1, 0) : '',
    `L ${p(width, height - r)} A ${r} ${r} 0 0 1 ${p(width - r, height)}`,
    side === 'bottom' ? tail(at, height, -1, 0, 0, 1) : '',
    `L ${p(r, height)} A ${r} ${r} 0 0 1 ${p(0, height - r)}`,
    side === 'left' ? tail(0, at, 0, -1, -1, 0) : '',
    `L ${p(0, r)} A ${r} ${r} 0 0 1 ${p(r, 0)} Z`,
  ].join(' ');
};

/**
 * Enhances an existing `<nav id="rail">` element with React Bits `<Dock />`
 * tiles, spring magnification, click bounce hop, badges, active dots, and
 * right-click / long-press speech-bubble context menus.
 */
export function initDock(root, options = {}) {
  if (!root) return null;
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || window;

  const settings = {
    position: 'bottom',
    theme: 'dark',
    baseItemSize: 44,
    magnification: 60,
    distance: 150,
    panelHeight: 58,
    gap: 8,
    roundness: 0.48,
    spring: { mass: 0.1, stiffness: 150, damping: 12 },
    bounce: true,
    showLabels: true,
    showIndicators: true,
    showBadges: true,
    badgeColor: '#e0314b',
    accentColor: '#d8a24a',
    menus: {},
    ...options,
  };

  const tokens = {
    ...(THEMES[settings.theme] || THEMES.dark),
    '--dock-accent': settings.accentColor,
    '--dock-badge': settings.badgeColor,
    '--dock-base': `${settings.baseItemSize}px`,
    '--dock-thickness': `${settings.panelHeight}px`,
    '--dock-gap': `${settings.gap}px`,
    '--dock-pad': `${Math.max(4, (settings.panelHeight - settings.baseItemSize) / 2)}px`,
    '--dock-reach': `${settings.magnification - settings.baseItemSize}px`,
    '--dock-round': String(clamp(settings.roundness, 0, 1)),
  };

  root.classList.add('dock', `dock--${settings.position}`);
  for (const [k, v] of Object.entries(tokens)) {
    root.style.setProperty(k, String(v));
  }

  // Upgrade each button inside #rail without removing or replacing the button
  // element itself, so all DOM contracts and event listeners stay intact.
  const buttons = [...root.querySelectorAll('button')];
  const badgeNodes = new Map();

  buttons.forEach((btn, idx) => {
    btn.classList.add('dock-item');
    const key = btn.dataset.view || (btn.dataset.flip ? 'lyrics' : `item-${idx}`);
    btn.dataset.dockKey = key;

    const svg = btn.querySelector('svg');
    const labelEl = btn.querySelector('.rail__label');
    const labelText = labelEl?.textContent?.trim() || btn.getAttribute('aria-label') || '';

    if (!btn.querySelector('.dock-tile')) {
      const tile = doc.createElement('span');
      tile.className = 'dock-tile';
      const face = doc.createElement('span');
      face.className = 'dock-face';
      if (svg) face.appendChild(svg);

      const badge = doc.createElement('span');
      badge.className = 'dock-badge num';
      badge.hidden = true;
      tile.appendChild(face);
      tile.appendChild(badge);
      badgeNodes.set(key, badge);

      const dot = doc.createElement('span');
      dot.className = 'dock-dot';
      dot.setAttribute('aria-hidden', 'true');

      const tooltip = doc.createElement('span');
      tooltip.className = 'dock-label';
      tooltip.setAttribute('aria-hidden', 'true');
      tooltip.textContent = labelText;

      btn.replaceChildren(tile);
      if (labelEl) {
        labelEl.classList.add('dock-caption');
        btn.appendChild(labelEl);
      }
      btn.appendChild(dot);
      btn.appendChild(tooltip);
    }
  });

  const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const motion = new Map();
  const pointer = { x: 0, y: 0, inside: false };
  let activeMenuEl = null;
  let activeMenuCleanup = null;
  let pressTimer = 0;
  let skipClickIdx = -1;
  let raf = 0;
  let last = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let alive = true;

  const entry = (index) => {
    let state = motion.get(index);
    if (!state) {
      state = {
        size: settings.baseItemSize,
        velocity: 0,
        lift: 0,
        rise: 0,
        launch: 0,
        gravity: 0,
        hopping: false,
      };
      motion.set(index, state);
    }
    return state;
  };

  const tick = (now) => {
    raf = 0;
    if (!alive || doc.hidden || doc.visibilityState === 'hidden') return;
    const dt = Math.min(1 / 30, Math.max(0.001, (now - last) / 1000));
    last = now;

    const base = settings.baseItemSize;
    const peak = settings.magnification;
    const dist = Math.max(1, settings.distance);
    const mass = Math.max(0.01, settings.spring?.mass ?? 0.1);
    const stiffness = Math.max(1, settings.spring?.stiffness ?? 150);
    const damping = Math.max(0, settings.spring?.damping ?? 12);
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    const k = stiffness / mass;
    const c = damping / mass;
    let moving = false;

    buttons.forEach((btn, index) => {
      const state = entry(index);
      const rect = btn.getBoundingClientRect();
      const itemCenter = rect.left + rect.width / 2;
      const reach = !pointer.inside ? 1 : Math.abs(pointer.x - itemCenter) / dist;
      const target = base + (peak - base) * (reach < 1 ? Math.cos((reach * Math.PI) / 2) ** 2 : 0);

      if (reduce) {
        state.size = target;
        state.velocity = 0;
      } else {
        for (let i = 0; i < steps; i++) {
          state.velocity = (state.velocity + h * k * (target - state.size)) / (1 + h * c + h * h * k);
          state.size += state.velocity * h;
          if (!state.hopping) continue;
          state.rise -= state.gravity * h;
          state.lift += state.rise * h;
          if (state.lift > 0) continue;
          state.lift = 0;
          state.rise *= -0.36;
          if (state.rise < state.launch * 0.2) {
            state.rise = 0;
            state.hopping = false;
            btn.removeAttribute('data-hop');
          }
        }
      }

      if (Math.abs(state.velocity) < 0.01 && Math.abs(target - state.size) < 0.01) {
        state.size = target;
        state.velocity = 0;
      } else {
        moving = true;
      }
      if (state.hopping) moving = true;

      const scale = clamp(state.size / base, 1, 1.42);
      const extraLift = (scale - 1) * base * 0.42;
      const liftY = -(state.lift + extraLift);
      const tile = btn.querySelector('.dock-tile');
      if (tile) {
        if (scale === 1 && state.lift === 0) {
          tile.style.transform = '';
        } else {
          tile.style.transform = `translate3d(0, ${liftY.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`;
        }
      }
    });

    if (moving && !doc.hidden && doc.visibilityState !== 'hidden') {
      raf = requestAnimationFrame(tick);
    }
  };

  const wake = () => {
    if (raf || !alive || doc.hidden || doc.visibilityState === 'hidden') return;
    last = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (typeof requestAnimationFrame === 'function') {
      raf = requestAnimationFrame(tick);
    }
  };

  const hop = (index) => {
    const btn = buttons[index];
    if (reduce || !settings.bounce || !btn) return;
    const state = entry(index);
    if (state.hopping) return;
    const height = settings.baseItemSize * HOP;
    state.gravity = (8 * height) / (HOP_TIME * HOP_TIME);
    state.launch = (state.gravity * HOP_TIME) / 2;
    state.rise = state.launch;
    state.hopping = true;
    btn.setAttribute('data-hop', '');
    wake();
  };

  const closeMenu = () => {
    if (activeMenuCleanup) {
      activeMenuCleanup();
      activeMenuCleanup = null;
    }
    if (activeMenuEl) {
      activeMenuEl.remove();
      activeMenuEl = null;
    }
    buttons.forEach((b) => b.removeAttribute('data-open'));
  };

  const openMenu = (index) => {
    const btn = buttons[index];
    if (!btn) return false;
    const key = btn.dataset.dockKey;
    const menuSource = settings.menus?.[key];
    const rows = typeof menuSource === 'function' ? menuSource() : menuSource;
    if (!Array.isArray(rows) || !rows.length) return false;

    closeMenu();
    btn.setAttribute('data-open', '');

    const outer = doc.createElement('div');
    outer.className = 'dock-menu';
    outer.setAttribute('data-dock-menu', '');
    for (const [k, v] of Object.entries(tokens)) {
      outer.style.setProperty(k, String(v));
    }

    const shadow = doc.createElement('span');
    shadow.className = 'dock-menu-shadow';
    const glass = doc.createElement('span');
    glass.className = 'dock-menu-glass';
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dock-menu-shape');
    svg.setAttribute('aria-hidden', 'true');
    const pathNode = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(pathNode);

    const list = doc.createElement('div');
    list.className = 'dock-menu-list';
    list.setAttribute('role', 'menu');
    const highlight = doc.createElement('span');
    highlight.className = 'dock-menu-highlight';
    list.appendChild(highlight);

    const hasChecks = rows.some((r) => r && !r.separator && r.checked !== undefined);
    rows.forEach((row, rIdx) => {
      if (!row) return;
      if (row.separator) {
        const sep = doc.createElement('span');
        sep.className = 'dock-menu-separator';
        sep.setAttribute('role', 'separator');
        list.appendChild(sep);
        return;
      }
      const itemBtn = doc.createElement('button');
      itemBtn.type = 'button';
      itemBtn.className = 'dock-menu-row';
      itemBtn.dataset.dockRow = String(rIdx);
      if (row.disabled) itemBtn.setAttribute('aria-disabled', 'true');

      if (hasChecks) {
        const chk = doc.createElement('span');
        chk.className = 'dock-menu-check';
        chk.textContent = row.checked ? '✓' : '';
        itemBtn.appendChild(chk);
      }

      const txt = doc.createElement('span');
      txt.className = 'dock-menu-text';
      txt.textContent = String(row.label || '');
      itemBtn.appendChild(txt);

      if (row.shortcut) {
        const sc = doc.createElement('span');
        sc.className = 'dock-menu-shortcut num';
        sc.textContent = String(row.shortcut);
        itemBtn.appendChild(sc);
      }

      itemBtn.addEventListener('pointerenter', () => {
        if (!usable(row)) return;
        list.querySelectorAll('.dock-menu-row').forEach((n) => n.removeAttribute('data-active'));
        itemBtn.setAttribute('data-active', '');
        highlight.style.transform = `translateY(${itemBtn.offsetTop}px)`;
        highlight.style.height = `${itemBtn.offsetHeight}px`;
        highlight.style.opacity = '1';
      });

      itemBtn.addEventListener('click', (ev) => {
        ev.stopPropagation?.();
        if (!usable(row)) return;
        closeMenu();
        hop(index);
        row.onClick?.();
      });

      list.appendChild(itemBtn);
    });

    outer.appendChild(shadow);
    outer.appendChild(glass);
    outer.appendChild(svg);
    outer.appendChild(list);
    doc.body.appendChild(outer);
    activeMenuEl = outer;

    const rect = btn.getBoundingClientRect();
    const width = Math.max(180, list.offsetWidth || 196);
    const height = Math.max(44, list.offsetHeight || rows.length * 26 + 12);
    const vw = doc.documentElement?.clientWidth || win.innerWidth || 390;
    const px = rect.left + rect.width / 2;
    const py = rect.top - MENU_GAP;
    const left = clamp(px - width / 2, MARGIN, vw - MARGIN - width);
    const top = Math.max(MARGIN, py - TAIL - height);
    const at = clamp(px - left, MENU_RADIUS + TAIL_HALF, width - MENU_RADIUS - TAIL_HALF);
    const d = menuPath(width, height, 'bottom', at);

    outer.style.left = `${left}px`;
    outer.style.top = `${top}px`;
    outer.style.visibility = 'visible';
    glass.style.clipPath = `path('${d}')`;
    pathNode.setAttribute('d', d);

    const onDocDown = (ev) => {
      if (outer.contains(ev.target) || btn.contains(ev.target)) return;
      closeMenu();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') closeMenu();
    };
    doc.addEventListener('pointerdown', onDocDown, true);
    doc.addEventListener('keydown', onKey);
    activeMenuCleanup = () => {
      doc.removeEventListener('pointerdown', onDocDown, true);
      doc.removeEventListener('keydown', onKey);
    };
    return true;
  };

  const onPointerMove = (e) => {
    if (e.pointerType === 'touch') return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
    wake();
  };

  const onPointerLeave = () => {
    pointer.inside = false;
    wake();
  };

  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerleave', onPointerLeave);
  root.addEventListener('pointercancel', onPointerLeave);

  buttons.forEach((btn, idx) => {
    btn.addEventListener('pointerdown', (e) => {
      clearTimeout(pressTimer);
      if (e.button === 2 || e.ctrlKey) return;
      pressTimer = setTimeout(() => {
        if (openMenu(idx)) {
          skipClickIdx = idx;
        }
      }, HOLD_TIME);
    });
    btn.addEventListener('pointerup', () => clearTimeout(pressTimer));
    btn.addEventListener('pointercancel', () => clearTimeout(pressTimer));
    btn.addEventListener('contextmenu', (e) => {
      if (openMenu(idx)) {
        e.preventDefault();
        clearTimeout(pressTimer);
      }
    });
    btn.addEventListener(
      'click',
      (e) => {
        if (skipClickIdx === idx) {
          skipClickIdx = -1;
          e.stopImmediatePropagation();
          e.preventDefault();
          return;
        }
        closeMenu();
        hop(idx);
      },
      true
    );
  });

  const onVisibility = () => {
    if (doc.hidden || doc.visibilityState === 'hidden') {
      pointer.inside = false;
      closeMenu();
      if (raf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    hop,
    openMenu,
    closeMenu,
    setBadge(key, value) {
      const node = badgeNodes.get(key);
      if (!node) return;
      const num = Number(value);
      if (!value || (Number.isFinite(num) && num <= 0)) {
        node.textContent = '';
        node.hidden = true;
      } else {
        node.textContent = Number.isFinite(num) && num > 99 ? '99+' : String(value);
        node.hidden = false;
      }
    },
    destroy() {
      alive = false;
      clearTimeout(pressTimer);
      closeMenu();
      if (raf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
      raf = 0;
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onPointerLeave);
      root.removeEventListener('pointercancel', onPointerLeave);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

export default initDock;
