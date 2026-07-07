#!/usr/bin/env node
/*
 * State-path assertion test.
 *
 * Loads the REAL constants.js, schema.js, and state.js (browser IIFEs)
 * into a Node VM with minimal window/localStorage shims, then asserts
 * that every canonical container path in TB.schema.PATHS resolves to a
 * declared container in DEFAULT_STATE via TB.state.get().
 *
 * Why: the review found a class of dead features caused by one module
 * reading a state path another module never writes (fbar.years,
 * family.members[].name, net_worth.reports, projections.startYear).
 * TB.schema centralizes the correct names; this test fails the moment a
 * canonical path drifts away from DEFAULT_STATE, instead of the feature
 * silently going dead (REVIEW.md H5/H13/H16/M18).
 *
 * Usage: node tools/test-paths.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'scripts');

// Minimal browser shims. state.js references only window, localStorage,
// and console; deepClone is JSON-based. If state.js grows a new global
// dependency, this test will throw here — which is itself a useful
// signal to keep it Node-loadable.
const store = {};
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['constants.js', 'schema.js', 'state.js']) {
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const TB = sandbox.window.TB;

let pass = 0, fail = 0;
function check(label, ok) {
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}

console.log('\nAsserting TB.schema loaded:');
check('TB.schema.PATHS present', TB && TB.schema && TB.schema.PATHS);
check('TB.state.get available', TB && TB.state && typeof TB.state.get === 'function');

console.log('\nEvery canonical container path resolves in DEFAULT_STATE:');
if (TB && TB.schema && TB.state) {
  for (const p of TB.schema.containerPaths()) {
    const val = TB.state.get(p);
    check(p + ' → ' + (Array.isArray(val) ? '[]' : typeof val), val !== undefined);
  }
}

console.log('\n----- Results -----');
console.log('  passed: ' + pass);
console.log('  failed: ' + fail);
process.exit(fail === 0 ? 0 : 1);
