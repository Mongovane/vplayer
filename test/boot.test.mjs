/**
 * Boot the whole page in jsdom, with one element removed on purpose.
 *
 * Every listener in main.js is registered from a single function, so `el.foo`
 * being null used to throw on the next property access and take the other 87
 * registrations with it — one missing div and the app did not start at all.
 * That shipped twice.
 *
 * `scripts/check-dom-contract.mjs` is the real guard and catches a missing id
 * before it ever deploys. This checks what happens if something gets past it:
 * one dead control, everything else working, and a loud message saying which.
 *
 *   node test/boot.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile('public/index.html', 'utf8');

/**
 * Load main.js against a page, optionally with some ids removed, and report
 * what got wired up.
 *
 * main.js is an ES module that imports its siblings, so it is not evaluated
 * here — that would need the whole engine, IndexedDB and network. What is
 * exercised is the part under test: the `$()` lookup and what the code does
 * with what it returns.
 */
async function boot({ remove = [] } = {}) {
  const dom = new JSDOM(html, { url: 'https://vplayer.test/', pretendToBeVisual: true });
  const { document } = dom.window;

  for (const id of remove) {
    const node = document.getElementById(id);
    assert.ok(node, `precondition: #${id} is not in the page to begin with`);
    node.remove();
  }

  const errors = [];
  const bound = [];

  // The two definitions under test, lifted from main.js so the test exercises
  // the real implementation rather than a paraphrase of it.
  const source = await readFile('public/src/main.js', 'utf8');
  const from = source.indexOf('const reportedMissing = new Set();');
  const to = source.indexOf('\n', source.indexOf('const $ = (id) => document.getElementById(id)'));
  assert.ok(from > 0 && to > from, 'could not find the $() definition in main.js');
  const helper = source.slice(from, to);

  const make = new dom.window.Function(
    'document',
    'console',
    `${helper}; return $;`
  );
  const $ = make(document, { error: (m) => errors.push(String(m)) });

  // Stand in for bindEvents(): a run of registrations against ids the real one
  // uses, in one function, exactly as the real one does it.
  const ids = [
    'playBtn', 'nextBtn', 'prevBtn', 'modeBtn', 'searchInput',
    'favPlayAllBtn', 'favQueueBtn', 'favIngestBtn', 'favDownloadAllBtn',
    'chartPlayAllBtn', 'chartQueueBtn', 'searchPlayAllBtn', 'searchQueueBtn',
    'libraryRestoreBtn', 'createInviteBtn', 'memberLogoutBtn',
    'chartRetryBtn', 'approveAllBtn', 'rejectAllBtn', 'approveCancelBtn',
  ];
  for (const id of ids) {
    // No try/catch: the point is that this loop runs to completion.
    const node = $(id);
    node.addEventListener('click', () => {});
    node.hidden = false;
    node.textContent = '';
    bound.push(id);
  }

  // Looked up again, because main.js does: the same id appears at a registration
  // site and again wherever it is painted. Without this the "reported once"
  // assertion below passes whether the de-duplication exists or not — each id
  // was only ever asked for once, so one message was inevitable.
  for (const id of ids) $(id).hidden = false;

  return { bound, errors, ids };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

await test('a complete page wires everything and says nothing', async () => {
  const { bound, errors, ids } = await boot();
  assert.equal(bound.length, ids.length, 'not every control was wired');
  assert.deepEqual(errors, [], `complained about a complete page: ${errors.join(' | ')}`);
});

await test('one missing element does not stop the rest', async () => {
  // The exact shape of the failure that shipped: a settings block removed by
  // accident while editing a neighbour.
  const { bound, ids } = await boot({ remove: ['favIngestBtn'] });
  assert.equal(
    bound.length,
    ids.length,
    `wiring stopped after ${bound.length}/${ids.length} controls — one missing element killed the rest`
  );
});

await test('it says which element is missing, once', async () => {
  const { errors } = await boot({ remove: ['chartQueueBtn'] });
  assert.equal(errors.length, 1, `expected one message, got ${errors.length}`);
  assert.match(errors[0], /chartQueueBtn/, 'the message does not name the element');
  assert.match(errors[0], /npm run check/, 'the message does not say what would have caught it');
});

await test('several missing elements are each named once', async () => {
  const { bound, errors, ids } = await boot({
    remove: ['favPlayAllBtn', 'favQueueBtn', 'searchQueueBtn'],
  });
  assert.equal(bound.length, ids.length, 'wiring stopped part way');
  assert.equal(errors.length, 3, `expected three messages, got ${errors.length}`);
});

await test('a stand-in absorbs the operations the real code performs on it', async () => {
  const { errors } = await boot({ remove: ['modeBtn'] });
  assert.equal(errors.length, 1);
  // Beyond addEventListener/hidden/textContent, which boot() already exercised:
  // the shapes that would otherwise throw on undefined.
  const dom = new JSDOM(html, { url: 'https://vplayer.test/' });
  const source = await readFile('public/src/main.js', 'utf8');
  const from = source.indexOf('const reportedMissing = new Set();');
  const to = source.indexOf('\n', source.indexOf('const $ = (id) => document.getElementById(id)'));
  const $ = new dom.window.Function('document', 'console', `${source.slice(from, to)}; return $;`)(
    dom.window.document,
    { error: () => {} }
  );
  const stub = $('definitely-not-here');
  stub.classList.add('is-on');
  stub.classList.remove('is-on');
  assert.equal(stub.classList.contains('is-on'), false);
  stub.dataset.armed = '1';
  stub.style.width = '10px';
  stub.setAttribute('aria-pressed', 'true');
  stub.querySelectorAll?.('button');
  assert.equal(stub.hidden, true, 'a missing element should read as hidden, not visible');
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${String(r.err.message).split('\n')[0]}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
