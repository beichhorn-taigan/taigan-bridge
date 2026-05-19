/* Taigan Bridge — modules/sofa-roth.js
 *
 * SOFA Roth Sequencing Planner (v0.3.x — Phase 1)
 *
 * The window between active SOFA status and 住民票 (juminhyou)
 * registration in Japan is where U.S. expats can do certain
 * tax-efficient moves — Roth conversions, capital-gains realization,
 * RSU/option exercises, US asset cleanups — at U.S.-only tax cost.
 * After 住民票, those same moves are subject to Japanese national +
 * residence tax, often at marginal rates that double or triple the
 * effective tax cost.
 *
 * The tool's job: surface the WINDOW, generate the action SEQUENCE
 * in the right order, and put a triple-confirmation gate in front
 * of the highest-stakes actions so the user pauses to confirm
 * they've talked to a CPA before pulling the trigger.
 *
 * Phase 1 (this release) is the foundation: state schema, profile +
 * accounts inputs, dynamically-derived sequence, severity badges,
 * and risk explanations. Cost-of-mistake calculator math comes in
 * Phase 2 — we currently surface the conceptual cost but don't yet
 * compute exact dollar figures (intentional — getting the math wrong
 * here is worse than not showing it).
 *
 * Privacy posture:
 *   - Account balances are stored locally; nothing is transmitted.
 *   - The optional AI Advisor (later phase) sends only aggregated
 *     summaries (status counts, no PII).
 */

