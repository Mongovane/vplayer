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

await test("lyrics.js keeps #lyricDialArc steady (no pulsing), aligns English sustained lines without jumping a line ahead, and parseLyrics handles bilingual/offset/endTime LRCs", async () => {
  const dom = new JSDOM(html, { url: "https://vplayer.test/", pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", maxTouchPoints: 5 }, configurable: true, writable: true });
  globalThis.Audio = function () { const el = document.createElement("audio"); el.paused = true; el.currentTime = 0; return el; };
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.requestAnimationFrame = () => 1;

  const store = await import("../public/src/store.js");
  const api = await import("../public/src/api.js");
  const lyricsMod = await import("../public/src/lyrics.js");
  lyricsMod.init();

  // Verify parseLyrics merges same-timestamp bilingual English+Chinese lines and trailing end-timestamps
  const parsedBilingual = api.parseLyrics(
    "[offset:1000]\n[00:11.00]Monday left me broken[00:14.80]\n[00:11.00]星期一让我支离破碎\n[00:21.00]Tuesday I was through with hoping",
    "",
    ""
  );
  assert.equal(parsedBilingual.length, 2, "same-timestamp bilingual LRC lines and trailing end-timestamps must not create duplicate lines");
  assert.equal(parsedBilingual[0].time, 10, "[offset:1000] must shift 11.00s to 10.00s");
  assert.equal(parsedBilingual[0].words, "Monday left me broken");
  assert.equal(parsedBilingual[0].trans, "星期一让我支离破碎");
  assert.equal(parsedBilingual[0].endTime, 13.8, "trailing [00:14.80] minus 1s offset should set endTime=13.8s");

  const overlay = document.getElementById("lyricOverlay");
  overlay.classList.add("is-open");
  const arc = document.getElementById("lyricDialArc");
  const initialArcOpacity = arc.getAttribute("stroke-opacity");
  const initialArcWidth = arc.getAttribute("stroke-width");

  // Feed an English song with a 10s span between lines (e.g. 10s..20s): must NOT insert a gap or jump ahead at t=15s!
  store.set({
    duration: 200,
    playing: true,
    lyrics: [
      { time: 10, words: "Without you I feel torn" },
      { time: 20, words: "Like a sail in a storm" },
    ],
  });

  store.set({ elapsed: 15.5 });
  const lineNodes = document.getElementById("lyrics").children.filter((n) => n.classList.contains("lyric") && !n.classList.contains("gap"));
  assert.equal(lineNodes.length, 2, "expected 2 lyric lines");
  assert.equal(lineNodes[0].classList.contains("is-active"), true, "at t=15.5s (mid-span of 10s..20s), English line 1 must stay active and not jump a line ahead");
  assert.equal(lineNodes[1].classList.contains("is-active"), false, "English line 2 must not activate before t=20s");

  // Verify #lyricDialArc stroke-opacity and stroke-width stay completely steady (no pulsing/flashing)
  assert.equal(arc.getAttribute("stroke-opacity"), initialArcOpacity, "#lyricDialArc stroke-opacity must stay steady without pulsing");
  assert.equal(arc.getAttribute("stroke-width"), initialArcWidth, "#lyricDialArc stroke-width must stay steady without pulsing");

  // At t = 20.5s (line 2): line 1 characters deterministically reset to 0 and line 2 activates
  store.set({ elapsed: 20.5 });
  assert.equal(lineNodes[0].classList.contains("is-active"), false, "line 1 should deactivate at t=20.5s");
  assert.equal(lineNodes[1].classList.contains("is-active"), true, "line 2 should activate at t=20.5s");
  const line1Char = lineNodes[0].children[0].children[0].children[0];
  assert.equal(line1Char._v, 0, "previous line characters must deterministically reset _v to 0");

  // Verify coverUrl security & QQ 300x300 cache-bucket stability + lyrics.stop()
  assert.equal(api.coverUrl("javascript:alert(1)"), "", "coverUrl must reject javascript: URIs");
  assert.equal(api.coverUrl("data:text/html,<script>alert(1)</script>"), "", "coverUrl must reject non-image data: URIs");
  assert.match(api.coverUrl("https://y.gtimg.cn/music/photo_new/T002R500x500M0000039MnYb0qxYhV.jpg", 512), /T002R300x300M000/, "QQ coverUrl must normalize to T002R300x300M000 to avoid 404s and share search cache");
  lyricsMod.stop();
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.name}`);
  else {
    failed += 1;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${r.err.stack}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
