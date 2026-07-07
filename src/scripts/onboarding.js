/* Taigan Bridge — onboarding.js  (v2)
 *
 * Renders the onboarding wizard, persists each answer to state, and on
 * submit computes the user's tracks via TB.tracks.assign and writes
 * them back to state.
 *
 * v2 capabilities (2026-05):
 *   • showIf predicates per question — questions can declare a function
 *     of prior answers; if it returns false the question is skipped
 *     (e.g., non_sofa_jp_income only shows when tax_status === 'sofa_no_file').
 *   • Default values driven by prior answers — jp_filing_responsibility
 *     pre-selects 'spouse' for SOFA + spouse households, 'na' for SOFA
 *     solo, 'self' for everyone else (matches the logic in
 *     tax-coordinator.js → deriveJpFilingResponsibility).
 *   • Edit-single-question mode — TB.onboarding.start(host, { editQuestionId })
 *     renders just that one question with a "save and return" button
 *     instead of the full wizard. Used by the Profile page.
 *   • Module-state sync on finish — answers that drive module behavior
 *     (jp_filing_responsibility, retirement_horizon, healthcare_coverage,
 *     fx_platforms, ai_consent) are written into the corresponding
 *     module's state so the modules don't have to re-read onboarding
 *     answers on every render.
 *
 * Question definitions live in content/inline.js (window.TB.content
 * .onboardingQuestions).
 */

