/* Taigan Bridge — state.js
 *
 * Single namespaced object in localStorage under "taigan-bridge-state".
 * Exposes get(path), set(path, value), subscribe(callback),
 * export(), import(json). Includes a state-version field so we can
 * migrate the shape between releases.
 *
 * Vanilla, no dependencies. Attaches to the global TB.state.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'taigan-bridge-state';
  const CURRENT_VERSION = 4;

  const DEFAULT_STATE = Object.freeze({
    version: CURRENT_VERSION,
    onboarding: {
      complete: false,
      answers: {},
      completedAt: null,
    },
    tracks: [],
    modules: { unlocked: [] },
    profile: {
      displayName: '',
      displayNameJa: '',
    },
    // Normalized FBAR tables. See docs/ARCHITECTURE.md "FBAR data model".
    fbar: {
      filers: [],            // { id, name_en, name_jp, ssn_last4, dob, relationship, isMinor, isUSPerson, filing_address, notes }
      accounts: [],          // { id, filer_ids[], account_type, institution_name, institution_address, account_number_masked, account_number_full, currency, country, opened_year, closed_year, signatory_only, notes }
      yearly_balances: [],   // { id, account_id, year, max_balance_native, max_balance_date, fx_rate_used, fx_rate_source, fx_rate_overridden, max_balance_usd, notes }
      filing_history: [],    // { id, filer_id, year, filed_on, bsa_id, method, notes }
    },
    // Asset & Portfolio Tracker — canonical store for all accounts.
    // SOFA Roth Planner derives its rollup from this list (see
    // TB.assets.aggregateForSofa) so balances are entered ONCE.
    //
    // Account record shape:
    //   id                : string (uuid)
    //   institution       : string (Empower, Schwab, Yokohama Bank, etc.)
    //   name              : string (display name — e.g. "Roth 401(k)")
    //   country           : 'US' | 'JP' | 'OTHER'
    //   tax_wrapper       : 'traditional_ira' | 'traditional_401k_tsp' | 'roth_ira' |
    //                       'roth_401k' | 'taxable_brokerage' | 'hsa' |
    //                       'rsu_unvested' | 'nso_iso' | 'deferred_comp' |
    //                       'us_real_estate' | 'jp_savings' | 'jp_checking' |
    //                       'jp_fixed_deposit' | '529' | 'other'
    //   currency          : ISO-4217 code ('USD', 'JPY', 'EUR', …)
    //   balance_native    : number — current balance in the account's currency
    //   basis_native      : number | null — cost basis in same currency
    //                       (only for taxable_brokerage / us_real_estate)
    //   notes             : string
    //   updated_at        : ISO-8601 date — last user edit of balance
    //   active            : boolean — soft-delete flag (closed/archived)
    //   include_in_sofa   : boolean — exclude 529s, kids' accounts, etc.
    //   close_date        : ISO-8601 | null — CD maturity / planned close
    //   transfer_to       : string | null — target account name on close
    //   beneficiary       : string | null — POD / TOD / 受取人 (free-form,
    //                       can be a person's name, trust, or organization)
    //   account_number_last4 : string | null — last 4 digits, for "the
    //                          one ending in 1234" disambiguation
    //   allocation        : { equity_us, equity_intl, bond, cash,
    //                         real_estate, alternative } — decimals 0-1.
    //                       When all-zero, the wrapper default is used.
    //   fbar_account_id   : string | null — when set, this Assets
    //                       record is a derivative of an FBAR account.
    //                       Institution / currency / last4 / balance
    //                       are auto-synced from FBAR; user-only
    //                       fields (tax_wrapper, allocation, beneficiary,
    //                       include_in_sofa) stay user-controlled.
    //
    // assets.target_allocation: same shape as per-account allocation;
    //   when set, the summary card shows drift deltas.
    //
    // assets.snapshots[]: { id, taken_at, label, total_usd, allocation,
    //   accounts: [{ account_id, institution, name, country, tax_wrapper,
    //   currency, balance_native, balance_usd, allocation }] }
    assets: { accounts: [], target_allocation: null, snapshots: [] },
    // Financial projections — see modules/projections.js. Inputs are
    // user-editable; balances + allocation are pulled live from
    // assets.accounts so there's no double entry. ui_state holds
    // per-session view choices (active tab, chart mode, zoom range).
    projections: {
      inputs: {
        // Career
        base_salary_usd: 137000,
        salary_growth_pct: 3.0,
        contrib_401k_pct: 15.0,
        catch_up_at_50: true,
        employer_match_max_pct: 10.0,
        // Retirement timing
        current_age: 47,
        retire_age: 60,
        ss_start_age: 70,
        ss_monthly_at_70_usd: 4800,
        // Draw
        withdrawal_rate_pct: 4.0,
        monthly_target_usd: null,
        // Per-class growth (applied weighted by each account's allocation)
        growth_equity_us_pct: 7.0,
        growth_equity_intl_pct: 6.0,
        growth_bond_pct: 4.0,
        growth_cash_pct: 4.5,
        growth_real_estate_pct: 4.0,
        growth_alternative_pct: 6.0,
        retirement_growth_dampener_pct: 70,
        retirement_growth_floor_pct: 4.0,
        // Drawdown sequencing — array of tax_wrapper IDs in priority
        // order. Standard tax-efficient default (taxable first, then
        // pre-tax, then Roth last). User can reorder.
        drawdown_order: [
          'taxable_brokerage', 'us_savings', 'us_checking', 'us_cd',
          'us_savings_bond', 'us_treasury',
          'jp_savings', 'jp_checking', 'jp_fixed_deposit',
          'traditional_ira', 'traditional_401k_tsp',
          'hsa', 'roth_ira', 'roth_401k',
          '529', 'us_real_estate',
          'rsu_unvested', 'nso_iso', 'deferred_comp', 'other',
        ],
        project_to_age: 95,
        // Phase 3 — Roth conversion ladder. Each entry moves
        // `amount_usd` from a Traditional wrapper to a Roth wrapper
        // in calendar year `year`, generating ordinary income at the
        // user's US (and post-住民票, JP) marginal rates. Empty by
        // default. Edited via Tax Strategy tab → Conversion editor.
        roth_conversions: [],
        // ── Phase 4 — additional tax accuracy ──────────────────────
        // Filing status drives NIIT and IRMAA thresholds. Defaults to
        // 'mfj' (most common); user can override per scenario.
        filing_status: 'mfj',          // 'single' | 'mfj' | 'mfs' | 'hoh'
        // State income tax — flat % applied to all taxable income.
        // Default 0 = non-resident / income-tax-free state. Real users
        // set their own (e.g., CA 9.3%, NY 6.85%, NJ 6.37%, FL/TX 0%).
        state_tax_pct: 0,
        // NIIT — 3.8% on investment income above MAGI thresholds.
        niit_enabled: true,
        // IRMAA — Medicare Part B+D surcharges starting age 65 based
        // on MAGI two years prior. Per-person; we model the user only.
        irmaa_enabled: true,
        medicare_part_b_base_monthly: 175,  // 2024 standard premium
        // Social Security COLA — annual inflation adjustment to SS
        // benefits during distribution years. Separate from general
        // inflation_pct so the user can model "what if SS COLA is
        // suppressed" scenarios.
        ss_cola_pct: 2.5,
        // ── Real monthly events (drive the per-month breakdown) ────
        // Bonus paid in this calendar month (1-12) as % of base salary.
        // 0 = no bonus.
        bonus_month: 3,
        bonus_pct_of_salary: 0,
        // RSU vest months — array of 1-12 values. Quarterly-vest
        // schedules are common (3, 6, 9, 12). Empty array = monthly
        // view spreads contributions evenly.
        rsu_vest_months: [3, 6, 9, 12],
      },
      // Phase 2 — inflation assumption + view toggle.
      // inflation_view: 'nominal' (raw future $) | 'real' (today's $).
      // Phase 3 — year_filter restricts chart x-range; table stays full.
      // Phase 4 — primary_currency drives the dollar/yen display:
      //   'usd' → "$1,234,567 (¥187,654,090)" with the yen clickable
      //   'jpy' → "¥187,654,090 ($1,234,567)" with the dollar clickable
      ui_state: {
        active_tab: 'projection',
        chart_mode: 'full',
        scenario_id: null,           // active scenario, null = working draft
        inflation_view: 'nominal',
        inflation_pct: 2.5,
        year_filter: null,           // { from, to } | null
        chart_hover_year: null,      // remembered hover year (sticks last value)
        primary_currency: 'usd',
      },
      // Saved scenarios: { id, name, created_at, inputs }. The
      // currently-displayed inputs live in projections.inputs above;
      // saving snapshots them here. "Active" = the scenario the user
      // last loaded; user changes show as "(unsaved)" until re-saved.
      scenarios: [],
    },
    // SOFA Roth Sequencing Planner — see docs/ARCHITECTURE.md (forthcoming)
    // and modules/sofa-roth.js for the domain model. The window between
    // active SOFA status and 住民票 (juminhyou) registration in Japan is
    // where tax-efficient sequencing of Roth conversions, capital-gains
    // realization, RSU/option exercises, and US asset moves happens.
    // Misordering these steps is "extraordinarily costly" — the tool
    // exists to surface the window and the action checklist.
    sofa: {
      profile: {
        role: '',                     // 'military' | 'dod_civilian' | 'dod_contractor' | 'family_member'
        sofa_status: '',              // 'active' | 'transitioning' | 'post_sofa'
        separation_date: '',          // YYYY-MM-DD — when SOFA orders / employment end
        jp_residency_plan: '',        // 'stay' | 'leave' | 'undecided'
        juminhyou_target_date: '',    // YYYY-MM-DD — planned 住民票 registration if staying
        filing_status: '',            // 'single' | 'mfj' | 'mfs' | 'hoh'
        spouse_us_person: '',         // 'yes' | 'no' | 'na'
        has_minor_children: '',       // 'yes' | 'no'
        notes: '',
      },
      // NOTE: As of v4, account balances live in `assets.accounts[]`
      // (canonical store). SOFA derives its rollup via
      // TB.assets.aggregateForSofa() — no per-wrapper fields here.
      //
      // Tax bracket assumptions (user-supplied or sensible defaults).
      tax_assumptions: {
        us_marginal_pct: null,
        us_ltcg_pct: null,
        jp_marginal_pct: null,
        jp_ltcg_pct: 20.315,
      },
      // Sequence of planned actions. Each step is generated dynamically
      // from profile+accounts but persisted so user-set status (planned,
      // executed, dismissed) survives reload.
      steps: [
        // { id, type, title_en, title_jp, deadline_iso, severity, status,
        //   amount_usd, account_from, account_to, executed_date,
        //   executed_amount, notes }
      ],
      // Versioned acknowledgments + the triple-confirmation acks.
      acks: {
        disclaimer_version: '',
        consulted_cpa: false,
        consulted_cpa_at: null,
      },
    },
    // Action Center — auto-generated to-do surface that pulls from
    // every other module's state. Persisted bit here is just the
    // user's snooze/dismiss choices. dismissed maps action id →
    // { until: ISO } so an "I know, stop showing me" click suppresses
    // the item until a defined date (typically next year for annual
    // recurring items like FBAR April 15).
    action_center: {
      dismissed: {},  // { actionId: { until: 'YYYY-MM-DD' } }
    },
    // Long-Term Resident module — for non-SOFA Americans who are JP
    // tax residents. Tracks: residency arrival/visa/PR status,
    // furusato nozei limit + planned donations, mortgage credit
    // (住宅ローン控除) details, NHI awareness. Action Center watches
    // for 確定申告 deadline, PR eligibility year, 10-year worldwide-
    // asset clock countdown.
    resident: {
      residency: {
        arrival_date: null,        // when first arrived in Japan
        juminhyo_date: null,       // 住民票 registration date
        visa_status: null,         // 'work' | 'spouse_jp' | 'long_term' | 'permanent' | 'cultural' | 'other'
        permanent_residency: false,
        pr_application_filed: null, // date filed (if pending)
      },
      furusato: {
        prior_year_income_jpy: null,
        prior_year_dependents: 0,
        donations_planned_jpy: 0,
      },
      mortgage: {
        has_jp_mortgage: false,
        purchase_year: null,
        loan_balance_jpy: null,
        loan_type: null,           // 'standard' | 'long_term' | 'energy_efficient'
      },
      nhi: {
        enrolled: false,
        prior_year_assessment_jpy: null,
      },
    },
    // Veteran module — service record + VA benefits tracking for US
    // veterans living in Japan. Action Center watches for expiring
    // GI Bill, DD-214 not in vault, VGLI conversion deadline, etc.
    veteran: {
      service: {
        branch: null,            // 'army' | 'navy' | 'air_force' | 'marines' | 'coast_guard' | 'space_force'
        component: null,         // 'active' | 'reserve' | 'national_guard' | 'irr'
        entry_date: null,        // YYYY-MM-DD
        discharge_date: null,    // YYYY-MM-DD
        discharge_type: null,    // 'honorable' | 'general' | 'oth' | 'bcd' | 'dishonorable'
        final_rank: '',
        mos_rating: '',          // job specialty / rate
        retired: false,
      },
      disability: {
        overall_rating_pct: 0,           // 0-100 (in 10% increments per VA standard)
        monthly_compensation_usd: 0,
        individual_unemployability: false, // IU/TDIU — paid at 100% rate even if rated <100%
        last_evaluation_date: null,
        conditions: [],          // [{ id, name, rating_pct, service_connected, effective_date }]
      },
      healthcare: {
        tricare_eligible: false,
        tricare_plan: null,      // 'prime' | 'select' | 'tricare_for_life' | 'overseas' | 'us_family_health_plan'
        fmp_enrolled: false,     // VA Foreign Medical Program for service-connected conditions
        chappy_17: false,        // Chapter 17 indigent vet healthcare
      },
      education: {
        benefit_type: null,      // 'post_911' | 'montgomery' | 'forever_gi_bill' | 'none'
        months_remaining: null,  // out of 36
        expiration_date: null,   // 15-year limit applies to those discharged before 2013
        transferred: false,      // benefits transferred to dependents
      },
      survivor: {
        sgli_amount: null,       // active duty / drill — lapses 120d after separation
        vgli_amount: null,       // post-separation conversion ($400K max)
      },
      // Legacy fields kept for back-compat with v0.x state.
      dd214Stored: false,
      vaRating: null,
      notes: '',
    },
    // Sharing & Backup — generates shareable views for the demographic's
    // typical secondary consumers: spouses (read-only HTML snapshot),
    // survivors (extended LoI as standalone HTML), CPAs/advisors
    // (tax-relevant subset as JSON). Plus full state backup/import.
    //
    //   shares_log: [{ id, type, generated_at, scope_summary, filename }]
    //   preferences: tunables for what each share type includes
    sharing: {
      shares_log: [],
      preferences: {
        spouse_include_balances: true,
        spouse_include_documents: true,
        spouse_include_action_items: true,
        advisor_include_balances: true,
        advisor_include_documents_list: true,
        advisor_anonymize_family: false,
      },
    },
    // Consultation Tracker — log of professionals engaged (CPAs,
    // 税理士, lawyers, immigration attorneys) + per-consultation
    // notes. Surfaces "have you consulted on X?" prompts based on
    // user state (PFIC detected → CPA recommended; renunciation
    // contemplated → specialist recommended; etc.)
    //
    //   professionals: [{ id, name, type, firm, contact, city,
    //     jurisdiction, specialty, retainer_status, notes,
    //     created_at, updated_at }]
    //   consultations: [{ id, professional_id, date, topic,
    //     summary, follow_up_needed, follow_up_date,
    //     related_module, notes }]
    consultations: {
      professionals: [],
      consultations: [],
      // suggested_starting_point — pre-fill from Onboarding v2's
      // consultations_history answer. Used by the Consultations module
      // to render a relevant CTA on first open ('Add your CPA's
      // contact?' for cpa_us_intl users, 'Find a CPA' for no_yet, etc.)
      suggested_starting_point: null,
    },
    // Real Estate / Property — both JP and US property holdings.
    // Single `properties` array with country flag (rather than separate
    // arrays) so the comparison + situs analysis can iterate uniformly.
    //
    // Each property record:
    //   id, label, country ('JP' | 'US' | 'OTHER'), currency,
    //   type ('primary_residence' | 'rental' | 'vacation' | 'kominka' |
    //         'inherited' | 'land' | 'other'),
    //   purchase_date, purchase_price_native, current_value_native,
    //   address, square_meters,
    //   structure_type (JP only: 'wood' | 'rc' | 'src' | 'steel' | 'other'),
    //   mortgage_balance_native, mortgage_rate_pct, mortgage_remaining_years,
    //   annual_property_tax_native, annual_city_tax_native,
    //   annual_insurance_native, monthly_maintenance_native,
    //   // Rental-specific:
    //   rental_status (null | 'rented' | 'vacant' | 'pending'),
    //   monthly_rent_native, annual_rental_expenses_native,
    //   depreciation_started_year, depreciation_basis_native,
    //   // Sale planning:
    //   planned_sale_year, lived_2_of_5_years (US only — §121 eligibility),
    //   // Estate-side flag — drives 小規模宅地等の特例 eligibility in Estate calc:
    //   is_residential_for_inheritance,
    //   notes
    property: {
      properties: [],
      preferences: {
        show_summary_currency: 'usd',  // 'usd' | 'jpy'
      },
    },
    // FX & Cross-Border Banking — daily-decision module for the
    // routine USD↔JPY questions every JP-resident US person faces:
    // which platform for transfers, when to convert, how to hold
    // multi-currency, what's the actual delivered rate. Leverages
    // the FX fetcher already in utils.js + settings.fx.
    //
    //   rate_alerts   : [{ id, direction: 'gt'|'lt', threshold_jpy_per_usd,
    //                      active, last_triggered_at, label }]
    //   preferences   : { primary_platform, monthly_estimate_usd,
    //                     show_all_platforms }
    //   recorded_fees : optional per-platform user-recorded actuals
    //                   (since published rates drift quarterly)
    fx_banking: {
      rate_alerts: [],
      preferences: {
        primary_platform: null,
        monthly_estimate_usd: null,
        show_all_platforms: false,
      },
      recorded_fees: {},
      // platforms_used — pre-fill from Onboarding v2's fx_platforms
      // multi-select. The FX Banking module uses this to surface the
      // user's actual platforms first (rather than leading with Wise
      // for everyone). Values mirror the onboarding option ids:
      // 'wise' | 'revolut' | 'sony_bank' | 'shinsei' | 'rakuten' |
      // 'remitly' | 'westernunion' | 'usaa' | 'navy_fed' | 'broker' |
      // 'crypto' | 'none'.
      platforms_used: [],
    },
    // Retirement Decumulation — closes the planning loop. Projections
    // models accumulation; this module covers SS claiming strategy,
    // JP pension eligibility, JP-resident-aware withdrawal sequence,
    // RMD planning, and the Social Security Fairness Act repeal of
    // WEP/GPO (late 2024) for 厚生年金 recipients.
    //
    //   ss_claiming   : chosen claim age, monthly estimate, spouse strategy
    //   jp_pension    : 国民年金 + 厚生年金 contribution years + estimates
    //   withdrawal    : JP-resident strategy choice + override
    //   rmd_planning  : pre-RMD Roth conversion intent, QCD planning
    decumulation: {
      // retirement_horizon — pre-fill from Onboarding v2. Drives which
      // sections auto-show in the Decumulation module (RMD planning
      // surfaces for 'already' and 'lt5y'; accumulation-flavored
      // content for 'gt30y'). Values: 'already' | 'lt5y' | '5_15y' |
      // '15_30y' | 'gt30y' | 'unsure'.
      retirement_horizon: null,
      ss_claiming: {
        chosen_age: null,                  // 62-70
        estimated_monthly_at_chosen_age_usd: null,
        spouse_strategy: null,              // 'spousal_first' | 'individual' | 'survivor_max' | null
        notes: '',
      },
      jp_pension: {
        kokumin_nenkin_years: null,         // 国民年金 contribution years
        kosei_nenkin_years: null,           // 厚生年金 contribution years
        kosei_estimated_monthly_jpy: null,
        kokumin_estimated_monthly_jpy: null,
        has_japan_coverage_certificate: false,  // for US SE-tax exemption via totalization
        notes: '',
      },
      withdrawal: {
        jp_resident_at_retirement: null,    // boolean
        preferred_strategy: null,           // 'roth_first' | 'pre_tax_first' | 'tax_diversified' | 'standard'
        notes: '',
      },
      rmd_planning: {
        convert_pre_rmd: null,              // boolean strategy flag
        qcd_planned: null,                   // boolean
        notes: '',
      },
    },
    // Healthcare — orchestration layer over the existing health-related
    // surfaces (resident.nhi, veteran.healthcare) plus net-new state
    // for Medicare, 介護保険, end-of-life preferences, and a monthly
    // premium budget aggregation.
    //
    //   medicare         : US Medicare A/B/D enrollment + Part B
    //                      in-Japan decision tracking. Part B premium
    //                      ($185+/mo in 2026) is paid by every B-enrolled
    //                      person regardless of country, but care abroad
    //                      isn\'t covered — many JP-resident retirees
    //                      pay for nothing. Late-enrollment penalty
    //                      makes the decision asymmetric.
    //   ltc              : 介護保険 (long-term care). Universal in
    //                      Japan at 40+; premium scales with income.
    //                      Tracks care level, funding strategy.
    //   end_of_life      : organ donor flags, DNR preference, funeral
    //                      preferences. Cross-references Document Vault
    //                      for the advance directive document itself.
    //   monthly_budget   : aggregated premium tracking across NHI / SHI
    //                      / TRICARE / Medicare / LTC / private US.
    //                      Driven by user inputs; surfaced as a single
    //                      "you spend $X/mo on healthcare across all
    //                      systems" budget number.
    healthcare: {
      medicare: {
        enrolled_a: false,
        enrolled_b: false,
        enrolled_d: false,
        part_b_premium_monthly_usd: null,
        part_b_decision: null,         // 'enrolled' | 'declined' | 'undecided'
        part_b_decision_notes: '',
        irmaa_tier: null,              // computed elsewhere; stored here for ref
      },
      ltc: {
        applies: null,                 // null = auto from age 40+; true/false override
        care_level: null,              // '要支援1' | '要支援2' | '要介護1' .. '要介護5' | null
        monthly_premium_jpy: null,
        funding_strategy_notes: '',
      },
      end_of_life: {
        organ_donor_us: null,          // boolean
        organ_donor_jp: null,
        dnr_preference: null,          // 'yes' | 'no' | 'limited' | null
        funeral_preference_notes: '',
      },
      // Private / employer-provided international insurance — common
      // for SOFA-exempt expats: DoD contractors, US-company expats,
      // long-term US-company employees with overseas health benefits.
      // CIGNA International, Aetna International, Bupa Global, GeoBlue,
      // and US-employer FEHB are the typical plans. SOFA-status users
      // are NOT required to enroll in NHI/SHI — their coverage usually
      // comes through one of these channels instead.
      private: {
        type: null,                    // 'cigna_intl' | 'aetna_intl' | 'bupa_global' | 'geo_blue' | 'fehb' | 'us_employer' | 'other' | 'none'
        custom_name: '',               // free-form when type === 'other'
        monthly_premium_usd: null,
        monthly_premium_jpy: null,     // some plans bill in JPY
        employer_paid: null,           // 'fully' | 'partially' | 'self'
        notes: '',
      },
      monthly_budget: {
        nhi_jpy: null,
        shi_jpy: null,
        tricare_usd: null,
        medicare_b_usd: null,
        medicare_d_usd: null,
        ltc_jpy: null,
        private_us_usd: null,
        notes: '',
      },
      // coverage_types — multi-select pre-fill from Onboarding v2's
      // healthcare_coverage answer. Surfaces the right banner state in
      // the Healthcare module on first open (e.g., SOFA contractor on
      // CIGNA International gets the right "✓ Private intl" pill rather
      // than a "⚠ Not enrolled" red banner). Values mirror the
      // onboarding option ids: 'nhi' | 'shi' | 'tricare' | 'private_intl'
      // | 'us_employer' | 'medicare' | 'va_fmp' | 'none' | 'unsure'.
      coverage_types: [],
    },
    // ────────────────────────────────────────────────────────────────
    // Health Tracker (v0.37)
    // ────────────────────────────────────────────────────────────────
    //
    // Tactical records-keeping layer. While `healthcare` (above) covers
    // STRATEGIC coverage planning (Medicare timing, NHI vs SHI, EOL
    // preferences, premium budget), `health_tracker` is the
    // operational layer: actual exam results, lab values over time,
    // active medications, care plan, dental log, preventive screenings.
    //
    // Designed for the "upload my lab PDF, see all my history in one
    // place" use case. AI vision extracts structured values from
    // labs/exam reports (consent-gated like every other vision flow).
    //
    // Schema notes:
    //   • exams[]: each exam is a single visit / lab draw / procedure.
    //     Lab results live on the exam, not in a separate global table —
    //     the Lab Results tab queries across exams to build the trend
    //     view. Vitals live on the exam for the same reason.
    //   • medications[]: independent of exams. Includes start/end so
    //     "current vs historical" views work without timestamp queries.
    //   • care_plan: short-term planning surface (concerns, goals,
    //     screenings due). Not coupled to exams.
    //   • dental: separate from exams because dental exams are typically
    //     6-month cadence with their own data shape (X-rays, charting,
    //     procedures) that doesn't fit the medical exam shape.
    //   • insurance_summary: minimal — just enough for an emergency
    //     pull. The deep insurance planning lives in `healthcare`.
    health_tracker: {
      // Exam records. Each exam:
      //   id, date (YYYY-MM-DD), type (physical|blood_panel|imaging|
      //     specialist|emergency|telehealth|other), provider, location,
      //     facility (clinic/hospital name),
      //   vitals { weight_kg, height_cm, bp_systolic, bp_diastolic,
      //     heart_rate_bpm, temp_c, respiratory_rate, spo2_pct, bmi },
      //   lab_results [{ name, value, unit, range_low, range_high,
      //     flag ('normal'|'low'|'high'|'critical'), notes }],
      //   diagnoses [], procedures [], followup, notes,
      //   ai_summary (optional, populated by AI Advisor),
      //   linked_doc_id (Vault back-reference for the source PDF/scan),
      //   linked_consultation_id (Consultations log cross-ref)
      exams: [],
      // Active + historical medications.
      //   id, name (brand), generic_name, dosage, dosage_unit,
      //   frequency (free-form: "twice daily", "as needed", etc.),
      //   route ('oral'|'topical'|'injectable'|'inhaler'|'other'),
      //   started_date, ended_date (null = currently active),
      //   prescriber, pharmacy,
      //   refills_remaining (integer), next_refill_date,
      //   purpose (what condition), side_effects, notes
      medications: [],
      // Active care planning.
      //   primary_concerns [{ id, text, severity, started_date }],
      //   annual_goals [{ id, text, target_date, status }],
      //   preventive_screenings_due [{ id, name, due_date, last_done,
      //     interval_years, notes }] — eg colonoscopy, mammogram,
      //     skin check, etc.
      //   specialist_referrals [{ id, specialty, doctor, requested_date,
      //     completed_date, notes }],
      //   next_appointments [{ id, date, provider, purpose, location }]
      care_plan: {
        primary_concerns: [],
        annual_goals: [],
        preventive_screenings_due: [],
        specialist_referrals: [],
        next_appointments: [],
      },
      // Dental record-keeping.
      //   last_cleaning, last_xrays (date), last_perio (date),
      //   dentist (name), clinic, member_since,
      //   procedures [{ id, date, type, tooth_number, notes, cost_native, currency }],
      //   issues_tracked [{ id, text, started_date, resolved_date }]
      dental: {
        last_cleaning: null,
        last_xrays: null,
        last_perio: null,
        dentist: '',
        clinic: '',
        procedures: [],
        issues_tracked: [],
      },
      // Minimal insurance pointer for emergency pull. The deep
      // insurance planning lives in healthcare.* — this is just the
      // "what's on my card" subset.
      insurance_summary: {
        primary_plan: '',
        member_id_last4: '',
        bin: '',                 // pharmacy BIN if applicable
        pcp_name: '',
        pcp_phone: '',
        notes: '',
      },
      // Module-level preferences.
      preferences: {
        units: 'metric',         // 'metric' | 'imperial'
        track_trends: true,
        default_lab_panel: 'cmp', // 'cmp' | 'cbc' | 'lipid' | 'a1c_full' | 'custom'
      },
      // Care episodes (v0.39) — higher-level grouping that ties
      // together multiple exams + medications + invoices around a
      // single medical event. The motivating example: a colonoscopy
      // screening spans an April pre-procedure consult + a May
      // procedure + a June follow-up + a post-procedure prescription
      // + several invoices. All belong to the same "episode" even
      // though they're separate exam records.
      //
      // Each episode:
      //   id, title (free-form name), status ('active'|'completed'|
      //     'monitoring'|'cancelled'),
      //   category ('screening'|'condition'|'procedure'|'injury'|
      //     'pregnancy'|'other'),
      //   started_date, completed_date,
      //   specialty (e.g., 'gastroenterology'),
      //   provider, facility,
      //   related_condition (free-form clinical note),
      //   exam_ids[], medication_ids[], invoice_ids[],
      //   consultation_ids[]  (cross-link to Consultations module),
      //   vault_doc_ids[]     (cross-link to Document Vault),
      //   notes, outcome,
      //   ai_summary (optional Claude-generated episode-level summary)
      episodes: [],
      // Medical invoices/receipts (v0.39) — separately tracked so they
      // can roll up by episode (total cost of this colonoscopy) or by
      // year (total OOP medical spend). Lives in health_tracker so all
      // medical-related records stay co-located.
      //
      // Each invoice:
      //   id, date, provider, facility,
      //   amount_native, currency (USD/JPY/etc.), amount_usd_calc
      //     (computed at entry time so the historical USD value is
      //     preserved against FX drift),
      //   type ('visit'|'lab'|'procedure'|'rx'|'imaging'|'er'|'other'),
      //   paid (bool), paid_date,
      //   insurance_billed (bool), reimbursement_status
      //     ('na'|'pending'|'submitted'|'received'|'denied'),
      //   reimbursed_native, reimbursed_currency,
      //   episode_id, exam_id, medication_id (cross-refs — all
      //     optional; an invoice can be standalone),
      //   vault_doc_id (cross-link to Document Vault receipt PDF),
      //   notes
      invoices: [],
      // UI state — last-active tab persists across sessions.
      ui_state: {
        active_tab: 'dashboard',
      },
    },
    // Net Worth & Reports — temporal layer over Assets.
    //
    // Snapshots live in assets.snapshots[] (already declared above) so
    // they coexist with the canonical asset records that produced them.
    // Each snapshot freezes total_usd, total_jpy (computed at the FX
    // rate of that moment), and the per-account breakdown.
    //
    // This object holds the cross-cutting preferences + the annual
    // review log + cached report metadata.
    //   preferences.chart_currency       : 'usd' | 'jpy' display toggle
    //   preferences.chart_range          : 'all' | '1y' | '5y' | '10y'
    //   preferences.auto_snapshot_on_fbar : take a snapshot whenever
    //                                       FBAR data changes
    //   preferences.auto_snapshot_year_end: take a snapshot in early Jan
    //   reviews                           : log of annual reviews —
    //                                       [{ id, completed_at, notes,
    //                                         module_states_at_review }]
    //   annual_reports                    : metadata for generated
    //                                       year-end report bundles.
    //                                       The actual Markdown is
    //                                       streamed to the user as a
    //                                       download; we only persist
    //                                       metadata here.
    net_worth: {
      preferences: {
        chart_currency: 'usd',
        chart_range: 'all',
        auto_snapshot_on_fbar: true,
        auto_snapshot_year_end: true,
      },
      reviews: [],
      annual_reports: [],
    },
    // Ask Taigan — AI assistant with full state context. Each chat
    // message includes a generated state-summary digest (markdown, ~2K
    // tokens) so the model can answer questions specific to the user's
    // situation rather than giving generic advice. Conversations are
    // persisted as a personal advisory log.
    //
    //   conversations: [{ id, title, created_at, updated_at, messages: [
    //     { role: 'user' | 'assistant', content, ts }
    //   ] }]
    //   active_conversation_id: currently-open conversation
    //   preferences: tunables for state injection + UI behavior
    ai_assistant: {
      conversations: [],
      active_conversation_id: null,
      preferences: {
        include_full_state: true,
        max_state_chars: 8000,
        suggested_questions_dismissed: false,
        show_disclaimer: true,
      },
    },
    // Estate / Cross-Border Succession — orchestrates death/incapacity
    // planning by reading every other module:
    //   Family roster      → 法定相続人 derivation + statutory shares
    //   Family gifts_log   → 7-year clawback addition to estate
    //   Assets             → situs analysis + beneficiary inventory
    //   Document Vault     → will / POA / advance directive tracking
    //   Resident 10y clock → 永住者 status drives JP worldwide-asset scope
    //   Veteran survivor   → SBP coordination
    //
    // Schema:
    //   status                       : top-line review dates + will status
    //   beneficiaries.overrides      : per-account-id beneficiary records
    //                                  not pulled in from Assets directly
    //                                  (Assets only stores a free-form
    //                                  beneficiary string; Estate tracks
    //                                  primary/contingent + last_reviewed)
    //   letter_of_instruction        : funeral / pet / digital / contacts
    //                                  fields used by the LoI generator
    //   jp_inheritance_assumptions   : user-entered overrides for
    //                                  小規模宅地等の特例 eligibility,
    //                                  business succession, etc.
    estate: {
      status: {
        last_beneficiary_review: null,     // YYYY-MM-DD
        last_will_review: null,            // YYYY-MM-DD
        will_us_status: null,              // 'none' | 'drafted' | 'signed' | 'updated_recent'
        will_jp_status: null,              // 'none' | 'drafted' | 'kosei_shosho' (公正証書)
        executor_us: '',                   // free-form name
        executor_jp: '',                   // free-form name (執行者)
        notes: '',
      },
      beneficiaries: {
        // { account_id: { primary, contingent, percentage,
        //   last_reviewed: 'YYYY-MM-DD', notes } }
        overrides: {},
      },
      letter_of_instruction: {
        funeral_preferences: '',
        pet_instructions: '',
        digital_accounts_note: '',
        important_contacts: [],            // [{ name, relationship, role, contact }]
        additional_notes: '',
        last_generated: null,              // ISO timestamp
      },
      jp_inheritance_assumptions: {
        expects_kominka: false,            // owns 古民家 / small dwelling
        expects_business_succession: false,
        has_jp_real_estate_residence: false, // 小規模宅地等の特例 eligibility
        estimated_other_jp_assets_jpy: null, // assets not in our system
        estimated_other_us_assets_usd: null,
      },
    },
    // Tax Filing Coordinator — orchestrates the year-round US + JP
    // filing calendar. Detects which forms apply by reading other
    // modules (Assets aggregate → 8938 threshold; assets PFIC scan
    // → 8621; onboarding visa/residency → 確定申告; FBAR data → FBAR
    // applicability). State here is small — preparer info, prior-year
    // election history, and manual overrides for things we can't
    // detect automatically (foreign corp ownership, self-employment).
    //
    //   filing_status              : 'single' | 'mfj' | 'mfs' | 'hoh' | 'qw' | null
    //   feie_or_ftc_choice         : 'feie' | 'ftc' | 'both' | 'undecided' | null
    //   jp_filing_responsibility   : 'auto' | 'self' | 'spouse' | 'na' | null
    //                                'auto' (default) derives from onboarding —
    //                                see deriveJpFilingResponsibility() in
    //                                tax-coordinator.js. SOFA contractors with
    //                                a JP-national spouse default to 'spouse'
    //                                (the spouse files her own 確定申告 / 住民税
    //                                / ふるさと納税 — the SOFA holder is exempt
    //                                under SOFA Article 14 ¶7 and unregistered
    //                                under Article 9 ¶2). 'self' / 'spouse' /
    //                                'na' explicitly override the derivation.
    //   preparer                   : { name, contact, notes, next_appointment }
    //   manual_overrides           : flags for things the auto-detector can't
    //                                see (has_pfic, has_foreign_corp,
    //                                self_employed, paid_jp_tax_prior_year)
    //   forms_filed_history        : { 'YYYY': ['1040', '2555', 'fbar', ...] }
    //                                tracked per year so the next-year planning
    //                                inherits last year's choices.
    //   notes                      : free-form
    tax_coordinator: {
      filing_status: null,
      feie_or_ftc_choice: null,
      jp_filing_responsibility: null, // null/undefined = 'auto'
      preparer: {
        name: '',
        contact: '',
        notes: '',
        next_appointment: null,
      },
      manual_overrides: {
        has_pfic: null,
        has_foreign_corp: null,
        self_employed: null,
        paid_jp_tax_prior_year: null,
        // has_non_sofa_jp_income — captured by Onboarding v2's
        // non_sofa_jp_income answer (only asked of SOFA holders). When
        // true, forces 確定申告 to apply even for an otherwise-exempt
        // SOFA contractor (rental income, JP brokerage, etc.).
        has_non_sofa_jp_income: null,
      },
      forms_filed_history: {},
      notes: '',
    },
    // Document Vault — INVENTORY of important documents (passport,
    // will, deeds, tax returns, etc.) with extracted metadata,
    // expiry tracking, and storage location. We DO NOT store the
    // actual file — only extracted fields + a free-form storage
    // location so the user can find the original.
    //   items: [{
    //     id, category, type, title, person_name,
    //     issuing_authority, issue_date, expiry_date,
    //     reference_number_last4, storage_location, notes,
    //     created_at, updated_at
    //   }]
    documentVault: { items: [] },
    // Family module — roster of spouse / children / parents with
    // citizenships, key dates, and dual-nationality tracking. Drives
    // passport-renewal alerts, 国籍選択 (Japanese nationality choice by
    // age 22) deadlines, education savings strategy (529 vs 学資保険),
    // inheritance pre-positioning (暦年贈与 + 教育資金一括贈与 + 結婚・
    // 子育て + 相続時精算課税), and US citizenship renunciation
    // (covered-expatriate + exit-tax) planning.
    //
    // Member record shape:
    //   id                : uuid
    //   relationship      : 'spouse' | 'child' | 'parent' | 'sibling' | 'other'
    //   name_en           : display name (English)
    //   name_jp           : display name (Japanese, optional)
    //   birth_date        : YYYY-MM-DD
    //   citizenships      : ['US'] | ['JP'] | ['US','JP'] | etc.
    //   gender            : optional
    //   jp_resident       : bool — currently lives in Japan
    //   ssn_or_itin       : 'ssn' | 'itin' | 'none' | null
    //   passport_us       : { number_last4, expires, renewed_at }
    //   passport_jp       : { number_last4, expires, renewed_at }
    //   nationality_choice_made : null | 'us' | 'jp' | 'kept_both'
    //   notes             : free-form
    //   created_at, updated_at
    //
    // gifts_log entries: { id, year, recipient_id, amount_jpy,
    //   vehicle: '暦年贈与' | '教育資金一括贈与' | '結婚・子育て' |
    //            '相続時精算課税' | '配偶者控除', notes }
    family: {
      members: [],
      renunciation: {
        contemplating: false,
        target_year: null,
        consultation_complete: false,
        estimated_net_worth_usd: null,
        estimated_avg_tax_5y_usd: null,
        notes: '',
      },
      gifts_log: [],
    },
    settings: {
      apiKey: '',
      model: 'claude-sonnet-4-6',
      language: 'en',
      lastExportAt: null,
      // Versioned per-module disclaimer acknowledgments.
      // Keyed by module id; value is the version string the user
      // acknowledged. Bumping a module's required version re-prompts.
      disclaimer_acks: {},
      // Per-module section visibility overrides. Keyed by module id,
      // then by section id. Each value is a tri-state:
      //   true   — force show (override auto-detection)
      //   false  — force hide
      //   null   — use auto-detection (predicate from the module's
      //            section registry)
      // Lets users explore a section that onboarding didn't unlock
      // (e.g., dual-citizen children section when no kids were
      // declared) without re-running onboarding. Also lets users
      // hide sections they don't want to see.
      module_customizations: {},
      // Dashboard module visibility overrides — same tri-state pattern
      // but at the MODULE (tile) level rather than section level.
      // Keyed by module id; value is true (force show) / false (force
      // hide) / undefined (use derived). Lets users explore modules
      // their onboarding didn't unlock without re-running onboarding.
      dashboard_modules: {},
      // AI usage tracking (populated by TB.ai.recordUsage on every API
      // call). daily is keyed by YYYY-MM-DD; daily_limit_usd is a soft
      // cap (0 = no limit). Each daily/all_time bucket also carries
      // by_feature (FEATURE_IDS in ai-client.js) and by_model
      // sub-buckets so the Settings → Usage Dashboard can break costs
      // down by what triggered them. Older buckets without those
      // sub-objects are treated as "unattributed" for display.
      usage: {
        daily: {},
        daily_limit_usd: 0,
        all_time: {
          input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0,
          by_feature: {},
          by_model: {},
        },
      },
      // API key metadata: when the user last set the key (for the
      // 6-month rotation reminder) and the most recent /v1/messages
      // ping result (for the green/red health badge in Settings).
      api: {
        keySetAt: null,
        lastHealthCheck: null,
      },
      // ai_consent — captured by Onboarding v2's ai_consent question
      // and enforced by ai-client.js → checkConsent() before every
      // network call:
      //   'full'        — all features run without confirmation
      //   'per_call'    — show a one-line consent confirm before each AI call
      //   'vision_only' — allow document-extraction features only
      //                   (fbar_vision, asset_vision, document_vision)
      //   'off'         — disable all AI features (health_check still
      //                   bypasses since it's an explicit user-initiated
      //                   infra test)
      // Defaults to null (treated as 'full' by callers for back-compat
      // with users who haven't run Onboarding v2).
      ai_consent: null,
      // ai_consent_overrides — per-feature force-allow / force-deny
      // that overrides the global posture. Shape:
      //   { feature_id: 'allow' | 'deny' }
      // Where feature_id matches FEATURE_IDS in ai-client.js. 'allow'
      // bypasses the posture (skips per-call prompt; runs even when
      // posture is 'off' or 'vision_only'); 'deny' blocks the feature
      // even when posture is 'full'. Used by power users to e.g.
      // permanently allow asset_enrichment while keeping FBAR vision
      // behind a per-call prompt.
      ai_consent_overrides: {},
      // view_mode — UI polarity. 'user' (default) shows the primary
      // user's perspective: US-side tax filings prominent, JP-side
      // muted-or-hidden for SOFA contractors whose spouse handles JP.
      // 'spouse' INVERTS this: JP-side is primary (確定申告, 住民税,
      // ふるさと納税, NHI, education savings, kids' passports), US-side
      // gets muted "your spouse handles" pills. Used by the primary
      // user to walk through what their spouse needs to do; also drives
      // the bilingual spouse handoff package in Sharing & Backup.
      view_mode: 'user',
      // Accessibility preferences. Applied to <html> at boot:
      //   fontScale     — number in [0.875, 1.5], drives root font-size
      //   highContrast  — bumps borders + ensures focus-visible ring
      //   reducedMotion — collapses transitions/animations
      a11y: {
        fontScale: 1,
        highContrast: false,
        reducedMotion: false,
      },
      // API credit / top-up history. Anthropic credit grants and
      // user-purchased top-ups are logged here so the Settings panel
      // can show a remaining balance. last_reconciled_balance is the
      // user's confirmed actual balance at last_reconciled_at, used
      // to anchor local calculations to Anthropic's source of truth.
      credits: {
        topups: [],
        last_reconciled_at: null,
        last_reconciled_balance: null,
      },
      // Treasury FX rates fetched live from fiscaldata.treasury.gov.
      // Override the hardcoded TREASURY_FX table in fbar.js when
      // present. treasury_rates is keyed by year (string) → { CUR: rate }.
      // treasury_fetched_at is an ISO timestamp of the most recent
      // successful fetch.
      fx: {
        treasury_rates: {},
        treasury_fetched_at: null,
        treasury_fetch_errors: [],
      },
    },
  });

  const subscribers = new Set();
  let cache = null;

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function deepMerge(base, patch) {
    if (Array.isArray(base) || Array.isArray(patch)) return patch;
    if (typeof base !== 'object' || base === null) return patch;
    if (typeof patch !== 'object' || patch === null) return patch;
    const out = Object.assign({}, base);
    for (const key of Object.keys(patch)) {
      out[key] = key in base ? deepMerge(base[key], patch[key]) : patch[key];
    }
    return out;
  }

  function migrate(stored) {
    if (!stored || typeof stored !== 'object') return deepClone(DEFAULT_STATE);
    if (typeof stored.version !== 'number') stored.version = 0;

    // v1 → v2: FBAR shape changed from year-keyed nested
    // (fbar.years[YYYY].accounts) to normalized tables (fbar.filers,
    // fbar.accounts, fbar.yearly_balances, fbar.filing_history).
    // The old shape only existed for ~3 days in dev; no in-place
    // migration is provided. Old fbar data is dropped.
    if (stored.version < 2) {
      stored.fbar = deepClone(DEFAULT_STATE.fbar);
      stored.version = 2;
    }

    // v2 → v3: SOFA Roth Planner schema reshaped from a single
    // `sequence` stub into the full domain model (profile, accounts,
    // tax_assumptions, steps[], acks). The old shape was never
    // exposed to users, so we drop it cleanly.
    if (stored.version < 3) {
      stored.sofa = deepClone(DEFAULT_STATE.sofa);
      stored.version = 3;
    }

    // v3 → v4: Asset & Portfolio Tracker promoted to canonical store.
    // The old `sofa.accounts` flat USD-rollup is converted into
    // individual `assets.accounts[]` records so SOFA can derive the
    // same rollup but balances live in one place.
    if (stored.version < 4) {
      const oldSofa = (stored.sofa && stored.sofa.accounts) || {};
      const seeded = [];
      const now = new Date().toISOString().slice(0, 10);
      const mapping = [
        { f: 'traditional_ira_usd',          name: 'Traditional IRA',         tw: 'traditional_ira' },
        { f: 'traditional_401k_tsp_usd',     name: 'Traditional 401(k) / TSP', tw: 'traditional_401k_tsp' },
        { f: 'roth_ira_usd',                 name: 'Roth IRA',                tw: 'roth_ira' },
        { f: 'roth_401k_usd',                name: 'Roth 401(k)',             tw: 'roth_401k' },
        { f: 'rsu_unvested_value_usd',       name: 'Unvested RSUs',           tw: 'rsu_unvested' },
        { f: 'nso_iso_unrealized_value_usd', name: 'NSO / ISO grants',        tw: 'nso_iso' },
        { f: 'deferred_comp_usd',            name: 'Deferred compensation',   tw: 'deferred_comp' },
        { f: 'hsa_balance_usd',              name: 'HSA',                     tw: 'hsa' },
      ];
      for (const m of mapping) {
        const v = oldSofa[m.f];
        if (v != null && v !== 0) {
          seeded.push({
            id: 'mig-' + m.tw,
            institution: 'Migrated from SOFA',
            name: m.name,
            country: 'US',
            tax_wrapper: m.tw,
            currency: 'USD',
            balance_native: v,
            basis_native: null,
            notes: 'Auto-migrated from earlier SOFA-only entry. Edit institution/name to match your real account.',
            updated_at: now,
            active: true,
            include_in_sofa: true,
            close_date: null,
            transfer_to: null,
          });
        }
      }
      // Taxable brokerage carried both value AND basis — combine.
      if (oldSofa.taxable_brokerage_value_usd != null && oldSofa.taxable_brokerage_value_usd !== 0) {
        seeded.push({
          id: 'mig-taxable',
          institution: 'Migrated from SOFA',
          name: 'Taxable brokerage',
          country: 'US',
          tax_wrapper: 'taxable_brokerage',
          currency: 'USD',
          balance_native: oldSofa.taxable_brokerage_value_usd,
          basis_native: oldSofa.taxable_brokerage_basis_usd != null ? oldSofa.taxable_brokerage_basis_usd : null,
          notes: 'Auto-migrated from earlier SOFA-only entry.',
          updated_at: now,
          active: true,
          include_in_sofa: true,
          close_date: null,
          transfer_to: null,
        });
      }
      // U.S. real estate — same: value + basis pair.
      if (oldSofa.us_real_estate_value_usd != null && oldSofa.us_real_estate_value_usd !== 0) {
        seeded.push({
          id: 'mig-realestate',
          institution: 'Migrated from SOFA',
          name: 'U.S. real estate',
          country: 'US',
          tax_wrapper: 'us_real_estate',
          currency: 'USD',
          balance_native: oldSofa.us_real_estate_value_usd,
          basis_native: oldSofa.us_real_estate_basis_usd != null ? oldSofa.us_real_estate_basis_usd : null,
          notes: 'Auto-migrated from earlier SOFA-only entry.',
          updated_at: now,
          active: true,
          include_in_sofa: true,
          close_date: null,
          transfer_to: null,
        });
      }

      // Merge seeded records into any existing assets.accounts.
      const existing = (stored.assets && Array.isArray(stored.assets.accounts))
        ? stored.assets.accounts : [];
      stored.assets = { accounts: existing.concat(seeded) };

      // Strip the old flat field — SOFA now reads via assets aggregator.
      if (stored.sofa) delete stored.sofa.accounts;
      stored.version = 4;
    }

    // Always merge with defaults to absorb new fields without
    // erasing user data.
    return deepMerge(deepClone(DEFAULT_STATE), stored);
  }

  function load() {
    if (cache) return cache;
    let stored = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (err) {
      console.warn('[tb.state] failed to parse stored state, resetting:', err);
    }
    cache = migrate(stored);
    return cache;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch (err) {
      console.error('[tb.state] failed to persist state:', err);
    }
  }

  function notify(path, value) {
    subscribers.forEach((fn) => {
      try { fn(path, value, cache); }
      catch (err) { console.error('[tb.state] subscriber error:', err); }
    });
  }

  function get(path) {
    const root = load();
    if (!path) return deepClone(root);
    const parts = path.split('.');
    let cur = root;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur === undefined ? undefined : deepClone(cur);
  }

  function set(path, value) {
    const root = load();
    if (!path) {
      cache = migrate(value);
      persist();
      notify('', cache);
      return;
    }
    const parts = path.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
    persist();
    notify(path, value);
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function exportJson() {
    return JSON.stringify(load(), null, 2);
  }

  function importJson(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) { throw new Error('Invalid JSON: ' + err.message); }
    cache = migrate(parsed);
    persist();
    notify('', cache);
  }

  function reset() {
    cache = deepClone(DEFAULT_STATE);
    persist();
    notify('', cache);
  }

  function clearAll() {
    try { localStorage.removeItem(STORAGE_KEY); }
    catch (err) { console.error('[tb.state] failed to clear:', err); }
    cache = deepClone(DEFAULT_STATE);
    notify('', cache);
  }

  window.TB = window.TB || {};
  window.TB.state = {
    STORAGE_KEY,
    CURRENT_VERSION,
    get,
    set,
    subscribe,
    export: exportJson,
    import: importJson,
    reset,
    clearAll,
  };
})();
