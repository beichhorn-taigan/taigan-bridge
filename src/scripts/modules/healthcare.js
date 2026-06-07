/* Taigan Bridge — modules/healthcare.js
 *
 * Healthcare orchestration. Pulls from existing health-adjacent state
 * across modules and adds first-class coverage for the topics those
 * modules don't address:
 *
 *   Reads from:
 *     resident.nhi              → 国民健康保険 enrollment
 *     veteran.healthcare        → TRICARE plan + FMP
 *     onboarding.answers.veteran → veteran status (TRICARE eligibility)
 *     family.members            → dependents (kids' insurance gaps)
 *     documentVault.items       → advance directive presence
 *
 *   Adds:
 *     Medicare Part A/B/D enrollment + the in-Japan decision math
 *       (Part B is paid in full whether you use it or not; care abroad
 *       isn't covered — many JP-resident retirees pay $202.90/mo for
 *       nothing. Late-enrollment penalty creates an asymmetric trap.)
 *     介護保険 (long-term care insurance) — universal at 40+
 *     End-of-life preferences (organ donor, DNR, funeral wishes)
 *     Monthly premium budget — aggregated across NHI / SHI / TRICARE
 *       / Medicare / LTC / private US into one "you spend $X/mo on
 *       healthcare across all systems" number
 *
 * Cross-module integration via TB.healthcare.actionGenerators —
 * watches NHI not enrolled, Medicare Part B decision approaching,
 * dependent age-out gaps, advance directive missing, 介護保険 enrollment
 * at 40, etc.
 */

