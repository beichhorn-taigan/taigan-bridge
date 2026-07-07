#!/usr/bin/env node
/*
 * Build smoke test.
 *
 * Runs `node build.js`, then asserts that EVERY local <script src> and
 * <link rel=stylesheet> referenced by src/index.html was actually
 * inlined into dist/taigan-bridge.html (as a `data-source="…"` marker).
 *
 * Why: build.js inlines via regex, and the review found silent-failure
 * modes — e.g. a <script src="x"></script> with whitespace before the
 * closing tag doesn't match the inliner and ships as an un-inlined
 * external reference that 404s from file://, with no build warning
 * (REVIEW.md M35). This test turns that class of regression into a
 * failing CI check instead of a broken download.
 *
 * Usage: node tools/test-build.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_HTML = path.join(ROOT, 'src', 'index.html');
const DIST_HTML = path.join(ROOT, 'dist', 'taigan-bridge.html');

let fail = 0;
function check(label, ok) {
  if (ok) { console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}

console.log('\nRunning build...');
execFileSync(process.execPath, [path.join(ROOT, 'build.js')], { stdio: 'inherit' });

const src = fs.readFileSync(SRC_HTML, 'utf8');
const dist = fs.readFileSync(DIST_HTML, 'utf8');

// Collect local references from src/index.html.
const refs = [];
const scriptRe = /<script\s+[^>]*src=["']([^"']+)["']/gi;
const linkRe = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi;
// href can also come before rel; capture that ordering too.
const linkRe2 = /<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi;
let m;
while ((m = scriptRe.exec(src))) refs.push(m[1]);
while ((m = linkRe.exec(src))) refs.push(m[1]);
while ((m = linkRe2.exec(src))) refs.push(m[1]);

const local = [...new Set(refs)].filter((r) => !/^https?:\/\//i.test(r) && !r.startsWith('data:'));

console.log('\nAsserting every local asset was inlined into the dist:');
check('dist exists and is substantial (>200KB)', fs.statSync(DIST_HTML).size > 200 * 1024);
for (const ref of local) {
  const inlined = dist.includes('data-source="' + ref + '"');
  const stillExternal = new RegExp('src=["\']' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']').test(dist) ||
    new RegExp('href=["\']' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']').test(dist);
  check(ref + ' → inlined', inlined && !stillExternal);
}

console.log('\n----- Results -----');
console.log('  local assets checked: ' + local.length);
console.log('  failed: ' + fail);
process.exit(fail === 0 ? 0 : 1);
