/* Taigan Bridge — modules/estate.js
 *
 * Estate / Cross-Border Succession orchestration. The completing piece
 * of the life-cycle trilogy:
 *
 *   Tax Coordinator  →  annual cycle (every year you live)
 *   Family           →  life-stage choices (国籍選択, renunciation, gifts)
 *   Estate           →  death / incapacity (this module)
 *
 * This module computes very little of its own state — it derives nearly
 * everything by reading other modules:
 *
 *   Family.members            →  法定相続人 (statutory heirs) + shares
 *                                per Civil Code §887, §889, §890
 *   Family.gifts_log          →  7-year clawback addition to estate
 *   Family.renunciation       →  §2801 transfer-tax warnings
 *   Assets.accounts           →  situs analysis (JP vs US-taxable scope),
 *                                beneficiary inventory, JP/US estate-tax
 *                                exposure
 *   Document Vault.items      →  will / POA / advance-directive presence
 *                                + expiry tracking
 *   Resident.residency        →  10-year worldwide-asset clock determines
 *                                whether worldwide or JP-situs-only is
 *                                the JP estate base
 *   Veteran.survivor          →  SBP coordination
 *
 * JP 相続税 reference (current law):
 *   - Base deduction: ¥30M + ¥6M × number of statutory heirs
 *   - Bracket schedule (per heir's statutory share):
 *       ≤¥10M     10%       ¥10M-30M     15% (-¥0.5M)
 *       ¥30M-50M  20% (-¥2M) ¥50M-100M   30% (-¥7M)
 *       ¥100M-200M 40% (-¥17M) ¥200M-300M 45% (-¥27M)
 *       ¥300M-600M 50% (-¥42M) >¥600M    55% (-¥72M)
 *   - 配偶者控除: spouse pays no tax up to greater of ¥160M
 *     OR spouse's legal share of taxable estate
 *   - 小規模宅地等の特例: -80% on residential land up to 330㎡
 *     (when heir continues to live there)
 *   - 養子 cap (for statutory-heir count purposes):
 *     - 1 if decedent has biological children
 *     - 2 if no biological children
 *
 * Civil Code §887, §889, §890 priority order:
 *   1. Spouse (配偶者) — always inherits if alive
 *   2. Descendants (第1順位) — children, then grandchildren via 代襲相続
 *   3. Ascendants (第2順位) — parents, then grandparents (only if no descendants)
 *   4. Siblings (第3順位) — only if no descendants AND no ascendants
 *
 * Spouse + children:    spouse 1/2, children 1/2 split equally
 * Spouse + parents:     spouse 2/3, parents  1/3 split equally
 * Spouse + siblings:    spouse 3/4, siblings 1/4 split equally
 * No spouse:            entire estate to highest-priority class, split equally
 */

