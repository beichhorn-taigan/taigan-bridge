/* Taigan Bridge — ai-client.js
 *
 * Minimal Claude API wrapper. The user pastes their key into Settings;
 * it's stored only in localStorage and used for direct calls from the
 * browser to api.anthropic.com.
 *
 * callClaude is the single entry point. A real network call only happens
 * when the caller passes { live: true }; without it, callClaude returns a
 * deterministic stub. This is a deliberate guardrail so a caller that
 * forgets the flag can never silently spend the user's money — every
 * module that wants a real answer opts in explicitly.
 */

(function () {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const ANTHROPIC_VERSION = '2023-06-01';
  const DEFAULT_MODEL = 'claude-sonnet-4-6';

  // ====================================================================
  // MODEL CATALOG
  // ====================================================================
  // Pricing is per million tokens, USD. Values are approximate Anthropic
  // public-pricing snapshots and may drift; the displayed labels in
  // Settings are the source of truth users see and verify against
  // anthropic.com pricing.
  // ====================================================================

  const MODEL_CATALOG = [
    {
      id: 'claude-opus-4-7',
      label_en: 'Opus 4.7 — most capable',
      label_jp: 'Opus 4.7 — 最も高性能',
      input_per_m: 15,
      output_per_m: 75,
      group: 'frontier',
    },
    {
      id: 'claude-sonnet-4-6',
      label_en: 'Sonnet 4.6 — balanced (recommended)',
      label_jp: 'Sonnet 4.6 — バランス型(推奨)',
      input_per_m: 3,
      output_per_m: 15,
      group: 'balanced',
      recommended: true,
    },
    {
      id: 'claude-haiku-4-5-20251001',
      label_en: 'Haiku 4.5 — fast & cheap',
      label_jp: 'Haiku 4.5 — 高速・安価',
      input_per_m: 1,
      output_per_m: 5,
      group: 'fast',
    },
    {
      id: 'claude-sonnet-4-20250514',
      label_en: 'Sonnet 4 (legacy)',
      label_jp: 'Sonnet 4 (旧)',
      input_per_m: 3,
      output_per_m: 15,
      group: 'legacy',
    },
  ];

  function findModel(id) {
    for (const m of MODEL_CATALOG) if (m.id === id) return m;
    return null;
  }

  function modelPriceLabel(m) {
    if (!m) return '';
    return '$' + m.input_per_m + '/M in · $' + m.output_per_m + '/M out';
  }

  function getApiKey() {
    return TB.state.get('settings.apiKey') || '';
  }

  function getModel() {
    const stored = TB.state.get('settings.model');
    if (stored && findModel(stored)) return stored;
    return DEFAULT_MODEL;
  }

  function getModelInfo() {
    return findModel(getModel()) || findModel(DEFAULT_MODEL);
  }

  function hasKey() {
    const k = getApiKey();
    return typeof k === 'string' && k.startsWith('sk-ant-');
  }

  // ====================================================================
  // USAGE TRACKING + COST COMPUTATION
  // ====================================================================

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function computeCost(modelId, inputTokens, outputTokens) {
    const m = findModel(modelId) || findModel(DEFAULT_MODEL);
    if (!m) return 0;
    const inUsd = (Number(inputTokens) || 0) / 1_000_000 * m.input_per_m;
    const outUsd = (Number(outputTokens) || 0) / 1_000_000 * m.output_per_m;
    return inUsd + outUsd;
  }

  function getUsage() {
    return TB.state.get('settings.usage') || {
      daily: {},
      daily_limit_usd: 0,
      all_time: { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 },
    };
  }

  function setUsage(u) { TB.state.set('settings.usage', u); }

  function todayUsage() {
    const u = getUsage();
    return u.daily[todayKey()] || { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
  }

  // Canonical feature IDs for per-feature attribution. Display labels
  // and bucket order live in i18n (settings.ai.features.*); keep this
  // list in sync with the call-sites that pass `feature` into recordUsage.
  const FEATURE_IDS = [
    'chat',              // generic callClaude (no feature override)
    'fbar_chat',         // FBAR Q&A bot
    'fbar_vision',       // FBAR passbook / statement extraction
    'fbar_enrichment',   // FBAR institution enrichment
    'asset_vision',      // Asset statement extraction
    'asset_enrichment',  // Asset institution enrichment
    'document_vision',   // Document Vault metadata extraction
    'medical_vision',    // Health Tracker — lab/exam result extraction
    'ask_taigan',        // Ask Taigan AI assistant
    'health_check',      // API key health-check ping
    'other',             // fallback bucket
  ];

  // Vision features — used by the 'vision_only' consent posture as
  // the allow-list. Anything not in this set is treated as a "chat"
  // feature and gated separately. Keep in sync with the call-sites.
  const VISION_FEATURES = ['fbar_vision', 'asset_vision', 'document_vision', 'medical_vision'];

  function isVisionFeature(featureId) {
    return VISION_FEATURES.indexOf(featureId) !== -1;
  }

  // ====================================================================
  // AI CONSENT ENFORCEMENT
  // ====================================================================
  //
  // settings.ai_consent captures the user's default posture:
  //   'full'        — all AI features run without confirmation (default
  //                   for back-compat when ai_consent is null/undefined)
  //   'per_call'    — show a confirmation modal before each AI request
  //   'vision_only' — allow vision (document extraction) features; block
  //                   chat / enrichment / Ask Taigan
  //   'off'         — disable all AI features
  //
  // settings.ai_consent_overrides allows per-feature override of the
  // global posture:
  //   { feature_id: 'allow' | 'deny' | null }
  //   • 'allow' — force-allow this feature regardless of posture
  //                (skips per-call prompt, overrides vision_only/off)
  //   • 'deny'  — force-block this feature
  //   • null    — inherit from posture
  //
  // Session-only "Don't ask again for this feature" lives in
  // _sessionAllowFeatures and resets on page reload — deliberately
  // ephemeral, never persisted.
  //
  // Errors thrown from this gate use the shape:
  //   { name: 'AIConsentError', reason: 'off'|'denied'|'vision_only'|'cancelled', featureId }
  // so modules can render a friendly disabled-banner rather than a
  // generic "AI failed."

  const _sessionAllowFeatures = new Set();

  function getConsentPosture() {
    const v = TB.state.get('settings.ai_consent');
    if (v === 'off' || v === 'per_call' || v === 'vision_only' || v === 'full') return v;
    return 'full';  // back-compat default for users without v2 onboarding
  }
  function setConsentPosture(v) {
    if (['off', 'per_call', 'vision_only', 'full'].indexOf(v) === -1) return;
    TB.state.set('settings.ai_consent', v);
  }
  function getConsentOverrides() {
    return TB.state.get('settings.ai_consent_overrides') || {};
  }
  function setConsentOverride(featureId, value) {
    const cur = getConsentOverrides();
    if (value == null) delete cur[featureId];
    else cur[featureId] = value;
    TB.state.set('settings.ai_consent_overrides', cur);
  }

  // Build a sanitized "what gets sent" preview for the per-call modal.
  // Per-feature: returns a short string of what (de-identified) data
  // is going over the wire. NEVER include actual PII — the modal is
  // an audit surface, not a logging system.
  function consentPreview(featureId, ctx) {
    ctx = ctx || {};
    switch (featureId) {
      case 'fbar_vision':
      case 'asset_vision':
      case 'document_vision':
        return ctx.fileName
          ? 'The document image/PDF "' + ctx.fileName + '" (' +
            (ctx.fileSize ? Math.round(ctx.fileSize / 1024) + ' KB' : 'size unknown') + ').'
          : 'A document image/PDF you uploaded.';
      case 'asset_enrichment':
      case 'fbar_enrichment':
        return ctx.institution
          ? 'Institution name + country only: "' + ctx.institution + '" (' + (ctx.country || '?') + '). No account numbers, balances, or beneficiaries are sent.'
          : 'Institution name + country only — no account numbers, balances, or beneficiaries.';
      case 'fbar_chat':
        return 'Your typed question + a category-level FBAR summary (counts of accounts by type/country/currency; threshold met or not). No account numbers, balances, names, or dates.';
      case 'ask_taigan':
        return 'Your typed message + a digest of your Taigan Bridge state (sanitized — no full account numbers, no SSNs).';
      case 'chat':
        return 'Your typed question and the conversation so far.';
      case 'health_check':
        return 'A 1-token ping ("ping" → 1-token response) to verify the API key works. Cost ~$0.0001.';
      default:
        return 'See the per-feature consent preview in Settings.';
    }
  }

  // Synchronous "would this feature be allowed without prompting?"
  // check. Returns:
  //   true   — feature will run silently (full / vision_only-vision / allow override)
  //   false  — feature will be blocked (off / deny override / vision_only-chat)
  //   null   — feature will prompt (per_call)
  // Modules use this to gray out buttons proactively when the answer is
  // false, or to add a "you'll be asked to confirm" hint when null.
  function isFeatureAllowed(featureId) {
    if (!featureId) return null;
    if (featureId === 'health_check') return true;
    const ov = getConsentOverrides()[featureId];
    if (ov === 'deny') return false;
    if (ov === 'allow') return true;
    const posture = getConsentPosture();
    if (posture === 'full') return true;
    if (posture === 'off') return false;
    if (posture === 'vision_only') return isVisionFeature(featureId) ? true : false;
    if (posture === 'per_call') return null;
    return true;
  }

  // The gate. Throws on denial; resolves silently on allow. ctx is
  // optional; passed through to the per-call modal so the preview
  // can name the institution / file / etc.
  async function checkConsent(featureId, ctx) {
    if (!featureId) featureId = 'other';

    // health_check is always allowed — it's the explicit "is my key
    // alive?" button. Failing it because AI is set to 'off' would be
    // counterintuitive (user can't even verify their key works without
    // re-enabling AI first). Cheap enough that no consent prompt is
    // warranted.
    if (featureId === 'health_check') return true;

    const overrides = getConsentOverrides();
    const ov = overrides[featureId];

    // Per-feature override 'deny' is absolute.
    if (ov === 'deny') {
      const e = new Error('AI feature "' + featureId + '" is force-disabled in your AI Consent settings.');
      e.name = 'AIConsentError'; e.reason = 'denied'; e.featureId = featureId;
      throw e;
    }
    // Per-feature override 'allow' bypasses posture (still blocked by
    // dailyLimit / API key checks downstream).
    if (ov === 'allow') return true;

    const posture = getConsentPosture();
    if (posture === 'full') return true;

    if (posture === 'off') {
      const e = new Error('AI features are disabled. Enable in Settings → AI consent.');
      e.name = 'AIConsentError'; e.reason = 'off'; e.featureId = featureId;
      throw e;
    }

    if (posture === 'vision_only') {
      if (isVisionFeature(featureId)) return true;
      const e = new Error('Only vision (document extraction) features are enabled. Enable broader AI in Settings → AI consent, or allow "' + featureId + '" specifically.');
      e.name = 'AIConsentError'; e.reason = 'vision_only'; e.featureId = featureId;
      throw e;
    }

    if (posture === 'per_call') {
      // Skip the modal if user clicked "Don't ask again this session"
      if (_sessionAllowFeatures.has(featureId)) return true;
      const ok = await showConsentModal(featureId, ctx);
      if (!ok) {
        const e = new Error('You cancelled the AI request.');
        e.name = 'AIConsentError'; e.reason = 'cancelled'; e.featureId = featureId;
        throw e;
      }
      return true;
    }
    return true;
  }

  // Render the per-call confirmation modal. Returns Promise<boolean>:
  // true if the user clicked Send, false if Cancel / Esc.
  function showConsentModal(featureId, ctx) {
    return new Promise((resolve) => {
      const utils = (window.TB && window.TB.utils) || null;
      const el = utils && utils.el;
      const t = (window.TB && window.TB.i18n && window.TB.i18n.t) || ((k) => k);
      const root = document.getElementById('tb-modal-root');
      if (!el || !root) {
        // Fallback to confirm() in pathological no-DOM cases.
        const ok = window.confirm('Send "' + featureId + '" request to Claude?');
        resolve(!!ok); return;
      }

      const lang = (window.TB && window.TB.i18n && window.TB.i18n.getLang && window.TB.i18n.getLang()) || 'en';
      const featureLabel = t('settings.dashboard.feature.' + featureId);
      const preview = consentPreview(featureId, ctx);
      const cost = ctx && ctx.estimatedCostUsd != null ? ctx.estimatedCostUsd
                 : (ctx && ctx.file ? (estimateCost(ctx.file) || { approxUsd: 0 }).approxUsd : null);

      const backdrop = el('div', { class: 'tb-modal-backdrop' });
      const modal = el('div', { class: 'tb-modal', style: { maxWidth: '520px' } });
      backdrop.appendChild(modal);
      function close(ok) { root.innerHTML = ''; resolve(ok); }
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
      function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
        else if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close(true); }
      }
      document.addEventListener('keydown', onKey);

      modal.appendChild(el('h2', { style: { marginTop: 0 } },
        '🔒 ' + t('ai.consent.modal.title')));
      modal.appendChild(el('p', null,
        t('ai.consent.modal.intro', { feature: featureLabel })));

      // What gets sent (sanitized preview)
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderLeft: '3px solid var(--tb-accent)', borderRadius: 'var(--tb-radius-1)',
          margin: 'var(--tb-sp-3) 0', fontSize: 'var(--tb-fs-14)',
        },
      },
        el('div', {
          style: { fontSize: '11px', fontWeight: '600', textTransform: 'uppercase',
                   letterSpacing: '0.06em', color: 'var(--tb-text-soft)', marginBottom: '6px' },
        }, t('ai.consent.modal.whatSent')),
        el('div', null, preview),
      ));

      // Cost estimate
      if (cost != null && cost > 0) {
        modal.appendChild(el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
          '💰 ' + t('ai.consent.modal.estCost', { usd: cost.toFixed(4) })));
      }

      // "Don't ask again this session" checkbox
      let dontAskAgain = false;
      modal.appendChild(el('label', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
                 fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
                 marginBottom: 'var(--tb-sp-3)' },
      },
        el('input', {
          type: 'checkbox',
          onchange: (e) => { dontAskAgain = !!e.target.checked; },
        }),
        el('span', null, t('ai.consent.modal.dontAskSession', { feature: featureLabel })),
      ));

      // Buttons
      const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)' } });
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        onclick: () => { document.removeEventListener('keydown', onKey); close(false); },
      }, t('ai.consent.modal.cancel')));
      btnRow.appendChild(el('button', {
        class: 'tb-btn',
        type: 'button',
        onclick: () => {
          if (dontAskAgain) _sessionAllowFeatures.add(featureId);
          document.removeEventListener('keydown', onKey);
          close(true);
        },
      }, t('ai.consent.modal.send')));
      modal.appendChild(btnRow);

      // Link to permanently change for this feature in Settings.
      modal.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-3)', textAlign: 'right', fontSize: 'var(--tb-fs-12)' },
      },
        el('a', {
          href: '#',
          style: { color: 'var(--tb-text-soft)' },
          onclick: (e) => {
            e.preventDefault();
            document.removeEventListener('keydown', onKey);
            close(false);
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
          },
        }, t('ai.consent.modal.openSettings') + ' →'),
      ));

      root.innerHTML = '';
      root.appendChild(backdrop);
    });
  }

  function emptyBucket() {
    return { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
  }

  function bumpBucket(bucket, inT, outT, cost) {
    bucket.input_tokens += inT;
    bucket.output_tokens += outT;
    bucket.cost_usd += cost;
    bucket.calls += 1;
  }

  function recordUsage(modelId, usage, feature) {
    const inT = Number(usage && usage.input_tokens) || 0;
    const outT = Number(usage && usage.output_tokens) || 0;
    const cost = computeCost(modelId, inT, outT);
    const u = getUsage();
    if (!u.daily) u.daily = {};
    if (!u.all_time) u.all_time = emptyBucket();
    const featureId = (feature && FEATURE_IDS.indexOf(feature) >= 0) ? feature : 'other';
    const modelKey = modelId || 'unknown';

    const key = todayKey();
    const day = u.daily[key] || emptyBucket();
    bumpBucket(day, inT, outT, cost);
    if (!day.by_feature) day.by_feature = {};
    if (!day.by_feature[featureId]) day.by_feature[featureId] = emptyBucket();
    bumpBucket(day.by_feature[featureId], inT, outT, cost);
    if (!day.by_model) day.by_model = {};
    if (!day.by_model[modelKey]) day.by_model[modelKey] = emptyBucket();
    bumpBucket(day.by_model[modelKey], inT, outT, cost);
    u.daily[key] = day;

    bumpBucket(u.all_time, inT, outT, cost);
    if (!u.all_time.by_feature) u.all_time.by_feature = {};
    if (!u.all_time.by_feature[featureId]) u.all_time.by_feature[featureId] = emptyBucket();
    bumpBucket(u.all_time.by_feature[featureId], inT, outT, cost);
    if (!u.all_time.by_model) u.all_time.by_model = {};
    if (!u.all_time.by_model[modelKey]) u.all_time.by_model[modelKey] = emptyBucket();
    bumpBucket(u.all_time.by_model[modelKey], inT, outT, cost);

    setUsage(u);
    return cost;
  }

  function resetTodayUsage() {
    const u = getUsage();
    if (u.daily) delete u.daily[todayKey()];
    setUsage(u);
  }

  function dailyLimitUsd() {
    const u = getUsage();
    return Number(u.daily_limit_usd) || 0;
  }

  function setDailyLimitUsd(usd) {
    const u = getUsage();
    u.daily_limit_usd = Math.max(0, Number(usd) || 0);
    setUsage(u);
  }

  // Throws if today's spend already meets / exceeds the configured
  // daily limit. Estimated cost of the about-to-be-made call is added
  // to today's already-recorded cost; if the sum >= limit, refuse.
  function enforceDailyLimit(estimatedCostUsd) {
    const limit = dailyLimitUsd();
    if (limit <= 0) return; // 0 = no limit
    const today = todayUsage();
    const projected = (today.cost_usd || 0) + (Number(estimatedCostUsd) || 0);
    if (projected >= limit) {
      throw new Error(
        'Daily AI spend limit reached. Today: $' + (today.cost_usd || 0).toFixed(4) +
        ' · projected after this call: $' + projected.toFixed(4) +
        ' · limit: $' + limit.toFixed(2) +
        '. Raise the limit in Settings or wait until tomorrow.',
      );
    }
  }

  // ====================================================================
  // CREDIT BALANCE TRACKING
  // ====================================================================

  function getCredits() {
    return TB.state.get('settings.credits') || {
      topups: [],
      last_reconciled_at: null,
      last_reconciled_balance: null,
    };
  }

  function setCredits(c) { TB.state.set('settings.credits', c); }

  function isTopupActive(topup, now) {
    const today = now || new Date();
    if (!topup.expires) return true;
    const exp = new Date(topup.expires + 'T23:59:59');
    return !isNaN(exp.getTime()) && exp >= today;
  }

  function activeTopups() {
    const c = getCredits();
    return (c.topups || []).filter(t => isTopupActive(t));
  }

  // Returns the locally-computed remaining balance.
  //
  // Without a reconcile snapshot:
  //   sum(active_topups.amount) - all_time.cost_usd
  // (Approximation — assumes topups predate any tracked usage.)
  //
  // With a reconcile snapshot (last_reconciled_at + last_reconciled_balance):
  //   last_reconciled_balance - sum(daily costs after reconcile_date)
  // (More accurate — anchors to the user's confirmed actual balance.)
  function computeRemainingBalance() {
    const c = getCredits();
    const u = getUsage();
    const purchased = activeTopups().reduce((s, t) => s + (Number(t.amount_usd) || 0), 0);

    if (c.last_reconciled_at && c.last_reconciled_balance != null) {
      const reconcileDate = String(c.last_reconciled_at).slice(0, 10);
      let spentSince = 0;
      for (const [day, info] of Object.entries(u.daily || {})) {
        if (day > reconcileDate) spentSince += (Number(info.cost_usd) || 0);
      }
      return {
        purchased,
        spent_since_reconcile: spentSince,
        spent_total: u.all_time && u.all_time.cost_usd || 0,
        remaining: Math.max(0, Number(c.last_reconciled_balance) - spentSince),
        anchored: true,
      };
    }

    const allTimeCost = u.all_time && u.all_time.cost_usd || 0;
    return {
      purchased,
      spent_since_reconcile: 0,
      spent_total: allTimeCost,
      remaining: Math.max(0, purchased - allTimeCost),
      anchored: false,
    };
  }

  function addTopup(topup) {
    const c = getCredits();
    if (!c.topups) c.topups = [];
    c.topups.push(Object.assign({ id: 'tu-' + Math.random().toString(36).slice(2, 10) }, topup));
    // Sort newest-first for display.
    c.topups.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    setCredits(c);
  }

  function removeTopup(id) {
    const c = getCredits();
    c.topups = (c.topups || []).filter(t => t.id !== id);
    setCredits(c);
  }

  function reconcile(actualBalanceUsd) {
    const c = getCredits();
    c.last_reconciled_at = new Date().toISOString();
    c.last_reconciled_balance = Math.max(0, Number(actualBalanceUsd) || 0);
    setCredits(c);
  }

  // Returned when callClaude is invoked without { live: true }. This is
  // the no-spend guardrail path: deterministic text, zero tokens, no
  // network call. A caller seeing this in production has forgotten to
  // pass { live: true }.
  function placeholderResponse(prompt) {
    return {
      role: 'assistant',
      content: [{
        type: 'text',
        text: '[No live AI call — callClaude was invoked without { live: true }.]\n\n' +
              'Prompt received: ' + (prompt || '').slice(0, 200) +
              ((prompt || '').length > 200 ? '…' : ''),
      }],
      model: getModel(),
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  // Real Claude API call. Reached only via callClaude({ live: true }) so
  // we never bill the user by accident. Callers must check hasKey() first
  // and surface a friendly "add your key in Settings" message if not.
  async function callClaudeLive({ system, messages, model, maxTokens, temperature, feature }) {
    if (!hasKey()) {
      throw new Error('No Claude API key set. Add one in Settings to use AI features.');
    }
    const featureId = feature || 'chat';
    // Consent gate runs BEFORE enforceDailyLimit so a denial doesn't
    // mention budget. Throws AIConsentError on denial.
    await checkConsent(featureId);
    enforceDailyLimit(0);
    const useModel = model || getModel();
    const body = {
      model: useModel,
      max_tokens: maxTokens || 1024,
      temperature: temperature == null ? 0.7 : temperature,
      messages: messages || [],
    };
    if (system) body.system = system;

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        // Required so the browser can call the API directly without
        // a server-side proxy. The key never leaves the user's machine.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errText}`);
    }
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, featureId);
    return json;
  }

  function callClaude(prompt, options) {
    const opts = options || {};
    if (!opts.live) {
      return Promise.resolve(placeholderResponse(prompt));
    }
    const messages = opts.messages || [{
      role: 'user',
      content: typeof prompt === 'string' ? prompt : '',
    }];
    return callClaudeLive({
      system: opts.system,
      messages,
      model: opts.model,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      feature: opts.feature,
    });
  }

  // ====================================================================
  // FBAR SANITIZER (background AI calls)
  // ====================================================================
  //
  // BACKGROUND AI calls (suggestions, explanations, "what should I ask
  // a CPA about FBAR?") MUST NOT send FBAR account numbers, balances,
  // filer names, dates, addresses, or any other identifying field to
  // Anthropic. Those calls go through:
  //
  //   TB.ai.callClaudeWithFbarContext(prompt, options)
  //
  // which assembles a system message containing only the category-
  // level summary returned by TB.fbar.summarizeFbarForAi() (counts of
  // accounts by type/country/currency, filer counts, threshold-met
  // counts per year — no PII).
  //
  // EXPLICIT USER-INITIATED UPLOADS are the one exception. When the
  // user clicks "Upload bank document" and confirms a per-call consent
  // modal that names the destination, the image / PDF goes via:
  //
  //   TB.ai.callClaudeVisionForExtraction(file, kind, options)
  //
  // The image is held in memory only (never persisted), confirmation
  // is required per upload (never stored "trust this site" style),
  // and the call uses the user's own API key for direct browser →
  // api.anthropic.com transmission. The author cannot intercept it.
  //
  // No other code path may transmit raw FBAR data. If you find one,
  // it's a bug — file an issue and gate it behind the same consent UI.
  // ====================================================================

  function buildFbarSystemMessage() {
    if (!window.TB || !window.TB.fbar || typeof window.TB.fbar.summarizeFbarForAi !== 'function') {
      return null;
    }
    const summary = window.TB.fbar.summarizeFbarForAi();
    return [
      'The user has FBAR data in Taigan Bridge. The summary below is the',
      'ONLY information available about that data — no account numbers,',
      'balances, names, dates, or addresses are included.',
      '',
      'Sanitized FBAR context:',
      JSON.stringify(summary, null, 2),
      '',
      'Help the user think about FBAR organization, deadlines, common',
      'mistakes, and questions to bring to a CPA. Never ask the user to',
      'paste their account numbers, balances, or names into chat — those',
      'belong only in their local Taigan Bridge state.',
    ].join('\n');
  }

  function callClaudeWithFbarContext(prompt, options) {
    const sys = buildFbarSystemMessage();
    const opts = Object.assign({}, options || {});
    // Combine with any caller-provided system message.
    opts.system = sys && opts.system
      ? (sys + '\n\n---\n\n' + opts.system)
      : (sys || opts.system);
    if (!opts.feature) opts.feature = 'fbar_chat';
    return callClaude(prompt, opts);
  }

  // ====================================================================
  // VISION EXTRACTION (user-initiated uploads, gated by consent)
  // ====================================================================
  //
  // callClaudeVisionForExtraction(file, kind, options)
  //   file: a File object (from <input type="file">) — PNG / JPG / WEBP
  //         / GIF / PDF
  //   kind: 'passbook' | 'statement' | 'screenshot' | 'generic'
  //   options.year:    hint to narrow extraction to a single calendar
  //                    year (the FBAR module passes the active year)
  //   options.model:   override default model
  //   options.maxTokens: defaults to 2048
  //
  // Returns: parsed JSON conforming to the OUTPUT SHAPE in
  // buildExtractionPrompt(). Throws on network error, no API key, or
  // unparseable response.
  //
  // The caller is responsible for showing the consent modal BEFORE
  // invoking this function. This function does not show one — it
  // assumes the user has already confirmed.
  // ====================================================================

  const ACCEPTED_IMAGE_TYPES = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  ];
  const ACCEPTED_PDF_TYPES = ['application/pdf'];
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB hard limit

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const m = result.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) return reject(new Error('Failed to read file as base64'));
        resolve({ mediaType: m[1], data: m[2] });
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(file);
    });
  }

  function classifyFile(file) {
    const t = (file.type || '').toLowerCase();
    if (ACCEPTED_PDF_TYPES.indexOf(t) !== -1) return 'pdf';
    if (ACCEPTED_IMAGE_TYPES.indexOf(t) !== -1) return 'image';
    // Some browsers report .pdf with empty type — sniff by extension.
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf')) return 'pdf';
    if (/\.(png|jpe?g|webp|gif)$/.test(name)) return 'image';
    return null;
  }

  function buildExtractionPrompt(kind, opts) {
    const year = opts && opts.year ? opts.year : null;
    const yearHint = year
      ? `\nThe user is currently focused on calendar year ${year}, but if the document spans multiple years, extract ALL of them — do not narrow the output to the focused year.`
      : '';

    return [
      'You are an extraction assistant for a Foreign Bank and Financial',
      'Accounts Report (FBAR) tracker. You receive a single document',
      '(a bank passbook page, statement, or screenshot) and return',
      'STRUCTURED JSON describing what you can read.' + yearHint,
      '',
      'CRITICAL RULES:',
      '- Respond with ONLY a JSON object, nothing else. No markdown,',
      '  no code fences, no commentary before or after the JSON.',
      '- If you cannot determine a field, use null. Never guess or',
      '  fabricate values.',
      '- ALL dates in your output MUST be ISO 8601 Western calendar',
      '  (YYYY-MM-DD). See the JAPANESE CALENDAR section below.',
      '- Numbers: use the document\'s native currency. Do not convert',
      '  to USD. Strip currency symbols, commas, and Japanese 万 / 千',
      '  notation — return raw numbers (e.g., 1500000 not "¥1,500,000",',
      '  "150万円" → 1500000).',
      '- Account numbers: include any digits visible. Do not mask.',
      '',
      'JAPANESE CALENDAR (和暦) — CRITICAL:',
      'Japanese passbooks (通帳), tax documents, residence cards, and',
      'official bank papers commonly use 和暦 (the Japanese era',
      'calendar) instead of Western dates. You MUST convert every era',
      'date to a Western YYYY-MM-DD before putting it in the output.',
      '',
      'Era conversion table (formula: era_year + offset = Western_year):',
      '  令和 (Reiwa)  : Western = Reiwa + 2018   → 令和元年=2019, 令和6年=2024',
      '  平成 (Heisei) : Western = Heisei + 1988  → 平成元年=1989, 平成31年=2019',
      '  昭和 (Showa)  : Western = Showa + 1925   → 昭和元年=1926, 昭和64年=1989',
      '  大正 (Taisho) : Western = Taisho + 1911',
      '  明治 (Meiji)  : Western = Meiji + 1867',
      '',
      '元年 means "year 1" in any era.',
      'Examples (era → Western):',
      '  令和元年12月31日   → 2019-12-31',
      '  令和3年4月1日      → 2021-04-01',
      '  令和6年10月15日    → 2024-10-15',
      '  R6.10.15 / 令6.10.15 (abbreviations) — same conversion',
      '  平成31年4月30日    → 2019-04-30 (era changed to Reiwa on 2019-05-01)',
      '  昭和64年1月7日     → 1989-01-07 (era changed to Heisei on 1989-01-08)',
      '',
      'If a date is ambiguous (just "6年10月15日" with no era prefix),',
      'assume the most recent applicable era based on context. If the',
      'page header shows the account was opened in 平成, transactions',
      'before May 2019 are likely 平成; after that, 令和.',
      '',
      'OPENED / CLOSED YEAR — DO NOT FABRICATE:',
      'opened_year and closed_year may ONLY be populated if you can',
      'see an EXPLICIT account-opening or closure date on the',
      'document. Look for these specific labels:',
      '  - 開設日 / 開設年月日 / 申込日 / Account opened / Opening date',
      '  - 解約日 / 閉鎖日 / Account closed / Closure date',
      'If none of these appear on the document, return null for the',
      'corresponding field. DO NOT infer opened_year from the earliest',
      'transaction date — a 2025 statement showing transactions',
      'starting January 2025 does NOT mean the account was opened in',
      '2025. The opening date might be years earlier (or, for a new',
      'account, exactly 2025) — you cannot tell from transaction dates',
      'alone. The user will fill in opened_year manually if you',
      'return null.',
      '',
      'MULTI-YEAR DOCUMENTS — CRITICAL:',
      'Passbooks regularly span multiple calendar years. You MUST',
      'return a `years_covered` array with one entry per calendar year',
      'where transactions or balance entries are EXPLICITLY VISIBLE',
      'on the document. Each entry contains that year\'s maximum',
      'balance. Do not collapse a multi-year document into a single',
      'year.',
      '',
      'NEVER fabricate years_covered entries. If the document shows',
      'transactions for 2025 only, return only [{year: 2025, ...}].',
      'Do NOT add 2024 or 2023 entries unless those years\' transactions',
      'or balances are physically visible on the page. The application',
      'will carry-forward dormant years on its own; that\'s a separate',
      'concern from extraction. Your job is to report ONLY what the',
      'document actually shows.',
      '',
      'Only include years that have ALREADY STARTED OR ENDED. Do NOT',
      'include FUTURE dates as years_covered entries — even if they',
      'appear on the document. The most common case where this',
      'matters is fixed-deposit (FD / 定期預金) certificates that',
      'show a future 満期日 (maturity date). The principal does not',
      '"exist" in the future maturity year for FBAR reporting. Skip',
      'those years entirely; the application will carry the prior',
      'year\'s balance forward only as far as today\'s calendar year.',
      '',
      'Also populate `balance_entries` with EVERY visible transaction',
      'row, with date converted from 和暦 to Western. The application',
      'uses balance_entries as a fallback to recover per-year maxes if',
      '`years_covered` is missing — so even if you forget the summary,',
      'the entries will let the user recover.',
      '',
      'DORMANT YEARS / CARRY-FORWARD — CRITICAL FOR FBAR:',
      'A bank account that has no transactions in a given year is',
      'still REPORTABLE for that year — the balance carries forward',
      'from the most recent prior transaction. FBAR\'s threshold is',
      '"maximum balance during the year," and a dormant balance is',
      'still a balance.',
      '',
      'When a passbook shows a gap (e.g., transactions in 2019-2021,',
      'then nothing until 2026), include a `years_covered` entry for',
      'EVERY year in the span — using the carry-forward balance from',
      'the most recent prior transaction for the dormant years.',
      'Set max_balance_date to null for the carry-forward years and',
      'note the carry-forward in extraction_notes.',
      '',
      'Common signals of a long gap in 通帳:',
      '  - A "繰越" (carryforward) line followed by a much later date',
      '  - A "通帳記入" line indicating when the passbook was last printed',
      '  - The same balance value repeated with no intervening rows',
      '  - A multi-year date jump on consecutive lines',
      'In all of these cases, fill in the missing intermediate years',
      'with the carry-forward balance.',
      '',
      'Account closure: ONLY skip carry-forward years if you see an',
      'explicit closure marker (口座解約 / closed / final balance 0).',
      'Otherwise assume the account remained open and dormant.',
      '',
      'BEFORE YOU RESPOND, run this self-check:',
      '  1. How many distinct calendar years span the document?',
      '     (From earliest visible date to latest visible date.)',
      '  2. Does `years_covered` have an entry for EVERY year in that',
      '     span — including dormant years with carry-forward balances?',
      '  3. For each year with transactions, did I find the MAXIMUM',
      '     差引残高 across all in-year rows (not just the year-end)?',
      '  4. For each dormant year, did I use the carry-forward',
      '     balance from the most recent prior transaction?',
      '  5. Are all dates in YYYY-MM-DD Western calendar (not 和暦)?',
      '  6. Did I convert 元年 = year 1 of each era correctly?',
      '     (令和元年 → 2019, NOT 0)',
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "kind": "passbook" | "statement" | "screenshot" | "fd_certificate" | "unknown",',
      '  "institution_name": string|null,             // primary form as visible on the document',
      '  "institution_name_en": string|null,          // English / romanized form (e.g. "Akita Bank")',
      '  "institution_name_jp": string|null,          // Japanese form (kanji/katakana, e.g. "秋田銀行")',
      '  "institution_address": string|null,          // English / romanized form (used on FBAR)',
      '  "institution_address_jp": string|null,       // Japanese form (kanji, optional)',
      '  "country": string|null,                     // ISO 3166-1 alpha-2',
      '  "currency": string|null,                    // ISO 4217',
      '  "account_type": "bank"|"securities"|"other"|null,',
      '  "account_number": string|null,',
      '  "account_holder_name": string|null,         // Romanized form preferred',
      '  "account_holder_name_jp": string|null,      // 漢字 / カタカナ form',
      '  "year": number|null,                        // single-year docs only',
      '  "opened_year": number|null,                 // ONLY if an explicit account-opening date is visible',
      '  "closed_year": number|null,                 // ONLY if an explicit closure date is visible',
      '  "years_covered": [                          // REQUIRED — one per visibly-active year',
      '    { "year": number, "max_balance_native": number, "max_balance_date": "YYYY-MM-DD"|null }',
      '  ],',
      '  "balance_entries": [                        // OPTIONAL — sample only',
      '    { "date": "YYYY-MM-DD"|null, "balance_native": number, "memo": string|null }',
      '  ],',
      '  "max_balance_native": number|null,          // overall peak across all years',
      '  "max_balance_date": "YYYY-MM-DD"|null,',
      '  "transactions": [                            // every visible passbook row (deep mode)',
      '    { "date": "YYYY-MM-DD", "deposit": number|null, "withdrawal": number|null,',
      '      "balance": number, "description": string|null }',
      '  ],',
      '  "consolidated_entries": [                    // 合算 collapsed-row ranges',
      '    { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD",',
      '      "count": number, "total_deposits": number|null,',
      '      "total_withdrawals": number|null, "ending_balance": number|null }',
      '  ],',
      '  "fd_references": [                            // parallel FD certificates',
      '    { "cert_number": string, "fd_number": string|null,',
      '      "amount": number|null, "open_date": "YYYY-MM-DD"|null,',
      '      "maturity_date": "YYYY-MM-DD"|null,',
      '      "status": "active"|"matured"|"rolled"|"unknown" }',
      '  ],',
      '  "carry_over_balance": number|null,           // 繰越高 from previous passbook',
      '  "warnings": [ string ],                      // ambiguities for user review',
      '  "extraction_notes": string|null,             // free-form notes',
      '  "confidence": "high"|"medium"|"low",',
      '  "accounts": [                                // ONLY for multi-account documents (see section below)',
      '    {',
      '      "account_number": string,                // distinguishing identifier, e.g. "FD#01 cert 55130-1438907"',
      '      "account_type": "bank"|"securities"|"other"|null,  // override; otherwise inherits top-level',
      '      "currency": string|null,                 // override; otherwise inherits top-level',
      '      "principal_amount": number|null,         // for FDs / time deposits, the principal in native currency',
      '      "open_date": "YYYY-MM-DD"|null,',
      '      "maturity_date": "YYYY-MM-DD"|null,',
      '      "interest_rate_pct": number|null,        // annual rate as a percent, e.g. 0.01 for 0.01%',
      '      "notes": string|null,                    // FD#, term, anything distinguishing',
      '      "years_covered": [',
      '        { "year": number, "max_balance_native": number, "max_balance_date": "YYYY-MM-DD"|null }',
      '      ]',
      '    }',
      '  ]',
      '}',
      '',
      'OUTPUT BUDGET — KEEP RESPONSE SMALL:',
      'Long passbooks with hundreds of transactions can cause the',
      'response to be truncated at the token limit, breaking JSON',
      'parsing. To stay within budget:',
      '  - `years_covered` is the PRIMARY OUTPUT. One entry per year,',
      '    with that year\'s max balance. This is what the application',
      '    uses; complete it first.',
      '  - `balance_entries` is OPTIONAL and SAMPLED. Include AT MOST',
      '    3 rows PER YEAR: the year\'s opening balance, the year\'s',
      '    peak (the row that produced max_balance_native), and the',
      '    year\'s closing balance. Skip everything else. Do not list',
      '    every transaction.',
      '  - For `extraction_notes`, keep it under 500 characters.',
      'Following these caps keeps responses well under the token',
      'limit even for 30-year passbooks.',
      '',
      'MULTI-ACCOUNT DOCUMENTS — CRITICAL FOR FBAR:',
      'A single document can represent MULTIPLE separate FBAR-reportable',
      'accounts. The most common case is a Japanese fixed-deposit (定期',
      '預金) certificate that bundles 2-10 sub-deposits ("FD#01",',
      '"FD#02", etc.) under one cert number, each with its own',
      'principal amount, term, and per-year max balance. For FBAR',
      'purposes, EACH sub-deposit is a separate reportable account',
      'and gets its own line on the form.',
      '',
      'When you encounter such a document, populate `accounts[]` with',
      'one entry per sub-deposit. EACH entry has:',
      '  - `account_number`: a string distinguishing this sub-deposit',
      '    from its siblings, e.g., "FD#01 cert 55130-1438907" or',
      '    "Sub-deposit A". Include the parent cert number for',
      '    traceability.',
      '',
      '    DO NOT confuse a BRANCH NUMBER (店番 / 支店番号) with the',
      '    sub-deposit identifier. The branch number is a 3-5 digit',
      '    code that identifies the bank branch and is the SAME across',
      '    every sub-deposit at that branch. The sub-deposit ID is the',
      '    smaller per-row identifier (often 2-5 digits) that DIFFERS',
      '    between sub-deposits on the same cert. If a single value',
      '    repeats across every row of a multi-FD certificate, it is',
      '    almost certainly the branch number — put it in `notes` if',
      '    you want to record it, but DO NOT put it in account_number',
      '    as if it were the sub-deposit ID.',
      '  - `principal_amount`: the deposit principal in the native',
      '    currency (the FBAR max value will be roughly this for an',
      '    FD that hasn\'t accrued much interest).',
      '  - `open_date` / `maturity_date`: the sub-deposit\'s own dates.',
      '  - `years_covered`: per-year max balance entries for THIS',
      '    sub-deposit (not the cert as a whole). For FDs, the max',
      '    is usually the principal × cumulative interest, roughly',
      '    constant year-over-year until maturity.',
      '  - `interest_rate_pct`: if visible (Japanese FDs typically',
      '    show 利率 as a percentage like 0.01 for 0.01%).',
      '  - `notes`: anything distinguishing — term length (1Y/3Y/5Y),',
      '    type (定期 / 定額), special conditions.',
      '',
      'The TOP-LEVEL fields (institution_name, country, currency,',
      'institution_address, etc.) describe the SHARED parent metadata',
      '— they apply to all sub-accounts unless an entry overrides',
      'them. The application will create N separate account records',
      'from accounts[], each inheriting the shared metadata.',
      '',
      'When in doubt about whether a document is "single account" or',
      '"multi-account": if you can identify multiple distinct FD',
      'numbers, sub-deposit identifiers, or per-row principal amounts',
      'on the SAME document, populate accounts[] with one entry each.',
      'If the document is a regular passbook with one account number',
      'and a transaction history, leave accounts[] empty (the',
      'top-level fields handle the single-account case).',
      '',
      'FD LIFECYCLE — CRITICAL FOR FIXED DEPOSITS:',
      '',
      'Japanese fixed deposits (定期預金 / 定額貯金 / 定期貯金) are NOT',
      'one-time transactions. Each FD has a LIFECYCLE:',
      '  1. DEPOSIT (預入 / 入金 / 預け入れ) on the open date —',
      '     principal is deposited.',
      '  2. LOCKUP — balance is held at approximately PRINCIPAL for',
      '     the entire term (Japanese FD rates are typically 0.01%-',
      '     0.05% — interest accrual is negligible compared to the',
      '     principal).',
      '  3. PAYMENT / PAYOUT (払戻 / 支払 / 満期受取) on the close',
      '     date — principal + accrued interest comes out.',
      '',
      'CRITICAL — 定額貯金 (postal time deposit / Japan Post) DEPOSIT-ROW DATES:',
      '',
      'For 定額貯金 specifically (and many 定期預金 products at Japanese',
      'banks), the DEPOSIT ROW often shows TWO dates side by side:',
      '  - The first date (left column) = 預入日 = DEPOSIT date',
      '  - The second date (further right, near the rate / 利率) =',
      '    据置期間満了日 = WITHDRAWAL-ELIGIBLE date (typically the',
      '    deposit date + 6 months for 定額貯金).',
      '',
      'The 据置期間満了日 is NOT the maturity date. It is the earliest',
      'date the customer is ALLOWED to withdraw without penalty.',
      'After this date, the FD continues to accrue interest until full',
      'maturity (10 years from deposit for 定額貯金) or until the',
      'customer chooses to withdraw.',
      '',
      'The TRUE maturity_date / close_date is on the SEPARATE',
      'PAYMENT ROW (the row showing 払戻金額 / 支払金額 / お支払金額),',
      'which often appears MUCH later in the passbook — sometimes',
      '5-10 years after the deposit row. That row\'s date is the',
      'actual close date.',
      '',
      'Concrete pattern to recognize:',
      '  Deposit row:  | 24-06-08 | ... | *500,000円 | 0.04% (3年以上) | 24-12-08 |',
      '  Payment row:  | 5-01-18  | ... |             | お支払金額 *501,600円 |',
      '',
      'The "24-12-08" on the deposit row is 据置期間満了日 (Heisei 24',
      'Dec 8 = 2012-12-08, exactly 6 months after the 2012-06-08',
      'deposit). It is NOT the maturity. The TRUE maturity is the',
      'date on the payment row: 5-01-18 = 令和5年1月18日 = 2023-01-18.',
      '',
      'Rule: maturity_date / close_date comes ONLY from a PAYMENT',
      'row (払戻 / 支払 / お支払金額 columns populated). NEVER take',
      'a date from the deposit row as the close date, even if it',
      'is in the future relative to the deposit date — that\'s',
      'almost always the 据置期間満了日, not the maturity.',
      '',
      'If you cannot find a corresponding payment row for a',
      'deposit, the FD is STILL ACTIVE: leave maturity_date null',
      'and populate years_covered through the current year.',
      '',
      'For FBAR purposes, an FD\'s max balance during EVERY YEAR of',
      'its lifetime is the PRINCIPAL. The FD existed and held that',
      'principal for every calendar year between open and close.',
      'You MUST populate years_covered with one entry per year in',
      'that range — not just the year the deposit was made or the',
      'year the payout happened.',
      '',
      'When you see an FD entry on the document, identify:',
      '  - DEPOSIT date (open_date)',
      '  - PAYMENT date (close_date / maturity_date), or null if',
      '    still active',
      '  - PRINCIPAL amount (the deposit amount)',
      '  - PAYOUT amount (principal + accrued interest, only',
      '    relevant for the close year)',
      '',
      'Then populate years_covered for the FD as follows:',
      '  - For every year from open_date.year through close_date.year',
      '    (or current calendar year if still active): one entry with',
      '    max_balance_native = principal.',
      '  - The CLOSE year specifically gets max_balance_native =',
      '    payout amount (slightly higher than principal due to',
      '    accrued interest), and max_balance_date = the payment',
      '    date.',
      '  - The OPEN year gets max_balance_date = the deposit date.',
      '  - All intermediate years get max_balance_date = null (the',
      '    balance was the principal throughout, no specific peak day).',
      '',
      'WORKED EXAMPLE — a single FD\'s lifecycle:',
      '',
      'Document shows:',
      '  Entry 01 — Deposit row:',
      '    | 24-06-08 | 51555 | *500,000円 | 500千円 | 1口 |',
      '    | 定額貯金 | 0.04% (3年以上) | 24-12-08 |',
      '    Interpretation:',
      '      平成24年6月8日 (2012-06-08) = DEPOSIT date',
      '      ¥500,000 = principal, 0.04% rate, 3-year+ tier',
      '      sub-id 51555',
      '      24-12-08 = 据置期間満了日 (lockup-expiry, 2012-12-08)',
      '        — NOT the maturity. Ignore for open/close purposes.',
      '  Entry 01 — Payment row:',
      '    | 5-01-18 | 01200 | お支払金額 *501,600円 | 税額 *406 |',
      '    Interpretation:',
      '      令和5年1月18日 (2023-01-18) = PAYMENT / maturity date',
      '      01200 = branch number (not a sub-deposit ID)',
      '      ¥501,600 paid out (¥1,600 gross interest, ¥406 tax)',
      '',
      'This is ONE FD that existed from June 2012 to January 2023.',
      'It held ¥500,000 (the principal) every year from 2012 through',
      '2022, and ¥501,600 (the payout) momentarily in early 2023',
      'before being paid out.',
      '',
      'Output (one entry in accounts[]):',
      '{',
      '  "account_number": "FD#01 cert XXXXXXX (sub 51555)",',
      '  "principal_amount": 500000,',
      '  "open_date": "2012-06-08",',
      '  "maturity_date": "2023-01-18",',
      '  "interest_rate_pct": 0.04,',
      '  "notes": "Sub 51555; 3-year+ tier; matured 2023-01-18,',
      '           ¥1,600 gross interest, ¥406 tax withheld",',
      '  "years_covered": [',
      '    { "year": 2012, "max_balance_native": 500000, "max_balance_date": "2012-06-08" },',
      '    { "year": 2013, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2014, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2015, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2016, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2017, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2018, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2019, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2020, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2021, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2022, "max_balance_native": 500000, "max_balance_date": null },',
      '    { "year": 2023, "max_balance_native": 501600, "max_balance_date": "2023-01-18" }',
      '  ]',
      '}',
      '',
      'For an FD that is STILL ACTIVE (no payment row visible):',
      '  - maturity_date is null',
      '  - years_covered runs from open_date.year through the current',
      '    calendar year (the application reads this as "still open")',
      '  - Every year\'s max is the principal',
      '',
      'DATE SANITY CHECKS — apply BEFORE returning open_date / maturity_date:',
      '',
      '1. open_date MUST be in the past. A bank cannot accept a deposit',
      '   on a date that hasn\'t happened yet. If your candidate',
      '   open_date is in the future, you misread the era prefix —',
      '   recheck and fix.',
      '',
      '2. Distinguish DEPOSIT date from MATURITY / PAYMENT date.',
      '   On Japanese FD documents, you may see multiple dates per',
      '   FD entry — typically labeled differently:',
      '     預入日 / 入金 / 預入年月日 → DEPOSIT date (= open_date)',
      '     満期日 / 払戻 / 支払日       → PAYMENT / MATURITY date (= close_date)',
      '     据置期間満了日              → LOCKUP-EXPIRY (NEITHER — IGNORE)',
      '   Do NOT use a 満期日 (maturity) as the open_date. If the',
      '   only date you can identify is a maturity-style date,',
      '   leave open_date null rather than use the maturity date.',
      '',
      '   For a single FD entry on a passbook there are typically',
      '   TWO ROWS — the deposit row (when the principal went in)',
      '   and the payment row (when it came out). Both rows often',
      '   share the same FD number / cert number. Pick the EARLIER',
      '   date as open_date and the LATER date as maturity_date. If',
      '   you produce open_date and maturity_date in the same year',
      '   (or worse, on the same day) for what looks like a 1y+ FD,',
      '   you have probably read the SAME row twice — fix it.',
      '',
      '   IMPORTANT — DEPOSIT-ROW SECONDARY DATE TRAP:',
      '   On 定額貯金 (postal time deposit) and many 定期預金 products,',
      '   the DEPOSIT ROW itself shows TWO dates: the deposit date',
      '   (left, e.g. 24-06-08) AND a second date near the rate',
      '   column (e.g. 24-12-08). The second date is the',
      '   据置期間満了日 (withdrawal-eligible / lockup-expiry date),',
      '   typically deposit + 6 months for 定額貯金. It is NOT the',
      '   maturity. NEVER use that second deposit-row date as',
      '   maturity_date / close_date.',
      '',
      '   The true maturity comes ONLY from a separate PAYMENT row',
      '   showing お支払金額 / 払戻金額 / 支払金額 columns. If no',
      '   such payment row exists, the FD is still active — leave',
      '   maturity_date null.',
      '',
      '3. ERA CONVERSION — be especially careful:',
      '     平成 (Heisei, "H"): + 1988 = Western year',
      '       H24 = 2012  · H30 = 2018  · H31 = 2019 (era ended Apr 30)',
      '     令和 (Reiwa, "R"):  + 2018 = Western year',
      '       R1 = 2019 (era began May 1) · R5 = 2023 · R10 = 2028',
      '',
      '   HARD INVARIANTS — these are mathematically required, not',
      '   stylistic preferences. If your candidate violates any of',
      '   them, the era is wrong and you must recompute:',
      '     - Reiwa (令和) DID NOT EXIST before 2019-05-01. Any',
      '       date you have produced as a Reiwa year MUST be 2019',
      '       or later. If you produced "2005" from R5, that is',
      '       BACKWARDS — R5 = 2023, NOT 2005. Recompute.',
      '     - Heisei (平成) ran 1989-01-08 through 2019-04-30. Any',
      '       Heisei-derived Western year MUST be in 1989..2019.',
      '     - When a 4-digit Western year stamp like "2023" appears',
      '       directly on the document, prefer it over your own era',
      '       conversion.',
      '',
      '   Common misreads to watch for:',
      '     - 令和N年 read AS the Western year "200N" or "20N":',
      '       e.g., 令和5年 (=2023) misread as 2005, 令和6年 (=2024)',
      '       misread as 2006. If you computed a Western year before',
      '       2019 from a 令 / R prefix, you reversed the conversion —',
      '       redo it.',
      '     - H24 (=2012) misread as R10 (=2028) — they look',
      '       similar in stamped/handwritten form. If you computed a',
      '       2028 deposit date for an FD, the document almost',
      '       certainly says H24 (2012), not R10 (2028).',
      '     - H30 (=2018) vs R12 (=2030) — same risk.',
      '     - Era-less year numbers — if you see "24-06-08" with no',
      '       prefix, look for context (a 平成 / 令和 marker on the',
      '       page header) before assuming Reiwa.',
      '',
      '4. FD term-length sanity: typical Japanese FDs have 1y / 3y /',
      '   5y / 10y terms. If your computed maturity_date - open_date',
      '   would be more than 30 years apart, you misread one of the',
      '   eras — recheck.',
      '',
      '5. If after these checks you\'re still not confident about a',
      '   date, return null and add a warning to the warnings[]',
      '   array describing what you saw and why you couldn\'t resolve it.',
      '',
      'For an FD that ROLLED OVER (matured + reinvested into a new',
      'FD), capture the OLD FD as one accounts[] entry (with its own',
      'open + close dates) and the NEW FD as a SEPARATE accounts[]',
      'entry (its own open date, no close date if still active). They',
      'are technically separate accounts on the FBAR.',
      '',
      'COMMON CASES:',
      '- Japanese 通帳 (passbook): institution_name is the bank as',
      '  printed (usually 漢字 form like "ゆうちょ銀行"); ALSO populate',
      '  `institution_name_jp` with the same value AND populate',
      '  `institution_name_en` with the romanized English name when',
      '  the institution is well-known (e.g., 秋田銀行 → "Akita Bank",',
      '  ゆうちょ銀行 → "Japan Post Bank", 三菱UFJ → "MUFG Bank").',
      '  currency "JPY", country "JP". Each row is a transaction; the',
      '  rightmost column 差引残高 is the running balance after that',
      '  transaction. For each calendar year visible, find the MAX',
      '  value of 差引残高 across that year\'s rows and put it in',
      '  `years_covered`.',
      '',
      'DEEP PASSBOOK ANALYSIS — when the document is a Japanese',
      '通帳, ALSO extract these structured details:',
      '',
      'a) `transactions[]` — capture EVERY visible transaction row:',
      '     { "date": "YYYY-MM-DD", "deposit": number|null,',
      '       "withdrawal": number|null, "balance": number,',
      '       "description": string|null }',
      '   The `balance` is the running 差引残高 AFTER that row.',
      '   Capture for EVERY visible row — not just deposits or',
      '   withdrawals. Interest rows (利息 / リソク) and carry-overs',
      '   are also rows; populate their `balance` field.',
      '   Convert era dates (令和N年, 平成N年) to YYYY-MM-DD.',
      '',
      'b) `consolidated_entries[]` — Japanese passbooks sometimes',
      '   collapse N transactions into a single "合算" or "合算N" row',
      '   when the book hasn\'t been printed in a long time. That',
      '   single row HIDES individual transactions and may obscure',
      '   the true peak balance in that range. When you see one:',
      '     { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD",',
      '       "count": number, "total_deposits": number|null,',
      '       "total_withdrawals": number|null,',
      '       "ending_balance": number|null }',
      '   ALSO add a string to top-level `warnings[]` flagging that',
      '   the peak in that range may be unknown.',
      '',
      'c) `fd_references[]` — fixed deposit (定期預金 / FD) certificate',
      '   references that appear alongside passbook entries (e.g., a',
      '   parallel FD certificate number printed in the passbook).',
      '   FDs roll over: a matured FD reinvested gets a new cert',
      '   number that is a CONTINUATION of the same FD, not a',
      '   separate account.',
      '     { "cert_number": string, "fd_number": string|null,',
      '       "amount": number|null, "open_date": "YYYY-MM-DD"|null,',
      '       "maturity_date": "YYYY-MM-DD"|null,',
      '       "status": "active" | "matured" | "rolled" | "unknown" }',
      '   These are NOT regular transactions; do not include them',
      '   in `transactions[]`. The user may import the FD as a',
      '   separate account record later.',
      '',
      'd) `carry_over_balance` — number|null. The first line of a',
      '   new passbook often shows 繰越高 / 繰越 — the ending balance',
      '   carried from the previous book. Capture this value',
      '   separately from `transactions[]`.',
      '',
      'e) `warnings[]` — string array of ambiguities the user should',
      '   review. When a value is unclear (handwritten, smudged,',
      '   partially obscured), set the value to null AND add a',
      '   warning describing what couldn\'t be read. Do NOT guess.',
      '   Examples:',
      '     "Row 12 (合算9, 2018-04-15 to 2020-03-10) collapses 9',
      '      transactions; peak balance in that range is unknown."',
      '     "Balance on 2024-08-22 is partially obscured; left null."',
      '     "Account holder name appears handwritten and ambiguous."',
      '',
      'TRANSACTION VOLUME / TOKEN BUDGET:',
      'A long passbook can have hundreds of transactions. Try to',
      'capture all of them — but if you sense the response is',
      'getting long, prioritize: (1) `years_covered` summary,',
      '(2) `consolidated_entries`, (3) `fd_references`, (4)',
      '`warnings`, (5) representative `transactions` rows including',
      'every yearly peak. The application will reconstruct per-year',
      'maxes from `transactions[]` if `years_covered` is missing.',
      '- Wise statement: institution_name "Wise". Currency per the',
      '  statement. Statements usually cover a single period; populate',
      '  `years_covered` with one entry per calendar year that has',
      '  visible balances.',
      '- Online banking screenshot: extract whatever is visible. If',
      '  the dashboard shows an explicit "annual high" / "年中最高残高"',
      '  field, use that for the corresponding year in `years_covered`',
      '  rather than the current snapshot balance.',
      '',
      'Return JSON only. The user will review and correct every field.',
    ].join('\n');
  }

  function parseJsonFromResponse(text) {
    if (!text) throw new Error('Empty response from Claude');
    let trimmed = String(text).trim();
    // Strip markdown code fences if Claude added them despite instructions.
    if (trimmed.startsWith('```')) {
      trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    // Handle stray prose before/after the JSON object.
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      trimmed = trimmed.slice(first, last + 1);
    }
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      // Best-effort recovery from truncated responses (response cut
      // off at max_tokens). Try to salvage the top-level scalar
      // fields plus whatever years_covered entries completed before
      // the cutoff.
      const recovered = recoverPartialJson(trimmed);
      if (recovered && recovered._partial) {
        console.warn('[ai-client] Response was truncated; recovered partial JSON with', (recovered.years_covered || []).length, 'years.');
        return recovered;
      }
      throw new Error('Failed to parse extraction JSON: ' + err.message + '\n\nRaw response:\n' + text.slice(0, 500));
    }
  }

  // Salvage what we can from a truncated extraction response. We
  // assume the JSON fragment starts with a single { and was cut off
  // somewhere inside an array. Strategy:
  //   1. Pull every "key": value pair where the value is a complete
  //      string, number, or boolean (top-level scalars).
  //   2. Find a "years_covered": [ ... ] block and parse as many
  //      complete { ... } objects as possible from inside it.
  //   3. Return a synthetic object with those plus _partial: true.
  function recoverPartialJson(fragment) {
    const out = { _partial: true };

    // Top-level scalars.
    const scalarRe = /"([a-z_]+)"\s*:\s*(?:"((?:\\.|[^"\\])*)"|(-?\d+(?:\.\d+)?)|(true|false|null))/g;
    let m;
    while ((m = scalarRe.exec(fragment)) !== null) {
      const key = m[1];
      const strVal = m[2];
      const numVal = m[3];
      const boolVal = m[4];
      if (key === 'year' || key === 'max_balance_native' || key === 'max_balance_date'
          || key === 'balance_native' || key === 'date' || key === 'memo') continue;
      if (out[key] !== undefined) continue;
      if (strVal !== undefined) out[key] = strVal.replace(/\\(.)/g, '$1');
      else if (numVal !== undefined) out[key] = parseFloat(numVal);
      else if (boolVal === 'true') out[key] = true;
      else if (boolVal === 'false') out[key] = false;
      else if (boolVal === 'null') out[key] = null;
    }

    // years_covered array — extract complete { ... } objects.
    const ycIdx = fragment.indexOf('"years_covered"');
    if (ycIdx >= 0) {
      const after = fragment.slice(ycIdx);
      const arrStart = after.indexOf('[');
      if (arrStart >= 0) {
        const arrText = after.slice(arrStart + 1);
        const years = [];
        const objRe = /\{[^{}]*\}/g;
        let mm;
        while ((mm = objRe.exec(arrText)) !== null) {
          try {
            const obj = JSON.parse(mm[0]);
            if (obj && typeof obj.year === 'number' && typeof obj.max_balance_native === 'number') {
              years.push(obj);
            }
          } catch (_) { /* skip malformed */ }
        }
        if (years.length > 0) out.years_covered = years;
      }
    }

    // Only return if we got something useful.
    if (out.years_covered && out.years_covered.length > 0) return out;
    if (out.institution_name || out.account_number) return out;
    return null;
  }

  async function callClaudeVisionForExtraction(file, kind, options) {
    if (!hasKey()) {
      throw new Error('No Claude API key set. Add one in Settings to enable document upload.');
    }
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error(`Unsupported file type: ${file.type || file.name}. Use PNG, JPG, WEBP, GIF, or PDF.`);

    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    // Consent gate — passes the file context so per-call modal can name
    // the file and show a real cost estimate.
    await checkConsent(opts.feature || 'fbar_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);

    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const promptText = buildExtractionPrompt(kind, opts);

    const body = {
      model: useModel,
      // Vision extractions on multi-year passbooks can produce
      // verbose JSON. 8192 tokens (~32 KB of output text) fits a
      // 30-year passbook with the year-summary + 3-rows-per-year
      // sample. callClaude (chat) keeps the conservative 1024
      // default; only this vision path needs the larger budget.
      max_tokens: opts.maxTokens || 8192,
      // Lower temperature for extraction — we want determinism.
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: promptText }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'fbar_vision');
    const text = (json.content || [])
      .map(c => c.type === 'text' ? c.text : '')
      .join('');
    const parsed = parseJsonFromResponse(text);

    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // ASSET STATEMENT EXTRACTION (vision)
  // ====================================================================
  //
  // callClaudeVisionForAssetExtraction(file, options)
  //   file: a File object (from <input type="file">) — PNG / JPG / WEBP
  //         / GIF / PDF
  //   options.country_hint:    'US' | 'JP' | null — passed when the modal
  //                             already knows which side of the Pacific
  //   options.model:           override default model
  //   options.maxTokens:       defaults to 2048
  //
  // Returns: { extracted, raw, usage, model, cost_usd } where `extracted`
  // is a parsed object conforming to the OUTPUT SHAPE below. Throws on
  // network error, no API key, or unparseable response.
  //
  // Designed for the Assets module. Output is single-account; if the
  // statement covers multiple accounts the model is instructed to return
  // the largest / most prominent one and list the others under
  // `additional_accounts_observed` for the user's reference.
  // ====================================================================

  function buildAssetExtractionPrompt(opts) {
    const country = opts && opts.country_hint ? opts.country_hint : null;
    const countryHint = country
      ? `\nThe user has indicated this is a ${country === 'US' ? 'United States' : country === 'JP' ? 'Japan' : country} account, but verify against the document.`
      : '';
    return [
      'You are an extraction assistant for a portfolio tracker that',
      'helps Americans living in Japan organize accounts on both sides',
      'of the Pacific.' + countryHint,
      '',
      'You receive an account statement, passbook page, or screenshot of',
      'a financial institution\'s account-list page. Return STRUCTURED',
      'JSON describing EVERY account you can read on the page — not just',
      'the largest one.',
      '',
      'CRITICAL RULES:',
      '- Respond with ONLY a JSON object, nothing else. No markdown,',
      '  no code fences, no commentary before or after the JSON.',
      '- The output is ALWAYS shaped { "accounts": [ … ] }. Even if only',
      '  one account is visible, wrap it in the array.',
      '- One array entry per distinct account. If a screenshot lists 4',
      '  accounts (e.g., a Navy Federal "Accounts" page with Checking,',
      '  Savings, Money Market, and a CD), return 4 entries — same',
      '  institution, different account_name, different last4, different',
      '  tax_wrapper_hint as appropriate.',
      '- If you cannot determine a field, use null. Never guess.',
      '- ALL dates in your output MUST be ISO 8601 (YYYY-MM-DD).',
      '- Numbers: use the document\'s native currency. Strip currency',
      '  symbols, commas, and Japanese 万 notation. Return raw numbers',
      '  (e.g., 1500000 not "¥1,500,000", "150万円" → 1500000).',
      '- Account numbers: return ONLY the last 4 digits.',
      '',
      'JAPANESE CALENDAR (和暦):',
      'If the document uses 和暦, convert: 令和N → 2018+N · 平成N → 1988+N',
      '· 昭和N → 1925+N. 令和元年 = 2019, 平成元年 = 1989.',
      '',
      'TREASURY-SPECIFIC FIELDS:',
      'For TreasuryDirect savings bonds, the page typically shows BOTH a',
      'face/purchase "Amount" and a "Current Value". Use Current Value as',
      'balance_native (the bond\'s present worth incl. accrued interest).',
      'For marketable Treasuries, use the current market/par value shown.',
      'Put the issue date and maturity date in notes_suggestion when',
      'visible (e.g., "Issued 2022-05-01, matures 2052-05-01, 3.12% rate").',
      '',
      'TAX WRAPPER TAXONOMY (use one of these exact IDs in tax_wrapper_hint).',
      'Pick by the account TYPE label on the document, not by institution.',
      'Bank-deposit accounts (checking / savings / money-market / CD) are',
      'NEVER taxable_brokerage — that wrapper is reserved for SECURITIES',
      'accounts (stocks / ETFs / mutual funds at Schwab, Fidelity, etc.).',
      '  traditional_ira         — Traditional / pre-tax IRA',
      '  traditional_401k_tsp    — Traditional 401(k), 403(b), TSP',
      '  roth_ira                — Roth IRA',
      '  roth_401k               — Roth 401(k) / Roth TSP',
      '  taxable_brokerage       — U.S. taxable SECURITIES brokerage (stocks / ETFs / mutual funds)',
      '  hsa                     — Health Savings Account',
      '  rsu_unvested            — Unvested RSU grants (employer equity portal)',
      '  nso_iso                 — NSO / ISO option grants',
      '  deferred_comp           — Deferred compensation (409A)',
      '  us_real_estate          — U.S. real estate (deed / appraisal)',
      '  us_checking             — U.S. bank/credit-union CHECKING (Navy Federal Flagship Checking, USAA Checking, etc.)',
      '  us_savings              — U.S. bank/credit-union SAVINGS or money-market savings (incl. NCUA share savings, jumbo MMA)',
      '  us_cd                   — U.S. bank/credit-union CERTIFICATE OF DEPOSIT / share certificate (any "Cert ___ Month" product)',
      '  us_savings_bond         — U.S. Treasury SAVINGS BOND held at TreasuryDirect: Series I, Series EE',
      '  us_treasury             — U.S. Treasury MARKETABLE security: T-Bill, T-Note, T-Bond, TIPS, FRN (auction-issued)',
      '  jp_savings              — Japan savings / 普通預金',
      '  jp_checking             — Japan checking / 当座預金',
      '  jp_fixed_deposit        — Japan time deposit / 定期 / 定額貯金',
      '  529                     — 529 college savings plan',
      '  other                   — anything else',
      '',
      'ALLOCATION HINT (optional, only when holdings are visible):',
      'If the document shows actual holdings (e.g., a brokerage page with',
      'fund tickers or a 401(k) page with "70% VTI / 20% VXUS / 10% BND"),',
      'fill allocation_hint with decimals 0-1 summing to 1.0 across the',
      'six classes: equity_us, equity_intl, bond, cash, real_estate,',
      'alternative. If no holdings are visible, return null and the tool',
      'will use a wrapper-based default. Do NOT guess from institution',
      'name alone — only fill when actual position data is on the page.',
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "accounts": [',
      '    {',
      '      "institution":              string | null,   // e.g. "Navy Federal", "横浜銀行"',
      '      "account_name":             string | null,   // e.g. "Flagship Checking", "Jumbo MMA"',
      '      "country":                  "US" | "JP" | "OTHER" | null,',
      '      "currency":                 string | null,   // ISO code',
      '      "tax_wrapper_hint":         string | null,   // ID from taxonomy above',
      '      "balance_native":           number | null,   // balance in native currency',
      '      "basis_native":             number | null,   // cost basis if visible (taxable / RE only)',
      '      "as_of_date":               string | null,   // YYYY-MM-DD statement date',
      '      "account_number_last4":     string | null,   // last 4 digits only',
      '      "notes_suggestion":         string | null,   // e.g. dividend rate, maturity date',
      '      "allocation_hint":          { equity_us: number, equity_intl: number, bond: number, cash: number, real_estate: number, alternative: number } | null',
      '    },',
      '    …',
      '  ],',
      '  "page_kind":                "accounts_list" | "single_statement" | "passbook" | "screenshot" | "other",',
      '  "primary_index":            number | null         // index into accounts[] of the largest / most prominent account, or null if undetermined',
      '}',
      '',
      'Return JSON now.',
    ].join('\n');
  }

  async function callClaudeVisionForAssetExtraction(file, options) {
    if (!hasKey()) {
      throw new Error('No Claude API key set. Add one in Settings to enable document upload.');
    }
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error(`Unsupported file type: ${file.type || file.name}. Use PNG, JPG, WEBP, GIF, or PDF.`);

    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'asset_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 2048,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildAssetExtractionPrompt(opts) }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'asset_vision');
    const text = (json.content || [])
      .map((c) => c.type === 'text' ? c.text : '')
      .join('');
    const parsed = parseJsonFromResponse(text);

    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // DOCUMENT EXTRACTION (vision)
  // ====================================================================
  //
  // callClaudeVisionForDocumentExtraction(file, options)
  //   file: PNG/JPG/WEBP/GIF/PDF
  //   options.expected_type: optional hint ('passport_us', 'will', etc.)
  //
  // Returns a parsed metadata object — NOT the file, NOT a transcription.
  // Only the small set of fields we care about for inventory + expiry
  // tracking. Asks the model to recognize document type and pick the
  // right extraction shape.

  function buildDocumentExtractionPrompt(opts) {
    const hint = opts && opts.expected_type
      ? '\nThe user expects this to be a "' + opts.expected_type + '" — verify and correct if wrong.'
      : '';
    return [
      'You are a document-inventory assistant. The user uploads a photo',
      'or scan of an important document (passport, drivers license,',
      'residence card, will, deed, tax return, etc.) and you extract',
      'just enough metadata to track it in an inventory + expiry calendar.',
      hint,
      '',
      'CRITICAL RULES:',
      '- Respond with ONLY a JSON object, nothing else. No markdown,',
      '  no code fences, no commentary before or after.',
      '- If you cannot determine a field, use null. Never guess.',
      '- ALL dates: ISO 8601 (YYYY-MM-DD).',
      '- For Japanese dates in 和暦, convert: 令和N → 2018+N · 平成N → 1988+N · 昭和N → 1925+N.',
      '- Reference numbers: return ONLY the LAST 4 digits/chars for privacy.',
      '- DO NOT transcribe the document content. Do not return passport',
      '  numbers, SSNs, full account numbers, or any other PII beyond',
      '  what\'s explicitly requested.',
      '',
      'DOCUMENT TYPE TAXONOMY (use one of these in document_type):',
      '  passport_us, passport_jp, passport_other,',
      '  drivers_license_us, drivers_license_jp, drivers_license_intl,',
      '  residence_card_jp (在留カード), my_number_card_jp (マイナンバーカード),',
      '  ssn_card, naturalization_cert, green_card,',
      '  visa, dd214, military_id, sofa_orders,',
      '  birth_cert, marriage_cert, divorce_decree,',
      '  will, trust_doc, poa, advance_directive,',
      '  property_deed, mortgage_doc, vehicle_title,',
      '  insurance_health, insurance_life, insurance_auto, insurance_home,',
      '  tax_return_us, tax_return_jp, fbar_confirmation, w2, ten99,',
      '  beneficiary_designation, employment_contract,',
      '  vaccination_record, medical_record,',
      '  other',
      '',
      'CATEGORY (use one of these in category):',
      '  identification | immigration | family | military_sofa |',
      '  estate | property | insurance | tax | medical | legal | other',
      '',
      'OUTPUT SHAPE (return EXACTLY these keys, nullable):',
      '{',
      '  "document_type":           string | null,    // ID from taxonomy',
      '  "category":                string | null,    // category from list',
      '  "title":                   string | null,    // human-readable, e.g. "US Passport"',
      '  "person_name":             string | null,    // full name as printed',
      '  "issuing_authority":       string | null,    // e.g. "US Dept of State", "東京都公安委員会"',
      '  "issue_date":              string | null,    // YYYY-MM-DD',
      '  "expiry_date":             string | null,    // YYYY-MM-DD or null if no expiry',
      '  "reference_number_last4":  string | null,    // last 4 digits/chars only',
      '  "notes_suggestion":        string | null     // 1-2 sentences worth saving',
      '}',
      '',
      'Return JSON now.',
    ].join('\n');
  }

  async function callClaudeVisionForDocumentExtraction(file, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('File too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). Limit ' + (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error('Unsupported file type: ' + (file.type || file.name));
    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'document_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildDocumentExtractionPrompt(opts) }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'document_vision');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // MEDICAL EXAM / LAB RESULTS EXTRACTION (vision)
  // ====================================================================
  //
  // callClaudeVisionForMedicalExtraction(file, options)
  //   file:    File object (PNG/JPG/WEBP/GIF/PDF — same as other vision)
  //   options.expected_type: 'blood_panel' | 'imaging' | 'physical' |
  //                          'specialist' | 'other' (hint, not required)
  //
  // Returns the same envelope as other vision extractors:
  //   { extracted, raw, usage, model, cost_usd }
  //
  // The extracted JSON shape:
  //   {
  //     exam_type, date, provider, facility,
  //     vitals: { weight_kg, height_cm, bp_systolic, bp_diastolic,
  //               heart_rate_bpm, temp_c, respiratory_rate, spo2_pct },
  //     lab_results: [{ name, value (number), unit, range_low, range_high,
  //                     flag ('normal'|'low'|'high'|'critical') }],
  //     diagnoses: [string],
  //     procedures: [string],
  //     followup: string,
  //     summary: short plain-text summary of notable findings
  //   }
  //
  // Privacy: this is an explicit user-initiated upload like the existing
  // vision flows. The image is held in memory only, never persisted,
  // and runs through the same consent gate. Feature id is
  // 'medical_vision' so it can be allowed/denied independently of
  // FBAR / asset / document vision.

  function buildMedicalExtractionPrompt(opts) {
    const hint = opts && opts.expected_type
      ? '\nThe user expects this to be a "' + opts.expected_type + '" — verify and correct if wrong.'
      : '';
    return [
      'You are a medical-record extraction assistant. The user uploads a',
      'photo or scan of a medical exam result, lab report, or clinical',
      'summary, and you extract structured data so they can track it over',
      'time in a personal health tracker.',
      hint,
      '',
      'CRITICAL RULES:',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- DO NOT invent values. If a field is not visible or not present,',
      '  set it to null (or omit it from lab_results / arrays entirely).',
      '- For lab values: extract the numeric value as a NUMBER, not a',
      '  string. Preserve the unit exactly as written (mg/dL, mmol/L,',
      '  g/dL, %, etc.). Capture reference range when present.',
      '- For the "flag" field: derive from the value vs. range. Use',
      '  "normal" when within range, "low" / "high" when out, "critical"',
      '  when the report itself flags it as critical / urgent / panic',
      '  value. Do NOT flag based on absolute thresholds — only on the',
      '  per-report reference range.',
      '- Dates: convert to YYYY-MM-DD (ISO 8601). Handle 和暦 (令和/平成)',
      '  by converting to the Western year first. If the report has only',
      '  a draw date and a result date, prefer the DRAW date.',
      '- Weights/heights: convert lbs → kg (1 lb = 0.4536 kg) and in/ft',
      '  → cm (1 in = 2.54 cm). Always store metric.',
      '- Vitals: only include keys with values. Omit keys you can\'t see.',
      '- diagnoses / procedures: extract only what is explicitly stated.',
      '  Do not infer diagnoses from lab values.',
      '- summary: a short 1-3 sentence plain-text observation about',
      '  notable findings (e.g., "A1C 5.4% — within normal range. LDL',
      '  138 mg/dL — slightly elevated. Vitamin D 22 ng/mL — low."). No',
      '  recommendations or medical advice; just the facts.',
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "exam_type": "physical"|"blood_panel"|"imaging"|"specialist"|"procedure"|"surgery"|"screening"|"dental"|"vaccination"|"mental_health"|"emergency"|"telehealth"|"follow_up"|"other"|null,',
      '      // "procedure" = colonoscopy / endoscopy / EGD / biopsy /',
      '      //   minor procedure with a procedure-report document.',
      '      // "surgery" = operative report / surgical procedure.',
      '      // "screening" = standalone preventive screening visit',
      '      //   (mammogram, DEXA, AAA screen) where the document is',
      '      //   primarily a screening result, not imaging in general.',
      '      // "specialist" = office consult / specialist evaluation.',
      '      // Reserve "other" for things you genuinely can\'t classify —',
      '      // do NOT use it as a default when one of the above fits.',
      '  "date": "YYYY-MM-DD"|null,',
      '  "provider": "ordering physician"|null,',
      '  "facility": "lab / clinic name"|null,',
      '  "vitals": {',
      '    "weight_kg": number|null, "height_cm": number|null,',
      '    "bp_systolic": number|null, "bp_diastolic": number|null,',
      '    "heart_rate_bpm": number|null, "temp_c": number|null,',
      '    "respiratory_rate": number|null, "spo2_pct": number|null',
      '  },',
      '  "lab_results": [',
      '    { "name": "Hemoglobin A1C", "value": 5.4, "unit": "%",',
      '      "range_low": 4.0, "range_high": 5.6, "flag": "normal" },',
      '    ...',
      '  ],',
      '  "diagnoses": [ "string" ],',
      '  "procedures": [ "string" ],',
      '  "followup": "string"|null,',
      '  "summary": "string"|null',
      '}',
      '',
      'Return JSON only.',
    ].join('\n');
  }

  async function callClaudeVisionForMedicalExtraction(file, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('File too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). Limit ' + (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error('Unsupported file type: ' + (file.type || file.name));
    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'medical_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 4096,
      temperature: opts.temperature == null ? 0.1 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildMedicalExtractionPrompt(opts) }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'medical_vision');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // MEDICAL INVOICE EXTRACTION (vision)
  // ====================================================================
  //
  // callClaudeVisionForInvoiceExtraction(file, options)
  //   file:    File object (PNG/JPG/WEBP/GIF/PDF)
  //   options: { feature? }
  //
  // Extracts billing/receipt metadata: date, provider, facility, amount,
  // currency, type, paid status, services rendered. Used by the Health
  // Tracker's "Import invoice (AI)" flow to auto-populate invoice
  // records + suggest auto-linking to existing exams/episodes by date
  // and provider matching.
  //
  // Uses the same `medical_vision` consent feature as exam extraction —
  // a separate `invoice_vision` feature would just clutter the consent
  // grid without giving meaningful additional control (both are
  // medical-records vision flows).

  function buildInvoiceExtractionPrompt() {
    return [
      'You are an invoice/receipt extraction assistant. The user uploads',
      'a photo or scan of a medical bill, receipt, or insurance EOB and',
      'you extract structured metadata so they can track healthcare',
      'spending and link the invoice to the related visit/episode.',
      '',
      'CRITICAL RULES:',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- DO NOT invent values. If a field is not visible or unclear,',
      '  set it to null.',
      '- Amount: extract the TOTAL DUE (or total paid) as a NUMBER, not',
      '  a string. If there are multiple line items, capture the grand',
      '  total. If only an amount is shown without explicit total,',
      '  use that.',
      '- Currency: ISO 4217 code. JPY for 円 / ¥ / Japanese yen.',
      '  USD for $ when context is US-based. EUR for €. GBP for £.',
      '  Be conservative — when ambiguous (e.g., bare $ in a JP context),',
      '  prefer the symbol\'s default but flag uncertainty in notes.',
      '- Numeric format hint: JPY values rarely have decimals; USD/EUR',
      '  almost always do. A "1,234" value in a JP receipt is probably',
      '  JPY ¥1,234, not USD $1,234.',
      '- Dates: convert to YYYY-MM-DD. Handle 和暦 (令和/平成) by',
      '  converting to Western year first. When a "service date" and',
      '  "billing date" differ, prefer the SERVICE DATE (the appointment',
      '  / procedure date) — that\'s what we use to link to exams.',
      '- Type: classify into one of: "visit" (office visit / consult),',
      '  "lab" (blood draw / pathology), "procedure" (colonoscopy /',
      '  surgery / minor procedure), "rx" (prescription / pharmacy),',
      '  "imaging" (X-ray / MRI / CT / ultrasound), "er" (emergency /',
      '  urgent care), "dental", or "other". Make a best guess from',
      '  the line items + facility name.',
      '- Paid status: true when receipt clearly shows "PAID" or "Balance:',
      '  $0" or "支払済"; false when bill shows balance due. When',
      '  unclear, leave null.',
      '- Services summary: 1-2 sentence plain-text summary of what was',
      '  billed for. Helps the user identify the invoice later.',
      '- Medications: when the document is a pharmacy receipt, an RX',
      '  invoice, or otherwise lists prescribed/dispensed drugs as line',
      '  items, extract each drug into the "medications" array. Skip',
      '  OTC items unless the document explicitly bills them as a',
      '  prescription. For each medication, capture name, dosage as a',
      '  NUMBER, dosage_unit (mg/mcg/g/mL/units/IU/puff), frequency',
      '  (e.g., "2x daily", "every 6h", "once before procedure"), and',
      '  the prescription instruction text when visible. Common JP',
      '  pharmacy formats list drugs as "薬品名 用量 用法" — parse',
      '  these. When the document is clearly not pharmacy/RX (e.g., a',
      '  hospital procedure bill, lab invoice), leave medications as []',
      '  even if drug names appear in service descriptions — we only',
      '  want actual prescribed/dispensed items.',
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "date": "YYYY-MM-DD"|null,         // service date if available',
      '  "billing_date": "YYYY-MM-DD"|null, // when bill was issued (if different)',
      '  "provider": "string"|null,         // clinic / hospital / lab / pharmacy name (most comprehensive form available)',
      '  // ALWAYS extract BOTH languages when both appear on the bill —',
      '  // JP medical/dental bills almost always print the clinic name in',
      '  // Japanese AND sometimes also Romanized/English. Capture each',
      '  // separately so the host app can store them as parallel fields.',
      '  "provider_name_en": "string"|null,',
      '  "provider_name_jp": "string"|null,',
      '  "provider_phone": "string"|null,   // phone printed on receipt header',
      '  "provider_address": "string"|null, // address printed on receipt header',
      '  "facility": "string"|null,         // location / branch name if different',
      '  "amount": number|null,              // total due or paid (NUMBER)',
      '  "currency": "USD"|"JPY"|"EUR"|"GBP"|"CAD"|"AUD"|"CHF"|null,',
      '  "type": "visit"|"lab"|"procedure"|"rx"|"imaging"|"er"|"dental"|"other"|null,',
      '  "paid": true|false|null,',
      '  "summary": "string"|null,           // 1-2 sentence services summary',
      '  "notes": "string"|null,             // anything else worth keeping (CPT codes, insurance info, line-item list)',
      '  "medications": [                    // empty array when no rx/pharmacy items',
      '    {',
      '      "name": "string",               // brand name as printed (e.g., "Lipitor", "ニフレック")',
      '      "generic_name": "string"|null,  // generic / chemical name when shown (e.g., "atorvastatin", "polyethylene glycol")',
      '      "dosage": number|null,          // numeric dose (e.g., 20, 0.5)',
      '      "dosage_unit": "mg"|"mcg"|"g"|"mL"|"units"|"IU"|"puff"|null,',
      '      "frequency": "string"|null,     // dosing instructions (e.g., "1 tab nightly", "2x daily", "once before procedure")',
      '      "quantity": number|null,        // total quantity dispensed when shown (e.g., 30 tablets)',
      '      "instructions": "string"|null   // any additional sig / instruction text printed on the receipt',
      '    }',
      '  ]',
      '}',
      '',
      'Return JSON only.',
    ].join('\n');
  }

  async function callClaudeVisionForInvoiceExtraction(file, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('File too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). Limit ' + (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error('Unsupported file type: ' + (file.type || file.name));
    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'medical_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 2048,
      temperature: opts.temperature == null ? 0.1 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildInvoiceExtractionPrompt() }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'medical_vision');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // DENTAL EXAM EXTRACTION (vision)
  // ====================================================================
  //
  // callClaudeVisionForDentalExtraction(file, options)
  //   • Mirrors the medical-extraction prompt but specialized for
  //     dental records (Japanese 歯科 reports and US dental records).
  //   • Extracts: per-tooth findings, treatment-history procedures
  //     (with JP insurance codes + Japanese names), periodontal stats,
  //     provider info, recommendations + action items, billing.
  //   • Uses `medical_vision` consent (same flow as medical exams).

  function buildDentalExtractionPrompt() {
    return [
      'You are a dental-record extraction assistant. The user uploads',
      'a dental exam report, periodontal chart, or treatment receipt',
      '(Japanese 歯科 or US dental) and you produce structured data so',
      'their personal Health Tracker dental tab can populate cleanly.',
      '',
      'CRITICAL RULES:',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- DO NOT invent values. Null when not visible.',
      '- Universal numbering = 1-32 (US/world standard).',
      '  FDI numbering = quadrant.position (e.g., 16 = upper right',
      '  first molar = Universal #3). When you see FDI numbers like',
      '  "16" or "26", convert to Universal in the output. Map:',
      '    11=8, 12=7, 13=6, 14=5, 15=4, 16=3, 17=2, 18=1,',
      '    21=9, 22=10, 23=11, 24=12, 25=13, 26=14, 27=15, 28=16,',
      '    31=24, 32=23, 33=22, 34=21, 35=20, 36=19, 37=18, 38=17,',
      '    41=25, 42=26, 43=27, 44=28, 45=29, 46=30, 47=31, 48=32',
      '- Dates: YYYY-MM-DD. Handle 和暦 (令和/平成) → Western year.',
      '- Currency: most JP dental bills are in JPY (¥). US dental in USD.',
      '- For "points" — Japanese 健康保険 insurance reports treatments in',
      '  point values (1 point = ¥10 typically). Capture both points',
      '  and the yen cost when both visible.',
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "is_dental": true|false,            // is this actually a dental document?',
      '  "exam_date": "YYYY-MM-DD"|null,',
      '  "provider": {',
      '    // ALWAYS try to extract BOTH the English and Japanese clinic',
      '    // names when both appear on the document — these often coexist',
      '    // on JP clinic letterheads (e.g., "Sakura Dental Clinic" +',
      '    // "さくら歯科"). Leave the other null only when truly only',
      '    // one language is printed. Strip parenthetical Romanized',
      '    // pronunciations when the dominant text is already in that',
      '    // language.',
      '    "name_en": "string"|null,',
      '    "name_jp": "string"|null,',
      '    "type": "string"|null,            // e.g., "Orthodontics", "General"',
      '    "address": "string"|null,',
      '    "phone": "string"|null',
      '  },',
      '  "teeth": [                          // only for teeth with findings — natural teeth not listed are assumed normal',
      '    {',
      '      "uni": 14,                      // Universal number',
      '      "status": "natural"|"filling"|"crown"|"bridge"|"implant"|"rct"|"missing"|null,',
      '      "has_pocket": true|false|null,  // pocket depth ≥ 4mm',
      '      "has_bleeding": true|false|null,',
      '      "is_mobile": true|false|null,',
      '      "has_cavity": true|false|null,  // active caries identified',
      '      "needs_treatment": true|false|null,  // flagged for treatment by clinician',
      '      "needs_observation": true|false|null, // flagged for monitoring',
      '      "pocket_max_mm": number|null,',
      '      "notes": "string"|null',
      '    }',
      '  ],',
      '  "periodontal": {',
      '    "pockets_4mm_pct": number|null,   // % of sites at ≥4mm',
      '    "bleeding_on_probing_pct": number|null,',
      '    "mobile_teeth": number|null,',
      '    // Pocket depth distribution (when explicitly shown):',
      '    "pocket_dist_healthy_pct": number|null,  // 1–3 mm range',
      '    "pocket_dist_mild_pct": number|null,     // 4–6 mm range',
      '    "pocket_dist_severe_pct": number|null    // 7+ mm range',
      '  },',
      '  // Aggregate counts for chart badges (when stated as summary',
      '  // counts on the doc, e.g., "Cavities: 0, Requires treatment: 0"):',
      '  "treatment_summary": {',
      '    "cavities": number|null,         // teeth with active caries',
      '    "needs_treatment": number|null,  // teeth flagged for tx',
      '    "needs_observation": number|null // teeth flagged for monitoring',
      '  },',
      '  "procedures": [                     // every billable line item',
      '    {',
      '      "name_en": "string"|null,',
      '      "name_jp": "string"|null,       // e.g., "scaling (SC)", "歯周基本検査"',
      '      "code": "string"|null,          // JP insurance code (P基検, SC, 初診, etc.) or CDT/ADA code (US)',
      '      "cost": number|null,            // local-currency amount (¥ or $)',
      '      "currency": "JPY"|"USD"|"EUR"|"GBP"|null,',
      '      "points": number|null,          // JP insurance points',
      '      "qty": number|null,',
      '      "tooth_numbers": [number]|null  // Universal numbers when procedure was tooth-specific',
      '    }',
      '  ],',
      '  "findings": "string"|null,          // factual narrative of what the exam observed (teeth counts, lab values, status)',
      '  "clinical_interpretation": "string"|null,  // clinician\'s analysis of what the findings mean (significance, context, drivers — separate from raw findings)',
      '  "recommendations": "string"|null,   // clinician\'s recommendations (newline-separated bullets ok)',
      '  "action_items": [ "string" ]|null,  // discrete follow-up actions for the patient',
      '  "next_appointment": "string"|null,  // FUTURE appointment ONLY. If the document shows the same',
      '                                       // date+time as the exam itself (typical "Next appointment"',
      '                                       // placeholder that\'s actually the current visit), set null.',
      '                                       // Format: YYYY-MM-DD or YYYY-MM-DDThh:mm or descriptive text.',
      '  "billing": {',
      '    "patient_paid": number|null,      // out-of-pocket amount this visit',
      '    "insurance": number|null,         // insurance/SHI covered',
      '    "total": number|null,             // total billed',
      '    "currency": "JPY"|"USD"|"EUR"|"GBP"|null,',
      '    "burden_ratio": "string"|null,    // JP cost share ratio ("3割","1割","10割") when visible',
      '    "receipt_no": "string"|null',
      '  }',
      '}',
      '',
      'Return JSON only.',
    ].join('\n');
  }

  async function callClaudeVisionForDentalExtraction(file, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('File too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). Limit ' + (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error('Unsupported file type: ' + (file.type || file.name));
    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'medical_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 4096,
      temperature: opts.temperature == null ? 0.1 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildDentalExtractionPrompt() }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'medical_vision');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // LAB DESCRIPTIONS (educational reference, no PHI)
  // ====================================================================
  //
  // callClaudeForLabDescriptions(testNames, options)
  //   testNames: string[]   — list of lab test names to describe
  //   options:   { feature? }
  //
  // Generates EN+JP educational descriptions for lab tests not in our
  // built-in LAB_INFO table. NO PHI sent — only the test names. Used by
  // the Health Tracker to fill in info popovers for any test the user
  // imports that we don't already have a description for.
  //
  // Uses `ask_taigan` consent because the data flow matches: text-only
  // request, educational output, no document upload.

  async function callClaudeForLabDescriptions(testNames, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!Array.isArray(testNames) || testNames.length === 0) {
      return { descriptions: {}, cost_usd: 0 };
    }
    const opts = options || {};
    const useModel = opts.model || getModel();
    await checkConsent(opts.feature || 'ask_taigan', {
      tests: testNames,
      estimatedCostUsd: 0.01 * testNames.length,
    });

    const prompt = [
      'You are a medical-lab reference assistant. The user pastes a list',
      'of lab test names and you return short structured descriptions',
      'for each, suitable for an educational hover-popover in a personal',
      'health-tracking app.',
      '',
      'CRITICAL RULES:',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- For each test, provide both English ("en") and Japanese ("jp").',
      '- Each language object: { "what": "...", "why": "...",',
      '  "high": "..."|null, "low": "..."|null }.',
      '  • what:  one sentence — what the test measures',
      '  • why:   one or two sentences — clinical significance',
      '  • high:  optional — common implications of high values',
      '  • low:   optional — common implications of low values',
      '- Keep each section concise (1-2 sentences). Plain English',
      '  (and natural Japanese), not clinical jargon.',
      '- If you don\'t reliably recognize a test name, set "what" to a',
      '  short honest fallback such as "Custom or specialty lab test —',
      '  refer to your lab report or doctor for details" and set the',
      '  other fields to null. Do NOT invent.',
      '- Use the EXACT test name string as the key in the output object.',
      '',
      'TESTS TO DESCRIBE:',
      JSON.stringify(testNames),
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "Test Name 1": {',
      '    "en": { "what": "...", "why": "...", "high": "..."|null, "low": "..."|null },',
      '    "jp": { "what": "...", "why": "...", "high": "..."|null, "low": "..."|null }',
      '  },',
      '  ...',
      '}',
      '',
      'Return JSON only.',
    ].join('\n');

    const body = {
      model: useModel,
      max_tokens: Math.min(4096, 300 + 250 * testNames.length),
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: [{ role: 'user', content: prompt }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'ask_taigan');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      descriptions: parsed || {},
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // INSURANCE CARD EXTRACTION (vision)
  // ====================================================================
  //
  // callClaudeVisionForInsuranceCard(file, options)
  //   file:    File object (PNG/JPG/WEBP/GIF/PDF)
  //   options: { feature? }
  //
  // Extracts metadata from a health-insurance card image/PDF: insurer,
  // plan name, network type, member ID (LAST 4 ONLY for privacy),
  // group/policy number, BIN/PCN/Rx group (pharmacy), customer-service
  // phone, PCP info if printed on card, effective/expiry dates.
  //
  // Privacy posture: prompt explicitly instructs Claude to NEVER return
  // the full member ID — only the last 4 digits. Stored values stay
  // out of the persisted JSON in full form.
  //
  // Uses `medical_vision` consent (same as lab/exam imports).

  function buildInsuranceCardExtractionPrompt() {
    return [
      'You are a medical-insurance-card extraction assistant. The user',
      'uploads a photo or scan of their health insurance card (front,',
      'back, or both) and you extract structured metadata so they can',
      'have a quick-reference summary in case of emergency.',
      '',
      'PRIVACY-FIRST RULES (mandatory):',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- Member ID: return ONLY the last 4 digits as a string. NEVER',
      '  return the full member ID even if you can read it. If the card',
      '  shows a 9-digit ID like "U12345678", return "5678". This is',
      '  for personal-record convenience only; full ID stays out of the',
      '  app for security.',
      '- Group number: similar treatment — last 4 digits only when it',
      '  looks like a sensitive identifier; full string only when it\'s',
      '  a short non-sensitive group code (≤ 6 chars total).',
      '',
      'EXTRACTION RULES:',
      '- DO NOT invent values. If a field is not visible or unclear,',
      '  set it to null.',
      '- Insurer: the issuing company (e.g., "CIGNA International",',
      '  "BCBS Federal", "Sony Bank 健保", "国民健康保険"). Strip',
      '  promotional taglines, keep the legal entity name.',
      '- Plan name: the product/plan tier if visible on the card',
      '  (e.g., "Open Access Plus", "PPO Federal", "選択 KENPO").',
      '- Network type: classify into one of: "PPO", "HMO", "EPO",',
      '  "POS", "HDHP", "FEHB", "TRICARE", "Medicare", "Medicaid",',
      '  "international", "NHI" (国民健康保険), "SHI" (社会保険), or',
      '  "other". Best guess from visible text.',
      '- Coverage type: "medical", "dental", "vision", "prescription",',
      '  or "combined". Most cards are "medical" or "combined".',
      '- Dates: convert to YYYY-MM-DD. Handle 和暦 (令和/平成) →',
      '  Western year first.',
      '- Phone numbers: keep formatting as printed; preserve country',
      '  codes when present.',
      '- Pharmacy fields (BIN, PCN, Rx Group): only when explicitly',
      '  shown on the card.',
      '',
      '- Coverage type: classify ACCURATELY. A standalone dental plan card',
      '  should be "dental", not "medical". A vision-only card is',
      '  "vision". Most major-medical cards that include prescription',
      '  are "combined" (medical + Rx).',
      '',
      'OUTPUT SHAPE:',
      '{',
      '  // ─── Plan identity',
      '  "insurer": "string"|null,           // issuing company (e.g., "CIGNA International", "BCBS Federal", "Delta Dental", "VSP")',
      '  "plan_name": "string"|null,         // product/plan tier',
      '  "network_type": "PPO"|"HMO"|"EPO"|"POS"|"HDHP"|"FEHB"|"TRICARE"|"Medicare"|"Medicaid"|"international"|"NHI"|"SHI"|"other"|null,',
      '  "coverage_type": "medical"|"dental"|"vision"|"prescription"|"combined"|null,',
      '  "effective_date": "YYYY-MM-DD"|null,',
      '  "expiry_date": "YYYY-MM-DD"|null,',
      '  "issuing_country": "string"|null,',
      '  "coverage_areas": "string"|null,    // territories/regions explicitly listed on card (e.g., "Worldwide excluding USA", "Japan only")',
      '  // ─── Member',
      '  "member_id_last4": "string"|null,   // ONLY last 4 digits',
      '  "member_name": "string"|null,',
      '  "group_number": "string"|null,      // sensitive identifiers truncated to last 4',
      '  // ─── Pharmacy',
      '  "bin": "string"|null,',
      '  "pcn": "string"|null,',
      '  "rx_group": "string"|null,',
      '  // ─── PCP (when printed on card)',
      '  "pcp_name": "string"|null,',
      '  "pcp_phone": "string"|null,',
      '  // ─── Phone contact (capture every distinct number printed)',
      '  "customer_service_phone": "string"|null,',
      '  "member_services_phone": "string"|null,',
      '  "claims_phone": "string"|null,      // claims inquiries / submission',
      '  "pharmacy_help_phone": "string"|null,',
      '  "provider_services_phone": "string"|null,  // for providers to verify benefits',
      '  "emergency_phone": "string"|null,   // 24/7 emergency or pre-cert line',
      '  "nurse_line_phone": "string"|null,  // nurse advice / 24/7 health line if shown',
      '  "mental_health_phone": "string"|null, // EAP / behavioral health line if shown',
      '  // ─── Online / claims submission',
      '  "claims_website": "string"|null,    // URL for claims submission',
      '  "claims_address": "string"|null,    // mailing address for paper claims',
      '  "member_portal": "string"|null,     // member login URL',
      '  "mobile_app": "string"|null,        // app name (e.g., "myCigna", "BCBS Federal App")',
      '  "email": "string"|null,             // member-facing email contact',
      '  // ─── Benefits structure (back of card / summary panel)',
      '  //   Many cards print key benefit numbers — capture them as',
      '  //   structured fields so the user gets a benefits dashboard.',
      '  //   When the card shows ranges or "individual / family" pairs,',
      '  //   split into the two fields. Currency defaults to USD for US',
      '  //   plans; JPY for Japanese SHI/NHI; the issuing country/card',
      '  //   layout should make this obvious.',
      '  "benefits": {',
      '    "referral_required": true|false|null,    // PCP referral needed for specialists?',
      '    "deductible_individual": number|null,    // numeric — strip currency symbol',
      '    "deductible_family": number|null,',
      '    "oop_max_individual": number|null,       // out-of-pocket maximum',
      '    "oop_max_family": number|null,',
      '    "currency": "USD"|"JPY"|"EUR"|"GBP"|"CAD"|"AUD"|"CHF"|null,',
      '    "copay_pcp": "string"|null,              // PCP / primary visit ("$25" or "Ded/80%" or "100%")',
      '    "copay_specialist": "string"|null,',
      '    "copay_urgent_care": "string"|null,',
      '    "copay_er": "string"|null,               // emergency room',
      '    "copay_hospital": "string"|null,         // inpatient hospital',
      '    "rx_coverage": "string"|null,            // free-form Rx terms (e.g., "Not covered US INN/OON; International 80%")',
      '    "benefits_notes": "string"|null          // anything else benefits-related not captured above',
      '  },',
      '  // ─── Free-form catch-all for anything else worth keeping',
      '  "notes_suggestion": "string"|null',
      '}',
      '',
      'Return JSON only.',
    ].join('\n');
  }

  async function callClaudeVisionForInsuranceCard(file, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('File too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). Limit ' + (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error('Unsupported file type: ' + (file.type || file.name));
    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'medical_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 1500,
      temperature: opts.temperature == null ? 0.1 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildInsuranceCardExtractionPrompt() }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'medical_vision');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // STRUCTURED FINANCIAL DOC EXTRACTION (vision · v0.60)
  // ====================================================================
  //
  // callClaudeVisionForStructuredDoc(file, kind, options)
  //   file: PNG/JPG/WEBP/GIF/PDF
  //   kind: 'property_tax_jp' | 'w2_us' | 'gensen_choshu_jp' |
  //         'pension_statement_jp' | 'ssa_statement'
  //
  // One vision endpoint covering the four module-side gaps left after
  // v0.59: property tax notice (固定資産税通知書), US W-2, Japanese
  // 源泉徴収票, Japanese 年金定期便, US SSA earnings/benefits statement.
  // Each kind has a distinct prompt + output schema; the API plumbing
  // (file → base64 → Claude → parse JSON → record cost) is shared.
  //
  // Privacy: each prompt explicitly truncates account/SSN-style numbers
  // to last 4. Wareki dates (令和/平成/昭和) get converted to ISO before
  // returning. Numeric values come back as numbers, not strings.
  //
  // Consent feature: 'document_vision' (same as the doc-vault flow —
  // both extract structured metadata from a financial / official doc).

  function buildStructuredDocPrompt(kind) {
    const PREAMBLE = [
      'You are a structured-data extraction assistant. The user has',
      'uploaded a financial or government document (photo or scan).',
      'Extract the requested fields into a single JSON object.',
      '',
      'CRITICAL RULES:',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- Numeric values: return as NUMBERS, not strings. No commas.',
      '- Dates: ISO 8601 (YYYY-MM-DD). Convert 和暦 to Western year:',
      '  令和N → 2018+N, 平成N → 1988+N, 昭和N → 1925+N.',
      '- Account / reference / SSN-like numbers: return ONLY the LAST 4',
      '  digits/chars for privacy. Never the full number.',
      '- If a field is not visible / not applicable, set it to null.',
      '  DO NOT invent values.',
      '- Currency: ISO 4217 (USD / JPY / EUR / GBP / CAD / AUD / CHF).',
      '',
    ];
    const SHAPES = {
      property_tax_jp: [
        'DOCUMENT TYPE: Japanese 固定資産税通知書 (property tax notice).',
        'OUTPUT SHAPE:',
        '{',
        '  "tax_year":               number | null,    // Western year the tax covers',
        '  "municipality":           string | null,    // 市区町村 issuing the notice',
        '  "property_address":       string | null,    // 所在地 as printed',
        '  "lot_or_house_no":        string | null,    // 地番 / 家屋番号',
        '  "land_assessed_jpy":      number | null,    // 土地 評価額',
        '  "building_assessed_jpy":  number | null,    // 家屋 評価額',
        '  "total_assessed_jpy":     number | null,    // 課税標準額 / 合計評価額',
        '  "annual_tax_jpy":         number | null,    // 固定資産税 年税額',
        '  "city_planning_tax_jpy":  number | null,    // 都市計画税 年税額 (when shown)',
        '  "due_dates": [            // 4 quarterly installment dates when listed',
        '    "YYYY-MM-DD"',
        '  ],',
        '  "owner_name":             string | null,    // 納税義務者 as printed',
        '  "notes":                  string | null     // anything else worth capturing',
        '}',
      ],
      w2_us: [
        'DOCUMENT TYPE: US IRS Form W-2 (Wage and Tax Statement).',
        'OUTPUT SHAPE:',
        '{',
        '  "tax_year":                  number | null,',
        '  "employer_name":             string | null,    // box c',
        '  "employer_ein_last4":        string | null,    // last 4 only of box b',
        '  "employee_name":             string | null,    // box e',
        '  "wages_box1":                number | null,    // box 1 wages, tips, other comp',
        '  "federal_tax_withheld_box2": number | null,',
        '  "ss_wages_box3":             number | null,',
        '  "ss_tax_withheld_box4":      number | null,',
        '  "medicare_wages_box5":       number | null,',
        '  "medicare_tax_withheld_box6": number | null,',
        '  "state":                     string | null,    // box 15 state code',
        '  "state_wages_box16":         number | null,',
        '  "state_tax_withheld_box17":  number | null,',
        '  "retirement_plan_box13":     true | false | null,  // checkbox',
        '  "notes":                     string | null     // box 12 codes (D, DD, etc.) summarized',
        '}',
      ],
      gensen_choshu_jp: [
        'DOCUMENT TYPE: Japanese 給与所得の源泉徴収票 (year-end wage statement).',
        'OUTPUT SHAPE:',
        '{',
        '  "tax_year":                       number | null,',
        '  "employer_name":                  string | null,    // 支払者',
        '  "employer_address":               string | null,',
        '  "employee_name":                  string | null,    // 受給者氏名',
        '  "gross_payment_jpy":              number | null,    // 支払金額',
        '  "employment_income_deduction_jpy": number | null,   // 給与所得控除後の金額',
        '  "deductions_total_jpy":           number | null,    // 所得控除の額の合計額',
        '  "income_tax_withheld_jpy":        number | null,    // 源泉徴収税額',
        '  "social_insurance_jpy":           number | null,    // 社会保険料等の金額',
        '  "spouse_deduction_jpy":           number | null,    // 配偶者控除',
        '  "dependents":                     number | null,    // 控除対象扶養親族の数',
        '  "year_end_adjusted":              true | false | null,  // 年末調整の有無',
        '  "notes":                          string | null',
        '}',
      ],
      pension_statement_jp: [
        'DOCUMENT TYPE: Japanese 年金定期便 (annual pension statement from 日本年金機構).',
        'OUTPUT SHAPE:',
        '{',
        '  "issued_date":                    "YYYY-MM-DD" | null,',
        '  "person_name":                    string | null,',
        '  "basic_pension_number_last4":     string | null,    // last 4 only',
        '  "total_paid_months":              number | null,    // 加入期間 月数 (合計)',
        '  "kokumin_paid_months":            number | null,    // 国民年金',
        '  "kosei_paid_months":              number | null,    // 厚生年金',
        '  "kyosai_paid_months":             number | null,    // 共済年金 (when shown)',
        '  "estimated_annual_pension_jpy":   number | null,    // 老齢年金見込額 (年額)',
        '  "as_of_date":                     "YYYY-MM-DD" | null,  // 「現在」の基準日',
        '  "lifetime_contributions_jpy":     number | null,    // 保険料納付額 (累計)',
        '  "notes":                          string | null     // 標準報酬月額, gaps, anything notable',
        '}',
      ],
      ssa_statement: [
        'DOCUMENT TYPE: US Social Security Administration statement (paper or "my Social Security" PDF).',
        'OUTPUT SHAPE:',
        '{',
        '  "issued_date":                  "YYYY-MM-DD" | null,',
        '  "person_name":                  string | null,',
        '  "ssn_last4":                    string | null,    // last 4 only',
        '  "as_of_year":                   number | null,    // earnings record through this year',
        '  "credits_earned":               number | null,    // total work credits',
        '  "estimated_monthly_at_62_usd":  number | null,',
        '  "estimated_monthly_at_fra_usd": number | null,    // full retirement age',
        '  "estimated_monthly_at_70_usd":  number | null,',
        '  "fra_age":                      string | null,    // e.g. "67" or "66 and 6 months"',
        '  "disability_monthly_usd":       number | null,    // SSDI estimate when shown',
        '  "survivors_monthly_usd":        number | null,    // surviving-spouse benefit',
        '  "medicare_eligible_date":       "YYYY-MM-DD" | null,',
        '  "notes":                        string | null     // earnings-record gaps, WEP/GPO mentions',
        '}',
      ],
    };
    const shape = SHAPES[kind];
    if (!shape) throw new Error('Unsupported structured doc kind: ' + kind);
    return PREAMBLE.concat(shape).concat(['', 'Return JSON only.']).join('\n');
  }

  async function callClaudeVisionForStructuredDoc(file, kind, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    if (!file) throw new Error('No file provided.');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error('File too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB). Limit ' + (MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
    }
    const cls = classifyFile(file);
    if (!cls) throw new Error('Unsupported file type: ' + (file.type || file.name));
    const opts = options || {};
    const useModel = opts.model || getModel();
    const estimated = estimateCost(file);
    await checkConsent(opts.feature || 'document_vision', {
      fileName: file.name, fileSize: file.size, file,
      estimatedCostUsd: estimated ? estimated.approxUsd : null,
    });
    enforceDailyLimit(estimated ? estimated.approxUsd : 0);

    const { mediaType, data } = await fileToBase64(file);
    const sourceBlock = cls === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data } };

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 1536,
      temperature: opts.temperature == null ? 0.1 : opts.temperature,
      messages: [{
        role: 'user',
        content: [sourceBlock, { type: 'text', text: buildStructuredDocPrompt(kind) }],
      }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'document_vision');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // ASSET ENRICHMENT (institution-knowledge, no PII)
  // ====================================================================
  //
  // enrichAssetAccountWithAi(account, options) — chained after asset
  // statement extraction by default (with an opt-out). Sends ONLY the
  // institution name + country + currency + account type. Asks the
  // model for canonical institution metadata: HQ address, support
  // phone, parent corp, SWIFT/routing, key reminders for the wrapper
  // type. Returns a string suitable for appending to notes.
  //
  // What is NOT sent: account number (full or last4), balance, basis,
  // beneficiary, beneficiary, the user's notes, or the holding's name.

  function buildAssetEnrichmentInput(account) {
    if (!account) return {};
    return {
      institution: account.institution || null,
      country: account.country || null,
      currency: account.currency || null,
      tax_wrapper: account.tax_wrapper || null,
    };
  }

  // ====================================================================
  // PROVIDER ENRICHMENT (medical / dental clinic info, no PHI)
  // ====================================================================
  //
  // callClaudeForProviderEnrichment(provider, options)
  //   provider: { name_en?, name_jp?, type?, address?, phone? }
  //
  // Asks Claude to fill in missing public info for a healthcare provider
  // — website, phone, hours, full address, missing-language name — from
  // its own training knowledge. NO PHI sent: only the clinic identity
  // (name, type, country/region) is included in the prompt. Useful for
  // populating provider records after a sparse invoice or exam import.
  //
  // Uses `asset_enrichment` consent — same data flow (institution name
  // out, public reference info in, no patient data).
  async function callClaudeForProviderEnrichment(provider, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    const p = provider || {};
    if (!p.name_en && !p.name_jp) {
      return { extracted: null, cost_usd: 0 };
    }
    const opts = options || {};
    const useModel = opts.model || getModel();
    await checkConsent(opts.feature || 'asset_enrichment', {
      institution: p.name_en || p.name_jp,
      country: p.country || (p.name_jp ? 'JP' : null),
      estimatedCostUsd: 0.008,
    });

    const prompt = [
      'You are a public-reference assistant. The user gives you ONLY a',
      'healthcare provider\'s public-facing identity (clinic name, type,',
      'rough location) and you fill in publicly verifiable details from',
      'your training data.',
      '',
      'CRITICAL RULES:',
      '- Output ONLY a JSON object. No markdown, no commentary.',
      '- DO NOT invent values. When unsure, set the field to null.',
      '- Only return facts that would be on the clinic\'s public website,',
      '  Google Business listing, or directory: address, phone, website',
      '  URL, typical hours, specialties offered.',
      '- DO NOT return private clinical info, patient reviews, doctor',
      '  personal details, or anything sensitive.',
      '- For Japanese clinics: when only one language name was provided,',
      '  try to provide the other (e.g., Romaji ↔ Japanese) when it\'s a',
      '  well-known clinic; null otherwise.',
      '- For website: full URL with https://. Confirm the clinic actually',
      '  has that domain — never guess at "[clinicname].com".',
      '',
      'PROVIDER (input):',
      JSON.stringify({
        name_en: p.name_en || null,
        name_jp: p.name_jp || null,
        type: p.type || null,
        country: p.country || (p.name_jp ? 'JP' : null),
        existing_address: p.address || null,
        existing_phone: p.phone || null,
      }, null, 2),
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "name_en": "string"|null,        // English/Romanized name (only when missing from input)',
      '  "name_jp": "string"|null,        // Japanese name (only when missing from input)',
      '  "address": "string"|null,        // full street address',
      '  "phone": "string"|null,          // main phone number',
      '  "website": "string"|null,        // full URL with https://',
      '  "hours": "string"|null,          // free-form hours summary',
      '  "specialties": "string"|null,    // brief comma-separated list',
      '  "notes": "string"|null,          // any other publicly-known useful detail',
      '  "confidence": "high"|"medium"|"low"|"unknown" // your overall confidence in this enrichment',
      '}',
      '',
      'When you don\'t recognize the clinic, return all-null fields and',
      'confidence: "unknown". DO NOT GUESS.',
      'Return JSON only.',
    ].join('\n');

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature == null ? 0.1 : opts.temperature,
      messages: [{ role: 'user', content: prompt }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + await res.text());
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'asset_enrichment');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('');
    const parsed = parseJsonFromResponse(text);
    return {
      extracted: parsed,
      raw: text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  async function enrichAssetAccountWithAi(account, options) {
    if (!hasKey()) throw new Error('No Claude API key set.');
    const summary = buildAssetEnrichmentInput(account);
    if (!summary.institution) return { text: '', cost_usd: 0 };

    const opts = options || {};
    const useModel = opts.model || getModel();
    await checkConsent(opts.feature || 'asset_enrichment', {
      institution: summary.institution,
      country: summary.country,
      estimatedCostUsd: 0.005,
    });

    const prompt = [
      'You are a reference assistant. The user gave you ONLY the public',
      'metadata of a financial account; no PII. Return a SHORT plain-text',
      'paragraph (under 80 words) appropriate to append to the account notes.',
      '',
      'Include where applicable:',
      '- Institution full legal name + parent company',
      '- HQ city / country',
      '- Customer support phone (international preferred for expat use)',
      '- One reminder relevant to the tax wrapper (e.g., "RMD age 73 for',
      '  Traditional IRA"; "5-year rule for Roth"; "Series I bonds → check',
      '  TreasuryDirect for current rate every May/Nov")',
      '',
      'Do NOT make up phone numbers or addresses you are not confident in.',
      'If unsure, omit. Plain text only — no markdown, no headings.',
      '',
      'Account metadata:',
      JSON.stringify(summary),
    ].join('\n');

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 400,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    };

    enforceDailyLimit(0.005);

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('Claude API ' + res.status + ': ' + err);
    }
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'asset_enrichment');
    const text = (json.content || []).map((c) => c.type === 'text' ? c.text : '').join('').trim();
    return {
      text,
      usage: json.usage,
      model: json.model,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // ====================================================================
  // AI ENRICH (institution-knowledge lookup, user-initiated)
  // ====================================================================
  //
  // enrichAccountWithAi(accountSummary, options) sends ONLY
  // institution-level metadata (institution_name, country, currency,
  // account_type) to Claude and asks the model to fill in canonical
  // facts about that institution from its training knowledge — HQ
  // address, English name, SWIFT/BIC, etc.
  //
  // What this DOES NOT send:
  //   - Account number (full or masked)
  //   - Filer names
  //   - Balances / yearly_balances
  //   - Notes (may contain user observations)
  //   - Any other PII
  //
  // The caller is responsible for sanitizing the input before calling.
  // The buildEnrichmentInput() helper below produces a strictly
  // institution-only summary from a full account record.
  // ====================================================================

  function buildEnrichmentInput(account) {
    if (!account) return {};
    return {
      institution_name: account.institution_name || null,
      institution_address: account.institution_address || null,
      country: account.country || null,
      currency: account.currency || null,
      account_type: account.account_type || null,
    };
  }

  function buildEnrichmentPrompt(accountSummary) {
    return [
      'You are an institution-information assistant for a financial',
      'tracker. Given a partial account record, fill in known facts',
      'about the INSTITUTION (the bank or financial firm itself) using',
      'your training knowledge.',
      '',
      'BE GENEROUS WITH WELL-KNOWN INSTITUTIONS:',
      'For publicly-listed banks, regional banks, megabanks, postal',
      'banks, government-affiliated financial firms, and major fintech',
      'companies, the HQ address and other public facts ARE part of',
      'your training data — provide them. The user reviews every',
      'suggestion before it\'s applied; over-cautious "null"s force',
      'them to look up information you already know.',
      '',
      'WHEN TO RETURN null:',
      '- Genuinely obscure institutions (tiny credit unions, unknown',
      '  private firms) where the HQ is not in your training data.',
      '- Ambiguous institution names that could refer to multiple',
      '  unrelated entities.',
      '- Fields that aren\'t applicable (e.g., a bank with no public',
      '  SWIFT/BIC).',
      'Do NOT return null just because you can\'t produce a perfect',
      'street address — a city + prefecture / state level address is',
      'still useful and the user can refine it.',
      '',
      'OTHER RULES:',
      '- For Japanese institutions, populate BOTH the kanji form',
      '  (institution_name_jp) and the romanized English name',
      '  (institution_name_en).',
      '- For institution_address: ALWAYS provide the address in',
      '  English / romanized form. This is what goes on the FBAR',
      '  (FinCEN 114), which is a U.S. federal form and requires',
      '  English-language addresses. Format Japanese addresses in',
      '  Western order: "<building/number> <street/area>, <city>-shi,',
      '  <prefecture> <postal-code>, Japan".',
      '- For institution_address_jp: ALSO provide the Japanese form',
      '  with 〒postal code if the institution is Japanese. Optional',
      '  for non-Japanese institutions.',
      '- Respond with ONLY a JSON object — no markdown, no commentary.',
      '',
      'Input account (institution-only summary):',
      JSON.stringify(accountSummary, null, 2),
      '',
      'OUTPUT SHAPE:',
      '{',
      '  "institution_name_en": string|null,        // canonical English / romanized name',
      '  "institution_name_jp": string|null,        // Japanese form (kanji or katakana) if applicable',
      '  "institution_address": string|null,        // English / romanized HQ address (FBAR-required)',
      '  "institution_address_jp": string|null,     // Japanese form of HQ address (optional, for reference)',
      '  "institution_swift_bic": string|null,      // SWIFT/BIC code, if commonly known',
      '  "country": string|null,                    // ISO 3166-1 alpha-2',
      '  "currency_suggestion": string|null,        // ISO 4217 of typical deposit currency',
      '  "account_type_suggestion": "bank"|"securities"|"other"|null,',
      '  "notes": string|null,                       // 1-2 sentence summary of the institution',
      '  "confidence": "high"|"medium"|"low"',
      '}',
      '',
      'WORKED EXAMPLES (illustrative — these institutions ARE in your',
      'training data, so populate the address rather than returning null):',
      '',
      '- "秋田銀行" / "Akita Bank":',
      '  institution_name_en: "Akita Bank", institution_name_jp: "秋田銀行",',
      '  institution_address: "3-2-1 Sanno, Akita-shi, Akita 010-8655, Japan",',
      '  institution_address_jp: "〒010-8655 秋田県秋田市山王三丁目2番1号",',
      '  country: "JP", currency_suggestion: "JPY",',
      '  account_type_suggestion: "bank",',
      '  notes: "Japanese regional bank headquartered in Akita Prefecture,',
      '  serving the Tohoku region.", confidence: "high".',
      '',
      '- "ゆうちょ銀行" / "Japan Post Bank":',
      '  institution_address: "3-2 Kasumigaseki 1-chome, Chiyoda-ku, Tokyo 100-8793, Japan",',
      '  institution_address_jp: "〒100-8793 東京都千代田区霞が関一丁目3番2号",',
      '  country: "JP", currency_suggestion: "JPY".',
      '',
      '- "三菱UFJ銀行" / "MUFG Bank":',
      '  institution_address: "7-1 Marunouchi 2-chome, Chiyoda-ku, Tokyo 100-8388, Japan",',
      '  institution_address_jp: "〒100-8388 東京都千代田区丸の内二丁目7番1号",',
      '  country: "JP", currency_suggestion: "JPY",',
      '  institution_swift_bic: "BOTKJPJT".',
      '',
      '- "Wise" / "Wise Payments Limited":',
      '  institution_address: "56 Shoreditch High Street, London E1 6JJ, UK",',
      '  country: "GB" (UK FCA-regulated), notes mentions Wise US Inc.',
      '  for US-customer accounts.',
      '',
      'Return JSON only.',
    ].join('\n');
  }

  async function enrichAccountWithAi(accountSummary, options) {
    if (!hasKey()) {
      throw new Error('No Claude API key set. Add one in Settings to use AI enrichment.');
    }
    const opts = options || {};
    const useModel = opts.model || getModel();
    await checkConsent(opts.feature || 'fbar_enrichment', {
      institution: accountSummary && (accountSummary.institution || accountSummary.institution_name_en),
      country: accountSummary && accountSummary.country,
      estimatedCostUsd: 0.005,
    });
    enforceDailyLimit(0.005); // small text-only call

    const promptText = buildEnrichmentPrompt(accountSummary);

    const body = {
      model: useModel,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature == null ? 0.2 : opts.temperature,
      messages: [{ role: 'user', content: promptText }],
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errText}`);
    }
    const json = await res.json();
    if (json && json.usage) recordUsage(json.model || useModel, json.usage, opts.feature || 'fbar_enrichment');
    const text = (json.content || [])
      .map(c => c.type === 'text' ? c.text : '')
      .join('');
    return {
      suggestions: parseJsonFromResponse(text),
      raw: text,
      usage: json.usage,
      cost_usd: json.usage ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens) : 0,
    };
  }

  // Rough cost estimate (USD) for the consent modal. Uses the
  // currently-selected model's per-token pricing. Inputs estimated
  // from byte size (we don't have render dimensions until Claude
  // tokenizes the image). Output budget assumed at 3k tokens —
  // typical for a multi-year passbook extraction with the years_covered
  // summary plus a few sample balance_entries per year. Actual cost
  // can be a bit higher (multi-page passbooks) or lower (screenshots).
  function estimateCost(file) {
    if (!file) return null;
    const m = getModelInfo() || findModel(DEFAULT_MODEL);
    if (!m) return null;
    const cls = classifyFile(file);
    const kb = file.size / 1024;
    const inTokensPerKb = cls === 'pdf' ? 2 : 1.5;
    const inTokens = Math.max(800, Math.round(kb * inTokensPerKb));
    const outTokens = 3000;
    const inCostUsd = (inTokens / 1_000_000) * m.input_per_m;
    const outCostUsd = (outTokens / 1_000_000) * m.output_per_m;
    return {
      approxInputTokens: inTokens,
      approxOutputTokens: outTokens,
      approxUsd: inCostUsd + outCostUsd,
    };
  }

  // ====================================================================
  // API KEY HEALTH CHECK
  // ====================================================================
  //
  // Sends a deliberately tiny request (1 token output) so the user can
  // verify their key is valid + the model is reachable without burning
  // meaningful tokens. Tagged as 'health_check' so it shows up in the
  // per-feature breakdown but doesn't pollute the chat or vision counts.
  async function pingApiKey(options) {
    if (!hasKey()) {
      return { ok: false, error: 'no_key', message: 'No Claude API key configured.' };
    }
    const opts = options || {};
    const useModel = opts.model || getModel();
    const startedAt = performance.now();
    try {
      const body = {
        model: useModel,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'ping' }],
      };
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': getApiKey(),
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (!res.ok) {
        let errText = '';
        try { errText = await res.text(); } catch (_) {}
        let errCode = 'http_' + res.status;
        if (res.status === 401) errCode = 'invalid_key';
        else if (res.status === 403) errCode = 'forbidden';
        else if (res.status === 429) errCode = 'rate_limited';
        else if (res.status >= 500) errCode = 'server_error';
        return {
          ok: false,
          error: errCode,
          status: res.status,
          message: errText.slice(0, 240),
          elapsed_ms: elapsedMs,
        };
      }
      const json = await res.json();
      if (json && json.usage) recordUsage(json.model || useModel, json.usage, 'health_check');
      return {
        ok: true,
        model: json && (json.model || useModel),
        elapsed_ms: elapsedMs,
        cost_usd: json && json.usage
          ? computeCost(json.model || useModel, json.usage.input_tokens, json.usage.output_tokens)
          : 0,
      };
    } catch (err) {
      return {
        ok: false,
        error: 'network',
        message: (err && err.message) || String(err),
        elapsed_ms: Math.round(performance.now() - startedAt),
      };
    }
  }

  window.TB = window.TB || {};
  window.TB.ai = {
    // Core call surface
    callClaude,
    callClaudeWithFbarContext,
    callClaudeVisionForExtraction,
    callClaudeVisionForAssetExtraction,
    callClaudeVisionForDocumentExtraction,
    callClaudeVisionForMedicalExtraction,
    callClaudeVisionForInvoiceExtraction,
    callClaudeVisionForInsuranceCard,
    callClaudeVisionForDentalExtraction,
    callClaudeVisionForStructuredDoc,
    callClaudeForLabDescriptions,
    callClaudeForProviderEnrichment,
    enrichAssetAccountWithAi,
    buildAssetEnrichmentInput,
    enrichAccountWithAi,
    buildEnrichmentInput,
    pingApiKey,
    // Helpers
    estimateCost,
    classifyFile,
    hasKey,
    getModel,
    getModelInfo,
    findModel,
    modelPriceLabel,
    // Catalog + constants
    DEFAULT_MODEL,
    MODEL_CATALOG,
    FEATURE_IDS,
    VISION_FEATURES,
    ACCEPTED_IMAGE_TYPES,
    ACCEPTED_PDF_TYPES,
    MAX_UPLOAD_BYTES,
    // Consent
    checkConsent,
    isVisionFeature,
    isFeatureAllowed,
    getConsentPosture,
    setConsentPosture,
    getConsentOverrides,
    setConsentOverride,
    consentPreview,
    // Usage tracking
    todayKey,
    todayUsage,
    getUsage,
    recordUsage,
    resetTodayUsage,
    computeCost,
    dailyLimitUsd,
    setDailyLimitUsd,
    // Credits
    getCredits,
    addTopup,
    removeTopup,
    activeTopups,
    isTopupActive,
    computeRemainingBalance,
    reconcile,
  };
})();
