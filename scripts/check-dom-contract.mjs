/**
 * Check the contract between index.html and the code that reaches into it.
 *
 * There is no build step and no framework, so nothing verifies that an element
 * the code looks up actually exists. `$('keepAliveOpt')` returns null, the next
 * property access throws, and because every listener in the app is registered
 * inside one long bindEvents() the throw takes the rest of them with it — a
 * single missing div and nothing works. That is the failure this catches, and
 * it has happened twice, both times while editing the settings panel by
 * character range and quietly removing a neighbouring block.
 *
 * eslint cannot see it, `node --check` cannot see it, and the engine tests
 * cannot see it either — they build their own DOM and never load the page.
 *
 *   node scripts/check-dom-contract.mjs
 */

import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const PAGE = 'public/index.html';
const SOURCES = ['public/src/main.js', 'public/src/list.js', 'public/src/dial.js', 'public/src/lyrics.js'];

const problems = [];
const html = await readFile(PAGE, 'utf8');
const { window } = new JSDOM(html, { url: 'https://vplayer.test/' });
const doc = window.document;

/* 1. Every id the code looks up must exist. ------------------------------- */

for (const file of SOURCES) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  const wanted = new Set();
  // $('id') and the direct form, which both appear in this codebase.
  for (const m of text.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1]);
  for (const m of text.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) wanted.add(m[1]);
  for (const id of wanted) {
    if (!doc.getElementById(id)) problems.push(`${file} looks up #${id}, which is not in ${PAGE}`);
  }
}

/* 2. Every CSS selector the code queries must match something. ------------ */

for (const file of SOURCES) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  // Only `document.querySelector*`. A bare `el.querySelector('.row__art')`
  // runs against markup this app builds at runtime, which is not in the page
  // and never will be — checking those produced fifteen false positives on the
  // first run, which is precisely how a check stops being run.
  for (const m of text.matchAll(/document\.querySelector(?:All)?\('([^'$]+)'\)/g)) {
    const sel = m[1];
    let hit = 0;
    try {
      hit = doc.querySelectorAll(sel).length;
    } catch {
      problems.push(`${file}: invalid selector '${sel}'`);
      continue;
    }
    if (!hit) problems.push(`${file} queries '${sel}', which matches nothing in ${PAGE}`);
  }
}

/* 3. Every <use> must resolve to a sprite id. ----------------------------- */

const sprite = new Set([...doc.querySelectorAll('symbol[id^="i-"], g[id^="i-"]')].map((n) => n.id));
for (const use of doc.querySelectorAll('use')) {
  const ref = (use.getAttribute('href') || use.getAttribute('xlink:href') || '').replace('#', '');
  if (ref && !sprite.has(ref) && !doc.getElementById(ref)) {
    problems.push(`${PAGE}: <use href="#${ref}"> resolves to nothing`);
  }
}

/* 4. A <details> group must ship collapsed. ------------------------------- */

for (const d of doc.querySelectorAll('details')) {
  if (d.hasAttribute('open')) {
    problems.push(`${PAGE}: <details${d.id ? ` #${d.id}` : ''}> ships open — it is meant to be folded shut`);
  }
  if (!d.querySelector('summary')) {
    problems.push(`${PAGE}: <details${d.id ? ` #${d.id}` : ''}> has no <summary>, so there is nothing to click`);
  }
}

/* 5. Ids must be unique. -------------------------------------------------- */

const seen = new Map();
for (const node of doc.querySelectorAll('[id]')) {
  seen.set(node.id, (seen.get(node.id) || 0) + 1);
}
for (const [id, n] of seen) {
  if (n > 1) problems.push(`${PAGE}: #${id} is defined ${n} times`);
}

/* ------------------------------------------------------------------------ */

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `${PAGE} — DOM contract holds (${seen.size} ids, ${sprite.size} sprite glyphs, ${SOURCES.length} sources)`
);
