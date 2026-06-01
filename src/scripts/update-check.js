/* Taigan Bridge — update-check.js
 *
 * Lets a downloaded copy of Taigan Bridge learn that a newer release
 * is available without making the kind of fetch() call that file://
 * pages can't perform.
 *
 *   Constraint:  most users open this app as a file:// download, where
 *                Chrome/Edge block all cross-origin fetch/XHR. We can
 *                therefore NOT call api.github.com directly from the
 *                runtime — it works on the dev server and from
 *                github.io, but silently fails for ~90% of real users.
 *
 *   Workaround:  cross-origin <script src=...> tags ARE allowed even
 *                from file://. We publish a tiny version.js (built to
 *                the repo root, committed + tagged each release) and
 *                serve it via jsDelivr from the latest tag. It just
 *                assigns a payload object onto a global. The runtime
 *                injects a <script> tag, waits for onload, and reads
 *                the payload back. Bonus: jsDelivr's public hit stats
 *                give a coarse, anonymous active-install count.
 *
 * Privacy:
 *   - Off by default until the user answers a one-time consent
 *     prompt. The prompt explains exactly what the request is and
 *     what it carries (nothing — just an HTTP GET of a static JS
 *     file, no params, no headers we control).
 *   - "Ask me later" leaves the consent unset so we re-prompt on the
 *     next launch. "Yes" enables; "No" sets enabled=false but
 *     consented=true so we don't keep nagging.
 *   - Settings → "Check for updates" toggle to change the choice
 *     after the fact. A "Check now" button is always available
 *     regardless of the toggle (manual one-shot).
 *
 * Rate-limiting:
 *   - Auto-checks fire at most once per 24h per browser, even if the
 *     toggle is on and the app is launched twenty times that day.
 *   - The version.js URL gets a cache-buster query so we don't see
 *     a stale CDN copy.
 *
 * Banner:
 *   - Inline (NOT sticky) so we don't add yet another fixed strip to
 *     the top of the viewport — disclaimer + tamper + hosted-demo
 *     are already stacking sticky bars there.
 *   - Dismissable per-version: dismissing 0.2.0 doesn't dismiss 0.3.0.
 *
 * Hosted-demo skip:
 *   - The hosted preview at github.io is, by definition, always the
 *     latest. Showing an "update available" banner there would be
 *     nonsensical, so we no-op entirely when isHostedDemo() is true.
 *
 * Schema versioning:
 *   - The payload carries `schema: 1`. Any future format change should
 *     bump this number and old installs will gracefully skip payloads
 *     they don't understand.
 */