(function () {
  'use strict';

  const DEFAULT_QUESTIONS_URL = 'content/onboarding-questions.json';

  let QUESTIONS = null;
  let stepIndex = 0;
  let workingAnswers = {};
  let host = null;
  // When set, the wizard renders only this single question with a
  // "save and return" button. Used by Profile → Quick edit.
  let editOnlyId = null;
  let editReturnView = null;

  async function loadQuestions() {
    if (QUESTIONS) return QUESTIONS;
    if (window.TB && window.TB.content && window.TB.content.onboardingQuestions) {
      QUESTIONS = window.TB.content.onboardingQuestions;
      return QUESTIONS;
    }
    // Defensive fetch fallback — used only if content/inline.js was
    // not loaded for some reason. Wrapped in try/catch because under
    // file:// the browser blocks fetch with a CORS error.
    try {
      const res = await fetch(DEFAULT_QUESTIONS_URL, { cache: 'no-store' });
      if (res.ok) {
        QUESTIONS = await res.json();
        return QUESTIONS;
      }
    } catch (_) { /* fall through */ }
    throw new Error(
      'Onboarding questions unavailable. Load content/inline.js or ' +
      'serve the app over http (npm run dev).',
    );
  }

  function pickText(q, key) {
    const lang = TB.i18n.getLang();
    return q[key + '_' + (lang === 'ja' ? 'jp' : 'en')] || q[key + '_en'] || '';
  }

  function pickOptionLabel(opt) {
    const lang = TB.i18n.getLang();
    return opt['label_' + (lang === 'ja' ? 'jp' : 'en')] || opt.label_en || opt.value;
  }

  async function start(container, opts) {
    host = container;
    opts = opts || {};
    const existing = TB.state.get('onboarding.answers') || {};
    workingAnswers = opts.fresh ? {} : Object.assign({}, existing);
    // Pre-populate the display name fields from the existing profile
    // so a returning user sees their saved names already filled in
    // (rather than having to retype on every re-run of onboarding).
    const profile = TB.state.get('profile') || {};
    if (!workingAnswers.display_name && profile.displayName) {
      workingAnswers.display_name = profile.displayName;
    }
    if (!workingAnswers.display_name_ja && profile.displayNameJa) {
      workingAnswers.display_name_ja = profile.displayNameJa;
    }
    editOnlyId = opts.editQuestionId || null;
    editReturnView = opts.returnTo || 'profile';
    stepIndex = 0;
    try {
      await loadQuestions();
    } catch (err) {
      // loadQuestions() throws when content/inline.js wasn't loaded AND
      // the fallback fetch failed (always the case under file://, since
      // local fetch is blocked there). Without this catch, callers that
      // don't attach a .catch (e.g. index.html's start() call) leave the
      // user staring at an indefinite "Loading…" state with only a
      // console rejection to go on. Render a visible message directly
      // into the container we were given instead.
      console.error('[onboarding] failed to load questions:', err);
      if (host) {
        host.innerHTML = '';
        host.appendChild(TB.utils.el('div', { class: 'tb-card', 'data-track': 'core' },
          TB.utils.el('p', { class: 'tb-disclaimer-inline' },
            'Onboarding content failed to load — try reloading the page.',
          ),
        ));
      }
      return;
    }
    if (editOnlyId) {
      // Find the matching question and render directly.
      const idx = QUESTIONS.findIndex((q) => q.id === editOnlyId);
      if (idx === -1) {
        console.warn('[onboarding] edit-only question not found:', editOnlyId);
        renderIntro();
        return;
      }
      stepIndex = idx;
      renderEditOnly();
      return;
    }
    renderIntro();
  }

  // ────────────────────────────────────────────────────────────────────
  // VISIBILITY (showIf) + DEFAULT VALUES
  // ────────────────────────────────────────────────────────────────────
  //
  // showIf predicates live in inline.js as q.showIf(answers) — kept as
  // functions because JSON can't carry logic. We evaluate against the
  // current workingAnswers, NOT stored answers, so a user can flip an
  // earlier answer mid-flow and the dependent questions reflow live.

  function isVisible(q) {
    if (typeof q.showIf !== 'function') return true;
    try { return !!q.showIf(workingAnswers); } catch (_) { return true; }
  }

  function visibleQuestions() {
    return QUESTIONS.filter(isVisible);
  }

  function visibleIndexOf(q) {
    return visibleQuestions().indexOf(q);
  }

  // For questions whose default depends on prior answers, return the
  // suggested initial value. Currently used by jp_filing_responsibility
  // (mirrors deriveJpFilingResponsibility in tax-coordinator.js so the
  // user sees a sensible pre-selection even before saving).
  function suggestedDefault(qId) {
    const a = workingAnswers;
    if (qId === 'jp_filing_responsibility') {
      const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
      const hasSpouse = fam.indexOf('jp_spouse') !== -1
                     || fam.indexOf('us_spouse') !== -1
                     || fam.indexOf('third_spouse') !== -1;
      if (a.tax_status === 'sofa_no_file') {
        // Even SOFA holders need to file 確定申告 if they have non-SOFA
        // JP income — bias toward 'self' in that case.
        if (a.non_sofa_jp_income === 'yes') return 'self';
        return hasSpouse ? 'spouse' : 'na';
      }
      if (a.tax_status === 'us_only') return 'na';
      if (a.tax_status === 'japan_resident' || a.tax_status === 'japan_filer') return 'self';
      return 'self';
    }
    return undefined;
  }

  function renderIntro() {
    const el = TB.utils.el;
    host.innerHTML = '';
    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h1', null, TB.i18n.t('onboarding.intro.title')),
      el('p', null, TB.i18n.t('onboarding.intro.body')),
      el('div', { class: 'tb-disclaimer-inline' },
        TB.i18n.t('banner.disclaimer'),
      ),
      el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn',
          onclick: () => { stepIndex = 0; renderStep(); },
        }, TB.i18n.t('onboarding.start')),
        // "Try with sample data" — fast-path for new visitors who
        // want to evaluate the tool before committing to entering
        // real numbers. Skips onboarding entirely and loads a
        // complete fictional household. Only shown when the demo
        // module is available (it self-installs via sample-data.js).
        (TB.sampleData && typeof TB.sampleData.loadInteractive === 'function')
          ? el('button', {
              class: 'tb-btn tb-btn--ghost',
              type: 'button',
              onclick: () => TB.sampleData.loadInteractive(),
              title: TB.i18n.t('onboarding.tryDemo.tooltip'),
            }, '🧪 ' + TB.i18n.t('onboarding.tryDemo'))
          : null,
      ),
    );
    host.appendChild(card);
  }

  function renderStep() {
    const el = TB.utils.el;
    const q = QUESTIONS[stepIndex];
    if (!q) return finish();
    // If the current question shouldn't show given prior answers,
    // skip forward (or finish if we ran past the end).
    if (!isVisible(q)) {
      stepIndex += 1;
      if (stepIndex >= QUESTIONS.length) return finish();
      return renderStep();
    }

    // Apply suggested default if this question hasn't been touched yet.
    if (workingAnswers[q.id] === undefined) {
      const suggested = suggestedDefault(q.id);
      if (suggested !== undefined) workingAnswers[q.id] = suggested;
    }

    host.innerHTML = '';

    // Progress bar uses the VISIBLE question count so users see an
    // honest "step n of m" rather than counting branches they'll never
    // see.
    const visible = visibleQuestions();
    const visIdx = visible.indexOf(q);

    const progress = el('div', { class: 'tb-wizard-progress' },
      ...visible.map((_, i) => {
        let cls = 'tb-wizard-step';
        if (i < visIdx) cls += ' is-done';
        else if (i === visIdx) cls += ' is-current';
        return el('div', { class: cls });
      }),
    );

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      progress,
      el('div', { class: 'tb-card-meta' },
        TB.i18n.t('onboarding.progress', { n: visIdx + 1, total: visible.length }),
      ),
      el('h2', { class: 'tb-wizard-question' }, pickText(q, 'question')),
      pickText(q, 'helpText') ? el('p', { class: 'tb-wizard-help' }, pickText(q, 'helpText')) : null,
      renderInput(q),
      el('div', { id: 'tb-onboarding-error', class: 'tb-disclaimer-inline', style: { display: 'none' } },
        TB.i18n.t('onboarding.required'),
      ),
      el('div', { class: 'tb-btn-row' },
        visIdx > 0
          ? el('button', { class: 'tb-btn tb-btn--secondary', onclick: prev }, TB.i18n.t('onboarding.back'))
          : null,
        el('button', { class: 'tb-btn', onclick: next },
          visIdx === visible.length - 1 ? TB.i18n.t('onboarding.finish') : TB.i18n.t('onboarding.next'),
        ),
      ),
    );

    host.appendChild(card);
  }

  // Edit-single-question mode. Renders just one question with "Save"
  // and "Cancel" buttons. Used by the Profile page to let the user
  // update one answer without re-running the whole wizard.
  function renderEditOnly() {
    const el = TB.utils.el;
    const q = QUESTIONS[stepIndex];
    if (!q) return;
    host.innerHTML = '';

    // Apply suggested default when missing (gives the picker a sensible
    // initial selection even on first edit).
    if (workingAnswers[q.id] === undefined) {
      const suggested = suggestedDefault(q.id);
      if (suggested !== undefined) workingAnswers[q.id] = suggested;
    }

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } },
        '✎ ' + TB.i18n.t('onboarding.editOne')),
      el('h2', { class: 'tb-wizard-question' }, pickText(q, 'question')),
      pickText(q, 'helpText') ? el('p', { class: 'tb-wizard-help' }, pickText(q, 'helpText')) : null,
      renderInput(q),
      el('div', { id: 'tb-onboarding-error', class: 'tb-disclaimer-inline', style: { display: 'none' } },
        TB.i18n.t('onboarding.required'),
      ),
      el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          onclick: () => {
            editOnlyId = null;
            const view = editReturnView || 'profile';
            editReturnView = null;
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view } }));
          },
        }, TB.i18n.t('onboarding.cancel')),
        el('button', {
          class: 'tb-btn',
          onclick: () => {
            if (!isAnswered(q)) {
              const err = document.getElementById('tb-onboarding-error');
              if (err) err.style.display = 'block';
              return;
            }
            saveSingleAnswer();
          },
        }, TB.i18n.t('onboarding.save')),
      ),
    );
    host.appendChild(card);
  }

  // Save one answer + re-derive tracks/modules without re-running
  // the full wizard. Returns the user to the editReturnView.
  function saveSingleAnswer() {
    const existing = TB.state.get('onboarding.answers') || {};
    const merged = Object.assign({}, existing, workingAnswers);
    const result = TB.tracks.assign(merged);
    TB.state.set('onboarding', {
      complete: TB.state.get('onboarding.complete') === true,
      answers: merged,
      completedAt: TB.state.get('onboarding.completedAt') || new Date().toISOString(),
      lastEditedAt: new Date().toISOString(),
    });
    TB.state.set('tracks', result.tracks);
    TB.state.set('modules.unlocked', result.modules);
    syncToModuleState(merged);
    const view = editReturnView || 'profile';
    editOnlyId = null;
    editReturnView = null;
    document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view } }));
  }

  function renderInput(q) {
    const el = TB.utils.el;
    const value = workingAnswers[q.id];

    if (q.type === 'single' || q.type === 'radio') {
      return el('div', { class: 'tb-radio-group' },
        ...q.options.map((opt) => {
          const id = `tb-q-${q.id}-${opt.value}`;
          const selected = value === opt.value;
          return el('label', {
            class: 'tb-radio' + (selected ? ' is-selected' : ''),
            for: id,
          },
            el('input', {
              type: 'radio',
              id,
              name: q.id,
              value: opt.value,
              checked: selected,
              onchange: (e) => {
                workingAnswers[q.id] = e.target.value;
                renderStep();
              },
            }),
            el('div', null,
              el('div', null, pickOptionLabel(opt)),
              opt['hint_' + (TB.i18n.getLang() === 'ja' ? 'jp' : 'en')]
                ? el('small', null, opt['hint_' + (TB.i18n.getLang() === 'ja' ? 'jp' : 'en')])
                : null,
            ),
          );
        }),
      );
    }

    if (q.type === 'multi' || q.type === 'checkbox') {
      const set = new Set(Array.isArray(value) ? value : []);
      return el('div', { class: 'tb-checkbox-group' },
        ...q.options.map((opt) => {
          const id = `tb-q-${q.id}-${opt.value}`;
          const checked = set.has(opt.value);
          return el('label', {
            class: 'tb-checkbox' + (checked ? ' is-selected' : ''),
            for: id,
          },
            el('input', {
              type: 'checkbox',
              id,
              name: q.id,
              value: opt.value,
              checked,
              onchange: (e) => {
                if (e.target.checked) set.add(opt.value);
                else set.delete(opt.value);
                workingAnswers[q.id] = Array.from(set);
                renderStep();
              },
            }),
            el('div', null,
              el('div', null, pickOptionLabel(opt)),
            ),
          );
        }),
      );
    }

    if (q.type === 'text') {
      return el('input', {
        type: 'text',
        class: 'tb-input',
        value: value || '',
        oninput: (e) => { workingAnswers[q.id] = e.target.value; },
      });
    }

    if (q.type === 'date') {
      return el('input', {
        type: 'date',
        class: 'tb-input',
        value: value || '',
        oninput: (e) => { workingAnswers[q.id] = e.target.value || null; },
      });
    }

    return el('div', null, '[unsupported question type: ' + q.type + ']');
  }

  function isAnswered(q) {
    const v = workingAnswers[q.id];
    if (q.optional) return true;
    if (q.type === 'multi' || q.type === 'checkbox') return Array.isArray(v) && v.length > 0;
    if (q.type === 'text') return typeof v === 'string' && v.trim().length > 0;
    if (q.type === 'date') return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    return v !== undefined && v !== '' && v !== null;
  }

  function next() {
    const q = QUESTIONS[stepIndex];
    if (!isAnswered(q)) {
      const err = document.getElementById('tb-onboarding-error');
      if (err) err.style.display = 'block';
      return;
    }
    // Walk forward over invisible questions until we find a visible
    // one — branching means the next visible question may not be the
    // immediate stepIndex + 1.
    let nextIdx = stepIndex + 1;
    while (nextIdx < QUESTIONS.length && !isVisible(QUESTIONS[nextIdx])) nextIdx += 1;
    if (nextIdx >= QUESTIONS.length) return finish();
    stepIndex = nextIdx;
    renderStep();
  }

  function prev() {
    // Walk backward over invisible questions for the same reason.
    let prevIdx = stepIndex - 1;
    while (prevIdx >= 0 && !isVisible(QUESTIONS[prevIdx])) prevIdx -= 1;
    if (prevIdx < 0) { renderIntro(); return; }
    stepIndex = prevIdx;
    renderStep();
  }

  function finish() {
    const result = TB.tracks.assign(workingAnswers);
    TB.state.set('onboarding', {
      complete: true,
      answers: workingAnswers,
      completedAt: new Date().toISOString(),
    });
    TB.state.set('tracks', result.tracks);
    TB.state.set('modules.unlocked', result.modules);

    // Sync display-name answers into the profile so the dashboard
    // shows the personalized title. Empty answer = clear; trim
    // whitespace; tolerate the case where profile didn't exist yet.
    const profile = TB.state.get('profile') || {};
    const nameEn = (workingAnswers.display_name || '').trim();
    const nameJa = (workingAnswers.display_name_ja || '').trim();
    if (nameEn) profile.displayName = nameEn;
    profile.displayNameJa = nameJa || profile.displayNameJa || '';
    TB.state.set('profile', profile);

    // Sync separation date into veteran.service.discharge_date so the
    // Veteran module's benefit-window calculations work without the
    // user having to enter the date twice. Only writes if onboarding
    // captured a value AND the existing service record doesn't have
    // one yet (don't clobber user-entered service info).
    if (workingAnswers.separation_date) {
      const vet = TB.state.get('veteran') || {};
      vet.service = vet.service || {};
      if (!vet.service.discharge_date) {
        vet.service.discharge_date = workingAnswers.separation_date;
        TB.state.set('veteran', vet);
      }
    }

    // Sync the new v2 answers into their respective modules so users
    // don't have to re-discover the relevant pickers/toggles.
    syncToModuleState(workingAnswers);

    document.dispatchEvent(new CustomEvent('tb:onboarding-complete', { detail: result }));
  }

  // ────────────────────────────────────────────────────────────────────
  // MODULE-STATE SYNC
  // ────────────────────────────────────────────────────────────────────
  //
  // Called from both finish() and saveSingleAnswer(). For each new v2
  // answer, write into the corresponding module's state if the user
  // explicitly set a value. We DO NOT clobber existing module-level
  // state (the picker the user adjusted by hand wins) — only fill in
  // when the module field is null/undefined OR matches the previous
  // onboarding-derived value.

  function syncToModuleState(answers) {
    if (!answers) return;

    // jp_filing_responsibility → tax_coordinator.jp_filing_responsibility
    if (answers.jp_filing_responsibility) {
      const coord = TB.state.get('tax_coordinator') || {};
      const cur = coord.jp_filing_responsibility;
      // Only set when the user hasn't already overridden it via the
      // Tax Coordinator picker (cur is null/undefined or equals 'auto').
      if (cur == null || cur === 'auto' || cur === answers.jp_filing_responsibility) {
        coord.jp_filing_responsibility = answers.jp_filing_responsibility;
        TB.state.set('tax_coordinator', coord);
      }
    }

    // healthcare_coverage → healthcare.coverage_types[]
    if (Array.isArray(answers.healthcare_coverage) && answers.healthcare_coverage.length) {
      const hc = TB.state.get('healthcare') || {};
      // Don't clobber if user has already curated the list themselves
      // (we treat any non-empty existing list as user-touched).
      if (!Array.isArray(hc.coverage_types) || hc.coverage_types.length === 0) {
        hc.coverage_types = answers.healthcare_coverage.slice();
        TB.state.set('healthcare', hc);
      }
    }

    // retirement_horizon → decumulation.retirement_horizon
    if (answers.retirement_horizon) {
      const dec = TB.state.get('decumulation') || {};
      if (!dec.retirement_horizon) {
        dec.retirement_horizon = answers.retirement_horizon;
        TB.state.set('decumulation', dec);
      }
    }

    // fx_platforms → fx_banking.platforms_used[] (pre-fills which
    // platform tiles get unlocked / surfaced first in the FX module).
    if (Array.isArray(answers.fx_platforms) && answers.fx_platforms.length) {
      const fx = TB.state.get('fx_banking') || {};
      if (!Array.isArray(fx.platforms_used) || fx.platforms_used.length === 0) {
        fx.platforms_used = answers.fx_platforms.slice();
        TB.state.set('fx_banking', fx);
      }
    }

    // ai_consent → settings.ai_consent + appropriate downstream toggles.
    // 'off' explicitly disables AI features by clearing the API key
    // is too aggressive (user may have paid for credits) — instead we
    // store the consent posture and let modules check it before any
    // call. The Settings card surfaces this with a banner.
    if (answers.ai_consent) {
      TB.state.set('settings.ai_consent', answers.ai_consent);
    }

    // consultations_history → consultations.suggested_starting_point
    // Pre-fills the empty state so the module doesn't look bare on
    // first open. We don't auto-create log entries (no facts to put
    // in them) — just record the user's posture so the module can
    // show a relevant CTA ("Add your CPA's contact?" vs "Find a CPA").
    if (answers.consultations_history) {
      const cons = TB.state.get('consultations') || {};
      if (!cons.suggested_starting_point) {
        cons.suggested_starting_point = answers.consultations_history;
        TB.state.set('consultations', cons);
      }
    }

    // non_sofa_jp_income → tax_coordinator.manual_overrides.has_non_sofa_jp_income
    // Used by the Tax Coordinator to decide whether 確定申告 is required
    // even for SOFA holders.
    if (answers.non_sofa_jp_income) {
      const coord = TB.state.get('tax_coordinator') || {};
      coord.manual_overrides = coord.manual_overrides || {};
      if (coord.manual_overrides.has_non_sofa_jp_income == null) {
        coord.manual_overrides.has_non_sofa_jp_income = (answers.non_sofa_jp_income === 'yes');
        TB.state.set('tax_coordinator', coord);
      }
    }

    // birth_year + biological_sex → health_tracker.preferences
    // Used by Health Tracker for screening filtering and Medicare IEP
    // detection in Decumulation / Healthcare.
    if (answers.birth_year || answers.biological_sex) {
      const ht = TB.state.get('health_tracker') || {};
      ht.preferences = ht.preferences || {};
      if (answers.birth_year && /^\d{4}$/.test(String(answers.birth_year))) {
        const by = parseInt(answers.birth_year, 10);
        if (by > 1900 && by < 2100) {
          ht.preferences.age = new Date().getFullYear() - by;
        }
      }
      if (answers.biological_sex && !ht.preferences.sex) {
        ht.preferences.sex = answers.biological_sex;
      }
      TB.state.set('health_tracker', ht);
    }
  }

  // Convenience wrapper for Profile → Quick edit. Navigates to the
  // dashboard view first, then mounts the wizard in single-edit mode.
  // Caller passes the question id and (optionally) where to return to.
  function startEditOne(questionId, returnTo) {
    const view = document.getElementById('tb-view');
    if (!view) return;
    start(view, { editQuestionId: questionId, returnTo: returnTo || 'profile' });
  }

  window.TB = window.TB || {};
  window.TB.onboarding = { start, startEditOne, loadQuestions };
})();
