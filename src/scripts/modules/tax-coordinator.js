/* Taigan Bridge — modules/tax-coordinator.js
 *
 * Tax Filing Coordinator — orchestrates the full annual tax cycle for
 * US persons living in Japan. This module does NOT compute tax — it
 * surfaces the WHICH-FORMS-WHEN-AND-WHY question that's normally
 * scattered across the IRS, NTA, and a dozen expat-finance blogs.
 *
 * Auto-detection strategy:
 *   - Reads onboarding answers for visa / residency / family / employment
 *   - Reads TB.assets to compute foreign-asset aggregate (8938 / FBAR)
 *   - Reads TB.assets to scan for 投資信託 / 学資保険 / JP mutual funds
 *     (PFIC trap)
 *   - Reads TB.fbar for prior-year filing history
 *   - Reads TB.veteran for combat-zone tax extensions / military relief
 *   - Reads TB.resident for 確定申告 deadline + Furusato + 住宅ローン
 *
 * State (in tax_coordinator.*):
 *   - filing_status        : single / mfj / mfs / hoh / qw
 *   - feie_or_ftc_choice   : feie / ftc / both / undecided
 *   - preparer             : { name, contact, notes, next_appointment }
 *   - manual_overrides     : flags for things we can't auto-detect
 *                            (foreign corp, self-employed, etc.)
 *   - forms_filed_history  : { 'YYYY': ['1040', '2555', ...] }
 *
 * Action Center generators surface upcoming deadlines (≤60d), PFIC
 * detection alerts, 8938 threshold approaching, preparer appointment
 * reminders, and quarterly estimated payment dates.
 */

