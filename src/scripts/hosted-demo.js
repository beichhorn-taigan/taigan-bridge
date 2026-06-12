/* Taigan Bridge — hosted-demo.js
 *
 * Adapts the app's behavior when it's running as a hosted preview
 * (e.g., on taiganjp.com/tools/taigan-bridge) rather than as
 * a downloaded local file. The hosted version is for evaluation
 * only — users shouldn't enter real financial data into a copy of
 * the app they don't own.
 *
 * Two behaviors when hosted:
 *
 *   1. Sticky "LIVE DEMO" banner pinned to the very top of every
 *      page, in a distinctive orange-red, with a prominent "Download"
 *      button linking to GitHub Releases. The banner sits ABOVE the
 *      disclaimer banner so it's the first thing the user sees and
 *      the most visually dominant element on the page.
 *
 *   2. Force-load a sample profile on first visit (when localStorage
 *      has no Taigan Bridge state OR has user-entered onboarding
 *      that isn't from the demo). This guarantees the user lands on
 *      a populated, exploration-ready state and can't accidentally
 *      start entering their own info into the hosted version.
 *
 * Detection: any non-file:// origin is treated as hosted. Localhost
 * and 127.0.0.1 are EXCLUDED so the dev server (npm run dev) doesn't
 * trigger the banner during local development.
 *
 * The script is a no-op when the page is opened via file:// (the
 * downloaded, intended-for-real-use mode).
 */
(function () {
  'use strict';

  // ─── Detection ─────────────────────────────────────────────────────
  function isHostedDemo() {
    const loc = window.location || {};
    const protocol = String(loc.protocol || '').toLowerCase();
    // file:// downloads are the "real use" mode — skip everything.
    if (protocol === 'file:') return false;
    const host = String(loc.hostname || '').toLowerCase();
    // Local dev server (http-server on localhost:4747) should behave
    // like a normal install for the developer's testing experience.
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        host.endsWith('.localhost')) return false;
    // Everything else served over http(s) is treated as hosted demo.
    return protocol === 'http:' || protocol === 'https:';
  }

  if (!isHostedDemo()) return;

  // ─── Force-load demo state if user has nothing useful loaded ───────
  // Runs BEFORE the banner is painted so the page lands in the
  // populated demo state on first visit. Uses sample-data.js's
  // buildSampleState builder and TB.state.import directly to avoid
  // the confirm() dialog that loadInteractive() would trigger.
  function ensureDemoLoaded() {
    if (!window.TB || !TB.state || !TB.sampleData) return;
    // Already in a demo profile? Leave it alone — user may have
    // picked a different one to explore.
    if (TB.sampleData.isDemoActive && TB.sampleData.isDemoActive()) return;
    // No state at all (fresh visit) — load the SOFA profile as the
    // default landing experience.
    const raw = (() => {
      try { return localStorage.getItem(TB.state.STORAGE_KEY); }
      catch (_) { return null; }
    })();
    let shouldLoad = false;
    if (!raw) {
      shouldLoad = true;
    } else {
      try {
        const parsed = JSON.parse(raw);
        // User entered onboarding info that isn't from a demo —
        // overwrite it with the SOFA profile. On the hosted version
        // user-entered data is unsafe (wrong account, mixed with
        // demo data, no guarantee of persistence).
        if (parsed && parsed.onboarding && parsed.onboarding.complete && !parsed._demo) {
          shouldLoad = true;
        }
      } catch (_) {
        shouldLoad = true;
      }
    }
    if (!shouldLoad) return;
    try {
      const state = TB.sampleData.buildSampleState('sofa');
      TB.state.import(JSON.stringify(state));
    } catch (e) {
      console.warn('[hosted-demo] failed to auto-load demo:', e && e.message);
    }
  }

  // ─── Banner ────────────────────────────────────────────────────────
  // Pinned at the very top of <body>, above the disclaimer banner,
  // above the integrity tamper banner, above everything. Non-
  // dismissable (the whole point is to keep it visible). Includes a
  // clear "Download for your own data" CTA pointing at Releases.
  function paintHostedBanner() {
    if (document.querySelector('.tb-hosted-banner')) return;
    const t = (TB.i18n && TB.i18n.t) ? TB.i18n.t : ((k) => k);
    // Primary CTA: one-click direct download from taiganjp.com (no GitHub
    // account or Releases-page navigation needed). Secondary link: GitHub
    // Releases for users who want version history or checksums.
    const DIRECT_DOWNLOAD_URL = 'https://taiganjp.com/downloads/taigan-bridge';
    const RELEASES_URL = 'https://github.com/beichhorn-taigan/taigan-bridge/releases/latest';
    const banner = document.createElement('div');
    banner.className = 'tb-hosted-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      '<strong>🌐 ' + t('hostedDemo.banner.label') + '</strong>' +
      '<span class="tb-hosted-banner__body">' + t('hostedDemo.banner.body') + '</span>' +
      '<a class="tb-hosted-banner__cta" href="' + DIRECT_DOWNLOAD_URL + '">' +
        '⬇ ' + t('hostedDemo.banner.cta') + '</a>' +
      '<a class="tb-hosted-banner__alt" href="' + RELEASES_URL +
        '" target="_blank" rel="noopener noreferrer">' +
        t('hostedDemo.banner.github') + '</a>';
    if (document.body.firstChild) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.body.appendChild(banner);
    }
  }

  function boot() {
    try { ensureDemoLoaded(); } catch (_) { /* never block the page */ }
    try { paintHostedBanner(); } catch (_) { /* never block the page */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for debugging
  window.TB = window.TB || {};
  window.TB.hostedDemo = { isHostedDemo };
})();
