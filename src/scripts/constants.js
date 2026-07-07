/* Taigan Bridge — constants.js
 *
 * SINGLE SOURCE OF TRUTH for time-decaying facts: dollar / yen figures,
 * penalty amounts, premiums, exclusion amounts, and statutory sunset
 * dates that change on a calendar and must be re-verified periodically.
 *
 * Why this file exists: the 2026-06-07 source-verification audit found
 * that every factual error in v1.0.0 was a hand-entered, time-decaying
 * number that had drifted (FX rates, FBAR penalties, Medicare premium,
 * gift sunset dates) — never the underlying legal reasoning. Centralizing
 * them here, each stamped with its issuing-authority source and the date
 * it was last verified, turns the next audit into a one-file diff.
 *
 * Every value has a matching row in docs/CLAIM-LEDGER.md with the full
 * audit trail and a "recheck by" date. When you change a value here,
 * update that ledger row in the same commit.
 *
 * Load order: this file loads BEFORE state.js and all modules, so
 * TB.constants is always available by the time anything reads it.
 *
 * Annual recheck batch: ~January 15 — Treasury year-end FX, the FinCEN
 * penalty inflation adjustment, and the prior-December Japan tax-reform
 * 大綱 outcomes all land within a couple of weeks of each other.
 */
(function () {
  'use strict';
  window.TB = window.TB || {};

  // ── Medicare ───────────────────────────────────────────────────────
  // CMS announces the standard Part B premium each November.
  const PART_B_PREMIUM_MONTHLY = 202.90; // 2026 — was $185.00 (2025), $174.70 (2024)

  // ── FBAR civil penalties — FinCEN inflation-adjusts these each January ─
  const FBAR_NONWILLFUL_MAX = 16536;  // up to, per REPORT (Bittner 2023), not per account
  const FBAR_WILLFUL_MIN    = 165353; // willful = greater of this OR 50% of the balance

  // ── Foreign Earned Income Exclusion — IRS announces each fall ───────
  const FEIE = { '2024': 126500, '2025': 130000, '2026': 132900 }; // IRS inflation adj.; recheck Nov 2026 for the 2027 figure

  // ── Japan gift-tax lump-sum vehicle sunset dates ───────────────────
  const GIFT_SUNSET = {
    // 教育資金一括贈与 — FY2026 (令和8年度) reform did NOT extend. Closed to
    // NEW contributions after this date; funds contributed by then remain
    // covered under the existing rules.
    education: '2026-03-31',
    // 結婚・子育て資金一括贈与 — extended two years by the FY2025 reform.
    marriageChildrearing: '2027-03-31',
  };

  // ── Treasury year-end Reporting Rates of Exchange (FBAR) ────────────
  // The app auto-fetches the official rates from the Fiscal Data API when
  // the FBAR module opens; this table is the OFFLINE FALLBACK only.
  // JPY is the exact official rate for every year. 2025 is FULLY official
  // (all currencies — re-pulled from the API; matches the TaiganJP
  // fbar-calculator); 2024 has EUR/KRW/CAD fixed. Earlier years' non-JPY
  // are close approximations until the live fetch replaces them. Verified
  // vs the Fiscal Data API on 2026-06-07 (JPY + 2024) and 2026-06-25 (full
  // 2025 set).
  const TREASURY_FX_FALLBACK = {
    '2019': { JPY: 108.53, EUR: 0.890, GBP: 0.755, CAD: 1.299, AUD: 1.425, CHF: 0.969, SGD: 1.347, HKD: 7.788, KRW: 1156.4, CNY: 6.962, NZD: 1.486, THB: 29.97, MXN: 18.880, BRL: 4.020, NOK: 8.78 },
    '2020': { JPY: 103.08, EUR: 0.815, GBP: 0.731, CAD: 1.272, AUD: 1.293, CHF: 0.884, SGD: 1.322, HKD: 7.752, KRW: 1086.3, CNY: 6.527, NZD: 1.388, THB: 30.04, MXN: 19.910, BRL: 5.197, NOK: 8.55 },
    '2021': { JPY: 115.04, EUR: 0.882, GBP: 0.741, CAD: 1.263, AUD: 1.376, CHF: 0.911, SGD: 1.350, HKD: 7.798, KRW: 1188.0, CNY: 6.366, NZD: 1.464, THB: 33.42, MXN: 20.510, BRL: 5.581, NOK: 8.83 },
    '2022': { JPY: 131.83, EUR: 0.938, GBP: 0.829, CAD: 1.355, AUD: 1.471, CHF: 0.926, SGD: 1.341, HKD: 7.806, KRW: 1267.3, CNY: 6.898, NZD: 1.575, THB: 34.61, MXN: 19.360, BRL: 5.286, NOK: 9.85 },
    '2023': { JPY: 141.47, EUR: 0.905, GBP: 0.785, CAD: 1.323, AUD: 1.467, CHF: 0.842, SGD: 1.320, HKD: 7.812, KRW: 1289.2, CNY: 7.099, NZD: 1.581, THB: 34.10, MXN: 16.920, BRL: 4.846, NOK: 10.17 },
    '2024': { JPY: 156.85, EUR: 0.961, GBP: 0.799, CAD: 1.438, AUD: 1.617, CHF: 0.907, SGD: 1.365, HKD: 7.768, KRW: 1473.27, CNY: 7.299, NZD: 1.789, THB: 34.10, MXN: 20.830, BRL: 6.187, NOK: 10.56 },
    '2025': { JPY: 156.61, EUR: 0.851, GBP: 0.743, CAD: 1.369, AUD: 1.495, CHF: 0.792, SGD: 1.285, HKD: 7.784, KRW: 1443.75, CNY: 6.998, NZD: 1.733, THB: 31.66, MXN: 17.956, BRL: 5.477, NOK: 10.072 },
  };

  // ── Provenance: issuing-authority source + last-verified + recheck ──
  // Mirrors docs/CLAIM-LEDGER.md. Surfaced nowhere in the UI today, but
  // kept beside the values so the audit trail travels with the code.
  const SOURCES = {
    PART_B_PREMIUM_MONTHLY: { src: 'https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles', verified: '2026-06-07', recheck: '2026-11-30' },
    FBAR_NONWILLFUL_MAX:    { src: '31 CFR 1010.821; Bittner v. US, 598 U.S. 85 (2023)', verified: '2026-06-07', recheck: '2027-01-31' },
    FBAR_WILLFUL_MIN:       { src: '31 CFR 1010.821', verified: '2026-06-07', recheck: '2027-01-31' },
    FEIE:                   { src: 'https://www.irs.gov/individuals/international-taxpayers/foreign-earned-income-exclusion', verified: '2026-06-07', recheck: '2026-11-30' },
    GIFT_SUNSET:            { src: 'https://www.nta.go.jp/ ; https://www.mof.go.jp/tax_policy/tax_reform/ ; https://www.cfa.go.jp/policies/shoushika/zouyozei', verified: '2026-06-07', recheck: '2026-12-31' },
    TREASURY_FX_FALLBACK:   { src: 'https://fiscaldata.treasury.gov/datasets/treasury-reporting-rates-exchange/', verified: '2026-06-07', recheck: '2027-01-15' },
  };

  TB.constants = {
    PART_B_PREMIUM_MONTHLY: PART_B_PREMIUM_MONTHLY,
    FBAR_NONWILLFUL_MAX: FBAR_NONWILLFUL_MAX,
    FBAR_WILLFUL_MIN: FBAR_WILLFUL_MIN,
    FEIE: FEIE,
    GIFT_SUNSET: GIFT_SUNSET,
    TREASURY_FX_FALLBACK: TREASURY_FX_FALLBACK,
    sources: SOURCES,
    meta: {
      lastFullVerification: '2026-06-07',
      nextRequiredVerification: '2027-01-15',
      ledger: 'docs/CLAIM-LEDGER.md',
    },
  };
})();
