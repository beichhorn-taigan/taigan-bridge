/* Taigan Bridge — modules/decumulation.js
 *
 * Retirement Decumulation — closes the planning loop. Projections
 * models accumulation; this module covers the JP-resident-aware
 * decumulation strategies that don't fit cleanly into accumulation
 * projection math:
 *
 *   - US Social Security claiming optimizer (early/FRA/70 trade-off
 *     with US-Japan totalization treaty consideration)
 *   - WEP/GPO context — REPEALED Jan 2025 by the Social Security
 *     Fairness Act. 厚生年金 recipients no longer face the 50%
 *     reduction on US SS that applied for decades.
 *   - JP 国民年金 / 厚生年金 eligibility check (10y minimum for any
 *     benefit; 25y formerly required for full)
 *   - Withdrawal sequence — the standard US "taxable → pre-tax → Roth"
 *     order is often suboptimal for high-JP-bracket residents
 *   - RMD planning (US 73; no JP equivalent)
 *
 * Cross-references:
 *   - Projections     : current_age, retire_age, ss_start_age, drawdown_order
 *   - Resident        : 永住者 status (drives JP tax bracket assumption)
 *   - Tax Coordinator : FEIE/FTC election + filing status
 *   - Healthcare      : Medicare A+B for TFL coordination
 */

