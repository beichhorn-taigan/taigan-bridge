/* Taigan Bridge — modules/consultations.js
 *
 * Consultation Tracker — log of professional advisors engaged + per-
 * consultation notes. Reinforces the "informational, not professional
 * advice" positioning by making it easy to track WHO has actually
 * reviewed WHAT.
 *
 * Surfaces "have you consulted on X?" prompts based on user state:
 *   - PFIC detected in Assets    → recommends specialist CPA
 *   - Renunciation contemplated  → recommends specialist consultation
 *   - JP estate >¥30M projected  → recommends 税理士
 *   - VA disability rating > 0   → recommends VA-accredited claims agent
 *   - 養子縁組 in family plan   → recommends 司法書士
 */

(function () {
  'use strict';

  const id = 'consultations';

  // ====================================================================
  // Reference data
  // ====================================================================

  const PROFESSIONAL_TYPES = [
    { id: 'cpa_us',         label_en: 'US CPA',                 label_jp: '米国 CPA' },
    { id: 'cpa_us_intl',    label_en: 'US CPA (international specialty)', label_jp: '米国 CPA(国際税務専門)' },
    { id: 'tax_jp',         label_en: '税理士 (JP tax accountant)', label_jp: '税理士' },
    { id: 'lawyer_us',      label_en: 'US attorney',            label_jp: '米国弁護士' },
    { id: 'lawyer_jp',      label_en: '弁護士 (JP attorney)',     label_jp: '弁護士' },
    { id: 'shihoshoshi',    label_en: '司法書士 (judicial scrivener)', label_jp: '司法書士' },
    { id: 'gyoseishoshi',   label_en: '行政書士 (administrative scrivener)', label_jp: '行政書士' },
    { id: 'immigration_us', label_en: 'US immigration attorney', label_jp: '米国移民弁護士' },
    { id: 'va_claims',      label_en: 'VA-accredited claims agent', label_jp: 'VA 認定請求代理人' },
    { id: 'financial_planner', label_en: 'Financial planner / CFP', label_jp: 'ファイナンシャルプランナー / CFP' },
    { id: 'estate_planner', label_en: 'Estate planner',         label_jp: '相続プランナー' },
    { id: 'enrolled_agent', label_en: 'Enrolled Agent (US)',    label_jp: '登録税務代理人(米国)' },
    { id: 'other',          label_en: 'Other',                  label_jp: 'その他' },
  ];

  const RETAINER_STATUS = [
    { id: 'engaged',   label_en: 'Currently engaged' },
    { id: 'on_call',   label_en: 'On call (no active engagement)' },
    { id: 'past',      label_en: 'Past engagement' },
  ];

  const RELATED_MODULES = [
    'tax-coordinator', 'fbar', 'estate', 'family', 'property',
    'veteran', 'resident', 'healthcare', 'projections', 'decumulation',
    'sofa-roth', 'fx-banking', 'document-vault',
  ];

  // ====================================================================
  // State accessors
  // ====================================================================

  function getConsultations() { return TB.state.get('consultations') || {}; }
  function getProfessionals() { return getConsultations().professionals || []; }
  function getConsultLog()    { return getConsultations().consultations || []; }

  function setProfessionals(arr) {
    const c = getConsultations();
    c.professionals = arr;
    TB.state.set('consultations', c);
  }
  function setConsultLog(arr) {
    const c = getConsultations();
    c.consultations = arr;
    TB.state.set('consultations', c);
  }

  function uuid(prefix) {
    return (prefix || 'con-') + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function upsertProfessional(rec) {
    const arr = getProfessionals();
    const i = arr.findIndex((x) => x.id === rec.id);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    setProfessionals(arr);
  }
  function upsertConsultation(rec) {
    const arr = getConsultLog();
    const i = arr.findIndex((x) => x.id === rec.id);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
    setConsultLog(arr);
  }

  // ====================================================================
  // Reminders — derive "have you consulted on X?" prompts
  // ====================================================================

  function buildReminders() {
    const out = [];
    const log = getConsultLog();
    const professionals = getProfessionals();

    function hasConsultedOn(topic, withinDays) {
      const cutoff = withinDays
        ? Date.now() - withinDays * 86400000 : 0;
      return log.some((c) => {
        if (c.date && new Date(c.date).getTime() < cutoff) return false;
        const t = (c.topic || '') + ' ' + (c.summary || '') + ' ' + (c.notes || '');
        return t.toLowerCase().indexOf(topic.toLowerCase()) !== -1;
      });
    }
    function hasProfessionalType(typeId) {
      return professionals.some((p) => p.type === typeId &&
        (p.retainer_status === 'engaged' || p.retainer_status === 'on_call'));
    }

    // PFIC detected → recommend international-CPA consultation
    try {
      if (TB.taxCoord && typeof TB.taxCoord.buildContext === 'function') {
        const ctx = TB.taxCoord.buildContext();
        if (ctx.has_pfic === true && !hasConsultedOn('PFIC', 365)) {
          out.push({
            severity: 'high', icon: '⚠',
            title_key: 'consult.reminder.pfic.title',
            body_key: 'consult.reminder.pfic.body',
            recommended_type: 'cpa_us_intl',
          });
        }
      }
    } catch (err) { /* swallow */ }

    // Renunciation contemplated → specialist consultation
    try {
      const r = TB.state.get('family.renunciation') || {};
      if (r.contemplating && !r.consultation_complete &&
          !hasConsultedOn('renunciation', 720)) {
        out.push({
          severity: 'high', icon: '⚠',
          title_key: 'consult.reminder.renunciation.title',
          body_key: 'consult.reminder.renunciation.body',
          recommended_type: 'cpa_us_intl',
        });
      }
    } catch (err) { /* swallow */ }

    // High JP estate exposure → 税理士
    try {
      if (TB.estate && typeof TB.estate.computeJpInheritanceTax === 'function') {
        const tax = TB.estate.computeJpInheritanceTax();
        if (tax.net_tax > 30_000_000 && !hasProfessionalType('tax_jp')) {
          out.push({
            severity: 'medium', icon: '💴',
            title_key: 'consult.reminder.jp_estate.title',
            body_key: 'consult.reminder.jp_estate.body',
            recommended_type: 'tax_jp',
          });
        }
      }
    } catch (err) { /* swallow */ }

    // VA disability rating → VA-accredited claims agent
    try {
      const rating = TB.state.get('veteran.disability.overall_rating_pct') || 0;
      if (rating > 0 && !hasProfessionalType('va_claims') &&
          !hasConsultedOn('VA', 730)) {
        out.push({
          severity: 'low', icon: '🎖',
          title_key: 'consult.reminder.va.title',
          body_key: 'consult.reminder.va.body',
          recommended_type: 'va_claims',
        });
      }
    } catch (err) { /* swallow */ }

    // No CPA at all but US person living in JP — universal recommendation
    try {
      const visa = TB.state.get('onboarding.answers.visa');
      const taxStatus = TB.state.get('onboarding.answers.tax_status');
      const inJapan = TB.state.get('onboarding.answers.in_japan');
      if (inJapan === 'yes' && visa !== 'sofa' &&
          !hasProfessionalType('cpa_us') && !hasProfessionalType('cpa_us_intl')) {
        out.push({
          severity: 'medium', icon: '👔',
          title_key: 'consult.reminder.no_cpa.title',
          body_key: 'consult.reminder.no_cpa.body',
          recommended_type: 'cpa_us_intl',
        });
      }
    } catch (err) { /* swallow */ }

    // Engaged professional with stale follow-up
    log.forEach((c) => {
      if (!c.follow_up_needed || !c.follow_up_date) return;
      const days = Math.floor((Date.now() - new Date(c.follow_up_date).getTime()) / 86400000);
      if (days < 0) return;  // future date
      if (days > 30) {
        const pro = professionals.find((p) => p.id === c.professional_id);
        out.push({
          severity: days > 90 ? 'high' : 'medium',
          icon: '⏰',
          title_key: 'consult.reminder.followup.title',
          title_data: { name: pro ? pro.name : '(unknown)', topic: c.topic || '' },
          body_key: 'consult.reminder.followup.body',
          body_data: { days },
          consultation_id: c.id,
        });
      }
    });

    return out;
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  const SECTIONS = [
    { id: 'header',       always: true, builder: () => buildHeaderCard() },
    { id: 'reminders',    always: true, builder: () => buildRemindersCard() },
    { id: 'professionals', always: true, builder: () => buildProfessionalsCard() },
    { id: 'log',          always: true, builder: () => buildLogCard() },
    { id: 'resources',    always: true, builder: () => buildResourcesCard() },
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
    return el('div', { class: 'tb-card', 'data-track': 'consult' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'consult' }, t('consult.badge')),
      ),
      el('h1', null, '👔 ' + t('consult.title')),
      el('p', { class: 'tb-card-meta' }, t('consult.subtitle')),
    );
  }

  // ─── Reminders ────────────────────────────────────────────────────

  function buildRemindersCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const reminders = buildReminders();

    const card = el('div', { class: 'tb-card', 'data-track': 'consult' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🔔 ' + t('consult.section.reminders')));

    if (reminders.length === 0) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-success)',
          background: 'rgba(47, 111, 78, 0.06)', borderRadius: 'var(--tb-radius-1)',
        },
      },
        el('div', { style: { fontWeight: '600', color: 'var(--tb-success)' } },
          '✓ ' + t('consult.reminders.none')),
        el('p', { style: { margin: '4px 0 0 0', fontSize: 'var(--tb-fs-12)' } },
          t('consult.reminders.none_body')),
      ));
      return card;
    }

    reminders.forEach((r) => {
      const color = r.severity === 'high' ? 'var(--tb-error)'
                  : r.severity === 'medium' ? 'var(--tb-warn)'
                  : 'var(--tb-track-consult)';
      const proType = PROFESSIONAL_TYPES.find((p) => p.id === r.recommended_type);
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
          r.icon + ' ' + t(r.title_key, r.title_data || {})),
        el('p', { style: { margin: 0, fontSize: 'var(--tb-fs-14)' } },
          t(r.body_key, r.body_data || {})),
        proType
          ? el('div', { class: 'tb-field-help', style: { marginTop: '6px' } },
              t('consult.reminder.recommended') + ': ' + proType.label_en)
          : null,
      ));
    });

    return card;
  }

  // ─── Professionals roster ─────────────────────────────────────────

  function buildProfessionalsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const professionals = getProfessionals();

    const card = el('div', { class: 'tb-card', 'data-track': 'consult' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🧑‍💼 ' + t('consult.section.professionals')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openProfessionalModal(null) }, '＋ ' + t('consult.add_professional')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('consult.professionals.intro')));

    if (professionals.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('consult.professionals.empty')));
      return card;
    }

    professionals.forEach((p) => {
      const typeMeta = PROFESSIONAL_TYPES.find((x) => x.id === p.type) || {};
      const typeLabel = lang === 'ja' ? typeMeta.label_jp : typeMeta.label_en;
      const statusMeta = RETAINER_STATUS.find((x) => x.id === p.retainer_status) || {};
      let statusColor = 'var(--tb-text-soft)';
      if (p.retainer_status === 'engaged') statusColor = 'var(--tb-success)';
      else if (p.retainer_status === 'on_call') statusColor = 'var(--tb-track-consult)';

      const consultCount = getConsultLog().filter((c) => c.professional_id === p.id).length;

      card.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-consult)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      },
        el('div', { style: { flex: '1', minWidth: '180px' } },
          el('div', { style: { fontWeight: '600' } },
            p.name + (p.firm ? ' · ' + p.firm : '')),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
            (typeLabel || '—') + (p.specialty ? ' · ' + p.specialty : '') +
            (p.city || p.jurisdiction ? ' · ' + [p.city, p.jurisdiction].filter(Boolean).join(', ') : '')),
          consultCount > 0
            ? el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
                '📝 ' + consultCount + ' ' + t('consult.consultations_count'))
            : null,
        ),
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)' } },
          el('span', { style: { color: statusColor, fontSize: 'var(--tb-fs-12)', fontWeight: '600' } },
            statusMeta.label_en || '—'),
          el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => openConsultationModal(null, p.id) }, '＋ ' + t('consult.log_consult')),
          el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => openProfessionalModal(p) }, '✎'),
        ),
      ));
    });

    return card;
  }

  function openProfessionalModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isNew = !existing;
    const draft = Object.assign({
      id: uuid('pro-'), name: '', type: 'cpa_us_intl', firm: '',
      contact: '', city: '', jurisdiction: '', specialty: '',
      retainer_status: 'engaged', notes: '',
      created_at: new Date().toISOString(),
    }, existing || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isNew ? t('consult.modal.add_professional') : t('consult.modal.edit_professional')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('consult.field.name'),
      el('input', { type: 'text', class: 'tb-input', value: draft.name,
        oninput: (e) => { draft.name = e.target.value; } })));
    modal.appendChild(field(t('consult.field.type'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.type = e.target.value; } },
        ...PROFESSIONAL_TYPES.map((typ) => el('option', {
          value: typ.id, selected: draft.type === typ.id,
        }, lang === 'ja' ? typ.label_jp : typ.label_en)),
      )));
    modal.appendChild(field(t('consult.field.firm'),
      el('input', { type: 'text', class: 'tb-input', value: draft.firm,
        placeholder: 'e.g. "Sakura Tax Office", "Sample Expat CPA"',
        oninput: (e) => { draft.firm = e.target.value; } })));
    modal.appendChild(field(t('consult.field.contact'),
      el('input', { type: 'text', class: 'tb-input', value: draft.contact,
        placeholder: 'Email / phone / LINE',
        oninput: (e) => { draft.contact = e.target.value; } })));

    const locRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    locRow.appendChild(field(t('consult.field.city'),
      el('input', { type: 'text', class: 'tb-input', value: draft.city,
        oninput: (e) => { draft.city = e.target.value; } })));
    locRow.appendChild(field(t('consult.field.jurisdiction'),
      el('input', { type: 'text', class: 'tb-input', value: draft.jurisdiction,
        placeholder: 'e.g. "Tokyo", "California"',
        oninput: (e) => { draft.jurisdiction = e.target.value; } })));
    modal.appendChild(locRow);

    modal.appendChild(field(t('consult.field.specialty'),
      el('input', { type: 'text', class: 'tb-input', value: draft.specialty,
        placeholder: 'e.g. "PFIC, expat tax, JP estate"',
        oninput: (e) => { draft.specialty = e.target.value; } }),
      t('consult.field.specialty.help')));

    modal.appendChild(field(t('consult.field.retainer_status'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.retainer_status = e.target.value; } },
        ...RETAINER_STATUS.map((s) => el('option', {
          value: s.id, selected: draft.retainer_status === s.id,
        }, s.label_en)),
      )));

    modal.appendChild(field(t('consult.field.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)' } });
    if (!isNew) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          if (confirm(t('consult.confirm.delete_professional'))) {
            setProfessionals(getProfessionals().filter((x) => x.id !== draft.id));
            close(); rerender();
          }
        } }, '🗑 ' + t('consult.delete')));
    } else {
      btnRow.appendChild(el('div', null));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('consult.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        draft.updated_at = new Date().toISOString();
        upsertProfessional(draft);
        close(); rerender();
      } }, t('consult.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Consultation log ────────────────────────────────────────────

  function buildLogCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const log = getConsultLog().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const professionals = getProfessionals();

    const card = el('div', { class: 'tb-card', 'data-track': 'consult' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '📝 ' + t('consult.section.log')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openConsultationModal(null) }, '＋ ' + t('consult.log_consult')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('consult.log.intro')));

    if (log.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('consult.log.empty')));
      return card;
    }

    log.slice(0, 30).forEach((c) => {
      const pro = professionals.find((p) => p.id === c.professional_id);
      const followUpStale = c.follow_up_needed && c.follow_up_date &&
        new Date(c.follow_up_date) < new Date();
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (followUpStale ? 'var(--tb-warn)' : 'var(--tb-track-consult)'),
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
          el('div', null,
            el('div', { style: { fontWeight: '600' } }, c.topic || '(no topic)'),
            el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
              (pro ? pro.name + (pro.firm ? ' · ' + pro.firm : '') : '(unknown professional)') +
              ' · ' + (c.date || '—') +
              (c.related_module ? ' · ' + c.related_module : '')),
          ),
          el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => openConsultationModal(c) }, '✎'),
        ),
        c.summary
          ? el('div', { style: { marginTop: '6px', fontSize: 'var(--tb-fs-14)' } }, c.summary)
          : null,
        followUpStale
          ? el('div', { style: { marginTop: '4px', color: 'var(--tb-warn)', fontSize: 'var(--tb-fs-12)' } },
              '⏰ ' + t('consult.followup_overdue', { date: c.follow_up_date }))
          : (c.follow_up_needed && c.follow_up_date
              ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
                  '📅 ' + t('consult.followup_scheduled', { date: c.follow_up_date }))
              : null),
      ));
    });

    if (log.length > 30) {
      card.appendChild(el('p', { class: 'tb-field-help' },
        t('consult.log.more', { count: log.length - 30 })));
    }

    return card;
  }

  function openConsultationModal(existing, defaultProfessionalId) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const isNew = !existing;
    const draft = Object.assign({
      id: uuid('cons-'),
      professional_id: defaultProfessionalId || (getProfessionals()[0] && getProfessionals()[0].id) || '',
      date: new Date().toISOString().slice(0, 10),
      topic: '',
      summary: '',
      follow_up_needed: false,
      follow_up_date: null,
      related_module: '',
      notes: '',
    }, existing || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isNew ? t('consult.modal.log_consult') : t('consult.modal.edit_consult')));

    const professionals = getProfessionals();
    if (professionals.length === 0) {
      modal.appendChild(el('p', { class: 'tb-card-meta' }, t('consult.modal.no_pros_first')));
      modal.appendChild(el('button', { class: 'tb-btn', type: 'button',
        style: { marginTop: 'var(--tb-sp-2)' },
        onclick: () => { close(); openProfessionalModal(null); } }, '＋ ' + t('consult.add_professional')));
      const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' } });
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('consult.cancel')));
      modal.appendChild(btnRow);
      root.innerHTML = '';
      root.appendChild(backdrop);
      return;
    }

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('consult.field.professional'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.professional_id = e.target.value; } },
        ...professionals.map((p) => el('option', {
          value: p.id, selected: draft.professional_id === p.id,
        }, p.name + (p.firm ? ' (' + p.firm + ')' : ''))),
      )));

    const dtRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    dtRow.appendChild(field(t('consult.field.date'),
      el('input', { type: 'date', class: 'tb-input', value: draft.date,
        oninput: (e) => { draft.date = e.target.value; } })));
    dtRow.appendChild(field(t('consult.field.related_module'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.related_module = e.target.value || ''; } },
        el('option', { value: '', selected: !draft.related_module }, '—'),
        ...RELATED_MODULES.map((m) => el('option', {
          value: m, selected: draft.related_module === m,
        }, m)),
      )));
    modal.appendChild(dtRow);

    modal.appendChild(field(t('consult.field.topic'),
      el('input', { type: 'text', class: 'tb-input', value: draft.topic,
        placeholder: 'e.g. "PFIC mitigation strategy"',
        oninput: (e) => { draft.topic = e.target.value; } })));

    modal.appendChild(field(t('consult.field.summary'),
      el('textarea', { class: 'tb-input', rows: 4,
        placeholder: t('consult.field.summary.placeholder'),
        oninput: (e) => { draft.summary = e.target.value; } }, draft.summary || ''),
      t('consult.field.summary.help')));

    const fuCheck = el('input', { type: 'checkbox', checked: !!draft.follow_up_needed,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.follow_up_needed = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        fuCheck, t('consult.field.follow_up_needed'))));

    modal.appendChild(field(t('consult.field.follow_up_date'),
      el('input', { type: 'date', class: 'tb-input',
        value: draft.follow_up_date || '',
        oninput: (e) => { draft.follow_up_date = e.target.value || null; } }),
      t('consult.field.follow_up_date.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)' } });
    if (!isNew) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          if (confirm(t('consult.confirm.delete_consult'))) {
            setConsultLog(getConsultLog().filter((x) => x.id !== draft.id));
            close(); rerender();
          }
        } }, '🗑 ' + t('consult.delete')));
    } else {
      btnRow.appendChild(el('div', null));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('consult.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        upsertConsultation(draft);
        close(); rerender();
      } }, t('consult.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Resources ────────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'consult' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('consult.section.resources')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('consult.resources.intro')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-consult)',
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
    card.appendChild(resource(t('consult.resources.aicpa.title'), t('consult.resources.aicpa.body'),
      'https://www.aicpa-cima.com/resources/landing/find-a-cpa'));
    card.appendChild(resource(t('consult.resources.tokyo_lawyers.title'), t('consult.resources.tokyo_lawyers.body'),
      'https://www.toben.or.jp/english/'));
    card.appendChild(resource(t('consult.resources.va_accredited.title'), t('consult.resources.va_accredited.body'),
      'https://www.va.gov/ogc/apps/accreditation/index.asp'));
    card.appendChild(resource(t('consult.resources.aila.title'), t('consult.resources.aila.body'),
      'https://www.ailalawyer.com/'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genFollowUpOverdue() {
    const out = [];
    getConsultLog().forEach((c) => {
      if (!c.follow_up_needed || !c.follow_up_date) return;
      const days = Math.floor((Date.now() - new Date(c.follow_up_date).getTime()) / 86400000);
      if (days < 0 || days > 365) return;
      const pro = getProfessionals().find((p) => p.id === c.professional_id);
      out.push({
        id: 'consult_followup_' + c.id,
        group: 'consult',
        urgency: days > 60 ? 'high' : 'medium',
        icon: '⏰',
        title: 'Follow-up overdue: ' + (c.topic || '(consultation)') + ' with ' + (pro ? pro.name : '(unknown)'),
        body: 'Originally scheduled to follow up by ' + c.follow_up_date + '. Overdue by ' + days + ' days. Open Consultations module to update or schedule new consultation.',
        deadline: c.follow_up_date,
        module: 'consultations', snoozable: true,
      });
    });
    return out;
  }

  function genSpecialistRecommended() {
    const out = [];
    const reminders = buildReminders();
    reminders.forEach((r) => {
      // Skip the follow-up reminder — that's covered by genFollowUpOverdue
      if (r.title_key === 'consult.reminder.followup.title') return;
      out.push({
        id: 'consult_recommended_' + (r.title_key || '').replace(/\W/g, '_'),
        group: 'consult',
        urgency: r.severity || 'medium',
        icon: r.icon || '👔',
        title: TB.i18n.t(r.title_key, r.title_data || {}),
        body: TB.i18n.t(r.body_key, r.body_data || {}) +
          (r.recommended_type
            ? ' Recommended type: ' + (PROFESSIONAL_TYPES.find((p) => p.id === r.recommended_type) || {}).label_en
            : ''),
        module: 'consultations', snoozable: true,
      });
    });
    return out;
  }

  // ====================================================================
  // Module registration
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Consultations', label_jp: 'コンサルテーション', render,
    searchSections: SECTIONS,
  };

  window.TB.consultations = {
    actionGenerators: [genFollowUpOverdue, genSpecialistRecommended],
    PROFESSIONAL_TYPES, RETAINER_STATUS, RELATED_MODULES,
    buildReminders,
  };
})();
