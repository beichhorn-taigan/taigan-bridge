/* Taigan Bridge — tracks.js
 *
 * Pure track-assignment logic. Given the onboarding answers object,
 * returns { tracks: string[], modules: string[] }.
 *
 * Tracks:
 *   - sofa      — SOFA-status (active duty, DoD civ, DoD contractor) and
 *                 has not yet registered 住民票 in their current cycle.
 *   - veteran   — past US military service (any branch).
 *   - resident  — Japan tax resident (non-SOFA expats / long-term).
 *   - family    — Japanese-national spouse and/or dual-citizen children.
 *   - property  — owns or expects to inherit Japanese real estate.
 *
 * Modules unlocked:
 *   - core: profile, settings (always)
 *   - core: fbar, assets, document-vault (always — every US person in
 *           Japan likely has FBAR exposure)
 *   - sofa-roth (only if sofa track active)
 *   - veteran (only if veteran track active)
 */

(function () {
  'use strict';

  const ALWAYS_MODULES = ['profile', 'fbar', 'assets', 'document-vault', 'tax-coordinator', 'estate', 'net-worth', 'healthcare', 'health-tracker', 'fx-banking', 'decumulation', 'ask-taigan', 'sharing-backup', 'consultations', 'settings'];

  function arr(v) {
    if (Array.isArray(v)) return v;
    if (v == null || v === '') return [];
    return [v];
  }

  function assign(answers) {
    answers = answers || {};
    const tracks = new Set();
    const modules = new Set(ALWAYS_MODULES);

    const employment = answers.employment;          // string
    const visa = answers.visa;                       // string
    const juminhyo = answers.juminhyo;               // 'yes' | 'no' | 'unsure'
    const veteran = answers.veteran;                 // 'no' | 'active' | 'reserve_ng' | 'retired' | 'separated_no_dis' | 'separated_with_dis'
    const yearsInJapan = answers.years_in_japan;    // string range
    const taxStatus = answers.tax_status;            // string
    const family = arr(answers.family);              // multi
    const realEstate = answers.real_estate;          // 'yes' | 'no' | 'expected'

    // ----- SOFA track ---------------------------------------------
    // SOFA status if employment indicates DoD active/civ/contractor AND
    // visa indicates SOFA OR juminhyo not yet registered.
    const sofaEmployment = employment === 'dod_active' ||
                           employment === 'dod_civilian' ||
                           employment === 'dod_contractor';
    const sofaVisa = visa === 'sofa';
    if (sofaEmployment && (sofaVisa || juminhyo === 'no')) {
      tracks.add('sofa');
      modules.add('sofa-roth');
    }

    // ----- Veteran track ------------------------------------------
    // Any non-"no" status unlocks the Veteran module. The module
    // itself filters which sections appear based on the specific
    // status (e.g., TRICARE Retired only shows for 'retired').
    if (veteran && veteran !== 'no') {
      tracks.add('veteran');
      modules.add('veteran');
    }
    // Back-compat: pre-v0.14 the answer was 'yes' | 'no'.
    if (veteran === 'yes') {
      tracks.add('veteran');
      modules.add('veteran');
    }

    // ----- Long-Term Resident track -------------------------------
    // Japan tax resident if NOT actively SOFA and either juminhyo
    // registered, tax_status indicates Japan filer, or 5+ years in
    // Japan. SOFA-status individuals — even those with 10+ years in
    // Japan as DoD contractors/civilians — are NOT JP tax residents.
    // Surfacing "Long-Term Resident" for them is misleading; they
    // can force-enable via Customize dashboard if they want to
    // explore the module (e.g., planning a SOFA→work-visa transition).
    const longResident =
      (taxStatus === 'japan_resident' || taxStatus === 'japan_filer') ||
      (juminhyo === 'yes' && !tracks.has('sofa')) ||
      ((yearsInJapan === '5_to_10' || yearsInJapan === 'over_10') && !tracks.has('sofa'));
    if (longResident) {
      tracks.add('resident');
      modules.add('resident');
    }

    // ----- Family track -------------------------------------------
    if (family.includes('jp_spouse') ||
        family.includes('dual_children') ||
        family.includes('jp_children')) {
      tracks.add('family');
      modules.add('family');
    }

    // ----- Property track -----------------------------------------
    if (realEstate === 'yes' || realEstate === 'expected') {
      tracks.add('property');
      modules.add('property');
    }

    // If nothing matched (e.g., user just visiting), default to a
    // "core" placeholder track so the dashboard renders sensibly.
    if (tracks.size === 0) tracks.add('core');

    return {
      tracks: Array.from(tracks),
      modules: Array.from(modules),
    };
  }

  function trackLabel(id, lang) {
    const labels = {
      en: {
        sofa: 'SOFA',
        veteran: 'Veteran',
        resident: 'Long-Term Resident',
        family: 'Family',
        property: 'Property',
        core: 'Core',
      },
      ja: {
        sofa: 'SOFA',
        veteran: '退役軍人',
        resident: '長期居住者',
        family: '家族',
        property: '不動産',
        core: '基本',
      },
    };
    return (labels[lang] || labels.en)[id] || id;
  }

  window.TB = window.TB || {};
  window.TB.tracks = { assign, trackLabel };
})();