(function () {
  'use strict';

  const id = 'sofa-roth';
  const REQUIRED_DISCLAIMER_VERSION = 'v0.3.0';

  // ====================================================================
  // Domain enums
  // ====================================================================

  const SOFA_ROLES = [
    { value: 'military',        label_en: 'U.S. military (active duty)',          label_jp: '米軍(現役)' },
    { value: 'dod_civilian',    label_en: 'DoD civilian (GS / NAF)',              label_jp: '国防総省文民職員(GS / NAF)' },
    { value: 'dod_contractor',  label_en: 'DoD contractor under SOFA',            label_jp: 'SOFA 適用の国防総省契約者' },
    { value: 'family_member',   label_en: 'Dependent / family member',            label_jp: '扶養家族・帯同家族' },
  ];

  const SOFA_STATUSES = [
    { value: 'active',         label_en: 'Currently active SOFA status',                                   label_jp: 'SOFA 適用中' },
    { value: 'transitioning',  label_en: 'Transitioning out (separation / retirement / contract end)',    label_jp: '離任手続中(退役・退職・契約終了)' },
    { value: 'post_sofa',      label_en: 'Already post-SOFA (employment ended)',                          label_jp: 'SOFA 適用終了済み' },
  ];

  const JP_RESIDENCY_PLANS = [
    { value: 'stay',       label_en: 'Stay in Japan long-term (will register 住民票)', label_jp: '日本に長期滞在(住民票登録予定)' },
    { value: 'leave',      label_en: 'Leaving Japan (returning to US or elsewhere)',   label_jp: '日本を離れる(帰米・他国移住)' },
    { value: 'undecided',  label_en: 'Not yet decided',                                label_jp: '未決定' },
  ];

  const FILING_STATUSES = [
    { value: 'single', label_en: 'Single',                              label_jp: '単身者(Single)' },
    { value: 'mfj',    label_en: 'Married filing jointly',              label_jp: '夫婦合算申告(MFJ)' },
    { value: 'mfs',    label_en: 'Married filing separately',           label_jp: '夫婦個別申告(MFS)' },
    { value: 'hoh',    label_en: 'Head of household',                   label_jp: '世帯主(HoH)' },
  ];

  // ====================================================================
  // State accessors
  // ====================================================================

  function getProfile()      { return TB.state.get('sofa.profile') || {}; }
  // Account balances live in assets.accounts as of v4 — SOFA derives
  // its rollup via TB.assets.aggregateForSofa(). No setter exists for
  // this object; users edit individual accounts in the Assets module.
  function getAccounts() {
    return (TB.assets && TB.assets.aggregateForSofa)
      ? TB.assets.aggregateForSofa()
      : {};
  }
  function getTaxAssump()    { return TB.state.get('sofa.tax_assumptions') || {}; }
  function getSteps()        { return TB.state.get('sofa.steps') || []; }
  function getAcks()         { return TB.state.get('sofa.acks') || {}; }

  function setProfileField(field, value)  {
    const p = getProfile();
    p[field] = value;
    TB.state.set('sofa.profile', p);
  }
  function setTaxField(field, value)      {
    const a = getTaxAssump();
    a[field] = value;
    TB.state.set('sofa.tax_assumptions', a);
  }
  function setSteps(arr)                  { TB.state.set('sofa.steps', arr); }
  function setAck(field, value)           {
    const a = getAcks();
    a[field] = value;
    TB.state.set('sofa.acks', a);
  }

  function hasAcknowledgedDisclaimer() {
    return getAcks().disclaimer_version === REQUIRED_DISCLAIMER_VERSION;
  }
  function acknowledgeDisclaimer() {
    setAck('disclaimer_version', REQUIRED_DISCLAIMER_VERSION);
  }

  // ====================================================================
  // Module-local UI state
  // ====================================================================

  let host = null;
  let activeTab = 'overview';

  // ====================================================================
  // Sequence engine — derives the action checklist from profile +
  // accounts + tax assumptions. Each step has:
  //   id        — stable per (type, account_from, account_to)
  //   type      — 'roth_conversion' | 'realize_ltcg' | 'rsu_vest' |
  //               'exercise_options' | 'deferred_comp' | 're_sale' |
  //               'setup_brokerage' | 'setup_jp_banking' |
  //               'gift_transfer' | 'pfic_avoid' | 'tsp_rollover'
  //   title_*   — bilingual short title
  //   summary_* — bilingual one-paragraph rationale
  //   severity  — 'critical' | 'high' | 'medium' | 'info'
  //   deadline_iso — derived: juminhyou_target_date - 30 days for most;
  //                  separation_date for SOFA-status-only items
  //   status    — 'pending' | 'planned' | 'executed' | 'dismissed'
  //               (pulled from persisted state if user has set it)
  // ====================================================================

  function deriveSequence() {
    const profile = getProfile();
    const accounts = getAccounts();
    const persisted = getSteps();

    // Index persisted steps by id for status carryover.
    const persistedById = {};
    for (const s of persisted) {
      if (s && s.id) persistedById[s.id] = s;
    }

    const out = [];
    const stay = profile.jp_residency_plan === 'stay';
    const sep = profile.separation_date || null;
    const jum = profile.juminhyou_target_date || null;

    // The deadline anchor for "do this BEFORE 住民票" items is whichever
    // is earliest of (juminhyou target) or (separation + 14 days, the
    // typical legal deadline for Japan-resident registration after losing
    // SOFA status). If neither is set, leave deadline null and surface
    // a warning to the user that timing can't be computed yet.
    function preJuminhyouDeadline() {
      if (jum) return jum;
      if (sep) return addDays(sep, -1);
      return null;
    }

    function emit(step) {
      const previous = persistedById[step.id];
      out.push(Object.assign({}, step, {
        status: previous && previous.status ? previous.status : 'pending',
        executed_date: previous ? (previous.executed_date || null) : null,
        executed_amount: previous ? (previous.executed_amount || null) : null,
        notes: previous ? (previous.notes || '') : '',
      }));
    }

    // ---- Roth conversion window (the headline action) ---------------
    const tradBalance = (accounts.traditional_ira_usd || 0)
      + (accounts.traditional_401k_tsp_usd || 0);
    if (stay && tradBalance > 0) {
      emit({
        id: 'roth_conversion_window',
        type: 'roth_conversion',
        title_en: 'Complete Roth conversions BEFORE registering 住民票',
        title_jp: '住民票登録前に Roth コンバージョンを完了させる',
        summary_en:
          'While SOFA-status (or pre-住民票), traditional IRA / 401(k) / TSP conversions to Roth are taxed at U.S. ordinary income rates only. ' +
          'After 住民票 registration Japan does not recognize the Roth tax wrapper — every conversion becomes Japan-taxable as ordinary income at your Japan marginal rate (often 20-45% national + 10% local). ' +
          'Convert the amount you can absorb at favorable U.S. brackets in calendar years that close BEFORE your 住民票 target date.',
        summary_jp:
          'SOFA 適用中(または住民票登録前)は、Traditional IRA / 401(k) / TSP から Roth への変換は米国の通常所得税のみで課税されます。' +
          '住民票登録後は、日本側は Roth の税制優遇を認めず、変換額の全額を日本の通常所得として課税します(国税 20-45% + 住民税 10%)。' +
          '住民票登録予定日より前に締まる暦年で、米国側で許容できる金額を変換しておきましょう。',
        severity: 'critical',
        deadline_iso: preJuminhyouDeadline(),
        amount_usd: tradBalance,
      });
    }

    // ---- Capital gains realization on appreciated taxable accounts --
    const taxableValue = accounts.taxable_brokerage_value_usd || 0;
    const taxableBasis = accounts.taxable_brokerage_basis_usd || 0;
    const unrealizedGain = Math.max(0, taxableValue - taxableBasis);
    if (stay && unrealizedGain > 0) {
      emit({
        id: 'realize_ltcg_window',
        type: 'realize_ltcg',
        title_en: 'Consider realizing long-term capital gains BEFORE 住民票',
        title_jp: '住民票登録前に米国 LTCG の実現益確定を検討する',
        summary_en:
          'Pre-住民票 sales of appreciated U.S. taxable-brokerage holdings are subject only to U.S. long-term capital-gains rates (0/15/20%). ' +
          'Post-住民票 the same sale is also Japan-taxable at the standard 20.315% securities rate, often without a basis step-up. ' +
          'For low-basis legacy positions, the cost difference can be material. Discuss with a CPA — partial harvest + immediate repurchase is a common pattern.',
        summary_jp:
          '住民票登録前に米国課税口座の含み益のある株式を売却する場合、米国の長期キャピタルゲイン税(0/15/20%)のみが課されます。' +
          '住民票登録後は、同じ売却が日本側でも 20.315%(申告分離課税)の対象となり、しかも取得価額の引き上げ(step-up)は通常認められません。' +
          '簿価の低い保有銘柄ほど差額は大きくなります。CPA と相談の上、部分利確+即時再取得などを検討してください。',
        severity: 'high',
        deadline_iso: preJuminhyouDeadline(),
        amount_usd: unrealizedGain,
      });
    }

    // ---- RSU / option vesting & exercise sourcing -------------------
    const rsuValue = accounts.rsu_unvested_value_usd || 0;
    const optValue = accounts.nso_iso_unrealized_value_usd || 0;
    if (stay && (rsuValue > 0 || optValue > 0)) {
      emit({
        id: 'rsu_option_sourcing',
        type: 'rsu_vest',
        title_en: 'Plan RSU vests / option exercises around 住民票 date',
        title_jp: 'RSU 権利確定・SO 行使のタイミングを住民票登録日と整合させる',
        summary_en:
          'RSU and option income is sourced by where the work was performed across the vesting period — partly U.S., partly Japan once you become a Japan resident. ' +
          'The Japan-source portion is Japan-taxable. For grants that vest soon after 住民票, the Japan-source slice (and tax) can be larger than expected. ' +
          'Coordinate with employer payroll on the W-2 / 給与所得 split BEFORE 住民票.',
        summary_jp:
          'RSU・SO の所得は、権利確定期間の労働実施地で按分されます。住民票登録後は日本側勤務分が日本所得となり、その部分が日本で課税されます。' +
          '住民票登録直後に確定する付与は、想定以上の日本所得割合になることがあります。住民票登録前に、勤務先給与部門と W-2 / 給与所得の按分について調整してください。',
        severity: 'high',
        deadline_iso: preJuminhyouDeadline(),
        amount_usd: rsuValue + optValue,
      });
    }

    // ---- Deferred compensation lump --------------------------------
    const defComp = accounts.deferred_comp_usd || 0;
    if (stay && defComp > 0) {
      emit({
        id: 'deferred_comp_election',
        type: 'deferred_comp',
        title_en: 'Review deferred-comp distribution election before 住民票',
        title_jp: '住民票登録前に繰延報酬の受取方法を見直す',
        summary_en:
          'Lump-sum vs. installment distributions of deferred compensation are taxed very differently in Japan. ' +
          'Japan generally lacks the U.S. tax-deferral concept and may attribute the full balance to a single year if collapsed post-residency. ' +
          'Confirm the election with the plan administrator before 住民票 registration.',
        summary_jp:
          '繰延報酬の一時金受取と分割受取では、日本側の課税扱いが大きく異なります。' +
          '日本には米国型の繰延税制がなく、住民票登録後に一括受取とすると当該年度に全額が課税される可能性があります。' +
          '住民票登録前に、プラン管理者と受取方法を確定してください。',
        severity: 'high',
        deadline_iso: preJuminhyouDeadline(),
        amount_usd: defComp,
      });
    }

    // ---- US real estate sale ---------------------------------------
    const reValue = accounts.us_real_estate_value_usd || 0;
    const reBasis = accounts.us_real_estate_basis_usd || 0;
    const reGain = Math.max(0, reValue - reBasis);
    if (stay && reValue > 0) {
      emit({
        id: 're_sale_timing',
        type: 're_sale',
        title_en: 'Decide U.S. real-estate sale timing relative to 住民票',
        title_jp: '住民票登録時点と米国不動産の売却タイミングを整理する',
        summary_en:
          'Selling a U.S. principal residence pre-住民票 may qualify for the §121 exclusion ($250k single / $500k MFJ) at U.S.-only tax cost. ' +
          'Post-住民票, Japan also taxes the gain (with its own JPY-basis recomputation that frequently differs from the U.S. basis), and the §121 exclusion is not recognized. ' +
          'For high-appreciation properties, the Japan-side cost can dwarf the U.S.-side cost. Decide BEFORE listing.',
        summary_jp:
          '米国の主たる住居を住民票登録前に売却すれば、米国側で §121 除外(単身 25万ドル/MFJ 50万ドル)が適用され米国課税のみで完結する場合があります。' +
          '住民票登録後は日本側も売却益を課税対象とし(取得原価は円ベースで再計算され米国ベースと異なることが多い)、§121 除外は認められません。' +
          '値上がりの大きい物件ほど日本側課税が米国側を大きく上回ることがあります。売却の意思決定は売出し前に行ってください。',
        severity: reGain > 200000 ? 'critical' : 'high',
        deadline_iso: preJuminhyouDeadline(),
        amount_usd: reGain || reValue,
      });
    }

    // ---- Set up non-resident-friendly U.S. brokerage ---------------
    if (stay && (taxableValue > 0 || tradBalance > 0)) {
      emit({
        id: 'setup_intl_brokerage',
        type: 'setup_brokerage',
        title_en: 'Move U.S. brokerage to a Japan-resident-friendly platform',
        title_jp: '在日駐在に対応する米国ブローカーへ口座を移管する',
        summary_en:
          'After 住民票 registration, many U.S. brokerages (Vanguard, Fidelity\'s domestic platform) close or restrict accounts for Japan residents. ' +
          'Schwab International (Schwab One International) and Interactive Brokers explicitly support Japan-resident clients. ' +
          'Initiate the transfer BEFORE 住民票 — it takes weeks and a frozen account during transit is painful.',
        summary_jp:
          '住民票登録後、Vanguard や Fidelity 国内口座など多くの米国ブローカーは在日居住者の口座を閉鎖・制限します。' +
          'Schwab International(Schwab One International)や Interactive Brokers は在日居住者の受け入れを明記しています。' +
          '移管手続きは数週間を要し、その間口座が凍結されることもあります。住民票登録前に開始してください。',
        severity: 'high',
        deadline_iso: preJuminhyouDeadline(),
      });
    }

    // ---- TSP rollover decision (military / civilian only) ----------
    const tspBalance = accounts.traditional_401k_tsp_usd || 0;
    const isFedOrMilitary = profile.role === 'military' || profile.role === 'dod_civilian';
    if (isFedOrMilitary && tspBalance > 0) {
      emit({
        id: 'tsp_rollover',
        type: 'tsp_rollover',
        title_en: 'TSP rollover decision (Traditional → Roth IRA pathway)',
        title_jp: 'TSP の処理を決める(Traditional → Roth IRA への経路を含む)',
        summary_en:
          'Post-separation, TSP can be left in place, rolled to an IRA, or sequentially converted Traditional → Roth. ' +
          'Rolling to an IRA opens up Roth-conversion flexibility (TSP itself does not allow partial in-plan Roth conversions). ' +
          'Do the rollover and any conversions BEFORE 住民票 to keep them U.S.-only.',
        summary_jp:
          '退役・離職後の TSP は据え置き・IRA への移管・Traditional から Roth への段階的変換が選択肢になります。' +
          'TSP 自体は部分的な内部 Roth 変換を許容していないため、IRA に移すと Roth 変換の自由度が高まります。' +
          '移管も変換も住民票登録前に行うことで、米国課税のみで完結します。',
        severity: 'high',
        deadline_iso: preJuminhyouDeadline(),
        amount_usd: tspBalance,
      });
    }

    // ---- Establish Japan banking under SOFA before losing access ---
    if (stay && profile.sofa_status === 'active') {
      emit({
        id: 'setup_jp_banking',
        type: 'setup_jp_banking',
        title_en: 'Set up Japan banking while still SOFA-status',
        title_jp: 'SOFA 適用期間中に日本の銀行口座を整備する',
        summary_en:
          'Some Japanese banks (Shinsei, Sony Bank, SMBC Trust PRESTIA) accept SOFA-status applicants more readily than they accept post-SOFA gaijin without 住民票. ' +
          'A Japan Post account opened during SOFA is a portable foundation that survives the transition. ' +
          'Open accounts now; do not wait until you actually need them.',
        summary_jp:
          '新生銀行・Sony Bank・SMBC 信託銀行 PRESTIA など、SOFA 適用中の方が住民票なしの一般外国人より口座開設のハードルが低いことがあります。' +
          'SOFA 適用中に開設したゆうちょ口座は、SOFA 終了後も継続利用しやすい基盤になります。' +
          '実際に必要になる前に開設しておきましょう。',
        severity: 'medium',
        deadline_iso: sep,
      });
    }

    // ---- PFIC trap warning -----------------------------------------
    if (stay) {
      emit({
        id: 'pfic_trap',
        type: 'pfic_avoid',
        title_en: 'Do NOT buy Japanese mutual funds / ETFs / 投資信託 after 住民票',
        title_jp: '住民票登録後に日本の投資信託・ETF を購入しない',
        summary_en:
          'Most Japan-domiciled mutual funds and ETFs are PFICs (Passive Foreign Investment Companies) under U.S. tax law. ' +
          'PFIC status triggers punitive U.S. taxation (Form 8621, ordinary-income treatment of gains, interest charges) that can exceed 50% of returns. ' +
          'Limit 投資信託 purchases to U.S. brokerage accounts; if NISA / iDeCo are tempting, get CPA review first — the U.S. PFIC consequences usually outweigh the Japan tax-shelter benefit.',
        summary_jp:
          '日本籍の投資信託・ETF の大半は、米国税法上 PFIC(受動的外国投資会社)に該当します。' +
          'PFIC 該当により、米国側で重い課税(Form 8621、利益の通常所得課税、利息課税)が発生し、リターンの 50% 超が税負担となることもあります。' +
          '投資信託は米国ブローカー口座での購入に限定し、NISA / iDeCo を検討する場合は事前に CPA に相談してください。米国側の PFIC コストが日本側の節税メリットを上回る場合がほとんどです。',
        severity: 'high',
        deadline_iso: jum,
      });
    }

    // ---- Inheritance / gift timing -----------------------------------
    if (stay) {
      emit({
        id: 'inheritance_gift_window',
        type: 'gift_transfer',
        title_en: 'Major U.S. gift / inheritance transfers — finish BEFORE 住民票',
        title_jp: '米国側の大型贈与・相続移転は住民票登録前に完結させる',
        summary_en:
          'Japan inheritance and gift tax has a 10-year lookback for long-term residents and can apply to non-Japan-located assets. ' +
          'A pre-住民票 gift to a U.S.-resident heir avoids Japan gift tax on that transfer. ' +
          'For inheritances expected to flow your way, family timing decisions interact with your residency clock — flag this with both your CPA and a Japan-side estate professional.',
        summary_jp:
          '日本の相続税・贈与税は、長期居住者には 10 年遡及があり、日本所在外の資産にも課税されることがあります。' +
          '住民票登録前に米国居住の相続人へ贈与した場合、当該贈与は日本の贈与税対象外です。' +
          'これから受ける相続については、家族側のタイミング判断と本人の居住時計の関係を、CPA と日本側の相続専門家に並行して相談してください。',
        severity: 'medium',
        deadline_iso: preJuminhyouDeadline(),
      });
    }

    // ---- Persist newly-derived steps so the user's status flips
    //      (planned, executed, dismissed) survive the next render.
    setSteps(out);
    return out;
  }

  // ---- Date helpers ---------------------------------------------------

  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function daysUntil(iso) {
    if (!iso) return null;
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return iso;
  }

  function fmtDeadlineLabel(iso) {
    if (!iso) return TB.i18n.t('sofa.deadline.unknown');
    const days = daysUntil(iso);
    if (days == null) return iso;
    if (days < 0) return TB.i18n.t('sofa.deadline.past', { date: iso, days: Math.abs(days) });
    if (days === 0) return TB.i18n.t('sofa.deadline.today', { date: iso });
    if (days <= 90) return TB.i18n.t('sofa.deadline.soon', { date: iso, days });
    return TB.i18n.t('sofa.deadline.future', { date: iso, days });
  }

  // ====================================================================
  // Disclaimer modal — versioned ack with the cost-of-mistake warning
  // and triple-check (educational ack + CPA acknowledgment).
  // ====================================================================

  function buildDisclaimerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const acks = getAcks();
    let educationalChecked = false;
    let cpaChecked = !!acks.consulted_cpa;

    const card = el('div', { class: 'tb-card', 'data-track': 'sofa' });
    card.appendChild(el('div', { class: 'tb-card-meta' },
      el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'sofa' }, 'SOFA'),
    ));
    card.appendChild(el('h1', null, t('sofa.title')));
    card.appendChild(el('p', null, t('sofa.subtitle')));

    card.appendChild(el('div', {
      class: 'tb-disclaimer-inline',
      style: { borderLeftColor: 'var(--tb-warn)', marginBottom: 'var(--tb-sp-3)' },
    },
      el('strong', null, t('sofa.disclaimer.cost.headline')),
      el('p', { style: { margin: '6px 0 0' } }, t('sofa.disclaimer.cost.body')),
    ));

    card.appendChild(el('h3', null, t('sofa.disclaimer.title')));
    card.appendChild(el('div', { class: 'tb-disclaimer-inline' }, t('sofa.disclaimer.body')));

    // Triple-check acknowledgments. The disclaimer ack itself + the
    // CPA-consulted ack. The CPA ack is also tracked separately so
    // high-stakes actions later can require it again.
    const eduAck = el('label', {
      style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--tb-sp-2)', margin: 'var(--tb-sp-3) 0', cursor: 'pointer' },
    },
      el('input', {
        type: 'checkbox',
        onchange: (e) => {
          educationalChecked = e.target.checked;
          updateContinueBtn();
        },
      }),
      el('span', null, t('sofa.disclaimer.ack.educational')),
    );
    card.appendChild(eduAck);

    const cpaAck = el('label', {
      style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--tb-sp-2)', margin: 'var(--tb-sp-3) 0', cursor: 'pointer' },
    },
      el('input', {
        type: 'checkbox',
        checked: cpaChecked,
        onchange: (e) => {
          cpaChecked = e.target.checked;
          setAck('consulted_cpa', cpaChecked);
          if (cpaChecked) setAck('consulted_cpa_at', new Date().toISOString());
          updateContinueBtn();
        },
      }),
      el('span', null, t('sofa.disclaimer.ack.cpa')),
    );
    card.appendChild(cpaAck);

    const continueBtn = el('button', {
      class: 'tb-btn',
      disabled: true,
      onclick: () => {
        if (!educationalChecked) return;
        acknowledgeDisclaimer();
        render(host);
      },
    }, t('sofa.disclaimer.continue'));
    function updateContinueBtn() {
      // Educational ack is required to proceed. CPA ack is recorded
      // but not blocking — the user may not have consulted yet.
      continueBtn.disabled = !educationalChecked;
    }

    card.appendChild(el('div', { class: 'tb-btn-row' }, continueBtn));
    return card;
  }

  // ====================================================================
  // Top-level render
  // ====================================================================

  function render(container) {
    host = container;
    container.innerHTML = '';

    if (!hasAcknowledgedDisclaimer()) {
      container.appendChild(buildDisclaimerCard());
      return;
    }

    container.appendChild(buildShellCard());
    const tabHost = TB.utils.el('div', { id: 'tb-sofa-tab-host' });
    container.appendChild(tabHost);
    renderActiveTab();
  }

  function renderActiveTab() {
    const tabHost = host && host.querySelector('#tb-sofa-tab-host');
    if (!tabHost) return;
    tabHost.innerHTML = '';
    switch (activeTab) {
      case 'profile':  renderProfile(tabHost);  break;
      case 'accounts': renderAccounts(tabHost); break;
      case 'sequence': renderSequence(tabHost); break;
      case 'risks':    renderRisks(tabHost);    break;
      default:         renderOverview(tabHost);
    }
  }

  function buildShellCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const tabs = [
      { id: 'overview', label: t('sofa.tab.overview') },
      { id: 'profile',  label: t('sofa.tab.profile') },
      { id: 'accounts', label: t('sofa.tab.accounts') },
      { id: 'sequence', label: t('sofa.tab.sequence') },
      { id: 'risks',    label: t('sofa.tab.risks') },
    ];

    const tabBar = el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' },
    },
      ...tabs.map(tab => el('button', {
        class: 'tb-btn ' + (activeTab === tab.id ? '' : 'tb-btn--secondary'),
        onclick: () => { activeTab = tab.id; renderActiveTab(); render(host); },
      }, tab.label)),
    );

    const card = el('div', { class: 'tb-card', 'data-track': 'sofa' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'sofa' }, 'SOFA'),
      ),
      el('h1', null, t('sofa.title')),
      el('p', { class: 'tb-card-meta' }, t('sofa.subtitle')),
      tabBar,
    );
    return card;
  }

  // ====================================================================
  // OVERVIEW
  // ====================================================================

  function renderOverview(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const profile = getProfile();
    const lang = TB.i18n.getLang();

    // Profile completeness gate.
    if (!profile.role || !profile.jp_residency_plan) {
      tabHost.appendChild(el('div', { class: 'tb-card', 'data-track': 'sofa' },
        el('h2', null, t('sofa.overview.empty.title')),
        el('p', null, t('sofa.overview.empty.body')),
        el('div', { class: 'tb-btn-row' },
          el('button', {
            class: 'tb-btn',
            onclick: () => { activeTab = 'profile'; render(host); },
          }, t('sofa.overview.empty.cta')),
        ),
      ));
      return;
    }

    // Window summary card.
    const windowCard = el('div', { class: 'tb-card', 'data-track': 'sofa' });
    windowCard.appendChild(el('h2', null, t('sofa.overview.window.title')));

    const stay = profile.jp_residency_plan === 'stay';
    if (!stay) {
      windowCard.appendChild(el('p', null, t('sofa.overview.window.notStaying')));
    } else {
      const sep = profile.separation_date;
      const jum = profile.juminhyou_target_date;
      const grid = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-3)' },
      });
      grid.appendChild(buildWindowPill(t('sofa.overview.window.separation'), sep));
      grid.appendChild(buildWindowPill(t('sofa.overview.window.juminhyou'), jum));
      const daysToJum = daysUntil(jum);
      if (daysToJum != null) {
        grid.appendChild(buildWindowPill(t('sofa.overview.window.daysLeft'),
          daysToJum >= 0 ? String(daysToJum) : '—'));
      }
      windowCard.appendChild(grid);
    }
    tabHost.appendChild(windowCard);

    // Top recommended actions (top 3 by severity).
    const steps = deriveSequence().filter(s => s.status !== 'dismissed' && s.status !== 'executed');
    const severityOrder = { critical: 0, high: 1, medium: 2, info: 3 };
    steps.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));
    const top = steps.slice(0, 3);

    if (top.length > 0) {
      const stepsCard = el('div', { class: 'tb-card', 'data-track': 'sofa' });
      stepsCard.appendChild(el('h2', null, t('sofa.overview.actions.title')));
      stepsCard.appendChild(el('p', { class: 'tb-card-meta' }, t('sofa.overview.actions.intro')));
      for (const s of top) stepsCard.appendChild(buildStepRow(s, lang, true));
      stepsCard.appendChild(el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          onclick: () => { activeTab = 'sequence'; render(host); },
        }, t('sofa.overview.actions.viewAll', { count: steps.length })),
      ));
      tabHost.appendChild(stepsCard);
    }

    // Quick links card.
    tabHost.appendChild(el('div', { class: 'tb-card', 'data-track': 'sofa' },
      el('h2', null, t('sofa.overview.quicklinks')),
      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'profile'; render(host); } }, t('sofa.overview.ql.profile')),
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'accounts'; render(host); } }, t('sofa.overview.ql.accounts')),
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'risks'; render(host); } }, t('sofa.overview.ql.risks')),
      ),
    ));
  }

  function buildWindowPill(label, value) {
    const el = TB.utils.el;
    return el('div', {
      style: {
        padding: 'var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
      },
    },
      el('div', { class: 'tb-card-meta', style: { marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--tb-fs-12)' } }, label),
      el('div', { style: { fontSize: 'var(--tb-fs-22)', fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, value || '—'),
    );
  }

  // ====================================================================
  // PROFILE
  // ====================================================================

  function renderProfile(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const profile = getProfile();
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'sofa' });
    card.appendChild(el('h2', null, t('sofa.profile.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('sofa.profile.intro')));

    function bind(field) {
      return (e) => setProfileField(field, e.target.value);
    }

    function pickerField(label, fieldName, options, helpKey) {
      const labelFor = (o) => lang === 'ja' ? o.label_jp : o.label_en;
      return field(label,
        el('select', {
          class: 'tb-select',
          onchange: bind(fieldName),
        },
          el('option', { value: '', selected: !profile[fieldName] }, '— ' + t('sofa.profile.choose') + ' —'),
          ...options.map(o => el('option', {
            value: o.value, selected: profile[fieldName] === o.value,
          }, labelFor(o))),
        ),
        helpKey ? t(helpKey) : null);
    }

    card.appendChild(grid2col(
      pickerField(t('sofa.profile.role'), 'role', SOFA_ROLES, 'sofa.profile.role.help'),
      pickerField(t('sofa.profile.sofa_status'), 'sofa_status', SOFA_STATUSES),
    ));

    card.appendChild(grid2col(
      field(t('sofa.profile.separation_date'), el('input', {
        type: 'date',
        class: 'tb-input',
        value: profile.separation_date || '',
        onchange: bind('separation_date'),
      }), t('sofa.profile.separation_date.help')),
      field(t('sofa.profile.juminhyou_target_date'), el('input', {
        type: 'date',
        class: 'tb-input',
        value: profile.juminhyou_target_date || '',
        onchange: bind('juminhyou_target_date'),
      }), t('sofa.profile.juminhyou_target_date.help')),
    ));

    card.appendChild(grid2col(
      pickerField(t('sofa.profile.jp_residency_plan'), 'jp_residency_plan', JP_RESIDENCY_PLANS,
        'sofa.profile.jp_residency_plan.help'),
      pickerField(t('sofa.profile.filing_status'), 'filing_status', FILING_STATUSES),
    ));

    card.appendChild(grid2col(
      field(t('sofa.profile.spouse_us'), el('select', {
        class: 'tb-select', onchange: bind('spouse_us_person'),
      },
        el('option', { value: '', selected: !profile.spouse_us_person }, '—'),
        el('option', { value: 'yes', selected: profile.spouse_us_person === 'yes' }, t('sofa.yes')),
        el('option', { value: 'no', selected: profile.spouse_us_person === 'no' }, t('sofa.no')),
        el('option', { value: 'na', selected: profile.spouse_us_person === 'na' }, t('sofa.na')),
      )),
      field(t('sofa.profile.minor_children'), el('select', {
        class: 'tb-select', onchange: bind('has_minor_children'),
      },
        el('option', { value: '', selected: !profile.has_minor_children }, '—'),
        el('option', { value: 'yes', selected: profile.has_minor_children === 'yes' }, t('sofa.yes')),
        el('option', { value: 'no', selected: profile.has_minor_children === 'no' }, t('sofa.no')),
      )),
    ));

    card.appendChild(field(t('sofa.profile.notes'), el('textarea', {
      class: 'tb-input',
      rows: 3,
      style: { resize: 'vertical' },
      placeholder: t('sofa.profile.notes.placeholder'),
      onchange: bind('notes'),
    }, profile.notes || '')));

    tabHost.appendChild(card);
  }

  // ====================================================================
  // ACCOUNTS
  // ====================================================================

  function renderAccounts(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const accounts = getAccounts(); // derived rollup from assets module
    const tax = getTaxAssump();

    const card = el('div', { class: 'tb-card', 'data-track': 'sofa' });
    card.appendChild(el('h2', null, t('sofa.accounts.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('sofa.accounts.intro')));

    // Source-of-truth callout — balances live in the Assets module now.
    const calloutBody = lang === 'ja'
      ? '口座残高は「資産・口座トラッカー」モジュールに統合されました。下記は SOFA に流れる集計のプレビューです。残高を編集するには Assets を開いてください。'
      : 'Account balances now live in the Assets & Portfolio Tracker. Below is a read-only preview of the rollup feeding the SOFA sequencer. Open the Assets module to edit any balance.';
    card.appendChild(el('div', { class: 'tb-disclaimer-inline', style: { marginBottom: 'var(--tb-sp-3)' } },
      calloutBody));
    card.appendChild(el('div', { class: 'tb-btn-row', style: { marginTop: 0, marginBottom: 'var(--tb-sp-4)' } },
      el('button', {
        class: 'tb-btn',
        type: 'button',
        onclick: () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'assets' } })),
      }, lang === 'ja' ? '資産モジュールを開く →' : 'Open Assets module →'),
    ));

    // Rollup display — read-only rows with contributing-account
    // drill-down. Empty wrappers are dimmed and show a "+ Add account"
    // CTA so the user can flow directly to Assets to set them up.
    //
    // wrapperId param maps the SOFA-flat field back to the Assets
    // wrapper(s) that contribute to it. Some fields (taxable_basis,
    // re_basis) don't have a 1:1 wrapper — those skip the drill-down.
    function rollupRow(labelKey, fieldName, helpKey, wrapperId) {
      const v = accounts[fieldName];
      const has = v != null && v !== 0;
      const wrapperAccounts = wrapperId && TB.assets && TB.assets.getAccountsForWrapper
        ? TB.assets.getAccountsForWrapper(wrapperId)
        : [];

      const headerRow = el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          marginBottom: wrapperAccounts.length > 0 ? '2px' : 'var(--tb-sp-1)',
          opacity: has ? '1' : '0.55',
        },
      },
        el('div', null,
          el('div', { style: { fontSize: 'var(--tb-fs-14)' } }, t(labelKey)),
          helpKey ? el('div', { class: 'tb-field-help' }, t(helpKey)) : null,
        ),
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
          has ? TB.utils.formatUSD(v, { maximumFractionDigits: 0 }) : '—'),
      );

      // No wrapperId mapping — return just the header (used for basis fields).
      if (!wrapperId) return headerRow;

      const wrap = el('div');
      wrap.appendChild(headerRow);

      if (wrapperAccounts.length > 0) {
        // Per-account list — small, indented, with institution + name + USD.
        const list = el('div', {
          style: {
            padding: '4px var(--tb-sp-3) var(--tb-sp-2) var(--tb-sp-5)',
            fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
          },
        });
        for (const a of wrapperAccounts) {
          list.appendChild(el('div', {
            style: { display: 'flex', justifyContent: 'space-between', padding: '2px 0' },
          },
            el('span', null,
              (a.institution ? a.institution + ' · ' : '') + (a.name || '(unnamed)') +
              (a.account_number_last4 ? ' (••••' + a.account_number_last4 + ')' : '')),
            el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
              TB.utils.formatUSD(a.balance_usd, { maximumFractionDigits: 0 })),
          ));
        }
        wrap.appendChild(list);
      } else {
        // Empty-wrapper guidance — link to Assets to add one.
        wrap.appendChild(el('div', {
          style: {
            padding: '4px var(--tb-sp-3) var(--tb-sp-2) var(--tb-sp-5)',
            fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', fontStyle: 'italic',
          },
        },
          el('span', null, t('sofa.accounts.empty.cta') + ' '),
          el('a', {
            href: '#',
            style: { color: 'var(--tb-navy)' },
            onclick: (e) => {
              e.preventDefault();
              document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'assets' } }));
            },
          }, t('sofa.accounts.empty.link') + ' →'),
        ));
      }
      return wrap;
    }

    card.appendChild(el('h3', null, t('sofa.accounts.section.retirement')));
    card.appendChild(rollupRow('sofa.accounts.traditional_ira',     'traditional_ira_usd',          'sofa.accounts.traditional_ira.help', 'traditional_ira'));
    card.appendChild(rollupRow('sofa.accounts.traditional_401k_tsp','traditional_401k_tsp_usd',     null, 'traditional_401k_tsp'));
    card.appendChild(rollupRow('sofa.accounts.roth_ira',            'roth_ira_usd',                 null, 'roth_ira'));
    card.appendChild(rollupRow('sofa.accounts.roth_401k',           'roth_401k_usd',                null, 'roth_401k'));
    card.appendChild(rollupRow('sofa.accounts.hsa',                 'hsa_balance_usd',              'sofa.accounts.hsa.help', 'hsa'));

    card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-5)' } }, t('sofa.accounts.section.taxable')));
    card.appendChild(rollupRow('sofa.accounts.taxable_value', 'taxable_brokerage_value_usd', null, 'taxable_brokerage'));
    card.appendChild(rollupRow('sofa.accounts.taxable_basis', 'taxable_brokerage_basis_usd', 'sofa.accounts.taxable_basis.help'));

    card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-5)' } }, t('sofa.accounts.section.equity')));
    card.appendChild(rollupRow('sofa.accounts.rsu_unvested',  'rsu_unvested_value_usd',       null, 'rsu_unvested'));
    card.appendChild(rollupRow('sofa.accounts.options',       'nso_iso_unrealized_value_usd', null, 'nso_iso'));
    card.appendChild(rollupRow('sofa.accounts.deferred_comp', 'deferred_comp_usd',            null, 'deferred_comp'));

    card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-5)' } }, t('sofa.accounts.section.realestate')));
    card.appendChild(rollupRow('sofa.accounts.re_value', 'us_real_estate_value_usd', null, 'us_real_estate'));
    card.appendChild(rollupRow('sofa.accounts.re_basis', 'us_real_estate_basis_usd'));

    // Tax assumptions stay in SOFA — they're SOFA-specific user prefs,
    // not portfolio data, so they belong here.
    card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-5)' } }, t('sofa.accounts.section.tax')));
    card.appendChild(grid2col(
      field(t('sofa.tax.us_marginal'), el('input', {
        type: 'number', class: 'tb-input', min: '0', max: '50', step: '0.5',
        placeholder: '24',
        value: tax.us_marginal_pct != null ? tax.us_marginal_pct : '',
        onchange: (e) => setTaxField('us_marginal_pct',
          e.target.value === '' ? null : Number(e.target.value)),
      }), t('sofa.tax.us_marginal.help')),
      field(t('sofa.tax.us_ltcg'), el('input', {
        type: 'number', class: 'tb-input', min: '0', max: '30', step: '0.5',
        placeholder: '15',
        value: tax.us_ltcg_pct != null ? tax.us_ltcg_pct : '',
        onchange: (e) => setTaxField('us_ltcg_pct',
          e.target.value === '' ? null : Number(e.target.value)),
      })),
    ));
    card.appendChild(grid2col(
      field(t('sofa.tax.jp_marginal'), el('input', {
        type: 'number', class: 'tb-input', min: '0', max: '60', step: '0.5',
        placeholder: '33',
        value: tax.jp_marginal_pct != null ? tax.jp_marginal_pct : '',
        onchange: (e) => setTaxField('jp_marginal_pct',
          e.target.value === '' ? null : Number(e.target.value)),
      }), t('sofa.tax.jp_marginal.help')),
      field(t('sofa.tax.jp_ltcg'), el('input', {
        type: 'number', class: 'tb-input', min: '0', max: '30', step: '0.001',
        value: tax.jp_ltcg_pct != null ? tax.jp_ltcg_pct : 20.315,
        onchange: (e) => setTaxField('jp_ltcg_pct',
          e.target.value === '' ? null : Number(e.target.value)),
      }), t('sofa.tax.jp_ltcg.help')),
    ));

    tabHost.appendChild(card);
  }

  // ====================================================================
  // SEQUENCE
  // ====================================================================

  function renderSequence(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const profile = getProfile();

    const card = el('div', { class: 'tb-card', 'data-track': 'sofa' });
    card.appendChild(el('h2', null, t('sofa.sequence.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('sofa.sequence.intro')));

    if (!profile.role || !profile.jp_residency_plan) {
      card.appendChild(el('p', { class: 'tb-wizard-help' }, t('sofa.sequence.profileFirst')));
      card.appendChild(el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn',
          onclick: () => { activeTab = 'profile'; render(host); },
        }, t('sofa.overview.empty.cta')),
      ));
      tabHost.appendChild(card);
      return;
    }

    const steps = deriveSequence();
    if (steps.length === 0) {
      card.appendChild(el('p', { class: 'tb-wizard-help' }, t('sofa.sequence.empty')));
      tabHost.appendChild(card);
      return;
    }

    // Sort: severity then deadline.
    const severityOrder = { critical: 0, high: 1, medium: 2, info: 3 };
    steps.sort((a, b) => {
      const sa = severityOrder[a.severity] || 99;
      const sb = severityOrder[b.severity] || 99;
      if (sa !== sb) return sa - sb;
      const da = a.deadline_iso || '9999-12-31';
      const db = b.deadline_iso || '9999-12-31';
      return da.localeCompare(db);
    });

    // Group by status.
    const buckets = { pending: [], planned: [], executed: [], dismissed: [] };
    for (const s of steps) {
      const k = s.status || 'pending';
      (buckets[k] || buckets.pending).push(s);
    }

    function renderBucket(label, list, expandable) {
      if (list.length === 0) return null;
      const wrap = el('div', { style: { marginTop: 'var(--tb-sp-4)' } });
      wrap.appendChild(el('h3', null, label + ' · ' + list.length));
      for (const s of list) wrap.appendChild(buildStepRow(s, lang, false));
      return wrap;
    }

    const pendingSection = renderBucket(t('sofa.sequence.bucket.pending'), buckets.pending);
    const plannedSection = renderBucket(t('sofa.sequence.bucket.planned'), buckets.planned);
    const executedSection = renderBucket(t('sofa.sequence.bucket.executed'), buckets.executed, true);
    const dismissedSection = renderBucket(t('sofa.sequence.bucket.dismissed'), buckets.dismissed, true);

    if (pendingSection) card.appendChild(pendingSection);
    if (plannedSection) card.appendChild(plannedSection);
    if (executedSection) card.appendChild(executedSection);
    if (dismissedSection) card.appendChild(dismissedSection);

    tabHost.appendChild(card);
  }

  function buildStepRow(step, lang, compact) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const titleText = lang === 'ja' ? step.title_jp : step.title_en;
    const summaryText = lang === 'ja' ? step.summary_jp : step.summary_en;

    const sevClass = 'tb-sofa-sev-' + (step.severity || 'info');
    const sevColors = {
      critical: 'var(--tb-error, var(--tb-warn))',
      high:     'var(--tb-warn)',
      medium:   'var(--tb-accent)',
      info:     'var(--tb-text-soft)',
    };
    const sevColor = sevColors[step.severity] || sevColors.info;

    const wrap = el('div', {
      class: 'tb-card',
      style: {
        background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        borderLeft: '4px solid ' + sevColor,
        opacity: step.status === 'dismissed' || step.status === 'executed' ? '0.6' : '1',
      },
    });

    const headerRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-2)' },
    },
      el('div', { style: { flex: '1 1 0', minWidth: '200px' } },
        el('strong', null, titleText),
        el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } },
          el('span', {
            style: {
              display: 'inline-block', padding: '1px 8px', borderRadius: '999px',
              fontSize: 'var(--tb-fs-12)', textTransform: 'uppercase', letterSpacing: '0.04em',
              background: sevColor + '22', color: sevColor, fontWeight: '700', marginRight: 'var(--tb-sp-2)',
            },
          }, t('sofa.severity.' + (step.severity || 'info'))),
          step.deadline_iso
            ? el('span', { style: { color: 'var(--tb-text-soft)' } }, fmtDeadlineLabel(step.deadline_iso))
            : null,
          step.amount_usd
            ? el('span', {
                style: { color: 'var(--tb-text-soft)', marginLeft: 'var(--tb-sp-2)' },
              }, '~$' + Number(step.amount_usd).toLocaleString())
            : null,
        ),
      ),
    );
    wrap.appendChild(headerRow);

    if (!compact) {
      wrap.appendChild(el('p', { style: { margin: 'var(--tb-sp-2) 0', lineHeight: '1.55' } }, summaryText));

      // ── Asset-integration awareness ────────────────────────────
      // When a step references a wrapper that has $0 balance in
      // Assets, show a guidance row pointing the user to add the
      // account. Mapping: roth_conversion → traditional_ira/401k_tsp;
      // realize_ltcg → taxable_brokerage; rsu_vest → rsu_unvested;
      // re_sale → us_real_estate; tsp_rollover → traditional_401k_tsp.
      const wrapperGuards = {
        roth_conversion:  ['traditional_ira', 'traditional_401k_tsp'],
        realize_ltcg:     ['taxable_brokerage'],
        rsu_vest:         ['rsu_unvested'],
        exercise_options: ['nso_iso'],
        deferred_comp:    ['deferred_comp'],
        re_sale:          ['us_real_estate'],
        tsp_rollover:     ['traditional_401k_tsp'],
      };
      const guardWrappers = wrapperGuards[step.type] || [];
      if (guardWrappers.length > 0 && TB.assets && TB.assets.getAccountsForWrapper) {
        const hasAny = guardWrappers.some((w) => TB.assets.getAccountsForWrapper(w).length > 0);
        if (!hasAny) {
          const wrapperNames = guardWrappers.map((w) => t('assets.wrapper.' + w) || w).join(' / ');
          wrap.appendChild(el('div', {
            style: {
              borderLeft: '3px solid var(--tb-warn)',
              padding: '6px 12px',
              background: 'rgba(185, 122, 26, 0.06)',
              borderRadius: 'var(--tb-radius-1)',
              fontSize: 'var(--tb-fs-12)',
              color: 'var(--tb-warn)',
              margin: 'var(--tb-sp-2) 0',
            },
          },
            '⚠ ' + t('sofa.step.noAssets', { wrappers: wrapperNames }) + ' ',
            el('a', {
              href: '#',
              style: { color: 'var(--tb-warn)', fontWeight: '600' },
              onclick: (e) => {
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'assets' } }));
              },
            }, t('sofa.step.openAssets') + ' →'),
          ));
        } else {
          // Show the actual contributing accounts inline so the user
          // sees exactly what they'd be drawing from / converting.
          const accts = guardWrappers.flatMap((w) => TB.assets.getAccountsForWrapper(w));
          if (accts.length > 0 && !compact) {
            const list = accts.slice(0, 4).map((a) =>
              (a.institution ? a.institution + ' ' : '') + (a.name || '') +
              ' (' + TB.utils.formatUSD(a.balance_usd, { maximumFractionDigits: 0 }) + ')'
            ).join(' · ');
            wrap.appendChild(el('div', {
              style: {
                fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
                padding: '4px 0', borderTop: '1px dashed var(--tb-border)',
                marginTop: 'var(--tb-sp-1)',
              },
            },
              el('strong', null, t('sofa.step.affectsAccounts') + ' '),
              list + (accts.length > 4 ? ' …+' + (accts.length - 4) : ''),
            ));
          }
        }
      }

      const actionsRow = el('div', { class: 'tb-btn-row', style: { margin: 0 } });

      // ── Cross-link to Projections for actionable step types ────
      // Roth conversions: deep-link to Projections → Tax Strategy
      // (where the conversion ladder editor lives).
      if (step.type === 'roth_conversion' && !compact) {
        actionsRow.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          onclick: () => {
            // Navigate to Projections + open Tax Strategy tab.
            try { TB.state.set('projections.ui_state.active_tab', 'tax_strategy'); } catch (e) {}
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'projections' } }));
          },
        }, '🟢 ' + t('sofa.step.planInProjections')));
      }
      // Realize LTCG, RSU vest, RE sale: deep-link to Projections too,
      // but to the main projection (where you can see the year and tax).
      if ((step.type === 'realize_ltcg' || step.type === 'rsu_vest' || step.type === 're_sale') && !compact) {
        actionsRow.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          onclick: () => {
            try { TB.state.set('projections.ui_state.active_tab', 'projection'); } catch (e) {}
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'projections' } }));
          },
        }, '📊 ' + t('sofa.step.viewProjection')));
      }
      const status = step.status || 'pending';
      function flip(newStatus) {
        const all = getSteps();
        const i = all.findIndex(x => x.id === step.id);
        if (i >= 0) {
          all[i] = Object.assign({}, all[i], { status: newStatus });
          if (newStatus === 'executed') {
            all[i].executed_date = new Date().toISOString().slice(0, 10);
          }
          setSteps(all);
        }
        renderActiveTab();
      }

      if (status === 'pending') {
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => flip('planned') }, t('sofa.action.markPlanned')));
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => openExecutedModal(step) }, t('sofa.action.markExecuted')));
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', onclick: () => flip('dismissed') }, t('sofa.action.dismiss')));
      } else if (status === 'planned') {
        actionsRow.appendChild(el('button', { class: 'tb-btn', onclick: () => openExecutedModal(step) }, t('sofa.action.markExecuted')));
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => flip('pending') }, t('sofa.action.unplan')));
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', onclick: () => flip('dismissed') }, t('sofa.action.dismiss')));
      } else if (status === 'executed') {
        actionsRow.appendChild(el('span', { class: 'tb-card-meta' },
          '✓ ' + t('sofa.executed.on', { date: step.executed_date || '—' })));
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', onclick: () => flip('pending') }, t('sofa.action.reopen')));
      } else if (status === 'dismissed') {
        actionsRow.appendChild(el('span', { class: 'tb-card-meta' }, t('sofa.dismissed')));
        actionsRow.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', onclick: () => flip('pending') }, t('sofa.action.reopen')));
      }
      wrap.appendChild(actionsRow);
    }

    return wrap;
  }

  // ====================================================================
  // Triple-confirmation modal — used when marking a critical step as
  // executed, to slow the user down and confirm CPA review.
  // ====================================================================

  function openExecutedModal(step) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    const isCritical = step.severity === 'critical';
    let ack1 = false;
    let ack2 = false;
    let ack3 = !isCritical; // third ack only required for critical steps
    let amountStr = '';
    let dateStr = new Date().toISOString().slice(0, 10);
    let notesStr = '';

    function rebuild() {
      modalRoot.innerHTML = '';

      const card = el('div', { class: 'tb-modal' });
      card.appendChild(el('h2', { style: { marginTop: 0 } },
        '✓ ' + t('sofa.executed.modal.title')));
      card.appendChild(el('p', { class: 'tb-card-meta' },
        lang === 'ja' ? step.title_jp : step.title_en));

      if (isCritical) {
        card.appendChild(el('div', {
          class: 'tb-disclaimer-inline',
          style: { borderLeftColor: 'var(--tb-error, var(--tb-warn))' },
        },
          el('strong', null, t('sofa.executed.modal.criticalHeadline')),
          el('p', { style: { margin: '6px 0 0' } }, t('sofa.executed.modal.criticalBody')),
        ));
      }

      // Triple-ack section.
      const ackBox = (label, isChecked, onChange) => el('label', {
        style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--tb-sp-2)', margin: 'var(--tb-sp-2) 0', cursor: 'pointer' },
      },
        el('input', {
          type: 'checkbox',
          checked: isChecked,
          onchange: (e) => { onChange(e.target.checked); rebuild(); },
        }),
        el('span', null, label),
      );

      card.appendChild(ackBox(t('sofa.executed.modal.ack1'), ack1, (v) => { ack1 = v; }));
      card.appendChild(ackBox(t('sofa.executed.modal.ack2'), ack2, (v) => { ack2 = v; }));
      if (isCritical) {
        card.appendChild(ackBox(t('sofa.executed.modal.ack3'), ack3, (v) => { ack3 = v; }));
      }

      // Detail inputs.
      card.appendChild(field(t('sofa.executed.modal.dateLabel'), el('input', {
        type: 'date', class: 'tb-input', value: dateStr,
        onchange: (e) => { dateStr = e.target.value; },
      })));
      card.appendChild(field(t('sofa.executed.modal.amountLabel'), el('input', {
        type: 'number', class: 'tb-input', placeholder: 'USD',
        value: amountStr,
        onchange: (e) => { amountStr = e.target.value; },
      })));
      card.appendChild(field(t('sofa.executed.modal.notesLabel'), el('textarea', {
        class: 'tb-input', rows: 2, style: { resize: 'vertical' },
        onchange: (e) => { notesStr = e.target.value; },
      }, notesStr)));

      const allAcked = ack1 && ack2 && ack3;
      card.appendChild(el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: closeModal }, t('sofa.action.cancel')),
        el('button', {
          class: 'tb-btn',
          disabled: !allAcked,
          onclick: () => {
            const all = getSteps();
            const i = all.findIndex(x => x.id === step.id);
            if (i >= 0) {
              all[i] = Object.assign({}, all[i], {
                status: 'executed',
                executed_date: dateStr || null,
                executed_amount: amountStr === '' ? null : Number(amountStr),
                notes: notesStr,
              });
              setSteps(all);
            }
            closeModal();
            renderActiveTab();
          },
        }, t('sofa.executed.modal.confirm')),
      ));

      const backdrop = el('div', {
        class: 'tb-modal-backdrop',
        onclick: (e) => { if (e.target === backdrop) closeModal(); },
      }, card);
      modalRoot.appendChild(backdrop);
    }

    rebuild();
  }

  // ====================================================================
  // RISKS — explanations of the major cost-of-mistake scenarios.
  // ====================================================================

  function renderRisks(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const risks = [
      {
        title: t('sofa.risks.roth.title'),
        body: t('sofa.risks.roth.body'),
        severity: 'critical',
      },
      {
        title: t('sofa.risks.ltcg.title'),
        body: t('sofa.risks.ltcg.body'),
        severity: 'high',
      },
      {
        title: t('sofa.risks.pfic.title'),
        body: t('sofa.risks.pfic.body'),
        severity: 'high',
      },
      {
        title: t('sofa.risks.exit.title'),
        body: t('sofa.risks.exit.body'),
        severity: 'medium',
      },
      {
        title: t('sofa.risks.inheritance.title'),
        body: t('sofa.risks.inheritance.body'),
        severity: 'medium',
      },
      {
        title: t('sofa.risks.rsu.title'),
        body: t('sofa.risks.rsu.body'),
        severity: 'high',
      },
    ];

    const card = el('div', { class: 'tb-card', 'data-track': 'sofa' });
    card.appendChild(el('h2', null, t('sofa.risks.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('sofa.risks.intro')));
    tabHost.appendChild(card);

    const sevColors = {
      critical: 'var(--tb-error, var(--tb-warn))',
      high:     'var(--tb-warn)',
      medium:   'var(--tb-accent)',
    };

    for (const r of risks) {
      const block = el('div', {
        class: 'tb-card', 'data-track': 'sofa',
        style: {
          borderLeft: '4px solid ' + (sevColors[r.severity] || sevColors.medium),
        },
      });
      block.appendChild(el('h3', { style: { margin: 0 } }, r.title));
      block.appendChild(el('p', { style: { lineHeight: '1.6', margin: 'var(--tb-sp-2) 0 0' } }, r.body));
      tabHost.appendChild(block);
    }
  }

  // ====================================================================
  // Small UI helpers
  // ====================================================================

  function field(label, control, help) {
    const el = TB.utils.el;
    return el('label', { class: 'tb-field', style: { marginBottom: 0 } },
      el('span', { class: 'tb-field-label' }, label),
      control,
      help ? el('div', { class: 'tb-field-help' }, help) : null,
    );
  }

  function grid2col() {
    const el = TB.utils.el;
    return el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--tb-sp-3)', marginBottom: 'var(--tb-sp-3)' },
    }, ...arguments);
  }

  // ====================================================================
  // Module registration
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'SOFA Roth Planner',
    label_jp: 'SOFA Roth プランナー',
    render,
  };

  // Expose pure functions for tests / future AI integration.
  window.TB.sofa = {
    deriveSequence,
    REQUIRED_DISCLAIMER_VERSION,
    SOFA_ROLES,
    SOFA_STATUSES,
    JP_RESIDENCY_PLANS,
    FILING_STATUSES,
  };
})();
