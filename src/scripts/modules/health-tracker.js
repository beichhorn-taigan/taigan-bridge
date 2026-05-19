/* Taigan Bridge — modules/health-tracker.js  (v0.37.0)
 *
 * Health Tracker — operational layer for personal medical records.
 * Distinct from the Healthcare module (which covers insurance /
 * coverage strategy: Medicare timing, NHI vs SHI, EOL preferences,
 * premium budget). This module is "records and results":
 *
 *   • Exam log — each visit / lab draw / procedure with vitals,
 *     lab results, diagnoses, follow-up.
 *   • Lab Results — unified view across exams, with trend sparklines
 *     per test so you see "my A1C over the last 3 years" in one place.
 *   • Dashboard — latest vitals + trend cards + screenings due.
 *   • Care Plan — concerns, goals, preventive screenings, referrals,
 *     next appointments.
 *   • Meds & Tracking — current + historical medications, refill log.
 *   • Dental — separate cadence (~6mo), separate data shape.
 *   • Insurance & Notes — minimal "what's on the card" pull; deeper
 *     coverage planning lives in the Healthcare module.
 *
 * AI features (all consent-gated):
 *   • Vision import — drop a lab PDF or clinic-summary scan, Claude
 *     extracts structured values (vitals, lab results, diagnoses).
 *   • AI Advisor — pre-fills an Ask Taigan conversation with your
 *     recent exam(s) context for "what should I follow up on?"
 *
 * Action Center generators surface:
 *   • Annual physical due (>365d since last 'physical' exam)
 *   • Dental cleaning due (>180d since last_cleaning)
 *   • Preventive screening overdue (age-based defaults + user entries)
 *   • Medication refill due (next_refill_date within 14 days)
 *   • Abnormal lab result flagged (any exam with 'high'/'low'/'critical')
 *
 * Privacy:
 *   • All data local. No upload of files; vision extraction is opt-in
 *     and uses the centralized consent gate (see ai-client.js).
 *   • AI Advisor digest sanitizes — flag values + diagnoses, not raw
 *     PII like provider names + facility addresses.
 *
 * Built for personal use by the SOFA-contractor + JP-spouse household
 * pattern: both partners may have their own exam timelines, so we
 * track exams against the active TB profile (single-user). Spouse
 * tracking is a future phase (see Household Mode module).
 */

(function () {
  'use strict';

  const id = 'health-tracker';

  // ====================================================================
  // Reference data
  // ====================================================================

  // Ordered roughly by frequency in a typical year of care. "Other" is
  // intentionally last — it should be a last resort, not a default.
  const EXAM_TYPES = [
    { id: 'physical',      label_en: 'Annual physical',           label_jp: '健康診断' },
    { id: 'blood_panel',   label_en: 'Blood panel / lab work',    label_jp: '血液検査' },
    { id: 'imaging',       label_en: 'Imaging (X-ray, MRI, CT, etc.)', label_jp: '画像検査(X線・MRI・CT・他)' },
    { id: 'specialist',    label_en: 'Specialist visit',          label_jp: '専門医診察' },
    { id: 'procedure',     label_en: 'Procedure (endoscopy, biopsy, etc.)', label_jp: '処置(内視鏡・生検・他)' },
    { id: 'surgery',       label_en: 'Surgery / operation',       label_jp: '手術' },
    { id: 'screening',     label_en: 'Screening visit (mammogram, DEXA, etc.)', label_jp: '検診(マンモ・骨密度・他)' },
    { id: 'dental',        label_en: 'Dental visit',              label_jp: '歯科受診' },
    { id: 'vaccination',   label_en: 'Vaccination / immunization', label_jp: '予防接種' },
    { id: 'mental_health', label_en: 'Mental health / therapy',   label_jp: 'メンタルヘルス・カウンセリング' },
    { id: 'emergency',     label_en: 'ER / urgent care',          label_jp: '救急・緊急外来' },
    { id: 'telehealth',    label_en: 'Telehealth',                label_jp: 'オンライン診療' },
    { id: 'follow_up',     label_en: 'Follow-up',                 label_jp: 'フォローアップ' },
    { id: 'other',         label_en: 'Other',                     label_jp: 'その他' },
  ];

  // Common preventive screenings with default intervals. Adjusted for
  // a typical US person on US-side schedule (USPSTF guidelines), but
  // works as defaults — user can edit per-row.
  //
  // sex_applicable: 'all' | 'female' | 'male'. Used to filter the
  // library when health_tracker.preferences.sex is set. 'female-only'
  // and 'male-only' don't show up for the other sex unless the user
  // force-shows via custom entries. For users who haven't set their
  // sex preference yet, ALL screenings are shown with a setup banner
  // nudging them to filter.
  const PREVENTIVE_SCREENINGS_LIBRARY = [
    { id: 'colonoscopy',     label_en: 'Colonoscopy',            label_jp: '大腸内視鏡', start_age: 45, interval_years: 10, sex_applicable: 'all' },
    { id: 'mammogram',       label_en: 'Mammogram',              label_jp: '乳がん検診', start_age: 40, interval_years: 1, sex_applicable: 'female' },
    { id: 'pap_smear',       label_en: 'Pap smear / cervical',   label_jp: '子宮頸がん検診', start_age: 21, interval_years: 3, sex_applicable: 'female' },
    { id: 'prostate_psa',    label_en: 'PSA / prostate',          label_jp: '前立腺(PSA)', start_age: 50, interval_years: 1, sex_applicable: 'male' },
    { id: 'skin_check',      label_en: 'Full-body skin check',    label_jp: '皮膚科スクリーニング', start_age: 30, interval_years: 1, sex_applicable: 'all' },
    { id: 'eye_exam',        label_en: 'Eye exam',                label_jp: '眼科検診', start_age: 18, interval_years: 2, sex_applicable: 'all' },
    { id: 'lipid_panel',     label_en: 'Lipid panel',             label_jp: '脂質パネル', start_age: 35, interval_years: 5, sex_applicable: 'all' },
    { id: 'bone_density',    label_en: 'Bone density / DEXA',     label_jp: '骨密度', start_age: 65, interval_years: 2, sex_applicable: 'all' },
    { id: 'a1c',             label_en: 'A1C (diabetes screen)',   label_jp: 'A1C(糖尿病)', start_age: 35, interval_years: 3, sex_applicable: 'all' },
    { id: 'lung_ct',         label_en: 'Low-dose lung CT',        label_jp: '低線量肺 CT', start_age: 50, interval_years: 1, sex_applicable: 'all' },
    { id: 'hep_c',           label_en: 'Hepatitis C screen',      label_jp: 'C 型肝炎スクリーニング', start_age: 18, interval_years: 999, sex_applicable: 'all' },
    { id: 'tdap_booster',    label_en: 'Tdap booster',            label_jp: 'Tdap 追加接種', start_age: 19, interval_years: 10, sex_applicable: 'all' },
    { id: 'flu_shot',        label_en: 'Influenza vaccine',       label_jp: 'インフルエンザワクチン', start_age: 6, interval_years: 1, sex_applicable: 'all' },
    { id: 'shingles',        label_en: 'Shingles vaccine',        label_jp: '帯状疱疹ワクチン', start_age: 50, interval_years: 999, sex_applicable: 'all' },
    { id: 'aaa_screen',      label_en: 'AAA ultrasound (one-time)', label_jp: '腹部大動脈瘤エコー(1 回)', start_age: 65, interval_years: 999, sex_applicable: 'male' },
  ];

  // Keyword / lab-name signals that identify a screening as completed
  // when an exam record contains them. Used by `inferScreeningsFromExam`
  // to auto-update `cp.preventive_screenings_due[*].last_done` whenever
  // a new exam comes in. Two channels per matcher:
  //   • text:  regex matched against type + diagnoses + procedures +
  //            followup + notes + ai_summary + document titles+summaries
  //   • labs:  regex matched against the lab_results[].name list
  // A hit on either channel marks the screening as done with the exam's
  // date as last_done.
  const SCREENING_MATCHERS = [
    { lib_id: 'colonoscopy',    text: [/colonoscop/i, /大腸内視鏡/],                  labs: [] },
    { lib_id: 'mammogram',      text: [/mammogram|mammo/i, /マンモ|乳がん検診/],       labs: [] },
    { lib_id: 'pap_smear',      text: [/pap smear|cervical screen/i, /子宮頸/],         labs: [] },
    { lib_id: 'prostate_psa',   text: [/prostate exam/i, /前立腺/],                    labs: [/^psa\b/i, /prostate[\s-]?specific[\s-]?antigen/i] },
    { lib_id: 'skin_check',     text: [/full[-\s]?body skin|dermatolog.*screen/i, /皮膚.*検診/], labs: [] },
    { lib_id: 'eye_exam',       text: [/eye exam|ophthalmolog|optometry/i, /眼科検診/],  labs: [] },
    { lib_id: 'lipid_panel',    text: [/lipid panel|cholesterol panel/i, /脂質.*検査/], labs: [/^(ldl|hdl|total\s*cholesterol|triglycerides?)\b/i] },
    { lib_id: 'bone_density',   text: [/\bdexa\b|bone density/i, /骨密度/],             labs: [] },
    { lib_id: 'a1c',            text: [/\ba1c\b|hemoglobin\s*a1c|diabetes\s*screen/i, /HbA1c|糖尿病/i], labs: [/^(hba1c|hemoglobin\s*a1c|a1c)\b/i] },
    { lib_id: 'lung_ct',        text: [/low[-\s]?dose\s*lung\s*ct|lung\s*screening\s*ct/i, /低線量肺\s*CT/i], labs: [] },
    { lib_id: 'hep_c',          text: [/hep(?:atitis)?[\s-]?c|hcv/i, /C\s*型?肝炎/i],     labs: [/^(hcv|hcv[-\s]?ab|hcv\s*antibody|hep[\s-]?c)\b/i] },
    { lib_id: 'tdap_booster',   text: [/tdap|tetanus[-\s,]+diphtheria/i, /三種混合|破傷風/], labs: [] },
    { lib_id: 'flu_shot',       text: [/flu\s*shot|influenza\s*vaccine|flu\s*vaccine/i, /インフル.*ワクチン|インフル.*接種/], labs: [] },
    { lib_id: 'shingles',       text: [/shingles|herpes\s*zoster|zoster\s*vaccine/i, /帯状疱疹/], labs: [] },
    { lib_id: 'aaa_screen',     text: [/aaa\s*ultrasound|abdominal\s*aortic\s*aneurysm/i, /腹部大動脈瘤/], labs: [] },
  ];

  // ====================================================================
  // State accessors
  // ====================================================================

  function getHt() { return TB.state.get('health_tracker') || {}; }
  function patchHt(patch) {
    const cur = getHt();
    TB.state.set('health_tracker', Object.assign({}, cur, patch));
  }
  function getExams() { return getHt().exams || []; }
  function setExams(arr) { patchHt({ exams: arr }); }
  function upsertExam(exam) {
    const arr = getExams().slice();
    const i = arr.findIndex((e) => e.id === exam.id);
    if (i >= 0) arr[i] = exam;
    else arr.push(exam);
    arr.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // newest first
    setExams(arr);
    // Mirror exam completion into the Care Plan's screening tracker.
    // Defined later in the file — guarded so it's safe during module
    // initialization. Catches both manual saves and AI imports.
    try { if (typeof applyExamScreeningInference === 'function') applyExamScreeningInference(exam); } catch (_) {}
  }
  function deleteExam(examId) {
    setExams(getExams().filter((e) => e.id !== examId));
  }
  function getMeds() { return getHt().medications || []; }
  function setMeds(arr) { patchHt({ medications: arr }); }
  function upsertMed(med) {
    const arr = getMeds().slice();
    const i = arr.findIndex((m) => m.id === med.id);
    if (i >= 0) arr[i] = med;
    else arr.push(med);
    setMeds(arr);
  }
  function deleteMed(medId) {
    setMeds(getMeds().filter((m) => m.id !== medId));
  }
  function getCarePlan() { return getHt().care_plan || { primary_concerns: [], annual_goals: [], preventive_screenings_due: [], specialist_referrals: [], next_appointments: [] }; }
  function setCarePlan(cp) { patchHt({ care_plan: cp }); }
  function getDental() {
    const d = getHt().dental || {};
    return Object.assign({
      // Legacy summary fields (kept for back-compat + dashboard)
      last_cleaning: null, last_xrays: null, last_perio: null,
      dentist: '', clinic: '',
      // v0.52 expanded model — mirrors retirement-tool style
      teeth: {},                  // tooth_id (1..32) -> { status, has_pocket, has_bleeding, is_mobile, has_cavity, needs_treatment, needs_observation, pocket_max_mm, notes }
      periodontal: {              // aggregate (auto-computed from teeth when possible)
        pockets_4mm_pct: null,
        bleeding_on_probing_pct: null,
        mobile_teeth: 0,
        // Pocket depth distribution (v0.53)
        pocket_dist_healthy_pct: null,   // 1-3 mm sites
        pocket_dist_mild_pct: null,      // 4-6 mm sites
        pocket_dist_severe_pct: null,    // 7+ mm sites
        last_perio_exam: null,
        target_pocket_pct: 10,
        target_bop_pct: 10,
      },
      providers: [],              // [{id, name_en, name_jp, type, address, phone, email, notes}]
      procedures: [],             // [{id, date, name_en, name_jp, code, cost, currency, points, qty, provider_id, invoice_id, tooth_numbers, notes}]
      appointments: [],           // [{id, date, time, provider_id, purpose, notes}]
      notes_log: [],              // [{id, date, provider_id, status: 'open'|'complete', findings, recommendations, action_items: [{id,text,checked,due_date}], next_appointment, billing, exam_source, invoice_source, exam_id, invoice_id}]
      _migrated_v52: false,
    }, d);
  }
  function setDental(d) { patchHt({ dental: d }); }

  // ─── Tooth chart constants ────────────────────────────────────────
  //
  // Universal numbering (1-32) + ISO/FDI parenthetical for Japanese
  // dental records. Layout is occlusal-view: upper arch top, lower
  // arch bottom, patient's right on viewer's left (mirror like
  // looking into someone else's mouth).
  //
  // Each tooth has approximate x/y positions on an SVG canvas so the
  // arches read as a natural smile shape.
  // Occlusal (top-down) view: looking down at the head, so the FRONT
  // of the mouth (incisors) is at the BOTTOM of the upper arch / TOP
  // of the lower arch — both arches curve toward the tongue at the
  // center of the canvas. 3rd molars sit at the outer edges.
  //
  // Curve shape: hand-tuned smile/U-shape on a 790×460 canvas.
  //   • Upper arch: y rises (smaller) at the molars, dips (larger)
  //     at the central incisors near y=200.
  //   • Lower arch mirrors below the tongue.
  const TOOTH_LAYOUT = [
    // ─── Upper arch (1 = right 3rd molar through 16 = left 3rd molar)
    //     Numbers in label go ABOVE each tooth (closer to top edge).
    { uni: 1,  fdi: 18, x:  90,  y: 90,  arch: 'upper' },
    { uni: 2,  fdi: 17, x: 125,  y: 110, arch: 'upper' },
    { uni: 3,  fdi: 16, x: 160,  y: 130, arch: 'upper' },
    { uni: 4,  fdi: 15, x: 200,  y: 150, arch: 'upper' },
    { uni: 5,  fdi: 14, x: 240,  y: 168, arch: 'upper' },
    { uni: 6,  fdi: 13, x: 285,  y: 183, arch: 'upper' },
    { uni: 7,  fdi: 12, x: 330,  y: 193, arch: 'upper' },
    { uni: 8,  fdi: 11, x: 378,  y: 198, arch: 'upper' },
    { uni: 9,  fdi: 21, x: 422,  y: 198, arch: 'upper' },
    { uni: 10, fdi: 22, x: 470,  y: 193, arch: 'upper' },
    { uni: 11, fdi: 23, x: 515,  y: 183, arch: 'upper' },
    { uni: 12, fdi: 24, x: 560,  y: 168, arch: 'upper' },
    { uni: 13, fdi: 25, x: 600,  y: 150, arch: 'upper' },
    { uni: 14, fdi: 26, x: 640,  y: 130, arch: 'upper' },
    { uni: 15, fdi: 27, x: 675,  y: 110, arch: 'upper' },
    { uni: 16, fdi: 28, x: 710,  y: 90,  arch: 'upper' },
    // ─── Lower arch (32 = right 3rd molar through 17 = left 3rd molar)
    //     Numbers go BELOW each tooth (closer to bottom edge).
    { uni: 32, fdi: 48, x:  90,  y: 380, arch: 'lower' },
    { uni: 31, fdi: 47, x: 125,  y: 360, arch: 'lower' },
    { uni: 30, fdi: 46, x: 160,  y: 340, arch: 'lower' },
    { uni: 29, fdi: 45, x: 200,  y: 320, arch: 'lower' },
    { uni: 28, fdi: 44, x: 240,  y: 302, arch: 'lower' },
    { uni: 27, fdi: 43, x: 285,  y: 287, arch: 'lower' },
    { uni: 26, fdi: 42, x: 330,  y: 277, arch: 'lower' },
    { uni: 25, fdi: 41, x: 378,  y: 272, arch: 'lower' },
    { uni: 24, fdi: 31, x: 422,  y: 272, arch: 'lower' },
    { uni: 23, fdi: 32, x: 470,  y: 277, arch: 'lower' },
    { uni: 22, fdi: 33, x: 515,  y: 287, arch: 'lower' },
    { uni: 21, fdi: 34, x: 560,  y: 302, arch: 'lower' },
    { uni: 20, fdi: 35, x: 600,  y: 320, arch: 'lower' },
    { uni: 19, fdi: 36, x: 640,  y: 340, arch: 'lower' },
    { uni: 18, fdi: 37, x: 675,  y: 360, arch: 'lower' },
    { uni: 17, fdi: 38, x: 710,  y: 380, arch: 'lower' },
  ];

  // Status display constants — color, label, what to render
  const TOOTH_STATUS = {
    natural: { color: 'transparent',     border: 'var(--tb-text-soft)', label_en: 'Natural tooth',  label_jp: '健全歯' },
    filling: { color: '#f59e0b',         border: '#d97706',             label_en: 'Filling',        label_jp: '充填' },
    crown:   { color: '#3b82f6',         border: '#1e40af',             label_en: 'Crown',          label_jp: 'クラウン' },
    bridge:  { color: '#8b5cf6',         border: '#6d28d9',             label_en: 'Bridge',         label_jp: 'ブリッジ' },
    implant: { color: '#10b981',         border: '#047857',             label_en: 'Implant',        label_jp: 'インプラント' },
    rct:     { color: '#ef4444',         border: '#b91c1c',             label_en: 'Root canal',     label_jp: '根管治療' },
    missing: { color: 'transparent',     border: 'var(--tb-text-soft)', label_en: 'Missing',        label_jp: '欠損' },
  };
  const TOOTH_STATUS_ORDER = ['natural', 'filling', 'crown', 'bridge', 'implant', 'rct', 'missing'];

  // ─── Dental helpers ──────────────────────────────────────────────
  function getDentalTooth(uni) {
    const d = getDental();
    return (d.teeth || {})[String(uni)] || { status: 'natural', has_pocket: false, has_bleeding: false, pocket_max_mm: null, is_mobile: false, notes: '' };
  }
  function setDentalTooth(uni, patch) {
    const d = getDental();
    d.teeth = d.teeth || {};
    d.teeth[String(uni)] = Object.assign({}, getDentalTooth(uni), patch);
    setDental(d);
    recomputeDentalPerio();
  }
  // Auto-compute periodontal aggregates from per-tooth data so the
  // top-of-tab stats stay in sync as the user clicks teeth.
  //
  // Critically, ONLY overwrites an aggregate when at least one tooth
  // has explicit data for that signal. Otherwise the aggregate (which
  // may have been set by AI extraction from a narrative like "50% BoP")
  // would get clobbered to 0% just because no per-tooth flags exist.
  function recomputeDentalPerio() {
    const d = getDental();
    const teeth = d.teeth || {};
    let present = 0;
    let pocketCount = 0, bopCount = 0, mobileCount = 0;
    let hasPocketSignal = false, hasBopSignal = false, hasMobileSignal = false;
    for (let n = 1; n <= 32; n++) {
      const t = teeth[String(n)];
      if (!t) continue;
      if (t.status === 'missing') continue;
      present++;
      if (typeof t.has_pocket === 'boolean') {
        hasPocketSignal = true;
        if (t.has_pocket) pocketCount++;
      }
      if (typeof t.has_bleeding === 'boolean') {
        hasBopSignal = true;
        if (t.has_bleeding) bopCount++;
      }
      if (typeof t.is_mobile === 'boolean') {
        hasMobileSignal = true;
        if (t.is_mobile) mobileCount++;
      }
    }
    if (present === 0) return;
    d.periodontal = d.periodontal || {};
    if (hasPocketSignal) d.periodontal.pockets_4mm_pct = Math.round((pocketCount / present) * 1000) / 10;
    if (hasBopSignal) d.periodontal.bleeding_on_probing_pct = Math.round((bopCount / present) * 1000) / 10;
    if (hasMobileSignal) d.periodontal.mobile_teeth = mobileCount;
    setDental(d);
  }
  function getDentalProviders() { return getDental().providers || []; }
  function getDentalProcedures() { return getDental().procedures || []; }
  function getDentalAppointments() { return getDental().appointments || []; }
  function getDentalNotesLog() { return getDental().notes_log || []; }
  // Sync provider info extracted from an invoice into the dental
  // provider list. Reuses the same overlap-matching + bilingual
  // upgrade logic that applyDentalExtraction uses, so re-importing the
  // same invoice keeps fields converging rather than duplicating.
  //
  // Matching is asymmetric-tolerant: when the invoice has only one
  // language name (e.g., only JP) and the existing provider has only
  // the other (e.g., only EN), pure name overlap can't match them. So
  // we fall back to phone-digit and address-substring matches — which
  // are language-neutral. Returns the merged-or-created provider so
  // callers can chain into AI enrichment when the record is still
  // single-language.
  function syncDentalProviderFromInvoice(provInfo) {
    if (!provInfo) return null;
    if (!provInfo.name_en && !provInfo.name_jp) return null;
    const d = getDental();
    const providers = d.providers || [];

    function nameKey(s) { return String(s || '').toLowerCase().trim(); }
    function namesOverlap(a, b) {
      const ak = nameKey(a), bk = nameKey(b);
      if (!ak || !bk) return false;
      if (ak === bk) return true;
      if (ak.length >= 4 && (ak.includes(bk) || bk.includes(ak))) return true;
      return false;
    }
    // Phone match: strip all non-digits and compare last 8 digits
    // (handles +81-3-1234-5678 vs. 03-1234-5678 vs. 0312345678).
    function phoneDigits(s) {
      return String(s || '').replace(/\D+/g, '').slice(-8);
    }
    function phonesMatch(a, b) {
      const ad = phoneDigits(a), bd = phoneDigits(b);
      return ad.length >= 7 && ad === bd;
    }
    // Address match: substring on a normalized form. A clinic's address
    // on an invoice may be longer or shorter than what the user typed
    // on the provider card, but the building name / street number
    // usually appears in both.
    function addrKey(s) {
      return String(s || '').toLowerCase().replace(/[\s\-‐−ー－,，。、]/g, '');
    }
    function addressesMatch(a, b) {
      const ak = addrKey(a), bk = addrKey(b);
      if (!ak || !bk) return false;
      if (ak.length < 8 || bk.length < 8) return false;
      return ak.includes(bk) || bk.includes(ak);
    }

    let existing = providers.find((p) =>
      namesOverlap(p.name_en, provInfo.name_en) ||
      namesOverlap(p.name_jp, provInfo.name_jp));
    // Fallback: phone match (most reliable cross-language signal)
    if (!existing && provInfo.phone) {
      existing = providers.find((p) => phonesMatch(p.phone, provInfo.phone));
    }
    // Fallback: address match
    if (!existing && provInfo.address) {
      existing = providers.find((p) => addressesMatch(p.address, provInfo.address));
    }

    if (existing) {
      let updated = false;
      // Fill in missing fields
      for (const k of ['name_en', 'name_jp', 'phone', 'address']) {
        if (!existing[k] && provInfo[k]) { existing[k] = provInfo[k]; updated = true; }
      }
      // Upgrade short variants (bilingual replaces monolingual, etc.)
      if (provInfo.name_en && existing.name_en &&
          isMoreCompleteName(provInfo.name_en, existing.name_en)) {
        existing.name_en = provInfo.name_en; updated = true;
      }
      if (provInfo.name_jp && existing.name_jp &&
          isMoreCompleteName(provInfo.name_jp, existing.name_jp)) {
        existing.name_jp = provInfo.name_jp; updated = true;
      }
      if (updated) upsertDentalProvider(existing);
      return existing;
    } else {
      // Create a new provider entry — the invoice provider is novel
      const newProvider = {
        id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('dp-' + Date.now().toString(36)),
        name_en: provInfo.name_en || '',
        name_jp: provInfo.name_jp || '',
        type: '',
        address: provInfo.address || '',
        phone: provInfo.phone || '',
        email: '', website: '', hours: '', notes: '',
        ai_imported: true,
        created_at: new Date().toISOString(),
      };
      upsertDentalProvider(newProvider);
      return newProvider;
    }
  }

  // Chain-AI: when a synced provider is still missing a language name
  // (or all public-info fields), fire provider enrichment in the
  // background. Skipped silently when the record is already complete
  // or when an enrichment ran recently. Toast surfaces success/cost.
  //
  // Fire-and-forget intentionally: the caller's save path should not
  // block on a second Claude call. Errors go to console + toast.
  function maybeChainProviderEnrichment(provider) {
    if (!provider) return;
    const needsLangFill = !provider.name_en || !provider.name_jp;
    const needsPublicInfo = !provider.website || !provider.address || !provider.phone;
    if (!needsLangFill && !needsPublicInfo) return;
    // Skip if we enriched within the last 7 days — avoids re-firing on
    // every subsequent invoice for the same clinic.
    if (provider.ai_enriched_at) {
      const ageMs = Date.now() - new Date(provider.ai_enriched_at).getTime();
      if (isFinite(ageMs) && ageMs < 7 * 24 * 3600 * 1000) return;
    }
    if (!TB.ai || typeof TB.ai.callClaudeForProviderEnrichment !== 'function') return;
    const t = TB.i18n.t;
    const labelName = provider.name_en || provider.name_jp || '?';
    // Don't await — let the save path return. Result lands via toast.
    (async () => {
      try {
        const result = await TB.ai.callClaudeForProviderEnrichment({
          name_en: provider.name_en,
          name_jp: provider.name_jp,
          type: provider.type || 'dental',
          address: provider.address,
          phone: provider.phone,
        });
        const en = (result && result.extracted) || {};
        // Re-fetch the latest record in case the user edited it in the
        // meantime; only fill blank fields.
        const d = getDental();
        const arr = (d.providers || []).slice();
        const idx = arr.findIndex((x) => x.id === provider.id);
        if (idx < 0) return;
        const cur = arr[idx];
        const filled = [];
        if (!cur.name_en && en.name_en) { cur.name_en = en.name_en; filled.push('name_en'); }
        if (!cur.name_jp && en.name_jp) { cur.name_jp = en.name_jp; filled.push('name_jp'); }
        if (!cur.address && en.address) { cur.address = en.address; filled.push('address'); }
        if (!cur.phone   && en.phone)   { cur.phone   = en.phone;   filled.push('phone'); }
        if (!cur.website && en.website) { cur.website = en.website; filled.push('website'); }
        if (!cur.hours   && en.hours)   { cur.hours   = en.hours;   filled.push('hours'); }
        if (filled.length === 0) {
          // Low-confidence or unknown: don't surface noise.
          return;
        }
        cur.ai_enriched_at = new Date().toISOString();
        upsertDentalProvider(cur);
        const cost = (result.cost_usd || 0).toFixed(4);
        try {
          showUndoToast(
            t('ht.dental.providers.chainEnrich.done', { name: labelName, n: filled.length, cost }),
            null,
          );
        } catch (_) {
          // Toast helper expects a restoreFn — fall back to a plain alert-style log.
        }
        // Re-render so the enriched provider info shows up.
        try { rerender(); } catch (_) {}
      } catch (err) {
        // Silent fallback: log to console; don't interrupt user flow.
        try { console.warn('Provider auto-enrich failed:', err && err.message); } catch (_) {}
      }
    })();
  }

  function upsertDentalProvider(p) {
    const d = getDental();
    const arr = (d.providers || []).slice();
    const i = arr.findIndex((x) => x.id === p.id);
    p.updated_at = new Date().toISOString();
    if (i >= 0) arr[i] = p; else arr.push(p);
    d.providers = arr;
    setDental(d);
  }
  function deleteDentalProviderWithUndo(pid) {
    const d = getDental();
    const p = (d.providers || []).find((x) => x.id === pid);
    if (!p) return false;
    const t = TB.i18n.t;
    if (!confirm(t('ht.dental.providers.delete.confirm', { name: p.name_en || p.name_jp || '?' }))) return false;
    const snap = JSON.parse(JSON.stringify(p));
    d.providers = (d.providers || []).filter((x) => x.id !== pid);
    setDental(d);
    showUndoToast(t('ht.toast.providerDeleted', { name: p.name_en || p.name_jp || '?' }), () => {
      const cur = getDental();
      cur.providers = (cur.providers || []).concat([snap]);
      setDental(cur);
    });
    return true;
  }
  function upsertDentalProcedure(p) {
    const d = getDental();
    const arr = (d.procedures || []).slice();
    const i = arr.findIndex((x) => x.id === p.id);
    p.updated_at = new Date().toISOString();
    if (i >= 0) arr[i] = p; else arr.push(p);
    arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    d.procedures = arr;
    setDental(d);
  }
  function deleteDentalProcedureWithUndo(pid) {
    const d = getDental();
    const p = (d.procedures || []).find((x) => x.id === pid);
    if (!p) return false;
    const t = TB.i18n.t;
    const label = p.name_en || p.name_jp || p.code || '?';
    if (!confirm(t('ht.dental.proc.delete.confirm', { label }))) return false;
    const snap = JSON.parse(JSON.stringify(p));
    d.procedures = (d.procedures || []).filter((x) => x.id !== pid);
    setDental(d);
    showUndoToast(t('ht.toast.procDeleted', { label }), () => {
      const cur = getDental();
      cur.procedures = (cur.procedures || []).concat([snap]);
      setDental(cur);
    });
    return true;
  }
  function upsertDentalAppointment(a) {
    const d = getDental();
    const arr = (d.appointments || []).slice();
    const i = arr.findIndex((x) => x.id === a.id);
    if (i >= 0) arr[i] = a; else arr.push(a);
    arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    d.appointments = arr;
    setDental(d);
  }
  function deleteDentalAppointment(aid) {
    const d = getDental();
    d.appointments = (d.appointments || []).filter((x) => x.id !== aid);
    setDental(d);
  }
  function upsertDentalNote(n) {
    const d = getDental();
    const arr = (d.notes_log || []).slice();
    const i = arr.findIndex((x) => x.id === n.id);
    n.updated_at = new Date().toISOString();
    if (i >= 0) arr[i] = n; else arr.push(n);
    arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    d.notes_log = arr;
    setDental(d);
  }
  function deleteDentalNoteWithUndo(nid) {
    const d = getDental();
    const n = (d.notes_log || []).find((x) => x.id === nid);
    if (!n) return false;
    const t = TB.i18n.t;
    if (!confirm(t('ht.dental.notes.delete.confirm', { date: n.date || '?' }))) return false;
    const snap = JSON.parse(JSON.stringify(n));
    d.notes_log = (d.notes_log || []).filter((x) => x.id !== nid);
    setDental(d);
    showUndoToast(t('ht.toast.noteDeleted', { date: n.date || '?' }), () => {
      const cur = getDental();
      cur.notes_log = (cur.notes_log || []).concat([snap]);
      setDental(cur);
    });
    return true;
  }
  function getInsuranceSummary() {
    const ins = getHt().insurance_summary || {};
    return Object.assign({
      primary_plan: '', member_id_last4: '', bin: '',
      pcp_name: '', pcp_phone: '', notes: '',
      vault_doc_id: null,
      cards: [],
      _migrated_legacy: false,
    }, ins);
  }
  function setInsuranceSummary(s) { patchHt({ insurance_summary: s }); }

  // ─── Insurance card helpers (v0.50) ──────────────────────────────
  //
  // Each card is a structured plan entry with its own contact info,
  // claims details, pharmacy info, etc. Multiple cards supported so
  // dental + vision + medical can live side-by-side rather than
  // crammed into one blob of notes.
  function getInsuranceCards() {
    const ins = getInsuranceSummary();
    return Array.isArray(ins.cards) ? ins.cards : [];
  }
  function upsertInsuranceCard(card) {
    const ins = getInsuranceSummary();
    const arr = Array.isArray(ins.cards) ? ins.cards.slice() : [];
    const i = arr.findIndex((c) => c.id === card.id);
    card.updated_at = new Date().toISOString();
    if (i >= 0) arr[i] = card;
    else arr.push(card);
    // Sort: primary medical first, then dental, vision, prescription, other.
    const TYPE_RANK = { medical: 0, combined: 0, dental: 1, vision: 2, prescription: 3, other: 4 };
    arr.sort((a, b) => (TYPE_RANK[a.card_type] || 9) - (TYPE_RANK[b.card_type] || 9));
    ins.cards = arr;
    setInsuranceSummary(ins);
  }
  function deleteInsuranceCardWithUndo(cardId) {
    const ins = getInsuranceSummary();
    const card = (ins.cards || []).find((c) => c.id === cardId);
    if (!card) return false;
    const t = TB.i18n.t;
    if (!confirm(t('ht.notes.cards.delete.confirm', { label: card.label || card.insurer || card.plan_name || '?' }))) return false;
    const snapshot = JSON.parse(JSON.stringify(card));
    ins.cards = (ins.cards || []).filter((c) => c.id !== cardId);
    setInsuranceSummary(ins);
    showUndoToast(t('ht.notes.cards.deleted', { label: card.insurer || card.plan_name || '?' }), () => {
      const cur = getInsuranceSummary();
      cur.cards = (cur.cards || []).concat([snapshot]);
      setInsuranceSummary(cur);
    });
    return true;
  }
  // One-time migration: when the user has legacy top-level fields set
  // but no cards array, package the legacy data into a single
  // medical-default card so the new UI has something to show.
  function migrateLegacyInsuranceFields() {
    const ins = getInsuranceSummary();
    if (ins._migrated_legacy) return false;
    if ((ins.cards || []).length > 0) {
      ins._migrated_legacy = true;
      setInsuranceSummary(ins);
      return false;
    }
    // Only migrate when there's actually legacy data worth saving.
    const hasLegacy = !!(ins.primary_plan || ins.member_id_last4 || ins.bin || ins.pcp_name || ins.pcp_phone || ins.notes || ins.vault_doc_id);
    if (!hasLegacy) {
      ins._migrated_legacy = true;
      setInsuranceSummary(ins);
      return false;
    }
    // Split "Insurer — Plan" if the legacy primary_plan looks like one.
    let insurer = '', planName = ins.primary_plan || '';
    const m = (ins.primary_plan || '').split(/\s+—\s+/);
    if (m.length >= 2) { insurer = m[0].trim(); planName = m.slice(1).join(' — ').trim(); }
    const card = {
      id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('card-' + Date.now().toString(36)),
      card_type: 'medical',
      label: '',
      insurer,
      plan_name: planName,
      network_type: '',
      coverage_type: 'medical',
      member_name: '',
      member_id_last4: ins.member_id_last4 || '',
      group_number: '',
      effective_date: null,
      expiry_date: null,
      bin: ins.bin || '',
      pcn: '',
      rx_group: '',
      pcp_name: ins.pcp_name || '',
      pcp_phone: ins.pcp_phone || '',
      customer_service_phone: '',
      member_services_phone: '',
      claims_phone: '',
      pharmacy_help_phone: '',
      provider_services_phone: '',
      emergency_phone: '',
      nurse_line_phone: '',
      mental_health_phone: '',
      claims_website: '',
      claims_address: '',
      member_portal: '',
      mobile_app: '',
      email: '',
      issuing_country: '',
      coverage_areas: '',
      notes: ins.notes || '',
      vault_doc_id: ins.vault_doc_id || null,
      ai_imported: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    ins.cards = [card];
    ins._migrated_legacy = true;
    setInsuranceSummary(ins);
    return true;
  }
  function getEpisodes() { return getHt().episodes || []; }
  function setEpisodes(arr) { patchHt({ episodes: arr }); }
  function upsertEpisode(ep) {
    const arr = getEpisodes().slice();
    const i = arr.findIndex((x) => x.id === ep.id);
    if (i >= 0) arr[i] = ep;
    else arr.push(ep);
    // Newest started first; pin active ones above completed.
    arr.sort((a, b) => {
      const aActive = (a.status || 'active') !== 'completed' && (a.status || 'active') !== 'cancelled';
      const bActive = (b.status || 'active') !== 'completed' && (b.status || 'active') !== 'cancelled';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return (b.started_date || '').localeCompare(a.started_date || '');
    });
    setEpisodes(arr);
  }
  function deleteEpisode(epId) {
    // Detach references from exams/meds/invoices so we don't leave
    // orphan IDs pointing at the deleted episode.
    setEpisodes(getEpisodes().filter((e) => e.id !== epId));
    const exams = getExams().map((e) => e.episode_id === epId ? Object.assign({}, e, { episode_id: null }) : e);
    setExams(exams);
    const meds = getMeds().map((m) => m.episode_id === epId ? Object.assign({}, m, { episode_id: null }) : m);
    setMeds(meds);
    const inv = getInvoices().map((i) => i.episode_id === epId ? Object.assign({}, i, { episode_id: null }) : i);
    setInvoices(inv);
  }
  function getInvoices() { return getHt().invoices || []; }
  function setInvoices(arr) { patchHt({ invoices: arr }); }
  function upsertInvoice(inv) {
    const arr = getInvoices().slice();
    const i = arr.findIndex((x) => x.id === inv.id);
    if (i >= 0) arr[i] = inv;
    else arr.push(inv);
    arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    setInvoices(arr);
  }
  function deleteInvoice(invId) {
    setInvoices(getInvoices().filter((i) => i.id !== invId));
  }

  // ─── Undo toast system ───────────────────────────────────────────
  //
  // After every destructive action (delete medication, exam, invoice,
  // episode, attached document) we surface a bottom-center toast with
  // an Undo button. The toast auto-dismisses after 10 seconds. The
  // restoreFn is a closure that puts the item back as it was — we
  // snapshot the record BEFORE deletion so any related-field changes
  // (e.g., episode_id detached when an episode is deleted) get
  // restored too.
  let __undoToastEl = null;
  let __undoToastTimer = null;
  function showUndoToast(label, restoreFn) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    if (__undoToastEl) {
      try { __undoToastEl.remove(); } catch (_) {}
      __undoToastEl = null;
    }
    if (__undoToastTimer) {
      clearTimeout(__undoToastTimer);
      __undoToastTimer = null;
    }
    const toast = el('div', {
      'data-tb-undo-toast': '1',
      style: {
        position: 'fixed', bottom: '24px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--tb-text)',
        color: 'var(--tb-bg)',
        padding: '12px 20px',
        borderRadius: 'var(--tb-radius-2)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
        zIndex: '99999',
        display: 'flex', alignItems: 'center', gap: '16px',
        fontSize: 'var(--tb-fs-14)',
        maxWidth: '90vw',
      },
    });
    toast.appendChild(el('span', null, label));
    // Omit the Undo button when no restoreFn is supplied — this lets
    // info-style toasts (e.g., AI provider enrichment completed) reuse
    // the same visual treatment without a non-functional undo control.
    if (typeof restoreFn === 'function') {
      toast.appendChild(el('button', {
        type: 'button',
        style: {
          background: 'transparent', color: 'var(--tb-bg)',
          border: '1px solid currentColor',
          padding: '4px 14px',
          borderRadius: 'var(--tb-radius-1)',
          cursor: 'pointer',
          fontWeight: '600',
          fontSize: 'var(--tb-fs-12)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        },
        onclick: () => {
          try { restoreFn(); } catch (e) { console.error('[undo] restore failed', e); }
          try { toast.remove(); } catch (_) {}
          __undoToastEl = null;
          if (__undoToastTimer) { clearTimeout(__undoToastTimer); __undoToastTimer = null; }
          rerender();
        },
      }, '↺ ' + t('ht.undo')));
    }
    toast.appendChild(el('button', {
      type: 'button',
      title: t('ht.undo.dismiss'),
      style: {
        background: 'transparent', color: 'var(--tb-bg)',
        border: 'none', cursor: 'pointer',
        fontSize: '18px', lineHeight: '1', padding: '0 4px',
        opacity: '0.7',
      },
      onclick: () => {
        try { toast.remove(); } catch (_) {}
        __undoToastEl = null;
        if (__undoToastTimer) { clearTimeout(__undoToastTimer); __undoToastTimer = null; }
      },
    }, '×'));
    document.body.appendChild(toast);
    __undoToastEl = toast;
    __undoToastTimer = setTimeout(() => {
      if (__undoToastEl === toast) {
        try { toast.remove(); } catch (_) {}
        __undoToastEl = null;
      }
      __undoToastTimer = null;
    }, 10000);
  }

  // ─── Hover popover ───────────────────────────────────────────────
  //
  // Custom popover for hover-content that needs richer styling than
  // native `title` attribute (line breaks, monospace numbers, etc.).
  // Singleton: only one popover lives in the DOM at a time. Attaches
  // to document.body with absolute positioning so it can render on
  // top of modal content. Repositions to stay in-viewport.
  //
  // Usage:
  //   attachHoverPopover(anchorEl, (popoverEl) => {
  //     // populate popoverEl with whatever DOM you want
  //     popoverEl.appendChild(...);
  //   });
  let __popoverEl = null;
  function dismissPopover() {
    if (__popoverEl) {
      try { __popoverEl.remove(); } catch (_) {}
      __popoverEl = null;
    }
  }
  function showPopover(anchorEl, populate) {
    dismissPopover();
    const el = TB.utils.el;
    const pop = el('div', {
      'data-tb-popover': '1',
      style: {
        position: 'fixed',
        zIndex: '99998',
        background: 'var(--tb-bg-elev, white)',
        color: 'var(--tb-text)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.16)',
        padding: '10px 12px',
        fontSize: 'var(--tb-fs-12)',
        lineHeight: 'var(--tb-lh-body)',
        maxWidth: '360px',
        pointerEvents: 'none', // we don't want hover-on-popover to keep it alive — anchor controls lifetime
      },
    });
    try { populate(pop); } catch (e) { console.error('[popover]', e); }
    document.body.appendChild(pop);
    __popoverEl = pop;
    // Position: prefer above anchor, fall back below when not enough room.
    const ar = anchorEl.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    let top = ar.top - pr.height - 8;
    if (top < 8) top = ar.bottom + 8;
    let left = ar.left + (ar.width / 2) - (pr.width / 2);
    if (left < 8) left = 8;
    if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }
  // Convenience: bind hover events to an anchor element. populate(pop)
  // builds the popover body each time it opens, so the data stays fresh.
  function attachHoverPopover(anchorEl, populate) {
    anchorEl.addEventListener('mouseenter', () => showPopover(anchorEl, populate));
    anchorEl.addEventListener('mouseleave', dismissPopover);
    // Also bind focus/blur for keyboard accessibility — works whether
    // the anchor is a button or has tabindex.
    anchorEl.addEventListener('focus', () => showPopover(anchorEl, populate));
    anchorEl.addEventListener('blur', dismissPopover);
  }

  // Wrapper helpers that confirm, snapshot, delete, and push undo.
  // Use these in place of bare delete*() calls from any delete UI.
  function deleteMedWithUndo(medId) {
    const med = getMeds().find((m) => m.id === medId);
    if (!med) return false;
    const t = TB.i18n.t;
    if (!confirm(t('ht.meds.delete.confirm.named', { name: med.name || '?' }))) return false;
    const snapshot = JSON.parse(JSON.stringify(med));
    deleteMed(medId);
    showUndoToast(t('ht.toast.medDeleted', { name: med.name || '?' }), () => {
      upsertMed(snapshot);
    });
    return true;
  }
  function deleteExamWithUndo(examId) {
    const ex = getExams().find((e) => e.id === examId);
    if (!ex) return false;
    const t = TB.i18n.t;
    if (!confirm(t('ht.exams.delete.confirm.named',
      { label: (ex.date || '?') + ' · ' + examTypeLabel(ex.type) }))) return false;
    const snapshot = JSON.parse(JSON.stringify(ex));
    deleteExam(examId);
    showUndoToast(t('ht.toast.examDeleted', { label: ex.date || '?' }), () => {
      upsertExam(snapshot);
    });
    return true;
  }
  function deleteInvoiceWithUndo(invId) {
    const inv = getInvoices().find((i) => i.id === invId);
    if (!inv) return false;
    const t = TB.i18n.t;
    const labelBits = [inv.date || '?'];
    if (inv.provider) labelBits.push(inv.provider);
    const lbl = labelBits.join(' · ');
    if (!confirm(t('ht.invoices.delete.confirm.named', { label: lbl }))) return false;
    const snapshot = JSON.parse(JSON.stringify(inv));
    deleteInvoice(invId);
    showUndoToast(t('ht.toast.invoiceDeleted', { label: lbl }), () => {
      upsertInvoice(snapshot);
    });
    return true;
  }
  function deleteEpisodeWithUndo(epId) {
    const ep = getEpisodes().find((e) => e.id === epId);
    if (!ep) return false;
    const t = TB.i18n.t;
    if (!confirm(t('ht.episodes.delete.confirm.named', { title: ep.title || '?' }))) return false;
    // Snapshot the episode + the IDs of records that were attached so we
    // can re-attach on restore. deleteEpisode detaches them with null;
    // we re-set the episode_id on each detached record.
    const epSnapshot = JSON.parse(JSON.stringify(ep));
    const attachedExamIds = getExams().filter((e) => e.episode_id === epId).map((e) => e.id);
    const attachedMedIds = getMeds().filter((m) => m.episode_id === epId).map((m) => m.id);
    const attachedInvIds = getInvoices().filter((i) => i.episode_id === epId).map((i) => i.id);
    deleteEpisode(epId);
    showUndoToast(t('ht.toast.episodeDeleted', { title: ep.title || '?' }), () => {
      upsertEpisode(epSnapshot);
      setExams(getExams().map((e) => attachedExamIds.indexOf(e.id) >= 0
        ? Object.assign({}, e, { episode_id: epSnapshot.id }) : e));
      setMeds(getMeds().map((m) => attachedMedIds.indexOf(m.id) >= 0
        ? Object.assign({}, m, { episode_id: epSnapshot.id }) : m));
      setInvoices(getInvoices().map((i) => attachedInvIds.indexOf(i.id) >= 0
        ? Object.assign({}, i, { episode_id: epSnapshot.id }) : i));
    });
    return true;
  }

  // ─── Lab-name canonicalization ───────────────────────────────────
  //
  // Different reports name the same test slightly differently — "HDL
  // Cholesterol", "HDL Cholesterol (HDL-C)", "HDL-Cholesterol" all
  // describe the exact same measurement. The Lab Results view groups
  // by canonical name so the user sees one row per test instead of
  // three near-duplicates.
  //
  // Each entry: { canonical, patterns:[ regex|string ] }. Order
  // matters when patterns are loose — put more specific entries
  // first so "RBC (Urine)" doesn't get folded into "RBC".
  //
  // Display-layer only — we don't mutate stored exam.lab_results[].name.
  // The original names remain in state so re-importing the same report
  // is still deduplicated correctly within an exam.
  const LAB_CANONICAL = [
    // ─── Compartment-qualified must come FIRST so they don't fold
    //     into the unqualified blood version below.
    { canonical: 'RBC (Urine)', patterns: [/^rbc[\s\-_]*\(urine\)$/i] },
    { canonical: 'WBC (Urine)', patterns: [/^wbc[\s\-_]*\(urine\)$/i] },
    { canonical: 'Epithelial cells (Urine)', patterns: [/^epith(?:elial)?\.?\s*cells?\s*squam(?:ous)?\s*\(urine\)$/i, /^epithelial\s*cells\s*\(urine\)$/i] },
    // ─── Urinalysis (chemistries that share root names with serum tests)
    { canonical: 'Urine pH', patterns: [/^urin(?:e|ary|alysis)\s*ph$/i, /^尿\s*ph$/i] },
    { canonical: 'Urine Specific Gravity', patterns: [/^urin(?:e|ary|alysis)\s*specific\s*gravity$/i, /^urin(?:e|ary|alysis)\s*sg$/i, /^尿比重$/i] },
    { canonical: 'Urine Protein', patterns: [/^urin(?:e|ary|alysis)\s*protein$/i, /^尿蛋白$/i] },
    { canonical: 'Urine Glucose', patterns: [/^urin(?:e|ary|alysis)\s*glucose$/i, /^尿糖$/i] },
    { canonical: 'Urine Ketones', patterns: [/^urin(?:e|ary|alysis)\s*ketones?$/i, /^尿ケトン$/i] },
    { canonical: 'Urine Bilirubin', patterns: [/^urin(?:e|ary|alysis)\s*bilirubin$/i, /^尿ビリルビン$/i] },
    { canonical: 'Urine Nitrites', patterns: [/^urin(?:e|ary|alysis)\s*nitrites?$/i] },
    { canonical: 'Urobilinogen', patterns: [/^(?:urin(?:e|ary|alysis)\s*)?urobilinogen$/i, /^ウロビリノーゲン$/i] },
    // ─── Lipid panel
    { canonical: 'HDL Cholesterol', patterns: [/^hdl[\s\-]?cholesterol(?:\s*\(hdl[\s\-]?c\))?$/i, /^hdl[\s\-]?c$/i] },
    { canonical: 'LDL Cholesterol', methodNoteKey: 'ldl_cholesterol', patterns: [/^ldl[\s\-]?cholesterol(?:\s*\(ldl[\s\-]?c\))?$/i, /^ldl[\s\-]?c$/i] },
    { canonical: 'non-HDL Cholesterol', patterns: [/^non[\s\-]?hdl[\s\-]?cholesterol$/i] },
    { canonical: 'Total Cholesterol', patterns: [/^total\s*cholesterol(?:\s*\(t[\s\-]?cho\))?$/i] },
    { canonical: 'Triglycerides', methodNoteKey: 'triglycerides', patterns: [/^triglycerides?(?:\s*\(tg\))?$/i] },
    // β-Lipoprotein: require the β prefix so we don't accidentally
    // match "Lipoprotein(a)" which is a distinct, atherogenic marker.
    { canonical: 'β-Lipoprotein', patterns: [/^β[\s\-]?lipoprotein(?:\s*\(β[\s\-]?lipo\))?$/i] },
    // ─── CBC
    { canonical: 'Hemoglobin', methodNoteKey: 'hemoglobin', patterns: [/^hemoglobin(?:\s*\(hb\))?$/i, /^hgb$/i] },
    { canonical: 'Hematocrit', methodNoteKey: 'hematocrit', patterns: [/^hematocrit(?:\s*\(ht\))?$/i, /^hct$/i] },
    { canonical: 'RBC',        patterns: [/^rbc(?:\s*\(blood\))?$/i, /^red\s*blood\s*cells?$/i] },
    { canonical: 'WBC',        patterns: [/^wbc(?:\s*\(blood\))?$/i, /^white\s*blood\s*cells?$/i] },
    { canonical: 'Platelets',  patterns: [/^platelet\s*count$/i, /^platelets?$/i, /^plt$/i] },
    // ─── Chem 7 / CMP
    { canonical: 'Sodium',     patterns: [/^sodium(?:\s*\(na\))?$/i] },
    { canonical: 'Potassium',  patterns: [/^potassium(?:\s*\(k\))?$/i] },
    { canonical: 'Chloride',   patterns: [/^chloride(?:\s*\(cl\))?$/i] },
    { canonical: 'Calcium',    patterns: [/^calcium(?:\s*\(ca\))?$/i] },
    { canonical: 'Magnesium',  patterns: [/^magnesium(?:\s*\(mg\))?$/i] },
    // Phosphorus: matched only by the explicit name (NOT bare "P" — that
    // would clobber any 1-letter "P"-prefixed test like PSA / Platelets).
    { canonical: 'Phosphorus', patterns: [/^(?:inorganic\s*)?phosphorus(?:\s*\((?:p|ip)\))?$/i] },
    { canonical: 'BUN',        patterns: [/^bun(?:\s*\((?:serum|un)\))?$/i, /^blood\s*urea\s*nitrogen$/i] },
    { canonical: 'Creatinine', patterns: [/^creatinine(?:\s*\((?:cre|serum)\))?$/i] },
    { canonical: 'eGFR',       methodNoteKey: 'egfr', patterns: [/^egfr$/i, /^estimated\s*gfr$/i, /^e[\s\-]?gfr$/i] },
    { canonical: 'Uric Acid',  methodNoteKey: 'uric_acid', patterns: [/^uric\s*acid(?:\s*\(ua\))?$/i] },
    { canonical: 'Albumin',    patterns: [/^albumin(?:\s*\(alb\))?$/i] },
    { canonical: 'Total Protein', patterns: [/^total\s*protein(?:\s*\(tp\))?$/i] },
    { canonical: 'A/G Ratio',  patterns: [/^a\/?g\s*ratio$/i] },
    { canonical: 'Iron',       patterns: [/^iron(?:\s*\(fe\))?$/i] },
    { canonical: 'TIBC',       patterns: [/^tibc$/i, /^total\s*iron[\s\-]?binding\s*capacity$/i] },
    { canonical: 'UIBC',       patterns: [/^uibc$/i, /^unsaturated\s*iron[\s\-]?binding\s*capacity$/i] },
    // ─── Liver enzymes
    { canonical: 'AST',        patterns: [/^ast(?:\s*\(got\))?$/i, /^got$/i] },
    { canonical: 'ALT',        patterns: [/^alt(?:\s*\(gpt\))?$/i, /^gpt$/i] },
    { canonical: 'γ-GTP',      patterns: [/^γ[\s\-]?gt(?:p)?(?:\s*\(γ[\s\-]?gtp\))?$/i, /^γ[\s\-]?gtp$/i, /^gamma[\s\-]?gtp$/i, /^ggt$/i] },
    { canonical: 'ALP',        patterns: [/^alp(?:[\s\/\(]+ifcc[\s\)]*)?$/i, /^alk\.?\s*phosph\.?(?:\s*\(ifcc\))?$/i, /^alkaline\s*phosphatase$/i] },
    { canonical: 'LDH',        patterns: [/^ldh$/i, /^ld(?:\s*\(ldh\))?$/i, /^ld[\s\/]ifcc$/i] },
    { canonical: 'LAP',        patterns: [/^lap$/i, /^leucine[\s\-]?aminopeptidase$/i] },
    { canonical: 'Total Bilirubin', patterns: [/^total\s*bilirubin(?:\s*\(t[\s\-]?bil\))?$/i] },
    { canonical: 'Direct Bilirubin', patterns: [/^direct\s*bilirubin(?:\s*\(d[\s\-]?bil\))?$/i] },
    { canonical: 'Cholinesterase', patterns: [/^cholinesterase(?:\s*\(ch[\s\-]?e\))?$/i] },
    // ─── Other common chem
    { canonical: 'Amylase',    patterns: [/^amylase(?:\s*\(amy\))?$/i] },
    { canonical: 'CK',         methodNoteKey: 'ck', patterns: [/^c[pk]k$/i, /^ck(?:\s*\(cpk\))?$/i] },
    { canonical: 'CRP',        patterns: [/^crp$/i, /^c[\s\-]?reactive\s*protein$/i] },
    { canonical: 'Rheumatoid Factor', patterns: [/^rheumatoid\s*factor$/i, /^rf(?:\s*定量)?$/i] },
    // ─── Diabetes
    { canonical: 'HbA1c',      methodNoteKey: 'hba1c', patterns: [/^hba1c(?:\s*\(ngsp\))?$/i, /^hemoglobin\s*a1c$/i, /^a1c$/i] },
    { canonical: 'Fasting Glucose', patterns: [/^fasting\s*plasma\s*glucose$/i, /^blood\s*glucose\s*\((?:bs|fasting)\)$/i, /^fpg$/i] },
    // ─── Body composition / anthropometry. Waist Circumference,
    //     Abdominal Circumference (JP 腹囲), and Waist Circumference
    //     (CT Measured) all describe the same anatomical measurement
    //     even though Japanese health checkups use the < 85 cm
    //     metabolic-syndrome threshold while US labs use < 102 cm —
    //     they're the same measurement, different reference bands.
    { canonical: 'Waist Circumference', methodNoteKey: 'waist_circumference', patterns: [/^waist\s*circumference(?:\s*\(ct\s*measured\))?$/i, /^abdominal\s*circumference$/i, /^腹囲$/i] },
    // BMI: handle bare "BMI", written-out "Body Mass Index", periods
    // ("B.M.I."), and any unit-suffix parenthetical (the AI sometimes
    // appends "(kg/m²)" or "(kg/m^2)" to the test name).
    { canonical: 'BMI',        patterns: [
      // Allow optional unit suffix "(kg/m²)" / "(kg/m^2)" / "(kg/m2)".
      // [²2\^] matches superscript two OR ascii 2 OR ^.
      /^bmi(?:\s*\(\s*kg\s*\/?\s*m\s*[²2\^]?\s*2?\s*\))?$/i,
      /^body\s*mass\s*index(?:\s*\(\s*kg\s*\/?\s*m\s*[²2\^]?\s*2?\s*\))?$/i,
      /^b\.?\s*m\.?\s*i\.?$/i,
      /^体格指数$/,
      /^体格指数\s*\(bmi\)$/i,
    ] },
    // Body Fat Percentage: many naming variants — "Body Fat %",
    // "Body Fat (%)", "%Body Fat", "Body Fat Ratio" (Japanese phrasing
    // often translated this way), JP 体脂肪率 / %体脂肪.
    // Body Fat MASS is distinct (kg) so don't fold that here.
    { canonical: 'Body Fat %', methodNoteKey: 'body_fat_pct', patterns: [
      /^body\s*fat\s*(?:percentage|percent|%|ratio)$/i,
      /^body\s*fat\s*\(\s*%\s*\)$/i,
      /^%\s*body\s*fat$/i,
      /^bfp$/i,
      /^体脂肪率(?:\s*\(\s*%\s*\))?$/,
      /^%\s*体脂肪$/,
    ] },
    { canonical: 'Body Weight', patterns: [/^(?:body\s*)?weight(?:\s*\(\s*kg\s*\))?$/i, /^体重(?:\s*\(\s*kg\s*\))?$/] },
    { canonical: 'Body Height', patterns: [/^(?:body\s*)?height(?:\s*\(\s*cm\s*\))?$/i, /^身長(?:\s*\(\s*cm\s*\))?$/] },
    // ─── Vitals — sometimes AI extracts these as lab rows
    { canonical: 'Heart Rate', patterns: [/^heart\s*rate(?:\s*\(\s*bpm\s*\))?$/i, /^pulse(?:\s*rate)?$/i, /^脈拍$/, /^心拍数$/] },
    { canonical: 'Body Temperature', patterns: [/^(?:body\s*)?temperature(?:\s*\(\s*°?\s*c\s*\))?$/i, /^体温(?:\s*\(\s*°?\s*c\s*\))?$/, /^temp\.?$/i] },
    { canonical: 'Respiratory Rate', patterns: [/^respiratory\s*rate$/i, /^rr$/i, /^呼吸数$/] },
    { canonical: 'SpO2', patterns: [/^spo\s*2$/i, /^o\s*2\s*sat(?:uration)?$/i, /^oxygen\s*sat(?:uration)?$/i, /^酸素飽和度$/] },
    { canonical: 'Systolic BP', patterns: [/^systolic(?:\s*(?:bp|blood\s*pressure))?$/i, /^sbp$/i, /^bp\s*systolic$/i, /^収縮期血圧$/, /^最高血圧$/] },
    { canonical: 'Diastolic BP', patterns: [/^diastolic(?:\s*(?:bp|blood\s*pressure))?$/i, /^dbp$/i, /^bp\s*diastolic$/i, /^拡張期血圧$/, /^最低血圧$/] },
    // ─── Thyroid
    { canonical: 'TSH',        patterns: [/^tsh$/i, /^thyroid[\s\-]?stimulating\s*hormone$/i, /^甲状腺刺激ホルモン$/] },
    { canonical: 'Free T4',    patterns: [/^ft4$/i, /^free\s*t4$/i, /^free\s*thyroxine$/i, /^遊離\s*t4$/] },
    { canonical: 'Free T3',    patterns: [/^ft3$/i, /^free\s*t3$/i, /^free\s*triiodothyronine$/i, /^遊離\s*t3$/] },
    { canonical: 'Total T4',   patterns: [/^t4$/i, /^total\s*t4$/i, /^thyroxine$/i] },
    { canonical: 'Total T3',   patterns: [/^t3$/i, /^total\s*t3$/i, /^triiodothyronine$/i] },
    // ─── Cardiac
    { canonical: 'NT-proBNP',  patterns: [/^nt[\s\-]?probnp$/i] },
    { canonical: 'BNP',        patterns: [/^bnp$/i, /^b[\s\-]?type\s*natriuretic\s*peptide$/i] },
    { canonical: 'Troponin I', patterns: [/^troponin\s*i$/i, /^tn\s*i$/i, /^cardiac\s*troponin\s*i$/i] },
    { canonical: 'Troponin T', patterns: [/^troponin\s*t$/i, /^tn\s*t$/i, /^cardiac\s*troponin\s*t$/i] },
    { canonical: 'PSA',        methodNoteKey: 'psa', patterns: [/^psa$/i, /^prostate[\s\-]?specific\s*antigen$/i] },
    // ─── Inflammation / iron / vitamins
    { canonical: 'ESR',        patterns: [/^esr$/i, /^sed(?:\s*rate)?$/i, /^sedimentation\s*rate$/i, /^erythrocyte\s*sedimentation\s*rate$/i, /^赤沈$/, /^血沈$/] },
    { canonical: 'hs-CRP',     patterns: [/^hs[\s\-]?crp$/i, /^high[\s\-]?sensitivity\s*crp$/i, /^cardiac\s*crp$/i] },
    { canonical: 'Ferritin',   methodNoteKey: 'ferritin', patterns: [/^ferritin$/i, /^serum\s*ferritin$/i, /^フェリチン$/] },
    { canonical: 'Vitamin D',  patterns: [/^vit\.?\s*d$/i, /^vitamin\s*d$/i, /^25[\s\-]?(?:oh|hydroxy)[\s\-]?vit(?:amin)?\.?\s*d$/i, /^25\s*\(\s*oh\s*\)\s*d$/i, /^calcidiol$/i, /^ビタミン\s*d$/] },
    { canonical: 'Vitamin B12', patterns: [/^vit\.?\s*b\s*12$/i, /^vitamin\s*b\s*12$/i, /^b\s*12$/i, /^cobalamin$/i, /^ビタミン\s*b\s*12$/] },
    { canonical: 'Folate',     patterns: [/^folate$/i, /^folic\s*acid$/i, /^vit\.?\s*b\s*9$/i, /^vitamin\s*b\s*9$/i, /^葉酸$/] },
    // ─── Coagulation
    { canonical: 'PT',         patterns: [/^pt$/i, /^prothrombin\s*time$/i] },
    { canonical: 'INR',        patterns: [/^inr$/i, /^international\s*normalized\s*ratio$/i, /^pt[\s\-]?inr$/i] },
    { canonical: 'aPTT',       patterns: [/^a?ptt$/i, /^activated\s*ptt$/i, /^partial\s*thromboplastin\s*time$/i] },
    { canonical: 'D-dimer',    patterns: [/^d[\s\-]?dimer$/i] },
    { canonical: 'Fibrinogen', patterns: [/^fibrinogen$/i, /^fib$/i] },
    // ─── Tumor markers
    { canonical: 'AFP',        patterns: [/^afp$/i, /^alpha[\s\-]?fetoprotein$/i, /^α[\s\-]?fetoprotein$/i] },
    { canonical: 'CEA',        patterns: [/^cea$/i, /^carcinoembryonic\s*antigen$/i] },
    { canonical: 'CA 19-9',    patterns: [/^ca\s*19[\s\-]?9$/i] },
    { canonical: 'CA 125',     patterns: [/^ca\s*125$/i] },
    { canonical: 'CA 15-3',    patterns: [/^ca\s*15[\s\-]?3$/i] },
    { canonical: 'PIVKA-II',   patterns: [/^pivka[\s\-]?ii$/i, /^dcp$/i, /^des[\s\-]?gamma[\s\-]?carboxy\s*prothrombin$/i] },
    // ─── Glycemic extras
    { canonical: 'Random Glucose', patterns: [/^random\s*(?:plasma\s*)?glucose$/i, /^rpg$/i] },
    { canonical: 'Postprandial Glucose', patterns: [/^postprandial\s*glucose$/i, /^post[\s\-]?meal\s*glucose$/i, /^ppg$/i, /^pp\s*glucose$/i, /^食後血糖$/] },
    // ─── Hematology indices
    { canonical: 'RDW',        patterns: [/^rdw$/i, /^red\s*cell\s*distribution\s*width$/i] },
    { canonical: 'MPV',        patterns: [/^mpv$/i, /^mean\s*platelet\s*volume$/i] },
    { canonical: 'Reticulocytes', patterns: [/^reticulocytes?$/i, /^retic\s*count$/i, /^retics$/i] },
    // ─── Lipoprotein extras
    { canonical: 'Lipoprotein(a)', patterns: [/^lipoprotein\s*\(\s*a\s*\)$/i, /^lp\s*\(\s*a\s*\)$/i, /^lp[\s\-]?a$/i] },
    { canonical: 'Apolipoprotein A1', patterns: [/^apolipoprotein\s*a[\s\-]?1?$/i, /^apo[\s\-]?a[\s\-]?1?$/i] },
    { canonical: 'Apolipoprotein B', patterns: [/^apolipoprotein\s*b$/i, /^apo[\s\-]?b$/i] },
    // ─── CBC differentials (white-cell breakdown)
    { canonical: 'Neutrophils', patterns: [/^neutrophils?(?:\s*\(\s*%?\s*\))?$/i, /^neut$/i, /^好中球$/] },
    { canonical: 'Lymphocytes', patterns: [/^lymphocytes?(?:\s*\(\s*%?\s*\))?$/i, /^lymphs?$/i, /^リンパ球$/] },
    { canonical: 'Monocytes', patterns: [/^monocytes?(?:\s*\(\s*%?\s*\))?$/i, /^mono$/i, /^単球$/] },
    { canonical: 'Eosinophils', patterns: [/^eosinophils?(?:\s*\(\s*%?\s*\))?$/i, /^eos$/i, /^好酸球$/] },
    { canonical: 'Basophils', patterns: [/^basophils?(?:\s*\(\s*%?\s*\))?$/i, /^baso$/i, /^好塩基球$/] },
    // ─── CBC indices (red-cell quality)
    { canonical: 'MCV', patterns: [/^mcv$/i, /^mean\s*corpuscular\s*volume$/i] },
    { canonical: 'MCH', patterns: [/^mch$/i, /^mean\s*corpuscular\s*hemoglobin$/i] },
    { canonical: 'MCHC', patterns: [/^mchc$/i, /^mean\s*corpuscular\s*hemoglobin\s*concentration$/i] },
    // ─── EKG measurements
    { canonical: 'PR Interval', patterns: [/^pr\s*interval$/i, /^pr$/i] },
    { canonical: 'QRS Duration', patterns: [/^qrs(?:\s*duration)?$/i] },
    { canonical: 'QTc', patterns: [/^qtc$/i, /^qt[\s\-]?c$/i, /^corrected\s*qt$/i] },
    { canonical: 'C-T Ratio', patterns: [/^c[\s\-]?t\s*ratio$/i, /^cardiothoracic\s*ratio$/i, /^心胸郭比$/, /^ctr$/i] },
    // ─── Spirometry (lung function)
    { canonical: 'FVC', patterns: [/^fvc$/i, /^forced\s*vital\s*capacity$/i] },
    { canonical: 'FEV1', patterns: [/^fev1$/i, /^forced\s*expiratory\s*volume(?:\s*in\s*)?1?\s*(?:second)?$/i] },
    { canonical: 'FEV1/FVC', patterns: [/^fev1\.?0?\s*%$/i, /^fev1\s*\/\s*fvc$/i, /^fev1\s*to\s*fvc(?:\s*ratio)?$/i] },
    { canonical: '%FVC', patterns: [/^%\s*fvc$/i, /^percent\s*predicted\s*fvc$/i, /^fvc\s*%\s*predicted$/i] },
    { canonical: '%FEV1', patterns: [/^%\s*predicted\s*fev1?$/i, /^%\s*fev$/i, /^fev1?\s*%\s*predicted$/i] },
    // ─── Body composition extras (visceral / subcutaneous fat — CT-derived)
    { canonical: 'Visceral Fat Area', patterns: [/^visceral\s*fat\s*area(?:\s*\(vfa\))?$/i, /^vfa$/i, /^内臓脂肪面積$/] },
    { canonical: 'Subcutaneous Fat Area', patterns: [/^subcutaneous\s*fat\s*area(?:\s*\(sfa\))?$/i, /^sfa$/i, /^皮下脂肪面積$/] },
    { canonical: 'Total Fat Area', patterns: [/^total\s*fat\s*area(?:\s*\(tfa\))?$/i, /^tfa$/i, /^総脂肪面積$/] },
    { canonical: 'VFA/TFA Ratio', patterns: [/^vfa\s*\/\s*tfa(?:\s*ratio)?$/i, /^v\s*\/\s*s\s*(?:ratio)?$/i, /^v\/s$/i] },
    // ─── Ophthalmology
    { canonical: 'Ocular Pressure (Left)', patterns: [/^ocular\s*pressure\s*left$/i, /^iop[\s\-]?(?:l|left|os)$/i, /^眼圧\s*左$/] },
    { canonical: 'Ocular Pressure (Right)', patterns: [/^ocular\s*pressure\s*right$/i, /^iop[\s\-]?(?:r|right|od)$/i, /^眼圧\s*右$/] },
    // ─── Infectious disease / hepatitis screening (JP physicals routinely include)
    { canonical: 'HBs Antigen (qual)', patterns: [/^hbs.?antigen?\s*(?:\(?clia\)?)?\s*判定$/i, /^hbs抗原(?:\/clia)?\s*判定$/i, /^hbsag\s*qualitative$/i] },
    { canonical: 'HBs Antigen (quant)', patterns: [/^hbs.?antigen?\s*(?:\(?clia\)?)?\s*定量値?$/i, /^hbs抗原(?:\/clia)?\s*定量値?$/i, /^hbsag\s*quantitative$/i] },
    { canonical: 'HCV Antibody (index)', patterns: [/^hcv.?antibody.*index$/i, /^hcv抗体\s*3rd?\s*インデックス$/i] },
    { canonical: 'HCV Antibody (unit)', patterns: [/^hcv.?antibody.*unit$/i, /^hcv抗体\s*3rd?\s*ユニット$/i] },
    { canonical: 'HCV Antibody (qual)', patterns: [/^hcv.?antibody.*(?:judgment|qualitative)$/i, /^hcv抗体\s*3rd?\s*判定$/i] },
    { canonical: 'RPR (Syphilis screen)', patterns: [/^rpr(?:法)?\s*(?:定性|qualitative)?$/i, /^syphilis\s*screen$/i] },
    { canonical: 'ASO', patterns: [/^aso(?:\s*定量)?$/i, /^antistreptolysin[\s\-]?o$/i] },
    // ─── Older JP liver-function legacy tests
    { canonical: 'Z.T.T.', patterns: [/^z\.?t\.?t\.?$/i, /^zinc\s*sulfate\s*turbidity$/i] },
  ];

  // Lookup by canonical name — used to surface entry-level metadata
  // (currently methodNoteKey) without re-scanning the patterns array.
  const LAB_CANONICAL_BY_NAME = {};
  for (const __e of LAB_CANONICAL) LAB_CANONICAL_BY_NAME[__e.canonical] = __e;

  // ─── Clinical panel grouping ────────────────────────────────────
  //
  // Lab tests cluster naturally into the panels that hospitals report
  // together. Grouping the Lab Results view this way means BMI sits
  // next to Body Fat %, all the liver enzymes are together, all the
  // lipids are together, etc. — matches the mental model of an
  // annual physical report.
  //
  // Order in LAB_GROUPS = display order from top of tab.
  // Tests not listed in any group fall into the implicit "Other"
  // bucket rendered last.
  const LAB_GROUPS = [
    { id: 'body_comp',    icon: '📏', tests: ['BMI', 'Body Fat %', 'Waist Circumference', 'Body Weight', 'Body Height', 'Visceral Fat Area', 'Subcutaneous Fat Area', 'Total Fat Area', 'VFA/TFA Ratio'] },
    { id: 'vitals',       icon: '⚕', tests: ['Heart Rate', 'Systolic BP', 'Diastolic BP', 'Body Temperature', 'Respiratory Rate', 'SpO2'] },
    { id: 'lipid',        icon: '🩸', tests: ['Total Cholesterol', 'HDL Cholesterol', 'LDL Cholesterol', 'non-HDL Cholesterol', 'Triglycerides', 'β-Lipoprotein', 'Lipoprotein(a)', 'Apolipoprotein A1', 'Apolipoprotein B'] },
    { id: 'glycemic',     icon: '🍬', tests: ['Fasting Glucose', 'HbA1c', 'Random Glucose', 'Postprandial Glucose'] },
    { id: 'liver',        icon: '🫁', tests: ['ALT', 'AST', 'γ-GTP', 'ALP', 'LDH', 'Total Bilirubin', 'Direct Bilirubin', 'Total Protein', 'Albumin', 'A/G Ratio', 'Cholinesterase', 'LAP', 'Z.T.T.'] },
    { id: 'kidney',       icon: '🧂', tests: ['BUN', 'Creatinine', 'eGFR', 'Uric Acid'] },
    { id: 'cbc',          icon: '🩸', tests: ['Hemoglobin', 'Hematocrit', 'RBC', 'WBC', 'Platelets', 'MCH', 'MCHC', 'MCV', 'RDW', 'MPV', 'Reticulocytes', 'Neutrophils', 'Lymphocytes', 'Monocytes', 'Eosinophils', 'Basophils'] },
    { id: 'electrolytes', icon: '⚡', tests: ['Sodium', 'Potassium', 'Chloride', 'Calcium', 'Magnesium', 'Phosphorus'] },
    { id: 'iron',         icon: '🔩', tests: ['Iron', 'TIBC', 'UIBC', 'Ferritin'] },
    { id: 'thyroid',      icon: '🦋', tests: ['TSH', 'Free T4', 'Free T3', 'Total T4', 'Total T3'] },
    { id: 'cardiac',      icon: '❤', tests: ['NT-proBNP', 'BNP', 'Troponin I', 'Troponin T', 'CK'] },
    { id: 'ekg',          icon: '📈', tests: ['PR Interval', 'QRS Duration', 'QTc', 'C-T Ratio'] },
    { id: 'spirometry',   icon: '💨', tests: ['FVC', 'FEV1', 'FEV1/FVC', '%FVC', '%FEV1'] },
    { id: 'inflammation', icon: '🔥', tests: ['CRP', 'hs-CRP', 'ESR'] },
    { id: 'tumor_markers',icon: '🎯', tests: ['PSA', 'AFP', 'CEA', 'CA 19-9', 'CA 125', 'CA 15-3', 'PIVKA-II'] },
    { id: 'infectious',   icon: '🦠', tests: ['HBs Antigen (qual)', 'HBs Antigen (quant)', 'HCV Antibody (qual)', 'HCV Antibody (index)', 'HCV Antibody (unit)', 'RPR (Syphilis screen)', 'ASO'] },
    { id: 'vitamins',     icon: '☀', tests: ['Vitamin D', 'Vitamin B12', 'Folate'] },
    { id: 'coagulation',  icon: '🧬', tests: ['PT', 'INR', 'aPTT', 'D-dimer', 'Fibrinogen'] },
    { id: 'autoimmune',   icon: '🛡', tests: ['Rheumatoid Factor'] },
    { id: 'urinalysis',   icon: '💧', tests: ['Urine pH', 'Urine Specific Gravity', 'Urine Protein', 'Urine Glucose', 'Urine Ketones', 'Urine Bilirubin', 'Urine Nitrites', 'Urobilinogen', 'RBC (Urine)', 'WBC (Urine)', 'Epithelial cells (Urine)'] },
    { id: 'pancreas',     icon: '🍞', tests: ['Amylase'] },
    { id: 'ophthalmology',icon: '👁', tests: ['Ocular Pressure (Left)', 'Ocular Pressure (Right)'] },
  ];
  // Reverse lookup: test canonical name → group id
  const LAB_TEST_GROUP = {};
  for (const g of LAB_GROUPS) for (const t of g.tests) LAB_TEST_GROUP[t] = g.id;

  // ─── Lab test descriptions ──────────────────────────────────────
  //
  // Plain-English (and Japanese) explanations of what each test
  // measures and why it matters. Educational reference only — not
  // medical advice. Rendered as a hover popover on the test name in
  // the Lab Results table.
  //
  // Structure per test:
  //   { what, why, high?, low? } in both `en` and `jp`
  //   • what:  one sentence — what the test measures
  //   • why:   one or two sentences — clinical significance
  //   • high:  optional — common implications of elevated values
  //   • low:   optional — common implications of low values
  //
  // We keep these short and non-prescriptive on purpose. The popover
  // always footers with a disclaimer pointing the user toward their
  // doctor for interpretation.
  const LAB_INFO = {
    // ─── Liver enzymes
    'ALT': {
      en: {
        what: 'ALT (alanine aminotransferase, GPT) is an enzyme found mostly in the liver.',
        why: 'When liver cells are damaged, ALT leaks into the bloodstream. It\'s the most specific routine marker of liver-cell injury.',
        high: 'Often points to fatty liver, alcohol use, viral hepatitis, or medication effect (acetaminophen, statins, some supplements). Mild elevations are common; sustained >2× upper limit usually warrants follow-up.',
        low: 'Generally not concerning. Very low values may reflect vitamin B6 deficiency or low muscle mass.',
      },
      jp: {
        what: 'ALT(GPT・アラニンアミノ基転移酵素)は主に肝細胞に含まれる酵素です。',
        why: '肝細胞が傷害されると血中に漏れ出すため、肝障害の最も特異的な指標とされます。',
        high: '脂肪肝・飲酒・ウイルス性肝炎・薬剤性肝障害(アセトアミノフェン・スタチン等)を示唆。基準値の 2 倍超の持続的上昇は要精査。',
        low: '通常は問題なし。ビタミン B6 欠乏や筋肉量低下を示すこともあります。',
      },
    },
    'AST': {
      en: {
        what: 'AST (aspartate aminotransferase, GOT) is an enzyme found in liver, heart, muscle, and red blood cells.',
        why: 'Less liver-specific than ALT — high AST with normal ALT can point to muscle or heart issues. AST/ALT ratio is a clue: >2:1 suggests alcohol-related liver damage.',
        high: 'Liver injury, heavy exercise, recent heart muscle damage, or hemolysis. Look at AST/ALT ratio together with ALT for context.',
      },
      jp: {
        what: 'AST(GOT・アスパラギン酸アミノ基転移酵素)は肝臓・心臓・筋肉・赤血球に含まれる酵素です。',
        why: 'ALT より肝特異性は低く、AST のみ上昇する場合は筋肉や心臓由来の可能性。AST/ALT 比 > 2 はアルコール性肝障害を示唆。',
        high: '肝障害・激しい運動・心筋傷害・溶血など。ALT と組み合わせて評価します。',
      },
    },
    'γ-GTP': {
      en: {
        what: 'γ-GTP (gamma-glutamyl transferase) is an enzyme in liver and bile-duct cells.',
        why: 'Most sensitive routine marker for alcohol use and bile-duct issues. Often the first liver value to rise with regular drinking.',
        high: 'Regular alcohol consumption, bile-duct obstruction, fatty liver, certain medications (anti-seizure drugs, NSAIDs). Returns toward normal within weeks of stopping alcohol.',
      },
      jp: {
        what: 'γ-GTP(γ-グルタミルトランスフェラーゼ)は肝臓・胆道系に含まれる酵素です。',
        why: '飲酒や胆道系異常に最も敏感な肝機能マーカー。常習飲酒で最初に上昇することが多い指標です。',
        high: '飲酒・胆道閉塞・脂肪肝・抗てんかん薬や NSAIDs の影響など。禁酒で数週間以内に低下します。',
      },
    },
    'ALP': {
      en: {
        what: 'ALP (alkaline phosphatase) is an enzyme found in liver, bone, intestine, and placenta.',
        why: 'Elevations point to either bile-duct (liver) or bone activity. Pair with γ-GTP to distinguish: high ALP + high γ-GTP = liver/bile origin; high ALP + normal γ-GTP = bone origin.',
        high: 'Bile-duct blockage, liver disease, bone growth (normal in growing children/teens), bone disease (Paget\'s, healing fracture, vitamin D deficiency).',
      },
      jp: {
        what: 'ALP(アルカリホスファターゼ)は肝臓・骨・腸・胎盤に含まれる酵素です。',
        why: '上昇は胆道系か骨由来かのいずれかを示唆。γ-GTP と組み合わせて鑑別:両方上昇なら肝・胆道、ALP のみなら骨由来。',
        high: '胆道閉塞・肝疾患・成長期の骨形成(小児で生理的に高値)・骨疾患(パジェット病・骨折治癒・ビタミン D 不足)。',
      },
    },
    'LDH': {
      en: {
        what: 'LDH (lactate dehydrogenase) is an enzyme found in nearly every tissue.',
        why: 'Non-specific marker of cell damage. Elevated LDH says "something is dying somewhere" — but the cause needs context (liver, heart, blood, muscle, tumor).',
        high: 'Hemolysis, heart attack, liver disease, muscle injury, tumor lysis. Often part of broad screening rather than a primary diagnostic.',
      },
      jp: {
        what: 'LDH(乳酸脱水素酵素)は全身のほぼ全ての組織に含まれる酵素です。',
        why: '非特異的な細胞障害マーカー。「どこかで細胞が壊れている」ことは示しますが、部位の鑑別には他の検査と組み合わせが必要。',
        high: '溶血・心筋梗塞・肝疾患・筋障害・腫瘍崩壊など。スクリーニングの一環として測定されることが多い指標。',
      },
    },
    'Total Bilirubin': {
      en: {
        what: 'Total bilirubin is the breakdown product of old red blood cells, processed by the liver.',
        why: 'Elevations cause jaundice (yellow skin/eyes). Distinguishes pre-hepatic (hemolysis), hepatic (liver disease), and post-hepatic (bile-duct blockage) causes when split into direct/indirect.',
        high: 'Hemolysis, liver disease, bile-duct obstruction, or benign Gilbert\'s syndrome (~5% of people, harmless mild elevation).',
      },
      jp: {
        what: '総ビリルビンは古い赤血球が分解されてできる物質で、肝臓で処理されます。',
        why: '上昇は黄疸の原因。直接/間接ビリルビンの分画で、溶血・肝疾患・胆道閉塞のどれが原因かを鑑別します。',
        high: '溶血・肝疾患・胆道閉塞・体質性黄疸(ジルベール症候群:約 5% の人に見られる軽度の上昇で無害)。',
      },
    },
    'Albumin': {
      en: {
        what: 'Albumin is the most abundant protein made by the liver, carried in blood.',
        why: 'Reflects long-term liver synthesis and nutritional state. Half-life is ~20 days so it changes slowly.',
        low: 'Chronic liver disease, malnutrition, protein-losing kidney disease, severe inflammation. Acute illness can also drop albumin temporarily.',
      },
      jp: {
        what: 'アルブミンは肝臓で作られる血中の主要タンパク質です。',
        why: '肝臓の合成能と長期の栄養状態を反映。半減期約 20 日なので変動はゆっくりです。',
        low: '慢性肝疾患・低栄養・タンパク漏出性腎症・重度の炎症など。急性疾患でも一時的に低下することがあります。',
      },
    },
    'Total Protein': {
      en: {
        what: 'Total protein = albumin + globulin (immune proteins).',
        why: 'Quick screen for overall protein status. The A/G ratio is more informative than total alone — high globulin (low A/G) suggests inflammation or certain blood cancers.',
      },
      jp: {
        what: '総タンパク = アルブミン + グロブリン(免疫系タンパク)。',
        why: '全体のタンパク量を把握。総タンパクより A/G 比のほうが情報量が多い:グロブリン高値(A/G 低下)は炎症や血液腫瘍を示唆。',
      },
    },
    // ─── Kidney
    'BUN': {
      en: {
        what: 'BUN (blood urea nitrogen) is a waste product of protein metabolism cleared by the kidneys.',
        why: 'Combined with creatinine and eGFR, it gauges kidney function. BUN is sensitive to hydration and protein intake.',
        high: 'Dehydration, high-protein diet, kidney impairment, GI bleeding, heart failure.',
        low: 'Low-protein diet, severe liver disease, overhydration.',
      },
      jp: {
        what: 'BUN(血中尿素窒素)はタンパク質代謝の最終産物で、腎臓から排泄されます。',
        why: 'クレアチニン・eGFR と合わせて腎機能を評価。脱水と食事タンパク量に敏感です。',
        high: '脱水・高タンパク食・腎機能低下・消化管出血・心不全。',
        low: '低タンパク食・重度の肝疾患・過剰補液。',
      },
    },
    'Creatinine': {
      en: {
        what: 'Creatinine is a muscle-metabolism byproduct cleared by the kidneys at a steady rate.',
        why: 'The most-used routine marker of kidney filtration. Less hydration-sensitive than BUN. Muscle mass and meat intake nudge values up.',
        high: 'Kidney function decline, severe dehydration, intense exercise (transient), large muscle mass (baseline higher).',
        low: 'Low muscle mass, advanced liver disease, pregnancy (physiologic).',
      },
      jp: {
        what: 'クレアチニンは筋肉代謝の老廃物で、腎臓から一定の速度で排泄されます。',
        why: '腎機能評価の最も基本的な指標。BUN より水分量の影響を受けにくく、筋肉量と肉摂取で多少変動します。',
        high: '腎機能低下・重度の脱水・激しい運動(一時的)・筋肉量が多い体格(ベースが高め)。',
        low: '筋肉量低下・進行した肝疾患・妊娠(生理的)。',
      },
    },
    'eGFR': {
      en: {
        what: 'eGFR (estimated Glomerular Filtration Rate) estimates how much blood the kidneys filter per minute, normalized to body surface area.',
        why: 'The clinical headline number for kidney function. CKD stages: ≥90 normal, 60-89 mild ↓, 30-59 moderate ↓ (CKD 3), <30 severe (CKD 4-5).',
        low: 'Chronic kidney disease, acute kidney injury, dehydration. Steady year-over-year decline > 5 mL/min/yr warrants follow-up.',
      },
      jp: {
        what: 'eGFR(推算糸球体濾過量)は腎臓が 1 分間に濾過する血液量を体表面積で補正した推定値です。',
        why: '腎機能の代表的な数値。慢性腎臓病(CKD)のステージ:≥90 正常、60-89 軽度低下、30-59 中等度低下(CKD 3)、<30 重度(CKD 4-5)。',
        low: '慢性腎臓病・急性腎障害・脱水。年間 5 mL/min 以上の低下は精査が必要。',
      },
    },
    'Uric Acid': {
      en: {
        what: 'Uric acid is the breakdown product of purines (in meat, organ meats, beer, fructose).',
        why: 'Elevated uric acid causes gout (crystal arthritis) and is associated with metabolic syndrome and cardiovascular risk.',
        high: 'Gout/hyperuricemia, high-purine diet, alcohol, dehydration, kidney impairment, certain medications (diuretics). Risk of gout flare rises sharply above ~7 mg/dL.',
        low: 'Rarely concerning; can occur with certain medications or genetic conditions.',
      },
      jp: {
        what: '尿酸はプリン体(肉・内臓・ビール・果糖)の代謝終産物です。',
        why: '高尿酸血症は痛風(結晶性関節炎)の原因となり、メタボリックシンドローム・心血管リスクとも関連します。',
        high: '痛風・高プリン食・飲酒・脱水・腎機能低下・利尿薬。7 mg/dL を超えると痛風発作リスクが急上昇。',
        low: '通常は問題なし。一部薬剤や遺伝性疾患で見られます。',
      },
    },
    // ─── Lipid panel
    'HDL Cholesterol': {
      en: {
        what: 'HDL ("good cholesterol") carries cholesterol from tissues back to the liver for disposal.',
        why: 'Higher HDL is generally protective against heart disease. Targets: men > 40, women > 50 mg/dL.',
        high: 'Usually favorable. Very high (>90) can occasionally signal genetic or alcohol-related conditions.',
        low: 'Low HDL is a cardiovascular risk factor. Linked to obesity, sedentary lifestyle, smoking, type 2 diabetes, certain genetics.',
      },
      jp: {
        what: 'HDL(善玉コレステロール)は組織のコレステロールを肝臓に運び戻して処理させます。',
        why: 'HDL 高値は心疾患予防的とされます。目標値:男性 > 40、女性 > 50 mg/dL。',
        high: '通常は良好。極端に高値(>90)は遺伝性やアルコールが関与することも。',
        low: '心血管リスク因子。肥満・運動不足・喫煙・2 型糖尿病・遺伝などと関連。',
      },
    },
    'LDL Cholesterol': {
      en: {
        what: 'LDL ("bad cholesterol") carries cholesterol from the liver to tissues; excess builds up in artery walls.',
        why: 'The primary lipid target for cardiovascular risk reduction. Optimal < 100; <70 for high-risk patients (prior heart attack, diabetes).',
        high: 'Atherosclerosis, heart disease risk. Drivers: saturated fat intake, genetics (familial hypercholesterolemia), hypothyroidism, certain medications.',
      },
      jp: {
        what: 'LDL(悪玉コレステロール)は肝臓から組織にコレステロールを運び、過剰分は動脈壁に蓄積します。',
        why: '心血管リスク低減の最重要指標。目標値:< 100、高リスク者(心筋梗塞既往・糖尿病)は < 70。',
        high: '動脈硬化・心疾患リスク。飽和脂肪酸の過剰摂取・遺伝(家族性高コレステロール血症)・甲状腺機能低下症・薬剤の影響。',
      },
    },
    'non-HDL Cholesterol': {
      en: {
        what: 'Non-HDL = Total cholesterol − HDL. Captures all "atherogenic" (artery-damaging) particles: LDL + VLDL + IDL + Lp(a).',
        why: 'More comprehensive cardiovascular risk marker than LDL alone, especially when triglycerides are elevated. Target: 30 mg/dL above your LDL goal.',
      },
      jp: {
        what: 'Non-HDL = 総コレステロール − HDL。LDL・VLDL・IDL・Lp(a) など動脈硬化性粒子すべてを含む指標です。',
        why: 'LDL 単独より包括的な心血管リスク評価。中性脂肪が高い時に特に有用。目標値は LDL 目標 + 30 mg/dL。',
      },
    },
    'Total Cholesterol': {
      en: {
        what: 'Total cholesterol = HDL + LDL + ~20% of triglycerides.',
        why: 'Useful as a screening number but less informative than the breakdown. Two people with the same total can have very different cardiovascular risk depending on the HDL/LDL split.',
      },
      jp: {
        what: '総コレステロール = HDL + LDL + 中性脂肪の約 20%。',
        why: 'スクリーニングには有用ですが、内訳の方が情報量が多いです。同じ総コレステロールでも HDL/LDL の比率で心血管リスクは大きく変わります。',
      },
    },
    'Triglycerides': {
      en: {
        what: 'Triglycerides are the main form of fat stored and transported in blood.',
        why: 'High triglycerides are linked to metabolic syndrome, fatty liver, and pancreatitis (when very high, >500). Values strongly depend on fasting state.',
        high: 'Recent meal (especially carbs/alcohol), metabolic syndrome, type 2 diabetes, hypothyroidism, certain medications. Genetic forms also exist.',
      },
      jp: {
        what: '中性脂肪(トリグリセライド)は体内で貯蔵・運搬される脂肪の主要形態です。',
        why: '高値はメタボリックシンドローム・脂肪肝・膵炎(極めて高値 >500 で)と関連。食事(空腹時間)に大きく依存します。',
        high: '直近の食事(特に糖質・アルコール)・メタボリックシンドローム・2 型糖尿病・甲状腺機能低下症・薬剤性。遺伝性もあり。',
      },
    },
    // ─── Glycemic
    'Fasting Glucose': {
      en: {
        what: 'Plasma glucose level after at least 8 hours without eating.',
        why: 'Primary diabetes screening test alongside HbA1c. Diagnostic cutoffs: <100 normal, 100-125 prediabetes, ≥126 diabetes (confirmed on two occasions).',
        high: 'Diabetes, stress hyperglycemia, certain medications (steroids), Cushing\'s syndrome.',
      },
      jp: {
        what: '8 時間以上絶食後の血糖値です。',
        why: 'HbA1c と並ぶ糖尿病スクリーニングの基本検査。診断基準:<100 正常、100-125 糖尿病予備軍、≥126 糖尿病(2 回確認)。',
        high: '糖尿病・ストレス性高血糖・薬剤性(ステロイドなど)・クッシング症候群。',
      },
    },
    'HbA1c': {
      en: {
        what: 'HbA1c reflects the average blood glucose over the past 2-3 months by measuring sugar bound to hemoglobin.',
        why: 'The clinical gold standard for diabetes diagnosis and management. Cutoffs: <5.7% normal, 5.7-6.4% prediabetes, ≥6.5% diabetes.',
        high: 'Persistently elevated blood sugar over months. Each 1% drop reduces diabetes complications meaningfully.',
        low: 'Recent transfusion, hemolytic anemia, hemoglobinopathies (sickle cell, thalassemia) can artifactually lower HbA1c.',
      },
      jp: {
        what: 'HbA1c は過去 2〜3 ヶ月の平均血糖値を反映する指標で、ヘモグロビンに結合した糖を測定します。',
        why: '糖尿病の診断・管理における臨床ゴールドスタンダード。基準値:<5.7% 正常、5.7-6.4% 糖尿病予備軍、≥6.5% 糖尿病。',
        high: '数ヶ月単位の高血糖の持続を示唆。1% の低下で糖尿病合併症リスクが大幅に減少します。',
        low: '輸血・溶血性貧血・異常ヘモグロビン症(鎌状赤血球症・サラセミア等)で見かけ上低くなることがあります。',
      },
    },
    // ─── CBC
    'Hemoglobin': {
      en: {
        what: 'Hemoglobin is the iron-containing protein in red blood cells that carries oxygen.',
        why: 'Primary screen for anemia. Sex-specific norms: men 13.5-17.5, women 12-15.5 g/dL.',
        high: 'Dehydration (most common reason for mild elevation), high-altitude living, smoking, polycythemia, lung disease.',
        low: 'Anemia: iron deficiency (most common), B12/folate deficiency, chronic disease, blood loss, kidney disease.',
      },
      jp: {
        what: 'ヘモグロビンは赤血球内の鉄含有タンパクで、酸素を運搬します。',
        why: '貧血スクリーニングの基本指標。性別基準:男性 13.5-17.5、女性 12-15.5 g/dL。',
        high: '脱水(最も多い軽度上昇の原因)・高地居住・喫煙・多血症・肺疾患。',
        low: '貧血:鉄欠乏(最多)・ビタミン B12/葉酸欠乏・慢性疾患・出血・腎疾患。',
      },
    },
    'Hematocrit': {
      en: {
        what: 'Hematocrit is the percentage of blood volume occupied by red blood cells.',
        why: 'Closely tracks hemoglobin (usually ~3× the Hb value). Same diagnostic territory as hemoglobin: screens for anemia and red-cell excess.',
      },
      jp: {
        what: 'ヘマトクリットは血液中の赤血球が占める容積の割合(%)です。',
        why: 'ヘモグロビンとほぼ連動(通常 Hb の約 3 倍)。貧血や多血症のスクリーニングに使用されます。',
      },
    },
    'RBC': {
      en: {
        what: 'Red blood cell count — how many oxygen-carrying cells are in a unit volume of blood.',
        why: 'Part of the CBC. Less informative alone than hemoglobin or hematocrit; pair with MCV/MCH to characterize anemia type.',
      },
      jp: {
        what: '赤血球数 — 一定容積の血液中に含まれる酸素運搬細胞の数。',
        why: 'CBC の一部。単独より MCV/MCH と組み合わせて貧血のタイプ分類に使います。',
      },
    },
    'WBC': {
      en: {
        what: 'White blood cell count — the immune system\'s soldiers (neutrophils, lymphocytes, monocytes, eosinophils, basophils).',
        why: 'Primary screen for infection, inflammation, and certain cancers.',
        high: 'Bacterial infection, stress, steroid use, recent exercise, smoking. Very high (>20,000) can suggest leukemia.',
        low: 'Viral infection, severe sepsis (paradoxically), bone marrow suppression, autoimmune disease, certain medications (chemotherapy).',
      },
      jp: {
        what: '白血球数 — 免疫システムの細胞群(好中球・リンパ球・単球・好酸球・好塩基球)。',
        why: '感染・炎症・特定の血液腫瘍のスクリーニング。',
        high: '細菌感染・ストレス・ステロイド使用・運動直後・喫煙。極めて高値(>20,000)は白血病の可能性。',
        low: 'ウイルス感染・重症敗血症(逆説的)・骨髄抑制・自己免疫疾患・化学療法など。',
      },
    },
    'Platelets': {
      en: {
        what: 'Platelets are small cell fragments that initiate blood clotting.',
        why: 'Bleeding risk rises significantly below 50,000; clotting risk rises above ~600,000.',
        low: 'Viral infection, autoimmune destruction (ITP), liver disease, certain medications, bone marrow disorders.',
        high: 'Inflammation, iron deficiency, post-surgery recovery, post-splenectomy, essential thrombocythemia.',
      },
      jp: {
        what: '血小板は血液凝固を開始する小さな細胞断片です。',
        why: '50,000 を下回ると出血リスクが顕著に上昇、約 600,000 を超えると血栓リスクが上昇します。',
        low: 'ウイルス感染・自己免疫性破壊(ITP)・肝疾患・薬剤性・骨髄疾患。',
        high: '炎症・鉄欠乏・術後回復期・脾摘後・本態性血小板血症。',
      },
    },
    // ─── Electrolytes (brief)
    'Sodium': {
      en: {
        what: 'Sodium is the main electrolyte regulating water balance in the body.',
        why: 'Tightly controlled. Out-of-range values reflect water/sodium balance disturbance, not usually salt intake.',
        high: 'Dehydration, diabetes insipidus, excess salt intake (rare cause alone).',
        low: 'Overhydration, certain medications (diuretics, SSRIs), heart/liver/kidney failure, SIADH.',
      },
      jp: {
        what: 'ナトリウムは体内の水分バランスを調節する主要電解質です。',
        why: '厳密に制御されており、異常値は通常、塩分摂取量より水分・ナトリウムバランスの問題を反映します。',
        high: '脱水・尿崩症・過剰塩分摂取(単独原因は稀)。',
        low: '過剰水分摂取・薬剤性(利尿薬・SSRI)・心不全/肝不全/腎不全・SIADH。',
      },
    },
    'Potassium': {
      en: {
        what: 'Potassium is the main intracellular electrolyte, critical for heart rhythm and muscle function.',
        why: 'Very tight normal range. Both high and low values can cause dangerous heart rhythm disturbances.',
        high: 'Kidney disease, certain medications (ACE inhibitors, ARBs, K-sparing diuretics), tissue breakdown. Hemolyzed sample is a common false elevation.',
        low: 'Diuretic use, vomiting/diarrhea, low intake, certain genetic conditions.',
      },
      jp: {
        what: 'カリウムは細胞内の主要電解質で、心臓のリズムと筋機能に重要です。',
        why: '極めて狭い正常範囲。高値も低値も致死的な不整脈を起こし得ます。',
        high: '腎疾患・薬剤性(ACE 阻害薬・ARB・K 保持利尿薬)・組織崩壊。溶血検体での偽高値も多い。',
        low: '利尿薬・嘔吐/下痢・摂取不足・遺伝性疾患。',
      },
    },
    'Calcium': {
      en: {
        what: 'Calcium is the most abundant mineral, regulated by parathyroid hormone and vitamin D.',
        why: 'Critical for bone, nerve, and muscle function. Albumin-adjusted calcium is more accurate when albumin is low.',
        high: 'Hyperparathyroidism (most common), certain cancers, excess vitamin D, immobility, some medications (thiazide diuretics, lithium).',
        low: 'Vitamin D deficiency, kidney disease, low albumin (often a false low — check corrected), hypoparathyroidism.',
      },
      jp: {
        what: 'カルシウムは体内で最も多いミネラルで、副甲状腺ホルモンとビタミン D で調節されます。',
        why: '骨・神経・筋肉に必須。アルブミンが低い場合は補正カルシウムで評価。',
        high: '副甲状腺機能亢進症(最多)・特定のがん・ビタミン D 過剰・寝たきり・薬剤(サイアザイド・リチウム)。',
        low: 'ビタミン D 不足・腎疾患・低アルブミン血症(補正で正常なことが多い)・副甲状腺機能低下症。',
      },
    },
    // ─── Iron studies
    'Iron': {
      en: {
        what: 'Serum iron measures iron currently circulating bound to transferrin.',
        why: 'Interpret with TIBC and ferritin — iron alone fluctuates daily with diet and time of day. Best drawn fasting in the morning.',
      },
      jp: {
        what: '血清鉄はトランスフェリンに結合した循環血中の鉄を測定します。',
        why: 'TIBC・フェリチンと併せて解釈。単独では食事と時間帯で日内変動。朝の空腹時採血が望ましい。',
      },
    },
    'Ferritin': {
      en: {
        what: 'Ferritin is the body\'s iron-storage protein. Low ferritin = depleted iron stores.',
        why: 'Most reliable marker for iron deficiency. Catches iron deficiency earlier than hemoglobin drops.',
        high: 'Inflammation (acute-phase reactant — rises in any inflammatory state regardless of iron status), liver disease, iron overload (hemochromatosis), chronic alcohol use.',
        low: 'Iron deficiency. Often well before anemia develops. Most common cause: dietary intake, menstrual losses, GI bleeding.',
      },
      jp: {
        what: 'フェリチンは体内の鉄貯蔵タンパクです。低値 = 鉄貯蔵の枯渇。',
        why: '鉄欠乏の最も信頼できる指標。ヘモグロビン低下より早く鉄欠乏を捉えます。',
        high: '炎症(急性期反応物 — 鉄状態と関係なく炎症で上昇)・肝疾患・鉄過剰症(ヘモクロマトーシス)・慢性飲酒。',
        low: '鉄欠乏。貧血になる前に低下することが多い。原因:食事・月経・消化管出血。',
      },
    },
    // ─── Inflammation
    'CRP': {
      en: {
        what: 'CRP (C-reactive protein) is a liver protein that surges during inflammation.',
        why: 'Non-specific marker — rises with any inflammation (infection, autoimmune, injury, post-surgery). Standard CRP screens for acute inflammation; hs-CRP is more sensitive for low-grade chronic inflammation linked to cardiovascular risk.',
        high: 'Active infection, autoimmune flare, recent surgery, obesity, smoking, chronic inflammation.',
      },
      jp: {
        what: 'CRP(C 反応性タンパク)は炎症時に肝臓で増産されるタンパクです。',
        why: '非特異的な炎症マーカー。感染・自己免疫疾患・外傷・術後など、あらゆる炎症で上昇。標準 CRP は急性炎症のスクリーニング、hs-CRP は心血管リスクに関連する慢性低度炎症の検出に。',
        high: '活動性感染・自己免疫増悪・術後・肥満・喫煙・慢性炎症。',
      },
    },
    // ─── Thyroid
    'TSH': {
      en: {
        what: 'TSH (Thyroid-Stimulating Hormone) is released by the pituitary to signal the thyroid.',
        why: 'The most sensitive single test of thyroid function. High TSH = underactive thyroid (gland needs more push). Low TSH = overactive thyroid.',
        high: 'Hypothyroidism (Hashimoto\'s, post-radiation, certain medications, iodine deficiency).',
        low: 'Hyperthyroidism (Graves\', toxic nodule), excessive thyroid replacement, pituitary disease (rare).',
      },
      jp: {
        what: 'TSH(甲状腺刺激ホルモン)は下垂体から分泌され、甲状腺を刺激します。',
        why: '甲状腺機能の最も鋭敏な単独指標。TSH 高値 = 甲状腺機能低下(刺激を強めている)、低値 = 機能亢進。',
        high: '甲状腺機能低下症(橋本病・放射線治療後・薬剤性・ヨード不足)。',
        low: '甲状腺機能亢進症(バセドウ病・中毒性結節)・甲状腺ホルモン補充過剰・下垂体疾患(稀)。',
      },
    },
    'Free T4': {
      en: {
        what: 'Free T4 is the unbound, active form of the main thyroid hormone (thyroxine).',
        why: 'Direct measure of thyroid output. Pair with TSH: high TSH + low Free T4 = clear hypothyroidism; high TSH + normal Free T4 = subclinical hypothyroidism.',
      },
      jp: {
        what: 'Free T4 は遊離型(活性型)の主要甲状腺ホルモン(サイロキシン)です。',
        why: '甲状腺の産生量を直接測定。TSH と組み合わせる:TSH 高値 + Free T4 低値 = 顕性甲状腺機能低下症、TSH 高値 + Free T4 正常 = 潜在性。',
      },
    },
    // ─── Cardiac / cancer / other
    'PSA': {
      en: {
        what: 'PSA (Prostate-Specific Antigen) is a protein produced by the prostate gland.',
        why: 'Screens for prostate cancer in men ≥50 (≥45 with risk factors). Normal range varies by age; a rising trend matters more than a single value.',
        high: 'Prostate cancer (most concerning), benign prostatic enlargement, prostatitis, recent DRE, ejaculation within 48h, or prostate biopsy can transiently elevate values.',
      },
      jp: {
        what: 'PSA(前立腺特異抗原)は前立腺で産生されるタンパクです。',
        why: '50 歳以上(リスクありで 45 歳以上)の男性の前立腺がんスクリーニング。基準値は年齢別、単発の値より経時変化が重要。',
        high: '前立腺がん(最も注意)・良性前立腺肥大・前立腺炎・直腸診後・48 時間以内の射精・生検後でも一時的に上昇。',
      },
    },
    'Amylase': {
      en: {
        what: 'Amylase is an enzyme produced by the pancreas and salivary glands that digests carbohydrates.',
        why: 'Primary screen for pancreatitis when paired with abdominal pain.',
        high: 'Acute pancreatitis (3-5× upper limit typical), salivary gland disorders, kidney impairment, ectopic pregnancy.',
      },
      jp: {
        what: 'アミラーゼは膵臓と唾液腺で産生される糖質消化酵素です。',
        why: '腹痛と組み合わせて膵炎を疑う際の基本検査。',
        high: '急性膵炎(基準値の 3〜5 倍が典型)・唾液腺疾患・腎機能低下・子宮外妊娠。',
      },
    },
    'CK': {
      en: {
        what: 'CK (creatine kinase / CPK) is an enzyme found in muscle, heart, and brain.',
        why: 'Marker of muscle damage. Elevation context matters: skeletal muscle (exercise/injury), cardiac (heart attack — though troponin is now preferred), brain.',
        high: 'Strenuous exercise (can elevate 10-100× within 24h), muscle injury, statin-related myopathy, rhabdomyolysis.',
      },
      jp: {
        what: 'CK(クレアチンキナーゼ・CPK)は筋肉・心臓・脳に含まれる酵素です。',
        why: '筋障害マーカー。骨格筋(運動・外傷)、心筋(現在は主にトロポニンで評価)、脳など部位の鑑別が必要。',
        high: '激しい運動(24 時間以内に 10〜100 倍に上昇することも)・筋外傷・スタチンによる筋障害・横紋筋融解症。',
      },
    },
    // ─── Vitamins
    'Vitamin D': {
      en: {
        what: '25-hydroxyvitamin D — the storage form of vitamin D, made in skin from sunlight + diet.',
        why: 'Essential for calcium absorption and bone health; also linked to immune function. Targets: ≥30 ng/mL (some labs ≥20).',
        low: 'Vitamin D deficiency. Common in indoor lifestyles, dark skin, northern latitudes, winter, sunscreen use, malabsorption.',
      },
      jp: {
        what: '25-水酸化ビタミン D — 皮膚での日光暴露+食事で作られるビタミン D の貯蔵型です。',
        why: 'カルシウム吸収と骨健康に必須、免疫機能とも関連。目標値:≥30 ng/mL(検査機関により ≥20)。',
        low: 'ビタミン D 不足。屋内生活・色素の濃い肌・高緯度地域・冬季・日焼け止め使用・吸収不良。',
      },
    },
    'Vitamin B12': {
      en: {
        what: 'Vitamin B12 (cobalamin) is essential for red blood cell formation and nerve function.',
        why: 'Deficiency causes anemia (macrocytic — MCV ↑) and irreversible neurologic damage if prolonged.',
        low: 'Pernicious anemia, vegan/vegetarian diet without supplementation, advanced age (reduced absorption), metformin use, gastric bypass.',
      },
      jp: {
        what: 'ビタミン B12(コバラミン)は赤血球生成と神経機能に必須です。',
        why: '欠乏は大球性貧血(MCV ↑)を起こし、長期化すると不可逆的な神経障害につながります。',
        low: '悪性貧血・サプリなしのビーガン/ベジタリアン食・高齢(吸収低下)・メトホルミン使用・胃バイパス手術後。',
      },
    },
    // ─── Body composition (link the methodNoteKey-only entries to their info)
    'BMI': {
      en: {
        what: 'BMI (Body Mass Index) = weight (kg) ÷ height (m)². A rough screening number for body size.',
        why: 'Useful for population studies but limited for individuals — doesn\'t distinguish muscle from fat. A muscular person can have a "high" BMI without health risk.',
        high: 'WHO categories: 25-29.9 overweight, 30-34.9 obese class I, ≥35 obese class II/III. Asian populations use lower thresholds (23/25/30).',
      },
      jp: {
        what: 'BMI(体格指数)= 体重(kg)÷ 身長(m)²。体格の簡易スクリーニング指標。',
        why: '集団統計には有用ですが個人では限界あり — 筋肉と脂肪を区別できません。筋肉質な人は健康でも高 BMI になります。',
        high: 'WHO 基準:25-29.9 過体重、30-34.9 肥満度 I、≥35 肥満度 II/III。アジア人基準では 23/25/30 と低めに設定。',
      },
    },
    'Body Fat %': {
      en: {
        what: 'Body fat percentage — proportion of body mass that\'s fat tissue (vs muscle, bone, organ, water).',
        why: 'More direct measure of body composition than BMI. Healthy ranges depend on sex and age — typical adult: men 10-22%, women 20-32%.',
      },
      jp: {
        what: '体脂肪率 — 体重に占める脂肪組織の割合(筋肉・骨・臓器・水分を除く)。',
        why: 'BMI より体組成を直接的に評価。基準値は性別と年齢で異なる:成人男性 10-22%、女性 20-32% 程度。',
      },
    },
    'Waist Circumference': {
      en: {
        what: 'Waist circumference measures abdominal (visceral) fat — the most metabolically dangerous fat depot.',
        why: 'Stronger predictor of cardiovascular and metabolic disease than BMI. JP cutoff for metabolic syndrome: men <85 cm, women <90 cm. US (ATP-III): men <102 cm, women <88 cm.',
      },
      jp: {
        what: '腹囲は腹部内臓脂肪の蓄積を測定します — 最も代謝的に危険な脂肪です。',
        why: 'BMI より心血管・代謝疾患の予測力が高い指標。日本のメタボリックシンドローム基準:男性 <85 cm、女性 <90 cm。米国(ATP-III):男性 <102 cm、女性 <88 cm。',
      },
    },
    'Body Weight': {
      en: { what: 'Total body mass in kilograms.', why: 'Combined with height for BMI; useful for trend tracking. Day-to-day fluctuations of 1-2 kg are normal (hydration, glycogen).' },
      jp: { what: '体重(kg)。', why: '身長と組み合わせて BMI 算出。推移評価に有用。1〜2 kg の日内変動は正常(水分・グリコーゲン)。' },
    },
    'Body Height': {
      en: { what: 'Height in centimeters.', why: 'Reference for BMI. Adults gradually lose 1-2 cm with age. Sudden noticeable loss can suggest osteoporotic compression fractures.' },
      jp: { what: '身長(cm)。', why: 'BMI 算出の基礎。成人は加齢で 1〜2 cm 減少。急な明らかな身長低下は骨粗鬆症性圧迫骨折を示唆。' },
    },
    'Visceral Fat Area': {
      en: { what: 'CT-measured cross-section area of fat surrounding internal organs at the L4-L5 level.', why: 'Most accurate single measure of metabolic risk. JP target: <100 cm². Visceral fat is far more dangerous than subcutaneous fat.', high: 'Strong predictor of cardiovascular disease, type 2 diabetes, NAFLD, certain cancers.' },
      jp: { what: 'L4-L5 レベルの CT 撮影で測定する内臓周囲の脂肪断面積。', why: '代謝リスクの最も正確な単独指標。日本目標値:<100 cm²。内臓脂肪は皮下脂肪より遥かに危険。', high: '心血管疾患・2 型糖尿病・脂肪肝・特定のがんの強力な予測因子。' },
    },
    'Subcutaneous Fat Area': {
      en: { what: 'CT-measured cross-section area of fat just under the skin at the L4-L5 level.', why: 'Less metabolically active than visceral fat — high SFA alone is less dangerous than high VFA.' },
      jp: { what: 'L4-L5 レベルの CT 撮影で測定する皮膚直下の脂肪断面積。', why: '内臓脂肪より代謝的に不活発 — SFA 単独高値は VFA 高値より危険性は低い。' },
    },
    'Total Fat Area': {
      en: { what: 'Sum of visceral + subcutaneous fat area at the L4-L5 level.', why: 'Total abdominal fat burden. The VFA/TFA ratio is more clinically meaningful than total alone.' },
      jp: { what: '内臓脂肪 + 皮下脂肪面積の合計(L4-L5 レベル)。', why: '腹部総脂肪量。総量より VFA/TFA 比のほうが臨床的意義が大きい。' },
    },
    'VFA/TFA Ratio': {
      en: { what: 'Ratio of visceral to total fat area.', why: 'How much of your abdominal fat is the dangerous visceral kind. Higher ratio = higher metabolic risk for the same total fat.' },
      jp: { what: '内臓脂肪 ÷ 総脂肪面積の比。', why: '腹部脂肪のうち内臓脂肪が占める割合。同じ総脂肪量でも比が高いほど代謝リスクが高い。' },
    },
    // ─── Vitals
    'Heart Rate': {
      en: { what: 'Resting heart beats per minute.', why: 'Reflects cardiovascular fitness and autonomic balance. Normal: 60-100. Athletes often 40-60.', high: 'Stress, caffeine, dehydration, anemia, hyperthyroidism, infection.', low: 'Cardiovascular fitness (healthy), beta-blockers, hypothyroidism, advanced heart block.' },
      jp: { what: '安静時の心拍数(回/分)。', why: '心血管系の体力と自律神経バランスを反映。正常:60〜100。アスリートでは 40〜60 が一般的。', high: 'ストレス・カフェイン・脱水・貧血・甲状腺機能亢進症・感染症。', low: '体力(健康的)・β 遮断薬・甲状腺機能低下症・房室ブロック。' },
    },
    'Systolic BP': {
      en: { what: 'The higher blood pressure number — pressure during heart contraction.', why: 'Primary cardiovascular risk indicator. Target <120 ideal; 120-129 elevated; ≥130 stage 1 hypertension; ≥140 stage 2.', high: 'Hypertension, stress, salt sensitivity, kidney disease, certain medications. Often "silent" until complications appear.' },
      jp: { what: '上の血圧 — 心臓収縮時の動脈圧。', why: '心血管リスクの主要指標。理想 <120、120-129 高値正常、≥130 高血圧 I 度、≥140 II 度。', high: '高血圧・ストレス・食塩感受性・腎疾患・薬剤性。合併症が出るまで「沈黙の疾患」と呼ばれます。' },
    },
    'Diastolic BP': {
      en: { what: 'The lower blood pressure number — pressure during heart relaxation.', why: 'Reflects baseline vascular resistance. Target <80; ≥80 stage 1; ≥90 stage 2 hypertension.', high: 'Often rises before systolic in younger people. Associated with peripheral resistance, kidney issues.' },
      jp: { what: '下の血圧 — 心臓拡張期の動脈圧。', why: 'ベースの血管抵抗を反映。目標 <80、≥80 I 度、≥90 II 度。', high: '若年では収縮期より先に上昇することが多い。末梢血管抵抗・腎疾患と関連。' },
    },
    'Body Temperature': {
      en: { what: 'Core body temperature.', why: 'Normal: 36.1-37.2°C (97-99°F). Fever defined as ≥38°C (100.4°F) typically.', high: 'Infection, inflammation, heat exposure, certain medications (serotonin syndrome, malignant hyperthermia).', low: 'Cold exposure, hypothyroidism, sepsis (paradoxically), elderly.' },
      jp: { what: '体温(深部体温)。', why: '正常:36.1〜37.2°C。発熱の定義は通常 ≥38°C。', high: '感染・炎症・熱中症・薬剤性(セロトニン症候群・悪性高熱症)。', low: '寒冷暴露・甲状腺機能低下症・敗血症(逆説的)・高齢者。' },
    },
    'Respiratory Rate': {
      en: { what: 'Breaths per minute at rest.', why: 'Normal adult: 12-20. One of the most sensitive vital signs — changes early in clinical deterioration.', high: 'Anxiety, fever, pulmonary disease, acidosis, sepsis. Often the first vital sign to change in deterioration.', low: 'Opioid effect, sleep, hypothyroidism, central nervous system issues.' },
      jp: { what: '安静時の呼吸数(回/分)。', why: '成人正常:12〜20。最も鋭敏なバイタルサインの一つ — 容態悪化で最初に変化することが多い。', high: '不安・発熱・肺疾患・アシドーシス・敗血症。', low: 'オピオイド・睡眠・甲状腺機能低下症・中枢神経系異常。' },
    },
    'SpO2': {
      en: { what: 'Peripheral oxygen saturation — % of hemoglobin carrying oxygen, measured by fingertip pulse oximeter.', why: 'Quick screen for respiratory and cardiac function. Normal: 95-100%.', low: 'Lung disease (COPD, pneumonia, COVID), heart failure, high altitude, sleep apnea, anemia (severe).' },
      jp: { what: 'パルスオキシメータで測定する経皮的酸素飽和度。', why: '呼吸・循環機能の簡易スクリーニング。正常:95〜100%。', low: '肺疾患(COPD・肺炎・COVID)・心不全・高地・睡眠時無呼吸・重度貧血。' },
    },
    // ─── Liver function extras
    'Direct Bilirubin': {
      en: { what: 'Bilirubin that has been processed (conjugated) by the liver and is ready for excretion.', why: 'Helps distinguish causes of jaundice. Direct (conjugated) high = liver/bile-duct problem; indirect (unconjugated) high = pre-hepatic (hemolysis) or Gilbert\'s syndrome.', high: 'Bile-duct obstruction, hepatitis, cirrhosis, drug-induced cholestasis.' },
      jp: { what: '肝臓で抱合処理されて排泄準備が整ったビリルビン。', why: '黄疸の原因鑑別に有用。直接(抱合型)高値 = 肝・胆道系の問題、間接(非抱合型)高値 = 溶血や体質性。', high: '胆道閉塞・肝炎・肝硬変・薬剤性胆汁うっ滞。' },
    },
    'A/G Ratio': {
      en: { what: 'Ratio of albumin to globulin in serum. Normal range typically 1.2-2.2.', why: 'Quick check on protein balance. Low ratio (high globulin or low albumin) can suggest chronic inflammation, liver disease, or multiple myeloma.', low: 'Multiple myeloma, chronic liver disease, autoimmune disease, chronic infection. Worth investigating if persistent.' },
      jp: { what: 'アルブミン/グロブリン比。正常範囲は通常 1.2〜2.2。', why: 'タンパクバランスの簡易チェック。低比(グロブリン高または アルブミン低)は慢性炎症・肝疾患・多発性骨髄腫を示唆。', low: '多発性骨髄腫・慢性肝疾患・自己免疫疾患・慢性感染症。持続する場合は精査が必要。' },
    },
    'Cholinesterase': {
      en: { what: 'Liver-produced enzyme that breaks down acetylcholine.', why: 'Sensitive marker of liver synthetic function (like albumin) and exposure to organophosphate poisoning.', low: 'Liver disease (cirrhosis, hepatitis), malnutrition, organophosphate pesticide exposure, certain genetic variants.' },
      jp: { what: '肝臓で産生されアセチルコリンを分解する酵素。', why: '肝合成能の鋭敏な指標(アルブミンと同様)。有機リン中毒のスクリーニングにも使用。', low: '肝疾患(肝硬変・肝炎)・低栄養・有機リン農薬曝露・遺伝的変異。' },
    },
    'LAP': {
      en: { what: 'LAP (Leucine aminopeptidase) is a liver/bile-duct enzyme.', why: 'Used alongside ALP to distinguish liver/bile origin of elevated ALP from bone origin. Less commonly measured than γ-GTP today.' },
      jp: { what: 'LAP(ロイシンアミノペプチダーゼ)は肝・胆道系の酵素です。', why: 'ALP 上昇の鑑別(肝胆道由来 vs 骨由来)に ALP と併せて評価。現在は γ-GTP のほうが一般的。' },
    },
    'Z.T.T.': {
      en: { what: 'Zinc Sulfate Turbidity Test — an older liver function test measuring γ-globulin levels.', why: 'Largely replaced by direct serum protein electrophoresis. Still reported on Japanese routine physicals for historical comparison.', high: 'Chronic hepatitis, cirrhosis, autoimmune liver disease, multiple myeloma.' },
      jp: { what: '硫酸亜鉛混濁試験 — γ-グロブリンを測定する古典的な肝機能検査です。', why: '現在は血清タンパク分画に置き換わっていますが、日本の健診では履歴比較のため継続報告されています。', high: '慢性肝炎・肝硬変・自己免疫性肝疾患・多発性骨髄腫。' },
    },
    // ─── Electrolytes
    'Chloride': {
      en: { what: 'Chloride is an electrolyte that pairs with sodium for fluid and acid-base balance.', why: 'Usually tracks with sodium. Imbalances suggest acid-base disorders.' },
      jp: { what: '塩化物はナトリウムと共に水分・酸塩基平衡に関与する電解質です。', why: '通常ナトリウムと並行して変動。異常値は酸塩基平衡異常を示唆。' },
    },
    'Magnesium': {
      en: { what: 'Magnesium is essential for nerve, muscle, and heart rhythm function.', why: 'Often overlooked but critical for cardiac rhythm. Standard blood test reflects only ~1% of total body Mg.', low: 'Common with chronic alcohol use, diabetes, diuretic use, chronic diarrhea. Causes muscle cramps, arrhythmias, weakness.' },
      jp: { what: 'マグネシウムは神経・筋肉・心臓のリズムに必須のミネラルです。', why: '見落とされがちですが心リズムに重要。血中値は全身マグネシウムの約 1% のみを反映。', low: '常習飲酒・糖尿病・利尿薬使用・慢性下痢で多い。筋けいれん・不整脈・倦怠感の原因。' },
    },
    'Phosphorus': {
      en: { what: 'Phosphorus works with calcium for bone health and is critical for cellular energy (ATP).', why: 'Tightly regulated. Out-of-range values often reflect kidney function or parathyroid issues.', high: 'Kidney failure, hypoparathyroidism, excess vitamin D, tumor lysis syndrome.', low: 'Vitamin D deficiency, alcoholism, refeeding syndrome, certain antacids.' },
      jp: { what: 'リンはカルシウムと協働して骨健康を保ち、細胞エネルギー(ATP)に必須。', why: '厳密に制御される指標。異常値は腎機能や副甲状腺の問題を示唆することが多い。', high: '腎不全・副甲状腺機能低下症・ビタミン D 過剰・腫瘍崩壊症候群。', low: 'ビタミン D 不足・アルコール症・リフィーディング症候群・一部の制酸薬。' },
    },
    // ─── Iron studies
    'TIBC': {
      en: { what: 'Total Iron-Binding Capacity — measures the total amount of iron that transferrin (the iron transport protein) can carry.', why: 'Inversely tracks iron status. High TIBC = body trying to grab more iron (often iron deficient); low TIBC = ample iron or chronic disease.', high: 'Iron deficiency (body upregulating transferrin to scavenge more iron), pregnancy, oral contraceptives.', low: 'Chronic disease, inflammation, malnutrition, iron overload.' },
      jp: { what: '総鉄結合能 — トランスフェリン(鉄輸送タンパク)が運搬できる鉄の最大量。', why: '鉄状態と逆相関。TIBC 高値 = 体が鉄を求めている(鉄欠乏多い)、低値 = 鉄充足または慢性疾患。', high: '鉄欠乏(トランスフェリン増産で鉄を回収)・妊娠・経口避妊薬。', low: '慢性疾患・炎症・低栄養・鉄過剰症。' },
    },
    'UIBC': {
      en: { what: 'Unsaturated Iron-Binding Capacity = TIBC − serum iron. The "empty" portion of transferrin.', why: 'Practical measure of how much spare iron-carrying capacity exists. Higher UIBC = more empty transferrin = lower iron stores.' },
      jp: { what: '不飽和鉄結合能 = TIBC − 血清鉄。トランスフェリンの「空き」部分。', why: '鉄運搬の予備能を示す実用指標。UIBC 高値 = 空きが多い = 鉄貯蔵が少ない。' },
    },
    // ─── Lipid extras
    'β-Lipoprotein': {
      en: { what: 'β-Lipoprotein is largely composed of LDL plus IDL particles — the "bad" cholesterol fraction.', why: 'An older Japanese assay that captures similar territory to LDL. Often reported alongside LDL on JP physicals.', high: 'Same drivers as high LDL — saturated fat intake, genetics, hypothyroidism.' },
      jp: { what: 'β-リポタンパクは主に LDL + IDL で構成される動脈硬化性粒子です。', why: '古典的な日本の検査で、LDL と類似の領域をカバー。日本の健診では LDL と並列で報告されることが多い。', high: 'LDL 高値と同じ要因 — 飽和脂肪酸摂取・遺伝・甲状腺機能低下症。' },
    },
    'Lipoprotein(a)': {
      en: { what: 'Lp(a) is a genetically determined LDL-like particle that carries an extra apolipoprotein(a) attached.', why: 'Independent cardiovascular risk factor — high Lp(a) increases heart attack and stroke risk regardless of LDL. Largely determined by genetics; diet/lifestyle have little impact.', high: 'Higher cardiovascular risk; consider in patients with premature heart disease or strong family history. Few specific treatments available currently.' },
      jp: { what: 'Lp(a) は遺伝的に決定される LDL 様粒子で、追加のアポリポタンパク(a)が結合しています。', why: 'LDL とは独立した心血管リスク因子 — Lp(a) 高値は LDL に関わらず心筋梗塞・脳卒中リスクを高める。主に遺伝で決まり、食事・運動の影響は小さい。', high: '心血管リスク上昇。若年発症や家族歴の強い患者で考慮。現時点で特異的治療は限定的。' },
    },
    'Apolipoprotein A1': {
      en: { what: 'ApoA1 is the main protein component of HDL particles.', why: 'Better marker of "good cholesterol" capacity than HDL alone — measures the number of protective particles, not just their cholesterol content.', low: 'Cardiovascular risk; tracks with low HDL.' },
      jp: { what: 'ApoA1 は HDL の主要タンパク成分です。', why: 'HDL 単独より「善玉」粒子の数をより正確に評価できる指標。', low: '心血管リスク上昇。HDL 低値と並行。' },
    },
    'Apolipoprotein B': {
      en: { what: 'ApoB is the main protein on LDL, IDL, VLDL, and Lp(a) — one ApoB per atherogenic particle.', why: 'Direct count of atherogenic particles. Many cardiologists consider ApoB superior to LDL-C for cardiovascular risk assessment.', high: 'Strong predictor of heart attack and stroke risk. Optimal: <90 mg/dL; high-risk targets <80.' },
      jp: { what: 'ApoB は LDL・IDL・VLDL・Lp(a) の主要タンパクで、動脈硬化性粒子 1 個あたり 1 つの ApoB が結合しています。', why: '動脈硬化性粒子数の直接的指標。心血管リスク評価において LDL-C より優れているとする心臓専門医も多い。', high: '心筋梗塞・脳卒中リスクの強力な予測因子。理想:<90 mg/dL、高リスク者目標 <80。' },
    },
    // ─── Glycemic extras
    'Random Glucose': {
      en: { what: 'Blood glucose taken at any time, regardless of meals.', why: 'Quick screen — but ambiguous for diagnosis since values shift with recent eating. ≥200 mg/dL with diabetes symptoms is diagnostic.', high: 'Recent meal (especially carbs), diabetes, stress, certain medications.' },
      jp: { what: '食事に関係なく任意の時点で測定した血糖値。', why: '簡易スクリーニング — 食事の影響で診断には曖昧。≥200 mg/dL + 症状で糖尿病診断可。', high: '食後・糖尿病・ストレス・薬剤性。' },
    },
    'Postprandial Glucose': {
      en: { what: 'Blood glucose measured 1-2 hours after eating.', why: 'Captures the post-meal spike that fasting glucose misses. ≥200 mg/dL at 2 hours is diabetic-range; 140-199 prediabetic.', high: 'Diabetes, prediabetes, insulin resistance, certain medications.' },
      jp: { what: '食後 1〜2 時間の血糖値。', why: '空腹時血糖では捉えられない食後血糖上昇を評価。2 時間値 ≥200 で糖尿病範囲、140-199 で境界型。', high: '糖尿病・境界型糖尿病・インスリン抵抗性・薬剤性。' },
    },
    // ─── CBC indices + differentials
    'MCV': {
      en: { what: 'Mean Corpuscular Volume — average size of red blood cells.', why: 'Classifies anemia: low MCV (microcytic) = iron deficiency or thalassemia; high MCV (macrocytic) = B12/folate deficiency or liver disease; normal = chronic disease or hemolysis.', high: 'B12 or folate deficiency, alcohol use, liver disease, hypothyroidism, certain medications.', low: 'Iron deficiency, thalassemia, chronic disease.' },
      jp: { what: '平均赤血球容積 — 赤血球の平均サイズ。', why: '貧血の分類に使用:小球性(低 MCV) = 鉄欠乏・サラセミア、大球性(高 MCV) = B12/葉酸欠乏・肝疾患、正球性 = 慢性疾患・溶血。', high: 'B12/葉酸欠乏・飲酒・肝疾患・甲状腺機能低下症・薬剤性。', low: '鉄欠乏・サラセミア・慢性疾患。' },
    },
    'MCH': {
      en: { what: 'Mean Corpuscular Hemoglobin — average amount of hemoglobin per red blood cell.', why: 'Tracks closely with MCV. Low MCH usually reflects iron deficiency or thalassemia.' },
      jp: { what: '平均赤血球ヘモグロビン量 — 赤血球 1 個あたりの平均ヘモグロビン量。', why: 'MCV と並行して変動。低値は通常、鉄欠乏やサラセミアを反映。' },
    },
    'MCHC': {
      en: { what: 'Mean Corpuscular Hemoglobin Concentration — hemoglobin concentration within each red cell.', why: 'Falls in iron deficiency (red cells become pale — hypochromic). High MCHC is unusual and often a lab artifact or hereditary spherocytosis.' },
      jp: { what: '平均赤血球ヘモグロビン濃度 — 赤血球内のヘモグロビン濃度。', why: '鉄欠乏で低下(低色素性)。高値は稀で、検査エラーや遺伝性球状赤血球症が原因のことが多い。' },
    },
    'RDW': {
      en: { what: 'Red Cell Distribution Width — measures variability in red blood cell size.', why: 'Helpful for distinguishing types of anemia. High RDW + low MCV = iron deficiency; normal RDW + low MCV = thalassemia.', high: 'Mixed deficiencies (iron + B12), early iron deficiency, hemolysis, recovery from anemia.' },
      jp: { what: '赤血球分布幅 — 赤血球サイズのばらつき。', why: '貧血のタイプ分類に有用。高 RDW + 低 MCV = 鉄欠乏、正常 RDW + 低 MCV = サラセミア。', high: '複合欠乏(鉄 + B12)・初期の鉄欠乏・溶血・貧血からの回復期。' },
    },
    'MPV': {
      en: { what: 'Mean Platelet Volume — average size of platelets.', why: 'High MPV with low platelet count usually means active production (good — bone marrow is responding). Low MPV with low count is more concerning.', high: 'Active platelet turnover (ITP, post-bleed recovery), inflammation.', low: 'Bone marrow suppression, certain genetic conditions.' },
      jp: { what: '平均血小板容積 — 血小板の平均サイズ。', why: '高 MPV + 低血小板数は通常、骨髄が活発に新しい血小板を作っていることを示す(良い兆候)。低 MPV + 低血小板はより懸念される。', high: '血小板活発な代謝(ITP・出血後の回復)・炎症。', low: '骨髄抑制・遺伝性疾患。' },
    },
    'Reticulocytes': {
      en: { what: 'Reticulocytes are young red blood cells just released from bone marrow.', why: 'Measures bone marrow response. High retics with anemia = marrow working (blood loss, hemolysis); low retics with anemia = marrow failing (iron deficiency, aplastic anemia, B12 issues).', high: 'Active red cell production response (blood loss, hemolysis, treated iron deficiency).', low: 'Bone marrow suppression, iron/B12/folate deficiency.' },
      jp: { what: '網赤血球は骨髄から放出されたばかりの若い赤血球です。', why: '骨髄の反応性を測る指標。貧血+高網赤血球 = 骨髄が応答中(出血・溶血)、貧血+低網赤血球 = 骨髄機能不全(鉄欠乏・再生不良性貧血)。', high: '活発な赤血球産生(出血・溶血・鉄欠乏治療後)。', low: '骨髄抑制・鉄/B12/葉酸欠乏。' },
    },
    'Neutrophils': {
      en: { what: 'The most abundant white blood cells — first responders to bacterial infection.', why: 'Normal: 40-70% of WBC. Sharp increase often signals bacterial infection.', high: 'Bacterial infection, acute inflammation, steroid use, stress, smoking.', low: 'Viral infection, severe sepsis, chemotherapy, autoimmune destruction. <500 = severe infection risk.' },
      jp: { what: '最も多い白血球で、細菌感染の最初の防御細胞です。', why: '正常:WBC の 40-70%。急増は細菌感染を示唆。', high: '細菌感染・急性炎症・ステロイド使用・ストレス・喫煙。', low: 'ウイルス感染・重症敗血症・化学療法・自己免疫性破壊。<500 で重症感染リスク。' },
    },
    'Lymphocytes': {
      en: { what: 'Lymphocytes (T-cells, B-cells, NK cells) mediate immune memory and viral defense.', why: 'Normal: 20-40% of WBC. Patterns help distinguish viral vs bacterial infections.', high: 'Viral infection (mononucleosis, COVID, etc.), chronic lymphocytic leukemia.', low: 'HIV/AIDS, immunosuppression, severe acute infection, advanced age, certain medications.' },
      jp: { what: 'リンパ球(T 細胞・B 細胞・NK 細胞)は免疫記憶とウイルス防御を担います。', why: '正常:WBC の 20-40%。ウイルス感染と細菌感染の鑑別に有用。', high: 'ウイルス感染(伝染性単核症・COVID 等)・慢性リンパ性白血病。', low: 'HIV/AIDS・免疫抑制・重症急性感染・高齢者・薬剤性。' },
    },
    'Monocytes': {
      en: { what: 'Monocytes mature into macrophages — the cleanup crew of the immune system.', why: 'Normal: 2-10% of WBC. Elevations often indicate chronic infection or inflammation.', high: 'Chronic infection (TB, brucellosis), autoimmune disease, certain cancers, recovery from acute infection.' },
      jp: { what: '単球は組織内でマクロファージに分化する免疫細胞です。', why: '正常:WBC の 2-10%。上昇は慢性感染や炎症を示唆することが多い。', high: '慢性感染(結核・ブルセラ症)・自己免疫疾患・特定のがん・急性感染からの回復期。' },
    },
    'Eosinophils': {
      en: { what: 'Eosinophils fight parasites and mediate allergic responses.', why: 'Normal: 1-4% of WBC. Elevations often indicate allergy or parasitic infection.', high: 'Allergies (asthma, eczema, food/drug), parasitic infections, certain autoimmune and rare blood disorders.' },
      jp: { what: '好酸球は寄生虫を攻撃しアレルギー反応を媒介します。', why: '正常:WBC の 1-4%。上昇はアレルギーや寄生虫感染を示唆。', high: 'アレルギー(喘息・湿疹・食物/薬剤)・寄生虫感染・自己免疫疾患・稀な血液疾患。' },
    },
    'Basophils': {
      en: { what: 'Basophils are the least common white cells, involved in allergic reactions and inflammation.', why: 'Normal: 0-2% of WBC. Often clinically insignificant in routine screening.', high: 'Allergic reactions, chronic myeloid leukemia (rare cause but important).' },
      jp: { what: '好塩基球は最も少ない白血球で、アレルギー反応と炎症に関与します。', why: '正常:WBC の 0-2%。通常の健診では臨床的意義は限定的。', high: 'アレルギー反応・慢性骨髄性白血病(稀だが重要)。' },
    },
    // ─── Thyroid extras
    'Free T3': {
      en: { what: 'Free T3 is the unbound active form of triiodothyronine — the most metabolically active thyroid hormone.', why: 'Provides additional detail when TSH and Free T4 don\'t tell the full story (e.g., T3 thyrotoxicosis, sick euthyroid syndrome).', high: 'Hyperthyroidism (especially Graves\' disease or toxic nodule).', low: 'Hypothyroidism, severe illness ("low T3 syndrome" — non-thyroidal illness).' },
      jp: { what: 'Free T3 はトリヨードサイロニンの遊離(活性)型で、最も代謝活性の高い甲状腺ホルモンです。', why: 'TSH と Free T4 だけでは判断できない場合(T3 中毒症・非甲状腺疾患症候群)に詳細を提供。', high: '甲状腺機能亢進症(バセドウ病・中毒性結節)。', low: '甲状腺機能低下症・重症疾患(低 T3 症候群)。' },
    },
    'Total T4': {
      en: { what: 'Total T4 measures both protein-bound and free thyroxine.', why: 'Older test, less specific than Free T4 because pregnancy and oral estrogens raise binding proteins independently of true thyroid status.' },
      jp: { what: 'Total T4 はタンパク結合型と遊離型の両方を含む総サイロキシン量。', why: '古典的検査。Free T4 より特異性が低く、妊娠や経口エストロゲンで結合タンパクが増えると見かけ上変動。' },
    },
    'Total T3': {
      en: { what: 'Total T3 measures both protein-bound and free triiodothyronine.', why: 'Similar limitations to Total T4 — Free T3 is preferred for most clinical questions.' },
      jp: { what: 'Total T3 はタンパク結合型と遊離型の両方を含む総トリヨードサイロニン量。', why: 'Total T4 と同様の制限あり。臨床判断には Free T3 が優先されます。' },
    },
    // ─── Cardiac extras
    'NT-proBNP': {
      en: { what: 'NT-proBNP is released by stressed heart muscle, especially under volume/pressure overload.', why: 'Primary biomarker for heart failure. Useful for diagnosis and tracking response to treatment.', high: 'Heart failure (acute or chronic), atrial fibrillation, pulmonary embolism, kidney disease (mildly).' },
      jp: { what: 'NT-proBNP は容量・圧負荷を受けた心筋から放出されます。', why: '心不全診断の主要バイオマーカー。診断と治療反応の評価に有用。', high: '心不全(急性・慢性)・心房細動・肺塞栓症・腎疾患(軽度上昇)。' },
    },
    'BNP': {
      en: { what: 'BNP (B-type natriuretic peptide) is released by stressed heart muscle.', why: 'Similar role to NT-proBNP for heart failure diagnosis but with a much shorter half-life.', high: 'Heart failure, atrial fibrillation, pulmonary disease with cardiac involvement.' },
      jp: { what: 'BNP(脳性ナトリウム利尿ペプチド)は心筋ストレス時に放出されます。', why: '心不全診断における役割は NT-proBNP と同様だが、半減期がはるかに短い。', high: '心不全・心房細動・心臓に影響する肺疾患。' },
    },
    'Troponin I': {
      en: { what: 'Troponin I is a heart-muscle-specific protein released when heart cells die.', why: 'Gold standard biomarker for diagnosing heart attack. Highly specific to cardiac muscle.', high: 'Heart attack (rises within hours of symptoms, peaks at 12-24h). Smaller elevations: heart failure, myocarditis, severe sepsis, kidney failure.' },
      jp: { what: 'トロポニン I は心筋細胞が壊死した時に放出される心筋特異的タンパクです。', why: '心筋梗塞診断のゴールドスタンダード。心筋に高い特異性。', high: '心筋梗塞(症状発現後数時間で上昇、12-24 時間でピーク)。軽度上昇:心不全・心筋炎・重症敗血症・腎不全。' },
    },
    'Troponin T': {
      en: { what: 'Troponin T is another heart-muscle-specific protein. Used interchangeably with Troponin I depending on lab.', why: 'Same clinical role as Troponin I — diagnosis of heart muscle damage.', high: 'Heart attack, myocarditis, heart failure exacerbation.' },
      jp: { what: 'トロポニン T も心筋特異的タンパクで、検査機関により I と互換的に使用されます。', why: 'トロポニン I と同じ臨床的役割 — 心筋障害の診断。', high: '心筋梗塞・心筋炎・心不全増悪。' },
    },
    // ─── EKG
    'PR Interval': {
      en: { what: 'Time from atrial contraction to ventricular contraction on the EKG.', why: 'Normal: 0.12-0.20 seconds. Prolonged PR suggests AV node conduction delay; very short suggests pre-excitation (WPW).', high: 'First-degree AV block, beta-blockers, calcium channel blockers, athletes (often benign).' },
      jp: { what: 'EKG における心房収縮から心室収縮までの時間。', why: '正常:0.12〜0.20 秒。延長は房室結節の伝導遅延、短縮は早期興奮(WPW 症候群)を示唆。', high: '1 度房室ブロック・β 遮断薬・カルシウム拮抗薬・アスリート(通常良性)。' },
    },
    'QRS Duration': {
      en: { what: 'Time for ventricles to depolarize (contract) on the EKG.', why: 'Normal: <0.12 seconds. Wide QRS suggests bundle branch block, ventricular origin of beats, or hyperkalemia.', high: 'Bundle branch block (left or right), ventricular tachycardia, hyperkalemia, certain medications.' },
      jp: { what: 'EKG における心室脱分極(収縮)に要する時間。', why: '正常:<0.12 秒。延長は脚ブロック・心室性興奮・高カリウム血症を示唆。', high: '脚ブロック(左脚・右脚)・心室頻拍・高カリウム血症・薬剤性。' },
    },
    'QTc': {
      en: { what: 'QT interval corrected for heart rate — measures ventricular repolarization time.', why: 'Long QT increases risk of dangerous ventricular arrhythmias (torsades de pointes). Normal: <440 ms men, <460 ms women.', high: 'Long QT syndrome (genetic), many medications (antipsychotics, antibiotics, antidepressants), electrolyte imbalances (low K, Mg, Ca).' },
      jp: { what: '心拍数で補正した QT 間隔 — 心室再分極時間を測定。', why: 'QT 延長は致死的な心室性不整脈(トルサード)のリスク。正常:男性 <440 ms、女性 <460 ms。', high: 'QT 延長症候群(遺伝性)・多くの薬剤(抗精神病薬・抗生物質・抗うつ薬)・電解質異常(低 K/Mg/Ca)。' },
    },
    'C-T Ratio': {
      en: { what: 'Cardiothoracic ratio — heart width divided by chest width on chest X-ray.', why: 'Crude measure of heart enlargement. Normal: <50%. Sensitive but not specific.', high: 'Cardiomegaly: heart failure, valve disease, pericardial effusion, dilated cardiomyopathy.' },
      jp: { what: '心胸郭比 — 胸部 X 線における心臓幅 ÷ 胸郭幅。', why: '心拡大の簡易指標。正常:<50%。鋭敏だが特異性は低い。', high: '心拡大:心不全・弁膜症・心嚢液貯留・拡張型心筋症。' },
    },
    // ─── Spirometry
    'FVC': {
      en: { what: 'Forced Vital Capacity — total air you can forcefully exhale after maximum inhale.', why: 'Primary measure of lung volume. Low FVC = restrictive lung disease (fibrosis, neuromuscular).', low: 'Restrictive lung disease (pulmonary fibrosis, chest wall disease, neuromuscular weakness).' },
      jp: { what: '努力性肺活量 — 最大吸気後に勢いよく呼出できる空気量の総量。', why: '肺容量の主要指標。低値 = 拘束性肺障害(肺線維症・神経筋疾患)。', low: '拘束性肺障害(肺線維症・胸壁疾患・神経筋衰弱)。' },
    },
    'FEV1': {
      en: { what: 'Forced Expiratory Volume in 1 second — air exhaled in the first second of a forced exhale.', why: 'Primary measure of airflow obstruction. Low FEV1 with low FEV1/FVC ratio = obstructive disease (asthma, COPD).', low: 'Asthma, COPD, emphysema, bronchitis. Severity of COPD graded by FEV1: ≥80% normal/mild, 50-79% moderate, 30-49% severe, <30% very severe.' },
      jp: { what: '1 秒量 — 努力呼出の最初の 1 秒間に呼出できる空気量。', why: '気流閉塞の主要指標。低 FEV1 + 低 FEV1/FVC = 閉塞性疾患(喘息・COPD)。', low: '喘息・COPD・肺気腫・気管支炎。COPD 重症度:≥80% 正常/軽度、50-79% 中等度、30-49% 重度、<30% 最重度。' },
    },
    'FEV1/FVC': {
      en: { what: 'Ratio of FEV1 to FVC — what fraction of total lung capacity comes out in the first second.', why: 'Distinguishes obstructive (low ratio) from restrictive (preserved ratio) lung disease. Normal: ≥70%.', low: 'Obstructive lung disease (asthma, COPD, emphysema).' },
      jp: { what: 'FEV1 / FVC 比 — 全肺活量のうち最初の 1 秒で呼出される割合。', why: '閉塞性(低比)と拘束性(比は保持)肺疾患の鑑別。正常:≥70%。', low: '閉塞性肺疾患(喘息・COPD・肺気腫)。' },
    },
    '%FVC': {
      en: { what: 'FVC as a percentage of predicted FVC for someone of your age, sex, and height.', why: 'Normal: ≥80%. Lower values indicate restrictive lung disease.' },
      jp: { what: '同性同年齢同身長の予測値に対する FVC の割合(%)。', why: '正常:≥80%。低値は拘束性肺障害を示唆。' },
    },
    '%FEV1': {
      en: { what: 'FEV1 as a percentage of predicted FEV1 for someone of your age, sex, and height.', why: 'Used for COPD severity grading. Normal: ≥80%.' },
      jp: { what: '同性同年齢同身長の予測値に対する FEV1 の割合(%)。', why: 'COPD 重症度判定に使用。正常:≥80%。' },
    },
    // ─── Inflammation
    'hs-CRP': {
      en: { what: 'High-sensitivity CRP — same protein as standard CRP, measured with greater precision at low levels.', why: 'Used for cardiovascular risk assessment rather than acute inflammation. Low-grade chronic inflammation (hs-CRP 1-3 mg/L) is linked to heart disease risk.', high: '<1 low, 1-3 moderate, >3 high cardiovascular risk. Acute infection can transiently elevate >10.' },
      jp: { what: '高感度 CRP — 標準 CRP と同じタンパクを低濃度域で高精度に測定。', why: '急性炎症ではなく心血管リスク評価に使用。慢性低度炎症(hs-CRP 1-3 mg/L)は心疾患リスクと関連。', high: '<1 低、1-3 中等度、>3 高心血管リスク。急性感染で >10 まで一時的上昇。' },
    },
    'ESR': {
      en: { what: 'Erythrocyte Sedimentation Rate — how fast red cells settle in a tube.', why: 'Non-specific inflammation marker. Slower to rise/fall than CRP. Useful for monitoring chronic inflammatory diseases.', high: 'Chronic inflammation (rheumatoid arthritis, lupus, polymyalgia rheumatica), infection, certain cancers, anemia, advanced age.' },
      jp: { what: '赤血球沈降速度 — 試験管内で赤血球が沈む速度。', why: '非特異的炎症マーカー。CRP より変動がゆっくり。慢性炎症性疾患のモニタリングに有用。', high: '慢性炎症(リウマチ・SLE・リウマチ性多発筋痛症)・感染・特定のがん・貧血・高齢。' },
    },
    // ─── Vitamins
    'Folate': {
      en: { what: 'Folate (vitamin B9) is essential for DNA synthesis and red blood cell formation.', why: 'Deficiency causes macrocytic anemia (same as B12). Critical pre-conception and in early pregnancy to prevent neural tube defects.', low: 'Poor diet (low leafy greens), alcoholism, malabsorption, pregnancy (increased need), methotrexate.' },
      jp: { what: '葉酸(ビタミン B9)は DNA 合成と赤血球形成に必須です。', why: '欠乏は B12 と同様の大球性貧血を起こす。妊娠前・初期は神経管欠損予防に重要。', low: '食生活(緑黄色野菜不足)・アルコール症・吸収不良・妊娠(需要増)・メトトレキサート。' },
    },
    // ─── Coagulation
    'PT': {
      en: { what: 'Prothrombin Time — measures clotting via the extrinsic pathway (factors VII, X, V, II, fibrinogen).', why: 'Sensitive to warfarin effect and liver synthetic dysfunction. Usually reported with INR.', high: 'Warfarin effect, liver disease, vitamin K deficiency, DIC (disseminated intravascular coagulation).' },
      jp: { what: 'プロトロンビン時間 — 外因系凝固経路(第 VII・X・V・II 因子・フィブリノーゲン)を介した凝固を測定。', why: 'ワーファリンの効果と肝合成能の評価に鋭敏。通常 INR とともに報告。', high: 'ワーファリン服用・肝疾患・ビタミン K 欠乏・DIC(播種性血管内凝固)。' },
    },
    'INR': {
      en: { what: 'International Normalized Ratio — standardized PT to allow comparison across labs.', why: 'Primary monitoring tool for warfarin. Therapeutic range typically 2-3 (some indications 2.5-3.5). >5 has bleeding risk.', high: 'Warfarin dose too high, drug interactions, liver disease, vitamin K deficiency.' },
      jp: { what: '国際標準化比 — 検査機関を超えて比較可能な標準化された PT。', why: 'ワーファリン治療のモニタリングに使用。治療域は通常 2〜3(一部適応は 2.5〜3.5)。>5 で出血リスク。', high: 'ワーファリン過量・薬剤相互作用・肝疾患・ビタミン K 欠乏。' },
    },
    'aPTT': {
      en: { what: 'Activated Partial Thromboplastin Time — measures the intrinsic clotting pathway.', why: 'Used to monitor heparin therapy and screen for hemophilia/von Willebrand disease.', high: 'Heparin effect, hemophilia, von Willebrand disease, antiphospholipid syndrome, severe liver disease.' },
      jp: { what: '活性化部分トロンボプラスチン時間 — 内因系凝固経路の評価。', why: 'ヘパリン療法のモニタリングと血友病・フォンウィルブランド病のスクリーニング。', high: 'ヘパリン使用・血友病・フォンウィルブランド病・抗リン脂質抗体症候群・重度肝疾患。' },
    },
    'D-dimer': {
      en: { what: 'D-dimer is a breakdown product of cross-linked fibrin (blood clots).', why: 'Rules OUT clots when negative (high negative predictive value); a positive result is non-specific and needs follow-up imaging.', high: 'Pulmonary embolism, deep vein thrombosis, DIC, recent surgery, infection, pregnancy, advanced age.' },
      jp: { what: 'D ダイマーは架橋フィブリン(血栓)の分解産物です。', why: '陰性で血栓を除外する(陰性的中率高い)。陽性は非特異的なので画像検査での確認が必要。', high: '肺塞栓症・深部静脈血栓症・DIC・術後・感染・妊娠・高齢。' },
    },
    'Fibrinogen': {
      en: { what: 'Fibrinogen is the clotting protein that converts to fibrin during clot formation.', why: 'Required for normal clotting. Also an acute-phase reactant — rises with inflammation.', high: 'Acute inflammation, infection, smoking, certain cancers, cardiovascular risk.', low: 'DIC (consumption), severe liver disease, congenital deficiency.' },
      jp: { what: 'フィブリノーゲンは凝固時にフィブリンに変換される凝固タンパクです。', why: '正常な凝固に必須。急性期反応物でもあり炎症で上昇。', high: '急性炎症・感染・喫煙・特定のがん・心血管リスク。', low: 'DIC(消費性低下)・重度肝疾患・先天性欠損。' },
    },
    // ─── Tumor markers
    'AFP': {
      en: { what: 'AFP (alpha-fetoprotein) is a fetal protein normally absent in adults.', why: 'Screens for liver cancer (hepatocellular carcinoma) and germ cell tumors. Not specific — also elevated in pregnancy and chronic liver disease.', high: 'Liver cancer, testicular/ovarian germ cell tumors, pregnancy (physiological), chronic active hepatitis.' },
      jp: { what: 'AFP(アルファフェトプロテイン)は胎児期のタンパクで、通常成人にはほぼ存在しません。', why: '肝細胞がんと胚細胞腫瘍のスクリーニング。非特異的 — 妊娠や慢性肝疾患でも上昇。', high: '肝細胞がん・精巣/卵巣胚細胞腫瘍・妊娠(生理的)・慢性活動性肝炎。' },
    },
    'CEA': {
      en: { what: 'CEA (Carcinoembryonic Antigen) is a fetal protein expressed in some adult cancers.', why: 'Most useful for tracking colorectal cancer treatment response — less effective as a screening tool.', high: 'Colorectal cancer (esp. metastatic), other cancers (lung, breast, pancreas), smokers (mildly elevated baseline), inflammatory bowel disease.' },
      jp: { what: 'CEA(癌胎児性抗原)は胎児期のタンパクで、一部の成人がんで発現します。', why: '大腸がん治療反応のモニタリングに最も有用。スクリーニング検査としては限定的。', high: '大腸がん(特に転移)・その他のがん(肺・乳・膵)・喫煙者(ベース軽度上昇)・炎症性腸疾患。' },
    },
    'CA 19-9': {
      en: { what: 'CA 19-9 is a glycoprotein associated with pancreatic and bile-duct cancers.', why: 'Primarily used to monitor pancreatic cancer treatment. About 5-10% of people genetically can\'t produce it (false negative).', high: 'Pancreatic cancer, biliary obstruction, cholangiocarcinoma, also pancreatitis and benign biliary disease.' },
      jp: { what: 'CA 19-9 は膵がん・胆道がんに関連する糖タンパクです。', why: '主に膵がん治療のモニタリング。5-10% の人は遺伝的に産生できない(偽陰性)。', high: '膵がん・胆道閉塞・胆管がん。膵炎や良性胆道疾患でも上昇。' },
    },
    'CA 125': {
      en: { what: 'CA 125 is a glycoprotein elevated in ovarian and some other cancers.', why: 'Primarily used for ovarian cancer monitoring. Not a reliable screening test — many benign conditions cause elevations.', high: 'Ovarian cancer, endometriosis, fibroids, pelvic inflammatory disease, pregnancy, menstruation.' },
      jp: { what: 'CA 125 は卵巣がんなどで上昇する糖タンパクです。', why: '主に卵巣がんのモニタリングに使用。スクリーニングには不向き — 良性疾患でも上昇するため。', high: '卵巣がん・子宮内膜症・子宮筋腫・骨盤内炎症性疾患・妊娠・月経。' },
    },
    'CA 15-3': {
      en: { what: 'CA 15-3 is a marker associated with breast cancer.', why: 'Used to monitor metastatic breast cancer treatment. Not for screening.', high: 'Breast cancer (especially advanced), benign breast disease, liver disease, some other cancers.' },
      jp: { what: 'CA 15-3 は乳がん関連マーカーです。', why: '転移性乳がん治療のモニタリングに使用。スクリーニング目的では用いません。', high: '乳がん(特に進行例)・良性乳腺疾患・肝疾患・他のがん。' },
    },
    'PIVKA-II': {
      en: { what: 'PIVKA-II (Protein Induced by Vitamin K Absence-II / DCP) is a marker for hepatocellular carcinoma.', why: 'Often used together with AFP for liver cancer screening in patients with chronic hepatitis. More specific than AFP for HCC.', high: 'Hepatocellular carcinoma, vitamin K deficiency, warfarin use, severe liver disease.' },
      jp: { what: 'PIVKA-II(DCP — ビタミン K 欠乏誘導タンパク II)は肝細胞がんのマーカーです。', why: '慢性肝炎患者の肝がんスクリーニングで AFP と併用。AFP より HCC 特異性が高い。', high: '肝細胞がん・ビタミン K 欠乏・ワーファリン服用・重度肝疾患。' },
    },
    // ─── Autoimmune
    'Rheumatoid Factor': {
      en: { what: 'RF is an autoantibody that targets normal antibodies. Found in rheumatoid arthritis and other autoimmune diseases.', why: 'Helps diagnose rheumatoid arthritis but is not specific — 20% of healthy elderly people have mild elevations.', high: 'Rheumatoid arthritis (70-80% positive), Sjögren\'s syndrome, lupus, chronic infection, advanced age (often benign).' },
      jp: { what: 'RF は正常抗体を攻撃する自己抗体で、リウマチや他の自己免疫疾患で陽性となります。', why: 'リウマチ診断の補助。ただし非特異的 — 健常高齢者の 20% が軽度陽性。', high: 'リウマチ(70-80% 陽性)・シェーグレン症候群・SLE・慢性感染・高齢(良性のことが多い)。' },
    },
    // ─── Urinalysis
    'Urine pH': {
      en: { what: 'Acidity of the urine. Normal: 5.0-7.5.', why: 'Reflects diet and acid-base status. Diet-driven — vegetarian diets push toward alkaline, high-protein toward acidic.', high: 'Vegetarian diet, UTI with urea-splitting bacteria, certain medications, kidney stone risk (alkaline → calcium phosphate stones).', low: 'High-protein diet, dehydration, diabetic ketoacidosis, kidney stone risk (acidic → uric acid stones).' },
      jp: { what: '尿の酸性度。正常:5.0〜7.5。', why: '食事と酸塩基状態を反映。菜食でアルカリ性に、高タンパク食で酸性に傾く。', high: '菜食・尿素分解菌による尿路感染・薬剤性・腎結石リスク(アルカリ性 → リン酸カルシウム結石)。', low: '高タンパク食・脱水・糖尿病性ケトアシドーシス・腎結石リスク(酸性 → 尿酸結石)。' },
    },
    'Urine Specific Gravity': {
      en: { what: 'Urine concentration — how much dissolved substance per volume.', why: 'Reflects hydration and kidney concentrating ability. Normal range: 1.005-1.030.', high: 'Dehydration, glucose in urine (diabetes), proteinuria, SIADH.', low: 'Overhydration, diabetes insipidus, severe kidney damage (loss of concentrating ability).' },
      jp: { what: '尿の濃度 — 単位容積あたりの溶質量。', why: '水分状態と腎の濃縮能を反映。正常範囲:1.005〜1.030。', high: '脱水・尿糖(糖尿病)・タンパク尿・SIADH。', low: '過剰水分摂取・尿崩症・重度の腎障害(濃縮能喪失)。' },
    },
    'Urine Protein': {
      en: { what: 'Protein in urine (should normally be near-zero).', why: 'Kidney damage screening — even small amounts (microalbuminuria) indicate early kidney damage in diabetes and hypertension.', high: 'Kidney disease (diabetic nephropathy, glomerulonephritis), UTI, fever, exercise, dehydration, orthostatic proteinuria (benign in young people).' },
      jp: { what: '尿中タンパク(通常はほぼゼロのはず)。', why: '腎障害のスクリーニング — 微量(微量アルブミン尿)でも糖尿病・高血圧の早期腎障害を示唆。', high: '腎疾患(糖尿病性腎症・糸球体腎炎)・尿路感染・発熱・運動後・脱水・起立性タンパク尿(若年者で良性)。' },
    },
    'Urine Glucose': {
      en: { what: 'Sugar in urine (should normally be absent).', why: 'Glucose appears in urine when blood glucose exceeds the kidney threshold (~180 mg/dL). Less sensitive than blood glucose for diabetes screening.', high: 'Uncontrolled diabetes, renal glycosuria (lower kidney threshold — benign), pregnancy.' },
      jp: { what: '尿中ブドウ糖(通常は陰性)。', why: '血糖が腎閾値(約 180 mg/dL)を超えると尿に出現。糖尿病スクリーニングとしては血糖より鋭敏性が低い。', high: 'コントロール不良な糖尿病・腎性糖尿(腎閾値が低い — 良性)・妊娠。' },
    },
    'Urine Ketones': {
      en: { what: 'Ketones are byproducts of fat breakdown when glucose isn\'t available for energy.', why: 'Normally absent. Appears when the body switches to fat-burning mode.', high: 'Fasting, low-carb/ketogenic diet, diabetic ketoacidosis (DANGEROUS — needs immediate care if accompanied by high blood sugar), prolonged vomiting, severe illness.' },
      jp: { what: 'ケトン体はブドウ糖が利用できない時の脂肪分解産物です。', why: '通常は陰性。体が脂肪燃焼モードに切り替わると検出されます。', high: '空腹・低糖質/ケトン食・糖尿病性ケトアシドーシス(危険 — 高血糖を伴う場合は緊急受診)・嘔吐持続・重症疾患。' },
    },
    'Urine Bilirubin': {
      en: { what: 'Bilirubin in urine (normally absent).', why: 'Indicates liver disease or bile-duct obstruction. Often the first sign of jaundice (appears before yellow skin/eyes).', high: 'Hepatitis, cirrhosis, bile-duct obstruction.' },
      jp: { what: '尿中ビリルビン(通常は陰性)。', why: '肝疾患や胆道閉塞を示唆。黄疸の最初の兆候として、皮膚や眼球の黄染より早く検出されることが多い。', high: '肝炎・肝硬変・胆道閉塞。' },
    },
    'Urine Nitrites': {
      en: { what: 'Nitrites in urine indicate bacteria that convert nitrate to nitrite — a quick UTI screen.', why: 'Positive nitrites strongly suggests bacterial UTI. False negatives common if urine sat in bladder briefly.', high: 'Bacterial urinary tract infection.' },
      jp: { what: '尿中亜硝酸塩は硝酸塩を亜硝酸塩に変換する細菌の存在を示す尿路感染スクリーニング。', why: '陽性は細菌性尿路感染を強く示唆。膀胱内貯留時間が短いと偽陰性も多い。', high: '細菌性尿路感染症。' },
    },
    'Urobilinogen': {
      en: { what: 'Breakdown product of bilirubin metabolized by gut bacteria, partially reabsorbed and excreted in urine.', why: 'Small amounts are normal. Increases suggest excessive bilirubin production (hemolysis) or liver disease.', high: 'Hemolytic anemia, hepatitis, cirrhosis.' },
      jp: { what: 'ビリルビンが腸内細菌により代謝された産物で、一部が再吸収されて尿に排出されます。', why: '少量は正常。増加は過剰なビリルビン産生(溶血)や肝疾患を示唆。', high: '溶血性貧血・肝炎・肝硬変。' },
    },
    'RBC (Urine)': {
      en: { what: 'Red blood cells in urine.', why: 'Should be minimal (0-3 per high-power field). Higher amounts indicate bleeding somewhere in the urinary tract.', high: 'UTI, kidney stones, kidney disease (glomerulonephritis), bladder/kidney cancer, trauma, vigorous exercise, menstrual contamination.' },
      jp: { what: '尿中赤血球。', why: '通常は最小限(高倍率視野あたり 0-3 個)。多量は尿路のどこかの出血を示唆。', high: '尿路感染・腎結石・腎疾患(糸球体腎炎)・膀胱/腎がん・外傷・激しい運動・月経混入。' },
    },
    'WBC (Urine)': {
      en: { what: 'White blood cells in urine.', why: 'Should be minimal. Elevated WBCs indicate urinary tract inflammation, most commonly infection.', high: 'UTI (most common), pyelonephritis, interstitial nephritis, kidney stones.' },
      jp: { what: '尿中白血球。', why: '通常は最小限。増加は尿路の炎症 — 最多は感染。', high: '尿路感染症(最多)・腎盂腎炎・間質性腎炎・腎結石。' },
    },
    'Epithelial cells (Urine)': {
      en: { what: 'Cells from the lining of the urinary tract.', why: 'Squamous epithelial cells often indicate skin contamination from collection (not clinically significant). Renal tubular cells in larger numbers suggest kidney damage.', high: 'Specimen contamination (most common), urinary tract inflammation, renal tubular injury.' },
      jp: { what: '尿路上皮の剥離細胞。', why: '扁平上皮細胞は通常、採尿時の皮膚由来混入を示し臨床的意義は低い。腎尿細管細胞の大量出現は腎障害を示唆。', high: '検体汚染(最多)・尿路の炎症・腎尿細管障害。' },
    },
    // ─── Infectious disease
    'HBs Antigen (qual)': {
      en: { what: 'Hepatitis B Surface Antigen, qualitative — positive/negative result.', why: 'Detects active hepatitis B infection. Positive = currently infected (acute or chronic).', high: 'Active hepatitis B infection. Needs follow-up testing to distinguish acute vs. chronic and assess viral load.' },
      jp: { what: 'B 型肝炎ウイルス表面抗原(定性) — 陽性・陰性判定。', why: '活動性 B 型肝炎感染を検出。陽性 = 現在感染中(急性または慢性)。', high: '活動性 B 型肝炎感染。急性/慢性の鑑別とウイルス量評価のため追加検査が必要。' },
    },
    'HBs Antigen (quant)': {
      en: { what: 'Hepatitis B Surface Antigen, quantitative — measured concentration.', why: 'Used to monitor treatment response in chronic hepatitis B. Lower levels generally indicate better disease control.', high: 'Active hepatitis B infection with viral replication.' },
      jp: { what: 'B 型肝炎ウイルス表面抗原(定量) — 濃度測定値。', why: '慢性 B 型肝炎の治療反応モニタリングに使用。低値ほど病勢が抑えられていることを示唆。', high: 'ウイルス複製を伴う活動性 B 型肝炎感染。' },
    },
    'HCV Antibody (qual)': {
      en: { what: 'Hepatitis C antibody, qualitative — positive/negative result.', why: 'Detects past or present hepatitis C exposure. Positive antibody does NOT necessarily mean active infection — needs HCV RNA to confirm.', high: 'Past or current hepatitis C exposure. Need HCV RNA testing to determine if infection is active. Active HCV is now curable with antiviral therapy.' },
      jp: { what: 'C 型肝炎抗体(定性) — 陽性・陰性判定。', why: '過去または現在の C 型肝炎曝露を検出。抗体陽性 = 活動性感染とは限らない — HCV RNA 検査で確認が必要。', high: '過去または現在の C 型肝炎曝露。HCV RNA 検査で活動性感染の有無を判定。現在の活動性 HCV は抗ウイルス療法で治癒可能。' },
    },
    'HCV Antibody (index)': {
      en: { what: 'HCV antibody index value — semiquantitative measure of antibody level.', why: 'Higher index values generally correlate with true positive results. Low-index positives may need confirmatory testing.' },
      jp: { what: 'C 型肝炎抗体インデックス値 — 抗体レベルの半定量指標。', why: '高インデックス値は真の陽性をより示唆。低値陽性は確認検査が必要なことも。' },
    },
    'HCV Antibody (unit)': {
      en: { what: 'HCV antibody titer in defined units.', why: 'Alternative quantitative measure of HCV antibody response.' },
      jp: { what: '定義された単位での HCV 抗体価。', why: 'HCV 抗体反応の代替的な定量指標。' },
    },
    'RPR (Syphilis screen)': {
      en: { what: 'Rapid Plasma Reagin — screening test for syphilis.', why: 'Detects antibodies produced in response to syphilis infection. Confirmed positives require treponemal-specific testing.', high: 'Syphilis (any stage), also false positives from autoimmune disease, pregnancy, certain infections.' },
      jp: { what: 'RPR 法 — 梅毒スクリーニング検査。', why: '梅毒感染に対する抗体を検出。陽性確定にはトレポネーマ特異検査が必要。', high: '梅毒(全病期)。自己免疫疾患・妊娠・他の感染症で偽陽性も。' },
    },
    'ASO': {
      en: { what: 'Antistreptolysin O — measures antibodies to streptococcus bacteria.', why: 'Detects recent strep infection, used to diagnose post-streptococcal complications (rheumatic fever, post-strep glomerulonephritis).', high: 'Recent group A strep infection. Rises 1-3 weeks after infection, peaks at 3-6 weeks.' },
      jp: { what: '抗ストレプトリジン O — A 群連鎖球菌に対する抗体を測定。', why: '直近の溶連菌感染を検出。リウマチ熱や溶連菌感染後糸球体腎炎の診断に使用。', high: '直近の A 群溶連菌感染。感染後 1〜3 週で上昇、3〜6 週でピーク。' },
    },
    // ─── Ophthalmology
    'Ocular Pressure (Left)': {
      en: { what: 'Intraocular pressure of the left eye.', why: 'Primary screen for glaucoma. Normal: 10-21 mmHg. Elevated pressure damages the optic nerve over time.', high: 'Glaucoma (open-angle most common), uveitis, certain medications (steroids), acute angle-closure (medical emergency if very high + eye pain + vision changes).' },
      jp: { what: '左眼の眼圧。', why: '緑内障の主要スクリーニング指標。正常:10〜21 mmHg。眼圧上昇は視神経を経時的に傷害。', high: '緑内障(開放隅角型が多い)・ブドウ膜炎・薬剤性(ステロイド)・急性閉塞隅角緑内障(高眼圧+眼痛+視力障害で緊急受診)。' },
    },
    'Ocular Pressure (Right)': {
      en: { what: 'Intraocular pressure of the right eye.', why: 'Primary screen for glaucoma. Normal: 10-21 mmHg. Asymmetry between eyes (>3 mmHg) can be a concerning sign even when both are within "normal" range.', high: 'Same causes as left-eye elevation. Always compare to opposite eye.' },
      jp: { what: '右眼の眼圧。', why: '緑内障の主要スクリーニング指標。正常:10〜21 mmHg。左右差(>3 mmHg)は両眼とも「正常」範囲内でも要注意。', high: '左眼高値と同じ原因。常に対側眼と比較。' },
    },
  };

  // ─── AI-generated lab descriptions (overrides) ──────────────────
  //
  // For tests not in the built-in LAB_INFO table, the Health Tracker
  // can ask Claude to generate descriptions on the fly during vision
  // import. Results are cached in state so subsequent imports of the
  // same test name don't trigger re-generation.
  //
  // Stored at `health_tracker.lab_info_overrides[testName] = { en, jp,
  // ai_generated, generated_at }`. The ⓘ popover prefers built-in
  // LAB_INFO when both exist (manual writeups override AI), but
  // falls through to overrides for tests we don't yet cover.
  function getLabInfoOverrides() {
    return (getHt().lab_info_overrides) || {};
  }
  function setLabInfoOverride(name, data) {
    const cur = getLabInfoOverrides();
    cur[name] = data;
    patchHt({ lab_info_overrides: cur });
  }
  // Single lookup helper — checked everywhere instead of direct
  // LAB_INFO[name] reads. Returns null when neither source has it.
  function getLabInfoFor(name) {
    if (!name) return null;
    if (LAB_INFO[name]) return LAB_INFO[name];
    const overrides = getLabInfoOverrides();
    return overrides[name] || null;
  }

  // Post-extraction hook: identify tests whose canonical name has no
  // description on file, and ask Claude (text-only, NO PHI) to
  // generate one. Mutates state via setLabInfoOverride; UI re-renders
  // pick up the new info on next paint of the Lab Results tab.
  //
  // statusEl: optional DOM node to update with progress text. Quiet on
  // failure so the main extraction flow isn't interrupted.
  async function maybeGenerateLabDescriptions(ext, statusEl) {
    if (!ext || !Array.isArray(ext.lab_results) || ext.lab_results.length === 0) return;
    if (!TB.ai || typeof TB.ai.callClaudeForLabDescriptions !== 'function') return;
    if (!TB.ai.hasKey || !TB.ai.hasKey()) return;
    // Respect consent: ask_taigan covers educational text-only flows.
    if (typeof TB.ai.isFeatureAllowed === 'function' &&
        TB.ai.isFeatureAllowed('ask_taigan') === false) return;

    // Collect unique canonical names that we don't yet have info for.
    const wanted = [];
    const seen = new Set();
    for (const lr of ext.lab_results) {
      const raw = String(lr && lr.name || '').trim();
      if (!raw) continue;
      const canon = normalizeLabName(raw);
      if (seen.has(canon)) continue;
      seen.add(canon);
      if (getLabInfoFor(canon)) continue;
      wanted.push(canon);
    }
    if (wanted.length === 0) return;

    if (statusEl) {
      statusEl.textContent = '✨ ' + TB.i18n.t('ht.labs.info.aiGenerating', { n: wanted.length });
      statusEl.style.color = 'var(--tb-text-soft)';
    }

    try {
      const result = await TB.ai.callClaudeForLabDescriptions(wanted, { feature: 'ask_taigan' });
      const descs = (result && result.descriptions) || {};
      let saved = 0;
      for (const name of Object.keys(descs)) {
        const d = descs[name];
        if (!d) continue;
        // Validate basic shape — need at least one language present.
        if (!d.en && !d.jp) continue;
        setLabInfoOverride(name, Object.assign({}, d, {
          ai_generated: true,
          generated_at: new Date().toISOString(),
        }));
        saved++;
      }
      if (statusEl && saved > 0) {
        statusEl.textContent = '✨ ' + TB.i18n.t('ht.labs.info.aiGenerated.done',
          { n: saved, cost: (result.cost_usd || 0).toFixed(4) });
        statusEl.style.color = 'var(--tb-success)';
      }
    } catch (err) {
      // Quiet fail — main extraction flow continues. Surface only if
      // there's a status element to update so the user sees nothing
      // is broken; the rest of the import proceeds normally.
      if (statusEl) {
        console.warn('[lab-info] AI description fetch failed:', err);
      }
    }
  }

  // Memoize so we don't re-scan the table on every cell render.
  const __labNameCache = {};
  function normalizeLabName(name) {
    if (!name) return '';
    const trimmed = String(name).trim();
    if (!trimmed) return '';
    if (__labNameCache[trimmed] !== undefined) return __labNameCache[trimmed];
    for (const entry of LAB_CANONICAL) {
      for (const pat of entry.patterns) {
        if (pat instanceof RegExp && pat.test(trimmed)) {
          __labNameCache[trimmed] = entry.canonical;
          return entry.canonical;
        }
      }
    }
    __labNameCache[trimmed] = trimmed;
    return trimmed;
  }

  // ─── Fuzzy duplicate detection (post-extraction) ────────────────
  //
  // After a vision import, scan extracted lab names against the user's
  // existing distinct stored names. When two names normalize to the
  // SAME canonical, the display layer auto-merges — no action needed.
  // What we want to surface is names that normalize differently but
  // are SUSPICIOUSLY similar — likely the same test that our regex
  // table doesn't know about yet.
  //
  // Similarity signals (any one triggers a flag):
  //   • Strict superset: A contains B (case-insensitive, after
  //     stripping non-alphanumerics). Catches "Body Fat" ⊂
  //     "Body Fat Mass" — same root term, distinct measurement;
  //     surfaced so the user can dismiss ("they're different")
  //     or merge ("same thing").
  //   • Levenshtein distance ≤ 2 on normalized strings ≥ 6 chars.
  //     Catches typo-level differences.
  //   • Same alphanumeric "fingerprint" (lowercased, non-alpha
  //     stripped). Catches "HDL-C" vs "HDLC" vs "HDL C".

  function _alphaFingerprint(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function _levenshtein(a, b) {
    a = String(a || '').toLowerCase();
    b = String(b || '').toLowerCase();
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    // Bail out fast when length difference alone exceeds our threshold.
    if (Math.abs(a.length - b.length) > 3) return 99;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
  }

  // Return potential duplicate pairs found in an extracted lab_results
  // array against the existing exam history. Each result:
  //   { extracted_name, existing_name, reason, existing_canonical }
  // Already-canonicalized matches (both names map to the same
  // canonical) are EXCLUDED — those auto-merge cleanly already.
  function findPotentialDuplicateLabNames(extracted) {
    const labs = Array.isArray(extracted && extracted.lab_results) ? extracted.lab_results : [];
    if (labs.length === 0) return [];

    // Build the universe of existing distinct stored names.
    const existingSet = new Set();
    for (const e of getExams()) {
      for (const lr of (e.lab_results || [])) {
        const n = String(lr.name || '').trim();
        if (n) existingSet.add(n);
      }
    }
    if (existingSet.size === 0) return [];
    const existingList = Array.from(existingSet);

    const out = [];
    const seenPairs = new Set();
    for (const lr of labs) {
      const extName = String(lr.name || '').trim();
      if (!extName) continue;
      const extCanon = normalizeLabName(extName);
      const extFp = _alphaFingerprint(extName);
      if (extFp.length < 2) continue;

      for (const existName of existingList) {
        if (existName === extName) continue; // identical — not a "potential" dup
        const existCanon = normalizeLabName(existName);
        if (existCanon === extCanon) continue; // auto-merges via canonical table
        const existFp = _alphaFingerprint(existName);
        if (!existFp) continue;

        let reason = null;
        if (extFp === existFp) {
          reason = 'fingerprint'; // "HDL-C" vs "HDL C" — same letters, different punctuation
        } else if (extFp.length >= 4 && existFp.length >= 4 &&
                   (extFp.includes(existFp) || existFp.includes(extFp))) {
          reason = 'substring';
        } else if (extName.length >= 6 && existName.length >= 6 &&
                   _levenshtein(extName, existName) <= 2) {
          reason = 'typo';
        }
        if (!reason) continue;

        // Dedupe pairs — only first-seen reason wins.
        const key = extName + '||' + existName;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        out.push({
          extracted_name: extName,
          existing_name: existName,
          existing_canonical: existCanon,
          reason,
        });
      }
    }
    return out;
  }

  // Cross-query helpers — surface the episode's full constellation of
  // attached records. Each returns the records in chronological order
  // (oldest first for timelines, newest first for status lists).
  function examsForEpisode(epId) {
    return getExams().filter((e) => e.episode_id === epId)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }
  function medicationsForEpisode(epId) {
    return getMeds().filter((m) => m.episode_id === epId)
      .sort((a, b) => (b.started_date || '').localeCompare(a.started_date || ''));
  }
  function invoicesForEpisode(epId) {
    return getInvoices().filter((i) => i.episode_id === epId)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  }
  // Sum invoices for an episode in USD. Reimbursed amounts are
  // subtracted from totals when `net=true` (default). For non-USD
  // invoices, we use amount_usd_calc (captured at entry time) rather
  // than re-converting at the current rate — preserves historical
  // truth, prevents FX-drift fictional numbers.
  // Auto-derive episode metadata from its attached records.
  //
  // Rules:
  //   • Date range: ALWAYS pulled from attached records.
  //       started_date  = earliest date across exams + meds.started_date + invoices
  //       completed_date = latest date (only set when status='completed',
  //         so a still-active episode doesn't get an artificial end date).
  //   • Provider / facility / specialty / related_condition:
  //       auto-fill ONLY when the user hasn't set them yet (or has set
  //       a derived value that matches the previous auto-fill). Most-
  //       common value wins when records disagree.
  //   • Notes: when blank, populate by concatenating per-exam +
  //       per-document AI summaries with date tags. Once the user
  //       edits, we don't touch it.
  //   • Outcome: same as notes but only fills when status='completed'
  //       so an active episode doesn't get a premature outcome.
  //
  // The auto-derived values are marked with `__derived_<field>` keys
  // on the episode so we can detect "user-set vs auto-set" on later
  // attachments — when a user manually edits a field, we strip the
  // matching __derived_ marker so we never overwrite their edit.
  function recomputeEpisodeDerivedFields(epId) {
    const ep = getEpisodes().find((e) => e.id === epId);
    if (!ep) return;
    const exams = examsForEpisode(epId);
    const meds = medicationsForEpisode(epId);
    const invs = invoicesForEpisode(epId);

    // Collect all relevant dates
    const dates = [];
    exams.forEach((e) => { if (e.date) dates.push(e.date); });
    meds.forEach((m) => { if (m.started_date) dates.push(m.started_date); });
    invs.forEach((i) => { if (i.date) dates.push(i.date); });

    if (dates.length > 0) {
      dates.sort();
      // started_date: always min — date range should reflect reality
      ep.started_date = dates[0];
      // completed_date: only set when status indicates closure
      if (ep.status === 'completed') {
        ep.completed_date = dates[dates.length - 1];
      }
    }

    // Helper: auto-fill a string field if blank OR if it was previously
    // auto-derived (so attaching new records can update the derived
    // value, but a user-edited value sticks).
    function autoFillString(field, candidate) {
      if (!candidate) return;
      const cur = ep[field];
      const wasDerived = ep['__derived_' + field] === true;
      const isBlank = !cur || String(cur).trim().length === 0;
      if (isBlank || (wasDerived && cur !== candidate)) {
        ep[field] = candidate;
        ep['__derived_' + field] = true;
      }
    }

    // Most-common value across an array; ties broken by first-seen order.
    function mostCommon(arr) {
      const counts = {};
      const order = [];
      for (const v of arr) {
        if (!v) continue;
        if (counts[v] == null) { counts[v] = 0; order.push(v); }
        counts[v]++;
      }
      if (order.length === 0) return null;
      order.sort((a, b) => counts[b] - counts[a]);
      return order[0];
    }

    // Provider — pull from exams (most common). Meds' prescriber is
    // often a different person, so we don't pull from there.
    autoFillString('provider', mostCommon(exams.map((e) => e.provider)));

    // Facility — pull from exams (most common)
    autoFillString('facility', mostCommon(exams.map((e) => e.facility)));

    // Specialty — light inference from facility keywords + exam types.
    // Only fires when facility is set (we'd otherwise need a much
    // larger ontology to guess from exam type alone).
    if (!ep.specialty || ep['__derived_specialty']) {
      const inferred = inferSpecialty(ep, exams);
      if (inferred) autoFillString('specialty', inferred);
    }

    // Related condition — aggregate unique diagnoses from attached
    // exams. Joined with semicolons. Auto-overwrites previous derived
    // values when new diagnoses appear; preserved when user edits.
    const allDiagnoses = [];
    const seen = new Set();
    for (const e of exams) {
      for (const d of (e.diagnoses || [])) {
        if (!d) continue;
        const key = String(d).toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        allDiagnoses.push(d);
      }
    }
    if (allDiagnoses.length > 0) {
      autoFillString('related_condition', allDiagnoses.join('; '));
    }

    // Notes — concatenate AI summaries (per-exam + per-doc) with date
    // tags. Only fills when blank or previously auto-derived.
    const summaries = [];
    for (const e of exams) {
      if (e.ai_summary && e.ai_summary.trim()) {
        summaries.push('[' + (e.date || '?') + ' · ' + examTypeLabel(e.type) + '] ' + e.ai_summary);
      }
      for (const d of (e.documents || [])) {
        if (d.ai_summary && d.ai_summary.trim() &&
            (!e.ai_summary || !e.ai_summary.includes(d.ai_summary))) {
          const kindLabel = documentKindLabel(d.kind || 'other');
          summaries.push('[' + (e.date || '?') + ' · ' + kindLabel + '] ' + d.ai_summary);
        }
      }
    }
    if (summaries.length > 0) {
      autoFillString('notes', summaries.join('\n\n'));
    }

    // Outcome — only auto-fill when status=='completed'. Pulls follow-up
    // text from the latest exam + diagnoses summary.
    if (ep.status === 'completed') {
      const sortedExams = exams.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const latest = sortedExams[0];
      if (latest) {
        const parts = [];
        if (latest.followup) parts.push(latest.followup);
        if (allDiagnoses.length > 0) {
          parts.push('Final diagnoses: ' + allDiagnoses.join('; '));
        }
        if (parts.length > 0) autoFillString('outcome', parts.join('\n\n'));
      }
    }

    ep.updated_at = new Date().toISOString();
    upsertEpisode(ep);
  }

  // Lightweight specialty inference from facility name + exam types.
  // Returns a specialty string or null when nothing matches. Keep
  // additions here narrow + conservative — better to leave specialty
  // blank than wrong.
  function inferSpecialty(ep, exams) {
    const facilityLower = String(ep.facility || '').toLowerCase();
    const haystacks = [facilityLower].concat(
      exams.map((e) => String(e.facility || '').toLowerCase())
    );
    const combined = haystacks.join(' ');
    // Order matters — more specific terms first
    const PATTERNS = [
      [/gastro|endoscop|colonosc|消化器|内視鏡/, 'Gastroenterology'],
      [/cardio|heart|循環器|心臓/, 'Cardiology'],
      [/dermat|skin|皮膚科/, 'Dermatology'],
      [/ophthal|eye clinic|optic|眼科/, 'Ophthalmology'],
      [/orthop|ortho |bone|整形外科/, 'Orthopedics'],
      [/oncol|cancer|腫瘍|がん/, 'Oncology'],
      [/urolog|泌尿器/, 'Urology'],
      [/gyneco|obgyn|ob-gyn|婦人科|産婦人科/, 'OB/GYN'],
      [/neurolog|brain|神経内科/, 'Neurology'],
      [/psych|mental|精神|心療内科/, 'Psychiatry / Mental health'],
      [/dental|dentist|歯科/, 'Dental'],
      [/ent\b|otolaryng|耳鼻/, 'ENT (Otolaryngology)'],
      [/endocrin|diabetes|thyroid|内分泌/, 'Endocrinology'],
      [/radiol|imaging|放射線/, 'Radiology'],
      [/pulmon|lung|respirat|呼吸器/, 'Pulmonology'],
      [/internal medicine|primary care|family practice|内科/, 'Primary care / Internal medicine'],
    ];
    for (const [re, label] of PATTERNS) {
      if (re.test(combined)) return label;
    }
    // Fallback: if all attached exams are 'imaging'
    if (exams.length > 0 && exams.every((e) => e.type === 'imaging')) return 'Radiology';
    return null;
  }

  // Strip the __derived_<field> marker when the user manually edits a
  // field. Called from the episode edit modal's input handlers so
  // subsequent attachments respect their override.
  function markEpisodeFieldUserSet(epId, field) {
    const ep = getEpisodes().find((e) => e.id === epId);
    if (!ep) return;
    if (ep['__derived_' + field]) {
      delete ep['__derived_' + field];
      upsertEpisode(ep);
    }
  }

  function totalCostForEpisode(epId, opts) {
    opts = opts || {};
    const net = opts.net !== false;
    const invs = invoicesForEpisode(epId);
    let gross = 0, reimbursed = 0;
    for (const i of invs) {
      const u = i.amount_usd_calc;
      if (typeof u === 'number' && isFinite(u)) gross += u;
      const r = i.reimbursed_usd_calc;
      if (typeof r === 'number' && isFinite(r) && i.reimbursement_status === 'received') {
        reimbursed += r;
      }
    }
    return { gross, reimbursed, net: gross - reimbursed, count: invs.length };
  }

  function getPrefs() { return getHt().preferences || { units: 'metric', track_trends: true, default_lab_panel: 'cmp' }; }
  function getUi() { return getHt().ui_state || { active_tab: 'dashboard' }; }
  function setUiTab(tab) {
    const ui = getUi();
    patchHt({ ui_state: Object.assign({}, ui, { active_tab: tab }) });
  }

  // ====================================================================
  // Compute helpers
  // ====================================================================

  function daysSince(iso) {
    if (!iso) return Infinity;
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d.getTime())) return Infinity;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function daysUntil(iso) {
    if (!iso) return Infinity;
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d.getTime())) return Infinity;
    return Math.ceil((d.getTime() - Date.now()) / 86400000);
  }

  // Find the latest exam of a given type.
  function latestExamOfType(type) {
    const exams = getExams();
    for (const e of exams) {
      if (e.type === type) return e;
    }
    return null;
  }
  function latestExam() { return getExams()[0] || null; }

  // Lab-name patterns that classify as a "blood panel" — used for
  // detecting whether a physical / specialist / other exam ALSO
  // counts as blood work. The user-visible problem this solves:
  // an annual physical PDF typically includes a CMP/CBC/lipid panel,
  // so saying "Last blood panel: Never" when the screen literally
  // shows ALT/AST/Creatinine trends is wrong.
  //
  // Fact-check anchor: standard US Quest / LabCorp panel components +
  // common JP 健康診断 blood-draw values (sourced from MHLW標準健診項目).
  // Match is case-insensitive substring; multi-language friendly.
  const BLOOD_PANEL_KEYWORDS = [
    // Liver
    /\balt\b/i, /\bast\b/i, /\bgpt\b/i, /\bgot\b/i, /\balp\b/i,
    /\bggt\b/i, /\bldh\b/i, /bilirubin/i, /\bckb?\b|\bcpk\b/i, /総ビリルビン/i,
    // Kidney
    /creatinine/i, /\bbun\b/i, /\begfr\b/i, /urea/i, /uric.?acid/i, /尿酸/i,
    // Electrolytes
    /sodium|natrium|\bna\b/i, /potassium|\bk\b/i, /chloride|\bcl\b/i,
    /\bco2\b|bicarbonate/i, /calcium|\bca\b/i, /magnesium|\bmg\b/i,
    /phosphorus|phosphate|リン/i,
    // Glucose / diabetes
    /glucose|血糖/i, /\ba1c\b|hba1c|hemoglobin\s*a1c/i,
    // Lipids
    /\bldl\b/i, /\bhdl\b/i, /cholesterol|総コレ|tc\b/i, /triglyceride|中性脂肪/i,
    // CBC
    /\bwbc\b|white.?blood/i, /\brbc\b|red.?blood/i, /\bmcv\b/i,
    /\bmch\b/i, /\bmchc\b/i, /platelet|血小板/i,
    /hemoglobin|hgb|hb\b|ヘモグロビン/i, /hematocrit|hct|ヘマトクリット/i,
    // Proteins
    /albumin|アルブミン/i, /total.?protein|総蛋白/i, /globulin/i,
    // Thyroid
    /\btsh\b/i, /\bt3\b/i, /\bt4\b/i, /thyroid/i,
    // Vitamins / micros
    /vitamin.?d|25.?oh/i, /vitamin.?b12|cobalamin/i, /folate|folic/i,
    /iron|ferritin|鉄|フェリチン/i,
    // Hormones
    /testosterone|estradiol|progesterone|cortisol|テストステロン/i,
    // Cardiac
    /troponin/i, /\bbnp\b|nt.?pro.?bnp/i, /\bcrp\b|c.?reactive/i,
    // Common JP panel terms (Romaji + kanji)
    /中性脂肪/i, /血液一般/i, /生化学/i, /γ.?gtp/i,
  ];

  function isBloodPanelLab(name) {
    if (!name) return false;
    return BLOOD_PANEL_KEYWORDS.some((re) => re.test(name));
  }

  // True when an exam contains lab_results whose names match the
  // blood-panel keyword list. Threshold of 2 prevents a single
  // glucose reading at a dermatologist visit from counting as a panel.
  function examHasBloodPanel(exam, minMatches) {
    if (!exam || !Array.isArray(exam.lab_results)) return false;
    const min = minMatches || 2;
    let count = 0;
    for (const lr of exam.lab_results) {
      if (isBloodPanelLab(lr && lr.name)) {
        count++;
        if (count >= min) return true;
      }
    }
    return false;
  }

  // Find the latest exam that includes a blood panel — regardless of
  // whether the exam was filed as type='blood_panel' or type='physical'
  // or anything else. The fix for the "Last Blood Panel: Never" tile.
  function latestExamWithBloodPanel() {
    for (const e of getExams()) {
      if (examHasBloodPanel(e)) return e;
    }
    return null;
  }

  // Format a lab reference range using standard medical notation.
  // Real lab reports often have only one bound — e.g., abdominal
  // circumference is "<85 cm" (upper only), HDL is ">40 mg/dL"
  // (lower only), creatinine is "<1.07" (upper only). Displaying
  // these as "?-85" or "60-?" looks broken; "< 85" / "> 60" matches
  // how every lab report and clinician writes them. When both bounds
  // are present we render as the standard "low–high" range; when
  // neither is present we render an em-dash placeholder.
  function formatLabRange(low, high) {
    const hasLow = low != null && isFinite(Number(low));
    const hasHigh = high != null && isFinite(Number(high));
    if (!hasLow && !hasHigh) return '—';
    if (!hasLow &&  hasHigh) return '< ' + high;
    if ( hasLow && !hasHigh) return '> ' + low;
    return low + '–' + high;
  }

  // Build a lab-results trend series for a given test name across exams.
  // Returns [{ date, value, unit, flag }] sorted oldest → newest.
  // Names are normalized (lowercase, trimmed) for matching.
  // Trend for a single lab test. Accepts EITHER the canonical name
  // (preferred — looked up by normalizing each stored row's name) OR
  // any raw alias. Returns chronologically-sorted readings across all
  // exams that contain any name variant mapping to the same canonical.
  function trendForLabTest(name) {
    const target = normalizeLabName(name);
    if (!target) return [];
    const out = [];
    for (const e of getExams()) {
      if (!e.date) continue;
      for (const lr of (e.lab_results || [])) {
        if (normalizeLabName(lr.name) === target) {
          out.push({
            date: e.date,
            value: lr.value,
            unit: lr.unit,
            flag: lr.flag,
            exam_id: e.id,
            raw_name: lr.name || '',
            range_low: lr.range_low,
            range_high: lr.range_high,
          });
        }
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  // All distinct lab-test names across the exam history, grouped by
  // CANONICAL name (so "HDL Cholesterol", "HDL Cholesterol (HDL-C)",
  // and "HDL-Cholesterol" collapse into one row). Each record carries:
  //   • count          — total readings across all raw-name variants
  //   • raw_names      — distinct stored names, count desc
  //   • range_variants — distinct ranges seen ("85–120" / "< 100" / etc)
  //   • latest_*       — most-recent reading details + its range
  // Powers the Lab Results tab.
  function allLabTests() {
    const map = new Map();
    for (const e of getExams()) {
      for (const lr of (e.lab_results || [])) {
        const raw = String(lr.name || '').trim();
        if (!raw) continue;
        const canon = normalizeLabName(raw);
        if (!map.has(canon)) {
          const entry = LAB_CANONICAL_BY_NAME[canon];
          map.set(canon, {
            name: canon,
            unit: lr.unit,
            range_low: lr.range_low,
            range_high: lr.range_high,
            count: 0,
            latest_value: null,
            latest_date: null,
            latest_flag: null,
            raw_names: {},            // raw → count
            range_variants: new Set(), // distinct range strings
            // Methodology hint key — populated when the canonical entry
            // declares one. Renders as a small ⓘ in the Lab Results
            // row with a hover explaining the methodology variance.
            method_note_key: entry && entry.methodNoteKey ? entry.methodNoteKey : null,
          });
        }
        const rec = map.get(canon);
        rec.count++;
        rec.raw_names[raw] = (rec.raw_names[raw] || 0) + 1;
        const rangeStr = formatLabRange(lr.range_low, lr.range_high);
        if (rangeStr && rangeStr !== '—') rec.range_variants.add(rangeStr);
        if (!rec.latest_date || (e.date && e.date > rec.latest_date)) {
          rec.latest_date = e.date;
          rec.latest_value = lr.value;
          rec.latest_flag = lr.flag;
          rec.unit = lr.unit || rec.unit;
          // Always update range to the most-recent reading's range,
          // not first-seen — clinical ranges drift over time and the
          // newest report represents the user's current lab's
          // reference values.
          rec.range_low = lr.range_low != null ? lr.range_low : rec.range_low;
          rec.range_high = lr.range_high != null ? lr.range_high : rec.range_high;
        }
      }
    }
    // Materialize derived fields for downstream callers.
    const arr = Array.from(map.values()).map((rec) => {
      const rawSorted = Object.keys(rec.raw_names)
        .sort((a, b) => rec.raw_names[b] - rec.raw_names[a]);
      return Object.assign({}, rec, {
        raw_names: rawSorted,           // string[] sorted by count
        range_variants: Array.from(rec.range_variants),
        range_varies: rec.range_variants.size > 1,
      });
    });
    return arr.sort((a, b) => {
      // Abnormal-most-recent first, then alphabetical.
      const aBad = (a.latest_flag === 'critical' || a.latest_flag === 'high' || a.latest_flag === 'low') ? 0 : 1;
      const bBad = (b.latest_flag === 'critical' || b.latest_flag === 'high' || b.latest_flag === 'low') ? 0 : 1;
      if (aBad !== bBad) return aBad - bBad;
      return a.name.localeCompare(b.name);
    });
  }

  function activeMeds() {
    return getMeds().filter((m) => !m.ended_date);
  }

  // Compute the user's current age. Prefers explicit DOB from
  // onboarding (birth_year + optional birth_month), falls back to
  // separation_date for veterans (rough proxy), then null. Returns
  // null when no age data is available — callers must handle.
  function computeAge() {
    const a = TB.state.get('onboarding.answers') || {};
    if (a.birth_year && /^\d{4}$/.test(String(a.birth_year))) {
      const by = parseInt(a.birth_year, 10);
      if (by > 1900 && by < 2100) {
        return new Date().getFullYear() - by;
      }
    }
    // Health Tracker preference override (set inline if onboarding skipped)
    const prefAge = TB.state.get('health_tracker.preferences.age');
    if (prefAge && prefAge > 0 && prefAge < 130) return prefAge;
    return null;
  }

  // User's biological sex for screening filtering. Sourced from (in
  // priority order): health_tracker.preferences.sex, then
  // onboarding.answers.biological_sex. Returns 'female' | 'male' |
  // 'other' | 'prefer_not_to_say' | null. Used to filter sex-specific
  // screenings; sex-specific screenings are SHOWN for null users
  // (the setup banner nudges them to set it).
  function computeUserSex() {
    const pref = TB.state.get('health_tracker.preferences.sex');
    if (pref) return pref;
    const a = TB.state.get('onboarding.answers') || {};
    if (a.biological_sex) return a.biological_sex;
    return null;
  }

  // Compute "preventive screenings due" by combining the library with
  // the user's current age and the latest exam-of-type. User overrides
  // via care_plan.preventive_screenings_due take precedence.
  //
  // Status semantics:
  //   'never'    — never recorded; no last_done date. UI shows but
  //                action center does NOT fire (too noisy to nag
  //                about everything-not-yet-entered).
  //   'critical' — last_done > 1 year past the recommended interval
  //   'due'      — last_done past interval but < 1 year past
  //   'upcoming' — within 90 days of being due
  //   'current'  — well within interval
  function computeScreeningsDue() {
    const age = computeAge();
    const sex = computeUserSex();
    const userEntries = (getCarePlan().preventive_screenings_due || []);
    const userByLibId = {};
    for (const u of userEntries) {
      if (u.library_id) userByLibId[u.library_id] = u;
    }
    const out = [];
    for (const lib of PREVENTIVE_SCREENINGS_LIBRARY) {
      // Sex-specific filter: skip if user's sex is set AND doesn't
      // match this screening's applicability. When sex is null, we
      // show everything and rely on the setup banner to nudge the user.
      if (lib.sex_applicable && lib.sex_applicable !== 'all' && sex) {
        if (sex !== lib.sex_applicable) continue;
      }
      // Age gate: skip if user's age is known AND younger than start.
      // When age is null, we err on the side of showing (with banner).
      if (age != null && age < lib.start_age) continue;
      const user = userByLibId[lib.id];
      if (user && user.disabled) continue;
      const lastDone = user && user.last_done ? user.last_done : null;
      const interval = (user && user.interval_years) || lib.interval_years;
      let status, overdueDays = null;
      if (!lastDone) {
        status = 'never';
      } else {
        const daysSinceLast = daysSince(lastDone);
        const daysInterval = interval * 365;
        overdueDays = daysSinceLast - daysInterval;
        status = overdueDays > 365 ? 'critical'
              : overdueDays > 0   ? 'due'
              : overdueDays > -90 ? 'upcoming'
              : 'current';
      }
      out.push({
        library_id: lib.id,
        label_en: lib.label_en,
        label_jp: lib.label_jp,
        sex_applicable: lib.sex_applicable,
        start_age: lib.start_age,
        last_done: lastDone,
        interval_years: interval,
        overdue_days: overdueDays,
        status,
      });
    }
    // Sort: critical first, then due, then upcoming, then never, then current.
    const rank = { critical: 0, due: 1, upcoming: 2, never: 3, current: 4 };
    out.sort((x, y) => rank[x.status] - rank[y.status]);
    return out;
  }

  // Scan a single exam for evidence of completed preventive screenings.
  // Returns an array of `{ library_id, date }` — the date is the exam's
  // date which we'll treat as last_done for the screening. A single
  // exam can mark multiple screenings (e.g., an annual physical with a
  // lipid panel + A1C + Hep C antibody).
  function inferScreeningsFromExam(exam) {
    if (!exam) return [];
    const haystack = [
      exam.type || '',
      (exam.diagnoses || []).join(' '),
      (exam.procedures || []).join(' '),
      exam.followup || '',
      exam.notes || '',
      exam.ai_summary || '',
      (exam.documents || []).map((d) => (d.title || '') + ' ' + (d.ai_summary || '')).join(' '),
    ].join(' | ');
    const labNames = (exam.lab_results || []).map((lr) => String(lr.name || ''));
    const out = [];
    for (const matcher of SCREENING_MATCHERS) {
      let hit = false;
      for (const re of (matcher.text || [])) {
        if (re.test(haystack)) { hit = true; break; }
      }
      if (!hit) {
        for (const re of (matcher.labs || [])) {
          if (labNames.some((n) => re.test(n))) { hit = true; break; }
        }
      }
      if (hit) out.push({ library_id: matcher.lib_id, date: exam.date || null });
    }
    return out;
  }

  // Apply inferred screenings: update care_plan.preventive_screenings_due[*]
  // so the matched library_id's `last_done` reflects the latest exam
  // date. Only upgrades (never downgrades) — if the user has a NEWER
  // last_done than this exam, we leave theirs alone. Provenance is
  // tracked via `auto_inferred_from` for transparency.
  //
  // Returns the list of library_ids that were updated, so callers can
  // surface a small toast / log if they want to.
  function applyExamScreeningInference(exam) {
    const inferred = inferScreeningsFromExam(exam);
    if (inferred.length === 0) return [];
    const cp = getCarePlan();
    cp.preventive_screenings_due = cp.preventive_screenings_due || [];
    const updated = [];
    for (const m of inferred) {
      if (!m.date) continue;
      let entry = cp.preventive_screenings_due.find((u) => u.library_id === m.library_id);
      if (!entry) {
        entry = { library_id: m.library_id };
        cp.preventive_screenings_due.push(entry);
      }
      // Don't downgrade a user-set newer last_done. Only fill blank or
      // bump older auto/manual values forward.
      if (!entry.last_done || entry.last_done < m.date) {
        entry.last_done = m.date;
        entry.auto_inferred_from = exam.id;
        updated.push(m.library_id);
      }
    }
    if (updated.length > 0) setCarePlan(cp);
    return updated;
  }

  // ====================================================================
  // Multi-document per exam — auto-detect + merge helpers
  // ====================================================================
  //
  // A single annual physical typically produces several documents:
  //   • Office visit summary (vitals + diagnoses + plan)
  //   • Lab panel results (CBC, CMP, lipids, A1C, …)
  //   • Imaging reports
  //   • Specialist consult notes
  //   • Vaccination record
  //
  // We want one EXAM record to gather all of these so the user sees
  // "my 2025-10-12 physical" as a single unit with multiple documents
  // attached, not three separate exam entries that fragment the lab
  // history across rows.
  //
  // Auto-detect: when a new vision-extracted document comes in, look
  // for an existing exam within ±14 days with matching type / provider
  // / facility, score the match, and offer to attach instead of
  // creating a new exam.

  function scoreCandidateExam(existing, extracted) {
    // Date proximity score (max 50)
    let score = 0;
    if (existing.date && extracted.date) {
      const a = new Date(existing.date + 'T00:00:00').getTime();
      const b = new Date(extracted.date + 'T00:00:00').getTime();
      if (!isNaN(a) && !isNaN(b)) {
        const days = Math.abs(a - b) / 86400000;
        if (days === 0) score += 50;
        else if (days <= 3) score += 30;
        else if (days <= 7) score += 15;
        else if (days <= 14) score += 5;
        else return 0; // outside window — bail entirely
      }
    } else if (!existing.date || !extracted.date) {
      return 0; // can't score without dates
    }
    // Type match (max 30)
    if (existing.type && extracted.exam_type && existing.type === extracted.exam_type) {
      score += 30;
    } else if (existing.type === 'physical' && extracted.exam_type === 'blood_panel') {
      // Physical commonly produces a separate lab panel — treat as
      // strong companion match.
      score += 25;
    } else if (existing.type === 'blood_panel' && extracted.exam_type === 'physical') {
      score += 25;
    }
    // Provider match (max 20) — case-insensitive substring overlap.
    if (existing.provider && extracted.provider) {
      const a = String(existing.provider).toLowerCase().trim();
      const b = String(extracted.provider).toLowerCase().trim();
      if (a === b) score += 20;
      else if (a.length > 3 && (a.includes(b) || b.includes(a))) score += 12;
    }
    // Facility match (max 20)
    if (existing.facility && extracted.facility) {
      const a = String(existing.facility).toLowerCase().trim();
      const b = String(extracted.facility).toLowerCase().trim();
      if (a === b) score += 20;
      else if (a.length > 3 && (a.includes(b) || b.includes(a))) score += 12;
    }
    return score;
  }

  // Returns candidate exams sorted by score (highest first). Filtered
  // to score >= MIN_THRESHOLD so we only surface plausible matches.
  function findCandidateExamsForExtraction(extracted) {
    const MIN = 40;
    const out = [];
    for (const e of getExams()) {
      const s = scoreCandidateExam(e, extracted);
      if (s >= MIN) out.push({ exam: e, score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // ─── Invoice → exam/episode auto-linking ──────────────────────────
  //
  // When an invoice is extracted, we look for the visit it most likely
  // belongs to. Two passes:
  //   (1) Score exams by date proximity + provider + facility — if a
  //       strong match exists, the invoice belongs with that exam and
  //       (by extension) any episode the exam is attached to.
  //   (2) Score episodes directly — useful when no single exam captures
  //       the visit (e.g., a pharmacy receipt during a colonoscopy
  //       episode that doesn't have its own exam record).
  //
  // Threshold tuned looser than exam-doc scoring: invoices commonly land
  // weeks after the visit (insurance billing cycle), so the date window
  // is wider and date weight is slightly less aggressive.

  function scoreCandidateExamForInvoice(exam, inv) {
    let score = 0;
    // Date proximity — invoice date or billing_date may both be far from
    // service date. Use whichever is closer to the exam date.
    const invDates = [inv.date, inv.billing_date].filter(Boolean);
    if (exam.date && invDates.length > 0) {
      const a = new Date(exam.date + 'T00:00:00').getTime();
      let bestDays = Infinity;
      for (const d of invDates) {
        const b = new Date(d + 'T00:00:00').getTime();
        if (!isNaN(b)) bestDays = Math.min(bestDays, Math.abs(a - b) / 86400000);
      }
      if (bestDays === Infinity) return 0;
      if (bestDays === 0) score += 45;
      else if (bestDays <= 3) score += 35;
      else if (bestDays <= 7) score += 25;
      else if (bestDays <= 30) score += 15;
      else if (bestDays <= 90) score += 5;
      else return 0; // outside billing-cycle window
    } else {
      return 0;
    }
    // Provider match (max 25)
    if (exam.provider && inv.provider) {
      const a = String(exam.provider).toLowerCase().trim();
      const b = String(inv.provider).toLowerCase().trim();
      if (a === b) score += 25;
      else if (a.length > 3 && (a.includes(b) || b.includes(a))) score += 15;
    }
    // Facility match (max 25)
    if (exam.facility && inv.facility) {
      const a = String(exam.facility).toLowerCase().trim();
      const b = String(inv.facility).toLowerCase().trim();
      if (a === b) score += 25;
      else if (a.length > 3 && (a.includes(b) || b.includes(a))) score += 15;
    }
    // Type → exam type weak alignment (max 10). Maps invoice taxonomy
    // (visit/lab/procedure/rx/imaging/er/dental/other) to exam taxonomy.
    const TYPE_MAP = {
      lab: ['blood_panel'],
      imaging: ['imaging', 'screening'],
      procedure: ['procedure', 'surgery'],
      visit: ['physical', 'specialist', 'follow_up', 'telehealth', 'mental_health'],
      er: ['emergency'],
      dental: ['dental'],
    };
    if (inv.type && exam.type && TYPE_MAP[inv.type] && TYPE_MAP[inv.type].indexOf(exam.type) >= 0) {
      score += 10;
    }
    return score;
  }

  function findCandidateExamsForInvoice(inv) {
    const MIN = 35; // a hair looser than exam-doc matching
    const out = [];
    // Dental invoices should never match non-dental exams (e.g., a
    // dental visit shouldn't get attached to a colonoscopy just
    // because the dates are close). Filter the candidate pool.
    const isDental = inv.type === 'dental';
    for (const e of getExams()) {
      if (isDental && e.type !== 'dental') continue;
      // Conversely, non-dental invoices shouldn't match dental exams.
      if (!isDental && e.type === 'dental') continue;
      const s = scoreCandidateExamForInvoice(e, inv);
      if (s >= MIN) out.push({ exam: e, score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // Score an episode directly. Two signals:
  //   • Date range overlap — invoice date falls within or near the
  //     episode's started_date / completed_date window
  //   • Provider / facility match against episode's own provider/facility
  //     (which are themselves auto-derived from attached exams).
  function scoreCandidateEpisodeForInvoice(ep, inv) {
    let score = 0;
    const invDates = [inv.date, inv.billing_date].filter(Boolean);
    if (invDates.length === 0) return 0;
    if (ep.started_date) {
      const start = new Date(ep.started_date + 'T00:00:00').getTime();
      const end = ep.completed_date
        ? new Date(ep.completed_date + 'T00:00:00').getTime()
        : Date.now();
      // Allow some slack on both sides for billing lag / scheduling lead.
      const slackBefore = 14 * 86400000;
      const slackAfter = 90 * 86400000;
      let inside = false;
      let closestDays = Infinity;
      for (const d of invDates) {
        const t = new Date(d + 'T00:00:00').getTime();
        if (isNaN(t)) continue;
        if (t >= start - slackBefore && t <= end + slackAfter) inside = true;
        const d1 = Math.abs(t - start);
        const d2 = Math.abs(t - end);
        closestDays = Math.min(closestDays, d1 / 86400000, d2 / 86400000);
      }
      if (inside) score += 35;
      else if (closestDays <= 30) score += 15;
      else return 0;
    } else {
      // Episode with no date range yet — can't reliably score
      return 0;
    }
    if (ep.provider && inv.provider) {
      const a = String(ep.provider).toLowerCase().trim();
      const b = String(inv.provider).toLowerCase().trim();
      if (a === b) score += 25;
      else if (a.length > 3 && (a.includes(b) || b.includes(a))) score += 15;
    }
    if (ep.facility && inv.facility) {
      const a = String(ep.facility).toLowerCase().trim();
      const b = String(inv.facility).toLowerCase().trim();
      if (a === b) score += 25;
      else if (a.length > 3 && (a.includes(b) || b.includes(a))) score += 15;
    }
    // Active episodes get a small bias — pending invoices on closed
    // episodes are rarer than ones on still-active care.
    if (ep.status && ep.status !== 'completed' && ep.status !== 'cancelled') {
      score += 5;
    }
    return score;
  }

  function findCandidateEpisodesForInvoice(inv) {
    const MIN = 35;
    const out = [];
    // For dental invoices, filter to episodes that are dental-related
    // (category=dental, or have dental-typed exams attached). Avoids
    // suggesting a colonoscopy episode for a dental cleaning receipt.
    const isDental = inv.type === 'dental';
    for (const ep of getEpisodes()) {
      if (isDental) {
        const isDentalEpisode = ep.category === 'dental' ||
          examsForEpisode(ep.id).some((e) => e.type === 'dental');
        if (!isDentalEpisode) continue;
      } else {
        // Non-dental invoices shouldn't match dental-only episodes
        const isDentalEpisode = ep.category === 'dental';
        if (isDentalEpisode) continue;
      }
      const s = scoreCandidateEpisodeForInvoice(ep, inv);
      if (s >= MIN) out.push({ episode: ep, score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // Construct an invoice record from a vision-extraction result. The
  // amount_usd_calc is computed at entry time and stored — preserves
  // historical FX truth rather than re-converting at today's rate later.
  function createInvoiceFromExtraction(extracted, opts) {
    opts = opts || {};
    const ext = extracted || {};
    const amount = (typeof ext.amount === 'number' && isFinite(ext.amount)) ? ext.amount : null;
    const currency = ext.currency || 'USD';
    let usdCalc = null;
    if (amount != null) {
      if (currency === 'USD') usdCalc = amount;
      else if (TB.assets && typeof TB.assets.toUsd === 'function') {
        const u = TB.assets.toUsd(amount, currency);
        usdCalc = (u != null && isFinite(u)) ? u : null;
      }
    }
    const inv = {
      id: 'inv-' + Date.now().toString(36),
      date: ext.date || new Date().toISOString().slice(0, 10),
      billing_date: ext.billing_date || null,
      provider: ext.provider || '',
      facility: ext.facility || '',
      amount_native: amount,
      currency,
      amount_usd_calc: usdCalc,
      type: ext.type || 'visit',
      paid: ext.paid === true,
      paid_date: ext.paid === true ? (ext.date || null) : null,
      insurance_billed: false,
      reimbursement_status: 'na',
      reimbursed_native: null,
      reimbursed_currency: 'USD',
      reimbursed_usd_calc: null,
      episode_id: opts.episode_id || null,
      exam_id: opts.exam_id || null,
      medication_id: null,
      vault_doc_id: null,
      notes: [ext.summary, ext.notes].filter(Boolean).join('\n\n'),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Bookkeeping for the import — useful in the "imported invoices" view
      ai_imported: true,
      ai_cost_usd: opts.ai_cost_usd != null ? opts.ai_cost_usd : null,
      filename: opts.filename || '',
      // Stash extracted medications on the draft so save paths can
      // materialize them into medication records. Deleted before
      // upsert — never persisted on the invoice itself.
      __pending_medications: Array.isArray(ext.medications) ? ext.medications : [],
      // Stash bilingual provider extraction so saves can sync into the
      // dental provider record when type='dental'. Same convention:
      // consumed and deleted before persisting.
      __pending_provider: (ext.provider_name_en || ext.provider_name_jp ||
                           ext.provider_phone || ext.provider_address) ? {
        name_en: ext.provider_name_en || '',
        name_jp: ext.provider_name_jp || '',
        phone: ext.provider_phone || '',
        address: ext.provider_address || '',
      } : null,
    };
    return inv;
  }

  // Save an AI-imported invoice and materialize any medications the
  // extraction found into proper med records. Use this in place of a
  // bare upsertInvoice(draft) for any invoice that came from the vision
  // importer — covers fast-path attach, standalone save, exam-candidate
  // attach, and episode-candidate attach.
  //
  // Idempotent: when re-saving the same invoice we'll skip meds that
  // already exist for this source_invoice_id. So fine-tuning an
  // imported invoice doesn't create duplicate medication entries.
  function saveImportedInvoiceWithMedications(draft, chainOpts) {
    chainOpts = chainOpts || {};
    const autoEnrichProvider = chainOpts.autoEnrichProvider !== false;
    const pending = Array.isArray(draft.__pending_medications) ? draft.__pending_medications : [];
    const pendingProvider = draft.__pending_provider || null;
    // Strip the __pending fields before persisting — transient
    // import artifacts, not invoice state.
    delete draft.__pending_medications;
    delete draft.__pending_provider;
    upsertInvoice(draft);

    // Sync provider info into the dental provider list when this is a
    // dental invoice. Catches the case where AI invoice extraction
    // captured the JP clinic name but the existing dental provider
    // only has the English name (or vice versa).
    if (draft.type === 'dental' && pendingProvider) {
      let synced = null;
      try { synced = syncDentalProviderFromInvoice(pendingProvider); } catch (_) {}
      // Chain into AI provider enrichment when the merged provider is
      // still single-language (or missing public-info fields). Fires in
      // the background with toast feedback so the save path returns
      // immediately. Opt-out lives in the upload modal checkbox.
      if (autoEnrichProvider && synced) {
        maybeChainProviderEnrichment(synced);
      }
    }

    if (pending.length === 0) return [];

    // Resolve prescriber / pharmacy hints from the invoice context.
    // Pharmacy receipts: provider is typically the pharmacy name and
    // the prescribing physician is separate (may not be on the
    // receipt). Hospital procedure receipts: provider is the
    // facility, prescriber might be on a separate page.
    const isPharmacy = (draft.type === 'rx') || /pharmacy|薬局|ドラッグ/i.test(String(draft.provider || '') + ' ' + String(draft.facility || ''));
    const pharmacy = isPharmacy ? (draft.provider || draft.facility || '') : '';
    const prescriber = isPharmacy ? '' : (draft.provider || '');

    // Find existing meds sourced from THIS invoice so we don't dupe
    // on re-save. Match on source_invoice_id + name (case-insensitive,
    // trimmed) — the user's manual edits to the med record after
    // import won't trigger a recreate.
    const existingFromInvoice = getMeds().filter((m) => m.source_invoice_id === draft.id);
    const seenNames = new Set(existingFromInvoice.map((m) => String(m.name || '').trim().toLowerCase()));

    const created = [];
    for (const m of pending) {
      if (!m || !m.name) continue;
      const key = String(m.name).trim().toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const med = {
        id: 'med-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        name: m.name,
        generic_name: m.generic_name || '',
        dosage: (typeof m.dosage === 'number' && isFinite(m.dosage)) ? m.dosage : null,
        dosage_unit: m.dosage_unit || 'mg',
        frequency: m.frequency || '',
        route: 'oral',
        started_date: draft.date || new Date().toISOString().slice(0, 10),
        ended_date: null,
        prescriber,
        pharmacy,
        refills_remaining: null,
        next_refill_date: null,
        purpose: '',
        side_effects: '',
        // Stash extra detail into notes so the user can see qty +
        // instructions without us inventing fields just for receipts.
        notes: [
          m.quantity != null ? 'Qty: ' + m.quantity : '',
          m.instructions || '',
        ].filter(Boolean).join('\n'),
        episode_id: draft.episode_id || null,
        exam_id: draft.exam_id || null,
        // Provenance — lets us idempotently re-save and lets the UI
        // show "from invoice X" on AI-imported meds.
        source_invoice_id: draft.id,
        ai_imported: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      upsertMed(med);
      created.push(med);
    }
    return created;
  }

  // Detect the "kind" of a document from the extracted content.
  // Heuristic: if there are lab_results, it's lab data; if imaging
  // findings text, it's imaging; otherwise office summary or other.
  function inferDocumentKind(extracted, fallbackFromFilename) {
    if (extracted) {
      const labsCount = Array.isArray(extracted.lab_results) ? extracted.lab_results.length : 0;
      const hasVitals = extracted.vitals && Object.keys(extracted.vitals).filter(k => extracted.vitals[k] != null).length > 0;
      if (extracted.exam_type === 'imaging') return 'imaging';
      if (labsCount >= 3 && !hasVitals) return 'lab_results';
      if (labsCount > 0 && hasVitals) return 'office_summary';
      if (hasVitals && labsCount === 0) return 'office_summary';
      if ((extracted.diagnoses || []).length > 0 && labsCount === 0) return 'office_summary';
    }
    // Fallback: filename hints
    if (fallbackFromFilename) {
      const n = String(fallbackFromFilename).toLowerCase();
      if (/lab|cbc|cmp|lipid|a1c|panel/.test(n)) return 'lab_results';
      if (/scr(een)?ing|colonosc|mammo|dexa/.test(n)) return 'screening_results';
      if (/xray|x-ray|mri|ct|ultrasound|echo|imaging/.test(n)) return 'imaging';
      if (/path/.test(n)) return 'pathology';
      if (/vacc|immuniz/.test(n)) return 'vaccination';
    }
    return 'other';
  }

  function documentKindLabel(kind) {
    const lang = TB.i18n.getLang();
    const t = TB.i18n.t;
    const key = 'ht.doc.kind.' + kind;
    const v = t(key);
    return v === key ? kind : v;  // fall back to raw id if missing i18n
  }

  // ─── Facility / provider name canonicalization ───────────────────
  //
  // Clinics in Japan commonly appear in three forms:
  //   • Japanese-only:        "さくら歯科医院"
  //   • Bilingual:            "さくら歯科医院 (Sakura Dental Clinic)"
  //   • English-only:         "Sakura Dental Clinic"
  //
  // Different exam documents from the same clinic often pick different
  // forms. We want to converge on the most complete variant — usually
  // the bilingual one — so the user sees a single facility in their
  // history, not three separate-looking places.
  //
  // Rule: "more complete" = strictly longer AND contains the existing
  // as a case-insensitive substring, OR has BOTH Japanese and Latin
  // characters when the existing has only one. Conservative — won't
  // merge unrelated names that happen to share a prefix.
  function isMoreCompleteName(candidate, existing) {
    if (!candidate) return false;
    if (!existing) return true;
    const a = String(candidate).trim();
    const b = String(existing).trim();
    if (a === b) return false;
    if (!a) return false;
    if (!b) return true;
    // Strict superset: candidate contains existing AND is longer
    if (a.length > b.length && a.toLowerCase().includes(b.toLowerCase())) return true;
    // Bilingual upgrade: candidate has both scripts, existing only one
    const hasCjk = (s) => /[぀-ゟ゠-ヿ㐀-鿿＀-￯]/.test(s);
    const hasLatin = (s) => /[a-zA-Z]/.test(s);
    const candBi = hasCjk(a) && hasLatin(a);
    const existBi = hasCjk(b) && hasLatin(b);
    if (candBi && !existBi) {
      // Verify the bilingual candidate actually shares a substring with
      // the existing — otherwise it's a different clinic that happens
      // to be bilingual, and we shouldn't conflate them.
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      if (aLower.includes(bLower) || bLower.includes(aLower)) return true;
    }
    return false;
  }

  // After establishing a "more complete" facility (or provider) name on
  // one exam, propagate to ALL records (exams, invoices, episodes) that
  // hold a less-complete variant of the same name. Operates across the
  // whole list in one pass.
  //
  // The canonical pool is built from exams + invoices + episodes
  // combined — a bilingual name first appearing on an invoice should
  // upgrade an exam that has only the JP form, and vice versa.
  //
  // Returns true when at least one record was upgraded.
  function canonicalizeNamesAcrossExams() {
    const exams = getExams();
    const invoices = getInvoices();
    const episodes = getEpisodes();
    if (exams.length + invoices.length + episodes.length < 2) return false;

    // For a given set of distinct values, build a map of value → canonical
    // (most-complete variant within the set).
    function canonicalMap(values) {
      const arr = Array.from(new Set(values.filter(Boolean)));
      const out = {};
      for (const v of arr) {
        let best = v;
        for (const candidate of arr) {
          if (candidate !== best && isMoreCompleteName(candidate, best)) best = candidate;
        }
        out[v] = best;
      }
      return out;
    }

    const allFacilities = exams.map((e) => e.facility)
      .concat(invoices.map((i) => i.facility))
      .concat(episodes.map((ep) => ep.facility));
    const allProviders = exams.map((e) => e.provider)
      .concat(invoices.map((i) => i.provider))
      .concat(episodes.map((ep) => ep.provider));

    const facCanonical = canonicalMap(allFacilities);
    const provCanonical = canonicalMap(allProviders);

    let changed = false;

    // Apply to exams
    const examsUpdated = exams.map((e) => {
      let next = e;
      if (e.facility && facCanonical[e.facility] && facCanonical[e.facility] !== e.facility) {
        next = Object.assign({}, next, { facility: facCanonical[e.facility] });
        changed = true;
      }
      if (e.provider && provCanonical[e.provider] && provCanonical[e.provider] !== e.provider) {
        next = Object.assign({}, next, { provider: provCanonical[e.provider] });
        changed = true;
      }
      return next;
    });
    if (changed) setExams(examsUpdated);

    // Apply to invoices
    let invChanged = false;
    const invUpdated = invoices.map((i) => {
      let next = i;
      if (i.facility && facCanonical[i.facility] && facCanonical[i.facility] !== i.facility) {
        next = Object.assign({}, next, { facility: facCanonical[i.facility] });
        invChanged = true;
      }
      if (i.provider && provCanonical[i.provider] && provCanonical[i.provider] !== i.provider) {
        next = Object.assign({}, next, { provider: provCanonical[i.provider] });
        invChanged = true;
      }
      return next;
    });
    if (invChanged) { setInvoices(invUpdated); changed = true; }

    // Apply to episodes — but only when the episode's name was
    // auto-derived (we shouldn't overwrite a manually-typed facility).
    let epChanged = false;
    const epUpdated = episodes.map((ep) => {
      let next = ep;
      if (ep.facility && ep.__derived_facility &&
          facCanonical[ep.facility] && facCanonical[ep.facility] !== ep.facility) {
        next = Object.assign({}, next, { facility: facCanonical[ep.facility] });
        epChanged = true;
      }
      if (ep.provider && ep.__derived_provider &&
          provCanonical[ep.provider] && provCanonical[ep.provider] !== ep.provider) {
        next = Object.assign({}, next, { provider: provCanonical[ep.provider] });
        epChanged = true;
      }
      return next;
    });
    if (epChanged) { setEpisodes(epUpdated); changed = true; }

    return changed;
  }

  // Merge a vision-extracted document into an existing exam:
  //   • Append new lab_results (don't overwrite — preserves history
  //     when both docs report the same test from the same day, the
  //     user can dedupe manually if needed)
  //   • Fill missing vitals (don't overwrite existing values)
  //   • Append unique diagnoses + procedures
  //   • Upgrade provider/facility name when the extracted value is a
  //     more complete variant (e.g., bilingual replaces JP-only)
  //   • Add a new entry to documents[] with the per-doc AI summary
  //   • Update updated_at timestamp
  function mergeExtractionIntoExam(examId, extracted, meta) {
    const exam = getExams().find((e) => e.id === examId);
    if (!exam) return null;
    const merged = JSON.parse(JSON.stringify(exam));

    // Provider / facility name upgrades — when the extracted document
    // has a more complete name (bilingual vs. monolingual, fuller form
    // vs. abbreviated), upgrade the exam to the better variant. We
    // never DOWNGRADE here — a partial extraction shouldn't lose info.
    if (extracted.provider && isMoreCompleteName(extracted.provider, merged.provider)) {
      merged.provider = extracted.provider;
    }
    if (extracted.facility && isMoreCompleteName(extracted.facility, merged.facility)) {
      merged.facility = extracted.facility;
    }

    // Append lab results
    if (Array.isArray(extracted.lab_results) && extracted.lab_results.length > 0) {
      merged.lab_results = (merged.lab_results || []).concat(extracted.lab_results);
    }
    // Fill missing vitals
    if (extracted.vitals && typeof extracted.vitals === 'object') {
      merged.vitals = merged.vitals || {};
      for (const k of Object.keys(extracted.vitals)) {
        if (extracted.vitals[k] != null && (merged.vitals[k] == null || merged.vitals[k] === '')) {
          merged.vitals[k] = extracted.vitals[k];
        }
      }
    }
    // Append unique diagnoses
    if (Array.isArray(extracted.diagnoses) && extracted.diagnoses.length > 0) {
      merged.diagnoses = merged.diagnoses || [];
      for (const d of extracted.diagnoses) {
        if (d && merged.diagnoses.indexOf(d) === -1) merged.diagnoses.push(d);
      }
    }
    // Append unique procedures
    if (Array.isArray(extracted.procedures) && extracted.procedures.length > 0) {
      merged.procedures = merged.procedures || [];
      for (const p of extracted.procedures) {
        if (p && merged.procedures.indexOf(p) === -1) merged.procedures.push(p);
      }
    }
    // Append follow-up note (concatenate distinct text)
    if (extracted.followup && extracted.followup.trim()) {
      const existing = (merged.followup || '').trim();
      if (!existing.includes(extracted.followup.trim())) {
        merged.followup = existing
          ? existing + '\n\n[+ ' + (meta && meta.kind ? meta.kind : 'document') + '] ' + extracted.followup
          : extracted.followup;
      }
    }
    // Record the document
    merged.documents = merged.documents || [];
    merged.documents.push({
      id: 'doc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      kind: (meta && meta.kind) || inferDocumentKind(extracted, meta && meta.filename),
      title: (meta && meta.title) || extracted.summary || '',
      filename: meta && meta.filename || '',
      filesize_kb: meta && meta.filesize_kb || null,
      date_imported: new Date().toISOString().slice(0, 10),
      ai_summary: extracted.summary || '',
      cost_usd: meta && meta.cost_usd != null ? meta.cost_usd : null,
    });
    merged.updated_at = new Date().toISOString();
    upsertExam(merged);
    // Propagate any newly-upgraded facility/provider names to other
    // exams that hold a less-complete variant of the same clinic.
    canonicalizeNamesAcrossExams();
    return merged;
  }

  // Build a fresh exam from extracted data + document metadata. Returns
  // the new exam record (already inserted).
  function createExamFromExtraction(extracted, meta) {
    const labResults = Array.isArray(extracted.lab_results) ? extracted.lab_results : [];
    // Backfill flag for any rows where the model didn't set one
    for (const lr of labResults) {
      if (!lr.flag && lr.value != null) {
        if (lr.range_high != null && lr.value > lr.range_high) lr.flag = 'high';
        else if (lr.range_low != null && lr.value < lr.range_low) lr.flag = 'low';
        else lr.flag = 'normal';
      }
    }
    const exam = {
      id: 'exam-' + Date.now().toString(36),
      date: extracted.date || new Date().toISOString().slice(0, 10),
      type: extracted.exam_type || 'blood_panel',
      provider: extracted.provider || '',
      facility: extracted.facility || '',
      vitals: extracted.vitals || {},
      lab_results: labResults,
      diagnoses: Array.isArray(extracted.diagnoses) ? extracted.diagnoses : [],
      procedures: Array.isArray(extracted.procedures) ? extracted.procedures : [],
      followup: extracted.followup || '',
      notes: '',
      ai_summary: extracted.summary || '',
      documents: [{
        id: 'doc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        kind: (meta && meta.kind) || inferDocumentKind(extracted, meta && meta.filename),
        title: (meta && meta.title) || extracted.summary || '',
        filename: meta && meta.filename || '',
        filesize_kb: meta && meta.filesize_kb || null,
        date_imported: new Date().toISOString().slice(0, 10),
        ai_summary: extracted.summary || '',
        cost_usd: meta && meta.cost_usd != null ? meta.cost_usd : null,
      }],
      linked_doc_id: null,
      linked_consultation_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    upsertExam(exam);
    // If this new exam introduces a more-complete bilingual variant of
    // a facility/provider name that other exams already hold in a
    // monolingual form, propagate the upgrade so the user sees a
    // single canonical entry across their history.
    canonicalizeNamesAcrossExams();
    return exam;
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;
  let didInitialCanonicalize = false;

  function render(container) {
    host = container;
    if (!listenerSet) {
      // Re-render on customize / state changes from outside the module.
      listenerSet = true;
    }
    // One-time canonicalization sweep on first render — catches legacy
    // data where a clinic appears in multiple forms across already-saved
    // exams/invoices/episodes. Subsequent uploads keep things tidy via
    // the per-merge hook, so this only fires once per session.
    if (!didInitialCanonicalize) {
      didInitialCanonicalize = true;
      try { canonicalizeNamesAcrossExams(); } catch (_) {}
    }
    container.innerHTML = '';
    container.appendChild(buildHeaderCard());
    container.appendChild(buildTabsBar());
    const tabHost = TB.utils.el('div', { id: 'tb-ht-tab-host' });
    container.appendChild(tabHost);
    renderActiveTab(tabHost);
  }
  function rerender() { if (host) render(host); }

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    const titleRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--tb-sp-3)', flexWrap: 'wrap' },
    });
    titleRow.appendChild(el('div', null,
      el('h1', { style: { margin: 0 } }, '🩺 ' + t('ht.title')),
      el('p', { class: 'tb-card-meta', style: { margin: '4px 0 0' } }, t('ht.subtitle')),
    ));

    // Action buttons row — Import (vision), Export CSV, AI Advisor
    const actions = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });

    // CSV export
    actions.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: exportLabsCsv,
    }, '⤓ ' + t('ht.export.csv')));

    // Vision import — only when API key + medical_vision allowed
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    const consentOk = TB.ai && typeof TB.ai.isFeatureAllowed === 'function'
      ? TB.ai.isFeatureAllowed('medical_vision') !== false
      : true;
    if (hasKey && consentOk) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: openVisionImportModal,
      }, '📎 ' + t('ht.import.vision')));
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openInvoiceVisionImportModal(),
      }, '🧾 ' + t('ht.invoiceImport.btn')));
    }

    // Year-in-Review — annual summary modal. Only shows when there's
    // actually data worth reviewing (≥1 exam or ≥1 dental note).
    const hasYrData = (getExams().length > 0) || ((getDental().notes_log || []).length > 0) ||
      (getInvoices().length > 0);
    if (hasYrData) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: openHealthYearInReviewModal,
      }, '📊 ' + t('ht.yir.btn')));
    }

    // AI Advisor — pre-seeds Ask Taigan with exam context
    const askOk = TB.ai && typeof TB.ai.isFeatureAllowed === 'function'
      ? TB.ai.isFeatureAllowed('ask_taigan') !== false
      : true;
    if (askOk && TB.askTaigan && typeof TB.askTaigan.openWithContext === 'function') {
      actions.appendChild(el('button', {
        class: 'tb-btn',
        type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: openAiAdvisor,
      }, '🧠 ' + t('ht.advisor.btn')));
    }

    titleRow.appendChild(actions);
    card.appendChild(titleRow);
    return card;
  }

  // ─── Tabs ────────────────────────────────────────────────────────

  const TABS = [
    { id: 'dashboard', icon: '📊', label_en: 'Dashboard',       label_jp: 'ダッシュボード' },
    { id: 'labs',      icon: '🧪', label_en: 'Lab Results',     label_jp: '検査結果' },
    { id: 'exams',     icon: '📋', label_en: 'Exam Details',    label_jp: '受診詳細' },
    { id: 'episodes',  icon: '🧭', label_en: 'Care Episodes',   label_jp: 'ケアエピソード' },
    { id: 'care_plan', icon: '🎯', label_en: 'Care Plan',       label_jp: 'ケアプラン' },
    { id: 'meds',      icon: '💊', label_en: 'Meds & Tracking', label_jp: '服薬・追跡' },
    { id: 'dental',    icon: '🦷', label_en: 'Dental',          label_jp: '歯科' },
    { id: 'notes',     icon: '📒', label_en: 'Insurance & Notes', label_jp: '保険・メモ' },
  ];

  function buildTabsBar() {
    const el = TB.utils.el;
    const lang = TB.i18n.getLang();
    const active = getUi().active_tab || 'dashboard';
    const bar = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)',
        padding: 'var(--tb-sp-2) 0',
        marginBottom: 'var(--tb-sp-3)',
        borderBottom: '1px solid var(--tb-border)',
      },
    });
    for (const tab of TABS) {
      const isActive = tab.id === active;
      bar.appendChild(el('button', {
        class: 'tb-btn ' + (isActive ? 'tb-btn--secondary' : 'tb-btn--ghost'),
        type: 'button',
        style: {
          fontSize: 'var(--tb-fs-12)',
          fontWeight: isActive ? '600' : '400',
          borderColor: isActive ? 'var(--tb-track-health)' : 'transparent',
          color: isActive ? 'var(--tb-track-health)' : 'var(--tb-text-soft)',
        },
        onclick: () => { setUiTab(tab.id); rerender(); },
      }, tab.icon + ' ' + (lang === 'ja' ? tab.label_jp : tab.label_en)));
    }
    return bar;
  }

  function renderActiveTab(tabHost) {
    const active = getUi().active_tab || 'dashboard';
    if (active === 'dashboard') return renderDashboardTab(tabHost);
    if (active === 'labs')      return renderLabsTab(tabHost);
    if (active === 'exams')     return renderExamsTab(tabHost);
    if (active === 'episodes')  return renderEpisodesTab(tabHost);
    if (active === 'care_plan') return renderCarePlanTab(tabHost);
    if (active === 'meds')      return renderMedsTab(tabHost);
    if (active === 'dental')    return renderDentalTab(tabHost);
    if (active === 'notes')     return renderNotesTab(tabHost);
    return renderDashboardTab(tabHost);
  }

  // ====================================================================
  // Tab: Dashboard
  // ====================================================================

  function renderDashboardTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const exams = getExams();
    if (exams.length === 0) {
      tabHost.appendChild(buildEmptyState());
      return;
    }
    const latest = latestExam();
    const physical = latestExamOfType('physical');
    // Smarter "last blood panel" — uses content detection so a
    // physical that includes CBC/CMP/lipid values counts. Falls back
    // to the strict type='blood_panel' lookup if no physical-with-labs
    // matches. The latter rarely happens (standalone lab draws are
    // typically filed as 'blood_panel' explicitly).
    const bloodPanel = latestExamWithBloodPanel() || latestExamOfType('blood_panel');
    const meds = activeMeds();
    const screenings = computeScreeningsDue();
    // "Overdue" excludes 'never' — those haven't been recorded, so we
    // can't honestly call them overdue. The setup banner in Care Plan
    // nudges users to fill in last_done dates.
    const overdueScreenings = screenings.filter((s) => s.status === 'critical' || s.status === 'due');
    // Show the sex/age setup banner if neither is set — surfaces on
    // Dashboard so the first thing the user does is filter the library.
    if (!computeUserSex() || computeAge() == null) {
      tabHost.appendChild(buildSetupBanner());
    }

    // Top tile strip
    const tiles = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'var(--tb-sp-3)',
        marginBottom: 'var(--tb-sp-3)',
      },
    });
    tiles.appendChild(statTile(
      t('ht.dash.lastExam'),
      latest ? latest.date : '—',
      latest && latest.type ? examTypeLabel(latest.type) : '',
      latest && daysSince(latest.date) > 365 ? 'var(--tb-warn)' : null,
    ));
    tiles.appendChild(statTile(
      t('ht.dash.lastPhysical'),
      physical ? physical.date : '—',
      physical ? t('ht.dash.daysAgo', { n: daysSince(physical.date) }) : t('ht.dash.never'),
      !physical || daysSince(physical.date) > 365 ? 'var(--tb-warn)' : 'var(--tb-success)',
    ));
    // Blood panel tile: when the source isn't a standalone blood
    // panel exam (i.e., it's a physical that included labs), surface
    // that context in the subtitle — "via Annual physical · 200d ago" —
    // so the user understands why the date matches their physical.
    let bpSub;
    if (!bloodPanel) {
      bpSub = t('ht.dash.never');
    } else {
      const days = daysSince(bloodPanel.date);
      const labCount = (bloodPanel.lab_results || []).filter((lr) => isBloodPanelLab(lr && lr.name)).length;
      const sourcePrefix = bloodPanel.type !== 'blood_panel'
        ? t('ht.dash.via', { type: examTypeLabel(bloodPanel.type) }) + ' · '
        : '';
      bpSub = sourcePrefix + t('ht.dash.daysAgo', { n: days }) +
        (labCount > 0 ? ' · ' + labCount + ' ' + t('ht.dash.bloodLabs') : '');
    }
    tiles.appendChild(statTile(
      t('ht.dash.lastBloodPanel'),
      bloodPanel ? bloodPanel.date : '—',
      bpSub,
      !bloodPanel || daysSince(bloodPanel.date) > 365 ? 'var(--tb-warn)' : null,
    ));
    tiles.appendChild(statTile(
      t('ht.dash.activeMeds'),
      String(meds.length),
      meds.length > 0 ? meds.slice(0, 2).map((m) => m.name).join(', ') + (meds.length > 2 ? '…' : '') : t('ht.dash.none'),
    ));
    tiles.appendChild(statTile(
      t('ht.dash.screeningsDue'),
      String(overdueScreenings.length),
      overdueScreenings.length === 0 ? t('ht.dash.allCurrent') :
        overdueScreenings.slice(0, 2).map((s) => TB.i18n.getLang() === 'ja' ? s.label_jp : s.label_en).join(', ') +
        (overdueScreenings.length > 2 ? '…' : ''),
      overdueScreenings.length > 0 ? 'var(--tb-warn)' : 'var(--tb-success)',
    ));
    tabHost.appendChild(tiles);

    // Vitals trend section
    const allTests = allLabTests();
    if (allTests.length > 0) {
      const trendCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      trendCard.appendChild(el('h2', { style: { marginTop: 0 } }, '📈 ' + t('ht.dash.trends')));
      trendCard.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.dash.trends.intro')));
      const grid = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 'var(--tb-sp-2)',
          marginTop: 'var(--tb-sp-2)',
        },
      });
      // Take up to 6 tests (prioritize abnormal-most-recent)
      for (const tst of allTests.slice(0, 6)) {
        grid.appendChild(buildTrendMiniCard(tst));
      }
      trendCard.appendChild(grid);
      if (allTests.length > 6) {
        trendCard.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
          t('ht.dash.trends.more', { n: allTests.length - 6 }) +
          ' — ',
          el('a', {
            href: '#',
            style: { color: 'var(--tb-track-health)' },
            onclick: (e) => { e.preventDefault(); setUiTab('labs'); rerender(); },
          }, t('ht.dash.trends.viewAll'))));
      }
      tabHost.appendChild(trendCard);
    }

    // Screenings due summary
    if (overdueScreenings.length > 0) {
      const screenCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      screenCard.appendChild(el('h2', { style: { marginTop: 0 } }, '⚠ ' + t('ht.dash.screeningsTitle')));
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-1)' } });
      for (const s of overdueScreenings.slice(0, 5)) {
        const isCritical = s.status === 'critical';
        list.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            borderLeft: '3px solid ' + (isCritical ? 'var(--tb-error)' : 'var(--tb-warn)'),
            background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          },
        },
          el('div', { style: { fontWeight: '600' } },
            (TB.i18n.getLang() === 'ja' ? s.label_jp : s.label_en) + ' — ' +
            (isCritical ? t('ht.dash.critical', { d: s.overdue_days }) : t('ht.dash.dueNow'))),
          el('div', { class: 'tb-card-meta' },
            t('ht.dash.lastDone') + ': ' + (s.last_done || t('ht.dash.never'))),
        ));
      }
      screenCard.appendChild(list);
      if (overdueScreenings.length > 5) {
        screenCard.appendChild(el('a', {
          href: '#',
          style: { color: 'var(--tb-track-health)', fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-2)', display: 'inline-block' },
          onclick: (e) => { e.preventDefault(); setUiTab('care_plan'); rerender(); },
        }, t('ht.dash.viewAllScreenings', { n: overdueScreenings.length })));
      }
      tabHost.appendChild(screenCard);
    }

    // AI summary card — surfaces ai_summary from the latest exam if set
    if (latest && latest.ai_summary) {
      tabHost.appendChild(el('div', {
        class: 'tb-card', 'data-track': 'health',
        style: { borderLeft: '3px solid var(--tb-track-ai)' },
      },
        el('h3', { style: { marginTop: 0 } }, '🧠 ' + t('ht.dash.aiSummary')),
        el('p', { style: { margin: '0 0 var(--tb-sp-2)' } }, latest.ai_summary),
        el('div', { class: 'tb-card-meta' }, t('ht.dash.aiSummary.from', { date: latest.date })),
      ));
    }
  }

  function statTile(label, value, sub, color) {
    const el = TB.utils.el;
    return el('div', {
      class: 'tb-card', 'data-track': 'health',
      style: { padding: 'var(--tb-sp-3)', margin: 0 },
    },
      el('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', fontWeight: '600' } }, label),
      el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-22)', color: color || 'var(--tb-text)', marginTop: '4px' } }, value),
      sub ? el('div', { class: 'tb-card-meta', style: { marginTop: '2px', fontSize: 'var(--tb-fs-12)' } }, sub) : null,
    );
  }

  function buildTrendMiniCard(test) {
    const el = TB.utils.el;
    const series = trendForLabTest(test.name);
    const tile = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
      },
    });
    const flagColor = test.latest_flag === 'critical' ? 'var(--tb-error)'
                    : test.latest_flag === 'high' ? 'var(--tb-warn)'
                    : test.latest_flag === 'low' ? 'var(--tb-warn)'
                    : 'var(--tb-text)';
    tile.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
    },
      el('span', { style: { fontWeight: '600', fontSize: 'var(--tb-fs-12)' } }, test.name),
      el('span', { style: { color: flagColor, fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-14)' } },
        (test.latest_value != null ? test.latest_value : '—') +
        (test.unit ? ' ' + test.unit : '')),
    ));
    if (test.range_low != null || test.range_high != null) {
      tile.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } },
        'ref ' + formatLabRange(test.range_low, test.range_high)));
    }
    if (series.length >= 2) {
      tile.appendChild(buildSparkline(series, { title: test.name }));
    }
    tile.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '10px', marginTop: '2px' } },
      test.latest_date + ' · ' + test.count + ' reading' + (test.count > 1 ? 's' : '')));
    return tile;
  }

  // Vanilla-SVG sparkline. Width auto-fits to container; height fixed.
  // Hovering surfaces a popover with the exam-by-exam value list — the
  // SVG itself is wrapped in a span so the popover can anchor to a DOM
  // node (popover positioning uses getBoundingClientRect which works
  // fine on SVG, but the span gives us a stable hover surface that
  // covers any whitespace inside the SVG too).
  function buildSparkline(series, opts) {
    opts = opts || {};
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const W = 200, H = 36;
    const values = series.map((s) => s.value).filter((v) => typeof v === 'number' && isFinite(v));
    if (values.length < 2) return el('div');
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const range = max - min || 1;
    const xFor = (i) => 4 + (i / Math.max(1, values.length - 1)) * (W - 8);
    const yFor = (v) => H - 4 - ((v - min) / range) * (H - 8);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    svg.style.display = 'block';
    svg.style.marginTop = '4px';

    // Polyline
    const points = values.map((v, i) => xFor(i).toFixed(1) + ',' + yFor(v).toFixed(1)).join(' ');
    const poly = document.createElementNS(svgNS, 'polyline');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--tb-track-health)');
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);

    // Dots, colored by flag at each point. Each gets a native SVG
    // <title> for per-point native tooltips (covers the "tap on phone"
    // case where the hover popover doesn't trigger).
    series.forEach((s, i) => {
      const v = s.value;
      if (typeof v !== 'number' || !isFinite(v)) return;
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', xFor(i));
      dot.setAttribute('cy', yFor(v));
      dot.setAttribute('r', i === values.length - 1 ? 2.5 : 1.8);
      const color = s.flag === 'critical' ? 'var(--tb-error)'
                  : s.flag === 'high' || s.flag === 'low' ? 'var(--tb-warn)'
                  : 'var(--tb-track-health)';
      dot.setAttribute('fill', color);
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = (s.date || '?') + ': ' +
        v + (s.unit ? ' ' + s.unit : '') +
        (s.flag && s.flag !== 'normal' ? ' (' + s.flag + ')' : '');
      dot.appendChild(title);
      svg.appendChild(dot);
    });

    // Wrap in a span so the hover popover has a non-SVG anchor node.
    const wrapper = el('span', {
      tabindex: '0',
      style: {
        display: 'inline-block', width: '100%', cursor: 'help',
        outline: 'none',
      },
    });
    wrapper.appendChild(svg);

    // Hover popover with full date+value list
    attachHoverPopover(wrapper, (pop) => {
      pop.appendChild(el('div', {
        style: { fontWeight: '600', marginBottom: '6px',
          fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--tb-text-soft)' },
      }, opts.title || t('ht.labs.sparkline.title')));
      const table = el('table', { style: { borderCollapse: 'collapse', fontSize: 'var(--tb-fs-12)' } });
      for (const s of series) {
        const tr = el('tr');
        tr.appendChild(el('td', { style: { padding: '2px 8px 2px 0', color: 'var(--tb-text-soft)', fontFamily: 'var(--tb-font-mono)' } },
          s.date || '?'));
        const valCell = el('td', { style: { padding: '2px 0', fontFamily: 'var(--tb-font-mono)', textAlign: 'right' } },
          (s.value != null ? s.value : '—') + (s.unit ? ' ' + s.unit : ''));
        if (s.flag === 'critical' || s.flag === 'high' || s.flag === 'low') {
          valCell.style.color = s.flag === 'critical' ? 'var(--tb-error)' : 'var(--tb-warn)';
          valCell.style.fontWeight = '600';
        }
        tr.appendChild(valCell);
        tr.appendChild(el('td', { style: { padding: '2px 0 2px 8px', fontSize: '10px', color: 'var(--tb-text-soft)' } },
          s.flag === 'normal' ? '' : (s.flag || '')));
        table.appendChild(tr);
      }
      pop.appendChild(table);
    });
    return wrapper;
  }

  function buildEmptyState() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '👋 ' + t('ht.empty.title')));
    card.appendChild(el('p', null, t('ht.empty.body')));
    const btnRow = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap', marginTop: 'var(--tb-sp-2)' } });
    btnRow.appendChild(el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: () => openExamEditModal(null),
    }, '+ ' + t('ht.empty.addExam')));
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (hasKey) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        onclick: openVisionImportModal,
      }, '📎 ' + t('ht.empty.import')));
    }
    card.appendChild(btnRow);
    return card;
  }

  // ====================================================================
  // Tab: Lab Results
  // ====================================================================

  function renderLabsTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const tests = allLabTests();
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🧪 ' + t('ht.labs.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.labs.intro')));

    if (tests.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('ht.labs.empty')));
      tabHost.appendChild(card);
      return;
    }

    // ─── Group tests by clinical panel ─────────────────────────
    // Walk LAB_GROUPS in display order; for each, gather the user's
    // tests that belong. Tests not in any group go into an implicit
    // "Other" bucket rendered last. Each group renders as a
    // collapsible <details> block so the user can fold panels they
    // don't care about.
    const byGroup = {};
    const ungrouped = [];
    for (const tst of tests) {
      const gid = LAB_TEST_GROUP[tst.name];
      if (gid) {
        if (!byGroup[gid]) byGroup[gid] = [];
        byGroup[gid].push(tst);
      } else {
        ungrouped.push(tst);
      }
    }

    // Within each group, preserve LAB_GROUPS test order (clinically
    // meaningful — e.g., Hgb before Hct before RBC). Tests we recognize
    // but the user doesn't have are silently skipped.
    for (const g of LAB_GROUPS) {
      const groupTests = byGroup[g.id] || [];
      if (groupTests.length === 0) continue;
      const order = g.tests;
      groupTests.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
      card.appendChild(buildLabGroupPanel(g, groupTests));
    }

    // "Other" — tests outside any defined group
    if (ungrouped.length > 0) {
      // Sort abnormal-first then alphabetical inside the Other panel
      ungrouped.sort((a, b) => {
        const aBad = (a.latest_flag === 'critical' || a.latest_flag === 'high' || a.latest_flag === 'low') ? 0 : 1;
        const bBad = (b.latest_flag === 'critical' || b.latest_flag === 'high' || b.latest_flag === 'low') ? 0 : 1;
        if (aBad !== bBad) return aBad - bBad;
        return a.name.localeCompare(b.name);
      });
      card.appendChild(buildLabGroupPanel(
        { id: 'other', icon: '📋' },
        ungrouped
      ));
    }

    // Show a small legend when any row collapsed multiple names or
    // showed range variance — keeps users from puzzling at the ⇄ / *.
    const hasAliases = tests.some((x) => x.raw_names && x.raw_names.length > 1);
    const hasRangeVariance = tests.some((x) => x.range_varies);
    const hasInfo = tests.some((x) => getLabInfoFor(x.name) || x.method_note_key);
    if (hasAliases || hasRangeVariance || hasInfo) {
      const bits = [];
      if (hasInfo) bits.push('ⓘ ' + t('ht.labs.legend.info'));
      if (hasAliases) bits.push('⇄ ' + t('ht.labs.legend.alias'));
      if (hasRangeVariance) bits.push('* ' + t('ht.labs.legend.rangeVaries'));
      card.appendChild(el('p', {
        class: 'tb-field-help',
        style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
      }, bits.join(' · ')));
    }
    tabHost.appendChild(card);
  }

  // Build one collapsible panel for a clinical group.
  // Header shows: icon + label + (N tests · X abnormal indicator).
  // Body is the standard 6-column Lab Results table, scoped to this
  // group's tests.
  function buildLabGroupPanel(group, groupTests) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    // Count abnormal tests for the header summary
    const abnormalCount = groupTests.filter((x) =>
      x.latest_flag === 'critical' || x.latest_flag === 'high' || x.latest_flag === 'low'
    ).length;
    const criticalCount = groupTests.filter((x) => x.latest_flag === 'critical').length;

    // Determine header accent color from worst flag in group
    const headerColor = criticalCount > 0 ? 'var(--tb-error)'
                      : abnormalCount > 0 ? 'var(--tb-warn)'
                      : 'var(--tb-success)';

    // Auto-collapse fully-normal groups — keep abnormal panels open so
    // the user's attention lands on what needs follow-up.
    const startOpen = abnormalCount > 0;

    const details = el('details', {
      ...(startOpen ? { open: 'open' } : {}),
      style: {
        marginTop: 'var(--tb-sp-3)',
        borderLeft: '3px solid ' + headerColor,
        borderRadius: 'var(--tb-radius-2)',
        background: 'var(--tb-bg)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
      },
    });

    const groupLabel = t('ht.labs.group.' + group.id);
    const summary = el('summary', {
      style: {
        cursor: 'pointer', display: 'flex', alignItems: 'center',
        gap: 'var(--tb-sp-2)', fontWeight: '600', flexWrap: 'wrap',
        padding: '4px 0',
      },
    });
    summary.appendChild(el('span', { style: { fontSize: '16px' } }, group.icon || '📋'));
    summary.appendChild(el('span', null, groupLabel));
    summary.appendChild(el('span', {
      class: 'tb-card-meta',
      style: { fontSize: '11px', fontWeight: '400' },
    }, '· ' + t('ht.labs.group.count', { n: groupTests.length })));
    if (abnormalCount > 0) {
      summary.appendChild(el('span', {
        style: {
          fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: headerColor + '22', color: headerColor,
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
        },
      }, abnormalCount + ' ' + t('ht.labs.group.abnormal')));
    }
    details.appendChild(summary);

    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)', marginTop: 'var(--tb-sp-2)' },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        thTd(t('ht.labs.col.test'), true),
        thTd(t('ht.labs.col.latest'), true, 'right'),
        thTd(t('ht.labs.col.range'), true, 'right'),
        thTd(t('ht.labs.col.flag'), true, 'center'),
        thTd(t('ht.labs.col.readings'), true, 'right'),
        thTd(t('ht.labs.col.trend'), true, 'left'),
      ),
    ));
    const tbody = el('tbody');
    for (const tst of groupTests) tbody.appendChild(buildLabRow(tst));
    table.appendChild(tbody);
    details.appendChild(table);
    return details;
  }

  // Single Lab Results row. Extracted so both the grouped Labs tab
  // and any future per-exam lab view can share the same row layout.
  function buildLabRow(tst) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const series = trendForLabTest(tst.name);
    const flagColor = tst.latest_flag === 'critical' ? 'var(--tb-error)'
                    : tst.latest_flag === 'high' ? 'var(--tb-warn)'
                    : tst.latest_flag === 'low' ? 'var(--tb-warn)'
                    : 'var(--tb-success)';
    const flagBadge = el('span', {
      style: {
        padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
        background: flagColor + '22', color: flagColor,
        fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
      },
    }, tst.latest_flag || 'normal');
      // Test-name cell — when multiple raw-name variants collapsed
      // into this canonical, show a small ⇄ indicator. Hover opens a
      // popover listing the merged stored names with per-name counts
      // so the user can audit what was combined.
      const nameCell = el('span', null, el('strong', null, tst.name));
      // Combined info popover — one ⓘ that surfaces:
      //   • What the test measures
      //   • Why it matters (clinical significance)
      //   • Common high/low implications
      //   • Method-variance note (when applicable)
      //   • Footer disclaimer pointing to a doctor
      // Renders when there's any info (built-in or AI-generated override)
      // OR a method note exists.
      const labInfo = getLabInfoFor(tst.name);
      if (labInfo || tst.method_note_key) {
        const isAiInfo = !!(labInfo && labInfo.ai_generated);
        const infoBadge = el('span', {
          tabindex: '0',
          style: {
            marginLeft: '4px', fontSize: '12px', color: 'var(--tb-track-ai)',
            cursor: 'help', outline: 'none',
          },
        }, 'ⓘ');
        attachHoverPopover(infoBadge, (pop) => {
          const lang = TB.i18n.getLang() === 'ja' ? 'jp' : 'en';
          const info = labInfo && (labInfo[lang] || labInfo.en);
          // Title row — test name + small AI badge when override sourced.
          const titleRow = el('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' },
          });
          titleRow.appendChild(el('span', {
            style: { fontWeight: '700', fontSize: 'var(--tb-fs-14)' },
          }, tst.name));
          if (isAiInfo) {
            titleRow.appendChild(el('span', {
              style: { fontSize: '9px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
                background: 'rgba(46, 107, 92, 0.14)', color: 'var(--tb-track-ai)',
                fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
              title: t('ht.labs.info.aiGenerated.help'),
            }, '✨ ' + t('ht.labs.info.aiGenerated')));
          }
          pop.appendChild(titleRow);
          if (info) {
            if (info.what) {
              pop.appendChild(el('div', {
                style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
                  letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginTop: '6px' },
              }, t('ht.labs.info.what')));
              pop.appendChild(el('div', { style: { marginTop: '2px' } }, info.what));
            }
            if (info.why) {
              pop.appendChild(el('div', {
                style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
                  letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginTop: '6px' },
              }, t('ht.labs.info.why')));
              pop.appendChild(el('div', { style: { marginTop: '2px' } }, info.why));
            }
            if (info.high) {
              pop.appendChild(el('div', {
                style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
                  letterSpacing: '0.04em', color: 'var(--tb-warn)', marginTop: '6px' },
              }, t('ht.labs.info.high')));
              pop.appendChild(el('div', { style: { marginTop: '2px' } }, info.high));
            }
            if (info.low) {
              pop.appendChild(el('div', {
                style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
                  letterSpacing: '0.04em', color: 'var(--tb-warn)', marginTop: '6px' },
              }, t('ht.labs.info.low')));
              pop.appendChild(el('div', { style: { marginTop: '2px' } }, info.low));
            }
          }
          // Method note
          if (tst.method_note_key) {
            pop.appendChild(el('div', {
              style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
                letterSpacing: '0.04em', color: 'var(--tb-track-ai)', marginTop: '6px' },
            }, '⚖ ' + t('ht.labs.methodNote.title')));
            pop.appendChild(el('div', { style: { marginTop: '2px' } },
              t('ht.labs.methodNote.' + tst.method_note_key)));
          }
          // Disclaimer
          pop.appendChild(el('div', {
            style: { marginTop: '10px', paddingTop: '8px',
              borderTop: '1px dashed var(--tb-border)',
              fontSize: '10px', fontStyle: 'italic', color: 'var(--tb-text-soft)' },
          }, t('ht.labs.info.disclaimer')));
        });
        nameCell.appendChild(infoBadge);
      }
      if (tst.raw_names && tst.raw_names.length > 1) {
        const aliasBadge = el('span', {
          tabindex: '0',
          style: {
            marginLeft: '6px', fontSize: '10px',
            padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
            background: 'rgba(46, 107, 92, 0.10)', color: 'var(--tb-track-ai)',
            fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
            cursor: 'help', outline: 'none',
          },
        }, '⇄ ' + t('ht.labs.aliasBadge', { n: tst.raw_names.length }));
        attachHoverPopover(aliasBadge, (pop) => {
          pop.appendChild(el('div', {
            style: { fontWeight: '600', marginBottom: '6px',
              fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em',
              color: 'var(--tb-text-soft)' },
          }, t('ht.labs.aliasHover')));
          const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
          // tst.raw_names is sorted by count desc. We don't have the
          // counts here directly, so re-derive from the live exam
          // data so the popover shows up-to-date numbers.
          const counts = {};
          for (const e of getExams()) {
            for (const lr of (e.lab_results || [])) {
              const raw = String(lr.name || '').trim();
              if (!raw) continue;
              if (tst.raw_names.indexOf(raw) >= 0) {
                counts[raw] = (counts[raw] || 0) + 1;
              }
            }
          }
          for (const name of tst.raw_names) {
            list.appendChild(el('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: '12px' },
            },
              el('span', null, '• ' + name),
              el('span', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)' } },
                (counts[name] || 0) + '×'),
            ));
          }
          pop.appendChild(list);
        });
        nameCell.appendChild(aliasBadge);
      }

      // Range cell — when distinct ranges appear across reports
      // (different labs publish different reference intervals),
      // show the most-recent as primary and a popover listing variants.
      const rangeCell = el('span', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)' } },
        formatLabRange(tst.range_low, tst.range_high)
      );
      if (tst.range_varies) {
        const varBadge = el('span', {
          tabindex: '0',
          style: {
            marginLeft: '4px', fontSize: '10px', color: 'var(--tb-text-soft)',
            cursor: 'help', outline: 'none',
          },
        }, '*');
        attachHoverPopover(varBadge, (pop) => {
          pop.appendChild(el('div', {
            style: { fontWeight: '600', marginBottom: '6px',
              fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em',
              color: 'var(--tb-text-soft)' },
          }, t('ht.labs.rangeVariesHover')));
          const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
          for (const r of tst.range_variants) {
            list.appendChild(el('div', { style: { fontFamily: 'var(--tb-font-mono)' } }, '• ' + r));
          }
          pop.appendChild(list);
        });
        rangeCell.appendChild(varBadge);
      }

    return el('tr', null,
      thTd(nameCell),
      thTd(el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
        (tst.latest_value != null ? tst.latest_value : '—') + (tst.unit ? ' ' + tst.unit : '')
      ), false, 'right'),
      thTd(rangeCell, false, 'right'),
      thTd(flagBadge, false, 'center'),
      thTd(String(tst.count), false, 'right'),
      thTd(series.length >= 2 ? buildSparkline(series, { title: tst.name }) : el('span', { class: 'tb-card-meta' }, '—'), false, 'left'),
    );
  }

  function thTd(content, isHeader, align) {
    const el = TB.utils.el;
    const tag = isHeader ? 'th' : 'td';
    return el(tag, {
      style: {
        padding: '6px 8px', textAlign: align || 'left',
        borderBottom: isHeader ? '1px solid var(--tb-border)' : '1px dashed var(--tb-border)',
        fontSize: isHeader ? '10px' : 'inherit',
        fontWeight: isHeader ? '600' : 'normal',
        textTransform: isHeader ? 'uppercase' : 'none',
        letterSpacing: isHeader ? '0.04em' : 'normal',
        color: isHeader ? 'var(--tb-text-soft)' : 'inherit',
      },
    }, content);
  }

  // ====================================================================
  // Tab: Exam Details
  // ====================================================================

  function renderExamsTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const exams = getExams();
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('h2', { style: { margin: 0 } }, '📋 ' + t('ht.exams.title')),
      el('button', {
        class: 'tb-btn',
        type: 'button',
        onclick: () => openExamEditModal(null),
      }, '+ ' + t('ht.exams.add')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.exams.intro')));

    if (exams.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('ht.exams.empty')));
      tabHost.appendChild(card);
      return;
    }

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    for (const e of exams) {
      list.appendChild(buildExamRow(e));
    }
    card.appendChild(list);
    tabHost.appendChild(card);
  }

  function buildExamRow(exam) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const flagged = (exam.lab_results || []).filter((lr) => lr.flag && lr.flag !== 'normal').length;
    const docCount = (exam.documents || []).length;
    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        borderLeft: '3px solid ' + (flagged > 0 ? 'var(--tb-warn)' : 'var(--tb-track-health)'),
        borderRadius: 'var(--tb-radius-1)',
        cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
      onclick: () => openExamEditModal(exam),
    });
    const titleLine = el('div', { style: { fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      el('span', null, examTypeLabel(exam.type) + ' · ' + (exam.date || '—')),
    );
    // Document count badge — surfaces the multi-doc-per-exam pattern.
    // Only shows when more than one doc is attached (single-doc is the
    // default and doesn't need calling out).
    if (docCount > 1) {
      titleLine.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.12)', color: 'var(--tb-track-ai)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '📎 ' + docCount + ' ' + t('ht.exams.row.docs')));
    }
    row.appendChild(el('div', null,
      titleLine,
      el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } },
        (exam.provider || '') +
        (exam.facility ? ' · ' + exam.facility : '') +
        ((exam.lab_results || []).length > 0 ? ' · ' + (exam.lab_results.length) + ' lab(s)' : '') +
        (flagged > 0 ? ' · ' + flagged + ' flagged' : '')),
    ));
    row.appendChild(el('span', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', fontSize: '11px' } },
      exam.date ? t('ht.dash.daysAgo', { n: daysSince(exam.date) }) : ''));
    return row;
  }

  function examTypeLabel(typeId) {
    const lang = TB.i18n.getLang();
    const t = EXAM_TYPES.find((e) => e.id === typeId);
    if (!t) return typeId || '';
    return lang === 'ja' ? t.label_jp : t.label_en;
  }

  // ====================================================================
  // Tab: Care Plan
  // ====================================================================

  // ─── Sex / age setup banner ─────────────────────────────────────
  // When the user hasn't told us their biological sex or birth year,
  // the screening library is unfiltered — we show every screening
  // (mammogram, pap smear, prostate PSA, AAA ultrasound). This banner
  // is the prompt to set both so the list filters to what's relevant.
  // The data lives in health_tracker.preferences and ALSO in
  // onboarding.answers if the user filled it there; either source
  // works.
  function buildSetupBanner() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', {
      class: 'tb-card', 'data-track': 'health',
      style: {
        borderLeft: '4px solid var(--tb-warn)',
        background: 'rgba(185, 122, 26, 0.08)',
      },
    });
    card.appendChild(el('div', {
      style: { fontWeight: '600', color: 'var(--tb-warn)', marginBottom: '4px' },
    }, '⚙ ' + t('ht.setup.title')));
    card.appendChild(el('p', {
      class: 'tb-card-meta', style: { margin: '0 0 var(--tb-sp-3)' },
    }, t('ht.setup.body')));

    const row = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
    });

    // Sex picker
    const prefs = TB.state.get('health_tracker.preferences') || {};
    const curSex = computeUserSex();
    const sexSel = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        const v = e.target.value || null;
        const p = TB.state.get('health_tracker.preferences') || {};
        p.sex = v;
        TB.state.set('health_tracker.preferences', p);
        rerender();
      },
    },
      el('option', { value: '', selected: !curSex }, t('ht.setup.sex.choose')),
      el('option', { value: 'female', selected: curSex === 'female' }, t('ht.setup.sex.female')),
      el('option', { value: 'male', selected: curSex === 'male' }, t('ht.setup.sex.male')),
      el('option', { value: 'other', selected: curSex === 'other' }, t('ht.setup.sex.other')),
      el('option', { value: 'prefer_not_to_say', selected: curSex === 'prefer_not_to_say' }, t('ht.setup.sex.private')),
    );
    row.appendChild(el('div', null,
      el('label', { class: 'tb-field-label' }, t('ht.setup.sex.label')),
      sexSel,
      el('div', { class: 'tb-field-help' }, t('ht.setup.sex.help')),
    ));

    // Birth year input
    const curAge = computeAge();
    const curBy = TB.state.get('onboarding.answers.birth_year') ||
                  (prefs && prefs.age ? new Date().getFullYear() - prefs.age : '');
    const byInput = el('input', {
      type: 'number', class: 'tb-input',
      min: 1900, max: new Date().getFullYear() - 1,
      value: curBy || '',
      placeholder: 'e.g., 1980',
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        if (!isFinite(v) || v < 1900 || v > new Date().getFullYear() - 1) return;
        // Write both onboarding (so other modules can read) and prefs
        const ans = TB.state.get('onboarding.answers') || {};
        ans.birth_year = v;
        TB.state.set('onboarding.answers', ans);
        const p = TB.state.get('health_tracker.preferences') || {};
        p.age = new Date().getFullYear() - v;
        TB.state.set('health_tracker.preferences', p);
        rerender();
      },
    });
    row.appendChild(el('div', null,
      el('label', { class: 'tb-field-label' }, t('ht.setup.birthYear.label')),
      byInput,
      el('div', { class: 'tb-field-help' },
        t('ht.setup.birthYear.help') +
        (curAge != null ? ' · ' + t('ht.setup.birthYear.age', { age: curAge }) : '')),
    ));

    card.appendChild(row);
    return card;
  }

  function renderCarePlanTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const cp = getCarePlan();
    const lang = TB.i18n.getLang();

    // Setup banner first — same as Dashboard, but Care Plan is where
    // the screening filtering actually shows its effect.
    if (!computeUserSex() || computeAge() == null) {
      tabHost.appendChild(buildSetupBanner());
    }

    // Preventive screenings
    const screeningsCard = el('div', { class: 'tb-card', 'data-track': 'health' });
    screeningsCard.appendChild(el('h2', { style: { marginTop: 0 } }, '🎯 ' + t('ht.care.screenings.title')));
    screeningsCard.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.care.screenings.intro')));
    const screenings = computeScreeningsDue();
    if (screenings.length === 0) {
      screeningsCard.appendChild(el('p', { class: 'tb-field-help' }, t('ht.care.screenings.empty')));
    } else {
      const tbl = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' } });
      tbl.appendChild(el('thead', null,
        el('tr', null,
          thTd(t('ht.care.screenings.col.test'), true),
          thTd(t('ht.care.screenings.col.lastDone'), true, 'right'),
          thTd(t('ht.care.screenings.col.interval'), true, 'right'),
          thTd(t('ht.care.screenings.col.status'), true, 'center'),
          thTd('', true),
        ),
      ));
      const tb2 = el('tbody');
      for (const s of screenings) {
        const sLabel = lang === 'ja' ? s.label_jp : s.label_en;
        const statusColor = s.status === 'critical' ? 'var(--tb-error)'
                          : s.status === 'due' ? 'var(--tb-warn)'
                          : s.status === 'upcoming' ? 'var(--tb-track-tax)'
                          : 'var(--tb-success)';
        const statusBadge = el('span', {
          style: {
            padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
            background: statusColor + '22', color: statusColor,
            fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
          },
        }, t('ht.care.screenings.status.' + s.status));
        tb2.appendChild(el('tr', null,
          thTd(sLabel),
          thTd(s.last_done || '—', false, 'right'),
          thTd(s.interval_years + 'y', false, 'right'),
          thTd(statusBadge, false, 'center'),
          thTd(el('button', {
            class: 'tb-btn tb-btn--ghost',
            type: 'button',
            style: { padding: '2px 8px', fontSize: '11px' },
            onclick: () => openScreeningEditModal(s),
          }, '✎'), false, 'right'),
        ));
      }
      tbl.appendChild(tb2);
      screeningsCard.appendChild(tbl);
    }
    tabHost.appendChild(screeningsCard);

    // Primary concerns — manual entries + auto-derived from active
    // diagnoses + active episode conditions + active medication purpose.
    // Auto entries are recomputed on every render (not persisted) so
    // they always reflect the current state of attached records.
    const autoConcerns = deriveAutoPrimaryConcerns(cp);
    tabHost.appendChild(buildListCard(
      '🧭 ' + t('ht.care.concerns.title'),
      t('ht.care.concerns.intro'),
      (cp.primary_concerns || []).concat(autoConcerns),
      (item) => item.text + (item.severity ? ' · ' + item.severity : '') + (item.started_date ? ' (' + item.started_date + ')' : ''),
      () => addSimpleItem('primary_concerns', t('ht.care.concerns.add'))),
    );
    // Annual goals — manual entries + auto-derived from overdue
    // critical screenings.
    const autoGoals = deriveAutoAnnualGoals(cp, screenings);
    tabHost.appendChild(buildListCard(
      '🎯 ' + t('ht.care.goals.title'),
      t('ht.care.goals.intro'),
      (cp.annual_goals || []).concat(autoGoals),
      (item) => item.text + (item.target_date ? ' — target ' + item.target_date : '') + (item.status ? ' · ' + item.status : ''),
      () => addSimpleItem('annual_goals', t('ht.care.goals.add'))),
    );
    // Specialist referrals
    tabHost.appendChild(buildListCard(
      '👨‍⚕️ ' + t('ht.care.referrals.title'),
      t('ht.care.referrals.intro'),
      cp.specialist_referrals || [],
      (item) => (item.specialty || '?') + (item.doctor ? ' · ' + item.doctor : '') + (item.completed_date ? ' ✓ ' + item.completed_date : item.requested_date ? ' (requested ' + item.requested_date + ')' : ''),
      () => addReferral()),
    );
    // Next appointments
    tabHost.appendChild(buildListCard(
      '📅 ' + t('ht.care.appointments.title'),
      t('ht.care.appointments.intro'),
      cp.next_appointments || [],
      (item) => (item.date || '?') + ' · ' + (item.provider || '?') + (item.purpose ? ' — ' + item.purpose : ''),
      () => addAppointment()),
    );
  }

  function buildListCard(title, intro, items, formatItem, onAdd) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('h3', { style: { margin: 0 } }, title),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: onAdd,
      }, '+ ' + t('ht.care.add')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, intro));
    if (!items || items.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('ht.care.empty')));
      return card;
    }
    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: 'var(--tb-sp-2)' } });
    for (const item of items) {
      const isAuto = !!item.auto_source;
      const rowBody = el('span', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      },
        el('span', null, formatItem(item)),
        isAuto ? el('span', {
          style: {
            fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
            background: 'rgba(46, 107, 92, 0.10)', color: 'var(--tb-track-ai)',
            fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
          },
          title: item.auto_label || '',
        }, '🔄 ' + t('ht.care.auto') + (item.auto_label ? ' · ' + item.auto_label : '')) : null,
      );
      const row = el('div', {
        style: {
          padding: 'var(--tb-sp-1) var(--tb-sp-3)',
          background: isAuto ? 'transparent' : 'var(--tb-bg)',
          borderLeft: isAuto ? '2px dashed var(--tb-border)' : 'none',
          borderRadius: 'var(--tb-radius-1)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)',
          opacity: isAuto ? '0.85' : '1',
        },
      }, rowBody);
      // Auto-derived items can't be deleted from the list — they
      // re-derive on each render. The user can address the source
      // (end the medication, complete the episode, dismiss the
      // screening, etc.). Manual items keep their × delete button.
      if (!isAuto) {
        row.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '0 6px', fontSize: '12px', color: 'var(--tb-error)' },
          onclick: () => {
            if (!confirm(t('ht.care.delete.confirm'))) return;
            const cp = getCarePlan();
            for (const k of ['primary_concerns', 'annual_goals', 'specialist_referrals', 'next_appointments']) {
              const arr = cp[k] || [];
              const idx = arr.indexOf(item);
              if (idx >= 0) { arr.splice(idx, 1); cp[k] = arr; setCarePlan(cp); rerender(); return; }
            }
          },
        }, '×'));
      }
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  // ─── Care-plan auto-derivation ───────────────────────────────────
  //
  // These produce *transient* list entries marked with `auto_source` —
  // they're recomputed on every render of the Care Plan tab and never
  // saved to state. The user can't delete them directly; they fade
  // away when the source goes away (e.g., a medication is marked
  // ended, an episode is completed, a screening is brought current).
  //
  // De-duplication: we skip any auto entry whose text matches an
  // existing manual entry (case-insensitive). Lets the user "promote"
  // an auto item by manually re-adding it with their own wording.

  function deriveAutoPrimaryConcerns(cp) {
    const out = [];
    const seen = new Set();
    for (const it of (cp.primary_concerns || [])) {
      if (it && it.text) seen.add(String(it.text).toLowerCase().trim());
    }

    // 1) Diagnoses from the 3 most recent exams (oldest exams' diagnoses
    //    may be stale / one-off; cap at 3 for signal-to-noise).
    const recentExams = getExams().slice(0, 3);
    for (const e of recentExams) {
      for (const d of (e.diagnoses || [])) {
        if (!d) continue;
        const key = String(d).toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: 'cp-auto-dx-' + e.id + '-' + key.slice(0, 8),
          text: d,
          started_date: e.date || '',
          auto_source: 'exam:' + e.id,
          auto_label: TB.i18n.t('ht.care.auto.fromExam', { date: e.date || '' }),
        });
      }
    }

    // 2) Active care episodes' related_condition. Each episode may
    //    carry multiple conditions separated by semicolons (see
    //    recomputeEpisodeDerivedFields).
    for (const ep of getEpisodes()) {
      if (ep.status === 'completed' || ep.status === 'cancelled') continue;
      if (!ep.related_condition) continue;
      const conds = String(ep.related_condition).split(';').map((s) => s.trim()).filter(Boolean);
      for (const c of conds) {
        const key = c.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: 'cp-auto-ep-' + ep.id + '-' + key.slice(0, 8),
          text: c,
          started_date: ep.started_date || '',
          auto_source: 'episode:' + ep.id,
          auto_label: TB.i18n.t('ht.care.auto.fromEpisode', { title: ep.title || '' }),
        });
      }
    }

    // 3) Active medications with a stated purpose. "Atorvastatin for
    //    high cholesterol" → "high cholesterol" as a primary concern.
    for (const m of getMeds()) {
      if (m.ended_date) continue;
      if (!m.purpose) continue;
      const key = String(m.purpose).toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: 'cp-auto-med-' + m.id,
        text: m.purpose,
        auto_source: 'med:' + m.id,
        auto_label: TB.i18n.t('ht.care.auto.fromMed', { name: m.name || '' }),
      });
    }

    return out;
  }

  // Auto-generate annual-goal suggestions from any overdue (critical
  // or due) preventive screenings. The text reads as an action item
  // ("Schedule colonoscopy") with a "target by year-end" date. Once
  // the screening comes current (last_done updated), the goal
  // disappears automatically.
  function deriveAutoAnnualGoals(cp, screenings) {
    const out = [];
    const seen = new Set();
    for (const it of (cp.annual_goals || [])) {
      if (it && it.text) seen.add(String(it.text).toLowerCase().trim());
    }
    const yearEnd = (new Date().getFullYear()) + '-12-31';
    const lang = TB.i18n.getLang();
    for (const s of (screenings || [])) {
      // Only flag actually-overdue items. "Upcoming" and "current" are
      // not yet goal-worthy — would just clutter the list.
      if (s.status !== 'critical' && s.status !== 'due' && s.status !== 'never') continue;
      const label = lang === 'ja' ? s.label_jp : s.label_en;
      const text = TB.i18n.t('ht.care.auto.scheduleScreening', { name: label });
      const key = text.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: 'cp-auto-goal-' + s.library_id,
        text,
        target_date: yearEnd,
        auto_source: 'screening:' + s.library_id,
        auto_label: TB.i18n.t('ht.care.auto.fromScreening'),
      });
    }
    return out;
  }

  function addSimpleItem(field, promptLabel) {
    const text = prompt(promptLabel);
    if (!text || !text.trim()) return;
    const cp = getCarePlan();
    const arr = cp[field] || [];
    arr.push({ id: 'cp-' + Date.now().toString(36), text: text.trim(), created_at: new Date().toISOString() });
    cp[field] = arr;
    setCarePlan(cp);
    rerender();
  }
  function addReferral() {
    const specialty = prompt(TB.i18n.t('ht.care.referrals.prompt.specialty'));
    if (!specialty || !specialty.trim()) return;
    const doctor = prompt(TB.i18n.t('ht.care.referrals.prompt.doctor')) || '';
    const cp = getCarePlan();
    cp.specialist_referrals = cp.specialist_referrals || [];
    cp.specialist_referrals.push({
      id: 'ref-' + Date.now().toString(36),
      specialty: specialty.trim(),
      doctor: doctor.trim(),
      requested_date: new Date().toISOString().slice(0, 10),
    });
    setCarePlan(cp);
    rerender();
  }
  function addAppointment() {
    const date = prompt(TB.i18n.t('ht.care.appointments.prompt.date'), new Date().toISOString().slice(0, 10));
    if (!date) return;
    const provider = prompt(TB.i18n.t('ht.care.appointments.prompt.provider')) || '';
    const purpose = prompt(TB.i18n.t('ht.care.appointments.prompt.purpose')) || '';
    const cp = getCarePlan();
    cp.next_appointments = cp.next_appointments || [];
    cp.next_appointments.push({
      id: 'apt-' + Date.now().toString(36),
      date: date.trim(),
      provider: provider.trim(),
      purpose: purpose.trim(),
    });
    cp.next_appointments.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    setCarePlan(cp);
    rerender();
  }

  function openScreeningEditModal(screening) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const cp = getCarePlan();
    let userEntry = (cp.preventive_screenings_due || []).find((u) => u.library_id === screening.library_id);
    if (!userEntry) {
      userEntry = { library_id: screening.library_id, last_done: screening.last_done, interval_years: screening.interval_years };
      cp.preventive_screenings_due = cp.preventive_screenings_due || [];
      cp.preventive_screenings_due.push(userEntry);
    }
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '480px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      '🎯 ' + (lang === 'ja' ? screening.label_jp : screening.label_en)));

    const lastInput = el('input', {
      type: 'date', class: 'tb-input',
      value: userEntry.last_done || '',
      onchange: (e) => { userEntry.last_done = e.target.value || null; },
    });
    modal.appendChild(field(t('ht.care.screenings.lastDone'), lastInput));

    const intervalInput = el('input', {
      type: 'number', class: 'tb-input', step: 1, min: 1, max: 100,
      value: userEntry.interval_years || screening.interval_years,
      onchange: (e) => {
        const v = parseInt(e.target.value, 10);
        if (isFinite(v) && v > 0) userEntry.interval_years = v;
      },
    });
    modal.appendChild(field(t('ht.care.screenings.interval'), intervalInput, t('ht.care.screenings.interval.help')));

    const notesInput = el('textarea', {
      class: 'tb-textarea', rows: 2,
      value: userEntry.notes || '',
      onchange: (e) => { userEntry.notes = e.target.value || ''; },
    });
    modal.appendChild(field(t('ht.care.screenings.notes'), notesInput));

    const disableInput = el('input', {
      type: 'checkbox', checked: !!userEntry.disabled,
      onchange: (e) => { userEntry.disabled = !!e.target.checked; },
    });
    modal.appendChild(el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: 'var(--tb-sp-2)' } },
      disableInput,
      el('span', { class: 'tb-card-meta' }, t('ht.care.screenings.disable')),
    ));

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
      el('button', { class: 'tb-btn', type: 'button', onclick: () => {
        setCarePlan(cp);
        close();
        rerender();
      } }, t('ht.save')),
    ));
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Tab: Meds & Tracking
  // ====================================================================

  function renderMedsTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const meds = getMeds();
    const active = meds.filter((m) => !m.ended_date);
    const past = meds.filter((m) => m.ended_date);

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('h2', { style: { margin: 0 } }, '💊 ' + t('ht.meds.title')),
      el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => openMedEditModal(null),
      }, '+ ' + t('ht.meds.add')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.meds.intro')));

    if (meds.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('ht.meds.empty')));
      tabHost.appendChild(card);
      return;
    }

    if (active.length > 0) {
      card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)' } },
        t('ht.meds.active') + ' (' + active.length + ')'));
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
      for (const m of active) list.appendChild(buildMedRow(m));
      card.appendChild(list);
    }
    if (past.length > 0) {
      const details = el('details', { style: { marginTop: 'var(--tb-sp-3)' } });
      details.appendChild(el('summary', {
        style: { cursor: 'pointer', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
      }, t('ht.meds.past') + ' (' + past.length + ')'));
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: 'var(--tb-sp-2)', opacity: '0.6' } });
      for (const m of past) list.appendChild(buildMedRow(m));
      details.appendChild(list);
      card.appendChild(details);
    }
    tabHost.appendChild(card);
  }

  function buildMedRow(med) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const refillDue = med.next_refill_date && daysUntil(med.next_refill_date) <= 14;
    const isActive = !med.ended_date;

    // Quick-action buttons live in a right-aligned cluster. We
    // stopPropagation on each so they don't trigger the row's
    // click-to-edit handler.
    const actions = el('div', {
      style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' },
    });

    if (isActive) {
      // Mark refilled — bumps next_refill_date forward by the previous
      // gap (or 30d if no prior refill date), decrements
      // refills_remaining when set, stamps last_refill_date.
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        title: t('ht.meds.action.refill.help'),
        style: { padding: '2px 8px', fontSize: '11px' },
        onclick: (e) => {
          e.stopPropagation();
          markMedRefilled(med.id);
        },
      }, '↻ ' + t('ht.meds.action.refill')));

      // Mark course complete — sets ended_date to today. Confirmation
      // because the row visually fades into the Past list afterward.
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        title: t('ht.meds.action.complete.help'),
        style: { padding: '2px 8px', fontSize: '11px' },
        onclick: (e) => {
          e.stopPropagation();
          if (!confirm(t('ht.meds.action.complete.confirm', { name: med.name || '?' }))) return;
          markMedCompleted(med.id);
        },
      }, '✓ ' + t('ht.meds.action.complete')));
    } else {
      // Resume — clears ended_date and pops the med back into Active.
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        title: t('ht.meds.action.resume.help'),
        style: { padding: '2px 8px', fontSize: '11px' },
        onclick: (e) => {
          e.stopPropagation();
          markMedResumed(med.id);
        },
      }, '↺ ' + t('ht.meds.action.resume')));
    }

    // Right-most refill-due badge (when soon)
    if (refillDue) {
      actions.appendChild(el('span', {
        style: { color: 'var(--tb-warn)', fontSize: '11px', fontWeight: '600' },
      }, '⚠ refill ' + med.next_refill_date));
    }

    return el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        borderLeft: '3px solid ' + (refillDue ? 'var(--tb-warn)' : 'var(--tb-track-health)'),
        borderRadius: 'var(--tb-radius-1)',
        cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
      onclick: () => openMedEditModal(med),
    },
      el('div', null,
        el('div', { style: { fontWeight: '600' } },
          (med.name || '?') +
          (med.dosage ? ' · ' + med.dosage + (med.dosage_unit || '') : '') +
          (med.frequency ? ' · ' + med.frequency : '')),
        el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } },
          (med.purpose ? med.purpose + ' · ' : '') +
          (med.prescriber ? med.prescriber : '') +
          (med.started_date ? ' · since ' + med.started_date : '') +
          (med.ended_date ? ' · ended ' + med.ended_date : '') +
          (med.last_refill_date ? ' · refilled ' + med.last_refill_date : '')),
      ),
      actions,
    );
  }

  // ─── Medication state mutators (quick-action helpers) ────────────
  //
  // markMedRefilled — bump next_refill_date forward by the gap between
  // started_date / last_refill_date and the current next_refill_date.
  // Fall back to +30d when we can't compute a sensible gap. Decrement
  // refills_remaining when > 0. Stamps last_refill_date = today so the
  // user has a clean refill history visible in the row meta.
  function markMedRefilled(medId) {
    const med = getMeds().find((m) => m.id === medId);
    if (!med) return;
    const updated = Object.assign({}, med);
    const today = new Date().toISOString().slice(0, 10);
    // Compute gap days. Prefer previous interval (next_refill_date -
    // last_refill_date / started_date). Fall back to 30 days.
    let gapDays = 30;
    if (med.next_refill_date) {
      const anchor = med.last_refill_date || med.started_date;
      if (anchor) {
        const a = new Date(anchor + 'T00:00:00').getTime();
        const b = new Date(med.next_refill_date + 'T00:00:00').getTime();
        if (!isNaN(a) && !isNaN(b) && b > a) gapDays = Math.round((b - a) / 86400000);
      }
    }
    const next = new Date(today + 'T00:00:00');
    next.setDate(next.getDate() + gapDays);
    updated.next_refill_date = next.toISOString().slice(0, 10);
    updated.last_refill_date = today;
    if (typeof updated.refills_remaining === 'number' && updated.refills_remaining > 0) {
      updated.refills_remaining -= 1;
    }
    updated.updated_at = new Date().toISOString();
    upsertMed(updated);
    rerender();
  }

  function markMedCompleted(medId) {
    const med = getMeds().find((m) => m.id === medId);
    if (!med) return;
    const updated = Object.assign({}, med, {
      ended_date: new Date().toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    });
    upsertMed(updated);
    // If the med was part of an episode, recompute so the episode's
    // date range / outcome can update if this completion closes it.
    if (updated.episode_id) {
      try { recomputeEpisodeDerivedFields(updated.episode_id); } catch (_) {}
    }
    rerender();
  }

  function markMedResumed(medId) {
    const med = getMeds().find((m) => m.id === medId);
    if (!med) return;
    const updated = Object.assign({}, med, {
      ended_date: null,
      updated_at: new Date().toISOString(),
    });
    upsertMed(updated);
    rerender();
  }

  function openMedEditModal(existing, prefill) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    // Re-fetch latest from state in case the caller is holding a
    // stale reference (e.g., after an invoice import created the med).
    if (existing && existing.id) {
      const fresh = getMeds().find((m) => m.id === existing.id);
      if (fresh) existing = fresh;
    }
    const isEdit = !!existing;
    const draft = existing ? Object.assign({}, existing) : Object.assign({
      id: 'med-' + Date.now().toString(36),
      name: '', generic_name: '', dosage: null, dosage_unit: 'mg',
      frequency: '', route: 'oral',
      started_date: new Date().toISOString().slice(0, 10),
      ended_date: null,
      prescriber: '', pharmacy: '',
      refills_remaining: null, next_refill_date: null,
      purpose: '', side_effects: '', notes: '',
      exam_id: null,
      episode_id: null,
    }, prefill || {});
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '560px' } });
    backdrop.appendChild(modal);
    function close() {
      root.innerHTML = '';
      // Return to the parent record's modal when one is set — exam
      // takes precedence (came from "Linked medications" on an exam),
      // episode falls through.
      if (draft.exam_id) {
        const ex = getExams().find((e) => e.id === draft.exam_id);
        if (ex) { openExamEditModal(ex); return; }
      }
      if (draft.episode_id) {
        const ep = getEpisodes().find((e) => e.id === draft.episode_id);
        if (ep) openEpisodeEditModal(ep);
      }
    }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      (isEdit ? t('ht.meds.editTitle') : t('ht.meds.addTitle'))));

    // Capture original episode_id for cross-episode reassignment.
    const originalMedEpisodeId = existing ? (existing.episode_id || null) : null;

    const nameInput = textInput(draft.name, (v) => draft.name = v);
    modal.appendChild(field(t('ht.meds.field.name'), nameInput));
    const genericInput = textInput(draft.generic_name, (v) => draft.generic_name = v);
    modal.appendChild(field(t('ht.meds.field.generic'), genericInput, t('ht.meds.field.generic.help')));

    const dosageRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 100px', gap: 'var(--tb-sp-2)' } },
      numInput(draft.dosage, (v) => draft.dosage = v),
      el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.dosage_unit = e.target.value; },
      },
        ['mg', 'mcg', 'g', 'mL', 'units', 'IU', 'puff'].map((u) =>
          el('option', { value: u, selected: draft.dosage_unit === u }, u)),
      ),
    );
    modal.appendChild(field(t('ht.meds.field.dosage'), dosageRow));

    const freqInput = textInput(draft.frequency, (v) => draft.frequency = v);
    modal.appendChild(field(t('ht.meds.field.frequency'), freqInput, t('ht.meds.field.frequency.help')));

    modal.appendChild(field(t('ht.meds.field.route'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.route = e.target.value; },
    },
      [
        { v: 'oral', en: 'Oral', jp: '内服' },
        { v: 'topical', en: 'Topical', jp: '外用' },
        { v: 'injectable', en: 'Injectable', jp: '注射' },
        { v: 'inhaler', en: 'Inhaler', jp: '吸入' },
        { v: 'other', en: 'Other', jp: 'その他' },
      ].map((o) => el('option', { value: o.v, selected: draft.route === o.v }, lang === 'ja' ? o.jp : o.en)),
    )));

    modal.appendChild(field(t('ht.meds.field.purpose'),
      textInput(draft.purpose, (v) => draft.purpose = v),
      t('ht.meds.field.purpose.help')));

    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.meds.field.started'), dateInput(draft.started_date, (v) => draft.started_date = v)),
      field(t('ht.meds.field.ended'), dateInput(draft.ended_date, (v) => draft.ended_date = v), t('ht.meds.field.ended.help')),
    ));

    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.meds.field.prescriber'), textInput(draft.prescriber, (v) => draft.prescriber = v)),
      field(t('ht.meds.field.pharmacy'), textInput(draft.pharmacy, (v) => draft.pharmacy = v)),
    ));

    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.meds.field.refills'),
        numInput(draft.refills_remaining, (v) => draft.refills_remaining = v)),
      field(t('ht.meds.field.nextRefill'),
        dateInput(draft.next_refill_date, (v) => draft.next_refill_date = v)),
    ));

    modal.appendChild(field(t('ht.meds.field.sideEffects'),
      textareaInput(draft.side_effects, (v) => draft.side_effects = v)));

    // Episode link picker — same pattern as the exam edit modal,
    // letting users tie post-procedure prescriptions to the originating
    // episode (e.g., Bowtrol for the colonoscopy episode).
    const allEps = getEpisodes();
    if (allEps.length > 0) {
      const epSelect = el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.episode_id = e.target.value || null; },
      },
        el('option', { value: '', selected: !draft.episode_id }, '— ' + t('ht.meds.field.episode.none') + ' —'),
        ...allEps.map((ep) =>
          el('option', { value: ep.id, selected: draft.episode_id === ep.id },
            (episodeCategoryMeta(ep.category).icon) + ' ' + ep.title)),
      );
      modal.appendChild(field('🧭 ' + t('ht.meds.field.episode'), epSelect));
    }

    modal.appendChild(field(t('ht.meds.field.notes'),
      textareaInput(draft.notes, (v) => draft.notes = v)));

    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' },
    });
    if (isEdit) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          // deleteMedWithUndo handles its own named confirm + undo toast.
          if (!deleteMedWithUndo(draft.id)) return;
          close();
          rerender();
        },
      }, t('ht.delete')));
    } else {
      btnRow.appendChild(el('span'));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        if (!draft.name || !draft.name.trim()) { alert(t('ht.meds.field.name.required')); return; }
        upsertMed(draft);
        if (originalMedEpisodeId && originalMedEpisodeId !== draft.episode_id) {
          recomputeEpisodeDerivedFields(originalMedEpisodeId);
        }
        if (draft.episode_id) {
          recomputeEpisodeDerivedFields(draft.episode_id);
        }
        close();
        rerender();
      },
    }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Tab: Care Episodes (v0.39)
  // ====================================================================
  //
  // List view + detail-view modal. Each episode ties together exams,
  // medications, and invoices around a single medical event so the
  // user sees the full "colonoscopy journey" in one place rather than
  // fragmented across three tabs.

  const EPISODE_CATEGORIES = [
    { id: 'screening',  label_en: 'Screening',         label_jp: 'スクリーニング',   icon: '🔍' },
    { id: 'procedure',  label_en: 'Procedure',         label_jp: '処置・手術',       icon: '🩺' },
    { id: 'condition',  label_en: 'Ongoing condition', label_jp: '継続的な疾患',     icon: '📊' },
    { id: 'injury',     label_en: 'Injury / acute',    label_jp: '外傷・急性',       icon: '🤕' },
    { id: 'pregnancy',  label_en: 'Pregnancy',         label_jp: '妊娠・出産',       icon: '🤰' },
    { id: 'mental',     label_en: 'Mental health',     label_jp: 'メンタルヘルス',   icon: '🧠' },
    { id: 'preventive', label_en: 'Preventive care',   label_jp: '予防医療',         icon: '✨' },
    { id: 'other',      label_en: 'Other',             label_jp: 'その他',           icon: '📁' },
  ];

  const EPISODE_STATUSES = [
    { id: 'active',     label_en: 'Active',     label_jp: '進行中',   color: 'var(--tb-warn)' },
    { id: 'monitoring', label_en: 'Monitoring', label_jp: '経過観察', color: 'var(--tb-track-tax)' },
    { id: 'completed',  label_en: 'Completed',  label_jp: '完了',     color: 'var(--tb-success)' },
    { id: 'cancelled',  label_en: 'Cancelled',  label_jp: 'キャンセル', color: 'var(--tb-text-soft)' },
  ];

  function episodeCategoryMeta(id) {
    return EPISODE_CATEGORIES.find((c) => c.id === id) || EPISODE_CATEGORIES[EPISODE_CATEGORIES.length - 1];
  }
  function episodeStatusMeta(id) {
    return EPISODE_STATUSES.find((s) => s.id === id) || EPISODE_STATUSES[0];
  }

  function renderEpisodesTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const eps = getEpisodes();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('h2', { style: { margin: 0 } }, '🧭 ' + t('ht.episodes.title')),
      el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => openEpisodeEditModal(null),
      }, '+ ' + t('ht.episodes.add')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.episodes.intro')));

    if (eps.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('ht.episodes.empty')));
      tabHost.appendChild(card);
      return;
    }

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    for (const ep of eps) {
      list.appendChild(buildEpisodeRow(ep));
    }
    card.appendChild(list);
    tabHost.appendChild(card);
  }

  function buildEpisodeRow(ep) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const cat = episodeCategoryMeta(ep.category);
    const stat = episodeStatusMeta(ep.status || 'active');
    const examsCount = examsForEpisode(ep.id).length;
    const medsCount = medicationsForEpisode(ep.id).length;
    const invs = invoicesForEpisode(ep.id);
    const cost = totalCostForEpisode(ep.id);
    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '4px solid ' + stat.color,
        borderRadius: 'var(--tb-radius-2)',
        cursor: 'pointer',
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--tb-sp-3)',
        alignItems: 'start',
      },
      onclick: () => openEpisodeEditModal(ep),
    });
    const left = el('div');
    left.appendChild(el('div', {
      style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' },
    },
      el('span', { style: { fontSize: 'var(--tb-fs-18)' } }, cat.icon),
      el('strong', { style: { fontSize: 'var(--tb-fs-16)' } }, ep.title || t('ht.episodes.untitled')),
      el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: stat.color + '22', color: stat.color,
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, lang === 'ja' ? stat.label_jp : stat.label_en),
    ));
    const meta = [];
    if (ep.specialty) meta.push(ep.specialty);
    if (ep.provider) meta.push(ep.provider);
    if (ep.started_date) {
      const dur = ep.completed_date
        ? ep.started_date + ' → ' + ep.completed_date
        : ep.started_date + ' → ' + t('ht.episodes.ongoing');
      meta.push(dur);
    }
    if (meta.length) {
      left.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, meta.join(' · ')));
    }
    // Counts line
    const counts = [];
    if (examsCount > 0) counts.push('📋 ' + examsCount + ' ' + t('ht.episodes.exams'));
    if (medsCount > 0) counts.push('💊 ' + medsCount + ' ' + t('ht.episodes.meds'));
    if (invs.length > 0) counts.push('🧾 ' + invs.length + ' ' + t('ht.episodes.invoices'));
    if (counts.length) {
      left.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, counts.join(' · ')));
    }
    if (ep.notes) {
      left.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px', lineHeight: 'var(--tb-lh-body)' } }, ep.notes.slice(0, 140) + (ep.notes.length > 140 ? '…' : '')));
    }
    row.appendChild(left);

    // Right column — cost summary
    if (cost.gross > 0) {
      const right = el('div', { style: { textAlign: 'right', minWidth: '90px' } });
      right.appendChild(el('div', {
        style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', fontSize: 'var(--tb-fs-16)' },
      }, '$' + Math.round(cost.gross).toLocaleString()));
      if (cost.reimbursed > 0) {
        right.appendChild(el('div', { style: { fontSize: '10px', color: 'var(--tb-success)', fontFamily: 'var(--tb-font-mono)' } },
          '−$' + Math.round(cost.reimbursed).toLocaleString() + ' ' + t('ht.episodes.reimbursed')));
        right.appendChild(el('div', { style: { fontSize: '11px', fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-soft)' } },
          'net $' + Math.round(cost.net).toLocaleString()));
      }
      row.appendChild(right);
    }
    return row;
  }

  // ─── Episode add/edit modal ───────────────────────────────────────
  function openEpisodeEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    // CRITICAL: always re-fetch the latest version from state when an
    // existing episode is passed. Callers (picker modals, invoice
    // save) capture an `ep` reference BEFORE recompute fires, so
    // without this re-fetch the modal would render stale auto-fill
    // values — the data is correct in state but the JS object isn't.
    if (existing && existing.id) {
      const fresh = getEpisodes().find((e) => e.id === existing.id);
      if (fresh) existing = fresh;
    }
    const isEdit = !!existing;
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: 'ep-' + Date.now().toString(36),
      title: '',
      status: 'active',
      category: 'procedure',
      started_date: new Date().toISOString().slice(0, 10),
      completed_date: null,
      specialty: '',
      provider: '',
      facility: '',
      related_condition: '',
      notes: '',
      outcome: '',
      ai_summary: '',
      consultation_ids: [],
      vault_doc_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '760px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('button', { class: 'tb-modal-close', type: 'button', onclick: close }, '×'));
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      (isEdit ? t('ht.episodes.edit') : t('ht.episodes.addTitle'))));

    // Helpers used by both new + edit views. autoFillHint surfaces a
    // tiny ✨ Auto-filled badge next to fields that were derived from
    // attached records; userTouched strips that badge once the user
    // edits the field so subsequent attachments don't overwrite.
    function userTouched(fieldName) {
      delete draft['__derived_' + fieldName];
    }
    function autoFillHint(fieldName) {
      if (draft['__derived_' + fieldName]) {
        return el('span', {
          style: { fontSize: '10px', padding: '1px 6px', marginLeft: '6px',
            borderRadius: 'var(--tb-radius-pill)',
            background: 'rgba(46, 107, 92, 0.12)', color: 'var(--tb-track-ai)',
            fontWeight: '600', letterSpacing: '0.04em', textTransform: 'uppercase' },
        }, '✨ ' + t('ht.episodes.field.autoFilled'));
      }
      return null;
    }
    function labeledField(label, fieldKey, control, help) {
      const labelNode = el('span', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap' } },
        label,
        autoFillHint(fieldKey),
      );
      return el('div', { class: 'tb-field' },
        labelNode,
        control,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    // ─── Always-shown: the four essentials ───────────────────────
    // Brand-new episode creation shows ONLY these. Specialty, provider,
    // facility, condition, notes, outcome all auto-fill from attached
    // records — no point asking up front before data exists.
    modal.appendChild(field(t('ht.episodes.field.title'),
      textInput(draft.title, (v) => { draft.title = v; }),
      t('ht.episodes.field.title.help')));

    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.episodes.field.category'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.category = e.target.value; },
      }, EPISODE_CATEGORIES.map((c) =>
        el('option', { value: c.id, selected: draft.category === c.id },
          c.icon + ' ' + (lang === 'ja' ? c.label_jp : c.label_en))))),
      field(t('ht.episodes.field.status'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.status = e.target.value; },
      }, EPISODE_STATUSES.map((s) =>
        el('option', { value: s.id, selected: draft.status === s.id },
          lang === 'ja' ? s.label_jp : s.label_en)))),
    ));

    // Started date — single field on new (Completed auto-fills when
    // status flips). Side-by-side with Completed on edit.
    if (isEdit) {
      modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
        labeledField(t('ht.episodes.field.started'), 'started_date',
          dateInput(draft.started_date, (v) => { draft.started_date = v; userTouched('started_date'); })),
        labeledField(t('ht.episodes.field.completed'), 'completed_date',
          dateInput(draft.completed_date, (v) => { draft.completed_date = v; userTouched('completed_date'); }),
          t('ht.episodes.field.completed.help')),
      ));
    } else {
      modal.appendChild(field(t('ht.episodes.field.started'),
        dateInput(draft.started_date, (v) => { draft.started_date = v; }),
        t('ht.episodes.field.started.help.new')));
    }

    // ─── Edit-mode only: fine-tuning fields + attachments ────────
    if (isEdit) {
      // Visual divider — explains that everything below auto-fills
      modal.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-4)', marginBottom: 'var(--tb-sp-2)',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'rgba(46, 107, 92, 0.06)',
          borderLeft: '3px solid var(--tb-track-ai)',
          borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)',
        },
      },
        el('strong', null, '✨ ' + t('ht.episodes.autofill.section')),
        ' ' + t('ht.episodes.autofill.body')));

      modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
        labeledField(t('ht.episodes.field.specialty'), 'specialty',
          textInput(draft.specialty, (v) => { draft.specialty = v; userTouched('specialty'); }),
          t('ht.episodes.field.specialty.help')),
        labeledField(t('ht.episodes.field.provider'), 'provider',
          textInput(draft.provider, (v) => { draft.provider = v; userTouched('provider'); })),
      ));

      modal.appendChild(labeledField(t('ht.episodes.field.facility'), 'facility',
        textInput(draft.facility, (v) => { draft.facility = v; userTouched('facility'); })));

      modal.appendChild(labeledField(t('ht.episodes.field.condition'), 'related_condition',
        textInput(draft.related_condition, (v) => { draft.related_condition = v; userTouched('related_condition'); }),
        t('ht.episodes.field.condition.help')));

      modal.appendChild(labeledField(t('ht.episodes.field.notes'), 'notes',
        textareaInput(draft.notes, (v) => { draft.notes = v; userTouched('notes'); })));

      modal.appendChild(labeledField(t('ht.episodes.field.outcome'), 'outcome',
        textareaInput(draft.outcome, (v) => { draft.outcome = v; userTouched('outcome'); }),
        t('ht.episodes.field.outcome.help')));

      modal.appendChild(buildEpisodeAttachmentsSection(draft));
    } else {
      // Brand-new: surface "next steps" so the user knows what to do
      modal.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-4)',
          padding: 'var(--tb-sp-3)',
          background: 'rgba(46, 107, 92, 0.08)',
          borderLeft: '3px solid var(--tb-track-ai)',
          borderRadius: 'var(--tb-radius-2)',
        },
      },
        el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
          '✨ ' + t('ht.episodes.create.nextSteps.title')),
        el('div', { class: 'tb-card-meta', style: { lineHeight: 'var(--tb-lh-body)' } },
          t('ht.episodes.create.nextSteps.body'))));
    }

    // Bottom buttons
    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' },
    });
    if (isEdit) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          if (!deleteEpisodeWithUndo(draft.id)) return;
          close();
          rerender();
        },
      }, t('ht.delete')));
    } else {
      btnRow.appendChild(el('span'));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        if (!draft.title || !draft.title.trim()) { alert(t('ht.episodes.field.title.required')); return; }
        draft.updated_at = new Date().toISOString();
        upsertEpisode(draft);
        // For new episodes, re-open in edit mode so user can attach things
        if (!isEdit) {
          close();
          openEpisodeEditModal(draft);
          return;
        }
        close();
        rerender();
      },
    }, isEdit ? t('ht.save') : t('ht.episodes.create.saveContinue')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // The "attachments" panel inside the episode edit modal — shows the
  // timeline of exams, related medications, and invoices associated
  // with this episode, with add/remove affordances.
  function buildEpisodeAttachmentsSection(ep) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const wrap = el('div', {
      style: { marginTop: 'var(--tb-sp-4)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
    });
    wrap.appendChild(el('h3', { style: { marginTop: 0 } }, '🔗 ' + t('ht.episodes.attached.title')));

    // ─── Attached exams (timeline) ───────────────────────────────
    const exams = examsForEpisode(ep.id);
    wrap.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 'var(--tb-sp-3)' },
    },
      el('div', { style: { fontWeight: '600' } }, '📋 ' + t('ht.episodes.attached.exams') + ' (' + exams.length + ')'),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openExamPickerForEpisode(ep),
      }, '+ ' + t('ht.episodes.attached.exams.add')),
    ));
    if (exams.length === 0) {
      wrap.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: '4px' } }, t('ht.episodes.attached.exams.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } });
      for (const e of exams) {
        list.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-1) var(--tb-sp-3)', background: 'var(--tb-bg-elev)',
            borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)',
          },
        },
          el('span', null,
            (e.date || '?') + ' · ' + examTypeLabel(e.type) +
            (e.provider ? ' · ' + e.provider : '') +
            ((e.lab_results || []).length > 0 ? ' · ' + e.lab_results.length + ' lab(s)' : '')),
          el('span', { style: { display: 'flex', gap: '4px' } },
            el('button', {
              class: 'tb-btn tb-btn--ghost', type: 'button',
              style: { padding: '0 8px', fontSize: '11px' },
              title: t('ht.episodes.attached.exams.open'),
              onclick: () => {
                const root = document.getElementById('tb-modal-root');
                if (root) root.innerHTML = '';
                openExamEditModal(e);
              },
            }, '✎'),
            el('button', {
              class: 'tb-btn tb-btn--ghost', type: 'button',
              style: { padding: '0 8px', fontSize: '14px', color: 'var(--tb-error)' },
              title: t('ht.episodes.attached.exams.detach'),
              onclick: () => {
                const updated = Object.assign({}, e, { episode_id: null });
                upsertExam(updated);
                recomputeEpisodeDerivedFields(ep.id);
                const refreshed = getEpisodes().find((x) => x.id === ep.id);
                const root = document.getElementById('tb-modal-root');
                if (root) root.innerHTML = '';
                openEpisodeEditModal(refreshed || ep);
              },
            }, '×'),
          ),
        ));
      }
      wrap.appendChild(list);
    }

    // ─── Attached medications ────────────────────────────────────
    const meds = medicationsForEpisode(ep.id);
    wrap.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 'var(--tb-sp-3)' },
    },
      el('div', { style: { fontWeight: '600' } }, '💊 ' + t('ht.episodes.attached.meds') + ' (' + meds.length + ')'),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openMedPickerForEpisode(ep),
      }, '+ ' + t('ht.episodes.attached.meds.add')),
    ));
    if (meds.length === 0) {
      wrap.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: '4px' } }, t('ht.episodes.attached.meds.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } });
      for (const m of meds) {
        list.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-1) var(--tb-sp-3)', background: 'var(--tb-bg-elev)',
            borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)',
          },
        },
          el('span', null,
            (m.name || '?') +
            (m.dosage ? ' · ' + m.dosage + (m.dosage_unit || '') : '') +
            (m.started_date ? ' · ' + m.started_date : '') +
            (m.ended_date ? ' → ' + m.ended_date : '')),
          el('span', { style: { display: 'flex', gap: '4px' } },
            el('button', {
              class: 'tb-btn tb-btn--ghost', type: 'button',
              style: { padding: '0 8px', fontSize: '11px' },
              onclick: () => {
                const root = document.getElementById('tb-modal-root');
                if (root) root.innerHTML = '';
                openMedEditModal(m);
              },
            }, '✎'),
            el('button', {
              class: 'tb-btn tb-btn--ghost', type: 'button',
              style: { padding: '0 8px', fontSize: '14px', color: 'var(--tb-error)' },
              onclick: () => {
                const updated = Object.assign({}, m, { episode_id: null });
                upsertMed(updated);
                recomputeEpisodeDerivedFields(ep.id);
                const refreshed = getEpisodes().find((x) => x.id === ep.id);
                const root = document.getElementById('tb-modal-root');
                if (root) root.innerHTML = '';
                openEpisodeEditModal(refreshed || ep);
              },
            }, '×'),
          ),
        ));
      }
      wrap.appendChild(list);
    }

    // ─── Attached invoices + cost summary ────────────────────────
    const invs = invoicesForEpisode(ep.id);
    const cost = totalCostForEpisode(ep.id);
    wrap.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 'var(--tb-sp-3)' },
    },
      el('div', { style: { fontWeight: '600' } }, '🧾 ' + t('ht.episodes.attached.invoices') + ' (' + invs.length + ')'),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openInvoiceEditModal(null, { episode_id: ep.id }),
      }, '+ ' + t('ht.episodes.attached.invoices.add')),
    ));
    if (invs.length === 0) {
      wrap.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: '4px' } }, t('ht.episodes.attached.invoices.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } });
      for (const inv of invs) {
        const reimColor = inv.reimbursement_status === 'received' ? 'var(--tb-success)'
                        : inv.reimbursement_status === 'denied' ? 'var(--tb-error)'
                        : inv.reimbursement_status === 'submitted' || inv.reimbursement_status === 'pending' ? 'var(--tb-warn)'
                        : 'var(--tb-text-soft)';
        list.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-1) var(--tb-sp-3)', background: 'var(--tb-bg-elev)',
            borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)',
          },
        },
          el('div', null,
            el('div', null,
              (inv.date || '?') + ' · ' + (inv.provider || '?') +
              (inv.type ? ' · ' + t('ht.invoices.type.' + inv.type) : '')),
            el('div', { class: 'tb-card-meta', style: { fontSize: '11px', fontFamily: 'var(--tb-font-mono)' } },
              (inv.amount_native != null ? inv.amount_native.toLocaleString() + ' ' + (inv.currency || 'USD') : '?') +
              (inv.amount_usd_calc != null && inv.currency !== 'USD' ? ' (≈ $' + Math.round(inv.amount_usd_calc).toLocaleString() + ')' : '') +
              ' · ' +
              el('span', { style: { color: reimColor } }, t('ht.invoices.reim.' + (inv.reimbursement_status || 'na'))).outerHTML),
          ),
          el('span', { style: { display: 'flex', gap: '4px' } },
            el('button', {
              class: 'tb-btn tb-btn--ghost', type: 'button',
              style: { padding: '0 8px', fontSize: '11px' },
              onclick: () => {
                const root = document.getElementById('tb-modal-root');
                if (root) root.innerHTML = '';
                openInvoiceEditModal(inv);
              },
            }, '✎'),
            el('button', {
              class: 'tb-btn tb-btn--ghost', type: 'button',
              style: { padding: '0 8px', fontSize: '14px', color: 'var(--tb-error)' },
              onclick: () => {
                if (!deleteInvoiceWithUndo(inv.id)) return;
                recomputeEpisodeDerivedFields(ep.id);
                const refreshed = getEpisodes().find((x) => x.id === ep.id);
                const root = document.getElementById('tb-modal-root');
                if (root) root.innerHTML = '';
                openEpisodeEditModal(refreshed || ep);
              },
            }, '×'),
          ),
        ));
      }
      wrap.appendChild(list);
    }
    if (cost.gross > 0) {
      wrap.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)',
          display: 'flex', justifyContent: 'space-between', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      },
        el('span', null, t('ht.episodes.cost.total') + ': '),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } },
          '$' + Math.round(cost.gross).toLocaleString() +
          (cost.reimbursed > 0 ? '  −  $' + Math.round(cost.reimbursed).toLocaleString() + ' = $' + Math.round(cost.net).toLocaleString() + ' ' + t('ht.episodes.cost.net') : '')),
      ));
    }

    return wrap;
  }

  // Modal to pick from existing exams to attach to an episode. Lists
  // exams not already attached; click to attach + close. Useful for
  // retroactively grouping a colonoscopy episode after the fact.
  function openExamPickerForEpisode(ep) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const candidates = getExams().filter((e) => !e.episode_id || e.episode_id === ep.id);
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '560px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; openEpisodeEditModal(ep); }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '📋 ' + t('ht.episodes.picker.exams.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.episodes.picker.exams.intro')));

    if (candidates.length === 0) {
      modal.appendChild(el('p', { class: 'tb-field-help' }, t('ht.episodes.picker.exams.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '50vh', overflowY: 'auto' } });
      for (const e of candidates) {
        const isAttached = e.episode_id === ep.id;
        list.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: isAttached ? 'rgba(46, 107, 92, 0.10)' : 'var(--tb-bg)',
            borderLeft: '3px solid ' + (isAttached ? 'var(--tb-success)' : 'var(--tb-track-health)'),
            borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)',
            cursor: 'pointer',
          },
          onclick: () => {
            const updated = Object.assign({}, e, { episode_id: isAttached ? null : ep.id });
            upsertExam(updated);
            // Recompute derived fields so episode metadata (start date,
            // provider, facility, diagnoses) reflects the new attachment.
            recomputeEpisodeDerivedFields(ep.id);
            close();
          },
        },
          el('div', null,
            el('div', { style: { fontWeight: '600' } },
              (e.date || '?') + ' · ' + examTypeLabel(e.type)),
            el('div', { class: 'tb-card-meta' },
              (e.provider || '') +
              (e.facility ? ' · ' + e.facility : '') +
              ((e.lab_results || []).length > 0 ? ' · ' + e.lab_results.length + ' lab(s)' : '')),
          ),
          el('span', { style: { color: isAttached ? 'var(--tb-success)' : 'var(--tb-text-soft)' } },
            isAttached ? '✓ ' + t('ht.episodes.picker.attached') : '+ ' + t('ht.episodes.picker.attach')),
        ));
      }
      modal.appendChild(list);
    }
    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.episodes.picker.done')),
    ));
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  function openMedPickerForEpisode(ep) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const candidates = getMeds().filter((m) => !m.episode_id || m.episode_id === ep.id);
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '560px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; openEpisodeEditModal(ep); }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '💊 ' + t('ht.episodes.picker.meds.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.episodes.picker.meds.intro')));

    if (candidates.length === 0) {
      modal.appendChild(el('p', { class: 'tb-field-help' }, t('ht.episodes.picker.meds.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '50vh', overflowY: 'auto' } });
      for (const m of candidates) {
        const isAttached = m.episode_id === ep.id;
        list.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: isAttached ? 'rgba(46, 107, 92, 0.10)' : 'var(--tb-bg)',
            borderLeft: '3px solid ' + (isAttached ? 'var(--tb-success)' : 'var(--tb-track-health)'),
            borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)',
            cursor: 'pointer',
          },
          onclick: () => {
            const updated = Object.assign({}, m, { episode_id: isAttached ? null : ep.id });
            upsertMed(updated);
            recomputeEpisodeDerivedFields(ep.id);
            close();
          },
        },
          el('div', null,
            el('div', { style: { fontWeight: '600' } }, (m.name || '?')),
            el('div', { class: 'tb-card-meta' },
              (m.dosage ? m.dosage + (m.dosage_unit || '') : '') +
              (m.frequency ? ' · ' + m.frequency : '') +
              (m.started_date ? ' · ' + m.started_date : '')),
          ),
          el('span', { style: { color: isAttached ? 'var(--tb-success)' : 'var(--tb-text-soft)' } },
            isAttached ? '✓ ' + t('ht.episodes.picker.attached') : '+ ' + t('ht.episodes.picker.attach')),
        ));
      }
      modal.appendChild(list);
    }
    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.episodes.picker.done')),
    ));
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Invoice add/edit modal ───────────────────────────────────────
  function openInvoiceEditModal(existing, opts) {
    opts = opts || {};
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    const draft = existing ? Object.assign({}, existing) : {
      id: 'inv-' + Date.now().toString(36),
      date: new Date().toISOString().slice(0, 10),
      provider: '',
      facility: '',
      amount_native: null,
      currency: 'USD',
      amount_usd_calc: null,
      type: 'visit',
      paid: false,
      paid_date: null,
      insurance_billed: false,
      reimbursement_status: 'na',
      reimbursed_native: null,
      reimbursed_currency: 'USD',
      reimbursed_usd_calc: null,
      episode_id: opts.episode_id || null,
      exam_id: opts.exam_id || null,
      medication_id: opts.medication_id || null,
      vault_doc_id: null,
      notes: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() {
      root.innerHTML = '';
      // Return to the parent record's modal when one is set. Exam takes
      // precedence over episode — when both are linked, the user came
      // from the exam's "Linked invoices" section and expects to land
      // back there. Falls through to episode for episode-rooted opens.
      if (draft.exam_id) {
        const ex = getExams().find((e) => e.id === draft.exam_id);
        if (ex) { openExamEditModal(ex); return; }
      }
      if (draft.episode_id) {
        const ep = getEpisodes().find((e) => e.id === draft.episode_id);
        if (ep) openEpisodeEditModal(ep);
      }
    }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('button', { class: 'tb-modal-close', type: 'button', onclick: close }, '×'));
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      (isEdit ? t('ht.invoices.edit') : t('ht.invoices.add'))));

    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.invoices.field.date'),
        dateInput(draft.date, (v) => { draft.date = v; })),
      field(t('ht.invoices.field.type'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.type = e.target.value; },
      },
        ['visit', 'lab', 'procedure', 'rx', 'imaging', 'er', 'dental', 'other'].map((k) =>
          el('option', { value: k, selected: draft.type === k }, t('ht.invoices.type.' + k))),
      )),
    ));

    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.invoices.field.provider'),
        textInput(draft.provider, (v) => { draft.provider = v; })),
      field(t('ht.invoices.field.facility'),
        textInput(draft.facility, (v) => { draft.facility = v; })),
    ));

    // Amount + currency — currency pick auto-updates USD calc
    function recomputeUsdCalc() {
      if (draft.currency === 'USD') {
        draft.amount_usd_calc = draft.amount_native;
      } else if (TB.assets && typeof TB.assets.toUsd === 'function') {
        const u = TB.assets.toUsd(draft.amount_native, draft.currency);
        draft.amount_usd_calc = (u != null && isFinite(u)) ? u : null;
      }
      if (draft.reimbursed_currency === 'USD') {
        draft.reimbursed_usd_calc = draft.reimbursed_native;
      } else if (TB.assets && typeof TB.assets.toUsd === 'function') {
        const u = TB.assets.toUsd(draft.reimbursed_native, draft.reimbursed_currency);
        draft.reimbursed_usd_calc = (u != null && isFinite(u)) ? u : null;
      }
    }

    const amountInput = el('input', {
      type: 'number', step: 'any', class: 'tb-input',
      style: { fontFamily: 'var(--tb-font-mono)' },
      value: draft.amount_native != null ? draft.amount_native : '',
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        draft.amount_native = isFinite(v) ? v : null;
        recomputeUsdCalc();
        usdLabel.textContent = draft.amount_usd_calc != null && draft.currency !== 'USD'
          ? '≈ $' + Math.round(draft.amount_usd_calc).toLocaleString() : '';
      },
    });
    const currencySel = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        draft.currency = e.target.value;
        recomputeUsdCalc();
        usdLabel.textContent = draft.amount_usd_calc != null && draft.currency !== 'USD'
          ? '≈ $' + Math.round(draft.amount_usd_calc).toLocaleString() : '';
      },
    },
      ['USD', 'JPY', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF'].map((c) =>
        el('option', { value: c, selected: draft.currency === c }, c)),
    );
    const usdLabel = el('span', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)' } },
      draft.amount_usd_calc != null && draft.currency !== 'USD'
        ? '≈ $' + Math.round(draft.amount_usd_calc).toLocaleString() : '');
    modal.appendChild(field(t('ht.invoices.field.amount'),
      el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 100px', gap: 'var(--tb-sp-2)', alignItems: 'center' } },
        amountInput, currencySel),
      ''));
    modal.appendChild(el('div', { style: { textAlign: 'right', marginTop: '-12px' } }, usdLabel));

    // Paid status row
    modal.appendChild(el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap', marginTop: 'var(--tb-sp-2)' } },
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!draft.paid,
          onchange: (e) => {
            draft.paid = !!e.target.checked;
            if (draft.paid && !draft.paid_date) draft.paid_date = new Date().toISOString().slice(0, 10);
          },
        }),
        el('span', null, t('ht.invoices.field.paid')),
      ),
    ));

    // Reimbursement section
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)', fontSize: 'var(--tb-fs-14)' } },
      '🏥 ' + t('ht.invoices.reim.section')));
    modal.appendChild(field(t('ht.invoices.reim.status'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.reimbursement_status = e.target.value; },
    },
      ['na', 'pending', 'submitted', 'received', 'denied'].map((s) =>
        el('option', { value: s, selected: draft.reimbursement_status === s }, t('ht.invoices.reim.' + s))),
    ), t('ht.invoices.reim.status.help')));

    const reimAmountInput = el('input', {
      type: 'number', step: 'any', class: 'tb-input',
      style: { fontFamily: 'var(--tb-font-mono)' },
      value: draft.reimbursed_native != null ? draft.reimbursed_native : '',
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        draft.reimbursed_native = isFinite(v) ? v : null;
        recomputeUsdCalc();
      },
    });
    modal.appendChild(field(t('ht.invoices.reim.amount'), reimAmountInput,
      t('ht.invoices.reim.amount.help')));

    // Notes
    modal.appendChild(field(t('ht.invoices.field.notes'),
      textareaInput(draft.notes, (v) => { draft.notes = v; })));

    // Buttons
    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' },
    });
    if (isEdit) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          if (!deleteInvoiceWithUndo(draft.id)) return;
          close();
        },
      }, t('ht.delete')));
    } else {
      btnRow.appendChild(el('span'));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        if (draft.amount_native == null || !isFinite(draft.amount_native)) {
          alert(t('ht.invoices.field.amount.required')); return;
        }
        recomputeUsdCalc();
        draft.updated_at = new Date().toISOString();
        // If this draft came in from the AI importer (still carries
        // __pending_medications), materialize those rx records too.
        // Otherwise it's a manual edit and we just persist.
        if (Array.isArray(draft.__pending_medications) && draft.__pending_medications.length > 0) {
          saveImportedInvoiceWithMedications(draft);
        } else {
          upsertInvoice(draft);
        }
        // Recompute the parent episode's derived fields so the start
        // date / cost rollups reflect the new invoice.
        if (draft.episode_id) {
          recomputeEpisodeDerivedFields(draft.episode_id);
        }
        close();
      },
    }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Tab: Dental
  // ====================================================================

  function renderDentalTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const d = getDental();

    // ─── Header card with action buttons
    const headerCard = el('div', { class: 'tb-card', 'data-track': 'health' });
    const headRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    });
    headRow.appendChild(el('h2', { style: { marginTop: 0 } }, '🦷 ' + t('ht.dental.title')));
    const headActions = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    const medOk = TB.ai && typeof TB.ai.isFeatureAllowed === 'function'
      ? TB.ai.isFeatureAllowed('medical_vision') !== false
      : true;
    if (hasKey && medOk) {
      headActions.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openDentalVisionImportModal(),
      }, '📎 ' + t('ht.dental.upload')));
    }
    headActions.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => openDentalNoteEditModal(null),
    }, '+ ' + t('ht.dental.addEntry')));
    headRow.appendChild(headActions);
    headerCard.appendChild(headRow);
    headerCard.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.dental.intro')));
    tabHost.appendChild(headerCard);

    // ─── Tooth & Gum Status chart
    tabHost.appendChild(buildToothChartCard(d));

    // ─── Dental Providers
    tabHost.appendChild(buildDentalProvidersCard());

    // ─── Treatment History
    tabHost.appendChild(buildTreatmentHistoryCard());

    // ─── Upcoming Appointments
    tabHost.appendChild(buildDentalAppointmentsCard());

    // ─── Costs & Invoice Tracking
    tabHost.appendChild(buildDentalCostsCard());

    // ─── Dental Notes & Follow-ups
    tabHost.appendChild(buildDentalNotesCard());
  }

  // ─── Tooth chart card ──────────────────────────────────────────
  function buildToothChartCard(d) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    const head = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    });
    head.appendChild(el('h3', { style: { margin: 0 } }, '🦷 ' + t('ht.dental.chart.title')));
    head.appendChild(el('span', { class: 'tb-card-meta', style: { fontSize: '11px' } }, t('ht.dental.chart.hint')));
    card.appendChild(head);

    // SVG tooth chart — larger canvas with title cleanly above teeth
    const W = 800, H = 480;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.display = 'block';
    svg.style.marginTop = 'var(--tb-sp-2)';
    svg.style.maxHeight = '560px';

    // Title bar — sits at top with enough breathing room above arches
    const titleText = document.createElementNS(svgNS, 'text');
    titleText.setAttribute('x', W / 2);
    titleText.setAttribute('y', 20);
    titleText.setAttribute('text-anchor', 'middle');
    titleText.setAttribute('font-size', '12');
    titleText.setAttribute('fill', 'var(--tb-track-health)');
    titleText.setAttribute('font-weight', '600');
    titleText.textContent = t('ht.dental.chart.subtitle');
    svg.appendChild(titleText);

    const legendText = document.createElementNS(svgNS, 'text');
    legendText.setAttribute('x', W / 2);
    legendText.setAttribute('y', 38);
    legendText.setAttribute('text-anchor', 'middle');
    legendText.setAttribute('font-size', '9');
    legendText.setAttribute('fill', 'var(--tb-text-soft)');
    legendText.textContent = t('ht.dental.chart.legend');
    svg.appendChild(legendText);

    // Arch labels (UPPER ARCH / LOWER ARCH) — sit at the canvas edges,
    // safely outside the tooth-number rows.
    [
      { text: t('ht.dental.chart.upper'), x: 18, y: 60 },
      { text: t('ht.dental.chart.lower'), x: 18, y: 445 },
    ].forEach((lbl) => {
      const tx = document.createElementNS(svgNS, 'text');
      tx.setAttribute('x', lbl.x);
      tx.setAttribute('y', lbl.y);
      tx.setAttribute('font-size', '10');
      tx.setAttribute('fill', 'var(--tb-text-soft)');
      tx.setAttribute('font-weight', '700');
      tx.setAttribute('letter-spacing', '0.06em');
      tx.textContent = lbl.text.toUpperCase();
      svg.appendChild(tx);
    });

    // R / L labels (patient's right = viewer's left), positioned in
    // the gap between upper and lower arches near the tongue.
    [
      { text: 'R', x: 30,  y: 240, sub: t('ht.dental.chart.patientRight') },
      { text: 'L', x: 770, y: 240, sub: t('ht.dental.chart.patientLeft') },
    ].forEach((lbl) => {
      const tx = document.createElementNS(svgNS, 'text');
      tx.setAttribute('x', lbl.x);
      tx.setAttribute('y', lbl.y);
      tx.setAttribute('text-anchor', 'middle');
      tx.setAttribute('font-size', '15');
      tx.setAttribute('fill', 'var(--tb-text-soft)');
      tx.setAttribute('font-weight', '700');
      tx.textContent = lbl.text;
      svg.appendChild(tx);
      const sub = document.createElementNS(svgNS, 'text');
      sub.setAttribute('x', lbl.x);
      sub.setAttribute('y', lbl.y + 14);
      sub.setAttribute('text-anchor', 'middle');
      sub.setAttribute('font-size', '8');
      sub.setAttribute('fill', 'var(--tb-text-soft)');
      sub.textContent = lbl.sub;
      svg.appendChild(sub);
    });

    // Tongue indicator — sits between the two arches at canvas center
    const tongue = document.createElementNS(svgNS, 'ellipse');
    tongue.setAttribute('cx', W / 2);
    tongue.setAttribute('cy', 235);
    tongue.setAttribute('rx', 65);
    tongue.setAttribute('ry', 30);
    tongue.setAttribute('fill', 'rgba(220, 170, 170, 0.18)');
    svg.appendChild(tongue);
    const tongueLabel = document.createElementNS(svgNS, 'text');
    tongueLabel.setAttribute('x', W / 2);
    tongueLabel.setAttribute('y', 240);
    tongueLabel.setAttribute('text-anchor', 'middle');
    tongueLabel.setAttribute('font-size', '10');
    tongueLabel.setAttribute('fill', 'var(--tb-text-soft)');
    tongueLabel.setAttribute('font-style', 'italic');
    tongueLabel.textContent = t('ht.dental.chart.tongue');
    svg.appendChild(tongueLabel);

    // Render each tooth
    for (const layout of TOOTH_LAYOUT) {
      const tooth = getDentalTooth(layout.uni);
      const status = TOOTH_STATUS[tooth.status] || TOOTH_STATUS.natural;

      // Halo: gum (pink), pocket (yellow), bleeding (red)
      if (tooth.has_bleeding || tooth.has_pocket || tooth.status !== 'missing') {
        const halo = document.createElementNS(svgNS, 'circle');
        halo.setAttribute('cx', layout.x);
        halo.setAttribute('cy', layout.y);
        halo.setAttribute('r', 22);
        if (tooth.has_bleeding) {
          halo.setAttribute('fill', 'rgba(239, 68, 68, 0.18)');
        } else if (tooth.has_pocket) {
          halo.setAttribute('fill', 'rgba(245, 158, 11, 0.18)');
        } else {
          halo.setAttribute('fill', 'rgba(244, 196, 196, 0.18)');
        }
        svg.appendChild(halo);
      }

      // Tooth body — square with rounded corners + status color
      const group = document.createElementNS(svgNS, 'g');
      group.style.cursor = 'pointer';
      group.addEventListener('click', () => openToothEditModal(layout.uni));
      const rect = document.createElementNS(svgNS, 'rect');
      const isMissing = tooth.status === 'missing';
      // Outline color shifts when the tooth has a clinical alert flag:
      // red border for cavity or treatment-needed, orange for observation.
      let outlineColor = status.border;
      let outlineWidth = 1.5;
      if (tooth.has_cavity || tooth.needs_treatment) {
        outlineColor = 'var(--tb-error)';
        outlineWidth = 2.5;
      } else if (tooth.needs_observation) {
        outlineColor = '#f59e0b';
        outlineWidth = 2.5;
      }
      rect.setAttribute('x', layout.x - 14);
      rect.setAttribute('y', layout.y - 14);
      rect.setAttribute('width', 28);
      rect.setAttribute('height', 28);
      rect.setAttribute('rx', 5);
      rect.setAttribute('fill', isMissing ? 'transparent' : status.color);
      rect.setAttribute('stroke', outlineColor);
      rect.setAttribute('stroke-width', outlineWidth);
      rect.setAttribute('stroke-dasharray', isMissing ? '3,2' : '');
      group.appendChild(rect);
      // Small red dot inside the tooth for cavity (separate from
      // needs-treatment so caries vs. planned-restoration are
      // distinguishable at a glance).
      if (tooth.has_cavity) {
        const cavityDot = document.createElementNS(svgNS, 'circle');
        cavityDot.setAttribute('cx', layout.x + 8);
        cavityDot.setAttribute('cy', layout.y - 8);
        cavityDot.setAttribute('r', 3);
        cavityDot.setAttribute('fill', 'var(--tb-error)');
        cavityDot.setAttribute('stroke', 'white');
        cavityDot.setAttribute('stroke-width', '1');
        group.appendChild(cavityDot);
      }
      // Hover-to-grow effect via title (native SVG tooltip)
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = '#' + layout.uni + ' (FDI ' + layout.fdi + ') · ' + (lang === 'ja' ? status.label_jp : status.label_en);
      group.appendChild(title);
      svg.appendChild(group);

      // Number label — Universal (bold) + FDI (parens) above tooth
      const labelOffset = layout.arch === 'upper' ? -22 : 26;
      const uniText = document.createElementNS(svgNS, 'text');
      uniText.setAttribute('x', layout.x);
      uniText.setAttribute('y', layout.y + labelOffset);
      uniText.setAttribute('text-anchor', 'middle');
      uniText.setAttribute('font-size', '10');
      uniText.setAttribute('font-weight', '600');
      uniText.setAttribute('fill', 'var(--tb-text)');
      uniText.textContent = String(layout.uni);
      svg.appendChild(uniText);
      const fdiText = document.createElementNS(svgNS, 'text');
      fdiText.setAttribute('x', layout.x);
      fdiText.setAttribute('y', layout.y + labelOffset + 10);
      fdiText.setAttribute('text-anchor', 'middle');
      fdiText.setAttribute('font-size', '8');
      fdiText.setAttribute('fill', 'var(--tb-text-soft)');
      fdiText.textContent = '(' + layout.fdi + ')';
      svg.appendChild(fdiText);
    }

    card.appendChild(svg);

    // Counts row + cavity/treatment/observation counters
    let natural = 0, fillings = 0, crowns = 0, missing = 0, other = 0;
    let cavities = 0, needTreatment = 0, needObservation = 0;
    for (const layout of TOOTH_LAYOUT) {
      const tt = getDentalTooth(layout.uni);
      if (tt.status === 'natural') natural++;
      else if (tt.status === 'filling') fillings++;
      else if (tt.status === 'crown') crowns++;
      else if (tt.status === 'missing') missing++;
      else other++;
      if (tt.has_cavity) cavities++;
      if (tt.needs_treatment) needTreatment++;
      if (tt.needs_observation) needObservation++;
    }

    // Treatment-status counter row (shows even when all zero — that's
    // useful info itself, "0 cavities" is reassuring).
    const txCountsRow = el('div', {
      style: {
        display: 'flex', justifyContent: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2)',
        borderTop: '1px solid var(--tb-border)', fontSize: 'var(--tb-fs-12)',
      },
    });
    function txBadge(label, count, color) {
      const isClean = count === 0;
      return el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '4px 12px', borderRadius: 'var(--tb-radius-pill)',
          background: isClean ? 'rgba(34, 139, 34, 0.10)' : color + '22',
          color: isClean ? 'var(--tb-success)' : color,
          fontWeight: '600',
        },
      },
        el('span', { style: { fontSize: '13px' } }, isClean ? '✓' : '⚠'),
        el('span', null, label + ': '),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } }, String(count)),
      );
    }
    txCountsRow.appendChild(txBadge(t('ht.dental.chart.cavities'), cavities, 'var(--tb-error)'));
    txCountsRow.appendChild(txBadge(t('ht.dental.chart.needTreatment'), needTreatment, 'var(--tb-warn)'));
    txCountsRow.appendChild(txBadge(t('ht.dental.chart.needObservation'), needObservation, 'var(--tb-warn)'));
    card.appendChild(txCountsRow);
    const countsRow = el('div', {
      style: { display: 'flex', justifyContent: 'center', gap: 'var(--tb-sp-4)', flexWrap: 'wrap',
        marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2)',
        borderTop: '1px solid var(--tb-border)', fontSize: 'var(--tb-fs-12)' },
    });
    function countCell(swatch, value, label, swatchProps) {
      const cell = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
      const sq = el('span', {
        style: Object.assign({
          width: '14px', height: '14px', borderRadius: '3px',
          display: 'inline-block', flexShrink: '0',
        }, swatchProps || {}),
      });
      cell.appendChild(sq);
      cell.appendChild(el('div', null,
        el('span', { style: { fontWeight: '600', marginRight: '4px' } }, label),
        el('span', { class: 'tb-card-meta' }, value + ' ' + t('ht.dental.chart.teeth')),
      ));
      return cell;
    }
    countsRow.appendChild(countCell(null, natural, t('ht.dental.chart.natural'),
      { background: 'transparent', border: '1.5px solid var(--tb-text-soft)' }));
    countsRow.appendChild(countCell(null, fillings, t('ht.dental.chart.filling'),
      { background: TOOTH_STATUS.filling.color }));
    countsRow.appendChild(countCell(null, crowns, t('ht.dental.chart.crown'),
      { background: TOOTH_STATUS.crown.color }));
    countsRow.appendChild(countCell(null, missing, t('ht.dental.chart.missing'),
      { background: 'transparent', border: '1.5px dashed var(--tb-text-soft)' }));
    card.appendChild(countsRow);

    // Periodontal stats — auto-computed from teeth
    const perio = d.periodontal || {};

    // ─── Pocket depth distribution stacked bar (v0.53)
    // Shows the breakdown of all probed sites by depth: healthy (1-3mm),
    // mild (4-6mm), severe (7+mm). When the data is present, this replaces
    // the abstract "% pockets 4mm+" with a fuller picture.
    if (perio.pocket_dist_healthy_pct != null ||
        perio.pocket_dist_mild_pct != null ||
        perio.pocket_dist_severe_pct != null) {
      const distContainer = el('div', {
        style: { marginTop: 'var(--tb-sp-3)', paddingTop: 'var(--tb-sp-2)',
          borderTop: '1px solid var(--tb-border)' },
      });
      distContainer.appendChild(el('div', {
        style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--tb-text-soft)',
          marginBottom: '6px' },
      }, t('ht.dental.perio.distribution.title')));
      distContainer.appendChild(el('div', {
        class: 'tb-card-meta',
        style: { fontSize: '11px', marginBottom: '8px' },
      }, t('ht.dental.perio.distribution.intro')));

      const healthy = perio.pocket_dist_healthy_pct || 0;
      const mild = perio.pocket_dist_mild_pct || 0;
      const severe = perio.pocket_dist_severe_pct || 0;
      const total = healthy + mild + severe || 100;

      const barWrap = el('div', {
        style: { display: 'flex', height: '24px', borderRadius: 'var(--tb-radius-1)',
          overflow: 'hidden', border: '1px solid var(--tb-border)' },
      });
      const segments = [
        { value: healthy, color: '#7dd3c0', label: t('ht.dental.perio.distribution.healthy'), key: '1-3 mm' },
        { value: mild, color: '#f59e0b', label: t('ht.dental.perio.distribution.mild'), key: '4-6 mm' },
        { value: severe, color: '#ef4444', label: t('ht.dental.perio.distribution.severe'), key: '7+ mm' },
      ];
      for (const seg of segments) {
        if (seg.value <= 0) continue;
        const pct = (seg.value / total) * 100;
        const segEl = el('div', {
          style: {
            flex: pct.toFixed(2),
            background: seg.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontSize: '11px', fontWeight: '600',
            minWidth: '0',
          },
          title: seg.label + ' (' + seg.key + '): ' + seg.value + '%',
        }, pct >= 8 ? seg.value + '%' : '');
        barWrap.appendChild(segEl);
      }
      distContainer.appendChild(barWrap);

      // Legend row below bar
      const legendRow = el('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-3)',
          marginTop: '6px', fontSize: '11px' },
      });
      for (const seg of segments) {
        legendRow.appendChild(el('div', {
          style: { display: 'flex', alignItems: 'center', gap: '6px' },
        },
          el('span', {
            style: { width: '12px', height: '12px', background: seg.color,
              borderRadius: '3px', display: 'inline-block' },
          }),
          el('span', null, seg.label, ' '),
          el('span', { style: { fontWeight: '600', fontFamily: 'var(--tb-font-mono)' } },
            (seg.value || 0).toFixed(1) + '%'),
          el('span', { class: 'tb-card-meta', style: { fontSize: '10px' } }, ' (' + seg.key + ')'),
        ));
      }
      distContainer.appendChild(legendRow);
      card.appendChild(distContainer);
    }

    // ─── Periodontal stats — three big numbers + trend sparklines
    const statsRow = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--tb-sp-3)',
        marginTop: 'var(--tb-sp-3)', paddingTop: 'var(--tb-sp-2)', borderTop: '1px solid var(--tb-border)' },
    });
    function statCell(label, value, target, isPct, trendSeries) {
      const tile = el('div', { style: { textAlign: 'center' } });
      tile.appendChild(el('div', {
        style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)' },
      }, label));
      const numColor = value == null ? 'var(--tb-text-soft)'
                     : isPct && value > target ? 'var(--tb-error)'
                     : !isPct && value > 0 ? 'var(--tb-warn)'
                     : 'var(--tb-success)';
      tile.appendChild(el('div', {
        style: { fontSize: '20px', fontWeight: '700', fontFamily: 'var(--tb-font-mono)', color: numColor },
      }, value == null ? '—' : (isPct ? value + '%' : String(value))));
      if (isPct && target != null) {
        tile.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } },
          t('ht.dental.perio.target', { v: target })));
      }
      // Trend sparkline (only when ≥2 historical data points)
      if (Array.isArray(trendSeries) && trendSeries.length >= 2) {
        tile.appendChild(buildSparkline(trendSeries, { title: label }));
      }
      return tile;
    }
    // Build trend series from notes_log periodontal_snapshots
    const perioHistory = getDentalNotesLog()
      .filter((n) => n.periodontal_snapshot && n.date)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    function trendFor(key, target) {
      const out = [];
      for (const n of perioHistory) {
        const snap = n.periodontal_snapshot || {};
        if (typeof snap[key] !== 'number') continue;
        out.push({
          date: n.date,
          value: snap[key],
          flag: target != null && snap[key] > target ? 'high' : 'normal',
        });
      }
      return out;
    }
    statsRow.appendChild(statCell(t('ht.dental.perio.pockets'),
      perio.pockets_4mm_pct, perio.target_pocket_pct || 10, true,
      trendFor('pockets_4mm_pct', perio.target_pocket_pct || 10)));
    statsRow.appendChild(statCell(t('ht.dental.perio.bop'),
      perio.bleeding_on_probing_pct, perio.target_bop_pct || 10, true,
      trendFor('bleeding_on_probing_pct', perio.target_bop_pct || 10)));
    statsRow.appendChild(statCell(t('ht.dental.perio.mobile'),
      perio.mobile_teeth || 0, null, false,
      trendFor('mobile_teeth', null)));
    card.appendChild(statsRow);

    return card;
  }

  // ─── Single-tooth edit modal ──────────────────────────────────
  function openToothEditModal(uni) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const layout = TOOTH_LAYOUT.find((x) => x.uni === uni);
    const tooth = JSON.parse(JSON.stringify(getDentalTooth(uni)));

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '480px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      '🦷 ' + t('ht.dental.tooth.title', { uni, fdi: layout ? layout.fdi : '' })));

    modal.appendChild(field(t('ht.dental.tooth.status'), el('select', {
      class: 'tb-select',
      onchange: (e) => { tooth.status = e.target.value; },
    },
      TOOTH_STATUS_ORDER.map((s) => el('option', { value: s, selected: tooth.status === s },
        lang === 'ja' ? TOOTH_STATUS[s].label_jp : TOOTH_STATUS[s].label_en)),
    )));

    // Periodontal flags
    modal.appendChild(el('h3', { style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-2)', marginBottom: '4px',
      color: 'var(--tb-text-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' } },
      t('ht.dental.tooth.section.perio')));
    modal.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!tooth.has_pocket,
          onchange: (e) => { tooth.has_pocket = !!e.target.checked; },
        }),
        el('span', null, t('ht.dental.tooth.pocket')),
      ),
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!tooth.has_bleeding,
          onchange: (e) => { tooth.has_bleeding = !!e.target.checked; },
        }),
        el('span', null, t('ht.dental.tooth.bleeding')),
      ),
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!tooth.is_mobile,
          onchange: (e) => { tooth.is_mobile = !!e.target.checked; },
        }),
        el('span', null, t('ht.dental.tooth.mobile')),
      ),
    ));

    // Clinical alert flags (cavity / treatment / observation)
    modal.appendChild(el('h3', { style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-3)', marginBottom: '4px',
      color: 'var(--tb-text-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' } },
      t('ht.dental.tooth.section.alerts')));
    modal.appendChild(el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!tooth.has_cavity,
          onchange: (e) => { tooth.has_cavity = !!e.target.checked; },
        }),
        el('span', null, '🔴 ' + t('ht.dental.tooth.cavity')),
      ),
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!tooth.needs_treatment,
          onchange: (e) => { tooth.needs_treatment = !!e.target.checked; },
        }),
        el('span', null, '⚠ ' + t('ht.dental.tooth.needsTreatment')),
      ),
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        el('input', {
          type: 'checkbox', checked: !!tooth.needs_observation,
          onchange: (e) => { tooth.needs_observation = !!e.target.checked; },
        }),
        el('span', null, '👁 ' + t('ht.dental.tooth.needsObservation')),
      ),
    ));

    modal.appendChild(field(t('ht.dental.tooth.pocketDepth'),
      numInput(tooth.pocket_max_mm, (v) => { tooth.pocket_max_mm = v; }),
      t('ht.dental.tooth.pocketDepth.help')));

    modal.appendChild(field(t('ht.dental.tooth.notes'),
      textareaInput(tooth.notes, (v) => { tooth.notes = v; })));

    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' },
    });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    btnRow.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        setDentalTooth(uni, tooth);
        close();
        rerender();
      },
    }, t('ht.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Dental Providers card ────────────────────────────────────
  function buildDentalProvidersCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h3', { style: { margin: 0 } }, '🏥 ' + t('ht.dental.providers.title')));
    const providers = getDentalProviders();
    if (providers.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-1)' } }, t('ht.dental.providers.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' } });
      for (const p of providers) {
        const row = el('div', {
          style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
            borderRadius: 'var(--tb-radius-1)', display: 'flex', justifyContent: 'space-between',
            alignItems: 'flex-start', gap: 'var(--tb-sp-2)' },
        });
        const main = el('div', { style: { flex: '1', minWidth: '0' } });
        main.appendChild(el('div', { style: { fontWeight: '600' } },
          (p.name_en || p.name_jp || '?') + (p.type ? ' (' + p.type + ')' : '')));
        if (p.name_en && p.name_jp) {
          main.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px' } },
            p.name_jp + ' · ' + p.name_en));
        }
        const subParts = [];
        if (p.address) subParts.push(p.address);
        if (p.phone) {
          // Click-to-call link
          const tel = String(p.phone).replace(/[^\d+]/g, '');
          subParts.push(el('a', { href: 'tel:' + tel, style: { color: 'inherit' } }, p.phone));
        }
        if (subParts.length > 0) {
          const meta = el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '4px' } });
          subParts.forEach((part, i) => {
            if (i > 0) meta.appendChild(el('span', null, ' · '));
            if (typeof part === 'string') meta.appendChild(el('span', null, part));
            else meta.appendChild(part);
          });
          main.appendChild(meta);
        }
        // Website (clickable) + hours on a second meta line
        const onlineBits = [];
        if (p.website) {
          const url = /^https?:\/\//.test(p.website) ? p.website : ('https://' + p.website);
          onlineBits.push(el('a', {
            href: url, target: '_blank', rel: 'noopener noreferrer',
            style: { color: 'var(--tb-track-health)' },
          }, '🌐 ' + p.website));
        }
        if (p.hours) onlineBits.push(el('span', null, '🕒 ' + p.hours));
        if (onlineBits.length > 0) {
          const onlineRow = el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '4px', display: 'flex', gap: '8px', flexWrap: 'wrap' } });
          for (const ob of onlineBits) onlineRow.appendChild(ob);
          main.appendChild(onlineRow);
        }
        // AI-enriched indicator
        if (p.ai_enriched_at) {
          main.appendChild(el('div', {
            class: 'tb-card-meta',
            style: { fontSize: '10px', marginTop: '2px', color: 'var(--tb-track-ai)', fontStyle: 'italic' },
          }, '✨ ' + t('ht.dental.providers.aiEnriched', { date: p.ai_enriched_at.slice(0, 10) })));
        }
        row.appendChild(main);
        const actions = el('div', { style: { display: 'flex', gap: '4px', flexShrink: '0', flexWrap: 'wrap' } });
        const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
        if (hasKey) {
          // ✨ Quick Enhance — fills missing fields in place without opening modal
          actions.appendChild(el('button', {
            class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', fontSize: '11px', color: 'var(--tb-track-ai)' },
            title: t('ht.dental.providers.enhance.help'),
            onclick: async (e) => {
              const btn = e.target;
              btn.disabled = true;
              btn.textContent = '⏳';
              try {
                const result = await TB.ai.callClaudeForProviderEnrichment({
                  name_en: p.name_en, name_jp: p.name_jp, type: p.type,
                  address: p.address, phone: p.phone,
                });
                const en = result.extracted || {};
                if (!p.name_en && en.name_en) p.name_en = en.name_en;
                if (!p.name_jp && en.name_jp) p.name_jp = en.name_jp;
                if (!p.address && en.address) p.address = en.address;
                if (!p.phone && en.phone) p.phone = en.phone;
                if (!p.website && en.website) p.website = en.website;
                if (!p.hours && en.hours) p.hours = en.hours;
                if (en.specialties || en.notes) {
                  const extra = ['Enhanced by AI'];
                  if (en.specialties) extra.push('Specialties: ' + en.specialties);
                  if (en.notes) extra.push(en.notes);
                  const cur = (p.notes || '').trim();
                  p.notes = cur ? cur + '\n\n— ' + extra.join('\n') : extra.join('\n');
                }
                p.ai_enriched_at = new Date().toISOString();
                upsertDentalProvider(p);
                rerender();
              } catch (err) {
                btn.disabled = false;
                btn.textContent = '✨';
                alert('AI enhance failed: ' + (err.message || err));
              }
            },
          }, '✨'));
        }
        actions.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '0 6px', fontSize: '12px' },
          onclick: () => openDentalProviderEditModal(p),
        }, '✎'));
        actions.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '0 6px', fontSize: '12px', color: 'var(--tb-error)' },
          onclick: () => { if (deleteDentalProviderWithUndo(p.id)) rerender(); },
        }, '×'));
        row.appendChild(actions);
        list.appendChild(row);
      }
      card.appendChild(list);
    }
    card.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-2)' },
      onclick: () => openDentalProviderEditModal(null),
    }, '+ ' + t('ht.dental.providers.add')));
    return card;
  }

  function openDentalProviderEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('dp-' + Date.now().toString(36)),
      name_en: '', name_jp: '', type: '',
      address: '', phone: '', email: '',
      website: '', hours: '',
      notes: '',
      created_at: new Date().toISOString(),
    };
    // Ensure new optional fields exist for legacy entries
    if (typeof draft.website !== 'string') draft.website = '';
    if (typeof draft.hours !== 'string') draft.hours = '';
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '560px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isEdit ? t('ht.dental.providers.editTitle') : t('ht.dental.providers.addTitle')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.providers.nameEn'), textInput(draft.name_en, (v) => draft.name_en = v)),
      field(t('ht.dental.providers.nameJp'), textInput(draft.name_jp, (v) => draft.name_jp = v)),
    ));
    modal.appendChild(field(t('ht.dental.providers.type'), textInput(draft.type, (v) => draft.type = v),
      t('ht.dental.providers.type.help')));
    modal.appendChild(field(t('ht.dental.providers.address'), textareaInput(draft.address, (v) => draft.address = v)));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.providers.phone'), textInput(draft.phone, (v) => draft.phone = v)),
      field(t('ht.dental.providers.email'), textInput(draft.email, (v) => draft.email = v)),
    ));
    // Inputs we need a ref to for the Enhance button to update live
    const websiteInput = textInput(draft.website, (v) => draft.website = v);
    const hoursInput = textareaInput(draft.hours, (v) => draft.hours = v);
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.providers.website'), websiteInput),
      field(t('ht.dental.providers.hours'), hoursInput),
    ));
    modal.appendChild(field(t('ht.dental.providers.notes'), textareaInput(draft.notes, (v) => draft.notes = v)));

    // ✨ Enhance with AI button — fills in missing fields from public
    // knowledge (Claude's training data). Sends ONLY the clinic name +
    // type to the API; never PHI.
    const enhanceStatus = el('div', {
      style: { fontSize: '11px', color: 'var(--tb-text-soft)', marginTop: 'var(--tb-sp-1)' },
    });
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (hasKey && (draft.name_en || draft.name_jp)) {
      modal.appendChild(el('div', {
        style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'rgba(46, 107, 92, 0.06)',
          borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-3)',
          flexWrap: 'wrap',
        },
      },
        el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          style: { fontSize: '11px' },
          onclick: async (e) => {
            const btn = e.target;
            btn.disabled = true;
            enhanceStatus.textContent = '⏳ ' + t('ht.dental.providers.enhance.processing');
            try {
              const result = await TB.ai.callClaudeForProviderEnrichment({
                name_en: draft.name_en,
                name_jp: draft.name_jp,
                type: draft.type,
                address: draft.address,
                phone: draft.phone,
              });
              const en = result.extracted || {};
              const filled = [];
              // Fill ONLY blank fields — never overwrite user-entered data
              if (!draft.name_en && en.name_en) { draft.name_en = en.name_en; filled.push('name_en'); }
              if (!draft.name_jp && en.name_jp) { draft.name_jp = en.name_jp; filled.push('name_jp'); }
              if (!draft.address && en.address) { draft.address = en.address; filled.push('address'); }
              if (!draft.phone && en.phone) { draft.phone = en.phone; filled.push('phone'); }
              if (!draft.website && en.website) { draft.website = en.website; filled.push('website'); websiteInput.value = en.website; }
              if (!draft.hours && en.hours) { draft.hours = en.hours; filled.push('hours'); hoursInput.value = en.hours; }
              // Append specialties + notes
              if (en.specialties || en.notes) {
                const extra = ['Enhanced by AI'];
                if (en.specialties) extra.push('Specialties: ' + en.specialties);
                if (en.notes) extra.push(en.notes);
                const cur = (draft.notes || '').trim();
                draft.notes = cur ? cur + '\n\n— ' + extra.join('\n') : extra.join('\n');
                filled.push('notes');
              }
              const cost = (result.cost_usd || 0).toFixed(4);
              if (filled.length === 0) {
                enhanceStatus.textContent = '⚠ ' + t('ht.dental.providers.enhance.nothing') + ' · $' + cost;
                enhanceStatus.style.color = 'var(--tb-warn)';
              } else if (en.confidence === 'unknown' || en.confidence === 'low') {
                enhanceStatus.textContent = '⚠ ' + t('ht.dental.providers.enhance.lowConf', { confidence: en.confidence }) + ' · $' + cost;
                enhanceStatus.style.color = 'var(--tb-warn)';
              } else {
                enhanceStatus.textContent = '✓ ' + t('ht.dental.providers.enhance.done', { n: filled.length, cost });
                enhanceStatus.style.color = 'var(--tb-success)';
              }
              // Re-render the modal in place to reflect updates
              draft.ai_enriched_at = new Date().toISOString();
              upsertDentalProvider(draft);
              setTimeout(() => { close(); openDentalProviderEditModal(draft); }, 800);
            } catch (err) {
              enhanceStatus.textContent = '✗ ' + (err.message || err);
              enhanceStatus.style.color = 'var(--tb-error)';
              btn.disabled = false;
            }
          },
        }, '✨ ' + t('ht.dental.providers.enhance')),
        el('span', { class: 'tb-card-meta', style: { fontSize: '11px', flex: '1', minWidth: '200px' } },
          t('ht.dental.providers.enhance.help')),
        enhanceStatus,
      ));
    }

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' } });
    if (isEdit) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => { if (deleteDentalProviderWithUndo(draft.id)) { close(); rerender(); } } },
        t('ht.delete')));
    } else btnRow.appendChild(el('span'));
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { upsertDentalProvider(draft); close(); rerender(); } }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Treatment History card ───────────────────────────────────
  function buildTreatmentHistoryCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });

    // Header + filter + Add Procedure
    const headRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } });
    const titleArea = el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    titleArea.appendChild(el('h3', { style: { margin: 0 } }, '📋 ' + t('ht.dental.tx.title')));

    // Year filter — All Time + each year present in the data
    const yearFilter = getDental()._tx_year_filter || 'all';
    const years = new Set();
    for (const p of getDentalProcedures()) {
      if (p.date) years.add(p.date.slice(0, 4));
    }
    const yearList = ['all'].concat(Array.from(years).sort().reverse());
    for (const y of yearList) {
      titleArea.appendChild(el('button', {
        class: 'tb-btn ' + (yearFilter === y ? 'tb-btn--secondary' : 'tb-btn--ghost'),
        type: 'button',
        style: { fontSize: '11px', padding: '2px 10px' },
        onclick: () => {
          const d = getDental();
          d._tx_year_filter = y;
          setDental(d);
          rerender();
        },
      }, y === 'all' ? t('ht.dental.tx.allTime') : y));
    }
    headRow.appendChild(titleArea);
    headRow.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => openDentalProcedureEditModal(null),
    }, '+ ' + t('ht.dental.tx.add')));
    card.appendChild(headRow);

    // Latest recommendations callout (from the latest note in notes_log)
    const notes = getDentalNotesLog();
    const latestNote = notes.length > 0 ? notes[0] : null;
    if (latestNote && latestNote.recommendations) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'rgba(245, 158, 11, 0.10)',
          borderLeft: '3px solid var(--tb-warn)',
          borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)',
          fontSize: 'var(--tb-fs-12)',
        },
      },
        el('strong', null, t('ht.dental.tx.recommendations') + ': '),
        el('span', { style: { whiteSpace: 'pre-wrap' } }, latestNote.recommendations),
      ));
    }

    // Procedures list — filtered by year
    const procs = getDentalProcedures().filter((p) => {
      if (yearFilter === 'all') return true;
      return p.date && p.date.startsWith(yearFilter);
    });
    if (procs.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('ht.dental.tx.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-1)', marginTop: 'var(--tb-sp-2)' } });
      for (const p of procs) list.appendChild(buildDentalProcRow(p));
      card.appendChild(list);
    }

    return card;
  }

  function buildDentalProcRow(p) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const providers = getDentalProviders();
    const prov = p.provider_id ? providers.find((x) => x.id === p.provider_id) : null;

    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderLeft: '3px solid var(--tb-warn)',
        borderRadius: 'var(--tb-radius-1)',
        display: 'flex', justifyContent: 'space-between', gap: 'var(--tb-sp-2)',
      },
    });
    const main = el('div', { style: { flex: '1', minWidth: '0' } });
    const titleRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } });
    titleRow.appendChild(el('span', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', fontSize: '11px' } }, p.date || '?'));
    titleRow.appendChild(el('span', { style: { fontWeight: '600', color: 'var(--tb-warn)' } }, p.name_en || p.name_jp || '?'));
    if (p.name_en && p.name_jp) {
      titleRow.appendChild(el('span', { class: 'tb-card-meta', style: { fontSize: '11px' } }, '(' + p.name_jp + ')'));
    }
    if (p.invoice_id) {
      titleRow.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.10)', color: 'var(--tb-track-ai)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '🧾 ' + t('ht.dental.tx.invoiceTag')));
    }
    main.appendChild(titleRow);
    const sub = [];
    if (prov) sub.push(prov.name_en || prov.name_jp || '');
    if (p.cost != null) {
      const currency = p.currency || 'JPY';
      const sym = ({ USD: '$', JPY: '¥', EUR: '€', GBP: '£' })[currency] || (currency + ' ');
      const fmtCost = currency === 'JPY' ? Math.round(p.cost).toLocaleString() :
        Number(p.cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      sub.push(sym + fmtCost);
    }
    if (p.points != null) sub.push(p.points + ' pts');
    if (p.qty != null && p.qty > 1) sub.push('qty ' + p.qty);
    main.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '2px' } },
      sub.join(' · ')));
    if (p.code) {
      main.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '2px', fontFamily: 'var(--tb-font-mono)' } },
        t('ht.dental.tx.code') + ': ' + p.code));
    }
    if (p.tooth_numbers && p.tooth_numbers.length > 0) {
      main.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '2px' } },
        t('ht.dental.tx.teeth') + ': ' + p.tooth_numbers.join(', ')));
    }
    if (p.notes) {
      main.appendChild(el('div', { style: { marginTop: '4px', fontSize: 'var(--tb-fs-12)', whiteSpace: 'pre-wrap' } }, p.notes));
    }
    row.appendChild(main);
    row.appendChild(el('div', { style: { display: 'flex', gap: '4px' } },
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '0 6px', fontSize: '12px' },
        onclick: () => openDentalProcedureEditModal(p) }, '✎'),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '0 6px', fontSize: '12px', color: 'var(--tb-error)' },
        onclick: () => { if (deleteDentalProcedureWithUndo(p.id)) rerender(); } }, '×'),
    ));
    return row;
  }

  function openDentalProcedureEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('proc-' + Date.now().toString(36)),
      date: new Date().toISOString().slice(0, 10),
      name_en: '', name_jp: '', code: '',
      cost: null, currency: 'JPY', points: null, qty: 1,
      provider_id: null, invoice_id: null,
      tooth_numbers: [], notes: '',
    };
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isEdit ? t('ht.dental.tx.editTitle') : t('ht.dental.tx.addTitle')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.tx.field.date'), dateInput(draft.date, (v) => draft.date = v)),
      field(t('ht.dental.tx.field.code'), textInput(draft.code, (v) => draft.code = v),
        t('ht.dental.tx.field.code.help')),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.tx.field.nameEn'), textInput(draft.name_en, (v) => draft.name_en = v)),
      field(t('ht.dental.tx.field.nameJp'), textInput(draft.name_jp, (v) => draft.name_jp = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 100px 1fr 80px', gap: 'var(--tb-sp-2)' } },
      field(t('ht.dental.tx.field.cost'), numInput(draft.cost, (v) => draft.cost = v)),
      field(t('ht.dental.tx.field.currency'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.currency = e.target.value; },
      }, ['JPY', 'USD', 'EUR', 'GBP'].map((c) =>
        el('option', { value: c, selected: draft.currency === c }, c)))),
      field(t('ht.dental.tx.field.points'), numInput(draft.points, (v) => draft.points = v),
        t('ht.dental.tx.field.points.help')),
      field(t('ht.dental.tx.field.qty'), numInput(draft.qty, (v) => draft.qty = v)),
    ));
    // Provider select
    const providers = getDentalProviders();
    modal.appendChild(field(t('ht.dental.tx.field.provider'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.provider_id = e.target.value || null; },
    },
      el('option', { value: '', selected: !draft.provider_id }, '— ' + t('ht.dental.tx.field.provider.none') + ' —'),
      ...providers.map((p) => el('option', { value: p.id, selected: draft.provider_id === p.id },
        p.name_en || p.name_jp || '?')),
    )));
    // Tooth numbers
    modal.appendChild(field(t('ht.dental.tx.field.teeth'),
      textInput((draft.tooth_numbers || []).join(', '), (v) => {
        draft.tooth_numbers = v.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
      }),
      t('ht.dental.tx.field.teeth.help')));
    modal.appendChild(field(t('ht.dental.tx.field.notes'), textareaInput(draft.notes, (v) => draft.notes = v)));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' } });
    if (isEdit) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => { if (deleteDentalProcedureWithUndo(draft.id)) { close(); rerender(); } } },
        t('ht.delete')));
    } else btnRow.appendChild(el('span'));
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { upsertDentalProcedure(draft); close(); rerender(); } }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Upcoming Appointments card ───────────────────────────────
  function buildDentalAppointmentsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h3', { style: { margin: 0 } }, '📅 ' + t('ht.dental.appts.title')));
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = getDentalAppointments().filter((a) => !a.date || a.date >= today);
    if (upcoming.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help', style: { textAlign: 'center', marginTop: 'var(--tb-sp-2)' } },
        t('ht.dental.appts.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: 'var(--tb-sp-2)' } });
      const providers = getDentalProviders();
      for (const a of upcoming) {
        const prov = a.provider_id ? providers.find((x) => x.id === a.provider_id) : null;
        list.appendChild(el('div', {
          style: { padding: 'var(--tb-sp-1) var(--tb-sp-3)', background: 'var(--tb-bg)',
            borderRadius: 'var(--tb-radius-1)', display: 'flex', justifyContent: 'space-between', gap: 'var(--tb-sp-2)' },
        },
          el('span', null,
            (a.date || '?') + (a.time ? ' ' + a.time : '') +
            (prov ? ' · ' + (prov.name_en || prov.name_jp || '?') : '') +
            (a.purpose ? ' — ' + a.purpose : '')),
          el('button', {
            class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '0 6px', fontSize: '12px', color: 'var(--tb-error)' },
            onclick: () => {
              if (!confirm(t('ht.dental.appts.delete.confirm'))) return;
              deleteDentalAppointment(a.id);
              rerender();
            },
          }, '×'),
        ));
      }
      card.appendChild(list);
    }
    card.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-2)' },
      onclick: () => openDentalAppointmentModal(),
    }, '+ ' + t('ht.dental.appts.add')));
    return card;
  }

  function openDentalAppointmentModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = {
      id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('apt-' + Date.now().toString(36)),
      date: new Date().toISOString().slice(0, 10),
      time: '',
      provider_id: null,
      purpose: '',
      notes: '',
    };
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '480px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '📅 ' + t('ht.dental.appts.addTitle')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.appts.field.date'), dateInput(draft.date, (v) => draft.date = v)),
      field(t('ht.dental.appts.field.time'), textInput(draft.time, (v) => draft.time = v),
        t('ht.dental.appts.field.time.help')),
    ));
    const providers = getDentalProviders();
    modal.appendChild(field(t('ht.dental.appts.field.provider'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.provider_id = e.target.value || null; },
    },
      el('option', { value: '' }, '— ' + t('ht.dental.tx.field.provider.none') + ' —'),
      ...providers.map((p) => el('option', { value: p.id }, p.name_en || p.name_jp || '?')),
    )));
    modal.appendChild(field(t('ht.dental.appts.field.purpose'), textInput(draft.purpose, (v) => draft.purpose = v)));
    modal.appendChild(field(t('ht.dental.appts.field.notes'), textareaInput(draft.notes, (v) => draft.notes = v)));
    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { upsertDentalAppointment(draft); close(); rerender(); } }, t('ht.save')));
    modal.appendChild(btnRow);
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Costs & Invoice Tracking card ────────────────────────────
  function buildDentalCostsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('h3', { style: { margin: 0 } }, '💰 ' + t('ht.dental.costs.title')));

    const yearFilter = getDental()._tx_year_filter || 'all';
    const yearLabel = yearFilter === 'all' ? '' : ' (' + yearFilter + ')';

    // Pull invoices first (primary source of truth for billing now).
    const notes = getDentalNotesLog();
    const dentalInvoices = getInvoices().filter((i) => {
      if (i.type === 'dental') return true;
      // Also include invoices linked to dental notes (legacy linkage)
      return notes.some((n) => n.invoice_id === i.id);
    });
    function inYear(dateStr) {
      if (yearFilter === 'all') return true;
      return dateStr && dateStr.startsWith(yearFilter);
    }

    // Aggregate from dental invoices (primary) + notes_log billing
    // for visits without an invoice. Procedures cost sums are a final
    // fallback when neither invoices nor note-billing exist.
    let totalExpenses = 0, insuranceCovered = 0;
    let currency = 'JPY';

    // 1) Dental-type invoices — primary
    for (const inv of dentalInvoices) {
      if (!inYear(inv.date)) continue;
      if (typeof inv.amount_native === 'number' && isFinite(inv.amount_native)) {
        totalExpenses += inv.amount_native;
      }
      if (inv.reimbursement_status === 'received' &&
          typeof inv.reimbursed_native === 'number' && isFinite(inv.reimbursed_native)) {
        insuranceCovered += inv.reimbursed_native;
      }
      if (inv.currency) currency = inv.currency;
    }

    // 2) Note billing for visits NOT covered by a linked invoice
    const invoicedNoteIds = new Set(
      dentalInvoices.filter((i) => i.exam_id).map((i) => i.exam_id)
        .concat(notes.filter((n) => n.invoice_id).map((n) => n.id))
    );
    for (const n of notes) {
      if (!inYear(n.date)) continue;
      if (invoicedNoteIds.has(n.id)) continue;
      // Also skip when the note's billing.receipt_source matches a
      // dental invoice filename (heuristic linkage for older imports).
      const b = n.billing || {};
      if (b.receipt_source && dentalInvoices.some((i) => i.filename === b.receipt_source)) continue;
      if (typeof b.total === 'number') totalExpenses += b.total;
      if (typeof b.insurance === 'number') insuranceCovered += b.insurance;
      if (b.currency) currency = b.currency;
    }

    // 3) Procedures-only fallback when nothing else has billing
    if (totalExpenses === 0) {
      for (const p of getDentalProcedures()) {
        if (!inYear(p.date)) continue;
        if (typeof p.cost === 'number') totalExpenses += p.cost * (p.qty || 1);
        if (p.currency) currency = p.currency;
      }
    }

    const sym = ({ USD: '$', JPY: '¥', EUR: '€', GBP: '£' })[currency] || (currency + ' ');
    function fmt(v) {
      if (currency === 'JPY') return sym + Math.round(v).toLocaleString();
      return sym + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    const grid = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: 'var(--tb-sp-2)' } });
    function totalRow(label, value, color) {
      return el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0',
          borderBottom: '1px solid var(--tb-border)' },
      },
        el('span', null, label),
        el('span', { style: { fontWeight: '600', fontFamily: 'var(--tb-font-mono)', color: color || 'inherit' } },
          fmt(value)),
      );
    }
    grid.appendChild(totalRow(t('ht.dental.costs.total') + yearLabel, totalExpenses, 'var(--tb-text)'));
    grid.appendChild(totalRow(t('ht.dental.costs.insurance'), insuranceCovered, 'var(--tb-track-health)'));
    grid.appendChild(totalRow(t('ht.dental.costs.oop'), totalExpenses - insuranceCovered, 'var(--tb-warn)'));
    card.appendChild(grid);

    // Invoice History with per-invoice action buttons
    if (dentalInvoices.length > 0) {
      card.appendChild(el('h4', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
        '🧾 ' + t('ht.dental.costs.invoiceHistory')));
      const invList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } });
      for (const inv of dentalInvoices) {
        if (!inYear(inv.date)) continue;
        invList.appendChild(buildDentalInvoiceRow(inv));
      }
      card.appendChild(invList);
    }

    // Upload invoice button — pass prefillType so the import flow
    // knows this is dental and filters candidates appropriately.
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (hasKey) {
      card.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-2)' },
        onclick: () => openInvoiceVisionImportModal({ prefillType: 'dental' }),
      }, '🧾 ' + t('ht.dental.costs.uploadInvoice')));
    }
    return card;
  }

  // Per-invoice row in the dental costs section — surfaces paid /
  // submitted-to-insurance / reimbursed status with one-click toggles.
  function buildDentalInvoiceRow(inv) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const sym = ({ USD: '$', JPY: '¥', EUR: '€', GBP: '£' })[inv.currency || 'USD'] || ((inv.currency || '') + ' ');
    const amt = inv.amount_native != null
      ? sym + (inv.currency === 'JPY'
          ? Math.round(inv.amount_native).toLocaleString()
          : Number(inv.amount_native).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
      : '—';
    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        display: 'flex', flexDirection: 'column', gap: '6px',
        borderLeft: '3px solid ' + (inv.paid ? 'var(--tb-success)' : 'var(--tb-warn)'),
      },
    });

    // Top line: date, amount, status pills
    const topLine = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' },
    });
    topLine.appendChild(el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
      inv.date || '?'));
    topLine.appendChild(el('span', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, amt));
    if (inv.paid) {
      topLine.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(34, 139, 34, 0.18)', color: 'var(--tb-success)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '✓ ' + t('ht.dental.costs.paid')));
    } else {
      topLine.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(200, 100, 30, 0.18)', color: 'var(--tb-warn)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.dental.costs.unpaid')));
    }
    if (inv.reimbursement_status === 'received') {
      topLine.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.18)', color: 'var(--tb-track-health)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '↩ ' + t('ht.dental.costs.reimbursed')));
    } else if (inv.reimbursement_status === 'submitted' || inv.reimbursement_status === 'pending') {
      topLine.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.10)', color: 'var(--tb-track-health)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '📤 ' + t('ht.dental.costs.insSubmitted')));
    } else if (inv.reimbursement_status === 'denied') {
      topLine.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(220, 38, 38, 0.18)', color: 'var(--tb-error)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '✗ ' + t('ht.dental.costs.insDenied')));
    }
    row.appendChild(topLine);

    // Provider/facility meta line
    if (inv.facility || inv.provider) {
      row.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px' } },
        [inv.provider, inv.facility].filter(Boolean).join(' · ')));
    }

    // Action buttons — Mark paid / Submit insurance / Reimbursed
    const actions = el('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } });
    if (!inv.paid) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary', type: 'button',
        style: { fontSize: '11px', padding: '2px 10px' },
        onclick: () => {
          const updated = Object.assign({}, inv, {
            paid: true,
            paid_date: new Date().toISOString().slice(0, 10),
            updated_at: new Date().toISOString(),
          });
          upsertInvoice(updated);
          rerender();
        },
      }, '✓ ' + t('ht.dental.costs.markPaid')));
    } else {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: '11px', padding: '2px 10px' },
        onclick: () => {
          const updated = Object.assign({}, inv, {
            paid: false, paid_date: null,
            updated_at: new Date().toISOString(),
          });
          upsertInvoice(updated);
          rerender();
        },
      }, '↶ ' + t('ht.dental.costs.markUnpaid')));
    }
    if (inv.reimbursement_status !== 'submitted' && inv.reimbursement_status !== 'pending' &&
        inv.reimbursement_status !== 'received') {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: '11px', padding: '2px 10px' },
        onclick: () => {
          const updated = Object.assign({}, inv, {
            insurance_billed: true,
            reimbursement_status: 'submitted',
            updated_at: new Date().toISOString(),
          });
          upsertInvoice(updated);
          rerender();
        },
      }, '📤 ' + t('ht.dental.costs.submitInsurance')));
    } else if (inv.reimbursement_status === 'submitted' || inv.reimbursement_status === 'pending') {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: '11px', padding: '2px 10px' },
        onclick: () => {
          const amt = prompt(t('ht.dental.costs.reimbursedPrompt'));
          if (amt == null) return;
          const v = parseFloat(amt);
          const updated = Object.assign({}, inv, {
            reimbursement_status: 'received',
            reimbursed_native: isFinite(v) ? v : null,
            reimbursed_currency: inv.currency,
            updated_at: new Date().toISOString(),
          });
          upsertInvoice(updated);
          rerender();
        },
      }, '✓ ' + t('ht.dental.costs.markReimbursed')));
    }
    actions.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: '11px', padding: '2px 10px' },
      onclick: () => openInvoiceEditModal(inv),
    }, '✎ ' + t('ht.dental.costs.editInvoice')));
    actions.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: '11px', padding: '2px 10px', color: 'var(--tb-error)' },
      onclick: () => { if (deleteInvoiceWithUndo(inv.id)) rerender(); },
    }, '×'));
    row.appendChild(actions);

    return row;
  }

  // ─── Dental Notes & Follow-ups card ───────────────────────────
  function buildDentalNotesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'health' });
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('h3', { style: { margin: 0 } }, '📝 ' + t('ht.dental.notes.title')),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openDentalNoteEditModal(null),
      }, '+ ' + t('ht.dental.notes.add')),
    ));
    const notes = getDentalNotesLog();
    if (notes.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('ht.dental.notes.empty')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)' } });
      for (let i = 0; i < notes.length; i++) {
        list.appendChild(buildDentalNoteBlock(notes[i], i === 0));
      }
      card.appendChild(list);
    }
    return card;
  }

  function buildDentalNoteBlock(n, isLatest) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const providers = getDentalProviders();
    const prov = n.provider_id ? providers.find((x) => x.id === n.provider_id) : null;

    const block = el('div', {
      style: {
        border: '1px solid var(--tb-border)', borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
      },
    });

    // Header
    const head = el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    head.appendChild(el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } }, n.date || '?'));
    if (isLatest) {
      head.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(245, 158, 11, 0.20)', color: '#d97706',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.dental.notes.latest')));
    }
    if (n.status === 'complete') {
      head.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(34, 139, 34, 0.20)', color: 'var(--tb-success)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '✓ ' + t('ht.dental.notes.complete')));
    } else {
      head.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.14)', color: 'var(--tb-track-health)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.dental.notes.open')));
    }
    head.appendChild(el('span', { style: { flex: '1' } }));
    head.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: '11px', padding: '2px 8px' },
      onclick: () => {
        const d = getDental();
        const target = (d.notes_log || []).find((x) => x.id === n.id);
        if (target) {
          target.status = target.status === 'complete' ? 'open' : 'complete';
          setDental(d);
          rerender();
        }
      },
    }, n.status === 'complete' ? '↩ ' + t('ht.dental.notes.reopen') : '✓ ' + t('ht.dental.notes.markComplete')));
    head.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: '11px', padding: '2px 8px' },
      onclick: () => openDentalNoteEditModal(n),
    }, '✎'));
    head.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: '11px', padding: '2px 8px', color: 'var(--tb-error)' },
      onclick: () => { if (deleteDentalNoteWithUndo(n.id)) rerender(); },
    }, '×'));
    block.appendChild(head);

    if (prov) {
      block.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '4px' } },
        prov.name_en || prov.name_jp || '?'));
    }

    function section(label, content, color) {
      if (!content) return;
      block.appendChild(el('div', {
        style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
          letterSpacing: '0.04em', color: color || 'var(--tb-text-soft)',
          marginTop: 'var(--tb-sp-2)', marginBottom: '4px' },
      }, label));
      block.appendChild(content);
    }
    if (n.findings) {
      section(t('ht.dental.notes.findings'),
        el('div', { style: { fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)', whiteSpace: 'pre-wrap' } }, n.findings),
        'var(--tb-text-soft)');
    }
    if (n.clinical_interpretation) {
      section(t('ht.dental.notes.clinicalInterpretation'),
        el('div', { style: { fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)', whiteSpace: 'pre-wrap',
          fontStyle: 'italic', padding: '6px 10px', background: 'var(--tb-bg-elev, rgba(0,0,0,0.03))',
          borderLeft: '2px solid var(--tb-track-ai)', borderRadius: 'var(--tb-radius-1)' } },
          n.clinical_interpretation),
        'var(--tb-track-ai)');
    }
    if (n.recommendations) {
      const lines = n.recommendations.split('\n').filter((l) => l.trim());
      const list = el('ul', { style: { margin: '0', paddingLeft: '20px', fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)' } });
      for (const ln of lines) list.appendChild(el('li', null, ln.replace(/^[-•*]\s*/, '')));
      section(t('ht.dental.notes.recommendations'), list, 'var(--tb-warn)');
    }
    if (Array.isArray(n.action_items) && n.action_items.length > 0) {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
      for (const item of n.action_items) {
        list.appendChild(el('label', {
          style: { display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer',
            fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)' },
        },
          el('input', {
            type: 'checkbox', checked: !!item.checked,
            onchange: (e) => {
              const d = getDental();
              const tgt = (d.notes_log || []).find((x) => x.id === n.id);
              if (tgt) {
                const ai = (tgt.action_items || []).find((y) => y.id === item.id);
                if (ai) { ai.checked = !!e.target.checked; setDental(d); }
              }
            },
          }),
          el('span', { style: item.checked ? { textDecoration: 'line-through', color: 'var(--tb-text-soft)' } : null },
            item.text || ''),
        ));
      }
      section(t('ht.dental.notes.actionItems'), list, 'var(--tb-track-health)');
    }
    if (n.next_appointment) {
      block.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-2)', padding: '6px 10px', background: 'var(--tb-bg-elev, rgba(0,0,0,0.03))',
          borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)' },
      }, '📅 ' + t('ht.dental.notes.next') + ': ', el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, n.next_appointment)));
    }
    // Billing block
    const b = n.billing || {};
    if (b.patient_paid != null || b.insurance != null || b.total != null) {
      const billBox = el('div', {
        style: {
          marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev, rgba(0,0,0,0.03))', borderRadius: 'var(--tb-radius-1)',
        },
      });
      billBox.appendChild(el('div', {
        style: { fontSize: '10px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--tb-text-soft)', marginBottom: '4px' },
      }, t('ht.dental.notes.billing') + (b.receipt_no ? ' (' + t('ht.dental.notes.receiptNo') + ' ' + b.receipt_no + ')' : '')));
      const currency = b.currency || 'JPY';
      const sym = ({ USD: '$', JPY: '¥', EUR: '€' })[currency] || (currency + ' ');
      function billFmt(v) {
        if (v == null) return '—';
        return sym + (currency === 'JPY' ? Math.round(v).toLocaleString() : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      }
      const billGrid = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
      });
      function billCell(label, value, mono) {
        return el('div', null,
          el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } }, label),
          el('div', { style: { fontWeight: '600', fontFamily: mono ? 'var(--tb-font-mono)' : 'inherit' } }, value),
        );
      }
      billGrid.appendChild(billCell(t('ht.dental.notes.bill.paid'), billFmt(b.patient_paid), true));
      billGrid.appendChild(billCell(t('ht.dental.notes.bill.insurance'), billFmt(b.insurance), true));
      billGrid.appendChild(billCell(t('ht.dental.notes.bill.total'), billFmt(b.total), true));
      if (b.burden_ratio) {
        billGrid.appendChild(billCell(t('ht.dental.notes.bill.burden'), b.burden_ratio, false));
      }
      billBox.appendChild(billGrid);
      if (b.receipt_source) {
        billBox.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px', fontSize: '10px', fontFamily: 'var(--tb-font-mono)' } },
          t('ht.dental.notes.bill.source') + ': ' + b.receipt_source));
      }
      block.appendChild(billBox);
    }
    if (n.exam_source) {
      block.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)', fontSize: '10px', fontFamily: 'var(--tb-font-mono)' } },
        t('ht.dental.notes.examSource') + ': ' + n.exam_source));
    }
    return block;
  }

  function openDentalNoteEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('dn-' + Date.now().toString(36)),
      date: new Date().toISOString().slice(0, 10),
      provider_id: null,
      status: 'open',
      findings: '', clinical_interpretation: '', recommendations: '',
      action_items: [],
      next_appointment: '',
      periodontal_snapshot: null,
      billing: { patient_paid: null, insurance: null, total: null, currency: 'JPY', burden_ratio: '', receipt_no: '', receipt_source: '' },
      exam_source: '', exam_id: null, invoice_id: null,
      created_at: new Date().toISOString(),
    };
    // Ensure clinical_interpretation exists on legacy entries
    if (typeof draft.clinical_interpretation !== 'string') draft.clinical_interpretation = '';
    // Ensure billing exists
    if (!draft.billing) draft.billing = { patient_paid: null, insurance: null, total: null, currency: 'JPY', burden_ratio: '', receipt_no: '', receipt_source: '' };
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isEdit ? t('ht.dental.notes.editTitle') : t('ht.dental.notes.addTitle')));
    const providers = getDentalProviders();
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.notes.field.date'), dateInput(draft.date, (v) => draft.date = v)),
      field(t('ht.dental.notes.field.provider'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.provider_id = e.target.value || null; },
      },
        el('option', { value: '', selected: !draft.provider_id }, '— ' + t('ht.dental.tx.field.provider.none') + ' —'),
        ...providers.map((p) => el('option', { value: p.id, selected: draft.provider_id === p.id },
          p.name_en || p.name_jp || '?')),
      )),
    ));
    modal.appendChild(field(t('ht.dental.notes.findings'),
      textareaInput(draft.findings, (v) => draft.findings = v),
      t('ht.dental.notes.findings.help')));
    modal.appendChild(field(t('ht.dental.notes.clinicalInterpretation'),
      textareaInput(draft.clinical_interpretation, (v) => draft.clinical_interpretation = v),
      t('ht.dental.notes.clinicalInterpretation.help')));
    modal.appendChild(field(t('ht.dental.notes.recommendations'),
      textareaInput(draft.recommendations, (v) => draft.recommendations = v),
      t('ht.dental.notes.recommendations.help')));
    modal.appendChild(field(t('ht.dental.notes.next'),
      textInput(draft.next_appointment, (v) => draft.next_appointment = v),
      t('ht.dental.notes.next.help')));

    // Action items (editor — comma/newline separated)
    modal.appendChild(field(t('ht.dental.notes.actionItems'),
      textareaInput((draft.action_items || []).map(x => x.text).join('\n'), (v) => {
        const lines = v.split('\n').map(x => x.trim()).filter(Boolean);
        const existingMap = {};
        for (const ai of (draft.action_items || [])) existingMap[ai.text] = ai;
        draft.action_items = lines.map(text => existingMap[text] || {
          id: 'ai-' + Math.random().toString(36).slice(2, 8),
          text, checked: false,
        });
      }),
      t('ht.dental.notes.actionItems.help')));

    // Billing
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '💰 ' + t('ht.dental.notes.billing')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 80px', gap: 'var(--tb-sp-2)' } },
      field(t('ht.dental.notes.bill.paid'), numInput(draft.billing.patient_paid, (v) => draft.billing.patient_paid = v)),
      field(t('ht.dental.notes.bill.insurance'), numInput(draft.billing.insurance, (v) => draft.billing.insurance = v)),
      field(t('ht.dental.notes.bill.total'), numInput(draft.billing.total, (v) => draft.billing.total = v)),
      field(t('ht.dental.notes.bill.currency'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.billing.currency = e.target.value; },
      }, ['JPY', 'USD', 'EUR', 'GBP'].map((c) =>
        el('option', { value: c, selected: draft.billing.currency === c }, c)))),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.dental.notes.bill.burden'), textInput(draft.billing.burden_ratio, (v) => draft.billing.burden_ratio = v),
        t('ht.dental.notes.bill.burden.help')),
      field(t('ht.dental.notes.bill.receiptNo'), textInput(draft.billing.receipt_no, (v) => draft.billing.receipt_no = v)),
    ));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' } });
    if (isEdit) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => { if (deleteDentalNoteWithUndo(draft.id)) { close(); rerender(); } } },
        t('ht.delete')));
    } else btnRow.appendChild(el('span'));
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { upsertDentalNote(draft); close(); rerender(); } }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Dental vision import modal ───────────────────────────────
  //
  // Dedicated dental flow — opens a drop zone, runs the dental-specific
  // extraction prompt (per-tooth findings, procedure codes, billing,
  // periodontal stats), then auto-populates the dental tab with what
  // it finds. Cost is folded into the import preview.
  function openDentalVisionImportModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🦷 ' + t('ht.dental.import.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.dental.import.intro')));

    const status = el('div', { style: { marginTop: 'var(--tb-sp-2)', minHeight: '1.4em', fontSize: 'var(--tb-fs-12)' } });
    const fileInput = el('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf',
      style: { display: 'none' },
      onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) handleUpload(f); e.target.value = ''; },
    });
    const dropZone = el('div', {
      style: { border: '1px dashed var(--tb-border)', borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-4)', textAlign: 'center', background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-2)' },
    },
      el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-2)' } }, t('ht.dental.import.dropTitle')),
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } }, t('ht.dental.import.dropHelp')),
      el('button', { class: 'tb-btn', type: 'button', onclick: () => fileInput.click() }, '📎 ' + t('ht.import.choose')),
      fileInput,
    );
    if (TB.utils && typeof TB.utils.attachFileDrop === 'function') {
      TB.utils.attachFileDrop(dropZone, {
        accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
        text: '⤓ ' + t('ht.import.dropOver'),
        onFile: (f) => handleUpload(f),
        onError: (msg) => { status.textContent = '✗ ' + msg; status.style.color = 'var(--tb-error)'; },
      });
    }
    modal.appendChild(dropZone);
    modal.appendChild(status);

    async function handleUpload(file) {
      status.textContent = '⏳ ' + t('ht.dental.import.processing', { name: file.name });
      status.style.color = 'var(--tb-text-soft)';
      try {
        const result = await TB.ai.callClaudeVisionForDentalExtraction(file, {});
        const ext = result.extracted || {};
        const cost = (result.cost_usd || 0).toFixed(4);
        if (ext.is_dental === false) {
          status.textContent = '⚠ ' + t('ht.dental.import.notDental');
          status.style.color = 'var(--tb-warn)';
          return;
        }
        const summary = applyDentalExtraction(ext, file.name, Number(result.cost_usd) || 0);
        status.textContent = '✓ ' + t('ht.dental.import.done', {
          cost,
          teeth: summary.teethUpdated,
          procs: summary.proceduresAdded,
        });
        status.style.color = 'var(--tb-success)';
        setTimeout(() => { close(); rerender(); }, 1500);
      } catch (err) {
        status.textContent = '✗ ' + (err.message || err);
        status.style.color = 'var(--tb-error)';
      }
    }

    modal.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' } },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
    ));
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // Persist extracted dental data into the appropriate slots:
  //   • providers[] — upsert when a matching provider doesn't already exist
  //   • teeth{} — patch per-tooth status / pocket / bleeding / mobility
  //   • procedures[] — append billable line items (de-duped against
  //     existing procedures on the same date + same name)
  //   • notes_log[] — one new entry with findings / recommendations /
  //     action items / billing breakdown / exam source filename
  function applyDentalExtraction(ext, filename, costUsd) {
    const d = getDental();
    const stats = { teethUpdated: 0, proceduresAdded: 0, providerAdded: false, noteAdded: false };

    // ─── Provider — match by name (lowercase, trimmed, also try
    // substring overlap so "Sakura Dental Clinic" matches an
    // existing "Sakura Dental Clinic (Orthodontics)"). When matched,
    // fill missing fields AND upgrade short names with more complete
    // variants (e.g., JP-only → bilingual).
    let providerId = null;
    if (ext.provider && (ext.provider.name_en || ext.provider.name_jp)) {
      function nameKey(s) { return String(s || '').toLowerCase().trim(); }
      function namesOverlap(a, b) {
        const ak = nameKey(a), bk = nameKey(b);
        if (!ak || !bk) return false;
        if (ak === bk) return true;
        if (ak.length >= 4 && (ak.includes(bk) || bk.includes(ak))) return true;
        return false;
      }
      const existing = (d.providers || []).find((p) =>
        namesOverlap(p.name_en, ext.provider.name_en) ||
        namesOverlap(p.name_jp, ext.provider.name_jp));
      if (existing) {
        providerId = existing.id;
        let updated = false;
        // 1) Fill missing fields (when existing is blank, copy from
        //    the new extraction). This is how a JP-only existing
        //    record gets its English name added.
        for (const k of ['name_en', 'name_jp', 'type', 'address', 'phone']) {
          if (!existing[k] && ext.provider[k]) { existing[k] = ext.provider[k]; updated = true; }
        }
        // 2) Upgrade short variants — if the new extraction has a
        //    "more complete" version (e.g., includes both languages
        //    or is a strict superset), prefer it. Uses the same
        //    isMoreCompleteName helper that powers the asset
        //    canonicalization.
        if (ext.provider.name_en && existing.name_en &&
            isMoreCompleteName(ext.provider.name_en, existing.name_en)) {
          existing.name_en = ext.provider.name_en; updated = true;
        }
        if (ext.provider.name_jp && existing.name_jp &&
            isMoreCompleteName(ext.provider.name_jp, existing.name_jp)) {
          existing.name_jp = ext.provider.name_jp; updated = true;
        }
        if (updated) upsertDentalProvider(existing);
      } else {
        providerId = (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('dp-' + Date.now().toString(36));
        upsertDentalProvider({
          id: providerId,
          name_en: ext.provider.name_en || '',
          name_jp: ext.provider.name_jp || '',
          type: ext.provider.type || '',
          address: ext.provider.address || '',
          phone: ext.provider.phone || '',
          email: '', notes: '',
          ai_imported: true,
          created_at: new Date().toISOString(),
        });
        stats.providerAdded = true;
      }
    }

    // ─── Teeth — patch each tooth that has findings
    if (Array.isArray(ext.teeth)) {
      const d2 = getDental();
      d2.teeth = d2.teeth || {};
      for (const tooth of ext.teeth) {
        if (!tooth || typeof tooth.uni !== 'number') continue;
        if (tooth.uni < 1 || tooth.uni > 32) continue;
        const cur = d2.teeth[String(tooth.uni)] || { status: 'natural' };
        if (tooth.status) cur.status = tooth.status;
        if (tooth.has_pocket != null) cur.has_pocket = !!tooth.has_pocket;
        if (tooth.has_bleeding != null) cur.has_bleeding = !!tooth.has_bleeding;
        if (tooth.is_mobile != null) cur.is_mobile = !!tooth.is_mobile;
        // v0.53: cavity / treatment / observation flags
        if (tooth.has_cavity != null) cur.has_cavity = !!tooth.has_cavity;
        if (tooth.needs_treatment != null) cur.needs_treatment = !!tooth.needs_treatment;
        if (tooth.needs_observation != null) cur.needs_observation = !!tooth.needs_observation;
        if (typeof tooth.pocket_max_mm === 'number') cur.pocket_max_mm = tooth.pocket_max_mm;
        if (tooth.notes) cur.notes = tooth.notes;
        d2.teeth[String(tooth.uni)] = cur;
        stats.teethUpdated++;
      }
      setDental(d2);
      recomputeDentalPerio();
    }

    // ─── Periodontal aggregate — ALWAYS apply when the AI extracted
    // them (typical case: AI reads "12.5% pockets, 50% BoP" from the
    // findings narrative even when it can't pinpoint specific teeth).
    // recomputeDentalPerio (above) only overwrites these when actual
    // per-tooth flags exist, so this stays sticky.
    if (ext.periodontal) {
      const d3 = getDental();
      d3.periodontal = d3.periodontal || {};
      if (typeof ext.periodontal.pockets_4mm_pct === 'number') d3.periodontal.pockets_4mm_pct = ext.periodontal.pockets_4mm_pct;
      if (typeof ext.periodontal.bleeding_on_probing_pct === 'number') d3.periodontal.bleeding_on_probing_pct = ext.periodontal.bleeding_on_probing_pct;
      if (typeof ext.periodontal.mobile_teeth === 'number') d3.periodontal.mobile_teeth = ext.periodontal.mobile_teeth;
      // v0.53: pocket depth distribution
      if (typeof ext.periodontal.pocket_dist_healthy_pct === 'number') d3.periodontal.pocket_dist_healthy_pct = ext.periodontal.pocket_dist_healthy_pct;
      if (typeof ext.periodontal.pocket_dist_mild_pct === 'number') d3.periodontal.pocket_dist_mild_pct = ext.periodontal.pocket_dist_mild_pct;
      if (typeof ext.periodontal.pocket_dist_severe_pct === 'number') d3.periodontal.pocket_dist_severe_pct = ext.periodontal.pocket_dist_severe_pct;
      d3.periodontal.last_perio_exam = ext.exam_date || d3.periodontal.last_perio_exam;
      setDental(d3);
    }

    // ─── Procedures — append new, dedupe against existing on (date + name)
    if (Array.isArray(ext.procedures)) {
      const existingProcs = getDentalProcedures();
      for (const p of ext.procedures) {
        if (!p) continue;
        const procDate = p.date || ext.exam_date || new Date().toISOString().slice(0, 10);
        const name = (p.name_en || p.name_jp || '').trim();
        if (!name && !p.code) continue;
        // Dedupe check
        const dup = existingProcs.find((x) =>
          x.date === procDate &&
          ((x.name_en && x.name_en === p.name_en) ||
           (x.name_jp && x.name_jp === p.name_jp) ||
           (x.code && p.code && x.code === p.code))
        );
        if (dup) continue;
        upsertDentalProcedure({
          id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('proc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4)),
          date: procDate,
          name_en: p.name_en || '',
          name_jp: p.name_jp || '',
          code: p.code || '',
          cost: typeof p.cost === 'number' ? p.cost : null,
          currency: p.currency || (ext.billing && ext.billing.currency) || 'JPY',
          points: typeof p.points === 'number' ? p.points : null,
          qty: p.qty || 1,
          provider_id: providerId,
          invoice_id: null,
          tooth_numbers: Array.isArray(p.tooth_numbers) ? p.tooth_numbers : [],
          notes: '',
          ai_imported: true,
          ai_cost_usd: costUsd,
          created_at: new Date().toISOString(),
        });
        stats.proceduresAdded++;
      }
    }

    // ─── Notes log entry — capture findings + interpretation +
    // recommendations + actions + billing + per-exam periodontal
    // snapshot (the snapshot is what powers the trend sparkline
    // across exams — one data point per note).
    if (ext.findings || ext.clinical_interpretation || ext.recommendations ||
        (ext.action_items && ext.action_items.length > 0) || ext.billing || ext.periodontal) {
      const noteId = (TB.utils && TB.utils.uuid) ? TB.utils.uuid() : ('dn-' + Date.now().toString(36));
      const action_items = (Array.isArray(ext.action_items) ? ext.action_items : []).map((text) => ({
        id: 'ai-' + Math.random().toString(36).slice(2, 8),
        text: String(text || '').trim(),
        checked: false,
      })).filter((x) => x.text);
      // Snapshot the periodontal stats on the note itself so the
      // trend sparkline can plot one point per dental exam over time.
      const perioSnapshot = ext.periodontal ? {
        pockets_4mm_pct: typeof ext.periodontal.pockets_4mm_pct === 'number' ? ext.periodontal.pockets_4mm_pct : null,
        bleeding_on_probing_pct: typeof ext.periodontal.bleeding_on_probing_pct === 'number' ? ext.periodontal.bleeding_on_probing_pct : null,
        mobile_teeth: typeof ext.periodontal.mobile_teeth === 'number' ? ext.periodontal.mobile_teeth : null,
        pocket_dist_healthy_pct: typeof ext.periodontal.pocket_dist_healthy_pct === 'number' ? ext.periodontal.pocket_dist_healthy_pct : null,
        pocket_dist_mild_pct: typeof ext.periodontal.pocket_dist_mild_pct === 'number' ? ext.periodontal.pocket_dist_mild_pct : null,
        pocket_dist_severe_pct: typeof ext.periodontal.pocket_dist_severe_pct === 'number' ? ext.periodontal.pocket_dist_severe_pct : null,
      } : null;
      // Drop next_appointment when it matches the exam date itself —
      // PDFs often place a placeholder there that's actually the
      // current visit's time, not a real future appointment.
      let nextAppt = ext.next_appointment || '';
      const examDate = ext.exam_date || new Date().toISOString().slice(0, 10);
      if (nextAppt && examDate) {
        // Compare just the YYYY-MM-DD portion
        const naDate = String(nextAppt).slice(0, 10);
        if (naDate === examDate) nextAppt = '';
      }
      upsertDentalNote({
        id: noteId,
        date: ext.exam_date || new Date().toISOString().slice(0, 10),
        provider_id: providerId,
        status: 'open',
        findings: ext.findings || '',
        clinical_interpretation: ext.clinical_interpretation || '',
        recommendations: (Array.isArray(ext.recommendations) ? ext.recommendations.join('\n') : ext.recommendations) || '',
        action_items,
        next_appointment: nextAppt,
        periodontal_snapshot: perioSnapshot,
        billing: ext.billing ? {
          patient_paid: typeof ext.billing.patient_paid === 'number' ? ext.billing.patient_paid : null,
          insurance: typeof ext.billing.insurance === 'number' ? ext.billing.insurance : null,
          total: typeof ext.billing.total === 'number' ? ext.billing.total : null,
          currency: ext.billing.currency || 'JPY',
          burden_ratio: ext.billing.burden_ratio || '',
          receipt_no: ext.billing.receipt_no || '',
          receipt_source: filename || '',
        } : null,
        exam_source: filename || '',
        ai_imported: true,
        ai_cost_usd: costUsd,
        created_at: new Date().toISOString(),
      });
      stats.noteAdded = true;
    }

    // Legacy fields — keep them in sync for dashboard / Action Center
    const d4 = getDental();
    if (ext.exam_date) {
      // If any procedure was scaling/cleaning, update last_cleaning
      const isCleaning = Array.isArray(ext.procedures) && ext.procedures.some((p) =>
        /scaling|cleaning|prophy|sc\b|歯石/i.test((p.name_en || '') + ' ' + (p.name_jp || ''))
      );
      if (isCleaning && (!d4.last_cleaning || d4.last_cleaning < ext.exam_date)) {
        d4.last_cleaning = ext.exam_date;
      }
      const isPerio = (ext.periodontal && (ext.periodontal.pockets_4mm_pct != null || ext.periodontal.bleeding_on_probing_pct != null)) ||
        (Array.isArray(ext.procedures) && ext.procedures.some((p) =>
          /perio|periodontal|p基検|歯周/i.test((p.name_en || '') + ' ' + (p.name_jp || ''))
        ));
      if (isPerio && (!d4.last_perio || d4.last_perio < ext.exam_date)) {
        d4.last_perio = ext.exam_date;
      }
      const isXrays = Array.isArray(ext.procedures) && ext.procedures.some((p) =>
        /x[\s\-]?ray|panoramic|bitewing|デンタル.*x|レントゲン/i.test((p.name_en || '') + ' ' + (p.name_jp || ''))
      );
      if (isXrays && (!d4.last_xrays || d4.last_xrays < ext.exam_date)) {
        d4.last_xrays = ext.exam_date;
      }
    }
    if (!d4.dentist && ext.provider) {
      d4.dentist = ext.provider.name_en || ext.provider.name_jp || '';
    }
    if (!d4.clinic && ext.provider) {
      d4.clinic = ext.provider.name_jp || ext.provider.name_en || '';
    }
    setDental(d4);

    // Chain-AI: kick off provider enrichment when the synced provider
    // is missing a language name or public-info fields. Same chain the
    // invoice import uses — keeps both extraction paths converging on
    // a complete provider record.
    if (providerId) {
      const provNow = (getDental().providers || []).find((p) => p.id === providerId);
      if (provNow) {
        try { maybeChainProviderEnrichment(provNow); } catch (_) {}
      }
    }

    return stats;
  }

  // ====================================================================
  // Tab: Insurance & Notes
  // ====================================================================

  function renderNotesTab(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    // One-shot migration of legacy fields → cards[]. After this runs once,
    // the legacy fields stay in state (untouched) but the UI is cards-only.
    migrateLegacyInsuranceFields();
    const ins = getInsuranceSummary();
    const cards = getInsuranceCards();

    const card = el('div', { class: 'tb-card', 'data-track': 'health' });

    // Header row with title + actions
    const headRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    });
    headRow.appendChild(el('h2', { style: { marginTop: 0 } }, '📒 ' + t('ht.notes.title')));
    const actions = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    const medOk = TB.ai && typeof TB.ai.isFeatureAllowed === 'function'
      ? TB.ai.isFeatureAllowed('medical_vision') !== false
      : true;
    actions.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => openInsuranceCardEditModal(null),
    }, '+ ' + t('ht.notes.cards.addManual')));
    if (hasKey && medOk) {
      actions.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => openInsuranceCardImportModal(),
      }, '🪪 ' + t('ht.notes.import.btn')));
    }
    headRow.appendChild(actions);
    card.appendChild(headRow);
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.notes.intro')));

    // Cross-link to Healthcare module for deep coverage planning
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        borderLeft: '3px solid var(--tb-track-health)',
        borderRadius: 'var(--tb-radius-1)',
        marginBottom: 'var(--tb-sp-3)',
        fontSize: 'var(--tb-fs-12)',
      },
    },
      el('strong', null, '💡 ' + t('ht.notes.crossLink.title')),
      ' ' + t('ht.notes.crossLink.body') + ' ',
      el('a', {
        href: '#',
        style: { color: 'var(--tb-track-health)', fontWeight: '600' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'healthcare' } }));
        },
      }, '↗ ' + t('ht.notes.crossLink.open')),
    ));

    // Empty state
    if (cards.length === 0) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-4)', textAlign: 'center',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
          marginBottom: 'var(--tb-sp-3)',
        },
      },
        el('div', { style: { fontSize: '32px', marginBottom: 'var(--tb-sp-2)' } }, '🪪'),
        el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-1)' } }, t('ht.notes.cards.empty.title')),
        el('div', { class: 'tb-card-meta' }, t('ht.notes.cards.empty.body')),
      ));
    } else {
      // Render each card as a collapsible panel
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' } });
      for (const c of cards) list.appendChild(buildInsuranceCardPanel(c));
      card.appendChild(list);
    }

    // General notes — moved BELOW the cards as a catch-all for cross-plan
    // notes that don't fit a single card (allergies, drug sensitivities,
    // blood type, emergency contacts, advance directive location).
    card.appendChild(el('h3', {
      style: { marginTop: 'var(--tb-sp-4)', marginBottom: 'var(--tb-sp-1)', fontSize: 'var(--tb-fs-14)' },
    }, '🩹 ' + t('ht.notes.generalNotes')));
    card.appendChild(textareaInput(ins.notes, (v) => {
      const cur = getInsuranceSummary();
      cur.notes = v;
      setInsuranceSummary(cur);
    }));
    card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: '4px' } }, t('ht.notes.generalNotes.help')));

    tabHost.appendChild(card);
  }

  // ─── One card → its own collapsible panel ───────────────────────
  function buildInsuranceCardPanel(c) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    // Type icon + color
    const typeStyle = {
      medical:      { icon: '🏥', accent: 'var(--tb-track-health)' },
      combined:     { icon: '🏥', accent: 'var(--tb-track-health)' },
      dental:       { icon: '🦷', accent: '#a87fbf' },
      vision:       { icon: '👁', accent: '#7798c4' },
      prescription: { icon: '💊', accent: 'var(--tb-track-ai)' },
      other:        { icon: '📋', accent: 'var(--tb-text-soft)' },
    };
    const style = typeStyle[c.card_type] || typeStyle.other;

    // Top accent border + collapsible
    const details = el('details', {
      open: 'open',
      style: {
        borderLeft: '3px solid ' + style.accent,
        borderRadius: 'var(--tb-radius-2)',
        background: 'var(--tb-bg)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
      },
    });

    const titleBits = [c.insurer, c.plan_name].filter(Boolean);
    const title = c.label || (titleBits.length > 0 ? titleBits.join(' — ') : t('ht.notes.untitledCard'));

    const summary = el('summary', {
      style: { cursor: 'pointer', display: 'flex', alignItems: 'center',
        gap: 'var(--tb-sp-2)', fontWeight: '600', flexWrap: 'wrap', padding: '4px 0' },
    });
    summary.appendChild(el('span', { style: { fontSize: '18px' } }, style.icon));
    summary.appendChild(el('span', { style: { flex: '1', minWidth: '200px' } }, title));
    summary.appendChild(el('span', {
      style: { fontSize: '10px', padding: '1px 8px', borderRadius: 'var(--tb-radius-pill)',
        background: style.accent + '22', color: style.accent, fontWeight: '700',
        letterSpacing: '0.04em', textTransform: 'uppercase' },
    }, t('ht.notes.cards.type.' + (c.card_type || 'other'))));
    if (c.expiry_date) {
      summary.appendChild(el('span', { class: 'tb-card-meta', style: { fontSize: '11px' } },
        '· ' + t('ht.notes.expires') + ' ' + c.expiry_date));
    }
    details.appendChild(summary);

    // Body — grouped sections
    const body = el('div', { style: { marginTop: 'var(--tb-sp-2)', display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });

    // ─── Coverage section — bespoke layout (not the generic grid)
    // so Network/status pills, date range, and coverage-areas prose
    // each get the visual weight they deserve. CIGNA International
    // and similar plans pack a lot of detail in here.
    if (c.network_type || c.effective_date || c.expiry_date || c.coverage_areas || c.issuing_country) {
      body.appendChild(buildCoverageSection(c, style));
    }

    // ─── Benefits — deductible, OOP, copays, Rx coverage, referral.
    // Laid out to read like the back of the actual card: pill row,
    // money-summary grid, per-service list, free-form Rx + notes.
    const b = c.benefits || {};
    const hasBenefits = b.referral_required != null ||
      b.deductible_individual != null || b.deductible_family != null ||
      b.oop_max_individual != null || b.oop_max_family != null ||
      b.copay_pcp || b.copay_specialist || b.copay_urgent_care ||
      b.copay_er || b.copay_hospital ||
      b.rx_coverage || b.benefits_notes;
    if (hasBenefits) {
      body.appendChild(buildBenefitsSection(c, style));
    }

    // ─── Member
    const memberRows = [];
    if (c.member_name) memberRows.push([t('ht.notes.cards.field.memberName'), c.member_name]);
    if (c.member_id_last4) memberRows.push([t('ht.notes.cards.field.memberId'), '••••' + c.member_id_last4]);
    if (c.group_number) memberRows.push([t('ht.notes.cards.field.group'), c.group_number]);
    if (memberRows.length > 0) body.appendChild(buildCardSection('👤 ' + t('ht.notes.cards.section.member'), memberRows));

    // ─── Pharmacy
    const rxRows = [];
    if (c.bin) rxRows.push([t('ht.notes.cards.field.bin'), c.bin]);
    if (c.pcn) rxRows.push([t('ht.notes.cards.field.pcn'), c.pcn]);
    if (c.rx_group) rxRows.push([t('ht.notes.cards.field.rxGroup'), c.rx_group]);
    if (rxRows.length > 0) body.appendChild(buildCardSection('💊 ' + t('ht.notes.cards.section.pharmacy'), rxRows));

    // ─── PCP
    const pcpRows = [];
    if (c.pcp_name) pcpRows.push([t('ht.notes.cards.field.pcpName'), c.pcp_name]);
    if (c.pcp_phone) pcpRows.push([t('ht.notes.cards.field.pcpPhone'), formatPhoneLink(c.pcp_phone)]);
    if (pcpRows.length > 0) body.appendChild(buildCardSection('🩺 ' + t('ht.notes.cards.section.pcp'), pcpRows));

    // ─── Contact phones
    const contactRows = [];
    if (c.customer_service_phone) contactRows.push([t('ht.notes.cards.field.csPhone'), formatPhoneLink(c.customer_service_phone)]);
    if (c.member_services_phone) contactRows.push([t('ht.notes.cards.field.memberPhone'), formatPhoneLink(c.member_services_phone)]);
    if (c.claims_phone) contactRows.push([t('ht.notes.cards.field.claimsPhone'), formatPhoneLink(c.claims_phone)]);
    if (c.pharmacy_help_phone) contactRows.push([t('ht.notes.cards.field.rxPhone'), formatPhoneLink(c.pharmacy_help_phone)]);
    if (c.provider_services_phone) contactRows.push([t('ht.notes.cards.field.providerPhone'), formatPhoneLink(c.provider_services_phone)]);
    if (c.nurse_line_phone) contactRows.push([t('ht.notes.cards.field.nursePhone'), formatPhoneLink(c.nurse_line_phone)]);
    if (c.mental_health_phone) contactRows.push([t('ht.notes.cards.field.mhPhone'), formatPhoneLink(c.mental_health_phone)]);
    if (c.emergency_phone) contactRows.push([t('ht.notes.cards.field.emergencyPhone'), formatPhoneLink(c.emergency_phone)]);
    if (contactRows.length > 0) body.appendChild(buildCardSection('📞 ' + t('ht.notes.cards.section.contact'), contactRows));

    // ─── Online & Claims
    const onlineRows = [];
    if (c.claims_website) onlineRows.push([t('ht.notes.cards.field.claimsWeb'), formatWebLink(c.claims_website)]);
    if (c.member_portal) onlineRows.push([t('ht.notes.cards.field.portal'), formatWebLink(c.member_portal)]);
    if (c.mobile_app) onlineRows.push([t('ht.notes.cards.field.mobileApp'), c.mobile_app]);
    if (c.email) onlineRows.push([t('ht.notes.cards.field.email'), formatEmailLink(c.email)]);
    if (c.claims_address) onlineRows.push([t('ht.notes.cards.field.claimsAddr'), c.claims_address]);
    if (onlineRows.length > 0) body.appendChild(buildCardSection('🌐 ' + t('ht.notes.cards.section.online'), onlineRows));

    // ─── Notes (when present)
    if (c.notes) {
      const noteWrap = el('div', { style: { marginTop: 'var(--tb-sp-1)' } });
      noteWrap.appendChild(el('div', {
        style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--tb-text-soft)', marginBottom: '4px' },
      }, '📝 ' + t('ht.notes.cards.section.notes')));
      noteWrap.appendChild(el('div', { style: { whiteSpace: 'pre-wrap', fontSize: 'var(--tb-fs-12)' } }, c.notes));
      body.appendChild(noteWrap);
    }

    // ─── Vault link
    if (c.vault_doc_id) {
      const vaultItem = (TB.docVault && typeof TB.docVault.getItems === 'function')
        ? TB.docVault.getItems().find((d) => d.id === c.vault_doc_id) : null;
      if (vaultItem) {
        body.appendChild(el('div', {
          style: {
            padding: '6px 10px',
            background: 'rgba(46, 107, 92, 0.08)',
            borderRadius: 'var(--tb-radius-1)',
            fontSize: '11px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          },
        },
          el('span', null, '🔗 ' + t('ht.notes.linkedCard') + ': ', el('strong', null, vaultItem.title || c.insurer || t('ht.notes.untitledCard'))),
          el('button', {
            class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { fontSize: '11px', padding: '2px 8px' },
            onclick: () => {
              if (TB.docVault && typeof TB.docVault.openEditModal === 'function') {
                TB.docVault.openEditModal(vaultItem);
              }
            },
          }, '↗ ' + t('ht.notes.openInVault')),
        ));
      }
    }

    // Footer: action buttons
    const footer = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)', flexWrap: 'wrap' },
    });
    const leftBits = el('div', { class: 'tb-card-meta', style: { fontSize: '10px', fontFamily: 'var(--tb-font-mono)' } },
      c.ai_imported ? '✨ AI imported' : '',
    );
    footer.appendChild(leftBits);
    footer.appendChild(el('div', { style: { display: 'flex', gap: '6px' } },
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: '11px', padding: '2px 8px' },
        onclick: () => openInsuranceCardEditModal(c),
      }, '✎ ' + t('ht.notes.cards.edit')),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: '11px', padding: '2px 8px', color: 'var(--tb-error)' },
        onclick: () => {
          if (deleteInsuranceCardWithUndo(c.id)) rerender();
        },
      }, '× ' + t('ht.delete')),
    ));
    body.appendChild(footer);

    details.appendChild(body);
    return details;
  }

  // Bespoke "Coverage" section for the insurance card panel.
  // Visual hierarchy:
  //   • Top row: Network pill + Active/Expired status pill
  //   • Date range block: Effective → Expires + days-remaining
  //   • Coverage areas as a full-width prose block (no cramped grid)
  //   • Issuing country as small meta line at bottom
  // Significantly cleaner than the generic 2-column label-value grid
  // when a card has rich coverage detail.
  function buildCoverageSection(c, cardStyle) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const sec = el('div');

    // Section header
    sec.appendChild(el('div', {
      style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
        textTransform: 'uppercase', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-1)' },
    }, '📋 ' + t('ht.notes.cards.section.coverage')));

    // Top-row pills: Network + Active status
    const pillRow = el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: c.effective_date || c.expiry_date ? 'var(--tb-sp-2)' : '0' },
    });
    if (c.network_type) {
      pillRow.appendChild(el('span', {
        style: {
          fontSize: '11px', padding: '2px 10px', borderRadius: 'var(--tb-radius-pill)',
          background: cardStyle.accent + '22', color: cardStyle.accent,
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
        },
      }, c.network_type));
    }
    // Active / expired pill — derived from expiry_date
    if (c.expiry_date) {
      const daysLeft = daysUntil(c.expiry_date);
      let statusColor, statusLabel;
      if (daysLeft < 0) {
        statusColor = 'var(--tb-error)';
        statusLabel = t('ht.notes.cards.status.expired', { d: Math.abs(daysLeft) });
      } else if (daysLeft <= 30) {
        statusColor = 'var(--tb-warn)';
        statusLabel = t('ht.notes.cards.status.expiringSoon', { d: daysLeft });
      } else {
        statusColor = 'var(--tb-success)';
        statusLabel = t('ht.notes.cards.status.active', { d: daysLeft });
      }
      pillRow.appendChild(el('span', {
        style: {
          fontSize: '11px', padding: '2px 10px', borderRadius: 'var(--tb-radius-pill)',
          background: statusColor + '22', color: statusColor,
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
        },
      }, statusLabel));
    } else if (c.effective_date) {
      // No expiry but has effective — assume "no expiry / open-ended"
      pillRow.appendChild(el('span', {
        style: {
          fontSize: '11px', padding: '2px 10px', borderRadius: 'var(--tb-radius-pill)',
          background: 'var(--tb-success)22', color: 'var(--tb-success)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase',
        },
      }, t('ht.notes.cards.status.openEnded')));
    }
    if (pillRow.children.length > 0) sec.appendChild(pillRow);

    // Date range block — "Effective YYYY-MM-DD → Expires YYYY-MM-DD"
    if (c.effective_date || c.expiry_date) {
      const dateBlock = el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-3)',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev, rgba(0,0,0,0.02))',
          borderRadius: 'var(--tb-radius-1)',
          fontSize: 'var(--tb-fs-12)',
          flexWrap: 'wrap',
          marginBottom: c.coverage_areas || c.issuing_country ? 'var(--tb-sp-2)' : '0',
        },
      });
      if (c.effective_date) {
        dateBlock.appendChild(el('div', null,
          el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)' } },
            t('ht.notes.cards.field.effective')),
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } }, c.effective_date),
        ));
      }
      if (c.effective_date && c.expiry_date) {
        dateBlock.appendChild(el('span', { style: { color: 'var(--tb-text-soft)', fontSize: '16px' } }, '→'));
      }
      if (c.expiry_date) {
        dateBlock.appendChild(el('div', null,
          el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)' } },
            t('ht.notes.cards.field.expires')),
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } }, c.expiry_date),
        ));
      }
      sec.appendChild(dateBlock);
    }

    // Coverage areas — full-width prose block, not cramped into the grid
    if (c.coverage_areas) {
      const areaBlock = el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev, rgba(0,0,0,0.02))',
          borderLeft: '2px solid ' + cardStyle.accent,
          borderRadius: 'var(--tb-radius-1)',
          marginBottom: c.issuing_country ? 'var(--tb-sp-2)' : '0',
        },
      });
      areaBlock.appendChild(el('div', {
        style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--tb-text-soft)', marginBottom: '4px' },
      }, '🌍 ' + t('ht.notes.cards.field.coverageAreas')));
      areaBlock.appendChild(el('div', {
        style: { fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)', whiteSpace: 'pre-wrap' },
      }, c.coverage_areas));
      sec.appendChild(areaBlock);
    }

    // Issuing country — small meta line
    if (c.issuing_country) {
      sec.appendChild(el('div', {
        class: 'tb-card-meta',
        style: { fontSize: '11px', display: 'flex', gap: '4px' },
      },
        el('span', null, t('ht.notes.cards.field.country') + ':'),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, c.issuing_country),
      ));
    }

    return sec;
  }

  // Benefits panel — reads like the actual card's "what's covered"
  // summary. Sections:
  //   • Referral pill (✓ No referral required / ⚠ Referral required)
  //   • Deductible + OOP Max side-by-side block (individual/family)
  //   • Service coverage list (PCP, specialist, urgent care, ER, hospital)
  //   • Rx coverage prose
  //   • Free-form benefits notes
  function buildBenefitsSection(c, cardStyle) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const b = c.benefits || {};
    const sec = el('div');
    const currency = b.currency || 'USD';
    const sym = ({ USD: '$', JPY: '¥', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', CHF: 'Fr.' })[currency] || (currency + ' ');
    function fmtMoney(v) {
      if (v == null || !isFinite(v)) return '—';
      // JPY rarely has decimals; others usually do but for round
      // benefit amounts ($300, $2100) decimals add noise — show them
      // only when fractional.
      const n = Number(v);
      const isWhole = Math.abs(n - Math.round(n)) < 0.005;
      return sym + (isWhole ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    }

    // Section header
    sec.appendChild(el('div', {
      style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
        textTransform: 'uppercase', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-1)' },
    }, '💰 ' + t('ht.notes.cards.section.benefits')));

    // Referral pill (when explicitly set, since "unknown" is meaningful)
    if (b.referral_required === true || b.referral_required === false) {
      const refPill = b.referral_required === false
        ? { icon: '✓', label: t('ht.notes.cards.field.noReferral'), color: 'var(--tb-success)' }
        : { icon: '⚠', label: t('ht.notes.cards.field.referralReq'), color: 'var(--tb-warn)' };
      sec.appendChild(el('div', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px',
          padding: '3px 10px', borderRadius: 'var(--tb-radius-pill)',
          background: refPill.color + '22', color: refPill.color,
          fontSize: '11px', fontWeight: '700', letterSpacing: '0.04em',
          textTransform: 'uppercase',
          marginBottom: 'var(--tb-sp-2)' },
      }, refPill.icon + ' ' + refPill.label));
    }

    // Deductible + OOP Max grid (each shows individual / family)
    const hasDed = b.deductible_individual != null || b.deductible_family != null;
    const hasOop = b.oop_max_individual != null || b.oop_max_family != null;
    if (hasDed || hasOop) {
      const moneyGrid = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 'var(--tb-sp-2)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      function moneyBlock(label, indiv, family) {
        const blk = el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'var(--tb-bg-elev, rgba(0,0,0,0.02))',
            borderRadius: 'var(--tb-radius-1)',
          },
        });
        blk.appendChild(el('div', {
          style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em',
            color: 'var(--tb-text-soft)', marginBottom: '4px' },
        }, label));
        const row = el('div', {
          style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap', fontFamily: 'var(--tb-font-mono)' },
        });
        if (indiv != null) {
          row.appendChild(el('div', null,
            el('span', { style: { fontWeight: '600' } }, fmtMoney(indiv)),
            el('span', { class: 'tb-card-meta', style: { fontSize: '10px', marginLeft: '4px' } },
              t('ht.notes.cards.field.individual')),
          ));
        }
        if (family != null) {
          row.appendChild(el('div', null,
            el('span', { style: { fontWeight: '600' } }, fmtMoney(family)),
            el('span', { class: 'tb-card-meta', style: { fontSize: '10px', marginLeft: '4px' } },
              t('ht.notes.cards.field.family')),
          ));
        }
        blk.appendChild(row);
        return blk;
      }
      if (hasDed) moneyGrid.appendChild(moneyBlock(t('ht.notes.cards.field.deductible'),
        b.deductible_individual, b.deductible_family));
      if (hasOop) moneyGrid.appendChild(moneyBlock(t('ht.notes.cards.field.oopMax'),
        b.oop_max_individual, b.oop_max_family));
      sec.appendChild(moneyGrid);
    }

    // Service coverage list (PCP visit, specialist, urgent care, ER, hospital)
    const services = [
      { key: 'copay_pcp',          label: t('ht.notes.cards.svc.pcp') },
      { key: 'copay_specialist',   label: t('ht.notes.cards.svc.specialist') },
      { key: 'copay_urgent_care',  label: t('ht.notes.cards.svc.urgent') },
      { key: 'copay_er',           label: t('ht.notes.cards.svc.er') },
      { key: 'copay_hospital',     label: t('ht.notes.cards.svc.hospital') },
    ];
    const filledServices = services.filter((s) => b[s.key]);
    if (filledServices.length > 0) {
      const svcBlock = el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev, rgba(0,0,0,0.02))',
          borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      svcBlock.appendChild(el('div', {
        style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--tb-text-soft)', marginBottom: '6px' },
      }, t('ht.notes.cards.section.svcCoverage')));
      const grid = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'minmax(120px, max-content) 1fr',
          gap: '4px 12px', fontSize: 'var(--tb-fs-12)' },
      });
      for (const s of filledServices) {
        grid.appendChild(el('span', { class: 'tb-card-meta' }, s.label));
        grid.appendChild(el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, b[s.key]));
      }
      svcBlock.appendChild(grid);
      sec.appendChild(svcBlock);
    }

    // Rx coverage — prose block
    if (b.rx_coverage) {
      const rxBlock = el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev, rgba(0,0,0,0.02))',
          borderLeft: '2px solid ' + cardStyle.accent,
          borderRadius: 'var(--tb-radius-1)',
          marginBottom: b.benefits_notes ? 'var(--tb-sp-2)' : '0',
        },
      });
      rxBlock.appendChild(el('div', {
        style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--tb-text-soft)', marginBottom: '4px' },
      }, '💊 ' + t('ht.notes.cards.field.rxCoverage')));
      rxBlock.appendChild(el('div', {
        style: { fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)', whiteSpace: 'pre-wrap' },
      }, b.rx_coverage));
      sec.appendChild(rxBlock);
    }

    // Free-form benefits notes (anything else worth keeping)
    if (b.benefits_notes) {
      sec.appendChild(el('div', {
        style: { fontSize: 'var(--tb-fs-12)', lineHeight: 'var(--tb-lh-body)',
          whiteSpace: 'pre-wrap', color: 'var(--tb-text-soft)', fontStyle: 'italic' },
      }, b.benefits_notes));
    }

    return sec;
  }

  // Helper: a grouped section in the card panel (label + rows of label:value)
  function buildCardSection(label, rows) {
    const el = TB.utils.el;
    if (rows.length === 0) return el('div');
    const sec = el('div');
    sec.appendChild(el('div', {
      style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
        textTransform: 'uppercase', color: 'var(--tb-text-soft)', marginBottom: '4px' },
    }, label));
    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr',
        gap: '2px 12px', fontSize: 'var(--tb-fs-12)', lineHeight: '1.5' },
    });
    for (const [k, v] of rows) {
      grid.appendChild(el('span', { class: 'tb-card-meta' }, k));
      const valNode = (v && typeof v === 'object' && v.nodeType) ? v : el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, String(v));
      grid.appendChild(valNode);
    }
    sec.appendChild(grid);
    return sec;
  }

  function formatPhoneLink(raw) {
    const el = TB.utils.el;
    const digits = String(raw || '').replace(/[^\d+]/g, '');
    if (!digits) return el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, raw || '');
    return el('a', {
      href: 'tel:' + digits,
      style: { color: 'var(--tb-track-health)', fontFamily: 'var(--tb-font-mono)' },
    }, raw);
  }
  function formatWebLink(raw) {
    const el = TB.utils.el;
    const url = /^https?:\/\//.test(raw) ? raw : ('https://' + raw);
    return el('a', {
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: { color: 'var(--tb-track-health)', wordBreak: 'break-all' },
    }, raw);
  }
  function formatEmailLink(raw) {
    const el = TB.utils.el;
    return el('a', {
      href: 'mailto:' + raw,
      style: { color: 'var(--tb-track-health)' },
    }, raw);
  }

  // ====================================================================
  // Insurance card vision import
  // ====================================================================
  //
  // openInsuranceCardImportModal()
  //   • Drop zone for PDF/image of an insurance card
  //   • Calls TB.ai.callClaudeVisionForInsuranceCard
  //   • Prefills the Insurance Summary fields (member ID last 4 only)
  //   • ALSO creates a Document Vault item (category='insurance',
  //     type='insurance_health', linked_module='health-tracker') so
  //     the card surfaces in the vault's expiry tracking and renewal
  //     reminders. Stores vault_doc_id back on the insurance_summary
  //     for the bi-directional link.

  function openInsuranceCardImportModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🪪 ' + t('ht.notes.import.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.notes.import.intro')));

    const status = el('div', { style: { marginTop: 'var(--tb-sp-2)', minHeight: '1.4em', fontSize: 'var(--tb-fs-12)' } });

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf',
      style: { display: 'none' },
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) handleUpload(f);
        e.target.value = '';
      },
    });

    const dropZone = el('div', {
      style: {
        border: '1px dashed var(--tb-border)', borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-4)', textAlign: 'center', background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-2)' } }, t('ht.notes.import.dropTitle')),
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } }, t('ht.notes.import.dropHelp')),
      el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => fileInput.click(),
      }, '📎 ' + t('ht.import.choose')),
      fileInput,
    );
    if (TB.utils && typeof TB.utils.attachFileDrop === 'function') {
      TB.utils.attachFileDrop(dropZone, {
        accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
        text: '⤓ ' + t('ht.import.dropOver'),
        onFile: (f) => handleUpload(f),
        onError: (msg) => { status.textContent = '✗ ' + msg; status.style.color = 'var(--tb-error)'; },
      });
    }
    modal.appendChild(dropZone);
    modal.appendChild(status);

    async function handleUpload(file) {
      status.textContent = '⏳ ' + t('ht.notes.import.processing', { name: file.name });
      status.style.color = 'var(--tb-text-soft)';
      try {
        const result = await TB.ai.callClaudeVisionForInsuranceCard(file, {});
        const ext = result.extracted || {};
        const cost = (result.cost_usd || 0).toFixed(4);
        status.textContent = '✓ ' + t('ht.notes.import.done', { cost });
        status.style.color = 'var(--tb-success)';
        // Show review screen with extracted fields. User confirms,
        // then we save to both insurance_summary and vault.
        modal.innerHTML = '';
        renderInsuranceCardReview(modal, ext, file, Number(result.cost_usd) || 0, close);
      } catch (err) {
        status.textContent = '✗ ' + (err.message || err);
        status.style.color = 'var(--tb-error)';
      }
    }

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
    ));

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // Review screen — shows extracted card metadata before save, with
  // privacy-conscious treatment: full member ID is never stored, only
  // last 4 digits per the extraction prompt's contract.
  function renderInsuranceCardReview(modal, ext, originalFile, costUsd, close) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🪪 ' + t('ht.notes.import.review.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.notes.import.review.intro')));

    // Preview card — show every non-null extracted field
    const previewCard = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '3px solid var(--tb-track-health)',
        borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)',
      },
    });
    const headBits = [];
    if (ext.insurer) headBits.push(ext.insurer);
    if (ext.plan_name) headBits.push(ext.plan_name);
    previewCard.appendChild(el('div', { style: { fontWeight: '600' } },
      headBits.length > 0 ? headBits.join(' · ') : t('ht.notes.import.review.unknownIssuer')));

    const fieldsList = el('div', { style: { marginTop: 'var(--tb-sp-2)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 'var(--tb-fs-12)' } });
    function previewField(labelKey, value) {
      if (value == null || value === '') return;
      fieldsList.appendChild(el('span', { class: 'tb-card-meta' }, t(labelKey)));
      fieldsList.appendChild(el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, String(value)));
    }
    previewField('ht.notes.import.review.network', ext.network_type);
    previewField('ht.notes.import.review.coverage', ext.coverage_type);
    if (ext.member_id_last4) previewField('ht.notes.import.review.memberId', '••••' + ext.member_id_last4);
    previewField('ht.notes.import.review.member', ext.member_name);
    previewField('ht.notes.import.review.group', ext.group_number);
    previewField('ht.notes.import.review.bin', ext.bin);
    previewField('ht.notes.import.review.pcn', ext.pcn);
    previewField('ht.notes.import.review.rxGroup', ext.rx_group);
    previewField('ht.notes.import.review.pcp', ext.pcp_name);
    previewField('ht.notes.import.review.pcpPhone', ext.pcp_phone);
    previewField('ht.notes.import.review.csPhone', ext.customer_service_phone);
    previewField('ht.notes.import.review.memberPhone', ext.member_services_phone);
    previewField('ht.notes.import.review.rxPhone', ext.pharmacy_help_phone);
    previewField('ht.notes.import.review.effective', ext.effective_date);
    previewField('ht.notes.import.review.expires', ext.expiry_date);
    previewField('ht.notes.import.review.country', ext.issuing_country);
    if (ext.notes_suggestion) previewField('ht.notes.import.review.notes', ext.notes_suggestion);
    previewCard.appendChild(fieldsList);

    // Privacy callout
    previewCard.appendChild(el('div', {
      style: { marginTop: 'var(--tb-sp-2)', padding: '6px 10px',
        background: 'rgba(46, 107, 92, 0.08)',
        borderRadius: 'var(--tb-radius-1)',
        fontSize: '11px', fontStyle: 'italic', color: 'var(--tb-text-soft)' },
    }, '🔒 ' + t('ht.notes.import.review.privacy')));

    modal.appendChild(previewCard);

    // Save controls — checkbox for vault save (default on), confirm + cancel
    const saveToVault = { value: true };
    modal.appendChild(el('label', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: 'var(--tb-sp-3)' },
    },
      el('input', {
        type: 'checkbox', checked: true,
        onchange: (e) => { saveToVault.value = !!e.target.checked; },
      }),
      el('span', null, t('ht.notes.import.review.saveToVault')),
    ));

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
      el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => {
          applyInsuranceCardExtraction(ext, originalFile, costUsd, saveToVault.value);
          close();
          rerender();
        },
      }, '✓ ' + t('ht.notes.import.review.save')),
    ));
  }

  // Persist the extracted card data as a new entry in
  // insurance_summary.cards[] (so dental + vision + medical can
  // coexist), and optionally create a Document Vault item with
  // bidirectional linking.
  function applyInsuranceCardExtraction(ext, originalFile, costUsd, saveToVault) {
    const cardType = (ext.coverage_type === 'dental' || ext.coverage_type === 'vision' ||
                      ext.coverage_type === 'prescription') ? ext.coverage_type
                   : (ext.coverage_type === 'medical' || ext.coverage_type === 'combined') ? ext.coverage_type
                   : 'medical';

    const cardId = (TB.utils && TB.utils.uuid)
      ? TB.utils.uuid()
      : ('card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));

    let vaultDocId = null;
    if (saveToVault && TB.docVault && typeof TB.docVault.upsertItem === 'function') {
      vaultDocId = (TB.utils && TB.utils.uuid)
        ? TB.utils.uuid()
        : ('vault-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
      const titleBits = [ext.insurer, ext.plan_name].filter(Boolean);
      const docTitle = titleBits.length > 0 ? titleBits.join(' — ') :
        (cardType === 'dental' ? 'Dental insurance card' :
         cardType === 'vision' ? 'Vision insurance card' :
         'Health insurance card');
      // Brief notes for the vault item — full structured fields live
      // on the card itself, not duplicated in the vault notes.
      const docNotes = [
        ext.network_type ? 'Network: ' + ext.network_type : '',
        ext.coverage_areas ? 'Coverage: ' + ext.coverage_areas : '',
        ext.notes_suggestion || '',
      ].filter(Boolean).join('\n');
      TB.docVault.upsertItem({
        id: vaultDocId,
        category: 'insurance',
        type: 'insurance_health',
        title: docTitle,
        person_name: ext.member_name || (TB.state.get('profile.displayName') || ''),
        issuing_authority: ext.insurer || '',
        issue_date: ext.effective_date || null,
        expiry_date: ext.expiry_date || null,
        reference_number_last4: ext.member_id_last4 || null,
        storage_location: originalFile ? originalFile.name : '',
        notes: docNotes,
        linked_module: 'health-tracker',
        linked_id: 'insurance_summary',
        ai_imported: true,
        ai_cost_usd: costUsd,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // Benefits sub-object — preserve all the structured-coverage detail
    // the AI extracted (deductible, OOP, copays, Rx, referral).
    const extBenefits = (ext && ext.benefits) || {};
    const benefits = {
      referral_required: typeof extBenefits.referral_required === 'boolean' ? extBenefits.referral_required : null,
      deductible_individual: (typeof extBenefits.deductible_individual === 'number' && isFinite(extBenefits.deductible_individual)) ? extBenefits.deductible_individual : null,
      deductible_family: (typeof extBenefits.deductible_family === 'number' && isFinite(extBenefits.deductible_family)) ? extBenefits.deductible_family : null,
      oop_max_individual: (typeof extBenefits.oop_max_individual === 'number' && isFinite(extBenefits.oop_max_individual)) ? extBenefits.oop_max_individual : null,
      oop_max_family: (typeof extBenefits.oop_max_family === 'number' && isFinite(extBenefits.oop_max_family)) ? extBenefits.oop_max_family : null,
      currency: extBenefits.currency || 'USD',
      copay_pcp: extBenefits.copay_pcp || '',
      copay_specialist: extBenefits.copay_specialist || '',
      copay_urgent_care: extBenefits.copay_urgent_care || '',
      copay_er: extBenefits.copay_er || '',
      copay_hospital: extBenefits.copay_hospital || '',
      rx_coverage: extBenefits.rx_coverage || '',
      benefits_notes: extBenefits.benefits_notes || '',
    };

    upsertInsuranceCard({
      id: cardId,
      card_type: cardType,
      label: '',
      insurer: ext.insurer || '',
      plan_name: ext.plan_name || '',
      network_type: ext.network_type || '',
      coverage_type: ext.coverage_type || cardType,
      member_name: ext.member_name || '',
      member_id_last4: ext.member_id_last4 || '',
      group_number: ext.group_number || '',
      effective_date: ext.effective_date || null,
      expiry_date: ext.expiry_date || null,
      bin: ext.bin || '',
      pcn: ext.pcn || '',
      rx_group: ext.rx_group || '',
      pcp_name: ext.pcp_name || '',
      pcp_phone: ext.pcp_phone || '',
      customer_service_phone: ext.customer_service_phone || '',
      member_services_phone: ext.member_services_phone || '',
      claims_phone: ext.claims_phone || '',
      pharmacy_help_phone: ext.pharmacy_help_phone || '',
      provider_services_phone: ext.provider_services_phone || '',
      emergency_phone: ext.emergency_phone || '',
      nurse_line_phone: ext.nurse_line_phone || '',
      mental_health_phone: ext.mental_health_phone || '',
      claims_website: ext.claims_website || '',
      claims_address: ext.claims_address || '',
      member_portal: ext.member_portal || '',
      mobile_app: ext.mobile_app || '',
      email: ext.email || '',
      issuing_country: ext.issuing_country || '',
      coverage_areas: ext.coverage_areas || '',
      benefits,
      notes: ext.notes_suggestion || '',
      vault_doc_id: vaultDocId,
      ai_imported: true,
      ai_cost_usd: costUsd,
      filename: originalFile ? originalFile.name : '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  // ─── Card edit modal ─────────────────────────────────────────────
  //
  // Sectioned form — same grouping as the read-view panel. Card_type
  // picker at top determines which sections are most relevant
  // (pharmacy fields are most useful on medical/Rx cards; less so on
  // dental/vision).
  function openInsuranceCardEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    // Re-fetch from state to avoid stale-object renders (same pattern
    // we use throughout the module after canonicalize/recompute sweeps).
    if (existing && existing.id) {
      const fresh = getInsuranceCards().find((c) => c.id === existing.id);
      if (fresh) existing = fresh;
    }
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: (TB.utils && TB.utils.uuid) ? TB.utils.uuid()
        : ('card-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
      card_type: 'medical',
      label: '',
      insurer: '', plan_name: '', network_type: '', coverage_type: 'medical',
      member_name: '', member_id_last4: '', group_number: '',
      effective_date: null, expiry_date: null,
      bin: '', pcn: '', rx_group: '',
      pcp_name: '', pcp_phone: '',
      customer_service_phone: '', member_services_phone: '', claims_phone: '',
      pharmacy_help_phone: '', provider_services_phone: '', emergency_phone: '',
      nurse_line_phone: '', mental_health_phone: '',
      claims_website: '', claims_address: '', member_portal: '', mobile_app: '', email: '',
      issuing_country: '', coverage_areas: '', notes: '',
      benefits: {
        referral_required: null,
        deductible_individual: null, deductible_family: null,
        oop_max_individual: null, oop_max_family: null,
        currency: 'USD',
        copay_pcp: '', copay_specialist: '', copay_urgent_care: '',
        copay_er: '', copay_hospital: '',
        rx_coverage: '', benefits_notes: '',
      },
      vault_doc_id: null,
      ai_imported: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Ensure benefits exists even on legacy cards being edited
    if (!draft.benefits) {
      draft.benefits = {
        referral_required: null,
        deductible_individual: null, deductible_family: null,
        oop_max_individual: null, oop_max_family: null,
        currency: 'USD',
        copay_pcp: '', copay_specialist: '', copay_urgent_care: '',
        copay_er: '', copay_hospital: '',
        rx_coverage: '', benefits_notes: '',
      };
    }

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('button', { class: 'tb-modal-close', type: 'button', onclick: close }, '×'));
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isEdit ? '🪪 ' + t('ht.notes.cards.edit.title') : '🪪 ' + t('ht.notes.cards.add.title')));

    // Card type picker
    modal.appendChild(field(t('ht.notes.cards.field.cardType'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.card_type = e.target.value; },
    },
      ['medical', 'dental', 'vision', 'prescription', 'combined', 'other'].map((tt) =>
        el('option', { value: tt, selected: draft.card_type === tt }, t('ht.notes.cards.type.' + tt))),
    ), t('ht.notes.cards.field.cardType.help')));

    // ─── Plan basics
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '📋 ' + t('ht.notes.cards.section.basics')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.insurer'), textInput(draft.insurer, (v) => draft.insurer = v)),
      field(t('ht.notes.cards.field.plan'), textInput(draft.plan_name, (v) => draft.plan_name = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.network'), textInput(draft.network_type, (v) => draft.network_type = v),
        t('ht.notes.cards.field.network.help')),
      field(t('ht.notes.cards.field.country'), textInput(draft.issuing_country, (v) => draft.issuing_country = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.effective'), dateInput(draft.effective_date, (v) => draft.effective_date = v || null)),
      field(t('ht.notes.cards.field.expires'), dateInput(draft.expiry_date, (v) => draft.expiry_date = v || null)),
    ));
    modal.appendChild(field(t('ht.notes.cards.field.coverageAreas'),
      textInput(draft.coverage_areas, (v) => draft.coverage_areas = v),
      t('ht.notes.cards.field.coverageAreas.help')));

    // ─── Benefits (deductible, OOP, copays, Rx, referral)
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '💰 ' + t('ht.notes.cards.section.benefits')));
    // Referral toggle — tri-state (yes / no / unknown). We model as a
    // select rather than checkbox so "unknown" stays explicit.
    modal.appendChild(field(t('ht.notes.cards.field.referral'), el('select', {
      class: 'tb-select',
      onchange: (e) => {
        const v = e.target.value;
        draft.benefits.referral_required = v === 'yes' ? true : v === 'no' ? false : null;
      },
    },
      el('option', { value: '', selected: draft.benefits.referral_required == null }, t('ht.notes.cards.field.referral.unknown')),
      el('option', { value: 'no', selected: draft.benefits.referral_required === false }, t('ht.notes.cards.field.referral.no')),
      el('option', { value: 'yes', selected: draft.benefits.referral_required === true }, t('ht.notes.cards.field.referral.yes')),
    )));
    // Currency
    modal.appendChild(field(t('ht.notes.cards.field.currency'), el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.benefits.currency = e.target.value; },
    },
      ['USD', 'JPY', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF'].map((cur) =>
        el('option', { value: cur, selected: draft.benefits.currency === cur }, cur)),
    )));
    // Deductible
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.deductibleIndiv'),
        numInput(draft.benefits.deductible_individual, (v) => { draft.benefits.deductible_individual = v; })),
      field(t('ht.notes.cards.field.deductibleFam'),
        numInput(draft.benefits.deductible_family, (v) => { draft.benefits.deductible_family = v; })),
    ));
    // OOP Max
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.oopIndiv'),
        numInput(draft.benefits.oop_max_individual, (v) => { draft.benefits.oop_max_individual = v; })),
      field(t('ht.notes.cards.field.oopFam'),
        numInput(draft.benefits.oop_max_family, (v) => { draft.benefits.oop_max_family = v; })),
    ));
    // Per-service copays — free-form text since formats vary
    // ("$25" / "Ded/80%" / "100%" / "20% after deductible")
    modal.appendChild(el('div', {
      class: 'tb-field-help',
      style: { fontSize: '11px', marginBottom: 'var(--tb-sp-1)' },
    }, t('ht.notes.cards.field.copay.help')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.svc.pcp'),
        textInput(draft.benefits.copay_pcp, (v) => { draft.benefits.copay_pcp = v; })),
      field(t('ht.notes.cards.svc.specialist'),
        textInput(draft.benefits.copay_specialist, (v) => { draft.benefits.copay_specialist = v; })),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.svc.urgent'),
        textInput(draft.benefits.copay_urgent_care, (v) => { draft.benefits.copay_urgent_care = v; })),
      field(t('ht.notes.cards.svc.er'),
        textInput(draft.benefits.copay_er, (v) => { draft.benefits.copay_er = v; })),
    ));
    modal.appendChild(field(t('ht.notes.cards.svc.hospital'),
      textInput(draft.benefits.copay_hospital, (v) => { draft.benefits.copay_hospital = v; })));
    // Rx coverage — multi-line since formats can be verbose
    // ("Not covered US INN/OON; International 80%")
    modal.appendChild(field(t('ht.notes.cards.field.rxCoverage'),
      textareaInput(draft.benefits.rx_coverage, (v) => { draft.benefits.rx_coverage = v; }),
      t('ht.notes.cards.field.rxCoverage.help')));
    // Free-form benefits notes
    modal.appendChild(field(t('ht.notes.cards.field.benefitsNotes'),
      textareaInput(draft.benefits.benefits_notes, (v) => { draft.benefits.benefits_notes = v; }),
      t('ht.notes.cards.field.benefitsNotes.help')));

    // ─── Member
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '👤 ' + t('ht.notes.cards.section.member')));
    modal.appendChild(field(t('ht.notes.cards.field.memberName'),
      textInput(draft.member_name, (v) => draft.member_name = v)));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.memberId'),
        textInput(draft.member_id_last4, (v) => draft.member_id_last4 = v),
        t('ht.notes.cards.field.memberId.help')),
      field(t('ht.notes.cards.field.group'),
        textInput(draft.group_number, (v) => draft.group_number = v)),
    ));

    // ─── Pharmacy (medical/Rx/combined only)
    const showRx = draft.card_type === 'medical' || draft.card_type === 'combined' || draft.card_type === 'prescription';
    if (showRx) {
      modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
        '💊 ' + t('ht.notes.cards.section.pharmacy')));
      modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--tb-sp-3)' } },
        field(t('ht.notes.cards.field.bin'), textInput(draft.bin, (v) => draft.bin = v)),
        field(t('ht.notes.cards.field.pcn'), textInput(draft.pcn, (v) => draft.pcn = v)),
        field(t('ht.notes.cards.field.rxGroup'), textInput(draft.rx_group, (v) => draft.rx_group = v)),
      ));
    }

    // ─── PCP (medical/combined only)
    if (draft.card_type === 'medical' || draft.card_type === 'combined') {
      modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
        '🩺 ' + t('ht.notes.cards.section.pcp')));
      modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
        field(t('ht.notes.cards.field.pcpName'), textInput(draft.pcp_name, (v) => draft.pcp_name = v)),
        field(t('ht.notes.cards.field.pcpPhone'), textInput(draft.pcp_phone, (v) => draft.pcp_phone = v)),
      ));
    }

    // ─── Contact phones (always)
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '📞 ' + t('ht.notes.cards.section.contact')));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.csPhone'), textInput(draft.customer_service_phone, (v) => draft.customer_service_phone = v)),
      field(t('ht.notes.cards.field.memberPhone'), textInput(draft.member_services_phone, (v) => draft.member_services_phone = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.claimsPhone'), textInput(draft.claims_phone, (v) => draft.claims_phone = v)),
      field(t('ht.notes.cards.field.providerPhone'), textInput(draft.provider_services_phone, (v) => draft.provider_services_phone = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.rxPhone'), textInput(draft.pharmacy_help_phone, (v) => draft.pharmacy_help_phone = v)),
      field(t('ht.notes.cards.field.nursePhone'), textInput(draft.nurse_line_phone, (v) => draft.nurse_line_phone = v)),
    ));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.mhPhone'), textInput(draft.mental_health_phone, (v) => draft.mental_health_phone = v)),
      field(t('ht.notes.cards.field.emergencyPhone'), textInput(draft.emergency_phone, (v) => draft.emergency_phone = v)),
    ));

    // ─── Online & Claims
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '🌐 ' + t('ht.notes.cards.section.online')));
    modal.appendChild(field(t('ht.notes.cards.field.claimsWeb'),
      textInput(draft.claims_website, (v) => draft.claims_website = v)));
    modal.appendChild(field(t('ht.notes.cards.field.portal'),
      textInput(draft.member_portal, (v) => draft.member_portal = v)));
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.notes.cards.field.mobileApp'), textInput(draft.mobile_app, (v) => draft.mobile_app = v)),
      field(t('ht.notes.cards.field.email'), textInput(draft.email, (v) => draft.email = v)),
    ));
    modal.appendChild(field(t('ht.notes.cards.field.claimsAddr'),
      textareaInput(draft.claims_address, (v) => draft.claims_address = v),
      t('ht.notes.cards.field.claimsAddr.help')));

    // ─── Notes
    modal.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } },
      '📝 ' + t('ht.notes.cards.section.notes')));
    modal.appendChild(textareaInput(draft.notes, (v) => draft.notes = v));

    // Buttons
    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' },
    });
    if (isEdit) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          if (!deleteInsuranceCardWithUndo(draft.id)) return;
          close();
          rerender();
        },
      }, t('ht.delete')));
    } else {
      btnRow.appendChild(el('span'));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        upsertInsuranceCard(draft);
        close();
        rerender();
      },
    }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Exam edit modal — the workhorse
  // ====================================================================

  function openExamEditModal(existing, prefill) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    // Re-fetch from state so callers holding a stale `existing`
    // reference (e.g., after a canonicalization sweep updated the
    // facility name, or after an invoice attach upgraded a field) see
    // the latest values when reopening the modal.
    if (existing && existing.id) {
      const fresh = getExams().find((e) => e.id === existing.id);
      if (fresh) existing = fresh;
    }
    const isEdit = !!existing;
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : Object.assign({
      id: 'exam-' + Date.now().toString(36),
      date: new Date().toISOString().slice(0, 10),
      type: 'blood_panel',
      provider: '',
      facility: '',
      vitals: {},
      lab_results: [],
      diagnoses: [],
      procedures: [],
      followup: '',
      notes: '',
      ai_summary: '',
      linked_doc_id: null,
      linked_consultation_id: null,
      created_at: new Date().toISOString(),
    }, prefill || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('button', { class: 'tb-modal-close', type: 'button', onclick: close }, '×'));
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      (isEdit ? t('ht.exams.edit') : t('ht.exams.addTitle'))));

    // Top fields: type, date, provider, facility
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.exams.field.type'), el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.type = e.target.value; },
      }, EXAM_TYPES.map((et) => el('option', { value: et.id, selected: draft.type === et.id }, lang === 'ja' ? et.label_jp : et.label_en)))),
      field(t('ht.exams.field.date'), dateInput(draft.date, (v) => { draft.date = v; })),
    ));
    const providerInput = textInput(draft.provider, (v) => { draft.provider = v; });
    const facilityInput = textInput(draft.facility, (v) => { draft.facility = v; });
    modal.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
      field(t('ht.exams.field.provider'), providerInput),
      field(t('ht.exams.field.facility'), facilityInput),
    ));
    // ✨ Enhance provider info — fills in missing facility / appends
    // address+phone+website to notes using AI public-knowledge lookup.
    const hasKeyForEnrich = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (hasKeyForEnrich) {
      const enrichStatus = el('span', {
        style: { fontSize: '11px', color: 'var(--tb-text-soft)', marginLeft: 'var(--tb-sp-2)' },
      });
      modal.appendChild(el('div', {
        style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', marginTop: '-4px',
          marginBottom: 'var(--tb-sp-2)', flexWrap: 'wrap' },
      },
        el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { fontSize: '11px', padding: '2px 10px', color: 'var(--tb-track-ai)' },
          onclick: async (e) => {
            if (!draft.provider && !draft.facility) {
              enrichStatus.textContent = '⚠ ' + t('ht.exams.field.provider.enhance.needName');
              enrichStatus.style.color = 'var(--tb-warn)';
              return;
            }
            const btn = e.target;
            btn.disabled = true;
            enrichStatus.textContent = '⏳ ' + t('ht.exams.field.provider.enhance.processing');
            enrichStatus.style.color = 'var(--tb-text-soft)';
            try {
              const result = await TB.ai.callClaudeForProviderEnrichment({
                name_en: draft.provider, name_jp: '', type: examTypeLabel(draft.type),
                address: draft.facility, phone: '',
              });
              const en = result.extracted || {};
              const filled = [];
              // Facility: if blank, fill with address; otherwise append
              if (!draft.facility && en.address) { draft.facility = en.address; facilityInput.value = en.address; filled.push('facility'); }
              // Append phone / website / hours / specialties to notes
              const extras = [];
              if (en.phone) extras.push('☎ ' + en.phone);
              if (en.website) extras.push('🌐 ' + en.website);
              if (en.hours) extras.push('🕒 ' + en.hours);
              if (en.specialties) extras.push('Specialties: ' + en.specialties);
              if (en.notes) extras.push(en.notes);
              if (en.name_jp && !/[　-鿿]/.test(draft.provider || '')) {
                extras.unshift('JP: ' + en.name_jp);
              }
              if (extras.length > 0) {
                const cur = (draft.notes || '').trim();
                const block = '— Provider info (AI enhanced) —\n' + extras.join('\n');
                draft.notes = cur ? cur + '\n\n' + block : block;
                filled.push('notes');
              }
              const cost = (result.cost_usd || 0).toFixed(4);
              if (filled.length === 0) {
                enrichStatus.textContent = '⚠ ' + t('ht.exams.field.provider.enhance.nothing') + ' · $' + cost;
                enrichStatus.style.color = 'var(--tb-warn)';
              } else if (en.confidence === 'unknown' || en.confidence === 'low') {
                enrichStatus.textContent = '⚠ ' + t('ht.exams.field.provider.enhance.lowConf', { confidence: en.confidence }) + ' · $' + cost;
                enrichStatus.style.color = 'var(--tb-warn)';
              } else {
                enrichStatus.textContent = '✓ ' + t('ht.exams.field.provider.enhance.done', { n: filled.length, cost });
                enrichStatus.style.color = 'var(--tb-success)';
              }
              btn.disabled = false;
            } catch (err) {
              enrichStatus.textContent = '✗ ' + (err.message || err);
              enrichStatus.style.color = 'var(--tb-error)';
              btn.disabled = false;
            }
          },
        }, '✨ ' + t('ht.exams.field.provider.enhance')),
        el('span', { class: 'tb-card-meta', style: { fontSize: '10px' } },
          t('ht.exams.field.provider.enhance.help')),
        enrichStatus,
      ));
    }

    // ─── Episode link picker ────────────────────────────────
    // Lets the user tie this exam to a multi-visit care episode
    // (e.g., colonoscopy: pre-consult + labs + procedure + follow-up
    // all belong to one episode). Single-select; "create new" opens
    // the episode edit modal pre-filled with the exam date.
    const allEps = getEpisodes();
    const epSelect = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        const v = e.target.value;
        if (v === '__new__') {
          // Save current exam state, then open new-episode flow
          upsertExam(draft);
          const root = document.getElementById('tb-modal-root');
          if (root) root.innerHTML = '';
          openEpisodeEditModal(null);
          return;
        }
        draft.episode_id = v || null;
      },
    },
      el('option', { value: '', selected: !draft.episode_id }, '— ' + t('ht.exams.field.episode.none') + ' —'),
      ...allEps.map((ep) =>
        el('option', { value: ep.id, selected: draft.episode_id === ep.id },
          (episodeCategoryMeta(ep.category).icon) + ' ' + ep.title +
          (ep.started_date ? ' (' + ep.started_date.slice(0, 7) + ')' : ''))),
      el('option', { value: '__new__' }, '+ ' + t('ht.exams.field.episode.createNew')),
    );
    modal.appendChild(field('🧭 ' + t('ht.exams.field.episode'),
      epSelect,
      t('ht.exams.field.episode.help')));

    // ─── Vitals section ─────────────────────────────────────
    const vitalsSection = el('details', {
      open: 'open',
      style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
    });
    vitalsSection.appendChild(el('summary', { style: { fontWeight: '600', cursor: 'pointer' } }, '⚕ ' + t('ht.exams.vitals.title')));
    const v = draft.vitals || (draft.vitals = {});
    vitalsSection.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' } },
      field(t('ht.vitals.weight_kg'), numInput(v.weight_kg, (x) => v.weight_kg = x)),
      field(t('ht.vitals.height_cm'), numInput(v.height_cm, (x) => v.height_cm = x)),
      field(t('ht.vitals.bp_systolic'), numInput(v.bp_systolic, (x) => v.bp_systolic = x)),
      field(t('ht.vitals.bp_diastolic'), numInput(v.bp_diastolic, (x) => v.bp_diastolic = x)),
      field(t('ht.vitals.heart_rate'), numInput(v.heart_rate_bpm, (x) => v.heart_rate_bpm = x)),
      field(t('ht.vitals.temp_c'), numInput(v.temp_c, (x) => v.temp_c = x)),
      field(t('ht.vitals.spo2'), numInput(v.spo2_pct, (x) => v.spo2_pct = x)),
    ));
    modal.appendChild(vitalsSection);

    // ─── Lab results section ─────────────────────────────────
    const labsSection = el('details', {
      open: 'open',
      style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
    });
    labsSection.appendChild(el('summary', { style: { fontWeight: '600', cursor: 'pointer' } },
      '🧪 ' + t('ht.exams.labs.title') + ' (' + (draft.lab_results || []).length + ')'));
    const labsList = el('div', { style: { marginTop: 'var(--tb-sp-2)' } });
    function renderLabs() {
      labsList.innerHTML = '';
      (draft.lab_results || []).forEach((lr, idx) => {
        const row = el('div', {
          style: { display: 'grid', gridTemplateColumns: '2fr 1fr 0.8fr 1fr 0.7fr auto', gap: '6px', alignItems: 'center', marginBottom: '4px' },
        });
        row.appendChild(el('input', {
          type: 'text', class: 'tb-input', placeholder: t('ht.labs.field.name'),
          value: lr.name || '',
          oninput: (e) => { lr.name = e.target.value; },
        }));
        row.appendChild(el('input', {
          type: 'number', step: 'any', class: 'tb-input', placeholder: t('ht.labs.field.value'),
          style: { fontFamily: 'var(--tb-font-mono)' },
          value: lr.value != null ? lr.value : '',
          oninput: (e) => {
            const x = parseFloat(e.target.value);
            lr.value = isFinite(x) ? x : null;
            recomputeFlag(lr);
          },
        }));
        row.appendChild(el('input', {
          type: 'text', class: 'tb-input', placeholder: t('ht.labs.field.unit'),
          value: lr.unit || '',
          oninput: (e) => { lr.unit = e.target.value; },
        }));
        const rangeRow = el('div', { style: { display: 'flex', gap: '4px' } },
          el('input', {
            type: 'number', step: 'any', class: 'tb-input',
            style: { fontFamily: 'var(--tb-font-mono)', width: '50%' },
            placeholder: 'low',
            value: lr.range_low != null ? lr.range_low : '',
            oninput: (e) => { const x = parseFloat(e.target.value); lr.range_low = isFinite(x) ? x : null; recomputeFlag(lr); },
          }),
          el('input', {
            type: 'number', step: 'any', class: 'tb-input',
            style: { fontFamily: 'var(--tb-font-mono)', width: '50%' },
            placeholder: 'high',
            value: lr.range_high != null ? lr.range_high : '',
            oninput: (e) => { const x = parseFloat(e.target.value); lr.range_high = isFinite(x) ? x : null; recomputeFlag(lr); },
          }),
        );
        row.appendChild(rangeRow);
        row.appendChild(el('select', {
          class: 'tb-select',
          onchange: (e) => { lr.flag = e.target.value; },
        },
          ['normal', 'low', 'high', 'critical'].map((f) =>
            el('option', { value: f, selected: lr.flag === f }, f)),
        ));
        row.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '0 6px', color: 'var(--tb-error)' },
          onclick: () => {
            draft.lab_results.splice(idx, 1);
            renderLabs();
          },
        }, '×'));
        labsList.appendChild(row);
      });
    }
    function recomputeFlag(lr) {
      if (lr.value == null || (lr.range_low == null && lr.range_high == null)) return;
      if (lr.range_high != null && lr.value > lr.range_high) lr.flag = 'high';
      else if (lr.range_low != null && lr.value < lr.range_low) lr.flag = 'low';
      else lr.flag = 'normal';
    }
    renderLabs();
    labsSection.appendChild(labsList);
    labsSection.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-1)' },
      onclick: () => {
        draft.lab_results = draft.lab_results || [];
        draft.lab_results.push({ name: '', value: null, unit: '', range_low: null, range_high: null, flag: 'normal' });
        renderLabs();
      },
    }, '+ ' + t('ht.labs.addRow')));
    modal.appendChild(labsSection);

    // ─── Attached documents ─────────────────────────────────────
    // Each exam can have multiple source documents (lab report,
    // screening result, office summary, imaging report). This section
    // lists them and offers to attach more via the vision import flow.
    const docsSection = el('details', {
      open: 'open',
      style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
    });
    const docs = draft.documents || [];
    docsSection.appendChild(el('summary', { style: { fontWeight: '600', cursor: 'pointer' } },
      '📎 ' + t('ht.exams.docs.title') + ' (' + docs.length + ')'));
    if (docs.length === 0) {
      docsSection.appendChild(el('p', { class: 'tb-field-help', style: { margin: 'var(--tb-sp-2) 0' } }, t('ht.exams.docs.empty')));
    } else {
      const docList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: 'var(--tb-sp-2)' } });
      for (const d of docs) {
        const row = el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'var(--tb-bg-elev)',
            borderLeft: '3px solid var(--tb-track-health)',
            borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--tb-sp-3)',
          },
        });
        const docDetails = el('div', { style: { flex: '1', minWidth: '0' } });
        docDetails.appendChild(el('div', {
          style: { fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        },
          el('span', null, d.filename || d.title || t('ht.exams.docs.untitled')),
          el('span', {
            style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
              background: 'rgba(46, 107, 92, 0.12)', color: 'var(--tb-track-ai)',
              fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
          }, documentKindLabel(d.kind || 'other')),
        ));
        if (d.ai_summary) {
          docDetails.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px', lineHeight: 'var(--tb-lh-body)' } }, d.ai_summary));
        }
        docDetails.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px', fontSize: '10px', fontFamily: 'var(--tb-font-mono)' } },
          (d.date_imported ? d.date_imported + ' · ' : '') +
          (d.filesize_kb ? d.filesize_kb + ' KB · ' : '') +
          (d.cost_usd != null ? '$' + Number(d.cost_usd).toFixed(4) : '')));
        row.appendChild(docDetails);
        row.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '0 8px', color: 'var(--tb-error)', fontSize: '14px' },
          title: t('ht.exams.docs.remove'),
          onclick: () => {
            if (!confirm(t('ht.exams.docs.remove.confirm'))) return;
            draft.documents = (draft.documents || []).filter((x) => x.id !== d.id);
            // Re-open the modal to re-render with updated list
            const updated = JSON.parse(JSON.stringify(draft));
            // Save now so the change persists even if user clicks Cancel
            upsertExam(updated);
            const root = document.getElementById('tb-modal-root');
            if (root) root.innerHTML = '';
            openExamEditModal(updated);
          },
        }, '×'));
        docList.appendChild(row);
      }
      docsSection.appendChild(docList);
    }
    // Attach-another button — only visible when AI key is set and
    // consent allows medical_vision (same gate as the header upload).
    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    const medOk = TB.ai && typeof TB.ai.isFeatureAllowed === 'function'
      ? TB.ai.isFeatureAllowed('medical_vision') !== false
      : true;
    if (hasKey && medOk && isEdit) {
      docsSection.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary', type: 'button',
        style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          // Save current draft state before opening import — otherwise
          // unsaved changes in the modal would be lost when we close to
          // open the import modal.
          upsertExam(draft);
          const root = document.getElementById('tb-modal-root');
          if (root) root.innerHTML = '';
          openVisionImportModal({ attachToExamId: draft.id });
        },
      }, '+ ' + t('ht.exams.docs.attachAnother')));
    } else if (isEdit && !hasKey) {
      docsSection.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('ht.exams.docs.noKey')));
    }
    modal.appendChild(docsSection);

    // ─── Linked invoices ────────────────────────────────────────
    // Surfaces every invoice tied to this exam (inv.exam_id === draft.id).
    // For each invoice we show the high-value extracted fields:
    //   • Type badge + paid status
    //   • Amount with USD equivalent
    //   • Provider / facility / date
    //   • AI summary (services rendered)
    //   • AI notes (CPT codes, line-item list, medication names —
    //     this is where the colonoscopy pharmacy invoice's medication
    //     list lives)
    // Plus actions: open the invoice's own edit modal for fine-tuning,
    // and a "+ Add invoice" / "+ Import invoice (AI)" pair when in edit
    // mode so the user can attach more from inside the exam view.
    if (isEdit) {
      const invSection = el('details', {
        open: 'open',
        style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
      });
      const linkedInvoices = getInvoices().filter((i) => i.exam_id === draft.id);
      // Sum gross + reimbursed for the section header
      let invGross = 0, invReimb = 0;
      for (const inv of linkedInvoices) {
        if (typeof inv.amount_usd_calc === 'number' && isFinite(inv.amount_usd_calc)) invGross += inv.amount_usd_calc;
        if (inv.reimbursement_status === 'received' &&
            typeof inv.reimbursed_usd_calc === 'number' && isFinite(inv.reimbursed_usd_calc)) {
          invReimb += inv.reimbursed_usd_calc;
        }
      }
      const headerBits = [t('ht.exams.invoices.title') + ' (' + linkedInvoices.length + ')'];
      if (linkedInvoices.length > 0) {
        const grossStr = '$' + Math.round(invGross).toLocaleString();
        headerBits.push(grossStr);
        if (invReimb > 0) headerBits.push('− $' + Math.round(invReimb).toLocaleString() + ' ' + t('ht.episodes.reimbursed'));
      }
      invSection.appendChild(el('summary', { style: { fontWeight: '600', cursor: 'pointer' } },
        '🧾 ' + headerBits.join(' · ')));

      if (linkedInvoices.length === 0) {
        invSection.appendChild(el('p', { class: 'tb-field-help', style: { margin: 'var(--tb-sp-2) 0' } },
          t('ht.exams.invoices.empty')));
      } else {
        const invList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: 'var(--tb-sp-2)' } });
        // Newest first for the in-exam view
        const sortedInvs = linkedInvoices.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        for (const inv of sortedInvs) {
          invList.appendChild(buildLinkedInvoiceRow(inv, draft));
        }
        invSection.appendChild(invList);
      }

      // Action row: add manual + AI import. AI import gated by key+consent.
      const invActions = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap', marginTop: 'var(--tb-sp-2)' } });
      invActions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          // Persist any pending exam edits before navigating to the
          // invoice modal (consistent with the docs-section behavior).
          upsertExam(draft);
          const root = document.getElementById('tb-modal-root');
          if (root) root.innerHTML = '';
          openInvoiceEditModal(null, {
            exam_id: draft.id,
            episode_id: draft.episode_id || null,
          });
        },
      }, '+ ' + t('ht.exams.invoices.addManual')));
      if (hasKey && medOk) {
        invActions.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          style: { fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            upsertExam(draft);
            const root = document.getElementById('tb-modal-root');
            if (root) root.innerHTML = '';
            openInvoiceVisionImportModal({
              prefillExamId: draft.id,
              prefillEpisodeId: draft.episode_id || null,
            });
          },
        }, '🧾 ' + t('ht.exams.invoices.import')));
      }
      invSection.appendChild(invActions);
      modal.appendChild(invSection);
    }

    // ─── Linked medications ─────────────────────────────────────
    // Pulls in medications attached to this exam directly (exam_id) AND
    // medications sourced from any invoice linked to this exam (the
    // pharmacy receipts that listed the prescribed drugs). This is what
    // makes the colonoscopy procedure show its prep meds even though
    // they were extracted from a pharmacy invoice, not the procedure
    // report itself.
    if (isEdit) {
      const medSection = el('details', {
        open: 'open',
        style: { marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
      });
      const linkedInvoiceIds = getInvoices()
        .filter((i) => i.exam_id === draft.id)
        .map((i) => i.id);
      const linkedMeds = getMeds().filter((m) =>
        m.exam_id === draft.id ||
        (m.source_invoice_id && linkedInvoiceIds.indexOf(m.source_invoice_id) >= 0)
      );
      medSection.appendChild(el('summary', { style: { fontWeight: '600', cursor: 'pointer' } },
        '💊 ' + t('ht.exams.meds.title') + ' (' + linkedMeds.length + ')'));

      if (linkedMeds.length === 0) {
        medSection.appendChild(el('p', { class: 'tb-field-help', style: { margin: 'var(--tb-sp-2) 0' } },
          t('ht.exams.meds.empty')));
      } else {
        const medList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: 'var(--tb-sp-2)' } });
        // Newest started first
        const sortedMeds = linkedMeds.slice().sort((a, b) => (b.started_date || '').localeCompare(a.started_date || ''));
        for (const m of sortedMeds) {
          medList.appendChild(buildLinkedMedRow(m, draft));
        }
        medSection.appendChild(medList);
      }

      const medActions = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap', marginTop: 'var(--tb-sp-2)' } });
      medActions.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          upsertExam(draft);
          const root = document.getElementById('tb-modal-root');
          if (root) root.innerHTML = '';
          openMedEditModal(null, {
            // Pre-fill exam_id + episode_id so it lands attached.
            exam_id: draft.id,
            episode_id: draft.episode_id || null,
            started_date: draft.date || new Date().toISOString().slice(0, 10),
            prescriber: draft.provider || '',
          });
        },
      }, '+ ' + t('ht.exams.meds.addManual')));
      medSection.appendChild(medActions);
      modal.appendChild(medSection);
    }

    // Diagnoses + followup
    modal.appendChild(field(t('ht.exams.diagnoses'),
      textareaInput((draft.diagnoses || []).join('\n'), (v) => {
        draft.diagnoses = v.split('\n').map((x) => x.trim()).filter(Boolean);
      }), t('ht.exams.diagnoses.help')));
    modal.appendChild(field(t('ht.exams.followup'),
      textareaInput(draft.followup, (v) => { draft.followup = v; })));
    modal.appendChild(field(t('ht.exams.notes'),
      textareaInput(draft.notes, (v) => { draft.notes = v; })));

    // Buttons
    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' },
    });
    if (isEdit) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          if (!deleteExamWithUndo(draft.id)) return;
          close();
          rerender();
        },
      }, t('ht.delete')));
    } else {
      btnRow.appendChild(el('span'));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')));
    // Capture the episode_id at modal open so we can recompute the
    // OLD episode (when user reassigns the exam) AND the NEW episode
    // on save. Otherwise an exam moving from episode A to B would
    // leave A's derived metadata stale.
    const originalEpisodeId = existing ? (existing.episode_id || null) : null;

    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        // Clean empty lab rows
        draft.lab_results = (draft.lab_results || []).filter((lr) => lr.name && lr.name.trim());
        upsertExam(draft);
        // Recompute affected episodes' derived fields. Old + new in
        // case the user moved the exam between episodes.
        if (originalEpisodeId && originalEpisodeId !== draft.episode_id) {
          recomputeEpisodeDerivedFields(originalEpisodeId);
        }
        if (draft.episode_id) {
          recomputeEpisodeDerivedFields(draft.episode_id);
        }
        close();
        rerender();
      },
    }, t('ht.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Vision import modal — upload lab PDF/image, Claude extracts
  // ====================================================================

  // Vision import. Two entry points:
  //   • openVisionImportModal()                  — header button, free upload
  //   • openVisionImportModal({ attachToExamId }) — from inside an exam edit
  //     modal, skips the create-new option and merges directly.
  function openVisionImportModal(opts) {
    opts = opts || {};
    const attachToExamId = opts.attachToExamId || null;
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '📎 ' + t('ht.import.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' },
      attachToExamId ? t('ht.import.intro.attach') : t('ht.import.intro')));

    // ─── Exam type selector (v0.54): Medical vs Dental.
    // Auto-detects from the chosen filename — if it looks dental (jp
    // 歯科, "dental", known dental clinic names), defaults to dental
    // and uses the dental-specific extraction prompt. User can toggle.
    // Hidden when attachToExamId is set (we're attaching to a known
    // existing exam, so type is fixed).
    const examType = { value: 'medical' };  // 'medical' | 'dental'
    if (!attachToExamId) {
      const typeRow = el('div', {
        style: {
          display: 'flex', gap: 'var(--tb-sp-2)', alignItems: 'center', flexWrap: 'wrap',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev, rgba(0,0,0,0.03))',
          borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
          fontSize: 'var(--tb-fs-12)',
        },
      });
      typeRow.appendChild(el('span', { style: { fontWeight: '600', marginRight: 'var(--tb-sp-2)' } },
        t('ht.import.type.label')));
      const medBtn = el('button', {
        class: 'tb-btn tb-btn--secondary', type: 'button',
        style: { fontSize: '11px', padding: '4px 12px' },
      }, '🩺 ' + t('ht.import.type.medical'));
      const denBtn = el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: '11px', padding: '4px 12px' },
      }, '🦷 ' + t('ht.import.type.dental'));
      function syncTypeBtns() {
        medBtn.className = 'tb-btn ' + (examType.value === 'medical' ? 'tb-btn--secondary' : 'tb-btn--ghost');
        denBtn.className = 'tb-btn ' + (examType.value === 'dental' ? 'tb-btn--secondary' : 'tb-btn--ghost');
      }
      medBtn.onclick = () => { examType.value = 'medical'; syncTypeBtns(); };
      denBtn.onclick = () => { examType.value = 'dental'; syncTypeBtns(); };
      typeRow.appendChild(medBtn);
      typeRow.appendChild(denBtn);
      typeRow.appendChild(el('span', {
        class: 'tb-card-meta',
        style: { fontSize: '10px', marginLeft: 'var(--tb-sp-2)' },
      }, t('ht.import.type.help')));
      modal.appendChild(typeRow);
    }

    const status = el('div', { style: { marginTop: 'var(--tb-sp-2)', minHeight: '1.4em', fontSize: 'var(--tb-fs-12)' } });

    // Filename-based dental hint — auto-flip the toggle when a clearly
    // dental file is chosen. Patterns cover EN ("dental", "perio",
    // "tooth"), JP (歯科, 歯医者), and the user's known clinic names.
    function looksLikeDentalFilename(name) {
      const n = String(name || '').toLowerCase();
      // Generic dental keywords only — no clinic-specific shortcuts
      // (those biased file-name detection toward the author's local
      // clinic and aren't useful for the general user).
      return /dental|perio|tooth|歯科|歯医者/i.test(n);
    }

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf',
      style: { display: 'none' },
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) handleUpload(f);
        e.target.value = '';
      },
    });

    const dropZone = el('div', {
      style: {
        border: '1px dashed var(--tb-border)', borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-4)', textAlign: 'center', background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-2)' } }, t('ht.import.dropTitle')),
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } }, t('ht.import.dropHelp')),
      el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => fileInput.click(),
      }, '📎 ' + t('ht.import.choose')),
      fileInput,
    );
    if (TB.utils && typeof TB.utils.attachFileDrop === 'function') {
      TB.utils.attachFileDrop(dropZone, {
        accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
        text: '⤓ ' + t('ht.import.dropOver'),
        onFile: (f) => handleUpload(f),
        onError: (msg) => { status.textContent = '✗ ' + msg; status.style.color = 'var(--tb-error)'; },
      });
    }
    modal.appendChild(dropZone);
    modal.appendChild(status);

    async function handleUpload(file) {
      // Filename hint can auto-flip toggle to dental on first file pick
      if (!attachToExamId && examType.value === 'medical' && looksLikeDentalFilename(file.name)) {
        examType.value = 'dental';
      }
      // ─── Dental short-circuit: use the dental-specific extraction
      // + applyDentalExtraction to populate the dental tab directly.
      // No routing screen — dental flows are self-contained.
      if (!attachToExamId && examType.value === 'dental') {
        status.textContent = '⏳ ' + t('ht.dental.import.processing', { name: file.name });
        status.style.color = 'var(--tb-text-soft)';
        try {
          const result = await TB.ai.callClaudeVisionForDentalExtraction(file, {});
          const ext = result.extracted || {};
          const cost = (result.cost_usd || 0).toFixed(4);
          if (ext.is_dental === false) {
            status.textContent = '⚠ ' + t('ht.dental.import.notDental');
            status.style.color = 'var(--tb-warn)';
            return;
          }
          const summary = applyDentalExtraction(ext, file.name, Number(result.cost_usd) || 0);
          status.textContent = '✓ ' + t('ht.dental.import.done', {
            cost, teeth: summary.teethUpdated, procs: summary.proceduresAdded,
          });
          status.style.color = 'var(--tb-success)';
          setTimeout(() => { close(); rerender(); }, 1500);
          return;
        } catch (err) {
          status.textContent = '✗ ' + (err.message || err);
          status.style.color = 'var(--tb-error)';
          return;
        }
      }

      status.textContent = '⏳ ' + t('ht.import.processing', { name: file.name });
      status.style.color = 'var(--tb-text-soft)';
      try {
        const result = await TB.ai.callClaudeVisionForMedicalExtraction(file, {});
        const ext = result.extracted || {};
        const cost = (result.cost_usd || 0).toFixed(4);

        // Backfill flags from value vs range when the model didn't set one
        for (const lr of (Array.isArray(ext.lab_results) ? ext.lab_results : [])) {
          if (!lr.flag && lr.value != null) {
            if (lr.range_high != null && lr.value > lr.range_high) lr.flag = 'high';
            else if (lr.range_low != null && lr.value < lr.range_low) lr.flag = 'low';
            else lr.flag = 'normal';
          }
        }

        const docMeta = {
          filename: file.name,
          filesize_kb: Math.round(file.size / 1024),
          cost_usd: Number(result.cost_usd) || 0,
          kind: inferDocumentKind(ext, file.name),
        };

        // Identify any extracted lab tests we don't have descriptions
        // for and ask Claude to generate them. Runs in the background
        // — non-blocking; the ⓘ popovers populate when state updates.
        // Only runs when the user has `ask_taigan` consent.
        try { await maybeGenerateLabDescriptions(ext, status); } catch (_) {}

        // If called with attachToExamId, skip review screen and merge
        // directly — the user already chose an exam.
        if (attachToExamId) {
          mergeExtractionIntoExam(attachToExamId, ext, docMeta);
          close();
          // Re-open the exam edit modal so the user sees the new doc
          const refreshed = getExams().find((e) => e.id === attachToExamId);
          if (refreshed) openExamEditModal(refreshed);
          else rerender();
          return;
        }

        // Otherwise, auto-detect candidate exams + show the review/route
        // screen.
        const candidates = findCandidateExamsForExtraction(ext);
        status.textContent = '✓ ' + t('ht.import.done', { cost });
        status.style.color = 'var(--tb-success)';
        // Replace upload UI with review/route choice
        modal.innerHTML = '';
        renderRouteChoice(modal, ext, docMeta, candidates, close);
      } catch (err) {
        status.textContent = '✗ ' + (err.message || err);
        status.style.color = 'var(--tb-error)';
      }
    }

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
    ));

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // After extraction, show the user "merge into existing exam X" vs
  // "create new exam". Auto-detect candidates are listed at top with
  // match-score badges; "Create new" sits at the bottom as the default
  // fallback when no candidates score high enough.
  function renderRouteChoice(modal, ext, docMeta, candidates, close) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🔍 ' + t('ht.route.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.route.intro')));

    // Extracted preview card
    const previewCard = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '3px solid var(--tb-track-health)',
        borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)',
      },
    });
    previewCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginBottom: '4px' } },
      t('ht.route.preview.title')));
    const parts = [];
    if (ext.exam_type) parts.push(examTypeLabel(ext.exam_type));
    if (ext.date) parts.push(ext.date);
    if (ext.provider) parts.push(ext.provider);
    if (ext.facility) parts.push(ext.facility);
    previewCard.appendChild(el('div', { style: { fontWeight: '600' } }, parts.join(' · ')));
    const stats = [];
    const labCount = Array.isArray(ext.lab_results) ? ext.lab_results.length : 0;
    if (labCount) stats.push(t('ht.route.preview.labs', { n: labCount }));
    const vitalCount = ext.vitals ? Object.keys(ext.vitals).filter(k => ext.vitals[k] != null).length : 0;
    if (vitalCount) stats.push(t('ht.route.preview.vitals', { n: vitalCount }));
    const diagCount = (ext.diagnoses || []).length;
    if (diagCount) stats.push(t('ht.route.preview.diagnoses', { n: diagCount }));
    if (stats.length) {
      previewCard.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, stats.join(' · ')));
    }
    previewCard.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } },
      docMeta.filename + ' · ' + (docMeta.filesize_kb || 0) + ' KB · ' +
      t('ht.route.preview.kind') + ': ' + documentKindLabel(docMeta.kind)));
    modal.appendChild(previewCard);

    // ─── Potential duplicate lab names panel ────────────────────
    // Show a warning when extracted names are suspiciously similar to
    // names already in the user's history but don't auto-canonicalize.
    // User can "Rename to match" (mutates the in-memory ext payload
    // before save) or dismiss. Catches gaps in LAB_CANONICAL that the
    // pattern table doesn't yet handle.
    const dupPairs = findPotentialDuplicateLabNames(ext);
    if (dupPairs.length > 0) {
      const dupPanel = el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'rgba(200, 100, 30, 0.06)',
          borderLeft: '3px solid var(--tb-warn)',
          borderRadius: 'var(--tb-radius-2)',
          marginBottom: 'var(--tb-sp-3)',
        },
      });
      dupPanel.appendChild(el('div', {
        style: { fontWeight: '600', marginBottom: '4px' },
      }, '⚠ ' + t('ht.labs.dup.title', { n: dupPairs.length })));
      dupPanel.appendChild(el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } },
        t('ht.labs.dup.intro')));
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
      for (const pair of dupPairs) {
        const row = el('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
            background: 'var(--tb-bg)', padding: '6px 10px', borderRadius: 'var(--tb-radius-1)',
            fontSize: 'var(--tb-fs-12)',
          },
        });
        row.appendChild(el('div', null,
          el('div', null,
            el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, '“' + pair.extracted_name + '”'),
            el('span', { style: { margin: '0 6px', color: 'var(--tb-text-soft)' } }, '≈'),
            el('span', { style: { fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-soft)' } }, '“' + pair.existing_name + '”'),
          ),
          el('div', { class: 'tb-card-meta', style: { fontSize: '10px', marginTop: '2px' } },
            t('ht.labs.dup.reason.' + pair.reason)),
        ));
        const actions = el('div', { style: { display: 'flex', gap: '4px' } });
        actions.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          style: { fontSize: '11px', padding: '2px 8px' },
          onclick: (e) => {
            // Rename the matching lab_results entries in the
            // extraction payload so the merge/create writes the same
            // stored name as the existing test — they'll collapse on
            // display without needing a new canonical pattern.
            if (Array.isArray(ext.lab_results)) {
              for (const lr of ext.lab_results) {
                if (lr && lr.name === pair.extracted_name) lr.name = pair.existing_name;
              }
            }
            // Update the row visually: collapse it and disable
            // further actions so the user sees what they picked.
            row.style.opacity = '0.5';
            row.style.pointerEvents = 'none';
            actions.innerHTML = '';
            actions.appendChild(el('span', {
              style: { fontSize: '11px', color: 'var(--tb-success)', fontWeight: '600' },
            }, '✓ ' + t('ht.labs.dup.action.renamed')));
          },
        }, '↻ ' + t('ht.labs.dup.action.rename')));
        actions.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { fontSize: '11px', padding: '2px 8px' },
          onclick: () => {
            row.remove();
          },
        }, '× ' + t('ht.labs.dup.action.different')));
        row.appendChild(actions);
        list.appendChild(row);
      }
      dupPanel.appendChild(list);
      modal.appendChild(dupPanel);
    }

    // Candidate exams (when any meet the threshold)
    if (candidates.length > 0) {
      modal.appendChild(el('div', {
        style: { fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-2)' },
      }, t('ht.route.candidates.title')));
      for (const c of candidates.slice(0, 3)) {
        modal.appendChild(buildCandidateRow(c, ext, docMeta, close));
      }
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          border: '1px dashed var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)', marginTop: 'var(--tb-sp-2)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } }, t('ht.route.createNew.title')),
          el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, t('ht.route.createNew.body')),
        ),
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          type: 'button',
          onclick: () => {
            const exam = createExamFromExtraction(ext, docMeta);
            close();
            openExamEditModal(exam);
          },
        }, '+ ' + t('ht.route.createNew.button')),
      ));
    } else {
      // No candidates above threshold — straight create.
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderLeft: '3px solid var(--tb-success)',
          borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)',
        },
      },
        el('div', { style: { fontWeight: '600' } }, '✓ ' + t('ht.route.noCandidates.title')),
        el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, t('ht.route.noCandidates.body')),
      ));
      modal.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)' } },
        el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
        el('button', {
          class: 'tb-btn', type: 'button',
          onclick: () => {
            const exam = createExamFromExtraction(ext, docMeta);
            close();
            openExamEditModal(exam);
          },
        }, '+ ' + t('ht.route.createNew.button')),
      ));
    }

    // Cancel button (always available)
    if (candidates.length > 0) {
      modal.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' } },
        el('button', { class: 'tb-btn tb-btn--ghost', type: 'button', onclick: close }, t('ht.cancel')),
      ));
    }
  }

  function buildCandidateRow(candidate, ext, docMeta, close) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const c = candidate.exam;
    const score = candidate.score;
    const matchLevel = score >= 80 ? 'strong' : score >= 60 ? 'likely' : 'possible';
    const matchColor = matchLevel === 'strong' ? 'var(--tb-success)'
                     : matchLevel === 'likely' ? 'var(--tb-track-health)'
                     : 'var(--tb-warn)';
    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '3px solid ' + matchColor,
        borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-2)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
    });
    const docCount = (c.documents || []).length;
    row.appendChild(el('div', null,
      el('div', null,
        el('span', { style: { fontWeight: '600' } },
          examTypeLabel(c.type) + ' · ' + (c.date || '?')),
        el('span', {
          style: { marginLeft: 'var(--tb-sp-2)', fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
            background: matchColor + '22', color: matchColor, fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
        }, t('ht.route.match.' + matchLevel) + ' · ' + score),
      ),
      el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } },
        (c.provider || '') +
        (c.facility ? ' · ' + c.facility : '') +
        ((c.lab_results || []).length > 0 ? ' · ' + (c.lab_results.length) + ' lab(s)' : '') +
        (docCount > 0 ? ' · ' + docCount + ' doc' + (docCount === 1 ? '' : 's') : '')),
    ));
    row.appendChild(el('button', {
      class: 'tb-btn',
      type: 'button',
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        mergeExtractionIntoExam(c.id, ext, docMeta);
        close();
        const refreshed = getExams().find((e) => e.id === c.id);
        if (refreshed) openExamEditModal(refreshed);
        else rerender();
      },
    }, '🔗 ' + t('ht.route.attach.button')));
    return row;
  }

  // ====================================================================
  // Invoice vision import — separate flow from exam import
  // ====================================================================
  //
  // openInvoiceVisionImportModal()
  //   Free upload from header. After extraction, score candidate exams
  //   and episodes; show a "route" screen offering:
  //     • Attach to exam X (auto-fills episode_id from that exam)
  //     • Attach to episode Y directly (no specific exam)
  //     • Standalone — create invoice with no link
  //   The user can also pop the standard invoice edit modal pre-filled
  //   with the extracted data to fine-tune before save.

  function openInvoiceVisionImportModal(opts) {
    opts = opts || {};
    // When called from inside an exam edit modal, prefillExamId tells
    // us "skip the route screen — the user already chose where this
    // invoice belongs." Same shortcut pattern as the exam vision
    // import's attachToExamId.
    const prefillExamId = opts.prefillExamId || null;
    const prefillEpisodeId = opts.prefillEpisodeId || null;
    // prefillType: 'dental' forces the invoice type after extraction,
    // so candidate filtering routes to dental-only exams/episodes and
    // the dental costs section picks it up.
    const prefillType = opts.prefillType || null;
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🧾 ' + t('ht.invoiceImport.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' },
      prefillExamId ? t('ht.invoiceImport.intro.attach') : t('ht.invoiceImport.intro')));

    const status = el('div', { style: { marginTop: 'var(--tb-sp-2)', minHeight: '1.4em', fontSize: 'var(--tb-fs-12)' } });

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf',
      style: { display: 'none' },
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) handleUpload(f);
        e.target.value = '';
      },
    });

    const dropZone = el('div', {
      style: {
        border: '1px dashed var(--tb-border)', borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-4)', textAlign: 'center', background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-2)' } }, t('ht.invoiceImport.dropTitle')),
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } }, t('ht.invoiceImport.dropHelp')),
      el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => fileInput.click(),
      }, '📎 ' + t('ht.import.choose')),
      fileInput,
    );
    if (TB.utils && typeof TB.utils.attachFileDrop === 'function') {
      TB.utils.attachFileDrop(dropZone, {
        accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
        text: '⤓ ' + t('ht.import.dropOver'),
        onFile: (f) => handleUpload(f),
        onError: (msg) => { status.textContent = '✗ ' + msg; status.style.color = 'var(--tb-error)'; },
      });
    }
    modal.appendChild(dropZone);

    // Chain-AI toggle: after the invoice's extracted provider info is
    // synced into the dental provider list, automatically fire the
    // provider-enrichment AI call to fill in missing language name /
    // website / hours / etc. Defaults ON; user can opt out per upload.
    // Hidden for the exam-attach shortcut (no separate provider sync).
    const chainOpts = { autoEnrichProvider: true };
    if (!prefillExamId) {
      const chk = el('input', {
        type: 'checkbox', checked: true,
        style: { marginRight: '6px' },
        onchange: (e) => { chainOpts.autoEnrichProvider = !!e.target.checked; },
      });
      modal.appendChild(el('label', {
        style: {
          display: 'flex', alignItems: 'center', gap: '4px',
          fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
          marginBottom: 'var(--tb-sp-2)', cursor: 'pointer',
        },
      }, chk, el('span', null, '✨ ' + t('ht.invoiceImport.chainEnrich.label'))));
    }
    modal.appendChild(status);

    async function handleUpload(file) {
      status.textContent = '⏳ ' + t('ht.invoiceImport.processing', { name: file.name });
      status.style.color = 'var(--tb-text-soft)';
      try {
        const result = await TB.ai.callClaudeVisionForInvoiceExtraction(file, {});
        const ext = result.extracted || {};
        const cost = (result.cost_usd || 0).toFixed(4);

        // Build a draft invoice from the extraction. This is the
        // record we'll either save standalone or attach to an exam /
        // episode based on the user's choice.
        const draft = createInvoiceFromExtraction(ext, {
          ai_cost_usd: Number(result.cost_usd) || 0,
          filename: file.name,
          exam_id: prefillExamId,
          episode_id: prefillEpisodeId,
        });
        // Force the type when the caller specified one (dental costs
        // upload button passes prefillType='dental'). Also useful as
        // a filename-based hint when the AI guessed wrong.
        if (prefillType) draft.type = prefillType;
        else if (/dental|歯科|歯医者/i.test(file.name)) {
          draft.type = 'dental';
        }

        // Shortcut: when invoked from inside an exam, save directly and
        // re-open the exam modal so the user sees the new invoice in
        // the "Linked invoices" section. No route screen needed.
        if (prefillExamId) {
          saveImportedInvoiceWithMedications(draft, chainOpts);
          canonicalizeNamesAcrossExams();
          if (draft.episode_id) recomputeEpisodeDerivedFields(draft.episode_id);
          close();
          const refreshed = getExams().find((e) => e.id === prefillExamId);
          if (refreshed) openExamEditModal(refreshed);
          else rerender();
          return;
        }

        // Score candidates against the draft (which has invoice-shaped
        // fields like date / provider / facility).
        const examCands = findCandidateExamsForInvoice(draft);
        const episodeCands = findCandidateEpisodesForInvoice(draft);

        status.textContent = '✓ ' + t('ht.invoiceImport.done', { cost });
        status.style.color = 'var(--tb-success)';

        modal.innerHTML = '';
        renderInvoiceRouteChoice(modal, ext, draft, examCands, episodeCands, close, chainOpts);
      } catch (err) {
        status.textContent = '✗ ' + (err.message || err);
        status.style.color = 'var(--tb-error)';
      }
    }

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' },
    },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('ht.cancel')),
    ));

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // Post-extraction "where does this invoice belong?" screen.
  //   • Top: extracted preview (amount + currency + provider + date)
  //   • Candidate EXAMS section (scored, top 3)
  //   • Candidate EPISODES section (scored, top 3 — but only show
  //     episodes that aren't already covered by a candidate exam)
  //   • "Save as standalone" fallback row
  //   • "Edit before saving" — opens the standard invoice edit modal
  //     with the draft pre-filled, letting the user fine-tune any field
  function renderInvoiceRouteChoice(modal, ext, draft, examCands, episodeCands, close, chainOpts) {
    chainOpts = chainOpts || { autoEnrichProvider: true };
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🔍 ' + t('ht.invoiceImport.route.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('ht.invoiceImport.route.intro')));

    // Preview card
    const previewCard = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '3px solid var(--tb-track-health)',
        borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)',
      },
    });
    previewCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginBottom: '4px' } },
      t('ht.invoiceImport.route.preview.title')));
    const headParts = [];
    const amtStr = (draft.amount_native != null)
      ? formatInvoiceAmountLine(draft.amount_native, draft.currency, draft.amount_usd_calc)
      : '—';
    headParts.push(amtStr);
    if (draft.date) headParts.push(draft.date);
    if (draft.provider) headParts.push(draft.provider);
    previewCard.appendChild(el('div', { style: { fontWeight: '600' } }, headParts.join(' · ')));
    const subParts = [];
    if (draft.type) subParts.push(t('ht.invoices.type.' + draft.type));
    if (draft.facility) subParts.push(draft.facility);
    if (draft.paid === true) subParts.push('✓ ' + t('ht.invoices.field.paid'));
    if (subParts.length) {
      previewCard.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, subParts.join(' · ')));
    }
    if (ext.summary) {
      previewCard.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)', fontStyle: 'italic' } }, ext.summary));
    }
    if (draft.filename) {
      previewCard.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } }, draft.filename));
    }
    modal.appendChild(previewCard);

    const noCandidates = examCands.length === 0 && episodeCands.length === 0;

    // Track exams already shown so we don't double-suggest the same
    // episode via its child exam.
    const examEpisodeIds = new Set();
    examCands.slice(0, 3).forEach((c) => { if (c.exam.episode_id) examEpisodeIds.add(c.exam.episode_id); });

    if (examCands.length > 0) {
      modal.appendChild(el('div', {
        style: { fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-2)' },
      }, t('ht.invoiceImport.route.candidates.exams')));
      for (const c of examCands.slice(0, 3)) {
        modal.appendChild(buildInvoiceExamCandidateRow(c, draft, close, chainOpts));
      }
    }

    const filteredEpisodeCands = episodeCands.filter((c) => !examEpisodeIds.has(c.episode.id));
    if (filteredEpisodeCands.length > 0) {
      modal.appendChild(el('div', {
        style: { fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', margin: 'var(--tb-sp-3) 0 var(--tb-sp-2)' },
      }, t('ht.invoiceImport.route.candidates.episodes')));
      for (const c of filteredEpisodeCands.slice(0, 3)) {
        modal.appendChild(buildInvoiceEpisodeCandidateRow(c, draft, close, chainOpts));
      }
    }

    if (noCandidates) {
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderLeft: '3px solid var(--tb-warn)',
          borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)',
        },
      },
        el('div', { style: { fontWeight: '600' } }, '⚠ ' + t('ht.invoiceImport.route.noCandidates.title')),
        el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, t('ht.invoiceImport.route.noCandidates.body')),
      ));
    }

    // Standalone (always offered) — save invoice with no link
    modal.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        border: '1px dashed var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)', marginTop: 'var(--tb-sp-2)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
    },
      el('div', null,
        el('div', { style: { fontWeight: '600' } }, t('ht.invoiceImport.route.standalone.title')),
        el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, t('ht.invoiceImport.route.standalone.body')),
      ),
      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } },
        el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          onclick: () => {
            close();
            // Open the edit modal pre-filled so the user can fine-tune.
            openInvoiceEditModal(draft);
          },
        }, '✎ ' + t('ht.invoiceImport.route.edit')),
        el('button', {
          class: 'tb-btn', type: 'button',
          onclick: () => {
            saveImportedInvoiceWithMedications(draft, chainOpts);
            canonicalizeNamesAcrossExams();
            close();
            rerender();
          },
        }, '+ ' + t('ht.invoiceImport.route.save')),
      ),
    ));

    modal.appendChild(el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' } },
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button', onclick: close }, t('ht.cancel')),
    ));
  }

  // Pretty-format the invoice amount line for the preview card.
  // JPY → ¥1,234 (no decimals); USD → $1,234.56; other → e.g. €123.45.
  function formatInvoiceAmountLine(amount, currency, usdCalc) {
    const SYMBOL = { USD: '$', JPY: '¥', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', CHF: 'Fr.' };
    const sym = SYMBOL[currency] || '';
    let body;
    if (currency === 'JPY') {
      body = sym + Math.round(amount).toLocaleString();
    } else {
      body = sym + Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (currency !== 'USD' && usdCalc != null && isFinite(usdCalc)) {
      body += ' (≈ $' + Math.round(usdCalc).toLocaleString() + ')';
    }
    return body;
  }

  function buildInvoiceExamCandidateRow(candidate, draft, close, chainOpts) {
    chainOpts = chainOpts || { autoEnrichProvider: true };
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const c = candidate.exam;
    const score = candidate.score;
    const matchLevel = score >= 70 ? 'strong' : score >= 50 ? 'likely' : 'possible';
    const matchColor = matchLevel === 'strong' ? 'var(--tb-success)'
                     : matchLevel === 'likely' ? 'var(--tb-track-health)'
                     : 'var(--tb-warn)';
    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '3px solid ' + matchColor,
        borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-2)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
    });
    // Header: exam type, date, match pill
    const label = el('div', null,
      el('div', null,
        el('span', { style: { fontWeight: '600' } },
          examTypeLabel(c.type) + ' · ' + (c.date || '?')),
        el('span', {
          style: { marginLeft: 'var(--tb-sp-2)', fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
            background: matchColor + '22', color: matchColor, fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
        }, t('ht.route.match.' + matchLevel) + ' · ' + score),
      ),
    );
    const subBits = [];
    if (c.provider) subBits.push(c.provider);
    if (c.facility) subBits.push(c.facility);
    if (c.episode_id) {
      const ep = getEpisodes().find((e) => e.id === c.episode_id);
      if (ep) subBits.push('🧭 ' + (ep.title || t('ht.episodes.untitled')));
    }
    if (subBits.length) {
      label.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, subBits.join(' · ')));
    }
    row.appendChild(label);

    row.appendChild(el('button', {
      class: 'tb-btn', type: 'button', style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        draft.exam_id = c.id;
        if (c.episode_id) draft.episode_id = c.episode_id;
        saveImportedInvoiceWithMedications(draft, chainOpts);
        canonicalizeNamesAcrossExams();
        if (draft.episode_id) recomputeEpisodeDerivedFields(draft.episode_id);
        close();
        rerender();
      },
    }, '🔗 ' + t('ht.invoiceImport.route.attachExam')));
    return row;
  }

  function buildInvoiceEpisodeCandidateRow(candidate, draft, close, chainOpts) {
    chainOpts = chainOpts || { autoEnrichProvider: true };
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ep = candidate.episode;
    const score = candidate.score;
    const matchLevel = score >= 70 ? 'strong' : score >= 50 ? 'likely' : 'possible';
    const matchColor = matchLevel === 'strong' ? 'var(--tb-success)'
                     : matchLevel === 'likely' ? 'var(--tb-track-health)'
                     : 'var(--tb-warn)';
    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderLeft: '3px solid ' + matchColor,
        borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-2)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
      },
    });
    const label = el('div', null,
      el('div', null,
        el('span', { style: { fontWeight: '600' } }, '🧭 ' + (ep.title || t('ht.episodes.untitled'))),
        el('span', {
          style: { marginLeft: 'var(--tb-sp-2)', fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
            background: matchColor + '22', color: matchColor, fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
        }, t('ht.route.match.' + matchLevel) + ' · ' + score),
      ),
    );
    const subBits = [];
    if (ep.started_date) {
      subBits.push(ep.started_date + (ep.completed_date ? ' → ' + ep.completed_date : ' → …'));
    }
    if (ep.provider) subBits.push(ep.provider);
    if (ep.facility) subBits.push(ep.facility);
    if (subBits.length) {
      label.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, subBits.join(' · ')));
    }
    row.appendChild(label);

    row.appendChild(el('button', {
      class: 'tb-btn', type: 'button', style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        draft.episode_id = ep.id;
        saveImportedInvoiceWithMedications(draft, chainOpts);
        canonicalizeNamesAcrossExams();
        recomputeEpisodeDerivedFields(ep.id);
        close();
        rerender();
      },
    }, '🔗 ' + t('ht.invoiceImport.route.attachEpisode')));
    return row;
  }

  // Row used inside the exam edit modal's "Linked invoices" section.
  // Surfaces the AI-extracted detail that matters for tying spending
  // back to the exam — including the line-item / medication list that
  // lives in `inv.notes` (the invoice extraction prompt captures CPT
  // codes, line items, and medication names there).
  function buildLinkedInvoiceRow(inv, parentExamDraft) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg-elev)',
        borderLeft: '3px solid var(--tb-track-health)',
        borderRadius: 'var(--tb-radius-1)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 'var(--tb-sp-3)',
        cursor: 'pointer',
      },
      onclick: () => {
        // Persist parent exam state before navigating, so unsaved edits
        // aren't lost while the user fine-tunes the invoice.
        upsertExam(parentExamDraft);
        const root = document.getElementById('tb-modal-root');
        if (root) root.innerHTML = '';
        openInvoiceEditModal(inv);
      },
    });

    const body = el('div', { style: { flex: '1', minWidth: '0' } });

    // Header row: type badge + amount + paid status
    const headerRow = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    });
    headerRow.appendChild(el('span', {
      style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
        background: 'rgba(46, 107, 92, 0.12)', color: 'var(--tb-track-ai)',
        fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
    }, t('ht.invoices.type.' + (inv.type || 'other'))));
    headerRow.appendChild(el('span', {
      style: { fontWeight: '600', fontFamily: 'var(--tb-font-mono)' },
    }, inv.amount_native != null
      ? formatInvoiceAmountLine(inv.amount_native, inv.currency || 'USD', inv.amount_usd_calc)
      : '—'));
    if (inv.paid === true) {
      headerRow.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(34, 139, 34, 0.14)', color: 'var(--tb-success)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '✓ ' + t('ht.invoices.field.paid')));
    } else if (inv.paid === false) {
      headerRow.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(200, 100, 30, 0.14)', color: 'var(--tb-warn)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.exams.invoices.unpaid')));
    }
    if (inv.reimbursement_status === 'received') {
      headerRow.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.14)', color: 'var(--tb-track-health)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '↩ ' + t('ht.episodes.reimbursed')));
    } else if (inv.reimbursement_status === 'pending' || inv.reimbursement_status === 'submitted') {
      headerRow.appendChild(el('span', {
        style: { fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(200, 100, 30, 0.12)', color: 'var(--tb-warn)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.invoices.reim.' + inv.reimbursement_status)));
    }
    body.appendChild(headerRow);

    // Provider/facility/date meta line
    const metaBits = [];
    if (inv.date) metaBits.push(inv.date);
    if (inv.provider) metaBits.push(inv.provider);
    if (inv.facility && inv.facility !== inv.provider) metaBits.push(inv.facility);
    if (metaBits.length) {
      body.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, metaBits.join(' · ')));
    }

    // Materialized medication count — when meds have been auto-created
    // from this invoice, surface a small reference link instead of
    // re-rendering the same drug names in the notes panel below.
    const materializedMeds = getMeds().filter((m) => m.source_invoice_id === inv.id);
    if (materializedMeds.length > 0) {
      body.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-1)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-track-ai)' },
      }, '💊 ' + t('ht.exams.invoices.medsMaterialized', { n: materializedMeds.length })));
    }

    // AI summary — what was billed for
    if (inv.notes) {
      // Heuristically pull out medication-list-ish content for a small
      // emphasis treatment. The invoice extraction prompt captures
      // line items + CPT codes + meds in `notes`, so this is where
      // pharmacy receipts list the drugs that were dispensed. Suppress
      // the badge when we've already materialized meds so we don't
      // duplicate the same drug names twice in the row.
      const hasMaterialized = materializedMeds.length > 0;
      const looksLikeMeds = !hasMaterialized && /\b(rx|medication|dispens|tablet|capsule|mg|ml|prescrib|薬|錠|カプセル|処方)\b/i.test(inv.notes);
      body.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-1)',
          padding: 'var(--tb-sp-2)',
          background: looksLikeMeds ? 'rgba(46, 107, 92, 0.08)' : 'transparent',
          borderRadius: 'var(--tb-radius-1)',
          fontSize: 'var(--tb-fs-12)',
          lineHeight: 'var(--tb-lh-body)',
          whiteSpace: 'pre-wrap',
          color: 'var(--tb-text)',
        },
      },
        looksLikeMeds
          ? el('div', null,
              el('span', {
                style: { fontSize: '10px', fontWeight: '700', letterSpacing: '0.04em',
                  textTransform: 'uppercase', color: 'var(--tb-track-ai)', marginRight: '6px' },
              }, '💊 ' + t('ht.exams.invoices.lineItems')),
              el('span', null, inv.notes),
            )
          : inv.notes,
      ));
    }

    // Footer: file + cost meta
    if (inv.filename || inv.ai_cost_usd != null) {
      const bits = [];
      if (inv.filename) bits.push(inv.filename);
      if (inv.ai_cost_usd != null) bits.push('$' + Number(inv.ai_cost_usd).toFixed(4));
      body.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '4px', fontSize: '10px', fontFamily: 'var(--tb-font-mono)' } },
        bits.join(' · ')));
    }

    row.appendChild(body);
    row.appendChild(el('span', { style: { color: 'var(--tb-text-soft)', alignSelf: 'center', flexShrink: '0' } }, '✎'));
    return row;
  }

  // Row used inside the exam edit modal's "Linked medications" section.
  // Surfaces dosage + frequency + provenance (which invoice it came
  // from when AI-imported). Clicking opens the medication edit modal
  // for fine-tuning.
  function buildLinkedMedRow(med, parentExamDraft) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const row = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg-elev)',
        borderLeft: '3px solid var(--tb-track-health)',
        borderRadius: 'var(--tb-radius-1)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 'var(--tb-sp-3)',
        cursor: 'pointer',
      },
      onclick: () => {
        upsertExam(parentExamDraft);
        const root = document.getElementById('tb-modal-root');
        if (root) root.innerHTML = '';
        // Ensure the parent-exam link is set so close() returns to the
        // exam modal even for meds that were sourced from invoices and
        // never had exam_id set directly.
        const next = Object.assign({}, med);
        if (!next.exam_id) next.exam_id = parentExamDraft.id;
        openMedEditModal(next);
      },
    });

    const body = el('div', { style: { flex: '1', minWidth: '0' } });

    // Header: name + dosage (e.g., "Atorvastatin 20mg")
    const headerBits = [el('span', { style: { fontWeight: '600' } }, med.name || '—')];
    if (med.dosage != null) {
      headerBits.push(el('span', { style: { fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-soft)', marginLeft: '6px' } },
        med.dosage + (med.dosage_unit || '')));
    }
    if (med.ended_date) {
      headerBits.push(el('span', {
        style: { marginLeft: '8px', fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(125, 125, 125, 0.14)', color: 'var(--tb-text-soft)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.meds.ended')));
    } else {
      headerBits.push(el('span', {
        style: { marginLeft: '8px', fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.14)', color: 'var(--tb-track-health)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, t('ht.meds.active')));
    }
    if (med.ai_imported) {
      headerBits.push(el('span', {
        style: { marginLeft: '8px', fontSize: '10px', padding: '1px 6px', borderRadius: 'var(--tb-radius-pill)',
          background: 'rgba(46, 107, 92, 0.10)', color: 'var(--tb-track-ai)',
          fontWeight: '700', letterSpacing: '0.04em', textTransform: 'uppercase' },
      }, '✨ ' + t('ht.meds.ai')));
    }
    body.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap' } }, ...headerBits));

    // Generic name + frequency line
    const subBits = [];
    if (med.generic_name) subBits.push('(' + med.generic_name + ')');
    if (med.frequency) subBits.push(med.frequency);
    if (med.started_date) subBits.push(t('ht.meds.startedShort') + ' ' + med.started_date);
    if (subBits.length) {
      body.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, subBits.join(' · ')));
    }

    // Prescriber / pharmacy
    const provBits = [];
    if (med.prescriber) provBits.push(t('ht.meds.field.prescriber') + ': ' + med.prescriber);
    if (med.pharmacy) provBits.push(t('ht.meds.field.pharmacy') + ': ' + med.pharmacy);
    if (provBits.length) {
      body.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, provBits.join(' · ')));
    }

    // Provenance — which invoice the AI sourced this from
    if (med.source_invoice_id) {
      const srcInv = getInvoices().find((i) => i.id === med.source_invoice_id);
      if (srcInv) {
        body.appendChild(el('div', {
          class: 'tb-card-meta',
          style: { marginTop: '2px', fontSize: '10px', fontFamily: 'var(--tb-font-mono)' },
        }, '🧾 ' + t('ht.meds.fromInvoice') + ': ' + (srcInv.filename || srcInv.date || srcInv.id)));
      }
    }

    // Free-text notes (qty + instructions)
    if (med.notes) {
      body.appendChild(el('div', {
        class: 'tb-card-meta',
        style: { marginTop: '4px', whiteSpace: 'pre-wrap', lineHeight: 'var(--tb-lh-body)' },
      }, med.notes));
    }

    row.appendChild(body);
    row.appendChild(el('span', { style: { color: 'var(--tb-text-soft)', alignSelf: 'center', flexShrink: '0' } }, '✎'));
    return row;
  }

  // ====================================================================
  // AI Advisor — opens Ask Taigan with exam context pre-filled
  // ====================================================================

  function openAiAdvisor() {
    const t = TB.i18n.t;
    const exams = getExams();
    if (exams.length === 0) {
      alert(t('ht.advisor.empty'));
      return;
    }
    const latest = exams.slice(0, 3); // most recent 3 exams as context
    const summary = buildExamSummaryForAi(latest);
    const meds = activeMeds().map((m) => m.name + (m.dosage ? ' ' + m.dosage + (m.dosage_unit || '') : '')).join(', ');
    const promptEn = 'Here is a summary of my recent medical exams.\n\n' + summary +
      (meds ? '\n\nCurrent medications: ' + meds : '') +
      '\n\nWhat findings stand out? What follow-up questions should I bring to my next appointment? ' +
      'Be specific about which lab values are noteworthy and why. Do NOT give medical advice — just help me prepare for an informed conversation with my doctor.';
    const promptJp = '最近の健康診断結果の要約です。\n\n' + summary +
      (meds ? '\n\n服薬中:' + meds : '') +
      '\n\n注目すべき所見は?次回の受診時に医師に確認すべきフォローアップ事項は?どの検査値が注目に値するか具体的に教えてください。' +
      '医学的アドバイスは不要 — 医師との情報に基づいた会話の準備に役立ててください。';
    TB.askTaigan.openWithContext({
      feature: 'ask_taigan',
      label_en: 'Health Tracker exam advisor',
      label_jp: 'Health Tracker 受診アドバイザー',
      prompt_en: promptEn,
      prompt_jp: promptJp,
    });
  }

  // Sanitized exam summary for AI advisor — values + flags + diagnoses,
  // NOT facility/provider/raw PII.
  function buildExamSummaryForAi(exams) {
    const lines = [];
    for (const e of exams) {
      lines.push('## ' + (e.date || '?') + ' — ' + examTypeLabel(e.type));
      const v = e.vitals || {};
      const vitalParts = [];
      if (v.weight_kg != null) vitalParts.push('Weight: ' + v.weight_kg + ' kg');
      if (v.height_cm != null) vitalParts.push('Height: ' + v.height_cm + ' cm');
      if (v.bp_systolic != null && v.bp_diastolic != null) vitalParts.push('BP: ' + v.bp_systolic + '/' + v.bp_diastolic);
      if (v.heart_rate_bpm != null) vitalParts.push('HR: ' + v.heart_rate_bpm + ' bpm');
      if (v.spo2_pct != null) vitalParts.push('SpO2: ' + v.spo2_pct + '%');
      if (vitalParts.length > 0) lines.push('Vitals: ' + vitalParts.join(', '));
      if ((e.lab_results || []).length > 0) {
        lines.push('Lab results:');
        for (const lr of e.lab_results) {
          const flagTag = lr.flag && lr.flag !== 'normal' ? ' [' + lr.flag.toUpperCase() + ']' : '';
          const rangeTag = (lr.range_low != null || lr.range_high != null)
            ? ' (ref ' + formatLabRange(lr.range_low, lr.range_high) + ')'
            : '';
          lines.push('  - ' + lr.name + ': ' + lr.value + (lr.unit ? ' ' + lr.unit : '') + rangeTag + flagTag);
        }
      }
      if ((e.diagnoses || []).length > 0) {
        lines.push('Diagnoses: ' + e.diagnoses.join(', '));
      }
      if (e.followup) lines.push('Follow-up: ' + e.followup);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ====================================================================
  // Health Year-In Review (v0.58)
  // ====================================================================
  //
  // Annual summary report rolling up everything tracked in a year:
  // exams + dental + procedures + spend + providers + medication
  // changes + screenings + lab trends + open vs closed action items.
  //
  // Render is print-friendly so users can save as PDF and share with
  // CPA (for medical-expense deductions) or spouse.

  function openHealthYearInReviewModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', {
      class: 'tb-modal',
      id: 'tb-yir-modal',
      style: { maxWidth: '900px', maxHeight: '92vh', overflow: 'auto' },
    });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    // Year picker — defaults to current year. Show years that have
    // any data (exams, dental notes, invoices).
    const yearsSet = new Set();
    yearsSet.add(String(new Date().getFullYear()));
    for (const e of getExams()) if (e.date) yearsSet.add(e.date.slice(0, 4));
    for (const n of (getDental().notes_log || [])) if (n.date) yearsSet.add(n.date.slice(0, 4));
    for (const i of getInvoices()) if (i.date) yearsSet.add(i.date.slice(0, 4));
    for (const p of (getDental().procedures || [])) if (p.date) yearsSet.add(p.date.slice(0, 4));
    const years = Array.from(yearsSet).sort().reverse();
    const sel = { year: years[0] };

    function rerenderBody() {
      // Wipe and re-build everything except the modal itself
      modal.innerHTML = '';
      buildHeader();
      buildBody();
    }

    function buildHeader() {
      const headRow = el('div', {
        'data-yir-no-print': '1',
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' },
      });
      headRow.appendChild(el('h2', { style: { margin: 0 } },
        '📊 ' + t('ht.yir.title')));
      const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', alignItems: 'center', flexWrap: 'wrap' } });
      // Year picker
      right.appendChild(el('label', { style: { fontSize: 'var(--tb-fs-12)' } }, t('ht.yir.year') + ': '));
      right.appendChild(el('select', {
        class: 'tb-select',
        style: { fontSize: 'var(--tb-fs-12)', padding: '4px 8px' },
        onchange: (e) => { sel.year = e.target.value; rerenderBody(); },
      }, years.map((y) => el('option', { value: y, selected: y === sel.year }, y))));
      right.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: () => printYearInReview(),
      }, '🖨 ' + t('ht.yir.print')));
      right.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { fontSize: 'var(--tb-fs-12)' },
        onclick: close,
      }, t('ht.cancel')));
      headRow.appendChild(right);
      modal.appendChild(headRow);
    }

    function buildBody() {
      const body = renderYearInReviewBody(sel.year);
      modal.appendChild(body);
    }

    buildHeader();
    buildBody();

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // Render the full year-in-review content for the given year. Returns
  // a DOM element ready to drop into the modal (and also used for the
  // print view).
  function renderYearInReviewBody(year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const wrap = el('div', { id: 'tb-yir-content' });

    function inYear(dateStr) {
      return dateStr && dateStr.startsWith(year);
    }

    // ─── Gather data slices for the year
    const exams = getExams().filter((e) => inYear(e.date));
    const invoices = getInvoices().filter((i) => inYear(i.date));
    const procedures = (getDental().procedures || []).filter((p) => inYear(p.date));
    const dentalNotes = (getDental().notes_log || []).filter((n) => inYear(n.date));
    const meds = getMeds();
    const startedMeds = meds.filter((m) => inYear(m.started_date));
    const endedMeds = meds.filter((m) => inYear(m.ended_date));
    const episodes = getEpisodes().filter((ep) =>
      inYear(ep.started_date) || inYear(ep.completed_date));
    const completedEpisodes = episodes.filter((ep) =>
      ep.status === 'completed' && inYear(ep.completed_date));
    const activeEpisodes = getEpisodes().filter((ep) =>
      ep.status !== 'completed' && ep.status !== 'cancelled' &&
      (!ep.completed_date || ep.completed_date >= year + '-01-01'));

    // Title
    const profile = TB.state.get('profile') || {};
    const userName = lang === 'ja' ? (profile.displayNameJa || profile.displayName || '') : (profile.displayName || '');
    wrap.appendChild(el('div', {
      style: { textAlign: 'center', marginBottom: 'var(--tb-sp-4)',
        paddingBottom: 'var(--tb-sp-3)', borderBottom: '2px solid var(--tb-track-health)' },
    },
      el('h1', { style: { margin: 0, color: 'var(--tb-track-health)' } },
        year + ' ' + t('ht.yir.headerTitle')),
      userName ? el('div', { class: 'tb-card-meta', style: { marginTop: '4px' } }, userName) : null,
      el('div', { class: 'tb-card-meta', style: { fontSize: '11px', marginTop: '4px' } },
        t('ht.yir.generated') + ': ' + new Date().toISOString().slice(0, 10)),
    ));

    // ─── Overview tiles
    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-4)' },
    });
    function tile(label, value, color) {
      return el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', textAlign: 'center',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
          border: '1px solid var(--tb-border)' },
      },
        el('div', { style: { fontSize: '24px', fontWeight: '700', fontFamily: 'var(--tb-font-mono)', color: color || 'var(--tb-track-health)' } }, value),
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', marginTop: '2px' } }, label),
      );
    }
    tiles.appendChild(tile(t('ht.yir.tile.exams'), String(exams.length)));
    tiles.appendChild(tile(t('ht.yir.tile.procedures'), String(procedures.length)));
    tiles.appendChild(tile(t('ht.yir.tile.dentalVisits'), String(dentalNotes.length)));
    tiles.appendChild(tile(t('ht.yir.tile.activeMeds'),
      String(activeMeds().length)));
    tiles.appendChild(tile(t('ht.yir.tile.episodes'),
      String(episodes.length)));
    wrap.appendChild(tiles);

    // ─── Spend breakdown
    if (invoices.length > 0) {
      const spendCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      spendCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '💰 ' + t('ht.yir.section.spend')));
      // Aggregate by type + currency
      const byType = {};
      let totalUsd = 0, totalJpy = 0;
      let insuranceUsd = 0, insuranceJpy = 0;
      let unpaidCount = 0;
      for (const inv of invoices) {
        const tk = inv.type || 'other';
        byType[tk] = byType[tk] || { count: 0, native: 0, currency: inv.currency || 'USD' };
        byType[tk].count++;
        if (typeof inv.amount_native === 'number') byType[tk].native += inv.amount_native;
        if (typeof inv.amount_usd_calc === 'number') totalUsd += inv.amount_usd_calc;
        if (inv.currency === 'JPY' && typeof inv.amount_native === 'number') totalJpy += inv.amount_native;
        if (inv.reimbursement_status === 'received' && typeof inv.reimbursed_native === 'number') {
          if (inv.currency === 'JPY') insuranceJpy += inv.reimbursed_native;
          else if (typeof inv.reimbursed_usd_calc === 'number') insuranceUsd += inv.reimbursed_usd_calc;
        }
        if (!inv.paid) unpaidCount++;
      }
      const totalsRow = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' },
      });
      totalsRow.appendChild(el('div', null,
        el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } }, t('ht.yir.spend.totalUsd')),
        el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, '$' + Math.round(totalUsd).toLocaleString()),
      ));
      if (totalJpy > 0) totalsRow.appendChild(el('div', null,
        el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } }, t('ht.yir.spend.totalJpy')),
        el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, '¥' + Math.round(totalJpy).toLocaleString()),
      ));
      totalsRow.appendChild(el('div', null,
        el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } }, t('ht.yir.spend.insurance')),
        el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-success)' } },
          '$' + Math.round(insuranceUsd).toLocaleString() + (insuranceJpy > 0 ? ' / ¥' + Math.round(insuranceJpy).toLocaleString() : '')),
      ));
      totalsRow.appendChild(el('div', null,
        el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } }, t('ht.yir.spend.oop')),
        el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-warn)' } },
          '$' + Math.round(totalUsd - insuranceUsd).toLocaleString()),
      ));
      if (unpaidCount > 0) totalsRow.appendChild(el('div', null,
        el('div', { class: 'tb-card-meta', style: { fontSize: '10px' } }, t('ht.yir.spend.unpaid')),
        el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-error)' } },
          String(unpaidCount)),
      ));
      spendCard.appendChild(totalsRow);
      // Per-type breakdown table
      const typeTable = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-12)' } });
      typeTable.appendChild(el('thead', null, el('tr', null,
        thTd(t('ht.yir.spend.col.type'), true),
        thTd(t('ht.yir.spend.col.count'), true, 'right'),
        thTd(t('ht.yir.spend.col.amount'), true, 'right'),
      )));
      const tbody = el('tbody');
      const types = Object.keys(byType).sort((a, b) => byType[b].native - byType[a].native);
      for (const k of types) {
        const d = byType[k];
        const symHere = ({ USD: '$', JPY: '¥', EUR: '€', GBP: '£' })[d.currency || 'USD'] || (d.currency + ' ');
        tbody.appendChild(el('tr', null,
          thTd(t('ht.invoices.type.' + k)),
          thTd(String(d.count), false, 'right'),
          thTd(el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
            symHere + (d.currency === 'JPY' ? Math.round(d.native).toLocaleString() : d.native.toFixed(2))), false, 'right'),
        ));
      }
      typeTable.appendChild(tbody);
      spendCard.appendChild(typeTable);
      wrap.appendChild(spendCard);
    }

    // ─── Exams
    if (exams.length > 0) {
      const examCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      examCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '📋 ' + t('ht.yir.section.exams')));
      const sorted = exams.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
      for (const e of sorted) {
        const bits = [e.date || '?', examTypeLabel(e.type)];
        if (e.provider || e.facility) bits.push(e.provider || e.facility);
        const flaggedLabs = (e.lab_results || []).filter((lr) =>
          lr.flag === 'high' || lr.flag === 'low' || lr.flag === 'critical');
        if (flaggedLabs.length > 0) bits.push(flaggedLabs.length + ' flagged');
        list.appendChild(el('div', {
          style: { padding: '4px 12px', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', fontSize: 'var(--tb-fs-12)' },
        },
          el('span', null, bits.join(' · ')),
          (e.diagnoses && e.diagnoses.length > 0)
            ? el('span', { class: 'tb-card-meta' }, 'Dx: ' + e.diagnoses.slice(0, 2).join(', '))
            : null,
        ));
      }
      examCard.appendChild(list);
      wrap.appendChild(examCard);
    }

    // ─── Providers visited (count of visits per provider, across exams + dental)
    const providerCounts = {};
    for (const e of exams) {
      const name = e.facility || e.provider;
      if (!name) continue;
      providerCounts[name] = (providerCounts[name] || 0) + 1;
    }
    for (const n of dentalNotes) {
      const providers = getDentalProviders();
      const prov = n.provider_id ? providers.find((p) => p.id === n.provider_id) : null;
      const name = prov ? (prov.name_en || prov.name_jp) : null;
      if (!name) continue;
      providerCounts[name] = (providerCounts[name] || 0) + 1;
    }
    if (Object.keys(providerCounts).length > 0) {
      const provCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      provCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '🏥 ' + t('ht.yir.section.providers')));
      const provList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
      const sorted = Object.entries(providerCounts).sort((a, b) => b[1] - a[1]);
      for (const [name, n] of sorted) {
        provList.appendChild(el('div', {
          style: { padding: '4px 12px', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
            display: 'flex', justifyContent: 'space-between', fontSize: 'var(--tb-fs-12)' },
        },
          el('span', { style: { fontWeight: '500' } }, name),
          el('span', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)' } },
            n + ' ' + t('ht.yir.providers.visits')),
        ));
      }
      provCard.appendChild(provList);
      wrap.appendChild(provCard);
    }

    // ─── Medications timeline
    if (startedMeds.length > 0 || endedMeds.length > 0) {
      const medCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      medCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '💊 ' + t('ht.yir.section.medications')));
      if (startedMeds.length > 0) {
        medCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '700',
          textTransform: 'uppercase', color: 'var(--tb-success)', marginBottom: '4px' } },
          '+ ' + t('ht.yir.meds.started', { n: startedMeds.length })));
        for (const m of startedMeds) {
          medCard.appendChild(el('div', { style: { paddingLeft: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
            (m.started_date || '?') + ' · ' + (m.name || '?') +
            (m.dosage != null ? ' ' + m.dosage + (m.dosage_unit || '') : '') +
            (m.purpose ? ' (for ' + m.purpose + ')' : '')));
        }
      }
      if (endedMeds.length > 0) {
        medCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '700',
          textTransform: 'uppercase', color: 'var(--tb-text-soft)', marginTop: 'var(--tb-sp-2)', marginBottom: '4px' } },
          '× ' + t('ht.yir.meds.ended', { n: endedMeds.length })));
        for (const m of endedMeds) {
          medCard.appendChild(el('div', { style: { paddingLeft: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
            (m.ended_date || '?') + ' · ' + (m.name || '?')));
        }
      }
      wrap.appendChild(medCard);
    }

    // ─── Dental year summary
    if (dentalNotes.length > 0 || procedures.length > 0) {
      const dentCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      dentCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '🦷 ' + t('ht.yir.section.dental')));
      if (dentalNotes.length > 0) {
        dentCard.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-12)', marginBottom: 'var(--tb-sp-2)' } },
          t('ht.yir.dental.visits', { n: dentalNotes.length })));
      }
      // Periodontal trend across notes
      const perioSnaps = dentalNotes
        .filter((n) => n.periodontal_snapshot)
        .map((n) => ({ date: n.date, snap: n.periodontal_snapshot }))
        .sort((a, b) => a.date.localeCompare(b.date));
      if (perioSnaps.length >= 1) {
        const first = perioSnaps[0].snap, last = perioSnaps[perioSnaps.length - 1].snap;
        function delta(curr, prev, lower_is_better) {
          if (curr == null || prev == null) return '';
          const d = curr - prev;
          if (Math.abs(d) < 0.1) return ' →';
          if (lower_is_better) return d < 0 ? ' ↓ (' + d.toFixed(1) + ')' : ' ↑ (+' + d.toFixed(1) + ')';
          return d > 0 ? ' ↑ (+' + d.toFixed(1) + ')' : ' ↓ (' + d.toFixed(1) + ')';
        }
        if (perioSnaps.length >= 2) {
          const perioBits = [];
          if (last.pockets_4mm_pct != null) perioBits.push('Pockets 4mm+: ' + last.pockets_4mm_pct + '%' + delta(last.pockets_4mm_pct, first.pockets_4mm_pct, true));
          if (last.bleeding_on_probing_pct != null) perioBits.push('BoP: ' + last.bleeding_on_probing_pct + '%' + delta(last.bleeding_on_probing_pct, first.bleeding_on_probing_pct, true));
          if (perioBits.length > 0) {
            dentCard.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: '12px', marginBottom: 'var(--tb-sp-2)' } },
              t('ht.yir.dental.perioTrend') + ': ' + perioBits.join(' · ')));
          }
        }
      }
      if (procedures.length > 0) {
        dentCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '700',
          textTransform: 'uppercase', color: 'var(--tb-text-soft)', marginTop: 'var(--tb-sp-2)' } },
          t('ht.yir.dental.procedures', { n: procedures.length })));
        const sortedProcs = procedures.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        for (const p of sortedProcs) {
          dentCard.appendChild(el('div', { style: { paddingLeft: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
            (p.date || '?') + ' · ' + (p.name_en || p.name_jp || p.code || '?')));
        }
      }
      wrap.appendChild(dentCard);
    }

    // ─── Care episodes
    if (episodes.length > 0) {
      const epCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      epCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '🧭 ' + t('ht.yir.section.episodes')));
      if (completedEpisodes.length > 0) {
        epCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '700',
          textTransform: 'uppercase', color: 'var(--tb-success)' } },
          '✓ ' + t('ht.yir.episodes.completed', { n: completedEpisodes.length })));
        for (const ep of completedEpisodes) {
          const cost = totalCostForEpisode(ep.id);
          epCard.appendChild(el('div', { style: { paddingLeft: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
            (ep.title || '?') +
            (ep.started_date && ep.completed_date ? ' · ' + ep.started_date + ' → ' + ep.completed_date : '') +
            (cost.gross > 0 ? ' · ≈$' + Math.round(cost.gross).toLocaleString() : '')));
        }
      }
      const stillActive = activeEpisodes;
      if (stillActive.length > 0) {
        epCard.appendChild(el('div', { style: { fontSize: '11px', fontWeight: '700',
          textTransform: 'uppercase', color: 'var(--tb-warn)', marginTop: 'var(--tb-sp-2)' } },
          '🔄 ' + t('ht.yir.episodes.active', { n: stillActive.length })));
        for (const ep of stillActive) {
          epCard.appendChild(el('div', { style: { paddingLeft: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
            (ep.title || '?') +
            (ep.started_date ? ' · since ' + ep.started_date : '') +
            (ep.specialty ? ' · ' + ep.specialty : '')));
        }
      }
      wrap.appendChild(epCard);
    }

    // ─── Screenings status (current)
    if (typeof computeScreeningsDue === 'function') {
      const screenings = computeScreeningsDue();
      const overdue = screenings.filter((s) => s.status === 'critical' || s.status === 'due');
      const upcoming = screenings.filter((s) => s.status === 'upcoming');
      const current = screenings.filter((s) => s.status === 'current');
      if (screenings.length > 0) {
        const scrCard = el('div', { class: 'tb-card', 'data-track': 'health' });
        scrCard.appendChild(el('h3', { style: { marginTop: 0 } },
          '🎯 ' + t('ht.yir.section.screenings')));
        scrCard.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-12)' } },
          t('ht.yir.screenings.summary', {
            current: current.length, overdue: overdue.length, upcoming: upcoming.length,
          })));
        if (overdue.length > 0) {
          scrCard.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-2)' } },
            el('div', { style: { fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--tb-error)' } },
              t('ht.yir.screenings.overdue')),
            ...overdue.map((s) => el('div', { style: { paddingLeft: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
              (lang === 'ja' ? s.label_jp : s.label_en) +
              (s.last_done ? ' · last ' + s.last_done : ' · never done'))),
          ));
        }
        wrap.appendChild(scrCard);
      }
    }

    // ─── Action items: open vs closed across all dental notes from this year
    const acAll = [], acClosed = [];
    for (const n of dentalNotes) {
      for (const ai of (n.action_items || [])) {
        if (!ai || !ai.text) continue;
        acAll.push(ai);
        if (ai.checked) acClosed.push(ai);
      }
    }
    if (acAll.length > 0) {
      const aiCard = el('div', { class: 'tb-card', 'data-track': 'health' });
      aiCard.appendChild(el('h3', { style: { marginTop: 0 } },
        '✅ ' + t('ht.yir.section.actionItems')));
      const closedPct = Math.round((acClosed.length / acAll.length) * 100);
      aiCard.appendChild(el('div', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-12)' } },
        t('ht.yir.actions.summary', { closed: acClosed.length, total: acAll.length, pct: closedPct })));
      // Progress bar
      const bar = el('div', {
        style: { display: 'flex', height: '12px', borderRadius: 'var(--tb-radius-1)',
          overflow: 'hidden', border: '1px solid var(--tb-border)', marginTop: '6px' },
      });
      bar.appendChild(el('div', {
        style: { flex: acClosed.length, background: 'var(--tb-success)' },
      }));
      bar.appendChild(el('div', {
        style: { flex: (acAll.length - acClosed.length), background: 'var(--tb-bg)' },
      }));
      aiCard.appendChild(bar);
      wrap.appendChild(aiCard);
    }

    if (exams.length === 0 && dentalNotes.length === 0 && invoices.length === 0 && procedures.length === 0) {
      wrap.appendChild(el('div', { class: 'tb-card', style: { textAlign: 'center' } },
        el('p', { class: 'tb-field-help' }, t('ht.yir.empty', { year }))));
    }

    return wrap;
  }

  // Print just the YIR content. Uses a print-specific CSS injection
  // to hide everything else on the page.
  function printYearInReview() {
    const content = document.getElementById('tb-yir-content');
    if (!content) { window.print(); return; }
    // Inject a one-time print stylesheet that hides the rest of the
    // page and the modal chrome (header + close button), then
    // triggers the browser print dialog. Restored after print.
    const css = document.createElement('style');
    css.id = 'tb-yir-print-style';
    css.textContent =
      '@media print {' +
      '  body * { visibility: hidden !important; }' +
      '  #tb-yir-content, #tb-yir-content * { visibility: visible !important; }' +
      '  #tb-yir-content { position: absolute !important; left: 0; top: 0; width: 100%; padding: 24px !important; }' +
      '  [data-yir-no-print] { display: none !important; }' +
      '  .tb-card { break-inside: avoid; page-break-inside: avoid; }' +
      '}';
    document.head.appendChild(css);
    setTimeout(() => {
      window.print();
      setTimeout(() => { try { css.remove(); } catch (_) {} }, 500);
    }, 100);
  }

  // ====================================================================
  // CSV export
  // ====================================================================

  function exportLabsCsv() {
    const rows = [];
    rows.push(['exam_date', 'exam_type', 'test_name', 'value', 'unit', 'range_low', 'range_high', 'flag']);
    for (const e of getExams()) {
      for (const lr of (e.lab_results || [])) {
        rows.push([
          e.date || '',
          e.type || '',
          (lr.name || '').replace(/,/g, ' '),
          lr.value != null ? lr.value : '',
          lr.unit || '',
          lr.range_low != null ? lr.range_low : '',
          lr.range_high != null ? lr.range_high : '',
          lr.flag || '',
        ]);
      }
    }
    const csv = rows.map((r) => r.map((c) => {
      const s = String(c == null ? '' : c);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
    const fname = 'taigan-health-labs-' + new Date().toISOString().slice(0, 10) + '.csv';
    TB.utils.downloadFile(fname, csv, 'text/csv');
  }

  // ====================================================================
  // Input helpers (shared by all tabs)
  // ====================================================================

  function field(label, control, help) {
    const el = TB.utils.el;
    return el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, label),
      control,
      help ? el('div', { class: 'tb-field-help' }, help) : null,
    );
  }
  function textInput(val, onChange) {
    return TB.utils.el('input', {
      type: 'text', class: 'tb-input', value: val || '',
      oninput: (e) => onChange(e.target.value || ''),
    });
  }
  function numInput(val, onChange) {
    return TB.utils.el('input', {
      type: 'number', step: 'any', class: 'tb-input',
      style: { fontFamily: 'var(--tb-font-mono)' },
      value: val != null ? val : '',
      oninput: (e) => { const v = parseFloat(e.target.value); onChange(isFinite(v) ? v : null); },
    });
  }
  function dateInput(val, onChange) {
    return TB.utils.el('input', {
      type: 'date', class: 'tb-input',
      value: val || '',
      onchange: (e) => onChange(e.target.value || null),
    });
  }
  function textareaInput(val, onChange) {
    return TB.utils.el('textarea', {
      class: 'tb-textarea', rows: 3,
      oninput: (e) => onChange(e.target.value || ''),
    }, val || '');
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genAnnualPhysicalDue() {
    const physical = latestExamOfType('physical');
    if (!physical) {
      // No physical on file — surface a low-priority "first physical" item
      // only when we have at least some other exam data (signals the user
      // is engaged enough to act on it).
      const anyExam = getExams().length > 0;
      if (!anyExam) return [];
      return [{
        id: 'ht_no_physical',
        group: 'health', urgency: 'low', icon: '🩺',
        title: 'No annual physical on file',
        body: 'Add your most recent physical to the Health Tracker so we can track preventive screenings + the 1-year cadence.',
        module: 'health-tracker', snoozable: true,
      }];
    }
    const days = daysSince(physical.date);
    if (days < 330) return [];  // not yet due
    const urgency = days > 540 ? 'high' : days > 365 ? 'medium' : 'low';
    return [{
      id: 'ht_physical_due',
      group: 'health', urgency, icon: '🩺',
      title: 'Annual physical: ' + days + ' days since last',
      body: 'Last physical was ' + physical.date + '. USPSTF recommends annual for ages 30+; SOFA / TRICARE / NHI annual coverage. Book your next.',
      module: 'health-tracker', snoozable: true,
    }];
  }

  function genDentalCleaningDue() {
    const d = getDental();
    if (!d.last_cleaning) return [];
    const days = daysSince(d.last_cleaning);
    if (days < 165) return [];
    const urgency = days > 365 ? 'high' : days > 240 ? 'medium' : 'low';
    return [{
      id: 'ht_dental_due',
      group: 'health', urgency, icon: '🦷',
      title: 'Dental cleaning: ' + days + ' days since last',
      body: 'Last cleaning was ' + d.last_cleaning + '. Standard cadence is 6 months; insurance typically covers two per year.',
      module: 'health-tracker', snoozable: true,
    }];
  }

  function genMedRefillDue() {
    const out = [];
    for (const m of activeMeds()) {
      if (!m.next_refill_date) continue;
      const days = daysUntil(m.next_refill_date);
      if (days > 14 || days < -7) continue;  // window: 2 weeks ahead → 1 week past
      const urgency = days < 0 ? 'high' : days <= 3 ? 'high' : days <= 7 ? 'medium' : 'low';
      out.push({
        id: 'ht_refill_' + m.id,
        group: 'health', urgency, icon: '💊',
        title: (m.name || 'Medication') + ' refill ' + (days < 0 ? 'overdue' : 'in ' + days + 'd'),
        body: 'Pharmacy: ' + (m.pharmacy || '?') + (m.refills_remaining != null ? ' · ' + m.refills_remaining + ' refills left' : ''),
        deadline: m.next_refill_date,
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // Fires action items ONLY for screenings with a recorded last_done
  // date that's overdue by >1 year. 'never' status is intentionally
  // suppressed — nagging the user about every-not-yet-recorded
  // screening on first load is too noisy (especially before they've
  // set their sex/age preferences and the library is fully filtered).
  function genScreeningsOverdue() {
    const out = [];
    const lang = TB.i18n.getLang();
    for (const s of computeScreeningsDue()) {
      if (s.status !== 'critical') continue;
      if (s.last_done == null) continue;            // never-done items don't nag
      if (!isFinite(s.overdue_days)) continue;      // safety net
      const label = lang === 'ja' ? s.label_jp : s.label_en;
      out.push({
        id: 'ht_screen_' + s.library_id,
        group: 'health', urgency: 'medium', icon: '🎯',
        title: label + ' overdue by ' + Math.round(s.overdue_days) + ' days',
        body: 'Last done: ' + s.last_done + '. Recommended cadence: every ' + s.interval_years + ' year(s). Open Health Tracker → Care Plan to log when completed.',
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // Episode-level action items. Fires for:
  //   • Active episodes with no attached records (likely user created
  //     the episode and forgot to attach exams)
  //   • Episodes with submitted/pending reimbursement aged >30 days
  //     (likely got stuck somewhere in the insurance process)
  //   • Completed-status episodes with future-dated "next appointment"
  //     hints in notes (not implemented — would need NLP)
  function genActiveEpisodeEmpty() {
    const out = [];
    for (const ep of getEpisodes()) {
      if (ep.status !== 'active') continue;
      const examCount = examsForEpisode(ep.id).length;
      const medCount = medicationsForEpisode(ep.id).length;
      const invCount = invoicesForEpisode(ep.id).length;
      if (examCount > 0 || medCount > 0 || invCount > 0) continue;
      const days = daysSince(ep.started_date || ep.created_at);
      if (days < 7) continue;  // give the user a week to populate
      out.push({
        id: 'ht_ep_empty_' + ep.id,
        group: 'health', urgency: 'low', icon: '🧭',
        title: 'Episode "' + (ep.title || 'untitled') + '" has no attached records',
        body: 'Started ' + (ep.started_date || '?') + '. Attach the related exams, medications, or invoices in Health Tracker → Care Episodes.',
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  function genPendingReimbursement() {
    const out = [];
    const today = new Date();
    for (const inv of getInvoices()) {
      if (inv.reimbursement_status !== 'submitted' && inv.reimbursement_status !== 'pending') continue;
      const submittedDate = inv.paid_date || inv.date;
      if (!submittedDate) continue;
      const days = Math.floor((today.getTime() - new Date(submittedDate + 'T00:00:00').getTime()) / 86400000);
      if (days < 30) continue;
      const urgency = days > 90 ? 'high' : days > 60 ? 'medium' : 'low';
      out.push({
        id: 'ht_reim_pending_' + inv.id,
        group: 'health', urgency, icon: '🏥',
        title: 'Reimbursement ' + inv.reimbursement_status + ' for ' + days + ' days',
        body: (inv.provider || 'Unknown provider') + ' · ' + inv.date + ' · ' +
              (inv.amount_native != null ? inv.amount_native.toLocaleString() + ' ' + (inv.currency || 'USD') : '?') +
              '. Follow up with the insurer or pharmacy benefit manager.',
        deadline: null,
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  function genAbnormalLabFlags() {
    const out = [];
    const latest = latestExam();
    if (!latest) return out;
    const days = daysSince(latest.date);
    if (days > 90) return out;  // only flag recently
    const flagged = (latest.lab_results || []).filter((lr) =>
      lr.flag === 'high' || lr.flag === 'low' || lr.flag === 'critical');
    if (flagged.length === 0) return out;
    const critical = flagged.filter((lr) => lr.flag === 'critical');
    const urgency = critical.length > 0 ? 'high' : 'medium';
    out.push({
      id: 'ht_abnormal_' + latest.id,
      group: 'health', urgency, icon: critical.length > 0 ? '🚨' : '⚠',
      title: flagged.length + ' abnormal lab value' + (flagged.length === 1 ? '' : 's') + ' on your ' + latest.date + ' panel',
      body: 'Flagged: ' + flagged.map((lr) => lr.name + ' ' + (lr.flag || '').toUpperCase()).slice(0, 4).join(', ') +
        (flagged.length > 4 ? '…' : '') + '. Review in Health Tracker; bring questions to your next appointment.',
      module: 'health-tracker', snoozable: true,
    });
    return out;
  }

  // ─── v0.57 generators ───────────────────────────────────────────

  // Unchecked action items from dental notes that have been sitting
  // open. Fires per note when ≥1 action_item is still unchecked AND
  // the note is ≥7 days old (so we give the user some breathing room
  // right after import). Severity escalates with age.
  function genDentalNoteActionItems() {
    const out = [];
    const notes = (getDental().notes_log) || [];
    for (const n of notes) {
      if (n.status === 'complete') continue;
      const items = (n.action_items || []).filter((x) => x && x.text && !x.checked);
      if (items.length === 0) continue;
      const days = daysSince(n.date);
      if (days < 7) continue;  // grace period
      const urgency = days > 90 ? 'high' : days > 30 ? 'medium' : 'low';
      out.push({
        id: 'ht_dental_actions_' + n.id,
        group: 'health', urgency, icon: '🦷',
        title: items.length + ' unchecked dental action item' + (items.length === 1 ? '' : 's') +
          ' from ' + n.date,
        body: items.slice(0, 3).map((x) => '• ' + x.text).join('\n') +
          (items.length > 3 ? '\n• …+' + (items.length - 3) + ' more' : ''),
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // Insurance cards approaching expiry. Standard window: 60 days
  // ahead, since insurance renewal logistics (employer election,
  // provider re-verification) take real time.
  function genInsuranceCardExpiring() {
    const out = [];
    const ins = getInsuranceSummary();
    const cards = ins.cards || [];
    for (const c of cards) {
      if (!c.expiry_date) continue;
      const days = daysUntil(c.expiry_date);
      if (days > 60 || days < -7) continue;  // skip far-future + long-past
      const urgency = days < 0 ? 'critical' : days <= 14 ? 'high' : days <= 30 ? 'medium' : 'low';
      const label = c.insurer ? (c.insurer + (c.plan_name ? ' — ' + c.plan_name : '')) : (c.plan_name || 'Insurance card');
      out.push({
        id: 'ht_ins_expiry_' + c.id,
        group: 'health', urgency,
        icon: c.card_type === 'dental' ? '🦷' : c.card_type === 'vision' ? '👁' : '🛡️',
        title: days < 0
          ? label + ' expired ' + Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' ago'
          : label + ' expires in ' + days + ' day' + (days === 1 ? '' : 's'),
        body: 'Member ID ••••' + (c.member_id_last4 || '????') + (c.network_type ? ' · ' + c.network_type : '') +
          '. Confirm renewal with HR / insurer; update the card details here.',
        deadline: c.expiry_date,
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // Upcoming dental appointments — 7-day window. Useful as a "this
  // week" prompt; doesn't fire for events further out.
  function genDentalAppointmentsUpcoming() {
    const out = [];
    const today = new Date().toISOString().slice(0, 10);
    const appts = (getDental().appointments || []).filter((a) => a.date && a.date >= today);
    appts.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (const a of appts.slice(0, 3)) {
      const days = daysUntil(a.date);
      if (days > 7) continue;
      const urgency = days <= 1 ? 'high' : days <= 3 ? 'medium' : 'low';
      const providers = getDentalProviders();
      const prov = a.provider_id ? providers.find((p) => p.id === a.provider_id) : null;
      out.push({
        id: 'ht_dental_appt_' + a.id,
        group: 'health', urgency, icon: '📅',
        title: days === 0 ? 'Dental appointment today'
              : days === 1 ? 'Dental appointment tomorrow'
              : 'Dental appointment in ' + days + ' days · ' + a.date,
        body: (a.time ? a.time + ' · ' : '') +
              (prov ? (prov.name_en || prov.name_jp || '') : '') +
              (a.purpose ? ' — ' + a.purpose : ''),
        deadline: a.date,
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // Unpaid invoices >30 days old. Catches billing that fell through
  // the cracks. Skips invoices that are insurance-pending (waiting on
  // claim resolution is normal and tracked separately).
  function genUnpaidInvoicesOld() {
    const out = [];
    const today = new Date();
    for (const inv of getInvoices()) {
      if (inv.paid === true) continue;
      if (!inv.date) continue;
      // Skip if claim is still working through insurance — handled by
      // genPendingReimbursement.
      if (inv.reimbursement_status === 'submitted' || inv.reimbursement_status === 'pending') continue;
      const days = Math.floor((today.getTime() - new Date(inv.date + 'T00:00:00').getTime()) / 86400000);
      if (days < 30) continue;
      const urgency = days > 120 ? 'high' : days > 60 ? 'medium' : 'low';
      const sym = ({ USD: '$', JPY: '¥', EUR: '€', GBP: '£' })[inv.currency || 'USD'] || (inv.currency + ' ');
      const amt = inv.amount_native != null
        ? sym + (inv.currency === 'JPY' ? Math.round(inv.amount_native).toLocaleString() : inv.amount_native.toLocaleString())
        : '?';
      out.push({
        id: 'ht_unpaid_inv_' + inv.id,
        group: 'health', urgency, icon: '🧾',
        title: 'Unpaid invoice from ' + inv.date + ' · ' + amt,
        body: (inv.provider || 'Provider unknown') + ' · ' + days + ' days old. ' +
          'Pay it or mark paid in Health Tracker if already settled.',
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // Insurance claims that have been submitted but stuck. Different
  // from genPendingReimbursement (broader): this checks denial status
  // explicitly and surfaces "denied" claims so they don't get forgotten.
  function genInsuranceClaimsDenied() {
    const out = [];
    for (const inv of getInvoices()) {
      if (inv.reimbursement_status !== 'denied') continue;
      out.push({
        id: 'ht_claim_denied_' + inv.id,
        group: 'health', urgency: 'high', icon: '✗',
        title: 'Insurance claim denied — ' + (inv.provider || 'Provider'),
        body: 'Invoice from ' + inv.date + '. Review the denial reason, appeal if appropriate, or mark this paid/closed.',
        module: 'health-tracker', snoozable: true,
      });
    }
    return out;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'Health Tracker',
    label_jp: 'ヘルストラッカー',
    render,
  };

  window.TB.healthTracker = {
    getExams, upsertExam, deleteExam,
    getMeds, upsertMed, deleteMed,
    getCarePlan, setCarePlan,
    getDental, setDental,
    trendForLabTest, allLabTests, computeScreeningsDue,
    latestExam, latestExamOfType,
    latestExamWithBloodPanel, examHasBloodPanel, isBloodPanelLab,
    // Episodes + invoices public API
    getEpisodes, upsertEpisode, deleteEpisode,
    getInvoices, upsertInvoice, deleteInvoice,
    examsForEpisode, medicationsForEpisode, invoicesForEpisode,
    totalCostForEpisode,
    actionGenerators: [
      genAnnualPhysicalDue, genDentalCleaningDue, genMedRefillDue,
      genScreeningsOverdue, genAbnormalLabFlags,
      genActiveEpisodeEmpty, genPendingReimbursement,
      // v0.57 cross-module rollup additions
      genDentalNoteActionItems, genInsuranceCardExpiring,
      genDentalAppointmentsUpcoming, genUnpaidInvoicesOld,
      genInsuranceClaimsDenied,
    ],
  };
})();
