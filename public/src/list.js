/**
 * list.js — one virtual scroller.
 *
 * The old build had two: `setupVirtualScroll`/`vsCreateItem`/`vsRenderVisible`
 * for desktop and `mCreateItem`/`mRender` for mobile, kept in sync by hand.
 * This is a single node-recycling list; the queue and the search results are
 * both instances of it, differing only in the actions each row exposes.
 */

import { coverUrl } from './api.js';

const ROW_H = 62;

const ARM_TIMEOUT = 2600;
const ROW_HUES = [195, 150, 225, 20, 275, 95, 340, 200];
function hueForRow(item, index) {
  if (typeof item?.h === 'number') return item.h;
  const str = String(item?.name || item?.id || index);
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum = (sum * 31 + str.charCodeAt(i)) >>> 0;
  return ROW_HUES[(sum + index) % ROW_HUES.length];
}

/**
 * Destructive actions arm on the first press and fire on the second, then
 * disarm themselves. A modal for removing one queue row would be heavier than
 * the mistake it prevents; an armed button is undoable by simply not clicking.
 */
function bindAction(btn, action, cell) {
  clearTimeout(btn._armTimer);
  btn.classList.remove('is-armed');
  btn.dataset.armed = '';

  btn.onclick = (e) => {
    e.stopPropagation();
    // An action with no run is a state badge, not a control — it reports that
    // the track is already in the cloud and has nothing to do when tapped.
    if (!action.run) return;
    const index = Number(cell.row.dataset.index);
    const item = cell.items?.[index];

    if (!action.confirm || btn.dataset.armed === '1') {
      clearTimeout(btn._armTimer);
      btn.classList.remove('is-armed');
      btn.dataset.armed = '';
      action.run(item, index);
      return;
    }

    btn.dataset.armed = '1';
    btn.classList.add('is-armed');
    clearTimeout(btn._armTimer);
    btn._armTimer = setTimeout(() => {
      btn.classList.remove('is-armed');
      btn.dataset.armed = '';
    }, ARM_TIMEOUT);
  };
}

/** Crisp Vane vector emblem — the "no artwork / loading" fallback state. */
const BLANK = '/img/vane-maskable.svg';
const OVERSCAN = 6;

const ICONS = {
  play: 'i-play',
  plus: 'i-plus',
  trash: 'i-trash',
  close: 'i-close',
  download: 'i-download',
  cached: 'i-cached',
  cloud: 'i-cloud',
  heart: 'i-heart',
};

