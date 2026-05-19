/* Taigan Bridge — integrity.js
 *
 * Runtime anti-tamper hardening. Single-file HTML apps are inherently
 * copyable — anyone with View Source can lift the bundle. The goal of
 * this module isn't to make copying impossible (which is unachievable
 * in any client-side tool) but to add enough friction that:
 *
 *   1. Lazy republishers who strip the LICENSE / brand and try to
 *      pass it off as their own product produce a copy that
 *      actively warns its users that something is wrong, and
 *   2. Forensic identification of leaked copies is possible from a
 *      single open file — the canary IDs in the HTML head, the
 *      build hash, and the runtime checks all triangulate.
 *
 * Three layers:
 *
 *   A. Brand integrity check — verifies that key brand markers
 *      (copyright footer, License link, build-hash meta tag,
 *      対岸 character in DOM) are present at boot. If anything is
 *      missing, surfaces a small "Modified copy detected" banner
 *      and logs to console. Sets TB.integrity.tampered = true.
 *
 *   B. Console deterrent — Facebook-style dev-tools warning that
 *      tells anyone opening DevTools they should NOT paste random
 *      code (also explains the licensing situation in plain language).
 *
 *   C. Forensic fingerprint — on first run, captures a fingerprint
 *      (build hash + canary IDs + first-load timestamp + browser
 *      family) into localStorage. Persists across reloads. This
 *      lets the user themselves see when their copy was first opened
 *      and from which build, in case they ever need to demonstrate
 *      provenance.
 *
 * Spread across multiple checks intentionally — a single grep-and-
 * delete on "integrity" doesn't disable everything. The CSS for the
 * tamper banner lives in base.css as .tb-tamper-banner.
 */
