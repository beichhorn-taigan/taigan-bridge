/* Taigan Bridge — icons.js  (v0.34.0)
 *
 * Inline SVG icon set for every module + a few common UI accents.
 *
 * Why SVG and not emoji:
 *   • Several emojis we relied on render as dark unreadable blobs in
 *     Segoe UI Emoji on Windows (🗂 card-index, 🏘 houses, 🪦 headstone,
 *     🪖 helmet, the 👨‍👩‍👧 family ZWJ sequence). Cross-platform
 *     consistency was poor, and the icons didn't communicate their
 *     module's purpose at glance sizes.
 *   • SVG renders identically everywhere, can adopt theme colors via
 *     currentColor + var(--tb-accent), and ties visually to the
 *     torii-bridge brand mark (same 1.6-2px stroke vocabulary,
 *     vermillion accent on one distinguishing detail per icon).
 *
 * Visual language for the set:
 *   • viewBox 24 × 24
 *   • Line art (fill="none") with currentColor strokes (theme-aware)
 *   • Stroke 1.6 — 2.0 depending on detail density
 *   • Rounded line caps + joins
 *   • One vermillion accent per icon — the "tell" that identifies it
 *     at a glance: a checkmark for tax, a flag dot for FBAR, a key
 *     tooth for property, a heartbeat for healthcare, etc.
 *
 * Public API:
 *   TB.icons.get(moduleId, opts?)  → returns a fresh SVGElement node
 *     opts.size  — pixel size (default 24)
 *     opts.title — optional <title> for screen readers + tooltip
 *   TB.icons.has(moduleId) → boolean
 *   TB.icons.list()        → array of supported ids
 */