export class TrackList {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.scroller   the scrolling viewport
   * @param {HTMLElement} opts.sizer      absolute-positioning parent inside it
   * @param {() => Array} opts.items      current data, read on every render
   * @param {(item, index) => void} opts.onActivate
   * @param {(item, index) => Array<{icon, label, run}>} [opts.actions]
   * @param {() => number} [opts.currentIndex]  which row wears the vane marker
   */
  constructor({ scroller, sizer, items, onActivate, actions, currentIndex, progress, showRank = false }) {
    this.scroller = scroller;
    this.sizer = sizer;
    this.getItems = items;
    this.onActivate = onActivate;
    this.getActions = actions || (() => []);
    this.getCurrent = currentIndex || (() => -1);
    this.showRank = Boolean(showRank);
    /** id -> { received, total }. Read on paint, so scrolling keeps it right. */
    this.getProgress = progress || (() => new Map());

    this.pool = [];
    this.range = [0, -1];

    this.scroller.addEventListener('scroll', () => this.render(), { passive: true });
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.scroller);
  }

  /** Row factory. Structure is fixed so nodes can be recycled by index. */
  #createRow() {
    const row = document.createElement('div');
    row.className = 'row r';
    if (this.showRank) row.classList.add('row--ranked');
    row.innerHTML = `
      <span class="row__ord rk num"></span>
      <span class="row__thumb th">
        <svg class="row__emblem" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 7l12 25-12-7-12 7z" fill="none" stroke="#d4a94a" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <img class="row__art" alt="" loading="lazy" decoding="async" draggable="false">
        <span class="eq" aria-hidden="true"><u></u><u></u><u></u></span>
      </span>
      <span class="row__meta t">
        <span class="row__name"></span>
        <span class="row__sub"></span>
      </span>
      <span class="row__tail"></span>
      <span class="row__prog"><i></i></span>`;

    row.querySelector('.row__art').addEventListener('error', (e) => {
      e.target.removeAttribute('src');
      e.target.classList.add('is-empty');
      e.target.closest('.row__thumb')?.classList.remove('has-art');
      e.target.dataset.src = '';
    });

    let swipeStart = null;
    let swiped = false;
    row.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target.closest('.row__tail')) return;
        swipeStart = { x: e.clientX, y: e.clientY, t: performance.now() };
        swiped = false;
      },
      { passive: true }
    );
    row.addEventListener(
      'pointerup',
      (e) => {
        if (!swipeStart) return;
        const dx = e.clientX - swipeStart.x;
        const dy = Math.abs(e.clientY - swipeStart.y);
        const dt = performance.now() - swipeStart.t;
        swipeStart = null;
        if (dt < 650 && Math.abs(dx) > 54 && dy < 24) {
          swiped = true;
          const i = Number(row.dataset.index);
          const item = this.getItems()[i];
          const actions = item ? this.getActions(item, i) : [];
          const plusAct = actions.find((a) => a.icon === 'plus' && a.run);
          if (item && plusAct) {
            row.classList.add('is-swiped');
            setTimeout(() => row.classList.remove('is-swiped'), 320);
            plusAct.run(item, i);
          }
        }
      },
      { passive: true }
    );
    row.addEventListener('pointercancel', () => {
      swipeStart = null;
    });

    row.addEventListener('click', (e) => {
      if (swiped) {
        swiped = false;
        return;
      }
      if (e.target.closest('.row__tail')) return;
      const i = Number(row.dataset.index);
      const item = this.getItems()[i];
      if (item) this.onActivate(item, i);
    });

    this.sizer.append(row);
    return {
      row,
      ord: row.querySelector('.row__ord'),
      thumb: row.querySelector('.row__thumb'),
      art: row.querySelector('.row__art'),
      name: row.querySelector('.row__name'),
      sub: row.querySelector('.row__sub'),
      tail: row.querySelector('.row__tail'),
      prog: row.querySelector('.row__prog i'),
      actionKey: '',
    };
  }

  /** Actions are rebuilt only when the action set for a row actually changes. */
  #fillActions(cell, item, index) {
    const actions = this.getActions(item, index);
    const key = actions.map((a) => a.icon).join('|');
    if (cell.actionKey === key) {
      // Same buttons, new closure targets.
      cell.tail.querySelectorAll('button').forEach((btn, i) => {
        const action = actions[i];
        btn.setAttribute('aria-label', action.label);
        btn.title = action.label;
        btn.setAttribute('aria-pressed', String(Boolean(action.on)));
        btn.classList.toggle('is-on', Boolean(action.on));
        btn.classList.toggle('is-badge', Boolean(action.badge));
        btn.disabled = Boolean(action.badge);
        bindAction(btn, action, cell);
      });
      return;
    }
    cell.actionKey = key;
    cell.tail.textContent = '';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', action.label);
      btn.title = action.label;
      // A toggle that looks identical in both states is not a toggle.
      btn.setAttribute('aria-pressed', String(Boolean(action.on)));
      btn.classList.toggle('is-on', Boolean(action.on));
      btn.classList.toggle('is-badge', Boolean(action.badge));
      btn.disabled = Boolean(action.badge);
      btn.innerHTML = `<svg viewBox="0 0 24 24"><use href="#${ICONS[action.icon] || action.icon}"/></svg>`;
      bindAction(btn, action, cell);
      cell.tail.append(btn);
    }
  }

  render(force = false) {
    const items = this.getItems();
    const total = items.length;
    this.sizer.style.height = `${total * ROW_H}px`;

    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((top + height) / ROW_H) + OVERSCAN);

    if (!force && first === this.range[0] && last === this.range[1]) {
      this.#paint(items, first, last); // same window, refresh content only
      return;
    }
    this.range = [first, last];

    const need = Math.max(0, last - first + 1);
    while (this.pool.length < need) this.pool.push(this.#createRow());
    for (let i = need; i < this.pool.length; i++) this.pool[i].row.hidden = true;

    this.#paint(items, first, last);
  }

  #paint(items, first, last) {
    const current = this.getCurrent();
    for (const cell of this.pool) cell.items = items;
    for (let i = first; i <= last; i++) {
      const cell = this.pool[i - first];
      if (!cell) continue;
      const item = items[i];
      if (!item) {
        cell.row.hidden = true;
        continue;
      }
      cell.row.hidden = false;
      cell.row.dataset.index = String(i);
      cell.row.style.transform = `translateY(${i * ROW_H}px)`;
      cell.row.classList.toggle('is-current', i === current);
      cell.tail.querySelectorAll('button.is-armed').forEach((btn) => {
        clearTimeout(btn._armTimer);
        btn.classList.remove('is-armed');
        btn.dataset.armed = '';
      });

      this.#applyProgress(cell, item, i);
      // textContent throughout: every field here came from an upstream API or a
      // user-supplied file, so nothing is ever parsed as markup.
      cell.name.textContent = item.name || '未知歌曲';
      cell.sub.textContent = [item.artist, item.album].filter(Boolean).join(' · ') || '—';

      // QQ and KuGou search payloads carry no artwork at all — covers only
      // exist on resolve. That is the API's shape, not a failure, so an absent
      // cover gets a quiet bezel mark rather than an empty box that reads as
      // something broken.
      //
      // Built through coverUrl (not hand-assembled) so it carries the member
      // token — the image proxy is behind the auth gate, and a hand-built URL
      // 401'd, which is why every list cover appeared blank.
      cell.thumb.style.setProperty('--rh', String(hueForRow(item, i)));
      const art = item.cover ? coverUrl(item.cover, 96) : '';
      if (cell.art.dataset.src !== art) {
        cell.art.dataset.src = art;
        if (art) {
          cell.art.src = art;
          cell.art.classList.remove('is-empty');
          cell.thumb.classList.add('has-art');
        } else {
          cell.art.removeAttribute('src');
          cell.art.classList.add('is-empty');
          cell.thumb.classList.remove('has-art');
        }
      } else if (art && cell.art.classList.contains('is-empty')) {
        cell.art.classList.remove('is-empty');
        cell.thumb.classList.add('has-art');
        cell.art.src = art;
      }

      this.#fillActions(cell, item, i);
    }
  }

  /**
   * A download shows on the row it belongs to, not in a toast at the bottom of
   * the screen: the toast was both far from the song and gone before it
   * finished. The index column carries the percentage while it runs, since the
   * index is the least useful thing on screen at that moment.
   */
  #applyProgress(cell, item, index) {
    const p = this.getProgress().get(String(item.id));
    const rankNum = index + 1;
    cell.ord.classList.toggle('top', this.showRank && rankNum <= 3);
    if (!p) {
      cell.row.classList.remove('is-loading');
      cell.ord.textContent = this.showRank ? String(rankNum) : String(rankNum).padStart(2, '0');
      return;
    }
    const ratio = p.total ? Math.min(1, p.received / p.total) : 0;
    cell.row.classList.add('is-loading');
    cell.row.style.setProperty('--p', ratio.toFixed(3));
    cell.ord.textContent = p.total ? `${Math.round(ratio * 100)}%` : '··';
  }

  /** Repaint one row's progress without touching the rest of the list. */
  updateProgress(id) {
    const key = String(id);
    const items = this.getItems();
    for (let n = 0; n < this.pool.length; n++) {
      const cell = this.pool[n];
      if (cell.row.hidden) continue;
      const index = Number(cell.row.dataset.index);
      const item = items[index];
      if (item && String(item.id) === key) this.#applyProgress(cell, item, index);
    }
  }

  /** Scroll a row into view, centred, without fighting an in-progress drag. */
  scrollTo(index, behavior = 'smooth') {
    if (index < 0) return;
    const height = this.scroller.clientHeight || 400;
    const target = Math.max(0, index * ROW_H - height / 2 + ROW_H / 2);
    if (behavior === 'auto' || typeof this.scroller.scrollTo !== 'function') {
      this.scroller.scrollTop = target;
      this.render();
    } else {
      this.scroller.scrollTo({ top: target, behavior });
    }
  }

  destroy() {
    this.ro.disconnect();
  }
}