(function () {
  'use strict';

  // ─── A. Brand integrity check ─────────────────────────────────────
  // Each check returns { id, ok, detail } so the report can name
  // exactly what's missing without leaking the full set of markers
  // (a tamperer who reads the source still has to find each one in
  // the build to strip them; a forensic auditor can match the failed
  // checks against the source to identify which file was modified).
  const BRAND_CHECKS = [
    {
      id: 'copyright-footer',
      run: () => {
        // The page footer must contain the author attribution.
        // Stripping the © line is the most common branding-removal
        // move; this catches it.
        const footer = document.querySelector('.tb-footer');
        const ok = !!footer && /Eichhorn/i.test(footer.textContent);
        return { ok, detail: ok ? null : 'footer attribution missing' };
      },
    },
    {
      id: 'license-link',
      run: () => {
        // A link to the license must exist in the footer (or
        // elsewhere). Distributing without the LICENSE.md and the
        // link to it violates the license terms.
        const link = document.querySelector('a[href="#license"]');
        return { ok: !!link, detail: link ? null : 'license link missing' };
      },
    },
    {
      id: 'build-hash-meta',
      run: () => {
        // The build hash + version meta tags identify which release
        // a copy came from. Stripping them is a classic copy-and-
        // pretend-it's-yours tell.
        const v = document.querySelector('meta[name="tb-version"]');
        const h = document.querySelector('meta[name="tb-build-hash"]');
        const ok = !!v && !!h
          && (v.getAttribute('content') || '').trim() !== ''
          && (h.getAttribute('content') || '').trim() !== '';
        return { ok, detail: ok ? null : 'build identifiers missing' };
      },
    },
    {
      id: 'brand-mark-jp',
      run: () => {
        // The 対岸 brand character must appear in the brand block
        // in the header. This is the trademark-protected mark; its
        // removal is the surest sign that someone's tried to rebrand
        // the product.
        const brand = document.querySelector('.tb-brand');
        const ok = !!brand && /対岸/.test(brand.textContent);
        return { ok, detail: ok ? null : 'brand mark missing from header' };
      },
    },
    {
      id: 'disclaimer-banner',
      run: () => {
        // The "not financial advice" disclaimer is required by the
        // license. Hiding it is a liability shift — flag it.
        const banner = document.querySelector('.tb-disclaimer-banner');
        const ok = !!banner && /not\s+financial/i.test(banner.textContent);
        return { ok, detail: ok ? null : 'disclaimer banner missing or modified' };
      },
    },
  ];

  function runBrandIntegrity() {
    const results = BRAND_CHECKS.map((c) => {
      try {
        const r = c.run();
        return { id: c.id, ok: !!r.ok, detail: r.detail || null };
      } catch (e) {
        return { id: c.id, ok: false, detail: 'check threw: ' + (e.message || e) };
      }
    });
    const failed = results.filter((r) => !r.ok);
    return { ok: failed.length === 0, failed, all: results };
  }

  function showTamperBanner(failed) {
    // Insert at the very top of <body>, above the disclaimer banner
    // (or wherever — the CSS pins it visually). Idempotent: skip if
    // we've already inserted one.
    if (document.querySelector('.tb-tamper-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'tb-tamper-banner';
    banner.setAttribute('role', 'alert');
    banner.innerHTML =
      '<strong>⚠ Modified copy detected.</strong> ' +
      'This appears to be a tampered or republished build of Taigan Bridge. ' +
      'The original is free at the source — accept no substitutes. ' +
      'Failed checks: ' + failed.map((f) => f.id).join(', ') + '.';
    if (document.body.firstChild) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.body.appendChild(banner);
    }
  }

  // ─── B. Console deterrent ─────────────────────────────────────────
  // Facebook / Google / Twitter all use this pattern. It's
  // surprisingly effective at discouraging the "someone DM'd me JS
  // to paste in DevTools" attack, and it doubles as a friendly
  // "hey, this is a copyrighted tool" signal to people exploring
  // the source.
  function installConsoleDeterrent() {
    if (typeof console === 'undefined') return;
    const styleBig = 'color: #B7472A; font-size: 28px; font-weight: 700;';
    const styleBody = 'color: #14181F; font-size: 13px; line-height: 1.5;';
    const styleMuted = 'color: #5C6470; font-size: 12px;';
    try {
      console.log('%c⚠  STOP', styleBig);
      console.log(
        '%cThis is the developer console for Taigan Bridge.\n' +
        'If someone told you to paste code here, they\'re trying to compromise your account.\n' +
        'Anything you paste runs with full access to your saved data, your Claude API key,\n' +
        'and your browser. Do not paste anything here unless you wrote it yourself.',
        styleBody,
      );
      console.log(
        '%cTaigan Bridge — © Benjamin Eichhorn. Free for personal use.\n' +
        'Source viewing OK. Republishing / commercial use / derivative works require\n' +
        'written permission. See the License modal in the footer for terms.\n' +
        'Contact: benjamin.eichhorn@gmail.com',
        styleMuted,
      );
    } catch (_) { /* old browsers — silent */ }
  }

  // ─── C. Forensic fingerprint ──────────────────────────────────────
  // Captured once per browser, never sent anywhere. Lives in
  // localStorage so the user can see (and we can ask them about) the
  // first-load record if a copy ever needs to be traced.
  function captureFingerprint() {
    try {
      const KEY = 'tb-integrity-fingerprint';
      const existing = localStorage.getItem(KEY);
      if (existing) return JSON.parse(existing);
      const v = (document.querySelector('meta[name="tb-version"]') || {}).content || '';
      const h = (document.querySelector('meta[name="tb-build-hash"]') || {}).content || '';
      const d = (document.querySelector('meta[name="tb-build-date"]') || {}).content || '';
      // Pull any canary IDs from the HTML comment in <head>. They live
      // in a structured comment block injected by tools/canary.js;
      // grab the first three uuid-shaped tokens we find.
      const canaries = [];
      try {
        const html = document.documentElement.outerHTML.slice(0, 8000);
        const matches = html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
        for (let i = 0; i < Math.min(3, matches.length); i++) canaries.push(matches[i]);
      } catch (_) { /* ignore */ }
      const fp = {
        first_loaded_at: new Date().toISOString(),
        build_version: v,
        build_hash: h,
        build_date: d,
        canaries,
        ua_family: detectUaFamily(),
        // No personally-identifying data captured — we deliberately
        // skip the full UA string, screen size, fonts, etc. The point
        // is to tag THIS install at THIS build, not to fingerprint
        // the user.
      };
      localStorage.setItem(KEY, JSON.stringify(fp));
      return fp;
    } catch (_) {
      return null;
    }
  }
  function detectUaFamily() {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.indexOf('firefox') !== -1)               return 'firefox';
    if (ua.indexOf('edg/') !== -1)                  return 'edge';
    if (ua.indexOf('chrome') !== -1)                return 'chromium';
    if (ua.indexOf('safari') !== -1)                return 'safari';
    return 'other';
  }

  // ─── Boot ─────────────────────────────────────────────────────────
  function boot() {
    installConsoleDeterrent();
    const fp = captureFingerprint();
    const integrity = runBrandIntegrity();
    if (!integrity.ok) {
      try { showTamperBanner(integrity.failed); } catch (_) { /* don't break the app */ }
      try {
        console.warn(
          '[Taigan Bridge] integrity check failed:',
          integrity.failed.map((f) => f.id + (f.detail ? ' (' + f.detail + ')' : '')).join(', '),
        );
      } catch (_) { /* ignore */ }
    }
    window.TB = window.TB || {};
    window.TB.integrity = {
      tampered: !integrity.ok,
      checks: integrity.all,
      fingerprint: fp,
      // Re-run on demand (e.g., after a module re-renders the footer).
      recheck: () => runBrandIntegrity(),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
