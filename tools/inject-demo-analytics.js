#!/usr/bin/env node
/* inject-demo-analytics.js
 *
 * THE canonical step when re-publishing the hosted demo. The demo lives at
 * taiganjp.com/tools/taigan-bridge/ (served from the taiganjp site repo);
 * shipping a new Bridge version there is:
 *
 *   1. npm run build                              (in this repo)
 *   2. cp dist/taigan-bridge.html  ../taiganjp/public/tools/taigan-bridge/index.html
 *   3. node tools/inject-demo-analytics.js ../taiganjp/public/tools/taigan-bridge/index.html
 *   (the taiganjp README documents the same procedure from its side)
 *
 * Inserts the hosted-demo GoatCounter snippet immediately before the final
 * </body> in the target HTML file. The hosted copy ONLY — the downloadable
 * / release build (dist/taigan-bridge.html) never contains any analytics
 * code. A user who downloads the file and greps it finds nothing.
 *
 * Privacy-friendly by design: GoatCounter sets no cookies, collects no
 * personal data, and does no cross-site tracking — it records aggregate
 * pageview counts plus a tally of clicks on the "Download for your own
 * data" links (an anonymous event, no personal data). The injected snippet
 * is additionally gated to the official demo hostname, so a mirror of the
 * page can't report to our account.
 *
 * Reports to the taiganjp GoatCounter property (the site's own), so demo
 * pageviews, download clicks, and site traffic live in one dashboard.
 *
 * Usage:  node tools/inject-demo-analytics.js <path-to-html>
 *
 * Idempotent: a second run on an already-injected file is a no-op. Exits
 * non-zero on any failure so a broken publish fails loudly rather than
 * silently shipping an un-instrumented (or malformed) page.
 */
'use strict';

const fs = require('fs');

const DEMO_HOST = 'taiganjp.com';
const GC_ENDPOINT = 'https://taiganjp.goatcounter.com/count';
const MARKER = 'data-goatcounter'; // presence => already injected

const SNIPPET = [
  '<!-- Hosted-demo analytics (GoatCounter) — injected only into the hosted',
  '     copy by TaiganBridge tools/inject-demo-analytics.js; never in the',
  '     download. No cookies, no personal data, no cross-site tracking;',
  '     aggregate pageviews + a count of download-link clicks. Gated to the',
  '     demo host. -->',
  '<script>',
  '  (function () {',
  "    if (location.hostname !== '" + DEMO_HOST + "') return;",
  "    var gc = document.createElement('script');",
  '    gc.async = true;',
  "    gc.src = '//gc.zgo.at/count.js';",
  "    gc.setAttribute('data-goatcounter', '" + GC_ENDPOINT + "');",
  '    document.body.appendChild(gc);',
  '    // Count clicks on any "Download for your own data" link — the top',
  '    // banner CTA, the Settings card (GitHub releases), or a direct',
  '    // /downloads/ link. Delegated, so it also catches links rendered',
  '    // after this script runs.',
  "    document.addEventListener('click', function (e) {",
  '      var a = e.target && e.target.closest &&',
  '        e.target.closest(\'a[href*="/releases"], a[href*="/downloads/taigan-bridge"]\');',
  '      if (!a) return;',
  "      if (window.goatcounter && typeof window.goatcounter.count === 'function') {",
  '        window.goatcounter.count({',
  "          path: 'download-taigan-bridge-demo',",
  "          title: 'Taigan Bridge download (from demo)',",
  '          event: true,',
  '        });',
  '      }',
  '    });',
  '  })();',
  '</script>',
].join('\n');

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('[inject-demo-analytics] usage: node tools/inject-demo-analytics.js <path-to-html>');
    process.exit(2);
  }

  let html;
  try {
    html = fs.readFileSync(target, 'utf8');
  } catch (e) {
    console.error('[inject-demo-analytics] cannot read ' + target + ': ' + e.message);
    process.exit(1);
  }

  if (html.indexOf(MARKER) !== -1) {
    console.log('[inject-demo-analytics] already present in ' + target + ' — skipping.');
    return;
  }

  const idx = html.lastIndexOf('</body>');
  if (idx === -1) {
    console.error('[inject-demo-analytics] no </body> found in ' + target + ' — refusing to inject.');
    process.exit(1);
  }

  const out = html.slice(0, idx) + SNIPPET + '\n' + html.slice(idx);
  fs.writeFileSync(target, out, 'utf8');
  console.log('[inject-demo-analytics] injected GoatCounter snippet into ' + target);
}

main();
