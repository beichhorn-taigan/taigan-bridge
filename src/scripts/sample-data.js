/* Taigan Bridge — sample-data.js
 *
 * Demo / evaluation mode. Builds a complete, plausible Taigan Bridge
 * state for a fictional household and loads it via TB.state.import(),
 * which routes through the same migration + persistence path as a
 * real backup restore.
 *
 * Two distinct profiles ship in the demo loader so prospective users
 * can pick the one closer to their own situation:
 *
 *   • 'sofa'     — SOFA contractor + JP spouse + dual-citizen children.
 *                  Surfaces the SOFA Roth Planner, Veteran module,
 *                  spouse-handles JP-side tax flow, PFIC trap.
 *   • 'resident' — Long-term Japan resident (work visa → permanent
 *                  resident), files own 確定申告, has NHI, no veteran
 *                  background, kid already out of household.
 *
 * IMPORTANT — DATA HYGIENE:
 * Every named entity in this file (clinic names, addresses, phone
 * numbers, CPA firms, doctor names) is a PLACEHOLDER. Real Japan
 * addresses, real clinic names, and real firm names have been
 * scrubbed in favor of obviously-fictional "Sample…" / "Demo…" /
 * placeholder-zip / "XXXX" phone formats. The author's own household
 * data is never reflected here.
 *
 * Loading is destructive — confirms with the user, then overwrites
 * existing state and reloads. A floating "DEMO DATA — not your real
 * records" banner appears at the top of the page after load.
 *
 * Public API:
 *   TB.sampleData.PROFILES                     — { id, label_en, label_jp, desc_en, desc_jp }[]
 *   TB.sampleData.buildSampleState(profileId)  — returns the state JSON (no I/O)
 *   TB.sampleData.loadInteractive()            — opens the profile-picker modal
 *   TB.sampleData.loadProfile(profileId)       — confirm + load + reload
 *   TB.sampleData.isDemoActive()               — true when demo data is loaded
 *   TB.sampleData.activeProfile()              — id of the loaded demo, or null
 *   TB.sampleData.exit()                       — wipes the demo + reloads
 */