(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Each icon as an SVG body string (children of <svg>). The wrapping
  // <svg> element is added in get() with consistent attrs.
  //
  // Convention inside each body:
  //   • Primary strokes carry no explicit color (inherit currentColor)
  //   • Accent details use stroke="var(--tb-accent)" (or fill for dots)
  //   • Stroke widths between 1.5 and 2.2 depending on detail density
  const ICONS = {
    // ── Tax & Compliance ───────────────────────────────────────────
    // Calendar grid with a checkmark — "year-round filing calendar
    // with form-application detection."
    'tax-coordinator':
      '<rect x="3" y="5" width="18" height="16" rx="2" stroke-width="1.6"/>' +
      '<path d="M3 10h18" stroke-width="1.6"/>' +
      '<path d="M8 3v4M16 3v4" stroke-width="1.6"/>' +
      '<path d="M7.5 15l2.2 2.2 5-5" stroke="var(--tb-accent)" stroke-width="2.1"/>',

    // Bank columns with a flag dot — "foreign account reporting."
    fbar:
      '<path d="M3 21h18" stroke-width="1.6"/>' +
      '<path d="M3 10h18" stroke-width="1.6"/>' +
      '<path d="M3 10l9-6 9 6" stroke-width="1.6"/>' +
      '<path d="M6 21V10M10 21V10M14 21V10M18 21V10" stroke-width="1.6"/>' +
      '<circle cx="12" cy="7" r="1.6" fill="var(--tb-accent)" stroke="none"/>',

    // Folder with combination lock — "document inventory + storage."
    'document-vault':
      '<path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke-width="1.6"/>' +
      '<circle cx="12" cy="14" r="2.6" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M12 14v2.3" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // ── Wealth & Planning ──────────────────────────────────────────
    // Briefcase with a tiny upward chart inside — "all accounts."
    assets:
      '<rect x="3" y="7" width="18" height="13" rx="1.8" stroke-width="1.6"/>' +
      '<path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" stroke-width="1.6"/>' +
      '<polyline points="6,16 10,12 13,14 18,9" stroke="var(--tb-accent)" stroke-width="1.7" fill="none"/>',

    // Line chart climbing with apex dot — "net worth over time."
    'net-worth':
      '<line x1="3" y1="20" x2="21" y2="20" stroke-width="1.6"/>' +
      '<line x1="3" y1="20" x2="3" y2="4" stroke-width="1.6"/>' +
      '<polyline points="5,17 9,13 13,15 18,7" stroke-width="1.7" fill="none"/>' +
      '<circle cx="18" cy="7" r="2" fill="var(--tb-accent)" stroke="none"/>',

    // Branching forward arrows — "scenario projections."
    projections:
      '<path d="M3 12h6" stroke-width="1.6"/>' +
      '<path d="M9 12l4-5M9 12l4 5" stroke-width="1.6"/>' +
      '<path d="M13 7h6M13 17h6" stroke-width="1.6"/>' +
      '<path d="M17 5l2 2-2 2" stroke-width="1.6"/>' +
      '<path d="M17 15l2 2-2 2" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // Two currency symbols with exchange arrows — "FX & cross-border."
    'fx-banking':
      '<text x="3.5" y="10.5" font-size="10" font-weight="700" font-family="Georgia, serif" stroke="none" fill="currentColor">$</text>' +
      '<text x="14" y="20.5" font-size="10" font-weight="700" font-family="Georgia, serif" stroke="none" fill="var(--tb-accent)">¥</text>' +
      '<path d="M11 7h7l-2-2M13 17H6l2 2" stroke-width="1.6"/>',

    // Sun + horizon line with ground tick marks — "retirement decumulation."
    decumulation:
      '<circle cx="12" cy="10" r="3.6" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<line x1="3" y1="17" x2="21" y2="17" stroke-width="1.6"/>' +
      '<path d="M12 3.5v1.5M12 15v1.2M3.5 10h1.5M19 10h1.5M5.6 4l1 1M17.4 4l-1 1" stroke-width="1.6"/>',

    // ── Family & Life Events ───────────────────────────────────────
    // Two head-and-shoulder silhouettes (adult + child) — no ZWJ.
    family:
      '<circle cx="8" cy="7" r="2.6" stroke-width="1.6"/>' +
      '<path d="M3 20v-1.5a4.5 4.5 0 0 1 4.5-4.5h1a4.5 4.5 0 0 1 4.5 4.5V20" stroke-width="1.6"/>' +
      '<circle cx="17" cy="10" r="2" stroke="var(--tb-accent)" stroke-width="1.6"/>' +
      '<path d="M13.5 20v-1.5a3 3 0 0 1 3-3h1a3 3 0 0 1 3 3V20" stroke="var(--tb-accent)" stroke-width="1.6"/>',

    // Document scroll with a branching lineage tree — "succession / wills."
    estate:
      '<rect x="5" y="3" width="14" height="18" rx="1.5" stroke-width="1.6"/>' +
      '<line x1="8" y1="7" x2="16" y2="7" stroke-width="1.6"/>' +
      '<line x1="8" y1="10" x2="16" y2="10" stroke-width="1.6"/>' +
      '<path d="M12 13v3M8.5 18.5h7" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M9 16h6" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M8.5 18.5l-0.5 1.5M15.5 18.5l0.5 1.5M12 18.5v1.5" stroke="var(--tb-accent)" stroke-width="1.5"/>',

    // Medical cross with heartbeat trace — "healthcare + insurance."
    healthcare:
      '<rect x="9" y="3" width="6" height="18" rx="1.2" stroke-width="1.6"/>' +
      '<rect x="3" y="9" width="18" height="6" rx="1.2" stroke-width="1.6"/>' +
      '<polyline points="3,12 7,12 9,9 11,15 13,11 21,11" stroke="var(--tb-accent)" stroke-width="1.7" fill="none"/>',

    // Stethoscope-style curve + heart drop — "health records / tracker."
    // Distinct from healthcare's cross-and-heartbeat: this one is for
    // records-keeping, so we lead with the diagnostic instrument feel.
    'health-tracker':
      '<path d="M5 4v6a4 4 0 0 0 8 0V4" stroke-width="1.7"/>' +
      '<path d="M5 4h2M11 4h2" stroke-width="1.7"/>' +
      '<path d="M9 14v2a4 4 0 0 0 4 4h0a4 4 0 0 0 4-4v-2" stroke-width="1.7"/>' +
      '<circle cx="17" cy="11" r="2.2" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M17 9v4M15 11h4" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // ── Status-Specific ────────────────────────────────────────────
    // Clock with a forward-arrow conversion arc — "Roth sequencing."
    'sofa-roth':
      '<circle cx="12" cy="13" r="7" stroke-width="1.6"/>' +
      '<polyline points="12,9 12,13 15,15" stroke-width="1.7"/>' +
      '<path d="M17 4a6 6 0 0 1 4 4" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M21 4v4h-4" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // 5-point star with a small ribbon at the bottom — "veteran service."
    veteran:
      '<polygon points="12,3 14,8.5 20,9.2 15.5,13 17,19 12,16 7,19 8.5,13 4,9.2 10,8.5" stroke-width="1.6"/>' +
      '<path d="M9.5 16l-1.5 4 4-2 4 2-1.5-4" stroke="var(--tb-accent)" stroke-width="1.7" fill="none"/>',

    // House with a small year-counter tag at the door — "long-term resident."
    resident:
      '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" stroke-width="1.6"/>' +
      '<rect x="10" y="13" width="4" height="8" rx="0.6" stroke="var(--tb-accent)" stroke-width="1.6"/>' +
      '<line x1="10" y1="17" x2="14" y2="17" stroke="var(--tb-accent)" stroke-width="1.6"/>',

    // House with a key inside — "real estate ownership."
    property:
      '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" stroke-width="1.6"/>' +
      '<circle cx="14.5" cy="14.5" r="2" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M13 14.5h-3M10 14.5v1.6M11.5 14.5v1" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // ── AI & Tools ────────────────────────────────────────────────
    // Speech bubble with ninja-style eye slits (echoes the Taigan ninja
    // motif elsewhere in the app).
    'ask-taigan':
      '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5l-5 3v-3H6a2 2 0 0 1-2-2z" stroke-width="1.6"/>' +
      '<path d="M7 10.5h3.5M13.5 10.5H17" stroke="var(--tb-accent)" stroke-width="2.2" stroke-linecap="round"/>',

    // Clipboard with two stacked person icons — "consultation log."
    consultations:
      '<rect x="5" y="4" width="14" height="17" rx="1.5" stroke-width="1.6"/>' +
      '<rect x="9" y="2" width="6" height="3" rx="0.6" stroke-width="1.6"/>' +
      '<circle cx="9.5" cy="11" r="1.4" stroke="var(--tb-accent)" stroke-width="1.5"/>' +
      '<path d="M7 16v-0.5a2.5 2.5 0 0 1 5 0V16" stroke="var(--tb-accent)" stroke-width="1.5"/>' +
      '<circle cx="14.5" cy="11" r="1.2" stroke-width="1.5"/>' +
      '<path d="M12.5 16v-0.5a2 2 0 0 1 4 0V16" stroke-width="1.5"/>',

    // Two nodes linked by a dashed bridge — "sharing & backup."
    'sharing-backup':
      '<circle cx="6" cy="6" r="2.5" stroke-width="1.6"/>' +
      '<circle cx="18" cy="6" r="2.5" stroke-width="1.6"/>' +
      '<circle cx="12" cy="19" r="2.5" stroke-width="1.6"/>' +
      '<path d="M6 8.5L11 16.5M18 8.5L13 16.5" stroke-width="1.6"/>' +
      '<path d="M8.5 6h7" stroke="var(--tb-accent)" stroke-width="1.7" stroke-dasharray="2 2.5"/>',

    // ── Core (profile, settings, action-center, etc.) ─────────────
    profile:
      '<circle cx="12" cy="8" r="3.5" stroke-width="1.6"/>' +
      '<path d="M4 21v-1.5a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6V21" stroke-width="1.6"/>' +
      '<circle cx="18" cy="6" r="1.4" fill="var(--tb-accent)" stroke="none"/>',

    settings:
      '<path d="M12 3l1.2 2.5 2.7-.4 1 2.6 2.4 1.3-1 2.6 1.3 2.4-2.4 1.3-1 2.6-2.7-.4L12 21l-1.2-2.5-2.7.4-1-2.6-2.4-1.3 1-2.6-1.3-2.4 2.4-1.3 1-2.6 2.7.4z" stroke-width="1.5"/>' +
      '<circle cx="12" cy="12" r="2.8" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    'action-center':
      '<path d="M12 3l1.8 5.5h5.7l-4.6 3.4 1.8 5.5L12 14l-4.7 3.4 1.8-5.5L4.5 8.5h5.7z" stroke-width="1.6"/>' +
      '<circle cx="12" cy="11" r="1.8" fill="var(--tb-accent)" stroke="none"/>',

    about:
      '<circle cx="12" cy="12" r="9" stroke-width="1.6"/>' +
      '<path d="M12 8v0.5M12 11v5" stroke="var(--tb-accent)" stroke-width="2.1" stroke-linecap="round"/>',

    // ── Header UI icons (search, print, view-mode, theme) ─────────
    // Same visual language as the module icons: 24×24, line art,
    // 1.6-2.0 stroke, currentColor primary, vermillion accent on the
    // distinguishing detail. These replace the platform-fragile emojis
    // (🔍 🖨 👥 🌙) that render inconsistently in Segoe UI Emoji.

    // Magnifying glass with a vermillion lens highlight.
    'ui-search':
      '<circle cx="10.5" cy="10.5" r="6.5" stroke-width="1.7"/>' +
      '<line x1="15.5" y1="15.5" x2="20.5" y2="20.5" stroke-width="2.1"/>' +
      '<path d="M8 9a3 3 0 0 1 3-3" stroke="var(--tb-accent)" stroke-width="1.6"/>',

    // Printer with a vermillion "output sheet" coming out the front —
    // makes it instantly readable as "print" vs "fax" or "scanner."
    'ui-print':
      '<path d="M6 9V4h12v5" stroke-width="1.6"/>' +
      '<rect x="3" y="9" width="18" height="8" rx="1.5" stroke-width="1.6"/>' +
      '<rect x="6" y="13" width="12" height="7" rx="0.6" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<circle cx="17.5" cy="12" r="0.7" fill="currentColor" stroke="none"/>',

    // Single-person silhouette — user-perspective view mode.
    'ui-view-user':
      '<circle cx="12" cy="8" r="3.5" stroke-width="1.7"/>' +
      '<path d="M5 20v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1" stroke-width="1.7"/>',

    // Two overlapping silhouettes with vermillion accent on the
    // smaller (spouse) figure — spouse-perspective view mode.
    'ui-view-spouse':
      '<circle cx="9" cy="8" r="3" stroke-width="1.7"/>' +
      '<path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" stroke-width="1.7"/>' +
      '<circle cx="17" cy="10" r="2.4" stroke="var(--tb-accent)" stroke-width="1.7"/>' +
      '<path d="M13.5 20v-1a4 4 0 0 1 4-4h0a4 4 0 0 1 4 4v1" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // Sun for "switch to light mode" — vermillion sun rays.
    'ui-theme-light':
      '<circle cx="12" cy="12" r="4" stroke-width="1.7"/>' +
      '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" stroke="var(--tb-accent)" stroke-width="1.7"/>',

    // Crescent moon for "switch to dark mode" — vermillion star
    // alongside (small accent).
    'ui-theme-dark':
      '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" stroke-width="1.7"/>' +
      '<path d="M16 5l0.6 1.4L18 7l-1.4 0.6L16 9l-0.6-1.4L14 7l1.4-0.6z" stroke="var(--tb-accent)" stroke-width="1.4" fill="var(--tb-accent)"/>',
  };

  function get(moduleId, opts) {
    const body = ICONS[moduleId];
    if (!body) return null;
    opts = opts || {};
    const size = opts.size || 24;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', opts.title ? 'false' : 'true');
    svg.classList.add('tb-icon');
    svg.classList.add('tb-icon--' + moduleId);
    if (opts.title) {
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = opts.title;
      svg.appendChild(title);
    }
    // Inline-set the body. innerHTML works on SVG in modern browsers;
    // we already require ES2019+ throughout the app.
    svg.innerHTML = (svg.innerHTML || '') + body;
    return svg;
  }

  function has(moduleId) { return !!ICONS[moduleId]; }
  function list() { return Object.keys(ICONS); }

  window.TB = window.TB || {};
  window.TB.icons = { get };
})();
