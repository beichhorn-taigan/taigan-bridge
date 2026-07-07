/* Taigan Bridge — schema.js
 *
 * Canonical state-path and record-field names, in ONE place.
 *
 * Why this file exists: the 2026-07 code review found a whole class of
 * silent bugs where one module read a state path or record field that
 * another module never writes — search indexing `fbar.years` (dropped
 * in the v1→v2 migration), Contacts reading `family.members[].name`
 * (the real fields are `name_en`/`name_jp`), the net-worth wizard
 * checking `balance_updated_at` (never written; the field is
 * `updated_at`), Action Center reading `projections.startYear` (never
 * written). Each failed invisibly behind a try/catch. Centralizing the
 * canonical names here — and asserting them against DEFAULT_STATE in
 * tools/test-paths.js — turns that class of drift into a failing test
 * instead of a dead feature.
 *
 * These MUST match state.js DEFAULT_STATE (containers) and the record
 * shapes the owning modules actually write. When a schema changes,
 * change it here in the same commit; the path test will catch a miss.
 *
 * Load order: right after constants.js, before state.js — pure data,
 * no dependencies. Attaches to TB.schema.
 */
(function () {
  'use strict';
  window.TB = window.TB || {};

  // Cross-module container paths (dotted, for TB.state.get/set). Every
  // value here must resolve to a declared container in DEFAULT_STATE —
  // tools/test-paths.js asserts exactly that.
  const PATHS = {
    // Onboarding / routing
    onboarding: 'onboarding',
    onboardingAnswers: 'onboarding.answers',
    onboardingComplete: 'onboarding.complete',
    tracks: 'tracks',
    modulesUnlocked: 'modules.unlocked',
    profile: 'profile',

    // FBAR (normalized tables — see docs/ARCHITECTURE.md)
    fbarFilers: 'fbar.filers',
    fbarAccounts: 'fbar.accounts',
    fbarYearlyBalances: 'fbar.yearly_balances',
    fbarFilingHistory: 'fbar.filing_history',

    // Assets / net worth
    assetsAccounts: 'assets.accounts',
    assetsSnapshots: 'assets.snapshots',
    netWorthReviews: 'net_worth.reviews',
    netWorthReports: 'net_worth.annual_reports',   // NOT 'net_worth.reports'

    // Projections
    projectionsInputs: 'projections.inputs',

    // Family
    familyMembers: 'family.members',
    familyGiftsLog: 'family.gifts_log',            // NOT 'family.gifts'
    familyRenunciation: 'family.renunciation',

    // Document vault
    documentVaultItems: 'documentVault.items',     // NOT 'documents'

    // Consultations
    consultationsProfessionals: 'consultations.professionals',
    consultationsConsultations: 'consultations.consultations',

    // Settings
    settingsApiKey: 'settings.apiKey',
    settingsModel: 'settings.model',
    settingsLanguage: 'settings.language',
  };

  // Canonical record field names, grouped by record type. Reference
  // these at read sites (e.g. the ⌘K search indexers, Contacts
  // auto-derivation) instead of hand-typing field names that drift.
  const FIELDS = {
    fbarAccount: { institution: 'institution_name', country: 'country' },
    fbarBalance: { year: 'year', usd: 'max_balance_usd' },
    assetAccount: { updatedAt: 'updated_at', country: 'country', active: 'active' },
    assetSnapshot: { takenAt: 'taken_at', totalUsd: 'total_usd' },
    familyMember: { nameEn: 'name_en', nameJp: 'name_jp', citizenships: 'citizenships' },
    familyGift: { recipientId: 'recipient_id', year: 'year' },
    documentVaultItem: { expiry: 'expiry_date' },
    consultationProfessional: { name: 'name' },
  };

  // Every PATHS value must resolve to a non-undefined container via
  // TB.state.get(). Used by tools/test-paths.js.
  function containerPaths() {
    return Object.values(PATHS);
  }

  TB.schema = { PATHS, FIELDS, containerPaths };
})();