(function () {
  'use strict';

  // ─── Profile catalog ──────────────────────────────────────────────
  const PROFILES = [
    {
      id: 'sofa',
      label_en: 'SOFA contractor household',
      label_jp: 'SOFA 契約者世帯',
      desc_en: 'DoD contractor in Tokyo, JP-national spouse, two dual-citizen children, ' +
               '20-year military retiree, planning to transition out of SOFA next year. ' +
               'Surfaces the SOFA Roth Planner, Veteran module, spouse-handles JP-side ' +
               'tax flow, and a PFIC trap from a JP iDeCo holding.',
      desc_jp: '東京の DoD 契約者、日本人配偶者、日米二重国籍の子2人、20 年勤続の退役軍人で、' +
               '来年 SOFA から離脱予定の世帯です。SOFA Roth プランナー・退役軍人モジュール・' +
               '配偶者が日本側を担当する税務フロー・iDeCo 保有による PFIC トラップを確認できます。',
    },
    {
      id: 'resident',
      label_en: 'Long-term resident household',
      label_jp: '長期居住者世帯',
      desc_en: 'US software engineer in Yokohama, 12 years in Japan, work visa converted to ' +
               'Permanent Resident, JP-national spouse, adult child already in the US. ' +
               'Files own 確定申告, enrolled in NHI, owns inherited JP home outright, ' +
               'no military background, approaching retirement.',
      desc_jp: '横浜在住の米国人ソフトウェアエンジニア、日本居住 12 年、就労ビザから永住者に切替済み。' +
               '日本人配偶者あり、成人した子は米国在住。確定申告は本人が行い、国民健康保険加入、' +
               '相続した日本の自宅をローンなしで所有、軍歴なし、退職が視野に入った世帯です。',
    },
    {
      id: 'retiree',
      label_en: 'Retired American in Japan',
      label_jp: '日本在住の米国人退職者',
      desc_en: 'Retired US engineer in Kamakura, age 73, 18 years in Japan, Permanent Resident. ' +
               'Drawing Social Security since FRA, taking RMDs from Traditional IRA, paid-off ' +
               'JP home, both US + JP wills executed. Surfaces Decumulation deeply (RMD + SS + ' +
               'JP pension), Medicare Part A enrolled / Part B declined, IRMAA tracking, and ' +
               'urgent Estate planning given the 10-year worldwide-asset clock.',
      desc_jp: '鎌倉在住の退職した米国人エンジニア、73 歳、日本居住 18 年、永住者。FRA から社会保障受給開始、' +
               'Traditional IRA で RMD 中、住宅ローン完済、日米両方の遺言執行済み。Decumulation モジュール' +
               '(RMD・SS・年金)、Medicare A 加入/B 辞退、IRMAA 追跡、10 年全世界資産時計に伴う緊急の相続計画を' +
               '確認できます。',
    },
    {
      id: 'active_mil',
      label_en: 'Active duty military, JP spouse',
      label_jp: '現役米軍 + 日本人配偶者',
      desc_en: 'Active duty US Army E-5 stationed in Japan, age 32, JP-national spouse, no ' +
               'children yet. Lives on base, modest assets, building wealth from scratch. ' +
               'Pre-住民票, considering future Roth conversion timing. Surfaces SOFA Roth ' +
               'Planner (active not transitioning), TRICARE active duty, no PFIC traps ' +
               '(deliberately empty JP investments), and the early-career planning angle.',
      desc_jp: '日本駐留の現役米陸軍 E-5、32 歳、日本人配偶者あり、子供はまだなし。基地内居住、' +
               '資産は控えめで蓄積中。住民票未登録、将来の Roth 変換タイミングを検討中。' +
               'SOFA Roth プランナー(現役・離脱前)・TRICARE 現役・PFIC リスクなし(意図的に日本投資なし)・' +
               'キャリア初期の資産形成という観点を確認できます。',
    },
  ];

  // ─── Shared helpers ───────────────────────────────────────────────
  function isoDateYearsAgo(years) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString().slice(0, 10);
  }
  function isoDateMonthsAhead(months) {
    const d = new Date();
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
  }
  function isoDateNow() { return new Date().toISOString(); }
  function uuid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  // ─── Profile A: SOFA contractor household ─────────────────────────
  function buildSofaProfile() {
    const now = isoDateNow();
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;

    // Clearly fictional names. "Sample-mura" + placeholder zip
    // 100-0000 + "03-XXXX-XXXX" phone format make the address /
    // phone obviously not real.
    const HH = {
      primary:  { name_en: 'Alex Sample',  name_jp: 'アレックス サンプル', birth_year: 1979 },
      spouse:   { name_en: 'Yuki Sample',  name_jp: 'サンプル 結希',       birth_year: 1981 },
      child1:   { name_en: 'Mia Sample',   name_jp: 'ミア サンプル',        birth_year: 2014 },
      child2:   { name_en: 'Ken Sample',   name_jp: 'サンプル 健',          birth_year: 2018 },
    };

    const idAlex = 'fam-alex', idYuki = 'fam-yuki', idMia = 'fam-mia', idKen = 'fam-ken';
    const acctSchwab    = 'acct-schwab-brokerage';
    const acctVanguard  = 'acct-vanguard-roth';
    const acctTsp       = 'acct-tsp';
    const acctHsa       = 'acct-hsa';
    const acctSony      = 'acct-sony-bank';
    const acctYokohama  = 'acct-yokohama-bank';
    const acctIdeco     = 'acct-ideco';

    return {
      version: 4,
      _demo: { loaded_at: now, profile: 'sofa',
        household: HH.primary.name_en + ' / ' + HH.spouse.name_en },
      profile: {
        displayName:   HH.primary.name_en,
        displayNameJa: HH.primary.name_jp,
      },
      onboarding: {
        complete: true, completedAt: now,
        answers: {
          display_name: HH.primary.name_en, display_name_ja: HH.primary.name_jp,
          birth_year: String(HH.primary.birth_year),
          biological_sex: 'male',
          citizenship: 'us_only',
          in_japan: 'yes', years_in_japan: '5_to_10',
          visa: 'sofa', employment: 'dod_contractor',
          veteran: 'retired', separation_date: isoDateYearsAgo(8),
          tax_status: 'sofa_no_file', non_sofa_jp_income: 'no',
          family: ['jp_spouse', 'dual_children'],
          real_estate: 'yes', real_estate_use: 'primary',
          jp_filing_responsibility: 'spouse',
          healthcare_coverage: ['tricare', 'private_intl'],
          retirement_horizon: '5_15y',
          fx_platforms: ['wise', 'sony_bank', 'broker'],
          ai_consent: 'per_call',
          consultations_history: 'cpa_us_intl',
          pfic_holdings: 'yes_some',
          dual_children_age_band: 'all_under_18',
          medicare_status: 'not_yet',
          renunciation_status: 'never',
        },
      },
      tracks: ['sofa', 'veteran', 'family', 'property'],
      modules: { unlocked: [] },

      assets: {
        accounts: [
          { id: acctSchwab, institution: 'Charles Schwab', name: 'Joint Brokerage',
            country: 'US', tax_wrapper: 'taxable_brokerage', currency: 'USD',
            balance_native: 285000, basis_native: 210000,
            notes: 'Long-term hold, broad-market index funds.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en + ' (POD)',
            account_number_last4: '0001',
            allocation: { equity_us: 0.7, equity_intl: 0.2, bond: 0.05, cash: 0.05, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctVanguard, institution: 'Vanguard', name: 'Roth IRA',
            country: 'US', tax_wrapper: 'roth_ira', currency: 'USD',
            balance_native: 142000, basis_native: null, notes: '',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en + ' (primary), kids (contingent)',
            account_number_last4: '0002',
            allocation: { equity_us: 0.8, equity_intl: 0.15, bond: 0.05, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctTsp, institution: 'Thrift Savings Plan', name: 'TSP — military',
            country: 'US', tax_wrapper: 'traditional_401k_tsp', currency: 'USD',
            balance_native: 318000, basis_native: null,
            notes: 'Held from 20-year service. Considering rollover.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '0003',
            allocation: { equity_us: 0.6, equity_intl: 0.3, bond: 0.1, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctHsa, institution: 'Fidelity', name: 'HSA',
            country: 'US', tax_wrapper: 'hsa', currency: 'USD',
            balance_native: 38500, basis_native: null,
            notes: 'Triple-tax-advantaged. Invested.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '0004',
            allocation: { equity_us: 0.9, equity_intl: 0, bond: 0.1, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctSony, institution: 'Sony Bank', name: '普通預金 (savings)',
            country: 'JP', tax_wrapper: 'jp_savings', currency: 'JPY',
            balance_native: 4_250_000, basis_native: null,
            notes: 'Household expenses + utilities.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '0005',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-acct-sony' },
          { id: acctYokohama, institution: '横浜銀行 (Yokohama Bank)', name: '普通預金',
            country: 'JP', tax_wrapper: 'jp_checking', currency: 'JPY',
            balance_native: 1_120_000, basis_native: null,
            notes: 'Joint emergency reserve.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '0006',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-acct-yokohama' },
          { id: acctIdeco, institution: '楽天証券 (Rakuten Securities)',
            name: 'iDeCo (個人型確定拠出年金)',
            country: 'JP', tax_wrapper: 'other', currency: 'JPY',
            balance_native: 880_000, basis_native: 700_000,
            notes: '⚠ PFIC under US tax law. Form 8621 obligation. Consult CPA.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '0007',
            allocation: { equity_us: 0, equity_intl: 0.7, bond: 0.3, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
        ],
        target_allocation: null,
        snapshots: [{
          id: uuid('snap'), taken_at: isoDateYearsAgo(1),
          label: lastYear + ' year-end',
          total_usd: 765000,
          allocation: { equity_us: 0.62, equity_intl: 0.18, bond: 0.08, cash: 0.12, real_estate: 0, alternative: 0 },
          accounts: [],
        }],
      },
      fbar: {
        filers: [{
          id: 'fbar-filer-alex', name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
          ssn_last4: '0001', dob: HH.primary.birth_year + '-04-15', relationship: 'self',
          isMinor: false, isUSPerson: true,
          filing_address: '1-1-1 Sample-machi, Sample-ku, Tokyo 100-0000, JAPAN',
          notes: '',
        }],
        accounts: [
          { id: 'fbar-acct-sony', filer_ids: ['fbar-filer-alex'],
            account_type: 'savings', institution_name: 'Sony Bank',
            institution_address: '1-1-1 Sample, Minato-ku, Tokyo, JAPAN',
            account_number_masked: '*******0005', account_number_full: 'DEMO000000005',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 6, closed_year: null,
            signatory_only: false, notes: 'Primary household JPY account.' },
          { id: 'fbar-acct-yokohama', filer_ids: ['fbar-filer-alex'],
            account_type: 'checking', institution_name: '横浜銀行 (Yokohama Bank)',
            institution_address: '1-1-1 Sample, Naka-ku, Yokohama, JAPAN',
            account_number_masked: '*******0006', account_number_full: 'DEMO000000006',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 5, closed_year: null,
            signatory_only: false, notes: '' },
        ],
        yearly_balances: [
          { id: uuid('fb-bal'), account_id: 'fbar-acct-sony',
            year: lastYear, max_balance_native: 5_200_000, max_balance_date: lastYear + '-07-15',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(5200000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-acct-yokohama',
            year: lastYear, max_balance_native: 1_650_000, max_balance_date: lastYear + '-06-30',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(1650000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-acct-sony',
            year: thisYear, max_balance_native: 4_900_000, max_balance_date: thisYear + '-03-10',
            fx_rate_used: 158.00, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(4900000 / 158.00), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-acct-yokohama',
            year: thisYear, max_balance_native: 1_280_000, max_balance_date: thisYear + '-02-20',
            fx_rate_used: 158.00, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(1280000 / 158.00), notes: '' },
        ],
        filing_history: [{
          id: uuid('fb-file'), filer_id: 'fbar-filer-alex', year: lastYear,
          filed_on: thisYear + '-04-10',
          bsa_id: 'BSA-' + lastYear + '-DEMO-0001',
          method: 'self-filed BSA E-Filing',
          notes: 'Filed early, well ahead of Apr 15 deadline.',
        }],
      },
      family: {
        members: [
          { id: idAlex, relationship: 'self',
            name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
            birth_date: HH.primary.birth_year + '-04-15',
            citizenships: ['US'], jp_resident: true, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '0001', expires: isoDateMonthsAhead(38), renewed_at: isoDateYearsAgo(2) },
            passport_jp: { number_last4: '', expires: null, renewed_at: null },
            nationality_choice_made: null, notes: '',
            created_at: now, updated_at: now },
          { id: idYuki, relationship: 'spouse',
            name_en: HH.spouse.name_en, name_jp: HH.spouse.name_jp,
            birth_date: HH.spouse.birth_year + '-09-02',
            citizenships: ['JP'], jp_resident: true, ssn_or_itin: 'itin',
            passport_us: { number_last4: '', expires: null, renewed_at: null },
            passport_jp: { number_last4: '0002', expires: isoDateMonthsAhead(22), renewed_at: isoDateYearsAgo(3) },
            nationality_choice_made: null, is_emergency_contact: true,
            notes: 'Files her own 確定申告, 住民税, ふるさと納税.',
            created_at: now, updated_at: now },
          { id: idMia, relationship: 'child',
            name_en: HH.child1.name_en, name_jp: HH.child1.name_jp,
            birth_date: HH.child1.birth_year + '-06-12',
            citizenships: ['US', 'JP'], jp_resident: true, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '0003', expires: isoDateMonthsAhead(9), renewed_at: isoDateYearsAgo(4) },
            passport_jp: { number_last4: '0004', expires: isoDateMonthsAhead(11), renewed_at: isoDateYearsAgo(4) },
            nationality_choice_made: null, notes: '',
            created_at: now, updated_at: now },
          { id: idKen, relationship: 'child',
            name_en: HH.child2.name_en, name_jp: HH.child2.name_jp,
            birth_date: HH.child2.birth_year + '-11-20',
            citizenships: ['US', 'JP'], jp_resident: true, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '0005', expires: isoDateMonthsAhead(28), renewed_at: isoDateYearsAgo(2) },
            passport_jp: { number_last4: '0006', expires: isoDateMonthsAhead(31), renewed_at: isoDateYearsAgo(2) },
            nationality_choice_made: null, notes: '',
            created_at: now, updated_at: now },
        ],
        renunciation: { contemplating: false, target_year: null,
          consultation_complete: false, estimated_net_worth_usd: null,
          estimated_avg_tax_5y_usd: null, notes: '' },
        gifts_log: [
          { id: uuid('gift'), year: lastYear, recipient_id: idMia, amount_jpy: 1_000_000,
            vehicle: '暦年贈与', notes: 'Annual 110万 within tax-free 暦年贈与.' },
          { id: uuid('gift'), year: lastYear, recipient_id: idKen, amount_jpy: 1_000_000,
            vehicle: '暦年贈与', notes: 'Annual 110万 within tax-free 暦年贈与.' },
        ],
      },
      veteran: {
        service: {
          branch: 'air_force', component: 'active',
          entry_date: (HH.primary.birth_year + 18) + '-07-01',
          discharge_date: isoDateYearsAgo(8),
          discharge_type: 'honorable',
          final_rank: 'TSgt (E-6)', mos_rating: '3D0X2 — Cyber Systems Operations',
          retired: true,
        },
        disability: {
          overall_rating_pct: 30, monthly_compensation_usd: 537,
          individual_unemployability: false,
          last_evaluation_date: isoDateYearsAgo(2),
          conditions: [
            { id: uuid('cond'), name: 'Tinnitus', rating_pct: 10, service_connected: true, effective_date: isoDateYearsAgo(8) },
            { id: uuid('cond'), name: 'Lumbar strain', rating_pct: 20, service_connected: true, effective_date: isoDateYearsAgo(8) },
          ],
        },
        healthcare: { tricare_eligible: true, tricare_plan: 'overseas', fmp_enrolled: true, chappy_17: false },
        education: { benefit_type: 'post_911', months_remaining: 12, expiration_date: null, transferred: true },
        survivor: { sgli_amount: null, vgli_amount: 400000 },
        dd214Stored: true, vaRating: 30,
        notes: 'Retired E-6 with 20 years service. SBP elected at full base.',
      },
      property: {
        properties: [
          { id: uuid('prop'),
            label: 'Tokyo condo (primary residence)',
            country: 'JP', currency: 'JPY', type: 'primary_residence',
            purchase_date: isoDateYearsAgo(4),
            purchase_price_native: 78_000_000, current_value_native: 92_000_000,
            address: '1-1-1 Sample-machi, Sample-ku, Tokyo 100-0000',
            square_meters: 82, structure_type: 'rc',
            mortgage_balance_native: 54_000_000, mortgage_rate_pct: 0.65, mortgage_remaining_years: 26,
            annual_property_tax_native: 165000, annual_city_tax_native: 22000,
            annual_insurance_native: 38000, monthly_maintenance_native: 28000,
            rental_status: null, monthly_rent_native: null, annual_rental_expenses_native: null,
            depreciation_started_year: null, depreciation_basis_native: null,
            planned_sale_year: null, lived_2_of_5_years: null,
            is_residential_for_inheritance: true,
            notes: '住宅ローン控除 active — 13-year remaining.',
            created_at: now },
          { id: uuid('prop'),
            label: 'Inherited US rental (Florida)',
            country: 'US', currency: 'USD', type: 'rental',
            purchase_date: isoDateYearsAgo(3),
            purchase_price_native: 0, current_value_native: 295000,
            address: '100 Sample St, Demo City, FL 00000',
            square_meters: null, structure_type: null,
            mortgage_balance_native: 0, mortgage_rate_pct: 0, mortgage_remaining_years: 0,
            annual_property_tax_native: 4200, annual_city_tax_native: 0,
            annual_insurance_native: 2800, monthly_maintenance_native: 0,
            rental_status: 'rented', monthly_rent_native: 2400, annual_rental_expenses_native: 8500,
            depreciation_started_year: thisYear - 3, depreciation_basis_native: 268000,
            planned_sale_year: null, lived_2_of_5_years: false,
            is_residential_for_inheritance: false,
            notes: 'Inherited from parent. Step-up basis. Managed by local property mgr.',
            created_at: now },
        ],
        preferences: { show_summary_currency: 'usd' },
      },
      resident: {
        residency: { arrival_date: isoDateYearsAgo(6), juminhyo_date: null,
          visa_status: null, permanent_residency: false, pr_application_filed: null },
        furusato: { prior_year_income_jpy: null, prior_year_dependents: 0, donations_planned_jpy: 0 },
        mortgage: { has_jp_mortgage: true, purchase_year: thisYear - 4,
          loan_balance_jpy: 54_000_000, loan_type: 'standard' },
        nhi: { enrolled: false, prior_year_assessment_jpy: null },
      },
      healthcare: {
        medicare: { enrolled_a: false, enrolled_b: false, enrolled_d: false,
          part_b_premium_monthly_usd: null, part_b_decision: null,
          part_b_decision_notes: '', irmaa_tier: null },
        ltc: { applies: false, care_level: null, monthly_premium_jpy: null, funding_strategy_notes: '' },
        end_of_life: { organ_donor_us: true, organ_donor_jp: true,
          dnr_preference: 'limited',
          funeral_preference_notes: 'Cremation preferred. Small family service in Tokyo.' },
        private: { type: 'cigna_intl', custom_name: '',
          monthly_premium_usd: 850, monthly_premium_jpy: null,
          employer_paid: 'fully',
          notes: 'Employer-paid international plan. Covers JP + global.' },
        monthly_budget: { nhi_jpy: null, shi_jpy: null,
          tricare_usd: 0, medicare_b_usd: null, medicare_d_usd: null,
          ltc_jpy: null, private_us_usd: 850, notes: '' },
        coverage_types: ['tricare', 'private_intl'],
      },
      health_tracker: {
        exams: [{
          id: uuid('exam'),
          date: isoDateMonthsAhead(-3).slice(0, 10),
          type: 'physical',
          provider: 'Dr. Sample Physician',
          facility: 'Sample Medical Clinic Tokyo',
          location: 'Tokyo',
          vitals: { weight_kg: 78.2, height_cm: 178, bp_systolic: 122, bp_diastolic: 78,
            heart_rate_bpm: 64, temp_c: 36.5, respiratory_rate: 14, spo2_pct: 98, bmi: 24.7 },
          lab_results: [
            { name: 'Total Cholesterol', value: 188, unit: 'mg/dL', range_low: 0, range_high: 200, flag: 'normal' },
            { name: 'LDL', value: 112, unit: 'mg/dL', range_low: 0, range_high: 100, flag: 'high' },
            { name: 'HDL', value: 52, unit: 'mg/dL', range_low: 40, range_high: 999, flag: 'normal' },
            { name: 'Fasting Glucose', value: 94, unit: 'mg/dL', range_low: 70, range_high: 99, flag: 'normal' },
            { name: 'HbA1c', value: 5.4, unit: '%', range_low: 0, range_high: 5.6, flag: 'normal' },
          ],
          diagnoses: ['Borderline LDL — diet + exercise watch'],
          procedures: ['CMP', 'Lipid panel', 'A1c'],
          followup: 'Recheck lipids in 6 months.',
          notes: 'Annual physical. Cleared for full activity.',
        }],
        medications: [{
          id: uuid('med'), name: 'Vitamin D3', generic_name: 'cholecalciferol',
          dosage: 2000, dosage_unit: 'IU', frequency: 'daily', route: 'oral',
          started_date: isoDateYearsAgo(2), ended_date: null,
          prescriber: 'OTC', pharmacy: '', refills_remaining: null, next_refill_date: null,
          purpose: 'Supplementation', side_effects: '', notes: '',
        }],
        care_plan: {
          primary_concerns: [],
          annual_goals: [{ id: uuid('goal'), text: 'Get LDL under 100 mg/dL by year-end',
            target_date: thisYear + '-12-31', status: 'active' }],
          preventive_screenings_due: [{ id: uuid('scr'), name: 'Colonoscopy',
            due_date: isoDateMonthsAhead(8), last_done: null,
            interval_years: 10, notes: 'First one, age 45+' }],
          specialist_referrals: [], next_appointments: [],
        },
        dental: {
          last_cleaning: isoDateMonthsAhead(-2).slice(0, 10),
          last_xrays: isoDateMonthsAhead(-2).slice(0, 10),
          last_perio: isoDateMonthsAhead(-2).slice(0, 10),
          dentist: 'Dr. Sample Dentist',
          clinic: 'Sample Dental Clinic',
          procedures: [{
            id: uuid('dp'), date: isoDateMonthsAhead(-2).slice(0, 10),
            type: 'cleaning', tooth_number: null,
            notes: 'Routine 3-month cleaning + scaling.',
            cost_native: 4500, currency: 'JPY',
          }],
          issues_tracked: [],
          providers: [{
            id: uuid('dprov'),
            name_en: 'Sample Dental Clinic',
            name_jp: 'サンプル歯科クリニック',
            type: 'dental',
            address: '1-1-1 Sample-machi, Sample-ku, Tokyo 100-0000',
            phone: '03-XXXX-XXXX',
            email: '', website: 'https://sample-dental.example.jp',
            hours: 'Mon-Fri 10:00-19:00 · Sat 9:00-13:00',
            notes: '', ai_enriched_at: null,
            created_at: now,
          }],
          appointments: [], notes_log: [], teeth: {},
          periodontal: { pockets_4mm_pct: 6, bleeding_on_probing_pct: 4, mobile_teeth: 0 },
        },
        insurance_summary: {
          primary_plan: 'TRICARE Select Overseas',
          member_id_last4: '0001',
          bin: '', pcp_name: '', pcp_phone: '',
          notes: 'Active duty retiree dependent coverage.',
          cards: [{
            id: uuid('card'), card_type: 'medical', label: 'TRICARE',
            insurer: 'TRICARE', plan_name: 'Select Overseas',
            network_type: 'overseas', coverage_type: 'medical',
            member_name: HH.primary.name_en,
            member_id_last4: '0001', group_number: '',
            effective_date: isoDateYearsAgo(8), expiry_date: null,
            customer_service_phone: '+81-3-XXXX-XXXX',
            member_services_phone: '', claims_phone: '',
            pcp_name: '', pcp_phone: '',
            claims_website: 'https://tricare.mil/overseas',
            claims_address: '',
            notes: 'International SOS for emergencies.',
          }],
        },
        preferences: { units: 'metric', track_trends: true, default_lab_panel: 'cmp' },
        episodes: [], invoices: [],
        ui_state: { active_tab: 'dashboard' },
      },
      sofa: {
        profile: {
          role: 'dod_contractor', sofa_status: 'transitioning',
          separation_date: isoDateMonthsAhead(8),
          jp_residency_plan: 'stay',
          juminhyou_target_date: isoDateMonthsAhead(10),
          filing_status: 'mfs',
          spouse_us_person: 'no', has_minor_children: 'yes',
          notes: 'Planning to register 住民票 after SOFA ends. Roth conversion window is the priority.',
        },
        tax_assumptions: { us_marginal_pct: 24, us_ltcg_pct: 15,
          jp_marginal_pct: 33, jp_ltcg_pct: 20.315 },
        steps: [],
        acks: { disclaimer_version: 'v0.3.0', consulted_cpa: true, consulted_cpa_at: isoDateMonthsAhead(-4) },
      },
      projections: defaultProjectionsForAge(thisYear - HH.primary.birth_year, 'mfs', 168000, 4500, 60),
      decumulation: {
        retirement_horizon: '5_15y',
        ss_claiming: { chosen_age: 70, estimated_monthly_at_chosen_age_usd: 4500,
          spouse_strategy: 'individual', notes: 'Plan to delay to 70 for maximum benefit.' },
        jp_pension: { kokumin_nenkin_years: null, kosei_nenkin_years: null,
          kosei_estimated_monthly_jpy: null, kokumin_estimated_monthly_jpy: null,
          has_japan_coverage_certificate: true,
          notes: 'SOFA status — covered by US SS via totalization agreement.' },
        withdrawal: { jp_resident_at_retirement: true, preferred_strategy: 'tax_diversified', notes: '' },
        rmd_planning: { convert_pre_rmd: true, qcd_planned: null, notes: '' },
      },
      tax_coordinator: {
        filing_status: 'mfs', feie_or_ftc_choice: 'ftc',
        jp_filing_responsibility: 'spouse',
        preparer: {
          name: 'Pat Demo, CPA (Sample Expat Tax)',
          contact: 'pat@example.com',
          notes: 'International / expat focus. Reviewed PFIC + FBAR last year.',
          next_appointment: isoDateMonthsAhead(4),
        },
        manual_overrides: {
          has_pfic: true, has_foreign_corp: false,
          self_employed: false, paid_jp_tax_prior_year: false,
          has_non_sofa_jp_income: false,
        },
        forms_filed_history: { [lastYear]: ['1040', '1116', 'fbar', '8621'] },
        notes: 'PFIC obligation = iDeCo holding. Filed 8621 with QEF election last year.',
      },
      estate: {
        status: {
          last_beneficiary_review: isoDateYearsAgo(1),
          last_will_review: isoDateYearsAgo(2),
          will_us_status: 'signed', will_jp_status: 'drafted',
          executor_us: HH.spouse.name_en, executor_jp: HH.spouse.name_en,
          notes: 'US will current. JP 公正証書 遺言 in progress with local 司法書士.',
        },
        beneficiaries: { overrides: {} },
        letter_of_instruction: {
          funeral_preferences: 'Cremation. Small family service in Tokyo. No religious ceremony.',
          pet_instructions: 'Family cat — spouse handles.',
          digital_accounts_note: 'Master password in physical safe at home. Spouse has combination.',
          important_contacts: [
            { name: 'Pat Demo, CPA', relationship: 'tax professional', role: 'CPA', contact: 'pat@example.com' },
          ],
          additional_notes: '', last_generated: null,
        },
        jp_inheritance_assumptions: {
          expects_kominka: false, expects_business_succession: false,
          has_jp_real_estate_residence: true,
          estimated_other_jp_assets_jpy: null, estimated_other_us_assets_usd: null,
        },
      },
      documentVault: {
        items: [
          { id: uuid('doc'), category: 'identification', type: 'passport_us',
            title: 'US Passport — ' + HH.primary.name_en,
            person_name: HH.primary.name_en, issuing_authority: 'US Dept of State',
            issue_date: isoDateYearsAgo(2), expiry_date: isoDateMonthsAhead(38),
            reference_number_last4: '0001', storage_location: 'Home safe — top shelf',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'estate', type: 'will',
            title: 'US Will (executed)',
            person_name: HH.primary.name_en, issuing_authority: 'Maryland',
            issue_date: isoDateYearsAgo(2), expiry_date: null,
            reference_number_last4: '', storage_location: 'Home safe + attorney copy',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'military_sofa', type: 'dd214',
            title: 'DD-214', person_name: HH.primary.name_en,
            issuing_authority: 'USAF', issue_date: isoDateYearsAgo(8), expiry_date: null,
            reference_number_last4: '', storage_location: 'Home safe',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'tax', type: 'tax_return_us',
            title: lastYear + ' Form 1040 (filed)',
            person_name: HH.primary.name_en, issuing_authority: 'IRS',
            issue_date: thisYear + '-04-10', expiry_date: null,
            reference_number_last4: '', storage_location: 'Cloud — Google Drive / Taxes folder',
            notes: '', created_at: now, updated_at: now },
        ],
      },
      consultations: {
        professionals: [{
          id: 'pro-cpa', name: 'Pat Demo',
          type: 'cpa_intl', firm: 'Sample Expat Tax Services',
          contact: 'pat@example.com',
          city: 'Remote — US', jurisdiction: 'US',
          specialty: 'PFIC, FBAR, expat 1040, FEIE/FTC',
          retainer_status: 'annual', notes: '',
          created_at: now, updated_at: now,
        }],
        consultations: [{
          id: uuid('cns'), professional_id: 'pro-cpa',
          date: isoDateMonthsAhead(-4).slice(0, 10),
          topic: 'iDeCo PFIC + Form 8621',
          summary: 'Filed Form 8621 with QEF election for the Rakuten iDeCo holding. Recommended stopping further contributions until SOFA status ends.',
          follow_up_needed: true, follow_up_date: isoDateMonthsAhead(4),
          related_module: 'tax-coordinator', notes: '',
        }],
        suggested_starting_point: null,
      },
      fx_banking: defaultFxBanking(['wise', 'sony_bank', 'broker'], 3000, 480000),
      action_center: { dismissed: {} },
      net_worth: defaultNetWorth(),
      sharing: defaultSharing(),
      ai_assistant: defaultAiAssistant(),
      settings: defaultSettings(),
    };
  }

  // ─── Profile B: Long-term resident household ──────────────────────
  function buildResidentProfile() {
    const now = isoDateNow();
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;

    // Completely different household — different names, different
    // city, different career, different visa path. Designed so a
    // user toggling between the two demos sees clearly distinct
    // content (not just a re-skinned SOFA flow).
    const HH = {
      primary:  { name_en: 'Jordan Demo',  name_jp: 'ジョーダン デモ',  birth_year: 1968 },
      spouse:   { name_en: 'Misaki Demo',  name_jp: 'デモ 美咲',         birth_year: 1970 },
      // Adult child is in the US — included for emergency-contact
      // purposes but doesn't drive the dual-citizen-kids workflow.
      child1:   { name_en: 'Riley Demo',   name_jp: 'ライリー デモ',     birth_year: 1996 },
    };

    const idJordan = 'fam-jordan', idMisaki = 'fam-misaki', idRiley = 'fam-riley';
    const acctFidelity401k = 'acct-fidelity-401k';
    const acctVanguardRoth = 'acct-vanguard-roth';
    const acctVanguardTrad = 'acct-vanguard-trad-ira';
    const acctSchwabBank   = 'acct-schwab-checking';
    const acctMizuhoSav    = 'acct-mizuho-savings';
    const acctMizuhoChk    = 'acct-mizuho-checking';
    const acctNomura       = 'acct-nomura-brokerage';

    return {
      version: 4,
      _demo: { loaded_at: now, profile: 'resident',
        household: HH.primary.name_en + ' / ' + HH.spouse.name_en },
      profile: {
        displayName:   HH.primary.name_en,
        displayNameJa: HH.primary.name_jp,
      },
      onboarding: {
        complete: true, completedAt: now,
        answers: {
          display_name: HH.primary.name_en, display_name_ja: HH.primary.name_jp,
          birth_year: String(HH.primary.birth_year),
          biological_sex: 'female',
          citizenship: 'us_only',
          in_japan: 'yes', years_in_japan: 'over_10',
          visa: 'permanent',
          employment: 'us_company',
          veteran: 'no',
          // separation_date hidden by showIf — skip
          tax_status: 'japan_resident',
          family: ['jp_spouse'],
          real_estate: 'yes', real_estate_use: 'primary',
          jp_filing_responsibility: 'self',
          healthcare_coverage: ['nhi'],
          retirement_horizon: '5_15y',
          fx_platforms: ['wise', 'broker'],
          ai_consent: 'per_call',
          consultations_history: 'cpa_us_intl',
          pfic_holdings: 'no',
          medicare_status: 'approaching_iep',
          renunciation_status: 'never',
          // juminhyo: 'yes' would be asked since visa is not SOFA
          juminhyo: 'yes',
        },
      },
      tracks: ['resident', 'family', 'property'],
      modules: { unlocked: [] },

      assets: {
        accounts: [
          { id: acctFidelity401k, institution: 'Fidelity',
            name: '401(k) — rolled from former US employer',
            country: 'US', tax_wrapper: 'traditional_401k_tsp', currency: 'USD',
            balance_native: 612000, basis_native: null, notes: '',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '1001',
            allocation: { equity_us: 0.65, equity_intl: 0.2, bond: 0.15, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctVanguardRoth, institution: 'Vanguard', name: 'Roth IRA',
            country: 'US', tax_wrapper: 'roth_ira', currency: 'USD',
            balance_native: 218000, basis_native: null, notes: '',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en + ' (primary), Riley (contingent)',
            account_number_last4: '1002',
            allocation: { equity_us: 0.75, equity_intl: 0.2, bond: 0.05, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctVanguardTrad, institution: 'Vanguard', name: 'Traditional IRA',
            country: 'US', tax_wrapper: 'traditional_ira', currency: 'USD',
            balance_native: 95000, basis_native: null,
            notes: 'Considering Roth conversions while US bracket is low.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '1003',
            allocation: { equity_us: 0.6, equity_intl: 0.2, bond: 0.2, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctSchwabBank, institution: 'Charles Schwab',
            name: 'High-yield checking (US)',
            country: 'US', tax_wrapper: 'other', currency: 'USD',
            balance_native: 24500, basis_native: null,
            notes: 'No-fee international ATM card. Backup access while in JP.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '1004',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctMizuhoSav, institution: 'みずほ銀行 (Mizuho Bank)',
            name: '普通預金 (savings)',
            country: 'JP', tax_wrapper: 'jp_savings', currency: 'JPY',
            balance_native: 8_400_000, basis_native: null,
            notes: 'Primary JP household account.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '1005',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-r-mizuho' },
          { id: acctMizuhoChk, institution: 'みずほ銀行 (Mizuho Bank)',
            name: '当座預金 (checking)',
            country: 'JP', tax_wrapper: 'jp_checking', currency: 'JPY',
            balance_native: 1_950_000, basis_native: null,
            notes: 'Utilities + autopay account.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '1006',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-r-mizuho-chk' },
          { id: acctNomura, institution: '野村證券 (Nomura Securities)',
            name: '一般口座 (taxable JP brokerage)',
            country: 'JP', tax_wrapper: 'taxable_brokerage', currency: 'JPY',
            balance_native: 18_500_000, basis_native: 14_200_000,
            notes: 'Individual JP-listed equities only — no investment trusts to avoid PFIC trap.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '1007',
            allocation: { equity_us: 0, equity_intl: 0.95, bond: 0, cash: 0.05, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-r-nomura' },
        ],
        target_allocation: null,
        snapshots: [{
          id: uuid('snap'), taken_at: isoDateYearsAgo(1),
          label: lastYear + ' year-end',
          total_usd: 1_135_000,
          allocation: { equity_us: 0.5, equity_intl: 0.25, bond: 0.12, cash: 0.13, real_estate: 0, alternative: 0 },
          accounts: [],
        }],
      },
      fbar: {
        filers: [{
          id: 'fbar-r-filer', name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
          ssn_last4: '1001', dob: HH.primary.birth_year + '-02-22', relationship: 'self',
          isMinor: false, isUSPerson: true,
          filing_address: '2-2-2 Sample-machi, Sample-ku, Yokohama 220-0000, JAPAN',
          notes: '',
        }],
        accounts: [
          { id: 'fbar-r-mizuho', filer_ids: ['fbar-r-filer'],
            account_type: 'savings', institution_name: 'みずほ銀行 (Mizuho Bank)',
            institution_address: '1-1-1 Sample, Naka-ku, Yokohama, JAPAN',
            account_number_masked: '*******1005', account_number_full: 'DEMO000001005',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 12, closed_year: null,
            signatory_only: false, notes: 'Primary household account since arrival.' },
          { id: 'fbar-r-mizuho-chk', filer_ids: ['fbar-r-filer'],
            account_type: 'checking', institution_name: 'みずほ銀行 (Mizuho Bank)',
            institution_address: '1-1-1 Sample, Naka-ku, Yokohama, JAPAN',
            account_number_masked: '*******1006', account_number_full: 'DEMO000001006',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 12, closed_year: null,
            signatory_only: false, notes: '' },
          { id: 'fbar-r-nomura', filer_ids: ['fbar-r-filer'],
            account_type: 'brokerage', institution_name: '野村證券 (Nomura Securities)',
            institution_address: '1-1-1 Sample, Chuo-ku, Tokyo, JAPAN',
            account_number_masked: '*******1007', account_number_full: 'DEMO000001007',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 8, closed_year: null,
            signatory_only: false,
            notes: 'Individual stocks only — PFIC-aware portfolio.' },
        ],
        yearly_balances: [
          { id: uuid('fb-bal'), account_id: 'fbar-r-mizuho',
            year: lastYear, max_balance_native: 9_100_000, max_balance_date: lastYear + '-12-20',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(9100000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-r-mizuho-chk',
            year: lastYear, max_balance_native: 2_400_000, max_balance_date: lastYear + '-06-15',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(2400000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-r-nomura',
            year: lastYear, max_balance_native: 19_800_000, max_balance_date: lastYear + '-04-30',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(19800000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-r-mizuho',
            year: thisYear - 2, max_balance_native: 8_500_000, max_balance_date: (thisYear - 2) + '-08-10',
            fx_rate_used: 141.10, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(8500000 / 141.10), notes: '' },
        ],
        filing_history: [
          { id: uuid('fb-file'), filer_id: 'fbar-r-filer', year: lastYear,
            filed_on: thisYear + '-03-22',
            bsa_id: 'BSA-' + lastYear + '-DEMO-1001',
            method: 'self-filed BSA E-Filing',
            notes: 'Filed early as part of 確定申告 + US 1040 cycle.' },
          { id: uuid('fb-file'), filer_id: 'fbar-r-filer', year: thisYear - 2,
            filed_on: (thisYear - 1) + '-03-30',
            bsa_id: 'BSA-' + (thisYear - 2) + '-DEMO-1001',
            method: 'self-filed BSA E-Filing', notes: '' },
        ],
      },
      family: {
        members: [
          { id: idJordan, relationship: 'self',
            name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
            birth_date: HH.primary.birth_year + '-02-22',
            citizenships: ['US'], jp_resident: true, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '1001', expires: isoDateMonthsAhead(46), renewed_at: isoDateYearsAgo(4) },
            passport_jp: { number_last4: '', expires: null, renewed_at: null },
            nationality_choice_made: null, notes: '',
            created_at: now, updated_at: now },
          { id: idMisaki, relationship: 'spouse',
            name_en: HH.spouse.name_en, name_jp: HH.spouse.name_jp,
            birth_date: HH.spouse.birth_year + '-07-08',
            citizenships: ['JP'], jp_resident: true, ssn_or_itin: 'itin',
            passport_us: { number_last4: '', expires: null, renewed_at: null },
            passport_jp: { number_last4: '1002', expires: isoDateMonthsAhead(50), renewed_at: isoDateYearsAgo(5) },
            nationality_choice_made: null, is_emergency_contact: true,
            notes: 'Retired teacher. Drives household budget.',
            created_at: now, updated_at: now },
          { id: idRiley, relationship: 'child',
            name_en: HH.child1.name_en, name_jp: HH.child1.name_jp,
            birth_date: HH.child1.birth_year + '-10-04',
            citizenships: ['US'], jp_resident: false, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '1003', expires: isoDateMonthsAhead(8), renewed_at: isoDateYearsAgo(9) },
            passport_jp: { number_last4: '', expires: null, renewed_at: null },
            nationality_choice_made: null,
            notes: 'Adult — lives in California. Listed for emergency contact only.',
            created_at: now, updated_at: now },
        ],
        renunciation: { contemplating: false, target_year: null,
          consultation_complete: false, estimated_net_worth_usd: null,
          estimated_avg_tax_5y_usd: null, notes: '' },
        gifts_log: [],
      },
      // No veteran data — civilian household. Empty defaults.
      veteran: {
        service: { branch: null, component: null, entry_date: null, discharge_date: null,
          discharge_type: null, final_rank: '', mos_rating: '', retired: false },
        disability: { overall_rating_pct: 0, monthly_compensation_usd: 0,
          individual_unemployability: false, last_evaluation_date: null, conditions: [] },
        healthcare: { tricare_eligible: false, tricare_plan: null,
          fmp_enrolled: false, chappy_17: false },
        education: { benefit_type: null, months_remaining: null,
          expiration_date: null, transferred: false },
        survivor: { sgli_amount: null, vgli_amount: null },
        dd214Stored: false, vaRating: null, notes: '',
      },
      property: {
        properties: [{
          id: uuid('prop'),
          label: 'Yokohama home (primary residence, inherited)',
          country: 'JP', currency: 'JPY', type: 'primary_residence',
          purchase_date: isoDateYearsAgo(5),
          purchase_price_native: 0, current_value_native: 68_000_000,
          address: '2-2-2 Sample-machi, Sample-ku, Yokohama 220-0000',
          square_meters: 118, structure_type: 'wood',
          mortgage_balance_native: 0, mortgage_rate_pct: 0, mortgage_remaining_years: 0,
          annual_property_tax_native: 145000, annual_city_tax_native: 19000,
          annual_insurance_native: 32000, monthly_maintenance_native: 0,
          rental_status: null, monthly_rent_native: null, annual_rental_expenses_native: null,
          depreciation_started_year: null, depreciation_basis_native: null,
          planned_sale_year: null, lived_2_of_5_years: null,
          is_residential_for_inheritance: true,
          notes: 'Inherited from spouse\'s parents. No mortgage.',
          created_at: now,
        }],
        preferences: { show_summary_currency: 'usd' },
      },
      resident: {
        residency: {
          arrival_date: isoDateYearsAgo(12),
          juminhyo_date: isoDateYearsAgo(12),
          visa_status: 'permanent',
          permanent_residency: true,
          pr_application_filed: isoDateYearsAgo(6),
        },
        furusato: {
          prior_year_income_jpy: 12_500_000,
          prior_year_dependents: 1,
          donations_planned_jpy: 90_000,
        },
        mortgage: { has_jp_mortgage: false, purchase_year: null,
          loan_balance_jpy: null, loan_type: null },
        nhi: { enrolled: true, prior_year_assessment_jpy: 720000 },
      },
      healthcare: {
        medicare: {
          // Approaching 65 — IEP planning matters more than enrollment
          enrolled_a: false, enrolled_b: false, enrolled_d: false,
          part_b_premium_monthly_usd: null,
          part_b_decision: 'undecided',
          part_b_decision_notes: 'Living abroad — weighing IRMAA + late-enrollment penalty trade-off.',
          irmaa_tier: null,
        },
        ltc: { applies: true, care_level: null,
          monthly_premium_jpy: 5800,
          funding_strategy_notes: '介護保険 active (age 40+). Both spouses enrolled.' },
        end_of_life: { organ_donor_us: true, organ_donor_jp: true,
          dnr_preference: 'limited',
          funeral_preference_notes: 'Buddhist family service in Yokohama. Cremation.' },
        private: { type: 'none', custom_name: '',
          monthly_premium_usd: null, monthly_premium_jpy: null,
          employer_paid: null, notes: '' },
        monthly_budget: { nhi_jpy: 60000, shi_jpy: null,
          tricare_usd: null, medicare_b_usd: null, medicare_d_usd: null,
          ltc_jpy: 5800, private_us_usd: null, notes: '' },
        coverage_types: ['nhi'],
      },
      health_tracker: {
        exams: [{
          id: uuid('exam'),
          date: isoDateMonthsAhead(-5).slice(0, 10),
          type: 'physical',
          provider: 'Dr. Sample Physician',
          facility: 'Sample Yokohama Clinic',
          location: 'Yokohama',
          vitals: { weight_kg: 64.5, height_cm: 168, bp_systolic: 132, bp_diastolic: 84,
            heart_rate_bpm: 72, temp_c: 36.4, respiratory_rate: 14, spo2_pct: 97, bmi: 22.9 },
          lab_results: [
            { name: 'Total Cholesterol', value: 218, unit: 'mg/dL', range_low: 0, range_high: 200, flag: 'high' },
            { name: 'LDL', value: 138, unit: 'mg/dL', range_low: 0, range_high: 100, flag: 'high' },
            { name: 'HDL', value: 64, unit: 'mg/dL', range_low: 40, range_high: 999, flag: 'normal' },
            { name: 'HbA1c', value: 5.7, unit: '%', range_low: 0, range_high: 5.6, flag: 'high' },
          ],
          diagnoses: ['Prediabetic A1c — diet + exercise', 'Elevated LDL — statin discussion in 6mo'],
          procedures: ['CMP', 'Lipid panel', 'A1c'],
          followup: 'Recheck in 6 months. Lifestyle changes first.',
          notes: 'Annual 健康診断. Cleared otherwise.',
        }],
        medications: [],
        care_plan: {
          primary_concerns: [
            { id: uuid('pc'), text: 'Borderline A1c trending up', severity: 'medium',
              started_date: isoDateYearsAgo(1) },
          ],
          annual_goals: [
            { id: uuid('goal'), text: 'Get A1c under 5.6%', target_date: thisYear + '-12-31', status: 'active' },
          ],
          preventive_screenings_due: [
            { id: uuid('scr'), name: 'Colonoscopy', due_date: isoDateMonthsAhead(3),
              last_done: isoDateYearsAgo(10), interval_years: 10, notes: 'NHI covers' },
            { id: uuid('scr'), name: 'Mammogram', due_date: isoDateMonthsAhead(7),
              last_done: isoDateYearsAgo(2), interval_years: 2, notes: '' },
          ],
          specialist_referrals: [], next_appointments: [],
        },
        dental: {
          last_cleaning: isoDateMonthsAhead(-4).slice(0, 10),
          last_xrays: isoDateYearsAgo(1),
          last_perio: isoDateMonthsAhead(-4).slice(0, 10),
          dentist: 'Dr. Sample Dentist',
          clinic: 'Sample Yokohama Dental',
          procedures: [],
          issues_tracked: [],
          providers: [{
            id: uuid('dprov'),
            name_en: 'Sample Yokohama Dental',
            name_jp: 'サンプル横浜歯科',
            type: 'dental',
            address: '2-2-2 Sample-machi, Sample-ku, Yokohama 220-0000',
            phone: '045-XXXX-XXXX',
            email: '', website: 'https://sample-yokohama-dental.example.jp',
            hours: 'Mon-Fri 9:00-18:00 · Sat 9:00-12:00',
            notes: '', ai_enriched_at: null,
            created_at: now,
          }],
          appointments: [], notes_log: [], teeth: {},
          periodontal: { pockets_4mm_pct: 12, bleeding_on_probing_pct: 8, mobile_teeth: 0 },
        },
        insurance_summary: {
          primary_plan: '国民健康保険 (NHI) — Yokohama-shi',
          member_id_last4: '1001',
          bin: '', pcp_name: '', pcp_phone: '',
          notes: 'Both spouses on NHI through Yokohama city.',
          cards: [],
        },
        preferences: { units: 'metric', track_trends: true, default_lab_panel: 'cmp' },
        episodes: [], invoices: [],
        ui_state: { active_tab: 'dashboard' },
      },
      // No SOFA data — civilian household. Empty defaults.
      sofa: {
        profile: { role: '', sofa_status: '', separation_date: '',
          jp_residency_plan: '', juminhyou_target_date: '',
          filing_status: '', spouse_us_person: '', has_minor_children: '', notes: '' },
        tax_assumptions: { us_marginal_pct: null, us_ltcg_pct: null,
          jp_marginal_pct: null, jp_ltcg_pct: 20.315 },
        steps: [],
        acks: { disclaimer_version: '', consulted_cpa: false, consulted_cpa_at: null },
      },
      projections: defaultProjectionsForAge(thisYear - HH.primary.birth_year, 'mfs', 195000, 3800, 67),
      decumulation: {
        retirement_horizon: '5_15y',
        ss_claiming: {
          chosen_age: 67,
          estimated_monthly_at_chosen_age_usd: 3800,
          spouse_strategy: 'individual',
          notes: 'FRA age 67. Will reassess closer to 65.',
        },
        jp_pension: {
          kokumin_nenkin_years: 4, kosei_nenkin_years: 8,
          kosei_estimated_monthly_jpy: 95000, kokumin_estimated_monthly_jpy: 22000,
          has_japan_coverage_certificate: false,
          notes: '12 years total — short of the 25-year vesting under old rules but qualifies under post-2017 10-year rule.',
        },
        withdrawal: {
          jp_resident_at_retirement: true,
          preferred_strategy: 'tax_diversified',
          notes: 'Plan to spend taxable JP brokerage first, then Roth conversions during low-bracket years.',
        },
        rmd_planning: { convert_pre_rmd: true, qcd_planned: null, notes: '' },
      },
      tax_coordinator: {
        filing_status: 'mfs', feie_or_ftc_choice: 'ftc',
        jp_filing_responsibility: 'self',
        preparer: {
          name: 'Sample International CPA (self-prepared)',
          contact: '',
          notes: 'Self-prepare US 1040 + 確定申告 with annual review by sample CPA.',
          next_appointment: null,
        },
        manual_overrides: {
          has_pfic: false, has_foreign_corp: false,
          self_employed: false, paid_jp_tax_prior_year: true,
          has_non_sofa_jp_income: null,
        },
        forms_filed_history: {
          [lastYear]:     ['1040', '1116', 'fbar', '8938'],
          [thisYear - 2]: ['1040', '1116', 'fbar', '8938'],
        },
        notes: 'No PFIC — JP brokerage holds individual stocks only. Form 8938 triggered by aggregate foreign financial assets.',
      },
      estate: {
        status: {
          last_beneficiary_review: isoDateMonthsAhead(-6).slice(0, 10),
          last_will_review: isoDateYearsAgo(1),
          will_us_status: 'signed', will_jp_status: 'kosei_shosho',
          executor_us: HH.spouse.name_en, executor_jp: HH.spouse.name_en,
          notes: 'Both wills current. JP 公正証書 遺言 executed last year.',
        },
        beneficiaries: { overrides: {} },
        letter_of_instruction: {
          funeral_preferences: 'Buddhist service. Cremation. Family plot in Yokohama.',
          pet_instructions: '',
          digital_accounts_note: 'Password manager: 1Password — emergency kit with spouse and Riley.',
          important_contacts: [],
          additional_notes: '', last_generated: null,
        },
        jp_inheritance_assumptions: {
          expects_kominka: false, expects_business_succession: false,
          has_jp_real_estate_residence: true,
          estimated_other_jp_assets_jpy: null, estimated_other_us_assets_usd: null,
        },
      },
      documentVault: {
        items: [
          { id: uuid('doc'), category: 'identification', type: 'passport_us',
            title: 'US Passport — ' + HH.primary.name_en,
            person_name: HH.primary.name_en, issuing_authority: 'US Dept of State',
            issue_date: isoDateYearsAgo(4), expiry_date: isoDateMonthsAhead(46),
            reference_number_last4: '1001', storage_location: 'Home safe',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'immigration', type: 'residence_card_jp',
            title: '在留カード (Permanent Resident)',
            person_name: HH.primary.name_en, issuing_authority: '入国管理局',
            issue_date: isoDateYearsAgo(4), expiry_date: isoDateMonthsAhead(36),
            reference_number_last4: '1004', storage_location: 'Carry — wallet',
            notes: 'PR — renewable card every 7 years.',
            created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'estate', type: 'will',
            title: 'US Will (executed)',
            person_name: HH.primary.name_en, issuing_authority: 'California',
            issue_date: isoDateYearsAgo(1), expiry_date: null,
            reference_number_last4: '', storage_location: 'Home safe + attorney copy',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'estate', type: 'will',
            title: '公正証書遺言 (JP Will)',
            person_name: HH.primary.name_en, issuing_authority: '横浜公証役場',
            issue_date: isoDateYearsAgo(1), expiry_date: null,
            reference_number_last4: '', storage_location: '横浜公証役場 + copy at home',
            notes: 'Notarized JP will. Spouse and 司法書士 hold copies.',
            created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'tax', type: 'tax_return_us',
            title: lastYear + ' Form 1040 (filed)',
            person_name: HH.primary.name_en, issuing_authority: 'IRS',
            issue_date: thisYear + '-03-15', expiry_date: null,
            reference_number_last4: '', storage_location: 'Cloud — encrypted Drive',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'tax', type: 'tax_return_jp',
            title: lastYear + ' 確定申告書 (filed)',
            person_name: HH.primary.name_en, issuing_authority: '国税庁',
            issue_date: thisYear + '-03-14', expiry_date: null,
            reference_number_last4: '', storage_location: 'Cloud — encrypted Drive',
            notes: '', created_at: now, updated_at: now },
        ],
      },
      consultations: {
        professionals: [{
          id: 'pro-cpa-r', name: 'Sample International CPA',
          type: 'cpa_intl', firm: 'Sample Expat Tax (review-only)',
          contact: 'review@example.com',
          city: 'Remote — US', jurisdiction: 'US',
          specialty: 'Expat 1040 + Form 8938 review',
          retainer_status: 'as_needed', notes: 'Annual review only — JP side self-filed.',
          created_at: now, updated_at: now,
        }],
        consultations: [{
          id: uuid('cns'), professional_id: 'pro-cpa-r',
          date: isoDateMonthsAhead(-3).slice(0, 10),
          topic: 'Annual review — 1040 + 8938 + FBAR',
          summary: 'Reviewed self-prepared 1040 with FTC, Form 8938 (over thresholds for JP-resident MFS), FBAR confirmed. No PFIC issues.',
          follow_up_needed: false, follow_up_date: null,
          related_module: 'tax-coordinator', notes: '',
        }],
        suggested_starting_point: null,
      },
      fx_banking: defaultFxBanking(['wise', 'broker'], 2500, 400000),
      action_center: { dismissed: {} },
      net_worth: defaultNetWorth(),
      sharing: defaultSharing(),
      ai_assistant: defaultAiAssistant(),
      settings: defaultSettings(),
    };
  }

  // ─── Profile C: Retired American in Japan ────────────────────────
  function buildRetireeProfile() {
    const now = isoDateNow();
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;

    const HH = {
      primary: { name_en: 'Sam Demo',    name_jp: 'サム デモ',  birth_year: thisYear - 73 },
      spouse:  { name_en: 'Tomoko Demo', name_jp: 'デモ 朋子',  birth_year: thisYear - 71 },
      // Adult child living in California — listed for emergency
      // contact only, not a household-tax-filing concern.
      child1:  { name_en: 'Jamie Demo',  name_jp: 'ジェイミー デモ', birth_year: thisYear - 42 },
    };
    const idSam = 'fam-sam', idTomoko = 'fam-tomoko', idJamie = 'fam-jamie';
    const acctTradIra  = 'acct-r-trad-ira';
    const acctRothIra  = 'acct-r-roth-ira';
    const acctSchwab   = 'acct-r-schwab-brokerage';
    const acctMizuhoS  = 'acct-r-mizuho-savings';
    const acctNomura   = 'acct-r-nomura-brokerage';

    return {
      version: 4,
      _demo: { loaded_at: now, profile: 'retiree',
        household: HH.primary.name_en + ' / ' + HH.spouse.name_en },
      profile: { displayName: HH.primary.name_en, displayNameJa: HH.primary.name_jp },
      onboarding: {
        complete: true, completedAt: now,
        answers: {
          display_name: HH.primary.name_en, display_name_ja: HH.primary.name_jp,
          birth_year: String(HH.primary.birth_year),
          biological_sex: 'male',
          citizenship: 'us_only',
          in_japan: 'yes', years_in_japan: 'over_10',
          visa: 'permanent',
          juminhyo: 'yes',
          employment: 'retired_civ',
          veteran: 'no',
          tax_status: 'japan_resident',
          family: ['jp_spouse'],
          real_estate: 'yes', real_estate_use: 'primary',
          jp_filing_responsibility: 'self',
          healthcare_coverage: ['nhi', 'medicare'],
          retirement_horizon: 'already',
          fx_platforms: ['wise', 'broker'],
          ai_consent: 'per_call',
          consultations_history: 'multiple',
          pfic_holdings: 'no',
          medicare_status: 'enrolled_a_only',
          renunciation_status: 'never',
        },
      },
      tracks: ['resident', 'family', 'property'],
      modules: { unlocked: [] },
      assets: {
        accounts: [
          { id: acctTradIra, institution: 'Vanguard', name: 'Traditional IRA (RMD active)',
            country: 'US', tax_wrapper: 'traditional_ira', currency: 'USD',
            balance_native: 485000, basis_native: null,
            notes: 'RMD active since age 73. Annual distribution rolls to brokerage.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '2001',
            allocation: { equity_us: 0.4, equity_intl: 0.15, bond: 0.4, cash: 0.05, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctRothIra, institution: 'Vanguard', name: 'Roth IRA',
            country: 'US', tax_wrapper: 'roth_ira', currency: 'USD',
            balance_native: 195000, basis_native: null,
            notes: 'Spending last (no RMD). Reserved for late-life and heir basis.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en + ' (primary), Jamie (contingent)',
            account_number_last4: '2002',
            allocation: { equity_us: 0.65, equity_intl: 0.2, bond: 0.15, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctSchwab, institution: 'Charles Schwab', name: 'Brokerage',
            country: 'US', tax_wrapper: 'taxable_brokerage', currency: 'USD',
            balance_native: 320000, basis_native: 240000,
            notes: 'Step-up basis on death — keep here for heirs vs. spending Roth.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en + ' (POD)',
            account_number_last4: '2003',
            allocation: { equity_us: 0.5, equity_intl: 0.2, bond: 0.25, cash: 0.05, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctMizuhoS, institution: 'みずほ銀行 (Mizuho Bank)', name: '普通預金',
            country: 'JP', tax_wrapper: 'jp_savings', currency: 'JPY',
            balance_native: 6_800_000, basis_native: null,
            notes: 'Daily expenses + monthly NHI / 介護保険 autopay.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '2004',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-r-mizuho-2' },
          { id: acctNomura, institution: '野村證券 (Nomura Securities)',
            name: '一般口座 (taxable JP brokerage)',
            country: 'JP', tax_wrapper: 'taxable_brokerage', currency: 'JPY',
            balance_native: 12_400_000, basis_native: 9_600_000,
            notes: 'Individual JP-listed equities only — deliberately PFIC-safe.',
            updated_at: now, active: true, include_in_sofa: false,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '2005',
            allocation: { equity_us: 0, equity_intl: 0.95, bond: 0, cash: 0.05, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-r-nomura-2' },
        ],
        target_allocation: null,
        snapshots: [{
          id: uuid('snap'), taken_at: isoDateYearsAgo(1),
          label: lastYear + ' year-end',
          total_usd: 1_080_000,
          allocation: { equity_us: 0.4, equity_intl: 0.18, bond: 0.28, cash: 0.14, real_estate: 0, alternative: 0 },
          accounts: [],
        }],
      },
      fbar: {
        filers: [{
          id: 'fbar-r-filer-2', name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
          ssn_last4: '2001', dob: HH.primary.birth_year + '-05-10', relationship: 'self',
          isMinor: false, isUSPerson: true,
          filing_address: '3-3-3 Sample-machi, Sample-ku, Kamakura 248-0000, JAPAN',
          notes: '',
        }],
        accounts: [
          { id: 'fbar-r-mizuho-2', filer_ids: ['fbar-r-filer-2'],
            account_type: 'savings', institution_name: 'みずほ銀行 (Mizuho Bank)',
            institution_address: '1-1-1 Sample, Kamakura, Kanagawa, JAPAN',
            account_number_masked: '*******2004', account_number_full: 'DEMO000002004',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 18, closed_year: null,
            signatory_only: false, notes: '' },
          { id: 'fbar-r-nomura-2', filer_ids: ['fbar-r-filer-2'],
            account_type: 'brokerage', institution_name: '野村證券 (Nomura Securities)',
            institution_address: '1-1-1 Sample, Chuo-ku, Tokyo, JAPAN',
            account_number_masked: '*******2005', account_number_full: 'DEMO000002005',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 14, closed_year: null,
            signatory_only: false, notes: '' },
        ],
        yearly_balances: [
          { id: uuid('fb-bal'), account_id: 'fbar-r-mizuho-2',
            year: lastYear, max_balance_native: 7_400_000, max_balance_date: lastYear + '-04-15',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(7400000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-r-nomura-2',
            year: lastYear, max_balance_native: 13_200_000, max_balance_date: lastYear + '-09-08',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(13200000 / 149.50), notes: '' },
          { id: uuid('fb-bal'), account_id: 'fbar-r-mizuho-2',
            year: thisYear - 2, max_balance_native: 6_950_000, max_balance_date: (thisYear - 2) + '-11-01',
            fx_rate_used: 141.10, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(6950000 / 141.10), notes: '' },
        ],
        filing_history: [
          { id: uuid('fb-file'), filer_id: 'fbar-r-filer-2', year: lastYear,
            filed_on: thisYear + '-03-12',
            bsa_id: 'BSA-' + lastYear + '-DEMO-2001',
            method: 'self-filed BSA E-Filing', notes: 'Filed alongside 1040 + 8938 + 確定申告.' },
          { id: uuid('fb-file'), filer_id: 'fbar-r-filer-2', year: thisYear - 2,
            filed_on: (thisYear - 1) + '-03-15',
            bsa_id: 'BSA-' + (thisYear - 2) + '-DEMO-2001',
            method: 'self-filed BSA E-Filing', notes: '' },
        ],
      },
      family: {
        members: [
          { id: idSam, relationship: 'self',
            name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
            birth_date: HH.primary.birth_year + '-05-10',
            citizenships: ['US'], jp_resident: true, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '2001', expires: isoDateMonthsAhead(31), renewed_at: isoDateYearsAgo(7) },
            passport_jp: { number_last4: '', expires: null, renewed_at: null },
            nationality_choice_made: null, notes: '',
            created_at: now, updated_at: now },
          { id: idTomoko, relationship: 'spouse',
            name_en: HH.spouse.name_en, name_jp: HH.spouse.name_jp,
            birth_date: HH.spouse.birth_year + '-12-04',
            citizenships: ['JP'], jp_resident: true, ssn_or_itin: 'itin',
            passport_us: { number_last4: '', expires: null, renewed_at: null },
            passport_jp: { number_last4: '2002', expires: isoDateMonthsAhead(40), renewed_at: isoDateYearsAgo(6) },
            nationality_choice_made: null, is_emergency_contact: true,
            notes: 'Retired teacher. Power of attorney for Sam.',
            created_at: now, updated_at: now },
          { id: idJamie, relationship: 'child',
            name_en: HH.child1.name_en, name_jp: HH.child1.name_jp,
            birth_date: HH.child1.birth_year + '-08-22',
            citizenships: ['US'], jp_resident: false, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '2003', expires: isoDateMonthsAhead(24), renewed_at: isoDateYearsAgo(8) },
            passport_jp: { number_last4: '', expires: null, renewed_at: null },
            nationality_choice_made: null,
            notes: 'Adult — California. Listed as US-side executor.',
            created_at: now, updated_at: now },
        ],
        renunciation: { contemplating: false, target_year: null,
          consultation_complete: false, estimated_net_worth_usd: null,
          estimated_avg_tax_5y_usd: null, notes: '' },
        gifts_log: [],
      },
      veteran: {
        service: { branch: null, component: null, entry_date: null, discharge_date: null,
          discharge_type: null, final_rank: '', mos_rating: '', retired: false },
        disability: { overall_rating_pct: 0, monthly_compensation_usd: 0,
          individual_unemployability: false, last_evaluation_date: null, conditions: [] },
        healthcare: { tricare_eligible: false, tricare_plan: null, fmp_enrolled: false, chappy_17: false },
        education: { benefit_type: null, months_remaining: null, expiration_date: null, transferred: false },
        survivor: { sgli_amount: null, vgli_amount: null },
        dd214Stored: false, vaRating: null, notes: '',
      },
      property: {
        properties: [{
          id: uuid('prop'),
          label: 'Kamakura home (primary residence, paid off)',
          country: 'JP', currency: 'JPY', type: 'primary_residence',
          purchase_date: isoDateYearsAgo(15),
          purchase_price_native: 42_000_000, current_value_native: 58_000_000,
          address: '3-3-3 Sample-machi, Sample-ku, Kamakura 248-0000',
          square_meters: 96, structure_type: 'wood',
          mortgage_balance_native: 0, mortgage_rate_pct: 0, mortgage_remaining_years: 0,
          annual_property_tax_native: 132000, annual_city_tax_native: 17000,
          annual_insurance_native: 28000, monthly_maintenance_native: 0,
          rental_status: null, monthly_rent_native: null, annual_rental_expenses_native: null,
          depreciation_started_year: null, depreciation_basis_native: null,
          planned_sale_year: null, lived_2_of_5_years: null,
          is_residential_for_inheritance: true,
          notes: 'Mortgage paid off 4 years ago. Single-family home, walking distance to station.',
          created_at: now,
        }],
        preferences: { show_summary_currency: 'usd' },
      },
      resident: {
        residency: {
          arrival_date: isoDateYearsAgo(18),
          juminhyo_date: isoDateYearsAgo(18),
          visa_status: 'permanent', permanent_residency: true,
          pr_application_filed: isoDateYearsAgo(15),
        },
        furusato: { prior_year_income_jpy: 5_400_000, prior_year_dependents: 1, donations_planned_jpy: 80000 },
        mortgage: { has_jp_mortgage: false, purchase_year: null, loan_balance_jpy: null, loan_type: null },
        nhi: { enrolled: true, prior_year_assessment_jpy: 540000 },
      },
      healthcare: {
        medicare: {
          // Classic JP-resident retiree pattern: A is free + automatic
          // at 65, B was declined to avoid the $202.90/mo premium for
          // care that doesn't cover JP. Late-enrollment penalty
          // accepted as the cost of this strategy.
          enrolled_a: true, enrolled_b: false, enrolled_d: false,
          part_b_premium_monthly_usd: null,
          part_b_decision: 'declined',
          part_b_decision_notes: 'Declined Part B since arrival in JP — care covered by NHI. Late-enrollment penalty accepted.',
          irmaa_tier: null,
        },
        ltc: { applies: true, care_level: null, monthly_premium_jpy: 7200,
          funding_strategy_notes: '介護保険 active — both spouses enrolled.' },
        end_of_life: { organ_donor_us: true, organ_donor_jp: true,
          dnr_preference: 'yes',
          funeral_preference_notes: 'Cremation. Kamakura family plot. Buddhist service.' },
        private: { type: 'none', custom_name: '', monthly_premium_usd: null,
          monthly_premium_jpy: null, employer_paid: null, notes: '' },
        monthly_budget: { nhi_jpy: 45000, shi_jpy: null,
          tricare_usd: null, medicare_b_usd: null, medicare_d_usd: null,
          ltc_jpy: 7200, private_us_usd: null, notes: '' },
        coverage_types: ['nhi', 'medicare'],
      },
      health_tracker: {
        exams: [{
          id: uuid('exam'),
          date: isoDateMonthsAhead(-2).slice(0, 10),
          type: 'physical',
          provider: 'Dr. Sample Physician',
          facility: 'Sample Kamakura Clinic',
          location: 'Kamakura',
          vitals: { weight_kg: 71.0, height_cm: 173, bp_systolic: 138, bp_diastolic: 86,
            heart_rate_bpm: 70, temp_c: 36.6, respiratory_rate: 14, spo2_pct: 96, bmi: 23.7 },
          lab_results: [
            { name: 'Total Cholesterol', value: 205, unit: 'mg/dL', range_low: 0, range_high: 200, flag: 'high' },
            { name: 'LDL', value: 128, unit: 'mg/dL', range_low: 0, range_high: 100, flag: 'high' },
            { name: 'HDL', value: 58, unit: 'mg/dL', range_low: 40, range_high: 999, flag: 'normal' },
            { name: 'HbA1c', value: 6.0, unit: '%', range_low: 0, range_high: 5.6, flag: 'high' },
            { name: 'eGFR', value: 68, unit: 'mL/min/1.73m²', range_low: 60, range_high: 999, flag: 'normal' },
          ],
          diagnoses: ['Type 2 diabetes (controlled)', 'Hyperlipidemia (statin-managed)'],
          procedures: ['CMP', 'Lipid panel', 'A1c', 'eGFR'],
          followup: 'Quarterly A1c. Annual physical otherwise stable.',
          notes: '健康診断 — NHI covered.',
        }],
        medications: [
          { id: uuid('med'), name: 'Atorvastatin', generic_name: 'atorvastatin',
            dosage: 20, dosage_unit: 'mg', frequency: 'nightly', route: 'oral',
            started_date: isoDateYearsAgo(6), ended_date: null,
            prescriber: 'Dr. Sample Physician', pharmacy: 'Sample Pharmacy',
            refills_remaining: 5, next_refill_date: isoDateMonthsAhead(2),
            purpose: 'Cholesterol', side_effects: '', notes: '' },
          { id: uuid('med'), name: 'Metformin', generic_name: 'metformin',
            dosage: 500, dosage_unit: 'mg', frequency: 'twice daily with meals', route: 'oral',
            started_date: isoDateYearsAgo(3), ended_date: null,
            prescriber: 'Dr. Sample Physician', pharmacy: 'Sample Pharmacy',
            refills_remaining: 3, next_refill_date: isoDateMonthsAhead(1),
            purpose: 'Type 2 diabetes', side_effects: '', notes: '' },
        ],
        care_plan: {
          primary_concerns: [
            { id: uuid('pc'), text: 'A1c trending — targeting <6.5', severity: 'medium',
              started_date: isoDateYearsAgo(3) },
          ],
          annual_goals: [],
          preventive_screenings_due: [
            { id: uuid('scr'), name: 'Colonoscopy', due_date: isoDateMonthsAhead(4),
              last_done: isoDateYearsAgo(5), interval_years: 5,
              notes: 'Reduced interval due to age + family history.' },
          ],
          specialist_referrals: [], next_appointments: [],
        },
        dental: {
          last_cleaning: isoDateMonthsAhead(-3).slice(0, 10),
          last_xrays: isoDateYearsAgo(2),
          last_perio: isoDateMonthsAhead(-3).slice(0, 10),
          dentist: 'Dr. Sample Dentist',
          clinic: 'Sample Kamakura Dental',
          procedures: [],
          issues_tracked: [],
          providers: [{
            id: uuid('dprov'),
            name_en: 'Sample Kamakura Dental',
            name_jp: 'サンプル鎌倉歯科',
            type: 'dental',
            address: '3-3-3 Sample-machi, Sample-ku, Kamakura 248-0000',
            phone: '0467-XX-XXXX',
            email: '', website: '', hours: 'Mon-Fri 9:00-18:00',
            notes: '', ai_enriched_at: null,
            created_at: now,
          }],
          appointments: [], notes_log: [], teeth: {},
          periodontal: { pockets_4mm_pct: 18, bleeding_on_probing_pct: 12, mobile_teeth: 1 },
        },
        insurance_summary: {
          primary_plan: '国民健康保険 (NHI) — Kamakura-shi',
          member_id_last4: '2001',
          bin: '', pcp_name: 'Dr. Sample Physician', pcp_phone: '0467-XX-XXXX',
          notes: 'Both spouses on NHI through Kamakura city.',
          cards: [],
        },
        preferences: { units: 'metric', track_trends: true, default_lab_panel: 'cmp' },
        episodes: [], invoices: [],
        ui_state: { active_tab: 'dashboard' },
      },
      sofa: {
        profile: { role: '', sofa_status: '', separation_date: '',
          jp_residency_plan: '', juminhyou_target_date: '',
          filing_status: '', spouse_us_person: '', has_minor_children: '', notes: '' },
        tax_assumptions: { us_marginal_pct: null, us_ltcg_pct: null,
          jp_marginal_pct: null, jp_ltcg_pct: 20.315 },
        steps: [],
        acks: { disclaimer_version: '', consulted_cpa: false, consulted_cpa_at: null },
      },
      projections: defaultProjectionsForAge(73, 'mfs', 0, 3200, 65),
      decumulation: {
        retirement_horizon: 'already',
        ss_claiming: {
          chosen_age: 67,
          estimated_monthly_at_chosen_age_usd: 3200,
          spouse_strategy: 'individual',
          notes: 'Started at FRA (67). Would have waited but needed cash flow.',
        },
        jp_pension: {
          kokumin_nenkin_years: 6, kosei_nenkin_years: 12,
          kosei_estimated_monthly_jpy: 110000, kokumin_estimated_monthly_jpy: 32000,
          has_japan_coverage_certificate: false,
          notes: 'Receiving full 国民年金 + 厚生年金 monthly. 18-year combined coverage.',
        },
        withdrawal: {
          jp_resident_at_retirement: true,
          preferred_strategy: 'tax_diversified',
          notes: 'Spend taxable + RMD-required, preserve Roth for spouse + heir basis step-up.',
        },
        rmd_planning: {
          convert_pre_rmd: false,
          qcd_planned: true,
          notes: 'QCD ($105K limit 2026) routes RMD to charity tax-free.',
        },
      },
      tax_coordinator: {
        filing_status: 'mfs', feie_or_ftc_choice: 'ftc',
        jp_filing_responsibility: 'self',
        preparer: {
          name: 'Sample International CPA + Sakura Tax Office (税理士)',
          contact: 'review@example.com',
          notes: 'US side reviewed annually by sample CPA. JP side prepared by local 税理士.',
          next_appointment: isoDateMonthsAhead(2),
        },
        manual_overrides: {
          has_pfic: false, has_foreign_corp: false,
          self_employed: false, paid_jp_tax_prior_year: true,
          has_non_sofa_jp_income: null,
        },
        forms_filed_history: {
          [lastYear]:     ['1040', '1116', 'fbar', '8938'],
          [thisYear - 2]: ['1040', '1116', 'fbar', '8938'],
          [thisYear - 3]: ['1040', '1116', 'fbar', '8938'],
        },
        notes: 'Long history of clean filing. RMD income flows through 1040 line 4b.',
      },
      estate: {
        status: {
          last_beneficiary_review: isoDateMonthsAhead(-3).slice(0, 10),
          last_will_review: isoDateMonthsAhead(-8).slice(0, 10),
          will_us_status: 'updated_recent', will_jp_status: 'kosei_shosho',
          executor_us: HH.child1.name_en, executor_jp: HH.spouse.name_en,
          notes: 'Both wills current. Reviewed last summer. JP 公正証書 遺言 with 司法書士.',
        },
        beneficiaries: { overrides: {} },
        letter_of_instruction: {
          funeral_preferences: 'Cremation. Buddhist service in Kamakura.',
          pet_instructions: '',
          digital_accounts_note: 'Password manager kit in home safe. Spouse + Jamie both have access.',
          important_contacts: [
            { name: 'Sample International CPA', relationship: 'tax professional', role: 'CPA', contact: 'review@example.com' },
            { name: 'Sakura Tax Office', relationship: '税理士', role: '税理士', contact: 'office@example.jp' },
          ],
          additional_notes: 'Worldwide assets in scope under JP 10-year clock — verified with 税理士.',
          last_generated: isoDateMonthsAhead(-6).slice(0, 10),
        },
        jp_inheritance_assumptions: {
          expects_kominka: false, expects_business_succession: false,
          has_jp_real_estate_residence: true,
          estimated_other_jp_assets_jpy: null, estimated_other_us_assets_usd: null,
        },
      },
      documentVault: {
        items: [
          { id: uuid('doc'), category: 'identification', type: 'passport_us',
            title: 'US Passport — ' + HH.primary.name_en,
            person_name: HH.primary.name_en, issuing_authority: 'US Dept of State',
            issue_date: isoDateYearsAgo(7), expiry_date: isoDateMonthsAhead(31),
            reference_number_last4: '2001', storage_location: 'Home safe',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'immigration', type: 'residence_card_jp',
            title: '在留カード (Permanent Resident)',
            person_name: HH.primary.name_en, issuing_authority: '入国管理局',
            issue_date: isoDateYearsAgo(2), expiry_date: isoDateMonthsAhead(54),
            reference_number_last4: '2002', storage_location: 'Carry — wallet',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'estate', type: 'will',
            title: 'US Will (executed, current)',
            person_name: HH.primary.name_en, issuing_authority: 'California',
            issue_date: isoDateMonthsAhead(-8).slice(0, 10), expiry_date: null,
            reference_number_last4: '', storage_location: 'Home safe + attorney + Jamie',
            notes: 'Updated last summer.', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'estate', type: 'will',
            title: '公正証書遺言 (JP Will, current)',
            person_name: HH.primary.name_en, issuing_authority: '横浜公証役場',
            issue_date: isoDateYearsAgo(1), expiry_date: null,
            reference_number_last4: '', storage_location: '横浜公証役場 + copy at home',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'estate', type: 'poa',
            title: 'Power of Attorney — Tomoko Demo',
            person_name: HH.primary.name_en, issuing_authority: 'California notary',
            issue_date: isoDateYearsAgo(2), expiry_date: null,
            reference_number_last4: '', storage_location: 'Home safe',
            notes: 'Spouse holds POA. Jamie is contingent.',
            created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'tax', type: 'tax_return_us',
            title: lastYear + ' Form 1040 (filed)',
            person_name: HH.primary.name_en, issuing_authority: 'IRS',
            issue_date: thisYear + '-03-12', expiry_date: null,
            reference_number_last4: '', storage_location: 'Cloud — encrypted Drive',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'tax', type: 'tax_return_jp',
            title: lastYear + ' 確定申告書 (filed)',
            person_name: HH.primary.name_en, issuing_authority: '国税庁',
            issue_date: thisYear + '-03-10', expiry_date: null,
            reference_number_last4: '', storage_location: 'Cloud — encrypted Drive',
            notes: '', created_at: now, updated_at: now },
        ],
      },
      consultations: {
        professionals: [
          { id: 'pro-cpa-r2', name: 'Sample International CPA',
            type: 'cpa_intl', firm: 'Sample Expat Tax (annual review)',
            contact: 'review@example.com',
            city: 'Remote — US', jurisdiction: 'US',
            specialty: 'Retiree 1040 + Form 8938 + RMD review',
            retainer_status: 'annual', notes: '',
            created_at: now, updated_at: now },
          { id: 'pro-zeirishi', name: 'Sakura Tax Office',
            type: 'zeirishi', firm: 'Sakura Tax Office',
            contact: 'office@example.jp',
            city: 'Yokohama', jurisdiction: 'JP',
            specialty: '確定申告 for foreign-resident retirees, 相続税 planning',
            retainer_status: 'annual', notes: '',
            created_at: now, updated_at: now },
        ],
        consultations: [{
          id: uuid('cns'), professional_id: 'pro-zeirishi',
          date: isoDateMonthsAhead(-9).slice(0, 10),
          topic: '相続税 simulation under 10-year worldwide-asset rule',
          summary: 'Confirmed worldwide assets in scope. Estimated 相続税 burden + recommended 暦年贈与 to spouse over remaining years.',
          follow_up_needed: true, follow_up_date: isoDateMonthsAhead(3),
          related_module: 'estate', notes: '',
        }],
        suggested_starting_point: null,
      },
      fx_banking: defaultFxBanking(['wise', 'broker'], 1500, 240000),
      action_center: { dismissed: {} },
      net_worth: defaultNetWorth(),
      sharing: defaultSharing(),
      ai_assistant: defaultAiAssistant(),
      settings: defaultSettings(),
    };
  }

  // ─── Profile D: Active duty military with JP spouse ──────────────
  function buildActiveMilitaryProfile() {
    const now = isoDateNow();
    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;

    const HH = {
      primary: { name_en: 'Casey Demo',  name_jp: 'ケイシー デモ', birth_year: thisYear - 32 },
      spouse:  { name_en: 'Sayaka Demo', name_jp: 'デモ さやか',   birth_year: thisYear - 30 },
    };
    const idCasey = 'fam-casey', idSayaka = 'fam-sayaka';
    const acctTsp     = 'acct-d-tsp';
    const acctRoth    = 'acct-d-roth-ira';
    const acctHsa     = 'acct-d-hsa';
    const acctSchwab  = 'acct-d-schwab-checking';
    const acctSony    = 'acct-d-sony-bank';

    return {
      version: 4,
      _demo: { loaded_at: now, profile: 'active_mil',
        household: HH.primary.name_en + ' / ' + HH.spouse.name_en },
      profile: { displayName: HH.primary.name_en, displayNameJa: HH.primary.name_jp },
      onboarding: {
        complete: true, completedAt: now,
        answers: {
          display_name: HH.primary.name_en, display_name_ja: HH.primary.name_jp,
          birth_year: String(HH.primary.birth_year),
          biological_sex: 'female',
          citizenship: 'us_only',
          in_japan: 'yes', years_in_japan: '1_to_5',
          visa: 'sofa',
          // juminhyo skipped via showIf for SOFA
          employment: 'dod_active',
          veteran: 'active',
          // separation_date skipped for active-duty via showIf
          tax_status: 'sofa_no_file',
          non_sofa_jp_income: 'no',
          family: ['jp_spouse'],
          real_estate: 'no',
          jp_filing_responsibility: 'spouse',
          healthcare_coverage: ['tricare'],
          retirement_horizon: 'gt30y',
          fx_platforms: ['usaa', 'wise'],
          ai_consent: 'per_call',
          consultations_history: 'no_diy',
          pfic_holdings: 'no',
          medicare_status: 'not_yet',
          renunciation_status: 'never',
        },
      },
      tracks: ['sofa', 'veteran', 'family'],
      modules: { unlocked: [] },
      assets: {
        accounts: [
          { id: acctTsp, institution: 'Thrift Savings Plan', name: 'TSP — active duty',
            country: 'US', tax_wrapper: 'traditional_401k_tsp', currency: 'USD',
            balance_native: 58000, basis_native: null,
            notes: 'Currently contributing 15%. C/S/I split, no L fund.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '3001',
            allocation: { equity_us: 0.7, equity_intl: 0.25, bond: 0.05, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctRoth, institution: 'Vanguard', name: 'Roth IRA',
            country: 'US', tax_wrapper: 'roth_ira', currency: 'USD',
            balance_native: 14500, basis_native: null,
            notes: 'Maxing $7K/year since age 28.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '3002',
            allocation: { equity_us: 0.85, equity_intl: 0.15, bond: 0, cash: 0, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctHsa, institution: 'HSA Bank', name: 'HSA',
            country: 'US', tax_wrapper: 'hsa', currency: 'USD',
            balance_native: 4200, basis_native: null,
            notes: 'Building. Investing once balance exceeds $5K threshold.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '3003',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctSchwab, institution: 'Charles Schwab',
            name: 'High-yield checking (US)',
            country: 'US', tax_wrapper: 'other', currency: 'USD',
            balance_native: 8200, basis_native: null,
            notes: 'No-fee international ATM. Daily expenses.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '3004',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: null },
          { id: acctSony, institution: 'Sony Bank',
            name: '普通預金 (joint with spouse)',
            country: 'JP', tax_wrapper: 'jp_savings', currency: 'JPY',
            balance_native: 1_200_000, basis_native: null,
            notes: 'Spouse-side daily expenses. Stays under FBAR threshold.',
            updated_at: now, active: true, include_in_sofa: true,
            close_date: null, transfer_to: null,
            beneficiary: HH.spouse.name_en,
            account_number_last4: '3005',
            allocation: { equity_us: 0, equity_intl: 0, bond: 0, cash: 1, real_estate: 0, alternative: 0 },
            fbar_account_id: 'fbar-d-sony' },
        ],
        target_allocation: null,
        snapshots: [],
      },
      fbar: {
        // FBAR not currently required (single JP account well under
        // $10K). Filer added so onboarding is complete; no balance
        // history yet. Surfaces the "monitor — within sight of
        // threshold" status.
        filers: [{
          id: 'fbar-d-filer', name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
          ssn_last4: '3001', dob: HH.primary.birth_year + '-01-30', relationship: 'self',
          isMinor: false, isUSPerson: true,
          filing_address: 'Yokota AB, FPO AP 96328',
          notes: 'Active duty SOFA — JP residence not on 住民票.',
        }],
        accounts: [
          { id: 'fbar-d-sony', filer_ids: ['fbar-d-filer'],
            account_type: 'savings', institution_name: 'Sony Bank',
            institution_address: '1-1-1 Sample, Minato-ku, Tokyo, JAPAN',
            account_number_masked: '*******3005', account_number_full: 'DEMO000003005',
            currency: 'JPY', country: 'JP',
            opened_year: thisYear - 3, closed_year: null,
            signatory_only: false, notes: 'Joint with spouse. Stays under threshold.' },
        ],
        yearly_balances: [
          { id: uuid('fb-bal'), account_id: 'fbar-d-sony',
            year: lastYear, max_balance_native: 1_350_000, max_balance_date: lastYear + '-08-15',
            fx_rate_used: 149.50, fx_rate_source: 'Treasury', fx_rate_overridden: false,
            max_balance_usd: Math.round(1350000 / 149.50), notes: 'Below $10K threshold — FBAR not triggered.' },
        ],
        filing_history: [],
      },
      family: {
        members: [
          { id: idCasey, relationship: 'self',
            name_en: HH.primary.name_en, name_jp: HH.primary.name_jp,
            birth_date: HH.primary.birth_year + '-01-30',
            citizenships: ['US'], jp_resident: true, ssn_or_itin: 'ssn',
            passport_us: { number_last4: '3001', expires: isoDateMonthsAhead(64), renewed_at: isoDateYearsAgo(2) },
            passport_jp: { number_last4: '', expires: null, renewed_at: null },
            nationality_choice_made: null, notes: '',
            created_at: now, updated_at: now },
          { id: idSayaka, relationship: 'spouse',
            name_en: HH.spouse.name_en, name_jp: HH.spouse.name_jp,
            birth_date: HH.spouse.birth_year + '-04-18',
            citizenships: ['JP'], jp_resident: true, ssn_or_itin: 'itin',
            passport_us: { number_last4: '', expires: null, renewed_at: null },
            passport_jp: { number_last4: '3002', expires: isoDateMonthsAhead(28), renewed_at: isoDateYearsAgo(5) },
            nationality_choice_made: null, is_emergency_contact: true,
            notes: 'JP-side filing handled by spouse (small income from part-time work).',
            created_at: now, updated_at: now },
        ],
        renunciation: { contemplating: false, target_year: null,
          consultation_complete: false, estimated_net_worth_usd: null,
          estimated_avg_tax_5y_usd: null, notes: '' },
        gifts_log: [],
      },
      veteran: {
        service: {
          branch: 'army', component: 'active',
          entry_date: (HH.primary.birth_year + 22) + '-09-15',
          discharge_date: null,
          discharge_type: null,
          final_rank: 'SGT (E-5)',
          mos_rating: '25B — Information Technology Specialist',
          retired: false,
        },
        disability: {
          overall_rating_pct: 0, monthly_compensation_usd: 0,
          individual_unemployability: false, last_evaluation_date: null,
          conditions: [],
        },
        healthcare: {
          tricare_eligible: true, tricare_plan: 'prime',
          fmp_enrolled: false, chappy_17: false,
        },
        education: {
          benefit_type: 'post_911', months_remaining: 36,
          expiration_date: null, transferred: false,
        },
        survivor: { sgli_amount: 500000, vgli_amount: null },
        dd214Stored: false, vaRating: null,
        notes: 'Active duty — full SGLI active. VGLI conversion not yet relevant.',
      },
      property: { properties: [], preferences: { show_summary_currency: 'usd' } },
      resident: {
        residency: { arrival_date: isoDateYearsAgo(4), juminhyo_date: null,
          visa_status: null, permanent_residency: false, pr_application_filed: null },
        furusato: { prior_year_income_jpy: null, prior_year_dependents: 0, donations_planned_jpy: 0 },
        mortgage: { has_jp_mortgage: false, purchase_year: null, loan_balance_jpy: null, loan_type: null },
        nhi: { enrolled: false, prior_year_assessment_jpy: null },
      },
      healthcare: {
        medicare: { enrolled_a: false, enrolled_b: false, enrolled_d: false,
          part_b_premium_monthly_usd: null, part_b_decision: null,
          part_b_decision_notes: '', irmaa_tier: null },
        ltc: { applies: false, care_level: null, monthly_premium_jpy: null,
          funding_strategy_notes: 'Under 40 — 介護保険 not yet applicable.' },
        end_of_life: { organ_donor_us: true, organ_donor_jp: null,
          dnr_preference: null, funeral_preference_notes: '' },
        private: { type: 'none', custom_name: '', monthly_premium_usd: null,
          monthly_premium_jpy: null, employer_paid: null,
          notes: 'TRICARE Prime via active duty — no private layer needed.' },
        monthly_budget: { nhi_jpy: null, shi_jpy: null,
          tricare_usd: 0, medicare_b_usd: null, medicare_d_usd: null,
          ltc_jpy: null, private_us_usd: null, notes: 'TRICARE Prime free for active duty.' },
        coverage_types: ['tricare'],
      },
      health_tracker: {
        exams: [{
          id: uuid('exam'),
          date: isoDateMonthsAhead(-1).slice(0, 10),
          type: 'physical',
          provider: 'Dr. Sample Military Physician',
          facility: 'Sample MTF (Military Treatment Facility)',
          location: 'Yokota AB',
          vitals: { weight_kg: 62.0, height_cm: 165, bp_systolic: 116, bp_diastolic: 72,
            heart_rate_bpm: 58, temp_c: 36.4, respiratory_rate: 12, spo2_pct: 99, bmi: 22.8 },
          lab_results: [
            { name: 'Total Cholesterol', value: 162, unit: 'mg/dL', range_low: 0, range_high: 200, flag: 'normal' },
            { name: 'LDL', value: 88, unit: 'mg/dL', range_low: 0, range_high: 100, flag: 'normal' },
            { name: 'HDL', value: 62, unit: 'mg/dL', range_low: 40, range_high: 999, flag: 'normal' },
            { name: 'HbA1c', value: 5.1, unit: '%', range_low: 0, range_high: 5.6, flag: 'normal' },
          ],
          diagnoses: [],
          procedures: ['Annual PHA', 'Lipid panel', 'A1c'],
          followup: 'Routine. Cleared for full duty.',
          notes: 'Annual PHA at MTF.',
        }],
        medications: [],
        care_plan: {
          primary_concerns: [], annual_goals: [],
          preventive_screenings_due: [],
          specialist_referrals: [], next_appointments: [],
        },
        dental: {
          last_cleaning: isoDateMonthsAhead(-4).slice(0, 10),
          last_xrays: isoDateMonthsAhead(-4).slice(0, 10),
          last_perio: null,
          dentist: '', clinic: 'Sample MTF Dental',
          procedures: [], issues_tracked: [],
          providers: [], appointments: [], notes_log: [], teeth: {},
          periodontal: {},
        },
        insurance_summary: {
          primary_plan: 'TRICARE Prime (active duty)',
          member_id_last4: '3001',
          bin: '', pcp_name: 'Dr. Sample Military Physician', pcp_phone: '+81-3-XXXX-XXXX',
          notes: 'Active duty + dependent — TRICARE Prime.',
          cards: [],
        },
        preferences: { units: 'metric', track_trends: true, default_lab_panel: 'cmp' },
        episodes: [], invoices: [],
        ui_state: { active_tab: 'dashboard' },
      },
      sofa: {
        profile: {
          role: 'military',
          sofa_status: 'active',
          separation_date: '',
          jp_residency_plan: 'undecided',
          juminhyou_target_date: '',
          filing_status: 'mfs',
          spouse_us_person: 'no',
          has_minor_children: 'no',
          notes: 'Active duty. Considering staying in JP after separation but not committed.',
        },
        tax_assumptions: {
          us_marginal_pct: 12, us_ltcg_pct: 0,  // 0% LTCG bracket while active enlisted
          jp_marginal_pct: 23, jp_ltcg_pct: 20.315,
        },
        steps: [],
        acks: { disclaimer_version: 'v0.3.0', consulted_cpa: false, consulted_cpa_at: null },
      },
      projections: defaultProjectionsForAge(32, 'mfs', 58000, 4200, 60),
      decumulation: {
        retirement_horizon: 'gt30y',
        ss_claiming: { chosen_age: null, estimated_monthly_at_chosen_age_usd: null,
          spouse_strategy: null, notes: '30+ years out — revisit closer to 50.' },
        jp_pension: { kokumin_nenkin_years: null, kosei_nenkin_years: null,
          kosei_estimated_monthly_jpy: null, kokumin_estimated_monthly_jpy: null,
          has_japan_coverage_certificate: true,
          notes: 'SOFA — covered by US SS via totalization agreement.' },
        withdrawal: { jp_resident_at_retirement: null, preferred_strategy: null,
          notes: '' },
        rmd_planning: { convert_pre_rmd: null, qcd_planned: null, notes: '' },
      },
      tax_coordinator: {
        filing_status: 'mfs', feie_or_ftc_choice: 'undecided',
        jp_filing_responsibility: 'spouse',
        preparer: {
          name: 'MilTax (free military tax software)',
          contact: '',
          notes: 'Self-files via MilTax annually. No CPA yet.',
          next_appointment: null,
        },
        manual_overrides: {
          has_pfic: false, has_foreign_corp: false,
          self_employed: false, paid_jp_tax_prior_year: false,
          has_non_sofa_jp_income: false,
        },
        forms_filed_history: { [lastYear]: ['1040'] },
        notes: 'Simple return — W-2 + small spouse interest. No FBAR yet (under threshold).',
      },
      estate: {
        status: {
          last_beneficiary_review: isoDateYearsAgo(1),
          last_will_review: null,
          will_us_status: 'none', will_jp_status: 'none',
          executor_us: '', executor_jp: '',
          notes: 'Young household — no will yet. Tool flagged this as a SOFA-status priority.',
        },
        beneficiaries: { overrides: {} },
        letter_of_instruction: {
          funeral_preferences: '',
          pet_instructions: '',
          digital_accounts_note: '',
          important_contacts: [],
          additional_notes: '', last_generated: null,
        },
        jp_inheritance_assumptions: {
          expects_kominka: false, expects_business_succession: false,
          has_jp_real_estate_residence: false,
          estimated_other_jp_assets_jpy: null, estimated_other_us_assets_usd: null,
        },
      },
      documentVault: {
        items: [
          { id: uuid('doc'), category: 'identification', type: 'passport_us',
            title: 'US Passport — ' + HH.primary.name_en,
            person_name: HH.primary.name_en, issuing_authority: 'US Dept of State',
            issue_date: isoDateYearsAgo(2), expiry_date: isoDateMonthsAhead(64),
            reference_number_last4: '3001', storage_location: 'Home — locked drawer',
            notes: '', created_at: now, updated_at: now },
          { id: uuid('doc'), category: 'military_sofa', type: 'sofa_orders',
            title: 'SOFA orders + dependent ID',
            person_name: HH.primary.name_en, issuing_authority: 'US Army',
            issue_date: isoDateYearsAgo(4), expiry_date: null,
            reference_number_last4: '', storage_location: 'Home — locked drawer + base copy',
            notes: '', created_at: now, updated_at: now },
        ],
      },
      consultations: { professionals: [], consultations: [], suggested_starting_point: null },
      fx_banking: defaultFxBanking(['usaa', 'wise'], 800, 120000),
      action_center: { dismissed: {} },
      net_worth: defaultNetWorth(),
      sharing: defaultSharing(),
      ai_assistant: defaultAiAssistant(),
      settings: defaultSettings(),
    };
  }

  // ─── Defaults shared by both profiles ─────────────────────────────
  function defaultProjectionsForAge(currentAge, filingStatus, salary, ssMonthly, retireAge) {
    return {
      inputs: {
        base_salary_usd: salary, salary_growth_pct: 3.0,
        contrib_401k_pct: 15.0, catch_up_at_50: true, employer_match_max_pct: 6.0,
        current_age: currentAge, retire_age: retireAge,
        ss_start_age: 70, ss_monthly_at_70_usd: ssMonthly,
        withdrawal_rate_pct: 4.0, monthly_target_usd: null,
        growth_equity_us_pct: 7.0, growth_equity_intl_pct: 6.0,
        growth_bond_pct: 4.0, growth_cash_pct: 4.5,
        growth_real_estate_pct: 4.0, growth_alternative_pct: 6.0,
        retirement_growth_dampener_pct: 70, retirement_growth_floor_pct: 4.0,
        drawdown_order: [
          'taxable_brokerage', 'us_savings', 'us_checking',
          'jp_savings', 'jp_checking', 'jp_fixed_deposit',
          'traditional_ira', 'traditional_401k_tsp',
          'hsa', 'roth_ira', 'roth_401k',
          '529', 'us_real_estate',
          'rsu_unvested', 'nso_iso', 'deferred_comp', 'other',
        ],
        project_to_age: 95, roth_conversions: [],
        filing_status: filingStatus, state_tax_pct: 0,
        niit_enabled: true, irmaa_enabled: true,
        medicare_part_b_base_monthly: 202.90,
        ss_cola_pct: 2.5,
        bonus_month: 3, bonus_pct_of_salary: 8,
        rsu_vest_months: [],
      },
      ui_state: {
        active_tab: 'projection', chart_mode: 'full',
        scenario_id: null, inflation_view: 'nominal',
        inflation_pct: 2.5, year_filter: null,
        chart_hover_year: null, primary_currency: 'usd',
      },
      scenarios: [],
    };
  }
  function defaultFxBanking(platforms, monthlyUsd, monthlyJpy) {
    return {
      rate_alerts: [{
        id: uuid('alert'), direction: 'gt',
        threshold_jpy_per_usd: 162, active: true,
        last_triggered_at: null,
        label: 'Convert savings to JPY if rate goes above ¥162',
      }],
      preferences: {
        primary_platform: platforms[0] || 'wise',
        monthly_estimate_usd: monthlyUsd,
        show_all_platforms: false,
        calc_direction: 'usd_to_jpy',
        monthly_estimate_jpy: monthlyJpy,
      },
      recorded_fees: {}, platforms_used: platforms,
    };
  }
  function defaultNetWorth() {
    return {
      preferences: {
        chart_currency: 'usd', chart_range: 'all',
        auto_snapshot_on_fbar: true, auto_snapshot_year_end: true,
      },
      reviews: [], annual_reports: [],
    };
  }
  function defaultSharing() {
    return {
      shares_log: [],
      preferences: {
        spouse_include_balances: true,
        spouse_include_documents: true,
        spouse_include_action_items: true,
        advisor_include_balances: true,
        advisor_include_documents_list: true,
        advisor_anonymize_family: false,
      },
    };
  }
  function defaultAiAssistant() {
    return {
      conversations: [], active_conversation_id: null,
      preferences: {
        include_full_state: true, max_state_chars: 8000,
        suggested_questions_dismissed: false, show_disclaimer: true,
      },
    };
  }
  function defaultSettings() {
    return {
      apiKey: '', model: 'claude-sonnet-4-6', language: 'en',
      lastExportAt: null, disclaimer_acks: {},
      module_customizations: {}, dashboard_modules: {},
      usage: {
        daily: {}, daily_limit_usd: 5,
        all_time: {
          input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0,
          by_feature: {}, by_model: {},
        },
      },
      fx: {},
    };
  }

  // ─── Dispatch ─────────────────────────────────────────────────────
  function buildSampleState(profileId) {
    if (profileId === 'resident')   return buildResidentProfile();
    if (profileId === 'retiree')    return buildRetireeProfile();
    if (profileId === 'active_mil') return buildActiveMilitaryProfile();
    // Default and back-compat: 'sofa' is the original demo.
    return buildSofaProfile();
  }

  function activeProfile() {
    try {
      const raw = localStorage.getItem(TB.state.STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed._demo ? (parsed._demo.profile || 'sofa') : null;
    } catch (_) { return null; }
  }

  function isDemoActive() { return !!activeProfile(); }

  function loadProfile(profileId) {
    const state = buildSampleState(profileId);
    TB.state.import(JSON.stringify(state));
    location.reload();
  }

  function loadInteractive() {
    openProfilePicker();
  }

  function exit() {
    const t = (TB.i18n && TB.i18n.t) ? TB.i18n.t : ((k) => k);
    if (!confirm(t('demo.confirm.exit'))) return;
    TB.state.clearAll();
    location.reload();
  }

  // ─── Profile picker modal ─────────────────────────────────────────
  function openProfilePicker() {
    const t = (TB.i18n && TB.i18n.t) ? TB.i18n.t : ((k) => k);
    const lang = (TB.i18n && TB.i18n.getLang) ? TB.i18n.getLang() : 'en';
    let root = document.getElementById('tb-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tb-modal-root';
      document.body.appendChild(root);
    }
    const el = (TB.utils && TB.utils.el) ? TB.utils.el : null;
    if (!el) return; // shouldn't happen post-boot
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', {
      class: 'tb-modal',
      style: { maxWidth: '640px', maxHeight: '88vh', overflow: 'auto' },
      role: 'dialog', 'aria-modal': 'true',
    });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 'var(--tb-sp-3)', gap: 'var(--tb-sp-3)' },
    },
      el('h2', { style: { margin: 0 } }, '🧪 ' + t('demo.picker.title')),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 10px' },
        onclick: close, 'aria-label': t('overlay.close'),
      }, '✕'),
    ));
    modal.appendChild(el('p', null, t('demo.picker.intro')));
    modal.appendChild(el('p', { class: 'tb-field-help' }, t('demo.picker.warning')));

    PROFILES.forEach((p) => {
      const label = lang === 'ja' ? p.label_jp : p.label_en;
      const desc  = lang === 'ja' ? p.desc_jp  : p.desc_en;
      modal.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
          borderLeft: '4px solid var(--tb-accent, var(--tb-track-fx))',
        },
      },
        el('div', { style: { display: 'flex', justifyContent: 'space-between',
          alignItems: 'baseline', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } },
          el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-16)' } }, label),
          el('button', {
            class: 'tb-btn', type: 'button',
            onclick: () => {
              if (!confirm(t('demo.confirm.overwrite'))) return;
              close();
              loadProfile(p.id);
            },
          }, t('demo.picker.load')),
        ),
        el('p', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } }, desc),
      ));
    });

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Persistent "DEMO DATA" banner ─────────────────────────────────
  function paintBannerIfDemo() {
    const profileId = activeProfile();
    if (!profileId) return;
    if (document.querySelector('.tb-demo-banner')) return;
    const t = (TB.i18n && TB.i18n.t) ? TB.i18n.t : ((k) => k);
    const lang = (TB.i18n && TB.i18n.getLang) ? TB.i18n.getLang() : 'en';
    const profile = PROFILES.find((p) => p.id === profileId);
    const label = profile
      ? (lang === 'ja' ? profile.label_jp : profile.label_en)
      : profileId;
    const banner = document.createElement('div');
    banner.className = 'tb-demo-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      '<strong>🧪 ' + t('demo.banner.label') + '</strong> ' +
      '<span>' + t('demo.banner.body', { profile: label }) + '</span>' +
      '<button type="button" class="tb-demo-banner__exit" ' +
        'aria-label="' + t('demo.banner.exit') + '">' +
        t('demo.banner.exit') + ' ✕</button>';
    if (document.body.firstChild) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.body.appendChild(banner);
    }
    const exitBtn = banner.querySelector('.tb-demo-banner__exit');
    if (exitBtn) exitBtn.addEventListener('click', exit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintBannerIfDemo);
  } else {
    paintBannerIfDemo();
  }

  window.TB = window.TB || {};
  window.TB.sampleData = {
    PROFILES,
    buildSampleState, loadProfile, loadInteractive,
    exit, isDemoActive, activeProfile,
  };
})();
