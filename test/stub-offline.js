/**
 * Stand-in for offline.js.
 *
 * `downloaded` lets a test pretend some ids have a device copy, which is the
 * only way to exercise the LRU `touch` path — without it resolveTrack skips the
 * whole offline branch (it checks store.offlineIds first) and a test asserting
 * on touch calls passes for the wrong reason.
 */
export const calls = { touch: [], releaseAllExcept: [] };
export const downloaded = new Set();
export function reset() {
  calls.touch = [];
  calls.releaseAllExcept = [];
  downloaded.clear();
}

const has = (id) => downloaded.has(String(id));

export async function meta(id) {
  return has(id) ? { id: String(id), level: 'lossless', levelLabel: 'LOSSLESS', bytes: 1000 } : null;
}
export async function verify(id) { return { ok: has(id) }; }
export async function objectUrl(id) { return has(id) ? `blob:${id}` : null; }
export async function remove(id) { downloaded.delete(String(id)); }
export async function touch(id) { calls.touch.push(String(id)); }
export function releaseAllExcept(keep) { calls.releaseAllExcept.push(keep); }
export function requestPersistence() {}
export async function importFile() { throw new Error('not in test'); }