(function () {
  'use strict';

  const id = 'decumulation';

  // ====================================================================
  // i18n — Action Center generator strings
  // ====================================================================

  TB.i18n.extend('en', {
    'decum.genSsDecisionApproaching.title': 'SS claiming decision: {{years}}y to next milestone',
    'decum.genSsDecisionApproaching.body':  'Major SS claiming milestones are 62 (earliest), 67 (FRA), 70 (max). With WEP/GPO repealed in late 2024, JP-pension recipients no longer face automatic SS reductions. Open Decumulation → SS claiming to model the trade-offs.',

    'decum.genRmdApproaching.title': 'RMD age 73 in {{years}}y{{activeSuffix}}',
    'decum.genRmdApproaching.activeSuffix': ' (active now)',
    'decum.genRmdApproaching.body.convert':    'Required Minimum Distributions begin the year you turn 73. Pre-RMD years are the LAST window for tax-efficient Roth conversions before required income kicks in. You\'ve flagged pre-RMD conversion as a strategy — model it in Projections.',
    'decum.genRmdApproaching.body.noConvert':  'Required Minimum Distributions begin the year you turn 73. Pre-RMD years are the LAST window for tax-efficient Roth conversions before required income kicks in. Consider pre-RMD Roth conversions to manage future bracket. Penalty for missing an RMD is 25% (was 50% pre-SECURE 2.0).',

    'decum.genJpPensionGap.title': 'JP pension: {{years}}y short of eligibility',
    'decum.genJpPensionGap.body':  'Need 10y total contributions for any JP pension benefit. You have {{total}}y. Voluntary 国民年金 contributions can fill gaps; lump-sum back-pay also possible for missed years (up to 10y back).',
  });

  TB.i18n.extend('ja', {
    'decum.genSsDecisionApproaching.title': 'SS受給開始の判断: 次の節目まであと{{years}}年',
    'decum.genSsDecisionApproaching.body':  '主なSS受給開始の節目は62歳（最速）、67歳（FRA）、70歳（最大）です。2024年末のWEP/GPO廃止により、日本の年金受給者はSSの自動減額を受けなくなりました。Decumulation → SS claimingを開いてトレードオフをシミュレーションしてください。',

    'decum.genRmdApproaching.title': 'RMD開始年齢73歳まであと{{years}}年{{activeSuffix}}',
    'decum.genRmdApproaching.activeSuffix': '（現在対象中）',
    'decum.genRmdApproaching.body.convert':    'RMD（必要最低分配金）は73歳になる年から開始します。RMD開始前の年は、必要な所得が発生する前に税効率の良いRoth変換を行える最後の期間です。あなたはRMD開始前のRoth変換を戦略として設定済みです — Projectionsでモデル化してください。',
    'decum.genRmdApproaching.body.noConvert':  'RMD（必要最低分配金）は73歳になる年から開始します。RMD開始前の年は、必要な所得が発生する前に税効率の良いRoth変換を行える最後の期間です。将来の税率区分を管理するため、RMD開始前のRoth変換を検討してください。RMDを怠った場合のペナルティは25%です（SECURE 2.0以前は50%でした）。',

    'decum.genJpPensionGap.title': '日本の年金: 受給資格まであと{{years}}年不足',
    'decum.genJpPensionGap.body':  'いずれかの日本の年金給付を受けるには通算10年の納付が必要です。現在{{total}}年です。任意の国民年金保険料の納付で不足分を補うことができ、未納期間についても遡って（最大10年分）追納できる場合があります。',
  });

  // ====================================================================
  // Reference data
  // ====================================================================

  // SS claim age trade-offs (approximate, illustrative).
  // Reduction at 62: 30% below FRA. Bonus at 70: ~32% above FRA.
  const SS_CLAIM_AGES = [
    { age: 62, monthly_pct_of_fra: 0.70, label: 'Early — biggest discount' },
    { age: 65, monthly_pct_of_fra: 0.86, label: '3y before FRA' },
    { age: 67, monthly_pct_of_fra: 1.00, label: 'FRA (current)' },
    { age: 68, monthly_pct_of_fra: 1.08, label: '+8% delayed-retirement credit' },
    { age: 69, monthly_pct_of_fra: 1.16, label: '+16% delayed-retirement credit' },
    { age: 70, monthly_pct_of_fra: 1.24, label: 'Maximum benefit' },
  ];

  // JP pension minimums.
  const JP_PENSION_MIN_YEARS = 10;     // Lowered from 25 in 2017
  const JP_PENSION_FULL_YEARS = 40;    // 国民年金 full benefit at 40y contribution

  // Current-year reference figures for vesting / payout math.
  // FY = Japanese fiscal year (Apr-Mar). Updated annually by the
  // Pension Service. These are FY2026 estimates derived from recent
  // COLA adjustments — verify on the nenkin.go.jp site before relying.
  const JP_PENSION_PREMIUM_MONTHLY_FY2026 = 17920;   // 国民年金 monthly premium
  const JP_PENSION_FULL_BENEFIT_ANNUAL_FY2026 = 847300; // full 国民年金 at 40y, ¥/yr

  // ====================================================================
  // State accessors
  // ====================================================================

  // ====================================================================
  // Vision import — 年金定期便 / SSA statement (v0.60)
  // ====================================================================
  //
  // Both helpers fill ONLY blank fields on the draft so the user's
  // existing data is preserved. The modal closes and reopens after
  // a successful extraction so populated inputs render fresh values.
  async function runNenkinVision(file, draft, statusEl, onApplied) {
    const t = TB.i18n.t;
    statusEl.textContent = '⏳ ' + t('decum.jp_pension.import.processing');
    statusEl.style.color = 'var(--tb-text-soft)';
    try {
      const result = await TB.ai.callClaudeVisionForStructuredDoc(file, 'pension_statement_jp', {
        feature: 'document_vision',
      });
      const ext = (result && result.extracted) || {};
      const cost = (result.cost_usd || 0).toFixed(4);
      const filled = [];
      // Convert paid months → years (rounded to 0.5)
      function monthsToYears(m) {
        if (m == null || !isFinite(m)) return null;
        return Math.round((m / 12) * 2) / 2;
      }
      if (draft.kokumin_nenkin_years == null && ext.kokumin_paid_months != null) {
        draft.kokumin_nenkin_years = monthsToYears(ext.kokumin_paid_months);
        filled.push('kokumin_years');
      }
      if (draft.kosei_nenkin_years == null && ext.kosei_paid_months != null) {
        draft.kosei_nenkin_years = monthsToYears(ext.kosei_paid_months);
        filled.push('kosei_years');
      }
      // 年金定期便 gives an ANNUAL estimate; convert to monthly. Route to
      // kokumin slot as a default since we can't disaggregate without
      // more context — user can re-allocate manually.
      if (ext.estimated_annual_pension_jpy != null
          && draft.kokumin_estimated_monthly_jpy == null
          && draft.kosei_estimated_monthly_jpy == null) {
        draft.kokumin_estimated_monthly_jpy = Math.round(ext.estimated_annual_pension_jpy / 12);
        filled.push('estimated_monthly');
      }
      // Append helpful info to notes
      const noteBits = [];
      if (ext.as_of_date) noteBits.push(t('decum.jp_pension.import.notes.asOf', { date: ext.as_of_date }));
      if (ext.lifetime_contributions_jpy != null) {
        noteBits.push(t('decum.jp_pension.import.notes.contributions', { jpy: Math.round(ext.lifetime_contributions_jpy).toLocaleString() }));
      }
      if (ext.notes) noteBits.push(ext.notes);
      if (noteBits.length) {
        const note = noteBits.join(' · ');
        const cur = (draft.notes || '').trim();
        draft.notes = cur ? cur + '\n— ' + note : note;
        filled.push('notes');
      }
      if (filled.length === 0) {
        statusEl.textContent = '⚠ ' + t('decum.jp_pension.import.nothing') + ' · $' + cost;
        statusEl.style.color = 'var(--tb-warn)';
        return;
      }
      // Persist the partial draft so the reopen picks it up.
      setSection('jp_pension', draft);
      statusEl.textContent = '✓ ' + t('decum.jp_pension.import.done', { n: filled.length, cost });
      statusEl.style.color = 'var(--tb-success)';
      setTimeout(() => { try { onApplied && onApplied(); } catch (_) {} }, 600);
    } catch (err) {
      statusEl.textContent = '✗ ' + (err.message || err);
      statusEl.style.color = 'var(--tb-error)';
    }
  }

  async function runSsaStatementVision(file, draft, statusEl, onApplied) {
    const t = TB.i18n.t;
    statusEl.textContent = '⏳ ' + t('decum.ss.import.processing');
    statusEl.style.color = 'var(--tb-text-soft)';
    try {
      const result = await TB.ai.callClaudeVisionForStructuredDoc(file, 'ssa_statement', {
        feature: 'document_vision',
      });
      const ext = (result && result.extracted) || {};
      const cost = (result.cost_usd || 0).toFixed(4);
      const filled = [];
      // Capture all three age estimates in notes — the chosen-age
      // dropdown picks one, so the user sees all options at once.
      const ageBits = [];
      if (ext.estimated_monthly_at_62_usd != null)  ageBits.push('62: $' + Math.round(ext.estimated_monthly_at_62_usd).toLocaleString() + '/mo');
      if (ext.estimated_monthly_at_fra_usd != null) ageBits.push('FRA' + (ext.fra_age ? ' (' + ext.fra_age + ')' : '') + ': $' + Math.round(ext.estimated_monthly_at_fra_usd).toLocaleString() + '/mo');
      if (ext.estimated_monthly_at_70_usd != null)  ageBits.push('70: $' + Math.round(ext.estimated_monthly_at_70_usd).toLocaleString() + '/mo');
      if (ageBits.length) {
        const noteParts = [t('decum.ss.import.notes.estimates')];
        noteParts.push(ageBits.join(' · '));
        if (ext.credits_earned != null) noteParts.push(t('decum.ss.import.notes.credits', { n: ext.credits_earned }));
        if (ext.as_of_year) noteParts.push(t('decum.ss.import.notes.asOf', { year: ext.as_of_year }));
        if (ext.disability_monthly_usd != null) noteParts.push('SSDI: $' + Math.round(ext.disability_monthly_usd).toLocaleString() + '/mo');
        if (ext.survivors_monthly_usd != null) noteParts.push('Survivors: $' + Math.round(ext.survivors_monthly_usd).toLocaleString() + '/mo');
        if (ext.notes) noteParts.push(ext.notes);
        const note = noteParts.join('\n');
        const cur = (draft.notes || '').trim();
        draft.notes = cur ? cur + '\n\n— ' + note : note;
        filled.push('notes');
      }
      // If chosen_age already set, sync the corresponding monthly estimate
      if (draft.chosen_age && draft.estimated_monthly_at_chosen_age_usd == null) {
        let v = null;
        if (draft.chosen_age === 62) v = ext.estimated_monthly_at_62_usd;
        else if (draft.chosen_age === 70) v = ext.estimated_monthly_at_70_usd;
        else v = ext.estimated_monthly_at_fra_usd; // FRA fallback
        if (v != null) {
          draft.estimated_monthly_at_chosen_age_usd = Math.round(v);
          filled.push('estimated_monthly_at_chosen_age');
        }
      }
      if (filled.length === 0) {
        statusEl.textContent = '⚠ ' + t('decum.ss.import.nothing') + ' · $' + cost;
        statusEl.style.color = 'var(--tb-warn)';
        return;
      }
      setSection('ss_claiming', draft);
      statusEl.textContent = '✓ ' + t('decum.ss.import.done', { n: filled.length, cost });
      statusEl.style.color = 'var(--tb-success)';
      setTimeout(() => { try { onApplied && onApplied(); } catch (_) {} }, 600);
    } catch (err) {
      statusEl.textContent = '✗ ' + (err.message || err);
      statusEl.style.color = 'var(--tb-error)';
    }
  }

  function getDecum()     { return TB.state.get('decumulation') || {}; }
  function getSs()        { return getDecum().ss_claiming || {}; }
  function getJpPension() { return getDecum().jp_pension || {}; }
  function getWithdrawal() { return getDecum().withdrawal || {}; }
  function getRmdPlanning() { return getDecum().rmd_planning || {}; }

  function setSection(section, value) {
    const d = getDecum();
    d[section] = value;
    TB.state.set('decumulation', d);
  }

  // ── Cross-module reads ───────────────────────────────────────────

  function selfAge() {
    const v = TB.state.get('projections.inputs.current_age');
    return typeof v === 'number' ? v : null;
  }
  function retireAge() {
    const v = TB.state.get('projections.inputs.retire_age');
    return typeof v === 'number' ? v : null;
  }
  function ssStartAgeFromProjections() {
    const v = TB.state.get('projections.inputs.ss_start_age');
    return typeof v === 'number' ? v : null;
  }
  function ssMonthlyAt70UsdFromProjections() {
    const v = TB.state.get('projections.inputs.ss_monthly_at_70_usd');
    return typeof v === 'number' ? v : null;
  }
  function isJpResident() {
    const a = TB.state.get('onboarding.answers') || {};
    const tracks = TB.state.get('tracks') || [];
    return a.juminhyou === 'yes' ||
      a.years_in_japan === '5_to_10' || a.years_in_japan === 'over_10' ||
      tracks.indexOf('resident') !== -1;
  }
  function isPrForTax() {
    if (TB.resident && typeof TB.resident.yearsInJapan === 'function') {
      const yrs = TB.resident.yearsInJapan();
      return yrs != null && yrs >= 6;
    }
    return false;
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  const SECTIONS = [
    { id: 'header',    always: true, builder: () => buildHeaderCard() },
    { id: 'overview',  always: true, builder: () => buildOverviewCard() },
    {
      id: 'ss_claiming',
      label_en: 'US Social Security claiming strategy',
      label_jp: '米国 SS 受給戦略',
      description_en: 'Early (62) / FRA (67) / Delayed (70) trade-off with totalization treaty.',
      description_jp: '早期(62)・FRA(67)・繰下げ(70)のトレードオフと社会保障協定。',
      auto_show: () => true,
      builder: () => buildSsCard(),
    },
    {
      id: 'wep_gpo',
      label_en: 'WEP / GPO repeal (Social Security Fairness Act, signed Jan 2025)',
      label_jp: 'WEP / GPO 廃止(社会保障公平法、2025 年 1 月成立)',
      description_en: 'Signed Jan 5, 2025 (retroactive to Jan-2024 benefits), the repeal removed the 50% SS reduction that hit 厚生年金 recipients for decades.',
      description_jp: '2025 年 1 月 5 日成立(2024 年 1 月分の給付に遡及)。長年厚生年金受給者を悩ませた 50% SS 減額を撤廃。',
      auto_show: () => true,
      builder: () => buildWepGpoCard(),
    },
    {
      id: 'jp_pension',
      label_en: 'JP 国民年金 / 厚生年金 eligibility',
      label_jp: '国民年金 / 厚生年金 受給資格',
      description_en: '10y minimum for any benefit. Tracks contribution years + estimated monthly amounts.',
      description_jp: '受給最低 10 年。拠出年数と月額見込みを追跡。',
      auto_show: () => isJpResident() || isPrForTax(),
      builder: () => buildJpPensionCard(),
    },
    {
      id: 'jp_vesting_paths',
      label_en: 'JP pension vesting strategies (backpay, voluntary, totalization)',
      label_jp: 'JP 年金受給資格の獲得戦略(追納・任意加入・社会保障協定)',
      description_en: '4 paths to clear the 10-year hurdle: 追納 (back-pay exempted periods), 任意加入 (voluntary 60-65), totalization (US years count for vesting), カラ期間 (PR/naturalization complementary period).',
      description_jp: '10 年要件を満たす 4 つの方法:追納(免除期間の遡及納付)・任意加入(60-65 歳)・社会保障協定(米国年数を算入)・カラ期間(永住権・帰化者の合算対象期間)。',
      auto_show: () => isJpResident() || isPrForTax(),
      builder: () => buildJpVestingPathsCard(),
    },
    {
      id: 'withdrawal_sequence',
      label_en: 'Withdrawal sequence (JP-resident-aware)',
      label_jp: '取崩し順序(日本居住考慮)',
      description_en: 'Standard US "taxable → pre-tax → Roth" order is often wrong for high-JP-bracket residents. JP-aware alternatives.',
      description_jp: '標準的な「課税口座 → 前税口座 → Roth」順序は日本高税率居住者には不適切。日本居住者向けの代替戦略。',
      auto_show: () => true,
      builder: () => buildWithdrawalCard(),
    },
    {
      id: 'rmd',
      label_en: 'RMD planning (age 73)',
      label_jp: 'RMD 計画(73 歳)',
      description_en: 'Required Minimum Distributions begin at 73. Pre-RMD Roth conversion + QCD strategies.',
      description_jp: '必要最低分配額は 73 歳から。RMD 前の Roth 転換と QCD 戦略。',
      auto_show: () => {
        const a = selfAge();
        return a == null || a >= 60;
      },
      builder: () => buildRmdCard(),
    },
    {
      id: 'healthcare_bridge',
      label_en: 'Healthcare bridge to Medicare',
      label_jp: 'Medicare までの医療カバレッジ橋渡し',
      description_en: 'Cross-link to Healthcare module: Medicare Part B decision, TFL coordination, JP coverage during the gap.',
      description_jp: '医療モジュールへの相互リンク:Medicare Part B 判断・TFL 調整・空白期間の日本側カバー。',
      auto_show: () => {
        const r = retireAge();
        return r != null && r < 65;  // retiring before Medicare eligibility = bridge needed
      },
      builder: () => buildHealthcareBridgeCard(),
    },
    { id: 'resources', always: true, builder: () => buildResourcesCard() },
  ];

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
    return el('div', { class: 'tb-card', 'data-track': 'retire' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'retire' },
          t('decum.badge')),
      ),
      el('h1', null, '🌅 ' + t('decum.title')),
      el('p', { class: 'tb-card-meta' }, t('decum.subtitle')),
    );
  }

  // ─── Overview card ───────────────────────────────────────────────

  function buildOverviewCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const age = selfAge();
    const retire = retireAge();
    const ss = getSs();
    const jp = getJpPension();
    const wd = getWithdrawal();

    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📋 ' + t('decum.section.overview')));

    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
    });
    function tile(label, value, color, hint) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
          borderTop: '3px solid ' + (color || 'var(--tb-track-retire)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-18)' } }, value),
        hint ? el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' } }, hint) : null,
      );
    }

    // Years to retirement
    if (age != null && retire != null) {
      const yearsTo = retire - age;
      tiles.appendChild(tile(
        t('decum.overview.years_to_retire'),
        yearsTo > 0 ? yearsTo + 'y' : t('decum.overview.retired'),
        yearsTo <= 5 ? 'var(--tb-warn)' : 'var(--tb-track-retire)',
      ));
    }

    // SS claim age chosen
    const chosenSsAge = ss.chosen_age || ssStartAgeFromProjections();
    if (chosenSsAge) {
      tiles.appendChild(tile(
        t('decum.overview.ss_claim_age'),
        String(chosenSsAge),
        'var(--tb-track-retire)',
        chosenSsAge >= 70 ? t('decum.overview.ss_max') :
          chosenSsAge >= 67 ? t('decum.overview.ss_fra') :
          t('decum.overview.ss_early'),
      ));
    }

    // JP pension status
    const jpYears = (jp.kokumin_nenkin_years || 0) + (jp.kosei_nenkin_years || 0);
    if (jpYears > 0 || isJpResident()) {
      tiles.appendChild(tile(
        t('decum.overview.jp_pension_years'),
        jpYears + 'y',
        jpYears >= JP_PENSION_MIN_YEARS ? 'var(--tb-success)' :
          jpYears > 0 ? 'var(--tb-warn)' : 'var(--tb-text-soft)',
        jpYears >= JP_PENSION_MIN_YEARS
          ? t('decum.overview.jp_eligible')
          : (JP_PENSION_MIN_YEARS - jpYears) + 'y ' + t('decum.overview.jp_to_eligible'),
      ));
    }

    // RMD time horizon
    if (age != null) {
      const yearsToRmd = 73 - age;
      if (yearsToRmd > 0 && yearsToRmd < 25) {
        tiles.appendChild(tile(
          t('decum.overview.years_to_rmd'),
          yearsToRmd + 'y',
          yearsToRmd <= 5 ? 'var(--tb-warn)' : 'var(--tb-track-retire)',
          t('decum.overview.rmd_age_73'),
        ));
      }
    }

    card.appendChild(tiles);
    return card;
  }

  // ─── SS claiming strategy card ──────────────────────────────────

  function buildSsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ss = getSs();
    // Normalize whichever estimate we have to the FRA/PIA base, then the
    // per-claim-age table below re-scales it via SS_CLAIM_AGES.
    let fraEquivalent = 0;
    const projAt70 = ssMonthlyAt70UsdFromProjections();
    if (projAt70) {
      // Projections value is stated at age 70 → divide by the age-70 multiplier.
      fraEquivalent = projAt70 / 1.24;
    } else if (ss.estimated_monthly_at_chosen_age_usd) {
      // Fallback estimate is stated at chosen_age → divide by that age's
      // multiplier (not the constant 1.24). Defaults to FRA (1.0) if unknown.
      const chosenAge = ss.chosen_age;
      const row = SS_CLAIM_AGES.find((c) => c.age === chosenAge);
      const mult = row ? row.monthly_pct_of_fra : 1.0;
      fraEquivalent = ss.estimated_monthly_at_chosen_age_usd / mult;
    }

    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🇺🇸 ' + t('decum.section.ss_claiming')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openSsModal() }, '✎ ' + t('decum.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('decum.ss.intro')));

    // Claim-age comparison table
    if (fraEquivalent > 0) {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: 'var(--tb-sp-2)' } });
      const headers = el('div', {
        style: { display: 'grid', gridTemplateColumns: '60px 1fr 100px 100px',
          gap: 'var(--tb-sp-2)', padding: '4px var(--tb-sp-3)',
          fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
      },
        el('span', null, t('decum.ss.col.age')),
        el('span', null, ''),
        el('span', { style: { textAlign: 'right' } }, t('decum.ss.col.monthly')),
        el('span', { style: { textAlign: 'right' } }, t('decum.ss.col.lifetime')),
      );
      list.appendChild(headers);
      SS_CLAIM_AGES.forEach((c) => {
        const monthly = fraEquivalent * c.monthly_pct_of_fra;
        const yearsCollected = 90 - c.age;
        const lifetime = monthly * 12 * yearsCollected;
        const isChosen = ss.chosen_age === c.age;
        list.appendChild(el('div', {
          style: { display: 'grid', gridTemplateColumns: '60px 1fr 100px 100px',
            gap: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
            borderLeft: '3px solid ' + (isChosen ? 'var(--tb-success)' : 'transparent'),
            alignItems: 'baseline' },
        },
          el('span', { style: { fontWeight: '600' } }, String(c.age)),
          el('span', { class: 'tb-field-help' }, c.label),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right' } },
            '$' + Math.round(monthly).toLocaleString()),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right',
            fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
            '$' + Math.round(lifetime / 1000).toLocaleString() + 'K'),
        ));
      });
      card.appendChild(list);
      card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('decum.ss.lifetime_assumes')));
    } else {
      card.appendChild(el('p', { class: 'tb-field-help' },
        t('decum.ss.set_estimate_in_projections')));
    }

    // Strategy tips
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'decum.ss.tip.delay_for_longevity',
      'decum.ss.tip.early_for_health',
      'decum.ss.tip.spousal_strategy',
      'decum.ss.tip.totalization',
      'decum.ss.tip.taxed_in_jp',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  function openSsModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      chosen_age: null, estimated_monthly_at_chosen_age_usd: null,
      spouse_strategy: null, notes: '',
    }, getSs());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('decum.modal.ss')));

    // SSA statement vision import — pre-fills the chosen-age estimate
    // when the user picks 62/FRA/70 in the dropdown afterward, by
    // pulling the corresponding line from the statement. We capture
    // all three estimates into notes so the user can see them when
    // choosing chosen_age.
    if (TB.ai && typeof TB.ai.callClaudeVisionForStructuredDoc === 'function') {
      const visionStatus = el('div', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', marginTop: '4px', minHeight: '1em' } });
      const visionInput = el('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/jpg,image/webp,application/pdf',
        style: { display: 'none' },
        onchange: async (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) await runSsaStatementVision(f, draft, visionStatus, () => {
            close(); openSsModal();
          });
          e.target.value = '';
        },
      });
      modal.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
          display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' },
      },
        el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          style: { padding: '4px 10px', fontSize: '11px' },
          onclick: (e) => { e.preventDefault(); visionInput.click(); },
        }, '📎 ' + t('decum.ss.import.btn')),
        visionInput,
        el('span', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', flex: '1', minWidth: '180px' } },
          t('decum.ss.import.help')),
        visionStatus,
      ));
    }

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('decum.ss.chosen_age'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.chosen_age = parseInt(e.target.value, 10) || null; } },
        el('option', { value: '', selected: !draft.chosen_age }, '—'),
        ...SS_CLAIM_AGES.map((c) => el('option', {
          value: String(c.age), selected: draft.chosen_age === c.age,
        }, c.age + ' — ' + c.label)),
      )));

    modal.appendChild(field(t('decum.ss.spouse_strategy'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.spouse_strategy = e.target.value || null; } },
        el('option', { value: '', selected: !draft.spouse_strategy }, '—'),
        el('option', { value: 'individual',     selected: draft.spouse_strategy === 'individual' },     t('decum.ss.spouse.individual')),
        el('option', { value: 'spousal_first',  selected: draft.spouse_strategy === 'spousal_first' },  t('decum.ss.spouse.spousal_first')),
        el('option', { value: 'survivor_max',   selected: draft.spouse_strategy === 'survivor_max' },   t('decum.ss.spouse.survivor_max')),
      ),
      t('decum.ss.spouse_strategy.help')));

    modal.appendChild(field(t('decum.ss.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('decum.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('ss_claiming', draft); close(); rerender(); } }, t('decum.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── WEP/GPO repeal card ────────────────────────────────────────

  function buildWepGpoCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🎉 ' + t('decum.section.wep_gpo')));

    // Banner — good news!
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-success)',
        background: 'rgba(47, 111, 78, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '✓ ' + t('decum.wep_gpo.banner_label')),
      el('p', { style: { margin: 0 } }, t('decum.wep_gpo.banner_body')),
    ));

    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'decum.wep_gpo.point.what_was_wep',
      'decum.wep_gpo.point.what_was_gpo',
      'decum.wep_gpo.point.fairness_act',
      'decum.wep_gpo.point.retroactive',
      'decum.wep_gpo.point.contact_ssa',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── JP pension card ────────────────────────────────────────────

  function buildJpPensionCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const jp = getJpPension();
    const totalYears = (jp.kokumin_nenkin_years || 0) + (jp.kosei_nenkin_years || 0);
    const eligible = totalYears >= JP_PENSION_MIN_YEARS;

    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🇯🇵 ' + t('decum.section.jp_pension')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openJpPensionModal() }, '✎ ' + t('decum.edit')),
    ));

    // Eligibility banner
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + (eligible ? 'var(--tb-success)' : totalYears > 0 ? 'var(--tb-warn)' : 'var(--tb-text-soft)'),
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } },
        eligible ? '✓ ' + t('decum.jp_pension.eligible') :
          totalYears > 0
            ? '○ ' + t('decum.jp_pension.partial', { years: totalYears, needed: JP_PENSION_MIN_YEARS })
            : t('decum.jp_pension.no_contributions')),
      el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
        t('decum.jp_pension.kokumin') + ': ' + (jp.kokumin_nenkin_years || 0) + 'y · ' +
        t('decum.jp_pension.kosei')   + ': ' + (jp.kosei_nenkin_years || 0) + 'y'),
    ));

    // Estimated monthly
    if (jp.kokumin_estimated_monthly_jpy || jp.kosei_estimated_monthly_jpy) {
      const total = (jp.kokumin_estimated_monthly_jpy || 0) + (jp.kosei_estimated_monthly_jpy || 0);
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)' },
      },
        el('div', { class: 'tb-field-help' }, t('decum.jp_pension.estimated_monthly')),
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-22)' } },
          '¥' + total.toLocaleString())));
    }

    if (jp.has_japan_coverage_certificate) {
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-success)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
      }, '✓ ' + t('decum.jp_pension.has_certificate')));
    }

    // Education content
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'decum.jp_pension.point.10y_minimum',
      'decum.jp_pension.point.40y_full',
      'decum.jp_pension.point.totalization',
      'decum.jp_pension.point.lump_sum_withdrawal',
      'decum.jp_pension.point.taxed_under_treaty',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  function openJpPensionModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      kokumin_nenkin_years: null, kosei_nenkin_years: null,
      kokumin_estimated_monthly_jpy: null, kosei_estimated_monthly_jpy: null,
      has_japan_coverage_certificate: false, notes: '',
    }, getJpPension());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('decum.modal.jp_pension')));

    // 年金定期便 vision import — pre-fills paid months / estimated
    // monthly JP pension. Only fills blanks; never overwrites user
    // edits. We don't have separate kokumin/kosei "estimated monthly"
    // on a 年金定期便 (it gives a combined annual estimate) so we
    // route the combined into the kokumin field as the safer default
    // and append a notes line so the user can re-allocate if needed.
    if (TB.ai && typeof TB.ai.callClaudeVisionForStructuredDoc === 'function') {
      const visionStatus = el('div', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', marginTop: '4px', minHeight: '1em' } });
      const visionInput = el('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/jpg,image/webp,application/pdf',
        style: { display: 'none' },
        onchange: async (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) await runNenkinVision(f, draft, visionStatus, () => {
            close(); openJpPensionModal();
          });
          e.target.value = '';
        },
      });
      modal.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
          display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' },
      },
        el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          style: { padding: '4px 10px', fontSize: '11px' },
          onclick: (e) => { e.preventDefault(); visionInput.click(); },
        }, '📎 ' + t('decum.jp_pension.import.btn')),
        visionInput,
        el('span', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', flex: '1', minWidth: '180px' } },
          t('decum.jp_pension.import.help')),
        visionStatus,
      ));
    }

    function num(label, key, help, placeholder) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        el('input', { type: 'number', class: 'tb-input', step: '0.5', min: '0',
          value: draft[key] != null ? draft[key] : '',
          placeholder: placeholder || '',
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            draft[key] = isFinite(v) ? v : null;
          } }),
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    grid.appendChild(num(t('decum.jp_pension.kokumin') + ' ' + t('decum.jp_pension.years'), 'kokumin_nenkin_years', null, '0'));
    grid.appendChild(num(t('decum.jp_pension.kosei') + ' ' + t('decum.jp_pension.years'), 'kosei_nenkin_years', null, '0'));
    grid.appendChild(num(t('decum.jp_pension.kokumin') + ' ¥/mo', 'kokumin_estimated_monthly_jpy', null, '65000'));
    grid.appendChild(num(t('decum.jp_pension.kosei') + ' ¥/mo', 'kosei_estimated_monthly_jpy', null, '120000'));
    modal.appendChild(grid);

    const cb = el('input', { type: 'checkbox', checked: !!draft.has_japan_coverage_certificate,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.has_japan_coverage_certificate = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        cb, t('decum.jp_pension.coverage_cert')),
      el('div', { class: 'tb-field-help' }, t('decum.jp_pension.coverage_cert.help'))));

    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('decum.jp_pension.notes')),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('decum.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('jp_pension', draft); close(); rerender(); } }, t('decum.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── JP pension vesting paths card ──────────────────────────────

  function buildJpVestingPathsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const jp = getJpPension();
    const totalYears = (jp.kokumin_nenkin_years || 0) + (jp.kosei_nenkin_years || 0);

    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🛤 ' + t('decum.section.vesting_paths')));
    card.appendChild(el('p', null, t('decum.vesting.intro')));

    // Quick context banner — different depending on user's progress
    let bannerColor, bannerLabel, bannerBody;
    if (totalYears >= JP_PENSION_MIN_YEARS) {
      bannerColor = 'var(--tb-success)';
      bannerLabel = '✓ ' + t('decum.vesting.banner.eligible');
      bannerBody = t('decum.vesting.banner.eligible_body', { years: totalYears });
    } else if (totalYears > 0) {
      bannerColor = 'var(--tb-warn)';
      bannerLabel = '○ ' + t('decum.vesting.banner.partial');
      bannerBody = t('decum.vesting.banner.partial_body', {
        years: totalYears, needed: JP_PENSION_MIN_YEARS,
      });
    } else {
      bannerColor = 'var(--tb-track-retire)';
      bannerLabel = t('decum.vesting.banner.no_contributions');
      bannerBody = t('decum.vesting.banner.no_contributions_body');
    }
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + bannerColor,
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, bannerLabel),
      el('p', { style: { margin: 0, fontSize: 'var(--tb-fs-14)' } }, bannerBody),
    ));

    // 4 path cards
    const paths = [
      {
        id: 'tsuino', icon: '💰',
        title_key: 'decum.vesting.path.tsuino.title',
        when_key:  'decum.vesting.path.tsuino.when',
        how_key:   'decum.vesting.path.tsuino.how',
        gotchas_key: 'decum.vesting.path.tsuino.gotchas',
      },
      {
        id: 'nin_i_kanyu', icon: '⏳',
        title_key: 'decum.vesting.path.nin_i.title',
        when_key:  'decum.vesting.path.nin_i.when',
        how_key:   'decum.vesting.path.nin_i.how',
        gotchas_key: 'decum.vesting.path.nin_i.gotchas',
      },
      {
        id: 'totalization', icon: '🌐',
        title_key: 'decum.vesting.path.totalization.title',
        when_key:  'decum.vesting.path.totalization.when',
        how_key:   'decum.vesting.path.totalization.how',
        gotchas_key: 'decum.vesting.path.totalization.gotchas',
        recommended: true,  // most relevant for US persons
      },
      {
        id: 'kara_kikan', icon: '🛂',
        title_key: 'decum.vesting.path.kara.title',
        when_key:  'decum.vesting.path.kara.when',
        how_key:   'decum.vesting.path.kara.how',
        gotchas_key: 'decum.vesting.path.kara.gotchas',
      },
    ];

    paths.forEach((p) => {
      const wrap = el('details', {
        open: !!p.recommended,
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (p.recommended ? 'var(--tb-success)' : 'var(--tb-track-retire)'),
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      wrap.appendChild(el('summary', {
        style: { cursor: 'pointer', fontWeight: '600', display: 'flex', alignItems: 'baseline', gap: 'var(--tb-sp-2)' },
      },
        el('span', null, p.icon + ' ' + t(p.title_key)),
        p.recommended
          ? el('span', { class: 'tb-badge', style: { background: 'var(--tb-success)', color: '#fff', fontSize: '10px', padding: '1px 6px' } },
              t('decum.vesting.path.most_relevant'))
          : null,
      ));
      const body = el('div', { style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)' } });
      body.appendChild(el('div', { style: { marginBottom: 'var(--tb-sp-2)' } },
        el('strong', null, t('decum.vesting.path.when_label') + ': '),
        t(p.when_key)));
      body.appendChild(el('div', { style: { marginBottom: 'var(--tb-sp-2)' } },
        el('strong', null, t('decum.vesting.path.how_label') + ': '),
        t(p.how_key)));
      body.appendChild(el('div', null,
        el('strong', { style: { color: 'var(--tb-warn)' } }, t('decum.vesting.path.gotchas_label') + ': '),
        t(p.gotchas_key)));
      wrap.appendChild(body);
      card.appendChild(wrap);
    });

    // Strategic worth-it analysis
    const monthlyPremium = JP_PENSION_PREMIUM_MONTHLY_FY2026;
    const annualPremium = monthlyPremium * 12;
    const perYearBenefit = Math.round(JP_PENSION_FULL_BENEFIT_ANNUAL_FY2026 / JP_PENSION_FULL_YEARS);
    const breakeven = (annualPremium / perYearBenefit).toFixed(1);

    card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)' } }, '🧮 ' + t('decum.vesting.economics.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('decum.vesting.economics.intro')));

    const econGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' } });
    function tile(label, value, hint, color) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
          borderTop: '3px solid ' + (color || 'var(--tb-track-retire)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' } }, value),
        hint ? el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' } }, hint) : null,
      );
    }
    econGrid.appendChild(tile(
      t('decum.vesting.economics.premium'),
      '¥' + annualPremium.toLocaleString(),
      '¥' + monthlyPremium.toLocaleString() + '/' + t('decum.vesting.economics.month'),
    ));
    econGrid.appendChild(tile(
      t('decum.vesting.economics.per_year_value'),
      '¥' + perYearBenefit.toLocaleString(),
      t('decum.vesting.economics.per_year_value_hint'),
      'var(--tb-success)',
    ));
    econGrid.appendChild(tile(
      t('decum.vesting.economics.breakeven'),
      breakeven + 'y',
      t('decum.vesting.economics.breakeven_hint'),
    ));
    econGrid.appendChild(tile(
      t('decum.vesting.economics.full_benefit'),
      '¥' + JP_PENSION_FULL_BENEFIT_ANNUAL_FY2026.toLocaleString(),
      t('decum.vesting.economics.at_40_years'),
      'var(--tb-success)',
    ));
    card.appendChild(econGrid);

    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid var(--tb-track-retire)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)',
      },
    },
      el('strong', null, '💡 ' + t('decum.vesting.economics.strategic_label')),
      el('p', { style: { margin: '4px 0 0' } }, t('decum.vesting.economics.strategic_body')),
    ));

    // Tax treatment note
    card.appendChild(el('div', {
      style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)' },
    },
      el('strong', null, '📊 ' + t('decum.vesting.tax_label')),
      el('p', { style: { margin: '4px 0 0' } }, t('decum.vesting.tax_body')),
    ));

    return card;
  }

  // ─── Withdrawal sequence card ──────────────────────────────────

  function buildWithdrawalCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const wd = getWithdrawal();
    const isPr = isPrForTax();
    const willBeJpResident = wd.jp_resident_at_retirement === true ||
      (wd.jp_resident_at_retirement == null && (isJpResident() || isPr));

    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🔀 ' + t('decum.section.withdrawal_sequence')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openWithdrawalModal() }, '✎ ' + t('decum.edit')),
    ));
    card.appendChild(el('p', null, t('decum.withdrawal.intro')));

    // The "wrong default" callout
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185,122,26,0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '⚠ ' + t('decum.withdrawal.wrong_default_label')),
      el('p', { style: { margin: 0 } }, t('decum.withdrawal.wrong_default_body')),
    ));

    // Strategy comparison
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-3)' } });
    function tile(title, when, sequence, recommended) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)',
          border: recommended ? '2px solid var(--tb-success)' : '1px solid var(--tb-border)',
        },
      },
        el('div', { style: { fontWeight: '700', marginBottom: '4px' } },
          (recommended ? '⭐ ' : '') + title),
        el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-2)' } }, when),
        el('div', { style: { fontSize: 'var(--tb-fs-12)', fontFamily: 'var(--tb-font-mono)' } }, sequence),
      );
    }
    grid.appendChild(tile(
      t('decum.withdrawal.strat.standard'),
      t('decum.withdrawal.strat.standard.when'),
      'taxable → pre-tax → Roth',
      !willBeJpResident,
    ));
    grid.appendChild(tile(
      t('decum.withdrawal.strat.jp_resident'),
      t('decum.withdrawal.strat.jp_resident.when'),
      'Roth → taxable → pre-tax (slowly)',
      willBeJpResident,
    ));
    grid.appendChild(tile(
      t('decum.withdrawal.strat.tax_diversified'),
      t('decum.withdrawal.strat.tax_diversified.when'),
      'Mixed: pull from each bucket annually',
      false,
    ));
    card.appendChild(grid);

    // Insights
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'decum.withdrawal.tip.jp_treats_roth_taxable',
      'decum.withdrawal.tip.pre_tax_double_dip',
      'decum.withdrawal.tip.bracket_management',
      'decum.withdrawal.tip.specialist_required',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  function openWithdrawalModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      jp_resident_at_retirement: null, preferred_strategy: null, notes: '',
    }, getWithdrawal());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('decum.modal.withdrawal')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('decum.withdrawal.jp_resident_q'),
      el('select', { class: 'tb-select',
        onchange: (e) => {
          const v = e.target.value;
          draft.jp_resident_at_retirement = v === '' ? null : (v === 'yes');
        } },
        el('option', { value: '', selected: draft.jp_resident_at_retirement == null }, t('decum.withdrawal.unsure')),
        el('option', { value: 'yes', selected: draft.jp_resident_at_retirement === true }, t('decum.withdrawal.yes_jp')),
        el('option', { value: 'no',  selected: draft.jp_resident_at_retirement === false }, t('decum.withdrawal.no_us')),
      )));

    modal.appendChild(field(t('decum.withdrawal.preferred'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.preferred_strategy = e.target.value || null; } },
        el('option', { value: '', selected: !draft.preferred_strategy }, '—'),
        el('option', { value: 'standard',         selected: draft.preferred_strategy === 'standard' },         t('decum.withdrawal.strat.standard')),
        el('option', { value: 'roth_first',       selected: draft.preferred_strategy === 'roth_first' },       t('decum.withdrawal.strat.jp_resident')),
        el('option', { value: 'tax_diversified',  selected: draft.preferred_strategy === 'tax_diversified' },  t('decum.withdrawal.strat.tax_diversified')),
      )));

    modal.appendChild(field(t('decum.withdrawal.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('decum.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('withdrawal', draft); close(); rerender(); } }, t('decum.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── RMD planning card ──────────────────────────────────────────

  function buildRmdCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const r = getRmdPlanning();
    const age = selfAge();
    const yearsToRmd = age != null ? 73 - age : null;

    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '⏰ ' + t('decum.section.rmd')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openRmdModal() }, '✎ ' + t('decum.edit')),
    ));

    // Age-based banner
    if (age != null) {
      let bannerColor, bannerLabel;
      if (age >= 73) {
        bannerColor = 'var(--tb-error)'; bannerLabel = '⚠ ' + t('decum.rmd.active', { age });
      } else if (yearsToRmd <= 5) {
        bannerColor = 'var(--tb-warn)'; bannerLabel = t('decum.rmd.approaching', { years: yearsToRmd });
      } else {
        bannerColor = 'var(--tb-track-retire)'; bannerLabel = t('decum.rmd.future', { years: yearsToRmd });
      }
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + bannerColor,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)',
        },
      }, el('div', { style: { fontWeight: '600' } }, bannerLabel)));
    }

    // Strategy points
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'decum.rmd.point.age_73',
      'decum.rmd.point.first_year_grace',
      'decum.rmd.point.50pct_penalty',
      'decum.rmd.point.pre_rmd_conversion',
      'decum.rmd.point.qcd_strategy',
      'decum.rmd.point.no_jp_equivalent',
      'decum.rmd.point.jp_treats_rmd_as_income',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    // User strategy notes
    if (r.notes) {
      card.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid var(--tb-track-retire)' },
      },
        el('div', { style: { fontWeight: '600' } }, t('decum.rmd.your_strategy')),
        el('div', { style: { marginTop: '4px', fontSize: 'var(--tb-fs-14)' } }, r.notes),
      ));
    }

    return card;
  }

  function openRmdModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      convert_pre_rmd: null, qcd_planned: null, notes: '',
    }, getRmdPlanning());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('decum.modal.rmd')));

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

    modal.appendChild(checkbox(t('decum.rmd.convert_pre_rmd'),
      'convert_pre_rmd', t('decum.rmd.convert_pre_rmd.help')));
    modal.appendChild(checkbox(t('decum.rmd.qcd_planned'),
      'qcd_planned', t('decum.rmd.qcd_planned.help')));

    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('decum.rmd.notes')),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('decum.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('rmd_planning', draft); close(); rerender(); } }, t('decum.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Healthcare bridge card ─────────────────────────────────────

  function buildHealthcareBridgeCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🏥 ' + t('decum.section.healthcare_bridge')));
    card.appendChild(el('p', null, t('decum.healthcare_bridge.intro')));

    const ul = el('ul', { style: { paddingLeft: '20px' } });
    [
      'decum.healthcare_bridge.point.gap_period',
      'decum.healthcare_bridge.point.cobra',
      'decum.healthcare_bridge.point.aca_marketplace',
      'decum.healthcare_bridge.point.private_intl',
      'decum.healthcare_bridge.point.jp_nhi',
      'decum.healthcare_bridge.point.medicare_then_tfl',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      el('a', { href: '#', style: { color: 'var(--tb-navy)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'healthcare' } }));
        } }, '↗ ' + t('decum.healthcare_bridge.see_healthcare'))));
    return card;
  }

  // ─── Resources ──────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'retire' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('decum.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-retire)',
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
    card.appendChild(resource(t('decum.resources.ssa.title'), t('decum.resources.ssa.body'), 'https://www.ssa.gov/myaccount/'));
    card.appendChild(resource(t('decum.resources.totalization.title'), t('decum.resources.totalization.body'),
      'https://www.ssa.gov/international/Agreement_Pamphlets/japan.html'));
    card.appendChild(resource(t('decum.resources.fairness_act.title'), t('decum.resources.fairness_act.body'),
      'https://www.ssa.gov/benefits/retirement/social-security-fairness-act.html'));
    card.appendChild(resource(t('decum.resources.nenkin.title'), t('decum.resources.nenkin.body'),
      'https://www.nenkin.go.jp/international/index.html'));
    card.appendChild(resource(t('decum.resources.irs_rmd.title'), t('decum.resources.irs_rmd.body'),
      'https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-required-minimum-distributions-rmds'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genSsDecisionApproaching() {
    const t = TB.i18n.t;
    const age = selfAge();
    if (age == null) return [];
    const ss = getSs();
    if (ss.chosen_age) return [];  // user has already decided
    // Fire when within 5y of any of 62, 67, or 70
    const triggers = [62, 67, 70];
    const proximity = triggers
      .map((t) => t - age)
      .filter((d) => d > 0 && d <= 5)
      .sort((a, b) => a - b);
    if (proximity.length === 0) return [];
    return [{
      id: 'decum_ss_decision',
      group: 'retire',
      urgency: proximity[0] <= 1 ? 'high' : 'medium',
      icon: '🌅',
      title: t('decum.genSsDecisionApproaching.title', { years: proximity[0] }),
      body: t('decum.genSsDecisionApproaching.body'),
      module: 'decumulation', snoozable: true,
    }];
  }

  function genRmdApproaching() {
    const t = TB.i18n.t;
    const age = selfAge();
    if (age == null) return [];
    if (age < 68 || age > 73) return [];
    const r = getRmdPlanning();
    const activeSuffix = age >= 73 ? t('decum.genRmdApproaching.activeSuffix') : '';
    return [{
      id: 'decum_rmd_approaching',
      group: 'retire',
      urgency: age >= 72 ? 'high' : 'medium',
      icon: '⏰',
      title: t('decum.genRmdApproaching.title', { years: Math.max(0, 73 - age), activeSuffix }),
      body: r.convert_pre_rmd
        ? t('decum.genRmdApproaching.body.convert')
        : t('decum.genRmdApproaching.body.noConvert'),
      module: 'decumulation', snoozable: true,
    }];
  }

  function genJpPensionGap() {
    const t = TB.i18n.t;
    if (!isJpResident()) return [];
    const jp = getJpPension();
    const total = (jp.kokumin_nenkin_years || 0) + (jp.kosei_nenkin_years || 0);
    if (total === 0) return [];                       // not yet started
    if (total >= JP_PENSION_MIN_YEARS) return [];     // already eligible
    return [{
      id: 'decum_jp_pension_gap',
      group: 'retire',
      urgency: total >= 8 ? 'medium' : 'low',
      icon: '🇯🇵',
      title: t('decum.genJpPensionGap.title', { years: JP_PENSION_MIN_YEARS - total }),
      body: t('decum.genJpPensionGap.body', { total }),
      module: 'decumulation', snoozable: true,
    }];
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Retirement Decumulation', label_jp: '退職後の取崩し', render,
    searchSections: SECTIONS,
  };

  window.TB.decumulation = {
    actionGenerators: [genSsDecisionApproaching, genRmdApproaching, genJpPensionGap],
    SS_CLAIM_AGES, JP_PENSION_MIN_YEARS, JP_PENSION_FULL_YEARS,
  };
})();
