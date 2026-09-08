import globals from 'globals';

/**
 * The gate `node --check` cannot be.
 *
 * `node --check` parses. It cannot see that a `function` declared inside
 * bindEvents() is invisible to bindKeys(), because that is a scope resolution
 * performed at call time, not a syntax error. That exact mistake shipped
 * openLyrics/closeLyrics as a live ReferenceError on four key bindings.
 *
 * `no-undef` is the rule that catches it, and it is the reason this file
 * exists. Everything else here is in the same family: mistakes that parse
 * cleanly and fail at runtime.
 *
 * `no-use-before-define` is deliberately off. In a module the pattern
 * "function defined at line 300 reads a `let` declared at line 1200" is safe,
 * because the function is only ever called after evaluation finishes — and this
 * codebase does it constantly. Leaving it on produced ~30 findings, none real,
 * which is how a check stops being run.
 */
const runtimeHazards = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'use-isnan': 'error',
  'valid-typeof': 'error',
  // Signal, not noise: an unused binding after a refactor is usually a call
  // site that moved and a body that did not.
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
  'no-use-before-define': 'off',
};

export default [
  {
    files: ['public/src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.browser },
    rules: runtimeHazards,
  },
  {
    files: ['public/sw.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: globals.serviceworker },
    rules: runtimeHazards,
  },
  {
    files: ['functions/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.worker },
    rules: runtimeHazards,
  },
];
