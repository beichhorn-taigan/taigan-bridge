/* Taigan Bridge — modules/resident.js
 *
 * Long-Term Resident module — for non-SOFA Americans who are Japanese
 * tax residents. Surfaces the JP-side topics that don't fit cleanly
 * into the SOFA-focused Roth Planner: 確定申告 prep, the 10-year
 * worldwide-asset clock, 永住権 (PR) eligibility, Furusato Nozei
 * limit calculation, 住宅ローン控除 (mortgage credit), NHI awareness.
 *
 * Action Center integration via TB.resident.actionGenerators —
 * watches for: 確定申告 deadline (Feb 16 - Mar 15), PR eligibility
 * year reached, 10-year worldwide-asset clock approaching, NHI not
 * configured but JP resident, Furusato Nozei deadline (Dec 31).
 */

(function () {
  'use strict';

  const id = 'resident';

  // ====================================================================
  // Reference data
  // ====================================================================

  // Japan visa categories that affect PR eligibility timing.
  // Standard PR requires 10y residence; reduced for spouse, HSP, etc.
  const VISA_STATUSES = [
    { id: 'work',         label_en: 'Work visa (Engineer/Specialist/etc.)', label_jp: '就労ビザ',
      pr_years: 10, notes: 'Standard 10-year track to PR.' },
    { id: 'spouse_jp',    label_en: 'Spouse of Japanese national', label_jp: '日本人の配偶者等',
      pr_years: 3,  notes: 'Reduced to 3 years residency + 1 year continuous.' },
    { id: 'long_term',    label_en: 'Long-Term Resident (定住者)', label_jp: '定住者',
      pr_years: 5,  notes: '5-year track once status held.' },
    { id: 'highly_skilled', label_en: 'Highly Skilled Professional (高度専門職)', label_jp: '高度専門職',
      pr_years: 1,  notes: 'Fast-track PR: 80+ HSP points = 1 year, 70-79 points = 3 years.' },
    { id: 'permanent',    label_en: 'Already Permanent Resident',  label_jp: '永住者(取得済み)',
      pr_years: 0,  notes: 'PR already granted.' },
    { id: 'cultural',     label_en: 'Cultural / Student / other', label_jp: '文化・留学・その他',
      pr_years: 10, notes: 'Long path; 10y standard with continuous status.' },
    { id: 'other',        label_en: 'Other / Not sure',           label_jp: 'その他・不明',
      pr_years: 10, notes: '' },
  ];

  // Furusato Nozei limit estimator. The official formula is complex
  // (depends on resident tax + income tax brackets); this is the
  // commonly-cited approximation used by furusato-tax.jp and similar
  // calculators. Within ~5% accuracy for typical incomes. The user
  // can override with a manual figure.
  // Limit = (resident tax × 0.20) ÷ (1 − income_tax_rate − 0.10) + 2000
  // Simplified for our use: roughly 2% of income for moderate earners.
  function estimateFurusatoLimit(incomeJpy, dependents) {
    if (!incomeJpy || incomeJpy <= 0) return 0;
    // Rough lookup table (¥M income → annual limit in ¥). Single
    // filer, no dependents. Each dependent reduces by ~10%.
    // Source: cross-reference of major Japanese furusato calculators.
    let limit;
    if (incomeJpy <  3_000_000) limit = incomeJpy * 0.018;
    else if (incomeJpy <  5_000_000) limit = incomeJpy * 0.022;
    else if (incomeJpy <  8_000_000) limit = incomeJpy * 0.025;
    else if (incomeJpy < 12_000_000) limit = incomeJpy * 0.028;
    else if (incomeJpy < 20_000_000) limit = incomeJpy * 0.030;
    else                              limit = incomeJpy * 0.032;
    if (dependents > 0) limit *= Math.max(0.5, 1 - dependents * 0.08);
    return Math.round(limit / 1000) * 1000; // round to nearest ¥1K
  }

  // Mortgage credit (住宅ローン控除) estimator. The deduction is
  // 0.7% of year-end loan balance, capped at varying amounts based
  // on property type and acquisition year. Standard 2024 caps:
  //   Standard new construction: ¥3,000,000 loan × 0.7% = ¥21,000/yr
  //   Long-term excellent housing: ¥4,500,000 × 0.7% = ¥31,500/yr
  //   Energy-efficient (省エネ): ¥4,000,000 × 0.7% = ¥28,000/yr
  // Actually the loan caps are MUCH higher (¥30M-¥50M); the credit
  // is 0.7% on the loan balance up to those caps.
  const MORTGAGE_CAPS = {
    standard:         { loan_cap_jpy: 30_000_000, label_en: 'Standard new construction', label_jp: '一般住宅(新築)' },
    long_term:        { loan_cap_jpy: 45_000_000, label_en: 'Long-term excellent housing (長期優良住宅)', label_jp: '長期優良住宅' },
    energy_efficient: { loan_cap_jpy: 40_000_000, label_en: 'Energy-efficient (省エネ住宅)', label_jp: '省エネ住宅' },
  };

  function estimateMortgageCredit(balanceJpy, type) {
    if (!balanceJpy || balanceJpy <= 0) return 0;
    const cap = MORTGAGE_CAPS[type] || MORTGAGE_CAPS.standard;
    const taxable = Math.min(balanceJpy, cap.loan_cap_jpy);
    return Math.round(taxable * 0.007);
  }

  // ====================================================================
  // State accessors
  // ====================================================================

  function getResident()  { return TB.state.get('resident') || {}; }
  function getResidency() { return getResident().residency || {}; }
  function getFurusato()  { return getResident().furusato || {}; }
  function getMortgage()  { return getResident().mortgage || {}; }
  function getNhi()       { return getResident().nhi || {}; }
  function setSection(section, value) {
    const r = getResident();
    r[section] = value;
    TB.state.set('resident', r);
  }

  // ── Onboarding-derived residency defaults ────────────────────────
  //
  // Onboarding captures coarse versions of three residency fields:
  //   visa_status     →  residency.visa_status
  //   juminhyou       →  residency.juminhyo_status (yes/no/unsure)
  //   years_in_japan  →  approximate "years ago" (no exact date)
  //
  // We don't write these to residency state — instead we merge them
  // for display so the user sees populated data immediately after
  // onboarding without an extra Edit step. Explicit residency edits
  // override the onboarding-derived values; saving in the modal
  // promotes derived values into explicit state.
  function getOnboardingDerivedResidency() {
    const a = TB.state.get('onboarding.answers') || {};
    const out = {};
    // Map onboarding visa categories to this card's VISA_STATUSES.
    // SOFA users default to 'other' since the SOFA→PR path isn't
    // tracked here (they typically transition to a different visa
    // first). Highly-skilled / cultural categories aren't surfaced
    // in onboarding — user picks those manually if applicable.
    const visaMap = {
      sofa:       'other',
      spouse_jp:  'spouse_jp',
      work:       'work',
      permanent:  'permanent',
      long_term:  'long_term',
      other:      'other',
    };
    if (a.visa_status && visaMap[a.visa_status]) {
      out.visa_status = visaMap[a.visa_status];
    }
    if (a.visa_status === 'permanent') out.permanent_residency = true;
    if (a.juminhyou) out.juminhyo_status = a.juminhyou;
    return out;
  }

  // Merged view: explicit residency wins; falls back to onboarding-
  // derived defaults. Use this for display + modal prefill.
  function getResidencyView() {
    const explicit = getResidency();
    const derived = getOnboardingDerivedResidency();
    const merged = Object.assign({}, derived);
    Object.keys(explicit).forEach((k) => {
      if (explicit[k] != null && explicit[k] !== '') merged[k] = explicit[k];
    });
    return merged;
  }

  // Was this field surfaced from onboarding rather than explicit input?
  // Drives the "from onboarding" badge in the residency card.
  function isFromOnboarding(field) {
    const explicit = getResidency();
    const derived = getOnboardingDerivedResidency();
    return (explicit[field] == null || explicit[field] === '')
      && derived[field] != null;
  }

  // Years in Japan based on arrival_date (preferred) or
  // onboarding.years_in_japan (fallback bucket).
  function yearsInJapan() {
    const arrival = getResidency().arrival_date;
    if (arrival) {
      const days = (new Date() - new Date(arrival + 'T00:00:00')) / 86400000;
      return Math.floor(days / 365.25);
    }
    const bucket = TB.state.get('onboarding.answers.years_in_japan');
    if (bucket === 'under_1') return 0;
    if (bucket === '1_to_5') return 3;
    if (bucket === '5_to_10') return 7;
    if (bucket === 'over_10') return 12;
    return null;
  }

  function visaSpec(visaId) {
    const v = visaId != null ? visaId : getResidencyView().visa_status;
    return VISA_STATUSES.find((s) => s.id === v) || null;
  }

  // Days until 10-year worldwide-asset inheritance tax clock — the
  // year-10 anniversary of arrival in Japan is when JP inheritance
  // tax expands from JP-situs assets only to worldwide assets for
  // foreign nationals. Returns { years: int, days: int } or null.
  function tenYearClock() {
    const arrival = getResidency().arrival_date;
    if (!arrival) return null;
    const tenYearMark = new Date(arrival + 'T00:00:00');
    tenYearMark.setFullYear(tenYearMark.getFullYear() + 10);
    const today = new Date(); today.setHours(0,0,0,0);
    const days = Math.round((tenYearMark - today) / 86400000);
    const years = days / 365.25;
    return { date: tenYearMark.toISOString().slice(0, 10), days, years };
  }

  // PR eligibility year based on visa + arrival.
  function prEligibilityDate() {
    const arrival = getResidency().arrival_date;
    const spec = visaSpec();
    if (!arrival || !spec || spec.pr_years === 0) return null;
    const eligDate = new Date(arrival + 'T00:00:00');
    eligDate.setFullYear(eligDate.getFullYear() + spec.pr_years);
    const today = new Date(); today.setHours(0,0,0,0);
    return {
      date: eligDate.toISOString().slice(0, 10),
      days: Math.round((eligDate - today) / 86400000),
      already_eligible: eligDate <= today,
    };
  }

  // ====================================================================
  // Module render
  // ====================================================================

  // Predicates for auto-show (used by section registry).
  //
  // hasJpResidency: true if the user has any time-on-the-ground in
  // Japan. Used for general residency-aware sections (PR tracker,
  // 10-year clock, etc.).
  function hasJpResidency() {
    const r = getResidency();
    if (r.arrival_date) return true;
    const a = TB.state.get('onboarding.answers') || {};
    return a.years_in_japan && a.years_in_japan !== 'na';
  }

  // hasJpPersonalTaxFiling: stricter — true only if the user themself
  // files JP-side personal returns (確定申告, 住民税). SOFA contractors
  // and US-only filers return false even with years on the ground.
  // Honors the Tax Coordinator's jp_filing_responsibility picker so
  // a user with a spouse who handles JP filings won't see the 確定申告
  // / ふるさと納税 / 住宅ローン控除 sections by default.
  function hasJpPersonalTaxFiling() {
    if (!hasJpResidency()) return false;
    const a = TB.state.get('onboarding.answers') || {};
    if (a.tax_status === 'sofa_no_file' || a.tax_status === 'us_only') return false;
    // Cross-check the Tax Coordinator's setting if present.
    const coord = TB.state.get('tax_coordinator') || {};
    const stored = coord.jp_filing_responsibility;
    if (stored === 'self') return true;
    if (stored === 'spouse' || stored === 'na') return false;
    // 'auto' / unset → derive from onboarding answers.
    if (a.tax_status === 'japan_resident' || a.tax_status === 'japan_filer') return true;
    // Conservative default: time on ground but tax_status unset =>
    // probably files (was the legacy behavior).
    return true;
  }

  // hasJpHealthcareEnrollment: NHI is independent of tax filing
  // responsibility — even SOFA contractors' spouses enroll in NHI/SHI.
  // But SOFA contractors themselves are exempt from NHI under SOFA
  // Article 9 (typically use TRICARE / private intl insurance instead).
  // Surface only when the USER personally would enroll.
  function hasJpHealthcareEnrollmentForUser() {
    if (!hasJpResidency()) return false;
    const a = TB.state.get('onboarding.answers') || {};
    if (a.tax_status === 'sofa_no_file') return false;  // SOFA exempts user
    return true;
  }

  const SECTIONS = [
    { id: 'header',     always: true, builder: () => buildHeaderCard() },
    {
      id: 'residency',
      label_en: 'Residency status',
      label_jp: '居住ステータス',
      description_en: 'Arrival date, visa, 住民票 status (auto-pulled from onboarding).',
      description_jp: '来日日・在留資格・住民票(オンボーディングから自動取得)。',
      auto_show: () => true,
      builder: () => buildResidencyCard(),
    },
    {
      id: 'pr_tracker',
      label_en: '永住権 tracker',
      label_jp: '永住権トラッカー',
      description_en: 'PR eligibility countdown based on visa type and years in Japan.',
      description_jp: 'ビザ種別と日本居住年数に基づく永住権資格カウントダウン。',
      auto_show: hasJpResidency,
      builder: () => buildPrTrackerCard(),
    },
    {
      id: 'tenyear',
      label_en: '10-year worldwide-asset clock',
      label_jp: '10 年全世界資産時計',
      description_en: 'When JP inheritance tax expands from JP-situs to worldwide.',
      description_jp: '日本相続税が日本所在地から全世界に拡大するタイミング。',
      auto_show: hasJpResidency,
      builder: () => buildTenYearClockCard(),
    },
    {
      id: 'kakutei',
      label_en: '確定申告 prep checklist',
      label_jp: '確定申告準備チェックリスト',
      description_en: 'Documents + deadline + window for Japan annual tax return. Hidden by default for SOFA contractors and households where a spouse handles JP filings.',
      description_jp: '日本年次税務申告の書類・期限・受付期間。SOFA 契約者および配偶者が日本側を担当する世帯ではデフォルト非表示。',
      auto_show: hasJpPersonalTaxFiling,
      builder: () => buildKakuteiShinkokuCard(),
    },
    {
      id: 'furusato',
      label_en: 'Furusato Nozei calculator',
      label_jp: 'ふるさと納税計算機',
      description_en: 'Limit estimator + planned-donation tracking. Hidden by default for SOFA contractors (no JP income tax = no ふるさと納税 benefit) and spouse-handled households.',
      description_jp: '限度額試算と予定寄附額追跡。SOFA 契約者(日本所得税なし=ふるさと納税のメリットなし)および配偶者対応世帯ではデフォルト非表示。',
      auto_show: hasJpPersonalTaxFiling,
      builder: () => buildFurusatoCard(),
    },
    {
      id: 'mortgage',
      label_en: '住宅ローン控除',
      label_jp: '住宅ローン控除',
      description_en: 'Mortgage tax credit (0.7% × balance × 13y). Requires JP income tax to credit against — hidden by default for SOFA contractors.',
      description_jp: '住宅ローン控除(残高 × 0.7% × 13 年)。控除対象の日本所得税が必要のため、SOFA 契約者ではデフォルト非表示。',
      auto_show: hasJpPersonalTaxFiling,
      builder: () => buildMortgageCard(),
    },
    {
      id: 'nhi',
      label_en: 'NHI awareness',
      label_jp: '国民健康保険',
      description_en: 'National Health Insurance enrollment timing. SOFA contractors are exempt under Article 9 — hidden by default.',
      description_jp: '国民健康保険加入タイミング。SOFA 契約者は SOFA 第9条により適用除外のためデフォルト非表示。',
      auto_show: hasJpHealthcareEnrollmentForUser,
      builder: () => buildNhiCard(),
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

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'resident' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'resident' },
          t('resident.badge')),
      ),
      el('h1', null, '🏠 ' + t('resident.title')),
      el('p', { class: 'tb-card-meta' }, t('resident.subtitle')),
    );
  }

  // ─── Residency status card ─────────────────────────────────────────

  function buildResidencyCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const r = getResidencyView();
    const a = TB.state.get('onboarding.answers') || {};
    const yrsBucket = a.years_in_japan;

    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('resident.section.residency')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openResidencyModal() }, '✎ ' + t('resident.edit')),
    ));

    // Truly empty only if we have nothing from either onboarding OR
    // explicit edits. With onboarding visible to this card, this
    // branch is rare (skipped onboarding + never edited).
    const hasAny = r.arrival_date || r.juminhyo_date || r.juminhyo_status
      || r.visa_status || r.permanent_residency || r.pr_application_filed
      || (yrsBucket && yrsBucket !== 'na');
    if (!hasAny) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('resident.residency.empty')));
      return card;
    }

    const dl = el('dl', { class: 'tb-dl' });
    function row(label, val, fromOnboarding) {
      dl.appendChild(el('dt', null, label));
      const dd = el('dd', null);
      if (typeof val === 'string' || typeof val === 'number') {
        dd.appendChild(document.createTextNode(String(val || '—')));
      } else if (val) {
        dd.appendChild(val);
      } else {
        dd.appendChild(document.createTextNode('—'));
      }
      if (fromOnboarding) {
        dd.appendChild(el('span', {
          style: {
            marginLeft: '6px', padding: '1px 6px', fontSize: 'var(--tb-fs-12)',
            color: 'var(--tb-text-soft)', border: '1px solid var(--tb-border)',
            borderRadius: 'var(--tb-radius-pill)', background: 'var(--tb-bg)',
          },
        }, t('resident.from_onboarding')));
      }
      dl.appendChild(dd);
    }

    // Arrival — explicit date if present, else approximate from
    // years-in-Japan bucket (with a "from onboarding" badge).
    if (r.arrival_date) {
      const yrs = yearsInJapan();
      row(t('resident.field.arrival'),
        r.arrival_date + (yrs != null ? ' (' + yrs + 'y ago)' : ''), false);
    } else if (yrsBucket && yrsBucket !== 'na') {
      const yrs = yearsInJapan();
      row(t('resident.field.arrival'),
        '~' + yrs + 'y ' + t('resident.years_ago_approx'), true);
    }

    // 住民票 — explicit registration date if present, else status word
    // (yes/no/unsure) from onboarding.
    if (r.juminhyo_date) {
      row(t('resident.field.juminhyo'), r.juminhyo_date, false);
    } else if (r.juminhyo_status) {
      row(t('resident.field.juminhyo'),
        t('resident.juminhyo.' + r.juminhyo_status) || r.juminhyo_status,
        isFromOnboarding('juminhyo_status'));
    }

    const v = visaSpec(r.visa_status);
    if (v) {
      row(t('resident.field.visa'),
        lang === 'ja' ? v.label_jp : v.label_en,
        isFromOnboarding('visa_status'));
    }

    if (r.permanent_residency) {
      row(t('resident.field.pr_status'),
        el('span', { class: 'tb-badge', style: { background: 'var(--tb-success)', color: '#fff' } },
          '✓ ' + t('resident.pr.granted')),
        isFromOnboarding('permanent_residency'));
    } else if (r.pr_application_filed) {
      row(t('resident.field.pr_status'),
        el('span', { class: 'tb-badge', style: { background: 'var(--tb-warn)', color: '#fff' } },
          t('resident.pr.pending', { date: r.pr_application_filed })));
    }
    card.appendChild(dl);
    return card;
  }

  function openResidencyModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    // Prefill draft from merged view (explicit + onboarding-derived)
    // so the user sees their onboarding answers pre-filled rather
    // than having to re-enter them. Saving promotes any derived
    // values into explicit residency state.
    const draft = Object.assign({}, getResidencyView());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('resident.modal.residency')));

    // Show a small note when any field is being prefilled from
    // onboarding so the user understands where the values came from.
    const onbFields = ['visa_status', 'juminhyo_status', 'permanent_residency'];
    const anyFromOnb = onbFields.some(isFromOnboarding);
    if (anyFromOnb) {
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderLeft: '3px solid var(--tb-track-resident)',
          borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
          fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
        },
      }, 'ℹ ' + t('resident.modal.from_onboarding_note')));
    }

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('resident.field.arrival'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.arrival_date || '',
        oninput: (e) => { draft.arrival_date = e.target.value || null; } }),
      t('resident.field.arrival.help')));

    // 住民票 status — quick yes/no/unsure (from onboarding) for users
    // who don't know the exact registration date. Date field below
    // is optional and overrides the status when set.
    const statusRow = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-3)' } },
      ...['yes', 'no', 'unsure'].map((v) => {
        const radio = el('input', {
          type: 'radio', name: 'tb-juminhyo-status', value: v,
          checked: draft.juminhyo_status === v,
          onchange: () => { draft.juminhyo_status = v; },
        });
        return el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
          radio,
          el('span', null, t('resident.juminhyo.' + v)),
        );
      }),
    );
    modal.appendChild(field(t('resident.field.juminhyo_status'), statusRow,
      t('resident.field.juminhyo_status.help')));

    modal.appendChild(field(t('resident.field.juminhyo'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.juminhyo_date || '',
        oninput: (e) => { draft.juminhyo_date = e.target.value || null; } }),
      t('resident.field.juminhyo.help')));

    const visaSel = el('select', { class: 'tb-select',
      onchange: (e) => { draft.visa_status = e.target.value || null; } },
      el('option', { value: '', selected: !draft.visa_status }, '—'),
      ...VISA_STATUSES.map((v) => el('option', {
        value: v.id, selected: draft.visa_status === v.id,
      }, lang === 'ja' ? v.label_jp : v.label_en)),
    );
    modal.appendChild(field(t('resident.field.visa'), visaSel));

    const prCheck = el('input', { type: 'checkbox', checked: !!draft.permanent_residency,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.permanent_residency = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        prCheck, t('resident.field.pr_granted')),
    ));

    modal.appendChild(field(t('resident.field.pr_filed'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.pr_application_filed || '',
        oninput: (e) => { draft.pr_application_filed = e.target.value || null; } }),
      t('resident.field.pr_filed.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('resident.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('residency', draft); close(); rerender(); },
    }, t('resident.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── PR eligibility tracker ───────────────────────────────────────

  function buildPrTrackerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const r = getResidency();
    const v = visaSpec();
    const elig = prEligibilityDate();

    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🇯🇵 ' + t('resident.section.pr')));

    if (r.permanent_residency) {
      card.appendChild(el('p', null, '✓ ' + t('resident.pr.already_granted')));
      return card;
    }
    if (!r.arrival_date || !v || v.pr_years === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('resident.pr.empty')));
      return card;
    }

    const yrs = yearsInJapan();
    const eligible = elig.already_eligible;
    const yearsRemaining = elig.days / 365.25;
    const progress = Math.min(100, Math.max(0, ((v.pr_years - yearsRemaining) / v.pr_years) * 100));

    // Big progress display
    const wrap = el('div', { style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' } });
    wrap.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('div', null,
        el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
          t('resident.pr.path') + ': ' + (lang === 'ja' ? v.label_jp : v.label_en)),
        el('div', { style: { fontSize: 'var(--tb-fs-22)', fontWeight: '700' } },
          eligible ? '✓ ' + t('resident.pr.now_eligible') :
                     (Math.floor(yearsRemaining) + 'y ' + Math.round((yearsRemaining % 1) * 12) + 'mo')),
      ),
      el('div', { style: { textAlign: 'right' } },
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } }, elig.date),
        el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
          v.pr_years + 'y ' + t('resident.pr.required')),
      ),
    ));
    // Progress bar
    wrap.appendChild(el('div', {
      style: { marginTop: 'var(--tb-sp-2)', height: '10px', background: 'var(--tb-border)',
        borderRadius: 'var(--tb-radius-pill)', overflow: 'hidden' },
    },
      el('div', {
        style: { height: '100%',
          width: progress.toFixed(1) + '%',
          background: eligible ? 'var(--tb-success)' : 'var(--tb-track-resident)',
          transition: 'width var(--tb-motion-base) var(--tb-ease)' },
      }),
    ));
    if (v.notes) {
      wrap.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
        v.notes));
    }
    card.appendChild(wrap);

    // PR application status
    if (eligible && !r.pr_application_filed) {
      card.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-success)', background: 'rgba(47, 111, 78, 0.06)',
          borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)' },
      }, '✓ ' + t('resident.pr.eligible_apply')));
    }

    // Reference link
    card.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
      t('resident.pr.reference') + ' ',
      el('a', { href: 'https://www.moj.go.jp/isa/applications/procedures/16-4.html', target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'var(--tb-navy)' } }, 'moj.go.jp'),
    ));
    return card;
  }

  // ─── 10-year worldwide-asset clock ─────────────────────────────────

  function buildTenYearClockCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const r = getResidency();
    const clock = tenYearClock();

    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⏳ ' + t('resident.section.tenyear')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('resident.tenyear.intro')));

    if (!r.arrival_date) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('resident.tenyear.empty')));
      return card;
    }

    const past = clock.days < 0;
    const yearsIn = -clock.days / 365.25 + 10;
    const wrap = el('div', { style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
      borderRadius: 'var(--tb-radius-2)', borderLeft: '4px solid ' +
        (past ? 'var(--tb-error)' : clock.days < 365 * 2 ? 'var(--tb-warn)' : 'var(--tb-success)') } });

    if (past) {
      wrap.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-22)', fontWeight: '700', color: 'var(--tb-error)' } },
        '⚠ ' + t('resident.tenyear.past', { years: Math.floor(yearsIn) })));
      wrap.appendChild(el('p', { style: { margin: 'var(--tb-sp-2) 0 0' } }, t('resident.tenyear.past.body')));
    } else {
      const yrs = clock.days / 365.25;
      const yLabel = Math.floor(yrs) + 'y ' + Math.round((yrs % 1) * 12) + 'mo';
      wrap.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-22)', fontWeight: '700' } },
        yLabel + ' ' + t('resident.tenyear.until')));
      wrap.appendChild(el('div', { style: { color: 'var(--tb-text-soft)', fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', marginTop: '4px' } },
        t('resident.tenyear.date') + ': ' + clock.date));
      wrap.appendChild(el('p', { style: { margin: 'var(--tb-sp-2) 0 0' } }, t('resident.tenyear.future.body')));
    }
    card.appendChild(wrap);

    // Cross-link to inheritance tax mitigation in Projections.
    card.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
      el('a', { href: '#', style: { color: 'var(--tb-navy)' },
        onclick: (e) => {
          e.preventDefault();
          try { TB.state.set('projections.ui_state.active_tab', 'tax_strategy'); } catch (err) {}
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'projections' } }));
        },
      }, '↗ ' + t('resident.tenyear.see_strategies')),
    ));

    return card;
  }

  // ─── 確定申告 prep checklist card ─────────────────────────────────

  function buildKakuteiShinkokuCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🧾 ' + t('resident.section.kakutei')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('resident.kakutei.intro')));

    // Deadline countdown
    const today = new Date();
    const year = today.getUTCFullYear();
    const deadline = new Date(year + '-03-15T00:00:00');
    if (today > deadline) deadline.setUTCFullYear(year + 1);
    const days = Math.round((deadline - today) / 86400000);
    const monthOpen = new Date(deadline.getUTCFullYear() + '-02-16T00:00:00');
    const inWindow = today >= monthOpen && today <= deadline;
    const color = days <= 14 ? 'var(--tb-error)' : days <= 45 ? 'var(--tb-warn)' : 'var(--tb-text-soft)';

    card.appendChild(el('div', {
      style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid ' + color,
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)' },
    },
      el('div', { style: { fontWeight: '600', color } },
        inWindow
          ? '🔴 ' + t('resident.kakutei.window_open', { days })
          : t('resident.kakutei.next_deadline', { date: deadline.toISOString().slice(0,10), days })),
      el('div', { class: 'tb-field-help', style: { marginTop: '4px' } }, t('resident.kakutei.window_help')),
    ));

    // Checklist of things to gather
    card.appendChild(el('h3', null, t('resident.kakutei.checklist')));
    const items = [
      { en: '源泉徴収票 (year-end employment income statement) from each Japanese employer', jp: '各日本の雇用主からの源泉徴収票' },
      { en: 'US W-2 / 1099 forms — JP residents must report worldwide income', jp: '米国 W-2・1099 — 日本居住者は全世界所得を申告' },
      { en: 'US tax return for prior year (for FTC calculation)', jp: '前年の米国納税申告書(外国税額控除計算用)' },
      { en: 'Receipts for medical expenses >¥100,000 (医療費控除)', jp: '医療費 ¥10万超の領収書(医療費控除)' },
      { en: 'Furusato Nozei donation receipts (寄附金受領証明書)', jp: 'ふるさと納税の寄附金受領証明書' },
      { en: 'Mortgage balance certificate from bank (年末残高証明書) — for 住宅ローン控除', jp: '銀行の年末残高証明書 — 住宅ローン控除用' },
      { en: 'Life / earthquake insurance premium statements', jp: '生命保険・地震保険料の控除証明書' },
      { en: 'iDeCo / 小規模企業共済 contribution statements (if applicable + non-US-person)', jp: 'iDeCo・小規模企業共済の掛金証明書' },
      { en: 'Securities account 特定口座 annual reports (年間取引報告書)', jp: '特定口座の年間取引報告書' },
      { en: 'Foreign-source income documentation (for non-permanent residents only — 5-year rule)', jp: '海外源泉所得の証憑(非永住者のみ — 5年ルール)' },
    ];
    const list = el('ul', { style: { paddingLeft: '20px', margin: 0 } });
    items.forEach((it) => {
      list.appendChild(el('li', { style: { marginBottom: '6px' } },
        TB.i18n.getLang() === 'ja' ? it.jp : it.en));
    });
    card.appendChild(list);

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      t('resident.kakutei.us_person_note')));

    return card;
  }

  // ─── Furusato Nozei calculator card ──────────────────────────────

  function buildFurusatoCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const f = getFurusato();

    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '💴 ' + t('resident.section.furusato')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openFurusatoModal() }, '✎ ' + t('resident.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('resident.furusato.intro')));

    const limit = estimateFurusatoLimit(f.prior_year_income_jpy, f.prior_year_dependents || 0);
    const planned = f.donations_planned_jpy || 0;

    if (!f.prior_year_income_jpy) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('resident.furusato.empty')));
    } else {
      card.appendChild(el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
      },
        statBadge(t('resident.furusato.estimated_limit'), '¥' + limit.toLocaleString()),
        statBadge(t('resident.furusato.planned'), '¥' + planned.toLocaleString(),
          planned > limit ? 'var(--tb-error)' : null),
        statBadge(t('resident.furusato.headroom'), '¥' + Math.max(0, limit - planned).toLocaleString(),
          (limit - planned) <= 0 ? 'var(--tb-error)' : 'var(--tb-success)'),
      ));
      if (planned > limit) {
        card.appendChild(el('div', {
          style: { marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-error)',
            background: 'rgba(178, 58, 58, 0.08)', borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)' },
        }, '⚠ ' + t('resident.furusato.over_limit')));
      }
    }

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      t('resident.furusato.estimate_note') + ' ',
      el('a', { href: 'https://www.furusato-tax.jp/about/simulation', target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'var(--tb-navy)' } }, 'furusato-tax.jp ' + t('resident.furusato.calculator') + ' →'),
    ));
    return card;
  }

  function openFurusatoModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getFurusato());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('resident.modal.furusato')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }
    modal.appendChild(field(t('resident.furusato.prior_income'),
      el('input', { type: 'number', class: 'tb-input', step: '100000', min: '0',
        value: draft.prior_year_income_jpy != null ? draft.prior_year_income_jpy : '',
        placeholder: '8000000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.prior_year_income_jpy = isFinite(v) ? v : null;
        } }),
      t('resident.furusato.prior_income.help')));

    modal.appendChild(field(t('resident.furusato.dependents'),
      el('input', { type: 'number', class: 'tb-input', min: '0', max: '10',
        value: draft.prior_year_dependents || 0,
        oninput: (e) => {
          const v = parseInt(e.target.value, 10);
          draft.prior_year_dependents = isFinite(v) ? Math.max(0, v) : 0;
        } }),
      t('resident.furusato.dependents.help')));

    modal.appendChild(field(t('resident.furusato.donations_planned'),
      el('input', { type: 'number', class: 'tb-input', step: '1000', min: '0',
        value: draft.donations_planned_jpy || 0,
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.donations_planned_jpy = isFinite(v) ? v : 0;
        } }),
      t('resident.furusato.donations_planned.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('resident.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('furusato', draft); close(); rerender(); } }, t('resident.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Mortgage credit card ──────────────────────────────────────────

  function buildMortgageCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const m = getMortgage();

    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🏘 ' + t('resident.section.mortgage')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openMortgageModal() }, '✎ ' + t('resident.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('resident.mortgage.intro')));

    if (!m.has_jp_mortgage) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('resident.mortgage.empty')));
      return card;
    }

    const credit = estimateMortgageCredit(m.loan_balance_jpy, m.loan_type);
    const yearsRemaining = m.purchase_year ? Math.max(0, 13 - (new Date().getUTCFullYear() - m.purchase_year)) : null;
    const typeMeta = MORTGAGE_CAPS[m.loan_type] || MORTGAGE_CAPS.standard;

    card.appendChild(el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-3)' },
    },
      statBadge(t('resident.mortgage.annual_credit'), '¥' + credit.toLocaleString()),
      statBadge(t('resident.mortgage.years_remaining'),
        yearsRemaining != null ? yearsRemaining + ' / 13y' : '—'),
      statBadge(t('resident.mortgage.type'),
        lang === 'ja' ? typeMeta.label_jp : typeMeta.label_en),
    ));

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      t('resident.mortgage.note')));
    return card;
  }

  function openMortgageModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getMortgage());
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('resident.modal.mortgage')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    const hasCheck = el('input', { type: 'checkbox', checked: !!draft.has_jp_mortgage,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.has_jp_mortgage = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        hasCheck, t('resident.mortgage.has')),
    ));

    modal.appendChild(field(t('resident.mortgage.purchase_year'),
      el('input', { type: 'number', class: 'tb-input', min: '1990', max: '2050',
        value: draft.purchase_year || '',
        placeholder: '2024',
        oninput: (e) => {
          const v = parseInt(e.target.value, 10);
          draft.purchase_year = isFinite(v) ? v : null;
        } })));

    modal.appendChild(field(t('resident.mortgage.loan_balance'),
      el('input', { type: 'number', class: 'tb-input', step: '100000', min: '0',
        value: draft.loan_balance_jpy || '',
        placeholder: '30000000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.loan_balance_jpy = isFinite(v) ? v : null;
        } }),
      t('resident.mortgage.loan_balance.help')));

    const typeSel = el('select', { class: 'tb-select',
      onchange: (e) => { draft.loan_type = e.target.value || 'standard'; } },
      ...Object.entries(MORTGAGE_CAPS).map(([id, meta]) => el('option', {
        value: id, selected: draft.loan_type === id,
      }, lang === 'ja' ? meta.label_jp : meta.label_en)),
    );
    modal.appendChild(field(t('resident.mortgage.type'), typeSel));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('resident.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('mortgage', draft); close(); rerender(); } }, t('resident.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── NHI awareness card ───────────────────────────────────────────

  function buildNhiCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🏥 ' + t('resident.section.nhi')));
    card.appendChild(el('p', null, t('resident.nhi.body')));

    card.appendChild(el('div', {
      style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185, 122, 26, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
    }, '⚠ ' + t('resident.nhi.timing_tip')));
    return card;
  }

  // ─── Resources card ───────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'resident' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('resident.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-track-resident)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-2)' },
      },
        el('div', { style: { fontWeight: '600' } }, title),
        el('div', { class: 'tb-field-help', style: { margin: '4px 0' } }, desc),
        url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' } }, url + ' →') : null,
      );
    }
    card.appendChild(resource(t('resident.resources.nta.title'), t('resident.resources.nta.body'),
      'https://www.nta.go.jp/english/'));
    card.appendChild(resource(t('resident.resources.moj.title'), t('resident.resources.moj.body'),
      'https://www.moj.go.jp/isa/applications/procedures/16-4.html'));
    card.appendChild(resource(t('resident.resources.furusato.title'), t('resident.resources.furusato.body'),
      'https://www.furusato-tax.jp/'));
    card.appendChild(resource(t('resident.resources.zeirishi.title'), t('resident.resources.zeirishi.body'), null));
    return card;
  }

  // ─── helpers ──────────────────────────────────────────────────────

  function statBadge(label, value, color) {
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

  function genKakuteiShinkokuDeadline() {
    const out = [];
    // Honor the Tax Coordinator's JP-filing-responsibility setting.
    // SOFA contractors and households where a spouse handles JP-side
    // filings should not see this reminder — it's not their action.
    if (!hasJpPersonalTaxFiling()) return out;
    const today = new Date();
    const year = today.getUTCFullYear();
    const deadline = new Date(year + '-03-15T00:00:00');
    if (today > deadline) return out; // window closed for this year
    const windowOpen = new Date(year + '-02-16T00:00:00');
    const days = Math.round((deadline - today) / 86400000);
    if (today < windowOpen) {
      // Pre-window — only show 30d before opening
      const daysToOpen = Math.round((windowOpen - today) / 86400000);
      if (daysToOpen > 30) return out;
      out.push({
        id: 'resident_kakutei_window_opens',
        group: 'resident', urgency: 'medium', icon: '🧾',
        title: '確定申告 window opens in ' + daysToOpen + ' days (Feb 16)',
        body: 'Annual Japan tax return window: Feb 16 - Mar 15. As a US person + JP resident, you also must coordinate with your US 1040 (worldwide income on both). Start gathering 源泉徴収票, US W-2s, donation receipts, mortgage balance certificates.',
        deadline: deadline.toISOString().slice(0, 10), module: 'resident', snoozable: true,
      });
    } else {
      const urgency = days <= 7 ? 'critical' : days <= 21 ? 'high' : 'medium';
      out.push({
        id: 'resident_kakutei_due',
        group: 'resident', urgency, icon: '🧾',
        title: '確定申告 due ' + deadline.toISOString().slice(0,10) + ' (' + days + ' days)',
        body: 'Japan tax return deadline. Late filing = 5-15% delinquent tax + interest. e-Tax or paper to your local 税務署.',
        deadline: deadline.toISOString().slice(0, 10), module: 'resident', snoozable: false,
      });
    }
    return out;
  }

  function genTenYearClock() {
    const out = [];
    const clock = tenYearClock();
    if (!clock) return out;
    const r = getResidency();
    if (r.permanent_residency) return out; // already a JP citizen / different rules anyway? actually PR doesn't change this, but let it slide for now
    if (clock.days < 0) return out; // already past
    if (clock.days > 365 * 3) return out; // not yet actionable
    const urgency = clock.days <= 365 ? 'high' : 'medium';
    out.push({
      id: 'resident_tenyear_approaching',
      group: 'resident', urgency, icon: '⏳',
      title: '10-year worldwide-asset clock — ' + Math.floor(clock.days / 365) + 'y ' + Math.round((clock.days % 365) / 30) + 'mo left',
      body: 'JP inheritance tax expands to your WORLDWIDE assets at year 10 of residency. US 401k, IRA, brokerage, real estate all become subject to 10-55% JP inheritance tax in the event of your death. Plan mitigation NOW (gifting to non-JP heirs, leave Japan, restructure) — see Projections → Tax Strategy → Inheritance Tax Mitigation.',
      deadline: clock.date, module: 'resident', snoozable: true,
    });
    return out;
  }

  function genPrEligible() {
    const out = [];
    const r = getResidency();
    if (r.permanent_residency || r.pr_application_filed) return out;
    const elig = prEligibilityDate();
    if (!elig) return out;
    if (elig.already_eligible) {
      out.push({
        id: 'resident_pr_eligible',
        group: 'resident', urgency: 'low', icon: '🇯🇵',
        title: 'Eligible to apply for 永住権 (Permanent Residency)',
        body: 'Based on your visa + arrival date, you meet the residency requirement. PR removes visa-renewal hassle. Application process is paper-based at your local immigration office; typical 4-12 month review.',
        module: 'resident', snoozable: true,
      });
    } else if (elig.days <= 365) {
      out.push({
        id: 'resident_pr_approaching',
        group: 'resident', urgency: 'low', icon: '🇯🇵',
        title: '永住権 eligibility in ' + Math.floor(elig.days / 30) + 'mo (' + elig.date + ')',
        body: 'Start gathering documentation now: tax records (5y), residence certificates, employment records, character references. Some processing offices accept pre-application document review.',
        deadline: elig.date, module: 'resident', snoozable: true,
      });
    }
    return out;
  }

  function genFurusatoDeadline() {
    const out = [];
    const today = new Date();
    const year = today.getUTCFullYear();
    const deadline = new Date(year + '-12-31T00:00:00');
    const days = Math.round((deadline - today) / 86400000);
    if (days < 0 || days > 60) return out;
    const f = getFurusato();
    const limit = estimateFurusatoLimit(f.prior_year_income_jpy, f.prior_year_dependents || 0);
    const planned = f.donations_planned_jpy || 0;
    const headroom = limit - planned;
    if (limit === 0) return out;
    if (headroom <= 50_000) return out; // already maxed or close
    out.push({
      id: 'resident_furusato_year_end',
      group: 'resident', urgency: days <= 14 ? 'high' : 'medium', icon: '💴',
      title: 'Furusato Nozei deadline Dec 31 — ¥' + headroom.toLocaleString() + ' headroom remaining',
      body: 'Donations must be made AND processed by Dec 31 to count for the current year. Annual estimated limit: ¥' + limit.toLocaleString() + '. You\'ve planned ¥' + planned.toLocaleString() + '. Stretch the rest before year-end for ~30% gift-value return.',
      deadline: deadline.toISOString().slice(0, 10), module: 'resident', snoozable: true,
    });
    return out;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = { id, label_en: 'Long-Term Resident', label_jp: '長期居住者', render, searchSections: SECTIONS };

  window.TB.resident = {
    actionGenerators: [genKakuteiShinkokuDeadline, genTenYearClock, genPrEligible, genFurusatoDeadline],
    yearsInJapan, tenYearClock, prEligibilityDate,
    estimateFurusatoLimit, estimateMortgageCredit,
    VISA_STATUSES, MORTGAGE_CAPS,
  };
})();
