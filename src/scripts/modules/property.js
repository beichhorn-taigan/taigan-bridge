/* Taigan Bridge — modules/property.js
 *
 * Real Estate / Property — both JP and US property holdings, with
 * cross-border tax math that no other tool consolidates well for
 * this audience:
 *
 *   - JP property: 固定資産税, 都市計画税, 不動産取得税, 路線価-based
 *     valuation, depreciation by structure type, mortgage credit
 *     interaction (cross-link to Resident).
 *   - US property: §121 sale exclusion, depreciation recapture, FX
 *     gain on basis (§988), §469 passive activity loss rules.
 *   - US rental income while in JP: FEIE doesn't cover passive →
 *     Form 1116 + Schedule E mechanics, JP-side reporting requirement.
 *   - Inheritance: 古民家 / family-land scenarios, 小規模宅地等の特例
 *     eligibility for primary residence (cross-link to Estate calc).
 *
 * Cross-references:
 *   - Resident:  住宅ローン控除 (mortgage credit) — already tracked there
 *   - Estate:    situs analysis — JP residential flag drives 80% reduction
 *   - Tax Coord: filing context for FEIE/FTC + Schedule E
 *   - Assets:    optional cross-reference for property-as-asset
 */

(function () {
  'use strict';

  const id = 'property';

  // ====================================================================
  // Reference data
  // ====================================================================

  const PROPERTY_TYPES = [
    { id: 'primary_residence', label_en: 'Primary residence',     label_jp: '主たる居住用不動産' },
    { id: 'rental',            label_en: 'Rental property',        label_jp: '賃貸用不動産' },
    { id: 'vacation',          label_en: 'Vacation / second home', label_jp: '別荘・セカンドハウス' },
    { id: 'kominka',           label_en: '古民家 (traditional folk house)', label_jp: '古民家' },
    { id: 'inherited',         label_en: 'Inherited (not yet rebased)', label_jp: '相続済み' },
    { id: 'land',              label_en: 'Land only (no structure)', label_jp: '土地のみ' },
    { id: 'other',             label_en: 'Other',                  label_jp: 'その他' },
  ];

  // JP structure types — drive depreciation lifetime + 不動産取得税.
  // Useful-life standard durations per NTA:
  //   wood (木造):       22y
  //   light steel (軽量鉄骨): 27y
  //   steel (鉄骨):      34y
  //   RC (鉄筋コンクリート): 47y
  //   SRC (鉄骨鉄筋コンクリート): 47y
  const JP_STRUCTURE_TYPES = [
    { id: 'wood',  label_en: '木造 (Wood frame)',                  useful_life_years: 22 },
    { id: 'light_steel', label_en: '軽量鉄骨 (Light steel)',         useful_life_years: 27 },
    { id: 'steel', label_en: '鉄骨 (Steel)',                        useful_life_years: 34 },
    { id: 'rc',    label_en: '鉄筋コンクリート (RC)',                 useful_life_years: 47 },
    { id: 'src',   label_en: '鉄骨鉄筋コンクリート (SRC)',           useful_life_years: 47 },
    { id: 'other', label_en: 'Other / unknown',                     useful_life_years: null },
  ];

  // US §121 thresholds (annual exclusion on sale of primary residence).
  const US_121_EXCLUSION = {
    single: 250000,
    mfj:    500000,
  };

  // 不動産取得税 — JP real estate acquisition tax. Approximate 2026 rates.
  const JP_ACQUISITION_TAX = {
    standard_pct: 4.0,    // base rate
    residential_pct: 3.0, // reduced rate for residential real estate (through 2027)
    land_special_pct: 1.5, // half of standard for residential land
  };

  // ====================================================================
  // State accessors
  // ====================================================================

  function getProperty()    { return TB.state.get('property') || {}; }
  function getProperties()  { return getProperty().properties || []; }
  function getPrefs()       { return getProperty().preferences || {}; }

  function setProperties(arr) {
    const p = getProperty();
    p.properties = arr;
    TB.state.set('property', p);
  }
  function setPrefs(value) {
    const p = getProperty();
    p.preferences = value;
    TB.state.set('property', p);
  }

  function upsertProperty(rec) {
    const arr = getProperties();
    const i = arr.findIndex((x) => x.id === rec.id);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    setProperties(arr);
  }
  function deleteProperty(propId) {
    setProperties(getProperties().filter((x) => x.id !== propId));
  }

  // ====================================================================
  // Property tax notice vision import (v0.60)
  // ====================================================================
  //
  // Drops a 固定資産税通知書 photo/PDF and pre-fills address, assessed
  // values, and annual tax fields on the property draft. We don't auto-
  // save — the user gets to review the modal with extracted values
  // before confirming with Save. Wareki dates handled by the prompt.
  async function runPropertyTaxVision(file, draft, statusEl, onApplied) {
    const t = TB.i18n.t;
    statusEl.textContent = '⏳ ' + t('property.import.processing');
    statusEl.style.color = 'var(--tb-text-soft)';
    try {
      const result = await TB.ai.callClaudeVisionForStructuredDoc(file, 'property_tax_jp', {
        feature: 'document_vision',
      });
      const ext = (result && result.extracted) || {};
      const cost = (result.cost_usd || 0).toFixed(4);
      const filled = [];
      // Only fill blank fields — never overwrite user-entered data
      if (!draft.address && ext.property_address) {
        draft.address = ext.property_address;
        filled.push('address');
      }
      if (draft.annual_property_tax_native == null && ext.annual_tax_jpy != null) {
        draft.annual_property_tax_native = Number(ext.annual_tax_jpy);
        draft.currency = 'JPY';
        filled.push('annual_tax');
      }
      if (draft.annual_city_tax_native == null && ext.city_planning_tax_jpy != null) {
        draft.annual_city_tax_native = Number(ext.city_planning_tax_jpy);
        filled.push('city_tax');
      }
      if (draft.current_value_native == null && ext.total_assessed_jpy != null) {
        draft.current_value_native = Number(ext.total_assessed_jpy);
        filled.push('assessed_value');
      }
      // Append a notes line with anything else that came back
      if (ext.notes || ext.tax_year || ext.municipality) {
        const bits = [];
        if (ext.tax_year)     bits.push(String(ext.tax_year) + ' 度');
        if (ext.municipality) bits.push(ext.municipality);
        if (ext.lot_or_house_no) bits.push('地番/家屋番号: ' + ext.lot_or_house_no);
        if (ext.notes) bits.push(ext.notes);
        const note = bits.join(' · ');
        const cur = (draft.notes || '').trim();
        draft.notes = cur ? cur + '\n— ' + note : note;
        filled.push('notes');
      }
      if (filled.length === 0) {
        statusEl.textContent = '⚠ ' + t('property.import.nothing') + ' · $' + cost;
        statusEl.style.color = 'var(--tb-warn)';
        return;
      }
      statusEl.textContent = '✓ ' + t('property.import.done', { n: filled.length, cost });
      statusEl.style.color = 'var(--tb-success)';
      // Trigger the modal re-render so populated fields show up.
      setTimeout(() => { try { onApplied && onApplied(); } catch (_) {} }, 600);
    } catch (err) {
      statusEl.textContent = '✗ ' + (err.message || err);
      statusEl.style.color = 'var(--tb-error)';
    }
  }

  function uuid() {
    return 'prop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  // ====================================================================
  // FX helpers
  // ====================================================================

  function jpyToUsd(jpy) {
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      return TB.assets.toUsd(jpy || 0, 'JPY');
    }
    return (jpy || 0) / 150;
  }
  function usdToJpy(usd) {
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      const oneUsdInJpy = 1 / TB.assets.toUsd(1, 'JPY');
      return (usd || 0) * oneUsdInJpy;
    }
    return (usd || 0) * 150;
  }
  function nativeToUsd(value, currency) {
    if (currency === 'USD') return value || 0;
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      return TB.assets.toUsd(value || 0, currency);
    }
    if (currency === 'JPY') return jpyToUsd(value);
    return value || 0;
  }
  function fmtNative(value, currency) {
    if (currency === 'JPY') return '¥' + Math.round(value || 0).toLocaleString();
    return '$' + Math.round(value || 0).toLocaleString();
  }

  // ====================================================================
  // Computed helpers
  // ====================================================================

  // Years owned, fractional.
  function yearsOwned(rec) {
    if (!rec.purchase_date) return null;
    const pd = new Date(rec.purchase_date + 'T00:00:00');
    if (isNaN(pd.getTime())) return null;
    return (Date.now() - pd.getTime()) / (365.25 * 86400000);
  }

  // Estimated annual JP property tax (固定資産税 + 都市計画税).
  // Standard rates: 固定資産税 1.4% on assessed value; 都市計画税 max 0.3%.
  // Assessed value (固定資産税評価額) is typically 60-70% of market value.
  // We use 65% as a default proxy when user hasn't entered explicit tax.
  function estimateJpAnnualPropertyTax(rec) {
    if (rec.country !== 'JP') return 0;
    if (rec.annual_property_tax_native) {
      return (rec.annual_property_tax_native || 0) +
             (rec.annual_city_tax_native || 0);
    }
    if (!rec.current_value_native) return 0;
    const assessed = rec.current_value_native * 0.65;
    return Math.round(assessed * (0.014 + 0.003));
  }

  // §121 eligibility — must have owned AND used as primary residence
  // for at least 2 of the last 5 years.
  function us121Eligible(rec) {
    if (rec.country !== 'US') return null;
    if (rec.type !== 'primary_residence') return false;
    if (rec.lived_2_of_5_years === false) return false;
    if (rec.lived_2_of_5_years === true) return true;
    // Default: assume yes if owned ≥2 years
    const yrs = yearsOwned(rec);
    return yrs != null && yrs >= 2;
  }

  // Annual rental net income estimate.
  function netRentalIncome(rec) {
    if (rec.rental_status !== 'rented' || !rec.monthly_rent_native) return 0;
    return (rec.monthly_rent_native * 12) - (rec.annual_rental_expenses_native || 0);
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  function hasJpProperties() { return getProperties().some((p) => p.country === 'JP'); }
  function hasUsProperties() { return getProperties().some((p) => p.country === 'US'); }
  function hasRentals()      { return getProperties().some((p) => p.rental_status === 'rented'); }
  function hasInheritedJp()  { return getProperties().some((p) => p.country === 'JP' && (p.type === 'kominka' || p.type === 'inherited')); }
  function expectedInheritance() {
    const a = TB.state.get('onboarding.answers') || {};
    return a.real_estate === 'expected';
  }

  const SECTIONS = [
    { id: 'header',    always: true, builder: () => buildHeaderCard() },
    { id: 'roster',    always: true, builder: () => buildRosterCard() },
    {
      id: 'jp_taxes',
      label_en: 'JP property tax overview',
      label_jp: '日本の不動産税概要',
      description_en: '固定資産税 + 都市計画税 + 不動産取得税 estimates.',
      description_jp: '固定資産税・都市計画税・不動産取得税の試算。',
      auto_show: hasJpProperties,
      builder: () => buildJpTaxCard(),
    },
    {
      id: 'us_rental',
      label_en: 'US rental income reporting',
      label_jp: '米国賃貸収入の申告',
      description_en: 'FEIE doesn\'t cover passive income — Form 1116 + Schedule E mechanics for JP-resident landlords.',
      description_jp: 'FEIE は受動所得を対象外 — 日本居住の家主向け Form 1116 + Schedule E の取扱い。',
      auto_show: () => hasRentals() && hasUsProperties(),
      builder: () => buildUsRentalCard(),
    },
    {
      id: 'us_sale',
      label_en: 'US sale planning (§121 + 譲渡所得)',
      label_jp: '米国売却計画(§121 + 譲渡所得)',
      description_en: 'Per US property: §121 exclusion, depreciation recapture, FX-on-basis, JP capital gains.',
      description_jp: '米国不動産毎:§121 控除・減価償却の戻し入れ・基礎の FX 損益・日本側譲渡所得。',
      auto_show: hasUsProperties,
      builder: () => buildUsSaleCard(),
    },
    {
      id: 'mortgage_credit',
      label_en: '住宅ローン控除 cross-link',
      label_jp: '住宅ローン控除への参照',
      description_en: 'JP mortgage tax credit (0.7% × balance × 13y) — details tracked in Resident module.',
      description_jp: 'JP 住宅ローン控除(残高 × 0.7% × 13 年) — 詳細は Resident モジュールで管理。',
      auto_show: () => hasJpProperties() && getProperties().some((p) => p.country === 'JP' && p.mortgage_balance_native > 0),
      builder: () => buildMortgageCreditCard(),
    },
    {
      id: 'inherited_jp',
      label_en: '古民家 / inherited JP property',
      label_jp: '古民家・相続不動産',
      description_en: 'Family-land scenarios, 小規模宅地等の特例 eligibility, valuation challenges.',
      description_jp: '実家の土地・小規模宅地等の特例適用・評価額の論点。',
      auto_show: () => hasInheritedJp() || expectedInheritance(),
      builder: () => buildInheritedJpCard(),
    },
    {
      id: 'situs_link',
      label_en: 'Cross-border situs implications',
      label_jp: '国境を越える所在地の影響',
      description_en: 'Each property\'s situs drives Estate inheritance tax scope. Cross-link to Estate.',
      description_jp: '各不動産の所在地が相続税の対象範囲を決定。Estate への参照。',
      auto_show: () => getProperties().length > 0,
      builder: () => buildSitusLinkCard(),
    },
    {
      id: 'cash_flow',
      label_en: 'Monthly cash flow summary',
      label_jp: '月次キャッシュフロー要約',
      description_en: 'All properties combined: rental income − mortgage − tax − maintenance.',
      description_jp: '全不動産合計:賃貸収入 − ローン − 税金 − 維持費。',
      auto_show: () => getProperties().length > 0,
      builder: () => buildCashFlowCard(),
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
    return el('div', { class: 'tb-card', 'data-track': 'property' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'property' },
          t('property.badge')),
      ),
      el('h1', null, '🏠 ' + t('property.title')),
      el('p', { class: 'tb-card-meta' }, t('property.subtitle')),
    );
  }

  // ─── Property roster ─────────────────────────────────────────────

  function buildRosterCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const properties = getProperties();

    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🏘 ' + t('property.section.roster')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openPropertyModal(null) }, '＋ ' + t('property.add')),
    ));

    if (properties.length === 0) {
      const a = TB.state.get('onboarding.answers') || {};
      let hint = t('property.empty');
      if (a.real_estate === 'yes') hint = t('property.empty.from_onboarding');
      else if (a.real_estate === 'expected') hint = t('property.empty.expected');
      card.appendChild(el('p', { class: 'tb-field-help' }, hint));
      return card;
    }

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)' } });
    properties.forEach((p) => {
      const typeMeta = PROPERTY_TYPES.find((x) => x.id === p.type) || {};
      const typeLabel = lang === 'ja' ? typeMeta.label_jp : typeMeta.label_en;
      const yrs = yearsOwned(p);
      const valueDisplay = p.current_value_native
        ? fmtNative(p.current_value_native, p.currency) +
          ' (≈$' + Math.round(nativeToUsd(p.current_value_native, p.currency)).toLocaleString() + ')'
        : null;

      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-property)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      });
      row.appendChild(el('div', { style: { flex: '1', minWidth: '180px' } },
        el('div', { style: { fontWeight: '600' } },
          el('span', {
            style: {
              display: 'inline-block', padding: '1px 6px', marginRight: '6px',
              fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
              borderRadius: 'var(--tb-radius-pill)', color: '#fff',
              background: p.country === 'JP' ? '#B23A3A' : p.country === 'US' ? '#1A4480' : '#666',
            },
          }, p.country),
          p.label || t('property.untitled'),
        ),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          (typeLabel || '—') +
          (yrs != null ? ' · ' + yrs.toFixed(1) + 'y owned' : '') +
          (valueDisplay ? ' · ' + valueDisplay : '')),
        p.rental_status === 'rented' && p.monthly_rent_native
          ? el('div', { class: 'tb-field-help', style: { marginTop: '2px', color: 'var(--tb-success)' } },
              '💰 ' + fmtNative(p.monthly_rent_native, p.currency) + '/mo rental income')
          : null,
      ));
      row.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openPropertyModal(p) }, '✎'));
      list.appendChild(row);
    });
    card.appendChild(list);

    return card;
  }

  function openPropertyModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isNew = !existing;
    const draft = Object.assign({
      id: uuid(),
      label: '',
      country: 'JP',
      currency: 'JPY',
      type: 'primary_residence',
      purchase_date: null,
      purchase_price_native: null,
      address: '',
      square_meters: null,
      structure_type: null,
      current_value_native: null,
      mortgage_balance_native: null,
      mortgage_rate_pct: null,
      mortgage_remaining_years: null,
      annual_property_tax_native: null,
      annual_city_tax_native: null,
      annual_insurance_native: null,
      monthly_maintenance_native: null,
      rental_status: null,
      monthly_rent_native: null,
      annual_rental_expenses_native: null,
      depreciation_started_year: null,
      depreciation_basis_native: null,
      planned_sale_year: null,
      lived_2_of_5_years: null,
      is_residential_for_inheritance: false,
      notes: '',
      created_at: new Date().toISOString(),
    }, existing || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isNew ? t('property.modal.add') : t('property.modal.edit')));

    // Vision import — JP 固定資産税通知書 only (US property tax notices
    // vary widely by county and aren't worth a custom prompt yet).
    if (draft.country === 'JP'
        && TB.ai && typeof TB.ai.callClaudeVisionForStructuredDoc === 'function') {
      const visionStatus = el('div', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', marginTop: '4px', minHeight: '1em' } });
      const visionInput = el('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/jpg,image/webp,application/pdf',
        style: { display: 'none' },
        onchange: async (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) await runPropertyTaxVision(f, draft, visionStatus, () => {
            // Re-render the whole modal so newly populated fields appear
            close(); openPropertyModal(draft);
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
        }, '📎 ' + t('property.import.btn')),
        visionInput,
        el('span', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', flex: '1', minWidth: '180px' } },
          t('property.import.help')),
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
    function num(label, key, help, step, placeholder) {
      return field(label,
        el('input', { type: 'number', class: 'tb-input', step: step || '1', min: '0',
          value: draft[key] != null ? draft[key] : '',
          placeholder: placeholder || '',
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            draft[key] = isFinite(v) ? v : null;
          } }),
        help);
    }

    // Country / currency
    const ccRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    const countrySel = el('select', { class: 'tb-select',
      onchange: (e) => {
        draft.country = e.target.value;
        draft.currency = draft.country === 'JP' ? 'JPY' : draft.country === 'US' ? 'USD' : draft.currency;
        // Re-render to update structure_type visibility + currency labels
        close(); openPropertyModal(draft);
      } },
      el('option', { value: 'JP', selected: draft.country === 'JP' }, '🇯🇵 Japan'),
      el('option', { value: 'US', selected: draft.country === 'US' }, '🇺🇸 United States'),
      el('option', { value: 'OTHER', selected: draft.country === 'OTHER' }, t('property.country.other')),
    );
    ccRow.appendChild(field(t('property.field.country'), countrySel));
    ccRow.appendChild(field(t('property.field.currency'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.currency = e.target.value; } },
        ['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD'].map((c) =>
          el('option', { value: c, selected: draft.currency === c }, c)),
      )));
    modal.appendChild(ccRow);

    // Label + type
    const labelRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    labelRow.appendChild(field(t('property.field.label'),
      el('input', { type: 'text', class: 'tb-input', value: draft.label,
        placeholder: 'e.g. "Kichijoji apartment"',
        oninput: (e) => { draft.label = e.target.value; } })));
    labelRow.appendChild(field(t('property.field.type'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.type = e.target.value; } },
        PROPERTY_TYPES.map((typ) => el('option', {
          value: typ.id, selected: draft.type === typ.id,
        }, lang === 'ja' ? typ.label_jp : typ.label_en)),
      )));
    modal.appendChild(labelRow);

    // Purchase date + price
    const purchaseRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    purchaseRow.appendChild(field(t('property.field.purchase_date'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.purchase_date || '',
        oninput: (e) => { draft.purchase_date = e.target.value || null; } })));
    purchaseRow.appendChild(num(t('property.field.purchase_price') + ' (' + draft.currency + ')', 'purchase_price_native', null, '1000'));
    modal.appendChild(purchaseRow);

    // Address + size
    modal.appendChild(field(t('property.field.address'),
      el('input', { type: 'text', class: 'tb-input', value: draft.address,
        oninput: (e) => { draft.address = e.target.value; } })));

    const sizeRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    sizeRow.appendChild(num(t('property.field.square_meters'), 'square_meters', t('property.field.square_meters.help'), '1'));

    // Structure type — JP only
    if (draft.country === 'JP') {
      sizeRow.appendChild(field(t('property.field.structure_type'),
        el('select', { class: 'tb-select',
          onchange: (e) => { draft.structure_type = e.target.value || null; } },
          el('option', { value: '', selected: !draft.structure_type }, '—'),
          ...JP_STRUCTURE_TYPES.map((s) => el('option', {
            value: s.id, selected: draft.structure_type === s.id,
          }, s.label_en + (s.useful_life_years ? ' · ' + s.useful_life_years + 'y' : ''))),
        ),
        t('property.field.structure_type.help')));
    } else {
      sizeRow.appendChild(el('div', null));  // placeholder for grid alignment
    }
    modal.appendChild(sizeRow);

    // Current value
    modal.appendChild(num(t('property.field.current_value') + ' (' + draft.currency + ')',
      'current_value_native', t('property.field.current_value.help'), '1000'));

    // Mortgage section
    const mortgageDetails = el('details', { style: { marginTop: 'var(--tb-sp-3)' } });
    mortgageDetails.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
      '🏦 ' + t('property.section.mortgage')));
    const mGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' } });
    mGrid.appendChild(num(t('property.field.mortgage_balance'), 'mortgage_balance_native', null, '1000'));
    mGrid.appendChild(num(t('property.field.mortgage_rate_pct'), 'mortgage_rate_pct', null, '0.05'));
    mGrid.appendChild(num(t('property.field.mortgage_years_left'), 'mortgage_remaining_years', null, '1'));
    mortgageDetails.appendChild(mGrid);
    modal.appendChild(mortgageDetails);

    // Annual costs
    const costsDetails = el('details', { style: { marginTop: 'var(--tb-sp-2)' } });
    costsDetails.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
      '💴 ' + t('property.section.costs')));
    const cGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' } });
    if (draft.country === 'JP') {
      cGrid.appendChild(num(t('property.field.annual_property_tax_jp'), 'annual_property_tax_native', t('property.field.annual_property_tax_jp.help'), '1000'));
      cGrid.appendChild(num(t('property.field.annual_city_tax_jp'), 'annual_city_tax_native', t('property.field.annual_city_tax_jp.help'), '1000'));
    } else {
      cGrid.appendChild(num(t('property.field.annual_property_tax_us'), 'annual_property_tax_native', t('property.field.annual_property_tax_us.help'), '100'));
      cGrid.appendChild(el('div', null));
    }
    cGrid.appendChild(num(t('property.field.annual_insurance'), 'annual_insurance_native', null, '100'));
    cGrid.appendChild(num(t('property.field.monthly_maintenance'), 'monthly_maintenance_native', null, '100'));
    costsDetails.appendChild(cGrid);
    modal.appendChild(costsDetails);

    // Rental section
    const rentalDetails = el('details', { style: { marginTop: 'var(--tb-sp-2)' } });
    rentalDetails.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
      '🏘 ' + t('property.section.rental')));
    rentalDetails.appendChild(field(t('property.field.rental_status'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.rental_status = e.target.value || null; } },
        el('option', { value: '', selected: !draft.rental_status }, t('property.rental.not_rental')),
        el('option', { value: 'rented', selected: draft.rental_status === 'rented' }, t('property.rental.rented')),
        el('option', { value: 'vacant', selected: draft.rental_status === 'vacant' }, t('property.rental.vacant')),
        el('option', { value: 'pending', selected: draft.rental_status === 'pending' }, t('property.rental.pending')),
      )));
    const rGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--tb-sp-2)' } });
    rGrid.appendChild(num(t('property.field.monthly_rent') + ' (' + draft.currency + ')', 'monthly_rent_native', null, '100'));
    rGrid.appendChild(num(t('property.field.annual_rental_expenses') + ' (' + draft.currency + ')', 'annual_rental_expenses_native', t('property.field.annual_rental_expenses.help'), '100'));
    if (draft.country === 'US') {
      rGrid.appendChild(num(t('property.field.depreciation_started_year'), 'depreciation_started_year', t('property.field.depreciation_started_year.help'), '1', '2020'));
      rGrid.appendChild(num(t('property.field.depreciation_basis') + ' ($)', 'depreciation_basis_native', t('property.field.depreciation_basis.help'), '1000'));
    }
    rentalDetails.appendChild(rGrid);
    modal.appendChild(rentalDetails);

    // Sale planning — US only
    if (draft.country === 'US' && draft.type === 'primary_residence') {
      const saleDetails = el('details', { style: { marginTop: 'var(--tb-sp-2)' } });
      saleDetails.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
        '📤 ' + t('property.section.sale_planning')));
      const livedSel = el('select', { class: 'tb-select',
        onchange: (e) => {
          const v = e.target.value;
          draft.lived_2_of_5_years = v === '' ? null : (v === 'yes');
        } },
        el('option', { value: '', selected: draft.lived_2_of_5_years == null }, t('property.field.lived.auto')),
        el('option', { value: 'yes', selected: draft.lived_2_of_5_years === true }, t('property.field.lived.yes')),
        el('option', { value: 'no', selected: draft.lived_2_of_5_years === false }, t('property.field.lived.no')),
      );
      saleDetails.appendChild(field(t('property.field.lived_2_of_5'), livedSel,
        t('property.field.lived_2_of_5.help')));
      saleDetails.appendChild(num(t('property.field.planned_sale_year'), 'planned_sale_year', null, '1', '2030'));
      modal.appendChild(saleDetails);
    }

    // Inheritance flag — JP only, 小規模宅地等の特例 eligibility
    if (draft.country === 'JP') {
      const inhCheck = el('input', { type: 'checkbox', checked: !!draft.is_residential_for_inheritance,
        style: { marginRight: '8px' },
        onchange: (e) => { draft.is_residential_for_inheritance = !!e.target.checked; } });
      modal.appendChild(el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
          inhCheck, t('property.field.shotaku_eligible')),
        el('div', { class: 'tb-field-help' }, t('property.field.shotaku_eligible.help'))));
    }

    // Notes
    modal.appendChild(field(t('property.field.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    // Buttons
    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)' } });
    if (!isNew) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          if (confirm(t('property.confirm.delete'))) {
            deleteProperty(draft.id); close(); rerender();
          }
        } }, '🗑 ' + t('property.delete')));
    } else {
      btnRow.appendChild(el('div', null));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('property.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        draft.updated_at = new Date().toISOString();
        upsertProperty(draft);
        close(); rerender();
      } }, t('property.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── JP property tax overview ────────────────────────────────────

  function buildJpTaxCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const jpProps = getProperties().filter((p) => p.country === 'JP');

    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '💴 ' + t('property.section.jp_taxes')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('property.jp_taxes.intro')));

    let totalAnnual = 0;
    jpProps.forEach((p) => {
      const annualTax = estimateJpAnnualPropertyTax(p);
      totalAnnual += annualTax;
      const isEstimated = !p.annual_property_tax_native;
      card.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } }, p.label || t('property.untitled')),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
            isEstimated ? t('property.jp_taxes.estimated') : t('property.jp_taxes.user_entered')),
        ),
        el('div', { style: { textAlign: 'right' } },
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
            '¥' + Math.round(annualTax).toLocaleString() + '/y'),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
            '$' + Math.round(jpyToUsd(annualTax)).toLocaleString() + '/y'),
        ),
      ));
    });

    if (totalAnnual > 0) {
      card.appendChild(el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'rgba(156, 91, 58, 0.06)', borderRadius: 'var(--tb-radius-2)',
          marginTop: 'var(--tb-sp-3)', borderLeft: '4px solid var(--tb-track-property)',
        },
      },
        el('span', { style: { fontWeight: '700' } }, t('property.jp_taxes.total_annual')),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-22)' } },
          '¥' + Math.round(totalAnnual).toLocaleString() + ' / $' + Math.round(jpyToUsd(totalAnnual)).toLocaleString()),
      ));
    }

    // Education content
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } });
    [
      'property.jp_taxes.point.kotei',
      'property.jp_taxes.point.toshi',
      'property.jp_taxes.point.shutoku',
      'property.jp_taxes.point.assessment_lag',
      'property.jp_taxes.point.dual_residence',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── US rental income reporting ──────────────────────────────────

  function buildUsRentalCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const usRentals = getProperties().filter((p) => p.country === 'US' && p.rental_status === 'rented');

    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🇺🇸 ' + t('property.section.us_rental')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('property.us_rental.intro')));

    // FEIE-doesn't-cover-this banner
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185,122,26,0.06)', borderRadius: 'var(--tb-radius-1)',
        marginBottom: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '⚠ ' + t('property.us_rental.feie_warning_label')),
      el('p', { style: { margin: 0 } }, t('property.us_rental.feie_warning_body')),
    ));

    let totalGross = 0;
    let totalNet = 0;
    usRentals.forEach((p) => {
      const gross = (p.monthly_rent_native || 0) * 12;
      const net = netRentalIncome(p);
      totalGross += gross;
      totalNet += net;
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
          el('div', null,
            el('div', { style: { fontWeight: '600' } }, p.label || t('property.untitled')),
            el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
              p.address || ''),
          ),
          el('div', { style: { textAlign: 'right' } },
            el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
              t('property.us_rental.gross') + ': $' + Math.round(gross).toLocaleString() + '/y'),
            el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600',
              color: net >= 0 ? 'var(--tb-success)' : 'var(--tb-error)' } },
              t('property.us_rental.net') + ': $' + Math.round(net).toLocaleString() + '/y'),
          ),
        ),
      ));
    });

    if (totalNet !== 0) {
      card.appendChild(el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'rgba(156, 91, 58, 0.06)', borderRadius: 'var(--tb-radius-2)',
          marginTop: 'var(--tb-sp-2)', borderLeft: '4px solid var(--tb-track-property)',
        },
      },
        el('span', { style: { fontWeight: '700' } }, t('property.us_rental.total_net')),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } },
          '$' + Math.round(totalNet).toLocaleString() + '/y'),
      ));
    }

    // Education
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'property.us_rental.point.schedule_e',
      'property.us_rental.point.depreciation',
      'property.us_rental.point.passive_loss',
      'property.us_rental.point.jp_treatment',
      'property.us_rental.point.ftc_basket',
      'property.us_rental.point.recapture_on_sale',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── US §121 sale planning ───────────────────────────────────────

  function buildUsSaleCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const usProps = getProperties().filter((p) => p.country === 'US');
    if (usProps.length === 0) return el('div', { style: { display: 'none' } });

    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📤 ' + t('property.section.us_sale')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('property.us_sale.intro')));

    // Per-property §121 status
    usProps.forEach((p) => {
      const eligible = us121Eligible(p);
      const yrs = yearsOwned(p);
      let statusColor, statusLabel;
      if (eligible === true) {
        statusColor = 'var(--tb-success)';
        statusLabel = '✓ ' + t('property.us_sale.eligible');
      } else if (eligible === false) {
        statusColor = 'var(--tb-warn)';
        statusLabel = '⚠ ' + t('property.us_sale.not_eligible');
      } else {
        statusColor = 'var(--tb-text-soft)';
        statusLabel = '○ ' + t('property.us_sale.na');
      }
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + statusColor,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
          el('div', null,
            el('div', { style: { fontWeight: '600' } }, p.label || t('property.untitled')),
            el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
              p.type + (yrs != null ? ' · ' + yrs.toFixed(1) + 'y owned' : '')),
          ),
          el('div', { style: { fontWeight: '600', color: statusColor } }, statusLabel),
        ),
        eligible === true
          ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
              t('property.us_sale.exclusion_amount') + ': $' + US_121_EXCLUSION.single.toLocaleString() +
              ' / $' + US_121_EXCLUSION.mfj.toLocaleString() + ' (MFJ)')
          : null,
      ));
    });

    // Education
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'property.us_sale.point.121_basics',
      'property.us_sale.point.depreciation_recapture',
      'property.us_sale.point.fx_988',
      'property.us_sale.point.jp_capital_gains',
      'property.us_sale.point.ftc_offset',
      'property.us_sale.point.partial_exclusion',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── Mortgage credit cross-link ──────────────────────────────────

  function buildMortgageCreditCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🏠 ' + t('property.section.mortgage_credit')));
    card.appendChild(el('p', null, t('property.mortgage_credit.intro')));
    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
      el('a', { href: '#', style: { color: 'var(--tb-navy)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'resident' } }));
        } }, '↗ ' + t('property.mortgage_credit.open_resident'))));
    return card;
  }

  // ─── 古民家 / inherited JP property ──────────────────────────────

  function buildInheritedJpCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🏡 ' + t('property.section.inherited_jp')));
    card.appendChild(el('p', null, t('property.inherited_jp.intro')));

    const ul = el('ul', { style: { paddingLeft: '20px' } });
    [
      'property.inherited_jp.point.shotaku',
      'property.inherited_jp.point.rosenka',
      'property.inherited_jp.point.akiya_problem',
      'property.inherited_jp.point.us_estate_situs',
      'property.inherited_jp.point.deed_transfer',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── Cross-border situs cross-link ───────────────────────────────

  function buildSitusLinkCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const props = getProperties();
    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🌐 ' + t('property.section.situs_link')));
    card.appendChild(el('p', null, t('property.situs_link.intro')));

    // Quick situs breakdown
    let jpVal = 0, usVal = 0;
    props.forEach((p) => {
      const usd = nativeToUsd(p.current_value_native, p.currency);
      if (p.country === 'JP') jpVal += usd;
      else if (p.country === 'US') usVal += usd;
    });

    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' },
    });
    function tile(label, valueUsd, color) {
      return el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', borderLeft: '3px solid ' + color },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } }, label),
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } },
          '$' + Math.round(valueUsd).toLocaleString()),
      );
    }
    tiles.appendChild(tile(t('property.situs_link.jp_situs'), jpVal, '#B23A3A'));
    tiles.appendChild(tile(t('property.situs_link.us_situs'), usVal, '#1A4480'));
    card.appendChild(tiles);

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      el('a', { href: '#', style: { color: 'var(--tb-navy)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'estate' } }));
        } }, '↗ ' + t('property.situs_link.open_estate'))));

    return card;
  }

  // ─── Cash flow summary ──────────────────────────────────────────

  function buildCashFlowCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const props = getProperties();

    let monthlyIncome = 0;
    let monthlyOutgo = 0;
    props.forEach((p) => {
      const incomeUsd = p.rental_status === 'rented' && p.monthly_rent_native
        ? nativeToUsd(p.monthly_rent_native, p.currency) : 0;
      monthlyIncome += incomeUsd;
      // Mortgage payment estimate (simple — principal+interest only)
      let mortgagePmt = 0;
      if (p.mortgage_balance_native && p.mortgage_rate_pct && p.mortgage_remaining_years) {
        const r = (p.mortgage_rate_pct / 100) / 12;
        const n = p.mortgage_remaining_years * 12;
        if (r > 0) {
          mortgagePmt = (p.mortgage_balance_native * r) / (1 - Math.pow(1 + r, -n));
        }
      }
      monthlyOutgo += nativeToUsd(mortgagePmt, p.currency);
      // Tax + insurance + maintenance
      const annualOutgo = (p.annual_property_tax_native || 0) +
                         (p.annual_city_tax_native || 0) +
                         (p.annual_insurance_native || 0);
      monthlyOutgo += nativeToUsd(annualOutgo, p.currency) / 12;
      monthlyOutgo += nativeToUsd(p.monthly_maintenance_native || 0, p.currency);
    });
    const monthlyNet = monthlyIncome - monthlyOutgo;

    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '💵 ' + t('property.section.cash_flow')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('property.cash_flow.intro')));

    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' },
    });
    function tile(label, valueUsd, color) {
      return el('div', {
        style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', borderTop: '3px solid ' + (color || 'var(--tb-track-property)'),
          border: '1px solid var(--tb-border)' },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' } },
          '$' + Math.round(valueUsd).toLocaleString()),
      );
    }
    tiles.appendChild(tile(t('property.cash_flow.income'), monthlyIncome, 'var(--tb-success)'));
    tiles.appendChild(tile(t('property.cash_flow.outgo'), -monthlyOutgo, 'var(--tb-warn)'));
    tiles.appendChild(tile(t('property.cash_flow.net'), monthlyNet,
      monthlyNet >= 0 ? 'var(--tb-success)' : 'var(--tb-error)'));
    card.appendChild(tiles);

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
      t('property.cash_flow.note')));
    return card;
  }

  // ─── Resources ──────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'property' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('property.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-property)',
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
    if (hasJpProperties()) {
      card.appendChild(resource(t('property.resources.rosenka.title'), t('property.resources.rosenka.body'),
        'https://www.rosenka.nta.go.jp/'));
      card.appendChild(resource(t('property.resources.nta_property.title'), t('property.resources.nta_property.body'),
        'https://www.nta.go.jp/english/taxes/individual/12005.htm'));
    }
    if (hasUsProperties()) {
      card.appendChild(resource(t('property.resources.irs_pub527.title'), t('property.resources.irs_pub527.body'),
        'https://www.irs.gov/forms-pubs/about-publication-527'));
      card.appendChild(resource(t('property.resources.irs_pub523.title'), t('property.resources.irs_pub523.body'),
        'https://www.irs.gov/forms-pubs/about-publication-523'));
    }
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  // 不動産取得税 due — assessed within ~6 months of purchase. Fires
  // for JP properties purchased in last 8 months without a flagged
  // payment.
  function genJpAcquisitionTax() {
    const out = [];
    getProperties().forEach((p) => {
      if (p.country !== 'JP' || !p.purchase_date) return;
      const days = (Date.now() - new Date(p.purchase_date + 'T00:00:00').getTime()) / 86400000;
      if (days < 0 || days > 240) return;
      if (p.acquisition_tax_paid) return;
      out.push({
        id: 'property_jp_shutoku_' + p.id,
        group: 'property',
        urgency: days > 180 ? 'high' : 'medium',
        icon: '🏠',
        title: '不動産取得税 due — ' + (p.label || 'JP property'),
        body: 'Real estate acquisition tax bill typically arrives 3-6 months post-purchase from the prefecture. Standard rate 3% for residential (through 2027). Watch for the 納税通知書 in the mail.',
        module: 'property', snoozable: true,
      });
    });
    return out;
  }

  // §121 5-year clock approaching loss — for US primary residences
  // where user has lived in <2 of last 5 years.
  function genUs121ClockWarning() {
    const out = [];
    getProperties().forEach((p) => {
      if (p.country !== 'US') return;
      if (p.type !== 'primary_residence') return;
      if (p.lived_2_of_5_years !== false) return;  // only fire for explicit "no"
      out.push({
        id: 'property_121_clock_' + p.id,
        group: 'property',
        urgency: 'medium',
        icon: '📤',
        title: '§121 exclusion at risk — ' + (p.label || 'US property'),
        body: 'You\'ve flagged this property as not meeting the 2-of-5-year residence test. Selling now means foregoing up to $250K ($500K MFJ) of capital-gain exclusion. Consider whether to delay sale or accept the tax hit.',
        module: 'property', snoozable: true,
      });
    });
    return out;
  }

  // Annual JP property tax season — March/April reminders
  function genJpPropertyTaxSeason() {
    if (!hasJpProperties()) return [];
    const today = new Date();
    const month = today.getMonth() + 1;
    if (month < 3 || month > 5) return [];
    return [{
      id: 'property_jp_annual_tax_' + today.getFullYear(),
      group: 'property',
      urgency: 'low',
      icon: '💴',
      title: '固定資産税 quarterly bills incoming (April-June)',
      body: 'Annual JP property tax assessment notice (固定資産税納税通知書) typically arrives April. Payment in 4 quarterly installments OR annual lump sum. Watch the mail; auto-debit available at most JP banks.',
      module: 'property', snoozable: true,
    }];
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Real Estate', label_jp: '不動産', render,
    searchSections: SECTIONS,
  };

  window.TB.property = {
    actionGenerators: [genJpAcquisitionTax, genUs121ClockWarning, genJpPropertyTaxSeason],
    getProperties, estimateJpAnnualPropertyTax, us121Eligible, netRentalIncome,
    PROPERTY_TYPES, JP_STRUCTURE_TYPES, US_121_EXCLUSION, JP_ACQUISITION_TAX,
  };
})();