(function () {
  'use strict';

  const id = 'tax-coordinator';

  // ====================================================================
  // Reference data — forms + deadlines
  // ====================================================================

  // Form catalog. Each form has an `applies(ctx)` predicate that returns
  // either false, or an object { reason, urgency? }. Forms are rendered
  // in this order in the assessment card.
  const FORMS = [
    {
      id: '1040',
      name_en: 'Form 1040 — US Individual Income Tax Return',
      name_jp: 'Form 1040 — 米国個人所得税申告書',
      jurisdiction: 'us',
      deadline_md: '04-15',
      expat_extension_md: '06-15',
      max_extension_md: '10-15',
      applies: () => ({ reason_en: 'Required for all US persons regardless of where they live.',
                        reason_jp: '海外居住の有無に関わらず、すべての米国人が必要。' }),
      docs_needed: ['us_w2', 'us_1099', 'gensen_choshu', 'rental_income', 'crypto_records'],
    },
    {
      id: '2555',
      name_en: 'Form 2555 — Foreign Earned Income Exclusion (FEIE)',
      name_jp: 'Form 2555 — 海外勤労所得控除(FEIE)',
      jurisdiction: 'us',
      deadline_md: '04-15',
      expat_extension_md: '06-15',
      max_extension_md: '10-15',
      applies: (ctx) => {
        if (!ctx.is_jp_resident) return false;
        if (!ctx.has_foreign_earned_income) return false;
        if (ctx.feie_choice === 'ftc') return { reason_en: 'You\'ve elected FTC. FEIE not used.',
                                                reason_jp: 'FTC を選択済み。FEIE は不使用。',
                                                informational: true };
        return { reason_en: 'Excludes up to $126,500 (2024) of foreign earned income. Available if you\'re a bona fide resident of Japan or pass the physical-presence test (330d/12mo).',
                 reason_jp: '日本居住者またはフィジカル・プレゼンス・テスト合格者は、最大 $126,500(2024年)の海外勤労所得を控除可能。' };
      },
      docs_needed: ['gensen_choshu', 'jp_residency_certificate', 'travel_calendar'],
    },
    {
      id: '1116',
      name_en: 'Form 1116 — Foreign Tax Credit (FTC)',
      name_jp: 'Form 1116 — 外国税額控除(FTC)',
      jurisdiction: 'us',
      deadline_md: '04-15',
      expat_extension_md: '06-15',
      max_extension_md: '10-15',
      applies: (ctx) => {
        if (!ctx.paid_jp_tax) return false;
        return { reason_en: 'Credits Japanese income tax (所得税) and resident tax (住民税) against US tax dollar-for-dollar. Better than FEIE for high earners and for income types FEIE can\'t exclude (passive, capital gains).',
                 reason_jp: '日本の所得税・住民税を米国税から1対1で控除。高所得者や FEIE 対象外の所得(受動所得・キャピタルゲイン)に有利。' };
      },
      docs_needed: ['kakutei_shinkoku', 'gensen_choshu', 'juminze_assessment'],
    },
    {
      id: '8938',
      name_en: 'Form 8938 — FATCA Statement of Foreign Assets',
      name_jp: 'Form 8938 — 外国金融資産申告書(FATCA)',
      jurisdiction: 'us',
      deadline_md: '04-15',
      expat_extension_md: '06-15',
      max_extension_md: '10-15',
      threshold_note_en: 'Filing thresholds for residents living abroad: Single/MFS $200K end-of-year OR $300K any time. MFJ $400K end-of-year OR $600K any time.',
      threshold_note_jp: '海外居住者の申告基準額:単身/MFS は年末 $200K または期中 $300K。MFJ は年末 $400K または期中 $600K。',
      applies: (ctx) => {
        const t = thresholds_8938(ctx.filing_status, ctx.is_jp_resident);
        if (ctx.foreign_assets_usd >= t.year_end || ctx.foreign_assets_usd_max >= t.any_time) {
          return { reason_en: 'Your foreign financial assets ($' + Math.round(ctx.foreign_assets_usd).toLocaleString() + ') exceed the ' + ctx.filing_status_label + ' threshold ($' + t.year_end.toLocaleString() + ' year-end).',
                   reason_jp: '海外金融資産が申告基準額を超過。' };
        }
        if (ctx.foreign_assets_usd >= t.year_end * 0.75) {
          return { reason_en: 'Approaching threshold ($' + Math.round(ctx.foreign_assets_usd).toLocaleString() + ' / $' + t.year_end.toLocaleString() + '). Track carefully — once you cross, 8938 is required.',
                   reason_jp: '基準額に接近。年末残高に注意。',
                   approaching: true };
        }
        return false;
      },
      docs_needed: ['fbar_records', 'jp_bank_year_end_balances'],
    },
    {
      id: 'fbar',
      name_en: 'FinCEN 114 — Report of Foreign Bank Accounts (FBAR)',
      name_jp: 'FinCEN 114 — 外国銀行口座報告書(FBAR)',
      jurisdiction: 'us',
      deadline_md: '04-15',
      auto_extension_md: '10-15',  // FBAR has automatic extension to Oct 15
      threshold_note_en: 'Filed separately from 1040 (BSA E-Filing System). $10,000 aggregate any time during the year — single threshold, no filing-status variant.',
      threshold_note_jp: '1040 とは別に提出(BSA E-Filing システム)。年間ピーク総額 $10,000 超で必須。',
      applies: (ctx) => {
        if (ctx.fbar_aggregate_usd > 10000) {
          return { reason_en: 'Your aggregate foreign account peak ($' + Math.round(ctx.fbar_aggregate_usd).toLocaleString() + ') exceeds the $10,000 threshold. FBAR is required.',
                   reason_jp: '外国口座の年間ピーク総額が $10,000 を超過。FBAR 必須。' };
        }
        if (ctx.fbar_aggregate_usd > 7500) {
          return { reason_en: 'Approaching $10,000 threshold. Monitor closely — a single transfer can trigger the requirement.',
                   reason_jp: '$10,000 基準に接近。送金一回でも超過する可能性あり。',
                   approaching: true };
        }
        return false;
      },
      docs_needed: ['fbar_records', 'jp_bank_year_end_balances'],
    },
    {
      id: '8621',
      name_en: 'Form 8621 — PFIC Annual Information Return',
      name_jp: 'Form 8621 — PFIC 年次情報申告',
      jurisdiction: 'us',
      deadline_md: '04-15',
      expat_extension_md: '06-15',
      max_extension_md: '10-15',
      threshold_note_en: 'PFICs include nearly all foreign mutual funds (投資信託), 学資保険, and many JP-domiciled ETFs. Default tax treatment is punitive — gains taxed at the highest ordinary rate plus interest charge. QEF or mark-to-market elections can mitigate but require ongoing reporting.',
      threshold_note_jp: 'PFIC は外国投資信託、学資保険、日本籍 ETF の大部分を含む。デフォルトの課税は懲罰的(最高税率+利子課税)。QEF・MTM 選択で緩和可能だが継続的報告が必要。',
      applies: (ctx) => {
        if (ctx.has_pfic === true) {
          return { reason_en: 'PFIC investment(s) detected: ' + ctx.pfic_account_names.join(', ') + '. Form 8621 required for each PFIC each year held.',
                   reason_jp: 'PFIC 投資を検出。保有期間中は毎年提出が必要。',
                   urgency: 'high' };
        }
        if (ctx.has_pfic === false) return false;
        return false;
      },
      docs_needed: ['pfic_statements', 'jp_brokerage_statements'],
    },
    {
      id: '5471',
      name_en: 'Form 5471 — Information Return of US Persons w/ Foreign Corp',
      name_jp: 'Form 5471 — 外国法人保有米国人情報申告',
      jurisdiction: 'us',
      deadline_md: '04-15',
      expat_extension_md: '06-15',
      max_extension_md: '10-15',
      threshold_note_en: 'Required if you own ≥10% of a foreign corporation (合同会社, 株式会社, GK, KK). GILTI / Subpart F regime applies. Penalties: $10,000 per form per year for non-filing.',
      threshold_note_jp: '外国法人(合同会社・株式会社等)の 10% 以上保有時に必須。罰金は不申告で年間 $10,000/フォーム。',
      applies: (ctx) => {
        if (ctx.has_foreign_corp === true) {
          return { reason_en: 'You\'ve indicated foreign corporation ownership. Form 5471 + GILTI computation required. Strongly recommend a CPA familiar with international corporate tax.',
                   reason_jp: '外国法人保有を選択。Form 5471 と GILTI 計算が必要。国際税務に精通した CPA を強く推奨。',
                   urgency: 'high' };
        }
        return false;
      },
      docs_needed: ['corp_articles', 'corp_financial_statements'],
    },
    {
      id: 'kakutei',
      name_en: '確定申告 — Japan Annual Tax Return',
      name_jp: '確定申告',
      jurisdiction: 'jp',
      window_open_md: '02-16',
      deadline_md: '03-15',
      threshold_note_en: 'Required if you\'re a Japan tax resident with worldwide income (永住者 status: year 6+) OR a non-permanent resident (年 1-5) with JP-source or remitted income. Salary-only employees with single employer often don\'t need to file (年末調整 covers it).',
      threshold_note_jp: '永住者(6年目以降)は全世界所得、非永住者(1-5年)は日本源泉所得・送金所得のみ。単一雇用主の給与のみは年末調整で完結することが多い。',
      applies: (ctx) => {
        if (!ctx.is_jp_resident) {
          // Even non-residents may have a household member who files
          // (e.g., SOFA contractor with JP spouse). Show as informational
          // when responsibility is 'spouse' so the form still appears
          // in context but isn't flagged as the user's own action.
          if (ctx.jp_filing_responsibility === 'spouse') {
            return {
              reason_en: 'Your spouse handles JP-side tax filings — this row is informational. Update via the picker on the calendar card if that changes.',
              reason_jp: '日本側の税務申告は配偶者が対応。情報表示のみ。状況が変わった場合はカレンダーカードのピッカーで変更可能。',
              informational: true,
              spouseHandles: true,
            };
          }
          return false;
        }
        if (ctx.jp_filing_responsibility === 'spouse') {
          return {
            reason_en: 'You are a JP tax resident, but the picker indicates a spouse / family member handles JP-side filings. Coordinate with them — your name may still need to appear on certain forms (e.g., 配偶者控除).',
            reason_jp: 'あなたは日本居住者ですが、配偶者が日本側の申告を担当する設定です。連携を確認(配偶者控除等であなたの記載が必要な場合あり)。',
            informational: true,
            spouseHandles: true,
          };
        }
        return { reason_en: 'Required as a Japan tax resident. File at your local 税務署 between Feb 16 - Mar 15 for prior calendar year.',
                 reason_jp: '日本居住者として必要。前年分を 2/16〜3/15 に管轄税務署へ提出。' };
      },
      docs_needed: ['gensen_choshu', 'medical_receipts', 'furusato_receipts',
                    'mortgage_balance_cert', 'insurance_premium_certs',
                    'us_tax_return_prior_year'],
    },
  ];

  // 8938 thresholds — different for living-abroad vs domestic. Since
  // this module is built for JP-residing US persons, we use the abroad
  // thresholds when the user is a JP tax resident.
  function thresholds_8938(filing_status, is_abroad) {
    if (is_abroad) {
      if (filing_status === 'mfj') return { year_end: 400000, any_time: 600000 };
      return { year_end: 200000, any_time: 300000 };  // single, mfs, hoh, qw
    }
    if (filing_status === 'mfj') return { year_end: 100000, any_time: 150000 };
    return { year_end: 50000, any_time: 75000 };
  }

  // Document catalog — maps internal doc-needs IDs to Document Vault
  // type IDs (where available) and display labels. Used in the
  // document-checklist card to cross-link.
  // vault_type values map to existing TYPES in document-vault.js. For
  // doc-needs that don't have a direct vault counterpart (rental
  // statements, FBAR working papers, etc.) we leave vault_type=null;
  // the checklist still shows them but without a Vault cross-link.
  const DOC_CATALOG = {
    us_w2:                 { en: 'US W-2 from any US employer',                jp: '米国 W-2', vault_type: 'w2' },
    us_1099:               { en: 'US 1099 forms (INT, DIV, B, R, NEC)',        jp: '米国 1099 各種', vault_type: 'ten99' },
    gensen_choshu:         { en: '源泉徴収票 from each JP employer',            jp: '源泉徴収票(各日本雇用主)', vault_type: 'w2' },
    kakutei_shinkoku:      { en: 'Prior year 確定申告 copy',                    jp: '前年の確定申告控え', vault_type: 'tax_return_jp' },
    juminze_assessment:    { en: '住民税 assessment notice (税額決定通知書)',     jp: '住民税額決定通知書', vault_type: null },
    rental_income:         { en: 'Rental income statements',                   jp: '不動産賃貸収入記録', vault_type: null },
    crypto_records:        { en: 'Crypto transaction records (US-source)',      jp: '暗号資産取引記録', vault_type: null },
    jp_residency_certificate: { en: '住民票 (residence certificate)',           jp: '住民票', vault_type: 'residence_card_jp' },
    travel_calendar:       { en: 'Travel calendar (for 330-day FEIE test)',     jp: '渡航記録(FEIE 330日テスト用)', vault_type: null },
    fbar_records:          { en: 'All foreign account peak balances',           jp: '外国口座年間ピーク残高記録', vault_type: 'fbar_confirmation' },
    jp_bank_year_end_balances: { en: 'Japan bank year-end balance certificates', jp: '日本銀行年末残高証明書', vault_type: null },
    pfic_statements:       { en: 'PFIC annual statements (per fund)',           jp: 'PFIC 年次明細(ファンド毎)', vault_type: null },
    jp_brokerage_statements: { en: 'JP brokerage 年間取引報告書 (特定口座)',     jp: '特定口座年間取引報告書', vault_type: null },
    medical_receipts:      { en: 'Medical receipts >¥100k (医療費控除)',        jp: '医療費領収書 ¥10万超', vault_type: null },
    furusato_receipts:     { en: 'Furusato Nozei donation certificates',        jp: 'ふるさと納税寄附金受領証明書', vault_type: null },
    mortgage_balance_cert: { en: 'Year-end mortgage balance certificate (年末残高証明書)', jp: '住宅ローン年末残高証明書', vault_type: 'mortgage_doc' },
    insurance_premium_certs: { en: 'Life / earthquake insurance premium certs (控除証明書)', jp: '生命・地震保険料控除証明書', vault_type: 'insurance_life' },
    us_tax_return_prior_year: { en: 'Prior year US 1040 (for FTC carryover, AGI)', jp: '前年の米国 1040', vault_type: 'tax_return_us' },
    corp_articles:         { en: 'Foreign corp articles of incorporation (定款)', jp: '外国法人定款', vault_type: null },
    corp_financial_statements: { en: 'Foreign corp financial statements',       jp: '外国法人財務諸表', vault_type: null },
  };

  // ====================================================================
  // State accessors
  // ====================================================================

  function getCoord()    { return TB.state.get('tax_coordinator') || {}; }
  function getOverrides(){ return getCoord().manual_overrides || {}; }
  function setSection(section, value) {
    const c = getCoord();
    c[section] = value;
    TB.state.set('tax_coordinator', c);
  }
  function setField(field, value) {
    const c = getCoord();
    c[field] = value;
    TB.state.set('tax_coordinator', c);
  }

  // ====================================================================
  // JP-FILING RESPONSIBILITY (who in the household files JP returns)
  // ====================================================================
  //
  // Many SOFA contractors are exempt from JP income tax under SOFA
  // Article 14 ¶7 (income from US Forces service is not subject to
  // Japanese tax) and don't appear on 住民票 under Article 9 ¶2. When
  // they have a Japanese-national spouse, the spouse handles all
  // JP-side personal returns (確定申告, 住民税, ふるさと納税). Showing
  // the SOFA contractor a calendar full of 確定申告 / 予定納税 / ふるさと
  // 納税 deadlines is wrong — those are their spouse's affair, not
  // theirs.
  //
  // This setting controls whether the user sees JP-side personal
  // filing deadlines as their own, marked as "spouse handles," or
  // hidden entirely. Defaults are derived from onboarding answers but
  // the user can always override.
  //
  // Values:
  //   'self'   — user files their own JP returns (default for JP residents)
  //   'spouse' — spouse / family member handles JP-side
  //   'na'     — no JP filing obligation (default for SOFA / US-only)
  //   'auto'   — derive from onboarding answers (the meta-default)

  function deriveJpFilingResponsibility() {
    const a = TB.state.get('onboarding.answers') || {};
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    const hasSpouse = fam.indexOf('jp_spouse') !== -1
                   || fam.indexOf('us_spouse') !== -1
                   || fam.indexOf('third_spouse') !== -1;
    if (a.tax_status === 'sofa_no_file') {
      return hasSpouse ? 'spouse' : 'na';
    }
    if (a.tax_status === 'us_only') return 'na';
    if (a.tax_status === 'japan_resident' || a.tax_status === 'japan_filer') return 'self';
    // Time-based fallback only when tax_status is unset / 'unsure'
    if (a.juminhyou === 'yes') return 'self';
    if (a.years_in_japan === '5_to_10' || a.years_in_japan === 'over_10') return 'self';
    return 'self';
  }

  function getJpFilingResponsibility() {
    const stored = getCoord().jp_filing_responsibility;
    const base = (stored && stored !== 'auto') ? stored : deriveJpFilingResponsibility();
    // VIEW-MODE INVERSION: when the user is exploring the spouse's
    // perspective (settings.view_mode === 'spouse'), responsibility
    // flips. The household's JP-side filer (typically the spouse) sees
    // 確定申告 / 住民税 / ふるさと納税 as their OWN action items, and
    // the US-side filings (the primary user's responsibility) become
    // the muted "spouse handles" rows. 'na' (no JP filing in the
    // household at all) stays 'na' in both views.
    const viewMode = TB.state.get('settings.view_mode') || 'user';
    if (viewMode !== 'spouse') return base;
    if (base === 'spouse') return 'self';   // I see my spouse's view → JP filings are mine
    if (base === 'self')   return 'spouse'; // I usually file → in spouse view, "spouse handles"
    return base;
  }

  // For spouse view, the US side also needs to be flagged as "spouse
  // handles" — but only for US-side personal filings (1040, FBAR,
  // 8938, 8621, 1116/2555). The current calendar already filters JP
  // entries by responsibility; we add a symmetric concept here.
  function usFilingsAreSpouseHandled() {
    return (TB.state.get('settings.view_mode') || 'user') === 'spouse';
  }

  // Convenience: should the calendar show JP personal-filing deadlines
  // (確定申告, 予定納税, ふるさと納税) as actionable items for the user?
  function userFilesJpPersonal() {
    return getJpFilingResponsibility() === 'self';
  }

  // ====================================================================
  // Context builder — gathers facts from every other module so the
  // FORMS predicates can run uniformly.
  // ====================================================================

  function buildContext() {
    const a = TB.state.get('onboarding.answers') || {};
    const overrides = getOverrides();
    const filing_status = getCoord().filing_status || deriveFilingStatus(a);
    const feie_choice = getCoord().feie_or_ftc_choice;

    // JP tax-resident detection.
    //
    // SOFA / US-only status EXPLICITLY OVERRIDES the time-based
    // heuristic — a SOFA contractor in Japan 10+ years is still NOT a
    // JP tax resident under Article 14 ¶7 (income from US Forces
    // service is exempt) and Article 9 ¶2 (exempt from 住民票
    // registration). Treating them as a JP filer would surface
    // confétti calendar entries (確定申告, 予定納税) that don't apply.
    //
    // After the explicit-override check we fall through to the
    // time-based heuristic, which is only used when tax_status is
    // unset or 'unsure'.
    const tracks = TB.state.get('tracks') || [];
    let is_jp_resident;
    if (a.tax_status === 'sofa_no_file' || a.tax_status === 'us_only') {
      is_jp_resident = false;
    } else if (a.tax_status === 'japan_resident' || a.tax_status === 'japan_filer') {
      is_jp_resident = true;
    } else {
      is_jp_resident =
        a.juminhyou === 'yes' ||
        a.years_in_japan === '5_to_10' ||
        a.years_in_japan === 'over_10' ||
        tracks.indexOf('resident') !== -1;
    }

    // Foreign earned income proxy: employed in Japan or self-employed
    // there. Active SOFA contractors / DoD civilians technically have
    // US-source income, not foreign-earned, so they're excluded here.
    const has_foreign_earned_income =
      a.employment === 'japan_company' ||
      a.employment === 'us_company' ||  // expat assignment in Japan
      a.employment === 'self' ||
      overrides.self_employed === true;

    // Paid JP tax proxy — reasonable to assume yes if JP resident with
    // any local income, or explicit override.
    const paid_jp_tax = is_jp_resident || overrides.paid_jp_tax_prior_year === true;

    // Foreign assets aggregation — pull from Assets module.
    const foreign_assets = computeForeignAssetsUsd();
    const fbar_aggregate = computeFbarAggregateUsd();

    // PFIC detection — scan Assets for likely PFIC accounts unless
    // user has explicitly set the override.
    const pfic_scan = scanForPfic();
    const has_pfic = overrides.has_pfic != null ? overrides.has_pfic : pfic_scan.detected;

    return {
      filing_status: filing_status,
      filing_status_label: filingStatusLabel(filing_status),
      feie_choice: feie_choice,
      is_jp_resident: is_jp_resident,
      jp_filing_responsibility: getJpFilingResponsibility(),
      has_foreign_earned_income: has_foreign_earned_income,
      paid_jp_tax: paid_jp_tax,
      foreign_assets_usd: foreign_assets.year_end,
      foreign_assets_usd_max: foreign_assets.peak,
      fbar_aggregate_usd: fbar_aggregate,
      has_pfic: has_pfic,
      pfic_account_names: pfic_scan.names,
      has_foreign_corp: overrides.has_foreign_corp === true,
    };
  }

  function deriveFilingStatus(answers) {
    const fam = Array.isArray(answers.family) ? answers.family : [answers.family].filter(Boolean);
    if (fam.indexOf('jp_spouse') !== -1) return 'mfs';      // JP spouse no ITIN — common
    if (fam.indexOf('us_spouse') !== -1) return 'mfj';
    if (fam.indexOf('third_spouse') !== -1) return 'mfs';
    return 'single';
  }

  function filingStatusLabel(s) {
    return ({
      single: 'Single',
      mfj:    'Married Filing Jointly',
      mfs:    'Married Filing Separately',
      hoh:    'Head of Household',
      qw:     'Qualifying Widow(er)',
    })[s] || 'Unknown';
  }

  // Foreign asset computation — sum non-US accounts (country !== 'US')
  // in USD. Returns both year-end (best proxy: current balance) and
  // peak (we don't track peak, so use current as conservative max).
  function computeForeignAssetsUsd() {
    if (!TB.assets || typeof TB.assets.getActiveAccounts !== 'function') {
      return { year_end: 0, peak: 0 };
    }
    let total = 0;
    for (const acc of TB.assets.getActiveAccounts()) {
      if (acc.country === 'US') continue;
      total += TB.assets.toUsd(acc.balance_native, acc.currency);
    }
    return { year_end: total, peak: total };
  }

  // FBAR aggregate — sum yearly_balances for the most recent year if
  // FBAR data exists, else fall back to Assets computation.
  function computeFbarAggregateUsd() {
    const fbar = TB.state.get('fbar') || {};
    const yb = Array.isArray(fbar.yearly_balances) ? fbar.yearly_balances : [];
    if (yb.length === 0) return computeForeignAssetsUsd().year_end;
    // Find most recent year with data.
    const latest = yb.reduce((max, b) => Math.max(max, b.year || 0), 0);
    if (!latest) return 0;
    let sum = 0;
    for (const b of yb) {
      if (b.year !== latest) continue;
      sum += b.max_balance_usd || 0;
    }
    return sum;
  }

  // PFIC detector — scans Assets for likely PFIC holdings. Heuristics:
  //   - Country is JP AND tax_wrapper is taxable_brokerage → likely
  //     contains 投資信託 (almost guaranteed PFIC)
  //   - tax_wrapper indicates JP fixed deposit + currency JPY → not PFIC
  //   - name/notes contain "投資信託", "fund", "ETF" + non-US country
  //
  // This is a heuristic — user can override via the manual_overrides.
  function scanForPfic() {
    const out = { detected: false, names: [] };
    if (!TB.assets || typeof TB.assets.getActiveAccounts !== 'function') {
      return out;
    }
    const PFIC_KEYWORDS = ['投資信託', '学資保険', 'mutual fund', 'mutualfund', 'fund', 'etf', 'ニーサ', 'NISA', 'iDeCo', 'idoco'];
    for (const acc of TB.assets.getActiveAccounts()) {
      if (acc.country === 'US') continue;
      const haystack = (acc.name + ' ' + (acc.notes || '') + ' ' + acc.institution).toLowerCase();
      const looksPfic = PFIC_KEYWORDS.some((k) => haystack.indexOf(k.toLowerCase()) !== -1);
      // Plain JP savings/checking/fixed-deposit are NOT PFIC.
      const isJustBank = ['jp_savings', 'jp_checking', 'jp_fixed_deposit'].indexOf(acc.tax_wrapper) !== -1;
      if (looksPfic && !isJustBank) {
        out.detected = true;
        out.names.push(acc.name + ' (' + acc.institution + ')');
      }
    }
    return out;
  }

  // ====================================================================
  // Deadline computation
  // ====================================================================

  // Build the calendar of upcoming deadlines for the next 12 months.
  // Returns sorted array: [{ id, name_en, name_jp, date: Date, jurisdiction, form_id, days_until }]
  function buildDeadlineCalendar(ctx) {
    const today = new Date(); today.setHours(0,0,0,0);
    const horizonEnd = new Date(today); horizonEnd.setFullYear(today.getFullYear() + 1);
    const out = [];

    function addRecurring(name_en, name_jp, monthDay, jurisdiction, form_id, opts) {
      const [m, d] = monthDay.split('-').map((s) => parseInt(s, 10));
      // Try this year, next year — pick whichever falls in the horizon
      // and is still future.
      for (const yr of [today.getFullYear(), today.getFullYear() + 1]) {
        const dt = new Date(yr, m - 1, d);
        if (dt < today) continue;
        if (dt > horizonEnd) continue;
        const days = Math.round((dt - today) / 86400000);
        out.push({
          id: form_id + '_' + yr,
          name_en, name_jp, date: dt, jurisdiction,
          form_id, days_until: days,
          informational: !!(opts && opts.informational),
          spouseHandles: !!(opts && opts.spouseHandles),
        });
        break;
      }
    }

    // 確定申告 window (JP) — only if applicable.
    //
    // Three states for JP-side personal filings:
    //   userFilesJpPersonal()  → show as user's own deadlines
    //   responsibility==='spouse' → show as informational (spouse handles)
    //   responsibility==='na' (or no JP residency) → omit entirely
    const jpResp = getJpFilingResponsibility();
    const showJpPersonal = ctx.is_jp_resident || jpResp === 'self' || jpResp === 'spouse';
    const jpPersonalAsInformational = jpResp !== 'self';
    const jpPersonalSuffix = jpResp === 'spouse' ? ' (spouse handles)' : '';
    const jpPersonalSuffixJp = jpResp === 'spouse' ? '(配偶者対応)' : '';
    if (showJpPersonal && jpResp !== 'na') {
      addRecurring('確定申告 window opens' + jpPersonalSuffix, '確定申告 受付開始' + jpPersonalSuffixJp,
        '02-16', 'jp', 'kakutei_open', { informational: true, spouseHandles: jpResp === 'spouse' });
      addRecurring('確定申告 deadline' + jpPersonalSuffix, '確定申告 提出期限' + jpPersonalSuffixJp,
        '03-15', 'jp', 'kakutei', { informational: jpPersonalAsInformational, spouseHandles: jpResp === 'spouse' });
    }

    // US 1040 — base deadline + automatic 2-month expat extension.
    // In spouse view, US-side filings flip to "spouse handles" (your
    // spouse is the JP filer; YOU handle US — so when she's looking,
    // these are someone else's actions). usSuffix mirrors the JP
    // suffix logic above.
    const usSpouseHandles = usFilingsAreSpouseHandled();
    const usSuffix = usSpouseHandles ? ' (spouse handles)' : '';
    const usSuffixJp = usSpouseHandles ? '(配偶者対応)' : '';
    addRecurring('US 1040 standard deadline' + usSuffix, 'US 1040 通常期限' + usSuffixJp,
      '04-15', 'us', '1040', { informational: usSpouseHandles, spouseHandles: usSpouseHandles });
    addRecurring('US 1040 expat auto-extension' + usSuffix, 'US 1040 海外居住者自動延長' + usSuffixJp,
      '06-15', 'us', '1040_expat', { informational: true, spouseHandles: usSpouseHandles });
    addRecurring('US 1040 extended deadline (Form 4868)' + usSuffix, 'US 1040 延長期限(Form 4868)' + usSuffixJp,
      '10-15', 'us', '1040_ext', { informational: usSpouseHandles, spouseHandles: usSpouseHandles });

    // FBAR — Apr 15 with automatic Oct 15 extension
    if (ctx.fbar_aggregate_usd > 0 || ctx.foreign_assets_usd > 5000) {
      addRecurring('FBAR (FinCEN 114) deadline' + usSuffix, 'FBAR(FinCEN 114)期限' + usSuffixJp,
        '04-15', 'us', 'fbar', { informational: usSpouseHandles, spouseHandles: usSpouseHandles });
      addRecurring('FBAR auto-extended deadline' + usSuffix, 'FBAR 自動延長期限' + usSuffixJp,
        '10-15', 'us', 'fbar_ext', { informational: true, spouseHandles: usSpouseHandles });
    }

    // Quarterly estimated payments (only for self-employed or
    // significant non-W2 income — heuristic via SE override or large
    // brokerage holdings).
    const overrides = getOverrides();
    const showQuarterly = overrides.self_employed === true;
    if (showQuarterly) {
      addRecurring('Q1 estimated payment',  'Q1 予定納税', '04-15', 'us', 'q1_est');
      addRecurring('Q2 estimated payment',  'Q2 予定納税', '06-15', 'us', 'q2_est');
      addRecurring('Q3 estimated payment',  'Q3 予定納税', '09-15', 'us', 'q3_est');
      addRecurring('Q4 estimated payment',  'Q4 予定納税', '01-15', 'us', 'q4_est');
    }

    // JP 予定納税 (mid-year prepayment, July & November) — applicable
    // to JP residents with prior-year tax > ¥150K. Jurisdiction badge
    // makes the "JP" prefix redundant — name reads naturally. Honors
    // the same JP-filing-responsibility setting as 確定申告 above.
    if (showJpPersonal && jpResp !== 'na') {
      addRecurring('予定納税 1st installment' + jpPersonalSuffix, '予定納税(第1期)' + jpPersonalSuffixJp,
        '07-31', 'jp', 'jp_yotei_1', { informational: true, spouseHandles: jpResp === 'spouse' });
      addRecurring('予定納税 2nd installment' + jpPersonalSuffix, '予定納税(第2期)' + jpPersonalSuffixJp,
        '11-30', 'jp', 'jp_yotei_2', { informational: true, spouseHandles: jpResp === 'spouse' });
    }

    // Furusato Nozei deadline — only meaningful if JP resident.
    if (showJpPersonal && jpResp !== 'na') {
      addRecurring('ふるさと納税 deadline (donations posted by 12/31)' + jpPersonalSuffix,
        'ふるさと納税期限(12/31 までに決済)' + jpPersonalSuffixJp,
        '12-31', 'jp', 'furusato', { informational: true, spouseHandles: jpResp === 'spouse' });
    }

    out.sort((a, b) => a.date - b.date);
    return out;
  }

  // ====================================================================
  // Display helpers
  // ====================================================================

  // Small colored badge identifying jurisdiction (US / JP). Replaces
  // the 🇺🇸/🇯🇵 flag emojis which don't render reliably on Windows
  // (regional-indicator pairs fall back to plain "US"/"JP" letters
  // in a way that looks like a layout bug). Inline-block so it sits
  // cleanly next to text.
  function jurisdictionBadge(j) {
    const isJp = j === 'jp';
    return TB.utils.el('span', {
      style: {
        display: 'inline-block',
        padding: '1px 6px',
        marginRight: '6px',
        fontSize: 'var(--tb-fs-12)',
        fontWeight: '700',
        letterSpacing: '0.04em',
        borderRadius: 'var(--tb-radius-pill)',
        color: '#fff',
        background: isJp ? '#B23A3A' : '#1A4480',  // JP red, US navy
        verticalAlign: 'baseline',
      },
    }, isJp ? 'JP' : 'US');
  }

  // ====================================================================
  // Module render
  // ====================================================================

  // Predicates for auto-show.
  //
  // SOFA / US-only tax status explicitly overrides the time-based
  // heuristic — see the longer comment in buildContext().
  function isJpResident() {
    const a = TB.state.get('onboarding.answers') || {};
    if (a.tax_status === 'sofa_no_file' || a.tax_status === 'us_only') return false;
    if (a.tax_status === 'japan_resident' || a.tax_status === 'japan_filer') return true;
    const tracks = TB.state.get('tracks') || [];
    return a.juminhyou === 'yes'
        || a.years_in_japan === '5_to_10' || a.years_in_japan === 'over_10'
        || tracks.indexOf('resident') !== -1;
  }

  const SECTIONS = [
    { id: 'header',    always: true, builder: () => buildHeaderCard() },
    {
      id: 'calendar',
      label_en: 'Year-at-a-glance calendar',
      label_jp: '年間カレンダー',
      description_en: 'Upcoming US + JP filing deadlines for the next 12 months.',
      description_jp: '今後 12 ヶ月の米国 + 日本の申告期限。',
      auto_show: () => true,
      builder: () => buildCalendarCard(),
    },
    {
      id: 'assessment',
      label_en: 'Forms assessment',
      label_jp: '必要申告書の判定',
      description_en: 'Per-form applicability with reasoning (1040, 2555/1116, FBAR, 8938, 8621, 5471, 確定申告).',
      description_jp: '各申告書の適用判定と理由(1040・2555/1116・FBAR・8938・8621・5471・確定申告)。',
      auto_show: () => true,
      builder: () => buildAssessmentCard(),
    },
    {
      id: 'feie_vs_ftc',
      label_en: 'FEIE vs FTC decision support',
      label_jp: 'FEIE vs FTC 判断サポート',
      description_en: 'Side-by-side comparison + your election picker.',
      description_jp: '横並び比較とあなたの選択ピッカー。',
      auto_show: isJpResident,
      builder: () => buildFeieFtcCard(),
    },
    {
      id: 'pfic',
      label_en: 'PFIC alert (Form 8621)',
      label_jp: 'PFIC 警告(Form 8621)',
      description_en: 'Auto-detects 投資信託 / 学資保険 in Assets and surfaces mitigation paths.',
      description_jp: 'Asset の投資信託・学資保険を自動検出し、緩和策を表示。',
      auto_show: hasPficCallout,
      builder: () => buildPficCard(),
    },
    {
      id: 'spouse',
      label_en: 'Spouse strategy (MFJ vs MFS)',
      label_jp: '配偶者戦略(MFJ vs MFS)',
      description_en: '§6013(g) election trade-offs for non-US-person spouse.',
      description_jp: '非米国人配偶者の §6013(g) 選択トレードオフ。',
      auto_show: hasJpSpouseCallout,
      builder: () => buildSpouseCard(),
    },
    {
      id: 'docs',
      label_en: 'Document collection checklist',
      label_jp: '書類収集チェックリスト',
      description_en: 'Documents needed by applicable forms; cross-references Document Vault.',
      description_jp: '適用申告書に必要な書類;Document Vault と相互参照。',
      auto_show: () => true,
      builder: () => buildDocChecklistCard(),
    },
    {
      id: 'preparer',
      label_en: 'Tax preparer info',
      label_jp: '税務担当者情報',
      description_en: 'CPA / 税理士 contact + next appointment date.',
      description_jp: 'CPA・税理士の連絡先と次回予約日。',
      auto_show: () => true,
      builder: () => buildPreparerCard(),
    },
    {
      id: 'cpa_briefing',
      label_en: 'CPA briefing generator',
      label_jp: 'CPA 打合せ資料の生成',
      description_en: 'One-click pre-meeting prep doc summarizing your situation, applicable forms, asset snapshot, and upcoming deadlines. Downloads as Markdown.',
      description_jp: '状況・適用申告書・資産スナップショット・期限を要約した打合せ前の準備資料をワンクリック生成。Markdown としてダウンロード。',
      auto_show: () => true,
      builder: () => buildCpaBriefingCard(),
    },
    {
      id: 'overrides',
      label_en: 'Manual overrides',
      label_jp: '手動オーバーライド',
      description_en: 'Override auto-detection for PFIC, foreign corp, self-employment.',
      description_jp: 'PFIC・外国法人・自営業の自動検出を上書き。',
      auto_show: () => true,
      builder: () => buildOverridesCard(),
    },
    { id: 'resources', always: true, builder: () => buildResourcesCard() },
  ];

  let host = null;
  let listenerSet = false;

  function render(container) {
    host = container;
    if (!listenerSet) {
      TB.customize.onChange(id, () => rerender());
      listenerSet = true;
    }
    container.innerHTML = '';
    SECTIONS.forEach((s) => {
      if (s.always || TB.customize.isSectionEnabled(id, s.id, s.auto_show)) {
        container.appendChild(s.builder());
      }
    });
    container.appendChild(TB.customize.buildPanel(id, SECTIONS));
  }

  function rerender() { if (host) render(host); }

  // ─── Header ───────────────────────────────────────────────────────

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'tax' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'tax' },
          t('tax.badge')),
      ),
      el('h1', null, '🗂 ' + t('tax.title')),
      el('p', { class: 'tb-card-meta' }, t('tax.subtitle')),
    );
    // Vision import — shows extracted W-2 / 源泉徴収票 numbers in a
    // results modal so the user can copy them into their tax prep.
    // No structured per-year storage in this module yet, so we don't
    // auto-persist; user can save the doc to Document Vault from the
    // results modal.
    if (TB.ai && typeof TB.ai.callClaudeVisionForStructuredDoc === 'function') {
      const w2Btn = buildTaxDocImportButton('w2_us', '📎 ' + t('tax.import.w2.btn'));
      const gensenBtn = buildTaxDocImportButton('gensen_choshu_jp', '📎 ' + t('tax.import.gensen.btn'));
      card.appendChild(el('div', {
        style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap',
          marginTop: 'var(--tb-sp-3)' },
      }, w2Btn, gensenBtn));
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
        t('tax.import.help')));
    }
    return card;
  }

  // Build an upload button that runs structured-doc vision and shows
  // extracted fields in a results modal. Supports W-2 (US) and 源泉徴収票
  // (JP). Doesn't persist into tax_coordinator state — that surface is
  // strategic, not per-year financial data — but offers to save the
  // source doc into Document Vault for inventory.
  function buildTaxDocImportButton(kind, label) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/jpg,image/webp,application/pdf',
      style: { display: 'none' },
      onchange: async (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) await runTaxDocVision(f, kind);
        e.target.value = '';
      },
    });
    const btn = el('button', {
      class: 'tb-btn tb-btn--secondary', type: 'button',
      style: { padding: '4px 12px', fontSize: '12px' },
      onclick: (e) => { e.preventDefault(); fileInput.click(); },
    }, label);
    return el('span', null, btn, fileInput);
  }

  async function runTaxDocVision(file, kind) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '600px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      '🗂 ' + t(kind === 'w2_us' ? 'tax.import.w2.title' : 'tax.import.gensen.title')));
    const status = el('p', { class: 'tb-card-meta' }, '⏳ ' + t('tax.import.processing'));
    modal.appendChild(status);
    root.innerHTML = '';
    root.appendChild(backdrop);
    try {
      const result = await TB.ai.callClaudeVisionForStructuredDoc(file, kind, {
        feature: 'document_vision',
      });
      const ext = (result && result.extracted) || {};
      const cost = (result.cost_usd || 0).toFixed(4);
      status.textContent = '✓ ' + t('tax.import.done', { cost });
      // Build a key/value table of extracted fields
      const table = el('table', { class: 'tb-table', style: { width: '100%', marginTop: 'var(--tb-sp-2)' } });
      const tbody = el('tbody');
      Object.keys(ext).forEach((k) => {
        const v = ext[k];
        if (v == null) return;
        let display = v;
        if (typeof v === 'number') display = v.toLocaleString();
        if (Array.isArray(v))      display = v.join(', ');
        tbody.appendChild(el('tr', null,
          el('td', { style: { fontWeight: '600', padding: '4px 8px', verticalAlign: 'top' } }, k),
          el('td', { style: { padding: '4px 8px', fontFamily: 'var(--tb-font-mono)' } }, String(display)),
        ));
      });
      table.appendChild(tbody);
      modal.appendChild(table);
      // Save to Document Vault button (when available)
      if (TB.docVault && typeof TB.docVault.upsertItem === 'function') {
        modal.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-3)' } },
          el('button', {
            class: 'tb-btn', type: 'button',
            onclick: () => {
              try {
                TB.docVault.upsertItem({
                  id: 'doc-' + Date.now().toString(36),
                  category: 'tax',
                  type: kind === 'w2_us' ? 'w2' : 'tax_return_jp',
                  title: kind === 'w2_us'
                    ? 'W-2 ' + (ext.tax_year || '')
                    : '源泉徴収票 ' + (ext.tax_year || ''),
                  person_name: ext.employee_name || '',
                  issuing_authority: ext.employer_name || '',
                  issue_date: null,
                  expiry_date: null,
                  storage_location: file.name || '',
                  notes: 'Imported from Tax module · ' + file.name,
                  linked_module: 'tax-coordinator',
                  ai_imported: true,
                  ai_cost_usd: result.cost_usd || 0,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });
                close();
                alert(t('tax.import.savedToVault'));
              } catch (err) {
                alert(t('tax.import.vaultError') + ': ' + err.message);
              }
            },
          }, '💾 ' + t('tax.import.saveToVault'))));
      }
      modal.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' } },
        el('button', { class: 'tb-btn tb-btn--ghost', type: 'button', onclick: close }, t('tax.cancel'))));
    } catch (err) {
      status.textContent = '✗ ' + (err.message || err);
      status.style.color = 'var(--tb-error)';
    }
  }

  // ─── Year-at-a-glance calendar ────────────────────────────────────

  function buildCalendarCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const ctx = buildContext();
    const deadlines = buildDeadlineCalendar(ctx);

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📅 ' + t('tax.section.calendar')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('tax.calendar.intro')));

    // JP-filing-responsibility picker. Lets users opt out of JP-side
    // personal-filing deadlines that are handled by a spouse or that
    // don't apply to them at all (SOFA contractors).
    card.appendChild(buildJpRespPicker());

    if (deadlines.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('tax.calendar.empty')));
      return card;
    }

    // Build a single deadline row. Used for both the main list and
    // the collapsed-by-default spouse-handled section so styling
    // stays consistent.
    function buildDeadlineRow(d) {
      // Spouse-handled rows render as muted/secondary even when they
      // would otherwise be "actionable" — they're the spouse's action,
      // not the user's.
      const isUrgent = d.days_until <= 14 && !d.informational && !d.spouseHandles;
      const isSoon = d.days_until <= 45 && !d.informational && !d.spouseHandles;
      const color = isUrgent ? 'var(--tb-error)'
                  : isSoon ? 'var(--tb-warn)'
                  : (d.informational || d.spouseHandles) ? 'var(--tb-text-soft)'
                  : 'var(--tb-track-tax)';
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '4px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
          opacity: d.spouseHandles ? '0.7' : '1',
        },
      });
      const titleNode = el('div', {
        style: {
          fontWeight: d.informational ? '500' : '600',
          color: (d.informational || d.spouseHandles) ? 'var(--tb-text-soft)' : 'var(--tb-text)',
        },
      },
        jurisdictionBadge(d.jurisdiction),
        lang === 'ja' ? d.name_jp : d.name_en);
      if (d.spouseHandles) {
        titleNode.appendChild(el('span', {
          style: {
            display: 'inline-block',
            marginLeft: 'var(--tb-sp-2)',
            padding: '0 6px',
            fontSize: '10px',
            fontWeight: '600',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--tb-text-soft)',
            border: '1px solid var(--tb-border)',
            borderRadius: 'var(--tb-radius-pill)',
            verticalAlign: 'middle',
          },
        }, '👥 ' + t('tax.calendar.spouseTag')));
      }
      row.appendChild(el('div', null,
        titleNode,
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          d.date.toISOString().slice(0, 10)),
      ));
      row.appendChild(el('div', {
        style: {
          textAlign: 'right',
          fontFamily: 'var(--tb-font-mono)',
          fontSize: 'var(--tb-fs-12)',
          color: color,
          whiteSpace: 'nowrap',
        },
      }, d.days_until + 'd'));
      return row;
    }

    // Partition deadlines: ones the user personally actions vs.
    // ones the spouse handles. Spouse-handled rows go into a
    // collapsible <details> below the main list so the user only
    // sees their own deadlines by default but can still expand to
    // see the household's full picture.
    const mine   = deadlines.filter((d) => !d.spouseHandles);
    const spouse = deadlines.filter((d) =>  d.spouseHandles);

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    mine.forEach((d) => list.appendChild(buildDeadlineRow(d)));
    card.appendChild(list);

    if (spouse.length > 0) {
      // Persist the open/closed state across sessions so the user's
      // preference sticks. Default closed — that's the whole point
      // of this collapse: the user explicitly said "I'm not concerned
      // about the docs my wife files."
      const prefKey = 'tax_coordinator.calendar_spouse_expanded';
      const initiallyOpen = !!TB.state.get(prefKey);

      const details = el('details', {
        style: {
          marginTop: 'var(--tb-sp-2)',
          padding: '0',
          background: 'transparent',
        },
        ontoggle: (e) => {
          // Persist user's choice — open() sets true, close() false.
          TB.state.set(prefKey, !!e.target.open);
        },
      });
      if (initiallyOpen) details.open = true;

      const summary = el('summary', {
        style: {
          cursor: 'pointer',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          borderLeft: '4px solid var(--tb-text-soft)',
          fontSize: 'var(--tb-fs-12)',
          color: 'var(--tb-text-soft)',
          fontWeight: '600',
          letterSpacing: '0.02em',
          listStyle: 'none', // hide default disclosure triangle on browsers that show one
        },
      });
      // Use a plain text chevron so the open/closed state reads
      // without relying on a CSS pseudo-element. Updated on toggle.
      const chevron = el('span', {
        style: { display: 'inline-block', marginRight: '6px', fontFamily: 'var(--tb-font-mono)' },
      }, initiallyOpen ? '▼' : '▶');
      summary.appendChild(chevron);
      summary.appendChild(el('span', null,
        '👥 ' + t('tax.calendar.spouseGroup.summary', { n: spouse.length })));
      // Wire the toggle to keep the chevron in sync.
      details.addEventListener('toggle', () => {
        chevron.textContent = details.open ? '▼' : '▶';
      });
      details.appendChild(summary);

      const spouseList = el('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)',
          marginTop: 'var(--tb-sp-2)',
        },
      });
      spouse.forEach((d) => spouseList.appendChild(buildDeadlineRow(d)));
      details.appendChild(spouseList);

      card.appendChild(details);
    }

    return card;
  }

  // ─── JP-filing-responsibility picker ──────────────────────────────
  //
  // Rendered inline inside the calendar card. Three options + auto.
  // Updating the picker re-renders the whole module so the calendar,
  // forms assessment, and document checklist all reflow.

  function buildJpRespPicker() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const stored = getCoord().jp_filing_responsibility || 'auto';
    const derived = deriveJpFilingResponsibility();
    const a = TB.state.get('onboarding.answers') || {};
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    const isSofa = a.tax_status === 'sofa_no_file';
    const hasSpouse = fam.indexOf('jp_spouse') !== -1
                   || fam.indexOf('us_spouse') !== -1
                   || fam.indexOf('third_spouse') !== -1;

    const wrap = el('div', {
      style: {
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderLeft: '4px solid var(--tb-track-tax)',
        borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-3)',
        margin: 'var(--tb-sp-3) 0',
      },
    });
    wrap.appendChild(el('div', {
      style: {
        fontSize: 'var(--tb-fs-12)',
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--tb-text-soft)',
        marginBottom: 'var(--tb-sp-2)',
      },
    }, '👥 ' + t('tax.jpresp.title')));
    wrap.appendChild(el('p', { class: 'tb-card-meta', style: { margin: '0 0 var(--tb-sp-3)' } },
      t('tax.jpresp.intro')));

    // SOFA-specific contextual note when the user is SOFA + has spouse,
    // because that's the canonical "spouse handles" pattern and worth
    // calling out directly so users understand WHY this control exists.
    if (isSofa && hasSpouse) {
      wrap.appendChild(el('p', {
        class: 'tb-field-help',
        style: { margin: '0 0 var(--tb-sp-3)', color: 'var(--tb-text-soft)' },
      }, '💡 ' + t('tax.jpresp.sofaNote')));
    }

    const OPTIONS = [
      { value: 'auto',   label: t('tax.jpresp.opt.auto', { d: t('tax.jpresp.derived.' + derived) }) },
      { value: 'self',   label: t('tax.jpresp.opt.self') },
      { value: 'spouse', label: t('tax.jpresp.opt.spouse') },
      { value: 'na',     label: t('tax.jpresp.opt.na') },
    ];
    const select = el('select', {
      class: 'tb-select',
      style: { maxWidth: '360px' },
      onchange: (e) => {
        setField('jp_filing_responsibility', e.target.value);
        rerender();
      },
    });
    for (const opt of OPTIONS) {
      select.appendChild(el('option', { value: opt.value, selected: stored === opt.value }, opt.label));
    }
    wrap.appendChild(select);
    return wrap;
  }

  // ─── Forms assessment ─────────────────────────────────────────────

  function buildAssessmentCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const ctx = buildContext();

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📋 ' + t('tax.section.assessment')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('tax.assessment.intro')));

    // Filing status display + edit
    const fsRow = el('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
        marginBottom: 'var(--tb-sp-3)', gap: 'var(--tb-sp-3)',
      },
    });
    fsRow.appendChild(el('div', null,
      el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
        t('tax.filing_status.label')),
      el('div', { style: { fontWeight: '600' } }, ctx.filing_status_label),
    ));
    const fsSel = el('select', {
      class: 'tb-select',
      style: { maxWidth: '220px' },
      onchange: (e) => { setField('filing_status', e.target.value || null); rerender(); },
    },
      el('option', { value: '', selected: !getCoord().filing_status },
        t('tax.filing_status.auto')),
      ['single', 'mfj', 'mfs', 'hoh', 'qw'].map((s) =>
        el('option', { value: s, selected: getCoord().filing_status === s },
          filingStatusLabel(s))),
    );
    fsRow.appendChild(fsSel);
    card.appendChild(fsRow);

    // Build a single form row. Returns the <details> element so the
    // caller can route it to either the user-pile or the spouse-pile
    // collapsible group below.
    function buildFormRow(form) {
      const result = form.applies(ctx);
      let icon, color, body_en, body_jp;
      if (result === false || result == null) {
        icon = '○'; color = 'var(--tb-text-soft)';
        body_en = 'Not currently required.';
        body_jp = '現時点では不要。';
      } else if (result.informational) {
        icon = 'ℹ'; color = 'var(--tb-track-tax)';
        body_en = result.reason_en; body_jp = result.reason_jp;
      } else if (result.approaching) {
        icon = '⚠'; color = 'var(--tb-warn)';
        body_en = result.reason_en; body_jp = result.reason_jp;
      } else if (result.urgency === 'high') {
        icon = '⚠'; color = 'var(--tb-error)';
        body_en = result.reason_en; body_jp = result.reason_jp;
      } else {
        icon = '✓'; color = 'var(--tb-success)';
        body_en = result.reason_en; body_jp = result.reason_jp;
      }
      const row = el('details', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      const summary = el('summary', {
        style: { cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 'var(--tb-sp-2)' },
      });
      summary.appendChild(el('span', { style: { color, fontWeight: '700', fontSize: 'var(--tb-fs-18)' } }, icon));
      const titleSpan = el('span', { style: { fontWeight: '600' } },
        jurisdictionBadge(form.jurisdiction),
        lang === 'ja' ? form.name_jp : form.name_en);
      if (result && result.spouseHandles) {
        titleSpan.appendChild(el('span', {
          style: {
            display: 'inline-block',
            marginLeft: 'var(--tb-sp-2)',
            padding: '0 6px',
            fontSize: '10px',
            fontWeight: '600',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--tb-text-soft)',
            border: '1px solid var(--tb-border)',
            borderRadius: 'var(--tb-radius-pill)',
            verticalAlign: 'middle',
          },
        }, '👥 ' + t('tax.calendar.spouseTag')));
      }
      summary.appendChild(titleSpan);
      row.appendChild(summary);
      const body = el('div', { style: { marginTop: 'var(--tb-sp-2)', paddingLeft: '32px' } });
      body.appendChild(el('p', { style: { margin: '0 0 var(--tb-sp-2)' } },
        lang === 'ja' ? body_jp : body_en));
      if (form.threshold_note_en) {
        body.appendChild(el('div', {
          class: 'tb-field-help',
          style: { padding: 'var(--tb-sp-2)', background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-2)' },
        }, lang === 'ja' ? form.threshold_note_jp : form.threshold_note_en));
      }
      if (form.deadline_md) {
        const deadlineText = form.window_open_md
          ? (lang === 'ja' ? '期限:' : 'Window: ') + form.window_open_md + ' – ' + form.deadline_md
          : (lang === 'ja' ? '期限:' : 'Deadline: ') + form.deadline_md +
            (form.expat_extension_md ? (lang === 'ja' ? ' (海外居住者自動延長 ' : ' (expat auto-extension ') + form.expat_extension_md + ')' : '') +
            (form.max_extension_md ? (lang === 'ja' ? ' (Form 4868 で ' : ' (Form 4868 to ') + form.max_extension_md + ')' : '') +
            (form.auto_extension_md ? (lang === 'ja' ? ' (自動延長 ' : ' (auto-extended to ') + form.auto_extension_md + ')' : '');
        body.appendChild(el('div', { class: 'tb-field-help' }, deadlineText));
      }
      row.appendChild(body);
      return { row, isSpouse: !!(result && result.spouseHandles) };
    }

    // Same pattern as the calendar card: render user-pile forms
    // directly; group spouse-handled forms in a collapsed <details>
    // below. Default closed, persisted in state so it sticks.
    const userForms = [];
    const spouseForms = [];
    FORMS.forEach((form) => {
      const built = buildFormRow(form);
      (built.isSpouse ? spouseForms : userForms).push(built.row);
    });
    userForms.forEach((r) => card.appendChild(r));

    if (spouseForms.length > 0) {
      const prefKey = 'tax_coordinator.assessment_spouse_expanded';
      const initiallyOpen = !!TB.state.get(prefKey);
      const details = el('details', {
        style: { marginTop: 'var(--tb-sp-2)' },
        ontoggle: (e) => { TB.state.set(prefKey, !!e.target.open); },
      });
      if (initiallyOpen) details.open = true;
      const summary = el('summary', {
        style: {
          cursor: 'pointer',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid var(--tb-text-soft)',
          fontSize: 'var(--tb-fs-12)',
          color: 'var(--tb-text-soft)',
          fontWeight: '600',
          letterSpacing: '0.02em',
          listStyle: 'none',
        },
      });
      const chevron = el('span', {
        style: { display: 'inline-block', marginRight: '6px', fontFamily: 'var(--tb-font-mono)' },
      }, initiallyOpen ? '▼' : '▶');
      summary.appendChild(chevron);
      summary.appendChild(el('span', null,
        '👥 ' + t('tax.assessment.spouseGroup.summary', { n: spouseForms.length })));
      details.addEventListener('toggle', () => {
        chevron.textContent = details.open ? '▼' : '▶';
      });
      details.appendChild(summary);
      const inner = el('div', { style: { marginTop: 'var(--tb-sp-2)' } });
      spouseForms.forEach((r) => inner.appendChild(r));
      details.appendChild(inner);
      card.appendChild(details);
    }

    return card;
  }

  // ─── FEIE vs FTC decision support ─────────────────────────────────

  function buildFeieFtcCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const choice = getCoord().feie_or_ftc_choice || 'undecided';

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🤔 ' + t('tax.section.feie_vs_ftc')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('tax.feie_vs_ftc.intro')));

    // Side-by-side comparison
    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-3)' },
    });
    grid.appendChild(buildElectionTile('feie',
      'Form 2555 (FEIE)',
      'Excludes up to ~$126,500/yr (2024) of foreign earned income from US tax.',
      [
        '✓ Simpler on paper',
        '✓ Drops you to lower brackets / phaseouts',
        '✗ Wastes JP tax credits — once excluded, can\'t use those wages for FTC',
        '✗ Caps at ~$126K — high earners leave money on the table',
        '✗ Doesn\'t cover SE tax, dividends, capital gains',
        '⚠ Revoking requires IRS permission for 5 years',
      ], choice));
    grid.appendChild(buildElectionTile('ftc',
      'Form 1116 (FTC)',
      'Credits Japanese income + resident tax against US tax dollar-for-dollar.',
      [
        '✓ Unlimited credit (JP rates ≥ US for most income)',
        '✓ Generates excess credit you can carry back 1y / forward 10y',
        '✓ Covers passive, capital gains, all income types',
        '✓ Easy to switch between years',
        '✗ More paperwork (per income category)',
        '✗ Doesn\'t reduce SE tax (totalization treaty handles that)',
      ], choice));
    card.appendChild(grid);

    // Choice picker
    const picker = el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
    });
    picker.appendChild(el('div', null,
      el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
        t('tax.feie_vs_ftc.your_choice')),
      el('div', { style: { fontWeight: '600' } }, electionLabel(choice)),
    ));
    const sel = el('select', {
      class: 'tb-select',
      style: { maxWidth: '200px' },
      onchange: (e) => { setField('feie_or_ftc_choice', e.target.value); rerender(); },
    },
      ['undecided', 'feie', 'ftc', 'both'].map((c) =>
        el('option', { value: c, selected: choice === c }, electionLabel(c))),
    );
    picker.appendChild(sel);
    card.appendChild(picker);

    card.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid var(--tb-track-tax)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)',
      },
    }, '💡 ' + t('tax.feie_vs_ftc.rule_of_thumb')));

    return card;
  }

  function buildElectionTile(id, title, desc, bullets, current) {
    const el = TB.utils.el;
    const isCurrent = current === id;
    const tile = el('div', {
      style: {
        padding: 'var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
        border: isCurrent ? '2px solid var(--tb-track-tax)' : '1px solid var(--tb-border)',
      },
    });
    tile.appendChild(el('div', { style: { fontWeight: '700', marginBottom: '4px' } }, title));
    tile.appendChild(el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-2)' } }, desc));
    const ul = el('ul', { style: { paddingLeft: '20px', margin: 0 } });
    bullets.forEach((b) => ul.appendChild(el('li', { style: { fontSize: 'var(--tb-fs-12)', marginBottom: '4px' } }, b)));
    tile.appendChild(ul);
    return tile;
  }

  function electionLabel(c) {
    return ({
      undecided: 'Undecided',
      feie:      'FEIE (Form 2555)',
      ftc:       'FTC (Form 1116)',
      both:      'Both — split election',
    })[c] || c;
  }

  // ─── PFIC warning ─────────────────────────────────────────────────

  function hasPficCallout() {
    const ctx = buildContext();
    return ctx.has_pfic === true;
  }

  function buildPficCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const ctx = buildContext();

    const card = el('div', { class: 'tb-card', 'data-track': 'tax',
      style: { borderLeft: '4px solid var(--tb-error)' } });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚠ ' + t('tax.section.pfic')));
    card.appendChild(el('p', null,
      lang === 'ja'
        ? 'Asset 一覧から PFIC 該当の可能性がある投資を検出しました。米国市民・永住権保持者にとって PFIC のデフォルト課税は懲罰的です(超過分配・キャピタルゲインに最高税率+利子課税)。'
        : 'PFIC investments detected in your Assets. For US persons, the default PFIC tax treatment is punitive — excess distributions and gains are taxed at the highest ordinary rate plus an interest charge.'));

    // List detected accounts
    const accountsList = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    });
    accountsList.appendChild(el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
      t('tax.pfic.detected_label')));
    const ul = el('ul', { style: { margin: 0, paddingLeft: '20px' } });
    ctx.pfic_account_names.forEach((n) => ul.appendChild(el('li', null, n)));
    accountsList.appendChild(ul);
    card.appendChild(accountsList);

    // Mitigation options
    const opts = [
      { en: '✗ Default tax treatment — DO NOT do this if you can help it. Excess distribution rule = highest ordinary rate + interest from year of acquisition.',
        jp: '✗ デフォルト課税 — 可能な限り回避を。超過分配ルール = 取得年から最高税率+利子課税。' },
      { en: '✓ QEF election — pass-through ordinary/cap-gain income from the fund. Requires fund to provide PFIC Annual Information Statement (most JP funds don\'t).',
        jp: '✓ QEF 選択 — ファンドからのパススルー課税。PFIC 年次情報明細書の提供が必要(多くの日本ファンドは未対応)。' },
      { en: '✓ Mark-to-market — recognize gains/losses annually as ordinary income. Available for publicly-traded PFICs.',
        jp: '✓ MTM(時価評価)選択 — 毎年実現益として認識。公開取引 PFIC で利用可能。' },
      { en: '🟢 BEST: Sell BEFORE you became a US person, or replace with US-domiciled equivalents (e.g., VTI in a Schwab US account instead of 投資信託).',
        jp: '🟢 ベスト:米国人になる前に売却、または米国籍 ETF/MF(例:Schwab の VTI)に置換。' },
    ];
    const optsList = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-2)' } });
    opts.forEach((o) => optsList.appendChild(el('li', { style: { marginBottom: '6px' } },
      lang === 'ja' ? o.jp : o.en)));
    card.appendChild(optsList);

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      t('tax.pfic.cpa_note')));
    return card;
  }

  // ─── Spouse strategy (only if JP-national spouse) ─────────────────

  function hasJpSpouseCallout() {
    const a = TB.state.get('onboarding.answers') || {};
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    return fam.indexOf('jp_spouse') !== -1;
  }

  function buildSpouseCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '👫 ' + t('tax.section.spouse')));
    card.appendChild(el('p', null,
      lang === 'ja'
        ? '日本人配偶者がいる場合、米国の申告ステータス(MFJ vs MFS)を選ぶ必要があります。それぞれにトレードオフがあります。'
        : 'With a Japanese-national spouse, you face an MFJ vs MFS election that has significant trade-offs.'));

    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)' } });
    grid.appendChild(buildElectionTile('mfs', 'MFS — Married Filing Separately',
      'Default for couples with non-US spouse. JP spouse stays out of the US tax system.',
      [
        '✓ Simplest — JP spouse needs no ITIN, no US filing',
        '✓ JP spouse\'s income invisible to IRS',
        '✗ Lower brackets, lower deductions',
        '✗ NIIT and many credits phased out at lower MAGI',
        '✗ Roth IRA contribution disallowed at MAGI > $10K',
      ], null));
    grid.appendChild(buildElectionTile('mfj', 'MFJ — Married Filing Jointly',
      'Treat JP spouse as US resident under §6013(g). Spouse needs ITIN.',
      [
        '✓ Full MFJ brackets and standard deduction',
        '✓ Roth IRA for both spouses',
        '✗ JP spouse\'s WORLDWIDE income now reported to IRS',
        '✗ JP spouse\'s JP investments become PFICs',
        '✗ §6013(g) election binding until revoked + 5y bar',
        '⚠ Often a trap — analyze carefully before electing',
      ], null));
    card.appendChild(grid);

    card.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185, 122, 26, 0.06)',
        borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)',
      },
    }, '⚠ ' + t('tax.spouse.warning')));
    return card;
  }

  // ─── Document collection checklist ────────────────────────────────

  function buildDocChecklistCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const ctx = buildContext();

    // Aggregate all docs needed across applicable forms. Track for each
    // form whether it's spouse-handled — if so, its docs go to the
    // spouse pile rather than the user's own list. Forms that BOTH user
    // and spouse contribute docs to (rare) bias toward "user" — those
    // are primarily the user's responsibility to gather.
    const needed = new Map();          // user's own docs
    const spouseNeeded = new Map();    // docs the spouse's filings need
    FORMS.forEach((form) => {
      const result = form.applies(ctx);
      if (!result) return;
      if (result.informational && !result.spouseHandles) return;
      const target = result.spouseHandles ? spouseNeeded : needed;
      (form.docs_needed || []).forEach((docId) => {
        if (!target.has(docId)) target.set(docId, []);
        target.get(docId).push(form.id);
      });
    });

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📂 ' + t('tax.section.docs')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('tax.docs.intro')));

    if (needed.size === 0 && spouseNeeded.size === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('tax.docs.empty')));
      return card;
    }

    const vault = TB.state.get('documentVault.items') || [];

    function renderDocRow(docId, forForms, target) {
      const meta = DOC_CATALOG[docId];
      if (!meta) return;
      const inVault = meta.vault_type
        ? vault.some((v) => v.type === meta.vault_type)
        : false;
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (inVault ? 'var(--tb-success)' : 'var(--tb-border)'),
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      row.appendChild(el('div', null,
        el('div', null,
          el('span', { style: { marginRight: '6px', color: inVault ? 'var(--tb-success)' : 'var(--tb-text-soft)' } },
            inVault ? '✓' : '○'),
          lang === 'ja' ? meta.jp : meta.en),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          (lang === 'ja' ? '使用フォーム:' : 'Used by: ') + forForms.join(', ')),
      ));
      if (meta.vault_type) {
        row.appendChild(el('a', {
          href: '#',
          style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)', whiteSpace: 'nowrap' },
          onclick: (e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'document-vault' } }));
          },
        }, inVault ? (lang === 'ja' ? 'Vault で表示 →' : 'View in Vault →')
                   : (lang === 'ja' ? 'Vault に追加 →' : 'Add to Vault →')));
      }
      target.appendChild(row);
    }

    // User's own pile
    if (needed.size > 0) {
      needed.forEach((forForms, docId) => renderDocRow(docId, forForms, card));
    }

    // Spouse pile — collapsed by default; same persistence pattern
    // as the calendar + assessment cards above. Header line replaces
    // the always-visible block so the user only sees this pile when
    // they opt in.
    if (spouseNeeded.size > 0) {
      const prefKey = 'tax_coordinator.docs_spouse_expanded';
      const initiallyOpen = !!TB.state.get(prefKey);
      const details = el('details', {
        style: {
          marginTop: 'var(--tb-sp-4)',
          paddingTop: 'var(--tb-sp-3)',
          borderTop: '1px dashed var(--tb-border)',
        },
        ontoggle: (e) => { TB.state.set(prefKey, !!e.target.open); },
      });
      if (initiallyOpen) details.open = true;
      const summary = el('summary', {
        style: {
          cursor: 'pointer',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid var(--tb-text-soft)',
          fontSize: 'var(--tb-fs-12)',
          color: 'var(--tb-text-soft)',
          fontWeight: '600',
          letterSpacing: '0.02em',
          listStyle: 'none',
        },
      });
      const chevron = el('span', {
        style: { display: 'inline-block', marginRight: '6px', fontFamily: 'var(--tb-font-mono)' },
      }, initiallyOpen ? '▼' : '▶');
      summary.appendChild(chevron);
      summary.appendChild(el('span', null,
        '👥 ' + t('tax.docs.spouseGroup.summary', { n: spouseNeeded.size })));
      details.addEventListener('toggle', () => {
        chevron.textContent = details.open ? '▼' : '▶';
      });
      details.appendChild(summary);

      const inner = el('div', { style: { marginTop: 'var(--tb-sp-2)' } });
      // Keep the existing intro paragraph inside the expanded section
      // so the context isn't lost when the user opens it.
      inner.appendChild(el('p', { class: 'tb-card-meta', style: { margin: '0 0 var(--tb-sp-2)' } },
        t('tax.docs.spouseIntro')));
      spouseNeeded.forEach((forForms, docId) => renderDocRow(docId, forForms, inner));
      details.appendChild(inner);
      card.appendChild(details);
    }

    return card;
  }

  // ─── Preparer card ────────────────────────────────────────────────

  function buildPreparerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const p = getCoord().preparer || {};

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🤝 ' + t('tax.section.preparer')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openPreparerModal() }, '✎ ' + t('tax.edit')),
    ));

    if (!p.name) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('tax.preparer.empty')));
      return card;
    }

    const dl = el('dl', { class: 'tb-dl' });
    function row(label, val) {
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', null, val || '—'));
    }
    row(t('tax.preparer.name'), p.name);
    if (p.contact) row(t('tax.preparer.contact'), p.contact);
    if (p.next_appointment) row(t('tax.preparer.next_appointment'), p.next_appointment);
    if (p.notes) row(t('tax.preparer.notes'), p.notes);
    card.appendChild(dl);
    return card;
  }

  function openPreparerModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getCoord().preparer || {});
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('tax.modal.preparer')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('tax.preparer.name'),
      el('input', { type: 'text', class: 'tb-input',
        value: draft.name || '',
        placeholder: 'e.g. Yamada Tax Office, John CPA',
        oninput: (e) => { draft.name = e.target.value; } })));
    modal.appendChild(field(t('tax.preparer.contact'),
      el('input', { type: 'text', class: 'tb-input',
        value: draft.contact || '',
        placeholder: 'Email, phone, LINE',
        oninput: (e) => { draft.contact = e.target.value; } })));
    modal.appendChild(field(t('tax.preparer.next_appointment'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.next_appointment || '',
        oninput: (e) => { draft.next_appointment = e.target.value || null; } })));
    modal.appendChild(field(t('tax.preparer.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' },
    });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('tax.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('preparer', draft); close(); rerender(); } }, t('tax.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Manual overrides card ────────────────────────────────────────

  function buildOverridesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ov = getOverrides();

    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚙ ' + t('tax.section.overrides')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('tax.overrides.intro')));

    function triState(field, label, help) {
      const cur = ov[field];
      const sel = el('select', {
        class: 'tb-select',
        style: { maxWidth: '160px' },
        onchange: (e) => {
          const v = e.target.value;
          const newOv = Object.assign({}, getOverrides());
          newOv[field] = v === 'auto' ? null : (v === 'yes');
          setSection('manual_overrides', newOv);
          rerender();
        },
      },
        el('option', { value: 'auto', selected: cur == null }, t('tax.overrides.auto')),
        el('option', { value: 'yes',  selected: cur === true }, t('tax.overrides.yes')),
        el('option', { value: 'no',   selected: cur === false }, t('tax.overrides.no')),
      );
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '500' } }, label),
        help ? el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, help) : null,
      ));
      row.appendChild(sel);
      return row;
    }

    card.appendChild(triState('has_pfic',
      t('tax.overrides.pfic'),
      t('tax.overrides.pfic.help')));
    card.appendChild(triState('has_foreign_corp',
      t('tax.overrides.foreign_corp'),
      t('tax.overrides.foreign_corp.help')));
    card.appendChild(triState('self_employed',
      t('tax.overrides.self_employed'),
      t('tax.overrides.self_employed.help')));
    card.appendChild(triState('paid_jp_tax_prior_year',
      t('tax.overrides.paid_jp_tax'),
      t('tax.overrides.paid_jp_tax.help')));
    return card;
  }

  // ─── CPA Briefing generator ──────────────────────────────────────
  //
  // One-click pre-meeting prep doc summarizing the user's situation,
  // applicable forms, open questions, and recent decisions. Downloads
  // as Markdown by default; can also seed an Ask Taigan conversation
  // for refinement before sending to the CPA.
  //
  // Privacy: built from the user's local state. No account numbers,
  // no SSNs. Includes institution names, balances, filing status —
  // i.e. the same level of detail a CPA would see at intake.

  function buildCpaBriefingCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📝 ' + t('tax.cpa.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('tax.cpa.intro')));

    // Privacy callout — explicit about what's in the doc.
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderLeft: '3px solid var(--tb-track-tax)',
        borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
        fontSize: 'var(--tb-fs-12)',
      },
    },
      el('strong', null, '🔒 ' + t('tax.cpa.privacy.title')),
      ' ' + t('tax.cpa.privacy.body')));

    const status = el('div', { class: 'tb-card-meta', style: { minHeight: '1.4em', marginTop: 'var(--tb-sp-2)' } });

    const btnRow = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    btnRow.appendChild(el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: () => {
        try {
          const md = buildCpaBriefingMarkdown();
          const fname = 'taigan-cpa-briefing-' + new Date().toISOString().slice(0, 10) + '.md';
          TB.utils.downloadFile(fname, md, 'text/markdown');
          status.textContent = '✓ ' + t('tax.cpa.downloaded');
          status.style.color = 'var(--tb-success)';
        } catch (err) {
          status.textContent = '✗ ' + (err.message || err);
          status.style.color = 'var(--tb-error)';
        }
      },
    }, '⤓ ' + t('tax.cpa.download')));
    // "Open in Ask Taigan" — seeds a conversation with the briefing as
    // context so user can chat with Claude to refine before sending.
    if (TB.askTaigan && typeof TB.askTaigan.openWithContext === 'function') {
      const allowAsk = (TB.ai && typeof TB.ai.isFeatureAllowed === 'function')
        ? TB.ai.isFeatureAllowed('ask_taigan') : true;
      if (allowAsk !== false) {
        btnRow.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary',
          type: 'button',
          onclick: () => {
            const md = buildCpaBriefingMarkdown();
            const seedEn = 'Here is a draft pre-meeting briefing for my CPA. Help me refine it — ' +
              'spot anything I missed, flag questions I should add, and tighten the language.\n\n' + md;
            const seedJp = '以下は CPA との打合せ前の準備資料の下書きです。改善のお手伝いをお願いします — ' +
              '抜けている事項の指摘、追加すべき質問の提案、表現の整え方など。\n\n' + md;
            TB.askTaigan.openWithContext({
              feature: 'ask_taigan',
              label_en: 'CPA briefing draft',
              label_jp: 'CPA 打合せ資料(下書き)',
              prompt_en: seedEn,
              prompt_jp: seedJp,
            });
          },
        }, '💬 ' + t('tax.cpa.refineWithAi')));
      }
    }
    card.appendChild(btnRow);
    card.appendChild(status);
    return card;
  }

  // Generates the Markdown body of the CPA briefing. Pure function; no
  // DOM. Returns a string suitable for download or AI-context seeding.
  function buildCpaBriefingMarkdown() {
    const profile = TB.state.get('profile') || {};
    const onboarding = TB.state.get('onboarding') || {};
    const a = onboarding.answers || {};
    const today = new Date().toISOString().slice(0, 10);
    const ctx = buildContext();
    const lines = [];

    lines.push('# CPA / 税理士 Pre-Meeting Briefing');
    lines.push('_Generated by Taigan Bridge on ' + today + '. Read-only snapshot for advisor review._');
    lines.push('');
    lines.push('## Client');
    lines.push('- **Name**: ' + (profile.displayName || '(not set)'));
    if (profile.displayNameJa) lines.push('- **JP name**: ' + profile.displayNameJa);
    lines.push('- **Citizenship**: ' + (a.citizenship || '(not specified)'));
    lines.push('- **Currently in Japan**: ' + (a.in_japan || '(not specified)'));
    lines.push('- **Years in Japan**: ' + (a.years_in_japan || '(not specified)'));
    lines.push('- **Visa / status**: ' + (a.visa || '(not specified)'));
    lines.push('- **Employment**: ' + (a.employment || '(not specified)'));
    lines.push('- **JP tax status**: ' + (a.tax_status || '(not specified)'));
    if (a.tax_status === 'sofa_no_file') {
      lines.push('  - _Note: SOFA Article 14 ¶7 exempts US-Forces-source income from JP income tax;_');
      lines.push('  - _Article 9 ¶2 exempts from 住民票 registration._');
      if (a.non_sofa_jp_income === 'yes') {
        lines.push('  - _**Important**: client has non-SOFA JP-source income — 確定申告 may apply for that subset._');
      }
    }
    lines.push('- **住民票 registered**: ' + (a.juminhyo || '(not specified)'));
    lines.push('- **Filing status**: ' + (ctx.filing_status_label || '(not set)'));
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    if (fam.length > 0) lines.push('- **Family**: ' + fam.join(', '));
    const coord = TB.state.get('tax_coordinator') || {};
    if (coord.jp_filing_responsibility && coord.jp_filing_responsibility !== 'auto') {
      lines.push('- **JP-side filing responsibility**: ' + coord.jp_filing_responsibility);
    }
    lines.push('');

    lines.push('## Applicable Forms (auto-detected from data)');
    for (const form of FORMS) {
      const result = form.applies(ctx);
      if (!result) continue;
      if (result.informational && !result.spouseHandles) continue;
      const tag = result.spouseHandles ? '[SPOUSE HANDLES]' :
                  result.urgency === 'high' ? '[HIGH]' :
                  result.approaching ? '[APPROACHING]' : '';
      lines.push('- **' + form.id.toUpperCase() + '** — ' + form.name_en + ' ' + tag);
      lines.push('  - _Reason_: ' + (result.reason_en || ''));
    }
    lines.push('');

    lines.push('## Foreign Asset Aggregate');
    lines.push('- **Total foreign financial assets (year-end estimate)**: $' + Math.round(ctx.foreign_assets_usd).toLocaleString());
    lines.push('- **FBAR aggregate (peak proxy)**: $' + Math.round(ctx.fbar_aggregate_usd).toLocaleString());
    const t8938 = thresholds_8938(ctx.filing_status, ctx.is_jp_resident);
    lines.push('- **8938 threshold (' + (ctx.is_jp_resident ? 'abroad' : 'domestic') + ', ' + ctx.filing_status + ')**: $' + t8938.year_end.toLocaleString() + ' year-end / $' + t8938.any_time.toLocaleString() + ' any-time');
    if (ctx.has_pfic) {
      lines.push('- **PFIC accounts detected**: ' + ctx.pfic_account_names.join(', '));
      lines.push('  - _Form 8621 required for each PFIC each year held._');
    }
    if (ctx.has_foreign_corp) lines.push('- **Foreign corp owned (≥10%)**: yes — Form 5471 required.');
    lines.push('');

    // Asset summary
    if (TB.assets && typeof TB.assets.getActiveAccounts === 'function') {
      const accts = TB.assets.getActiveAccounts();
      if (accts.length > 0) {
        lines.push('## Asset Snapshot');
        lines.push('| Institution | Country | Wrapper | Currency | Balance (native) | Balance (USD) |');
        lines.push('|---|---|---|---|---:|---:|');
        for (const acct of accts) {
          const usd = TB.assets.toUsd(acct.balance_native, acct.currency);
          lines.push('| ' + (acct.institution || '?') + ' | ' + (acct.country || '?') +
            ' | ' + (acct.tax_wrapper || '?') + ' | ' + (acct.currency || '?') +
            ' | ' + (acct.balance_native != null ? Math.round(acct.balance_native).toLocaleString() : '—') +
            ' | $' + (usd != null ? Math.round(usd).toLocaleString() : '—') + ' |');
        }
        lines.push('');
        // Unrealized gain summary (uses helper from Assets module)
        if (typeof TB.assets.unrealizedGainSummary === 'function') {
          const sum = TB.assets.unrealizedGainSummary();
          if (sum.coverage_count > 0) {
            lines.push('**Unrealized gain across accounts with basis tracked** (' + sum.coverage_count + '/' + sum.coverage_total + ' accounts, ' + sum.coverage_pct.toFixed(0) + '% of portfolio value):');
            lines.push('- Cost basis: $' + Math.round(sum.total_basis_usd).toLocaleString());
            lines.push('- Current value: $' + Math.round(sum.total_value_usd).toLocaleString());
            lines.push('- Unrealized gain: ' + (sum.gain_usd >= 0 ? '+' : '') + '$' + Math.round(sum.gain_usd).toLocaleString() +
              (sum.gain_pct != null ? ' (' + sum.gain_pct.toFixed(1) + '%)' : ''));
            lines.push('');
          }
        }
      }
    }

    // Year-end deadlines
    const deadlines = buildDeadlineCalendar(ctx).filter((d) => d.days_until <= 180 && !d.spouseHandles);
    if (deadlines.length > 0) {
      lines.push('## Upcoming Deadlines (≤ 180 days)');
      for (const d of deadlines) {
        lines.push('- **' + d.date.toISOString().slice(0, 10) + '** (' + d.days_until + 'd) — ' + d.name_en);
      }
      lines.push('');
    }

    // Open questions / preparer notes
    const preparer = coord.preparer || {};
    lines.push('## Open Questions for the Meeting');
    lines.push('Edit this list before sharing — Taigan can suggest more via "💬 Refine with AI".');
    lines.push('1. [ ] (your question here)');
    lines.push('2. [ ] (your question here)');
    lines.push('3. [ ] (your question here)');
    lines.push('');
    if (preparer.notes) {
      lines.push('## Prior Notes');
      lines.push(preparer.notes);
      lines.push('');
    }
    if (preparer.name) {
      lines.push('## Preparer on File');
      lines.push('- **Name**: ' + preparer.name);
      if (preparer.contact) lines.push('- **Contact**: ' + preparer.contact);
      if (preparer.next_appointment) lines.push('- **Next appointment**: ' + preparer.next_appointment);
      lines.push('');
    }

    lines.push('---');
    lines.push('_Generated by Taigan Bridge — single-file financial planning tool for US persons in Japan. All data lives in the user\'s browser; nothing is uploaded anywhere._');
    return lines.join('\n');
  }

  // ─── Resources card ───────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'tax' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('tax.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-tax)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { fontWeight: '600' } }, title),
        el('div', { class: 'tb-field-help', style: { margin: '4px 0' } }, desc),
        url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' } }, url + ' →') : null,
      );
    }
    card.appendChild(resource(t('tax.resources.irs_intl.title'), t('tax.resources.irs_intl.body'),
      'https://www.irs.gov/individuals/international-taxpayers'));
    card.appendChild(resource(t('tax.resources.fbar.title'), t('tax.resources.fbar.body'),
      'https://bsaefiling.fincen.treas.gov/'));
    card.appendChild(resource(t('tax.resources.nta.title'), t('tax.resources.nta.body'),
      'https://www.nta.go.jp/english/'));
    card.appendChild(resource(t('tax.resources.totalization.title'), t('tax.resources.totalization.body'),
      'https://www.ssa.gov/international/Agreement_Pamphlets/japan.html'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  // Surface upcoming deadlines within 60 days. Filters out:
  //   - informational notices (window-open, etc.)
  //   - spouse-handled rows (those are not the user's action items)
  // This honors the JP-filing-responsibility setting transparently
  // because buildDeadlineCalendar already marks JP-personal entries
  // as spouseHandles when the picker says so.
  function genUpcomingDeadlines() {
    const out = [];
    const ctx = buildContext();
    const deadlines = buildDeadlineCalendar(ctx);
    deadlines.forEach((d) => {
      if (d.informational) return;
      if (d.spouseHandles) return;
      if (d.days_until > 60) return;
      if (d.days_until < 0) return;
      const urgency = d.days_until <= 7 ? 'critical'
                    : d.days_until <= 21 ? 'high'
                    : d.days_until <= 45 ? 'medium' : 'low';
      out.push({
        id: 'tax_deadline_' + d.id,
        group: 'tax', urgency,
        icon: '📅',
        title: (d.jurisdiction === 'jp' ? '[JP] ' : '[US] ') + d.name_en + ' — ' + d.days_until + 'd',
        body: 'Filing deadline: ' + d.date.toISOString().slice(0, 10) +
              '. Open Tax Coordinator for the per-form checklist + document list.',
        deadline: d.date.toISOString().slice(0, 10),
        module: 'tax-coordinator', snoozable: d.days_until > 7,
      });
    });
    return out;
  }

  // PFIC alert — fires once when detected. User can dismiss.
  function genPficAlert() {
    const ctx = buildContext();
    if (ctx.has_pfic !== true) return [];
    return [{
      id: 'tax_pfic_detected',
      group: 'tax', urgency: 'high', icon: '⚠',
      title: 'PFIC investments detected — Form 8621 required',
      body: 'Detected likely PFIC: ' + ctx.pfic_account_names.join(', ') +
            '. Default tax treatment is punitive; consider QEF / mark-to-market election or replacement with US-domiciled equivalents. CPA strongly recommended.',
      module: 'tax-coordinator', snoozable: true,
    }];
  }

  // 8938 threshold warning — fires when foreign assets cross 75% of
  // the year-end threshold but haven't yet exceeded it.
  function gen8938Approaching() {
    const ctx = buildContext();
    const t = thresholds_8938(ctx.filing_status, ctx.is_jp_resident);
    if (ctx.foreign_assets_usd >= t.year_end) return [];  // already required, deadline gen handles
    if (ctx.foreign_assets_usd < t.year_end * 0.75) return [];
    const headroom = t.year_end - ctx.foreign_assets_usd;
    return [{
      id: 'tax_8938_approaching',
      group: 'tax', urgency: 'medium', icon: '📊',
      title: 'Form 8938 threshold approaching — $' + Math.round(headroom).toLocaleString() + ' headroom',
      body: 'Your foreign financial assets ($' + Math.round(ctx.foreign_assets_usd).toLocaleString() +
            ') are within 25% of the ' + ctx.filing_status_label + ' threshold ($' + t.year_end.toLocaleString() +
            ' year-end). Once exceeded, Form 8938 becomes required.',
      module: 'tax-coordinator', snoozable: true,
    }];
  }

  // Preparer appointment reminder — fires 7d before scheduled date.
  function genPreparerAppointment() {
    const p = getCoord().preparer || {};
    if (!p.next_appointment) return [];
    const today = new Date(); today.setHours(0,0,0,0);
    const dt = new Date(p.next_appointment + 'T00:00:00');
    const days = Math.round((dt - today) / 86400000);
    if (days < 0 || days > 14) return [];
    return [{
      id: 'tax_preparer_appt',
      group: 'tax', urgency: days <= 3 ? 'high' : 'medium',
      icon: '🤝',
      title: 'Tax preparer appointment in ' + days + 'd — ' + (p.name || 'preparer'),
      body: 'Scheduled: ' + p.next_appointment + '. Review the document checklist in Tax Coordinator before your meeting.',
      deadline: p.next_appointment,
      module: 'tax-coordinator', snoozable: false,
    }];
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = { id, label_en: 'Tax Filing Coordinator', label_jp: '税務申告コーディネーター', render, searchSections: SECTIONS };

  window.TB.taxCoord = {
    actionGenerators: [genUpcomingDeadlines, genPficAlert, gen8938Approaching, genPreparerAppointment],
    buildContext,
    buildDeadlineCalendar,
    FORMS,
    DOC_CATALOG,
    thresholds_8938,
  };
})();
