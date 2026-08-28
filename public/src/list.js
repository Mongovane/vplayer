/**
 * list.js — one virtual scroller.
 *
 * The old build had two: `setupVirtualScroll`/`vsCreateItem`/`vsRenderVisible`
 * for desktop and `mCreateItem`/`mRender` for mobile, kept in sync by hand.
 * This is a single node-recycling list; the queue and the search results are
 * both instances of it, differing only in the actions each row exposes.
 */

const ROW_H = 56;

/** 1×1 transparent gif — the "no artwork" state. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const OVERSCAN = 6;

const ICONS = {
  play: 'i-play',
  plus: 'i-plus',
  minus: 'i-minus',
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
  constructor({ scroller, sizer, items, onActivate, actions, currentIndex }) {
    this.scroller = scroller;
    this.sizer = sizer;
    this.getItems = items;
    this.onActivate = onActivate;
    this.getActions = actions || (() => []);
    this.getCurrent = currentIndex || (() => -1);

    this.pool = [];
    this.range = [0, -1];

    this.scroller.addEventListener('scroll', () => this.render(), { passive: true });
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.scroller);
  }

  /** Row factory. Structure is fixed so nodes can be recycled by index. */
  #createRow() {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="row__ord num"></span>
      <img class="row__art" alt="" loading="lazy" decoding="async">
      <span class="row__meta">
        <span class="row__name"></span>
        <span class="row__sub"></span>
      </span>
      <span class="row__tail"></span>`;

    row.querySelector('.row__art').addEventListener('error', (e) => {
      e.target.src = BLANK;
      e.target.classList.add('is-empty');
    });

    row.addEventListener('click', (e) => {
      if (e.target.closest('.row__tail')) return;
      const i = Number(row.dataset.index);
      const item = this.getItems()[i];
      if (item) this.onActivate(item, i);
    });

    this.sizer.append(row);
    return {
      row,
      ord: row.querySelector('.row__ord'),
      art: row.querySelector('.row__art'),
      name: row.querySelector('.row__name'),
      sub: row.querySelector('.row__sub'),
      tail: row.querySelector('.row__tail'),
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
        btn.onclick = (e) => {
          e.stopPropagation();
          actions[i].run(item, Number(cell.row.dataset.index));
        };
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
      btn.innerHTML = `<svg><use href="#${ICONS[action.icon] || action.icon}"/></svg>`;
      btn.onclick = (e) => {
        e.stopPropagation();
        action.run(item, Number(cell.row.dataset.index));
      };
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

      cell.ord.textContent = String(i + 1).padStart(2, '0');
      // textContent throughout: every field here came from an upstream API or a
      // user-supplied file, so nothing is ever parsed as markup.
      cell.name.textContent = item.name || '未知歌曲';
      cell.sub.textContent = [item.artist, item.album].filter(Boolean).join(' · ') || '—';

      // QQ and KuGou search payloads carry no artwork at all — covers only
      // exist on resolve. That is the API's shape, not a failure, so an absent
      // cover gets a quiet bezel mark rather than an empty box that reads as
      // something broken.
      const art = item.cover ? `/api/image?url=${encodeURIComponent(item.cover)}` : '';
      if (cell.art.dataset.src !== art) {
        cell.art.dataset.src = art;
        cell.art.src = art || BLANK;
        cell.art.classList.toggle('is-empty', !art);
      }

      this.#fillActions(cell, item, i);
    }
  }

  /** Scroll a row into view, centred, without fighting an in-progress drag. */
  scrollTo(index, behavior = 'smooth') {
    if (index < 0) return;
    const target = index * ROW_H - this.scroller.clientHeight / 2 + ROW_H / 2;
    this.scroller.scrollTo({ top: Math.max(0, target), behavior });
  }

  destroy() {
    this.ro.disconnect();
  }
}
