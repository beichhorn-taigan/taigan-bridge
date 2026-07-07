/* Taigan Bridge — modules/contacts.js
 *
 * Contacts — unified address book that pulls together every contact
 * that's anywhere in the user's Taigan Bridge state, plus a set of
 * built-in contacts derived from their onboarding (VA for veterans,
 * US Embassy Tokyo for JP-resident citizens, etc.), plus manually-
 * entered personal contacts (family, professionals, friends).
 *
 * Design:
 *   • Auto-derived contacts are NEVER stored — they re-compute on
 *     every render so changes elsewhere flow through immediately.
 *   • Manual contacts live at `contacts.entries`.
 *   • Each contact has an "✨ Enhance with AI" button that calls
 *     TB.ai.callClaudeForProviderEnrichment to fill missing fields
 *     from public knowledge (website, phone, hours, address).
 *   • Built-in onboarding-driven contacts are tagged `builtin: true`
 *     so they can't be deleted (only dismissed via settings).
 *   • Categories: emergency, family, medical, dental, insurance,
 *     financial, military_va, us_government, japan_government,
 *     professional, personal.
 */

(function () {
  'use strict';

  const id = 'contacts';

  // ====================================================================
  // i18n — small literals not covered by the shared dictionary
  // (auto-derived insurance-contact labels + source-pill / AI-enhance
  // strings). Registered here via TB.i18n.extend() so this module can
  // self-contain its own translation table instead of touching the
  // shared i18n.js dictionary.
  // ====================================================================

  TB.i18n.extend('en', {
    'contacts.insurance.dental':      'Dental insurance',
    'contacts.insurance.vision':      'Vision insurance',
    'contacts.insurance.coverage':    'Coverage: {{value}}',
    'contacts.insurance.network':     'Network: {{value}}',
    'contacts.enhanced_by_ai':        'Enhanced by AI: {{notes}}',
    'contacts.visits_count':          '{{count}} visits',
  });

  TB.i18n.extend('ja', {
    'contacts.insurance.dental':      '歯科保険',
    'contacts.insurance.vision':      '視力保険',
    'contacts.insurance.coverage':    '適用範囲: {{value}}',
    'contacts.insurance.network':     'ネットワーク: {{value}}',
    'contacts.enhanced_by_ai':        'AI による補完: {{notes}}',
    'contacts.visits_count':          '{{count}} 回受診',
  });

  // ====================================================================
  // Categories
  // ====================================================================
  // Order = display order on the page. Each category has an icon +
  // i18n key suffix (resolved as ht-style 'contacts.cat.<id>').
  const CATEGORIES = [
    { id: 'emergency',          icon: '🚨', accent: 'var(--tb-error)' },
    { id: 'family',             icon: '👨‍👩‍👧', accent: 'var(--tb-track-family, var(--tb-track-health))' },
    { id: 'medical',            icon: '🏥', accent: 'var(--tb-track-health)' },
    { id: 'dental',             icon: '🦷', accent: '#a87fbf' },
    { id: 'insurance',          icon: '🛡️', accent: 'var(--tb-track-health)' },
    { id: 'financial',          icon: '🏦', accent: 'var(--tb-track-fbar, var(--tb-track-health))' },
    { id: 'military_va',        icon: '🪖', accent: 'var(--tb-track-veteran, var(--tb-warn))' },
    { id: 'us_government',      icon: '🇺🇸', accent: 'var(--tb-text)' },
    { id: 'japan_government',   icon: '🇯🇵', accent: 'var(--tb-text)' },
    { id: 'professional',       icon: '💼', accent: 'var(--tb-track-ai)' },
    { id: 'personal',           icon: '👥', accent: 'var(--tb-text-soft)' },
  ];

  // ====================================================================
  // State accessors — manual contacts only. Auto-derived live in code.
  // ====================================================================
  function getManualContacts() { return TB.state.get('contacts.entries') || []; }
  function setManualContacts(arr) { TB.state.set('contacts.entries', arr); }
  function upsertManualContact(c) {
    const arr = getManualContacts().slice();
    const i = arr.findIndex((x) => x.id === c.id);
    c.updated_at = new Date().toISOString();
    if (i >= 0) arr[i] = c;
    else arr.push(c);
    setManualContacts(arr);
  }
  function deleteManualContact(cid) {
    setManualContacts(getManualContacts().filter((x) => x.id !== cid));
  }
  // Dismissed built-ins (user explicitly hid them) — keyed by id
  function getDismissed() { return TB.state.get('contacts.dismissed') || {}; }
  function setDismissedFlag(cid, val) {
    const m = getDismissed();
    if (val) m[cid] = true; else delete m[cid];
    TB.state.set('contacts.dismissed', m);
  }

  // Deterministic sync string hash (djb2 variant) — used to build stable
  // auto-contact ids from arbitrary keys. Unlike slugifying (which strips
  // all non-ASCII chars via /[^a-z0-9]+/), this hashes the raw Unicode
  // string, so distinct Japanese-only names (e.g. 楽天銀行 vs ソニー銀行)
  // never collide just because they have no ASCII characters to keep.
  // TB.utils.sha256 (if present) is async-only, so we don't use it here.
  function hashKey(s) {
    const str = String(s || '');
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  // ====================================================================
  // Auto-derivation from every other module's state
  // ====================================================================
  //
  // Walks all relevant state and returns a flat array of contact
  // entries with `auto: true`. Each entry knows its `source` so we
  // can render a small back-ref pill ("from Assets · Sony Bank account").
  // No persistence — runs fresh every render.
  function deriveAutoContacts() {
    const out = [];

    // ─── Asset accounts → financial contacts
    const accts = TB.state.get('assets.accounts') || [];
    const seenInstitutions = new Set();
    for (const a of accts) {
      const inst = (a.institution || '').trim();
      if (!inst) continue;
      const key = (inst + '|' + (a.country || '')).toLowerCase();
      if (seenInstitutions.has(key)) continue;
      seenInstitutions.add(key);
      out.push({
        id: 'auto-assets-' + hashKey(key),
        category: 'financial',
        name: inst,
        organization: inst,
        country: a.country || null,
        type: labelForAccount(a),
        phone: a.support_phone || '',
        email: a.support_email || '',
        website: a.website || '',
        address: a.address || '',
        notes: a.support_notes || a.notes || '',
        source: 'assets',
        source_label_en: 'Asset accounts',
        source_label_jp: '資産口座',
        source_count: 1,
        auto: true,
      });
    }
    // Bump count when multiple accounts share an institution
    for (const a of accts) {
      const inst = (a.institution || '').trim();
      if (!inst) continue;
      const id = 'auto-assets-' + hashKey((inst + '|' + (a.country || '')).toLowerCase());
      const c = out.find((x) => x.id === id);
      if (c) c.source_count = (c.source_count || 1);
    }

    // ─── Dental providers → dental contacts
    const dental = TB.state.get('health_tracker.dental') || {};
    for (const p of (dental.providers || [])) {
      out.push({
        id: 'auto-dental-' + p.id,
        category: 'dental',
        name: p.name_en || p.name_jp || '?',
        name_jp: p.name_jp || '',
        organization: p.name_en || p.name_jp || '?',
        type: p.type || (TB.i18n.getLang() === 'ja' ? '歯科' : 'Dental'),
        phone: p.phone || '',
        email: p.email || '',
        website: p.website || '',
        address: p.address || '',
        hours: p.hours || '',
        notes: p.notes || '',
        source: 'dental',
        source_label_en: 'Dental providers',
        source_label_jp: '歯科受診先',
        source_ref: p.id,
        ai_enriched_at: p.ai_enriched_at || null,
        auto: true,
      });
    }

    // ─── Insurance cards → insurance contacts
    const insSummary = TB.state.get('health_tracker.insurance_summary') || {};
    for (const c of (insSummary.cards || [])) {
      if (!c.insurer && !c.plan_name) continue;
      const phones = [
        { label_en: 'Customer service',  label_jp: 'カスタマーサービス', value: c.customer_service_phone },
        { label_en: 'Member services',   label_jp: '会員サービス',       value: c.member_services_phone },
        { label_en: 'Claims',            label_jp: '請求受付',           value: c.claims_phone },
        { label_en: 'Pharmacy help',     label_jp: '薬局サポート',       value: c.pharmacy_help_phone },
        { label_en: 'Provider services', label_jp: '医療機関窓口',       value: c.provider_services_phone },
        { label_en: 'Emergency / 24/7',  label_jp: '救急 / 24 時間',     value: c.emergency_phone },
        { label_en: 'Nurse line',        label_jp: 'ナースライン',       value: c.nurse_line_phone },
        { label_en: 'Mental health',     label_jp: 'メンタルヘルス',     value: c.mental_health_phone },
      ].filter((p) => p.value);
      out.push({
        id: 'auto-insurance-' + c.id,
        category: 'insurance',
        name: c.insurer || c.plan_name,
        organization: [c.insurer, c.plan_name].filter(Boolean).join(' — '),
        type: c.card_type === 'dental' ? TB.i18n.t('contacts.insurance.dental')
            : c.card_type === 'vision' ? TB.i18n.t('contacts.insurance.vision')
            : c.card_type === 'prescription' ? 'Prescription'
            : c.network_type || 'Health insurance',
        phone: c.customer_service_phone || c.member_services_phone || c.claims_phone || '',
        phones,  // multi-phone display
        email: c.email || '',
        website: c.member_portal || c.claims_website || '',
        secondary_website: c.member_portal && c.claims_website && c.member_portal !== c.claims_website ? c.claims_website : '',
        address: c.claims_address || '',
        mobile_app: c.mobile_app || '',
        notes: [c.coverage_areas ? TB.i18n.t('contacts.insurance.coverage', { value: c.coverage_areas }) : '',
                c.network_type ? TB.i18n.t('contacts.insurance.network', { value: c.network_type }) : ''].filter(Boolean).join('\n'),
        source: 'insurance',
        source_label_en: 'Insurance cards',
        source_label_jp: '保険証',
        source_ref: c.id,
        auto: true,
      });
    }

    // ─── Medical exam providers → medical contacts
    //
    // Group by FACILITY (clinic) when present — multiple exams at the
    // same clinic with different doctors should produce ONE contact
    // for the clinic, with all the doctors listed as practitioners.
    // Falls back to provider name when no facility is given.
    //
    // Match-key normalization handles real-world fuzz: trailing
    // "Clinic / 医院 / クリニック", hyphen vs. space, half/full-width
    // punctuation. So "Sakura Yoyogi Clinic" and "Sakura
    // Yoyogi-Clinic" collapse to one group. Cross-language
    // mismatches (English-only on one exam, Japanese-only on another)
    // still won't collapse here — Claude provider enrichment fills in
    // the missing-language name, which then unifies subsequent passes.
    const exams = TB.state.get('health_tracker.exams') || [];
    function medGroupKey(s) {
      return String(s || '')
        .toLowerCase()
        // strip whitespace, hyphens, full/half-width separators, commas
        .replace(/[\s\-‐−ー－,，、・]+/g, '')
        // drop common clinic-suffix variations so "Foo Clinic" and "Foo"
        // collapse — they're the same place on different paperwork
        .replace(/(clinic|hospital|医院|病院|クリニック)$/i, '');
    }
    const medByKey = new Map();
    for (const e of exams) {
      const provider = (e.provider || '').trim();
      const facility = (e.facility || '').trim();
      if (!provider && !facility) continue;
      const groupName = facility || provider;
      const key = medGroupKey(groupName);
      if (!key) continue; // pure punctuation / empty after normalization
      if (!medByKey.has(key)) {
        medByKey.set(key, {
          name: groupName,
          facility: facility || '',
          practitioners: new Set(),
          exam_ids: [],
          latest_date: e.date || '',
        });
      }
      const rec = medByKey.get(key);
      // Only add provider to practitioners if it's clearly a person
      // (different from the facility name). Some exams use the clinic
      // name in the provider field — don't list a clinic as a doctor.
      if (provider && provider !== facility && provider !== groupName) {
        rec.practitioners.add(provider);
      }
      rec.exam_ids.push(e.id);
      if (e.date && e.date > rec.latest_date) rec.latest_date = e.date;
      // Prefer the longest name variant we've seen for display — a
      // later exam may have a more complete name (e.g., adds "Clinic"
      // back, or adds the city qualifier).
      if (groupName.length > rec.name.length) rec.name = groupName;
      if (facility && facility.length > rec.facility.length) rec.facility = facility;
    }
    medByKey.forEach((rec, key) => {
      // Don't duplicate when already captured as a dental provider.
      // Compare using the same normalization so "Foo Clinic" (dental)
      // and "Foo" (medical exam, no suffix) deduplicate correctly.
      const dupOfDental = (dental.providers || []).some((p) =>
        (p.name_en && medGroupKey(p.name_en) === key) ||
        (p.name_jp && medGroupKey(p.name_jp) === key)
      );
      if (dupOfDental) return;
      const doctors = Array.from(rec.practitioners);
      const lang = TB.i18n.getLang();
      out.push({
        id: 'auto-exam-' + hashKey(key),
        category: 'medical',
        name: rec.name,
        organization: rec.facility || rec.name,
        type: lang === 'ja' ? '医療機関' : 'Medical provider',
        practitioners: doctors,
        // Practitioners render as their own row below the source pill;
        // don't duplicate them into the notes blob.
        notes: '',
        source: 'exams',
        source_label_en: 'Medical exams',
        source_label_jp: '受診記録',
        source_count: rec.exam_ids.length,
        auto: true,
      });
    });

    // ─── Family members → family contacts
    //
    // family.js stores members with name_en/name_jp (see FIELDS.familyMember)
    // — there is no name/display_name/phone/email/address/birth_year/
    // is_emergency_contact on the real record. Prefer name_en with a
    // name_jp fallback (mirrors the display convention used throughout
    // family.js, e.g. its member list / gift-recipient rendering: JP name
    // shown only when UI lang is 'ja' AND a JP name exists, else EN name).
    const familyMembers = TB.state.get(TB.schema.PATHS.familyMembers) || [];
    const famF = TB.schema.FIELDS.familyMember;
    for (const m of familyMembers) {
      const lang = TB.i18n.getLang();
      const nameEn = m[famF.nameEn] || '';
      const nameJp = m[famF.nameJp] || '';
      const name = (lang === 'ja' && nameJp) ? nameJp : (nameEn || nameJp);
      if (!name) continue;
      out.push({
        id: 'auto-family-' + (m.id || name).replace(/[^a-z0-9]+/gi, '-'),
        category: 'family',
        name,
        name_jp: nameJp && nameJp !== name ? nameJp : '',
        type: m.relationship || (lang === 'ja' ? '家族' : 'Family'),
        notes: m.notes || '',
        source: 'family',
        source_label_en: 'Family members',
        source_label_jp: '家族メンバー',
        source_ref: m.id || name,
        auto: true,
      });
    }

    // ─── Consultations professionals roster (CPA, lawyers, tax advisors)
    // → professional contacts
    //
    // consultations.js keeps a roster at consultations.professionals with
    // fields: id, name, type, firm, contact, city, jurisdiction, specialty,
    // retainer_status, notes — NOT consultant_name/contact_name/role/
    // consultant_type, and NOT separate phone/email (just a free-text
    // "contact" field, e.g. "Email / phone / LINE"). The consultation LOG
    // entries (consultations.consultations) are visit history, not a
    // contacts roster, so they're intentionally not read here.
    const professionals = TB.state.get(TB.schema.PATHS.consultationsProfessionals) || [];
    const seenConsultants = new Set();
    for (const p of professionals) {
      const name = p.name || '';
      if (!name) continue;
      const key = name.toLowerCase();
      if (seenConsultants.has(key)) continue;
      seenConsultants.add(key);
      out.push({
        id: 'auto-consult-' + key.replace(/[^a-z0-9]+/g, '-'),
        category: 'professional',
        name,
        organization: p.firm || '',
        type: p.specialty || p.type || (TB.i18n.getLang() === 'ja' ? '顧問' : 'Advisor'),
        notes: [p.contact ? 'Contact: ' + p.contact : '',
                p.city || p.jurisdiction ? [p.city, p.jurisdiction].filter(Boolean).join(', ') : '',
                p.notes || ''].filter(Boolean).join('\n'),
        source: 'consultations',
        source_label_en: 'Consultations',
        source_label_jp: '相談履歴',
        source_ref: p.id,
        auto: true,
      });
    }

    // ─── Built-in onboarding-derived contacts
    deriveBuiltinContacts(out);

    return out;
  }

  // Onboarding-derived hardcoded contacts. The set surfaces based on
  // the user's profile state: veteran, SOFA, in_japan, citizenship.
  // Each is tagged `builtin: true` and dismissable via
  // `contacts.dismissed`.
  //
  // Field names mirror what the onboarding (src/content/inline.js)
  // actually stores in TB.state.get('onboarding.answers'):
  //   in_japan:     'yes' | 'partial' | 'planning' | 'no'
  //   visa:         'sofa' | 'spouse_jp' | 'work' | 'permanent' | 'long_term' | 'other'
  //   citizenship:  'us_only' | 'us_dual' | 'us_lpr' | 'us_jp_dual'
  //   veteran:      'no' | 'active' | 'reserve_ng' | 'retired' | 'separated_no_dis' | 'separated_with_dis'
  //   employment:   'dod_active' | 'dod_civilian' | 'dod_contractor' | ...
  function deriveBuiltinContacts(out) {
    const a = TB.state.get('onboarding.answers') || {};
    const dismissed = getDismissed();
    function push(c) {
      if (dismissed[c.id]) return;
      out.push(c);
    }

    // ─── Derived flags from onboarding answers
    const inJapan = a.in_japan === 'yes' || a.in_japan === 'partial' ||
      a.in_japan === 'planning';
    const isJPResident = a.in_japan === 'yes' || a.in_japan === 'partial';
    const isUSCitizen = typeof a.citizenship === 'string' &&
      a.citizenship.startsWith('us_');
    const isVeteran = a.veteran && a.veteran !== 'no';
    const isSofa = a.visa === 'sofa' || a.employment === 'dod_active' ||
      a.employment === 'dod_civilian' || a.employment === 'dod_contractor';
    const isUSResident = a.in_japan === 'no' && isUSCitizen;

    // ─── Emergency numbers — Japan
    if (inJapan) {
      push({
        id: 'builtin-emergency-jp-110',
        category: 'emergency',
        name: 'Police (警察)',
        type: 'Emergency · Japan',
        phone: '110',
        notes: 'Free from any phone. English support varies — say "English please".',
        source: 'builtin',
        source_label_en: 'Built-in · Japan',
        source_label_jp: '組込・日本',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-emergency-jp-119',
        category: 'emergency',
        name: 'Fire / Ambulance (消防・救急)',
        type: 'Emergency · Japan',
        phone: '119',
        notes: 'Free from any phone. Say "救急車" for ambulance, "火事" for fire.',
        source: 'builtin', source_label_en: 'Built-in · Japan', source_label_jp: '組込・日本',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-emergency-jp-7119',
        category: 'emergency',
        name: 'Medical Advice (救急安心センター)',
        type: 'Non-emergency · Japan',
        phone: '#7119',
        notes: 'Tokyo / major-city non-emergency medical advice line.',
        source: 'builtin', source_label_en: 'Built-in · Japan', source_label_jp: '組込・日本',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-emergency-jp-aminet',
        category: 'emergency',
        name: 'AMINET English Helpline',
        type: 'English medical · Japan',
        phone: '03-5774-0992',
        website: 'https://himawari.metro.tokyo.lg.jp/qq/qq13enmnlt.asp',
        notes: 'Tokyo Metro government English-language medical info / interpretation.',
        source: 'builtin', source_label_en: 'Built-in · Japan', source_label_jp: '組込・日本',
        auto: true, builtin: true,
      });
    }
    if (isUSResident) {
      push({
        id: 'builtin-emergency-us-911',
        category: 'emergency',
        name: 'Emergency (911)',
        type: 'Emergency · US',
        phone: '911',
        notes: 'Police, fire, ambulance.',
        source: 'builtin', source_label_en: 'Built-in · US', source_label_jp: '組込・米国',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-emergency-us-988',
        category: 'emergency',
        name: 'Suicide & Crisis Lifeline (988)',
        type: 'Crisis · US',
        phone: '988',
        website: 'https://988lifeline.org',
        notes: 'Mental health crisis hotline. Call or text 988.',
        source: 'builtin', source_label_en: 'Built-in · US', source_label_jp: '組込・米国',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-emergency-us-poison',
        category: 'emergency',
        name: 'Poison Control (1-800-222-1222)',
        type: 'Poison · US',
        phone: '1-800-222-1222',
        website: 'https://www.poison.org',
        notes: 'AAPCC nationwide poison control hotline.',
        source: 'builtin', source_label_en: 'Built-in · US', source_label_jp: '組込・米国',
        auto: true, builtin: true,
      });
    }

    // ─── Veteran-derived (any non-'no' veteran status)
    if (isVeteran) {
      push({
        id: 'builtin-va-main',
        category: 'military_va',
        name: 'US Department of Veterans Affairs (VA)',
        organization: 'VA',
        type: 'Federal · Benefits',
        phone: '1-800-827-1000',
        website: 'https://www.va.gov',
        notes: 'Main benefits info line — claims, appointments, healthcare. Mon-Fri 8am-9pm ET.',
        source: 'builtin', source_label_en: 'Built-in · Veteran', source_label_jp: '組込・退役軍人',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-va-fmp',
        category: 'military_va',
        name: 'VA Foreign Medical Program (FMP)',
        organization: 'VA / FMP',
        type: 'Federal · Healthcare abroad',
        phone: '+1-303-331-7590',
        email: 'hac.fmp@va.gov',
        website: 'https://www.va.gov/communitycare/programs/veterans/fmp/index.asp',
        notes: 'VA healthcare program for veterans living outside the US. Pre-authorization required for non-emergency care.',
        source: 'builtin', source_label_en: 'Built-in · Veteran', source_label_jp: '組込・退役軍人',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-deers',
        category: 'military_va',
        name: 'DEERS / DMDC',
        organization: 'Defense Manpower Data Center',
        type: 'Federal · Eligibility',
        phone: '1-800-538-9552',
        website: 'https://www.dmdc.osd.mil/milconnect',
        notes: 'Defense Enrollment Eligibility Reporting System. Update dependent records, get ID cards.',
        source: 'builtin', source_label_en: 'Built-in · Veteran', source_label_jp: '組込・退役軍人',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-tricare-overseas',
        category: 'military_va',
        name: 'TRICARE Overseas (Pacific)',
        organization: 'TRICARE',
        type: 'Federal · Healthcare',
        phone: '+81-3-3559-2148',
        website: 'https://www.tricare-overseas.com',
        notes: 'TRICARE Overseas Pacific contractor. Stateside toll-free: 1-877-988-9378.',
        source: 'builtin', source_label_en: 'Built-in · Veteran', source_label_jp: '組込・退役軍人',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-mypay',
        category: 'military_va',
        name: 'myPay / DFAS',
        organization: 'Defense Finance and Accounting Service',
        type: 'Federal · Pay',
        phone: '1-888-332-7411',
        website: 'https://mypay.dfas.mil',
        notes: 'Military / VA / federal civilian pay statements + W-2s + 1099-R for retirees.',
        source: 'builtin', source_label_en: 'Built-in · Veteran', source_label_jp: '組込・退役軍人',
        auto: true, builtin: true,
      });
    }

    // ─── US citizens living in Japan — federal services
    if (isUSCitizen && isJPResident) {
      push({
        id: 'builtin-us-embassy-tokyo',
        category: 'us_government',
        name: 'US Embassy Tokyo',
        organization: 'US Department of State',
        type: 'Federal · Consular',
        phone: '+81-3-3224-5000',
        website: 'https://jp.usembassy.gov',
        address: '1-10-5 Akasaka, Minato-ku, Tokyo 107-8420',
        notes: 'American Citizen Services, passport renewals, voting, federal benefits, notarial services.',
        source: 'builtin', source_label_en: 'Built-in · US citizen abroad', source_label_jp: '組込・在外米国市民',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-ssa-fbu-manila',
        category: 'us_government',
        name: 'SSA Federal Benefits Unit (Manila)',
        organization: 'Social Security Administration',
        type: 'Federal · Benefits',
        phone: '+63-2-5301-2000',
        email: 'FBU.Manila@ssa.gov',
        website: 'https://ph.usembassy.gov/u-s-citizen-services/social-security',
        notes: 'SSA office serving US citizens in Japan. Handles benefits, SSA-7162, IDs.',
        source: 'builtin', source_label_en: 'Built-in · US citizen abroad', source_label_jp: '組込・在外米国市民',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-irs-intl',
        category: 'us_government',
        name: 'IRS International Taxpayer Service',
        organization: 'Internal Revenue Service',
        type: 'Federal · Tax',
        phone: '+1-267-941-1000',
        website: 'https://www.irs.gov/individuals/international-taxpayers',
        notes: 'Tax help for US persons abroad. Mon-Fri 6am-11pm ET. Not toll-free.',
        source: 'builtin', source_label_en: 'Built-in · US citizen abroad', source_label_jp: '組込・在外米国市民',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-fbar-bsa',
        category: 'us_government',
        name: 'FinCEN BSA E-Filing Help Desk',
        organization: 'FinCEN',
        type: 'Federal · FBAR',
        phone: '+1-866-346-9478',
        email: 'BSAEFilingHelp@fincen.gov',
        website: 'https://bsaefiling.fincen.treas.gov',
        notes: 'FBAR (FinCEN 114) e-filing support.',
        source: 'builtin', source_label_en: 'Built-in · US citizen abroad', source_label_jp: '組込・在外米国市民',
        auto: true, builtin: true,
      });
    }

    // ─── Japan residents — government services
    if (isJPResident) {
      push({
        id: 'builtin-jp-immigration',
        category: 'japan_government',
        name: 'Immigration Services Agency (出入国在留管理庁)',
        organization: '法務省',
        type: '日本 · Immigration',
        phone: '0570-013-904',
        website: 'https://www.moj.go.jp/isa/',
        notes: 'Information Center for immigration/residence-card matters. English support available.',
        source: 'builtin', source_label_en: 'Built-in · Japan resident', source_label_jp: '組込・日本居住者',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-jp-nta',
        category: 'japan_government',
        name: 'National Tax Agency (国税庁)',
        organization: 'NTA',
        type: '日本 · Tax',
        website: 'https://www.nta.go.jp',
        notes: 'Tax filing (確定申告), Furusato Nozei certificates, NTA tax-advice consultation hotline by 国税局 region.',
        source: 'builtin', source_label_en: 'Built-in · Japan resident', source_label_jp: '組込・日本居住者',
        auto: true, builtin: true,
      });
      push({
        id: 'builtin-jp-mhlw-pensions',
        category: 'japan_government',
        name: 'Japan Pension Service (日本年金機構)',
        organization: '日本年金機構',
        type: '日本 · Pension',
        phone: '0570-05-1165',
        website: 'https://www.nenkin.go.jp',
        notes: 'Nenkin (kokumin nenkin / kosei nenkin) inquiries, totalization, lump-sum withdrawal (脱退一時金).',
        source: 'builtin', source_label_en: 'Built-in · Japan resident', source_label_jp: '組込・日本居住者',
        auto: true, builtin: true,
      });
    }
  }

  function labelForAccount(a) {
    const wrapper = a.tax_wrapper || a.account_type || '';
    if (!wrapper) return TB.i18n.getLang() === 'ja' ? '金融機関' : 'Financial institution';
    return wrapper;
  }

  // ====================================================================
  // Public lookup — used by other modules to surface their contacts
  // ====================================================================
  function getAllContacts() {
    const manual = getManualContacts().map((c) => Object.assign({}, c, { auto: false }));
    const auto = deriveAutoContacts();
    // Avoid showing both auto + manual for the same conceptual entity
    // when a manual entry has the same source linkage as an auto.
    const manualSourceKeys = new Set(manual.map((m) => m.linked_source || '').filter(Boolean));
    const autoFiltered = auto.filter((a) =>
      !manualSourceKeys.has(a.source + ':' + (a.source_ref || a.id)));
    return manual.concat(autoFiltered);
  }
  function getContactsByCategory(catId) {
    return getAllContacts().filter((c) => c.category === catId);
  }

  // ====================================================================
  // Render
  // ====================================================================
  //
  // The results list (category panels) lives in its own container,
  // `resultsHost`, separate from the header/search card. `rerender()`
  // only rebuilds `resultsHost` — the search <input> itself is never
  // re-created, so it keeps focus + cursor position across the debounced
  // re-renders triggered by typing. A full `render()` (used on initial
  // mount / route entry) rebuilds everything including the search card.
  let host = null;
  let resultsHost = null;
  function render(container) {
    host = container;
    container.innerHTML = '';
    container.appendChild(buildHeaderCard());
    container.appendChild(buildSearchCard());
    resultsHost = TB.utils.el('div');
    container.appendChild(resultsHost);
    renderResults();
  }
  function renderResults() {
    if (!resultsHost) return;
    resultsHost.innerHTML = '';
    const all = getAllContacts();
    const term = ((TB.state.get('contacts.search') || '') + '').toLowerCase().trim();
    const filtered = term ? all.filter((c) => matchesSearch(c, term)) : all;
    // Group by category
    const byCat = {};
    for (const c of filtered) {
      const cat = c.category || 'personal';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(c);
    }
    // Render each category in declared order
    for (const cat of CATEGORIES) {
      const items = byCat[cat.id];
      if (!items || items.length === 0) continue;
      resultsHost.appendChild(buildCategoryPanel(cat, items));
    }
    // Catch-all for any contact with an unknown/missing category
    const catSet = new Set(CATEGORIES.map((c) => c.id));
    const extras = Object.keys(byCat).filter((k) => !catSet.has(k));
    if (extras.length > 0) {
      for (const k of extras) {
        resultsHost.appendChild(buildCategoryPanel({ id: k, icon: '📞', accent: 'var(--tb-text-soft)' }, byCat[k]));
      }
    }
    if (filtered.length === 0) {
      resultsHost.appendChild(TB.utils.el('div', { class: 'tb-card' },
        TB.utils.el('p', { class: 'tb-field-help', style: { textAlign: 'center' } },
          term ? TB.i18n.t('contacts.search.none') : TB.i18n.t('contacts.empty.body')),
      ));
    }
  }
  // Full rerender — rebuilds header stats + search card + results. Used
  // after actions that can change header counts (add/delete/enhance/
  // dismiss) so the stats stay accurate. Search-input typing uses
  // renderResults() directly instead (see buildSearchCard) to preserve
  // input focus.
  function rerender() { if (host) render(host); }

  function matchesSearch(c, term) {
    const fields = [c.name, c.name_jp, c.organization, c.type, c.phone, c.email, c.website, c.address, c.notes];
    for (const f of fields) {
      if (f && String(f).toLowerCase().includes(term)) return true;
    }
    if (Array.isArray(c.phones)) {
      for (const p of c.phones) {
        if (p.value && String(p.value).toLowerCase().includes(term)) return true;
      }
    }
    return false;
  }

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card' });
    const titleRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 'var(--tb-sp-3)', flexWrap: 'wrap' },
    });
    titleRow.appendChild(el('div', null,
      el('h1', { style: { margin: 0 } }, '📇 ' + t('contacts.title')),
      el('p', { class: 'tb-card-meta', style: { margin: '4px 0 0' } }, t('contacts.intro')),
    ));
    titleRow.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => openContactEditModal(null),
    }, '+ ' + t('contacts.add')));
    card.appendChild(titleRow);
    // Stats — count by category
    const all = getAllContacts();
    const stats = el('div', {
      style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' },
    });
    stats.appendChild(el('div', null,
      el('span', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)', fontSize: '18px', color: 'var(--tb-track-health)' } },
        String(all.length)),
      el('span', { class: 'tb-card-meta', style: { marginLeft: '6px' } }, t('contacts.stats.total')),
    ));
    const autoCount = all.filter((c) => c.auto).length;
    const manualCount = all.length - autoCount;
    stats.appendChild(el('div', null,
      el('span', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)', fontSize: '18px' } },
        String(autoCount)),
      el('span', { class: 'tb-card-meta', style: { marginLeft: '6px' } }, t('contacts.stats.auto')),
    ));
    stats.appendChild(el('div', null,
      el('span', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)', fontSize: '18px' } },
        String(manualCount)),
      el('span', { class: 'tb-card-meta', style: { marginLeft: '6px' } }, t('contacts.stats.manual')),
    ));
    card.appendChild(stats);
    return card;
  }

  function buildSearchCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const wrap = el('div', { class: 'tb-card', style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)' } });
    const cur = TB.state.get('contacts.search') || '';
    const input = el('input', {
      type: 'text', class: 'tb-input', placeholder: t('contacts.search.placeholder'),
      value: cur,
      oninput: (e) => {
        TB.state.set('contacts.search', e.target.value);
        // Defer slightly to avoid laggy keystrokes. Rebuild only the
        // results list (renderResults), not the whole view — a full
        // rerender() would re-create this <input>, dropping focus and
        // cursor position on every debounce tick while the user types.
        clearTimeout(buildSearchCard._t);
        buildSearchCard._t = setTimeout(renderResults, 150);
      },
    });
    wrap.appendChild(input);
    return wrap;
  }

  function buildCategoryPanel(cat, items) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', style: { borderLeft: '3px solid ' + cat.accent } });
    const head = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    });
    head.appendChild(el('h3', { style: { margin: 0, color: cat.accent } },
      cat.icon + ' ' + t('contacts.cat.' + cat.id)));
    head.appendChild(el('span', { class: 'tb-card-meta', style: { fontSize: '11px' } },
      t('contacts.cat.count', { n: items.length })));
    card.appendChild(head);
    const list = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' },
    });
    for (const c of items) list.appendChild(buildContactCard(c));
    card.appendChild(list);
    return card;
  }

  function buildContactCard(c) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const card = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
        border: '1px solid var(--tb-border)',
        display: 'flex', flexDirection: 'column', gap: '6px',
      },
    });

    // Title row
    const titleRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' },
    });
    titleRow.appendChild(el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { style: { fontWeight: '700' } }, c.name || '?'),
      c.name_jp && c.name_jp !== c.name
        ? el('div', { class: 'tb-card-meta', style: { fontSize: '11px' } }, c.name_jp)
        : null,
      c.type ? el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '2px' } }, c.type) : null,
    ));
    // Action buttons (top-right)
    const actions = el('div', { style: { display: 'flex', gap: '2px', flexShrink: '0' } });
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (hasKey) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 6px', fontSize: '11px', color: 'var(--tb-track-ai)' },
        title: t('contacts.enhance.help'),
        onclick: async (e) => { await enhanceContact(c, e.target); rerender(); },
      }, '✨'));
    }
    if (!c.builtin) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 6px', fontSize: '11px' },
        onclick: () => openContactEditModal(c),
      }, '✎'));
    }
    if (c.builtin) {
      // Built-ins get a "hide" rather than "delete"
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 6px', fontSize: '11px', color: 'var(--tb-text-soft)' },
        title: t('contacts.dismiss.help'),
        onclick: () => {
          if (!confirm(t('contacts.dismiss.confirm', { name: c.name }))) return;
          setDismissedFlag(c.id, true);
          rerender();
        },
      }, '×'));
    } else if (!c.auto) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 6px', fontSize: '11px', color: 'var(--tb-error)' },
        onclick: () => {
          if (!confirm(t('contacts.delete.confirm', { name: c.name }))) return;
          deleteManualContact(c.id);
          rerender();
        },
      }, '×'));
    }
    titleRow.appendChild(actions);
    card.appendChild(titleRow);

    // Source pill — shows where this contact came from when auto
    if (c.auto && c.source) {
      const srcLabel = lang === 'ja' ? (c.source_label_jp || c.source) : (c.source_label_en || c.source);
      card.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.10)', color: 'var(--tb-text-soft)',
          fontWeight: '600', letterSpacing: '0.04em', textTransform: 'uppercase',
          alignSelf: 'flex-start' },
      }, (c.builtin ? '🔒 ' : '↩ ') + srcLabel +
         (c.source_count && c.source_count > 1 ? ' · ' + t('contacts.visits_count', { count: c.source_count }) : '')));
    }

    // Practitioners list — for medical clinics with multiple doctors
    if (Array.isArray(c.practitioners) && c.practitioners.length > 0) {
      card.appendChild(el('div', {
        style: { fontSize: 'var(--tb-fs-12)', display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'baseline' },
      },
        el('span', { class: 'tb-card-meta', style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em' } },
          (lang === 'ja' ? '医師' : 'Doctors') + ':'),
        ...c.practitioners.map((doc, i) => el('span', {
          style: { fontWeight: '500' },
        }, doc + (i < c.practitioners.length - 1 ? ',' : ''))),
      ));
    }

    // Phone(s) — multi-line when insurance card has many
    if (Array.isArray(c.phones) && c.phones.length > 1) {
      for (const p of c.phones) {
        card.appendChild(buildPhoneRow(p.value, lang === 'ja' ? p.label_jp : p.label_en));
      }
    } else if (c.phone) {
      card.appendChild(buildPhoneRow(c.phone, null));
    }

    // Email
    if (c.email) {
      card.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-12)' } },
        '✉ ',
        el('a', { href: 'mailto:' + c.email, style: { color: 'var(--tb-track-health)' } }, c.email),
      ));
    }
    // Website
    if (c.website) {
      const url = /^https?:\/\//.test(c.website) ? c.website : ('https://' + c.website);
      card.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-12)' } },
        '🌐 ',
        el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-track-health)', wordBreak: 'break-all' } }, c.website),
      ));
    }
    // Secondary website (insurance claims website when different from member portal)
    if (c.secondary_website) {
      const url = /^https?:\/\//.test(c.secondary_website) ? c.secondary_website : ('https://' + c.secondary_website);
      card.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-12)' } },
        '🌐 ',
        el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-track-health)', wordBreak: 'break-all' } }, c.secondary_website),
      ));
    }
    // Mobile app
    if (c.mobile_app) {
      card.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px' } },
        '📱 ' + c.mobile_app));
    }
    // Hours
    if (c.hours) {
      card.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px' } },
        '🕒 ' + c.hours));
    }
    // Address
    if (c.address) {
      card.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px', whiteSpace: 'pre-wrap' } },
        '📍 ' + c.address));
    }
    // Notes
    if (c.notes) {
      card.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px', whiteSpace: 'pre-wrap',
        marginTop: '4px', paddingTop: '4px', borderTop: '1px dashed var(--tb-border)' } },
        c.notes));
    }
    // AI-enriched indicator
    if (c.ai_enriched_at) {
      card.appendChild(el('div', {
        style: { fontSize: '10px', color: 'var(--tb-track-ai)', fontStyle: 'italic' },
      }, '✨ ' + t('contacts.aiEnriched', { date: c.ai_enriched_at.slice(0, 10) })));
    }
    return card;
  }

  function buildPhoneRow(phone, label) {
    const el = TB.utils.el;
    const tel = String(phone).replace(/[^\d+]/g, '');
    const row = el('div', { style: { fontSize: 'var(--tb-fs-12)' } });
    row.appendChild(el('span', null, '☎ '));
    row.appendChild(el('a', { href: 'tel:' + tel, style: { color: 'var(--tb-track-health)', fontFamily: 'var(--tb-font-mono)' } }, phone));
    if (label) {
      row.appendChild(el('span', { class: 'tb-card-meta', style: { marginLeft: '6px', fontSize: '10px' } },
        '· ' + label));
    }
    return row;
  }

  // ====================================================================
  // AI Enhance
  // ====================================================================
  async function enhanceContact(c, btn) {
    if (!TB.ai || typeof TB.ai.callClaudeForProviderEnrichment !== 'function') return;
    // Built-ins can't be enhanced/saved anywhere — check this BEFORE
    // calling the paid API so we never spend a network call on a result
    // we're going to discard.
    if (c.builtin) {
      alert(TB.i18n.t('contacts.enhance.builtinNote'));
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      const result = await TB.ai.callClaudeForProviderEnrichment({
        name_en: c.name, name_jp: c.name_jp || '', type: c.type,
        address: c.address || '', phone: c.phone || '',
      });
      const en = (result && result.extracted) || {};
      // For manual contacts, write back into the stored entry. For
      // auto contacts, we don't have a stored slot — so promote
      // the contact into a manual entry that supersedes the auto one.
      if (c.auto) {
        const promoted = Object.assign({}, c, {
          id: 'cust-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
          auto: false,
          linked_source: c.source + ':' + (c.source_ref || c.id),
          ai_enriched_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        });
        if (!promoted.address && en.address) promoted.address = en.address;
        if (!promoted.phone && en.phone) promoted.phone = en.phone;
        if (!promoted.website && en.website) promoted.website = en.website;
        if (!promoted.hours && en.hours) promoted.hours = en.hours;
        if (!promoted.name_jp && en.name_jp) promoted.name_jp = en.name_jp;
        if (en.notes) {
          const cur = (promoted.notes || '').trim();
          const extra = TB.i18n.t('contacts.enhanced_by_ai', { notes: en.notes });
          promoted.notes = cur ? cur + '\n\n' + extra : extra;
        }
        upsertManualContact(promoted);
      } else {
        const updated = Object.assign({}, c);
        if (!updated.address && en.address) updated.address = en.address;
        if (!updated.phone && en.phone) updated.phone = en.phone;
        if (!updated.website && en.website) updated.website = en.website;
        if (!updated.hours && en.hours) updated.hours = en.hours;
        if (!updated.name_jp && en.name_jp) updated.name_jp = en.name_jp;
        if (en.notes) {
          const cur = (updated.notes || '').trim();
          const extra = TB.i18n.t('contacts.enhanced_by_ai', { notes: en.notes });
          updated.notes = cur ? cur + '\n\n' + extra : extra;
        }
        updated.ai_enriched_at = new Date().toISOString();
        upsertManualContact(updated);
      }
    } catch (err) {
      alert('AI enhance failed: ' + (err.message || err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨'; }
    }
  }

  // ====================================================================
  // Edit modal — manual contacts only
  // ====================================================================
  function openContactEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: 'cust-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      category: 'personal',
      name: '', name_jp: '', organization: '', type: '',
      phone: '', email: '', website: '', address: '',
      hours: '', notes: '',
      is_emergency: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      '📇 ' + (isEdit ? t('contacts.edit') : t('contacts.add.title'))));

    // Category
    modal.appendChild(field(t('contacts.field.category'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.category = e.target.value; },
    },
      ...CATEGORIES.map((cat) => el('option', { value: cat.id, selected: draft.category === cat.id },
        cat.icon + ' ' + t('contacts.cat.' + cat.id))),
    )));

    // Names (EN + JP)
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('contacts.field.name'), textInput(draft.name, (v) => draft.name = v)),
      field(t('contacts.field.nameJp'), textInput(draft.name_jp, (v) => draft.name_jp = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('contacts.field.organization'), textInput(draft.organization, (v) => draft.organization = v)),
      field(t('contacts.field.type'), textInput(draft.type, (v) => draft.type = v),
        t('contacts.field.type.help')),
    ));

    // Contact info
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('contacts.field.phone'), textInput(draft.phone, (v) => draft.phone = v)),
      field(t('contacts.field.email'), textInput(draft.email, (v) => draft.email = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('contacts.field.website'), textInput(draft.website, (v) => draft.website = v)),
      field(t('contacts.field.hours'), textInput(draft.hours, (v) => draft.hours = v)),
    ));
    modal.appendChild(field(t('contacts.field.address'),
      textareaInput(draft.address, (v) => draft.address = v)));

    // Emergency contact flag
    modal.appendChild(el('label', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: 'var(--tb-sp-2)' },
    },
      el('input', {
        type: 'checkbox', checked: !!draft.is_emergency,
        onchange: (e) => { draft.is_emergency = !!e.target.checked; },
      }),
      el('span', null, '🚨 ' + t('contacts.field.emergency')),
    ));

    modal.appendChild(field(t('contacts.field.notes'),
      textareaInput(draft.notes, (v) => draft.notes = v)));

    // Buttons
    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' } });
    if (isEdit && !draft.auto) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          if (!confirm(t('contacts.delete.confirm', { name: draft.name }))) return;
          deleteManualContact(draft.id);
          close();
          rerender();
        },
      }, t('contacts.delete')));
    } else btnRow.appendChild(el('span'));
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close },
      t('contacts.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        if (!draft.name || !draft.name.trim()) {
          alert(t('contacts.field.name.required'));
          return;
        }
        // When editing an auto-derived (non-builtin) contact, promote it
        // into a real manual entry — mirror enhanceContact's promotion
        // logic (~line 979) so the saved contact's linked_source keys
        // match the dedup check in getAllContacts() (~line 613). Without
        // this, the original auto contact keeps re-deriving every render
        // and the edit becomes a permanent duplicate instead of an update.
        if (draft.auto && !draft.builtin) {
          draft.linked_source = draft.source + ':' + (draft.source_ref || draft.id);
          draft.auto = false;
        }
        upsertManualContact(draft);
        close();
        rerender();
      },
    }, t('contacts.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Small DOM helpers (mirror health-tracker.js for consistency)
  // ====================================================================
  function field(label, input, help) {
    const el = TB.utils.el;
    return el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, label),
      input,
      help ? el('div', { class: 'tb-field-help' }, help) : null,
    );
  }
  function textInput(value, onchange) {
    const el = TB.utils.el;
    return el('input', {
      type: 'text', class: 'tb-input', value: value || '',
      oninput: (e) => onchange(e.target.value),
    });
  }
  function textareaInput(value, onchange) {
    const el = TB.utils.el;
    // NOTE: el() routes unknown attrs through setAttribute, which is a
    // no-op for a <textarea>'s value — it must be set as a child text
    // node instead (matches consultations.js's openProfessionalModal
    // notes textarea, which passes draft.notes as a child, not an attr).
    return el('textarea', {
      class: 'tb-textarea', rows: 3,
      oninput: (e) => onchange(e.target.value),
    }, value || '');
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================
  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'Contacts',
    label_jp: '連絡先',
    render,
  };
  window.TB.contacts = {
    getAllContacts, getContactsByCategory,
    CATEGORIES,
    upsertManualContact, deleteManualContact,
  };
})();