(function () {
  'use strict';

  const id = 'estate';

  // ====================================================================
  // Reference data
  // ====================================================================

  // JP inheritance tax brackets — applied per-heir on their statutory
  // share. Each entry: { upper_jpy, rate, deduction_jpy }.
  // Tax = share × rate − deduction.
  const JP_BRACKETS = [
    { upper:    10_000_000, rate: 0.10, ded:           0 },
    { upper:    30_000_000, rate: 0.15, ded:     500_000 },
    { upper:    50_000_000, rate: 0.20, ded:   2_000_000 },
    { upper:   100_000_000, rate: 0.30, ded:   7_000_000 },
    { upper:   200_000_000, rate: 0.40, ded:  17_000_000 },
    { upper:   300_000_000, rate: 0.45, ded:  27_000_000 },
    { upper:   600_000_000, rate: 0.50, ded:  42_000_000 },
    { upper:   Infinity,    rate: 0.55, ded:  72_000_000 },
  ];

  // Constants used throughout the module.
  const BASE_DEDUCTION_FIXED = 30_000_000;       // ¥30M fixed
  const BASE_DEDUCTION_PER_HEIR = 6_000_000;     // ¥6M per statutory heir
  const SPOUSE_DEDUCTION_MIN = 160_000_000;      // ¥160M floor
  const SHOTAKU_LAND_REDUCTION_PCT = 0.80;       // 小規模宅地等の特例 80%
  const SHOTAKU_AREA_LIMIT_M2 = 330;             // up to 330㎡

  // 7-year clawback effective date (2024 reform). Pre-2024 gifts
  // remain on 3-year clawback. We use this to filter Family.gifts_log
  // when computing addition-back to estate.
  const CLAWBACK_YEARS = 7;

  // US estate tax (informational — most US persons abroad never reach it).
  //   - 2025 unified credit equivalent: $13.99M
  //   - 2026: $15.0M — OBBBA made the higher exemption PERMANENT (then
  //     inflation-indexed); the old TCJA "sunset to ~$7M" did NOT happen.
  //   - US-Japan estate tax treaty allows pro-rata deduction; less
  //     useful than treaty's gift-tax provisions.
  const US_ESTATE_EXEMPTION_2025 = 13_990_000;
  const US_ESTATE_EXEMPTION_2026 = 15_000_000;

  // ====================================================================
  // State accessors
  // ====================================================================

  function getEstate()        { return TB.state.get('estate') || {}; }
  function getStatus()        { return getEstate().status || {}; }
  function getBenOverrides()  { return (getEstate().beneficiaries || {}).overrides || {}; }
  function getLoI()           { return getEstate().letter_of_instruction || {}; }
  function getJpAssumptions() { return getEstate().jp_inheritance_assumptions || {}; }

  function setStatus(value) {
    const e = getEstate();
    e.status = value;
    TB.state.set('estate', e);
  }
  function setBenOverride(account_id, value) {
    const e = getEstate();
    e.beneficiaries = e.beneficiaries || { overrides: {} };
    e.beneficiaries.overrides = e.beneficiaries.overrides || {};
    if (value == null) delete e.beneficiaries.overrides[account_id];
    else e.beneficiaries.overrides[account_id] = value;
    TB.state.set('estate', e);
  }
  function setLoI(value) {
    const e = getEstate();
    e.letter_of_instruction = value;
    TB.state.set('estate', e);
  }
  function setJpAssumptions(value) {
    const e = getEstate();
    e.jp_inheritance_assumptions = value;
    TB.state.set('estate', e);
  }

  // ====================================================================
  // Helpers shared with other modules
  // ====================================================================

  function fxRate() {
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      // Convert 1 JPY → USD via Assets' rate
      const oneUsd = 1 / TB.assets.toUsd(1, 'JPY');
      return oneUsd; // returns USD-per-JPY. Used as multiplier.
    }
    return 1 / 150;  // sensible default
  }
  function jpyToUsd(jpy) {
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      return TB.assets.toUsd(jpy || 0, 'JPY');
    }
    return (jpy || 0) / 150;
  }
  function usdToJpy(usd) {
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      const oneUsdInJpy = 1 / (TB.assets.toUsd(1, 'JPY'));
      return (usd || 0) * oneUsdInJpy;
    }
    return (usd || 0) * 150;
  }

  function ageInYears(birth_date) {
    if (!birth_date) return null;
    const b = new Date(birth_date + 'T00:00:00');
    if (isNaN(b.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    const md = now.getMonth() - b.getMonth();
    if (md < 0 || (md === 0 && now.getDate() < b.getDate())) age--;
    return age;
  }

  // ====================================================================
  // 法定相続人 derivation (from Family roster)
  // ====================================================================

  // Derives the statutory heirs and per-heir shares per Civil Code
  // §887, §889, §890. Returns:
  //   { spouse: { member, share }, primary: [...], rank: 1|2|3|null,
  //     all_heirs: [{ member, share, role }], heir_count_for_tax }
  //
  // heir_count_for_tax includes 養子 caps for the inheritance-tax
  // base-deduction computation.
  function deriveStatutoryHeirs() {
    const members = (TB.family && typeof TB.family.getMembers === 'function')
      ? TB.family.getMembers() : (TB.state.get('family.members') || []);
    const out = {
      spouse: null,
      primary: [],          // descendants (第1順位)
      ascendants: [],       // parents (第2順位)
      siblings: [],         // siblings (第3順位)
      rank: null,           // 1, 2, or 3 — which class joined the spouse
      all_heirs: [],        // flat list with computed shares
      heir_count_for_tax: 0,
      no_heirs: false,
    };

    const spouse = members.find((m) => m.relationship === 'spouse');
    const children = members.filter((m) => m.relationship === 'child');
    const parents = members.filter((m) => m.relationship === 'parent');
    const siblings = members.filter((m) => m.relationship === 'sibling');

    if (spouse) out.spouse = { member: spouse, share: 0 };

    let rank;
    let classMembers;
    if (children.length > 0) { rank = 1; classMembers = children; out.primary = children; }
    else if (parents.length > 0) { rank = 2; classMembers = parents; out.ascendants = parents; }
    else if (siblings.length > 0) { rank = 3; classMembers = siblings; out.siblings = siblings; }
    else { rank = null; classMembers = []; }

    out.rank = rank;

    // Compute shares per Civil Code §900.
    if (spouse && classMembers.length > 0) {
      let spouseShare;
      let classTotal;
      if (rank === 1)      { spouseShare = 1/2; classTotal = 1/2; }
      else if (rank === 2) { spouseShare = 2/3; classTotal = 1/3; }
      else                 { spouseShare = 3/4; classTotal = 1/4; }
      out.spouse.share = spouseShare;
      const perPerson = classTotal / classMembers.length;
      classMembers.forEach((m) => {
        const role = rank === 1 ? 'child' : rank === 2 ? 'parent' : 'sibling';
        out.all_heirs.push({ member: m, share: perPerson, role });
      });
      out.all_heirs.unshift({ member: spouse, share: spouseShare, role: 'spouse' });
    } else if (spouse) {
      out.spouse.share = 1;
      out.all_heirs.push({ member: spouse, share: 1, role: 'spouse' });
    } else if (classMembers.length > 0) {
      const perPerson = 1 / classMembers.length;
      const role = rank === 1 ? 'child' : rank === 2 ? 'parent' : 'sibling';
      classMembers.forEach((m) => {
        out.all_heirs.push({ member: m, share: perPerson, role });
      });
    } else {
      out.no_heirs = true;
    }

    // Tax-purposes heir count: actual heirs, with 養子 caps.
    // Family roster doesn't currently distinguish biological vs adopted;
    // treating all child entries as biological for now. User can adjust
    // via the inheritance assumptions modal. (Future: add adoption flag
    // to Family member schema.)
    out.heir_count_for_tax = out.all_heirs.length || 1;

    return out;
  }

  // ====================================================================
  // Asset situs analysis (cross-references Assets + Resident 10y clock)
  // ====================================================================

  // Determines JP-taxable scope based on 永住者 status (year 6+ of JP
  // tax residency = worldwide assets in scope; pre-永住者 = JP-situs only).
  // Returns { is_pr_for_tax, years_in_japan, jp_situs_jpy, us_situs_jpy,
  //   total_jpy, jp_taxable_estate_jpy, by_account }
  function deriveAssetSitusBase() {
    const accounts = (TB.assets && typeof TB.assets.getActiveAccounts === 'function')
      ? TB.assets.getActiveAccounts() : [];
    const yearsInJp = (TB.resident && typeof TB.resident.yearsInJapan === 'function')
      ? TB.resident.yearsInJapan() : null;
    // 永住者 (tax-permanent) status = year 6+ in Japan
    const is_pr_for_tax = yearsInJp != null && yearsInJp >= 6;

    let jp_situs_jpy = 0;
    let us_situs_jpy = 0;
    const by_account = [];
    accounts.forEach((a) => {
      const jpy = usdToJpy(TB.assets.toUsd(a.balance_native, a.currency));
      const isJp = a.country === 'JP';
      if (isJp) jp_situs_jpy += jpy;
      else us_situs_jpy += jpy;
      by_account.push({
        account: a, jpy,
        situs: isJp ? 'JP' : 'US',
        jp_taxable: isJp || is_pr_for_tax,
      });
    });

    // Add user-overridden "other assets not in our system" estimates.
    const ja = getJpAssumptions();
    if (ja.estimated_other_jp_assets_jpy) jp_situs_jpy += ja.estimated_other_jp_assets_jpy;
    if (ja.estimated_other_us_assets_usd) {
      us_situs_jpy += usdToJpy(ja.estimated_other_us_assets_usd);
    }

    const total_jpy = jp_situs_jpy + us_situs_jpy;
    const jp_taxable_estate_jpy = is_pr_for_tax ? total_jpy : jp_situs_jpy;

    // 7-year clawback addition: gifts to statutory heirs in last 7y.
    const giftsLog = (TB.state.get('family.gifts_log') || []);
    const heirs = deriveStatutoryHeirs();
    const heirIds = new Set(heirs.all_heirs.map((h) => h.member.id));
    const cutoff_year = new Date().getFullYear() - CLAWBACK_YEARS;
    let clawback_jpy = 0;
    giftsLog.forEach((g) => {
      if (g.year < cutoff_year) return;
      if (g.vehicle !== '暦年贈与') return;  // lump-sum vehicles excluded
      if (!heirIds.has(g.recipient_id)) return;
      clawback_jpy += g.amount_jpy || 0;
    });

    return {
      is_pr_for_tax, years_in_japan: yearsInJp,
      jp_situs_jpy, us_situs_jpy, total_jpy,
      jp_taxable_estate_jpy: jp_taxable_estate_jpy + clawback_jpy,
      clawback_jpy,
      by_account,
    };
  }

  // ====================================================================
  // JP 相続税 calculation
  // ====================================================================

  // Tax owed by an heir on a given share amount, using the bracket table.
  function bracketTax(jpy) {
    if (jpy <= 0) return 0;
    for (const b of JP_BRACKETS) {
      if (jpy <= b.upper) return jpy * b.rate - b.ded;
    }
    return 0;
  }

  // Full estate-tax computation per the Japanese 法定相続分課税方式:
  //   1. Taxable estate = gross − base deduction
  //   2. Allocate by statutory share to each heir
  //   3. Apply bracket tax to each heir's allocated amount
  //   4. Sum → total estate tax
  //   5. Apportion back to actual recipients (we use statutory shares
  //      since we don't model wills here)
  //   6. 配偶者控除: subtract spouse's portion entirely (capped at
  //      greater of ¥160M or spouse's legal share)
  //   7. Apply 小規模宅地等の特例 to residential land (if eligible)
  //
  // Returns { gross_jpy, base_deduction, taxable_estate, total_tax,
  //   spouse_credit, net_tax, per_heir: [...] }
  function computeJpInheritanceTax() {
    const heirs = deriveStatutoryHeirs();
    const situs = deriveAssetSitusBase();
    const ja = getJpAssumptions();

    let gross = situs.jp_taxable_estate_jpy;

    // 小規模宅地等の特例 (rough): if user flags JP residential
    // real-estate residence, reduce the JP-situs portion by 80%
    // up to a cap. We don't have land-area data, so we assume the
    // entire residential value qualifies; that's an overstatement
    // but OK for a planning estimate.
    let shotaku_reduction = 0;
    if (ja.has_jp_real_estate_residence) {
      // Estimate the residential portion as half of JP-situs (rough).
      const residential = (situs.jp_situs_jpy + (ja.estimated_other_jp_assets_jpy || 0)) * 0.5;
      shotaku_reduction = residential * SHOTAKU_LAND_REDUCTION_PCT;
      gross -= shotaku_reduction;
    }
    if (gross < 0) gross = 0;

    const base_deduction = BASE_DEDUCTION_FIXED +
      BASE_DEDUCTION_PER_HEIR * (heirs.heir_count_for_tax || 1);

    const taxable_estate = Math.max(0, gross - base_deduction);

    // No taxable estate → no tax. Return early but include heirs view.
    if (taxable_estate === 0 || heirs.all_heirs.length === 0) {
      return {
        gross_jpy: gross, base_deduction, taxable_estate,
        shotaku_reduction, total_tax: 0, spouse_credit: 0, net_tax: 0,
        per_heir: heirs.all_heirs.map((h) => ({
          ...h, allocated: 0, tax: 0, after_credit: 0,
        })),
        clawback_jpy: situs.clawback_jpy,
        is_pr_for_tax: situs.is_pr_for_tax,
        years_in_japan: situs.years_in_japan,
      };
    }

    // Step 2-4: allocate by statutory share, compute per-heir bracket tax,
    // sum to total.
    const per_heir = heirs.all_heirs.map((h) => {
      const allocated = taxable_estate * h.share;
      const tax = bracketTax(allocated);
      return { ...h, allocated, tax, after_credit: tax };
    });
    const total_tax = per_heir.reduce((s, h) => s + h.tax, 0);

    // 配偶者控除: spouse's tax fully eliminated up to greater of
    // ¥160M legal share OR spouse's share of taxable estate.
    let spouse_credit = 0;
    const spouseEntry = per_heir.find((h) => h.role === 'spouse');
    if (spouseEntry) {
      // Spouse's tax-free amount cap
      const spouseCapAmt = Math.max(SPOUSE_DEDUCTION_MIN, spouseEntry.allocated);
      // Spouse's pro-rata of total tax
      const spouseProRataTax = spouseEntry.tax;
      // The portion of spouse's allocated within the cap is fully tax-free
      const taxFreePortion = Math.min(spouseEntry.allocated, spouseCapAmt);
      const fractionTaxFree = spouseEntry.allocated > 0
        ? taxFreePortion / spouseEntry.allocated : 0;
      spouse_credit = spouseProRataTax * fractionTaxFree;
      spouseEntry.after_credit = spouseProRataTax - spouse_credit;
    }
    const net_tax = total_tax - spouse_credit;

    return {
      gross_jpy: gross, base_deduction, taxable_estate,
      shotaku_reduction, total_tax, spouse_credit, net_tax,
      per_heir,
      clawback_jpy: situs.clawback_jpy,
      is_pr_for_tax: situs.is_pr_for_tax,
      years_in_japan: situs.years_in_japan,
    };
  }

  // ====================================================================
  // Beneficiary review (cross-references Assets)
  // ====================================================================

  // Per-account beneficiary record. Combines the Assets' free-form
  // `beneficiary` string with our richer overrides (primary,
  // contingent, percentage, last_reviewed).
  //
  // Returns array of { account, asset_beneficiary, override, gap_reason,
  //   needs_review }.
  function deriveBeneficiaries() {
    const accounts = (TB.assets && typeof TB.assets.getActiveAccounts === 'function')
      ? TB.assets.getActiveAccounts() : [];
    const overrides = getBenOverrides();
    const out = [];
    accounts.forEach((a) => {
      const ovr = overrides[a.id] || null;
      const has_asset_ben = a.beneficiary && a.beneficiary.trim().length > 0;
      const has_override_primary = ovr && ovr.primary && ovr.primary.trim().length > 0;
      let gap_reason = null;
      if (!has_asset_ben && !has_override_primary) {
        gap_reason = 'no_beneficiary';
      } else if (ovr && ovr.last_reviewed) {
        const days = (new Date() - new Date(ovr.last_reviewed + 'T00:00:00')) / 86400000;
        if (days > 365 * 2) gap_reason = 'stale_review';
      } else if (!ovr || !ovr.last_reviewed) {
        gap_reason = 'never_reviewed';
      }
      out.push({
        account: a,
        asset_beneficiary: a.beneficiary || null,
        override: ovr,
        gap_reason,
        needs_review: !!gap_reason,
      });
    });
    return out;
  }

  // ====================================================================
  // Document Vault cross-reference
  // ====================================================================

  function deriveWillStatus() {
    const items = TB.state.get('documentVault.items') || [];
    const wills = items.filter((i) => i.type === 'will');
    // Heuristic: any will document is "present"; specific JP detection
    // would require a country/jurisdiction field on docs. Fall back
    // to title text matching.
    const has_us = wills.some((w) =>
      /us|american|united states|英文/i.test(w.title || '') ||
      (w.notes || '').match(/US|英文|English/));
    const has_jp = wills.some((w) =>
      /公正証書|jp|japan|japanese|和文/i.test(w.title || '') ||
      (w.notes || '').match(/公正証書|和文|Japanese/));
    const has_any = wills.length > 0;
    return {
      count: wills.length,
      has_any,
      has_us_explicit: has_us,
      has_jp_explicit: has_jp,
      // If at least one will but neither tagged, assume single will
      // covers both jurisdictions (suboptimal but common).
      single_assumed: has_any && !has_us && !has_jp,
      items: wills,
    };
  }

  function deriveOtherEstateDocs() {
    const items = TB.state.get('documentVault.items') || [];
    return {
      poa: items.filter((i) => i.type === 'poa'),
      advance_directive: items.filter((i) => i.type === 'advance_directive'),
      trust: items.filter((i) => i.type === 'trust_doc'),
      ben_designation: items.filter((i) => i.type === 'beneficiary_designation'),
    };
  }

  // ====================================================================
  // Onboarding-aware predicates
  // ====================================================================

  function hasSpouse() {
    const members = (TB.family && typeof TB.family.getMembers === 'function')
      ? TB.family.getMembers() : (TB.state.get('family.members') || []);
    if (members.some((m) => m.relationship === 'spouse')) return true;
    const a = TB.state.get('onboarding.answers') || {};
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    return fam.indexOf('us_spouse') !== -1 || fam.indexOf('jp_spouse') !== -1
        || fam.indexOf('third_spouse') !== -1;
  }
  function hasJpExposure() {
    // 永住者 (year 6+) OR JP-situs assets present
    const yrs = (TB.resident && typeof TB.resident.yearsInJapan === 'function')
      ? TB.resident.yearsInJapan() : null;
    if (yrs != null && yrs >= 6) return true;
    const accounts = (TB.assets && typeof TB.assets.getActiveAccounts === 'function')
      ? TB.assets.getActiveAccounts() : [];
    return accounts.some((a) => a.country === 'JP');
  }

  // ====================================================================
  // Section registry
  // ====================================================================

  const SECTIONS = [
    { id: 'header',       always: true, builder: () => buildHeaderCard() },
    { id: 'overview',     always: true, builder: () => buildOverviewCard() },
    {
      id: 'heirs',
      label_en: '法定相続人 calculator',
      label_jp: '法定相続人計算',
      description_en: 'Auto-derives statutory heirs from Family roster (Civil Code §887, §889, §890).',
      description_jp: '家族構成から法定相続人を自動算出(民法 §887, §889, §890)。',
      auto_show: () => true,
      builder: () => buildHeirsCard(),
    },
    {
      id: 'jp_tax',
      label_en: 'JP 相続税 estimate',
      label_jp: '相続税試算',
      description_en: 'Live computation using current brackets, your asset situs, and 配偶者控除.',
      description_jp: '現行税率・資産所在地・配偶者控除を用いたリアルタイム試算。',
      auto_show: hasJpExposure,
      builder: () => buildJpTaxCard(),
    },
    {
      id: 'situs',
      label_en: 'Asset situs analysis',
      label_jp: '資産所在地分析',
      description_en: 'Per-account JP vs US classification; flips to worldwide at 永住者.',
      description_jp: '口座別の日本/米国分類;永住者で全世界に拡大。',
      auto_show: hasJpExposure,
      builder: () => buildSitusCard(),
    },
    {
      id: 'beneficiaries',
      label_en: 'Beneficiary review',
      label_jp: '受取人レビュー',
      description_en: 'Per-account beneficiary tracking with gap detection.',
      description_jp: '口座別受取人追跡とギャップ検出。',
      auto_show: () => true,
      builder: () => buildBeneficiaryCard(),
    },
    {
      id: 'will_tracker',
      label_en: 'Will & legal documents',
      label_jp: '遺言・法的書類',
      description_en: 'Cross-references your Document Vault for wills, POA, advance directive.',
      description_jp: 'Document Vault と相互参照(遺言・POA・事前指示書)。',
      auto_show: () => true,
      builder: () => buildWillTrackerCard(),
    },
    {
      id: 'dual_will',
      label_en: 'Dual-will strategy explainer',
      label_jp: 'デュアル遺言戦略の解説',
      description_en: 'Why two coordinated wills (US + JP) often beat a single international will.',
      description_jp: '調整された 2 通の遺言(米国 + 日本)が単一の国際遺言より優れる理由。',
      auto_show: hasJpExposure,
      builder: () => buildDualWillCard(),
    },
    {
      id: 'koseki',
      label_en: '戸籍 trail (foreigner-specific)',
      label_jp: '戸籍ルート(外国人特有)',
      description_en: 'Workarounds for non-Japanese decedents/heirs; 法定相続情報一覧図.',
      description_jp: '日本人以外の被相続人・相続人の回避策;法定相続情報一覧図。',
      auto_show: hasJpExposure,
      builder: () => buildKosekiCard(),
    },
    {
      id: 'probate_avoid',
      label_en: 'Probate-avoidance toolkit',
      label_jp: '検認回避ツールキット',
      description_en: 'TOD/POD, JTWROS, US trust, 家族信託, beneficiary designations.',
      description_jp: 'TOD/POD・JTWROS・米国信託・家族信託・受取人指定。',
      auto_show: () => true,
      builder: () => buildProbateAvoidanceCard(),
    },
    {
      id: 'secondary',
      label_en: '二次相続 warning',
      label_jp: '二次相続警告',
      description_en: 'The hidden tax bomb when surviving spouse later dies — split vs all-to-spouse trade-off.',
      description_jp: '生存配偶者死亡時の隠れた税負担 — 分割 vs 配偶者全額のトレードオフ。',
      auto_show: hasSpouse,
      builder: () => buildSecondaryInheritanceCard(),
    },
    {
      id: 'loi',
      label_en: 'Letter of Instruction generator',
      label_jp: '遺言補足書ジェネレーター',
      description_en: 'Markdown-format survivor guide stitching together every module.',
      description_jp: '全モジュールを統合した Markdown 形式の遺族ガイド。',
      auto_show: () => true,
      builder: () => buildLetterOfInstructionCard(),
    },
    {
      id: 'assumptions',
      label_en: 'JP inheritance assumptions',
      label_jp: '相続税の前提',
      description_en: 'Override the auto-detection (小規模宅地, 古民家, 事業承継, etc.).',
      description_jp: '自動検出を上書き(小規模宅地・古民家・事業承継など)。',
      auto_show: hasJpExposure,
      builder: () => buildAssumptionsCard(),
    },
    { id: 'resources', always: true, builder: () => buildResourcesCard() },
  ];

  // ====================================================================
  // Module render
  // ====================================================================

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
    return el('div', { class: 'tb-card', 'data-track': 'estate' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'estate' },
          t('estate.badge')),
      ),
      el('h1', null, '🪦 ' + t('estate.title')),
      el('p', { class: 'tb-card-meta' }, t('estate.subtitle')),
    );
  }

  // ─── Overview / readiness ────────────────────────────────────────

  function buildOverviewCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const status = getStatus();
    const willStatus = deriveWillStatus();
    const heirs = deriveStatutoryHeirs();
    const tax = computeJpInheritanceTax();
    const bens = deriveBeneficiaries();
    const benGaps = bens.filter((b) => b.needs_review).length;

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📋 ' + t('estate.section.overview')));

    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
    });

    function tile(label, value, color, hint) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
          borderTop: '3px solid ' + (color || 'var(--tb-track-estate)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' } }, value),
        hint ? el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' } }, hint) : null,
      );
    }

    // Heirs identified
    tiles.appendChild(tile(
      t('estate.overview.heirs'),
      heirs.no_heirs ? '0' : String(heirs.all_heirs.length),
      heirs.no_heirs ? 'var(--tb-error)' : 'var(--tb-success)',
      heirs.no_heirs ? t('estate.overview.no_heirs_hint') : t('estate.overview.heirs_hint'),
    ));

    // Will status
    let willColor, willLabel;
    if (willStatus.has_us_explicit && willStatus.has_jp_explicit) {
      willColor = 'var(--tb-success)';
      willLabel = t('estate.overview.dual_wills');
    } else if (willStatus.has_any) {
      willColor = 'var(--tb-warn)';
      willLabel = t('estate.overview.partial_wills');
    } else {
      willColor = 'var(--tb-error)';
      willLabel = t('estate.overview.no_will');
    }
    tiles.appendChild(tile(t('estate.overview.will'), willLabel, willColor));

    // Beneficiary gaps
    tiles.appendChild(tile(
      t('estate.overview.ben_gaps'),
      String(benGaps),
      benGaps === 0 ? 'var(--tb-success)' :
        benGaps <= 2 ? 'var(--tb-warn)' : 'var(--tb-error)',
      benGaps === 0 ? t('estate.overview.ben_gaps_clean')
                    : t('estate.overview.ben_gaps_hint'),
    ));

    // JP estate tax estimate
    tiles.appendChild(tile(
      t('estate.overview.jp_tax'),
      '¥' + Math.round(tax.net_tax / 1_000_000).toLocaleString() + 'M',
      tax.net_tax > 0 ? 'var(--tb-warn)' : 'var(--tb-success)',
      tax.net_tax > 0
        ? '$' + Math.round(jpyToUsd(tax.net_tax) / 1000).toLocaleString() + 'K USD'
        : t('estate.overview.below_threshold'),
    ));

    card.appendChild(tiles);

    // Readiness checklist
    const checklist = [
      { ok: !heirs.no_heirs, label: t('estate.checklist.heirs') },
      { ok: willStatus.has_any, label: t('estate.checklist.will') },
      { ok: willStatus.has_us_explicit && willStatus.has_jp_explicit, label: t('estate.checklist.dual_will') },
      { ok: deriveOtherEstateDocs().poa.length > 0, label: t('estate.checklist.poa') },
      { ok: deriveOtherEstateDocs().advance_directive.length > 0, label: t('estate.checklist.advance') },
      { ok: benGaps === 0, label: t('estate.checklist.beneficiaries') },
      { ok: !!getLoI().last_generated, label: t('estate.checklist.loi') },
    ];
    const ul = el('ul', { style: { listStyle: 'none', padding: 0, marginTop: 'var(--tb-sp-3)' } });
    checklist.forEach((c) => {
      ul.appendChild(el('li', {
        style: { padding: '4px 0', display: 'flex', alignItems: 'center', gap: '8px' },
      },
        el('span', { style: { color: c.ok ? 'var(--tb-success)' : 'var(--tb-text-soft)', fontWeight: '700' } },
          c.ok ? '✓' : '○'),
        el('span', { style: { color: c.ok ? 'var(--tb-text)' : 'var(--tb-text-soft)' } }, c.label),
      ));
    });
    card.appendChild(ul);

    return card;
  }

  // ─── 法定相続人 card ─────────────────────────────────────────────

  function buildHeirsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const heirs = deriveStatutoryHeirs();

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚖ ' + t('estate.section.heirs')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.heirs.intro')));

    if (heirs.no_heirs) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-error)',
          background: 'rgba(178,58,58,0.06)', borderRadius: 'var(--tb-radius-1)',
          fontSize: 'var(--tb-fs-14)',
        },
      },
        el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
          '⚠ ' + t('estate.heirs.no_heirs_label')),
        el('p', { style: { margin: 0 } }, t('estate.heirs.no_heirs_body')),
      ));
      // Cross-link to add family members
      card.appendChild(el('p', { style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' } },
        el('a', { href: '#', style: { color: 'var(--tb-navy)' },
          onclick: (e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'family' } }));
          },
        }, '↗ ' + t('estate.heirs.add_family_link'))));
      return card;
    }

    // Rank label
    const rankLabel = heirs.rank === 1 ? t('estate.heirs.rank.descendants')
                    : heirs.rank === 2 ? t('estate.heirs.rank.ascendants')
                    : heirs.rank === 3 ? t('estate.heirs.rank.siblings')
                    : t('estate.heirs.rank.spouse_only');
    card.appendChild(el('div', {
      style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginBottom: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
    },
      el('strong', null, t('estate.heirs.priority_class') + ': '), rankLabel));

    // Heir list with shares
    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    heirs.all_heirs.forEach((h) => {
      const m = h.member;
      const name = (lang === 'ja' && m.name_jp) ? m.name_jp : m.name_en;
      const roleLabel = h.role === 'spouse' ? t('estate.heirs.role.spouse')
                      : h.role === 'child' ? t('estate.heirs.role.child')
                      : h.role === 'parent' ? t('estate.heirs.role.parent')
                      : t('estate.heirs.role.sibling');
      const sharePct = (h.share * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
      list.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-estate)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } },
            name || (lang === 'ja' ? '(無題)' : '(untitled)')),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, roleLabel),
        ),
        el('div', {
          style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-22)' },
        }, sharePct),
      ));
    });
    card.appendChild(list);

    // Code reference
    card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      t('estate.heirs.code_ref')));
    return card;
  }

  // ─── JP 相続税 card ──────────────────────────────────────────────

  function buildJpTaxCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const tax = computeJpInheritanceTax();

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '💴 ' + t('estate.section.jp_tax')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openAssumptionsModal() }, '✎ ' + t('estate.assumptions.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.jp_tax.intro')));

    // 永住者 status banner
    if (tax.is_pr_for_tax) {
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-warn)', background: 'rgba(185,122,26,0.06)',
          borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
          fontSize: 'var(--tb-fs-14)' },
      }, '⚠ ' + t('estate.jp_tax.pr_active', {
        years: tax.years_in_japan != null ? tax.years_in_japan : '?',
      })));
    } else if (tax.years_in_japan != null) {
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-estate)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
          fontSize: 'var(--tb-fs-14)' },
      }, 'ℹ ' + t('estate.jp_tax.pre_pr', {
        years: tax.years_in_japan,
        remaining: Math.max(0, 6 - tax.years_in_japan),
      })));
    }

    // Tax breakdown
    function row(label, valueJpy, color) {
      return el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          padding: '6px var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', marginBottom: '4px',
        },
      },
        el('span', null, label),
        el('span', {
          style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600',
            color: color || 'var(--tb-text)' },
        }, '¥' + Math.round(valueJpy).toLocaleString()),
      );
    }
    card.appendChild(row(t('estate.jp_tax.gross'), tax.gross_jpy));
    if (tax.shotaku_reduction > 0) {
      card.appendChild(row('  – ' + t('estate.jp_tax.shotaku'), -tax.shotaku_reduction, 'var(--tb-success)'));
    }
    if (tax.clawback_jpy > 0) {
      card.appendChild(row('  + ' + t('estate.jp_tax.clawback'), tax.clawback_jpy, 'var(--tb-warn)'));
    }
    card.appendChild(row('  – ' + t('estate.jp_tax.base_deduction'), -tax.base_deduction, 'var(--tb-success)'));
    card.appendChild(row(t('estate.jp_tax.taxable_estate'), tax.taxable_estate));
    card.appendChild(row(t('estate.jp_tax.total_tax'), tax.total_tax, 'var(--tb-warn)'));
    if (tax.spouse_credit > 0) {
      card.appendChild(row('  – ' + t('estate.jp_tax.spouse_credit'), -tax.spouse_credit, 'var(--tb-success)'));
    }
    // Net
    card.appendChild(el('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: tax.net_tax > 0 ? 'rgba(185,122,26,0.08)' : 'rgba(47,111,78,0.06)',
        borderRadius: 'var(--tb-radius-2)', marginTop: 'var(--tb-sp-2)',
        borderLeft: '4px solid ' + (tax.net_tax > 0 ? 'var(--tb-warn)' : 'var(--tb-success)'),
      },
    },
      el('span', { style: { fontWeight: '700' } }, t('estate.jp_tax.net')),
      el('span', {
        style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700',
          fontSize: 'var(--tb-fs-22)', color: tax.net_tax > 0 ? 'var(--tb-warn)' : 'var(--tb-success)' },
      }, '¥' + Math.round(tax.net_tax).toLocaleString() + ' / $' + Math.round(jpyToUsd(tax.net_tax)).toLocaleString()),
    ));

    // Per-heir breakdown (collapsible)
    if (tax.per_heir.length > 0 && tax.taxable_estate > 0) {
      const details = el('details', { style: { marginTop: 'var(--tb-sp-3)' } });
      details.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
        t('estate.jp_tax.per_heir_label')));
      const innerList = el('div', { style: { marginTop: 'var(--tb-sp-2)', display: 'flex', flexDirection: 'column', gap: '4px' } });
      tax.per_heir.forEach((h) => {
        const m = h.member;
        const name = (lang === 'ja' && m.name_jp) ? m.name_jp : m.name_en;
        innerList.appendChild(el('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', padding: '4px var(--tb-sp-3)',
            background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
            fontSize: 'var(--tb-fs-12)',
          },
        },
          el('span', null,
            (name || '(untitled)') +
            ' (' + (h.share * 100).toFixed(2).replace(/\.?0+$/, '') + '%)'),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
            '¥' + Math.round(h.allocated).toLocaleString() + ' → ¥' + Math.round(h.after_credit).toLocaleString()),
        ));
      });
      details.appendChild(innerList);
      card.appendChild(details);
    }

    return card;
  }

  // ─── Asset situs analysis ─────────────────────────────────────────

  function buildSitusCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const situs = deriveAssetSitusBase();

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🌐 ' + t('estate.section.situs')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.situs.intro')));

    // Summary tiles
    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-2)' },
    });
    function tile(label, jpy, color) {
      return el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', borderLeft: '3px solid ' + color },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } }, label),
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } },
          '¥' + Math.round(jpy / 1_000_000).toLocaleString() + 'M'),
      );
    }
    tiles.appendChild(tile(t('estate.situs.jp'), situs.jp_situs_jpy, 'var(--tb-track-resident)'));
    tiles.appendChild(tile(t('estate.situs.us'), situs.us_situs_jpy, 'var(--tb-track-tax)'));
    tiles.appendChild(tile(t('estate.situs.total'), situs.total_jpy, 'var(--tb-track-estate)'));
    tiles.appendChild(tile(t('estate.situs.jp_taxable'), situs.jp_taxable_estate_jpy,
      situs.is_pr_for_tax ? 'var(--tb-warn)' : 'var(--tb-success)'));
    card.appendChild(tiles);

    // Per-account breakdown (collapsible)
    if (situs.by_account.length > 0) {
      const details = el('details', { style: { marginTop: 'var(--tb-sp-3)' } });
      details.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
        t('estate.situs.per_account_label')));
      const inner = el('div', { style: { marginTop: 'var(--tb-sp-2)', display: 'flex', flexDirection: 'column', gap: '4px' } });
      situs.by_account.sort((a, b) => b.jpy - a.jpy).forEach((row) => {
        inner.appendChild(el('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            padding: '4px var(--tb-sp-3)', background: 'var(--tb-bg)',
            borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)',
          },
        },
          el('span', null,
            el('span', {
              style: {
                display: 'inline-block', padding: '1px 6px', marginRight: '6px',
                fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
                borderRadius: 'var(--tb-radius-pill)', color: '#fff',
                background: row.situs === 'JP' ? '#B23A3A' : '#1A4480',
              },
            }, row.situs),
            row.account.institution + ' / ' + row.account.name,
            row.jp_taxable ? el('span', { style: { color: 'var(--tb-warn)', marginLeft: '6px' } }, '⚠ JP-taxable') : null,
          ),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
            '¥' + Math.round(row.jpy).toLocaleString()),
        ));
      });
      details.appendChild(inner);
      card.appendChild(details);
    }

    return card;
  }

  // ─── Beneficiary review ───────────────────────────────────────────

  function buildBeneficiaryCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const bens = deriveBeneficiaries();

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '👤 ' + t('estate.section.beneficiaries')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.beneficiaries.intro')));

    if (bens.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('estate.beneficiaries.empty')));
      return card;
    }

    // Sort: gaps first (no_beneficiary, then never_reviewed, then stale_review),
    // then complete records.
    const order = { no_beneficiary: 0, never_reviewed: 1, stale_review: 2 };
    bens.sort((a, b) => {
      const ra = a.gap_reason ? order[a.gap_reason] : 99;
      const rb = b.gap_reason ? order[b.gap_reason] : 99;
      return ra - rb;
    });

    bens.forEach((b) => {
      const a = b.account;
      let color, label;
      if (b.gap_reason === 'no_beneficiary') { color = 'var(--tb-error)'; label = t('estate.beneficiaries.gap.none'); }
      else if (b.gap_reason === 'never_reviewed') { color = 'var(--tb-warn)'; label = t('estate.beneficiaries.gap.never'); }
      else if (b.gap_reason === 'stale_review') { color = 'var(--tb-warn)'; label = t('estate.beneficiaries.gap.stale'); }
      else { color = 'var(--tb-success)'; label = '✓'; }
      const benDisplay = (b.override && b.override.primary) || b.asset_beneficiary || (lang === 'ja' ? '(未設定)' : '(none set)');
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } },
          a.institution + ' / ' + a.name),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          t('estate.beneficiaries.primary') + ': ' + benDisplay),
      ));
      const right = el('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' } });
      right.appendChild(el('span', { style: { color, fontSize: 'var(--tb-fs-12)', fontWeight: '600' } }, label));
      right.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openBeneficiaryModal(a),
      }, '✎ ' + t('estate.beneficiaries.edit')));
      row.appendChild(right);
      card.appendChild(row);
    });
    return card;
  }

  function openBeneficiaryModal(account) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const overrides = getBenOverrides();
    const draft = Object.assign({
      primary: account.beneficiary || '',
      contingent: '',
      percentage: 100,
      last_reviewed: new Date().toISOString().slice(0, 10),
      notes: '',
    }, overrides[account.id] || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      t('estate.modal.beneficiary') + ': ' + account.institution + ' / ' + account.name));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }
    modal.appendChild(field(t('estate.beneficiaries.primary'),
      el('input', { type: 'text', class: 'tb-input', value: draft.primary,
        oninput: (e) => { draft.primary = e.target.value; } })));
    modal.appendChild(field(t('estate.beneficiaries.contingent'),
      el('input', { type: 'text', class: 'tb-input', value: draft.contingent || '',
        oninput: (e) => { draft.contingent = e.target.value; } })));
    modal.appendChild(field(t('estate.beneficiaries.last_reviewed'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.last_reviewed,
        oninput: (e) => { draft.last_reviewed = e.target.value; } })));
    modal.appendChild(field(t('estate.beneficiaries.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('estate.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setBenOverride(account.id, draft); close(); rerender(); } }, t('estate.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Will & POA tracker ───────────────────────────────────────────

  function buildWillTrackerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const willStatus = deriveWillStatus();
    const otherDocs = deriveOtherEstateDocs();

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📜 ' + t('estate.section.will_tracker')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.will_tracker.intro')));

    function docRow(label, items, addType) {
      const has = items.length > 0;
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (has ? 'var(--tb-success)' : 'var(--tb-error)'),
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } },
          (has ? '✓ ' : '○ ') + label),
        items.length > 1
          ? el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
              items.length + ' ' + t('estate.will_tracker.docs_in_vault'))
          : null,
      ));
      row.appendChild(el('a', {
        href: '#',
        style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)', whiteSpace: 'nowrap' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'document-vault' } }));
        },
      }, has ? (t('estate.will_tracker.view_vault') + ' →')
            : (t('estate.will_tracker.add_to_vault') + ' →')));
      return row;
    }

    card.appendChild(docRow(t('estate.will_tracker.us_will'),
      willStatus.has_us_explicit ? willStatus.items.filter((w) =>
        /us|american|united states|英文/i.test(w.title || '')) : [],
      'will'));
    card.appendChild(docRow(t('estate.will_tracker.jp_will'),
      willStatus.has_jp_explicit ? willStatus.items.filter((w) =>
        /公正証書|jp|japan|japanese|和文/i.test(w.title || '')) : [],
      'will'));

    if (willStatus.single_assumed) {
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
          background: 'rgba(185,122,26,0.06)', borderRadius: 'var(--tb-radius-1)',
          fontSize: 'var(--tb-fs-12)', marginBottom: 'var(--tb-sp-2)' },
      }, '⚠ ' + t('estate.will_tracker.single_will_warning')));
    }

    card.appendChild(docRow(t('estate.will_tracker.poa'), otherDocs.poa, 'poa'));
    card.appendChild(docRow(t('estate.will_tracker.advance'), otherDocs.advance_directive, 'advance_directive'));
    card.appendChild(docRow(t('estate.will_tracker.trust'), otherDocs.trust, 'trust_doc'));
    card.appendChild(docRow(t('estate.will_tracker.ben_designation'), otherDocs.ben_designation, 'beneficiary_designation'));

    return card;
  }

  // ─── Dual-will strategy explainer ─────────────────────────────────

  function buildDualWillCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📑 ' + t('estate.section.dual_will')));
    card.appendChild(el('p', null, t('estate.dual_will.intro')));

    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)' },
    });
    function tile(title, body, bullets) {
      const div = el('div', {
        style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)' },
      });
      div.appendChild(el('div', { style: { fontWeight: '700', marginBottom: '4px' } }, title));
      div.appendChild(el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-2)' } }, body));
      const ul = el('ul', { style: { paddingLeft: '20px', margin: 0 } });
      bullets.forEach((b) => ul.appendChild(el('li', { style: { fontSize: 'var(--tb-fs-12)', marginBottom: '4px' } }, b)));
      div.appendChild(ul);
      return div;
    }
    grid.appendChild(tile(
      t('estate.dual_will.us_will_title'),
      t('estate.dual_will.us_will_body'),
      [
        t('estate.dual_will.us_bullet1'),
        t('estate.dual_will.us_bullet2'),
        t('estate.dual_will.us_bullet3'),
        t('estate.dual_will.us_bullet4'),
      ]));
    grid.appendChild(tile(
      t('estate.dual_will.jp_will_title'),
      t('estate.dual_will.jp_will_body'),
      [
        t('estate.dual_will.jp_bullet1'),
        t('estate.dual_will.jp_bullet2'),
        t('estate.dual_will.jp_bullet3'),
        t('estate.dual_will.jp_bullet4'),
      ]));
    card.appendChild(grid);

    card.appendChild(el('div', {
      style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid var(--tb-track-estate)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-1)', marginTop: 'var(--tb-sp-3)',
        fontSize: 'var(--tb-fs-12)' },
    }, '💡 ' + t('estate.dual_will.no_conflict')));

    return card;
  }

  // ─── 戸籍 trail card ──────────────────────────────────────────────

  function buildKosekiCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📋 ' + t('estate.section.koseki')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.koseki.intro')));

    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 0 } });
    [
      'estate.koseki.point1',
      'estate.koseki.point2',
      'estate.koseki.point3',
      'estate.koseki.point4',
      'estate.koseki.point5',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── Probate-avoidance strategies card ───────────────────────────

  function buildProbateAvoidanceCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🚪 ' + t('estate.section.probate_avoid')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.probate_avoid.intro')));

    const tools = [
      { id: 'tod_pod', title: 'TOD / POD', body_key: 'estate.probate_avoid.tod_body', good: ['us_situs'], bad: ['jp_situs'] },
      { id: 'jtwros',  title: 'JTWROS',    body_key: 'estate.probate_avoid.jtwros_body', good: ['us_situs'], bad: ['jp_situs'] },
      { id: 'living_trust', title: 'Living Trust (Revocable)', body_key: 'estate.probate_avoid.trust_body', good: ['us_situs'], bad: ['jp_situs'] },
      { id: 'kazoku_shintaku', title: '家族信託 (Family Trust, JP)', body_key: 'estate.probate_avoid.kazoku_body', good: ['jp_situs'], bad: [] },
      { id: 'beneficiary', title: 'Beneficiary designations', body_key: 'estate.probate_avoid.bd_body', good: ['us_situs', 'jp_situs'], bad: [] },
    ];
    tools.forEach((tool) => {
      const wrap = el('details', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-estate)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)' },
      });
      const summary = el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
        tool.title);
      wrap.appendChild(summary);
      wrap.appendChild(el('p', { style: { marginTop: 'var(--tb-sp-2)', marginBottom: 0, fontSize: 'var(--tb-fs-12)' } },
        t(tool.body_key)));
      card.appendChild(wrap);
    });
    return card;
  }

  // ─── 二次相続 (secondary inheritance) warning ──────────────────────

  function buildSecondaryInheritanceCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const heirs = deriveStatutoryHeirs();
    if (!heirs.spouse) return el('div', { style: { display: 'none' } });

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🔄 ' + t('estate.section.secondary')));
    card.appendChild(el('p', null, t('estate.secondary.intro')));

    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185,122,26,0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '⚠ ' + t('estate.secondary.warning_label')),
      el('p', { style: { margin: 0 } }, t('estate.secondary.warning_body')),
    ));

    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-2)' } });
    [
      'estate.secondary.tip1',
      'estate.secondary.tip2',
      'estate.secondary.tip3',
      'estate.secondary.tip4',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── Letter of Instruction generator ─────────────────────────────

  function buildLetterOfInstructionCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const loi = getLoI();
    const lastGen = loi.last_generated;

    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '✉ ' + t('estate.section.loi')),
      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } },
        el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => openLoiModal() }, '✎ ' + t('estate.edit')),
        el('button', { class: 'tb-btn', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => generateAndDownloadLoi() }, '⬇ ' + t('estate.loi.generate')),
      ),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.loi.intro')));

    if (lastGen) {
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('estate.loi.last_generated') + ': ' + new Date(lastGen).toLocaleDateString()));
    } else {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('estate.loi.never_generated')));
    }

    return card;
  }

  function openLoiModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      funeral_preferences: '',
      pet_instructions: '',
      digital_accounts_note: '',
      important_contacts: [],
      additional_notes: '',
    }, getLoI());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('estate.modal.loi')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.modal.loi_help')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('estate.loi.funeral'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.funeral_preferences = e.target.value; } },
        draft.funeral_preferences || ''),
      t('estate.loi.funeral.help')));

    modal.appendChild(field(t('estate.loi.pets'),
      el('textarea', { class: 'tb-input', rows: 2,
        oninput: (e) => { draft.pet_instructions = e.target.value; } },
        draft.pet_instructions || '')));

    modal.appendChild(field(t('estate.loi.digital'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.digital_accounts_note = e.target.value; } },
        draft.digital_accounts_note || ''),
      t('estate.loi.digital.help')));

    // Important contacts — simple table-style editor
    const contactsWrap = el('div', { class: 'tb-field' });
    contactsWrap.appendChild(el('label', { class: 'tb-field-label' }, t('estate.loi.contacts')));
    const contactsList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
    function renderContacts() {
      contactsList.innerHTML = '';
      draft.important_contacts.forEach((c, i) => {
        const row = el('div', { style: { display: 'grid', gridTemplateColumns: '2fr 2fr 2fr 1fr auto', gap: '4px' } });
        row.appendChild(el('input', { type: 'text', class: 'tb-input', placeholder: t('estate.loi.contacts.name'),
          value: c.name || '', oninput: (e) => { c.name = e.target.value; } }));
        row.appendChild(el('input', { type: 'text', class: 'tb-input', placeholder: t('estate.loi.contacts.role'),
          value: c.role || '', oninput: (e) => { c.role = e.target.value; } }));
        row.appendChild(el('input', { type: 'text', class: 'tb-input', placeholder: t('estate.loi.contacts.contact'),
          value: c.contact || '', oninput: (e) => { c.contact = e.target.value; } }));
        row.appendChild(el('input', { type: 'text', class: 'tb-input', placeholder: t('estate.loi.contacts.relationship'),
          value: c.relationship || '', oninput: (e) => { c.relationship = e.target.value; } }));
        row.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 8px' },
          onclick: () => { draft.important_contacts.splice(i, 1); renderContacts(); } }, '🗑'));
        contactsList.appendChild(row);
      });
    }
    renderContacts();
    contactsWrap.appendChild(contactsList);
    contactsWrap.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)', marginTop: '4px' },
      onclick: () => { draft.important_contacts.push({}); renderContacts(); } },
      '＋ ' + t('estate.loi.contacts.add')));
    modal.appendChild(contactsWrap);

    modal.appendChild(field(t('estate.loi.additional'),
      el('textarea', { class: 'tb-input', rows: 4,
        oninput: (e) => { draft.additional_notes = e.target.value; } },
        draft.additional_notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('estate.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setLoI(draft); close(); rerender(); } }, t('estate.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // Generates a Markdown-format Letter of Instruction by stitching
  // together state from every relevant module. User downloads the .md
  // file and prints it to keep with the will.
  function generateAndDownloadLoi() {
    const profile = TB.state.get('profile') || {};
    const loi = getLoI();
    const heirs = deriveStatutoryHeirs();
    const tax = computeJpInheritanceTax();
    const accounts = (TB.assets && typeof TB.assets.getActiveAccounts === 'function')
      ? TB.assets.getActiveAccounts() : [];
    const willStatus = deriveWillStatus();
    const otherDocs = deriveOtherEstateDocs();
    const giftsLog = TB.state.get('family.gifts_log') || [];
    const today = new Date().toISOString().slice(0, 10);

    const lines = [];
    lines.push('# Letter of Instruction');
    lines.push('');
    lines.push('**Prepared by:** ' + (profile.displayName || '(unspecified)'));
    lines.push('**Date generated:** ' + today);
    lines.push('');
    lines.push('> *This document is informational guidance for survivors. It is NOT a will and has no legal force. Use alongside (never instead of) properly executed wills in each jurisdiction where you hold assets.*');
    lines.push('');

    // 1. Family / heirs
    lines.push('## 1. Statutory Heirs (法定相続人)');
    lines.push('');
    if (heirs.no_heirs) {
      lines.push('*No statutory heirs identified in family roster. Estate may default to JP state (国庫帰属) unless will provides otherwise.*');
    } else {
      lines.push('| Heir | Relationship | Share |');
      lines.push('|------|--------------|-------|');
      heirs.all_heirs.forEach((h) => {
        const m = h.member;
        const name = (m.name_en || m.name_jp || '(unnamed)');
        const rel = h.role;
        const sharePct = (h.share * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
        lines.push('| ' + name + ' | ' + rel + ' | ' + sharePct + ' |');
      });
    }
    lines.push('');

    // 2. Asset inventory
    lines.push('## 2. Asset Inventory');
    lines.push('');
    if (accounts.length === 0) {
      lines.push('*No accounts in Asset tracker.*');
    } else {
      lines.push('| Institution | Name | Country | Wrapper | Currency | Balance | Beneficiary |');
      lines.push('|-------------|------|---------|---------|----------|---------|-------------|');
      accounts.forEach((a) => {
        const ovr = (getBenOverrides()[a.id] || {});
        const ben = ovr.primary || a.beneficiary || '*(not set)*';
        lines.push('| ' + (a.institution || '—') +
          ' | ' + (a.name || '—') +
          ' | ' + (a.country || '—') +
          ' | ' + (a.tax_wrapper || '—') +
          ' | ' + (a.currency || '—') +
          ' | ' + (a.balance_native != null ? a.balance_native.toLocaleString() : '—') +
          ' | ' + ben + ' |');
      });
    }
    lines.push('');

    // 3. Will & legal documents
    lines.push('## 3. Wills & Legal Documents (in Document Vault)');
    lines.push('');
    function listDocs(label, items) {
      lines.push('**' + label + ':** ' + (items.length === 0 ? '*none on record*' : items.length + ' record(s)'));
      items.forEach((it) => {
        lines.push('  - ' + (it.title || '(untitled)') +
          (it.storage_location ? ' — ' + it.storage_location : ''));
      });
    }
    listDocs('Will(s)', willStatus.items);
    listDocs('Power of Attorney', otherDocs.poa);
    listDocs('Advance Directive', otherDocs.advance_directive);
    listDocs('Trust documents', otherDocs.trust);
    listDocs('Beneficiary designations', otherDocs.ben_designation);
    lines.push('');

    // 4. JP inheritance tax preview
    lines.push('## 4. JP Inheritance Tax (相続税) Estimate');
    lines.push('');
    lines.push('- **Estate base (gross):** ¥' + Math.round(tax.gross_jpy).toLocaleString());
    lines.push('- **Base deduction:** ¥' + Math.round(tax.base_deduction).toLocaleString());
    lines.push('- **Taxable estate:** ¥' + Math.round(tax.taxable_estate).toLocaleString());
    lines.push('- **Total tax (before spouse credit):** ¥' + Math.round(tax.total_tax).toLocaleString());
    lines.push('- **Spouse credit applied:** ¥' + Math.round(tax.spouse_credit).toLocaleString());
    lines.push('- **Net estate tax owed:** ¥' + Math.round(tax.net_tax).toLocaleString() +
      ' (≈$' + Math.round(jpyToUsd(tax.net_tax)).toLocaleString() + ' USD)');
    lines.push('');
    lines.push('*This is a planning estimate, not a tax filing. Engage a 税理士 (Japanese tax accountant) within 10 months of death to file the actual 相続税申告書.*');
    lines.push('');

    // 5. Recent gifts (7y clawback awareness)
    if (giftsLog.length > 0) {
      lines.push('## 5. Recent Gifts (7-Year Clawback Window)');
      lines.push('');
      lines.push('*Gifts made within 7 years of death are added back to the estate for tax purposes. Below is the recorded gift history:*');
      lines.push('');
      const cutoff = new Date().getFullYear() - 7;
      const inWindow = giftsLog.filter((g) => g.year >= cutoff);
      if (inWindow.length === 0) {
        lines.push('*No gifts in the past 7 years.*');
      } else {
        inWindow.forEach((g) => {
          lines.push('- **' + g.year + '** — ¥' + (g.amount_jpy || 0).toLocaleString() +
            ' via ' + g.vehicle + (g.notes ? ' (' + g.notes + ')' : ''));
        });
      }
      lines.push('');
    }

    // 6. Funeral / personal preferences
    lines.push('## 6. Personal Preferences');
    lines.push('');
    if (loi.funeral_preferences) {
      lines.push('### Funeral wishes');
      lines.push(loi.funeral_preferences);
      lines.push('');
    }
    if (loi.pet_instructions) {
      lines.push('### Pet care');
      lines.push(loi.pet_instructions);
      lines.push('');
    }
    if (loi.digital_accounts_note) {
      lines.push('### Digital accounts');
      lines.push(loi.digital_accounts_note);
      lines.push('');
    }

    // 7. Important contacts
    if (loi.important_contacts && loi.important_contacts.length > 0) {
      lines.push('## 7. Important Contacts');
      lines.push('');
      lines.push('| Name | Relationship | Role | Contact |');
      lines.push('|------|--------------|------|---------|');
      loi.important_contacts.forEach((c) => {
        lines.push('| ' + (c.name || '—') +
          ' | ' + (c.relationship || '—') +
          ' | ' + (c.role || '—') +
          ' | ' + (c.contact || '—') + ' |');
      });
      lines.push('');
    }

    // 8. Additional notes
    if (loi.additional_notes) {
      lines.push('## 8. Additional Notes');
      lines.push('');
      lines.push(loi.additional_notes);
      lines.push('');
    }

    // 9. Action checklist for survivors
    lines.push('## 9. First-30-Days Action Checklist for Survivors');
    lines.push('');
    lines.push('- [ ] Obtain death certificate (multiple certified copies — both jurisdictions)');
    lines.push('- [ ] Notify Social Security Administration (US): 1-800-772-1213');
    lines.push('- [ ] Notify Japanese 市役所/区役所 (within 7 days for 死亡届)');
    lines.push('- [ ] Locate and read all wills (US + JP)');
    lines.push('- [ ] Contact named executor(s) and/or attorneys');
    lines.push('- [ ] Notify all banks, brokerages, retirement plan administrators');
    lines.push('- [ ] If decedent was Japan tax resident: engage 税理士 (10-month clock starts)');
    lines.push('- [ ] If US-citizen decedent: engage CPA for final 1040 + 706 (if estate >$13.99M)');
    lines.push('- [ ] Cancel/transfer credit cards, utilities, subscriptions');
    lines.push('- [ ] Update beneficiaries on surviving spouse\'s accounts');
    lines.push('');
    lines.push('---');
    lines.push('*Generated by Taigan Bridge — taigan-bridge.local*');

    const md = lines.join('\n');

    // Save and trigger download
    const loiState = getLoI();
    loiState.last_generated = new Date().toISOString();
    setLoI(loiState);

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'letter-of-instruction-' + today + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    rerender();
  }

  // ─── JP inheritance assumptions modal ────────────────────────────

  function buildAssumptionsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ja = getJpAssumptions();
    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '⚙ ' + t('estate.section.assumptions')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openAssumptionsModal() }, '✎ ' + t('estate.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('estate.assumptions.intro')));

    const dl = el('dl', { class: 'tb-dl' });
    function row(label, val) {
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', null, val));
    }
    row(t('estate.assumptions.shotaku'), ja.has_jp_real_estate_residence ? '✓' : '○');
    row(t('estate.assumptions.kominka'), ja.expects_kominka ? '✓' : '○');
    row(t('estate.assumptions.business'), ja.expects_business_succession ? '✓' : '○');
    if (ja.estimated_other_jp_assets_jpy) {
      row(t('estate.assumptions.other_jp'), '¥' + ja.estimated_other_jp_assets_jpy.toLocaleString());
    }
    if (ja.estimated_other_us_assets_usd) {
      row(t('estate.assumptions.other_us'), '$' + ja.estimated_other_us_assets_usd.toLocaleString());
    }
    card.appendChild(dl);
    return card;
  }

  function openAssumptionsModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      expects_kominka: false,
      expects_business_succession: false,
      has_jp_real_estate_residence: false,
      estimated_other_jp_assets_jpy: null,
      estimated_other_us_assets_usd: null,
    }, getJpAssumptions());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('estate.modal.assumptions')));

    function checkbox(label, key, help) {
      const cb = el('input', { type: 'checkbox', checked: !!draft[key],
        style: { marginRight: '8px' },
        onchange: (e) => { draft[key] = !!e.target.checked; } });
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
          cb, label),
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }
    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(checkbox(t('estate.assumptions.shotaku'),
      'has_jp_real_estate_residence', t('estate.assumptions.shotaku.help')));
    modal.appendChild(checkbox(t('estate.assumptions.kominka'),
      'expects_kominka', t('estate.assumptions.kominka.help')));
    modal.appendChild(checkbox(t('estate.assumptions.business'),
      'expects_business_succession', t('estate.assumptions.business.help')));
    modal.appendChild(field(t('estate.assumptions.other_jp'),
      el('input', { type: 'number', class: 'tb-input', step: '1000000', min: '0',
        value: draft.estimated_other_jp_assets_jpy != null ? draft.estimated_other_jp_assets_jpy : '',
        placeholder: '0',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.estimated_other_jp_assets_jpy = isFinite(v) ? v : null;
        } }),
      t('estate.assumptions.other_jp.help')));
    modal.appendChild(field(t('estate.assumptions.other_us'),
      el('input', { type: 'number', class: 'tb-input', step: '10000', min: '0',
        value: draft.estimated_other_us_assets_usd != null ? draft.estimated_other_us_assets_usd : '',
        placeholder: '0',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.estimated_other_us_assets_usd = isFinite(v) ? v : null;
        } }),
      t('estate.assumptions.other_us.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('estate.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setJpAssumptions(draft); close(); rerender(); } }, t('estate.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Resources ────────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'estate' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('estate.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-estate)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)' },
      },
        el('div', { style: { fontWeight: '600' } }, title),
        el('div', { class: 'tb-field-help', style: { margin: '4px 0' } }, desc),
        url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' } }, url + ' →') : null,
      );
    }
    card.appendChild(resource(t('estate.resources.nta_inheritance.title'),
      t('estate.resources.nta_inheritance.body'),
      'https://www.nta.go.jp/english/taxes/individual/12011.htm'));
    card.appendChild(resource(t('estate.resources.koseki_info.title'),
      t('estate.resources.koseki_info.body'),
      'https://www.moj.go.jp/MINJI/minji13.html'));
    card.appendChild(resource(t('estate.resources.ssa_survivors.title'),
      t('estate.resources.ssa_survivors.body'),
      'https://www.ssa.gov/benefits/survivors/'));
    card.appendChild(resource(t('estate.resources.us_treaty.title'),
      t('estate.resources.us_treaty.body'),
      'https://www.irs.gov/businesses/international-businesses/japan-tax-treaty-documents'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genBeneficiaryReviewOverdue() {
    const status = getStatus();
    const last = status.last_beneficiary_review;
    if (last) {
      const days = (new Date() - new Date(last + 'T00:00:00')) / 86400000;
      if (days < 365) return [];
    }
    const bens = deriveBeneficiaries();
    const gaps = bens.filter((b) => b.needs_review);
    if (gaps.length === 0 && last) return [];
    return [{
      id: 'estate_ben_review',
      group: 'estate',
      urgency: gaps.length > 3 ? 'high' : 'medium',
      icon: '👤',
      title: gaps.length > 0
        ? gaps.length + ' account(s) need beneficiary review'
        : 'Annual beneficiary review',
      body: 'Open Estate → Beneficiary Review. Common gaps: TSP/401(k) without contingent beneficiary, IRAs left to "estate" instead of named persons, JP bank accounts with no 受取人 designation. After divorce, marriage, birth, death — review immediately.',
      module: 'estate', snoozable: true,
    }];
  }

  function genWillMissing() {
    const willStatus = deriveWillStatus();
    if (willStatus.has_any) return [];
    return [{
      id: 'estate_will_missing',
      group: 'estate',
      urgency: 'high',
      icon: '📜',
      title: 'No will on record',
      body: 'Without a will, your estate distributes per Japanese intestacy (民法 §887, §889, §890) for JP-situs and per US state intestacy for US-situs — neither may match your intent. For US persons in Japan, you generally want BOTH a US will (covers US-situs) and a JP 公正証書遺言 (notarized JP will, fastest probate path).',
      module: 'estate', snoozable: true,
    }];
  }

  function genDualWillIncomplete() {
    const willStatus = deriveWillStatus();
    if (!willStatus.has_any) return [];  // covered by genWillMissing
    if (willStatus.has_us_explicit && willStatus.has_jp_explicit) return [];
    return [{
      id: 'estate_dual_will_incomplete',
      group: 'estate',
      urgency: 'medium',
      icon: '📑',
      title: 'Single will may not cover both jurisdictions',
      body: 'You have a will in Document Vault but it\'s not tagged as both US + JP. Cross-border estates work best with two wills (one per jurisdiction), each with a "no conflict / no revocation" clause. JP probate without a 公正証書遺言 routes through 家庭裁判所 — typically slower and more expensive.',
      module: 'estate', snoozable: true,
    }];
  }

  function genJpTaxExposure() {
    const tax = computeJpInheritanceTax();
    if (tax.net_tax === 0) return [];
    if (tax.net_tax < 5_000_000) return [];  // <¥5M not worth flagging
    return [{
      id: 'estate_jp_tax_exposure',
      group: 'estate',
      urgency: tax.net_tax > 50_000_000 ? 'high' : 'medium',
      icon: '💴',
      title: 'JP 相続税 exposure: ¥' + Math.round(tax.net_tax / 1_000_000) + 'M ($' +
        Math.round(jpyToUsd(tax.net_tax) / 1000) + 'K USD)',
      body: 'Your projected JP inheritance tax. Consider mitigation: lifetime 暦年贈与 to heirs (¥1.1M/yr each), 教育資金一括贈与 to grandkids (¥15M lump sum), residential 小規模宅地等の特例 if heir continues to live in the home. Open Family → Inheritance Pre-Positioning to track.',
      module: 'estate', snoozable: true,
    }];
  }

  function genTenYearClockApproaching() {
    if (!TB.resident || typeof TB.resident.tenYearClock !== 'function') return [];
    const clock = TB.resident.tenYearClock();
    if (!clock) return [];
    if (clock.days < 0) return [];        // already past
    if (clock.days > 365 * 2) return [];  // not yet
    return [{
      id: 'estate_tenyear_warning',
      group: 'estate',
      urgency: clock.days < 365 ? 'high' : 'medium',
      icon: '⏳',
      title: 'JP worldwide-asset clock — estate scope expanding in ' +
        Math.floor(clock.days / 365) + 'y ' + Math.round((clock.days % 365) / 30) + 'mo',
      body: 'When you cross 永住者 status (year 6+ as JP tax resident), your WORLDWIDE assets — US 401(k), IRA, brokerage, real estate — become subject to JP inheritance tax. Review Asset Situs in Estate to see the scope shift. Plan now: structured gifting, trust strategies, situs reorganization.',
      deadline: clock.date,
      module: 'estate', snoozable: true,
    }];
  }

  function genPostRenunciationTransferTax() {
    const r = TB.state.get('family.renunciation') || {};
    if (!r.contemplating) return [];
    // Only fires if there are US-citizen children/heirs
    const members = TB.state.get('family.members') || [];
    const hasUsHeirs = members.some((m) =>
      (m.relationship === 'child' || m.relationship === 'spouse') &&
      (m.citizenships || []).indexOf('US') !== -1);
    if (!hasUsHeirs) return [];
    return [{
      id: 'estate_2801_warning',
      group: 'estate',
      urgency: 'medium',
      icon: '⚠',
      title: '§2801 transfer tax — covered-expat gifts to US-person heirs',
      body: 'You\'re considering renunciation AND have US-citizen family members. Post-renunciation, future gifts/bequests from a covered expatriate to a US-person heir trigger IRC §2801 — a 40% transfer tax PAID BY THE RECIPIENT (your kids). For estates intended for US-person heirs, this can dwarf the exit tax. Discuss alternatives with a specialist BEFORE filing DS-4079.',
      module: 'estate', snoozable: true,
    }];
  }

  function genLoiStale() {
    const loi = getLoI();
    if (!loi.last_generated) {
      return [{
        id: 'estate_loi_never',
        group: 'estate',
        urgency: 'low',
        icon: '✉',
        title: 'Letter of Instruction never generated',
        body: 'A Letter of Instruction stitches together heirs, accounts, beneficiaries, gifts, will locations, funeral wishes, and a survivor\'s 30-day checklist. It\'s informational (not a will) — but it dramatically reduces survivor confusion. Generate a Markdown file from Estate → Letter of Instruction, print it, and store it with your will.',
        module: 'estate', snoozable: true,
      }];
    }
    const days = (new Date() - new Date(loi.last_generated)) / 86400000;
    if (days < 365) return [];
    return [{
      id: 'estate_loi_stale',
      group: 'estate',
      urgency: 'low',
      icon: '✉',
      title: 'Letter of Instruction is ' + Math.floor(days / 365) + 'y stale',
      body: 'Family / asset / beneficiary state has likely changed. Regenerate from Estate → Letter of Instruction.',
      module: 'estate', snoozable: true,
    }];
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Estate & Succession', label_jp: '相続・承継', render,
    searchSections: SECTIONS,
  };

  window.TB.estate = {
    actionGenerators: [
      genBeneficiaryReviewOverdue, genWillMissing, genDualWillIncomplete,
      genJpTaxExposure, genTenYearClockApproaching,
      genPostRenunciationTransferTax, genLoiStale,
    ],
    deriveStatutoryHeirs,
    deriveAssetSitusBase,
    computeJpInheritanceTax,
    deriveBeneficiaries,
    deriveWillStatus,
    JP_BRACKETS,
    BASE_DEDUCTION_FIXED,
    BASE_DEDUCTION_PER_HEIR,
    SPOUSE_DEDUCTION_MIN,
    CLAWBACK_YEARS,
  };
})();
