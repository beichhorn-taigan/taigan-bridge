/* Taigan Bridge — modules/veteran.js
 *
 * Veteran module — service record + VA benefits tracking for US
 * veterans living in Japan. Surfaces: VA disability rating + monthly
 * compensation, TRICARE eligibility, Foreign Medical Program for
 * service-connected care abroad, Post-9/11 GI Bill (and the 15-year
 * expiry for pre-2013 dischargees), SGLI/VGLI death benefits, and
 * Japan-specific resources (VA Manila Regional Office, TRICARE
 * Overseas, FMP enrollment).
 *
 * Action Center integration via TB.veteran.actionGenerators —
 * watches for: DD-214 not in vault, GI Bill expiring within 1 year,
 * VGLI 120-day conversion deadline, annual VA re-evaluation due.
 */

(function () {
  'use strict';

  const id = 'veteran';

  // ====================================================================
  // Action Center i18n — self-registered strings for genDD214Missing,
  // genGiBillExpiring, genVgliConversion, genAnnualReevalDue. Keys
  // follow vet.<generatorName>.<field> (title/body only; other fields
  // on the pushed items aren't user-facing strings).
  // ====================================================================

  TB.i18n.extend('en', {
    'vet.genDD214Missing.title': 'DD-214 not in your Document Vault',
    'vet.genDD214Missing.body': 'Your DD-214 is the master proof of US military service — required for VA benefits, security clearances, GI Bill claims, VA loans, government employment, and survivor benefits. Add it to the vault so your family can find it.',

    'vet.genGiBillExpiring.title': 'GI Bill benefits expire {{date}} ({{months}}mo)',
    'vet.genGiBillExpiring.body': 'Use it or lose it. Pre-2013 dischargees have a 15-year window from separation. Use the months remaining ({{monthsRemaining}} / 36) on a degree, certificate, or training program — OR transfer to a dependent if eligible.',

    'vet.genVgliConversion.easy.title': 'VGLI conversion window — {{days}} days left (no medical questions)',
    'vet.genVgliConversion.easy.body': 'Within 240 days of separation, you can convert SGLI → VGLI without any medical underwriting (up to your SGLI amount, max $400K). After 240 days you still have until day 485 but must answer medical questions and may be denied.',
    'vet.genVgliConversion.late.title': 'VGLI late window — {{days}} days left (medical questions required)',
    'vet.genVgliConversion.late.body': 'You missed the 240-day no-medical window but can still apply for VGLI through day 485. Health questions may result in denial. After day 485 the option is permanently lost.',

    'vet.genAnnualReevalDue.title': 'VA disability evaluation is {{years}} years old',
    'vet.genAnnualReevalDue.body': 'If your service-connected conditions have worsened, file for an increase. The VA can also schedule re-examinations on its own — keep records of all medical visits in your Document Vault for the next claim.',
  });

  TB.i18n.extend('ja', {
    'vet.genDD214Missing.title': 'DD-214 がドキュメント保管庫に未登録です',
    'vet.genDD214Missing.body': 'DD-214 は米軍兵役の基本証明書です — VA 給付、セキュリティクリアランス、GI Bill 申請、VA ローン、政府機関への就職、遺族給付に必要となります。ご家族がすぐ見つけられるよう保管庫に追加してください。',

    'vet.genGiBillExpiring.title': 'GI Bill 給付は {{date}} に失効します(残り{{months}}ヶ月)',
    'vet.genGiBillExpiring.body': '使わなければ失効します。2013 年以前の除隊者は除隊から 15 年の期限があります。残月数({{monthsRemaining}} / 36)を学位・資格・研修プログラムに使うか、対象であれば扶養家族に移転してください。',

    'vet.genVgliConversion.easy.title': 'VGLI 切替期間 — 残り{{days}}日(医療審査なし)',
    'vet.genVgliConversion.easy.body': '除隊から240日以内であれば、医療審査なしで SGLI → VGLI に切替できます(SGLI 額まで、最大 $400K)。240日を過ぎても485日目までは申請可能ですが、健康状態の質問に回答が必要で、断られる場合があります。',
    'vet.genVgliConversion.late.title': 'VGLI 後期切替期間 — 残り{{days}}日(医療審査が必要)',
    'vet.genVgliConversion.late.body': '医療審査なしの240日以内の期間は過ぎましたが、485日目までは VGLI の申請が可能です。健康状態の質問により却下される場合があります。485日を過ぎると権利は永久に失われます。',

    'vet.genAnnualReevalDue.title': 'VA 障害認定の検査から{{years}}年が経過しています',
    'vet.genAnnualReevalDue.body': '兵役関連状態が悪化している場合は増額請求を行ってください。VA が自主的に再検査を行うこともあります — 次回請求のため、すべての通院記録をドキュメント保管庫に保存しておきましょう。',
  });

  // ====================================================================
  // Reference tables
  // ====================================================================

  const BRANCHES = [
    { id: 'army',         emoji: '🪖', label_en: 'US Army',          label_jp: '米国陸軍' },
    { id: 'navy',         emoji: '⚓', label_en: 'US Navy',          label_jp: '米国海軍' },
    { id: 'air_force',    emoji: '✈️', label_en: 'US Air Force',     label_jp: '米国空軍' },
    { id: 'marines',      emoji: '🦅', label_en: 'US Marine Corps',  label_jp: '米国海兵隊' },
    { id: 'coast_guard',  emoji: '🚢', label_en: 'US Coast Guard',   label_jp: '米国沿岸警備隊' },
    { id: 'space_force',  emoji: '🚀', label_en: 'US Space Force',   label_jp: '米国宇宙軍' },
  ];

  const COMPONENTS = [
    { id: 'active',         label_en: 'Active duty',           label_jp: '現役' },
    { id: 'reserve',        label_en: 'Reserve',               label_jp: '予備役' },
    { id: 'national_guard', label_en: 'National Guard',        label_jp: '州兵' },
    { id: 'irr',            label_en: 'IRR (Inactive Ready)',  label_jp: '個人即応予備役 (IRR)' },
  ];

  const DISCHARGE_TYPES = [
    { id: 'honorable',    label_en: 'Honorable',                  label_jp: '名誉除隊' },
    { id: 'general',      label_en: 'General (Under Honorable)',  label_jp: '一般除隊' },
    { id: 'oth',          label_en: 'Other Than Honorable (OTH)', label_jp: '名誉除隊以外 (OTH)' },
    { id: 'bcd',          label_en: 'Bad Conduct (BCD)',          label_jp: '不品行除隊 (BCD)' },
    { id: 'dishonorable', label_en: 'Dishonorable (DD)',          label_jp: '不名誉除隊 (DD)' },
  ];

  const TRICARE_PLANS = [
    { id: 'prime',                 label_en: 'TRICARE Prime',                 label_jp: 'TRICARE Prime' },
    { id: 'select',                label_en: 'TRICARE Select',                label_jp: 'TRICARE Select' },
    { id: 'tricare_for_life',      label_en: 'TRICARE for Life (Medicare-eligible)', label_jp: 'TRICARE for Life(メディケア対象者)' },
    { id: 'overseas',              label_en: 'TRICARE Overseas Program',      label_jp: 'TRICARE Overseas プログラム' },
    { id: 'us_family_health_plan', label_en: 'US Family Health Plan',         label_jp: 'US Family Health Plan' },
  ];

  const EDUCATION_BENEFITS = [
    { id: 'post_911',         label_en: 'Post-9/11 GI Bill (Ch. 33)',  label_jp: 'Post-9/11 GI Bill(第33章)' },
    { id: 'montgomery',       label_en: 'Montgomery GI Bill (Ch. 30)', label_jp: 'モンゴメリー GI Bill(第30章)' },
    { id: 'forever_gi_bill',  label_en: 'Forever GI Bill (no expiry)', label_jp: 'Forever GI Bill(期限なし)' },
    { id: 'none',             label_en: 'None / Not eligible',         label_jp: 'なし・対象外' },
  ];

  // ====================================================================
  // Benefits deep-dive — status-specific guidance
  // ====================================================================
  //
  // Each veteran status unlocks a different mix of US benefits. This
  // table is the curated "what applies to YOU" surface that complements
  // the section cards (which are tracking surfaces). Items emphasize
  // Japan-relevant nuances (deposit-to-foreign-bank, treaty Article 17,
  // FMP for SC conditions, etc.) where they matter.
  //
  // Each item has: title, body, optional ref{url, label}, optional
  // jp_note (Japan-specific addendum) — kept short so the card scans.

  const BENEFITS_BY_STATUS = {
    active: {
      label_en: 'Active duty', label_jp: '現役',
      groups: [
        { label_en: 'Pay & allowances', label_jp: '給与・手当', items: [
          { title: 'Base pay', body: 'Set by your rank + years of service. See DFAS pay tables.',
            ref: { label: 'DFAS pay tables', url: 'https://www.dfas.mil/militarymembers/payentitlements/Pay-Tables/' } },
          { title: 'BAH (Basic Allowance for Housing)', body: 'Tax-free housing stipend. Rate set by duty location ZIP code + dependency status.',
            jp_en: 'BAH while in Japan is replaced by OHA (Overseas Housing Allowance) which reimburses actual rent up to a cap.' },
          { title: 'BAS (Basic Allowance for Subsistence)', body: 'Monthly food stipend, tax-free. Paid to all enlisted unless on subsistence-in-kind.' },
          { title: 'COLA (Cost of Living Allowance)', body: 'Tax-free supplement for high-cost areas. Japan rates can be substantial — verify your station\'s current COLA.' },
          { title: 'Combat Zone Tax Exclusion (CZTE)', body: 'All military pay earned in a designated combat zone is excluded from US federal tax (officer cap applies).' },
        ]},
        { label_en: 'Health', label_jp: '医療', items: [
          { title: 'TRICARE Active Duty (Prime Remote Overseas)', body: 'Free for service member. Family enrolled at no cost. Direct care at military treatment facilities + downtown network.' },
          { title: 'TRICARE Dental', body: 'Active Duty Dental Program for member; family pays via TRICARE Dental Program (TDP).' },
        ]},
        { label_en: 'Savings', label_jp: '貯蓄', items: [
          { title: 'TSP with 5% government match (BRS)', body: 'Blended Retirement System: 1% automatic + 4% match if you contribute 5%+. Roth + Traditional both available.',
            jp_en: 'TSP withdrawals while a JP resident are JP-taxable as ordinary income (treaty Article 17 saving-clause overrides).' },
          { title: 'Savings Deposit Program (SDP)', body: 'In combat zones: deposit up to $10K, earn 10% APR — well above market rates.' },
        ]},
        { label_en: 'Protection', label_jp: '保護', items: [
          { title: 'SGLI', body: 'Auto-enrolled at $400K. Premium ~$25/mo. Lapses 120 days after separation.' },
          { title: 'SCRA (Servicemembers Civil Relief Act)', body: '6% interest cap on pre-service debts, lease termination rights for orders, foreclosure protection.' },
        ]},
      ],
    },

    reserve_ng: {
      label_en: 'Reserve / National Guard', label_jp: '予備役・州兵',
      groups: [
        { label_en: 'Pay', label_jp: '給与', items: [
          { title: 'Drill pay', body: 'Standard 4 drills per month (one weekend) = 4 days of base pay. Tax-treatment same as active pay.' },
          { title: 'Annual training (AT)', body: '~2 weeks/year of full active duty pay + per diem.' },
          { title: 'Activation / mobilization pay', body: 'Treated as active duty for the activation period — full BAH/BAS, TRICARE Active, SCRA protections.' },
        ]},
        { label_en: 'Health', label_jp: '医療', items: [
          { title: 'TRICARE Reserve Select (TRS)', body: 'Paid premium (~$50/mo individual / ~$250/mo family in 2024). Vastly cheaper than civilian plans for the same coverage. Eligible while drilling.' },
          { title: 'Line of Duty (LOD) care', body: 'Injuries during drill / AT covered by military medical regardless of TRS enrollment.' },
        ]},
        { label_en: 'Savings', label_jp: '貯蓄', items: [
          { title: 'TSP', body: 'Continue contributing to your TSP via drill pay. No employer match while drilling (BRS match was for active duty service only).' },
        ]},
        { label_en: 'Future', label_jp: '将来', items: [
          { title: 'Reserve retirement at age 60', body: 'Earn retirement points throughout your career; collect monthly pension at age 60 (or earlier — 90 days less for each 90 days of qualifying active duty post-2008).',
            ref: { label: 'Reserve retirement points', url: 'https://www.militaryonesource.mil/financial-legal/personal-finance/saving-investing/reserve-component-retirement-system/' } },
          { title: 'TRICARE Retired Reserve (TRR)', body: 'Bridge coverage from end-of-service to age 60 for "gray area" reservists who completed 20+ years.' },
        ]},
        { label_en: 'Protection', label_jp: '保護', items: [
          { title: 'SGLI for drilling members', body: 'Available — same $400K max as active duty. Premium based on drill pay.' },
          { title: 'USERRA', body: 'Federal law: civilian employer must re-employ you in the same or comparable position after activation, with seniority intact.',
            ref: { label: 'USERRA overview', url: 'https://www.dol.gov/agencies/vets/programs/userra' } },
          { title: 'SCRA', body: 'Same protections as active duty during periods of activation.' },
        ]},
      ],
    },

    retired: {
      label_en: 'Retired (20+ years or medical)', label_jp: '退役者(20年以上または医療退役)',
      groups: [
        { label_en: 'Income', label_jp: '収入', items: [
          { title: 'Military retirement pay', body: '50%+ of your "high-3" base pay (or 40%+ under BRS). COLA-adjusted annually each December. Direct deposit to a US bank or — yes — a JP bank.',
            jp_en: 'Under the 2003 US-Japan Tax Treaty, government-service pensions (incl. military retirement) fall under Article 18: taxable in the paying state (US) — unless you are BOTH a resident AND a national of Japan, in which case Japan taxes it. (Article 17 covers private pensions + Social Security.) In practice the US saving clause keeps it US-taxable and a JP-resident retiree credits it via the FTC; coordinate with a cross-border preparer.' },
          { title: 'High-3 vs Final Pay vs REDUX vs BRS', body: 'Your specific calculation depends on entry date. High-3 (entered 1980-2017 most common). REDUX optional with $30K bonus. BRS (post-2018 entrants OR opted-in) = 40% pension + 5% TSP match.',
            ref: { label: 'DFAS retirement calculator', url: 'https://www.dfas.mil/RetiredMilitary/plan/Estimate-Your-Pay/' } },
        ]},
        { label_en: 'Health', label_jp: '医療', items: [
          { title: 'TRICARE Retired (Prime / Select)', body: 'Annual enrollment fees + cost-shares. TRICARE Select Overseas in Japan operates as reimbursement — pay JP providers cash, file claims.' },
          { title: 'TRICARE for Life (TFL)', body: 'At age 65 + Medicare-eligible: TFL becomes secondary to Medicare. Note: Medicare doesn\'t cover care abroad except in narrow border situations.' },
          { title: 'CHAMPVA (for surviving spouse)', body: 'For survivors of 100% disabled / KIA vets — separate VA-administered health benefit.' },
        ]},
        { label_en: 'Disability + retirement combo', label_jp: '障害 + 退役の組合せ', items: [
          { title: 'CRDP (Concurrent Retirement and Disability Pay)', body: 'If 50%+ rated, you receive BOTH full retirement AND VA disability — no offset. Auto-enrolled.' },
          { title: 'CRSC (Combat-Related Special Compensation)', body: 'For combat-related disabilities — even at <50% rating. Tax-free, replaces the offset of retirement pay vs VA comp. Must apply.' },
        ]},
        { label_en: 'Survivor protection', label_jp: '遺族保護', items: [
          { title: 'SBP (Survivor Benefit Plan)', body: 'Election made AT retirement — continue 55% of your pension to spouse. Premium ~6.5% of pension. Decline only with spouse signature.',
            ref: { label: 'SBP election guide', url: 'https://www.dfas.mil/RetiredMilitary/provide/sbp/' } },
          { title: 'VGLI', body: 'Convert SGLI within 240 days of retirement (no medical questions). Premiums age-based; gets expensive after ~60.' },
        ]},
        { label_en: 'Access & lifestyle', label_jp: 'アクセス・生活', items: [
          { title: 'Commissary / Exchange / MWR', body: 'Tax-free shopping at military bases worldwide, including Yokota, Misawa, Atsugi, Sasebo, Iwakuni, Okinawa.' },
          { title: 'Space-A travel', body: 'Standby military aircraft travel for retirees + dependents. From Japan to USA on patriot flights when seats available.' },
          { title: 'VA Home Loan', body: 'Available throughout retirement. No PMI, no down payment. US property only — not for buying Japanese real estate.' },
        ]},
      ],
    },

    separated_with_dis: {
      label_en: 'Separated with VA disability', label_jp: '除隊 + VA 障害認定あり',
      groups: [
        { label_en: 'Compensation', label_jp: '補償', items: [
          { title: 'VA disability compensation', body: 'Tax-free monthly. Rate increases with rating + dependents (child, spouse, parents). 2024 rates: 10%=~$171/mo, 50%=~$1,075/mo, 100%=~$3,737/mo (single).',
            jp_en: 'Direct deposit to a JP bank works (provide IBAN/SWIFT to VA Manila). US side: tax-free regardless of where you live (38 USC; IRS Pub 525). Japan side: genuinely UNSETTLED — there is no NTA ruling, tribunal 裁決, or court case on VA disability specifically. Clearly exempt while you hold SOFA status; for a permanent JP tax resident there are two solid not-taxable arguments (injury-compensation exemption + treaty government-service logic) plus an Article 21 "other income" fallback that could tax it. Not automatically exempt — see the "VA Disability in Japan" guide and confirm with a cross-border 税理士.' },
          { title: 'Annual COLA increase', body: 'Compensation rate adjusted each December for the Dec following.' },
        ]},
        { label_en: 'Healthcare', label_jp: '医療', items: [
          { title: 'VA Healthcare priority groups', body: 'Priority Group 1 (50%+) → no copays. Lower groups → may have copays. JP-resident vets typically use FMP for SC conditions, not direct VA care.' },
          { title: 'FMP (Foreign Medical Program)', body: 'Reimburses Japanese providers for treatment of YOUR specific service-connected conditions. Enroll once, then file claims via VA Manila for each visit.' },
          { title: 'Mental health support', body: 'PTSD, depression, etc. — Vet Center counseling available globally; some Japan-based providers participate in FMP.' },
        ]},
        { label_en: 'Education + employment', label_jp: '教育・雇用', items: [
          { title: 'VR&E (Chapter 31 Vocational Rehab)', body: 'Often BETTER than GI Bill for higher-rated vets — pays full tuition (no cap), monthly housing allowance, ALL books/supplies, employment services. 12+ year window from separation.',
            ref: { label: 'VR&E program', url: 'https://www.va.gov/careers-employment/vocational-rehabilitation/' } },
          { title: 'Post-9/11 GI Bill', body: '36 months. May be used in addition to or instead of VR&E. Foreign schools must be VA-approved.' },
          { title: 'Hire-Vets initiatives', body: 'Federal hiring preference, VA "Vets to Tech" program, USAJOBS veteran preference points.' },
        ]},
        { label_en: 'Savings + state benefits', label_jp: '節税・州給付', items: [
          { title: 'Property tax exemption', body: 'Many US states exempt 100% disabled vets from property tax (varies; FL/TX/CA generous, NJ/NY less so). Affects maintaining a US property while abroad.' },
          { title: 'Income tax exemption', body: 'Several states exempt military retirement + VA disability from state income tax. Verify your domicile state.' },
        ]},
      ],
    },

    separated_no_dis: {
      label_en: 'Separated, no VA disability', label_jp: '除隊 + VA 障害認定なし',
      groups: [
        { label_en: 'Education', label_jp: '教育', items: [
          { title: 'Post-9/11 GI Bill (Chapter 33)', body: '36 months of education benefit. Pre-2013 dischargees: 15-year delimitation date. Post-2013: Forever GI Bill (no expiry).' },
          { title: 'Yellow Ribbon Program', body: 'For schools where tuition exceeds the Post-9/11 cap — participating schools waive the difference, VA matches.' },
          { title: 'Transfer to dependents', body: 'Must transfer while still serving with 4+ years remaining service obligation. Once transferred, you cannot reclaim.' },
        ]},
        { label_en: 'Home', label_jp: '住宅', items: [
          { title: 'VA Home Loan', body: 'No PMI, no down payment, competitive rates. One-time use, restorable upon sale + payoff. US property only.',
            ref: { label: 'VA Home Loan', url: 'https://www.va.gov/housing-assistance/home-loans/' } },
          { title: 'Native American Direct Loan (NADL)', body: 'For Native American vets: direct VA loan for property on federal trust land.' },
        ]},
        { label_en: 'Career', label_jp: 'キャリア', items: [
          { title: 'USERRA', body: 'Re-employment rights with civilian employer after federal service obligations.' },
          { title: 'Veteran preference (federal hiring)', body: '5-point or 10-point preference on federal job applications. Affects USAJOBS scoring.' },
          { title: 'Transition Assistance Program (TAP)', body: 'Available for 365 days post-separation. Job placement, resume help, entrepreneurship resources.' },
        ]},
        { label_en: 'After-death benefits', label_jp: '埋葬・記念', items: [
          { title: 'Burial in National Cemetery', body: 'Free interment for any honorably-discharged veteran. Includes Yokohama (Yokohama War Cemetery is Commonwealth, but Honolulu Punchbowl is the closest US National Cemetery for Pacific-area vets).' },
          { title: 'Headstone, flag, military honors', body: 'Provided regardless of where buried. Folded flag presentation by uniformed honor guard.' },
          { title: 'Presidential Memorial Certificate', body: 'Engraved certificate signed by the sitting President. Apply via VA Form 40-0247.' },
        ]},
        { label_en: 'Reconsideration', label_jp: '再検討', items: [
          { title: 'File for VA disability claim', body: 'Even without obvious conditions: tinnitus, sleep apnea, joint issues, mental health are commonly underclaimed by separated vets. A VSO (Veterans Service Officer) helps file at no cost.',
            ref: { label: 'How to file a claim', url: 'https://www.va.gov/disability/how-to-file-claim/' } },
        ]},
      ],
    },
  };

  // ====================================================================
  // State accessors
  // ====================================================================

  function getVet()      { return TB.state.get('veteran') || {}; }
  function getService()  { return getVet().service || {}; }
  function getDisability() { return getVet().disability || {}; }
  function getHealthcare() { return getVet().healthcare || {}; }
  function getEducation()  { return getVet().education || {}; }
  function getSurvivor()   { return getVet().survivor || {}; }
  function setSection(section, value) {
    const v = getVet();
    v[section] = value;
    TB.state.set('veteran', v);
  }

  function lookupLabel(list, id, lang) {
    const it = list.find((x) => x.id === id);
    if (!it) return id || '—';
    return (it.emoji ? it.emoji + ' ' : '') + (lang === 'ja' ? it.label_jp : it.label_en);
  }

  // ====================================================================
  // Module render — single page with section cards
  // ====================================================================

  let host = null;

  // Read the user's veteran status from onboarding answers. This
  // determines which section cards render. Statuses:
  //   'active'             — show all sections, emphasize SGLI + active TRICARE
  //   'reserve_ng'         — show all sections (drilling reservists have SGLI)
  //   'retired'            — show all sections including TRICARE Retiree + pension
  //   'separated_with_dis' — hide TRICARE (not eligible), show disability + FMP
  //   'separated_no_dis'   — hide TRICARE + FMP + Disability sections; show GI Bill + survivor
  //   'yes' (legacy)       — show all (back-compat with v0.13 yes/no answer)
  function vetStatus() {
    return TB.state.get('onboarding.answers.veteran') || null;
  }

  function showsDisability() {
    const s = vetStatus();
    if (!s || s === 'no') return false;
    if (s === 'separated_no_dis') return false;
    return true;  // active, reserve_ng, retired, separated_with_dis, yes (legacy)
  }
  function showsHealthcare() {
    const s = vetStatus();
    if (!s || s === 'no') return false;
    // TRICARE eligibility requires retired or active duty (drilling
    // reservists too, but limited). Separated-no-disability folks
    // have neither TRICARE nor FMP.
    if (s === 'separated_no_dis') return false;
    return true;
  }
  function showsSurvivor() {
    const s = vetStatus();
    if (!s || s === 'no') return false;
    // SGLI/VGLI window logic: VGLI conversion permanently closes
    // 485 days after separation. If the user is past that AND has
    // no SGLI/VGLI amount on file, the section is just noise — hide
    // it. They can still re-show by manually editing the Survivor
    // section (we expose openSurvivorModal via the public API).
    const dischargeDate = (TB.state.get('veteran.service') || {}).discharge_date;
    if (dischargeDate) {
      const daysSince = Math.round((new Date() - new Date(dischargeDate + 'T00:00:00')) / 86400000);
      if (daysSince > 485) {
        const sb = TB.state.get('veteran.survivor') || {};
        const hasAmount = (sb.sgli_amount && sb.sgli_amount > 0) ||
                          (sb.vgli_amount && sb.vgli_amount > 0);
        if (!hasAmount) return false;
      }
    }
    return true;
  }
  function showsEducation() {
    const s = vetStatus();
    if (!s || s === 'no') return false;
    // GI Bill is potentially available to ALL veteran statuses,
    // but the user can mark it 'none' inside the section if they've
    // used it all up (which hides the expiry warning).
    return true;
  }

  const SECTIONS = [
    { id: 'header',   always: true, builder: () => buildHeaderCard() },
    { id: 'service',  always: true, builder: () => buildServiceCard() },
    {
      id: 'benefits_guide',
      label_en: 'Benefits guide (status-specific)',
      label_jp: '給付ガイド(ステータス別)',
      description_en: 'Tailored deep-dive based on your veteran status (active / reserve / retired / separated).',
      description_jp: 'あなたの退役軍人ステータス(現役・予備役・退役・除隊)に合わせた詳細ガイド。',
      auto_show: () => true,
      builder: () => buildBenefitsGuideCard(),
    },
    {
      id: 'disability',
      label_en: 'VA disability rating + compensation',
      label_jp: 'VA 障害認定と補償',
      description_en: 'Tracks rating %, monthly compensation, conditions list.',
      description_jp: '認定率、月次補償、症状リストを追跡。',
      auto_show: showsDisability,
      builder: () => buildDisabilityCard(),
    },
    {
      id: 'healthcare',
      label_en: 'TRICARE / FMP / VA healthcare',
      label_jp: 'TRICARE・FMP・VA 医療',
      description_en: 'Healthcare options for veterans abroad. TRICARE applies if retired.',
      description_jp: '海外退役軍人向け医療オプション。TRICARE は退役者のみ。',
      auto_show: showsHealthcare,
      builder: () => buildHealthcareCard(),
    },
    {
      id: 'education',
      label_en: 'GI Bill / Post-9/11 education benefits',
      label_jp: 'GI Bill・Post-9/11 教育給付',
      description_en: 'Track months remaining + 15-year expiration (pre-2013 dischargees).',
      description_jp: '残月数と 15 年期限(2013 年以前除隊者)を追跡。',
      auto_show: showsEducation,
      builder: () => buildEducationCard(),
    },
    {
      id: 'survivor',
      label_en: 'SGLI / VGLI / SBP / DIC',
      label_jp: 'SGLI・VGLI・SBP・DIC',
      description_en: 'Survivor benefits. SGLI lapses 120d after separation; VGLI conversion window 240/485d.',
      description_jp: '遺族給付。SGLI は除隊後 120 日で失効、VGLI 切替期間は 240/485 日。',
      auto_show: showsSurvivor,
      builder: () => buildSurvivorCard(),
    },
    { id: 'japan_resources', always: true, builder: () => buildJapanResourcesCard() },
  ];

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

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'veteran' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'veteran' },
          t('veteran.badge')),
      ),
      el('h1', null, '🪖 ' + t('veteran.title')),
      el('p', { class: 'tb-card-meta' }, t('veteran.subtitle')),
    );
  }

  // ──────────────── Service info card ────────────────────────────────

  function buildServiceCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const s = getService();

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('veteran.section.service')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openServiceModal(),
      }, '✎ ' + t('veteran.edit')),
    ));

    if (!s.branch) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('veteran.service.empty')));
      return card;
    }

    const dl = el('dl', { class: 'tb-dl' });
    function row(label, val) {
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', null, val || '—'));
    }
    row(t('veteran.field.branch'),         lookupLabel(BRANCHES, s.branch, lang));
    row(t('veteran.field.component'),      lookupLabel(COMPONENTS, s.component, lang));
    row(t('veteran.field.entry_date'),     s.entry_date);
    row(t('veteran.field.discharge_date'), s.discharge_date);
    row(t('veteran.field.discharge_type'), lookupLabel(DISCHARGE_TYPES, s.discharge_type, lang));
    row(t('veteran.field.final_rank'),     s.final_rank);
    row(t('veteran.field.mos_rating'),     s.mos_rating);
    if (s.retired) {
      dl.appendChild(el('dt', null, t('veteran.field.status')));
      dl.appendChild(el('dd', null,
        el('span', { class: 'tb-badge', style: { background: 'var(--tb-success)', color: '#fff' } },
          t('veteran.status.retired'))));
    }
    card.appendChild(dl);

    // DD-214 status — pulls from Document Vault if available.
    const dd214 = (TB.docVault && TB.docVault.getItems)
      ? TB.docVault.getItems().find((it) => it.type === 'dd214') : null;
    const dd214Note = el('div', {
      style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderRadius: 'var(--tb-radius-1)',
        background: dd214 ? 'rgba(47, 111, 78, 0.08)' : 'rgba(185, 122, 26, 0.08)',
        borderLeft: '3px solid ' + (dd214 ? 'var(--tb-success)' : 'var(--tb-warn)'),
        fontSize: 'var(--tb-fs-12)' },
    },
      dd214
        ? el('span', null, '✓ ' + t('veteran.dd214.tracked', { location: dd214.storage_location || '—' }))
        : el('span', null,
            '⚠ ' + t('veteran.dd214.missing') + ' ',
            el('a', {
              href: '#', style: { color: 'var(--tb-warn)', fontWeight: '600' },
              onclick: (e) => {
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'document-vault' } }));
              },
            }, t('veteran.dd214.openVault') + ' →'),
          ),
    );
    card.appendChild(dd214Note);
    return card;
  }

  function openServiceModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getService());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('veteran.modal.service')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }
    function selectField(label, list, val, onSet) {
      const sel = el('select', { class: 'tb-select', onchange: (e) => onSet(e.target.value || null) },
        el('option', { value: '', selected: !val }, '—'),
        ...list.map((it) => el('option', {
          value: it.id, selected: val === it.id,
        }, lang === 'ja' ? it.label_jp : it.label_en)),
      );
      return field(label, sel);
    }

    modal.appendChild(selectField(t('veteran.field.branch'),         BRANCHES, draft.branch,
      (v) => { draft.branch = v; }));
    modal.appendChild(selectField(t('veteran.field.component'),      COMPONENTS, draft.component,
      (v) => { draft.component = v; }));
    modal.appendChild(selectField(t('veteran.field.discharge_type'), DISCHARGE_TYPES, draft.discharge_type,
      (v) => { draft.discharge_type = v; }));

    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } });
    grid.appendChild(field(t('veteran.field.entry_date'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.entry_date || '',
        oninput: (e) => { draft.entry_date = e.target.value || null; } })));
    grid.appendChild(field(t('veteran.field.discharge_date'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.discharge_date || '',
        oninput: (e) => { draft.discharge_date = e.target.value || null; } })));
    modal.appendChild(grid);

    modal.appendChild(field(t('veteran.field.final_rank'),
      el('input', { type: 'text', class: 'tb-input',
        value: draft.final_rank || '',
        placeholder: 'E-7, O-3, W-2, etc.',
        oninput: (e) => { draft.final_rank = e.target.value; } })));
    modal.appendChild(field(t('veteran.field.mos_rating'),
      el('input', { type: 'text', class: 'tb-input',
        value: draft.mos_rating || '',
        placeholder: '11B, 25S, AW, etc.',
        oninput: (e) => { draft.mos_rating = e.target.value; } })));

    const retiredCheck = el('input', { type: 'checkbox', checked: !!draft.retired, style: { marginRight: '8px' },
      onchange: (e) => { draft.retired = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        retiredCheck, t('veteran.field.retired')),
      el('div', { class: 'tb-field-help' }, t('veteran.field.retired.help')),
    ));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('veteran.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('service', draft); close(); rerender(); },
    }, t('veteran.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ──────────────── Disability card ───────────────────────────────────

  function buildDisabilityCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const d = getDisability();

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('veteran.section.disability')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openDisabilityModal(),
      }, '✎ ' + t('veteran.edit')),
    ));

    if (!d.overall_rating_pct && (!d.conditions || d.conditions.length === 0)) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('veteran.disability.empty')));
      return card;
    }

    // Top stats row
    const ratingDisplay = (d.overall_rating_pct || 0) + '%' +
      (d.individual_unemployability ? ' ' + t('veteran.iu.suffix') : '');
    const compDisplay = d.monthly_compensation_usd
      ? TB.utils.formatUSD(d.monthly_compensation_usd, { maximumFractionDigits: 0 }) + '/mo'
      : '—';
    card.appendChild(el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
    },
      stat(t('veteran.disability.rating'),       ratingDisplay,  d.individual_unemployability ? 'var(--tb-success)' : null),
      stat(t('veteran.disability.compensation'), compDisplay),
      stat(t('veteran.disability.last_eval'),    d.last_evaluation_date || '—'),
    ));

    // Conditions list
    if (d.conditions && d.conditions.length > 0) {
      card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)' } }, t('veteran.disability.conditions')));
      const list = el('div');
      for (const c of d.conditions) {
        list.appendChild(el('div', {
          style: { display: 'flex', justifyContent: 'space-between', padding: '4px 8px',
            borderBottom: '1px dashed var(--tb-border)', alignItems: 'baseline' },
        },
          el('div', null,
            el('span', null, c.name || '(unnamed)'),
            c.service_connected ? el('span', {
              class: 'tb-badge', style: { marginLeft: '8px', fontSize: 'var(--tb-fs-12)', background: 'var(--tb-success)', color: '#fff', borderColor: 'transparent' } },
              'SC') : null,
          ),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
            (c.rating_pct || 0) + '%'),
        ));
      }
      card.appendChild(list);
    }

    // Reference link to VA Manila RO
    card.appendChild(el('div', {
      style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
    },
      t('veteran.disability.reference') + ' ',
      el('a', { href: 'https://www.va.gov/manila-regional-benefit-office/', target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'var(--tb-navy)' } }, 'va.gov/manila-regional-benefit-office'),
    ));

    return card;
  }

  function openDisabilityModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({ conditions: [] }, getDisability());
    if (!Array.isArray(draft.conditions)) draft.conditions = [];

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('veteran.modal.disability')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } });
    grid.appendChild(field(t('veteran.disability.rating'),
      el('input', { type: 'number', class: 'tb-input', min: '0', max: '100', step: '10',
        value: draft.overall_rating_pct || 0,
        oninput: (e) => { draft.overall_rating_pct = parseInt(e.target.value, 10) || 0; } }),
      t('veteran.disability.rating.help')));
    grid.appendChild(field(t('veteran.disability.compensation'),
      el('input', { type: 'number', class: 'tb-input', min: '0', step: '1',
        value: draft.monthly_compensation_usd || 0,
        oninput: (e) => { draft.monthly_compensation_usd = parseFloat(e.target.value) || 0; } }),
      t('veteran.disability.compensation.help')));
    modal.appendChild(grid);

    const iuCheck = el('input', { type: 'checkbox', checked: !!draft.individual_unemployability,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.individual_unemployability = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        iuCheck, t('veteran.disability.iu')),
      el('div', { class: 'tb-field-help' }, t('veteran.disability.iu.help')),
    ));

    modal.appendChild(field(t('veteran.disability.last_eval'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.last_evaluation_date || '',
        oninput: (e) => { draft.last_evaluation_date = e.target.value || null; } }),
      t('veteran.disability.last_eval.help')));

    // Conditions list editor
    modal.appendChild(el('h3', null, t('veteran.disability.conditions')));
    const condList = el('div');
    function rebuildConds() {
      condList.innerHTML = '';
      draft.conditions.forEach((c, i) => {
        condList.appendChild(el('div', {
          style: { display: 'grid', gridTemplateColumns: '1fr 80px auto auto', gap: '6px',
            padding: '4px 0', alignItems: 'center' },
        },
          el('input', { type: 'text', class: 'tb-input',
            value: c.name || '', placeholder: t('veteran.condition.name.placeholder'),
            oninput: (e) => { c.name = e.target.value; } }),
          el('input', { type: 'number', class: 'tb-input', min: '0', max: '100', step: '10',
            value: c.rating_pct || 0,
            oninput: (e) => { c.rating_pct = parseInt(e.target.value, 10) || 0; } }),
          el('label', { style: { fontSize: 'var(--tb-fs-12)', display: 'flex', alignItems: 'center', gap: '4px' } },
            el('input', { type: 'checkbox', checked: !!c.service_connected,
              onchange: (e) => { c.service_connected = !!e.target.checked; } }),
            'SC'),
          el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', color: 'var(--tb-error)' },
            onclick: () => { draft.conditions.splice(i, 1); rebuildConds(); },
          }, '🗑'),
        ));
      });
    }
    rebuildConds();
    modal.appendChild(condList);
    modal.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button',
      style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        draft.conditions.push({ id: TB.utils.uuid(), name: '', rating_pct: 0, service_connected: true });
        rebuildConds();
      },
    }, '+ ' + t('veteran.condition.add')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('veteran.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('disability', draft); close(); rerender(); },
    }, t('veteran.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ──────────────── Healthcare card ───────────────────────────────────

  function buildHealthcareCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const h = getHealthcare();

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('veteran.section.healthcare')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openHealthcareModal(),
      }, '✎ ' + t('veteran.edit')),
    ));

    if (!h.tricare_eligible && !h.fmp_enrolled) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('veteran.healthcare.empty')));
    } else {
      const dl = el('dl', { class: 'tb-dl' });
      function row(label, val) {
        dl.appendChild(el('dt', null, label));
        dl.appendChild(el('dd', null, val || '—'));
      }
      row(t('veteran.healthcare.tricare_eligible'),
        h.tricare_eligible ? '✓ ' + t('veteran.yes') : '✕ ' + t('veteran.no'));
      if (h.tricare_eligible) {
        row(t('veteran.healthcare.tricare_plan'), lookupLabel(TRICARE_PLANS, h.tricare_plan, lang));
      }
      row('Foreign Medical Program (FMP)',
        h.fmp_enrolled ? '✓ ' + t('veteran.yes') : '✕ ' + t('veteran.no'));
      card.appendChild(dl);
    }

    // Japan-specific healthcare guidance
    card.appendChild(el('div', {
      class: 'tb-disclaimer-inline',
      style: { marginTop: 'var(--tb-sp-3)' },
    }, '🇯🇵 ' + t('veteran.healthcare.jp_note')));

    return card;
  }

  function openHealthcareModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getHealthcare());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('veteran.modal.healthcare')));

    const tricareCheck = el('input', { type: 'checkbox', checked: !!draft.tricare_eligible,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.tricare_eligible = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        tricareCheck, t('veteran.healthcare.tricare_eligible')),
      el('div', { class: 'tb-field-help' }, t('veteran.healthcare.tricare_eligible.help')),
    ));

    const planSelect = el('select', { class: 'tb-select',
      onchange: (e) => { draft.tricare_plan = e.target.value || null; } },
      el('option', { value: '', selected: !draft.tricare_plan }, '—'),
      ...TRICARE_PLANS.map((p) => el('option', {
        value: p.id, selected: draft.tricare_plan === p.id,
      }, lang === 'ja' ? p.label_jp : p.label_en)),
    );
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('veteran.healthcare.tricare_plan')),
      planSelect,
    ));

    const fmpCheck = el('input', { type: 'checkbox', checked: !!draft.fmp_enrolled,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.fmp_enrolled = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        fmpCheck, t('veteran.healthcare.fmp')),
      el('div', { class: 'tb-field-help' }, t('veteran.healthcare.fmp.help')),
    ));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('veteran.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('healthcare', draft); close(); rerender(); },
    }, t('veteran.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ──────────────── Education benefits card ──────────────────────────

  function buildEducationCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const e = getEducation();

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('veteran.section.education')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openEducationModal(),
      }, '✎ ' + t('veteran.edit')),
    ));

    if (!e.benefit_type) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('veteran.education.empty')));
      return card;
    }

    const dl = el('dl', { class: 'tb-dl' });
    function row(label, val) {
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', null, val || '—'));
    }
    row(t('veteran.education.benefit_type'), lookupLabel(EDUCATION_BENEFITS, e.benefit_type, lang));
    if (e.months_remaining != null) {
      row(t('veteran.education.months_remaining'), e.months_remaining + ' / 36');
    }
    if (e.expiration_date) {
      const days = Math.round((new Date(e.expiration_date + 'T00:00:00') - new Date()) / 86400000);
      const color = days < 365 ? 'var(--tb-error)' : days < 365 * 3 ? 'var(--tb-warn)' : 'var(--tb-text)';
      row(t('veteran.education.expiration'),
        el('span', { style: { color } }, e.expiration_date + (days > 0 ? ' (' + Math.floor(days / 365) + 'y ' + (days % 365) + 'd)' : ' (expired)')));
    }
    if (e.transferred) {
      dl.appendChild(el('dt', null, t('veteran.education.transferred')));
      dl.appendChild(el('dd', null,
        el('span', { class: 'tb-badge', style: { background: 'var(--tb-success)', color: '#fff' } },
          t('veteran.yes'))));
    }
    card.appendChild(dl);
    return card;
  }

  function openEducationModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getEducation());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('veteran.modal.education')));

    const sel = el('select', { class: 'tb-select',
      onchange: (e) => { draft.benefit_type = e.target.value || null; } },
      el('option', { value: '', selected: !draft.benefit_type }, '—'),
      ...EDUCATION_BENEFITS.map((b) => el('option', {
        value: b.id, selected: draft.benefit_type === b.id,
      }, lang === 'ja' ? b.label_jp : b.label_en)),
    );
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('veteran.education.benefit_type')), sel));

    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('veteran.education.months_remaining')),
      el('input', { type: 'number', class: 'tb-input', min: '0', max: '36',
        value: draft.months_remaining != null ? draft.months_remaining : '',
        placeholder: '0–36',
        oninput: (e) => {
          const v = parseInt(e.target.value, 10);
          draft.months_remaining = isFinite(v) ? v : null;
        } }),
    ));

    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('veteran.education.expiration')),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.expiration_date || '',
        oninput: (e) => { draft.expiration_date = e.target.value || null; } }),
      el('div', { class: 'tb-field-help' }, t('veteran.education.expiration.help')),
    ));

    const transferCheck = el('input', { type: 'checkbox', checked: !!draft.transferred,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.transferred = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        transferCheck, t('veteran.education.transferred')),
      el('div', { class: 'tb-field-help' }, t('veteran.education.transferred.help')),
    ));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('veteran.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('education', draft); close(); rerender(); },
    }, t('veteran.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ──────────────── Survivor benefits card ───────────────────────────

  function buildSurvivorCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const s = getSurvivor();

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('veteran.section.survivor')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openSurvivorModal(),
      }, '✎ ' + t('veteran.edit')),
    ));

    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
    });
    grid.appendChild(stat('SGLI',
      s.sgli_amount ? TB.utils.formatUSD(s.sgli_amount, { maximumFractionDigits: 0 }) : '—'));
    grid.appendChild(stat('VGLI',
      s.vgli_amount ? TB.utils.formatUSD(s.vgli_amount, { maximumFractionDigits: 0 }) : '—'));
    card.appendChild(grid);
    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
      t('veteran.survivor.note')));
    return card;
  }

  function openSurvivorModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getSurvivor());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('veteran.modal.survivor')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field('SGLI ' + t('veteran.amount_usd'),
      el('input', { type: 'number', class: 'tb-input', min: '0', step: '10000',
        value: draft.sgli_amount != null ? draft.sgli_amount : '',
        placeholder: '400000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.sgli_amount = isFinite(v) ? v : null;
        } }),
      t('veteran.survivor.sgli.help')));
    modal.appendChild(field('VGLI ' + t('veteran.amount_usd'),
      el('input', { type: 'number', class: 'tb-input', min: '0', step: '10000',
        value: draft.vgli_amount != null ? draft.vgli_amount : '',
        placeholder: '400000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.vgli_amount = isFinite(v) ? v : null;
        } }),
      t('veteran.survivor.vgli.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('veteran.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('survivor', draft); close(); rerender(); },
    }, t('veteran.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ──────────────── Status-specific Benefits guide card ─────────────

  function buildBenefitsGuideCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const status = vetStatus();
    // Map legacy 'yes' to retired-as-default-richest scenario.
    const lookupKey = (status === 'yes') ? 'retired' : status;
    const guide = BENEFITS_BY_STATUS[lookupKey];

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🎖 ' + t('veteran.section.benefits')));

    if (!guide) {
      card.appendChild(el('p', { class: 'tb-card-meta' }, t('veteran.benefits.no_status')));
      return card;
    }

    card.appendChild(el('p', { class: 'tb-card-meta' },
      t('veteran.benefits.intro', { status: lang === 'ja' ? guide.label_jp : guide.label_en })));

    for (const group of guide.groups) {
      card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)', color: 'var(--tb-track-veteran)' } },
        lang === 'ja' ? group.label_jp : group.label_en));
      const list = el('div');
      for (const item of group.items) {
        const itemEl = el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            borderLeft: '3px solid var(--tb-track-veteran)',
            background: 'var(--tb-bg)',
            borderRadius: 'var(--tb-radius-1)',
            marginBottom: 'var(--tb-sp-2)',
          },
        },
          el('div', { style: { fontWeight: '600' } }, item.title),
          el('p', { style: { margin: '4px 0 0', fontSize: 'var(--tb-fs-14)', lineHeight: '1.5' } }, item.body),
          item.jp_en ? el('div', {
            style: { marginTop: '4px', padding: '4px 8px', fontSize: 'var(--tb-fs-12)',
              background: 'rgba(178, 58, 58, 0.06)', borderRadius: 'var(--tb-radius-1)',
              borderLeft: '2px solid var(--tb-error)' },
          }, '🇯🇵 ' + item.jp_en) : null,
          item.ref ? el('div', { style: { marginTop: '4px', fontSize: 'var(--tb-fs-12)' } },
            el('a', { href: item.ref.url, target: '_blank', rel: 'noopener noreferrer',
              style: { color: 'var(--tb-navy)' } }, item.ref.label + ' →')) : null,
        );
        list.appendChild(itemEl);
      }
      card.appendChild(list);
    }

    return card;
  }

  // ──────────────── Japan-specific resources card ────────────────────

  // Each Japan resource has a `showFor` predicate so we don't show
  // TRICARE / FMP / SOFA-VA-interaction content to vets who never
  // qualified for those programs (e.g., separated without disability).
  function buildJapanResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const status = vetStatus();
    const eligibleFmp     = status === 'separated_with_dis' || status === 'retired' || status === 'yes';
    const eligibleTricare = showsHealthcare();
    const eligibleSofaVA  = eligibleFmp || eligibleTricare;

    const card = el('div', { class: 'tb-card', 'data-track': 'veteran' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🇯🇵 ' + t('veteran.section.jp_resources')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('veteran.jp_resources.intro')));

    function resource(title, desc, url) {
      return el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-track-veteran)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-2)' },
      },
        el('div', { style: { fontWeight: '600' } }, title),
        el('div', { class: 'tb-field-help', style: { margin: '4px 0' } }, desc),
        url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' } }, url + ' →') : null,
      );
    }

    // VA Manila — relevant to anyone who might file a VA claim (incl.
    // a future late claim for a separated_no_dis vet reconsidering).
    card.appendChild(resource(
      t('veteran.jp_resources.manila.title'),
      t('veteran.jp_resources.manila.body'),
      'https://www.va.gov/manila-regional-benefit-office/',
    ));

    // FMP — only for vets with VA-rated SC conditions.
    if (eligibleFmp) {
      card.appendChild(resource(
        t('veteran.jp_resources.fmp.title'),
        t('veteran.jp_resources.fmp.body'),
        'https://www.va.gov/COMMUNITYCARE/programs/veterans/FMP/index.asp',
      ));
    }

    // TRICARE Overseas — only for TRICARE-eligible (active / reserve / retired).
    if (eligibleTricare) {
      card.appendChild(resource(
        t('veteran.jp_resources.tricare_overseas.title'),
        t('veteran.jp_resources.tricare_overseas.body'),
        'https://tricare.mil/Plans/HealthPlans/TOP',
      ));
    }

    // VA.gov account — useful for ALL veteran statuses (GI Bill,
    // VA loan, burial, late claim filing, etc.).
    card.appendChild(resource(
      t('veteran.jp_resources.ebenefits.title'),
      t('veteran.jp_resources.ebenefits.body'),
      'https://www.va.gov/',
    ));

    // SOFA + VA interaction — only relevant if the user has TRICARE
    // or FMP eligibility (otherwise the references make no sense).
    if (eligibleSofaVA) {
      card.appendChild(resource(
        t('veteran.jp_resources.sofa.title'),
        t('veteran.jp_resources.sofa.body'),
        null,
      ));
    }

    return card;
  }

  // ──────────────── Helpers ──────────────────────────────────────────

  function stat(label, value, color) {
    return TB.utils.el('div', {
      style: { background: 'var(--tb-bg)', padding: 'var(--tb-sp-3)', borderRadius: 'var(--tb-radius-2)',
        border: '1px solid var(--tb-border)' },
    },
      TB.utils.el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', marginBottom: '2px' } }, label),
      TB.utils.el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)',
        color: color || 'var(--tb-text)' } }, value),
    );
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function daysUntil(iso) {
    if (!iso) return Infinity;
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return Infinity;
    const t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }

  function genDD214Missing() {
    const out = [];
    const t = TB.i18n.t;
    const status = vetStatus();
    if (!status || status === 'no' || status === 'active') return out; // not separated yet
    const s = getService();
    if (s.discharge_type === 'dishonorable') return out;
    const inVault = (TB.docVault && TB.docVault.getItems)
      ? TB.docVault.getItems().some((it) => it.type === 'dd214') : false;
    if (inVault) return out;
    out.push({
      id: 'veteran_dd214_missing',
      group: 'veteran', urgency: 'medium', icon: '📋',
      title: t('vet.genDD214Missing.title'),
      body: t('vet.genDD214Missing.body'),
      module: 'document-vault', snoozable: true,
    });
    return out;
  }

  function genGiBillExpiring() {
    const out = [];
    const t = TB.i18n.t;
    const e = getEducation();
    // Skip if no benefit, "none" benefit, or no months left.
    if (!e.benefit_type || e.benefit_type === 'none') return out;
    if (e.months_remaining === 0) return out;
    if (!e.expiration_date) return out;
    const days = daysUntil(e.expiration_date);
    if (days < 0) return out;
    if (days > 365 * 2) return out;
    const urgency = days <= 180 ? 'high' : 'medium';
    out.push({
      id: 'veteran_gibill_expiring',
      group: 'veteran', urgency, icon: '🎓',
      title: t('vet.genGiBillExpiring.title', { date: e.expiration_date, months: Math.floor(days / 30) }),
      body: t('vet.genGiBillExpiring.body', { monthsRemaining: e.months_remaining || '?' }),
      deadline: e.expiration_date, module: 'veteran', snoozable: true,
    });
    return out;
  }

  function genVgliConversion() {
    const out = [];
    const t = TB.i18n.t;
    const status = vetStatus();
    // VGLI only relevant for separated/retired folks. Active duty
    // and drilling reservists have SGLI, not VGLI.
    if (status === 'no' || status === 'active' || status === 'reserve_ng') return out;
    const s = getService();
    const sb = getSurvivor();
    if (!s.discharge_date) return out;
    if (sb.vgli_amount && sb.vgli_amount > 0) return out; // already converted
    const days = daysUntil(s.discharge_date);
    // VGLI conversion window: 1 year + 120 days from separation. The
    // hard "no medical underwriting" window is 240 days. We surface
    // both phases.
    const daysSinceSep = -days;
    if (daysSinceSep < 0) return out; // not yet separated
    if (daysSinceSep <= 240) {
      out.push({
        id: 'veteran_vgli_easy_window',
        group: 'veteran', urgency: 'critical', icon: '🛡️',
        title: t('vet.genVgliConversion.easy.title', { days: 240 - daysSinceSep }),
        body: t('vet.genVgliConversion.easy.body'),
        module: 'veteran', snoozable: false,
      });
    } else if (daysSinceSep <= 485) {
      out.push({
        id: 'veteran_vgli_late_window',
        group: 'veteran', urgency: 'high', icon: '🛡️',
        title: t('vet.genVgliConversion.late.title', { days: 485 - daysSinceSep }),
        body: t('vet.genVgliConversion.late.body'),
        module: 'veteran', snoozable: false,
      });
    }
    return out;
  }

  function genAnnualReevalDue() {
    const out = [];
    const t = TB.i18n.t;
    if (!showsDisability()) return out;  // skip for separated_no_dis etc.
    const d = getDisability();
    if (!d.last_evaluation_date || !d.overall_rating_pct) return out;
    const days = daysUntil(d.last_evaluation_date);
    const yearsAgo = -days / 365;
    if (yearsAgo > 5 && d.overall_rating_pct < 100 && !d.individual_unemployability) {
      out.push({
        id: 'veteran_reeval_due',
        group: 'veteran', urgency: 'low', icon: '📋',
        title: t('vet.genAnnualReevalDue.title', { years: Math.floor(yearsAgo) }),
        body: t('vet.genAnnualReevalDue.body'),
        module: 'veteran', snoozable: true,
      });
    }
    return out;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = { id, label_en: 'Veteran', label_jp: '退役軍人', render, searchSections: SECTIONS };

  window.TB.veteran = {
    actionGenerators: [genDD214Missing, genGiBillExpiring, genVgliConversion, genAnnualReevalDue],
    BRANCHES, COMPONENTS, DISCHARGE_TYPES, TRICARE_PLANS, EDUCATION_BENEFITS,
  };
})();