(function () {
  'use strict';

  const id = 'healthcare';

  // ====================================================================
  // Reference data
  // ====================================================================

  // 介護保険 care levels — used in dropdown for users already enrolled.
  // Premium structure isn\'t in scope; users enter their actual figure.
  const LTC_CARE_LEVELS = [
    { id: '要支援1', label_en: '要支援1 (Support level 1)' },
    { id: '要支援2', label_en: '要支援2 (Support level 2)' },
    { id: '要介護1', label_en: '要介護1 (Care level 1)' },
    { id: '要介護2', label_en: '要介護2 (Care level 2)' },
    { id: '要介護3', label_en: '要介護3 (Care level 3)' },
    { id: '要介護4', label_en: '要介護4 (Care level 4)' },
    { id: '要介護5', label_en: '要介護5 (Care level 5)' },
  ];

  // TRICARE plans — slim list for the dropdown. The Veteran module
  // already has the full plan reference; we just surface the user's
  // choice here.
  const TRICARE_PLANS = [
    { id: 'tricare_overseas', label_en: 'TRICARE Overseas Program (active duty / family)' },
    { id: 'select_overseas',  label_en: 'TRICARE Select Overseas (retiree / family)' },
    { id: 'tfl',              label_en: 'TRICARE for Life (Medicare-eligible retirees)' },
    { id: 'usfhp',            label_en: 'US Family Health Plan (specific US regions only)' },
    { id: 'none',             label_en: 'Not enrolled / not eligible' },
  ];

  // 2026 Medicare Part B standard premium. Single source of truth:
  // constants.js (CMS; see docs/CLAIM-LEDGER.md). Recheck each November.
  const MEDICARE_PART_B_BASE_2026 = (window.TB && TB.constants && TB.constants.PART_B_PREMIUM_MONTHLY) || 202.90;

  // Private / employer international insurance plans — SOFA-exempt
  // users (DoD contractors, US-company expats) typically use one of
  // these instead of NHI/SHI. Order matches frequency in the
  // JP-resident-US-expat population.
  const PRIVATE_PLANS = [
    { id: 'cigna_intl',   label_en: 'CIGNA International (employer)' },
    { id: 'aetna_intl',   label_en: 'Aetna International (employer)' },
    { id: 'bupa_global',  label_en: 'Bupa Global' },
    { id: 'geo_blue',     label_en: 'GeoBlue' },
    { id: 'fehb',         label_en: 'FEHB (federal employee)' },
    { id: 'us_employer',  label_en: 'US-employer plan (other)' },
    { id: 'other',        label_en: 'Other (specify)' },
    { id: 'none',         label_en: 'None / not applicable' },
  ];

  // ====================================================================
  // State accessors
  // ====================================================================

  function getHc()        { return TB.state.get('healthcare') || {}; }
  function getMedicare()  { return getHc().medicare || {}; }
  function getLtc()       { return getHc().ltc || {}; }
  function getEol()       { return getHc().end_of_life || {}; }
  function getBudget()    { return getHc().monthly_budget || {}; }
  function getPrivate()   { return getHc().private || {}; }

  function setSection(section, value) {
    const h = getHc();
    h[section] = value;
    TB.state.set('healthcare', h);
  }

  // ── Cross-module reads ───────────────────────────────────────────

  function getResidentNhi() { return TB.state.get('resident.nhi') || {}; }
  function getVeteranHealthcare() { return TB.state.get('veteran.healthcare') || {}; }
  function vetStatus() { return TB.state.get('onboarding.answers.veteran') || 'no'; }
  function isJpResident() {
    const a = TB.state.get('onboarding.answers') || {};
    const tracks = TB.state.get('tracks') || [];
    return a.tax_status === 'japan_resident' || a.tax_status === 'japan_filer'
        || a.juminhyou === 'yes'
        || tracks.indexOf('resident') !== -1;
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

  // Self-age estimate from Projections current_age input (the cleanest
  // self-age signal in our state). Returns null if unavailable.
  function selfAge() {
    const v = TB.state.get('projections.inputs.current_age');
    return typeof v === 'number' ? v : null;
  }

  function isVeteranRetired() {
    const v = vetStatus();
    return v === 'retired';
  }

  // SOFA-status individuals are NOT required to enroll in NHI/SHI.
  // They're covered by US military health (active duty) OR employer-
  // provided international insurance (DoD contractors, civilians)
  // OR via the SOFA agreement itself. The "Not enrolled" state is
  // CORRECT for SOFA users — never an error.
  function isExemptFromNhi() {
    const a = TB.state.get('onboarding.answers') || {};
    if (a.visa === 'sofa') return true;
    if (a.employment === 'dod_active') return true;
    // DoD civilians + contractors are typically SOFA-status; key signal
    // is the visa choice. If they explicitly chose visa=sofa, exempt.
    if ((a.employment === 'dod_civilian' || a.employment === 'dod_contractor') &&
        a.visa === 'sofa') return true;
    return false;
  }

  // Best-guess primary coverage label based on onboarding answers
  // (used to suggest what the user probably has when no explicit
  // private/TRICARE record exists yet).
  function expectedPrimaryCoverage() {
    const a = TB.state.get('onboarding.answers') || {};
    if (a.employment === 'dod_active') return 'tricare_active';
    if (a.employment === 'dod_civilian') return 'fehb';  // typical for federal civilians
    if (a.employment === 'dod_contractor') return 'private_intl';  // CIGNA / Aetna typical
    if (a.employment === 'us_company') return 'private_intl';
    if (a.employment === 'japan_company') return 'shi';
    if (a.employment === 'self') return 'nhi';
    if (a.employment === 'retired_mil') return 'tricare_retiree';
    if (a.employment === 'retired_civ') return 'medicare_or_private';
    return null;
  }

  function privatePlanLabel() {
    const p = getPrivate();
    if (!p.type || p.type === 'none') return null;
    if (p.type === 'other') return p.custom_name || 'Other private plan';
    const found = PRIVATE_PLANS.find((pp) => pp.id === p.type);
    return found ? found.label_en : p.type;
  }

  function hasPrivateCoverage() {
    const p = getPrivate();
    return p.type && p.type !== 'none';
  }

  function hasAdvanceDirective() {
    const items = TB.state.get('documentVault.items') || [];
    return items.some((i) => i.type === 'advance_directive');
  }
  function hasMedicalPoa() {
    const items = TB.state.get('documentVault.items') || [];
    return items.some((i) => i.type === 'poa' && /medical|健康|医療/i.test(i.title || ''));
  }

  // ====================================================================
  // Coverage map — what the user is covered by, derived
  // ====================================================================

  // Returns flags indicating each coverage layer's status. Used by the
  // overview card to give a single-glance picture.
  function deriveCoverage() {
    const m = getMedicare();
    const lt = getLtc();
    const v = getVeteranHealthcare();
    const r = getResidentNhi();
    return {
      nhi: !!r.enrolled,
      shi: false,  // future: pull from SHI tracker if added
      private_intl: hasPrivateCoverage(),
      private_label: privatePlanLabel(),
      tricare: !!v.tricare_eligible || !!v.tricare_plan,
      tricare_plan: v.tricare_plan || null,
      fmp: !!v.fmp_enrolled,
      medicare_a: !!m.enrolled_a,
      medicare_b: !!m.enrolled_b,
      medicare_d: !!m.enrolled_d,
      ltc_eligible: ltcAppliesAuto(),
      ltc_enrolled: !!lt.care_level || (lt.applies === true),
      advance_directive: hasAdvanceDirective(),
      medical_poa: hasMedicalPoa(),
      // SOFA awareness — used by overview + NHI card for context-
      // appropriate messaging.
      nhi_exempt: isExemptFromNhi(),
      expected_primary: expectedPrimaryCoverage(),
    };
  }

  function ltcAppliesAuto() {
    const lt = getLtc();
    if (lt.applies != null) return !!lt.applies;
    const age = selfAge();
    return age != null && age >= 40 && isJpResident();
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
      id: 'nhi',
      label_en: 'NHI / SHI status (Japan)',
      label_jp: 'NHI / SHI ステータス',
      description_en: 'Japanese health insurance enrollment. Pulls from Resident module. SOFA-status users are exempt — context-aware messaging adjusts.',
      description_jp: '日本の健康保険加入状況。Resident モジュールから取得。SOFA ステータスは免除。',
      auto_show: () => isJpResident(),
      builder: () => buildNhiCard(),
    },
    {
      id: 'private',
      label_en: 'Private / employer international insurance',
      label_jp: '民間・雇用主提供の海外保険',
      description_en: 'CIGNA International, Aetna International, Bupa, GeoBlue, FEHB, US-employer plans. Common for SOFA-exempt expats: DoD contractors, US-company expats.',
      description_jp: 'CIGNA International・Aetna International・Bupa・GeoBlue・FEHB・米国雇用主プラン。SOFA 免除の駐在員(DoD 契約者・米国企業駐在)に一般的。',
      auto_show: () => {
        // Auto-show when employment suggests private coverage OR when
        // user has explicitly recorded a private plan.
        if (hasPrivateCoverage()) return true;
        const exp = expectedPrimaryCoverage();
        return exp === 'private_intl' || exp === 'fehb';
      },
      builder: () => buildPrivateCard(),
    },
    {
      id: 'tricare',
      label_en: 'TRICARE',
      label_jp: 'TRICARE',
      description_en: 'TRICARE plan + Overseas + TRICARE for Life. Eligibility depends on retired/active veteran status.',
      description_jp: 'TRICARE プラン・海外 TRICARE・TRICARE for Life。退役・現役のステータス次第で適用。',
      auto_show: () => {
        const s = vetStatus();
        return s === 'retired' || s === 'active';
      },
      builder: () => buildTricareCard(),
    },
    {
      id: 'fmp',
      label_en: 'VA Foreign Medical Program (FMP)',
      label_jp: 'VA 海外医療プログラム(FMP)',
      description_en: 'Service-connected disability care abroad through VA. Requires SC rating.',
      description_jp: 'VA を通じた海外での服務関連障害の治療。SC 認定が必要。',
      auto_show: () => {
        const v = TB.state.get('veteran.disability') || {};
        return (v.overall_rating_pct || 0) > 0;
      },
      builder: () => buildFmpCard(),
    },
    {
      id: 'medicare',
      label_en: 'Medicare (Part A / B / D)',
      label_jp: 'Medicare(Part A / B / D)',
      description_en: 'US Medicare in Japan: Part B paid regardless of usage; care abroad NOT covered. Late-enrollment penalty creates asymmetric trap.',
      description_jp: '米国 Medicare:Part B 保険料は使用有無にかかわらず支払;海外医療は対象外。遅延加入罰則により判断が非対称。',
      auto_show: () => {
        const age = selfAge();
        return age == null || age >= 60;  // start showing 5y before 65
      },
      builder: () => buildMedicareCard(),
    },
    {
      id: 'ltc',
      label_en: '介護保険 (Long-term care insurance)',
      label_jp: '介護保険',
      description_en: 'Universal in Japan at age 40+. Premium scales with income. Tracks care level.',
      description_jp: '40 歳以上で日本で強制加入。保険料は所得に応じて変動。要介護度を追跡。',
      auto_show: () => ltcAppliesAuto(),
      builder: () => buildLtcCard(),
    },
    {
      id: 'end_of_life',
      label_en: 'End-of-life preferences',
      label_jp: '終末期の希望',
      description_en: 'Advance directive, organ donor, DNR. Cross-references Document Vault.',
      description_jp: '事前指示書・臓器提供・DNR。Document Vault と相互参照。',
      auto_show: () => true,
      builder: () => buildEndOfLifeCard(),
    },
    {
      id: 'budget',
      label_en: 'Monthly premium budget',
      label_jp: '月次保険料予算',
      description_en: 'Aggregated premiums across NHI / SHI / TRICARE / Medicare / LTC / private US.',
      description_jp: 'NHI・SHI・TRICARE・Medicare・LTC・米国民間保険の保険料を集計。',
      auto_show: () => true,
      builder: () => buildBudgetCard(),
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
    return el('div', { class: 'tb-card', 'data-track': 'health' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'health' },
          t('health.badge')),
      ),
      el('h1', null, '🏥 ' + t('health.title')),
      el('p', { class: 'tb-card-meta' }, t('health.subtitle')),
    );
  }

  // ─── Coverage overview ───────────────────────────────────────────

  function buildOverviewCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const c = deriveCoverage();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📋 ' + t('health.section.overview')));

    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
    });

    function tile(label, value, color, hint) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
          borderTop: '3px solid ' + (color || 'var(--tb-track-health)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-18)' } }, value),
        hint ? el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' } }, hint) : null,
      );
    }

    // ── Primary medical coverage tile ────────────────────────────
    // Picks whichever the user actually uses for routine care, in
    // priority order: TRICARE Active > Private/employer > NHI > SHI
    // > TRICARE retiree > Medicare alone.
    let primary;
    if (c.tricare && (vetStatus() === 'active' || c.tricare_plan === 'tricare_overseas')) {
      primary = { label: 'TRICARE', color: 'var(--tb-success)', hint: c.tricare_plan || 'enrolled' };
    } else if (c.private_intl) {
      primary = { label: '✓ ' + (c.private_label || 'Private intl'), color: 'var(--tb-success)',
        hint: t('health.overview.private_intl') };
    } else if (c.nhi) {
      primary = { label: '✓ NHI', color: 'var(--tb-success)', hint: t('health.overview.nhi_active') };
    } else if (c.shi) {
      primary = { label: '✓ SHI', color: 'var(--tb-success)', hint: t('health.overview.shi_active') };
    } else if (c.tricare) {
      primary = { label: '✓ TRICARE', color: 'var(--tb-success)', hint: c.tricare_plan || 'retiree' };
    } else if (c.medicare_b) {
      primary = { label: '✓ Medicare', color: 'var(--tb-warn)', hint: t('health.overview.medicare_only_hint') };
    } else if (c.nhi_exempt) {
      // SOFA exempt + no recorded coverage — needs attention
      primary = { label: '⚠ ' + t('health.overview.no_primary'), color: 'var(--tb-warn)',
        hint: t('health.overview.sofa_add_private') };
    } else if (isJpResident()) {
      // JP resident, not SOFA, no coverage — actual problem
      primary = { label: '⚠ ' + t('health.overview.no_primary'), color: 'var(--tb-error)',
        hint: t('health.overview.jp_resident_required') };
    } else {
      primary = { label: t('health.overview.na'), color: 'var(--tb-text-soft)', hint: null };
    }
    tiles.appendChild(tile(t('health.overview.primary_coverage'), primary.label, primary.color, primary.hint));

    // ── JP system status (NHI / SHI / Exempt) ────────────────────
    let jpStatus, jpColor, jpHint;
    if (c.nhi) {
      jpStatus = '✓ NHI'; jpColor = 'var(--tb-success)';
      jpHint = t('health.overview.jp_enrolled');
    } else if (c.shi) {
      jpStatus = '✓ SHI'; jpColor = 'var(--tb-success)';
      jpHint = t('health.overview.jp_enrolled');
    } else if (c.nhi_exempt) {
      // SOFA users are EXEMPT — this is the correct state, not an error
      jpStatus = '○ ' + t('health.overview.sofa_exempt'); jpColor = 'var(--tb-text-soft)';
      jpHint = t('health.overview.sofa_exempt_hint');
    } else if (isJpResident()) {
      jpStatus = '⚠ ' + t('health.overview.jp_required'); jpColor = 'var(--tb-error)';
      jpHint = t('health.overview.jp_required_hint');
    } else {
      jpStatus = t('health.overview.na'); jpColor = 'var(--tb-text-soft)';
    }
    tiles.appendChild(tile(t('health.overview.jp_system'), jpStatus, jpColor, jpHint));

    // ── TRICARE ──────────────────────────────────────────────────
    if (vetStatus() !== 'no' && vetStatus()) {
      let trStatus, trColor, trHint;
      if (c.tricare) {
        const planLabel = (TRICARE_PLANS.find((p) => p.id === c.tricare_plan) || {}).label_en || 'enrolled';
        trStatus = '✓ ' + planLabel.split(' (')[0]; trColor = 'var(--tb-success)';
      } else if (vetStatus() === 'retired' || vetStatus() === 'active') {
        trStatus = '○ ' + t('health.overview.tricare_eligible'); trColor = 'var(--tb-warn)';
      } else {
        trStatus = t('health.overview.na'); trColor = 'var(--tb-text-soft)';
        trHint = t('health.overview.tricare_not_for_status');
      }
      tiles.appendChild(tile('TRICARE', trStatus, trColor, trHint));
    }

    // ── Medicare ─────────────────────────────────────────────────
    let mcStatus, mcColor;
    if (c.medicare_a && c.medicare_b) { mcStatus = '✓ A + B' + (c.medicare_d ? ' + D' : ''); mcColor = 'var(--tb-success)'; }
    else if (c.medicare_a) { mcStatus = '✓ A only'; mcColor = 'var(--tb-warn)'; }
    else if (selfAge() != null && selfAge() >= 65) { mcStatus = '⚠ ' + t('health.overview.medicare_due'); mcColor = 'var(--tb-error)'; }
    else { mcStatus = t('health.overview.medicare_pre'); mcColor = 'var(--tb-text-soft)'; }
    tiles.appendChild(tile('Medicare', mcStatus, mcColor));

    // ── LTC ──────────────────────────────────────────────────────
    let ltcStatus, ltcColor;
    if (c.ltc_enrolled) { ltcStatus = '✓ ' + (getLtc().care_level || t('health.overview.ltc_enrolled')); ltcColor = 'var(--tb-success)'; }
    else if (c.ltc_eligible) { ltcStatus = '✓ ' + t('health.overview.ltc_paying'); ltcColor = 'var(--tb-success)'; }
    else { ltcStatus = t('health.overview.na'); ltcColor = 'var(--tb-text-soft)'; }
    tiles.appendChild(tile('介護保険', ltcStatus, ltcColor));

    // ── Advance directive ────────────────────────────────────────
    tiles.appendChild(tile(
      t('health.overview.advance_directive'),
      c.advance_directive ? '✓ ' + t('health.overview.in_vault') : '○ ' + t('health.overview.not_filed'),
      c.advance_directive ? 'var(--tb-success)' : 'var(--tb-warn)',
    ));

    card.appendChild(tiles);

    // ── Quick takes (context-aware) ──────────────────────────────
    const takes = el('ul', {
      style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' },
    });
    // Only fire JP-coverage warning for users who AREN'T SOFA-exempt
    if (isJpResident() && !c.nhi && !c.shi && !c.nhi_exempt) {
      takes.appendChild(el('li', { style: { color: 'var(--tb-error)' } },
        '⚠ ' + t('health.overview.take.no_jp_coverage')));
    }
    // SOFA + no recorded private plan
    if (c.nhi_exempt && !c.private_intl && !c.tricare && !c.medicare_b) {
      takes.appendChild(el('li', { style: { color: 'var(--tb-warn)' } },
        '⚠ ' + t('health.overview.take.sofa_no_private')));
    }
    if (c.medicare_b && isJpResident() && !c.tricare) {
      takes.appendChild(el('li', { style: { color: 'var(--tb-warn)' } },
        '⚠ ' + t('health.overview.take.medicare_b_unused')));
    }
    if (selfAge() != null && selfAge() >= 64 && !c.medicare_a && !c.medicare_b) {
      takes.appendChild(el('li', { style: { color: 'var(--tb-error)' } },
        '⚠ ' + t('health.overview.take.medicare_decision')));
    }
    if (!c.advance_directive) {
      takes.appendChild(el('li', null, t('health.overview.take.advance_directive')));
    }
    if (takes.children.length > 0) card.appendChild(takes);

    return card;
  }

  // ─── NHI / SHI card ──────────────────────────────────────────────

  function buildNhiCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const r = getResidentNhi();
    const exempt = isExemptFromNhi();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🇯🇵 ' + t('health.section.nhi')),
      el('a', {
        href: '#', style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'resident' } }));
        },
      }, t('health.nhi.edit_in_resident') + ' →'),
    ));

    const enrolled = r.enrolled;

    // Status banner — context-aware. Three states:
    //   1. Enrolled            → green, ✓
    //   2. SOFA-exempt         → neutral, ○ (correct state, not an error)
    //   3. Not enrolled + req'd → red, ⚠ (actual problem)
    let bannerColor, bannerLabel, bannerText;
    if (enrolled) {
      bannerColor = 'var(--tb-success)';
      bannerLabel = '✓ ' + t('health.nhi.status_label') + ': ' + t('health.nhi.enrolled');
      bannerText = null;
    } else if (exempt) {
      bannerColor = 'var(--tb-text-soft)';
      bannerLabel = '○ ' + t('health.nhi.exempt_label');
      bannerText = t('health.nhi.exempt_body');
    } else {
      bannerColor = 'var(--tb-error)';
      bannerLabel = '⚠ ' + t('health.nhi.status_label') + ': ' + t('health.nhi.not_enrolled');
      bannerText = t('health.nhi.required_body');
    }

    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + bannerColor,
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } }, bannerLabel),
      bannerText
        ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } }, bannerText)
        : null,
      r.prior_year_assessment_jpy != null
        ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
            t('health.nhi.assessment') + ': ¥' + r.prior_year_assessment_jpy.toLocaleString())
        : null,
    ));

    // Cross-reference to private/employer coverage when SOFA-exempt
    if (exempt) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-track-health)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)',
        },
      },
        '💡 ' + t('health.nhi.see_private_card')));
    }

    // Education content
    const points = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } });
    [
      'health.nhi.point.universal',
      'health.nhi.point.30pct_copay',
      'health.nhi.point.high_cost_subsidy',
      'health.nhi.point.shi_alternative',
      'health.nhi.point.sofa_exception',
    ].forEach((k) => points.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(points);

    return card;
  }

  // ─── TRICARE card ────────────────────────────────────────────────

  function buildTricareCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const v = getVeteranHealthcare();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🪖 ' + t('health.section.tricare')),
      el('a', {
        href: '#', style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'veteran' } }));
        },
      }, t('health.tricare.edit_in_veteran') + ' →'),
    ));

    const planLabel = (TRICARE_PLANS.find((p) => p.id === v.tricare_plan) || {}).label_en
      || (v.tricare_eligible ? t('health.tricare.eligible_no_plan') : t('health.tricare.not_set'));

    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid var(--tb-success)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } }, t('health.tricare.current_plan') + ': ' + planLabel),
    ));

    const points = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'health.tricare.point.overseas_works',
      'health.tricare.point.tfl',
      'health.tricare.point.dependent_age_out',
      'health.tricare.point.cash_pay_then_claim',
      'health.tricare.point.no_jp_coordination',
    ].forEach((k) => points.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(points);

    return card;
  }

  // ─── FMP card ────────────────────────────────────────────────────

  function buildFmpCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const v = getVeteranHealthcare();
    const disability = TB.state.get('veteran.disability') || {};

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🇺🇸 ' + t('health.section.fmp')));

    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + (v.fmp_enrolled ? 'var(--tb-success)' : 'var(--tb-warn)'),
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } },
        (v.fmp_enrolled ? '✓ ' : '○ ') +
        (v.fmp_enrolled ? t('health.fmp.enrolled') : t('health.fmp.not_enrolled'))),
      el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
        t('health.fmp.disability_rating') + ': ' + (disability.overall_rating_pct || 0) + '%'),
    ));

    const points = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'health.fmp.point.sc_only',
      'health.fmp.point.reimbursement',
      'health.fmp.point.preauth',
      'health.fmp.point.no_iu',
    ].forEach((k) => points.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(points);

    return card;
  }

  // ─── Private / employer international insurance card ────────────

  function buildPrivateCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const p = getPrivate();
    const exp = expectedPrimaryCoverage();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🏢 ' + t('health.section.private')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openPrivateModal() }, '✎ ' + t('health.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('health.private.intro')));

    const planLabel = privatePlanLabel();
    const enrolled = !!planLabel;

    // Status banner
    let bannerColor, bannerText;
    if (enrolled) {
      bannerColor = 'var(--tb-success)';
      bannerText = '✓ ' + planLabel;
    } else if (exp === 'private_intl' || exp === 'fehb') {
      bannerColor = 'var(--tb-warn)';
      bannerText = '○ ' + t('health.private.expected_not_set');
    } else {
      bannerColor = 'var(--tb-text-soft)';
      bannerText = '○ ' + t('health.private.none');
    }

    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + bannerColor,
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } }, bannerText),
      enrolled && (p.monthly_premium_usd || p.monthly_premium_jpy)
        ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
            t('health.private.premium') + ': ' +
            (p.monthly_premium_usd ? '$' + p.monthly_premium_usd + '/mo' : '') +
            (p.monthly_premium_usd && p.monthly_premium_jpy ? ' · ' : '') +
            (p.monthly_premium_jpy ? '¥' + p.monthly_premium_jpy.toLocaleString() + '/mo' : '') +
            (p.employer_paid === 'fully' ? ' · ' + t('health.private.employer_fully') :
              p.employer_paid === 'partially' ? ' · ' + t('health.private.employer_partial') :
              p.employer_paid === 'self' ? ' · ' + t('health.private.self_pay') : ''))
        : null,
      p.notes ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } }, p.notes) : null,
    ));

    // Education content
    const points = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } });
    [
      'health.private.point.cigna_global',
      'health.private.point.coordinate_with_jp',
      'health.private.point.no_jp_coverage_substitute',
      'health.private.point.dependent_coverage',
      'health.private.point.transition_planning',
    ].forEach((k) => points.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(points);

    return card;
  }

  function openPrivateModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      type: null, custom_name: '',
      monthly_premium_usd: null, monthly_premium_jpy: null,
      employer_paid: null, notes: '',
    }, getPrivate());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('health.modal.private')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    // Plan type — also re-renders the modal so 'other' shows the
    // custom_name field.
    const customNameRow = el('div', { class: 'tb-field' });
    function paintCustomNameRow() {
      customNameRow.innerHTML = '';
      if (draft.type === 'other') {
        customNameRow.appendChild(el('label', { class: 'tb-field-label' }, t('health.private.custom_name')));
        customNameRow.appendChild(el('input', { type: 'text', class: 'tb-input',
          value: draft.custom_name || '',
          oninput: (e) => { draft.custom_name = e.target.value; } }));
      }
    }

    modal.appendChild(field(t('health.private.plan_type'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.type = e.target.value || null; paintCustomNameRow(); } },
        el('option', { value: '', selected: !draft.type }, '—'),
        ...PRIVATE_PLANS.map((pp) => el('option', {
          value: pp.id, selected: draft.type === pp.id,
        }, pp.label_en)),
      )));
    modal.appendChild(customNameRow);
    paintCustomNameRow();

    modal.appendChild(field(t('health.private.premium_usd'),
      el('input', { type: 'number', class: 'tb-input', step: '1', min: '0',
        value: draft.monthly_premium_usd != null ? draft.monthly_premium_usd : '',
        placeholder: '0',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.monthly_premium_usd = isFinite(v) ? v : null;
        } }),
      t('health.private.premium_usd.help')));

    modal.appendChild(field(t('health.private.premium_jpy'),
      el('input', { type: 'number', class: 'tb-input', step: '100', min: '0',
        value: draft.monthly_premium_jpy != null ? draft.monthly_premium_jpy : '',
        placeholder: '0',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.monthly_premium_jpy = isFinite(v) ? v : null;
        } }),
      t('health.private.premium_jpy.help')));

    modal.appendChild(field(t('health.private.employer_paid_label'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.employer_paid = e.target.value || null; } },
        el('option', { value: '', selected: !draft.employer_paid }, '—'),
        el('option', { value: 'fully',     selected: draft.employer_paid === 'fully' },     t('health.private.employer_fully')),
        el('option', { value: 'partially', selected: draft.employer_paid === 'partially' }, t('health.private.employer_partial')),
        el('option', { value: 'self',      selected: draft.employer_paid === 'self' },      t('health.private.self_pay')),
      )));

    modal.appendChild(field(t('health.private.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || ''),
      t('health.private.notes.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('health.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('private', draft); close(); rerender(); } }, t('health.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Medicare card ───────────────────────────────────────────────

  function buildMedicareCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const m = getMedicare();
    const age = selfAge();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🇺🇸 ' + t('health.section.medicare')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openMedicareModal() }, '✎ ' + t('health.edit')),
    ));

    // Reality-check banner
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185,122,26,0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
        '⚠ ' + t('health.medicare.reality_label')),
      el('p', { style: { margin: 0 } }, t('health.medicare.reality_body')),
    ));

    // Status grid
    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)' },
    });
    function partTile(label, enrolled, note) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid ' + (enrolled ? 'var(--tb-success)' : 'var(--tb-text-soft)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } }, label),
        el('div', { style: { fontWeight: '700' } },
          (enrolled ? '✓ ' : '○ ') + (enrolled ? t('health.medicare.enrolled') : t('health.medicare.not_enrolled'))),
        note ? el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, note) : null,
      );
    }
    grid.appendChild(partTile('Part A', m.enrolled_a, t('health.medicare.part_a_hint')));
    grid.appendChild(partTile('Part B', m.enrolled_b,
      m.part_b_premium_monthly_usd ? '$' + m.part_b_premium_monthly_usd + '/mo'
        : (m.enrolled_b ? '$' + MEDICARE_PART_B_BASE_2026.toFixed(2) + '/mo' : t('health.medicare.part_b_hint'))));
    grid.appendChild(partTile('Part D', m.enrolled_d, t('health.medicare.part_d_hint')));
    card.appendChild(grid);

    // Decision tree text
    const decision = el('div', {
      style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)' },
    });
    decision.appendChild(el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
      t('health.medicare.decision_label')));
    const ul = el('ul', { style: { margin: 0, paddingLeft: '20px' } });
    [
      'health.medicare.decision.point1',
      'health.medicare.decision.point2',
      'health.medicare.decision.point3',
      'health.medicare.decision.point4',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '4px' } }, t(k))));
    decision.appendChild(ul);
    card.appendChild(decision);

    if (m.part_b_decision_notes) {
      card.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          fontSize: 'var(--tb-fs-12)', borderLeft: '3px solid var(--tb-track-health)' },
      },
        el('div', { style: { fontWeight: '600' } }, t('health.medicare.your_notes')),
        el('div', { style: { marginTop: '4px' } }, m.part_b_decision_notes),
      ));
    }

    return card;
  }

  function openMedicareModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      enrolled_a: false, enrolled_b: false, enrolled_d: false,
      part_b_premium_monthly_usd: null,
      part_b_decision: null, part_b_decision_notes: '',
    }, getMedicare());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('health.modal.medicare')));

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

    modal.appendChild(checkbox(t('health.medicare.enrolled_a'), 'enrolled_a', t('health.medicare.part_a_hint')));
    modal.appendChild(checkbox(t('health.medicare.enrolled_b'), 'enrolled_b', t('health.medicare.part_b_hint')));
    modal.appendChild(field(t('health.medicare.part_b_premium'),
      el('input', { type: 'number', class: 'tb-input', step: '1', min: '0',
        value: draft.part_b_premium_monthly_usd != null ? draft.part_b_premium_monthly_usd : '',
        placeholder: MEDICARE_PART_B_BASE_2026.toFixed(2),
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.part_b_premium_monthly_usd = isFinite(v) ? v : null;
        } }),
      t('health.medicare.part_b_premium.help')));
    modal.appendChild(checkbox(t('health.medicare.enrolled_d'), 'enrolled_d', t('health.medicare.part_d_hint')));

    modal.appendChild(field(t('health.medicare.decision_select'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.part_b_decision = e.target.value || null; } },
        el('option', { value: '', selected: !draft.part_b_decision }, '—'),
        el('option', { value: 'enrolled',  selected: draft.part_b_decision === 'enrolled' },
          t('health.medicare.decision.enrolled')),
        el('option', { value: 'declined',  selected: draft.part_b_decision === 'declined' },
          t('health.medicare.decision.declined')),
        el('option', { value: 'undecided', selected: draft.part_b_decision === 'undecided' },
          t('health.medicare.decision.undecided')),
      )));

    modal.appendChild(field(t('health.medicare.decision_notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.part_b_decision_notes = e.target.value; } },
        draft.part_b_decision_notes || ''),
      t('health.medicare.decision_notes.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('health.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('medicare', draft); close(); rerender(); } }, t('health.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── 介護保険 (LTC) card ─────────────────────────────────────────

  function buildLtcCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lt = getLtc();
    const age = selfAge();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🧑‍⚕️ ' + t('health.section.ltc')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openLtcModal() }, '✎ ' + t('health.edit')),
    ));

    // Status banner
    const enrolled = !!lt.care_level || lt.applies === true;
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + (enrolled ? 'var(--tb-success)' : 'var(--tb-track-health)'),
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } },
        (age != null ? age + ' ' + t('health.ltc.age_years') + ' · ' : '') +
        (enrolled
          ? (lt.care_level
              ? '✓ ' + t('health.ltc.care_level') + ': ' + lt.care_level
              : '✓ ' + t('health.ltc.paying_premiums'))
          : (age != null && age >= 40 && isJpResident()
              ? t('health.ltc.should_be_paying')
              : t('health.ltc.not_yet_eligible')))),
      lt.monthly_premium_jpy
        ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
            t('health.ltc.monthly_premium') + ': ¥' + lt.monthly_premium_jpy.toLocaleString())
        : null,
    ));

    // Education content
    const points = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } });
    [
      'health.ltc.point.mandatory',
      'health.ltc.point.7_levels',
      'health.ltc.point.copay',
      'health.ltc.point.us_long_term_care_separate',
      'health.ltc.point.bridge_planning',
    ].forEach((k) => points.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(points);

    if (lt.funding_strategy_notes) {
      card.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid var(--tb-track-health)' },
      },
        el('div', { style: { fontWeight: '600' } }, t('health.ltc.your_strategy')),
        el('div', { style: { marginTop: '4px', fontSize: 'var(--tb-fs-14)' } }, lt.funding_strategy_notes),
      ));
    }
    return card;
  }

  function openLtcModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      applies: null, care_level: null, monthly_premium_jpy: null, funding_strategy_notes: '',
    }, getLtc());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('health.modal.ltc')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('health.ltc.care_level'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.care_level = e.target.value || null; } },
        el('option', { value: '', selected: !draft.care_level }, t('health.ltc.no_care_level')),
        ...LTC_CARE_LEVELS.map((c) => el('option', {
          value: c.id, selected: draft.care_level === c.id,
        }, c.label_en)),
      ),
      t('health.ltc.care_level.help')));

    modal.appendChild(field(t('health.ltc.monthly_premium'),
      el('input', { type: 'number', class: 'tb-input', step: '100', min: '0',
        value: draft.monthly_premium_jpy != null ? draft.monthly_premium_jpy : '',
        placeholder: '5000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.monthly_premium_jpy = isFinite(v) ? v : null;
        } }),
      t('health.ltc.monthly_premium.help')));

    modal.appendChild(field(t('health.ltc.strategy_notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.funding_strategy_notes = e.target.value; } },
        draft.funding_strategy_notes || ''),
      t('health.ltc.strategy_notes.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('health.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('ltc', draft); close(); rerender(); } }, t('health.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── End-of-life preferences ─────────────────────────────────────

  function buildEndOfLifeCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const eol = getEol();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🕊 ' + t('health.section.end_of_life')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openEolModal() }, '✎ ' + t('health.edit')),
    ));

    // Advance directive status pulled from Document Vault
    const ad = hasAdvanceDirective();
    const poa = hasMedicalPoa();
    const docRow = el('div', {
      style: {
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid ' + (ad ? 'var(--tb-success)' : 'var(--tb-warn)'),
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    });
    docRow.appendChild(el('div', null,
      el('div', { style: { fontWeight: '600' } },
        (ad ? '✓ ' : '○ ') + t('health.eol.advance_directive')),
      el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
        (poa ? '✓ ' : '○ ') + t('health.eol.medical_poa')),
    ));
    docRow.appendChild(el('a', { href: '#',
      style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)', whiteSpace: 'nowrap' },
      onclick: (e) => {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'document-vault' } }));
      },
    }, t('health.eol.add_to_vault') + ' →'));
    card.appendChild(docRow);

    // Preferences
    const dl = el('dl', { class: 'tb-dl', style: { marginTop: 'var(--tb-sp-3)' } });
    function row(label, val) {
      dl.appendChild(el('dt', null, label));
      dl.appendChild(el('dd', null, val || '—'));
    }
    row(t('health.eol.organ_donor_us'), eol.organ_donor_us == null ? '—' : (eol.organ_donor_us ? '✓' : '○'));
    row(t('health.eol.organ_donor_jp'), eol.organ_donor_jp == null ? '—' : (eol.organ_donor_jp ? '✓' : '○'));
    row(t('health.eol.dnr'), eol.dnr_preference || '—');
    if (eol.funeral_preference_notes) {
      row(t('health.eol.funeral_notes'), eol.funeral_preference_notes);
    }
    card.appendChild(dl);

    return card;
  }

  function openEolModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      organ_donor_us: null, organ_donor_jp: null,
      dnr_preference: null, funeral_preference_notes: '',
    }, getEol());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('health.modal.eol')));

    function checkbox(label, key) {
      const cb = el('input', { type: 'checkbox', checked: !!draft[key],
        style: { marginRight: '8px' },
        onchange: (e) => { draft[key] = !!e.target.checked; } });
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
          cb, label),
      );
    }
    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(checkbox(t('health.eol.organ_donor_us'), 'organ_donor_us'));
    modal.appendChild(checkbox(t('health.eol.organ_donor_jp'), 'organ_donor_jp'));

    modal.appendChild(field(t('health.eol.dnr'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.dnr_preference = e.target.value || null; } },
        el('option', { value: '', selected: !draft.dnr_preference }, '—'),
        el('option', { value: 'yes',     selected: draft.dnr_preference === 'yes' }, t('health.eol.dnr.yes')),
        el('option', { value: 'no',      selected: draft.dnr_preference === 'no' }, t('health.eol.dnr.no')),
        el('option', { value: 'limited', selected: draft.dnr_preference === 'limited' }, t('health.eol.dnr.limited')),
      ),
      t('health.eol.dnr.help')));

    modal.appendChild(field(t('health.eol.funeral_notes'),
      el('textarea', { class: 'tb-input', rows: 4,
        oninput: (e) => { draft.funeral_preference_notes = e.target.value; } },
        draft.funeral_preference_notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('health.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('end_of_life', draft); close(); rerender(); } }, t('health.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Monthly premium budget ──────────────────────────────────────

  // Returns the set of premium "lines" that apply to this user. Used
  // both by the budget card intro text and by the modal to scope which
  // input fields appear.
  function applicableBudgetLines() {
    const c = deriveCoverage();
    const exp = expectedPrimaryCoverage();
    const v = vetStatus();
    const isVet = v && v !== 'no';
    const lines = [];
    // NHI / SHI — only if non-SOFA JP resident
    if (isJpResident() && !c.nhi_exempt) {
      lines.push('nhi_jpy', 'shi_jpy');
    }
    // Private / employer international — covered by Private card already,
    // but include in modal if user might want a manual override slot
    if (c.private_intl || exp === 'private_intl' || exp === 'fehb') {
      lines.push('private_intl');
    }
    // TRICARE — only veterans
    if (isVet && (v === 'active' || v === 'retired' || c.tricare)) {
      lines.push('tricare_usd');
    }
    // Medicare — age 60+ or already enrolled
    const age = selfAge();
    if ((age != null && age >= 60) || c.medicare_a || c.medicare_b || c.medicare_d) {
      lines.push('medicare_b_usd', 'medicare_d_usd');
    }
    // 介護保険 — auto-applies at JP resident 40+
    if (c.ltc_eligible || c.ltc_enrolled || (age != null && age >= 35 && isJpResident())) {
      lines.push('ltc_jpy');
    }
    // Private US insurance — generic catch-all (always available as a
    // manual line, e.g., dental, vision, supplemental)
    lines.push('private_us_usd');
    return lines;
  }

  function buildBudgetCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const b = getBudget();
    const lt = getLtc();
    const m = getMedicare();
    const applicable = applicableBudgetLines();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '💴 ' + t('health.section.budget')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openBudgetModal() }, '✎ ' + t('health.edit')),
    ));
    // Build context-specific intro text listing the applicable lines.
    const labels = {
      nhi_jpy: 'NHI', shi_jpy: 'SHI',
      private_intl: t('health.budget.line.private'),
      tricare_usd: 'TRICARE',
      medicare_b_usd: 'Medicare', medicare_d_usd: '',
      ltc_jpy: '介護保険',
      private_us_usd: t('health.budget.line.private_us'),
    };
    const lineLabels = applicable
      .map((k) => labels[k])
      .filter((l, i, arr) => l && arr.indexOf(l) === i);  // unique non-empty
    card.appendChild(el('p', { class: 'tb-card-meta' },
      t('health.budget.intro_prefix') +
      (lineLabels.length > 0 ? ' ' + lineLabels.join(' / ') + '.' : '')));

    // Synthesize: pull LTC from ltc.monthly_premium_jpy, Medicare B from
    // medicare.part_b_premium_monthly_usd if available.
    const fxJpyPerUsd = (TB.assets && typeof TB.assets.toUsd === 'function')
      ? 1 / TB.assets.toUsd(1, 'JPY') : 150;

    const items = [];
    const priv = getPrivate();
    if (b.nhi_jpy)        items.push({ label: 'NHI', jpy: b.nhi_jpy });
    if (b.shi_jpy)        items.push({ label: 'SHI', jpy: b.shi_jpy });
    // Pull private/employer premium from the Private card record
    if (priv.monthly_premium_usd || priv.monthly_premium_jpy) {
      const label = privatePlanLabel() || 'Private intl';
      items.push({ label,
        usd: priv.monthly_premium_usd || null,
        jpy: priv.monthly_premium_jpy || null });
    }
    if (b.tricare_usd)    items.push({ label: 'TRICARE', usd: b.tricare_usd });
    if (b.medicare_b_usd || (m.enrolled_b && m.part_b_premium_monthly_usd)) {
      items.push({ label: 'Medicare Part B',
        usd: b.medicare_b_usd || m.part_b_premium_monthly_usd });
    }
    if (b.medicare_d_usd) items.push({ label: 'Medicare Part D', usd: b.medicare_d_usd });
    if (b.ltc_jpy || lt.monthly_premium_jpy) {
      items.push({ label: '介護保険', jpy: b.ltc_jpy || lt.monthly_premium_jpy });
    }
    if (b.private_us_usd) items.push({ label: 'Private US insurance', usd: b.private_us_usd });

    if (items.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('health.budget.empty')));
      return card;
    }

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
    let totalUsd = 0;
    let totalJpy = 0;
    items.forEach((it) => {
      const usd = it.usd != null ? it.usd : (it.jpy / fxJpyPerUsd);
      const jpy = it.jpy != null ? it.jpy : (it.usd * fxJpyPerUsd);
      totalUsd += usd;
      totalJpy += jpy;
      list.appendChild(el('div', {
        style: {
          display: 'grid', gridTemplateColumns: '1fr auto auto',
          gap: 'var(--tb-sp-3)', alignItems: 'baseline',
          padding: '6px var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
        },
      },
        el('span', null, it.label),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
          '¥' + Math.round(jpy).toLocaleString() + '/mo'),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
          '$' + Math.round(usd).toLocaleString()),
      ));
    });
    card.appendChild(list);

    // Total
    card.appendChild(el('div', {
      style: {
        display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'rgba(178, 58, 74, 0.06)',
        borderRadius: 'var(--tb-radius-2)', marginTop: 'var(--tb-sp-3)',
        borderLeft: '4px solid var(--tb-track-health)', alignItems: 'baseline',
      },
    },
      el('span', { style: { fontWeight: '700' } }, t('health.budget.total_monthly')),
      el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-18)' } },
        '¥' + Math.round(totalJpy).toLocaleString()),
      el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-14)', color: 'var(--tb-text-soft)' } },
        '$' + Math.round(totalUsd).toLocaleString()),
    ));

    // Annual
    card.appendChild(el('div', {
      style: {
        display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', marginTop: '4px', alignItems: 'baseline',
        fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
      },
    },
      el('span', null, t('health.budget.total_annual')),
      el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
        '¥' + Math.round(totalJpy * 12).toLocaleString()),
      el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
        '$' + Math.round(totalUsd * 12).toLocaleString()),
    ));

    return card;
  }

  function openBudgetModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({
      nhi_jpy: null, shi_jpy: null, tricare_usd: null,
      medicare_b_usd: null, medicare_d_usd: null,
      ltc_jpy: null, private_us_usd: null, notes: '',
    }, getBudget());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('health.modal.budget')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('health.budget.modal_help')));

    function num(label, key, currency, placeholder) {
      const isJpy = currency === 'jpy';
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label + ' (' + (isJpy ? '¥' : '$') + ')'),
        el('input', { type: 'number', class: 'tb-input',
          step: isJpy ? '100' : '1', min: '0',
          value: draft[key] != null ? draft[key] : '',
          placeholder: placeholder || '',
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            draft[key] = isFinite(v) ? v : null;
          } }),
      );
    }

    // Field metadata — only render fields whose key is in the
    // applicable list.
    const FIELDS = {
      nhi_jpy:        { label: 'NHI', currency: 'jpy', placeholder: '20000' },
      shi_jpy:        { label: 'SHI', currency: 'jpy', placeholder: '0' },
      tricare_usd:    { label: 'TRICARE', currency: 'usd', placeholder: '0' },
      medicare_b_usd: { label: 'Medicare Part B', currency: 'usd', placeholder: MEDICARE_PART_B_BASE_2026.toFixed(2) },
      medicare_d_usd: { label: 'Medicare Part D', currency: 'usd', placeholder: '40' },
      ltc_jpy:        { label: '介護保険', currency: 'jpy', placeholder: '5000' },
      private_us_usd: { label: t('health.budget.line.private_us'), currency: 'usd', placeholder: '0' },
    };
    const applicable = applicableBudgetLines().filter((k) => FIELDS[k]);
    if (applicable.length > 0) {
      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
      applicable.forEach((k) => {
        const f = FIELDS[k];
        grid.appendChild(num(f.label, k, f.currency, f.placeholder));
      });
      modal.appendChild(grid);
    }
    // For private intl, show a callout instead of duplicating the field
    // (premium is set in the Private card itself)
    if (applicableBudgetLines().indexOf('private_intl') !== -1) {
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-health)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)',
        },
      }, '💡 ' + t('health.budget.private_link')));
    }

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('health.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setSection('monthly_budget', draft); close(); rerender(); } }, t('health.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Resources ────────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const c = deriveCoverage();
    const age = selfAge();
    const vet = vetStatus();
    const isVet = vet && vet !== 'no';
    const hasDisability = (TB.state.get('veteran.disability.overall_rating_pct') || 0) > 0;

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('health.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-health)',
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

    // Each resource has an applicability predicate. We render only
    // resources that pass — otherwise users get a wall of links to
    // programs they don't qualify for. Customize panel can force-show
    // the whole card if hidden.
    const RESOURCES = [
      {
        key: 'medicare',
        applies: () => (age != null && age >= 60) ||
          c.medicare_a || c.medicare_b || c.medicare_d ||
          vet === 'retired',  // TFL retirees need Medicare A+B
        url: 'https://www.medicare.gov/',
      },
      {
        key: 'tricare_overseas',
        applies: () => isVet && (vet === 'active' || vet === 'retired'),
        url: 'https://tricare.mil/Plans/Eligibility/Overseas',
      },
      {
        key: 'fmp',
        applies: () => isVet && (hasDisability || c.fmp ||
          vet === 'separated_with_dis' || vet === 'retired'),
        url: 'https://www.va.gov/COMMUNITYCARE/programs/veterans/fmp/index.asp',
      },
      {
        key: 'mhlw',
        applies: () => isJpResident(),
        url: 'https://www.mhlw.go.jp/english/',
      },
      {
        key: 'ltc',
        applies: () => isJpResident() && (age == null || age >= 35),
        url: 'https://www.mhlw.go.jp/english/policy/care-welfare/care-welfare-elderly/index.html',
      },
      {
        key: 'cigna_intl',
        applies: () => {
          const p = getPrivate();
          return p.type === 'cigna_intl' || expectedPrimaryCoverage() === 'private_intl';
        },
        url: 'https://www.cignaglobal.com/',
      },
      {
        key: 'aetna_intl',
        applies: () => {
          const p = getPrivate();
          return p.type === 'aetna_intl';
        },
        url: 'https://www.aetnainternational.com/',
      },
      {
        key: 'fehb',
        applies: () => {
          const p = getPrivate();
          return p.type === 'fehb' || expectedPrimaryCoverage() === 'fehb';
        },
        url: 'https://www.opm.gov/healthcare-insurance/healthcare/',
      },
    ];

    let renderedAny = false;
    RESOURCES.forEach((r) => {
      if (!r.applies()) return;
      card.appendChild(resource(
        t('health.resources.' + r.key + '.title'),
        t('health.resources.' + r.key + '.body'),
        r.url,
      ));
      renderedAny = true;
    });

    if (!renderedAny) {
      card.appendChild(el('p', { class: 'tb-field-help' },
        t('health.resources.none_applicable')));
    }

    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genNhiNotEnrolled() {
    if (!isJpResident()) return [];
    if (getResidentNhi().enrolled) return [];
    // SOFA-exempt users are NOT required to enroll — skip the warning
    if (isExemptFromNhi()) return [];
    return [{
      id: 'health_nhi_missing',
      group: 'health',
      urgency: 'high',
      icon: '🇯🇵',
      title: 'NHI / SHI not enrolled but you\'re a JP resident',
      body: 'Mandatory under JP law for residents. Enroll at city hall (市役所/区役所) — bring residence card. Premium based on prior-year income; can be substantial. Without coverage you\'re paying full price for any medical care AND legally non-compliant.',
      module: 'healthcare', snoozable: true,
    }];
  }

  // SOFA-exempt users (DoD contractors, US-company expats) likely have
  // employer-provided international insurance (CIGNA, Aetna, etc.).
  // Nudge them to record it so the budget aggregation works and
  // dependent age-out / transition planning is informed.
  function genPrivateCoverageGap() {
    if (!isExemptFromNhi()) return [];
    if (hasPrivateCoverage()) return [];
    const v = getVeteranHealthcare();
    // Skip if active TRICARE or Medicare B is the documented primary
    if (v.tricare_eligible || v.tricare_plan) return [];
    if (getMedicare().enrolled_b) return [];
    const exp = expectedPrimaryCoverage();
    if (exp !== 'private_intl' && exp !== 'fehb' && exp !== 'tricare_active') return [];
    return [{
      id: 'health_private_coverage_unrecorded',
      group: 'health',
      urgency: 'low',
      icon: '🏢',
      title: 'Private / employer health coverage not yet recorded',
      body: 'You\'re SOFA-status — exempt from NHI but typically covered by employer-provided international insurance (CIGNA International, Aetna International, FEHB, etc.). Add the plan in Healthcare → Private / employer international insurance so your budget aggregation reflects reality + you have a record for when coverage transitions (job change, retirement).',
      module: 'healthcare', snoozable: true,
    }];
  }

  function genMedicareDecisionApproaching() {
    const age = selfAge();
    if (age == null) return [];
    if (age < 64 || age > 66) return [];
    const m = getMedicare();
    if (m.part_b_decision === 'enrolled' || m.part_b_decision === 'declined') return [];
    return [{
      id: 'health_medicare_decision_' + age,
      group: 'health',
      urgency: 'high',
      icon: '🇺🇸',
      title: 'Medicare Part B decision window — you\'re ' + age,
      body: 'Initial Enrollment Period: 7 months around your 65th birthday. Part B in Japan is paid in full ($' + MEDICARE_PART_B_BASE_2026.toFixed(2) + '/mo) but doesn\'t cover care abroad. The late-enrollment penalty (10% of premium per 12mo delayed, FOR LIFE) makes this asymmetric. Document your decision in Healthcare → Medicare.',
      module: 'healthcare', snoozable: true,
    }];
  }

  function genLtcEnrollmentReminder() {
    const age = selfAge();
    if (age == null) return [];
    if (age < 39 || age > 41) return [];  // narrow window: turning 40
    if (!isJpResident()) return [];
    const lt = getLtc();
    if (lt.applies === true || lt.care_level || lt.monthly_premium_jpy) return [];
    return [{
      id: 'health_ltc_age_40',
      group: 'health',
      urgency: 'medium',
      icon: '🧑‍⚕️',
      title: '介護保険 enrollment at age 40 — automatic',
      body: 'Age 40 is when 介護保険 (long-term care insurance) becomes mandatory in Japan. Premium auto-deducted via NHI/SHI based on income. Document the monthly amount in Healthcare → 介護保険 so it shows in your healthcare budget aggregation.',
      module: 'healthcare', snoozable: true,
    }];
  }

  function genAdvanceDirectiveMissing() {
    if (hasAdvanceDirective()) return [];
    const age = selfAge();
    if (age == null) return [];
    if (age < 50) return [];  // start nudging at 50
    return [{
      id: 'health_advance_directive_missing',
      group: 'health',
      urgency: age >= 70 ? 'high' : 'medium',
      icon: '🕊',
      title: 'Advance directive not in Document Vault',
      body: 'An advance directive (生前指示書 / リビング・ウィル) documents your medical wishes if you can\'t communicate. Especially important for cross-border families: US and JP medical teams may have different defaults. File one in BOTH languages if you split time. Add to Healthcare → End-of-life + scan to Document Vault.',
      module: 'healthcare', snoozable: true,
    }];
  }

  function genDependentTricareGap() {
    const v = getVeteranHealthcare();
    if (!v.tricare_eligible && !v.tricare_plan) return [];
    const members = TB.state.get('family.members') || [];
    const deps = members.filter((m) => m.relationship === 'child');
    const out = [];
    deps.forEach((d) => {
      if (!d.birth_date) return;
      const age = ageInYears(d.birth_date);
      if (age == null) return;
      if (age >= 19 && age <= 21) {  // approaching 21st
        out.push({
          id: 'health_tricare_dep_age_out_' + d.id,
          group: 'health',
          urgency: age >= 20 ? 'medium' : 'low',
          icon: '🪖',
          title: 'TRICARE coverage ends at 21 — ' + (d.name_en || d.name_jp || 'dependent') + ' is ' + age,
          body: 'TRICARE dependent coverage normally ends at age 21 (or 23 if full-time student). Plan replacement coverage: TRICARE Young Adult ($299-$719/mo), private plan, NHI, employer SHI. Decide before the 21st birthday — gap = full out-of-pocket.',
          module: 'healthcare', snoozable: true,
        });
      }
    });
    return out;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Healthcare', label_jp: '医療・健康保険', render,
    searchSections: SECTIONS,
  };

  window.TB.healthcare = {
    actionGenerators: [
      genNhiNotEnrolled, genPrivateCoverageGap, genMedicareDecisionApproaching,
      genLtcEnrollmentReminder, genAdvanceDirectiveMissing, genDependentTricareGap,
    ],
    deriveCoverage,
    isExemptFromNhi,
    expectedPrimaryCoverage,
    LTC_CARE_LEVELS,
    TRICARE_PLANS,
    PRIVATE_PLANS,
    MEDICARE_PART_B_BASE_2026,
  };
})();
