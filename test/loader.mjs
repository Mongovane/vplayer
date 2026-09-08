/**
 * Redirect engine.js's two network-facing imports at the stubs.
 *
 * engine.js is the file worth testing and the only reason it can't be imported
 * directly is that api.js talks to the network and offline.js talks to
 * IndexedDB. Swapping just those two leaves the code under test untouched —
 * no build step, no refactor for testability, and the real store.js.
 */
export async function resolve(specifier, context, next) {
  if (context.parentURL?.includes('/public/src/engine.js')) {
    if (specifier === './api.js') {
      return next('../../test/stub-api.js', context);
    }
    if (specifier === './offline.js') {
      return next('../../test/stub-offline.js', context);
    }
  }
  return next(specifier, context);
}