(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────
  const STATE_NS = 'settings.updateCheck';
  const RELEASES_URL = 'https://github.com/beichhorn-taigan/taigan-bridge/releases/latest';
  // Where version.js lives. Served by jsDelivr from the LATEST release
  // tag (build.js writes version.js at the repo root; it's committed
  // and tagged with each release). Two reasons for jsDelivr over
  // GitHub Pages:
  //   1. jsDelivr publishes public, aggregate hit statistics
  //      (https://data.jsdelivr.com/v1/stats/packages/gh/<owner>/<repo>),
  //      giving a coarse, anonymous active-install signal — no PII,
  //      no backend, no cookies.
  //   2. @latest resolves to the newest semver tag, which is exactly
  //      the version we want to advertise (and matches the
  //      releases/latest download link).
  // Caveat: jsDelivr caches @latest aliases (revalidated; up to ~7d
  // worst case), so a brand-new release can take a little while to be
  // announced to existing installs. Fine for occasional releases.
  const VERSION_URL = 'https://cdn.jsdelivr.net/gh/beichhorn-taigan/taigan-bridge@latest/version.js';
  // 24h between auto-checks (manual "Check now" bypasses this).
  const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  // Payload schema the runtime understands. Bump if the version.js
  // format changes incompatibly.
  const SUPPORTED_SCHEMAS = [1];

  // ─── Helpers ───────────────────────────────────────────────────────
  function isHostedDemo() {
    return !!(window.TB && TB.hostedDemo && TB.hostedDemo.isHostedDemo &&
              TB.hostedDemo.isHostedDemo());
  }

  function getLocalVersion() {
    const m = document.querySelector('meta[name="tb-version"]');
    return m ? String(m.content || '').trim() : '';
  }

  function getState() {
    if (!window.TB || !TB.state) return {};
    return TB.state.get(STATE_NS) || {};
  }
  function patchState(patch) {
    if (!window.TB || !TB.state) return;
    const cur = getState();
    TB.state.set(STATE_NS, Object.assign({}, cur, patch));
  }

  // Tolerant semver-ish compare. Strips any pre-release suffix
  // (`-rc1`, `-beta.2`) so we compare on the stable triple only. We
  // ship stable-only today; if/when prereleases become a thing,
  // version.js should expose a separate `beta` field rather than
  // making this comparator clever.
  function isNewer(remote, local) {
    if (!remote || !local) return false;
    const r = String(remote).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const l = String(local).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(r.length, l.length);
    for (let i = 0; i < len; i++) {
      const ri = r[i] || 0;
      const li = l[i] || 0;
      if (ri > li) return true;
      if (ri < li) return false;
    }
    return false;
  }

  function t(key, vars) {
    return (window.TB && TB.i18n && TB.i18n.t) ? TB.i18n.t(key, vars) : key;
  }

  // ─── Network: load version.js ──────────────────────────────────────
  // Returns a promise that resolves with the payload object, or
  // rejects with an Error. Uses <script> injection (not fetch) so it
  // works from file:// where cross-origin fetch is blocked.
  function loadPayload() {
    return new Promise(function (resolve, reject) {
      // Reset any prior payload so a stale value can't leak through.
      try { window.__TB_UPDATE_PAYLOAD__ = null; } catch (_) {}
      const script = document.createElement('script');
      // Cache-buster so we never read a stale CDN copy. The hosted
      // file is small so the cost of always-fresh fetches is trivial.
      script.src = VERSION_URL + '?_=' + Date.now();
      script.async = true;
      let settled = false;
      const cleanup = function () {
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      const timeout = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('timeout'));
      }, 10000);
      script.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        const payload = window.__TB_UPDATE_PAYLOAD__;
        if (!payload || typeof payload !== 'object') {
          reject(new Error('no payload'));
          return;
        }
        if (SUPPORTED_SCHEMAS.indexOf(payload.schema) === -1) {
          reject(new Error('unsupported schema: ' + payload.schema));
          return;
        }
        resolve(payload);
      };
      script.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error('network'));
      };
      document.head.appendChild(script);
    });
  }

  // ─── Banner ────────────────────────────────────────────────────────
  // Painted under the disclaimer banner (in document order). Not
  // sticky — we already have 2–3 sticky bars at top.
  function paintBanner(payload) {
    // If the user has dismissed this exact version, respect that.
    const state = getState();
    if (state.dismissedVersion === payload.stable) return;
    // Don't paint twice.
    if (document.querySelector('.tb-update-banner')) return;

    const banner = document.createElement('div');
    banner.className = 'tb-update-banner';
    banner.setAttribute('role', 'status');

    const versionText = payload.stable;
    const dateText = payload.date ? ' · ' + payload.date : '';

    banner.innerHTML =
      '<span class="tb-update-banner__icon" aria-hidden="true">ℹ</span>' +
      '<span class="tb-update-banner__body">' +
        '<strong>' + t('updateCheck.banner.label') + '</strong> ' +
        t('updateCheck.banner.body', { version: versionText }) +
        '<span class="tb-update-banner__meta">' + dateText + '</span>' +
      '</span>' +
      '<span class="tb-update-banner__actions">' +
        '<a class="tb-update-banner__cta" href="' + (payload.url || RELEASES_URL) + '"' +
          ' target="_blank" rel="noopener noreferrer">' +
          '⬇ ' + t('updateCheck.banner.download') + '</a>' +
        '<button type="button" class="tb-update-banner__dismiss" aria-label="' +
          t('updateCheck.banner.dismissAria') + '">' +
          t('updateCheck.banner.dismiss') + '</button>' +
      '</span>';

    banner.querySelector('.tb-update-banner__dismiss').addEventListener('click', function () {
      patchState({ dismissedVersion: payload.stable });
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    });

    // Insert below the disclaimer banner if present, else at the top
    // of <body>. Either way it ends up under the sticky bars.
    const disclaimer = document.querySelector('.tb-disclaimer-banner');
    if (disclaimer && disclaimer.parentNode) {
      disclaimer.parentNode.insertBefore(banner, disclaimer.nextSibling);
    } else if (document.body.firstChild) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.body.appendChild(banner);
    }
  }

  function removeBanner() {
    const b = document.querySelector('.tb-update-banner');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  // ─── Consent prompt ────────────────────────────────────────────────
  // Shown once per browser, on the first launch where the user
  // actually has TB.state available (so not before onboarding paint).
  // Uses the same .tb-modal-backdrop / .tb-modal classes as
  // about-overlays.js for visual consistency.
  function showConsentPrompt() {
    // Don't stack multiple consent modals.
    if (document.querySelector('.tb-update-consent-modal')) return;

    let root = document.getElementById('tb-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tb-modal-root';
      document.body.appendChild(root);
    }

    const backdrop = document.createElement('div');
    backdrop.className = 'tb-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'tb-modal tb-update-consent-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.style.maxWidth = '540px';

    function close() { root.innerHTML = ''; }

    modal.innerHTML =
      '<h2 style="margin-top:0">' + t('updateCheck.consent.title') + '</h2>' +
      '<p>' + t('updateCheck.consent.body') + '</p>' +
      '<ul style="margin:12px 0 16px 18px; padding:0; line-height:1.55">' +
        '<li>' + t('updateCheck.consent.bullet1') + '</li>' +
        '<li>' + t('updateCheck.consent.bullet2') + '</li>' +
        '<li>' + t('updateCheck.consent.bullet3') + '</li>' +
      '</ul>' +
      '<div class="tb-btn-row" style="justify-content:flex-end; gap:10px; flex-wrap:wrap">' +
        '<button type="button" class="tb-btn tb-btn--ghost" data-act="later">' +
          t('updateCheck.consent.later') + '</button>' +
        '<button type="button" class="tb-btn tb-btn--secondary" data-act="no">' +
          t('updateCheck.consent.no') + '</button>' +
        '<button type="button" class="tb-btn" data-act="yes">' +
          t('updateCheck.consent.yes') + '</button>' +
      '</div>';

    modal.querySelector('[data-act="yes"]').addEventListener('click', function () {
      patchState({ consented: true, enabled: true });
      close();
      // Kick off an immediate check now that they've opted in, so
      // they see the value of the feature on the same launch.
      runAutoCheck(true);
    });
    modal.querySelector('[data-act="no"]').addEventListener('click', function () {
      patchState({ consented: true, enabled: false });
      close();
    });
    modal.querySelector('[data-act="later"]').addEventListener('click', function () {
      // Leave consented unset so we re-prompt on the next launch.
      close();
    });

    backdrop.appendChild(modal);
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Public API ────────────────────────────────────────────────────
  // Manual "Check now" — bypasses the 24h throttle. Used by the
  // Settings card button. Returns a promise that resolves with the
  // payload (or rejects). Surfaces the banner if newer.
  function checkNow() {
    return loadPayload().then(function (payload) {
      patchState({
        lastCheckedAt: new Date().toISOString(),
        lastSeenVersion: payload.stable,
        lastError: null,
      });
      const local = getLocalVersion();
      if (isNewer(payload.stable, local)) {
        // A manual check should always re-show the banner, even if
        // the user dismissed it earlier — they asked for this on
        // purpose by clicking the button.
        removeBanner();
        patchState({ dismissedVersion: null });
        paintBanner(payload);
      }
      return payload;
    }).catch(function (err) {
      patchState({ lastError: String(err && err.message || err) });
      throw err;
    });
  }

  // Automatic check on launch — gated by consent, toggle, throttle,
  // and the hosted-demo skip. silent=true on the post-consent
  // immediate check.
  function runAutoCheck(silent) {
    if (isHostedDemo()) return;
    const state = getState();
    if (!state.consented || !state.enabled) return;
    if (!silent && state.lastCheckedAt) {
      const last = Date.parse(state.lastCheckedAt);
      if (!isNaN(last) && Date.now() - last < AUTO_CHECK_INTERVAL_MS) return;
    }
    loadPayload().then(function (payload) {
      patchState({
        lastCheckedAt: new Date().toISOString(),
        lastSeenVersion: payload.stable,
        lastError: null,
      });
      const local = getLocalVersion();
      if (isNewer(payload.stable, local)) paintBanner(payload);
    }).catch(function (err) {
      // Auto-checks fail silently — no banner, no toast. The error
      // is recorded in state so Settings can show "last check
      // failed" if helpful, but we don't bother the user mid-task.
      patchState({ lastError: String(err && err.message || err) });
    });
  }

  // Re-paint the banner if there's a known newer version sitting in
  // state that the user hasn't dismissed — useful when navigating
  // between modules since the banner is inline, not sticky.
  function repaintIfPending() {
    if (isHostedDemo()) return;
    const state = getState();
    const seen = state.lastSeenVersion;
    if (!seen) return;
    if (state.dismissedVersion === seen) return;
    const local = getLocalVersion();
    if (!isNewer(seen, local)) return;
    if (document.querySelector('.tb-update-banner')) return;
    // Paint a minimal banner from cached state — we don't have the
    // full payload here, so url falls back to /releases/latest.
    paintBanner({
      stable: seen,
      date: state.lastSeenDate || '',
      url: RELEASES_URL,
    });
  }

  // ─── Boot ──────────────────────────────────────────────────────────
  function boot() {
    if (isHostedDemo()) return;
    // Delay slightly so onboarding/setup screens finish painting
    // first — consent modal on a blank app feels jarring.
    setTimeout(function () {
      const state = getState();
      if (state.consented === undefined || state.consented === null) {
        // Only prompt once the user has the app running for ~3s,
        // and only if they've at least cracked the door open
        // (onboarding done, or sample data loaded).
        const ob = (TB.state && TB.state.get('onboarding')) || {};
        const hasData = !!(ob.complete);
        if (hasData) showConsentPrompt();
        // If not, we wait — next launch (post-onboarding) will catch them.
      } else if (state.consented && state.enabled) {
        runAutoCheck(false);
      }
      // Even if disabled, re-paint a previously-found-and-not-
      // dismissed banner so module navigation doesn't lose it.
      repaintIfPending();
    }, 2500);
  }

  // ─── Expose + wire boot ────────────────────────────────────────────
  window.TB = window.TB || {};
  window.TB.updateCheck = {
    checkNow: checkNow,
    isNewer: isNewer,
    getState: getState,
    // Internal hooks settings.js uses.
    _showConsentPrompt: showConsentPrompt,
    _repaintIfPending: repaintIfPending,
    _getLocalVersion: getLocalVersion,
    _RELEASES_URL: RELEASES_URL,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
