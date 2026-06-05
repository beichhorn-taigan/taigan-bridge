#!/usr/bin/env node
/* inject-demo-analytics.js
 *
 * Inserts the hosted-demo GoatCounter snippet immediately before </body>
 * in the target HTML file. The GitHub Pages deploy workflow runs this on
 * the Pages copy (dist/index.html) ONLY — the downloadable / release build
 * (dist/taigan-bridge.html) never contains any analytics code. A user who
 * downloads the file and greps it finds nothing.
 *
 * Privacy-friendly by design: GoatCounter sets no cookies, collects no
 * personal data, and does no cross-site tracking — it records aggregate
 * pageview counts plus a tally of clicks on the "Download for your own
 * data" link (an anonymous event, no personal data). The injected snippet
 * is additionally gated to the official demo hostname, so a mirror of the
 * page can't report to our account.
 *
 * Usage:  node tools/inject-demo-analytics.js <path-to-html>
 *
 * Idempotent: a second run on an already-injected file is a no-op. Exits
 * non-zero on any failure so a broken deploy fails loudly rather than
 * silently shipping an un-instrumented (or malformed) page.
 */
'use strict';

const fs = require('fs');

const DEMO_HOST = 'beichhorn-taigan.github.io';
const GC_ENDPOINT = 'https://taiganbridge.goatcounter.com/count';
const MARKER = 'data-goatcounter'; // presence => already injected

const SNIPPET = [
  '<!-- Hosted-demo analytics (GoatCounter) — injected only into the GitHub',
  '     Pages copy by tools/inject-demo-analytics.js; never in the download.',
  '     No cookies, no personal data, no cross-site tracking; aggregate',
  '     pageviews + a count of download-link clicks. Gated to the demo host. -->',
  '<script>',
  '  (function () {',
  "    if (location.hostname !== '" + DEMO_HOST + "') return;",
  "    var gc = document.createElement('script');",
  '    gc.async = true;',
  "    gc.src = '//gc.zgo.at/count.js';",
  "    gc.setAttribute('data-goatcounter', '" + GC_ENDPOINT + "');",
  '    document.body.appendChild(gc);',
  '    // Count clicks on any "Download for your own data" link (top banner',
  '    // or the Settings card). Delegated, so it also catches links that',
  '    // are rendered after this script runs.',
  "    document.addEventListener('click', function (e) {",
  '      var a = e.target && e.target.closest && e.target.closest(\'a[href*="/releases"]\');',
  '      if (!a) return;',
  "      if (window.goatcounter && typeof window.goatcounter.count === 'function') {",
  '        window.goatcounter.count({',
  "          path: 'download-cta',",
  "          title: 'Download for your own data',",
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
