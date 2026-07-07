/* Taigan Bridge — modules/assets.js
 *
 * Asset & Portfolio Tracker (v0.4.x — Phase 1)
 *
 * Canonical store for every account the user owns — US, Japan,
 * retirement, taxable, real estate, equity comp. SOFA Roth Planner
 * derives its aggregations from this list (TB.assets.aggregateForSofa)
 * so balances are entered ONCE.
 *
 * Phase 1 (this release):
 *   - Account CRUD with institution / tax-wrapper / country / currency
 *   - Multi-currency display (native + USD aggregate)
 *   - Summary card: total, by-country, by-tax-wrapper
 *   - Group-by-institution / wrapper / country
 *   - Staleness indicators
 *   - SOFA aggregator
 *
 * Phase 2 (deferred — see CHANGELOG):
 *   - Image / PDF upload + Claude vision extraction
 *   - Beneficiary tracking, asset allocation %, lifecycle countdown
 *   - AI note suggestions
 */

(function () {
  'use strict';

  const id = 'assets';

  // ====================================================================
  // i18n — small literals not covered by the shared dictionary
  // (Survivor Binder pop-up-blocked alert + Action Center generator
  // strings). Registered here via TB.i18n.extend() so this module can
  // self-contain its own translation table instead of touching the
  // shared i18n.js dictionary.
  // ====================================================================

  TB.i18n.extend('en', {
    'assets.survivorBinder.popupBlocked':      'Pop-up blocked — allow pop-ups for this site to open the Survivor Binder.',

    'assets.action.beneficiaryMissing.title':  '{{count}} account(s) have no beneficiary',
    'assets.action.beneficiaryMissing.body':   'POD/TOD beneficiaries bypass probate AND surface in your survivor binder. Quick fix — open Assets and click "+ Add" on each row in the Beneficiary Review card.',

    'assets.action.tlhOpportunity.title':      'Tax-loss harvesting: {{amount}} in unrealized losses',
    'assets.action.tlhOpportunity.body':       '{{count}} US position(s) sit below cost basis. Selling before Dec 31 realizes the loss; offsets up to $3,000/yr of ordinary income or unlimited capital gains. Mind the 30-day wash-sale rule.',
  });

  TB.i18n.extend('ja', {
    'assets.survivorBinder.popupBlocked':      'ポップアップがブロックされました — Survivor Binder を開くには、このサイトのポップアップを許可してください。',

    'assets.action.beneficiaryMissing.title':  '受取人未設定の口座が {{count}} 件あります',
    'assets.action.beneficiaryMissing.body':   'POD/TOD 受取人を指定すると検認(プロベート)を回避でき、survivor binder にも反映されます。手早い対応:Assets を開き、Beneficiary Review カードの各行で「+ 追加」をクリック。',

    'assets.action.tlhOpportunity.title':      '損出し(タックスロスハーベスティング):含み損 {{amount}}',
    'assets.action.tlhOpportunity.body':       '取得原価を下回る米国ポジションが {{count}} 件あります。12 月 31 日までに売却すると損失が確定し、最大 $3,000/年の通常所得または無制限のキャピタルゲインと相殺できます。30 日ウォッシュセールルールに注意。',
  });

  // ====================================================================
  // Taxonomies
  // ====================================================================

  // Tax wrapper definitions — keep in sync with assets.wrapper.* i18n.
  // `cat` groups wrappers for the by-wrapper summary card. `basis`
  // means the form should expose a cost-basis field (drives U.S. LTCG
  // and post-住民票 Japan-tax math).
  const WRAPPERS = [
    { id: 'traditional_ira',      country: 'US', cat: 'retirement_pretax', color: 'var(--tb-track-sofa)',     basis: false },
    { id: 'traditional_401k_tsp', country: 'US', cat: 'retirement_pretax', color: 'var(--tb-track-sofa)',     basis: false },
    { id: 'roth_ira',             country: 'US', cat: 'retirement_roth',   color: 'var(--tb-success)',        basis: false },
    { id: 'roth_401k',            country: 'US', cat: 'retirement_roth',   color: 'var(--tb-success)',        basis: false },
    { id: 'taxable_brokerage',    country: 'US', cat: 'taxable',           color: 'var(--tb-track-property)', basis: true  },
    { id: 'hsa',                  country: 'US', cat: 'special',           color: 'var(--tb-track-veteran)',  basis: false },
    { id: 'rsu_unvested',         country: 'US', cat: 'equity_comp',       color: 'var(--tb-warn)',           basis: false },
    { id: 'nso_iso',              country: 'US', cat: 'equity_comp',       color: 'var(--tb-warn)',           basis: false },
    { id: 'deferred_comp',        country: 'US', cat: 'equity_comp',       color: 'var(--tb-warn)',           basis: false },
    { id: 'us_real_estate',       country: 'US', cat: 'realestate',        color: 'var(--tb-accent)',         basis: true  },
    // U.S. banking — bank deposits, NOT securities. Don't feed SOFA's
    // taxable_brokerage/RSU/etc. flow but show in the by-wrapper rollup.
    { id: 'us_checking',          country: 'US', cat: 'banking_us',        color: 'var(--tb-slate)',          basis: false },
    { id: 'us_savings',           country: 'US', cat: 'banking_us',        color: 'var(--tb-slate)',          basis: false },
    { id: 'us_cd',                country: 'US', cat: 'banking_us',        color: 'var(--tb-slate)',          basis: false },
    // U.S. Treasury — federal-only interest income (state-exempt).
    // Savings bonds (I/EE) get tax-deferred treatment until redemption;
    // marketable Treasuries (bills/notes/bonds/TIPS) accrue annually.
    // Both are taxed in Japan post-住民票 as ordinary income, so they
    // sit alongside CDs / savings rather than under taxable_brokerage.
    { id: 'us_savings_bond',      country: 'US', cat: 'treasury_us',       color: 'var(--tb-navy-soft)',      basis: false },
    { id: 'us_treasury',          country: 'US', cat: 'treasury_us',       color: 'var(--tb-navy-soft)',      basis: false },
    { id: 'jp_savings',           country: 'JP', cat: 'banking_jp',        color: 'var(--tb-track-resident)', basis: false },
    { id: 'jp_checking',          country: 'JP', cat: 'banking_jp',        color: 'var(--tb-track-resident)', basis: false },
    { id: 'jp_fixed_deposit',     country: 'JP', cat: 'banking_jp',        color: 'var(--tb-track-resident)', basis: false },
    { id: '529',                  country: 'US', cat: 'savings',           color: 'var(--tb-track-family)',   basis: false },
    { id: 'other',                country: 'OTHER', cat: 'other',          color: 'var(--tb-text-soft)',      basis: false },
  ];

  const WRAPPER_BY_ID = Object.fromEntries(WRAPPERS.map((w) => [w.id, w]));

  // Display order for the by-wrapper rollup. Tax-deferred / Roth / taxable
  // sit at the top; banking-style and "other" trail.
  // ====================================================================
  // Asset allocation taxonomy (Phase 5)
  // ====================================================================
  //
  // Six top-level asset classes — broad enough to be useful, narrow
  // enough that defaults can be inferred from tax_wrapper. Stored on
  // each account as `allocation: { equity_us: 0.85, equity_intl: 0.15 }`
  // (decimals 0-1 summing to ~1.0). Missing classes treated as 0.
  // Auto-normalized on save so rounding doesn't drift sums above 1.

  const ASSET_CLASSES = ['equity_us', 'equity_intl', 'bond', 'cash', 'real_estate', 'alternative'];

  const ASSET_CLASS_COLOR = {
    equity_us:    'var(--tb-track-sofa)',      // navy
    equity_intl:  'var(--tb-track-veteran)',   // forest green
    bond:         'var(--tb-navy-soft)',
    cash:         'var(--tb-slate)',
    real_estate:  'var(--tb-accent)',          // terracotta
    alternative:  'var(--tb-warn)',            // amber
  };

  // Default allocation per wrapper. Values must sum to 1.0 per row.
  // The user can override per-account in the modal; "Use defaults"
  // resets to this table. Conservative bias: retirement = 70/20/10
  // (Bogle-ish), taxable brokerage = 85/15 with no bond default
  // (typical taxable holdings tilt growth-heavy).
  const WRAPPER_DEFAULT_ALLOC = {
    traditional_ira:        { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
    traditional_401k_tsp:   { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
    roth_ira:               { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
    roth_401k:              { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
    taxable_brokerage:      { equity_us: 0.85, equity_intl: 0.15 },
    hsa:                    { cash: 1.00 },
    rsu_unvested:           { equity_us: 1.00 },
    nso_iso:                { equity_us: 1.00 },
    deferred_comp:          { equity_us: 1.00 },
    us_real_estate:         { real_estate: 1.00 },
    us_savings_bond:        { bond: 1.00 },
    us_treasury:            { bond: 1.00 },
    us_checking:            { cash: 1.00 },
    us_savings:             { cash: 1.00 },
    us_cd:                  { cash: 1.00 },
    jp_savings:             { cash: 1.00 },
    jp_checking:            { cash: 1.00 },
    jp_fixed_deposit:       { cash: 1.00 },
    '529':                  { equity_us: 0.85, bond: 0.15 },
    other:                  { cash: 1.00 },
  };

  function defaultAllocFor(wrapperId) {
    const src = WRAPPER_DEFAULT_ALLOC[wrapperId] || WRAPPER_DEFAULT_ALLOC.other;
    const out = {};
    for (const cls of ASSET_CLASSES) out[cls] = src[cls] || 0;
    return out;
  }

  // Normalize an allocation map to sum to 1.0 (or empty if all zero).
  // Tolerates missing classes, NaN, and values out of [0, 1].
  function normalizeAllocation(alloc) {
    const out = {};
    let sum = 0;
    for (const cls of ASSET_CLASSES) {
      const v = (alloc && Number(alloc[cls])) || 0;
      const safe = isFinite(v) && v > 0 ? v : 0;
      out[cls] = safe;
      sum += safe;
    }
    if (sum <= 0) return out;
    for (const cls of ASSET_CLASSES) out[cls] = out[cls] / sum;
    return out;
  }

  // Effective allocation for an account: explicit alloc if set, else
  // default for its wrapper. Always normalized.
  function effectiveAllocation(account) {
    const explicit = account && account.allocation;
    const hasAny = explicit && ASSET_CLASSES.some((c) => Number(explicit[c]) > 0);
    return normalizeAllocation(hasAny ? explicit : defaultAllocFor(account && account.tax_wrapper));
  }

  // Portfolio-level allocation: weighted by USD value of each account.
  // Returns { equity_us: 0.42, equity_intl: 0.18, bond: 0.20, ... }
  // summing to 1.0 (or all-zero if no balances).
  function portfolioAllocation() {
    const totals = {};
    for (const cls of ASSET_CLASSES) totals[cls] = 0;
    let sum = 0;
    for (const a of getActiveAccounts()) {
      const v = toUsd(a.balance_native, a.currency);
      if (!v || !isFinite(v) || v <= 0) continue;
      const alloc = effectiveAllocation(a);
      for (const cls of ASSET_CLASSES) totals[cls] += v * alloc[cls];
      sum += v;
    }
    if (sum <= 0) return totals;
    for (const cls of ASSET_CLASSES) totals[cls] = totals[cls] / sum;
    return totals;
  }

  const WRAPPER_RENDER_ORDER = [
    'traditional_ira', 'traditional_401k_tsp',
    'roth_ira', 'roth_401k',
    'taxable_brokerage', 'hsa',
    'rsu_unvested', 'nso_iso', 'deferred_comp',
    'us_real_estate',
    'us_savings_bond', 'us_treasury',
    'us_checking', 'us_savings', 'us_cd',
    'jp_savings', 'jp_checking', 'jp_fixed_deposit',
    '529', 'other',
  ];

  const CURRENCIES = ['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'KRW', 'CNY', 'HKD', 'SGD'];

  // ====================================================================
  // FX conversion
  // ====================================================================
  //
  // v0.4 uses the hardcoded USDJPY rate from TB.utils.FX_FALLBACK.
  // Other non-USD currencies are treated as 1:1 placeholders until
  // a real FX table / live fetch is wired in (deferred to Phase 2).

  // Resolve a per-USD rate, preferring live Treasury rates when the
  // user has refreshed; falling back to the hardcoded perUsd table.
  function perUsdRate(currency) {
    if (!currency || currency === 'USD') return 1;
    const live = TB.state.get('settings.fx.current_rates') || {};
    if (live[currency] && live[currency] > 0) return live[currency];
    const fallback = (TB.utils.FX_FALLBACK && TB.utils.FX_FALLBACK.perUsd) || {};
    return fallback[currency] || 0;
  }

  function fxRate() { return perUsdRate('JPY') || 152; }

  // Convert `amount` in `currency` to USD using either live Treasury
  // rates (when refreshed) or the hardcoded perUsd table. Unknown
  // currencies fall back to 1:1 (treated as USD) with a console
  // warning so missing rates are visible during dev.
  function toUsd(amount, currency) {
    if (amount == null || !isFinite(amount)) return 0;
    if (!currency || currency === 'USD') return amount;
    const rate = perUsdRate(currency);
    if (rate && rate > 0) return amount / rate;
    if (!toUsd._warned) toUsd._warned = {};
    if (!toUsd._warned[currency]) {
      console.warn('[assets] no FX rate for', currency, '— treating as USD');
      toUsd._warned[currency] = true;
    }
    return amount;
  }

  // Whether the user has live Treasury rates loaded vs. hardcoded
  // fallbacks. Drives the "Live" / "Hardcoded" badge in the UI.
  function fxIsLive() {
    const r = TB.state.get('settings.fx.current_rates') || {};
    return Object.keys(r).length > 0;
  }

  function fmtNative(amount, currency) {
    if (amount == null || !isFinite(amount)) return '—';
    if (currency === 'JPY') return TB.utils.formatJPY(amount);
    if (currency === 'USD' || !currency) return TB.utils.formatUSD(amount);
    // Generic fallback — symbol + locale number.
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount) + ' ' + currency;
  }

  // ====================================================================
  // State accessors
  // ====================================================================

  function getAccounts()       { return TB.state.get('assets.accounts') || []; }
  function getActiveAccounts() { return getAccounts().filter((a) => a.active !== false); }
  function setAccounts(list)   { TB.state.set('assets.accounts', list); }
  function findById(aid)       { return getAccounts().find((a) => a.id === aid) || null; }

  function upsertAccount(record) {
    const list = getAccounts();
    const i = list.findIndex((a) => a.id === record.id);
    if (i >= 0) list[i] = record;
    else list.push(record);
    setAccounts(list);
  }

  function deleteAccount(aid) {
    setAccounts(getAccounts().filter((a) => a.id !== aid));
  }

  function setActive(aid, active) {
    const list = getAccounts();
    const acct = list.find((a) => a.id === aid);
    if (!acct) return;
    acct.active = active;
    setAccounts(list);
  }

  // ====================================================================
  // Aggregations
  // ====================================================================

  // SOFA Roth Planner consumes this rollup. Wrappers outside the
  // SOFA-relevant set (jp_*, 529, other) intentionally do not feed
  // these fields — they show up in this module's own summary instead.
  function aggregateForSofa() {
    const out = {
      traditional_ira_usd:          0,
      traditional_401k_tsp_usd:     0,
      roth_ira_usd:                 0,
      roth_401k_usd:                0,
      taxable_brokerage_value_usd:  0,
      taxable_brokerage_basis_usd:  0,
      rsu_unvested_value_usd:       0,
      nso_iso_unrealized_value_usd: 0,
      deferred_comp_usd:            0,
      us_real_estate_value_usd:     0,
      us_real_estate_basis_usd:     0,
      hsa_balance_usd:              0,
    };
    for (const a of getActiveAccounts()) {
      if (a.include_in_sofa === false) continue;
      const val = toUsd(a.balance_native, a.currency);
      const basis = a.basis_native != null ? toUsd(a.basis_native, a.currency) : 0;
      switch (a.tax_wrapper) {
        case 'traditional_ira':       out.traditional_ira_usd          += val; break;
        case 'traditional_401k_tsp':  out.traditional_401k_tsp_usd     += val; break;
        case 'roth_ira':              out.roth_ira_usd                 += val; break;
        case 'roth_401k':             out.roth_401k_usd                += val; break;
        case 'taxable_brokerage':
          out.taxable_brokerage_value_usd += val;
          out.taxable_brokerage_basis_usd += basis;
          break;
        case 'rsu_unvested':          out.rsu_unvested_value_usd       += val; break;
        case 'nso_iso':               out.nso_iso_unrealized_value_usd += val; break;
        case 'deferred_comp':         out.deferred_comp_usd            += val; break;
        case 'us_real_estate':
          out.us_real_estate_value_usd += val;
          out.us_real_estate_basis_usd += basis;
          break;
        case 'hsa':                   out.hsa_balance_usd              += val; break;
      }
    }
    return out;
  }

  function totalUsd() {
    return getActiveAccounts().reduce((s, a) => s + toUsd(a.balance_native, a.currency), 0);
  }

  // ====================================================================
  // FBAR ↔ Assets integration (Phase 4 audit follow-up)
  // ====================================================================
  //
  // FBAR accounts the user has uploaded are surfaced here as Assets
  // records so they flow through the projection engine + summary
  // rollup + Survivor Binder. We filter to ONLY accounts the user is
  // a filer on — children-only or spouse-only accounts are excluded.
  // Joint accounts (where the user is one of multiple filers) ARE
  // included, since the user has signature authority and beneficial
  // ownership.
  //
  // Sync strategy:
  //   • Already-linked accounts (have fbar_account_id) are silently
  //     refreshed on every Assets render — institution, currency,
  //     last4, balance, updated_at pulled from FBAR's source-of-truth.
  //   • Unlinked FBAR accounts surface as a banner ("N FBAR accounts
  //     not in your portfolio — Import"). User clicks Import to create
  //     Assets records with sensible wrapper defaults.
  //   • User-only fields (tax_wrapper, allocation, beneficiary,
  //     include_in_sofa, basis_native, close_date, transfer_to,
  //     account name) are NEVER overwritten by sync.

  function getSelfFiler() {
    const filers = TB.state.get('fbar.filers') || [];
    return filers.find((f) => f && f.relationship === 'self') || null;
  }

  function getFbarAccountsForUser() {
    const self = getSelfFiler();
    if (!self) return [];
    const all = TB.state.get('fbar.accounts') || [];
    return all.filter((a) =>
      Array.isArray(a.filer_ids) && a.filer_ids.indexOf(self.id) !== -1
    );
  }

  function getLatestFbarBalance(accountId) {
    const all = (TB.state.get('fbar.yearly_balances') || []).filter((b) => b.account_id === accountId);
    if (!all.length) return null;
    all.sort((a, b) => Number(b.year) - Number(a.year));
    return all[0];
  }

  // FBAR account_type ('bank' | 'securities' | 'other') + country →
  // the most-likely Assets tax_wrapper. User can override after import.
  function fbarToWrapper(fbarAcct) {
    const country = (fbarAcct.country || 'JP').toUpperCase();
    if (fbarAcct.account_type === 'bank') {
      if (country === 'JP') return 'jp_savings';
      if (country === 'US') return 'us_savings';
      return 'other';
    }
    if (fbarAcct.account_type === 'securities') {
      if (country === 'US') return 'taxable_brokerage';
      return 'other';   // JP-domiciled securities = PFIC, label as other
    }
    return 'other';
  }

  // Build the Assets-side payload from an FBAR account + its latest
  // yearly balance. Returns only the FBAR-sourced fields (institution,
  // country, currency, last4, balance, updated_at) plus a default
  // wrapper. User-only fields are intentionally absent.
  function fbarToAssetSync(fbarAcct, latestBalance) {
    const last4 = fbarAcct.account_number_masked
      ? String(fbarAcct.account_number_masked).replace(/[^0-9]/g, '').slice(-4) || null
      : null;
    return {
      institution: fbarAcct.institution_name || '',
      country: (fbarAcct.country || 'JP').toUpperCase(),
      currency: fbarAcct.currency || 'JPY',
      account_number_last4: last4,
      balance_native: latestBalance && isFinite(latestBalance.max_balance_native)
        ? latestBalance.max_balance_native : null,
      updated_at: latestBalance && latestBalance.max_balance_date
        ? latestBalance.max_balance_date
        : TB.utils.todayIso(),
    };
  }

  // Refresh FBAR-sourced fields on every Assets account that has an
  // fbar_account_id. Returns the number of accounts updated. Quiet —
  // no toast, no UI change unless balances actually moved.
  function refreshLinkedFromFbar() {
    const accts = TB.state.get('assets.accounts') || [];
    const fbarById = {};
    for (const fa of getFbarAccountsForUser()) fbarById[fa.id] = fa;
    let updated = 0;
    for (const a of accts) {
      if (!a.fbar_account_id) continue;
      const fa = fbarById[a.fbar_account_id];
      if (!fa) continue;
      const latest = getLatestFbarBalance(fa.id);
      const sync = fbarToAssetSync(fa, latest);
      let changed = false;
      for (const k of Object.keys(sync)) {
        if (a[k] !== sync[k]) { a[k] = sync[k]; changed = true; }
      }
      if (changed) updated++;
    }
    if (updated > 0) TB.state.set('assets.accounts', accts);
    return updated;
  }

  // Returns FBAR accounts that don't yet have a corresponding Assets
  // record. Used to drive the "import" banner.
  function unlinkedFbarAccounts() {
    const linked = new Set();
    for (const a of (TB.state.get('assets.accounts') || [])) {
      if (a.fbar_account_id) linked.add(a.fbar_account_id);
    }
    return getFbarAccountsForUser().filter((fa) => !linked.has(fa.id));
  }

  // Bulk import unlinked FBAR accounts into Assets. Each new record
  // gets a sensible wrapper default + allocation default; user can
  // edit afterward. Returns the count created.
  function importFromFbar() {
    const unlinked = unlinkedFbarAccounts();
    if (unlinked.length === 0) return 0;
    const accts = TB.state.get('assets.accounts') || [];
    for (const fa of unlinked) {
      const latest = getLatestFbarBalance(fa.id);
      const sync = fbarToAssetSync(fa, latest);
      const wrapper = fbarToWrapper(fa);
      const allocation = defaultAllocFor(wrapper);
      const newAcct = Object.assign({
        id: TB.utils.uuid(),
        fbar_account_id: fa.id,
        name: sync.institution, // best default — user can rename
        tax_wrapper: wrapper,
        basis_native: null,
        beneficiary: null,
        notes: 'Imported from FBAR ' + TB.utils.todayIso() + '. ' + (fa.notes || ''),
        active: true,
        include_in_sofa: true,
        close_date: null,
        transfer_to: null,
        allocation,
      }, sync);
      accts.push(newAcct);
    }
    TB.state.set('assets.accounts', accts);
    return unlinked.length;
  }

  // Per-wrapper drill-down. Returns active accounts in the wrapper,
  // sorted by USD balance descending. Used by SOFA Accounts tab to
  // show "Traditional IRA $511K" → which institutions contribute.
  // Includes balance_usd (computed) so the caller doesn't need toUsd.
  function getAccountsForWrapper(wrapperId) {
    if (!wrapperId) return [];
    const out = [];
    for (const a of getActiveAccounts()) {
      if (a.tax_wrapper !== wrapperId) continue;
      if (a.include_in_sofa === false) continue;
      out.push(Object.assign({}, a, {
        balance_usd: toUsd(a.balance_native, a.currency),
      }));
    }
    out.sort((x, y) => (y.balance_usd || 0) - (x.balance_usd || 0));
    return out;
  }

  function totalUsdByCountry() {
    const out = { US: 0, JP: 0, OTHER: 0 };
    for (const a of getActiveAccounts()) {
      const c = a.country || 'OTHER';
      out[c] = (out[c] || 0) + toUsd(a.balance_native, a.currency);
    }
    return out;
  }

  function totalUsdByWrapper() {
    const out = {};
    for (const a of getActiveAccounts()) {
      const w = a.tax_wrapper || 'other';
      out[w] = (out[w] || 0) + toUsd(a.balance_native, a.currency);
    }
    return out;
  }

  // ====================================================================
  // Staleness
  // ====================================================================

  // ====================================================================
  // Lifecycle countdown
  // ====================================================================

  // Translate close_date into the right i18n badge key + variables.
  // Returns null when there's no close_date set (caller hides the badge).
  function lifecycleBadge(closeIso) {
    if (!closeIso) return null;
    const close = new Date(closeIso + 'T00:00:00');
    if (isNaN(close.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ms = close - today;
    const days = Math.round(ms / (1000 * 60 * 60 * 24));
    if (days < 0)  return { key: 'assets.lifecycle.past',   vars: { date: closeIso }, severity: 'past' };
    if (days === 0) return { key: 'assets.lifecycle.today',  vars: { date: closeIso }, severity: 'today' };
    if (days <= 14) return { key: 'assets.lifecycle.soon',   vars: { date: closeIso, days }, severity: 'soon' };
    return { key: 'assets.lifecycle.future', vars: { date: closeIso, days }, severity: 'future' };
  }

  function staleness(updatedIso) {
    if (!updatedIso) return { state: 'never', label_key: 'assets.stale.never', vars: null };
    const updated = TB.utils.parseLocalDate(updatedIso);
    if (!updated || isNaN(updated.getTime())) return { state: 'never', label_key: 'assets.stale.never', vars: null };
    const now = new Date();
    const days = Math.floor((now - updated) / (1000 * 60 * 60 * 24));
    if (days <= 0) return { state: 'fresh', label_key: 'assets.stale.fresh', vars: null };
    if (days < 30 * 4) return { state: 'recent', label_key: 'assets.stale.recent', vars: { days } };
    const months = Math.floor(days / 30);
    return { state: 'stale', label_key: 'assets.stale.warn', vars: { months } };
  }

  // ====================================================================
  // Module-level UI state (resets on render — fine for tab-style)
  // ====================================================================

  let host = null;
  let groupBy = 'institution'; // 'institution' | 'wrapper' | 'country'
  let showArchived = false;

  // ====================================================================
  // RENDER
  // ====================================================================

  function render(container) {
    host = container;
    container.innerHTML = '';

    // Auto-refresh FBAR-linked balances on every render (silent) so
    // the user always sees the latest balance from FBAR without
    // having to click a button. Quiet — only updates state if values
    // actually changed.
    refreshLinkedFromFbar();

    container.appendChild(buildHeaderCard());
    // Banner offering to import FBAR accounts the user has uploaded
    // but hasn't yet brought into Assets. Hidden when nothing to import.
    const fbarBanner = buildFbarImportBanner();
    if (fbarBanner) container.appendChild(fbarBanner);
    container.appendChild(buildSummaryCard());
    // Three new review cards (v0.35). Each silently hides itself when
    // there's nothing meaningful to show — keeps the page short for new
    // users while surfacing real review work for established users.
    const benCard = buildBeneficiaryReviewCard();
    if (benCard) container.appendChild(benCard);
    const yoyCard = buildYoYChangeCard();
    if (yoyCard) container.appendChild(yoyCard);
    const tlhCard = buildTaxLossHarvestCard();
    if (tlhCard) container.appendChild(tlhCard);
    container.appendChild(buildToolbar());
    container.appendChild(buildAccountsList());
  }

  // FBAR import banner — displayed at the top of Assets when there
  // are FBAR accounts (in the user's name) not yet represented in
  // Assets. Click "Import" → bulk-creates Assets records linked to
  // those FBAR accounts. Per the user's intent: spouse-only and
  // children-only FBAR accounts are excluded by getFbarAccountsForUser.
  function buildFbarImportBanner() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const unlinked = unlinkedFbarAccounts();
    if (unlinked.length === 0) return null;

    const list = unlinked.slice(0, 5).map((fa) =>
      (fa.institution_name || '(unnamed)') +
      (fa.account_number_masked ? ' (••••' + String(fa.account_number_masked).slice(-4) + ')' : '')
    ).join(', ');
    const moreCount = unlinked.length > 5 ? unlinked.length - 5 : 0;

    return el('div', {
      class: 'tb-card',
      'data-track': 'core',
      style: {
        borderLeft: '4px solid var(--tb-navy)',
        background: 'var(--tb-bg-elev)',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-1)' } },
        '🔗 ' + t('assets.fbar.banner.title', { count: unlinked.length })),
      el('p', { class: 'tb-field-help', style: { margin: '0 0 var(--tb-sp-2)' } },
        t('assets.fbar.banner.help')),
      el('p', { style: { margin: '0 0 var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)', fontFamily: 'var(--tb-font-mono)' } },
        list + (moreCount > 0 ? ' …+' + moreCount + ' ' + t('assets.fbar.banner.more') : '')),
      el('div', { class: 'tb-btn-row', style: { margin: 0 } },
        el('button', {
          class: 'tb-btn',
          type: 'button',
          onclick: () => {
            const n = importFromFbar();
            if (n > 0) {
              alert(t('assets.fbar.banner.imported', { count: n }));
              rerender();
            }
          },
        }, '🔗 ' + t('assets.fbar.banner.import')),
        el('button', {
          class: 'tb-btn tb-btn--ghost',
          type: 'button',
          onclick: () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'fbar' } })),
        }, t('assets.fbar.banner.openFbar')),
      ),
    );
  }

  function rerender() { if (host) render(host); }

  // ----- Header --------------------------------------------------------

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'core' }, t('nav.profile')),
      ),
      el('h1', null, t('assets.title')),
      el('p', { class: 'tb-card-meta', style: { lineHeight: 'var(--tb-lh-body)' } },
        t('assets.subtitle')),
    );
  }

  // ----- Summary -------------------------------------------------------

  function buildSummaryCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const accounts = getActiveAccounts();

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', null, t('assets.summary.total')));

    if (accounts.length === 0) {
      card.appendChild(el('p', { class: 'tb-card-meta' }, t('assets.summary.none')));
      return card;
    }

    const usd = totalUsd();
    const jpy = usd * fxRate();

    // Top row: USD total + JPY equivalent
    const topRow = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--tb-sp-4)', marginBottom: 'var(--tb-sp-4)' },
    },
      stat(t('assets.summary.usd'), TB.utils.formatUSD(usd, { maximumFractionDigits: 0 })),
      stat(t('assets.summary.jpy'), TB.utils.formatJPY(jpy)),
    );
    card.appendChild(topRow);

    // By-country row
    const byCountry = totalUsdByCountry();
    if ((byCountry.US || 0) + (byCountry.JP || 0) + (byCountry.OTHER || 0) > 0) {
      card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-3)', marginBottom: 'var(--tb-sp-2)' } },
        lang === 'ja' ? '国別' : 'By country'));
      const cRow = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-3)' },
      });
      if (byCountry.US)    cRow.appendChild(stat(t('assets.summary.us'),    TB.utils.formatUSD(byCountry.US,    { maximumFractionDigits: 0 })));
      if (byCountry.JP)    cRow.appendChild(stat(t('assets.summary.jp'),    TB.utils.formatUSD(byCountry.JP,    { maximumFractionDigits: 0 })));
      if (byCountry.OTHER) cRow.appendChild(stat(lang === 'ja' ? 'その他' : 'Other', TB.utils.formatUSD(byCountry.OTHER, { maximumFractionDigits: 0 })));
      card.appendChild(cRow);
    }

    // By-wrapper rollup (only wrappers that have non-zero balances)
    const byW = totalUsdByWrapper();
    const wrapperOrder = WRAPPER_RENDER_ORDER.filter((w) => (byW[w] || 0) > 0);
    if (wrapperOrder.length > 0) {
      card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)', marginBottom: 'var(--tb-sp-2)' } },
        t('assets.summary.bywrapper')));
      const wRow = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--tb-sp-2)' },
      });
      for (const wid of wrapperOrder) {
        const wMeta = WRAPPER_BY_ID[wid];
        const pct = usd > 0 ? (byW[wid] / usd) * 100 : 0;
        wRow.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            borderLeft: '3px solid ' + (wMeta ? wMeta.color : 'var(--tb-border)'),
            background: 'var(--tb-bg)',
            borderRadius: 'var(--tb-radius-1)',
            fontSize: 'var(--tb-fs-14)',
          },
        },
          el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
            t('assets.wrapper.' + wid)),
          el('div', { style: { fontWeight: '600', fontFamily: 'var(--tb-font-mono)' } },
            TB.utils.formatUSD(byW[wid], { maximumFractionDigits: 0 })),
          el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
            pct.toFixed(1) + '%'),
        ));
      }
      card.appendChild(wRow);
    }

    // ---- Asset allocation rollup ---------------------------------
    // Horizontal segmented bar showing portfolio-level allocation
    // weighted by USD value. Segments collapse to nothing when their
    // class has 0% (so all-cash portfolios just show one slate bar).
    // Drift vs. target appears below when a target is set.
    const portAlloc = portfolioAllocation();
    const target = TB.state.get('assets.target_allocation') || null;
    const hasAllocData = ASSET_CLASSES.some((c) => portAlloc[c] > 0.001);

    if (hasAllocData) {
      const allocCard = el('div', { style: { marginTop: 'var(--tb-sp-3)' } });
      allocCard.appendChild(el('div', {
        style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', marginBottom: 'var(--tb-sp-1)' },
      }, t('assets.alloc.portfolio.title')));

      // Segmented bar.
      const bar = el('div', {
        style: {
          display: 'flex', height: '14px', borderRadius: 'var(--tb-radius-pill)',
          overflow: 'hidden', border: '1px solid var(--tb-border)',
        },
      });
      for (const cls of ASSET_CLASSES) {
        const pct = portAlloc[cls];
        if (pct < 0.001) continue;
        bar.appendChild(el('div', {
          style: {
            flexBasis: (pct * 100).toFixed(2) + '%',
            background: ASSET_CLASS_COLOR[cls],
          },
          title: t('assets.alloc.' + cls) + ': ' + (pct * 100).toFixed(1) + '%',
        }));
      }
      allocCard.appendChild(bar);

      // Legend with current % and (if target set) drift delta.
      const legend = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 'var(--tb-sp-2)',
          marginTop: 'var(--tb-sp-2)',
          fontSize: 'var(--tb-fs-12)',
        },
      });
      for (const cls of ASSET_CLASSES) {
        const pct = portAlloc[cls];
        if (pct < 0.001 && (!target || (target[cls] || 0) < 0.001)) continue;
        const tgtPct = target ? (target[cls] || 0) : null;
        const delta = (tgtPct != null) ? (pct - tgtPct) : null;
        let driftStr = '';
        let driftColor = 'var(--tb-text-soft)';
        if (delta != null) {
          const absDelta = Math.abs(delta * 100);
          if (absDelta >= 5) driftColor = 'var(--tb-warn)';
          if (absDelta >= 10) driftColor = 'var(--tb-error)';
          driftStr = (delta >= 0 ? '+' : '') + (delta * 100).toFixed(1) + '%';
        }
        legend.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          el('span', { style: {
            width: '10px', height: '10px', borderRadius: '50%',
            background: ASSET_CLASS_COLOR[cls], flexShrink: '0',
          } }),
          el('span', { style: { flex: '1', color: 'var(--tb-text)' } },
            t('assets.alloc.' + cls)),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
            (pct * 100).toFixed(1) + '%'),
          delta != null ? el('span', {
            style: { color: driftColor, fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' },
            title: t('assets.alloc.drift.tip', { target: (tgtPct * 100).toFixed(1) }),
          }, '(' + driftStr + ')') : null,
        ));
      }
      allocCard.appendChild(legend);

      if (target) {
        // Show overall drift score (sum of |actual - target|/2 across all classes).
        let totalDrift = 0;
        for (const cls of ASSET_CLASSES) totalDrift += Math.abs((portAlloc[cls] || 0) - (target[cls] || 0));
        totalDrift = totalDrift / 2; // L1/2 = "% of portfolio in wrong place"
        const driftPct = (totalDrift * 100).toFixed(1);
        const sevColor = totalDrift >= 0.10 ? 'var(--tb-error)'
                       : totalDrift >= 0.05 ? 'var(--tb-warn)' : 'var(--tb-success)';
        allocCard.appendChild(el('div', {
          style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', color: sevColor },
        }, t('assets.alloc.drift.summary', { pct: driftPct })));
      } else {
        // Affordance to set target.
        allocCard.appendChild(el('div', {
          style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
        }, t('assets.alloc.notarget')));
      }

      card.appendChild(allocCard);
    }

    // FX status row — live timestamp + refresh button.
    const fxStatus = el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        gap: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
      },
    });

    const live = fxIsLive();
    const asOf = TB.state.get('settings.fx.current_as_of');
    const fetchedAt = TB.state.get('settings.fx.current_fetched_at');
    const lastErr = TB.state.get('settings.fx.current_fetch_error');

    fxStatus.appendChild(el('span', null,
      '$1 = ¥' + fxRate().toFixed(2) +
      '  ·  ' + (live
        ? t('assets.fx.live', { asOf: asOf || '—' })
        : t('assets.fx.hardcoded'))));

    const refreshBtn = el('button', {
      class: 'tb-btn tb-btn--ghost',
      type: 'button',
      style: { padding: '2px 10px', fontSize: 'var(--tb-fs-12)' },
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = t('assets.fx.refreshing');
        try {
          await TB.utils.refreshCurrentFx();
          rerender();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = t('assets.fx.refresh');
          alert(t('assets.fx.error', { message: (err && err.message) || String(err) }));
        }
      },
    }, t('assets.fx.refresh'));
    fxStatus.appendChild(refreshBtn);

    if (lastErr) {
      fxStatus.appendChild(el('span', { style: { color: 'var(--tb-warn)' } },
        '⚠ ' + lastErr));
    }
    if (fetchedAt) {
      fxStatus.appendChild(el('span', null,
        t('assets.fx.fetchedAt', { when: new Date(fetchedAt).toLocaleString() })));
    }
    card.appendChild(fxStatus);

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
      t('assets.summary.fxnote')));

    return card;
  }

  function stat(label, value) {
    const el = TB.utils.el;
    return el('div', {
      style: {
        background: 'var(--tb-bg)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        borderRadius: 'var(--tb-radius-2)',
        border: '1px solid var(--tb-border)',
      },
    },
      el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', marginBottom: '2px' } }, label),
      el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' } }, value),
    );
  }

  // ----- Toolbar -------------------------------------------------------

  function buildToolbar() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const groupSelect = el('select', {
      class: 'tb-select',
      style: { maxWidth: '260px' },
      onchange: (e) => { groupBy = e.target.value; rerender(); },
    },
      el('option', { value: 'institution' }, t('assets.group.byinst')),
      el('option', { value: 'wrapper' },     t('assets.group.bywrapper')),
      el('option', { value: 'country' },     t('assets.group.bycountry')),
    );
    // Set selected
    Array.from(groupSelect.options).forEach((o) => { o.selected = o.value === groupBy; });

    const archivedToggle = el('button', {
      class: 'tb-btn tb-btn--ghost',
      type: 'button',
      onclick: () => { showArchived = !showArchived; rerender(); },
    }, showArchived ? t('assets.hide.archived') : t('assets.show.archived'));

    const addBtn = el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: () => openEditModal(null),
    }, '+ ' + t('assets.add'));

    const sofaBtn = el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      onclick: () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'sofa-roth' } })),
    }, t('assets.gotosofa') + ' →');

    const binderBtn = el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      onclick: () => openSurvivorBinder(),
    }, t('assets.binder.print'));

    const targetBtn = el('button', {
      class: 'tb-btn tb-btn--ghost',
      type: 'button',
      onclick: () => openTargetAllocationModal(),
    }, t('assets.alloc.target.button'));

    const snapshotBtn = el('button', {
      class: 'tb-btn tb-btn--ghost',
      type: 'button',
      onclick: () => openSnapshotsModal(),
    }, t('assets.snapshot.button'));

    return el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)',
        alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap', alignItems: 'center' } },
        groupSelect,
        archivedToggle,
      ),
      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } },
        snapshotBtn,
        targetBtn,
        binderBtn,
        sofaBtn,
        addBtn,
      ),
    );
  }

  // ====================================================================
  // Year-over-year balance snapshots (Phase 5)
  // ====================================================================
  //
  // A snapshot is a frozen-in-time copy of every active account's
  // balance + USD-equivalent + allocation rollup. Stored under
  // state.assets.snapshots[]. Useful for tracking growth over time
  // and as a backup before bulk re-uploads.
  //
  // Manual trigger only in v1 (Take snapshot button). v2 may add an
  // auto-prompt when the calendar year changes.

  function takeSnapshot(label) {
    const accounts = getActiveAccounts();
    // Nothing to snapshot — bail out rather than storing a permanent
    // total_usd: 0 point that would drag net-worth charts to zero.
    // Callers (e.g. net-worth.js) expect a falsy return here.
    if (accounts.length === 0) return null;
    const today = new Date().toISOString();
    const total_usd = totalUsd();
    // FX rate at snapshot time, captured so historical JPY chart uses
    // the rate of that moment (more meaningful than re-converting at
    // current rate). 1 USD = ? JPY.
    const oneUsdInJpy = 1 / toUsd(1, 'JPY');
    const snap = {
      id: TB.utils.uuid(),
      taken_at: today,
      label: label || today.slice(0, 10),
      total_usd,
      total_jpy: Math.round(total_usd * oneUsdInJpy),
      fx_rate_used: oneUsdInJpy,            // JPY per 1 USD
      allocation: portfolioAllocation(),
      accounts: accounts.map((a) => ({
        account_id: a.id,
        institution: a.institution || '',
        name: a.name || '',
        country: a.country || null,
        tax_wrapper: a.tax_wrapper || 'other',
        currency: a.currency || 'USD',
        balance_native: a.balance_native,
        balance_usd: toUsd(a.balance_native, a.currency),
        allocation: effectiveAllocation(a),
      })),
    };
    const list = (TB.state.get('assets.snapshots') || []).slice();
    list.push(snap);
    // Keep newest first when displaying, but store insertion order.
    TB.state.set('assets.snapshots', list);
    return snap;
  }

  function deleteSnapshot(snapshotId) {
    const list = (TB.state.get('assets.snapshots') || []).filter((s) => s.id !== snapshotId);
    TB.state.set('assets.snapshots', list);
  }

  function openSnapshotsModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');

    function render() {
      const snaps = (TB.state.get('assets.snapshots') || []).slice().reverse();
      const backdrop = el('div', { class: 'tb-modal-backdrop' });
      const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
      backdrop.appendChild(modal);
      function close() { root.innerHTML = ''; }
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

      modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('assets.snapshot.title')));
      modal.appendChild(el('p', { class: 'tb-field-help' }, t('assets.snapshot.help')));

      // Take-snapshot row.
      const labelInput = el('input', {
        type: 'text', class: 'tb-input',
        placeholder: t('assets.snapshot.label.placeholder'),
        style: { flex: '1' },
      });
      modal.appendChild(el('div', {
        style: { display: 'flex', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-4)' },
      },
        labelInput,
        el('button', {
          class: 'tb-btn', type: 'button',
          onclick: () => {
            takeSnapshot(labelInput.value.trim());
            root.innerHTML = '';
            render();
            rerender();
          },
        }, t('assets.snapshot.take')),
      ));

      if (snaps.length === 0) {
        modal.appendChild(el('p', { class: 'tb-field-help' }, t('assets.snapshot.empty')));
      } else {
        // History table.
        const table = el('table', {
          style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
        });
        const thead = el('thead', null,
          el('tr', null,
            el('th', { style: { textAlign: 'left',  padding: '4px 8px', borderBottom: '1px solid var(--tb-border)' } }, t('assets.snapshot.col.date')),
            el('th', { style: { textAlign: 'left',  padding: '4px 8px', borderBottom: '1px solid var(--tb-border)' } }, t('assets.snapshot.col.label')),
            el('th', { style: { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--tb-border)' } }, t('assets.snapshot.col.total')),
            el('th', { style: { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--tb-border)' } }, t('assets.snapshot.col.delta')),
            el('th', { style: { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--tb-border)' } }, ''),
          ),
        );
        table.appendChild(thead);
        const tbody = el('tbody');
        // Snaps are reversed (newest first); for delta vs. previous snapshot
        // we need the snapshot taken BEFORE this one (older → larger original index).
        for (let i = 0; i < snaps.length; i++) {
          const s = snaps[i];
          const prev = snaps[i + 1]; // older one
          let deltaCell = '—';
          let deltaColor = 'var(--tb-text-soft)';
          if (prev && prev.total_usd) {
            const delta = s.total_usd - prev.total_usd;
            const pct = (delta / prev.total_usd) * 100;
            const sign = delta >= 0 ? '+' : '';
            deltaCell = sign + TB.utils.formatUSD(delta, { maximumFractionDigits: 0 }) + ' (' + sign + pct.toFixed(1) + '%)';
            deltaColor = delta >= 0 ? 'var(--tb-success)' : 'var(--tb-error)';
          }
          tbody.appendChild(el('tr', null,
            el('td', { style: { padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)', fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
              s.taken_at.slice(0, 10)),
            el('td', { style: { padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)' } },
              s.label || '—'),
            el('td', { style: { padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)', textAlign: 'right', fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
              TB.utils.formatUSD(s.total_usd, { maximumFractionDigits: 0 })),
            el('td', { style: { padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)', textAlign: 'right', fontFamily: 'var(--tb-font-mono)', color: deltaColor } },
              deltaCell),
            el('td', { style: { padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)', textAlign: 'right' } },
              el('button', {
                class: 'tb-btn tb-btn--ghost',
                type: 'button',
                style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-error)' },
                onclick: () => {
                  if (confirm(t('assets.snapshot.confirmDelete'))) {
                    deleteSnapshot(s.id);
                    root.innerHTML = '';
                    render();
                    rerender();
                  }
                },
              }, '🗑'),
            ),
          ));
        }
        table.appendChild(tbody);
        modal.appendChild(table);
      }

      modal.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-4)' },
      },
        el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('assets.modal.close')),
      ));

      root.innerHTML = '';
      root.appendChild(backdrop);
    }

    render();
  }

  // ====================================================================
  // Asset deepening — analytical helpers (v0.35)
  // ====================================================================
  //
  // Powers the three new review cards on the Assets page:
  //   • Beneficiary review     — accounts missing POD/TOD designations
  //   • Year-over-year change  — large balance moves since last 12mo snapshot
  //   • Tax-loss harvesting    — US positions with unrealized loss > $500
  //
  // Plus exposes computeUnrealizedGain() and unrealizedGainSummary()
  // so the Net Worth, Projections, and Tax Coordinator modules can read
  // the same numbers without duplicating logic.

  // Unrealized gain in native currency. Returns null when either field
  // is missing — callers render "—" rather than treating null as zero.
  function computeUnrealizedGain(acct) {
    if (!acct) return null;
    if (acct.basis_native == null || acct.balance_native == null) return null;
    return acct.balance_native - acct.basis_native;
  }

  // Summary: totals across all active accounts.
  //   total_basis_usd  : sum of cost basis (USD, where available)
  //   total_value_usd  : sum of current balances (USD, where basis is set)
  //   gain_usd         : value - basis
  //   gain_pct         : gain / basis (when basis > 0)
  //   coverage_pct     : fraction of active-account dollars with basis set
  // Coverage matters because a low number means the gain figure is
  // unrepresentative.
  function unrealizedGainSummary() {
    const accts = getActiveAccounts();
    let basisUsd = 0, valueUsd = 0, allValueUsd = 0;
    let covered = 0;
    for (const a of accts) {
      const v = toUsd(a.balance_native, a.currency);
      if (v != null) allValueUsd += v;
      if (a.basis_native != null && a.balance_native != null) {
        const b = toUsd(a.basis_native, a.currency);
        if (b != null) {
          basisUsd += b;
          valueUsd += v || 0;
          covered++;
        }
      }
    }
    const gain = valueUsd - basisUsd;
    return {
      total_basis_usd: basisUsd,
      total_value_usd: valueUsd,
      gain_usd: gain,
      gain_pct: basisUsd > 0 ? (gain / basisUsd) * 100 : null,
      coverage_count: covered,
      coverage_total: accts.length,
      coverage_pct: allValueUsd > 0 ? (valueUsd / allValueUsd) * 100 : 0,
    };
  }

  // Accounts where a beneficiary designation IS appropriate but missing.
  // Skips JP-savings / JP-checking / cash wrappers since those pass via
  // 法定相続人 to the spouse/kids by default — POD/TOD doesn't apply.
  function accountsMissingBeneficiary() {
    // "cash"/"crypto" were never real wrapper ids — what this skip-list
    // actually means is "JP banking-style wrappers" (banking_jp cat).
    return getActiveAccounts().filter((a) => {
      if (a.beneficiary && String(a.beneficiary).trim().length > 0) return false;
      const w = WRAPPER_BY_ID[a.tax_wrapper];
      if (w && w.cat === 'banking_jp') return false;
      return true;
    });
  }

  // Tax-loss harvesting scan — surfaces US accounts with unrealized
  // loss above the noise threshold. JP accounts are excluded because
  // PFIC treatment + JP capital-gains treatment make the harvesting
  // math non-portable; we don't want to suggest selling 投資信託 to
  // "harvest" a loss that doesn't behave like a US capital loss.
  function scanTaxLossHarvest(opts) {
    opts = opts || {};
    const minLossUsd = opts.minLossUsd || 500;
    const out = [];
    for (const a of getActiveAccounts()) {
      const gain = computeUnrealizedGain(a);
      if (gain == null || gain >= 0) continue;
      if (a.country !== 'US') continue;
      // Tax-deferred wrappers don't realize gains until withdrawal —
      // harvesting inside them is meaningless. Derive from WRAPPERS'
      // `cat` field (rather than a hand-typed id list) so this can't
      // drift out of sync with the real taxonomy again.
      const w = WRAPPER_BY_ID[a.tax_wrapper];
      if (w && (w.cat === 'retirement_pretax' || w.cat === 'retirement_roth' || w.cat === 'special' || w.cat === 'savings')) continue;
      const lossUsd = Math.abs(toUsd(gain, a.currency) || 0);
      if (lossUsd < minLossUsd) continue;
      out.push({
        account: a,
        loss_native: gain,
        loss_usd: lossUsd,
        basis_usd: toUsd(a.basis_native, a.currency),
        value_usd: toUsd(a.balance_native, a.currency),
      });
    }
    out.sort((x, y) => y.loss_usd - x.loss_usd);
    return out;
  }

  // Year-over-year change per account. Walks snapshots to find the
  // closest one ~365 days ago, then diffs per-account USD balances.
  // Returns sorted by absolute % change so the biggest movers are first.
  // pctThreshold (default 25) is what the UI uses to highlight "big" moves.
  function yoyChangePerAccount() {
    const snapshots = (TB.state.get('assets.snapshots') || []).slice();
    if (snapshots.length === 0) return [];
    const today = new Date();
    const targetMs = today.getTime() - 365 * 24 * 3600 * 1000;
    // Pick the snapshot closest to 1y ago that is at LEAST 60 days old
    // (so we don't compare to a snapshot taken yesterday and call it YoY).
    const candidates = snapshots
      .map((s) => ({ snap: s, takenMs: new Date(s.taken_at).getTime() }))
      .filter((c) => today.getTime() - c.takenMs >= 60 * 24 * 3600 * 1000)
      .map((c) => Object.assign({ diff: Math.abs(c.takenMs - targetMs) }, c))
      .sort((a, b) => a.diff - b.diff);
    const ref = candidates[0] ? candidates[0].snap : null;
    if (!ref) return [];

    const refByAccount = {};
    for (const r of (ref.accounts || [])) {
      refByAccount[r.account_id] = r;
    }
    const out = [];
    for (const a of getActiveAccounts()) {
      const r = refByAccount[a.id];
      if (!r) continue;
      const fromUsd = Number(r.balance_usd) || 0;
      const toUsdVal = toUsd(a.balance_native, a.currency);
      if (toUsdVal == null) continue;
      const deltaUsd = toUsdVal - fromUsd;
      const pct = fromUsd > 0 ? (deltaUsd / fromUsd) * 100 : null;
      out.push({
        account: a,
        from_usd: fromUsd,
        to_usd: toUsdVal,
        delta_usd: deltaUsd,
        pct_change: pct,
        ref_date: ref.taken_at,
        ref_label: ref.label,
      });
    }
    out.sort((x, y) => {
      const ax = x.pct_change == null ? -Infinity : Math.abs(x.pct_change);
      const ay = y.pct_change == null ? -Infinity : Math.abs(y.pct_change);
      return ay - ax;
    });
    return out;
  }

  function fmtUsdShort(usd) {
    if (usd == null || !isFinite(usd)) return '—';
    const sign = usd < 0 ? '-' : '';
    const abs = Math.abs(usd);
    if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
    if (abs >= 1_000)     return sign + '$' + (abs / 1_000).toFixed(1) + 'K';
    return sign + '$' + Math.round(abs).toLocaleString();
  }

  // ====================================================================
  // Target allocation modal (Phase 5)
  // ====================================================================
  //
  // Lightweight modal: 6 % inputs + Suggest (60/30/10) preset + Clear.
  // Persists to state.assets.target_allocation. Drift is computed in
  // the summary-card legend (above) once a target is set.

  function openTargetAllocationModal() {
    const el = TB.utils.el;
    const root = document.getElementById('tb-modal-root');
    const t = TB.i18n.t;

    const current = TB.state.get('assets.target_allocation') || null;
    const draft = current
      ? Object.assign({}, current)
      : { equity_us: 0.6, equity_intl: 0.2, bond: 0.15, cash: 0.05, real_estate: 0, alternative: 0 };

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('assets.alloc.target.title')));
    modal.appendChild(el('p', { class: 'tb-field-help' }, t('assets.alloc.target.help')));

    const inputs = {};
    const sumLabel = el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } }, '100%');
    function updateSum() {
      let s = 0;
      for (const cls of ASSET_CLASSES) {
        const v = parseFloat(inputs[cls].value);
        if (isFinite(v) && v > 0) s += v;
      }
      sumLabel.textContent = s.toFixed(1) + '%';
      sumLabel.style.color = (Math.abs(s - 100) < 0.5) ? 'var(--tb-success)' : 'var(--tb-warn)';
    }

    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--tb-sp-2)' },
    });
    for (const cls of ASSET_CLASSES) {
      const input = el('input', {
        type: 'number', class: 'tb-input',
        min: '0', max: '100', step: '0.1',
        style: { fontFamily: 'var(--tb-font-mono)' },
        value: ((draft[cls] || 0) * 100).toFixed(1),
        oninput: updateSum,
      });
      inputs[cls] = input;
      grid.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)' } },
        el('span', { style: {
          width: '12px', height: '12px', borderRadius: '50%',
          background: ASSET_CLASS_COLOR[cls], display: 'inline-block', flexShrink: '0',
        } }),
        el('label', { style: { flex: '1', fontSize: 'var(--tb-fs-12)' } },
          t('assets.alloc.' + cls)),
        input,
        el('span', { style: { color: 'var(--tb-text-soft)' } }, '%'),
      ));
    }
    modal.appendChild(grid);

    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' },
    },
      el('div', null,
        el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 10px', fontSize: 'var(--tb-fs-12)', marginRight: 'var(--tb-sp-2)' },
          onclick: () => {
            const preset = { equity_us: 60, equity_intl: 20, bond: 15, cash: 5, real_estate: 0, alternative: 0 };
            for (const cls of ASSET_CLASSES) inputs[cls].value = String(preset[cls] || 0);
            updateSum();
          },
        }, t('assets.alloc.target.preset')),
        el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 10px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            for (const cls of ASSET_CLASSES) inputs[cls].value = '0';
            updateSum();
          },
        }, t('assets.alloc.target.clear')),
      ),
      el('div', null,
        el('span', { style: { color: 'var(--tb-text-soft)', marginRight: 'var(--tb-sp-1)' } },
          t('assets.alloc.sum')),
        sumLabel,
      ),
    ));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', {
      class: 'tb-btn tb-btn--danger', type: 'button',
      onclick: () => {
        TB.state.set('assets.target_allocation', null);
        close();
        rerender();
      },
    }, t('assets.alloc.target.remove')));
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('assets.modal.cancel')));
    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        const raw = {};
        for (const cls of ASSET_CLASSES) {
          const v = parseFloat(inputs[cls].value);
          raw[cls] = (isFinite(v) && v > 0) ? v / 100 : 0;
        }
        const norm = normalizeAllocation(raw);
        const anyNonZero = ASSET_CLASSES.some((c) => norm[c] > 0);
        TB.state.set('assets.target_allocation', anyNonZero ? norm : null);
        close();
        rerender();
      },
    }, t('assets.modal.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    updateSum();
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ----- Review cards (beneficiary / YoY / tax-loss harvesting) -------

  function buildBeneficiaryReviewCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const missing = accountsMissingBeneficiary();
    // When there are no missing beneficiaries, render a compact
    // "all clear" tile (only when the user has any active accounts at
    // all — empty state would be misleading).
    const accts = getActiveAccounts();
    if (accts.length === 0) return null;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '👥 ' + t('assets.review.beneficiary.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('assets.review.beneficiary.intro')));

    if (missing.length === 0) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-success)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        },
      }, '✓ ' + t('assets.review.beneficiary.allset', { n: accts.length })));
      return card;
    }

    card.appendChild(el('div', {
      style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'rgba(178, 58, 58, 0.08)',
        borderLeft: '3px solid var(--tb-error)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)' },
    },
      el('strong', null, '⚠ ' + t('assets.review.beneficiary.warn', { n: missing.length })),
      el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
        t('assets.review.beneficiary.warn.body')),
    ));

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    for (const a of missing) {
      const row = el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } },
          (a.institution || '?') + (a.name ? ' · ' + a.name : '')),
        el('div', { class: 'tb-card-meta' },
          (a.tax_wrapper || '?') + (a.country ? ' · ' + a.country : '') +
            ' · ' + fmtUsdShort(toUsd(a.balance_native, a.currency))),
      ));
      row.appendChild(el('button', {
        class: 'tb-btn',
        type: 'button',
        style: { fontSize: 'var(--tb-fs-12)', padding: '4px 10px' },
        onclick: () => openEditModal(a.id),
      }, '+ ' + t('assets.review.beneficiary.add')));
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  function buildYoYChangeCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const changes = yoyChangePerAccount();
    if (changes.length === 0) return null;

    // Pull out only the "big movers" (>= 25%) for the headline list;
    // the rest live behind a "show all" details expander.
    const big = changes.filter((c) => c.pct_change != null && Math.abs(c.pct_change) >= 25);

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    const ref = changes[0];
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📊 ' + t('assets.review.yoy.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' },
      t('assets.review.yoy.intro', { date: String(ref.ref_date).slice(0, 10) })));

    if (big.length === 0) {
      card.appendChild(el('div', { class: 'tb-field-help' },
        '✓ ' + t('assets.review.yoy.steady')));
    } else {
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
      for (const c of big) {
        const isPositive = c.delta_usd >= 0;
        const color = isPositive ? 'var(--tb-success)' : 'var(--tb-error)';
        list.appendChild(el('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
            padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
            borderLeft: '3px solid ' + color, borderRadius: 'var(--tb-radius-1)' },
        },
          el('div', null,
            el('div', { style: { fontWeight: '600' } },
              (c.account.institution || '?') + (c.account.name ? ' · ' + c.account.name : '')),
            el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } },
              fmtUsdShort(c.from_usd) + ' → ' + fmtUsdShort(c.to_usd)),
          ),
          el('div', { style: { textAlign: 'right' } },
            el('div', { style: { color, fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } },
              (isPositive ? '+' : '') + fmtUsdShort(c.delta_usd)),
            el('div', { style: { color, fontSize: 'var(--tb-fs-12)', fontFamily: 'var(--tb-font-mono)' } },
              (isPositive ? '+' : '') + c.pct_change.toFixed(1) + '%'),
          ),
        ));
      }
      card.appendChild(list);
    }

    // "Show all" expander for the steady accounts
    if (changes.length > big.length) {
      const details = el('details', { style: { marginTop: 'var(--tb-sp-3)' } });
      details.appendChild(el('summary', {
        style: { cursor: 'pointer', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
      }, t('assets.review.yoy.showAll', { n: changes.length - big.length })));
      const tbl = el('table', { style: { width: '100%', borderCollapse: 'collapse', marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' } });
      for (const c of changes.filter((c) => !big.includes(c))) {
        const sign = c.delta_usd >= 0 ? '+' : '';
        tbl.appendChild(el('tr', null,
          el('td', { style: { padding: '4px 8px' } },
            (c.account.institution || '?') + (c.account.name ? ' · ' + c.account.name : '')),
          el('td', { style: { padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--tb-font-mono)' } },
            sign + fmtUsdShort(c.delta_usd) + (c.pct_change != null ? ' (' + sign + c.pct_change.toFixed(1) + '%)' : '')),
        ));
      }
      details.appendChild(tbl);
      card.appendChild(details);
    }
    return card;
  }

  function buildTaxLossHarvestCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const opps = scanTaxLossHarvest();
    // Hide entirely when nothing's actionable — this is a year-end /
    // opportunistic card, not a daily one.
    if (opps.length === 0) {
      // BUT — if we have basis data and no losses, still show a "no opps"
      // line during the year-end window (Oct-Dec) so the user sees we
      // checked.
      const m = new Date().getMonth() + 1;
      const inWindow = m >= 10 && m <= 12;
      if (!inWindow) return null;
      const summary = unrealizedGainSummary();
      if (summary.coverage_count === 0) return null; // no basis data → no signal
      const card = el('div', { class: 'tb-card', 'data-track': 'core' });
      card.appendChild(el('h2', { style: { marginTop: 0 } }, '🍂 ' + t('assets.review.tlh.title')));
      card.appendChild(el('div', { class: 'tb-field-help' },
        '✓ ' + t('assets.review.tlh.none')));
      return card;
    }

    const totalLoss = opps.reduce((s, o) => s + o.loss_usd, 0);
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🍂 ' + t('assets.review.tlh.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' },
      t('assets.review.tlh.intro', { total: fmtUsdShort(totalLoss), n: opps.length })));

    // Wash-sale rule callout — important to mention since the whole
    // strategy collapses if violated.
    card.appendChild(el('div', {
      style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'rgba(185, 122, 26, 0.10)',
        borderLeft: '3px solid var(--tb-warn)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-3)',
        fontSize: 'var(--tb-fs-12)' },
    },
      el('strong', null, '⚠ ' + t('assets.review.tlh.wash.title')),
      ' ' + t('assets.review.tlh.wash.body')));

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
    for (const o of opps) {
      list.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderLeft: '3px solid var(--tb-error)', borderRadius: 'var(--tb-radius-1)' },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } },
            (o.account.institution || '?') + (o.account.name ? ' · ' + o.account.name : '')),
          el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } },
            t('assets.review.tlh.basis') + ' ' + fmtUsdShort(o.basis_usd) + ' → ' +
            t('assets.review.tlh.value') + ' ' + fmtUsdShort(o.value_usd)),
        ),
        el('div', { style: { textAlign: 'right' } },
          el('div', { style: { color: 'var(--tb-error)', fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } },
            '-' + fmtUsdShort(o.loss_usd)),
          el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
            t('assets.review.tlh.unrealized')),
        ),
      ));
    }
    card.appendChild(list);
    return card;
  }

  // ----- Account list --------------------------------------------------

  function buildAccountsList() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const all = getAccounts();
    const visible = showArchived ? all : all.filter((a) => a.active !== false);

    if (visible.length === 0) {
      return el('div', { class: 'tb-card', 'data-track': 'core' },
        el('h3', null, t('assets.empty.title')),
        el('p', { class: 'tb-card-meta' }, t('assets.empty.body')),
        el('div', { class: 'tb-btn-row' },
          el('button', {
            class: 'tb-btn',
            type: 'button',
            onclick: () => openEditModal(null),
          }, '+ ' + t('assets.add')),
        ),
      );
    }

    // Group accounts by the current grouping mode.
    const groups = {};
    const groupOrder = [];
    for (const a of visible) {
      let key, label;
      if (groupBy === 'wrapper') {
        key = a.tax_wrapper || 'other';
        label = t('assets.wrapper.' + key);
      } else if (groupBy === 'country') {
        key = a.country || 'OTHER';
        label = key === 'US' ? t('assets.field.country.us')
              : key === 'JP' ? t('assets.field.country.jp')
              : t('assets.field.country.other');
      } else {
        key = a.institution || (lang === 'ja' ? '(未指定)' : '(Unspecified)');
        label = key;
      }
      if (!groups[key]) { groups[key] = { label, accounts: [] }; groupOrder.push(key); }
      groups[key].accounts.push(a);
    }

    // Sort groupOrder for wrapper view (use canonical render order).
    if (groupBy === 'wrapper') {
      groupOrder.sort((a, b) => WRAPPER_RENDER_ORDER.indexOf(a) - WRAPPER_RENDER_ORDER.indexOf(b));
    } else if (groupBy === 'country') {
      const co = ['US', 'JP', 'OTHER'];
      groupOrder.sort((a, b) => co.indexOf(a) - co.indexOf(b));
    } else {
      // Institution sort: alphabetical, but archived-only groups last.
      groupOrder.sort((a, b) => a.localeCompare(b, lang === 'ja' ? 'ja' : 'en'));
    }

    const wrap = el('div');
    for (const k of groupOrder) {
      wrap.appendChild(buildGroupCard(k, groups[k]));
    }
    return wrap;
  }

  function buildGroupCard(key, group) {
    const el = TB.utils.el;

    // Compute group total in USD.
    const groupTotalUsd = group.accounts.reduce(
      (s, a) => s + (a.active === false ? 0 : toUsd(a.balance_native, a.currency)), 0);

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { padding: 'var(--tb-sp-4)' } });

    card.appendChild(el('div', {
      style: {
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)',
        marginBottom: 'var(--tb-sp-3)',
        paddingBottom: 'var(--tb-sp-2)', borderBottom: '1px solid var(--tb-border)',
      },
    },
      el('h3', { style: { margin: 0 } }, group.label),
      el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
        TB.utils.formatUSD(groupTotalUsd, { maximumFractionDigits: 0 })),
    ));

    for (const a of group.accounts) {
      card.appendChild(buildAccountRow(a));
    }
    return card;
  }

  function buildAccountRow(a) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const wrapperMeta = WRAPPER_BY_ID[a.tax_wrapper] || WRAPPER_BY_ID.other;
    const archived = a.active === false;
    const stale = staleness(a.updated_at);

    const row = el('div', {
      style: {
        borderLeft: '4px solid ' + wrapperMeta.color,
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        marginBottom: 'var(--tb-sp-2)',
        background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-1)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 'var(--tb-sp-3)',
        alignItems: 'start',
        opacity: archived ? '0.55' : '1',
      },
    });

    // Left column — name, balance, meta
    const left = el('div', { style: { minWidth: '0' } });

    const titleLine = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', alignItems: 'baseline' } },
      el('strong', { style: { fontSize: 'var(--tb-fs-16)' } }, a.name || (lang === 'ja' ? '(無名)' : '(Unnamed)')),
      el('span', {
        class: 'tb-badge',
        style: {
          background: wrapperMeta.color + '22',
          color: wrapperMeta.color,
          borderColor: 'transparent',
          fontSize: 'var(--tb-fs-12)',
        },
      }, t('assets.wrapper.' + (a.tax_wrapper || 'other'))),
      a.country ? el('span', { class: 'tb-badge', style: { fontSize: 'var(--tb-fs-12)' } },
        a.country === 'US' ? '🇺🇸' : a.country === 'JP' ? '🇯🇵' : '🌐') : null,
      // FBAR linkage badge — small + dim, links back to the FBAR module.
      a.fbar_account_id ? el('a', {
        href: '#',
        class: 'tb-badge',
        title: t('assets.fbar.linked.tip'),
        style: {
          fontSize: 'var(--tb-fs-12)',
          background: 'rgba(14, 42, 79, 0.10)',
          color: 'var(--tb-navy)',
          borderColor: 'transparent',
          textDecoration: 'none',
        },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'fbar' } }));
        },
      }, '🔗 ' + t('assets.fbar.linked.label')) : null,
      archived ? el('span', { class: 'tb-badge', style: { fontSize: 'var(--tb-fs-12)' } }, t('assets.archived.label')) : null,
    );
    left.appendChild(titleLine);

    // Balance line
    const balLine = el('div', {
      style: {
        marginTop: 'var(--tb-sp-1)',
        fontFamily: 'var(--tb-font-mono)',
        fontSize: 'var(--tb-fs-22)',
        fontWeight: '600',
      },
    },
      fmtNative(a.balance_native, a.currency),
    );
    left.appendChild(balLine);

    // USD-equivalent line (only if non-USD)
    if (a.currency && a.currency !== 'USD' && a.balance_native != null) {
      left.appendChild(el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', fontFamily: 'var(--tb-font-mono)' } },
        '≈ ' + TB.utils.formatUSD(toUsd(a.balance_native, a.currency), { maximumFractionDigits: 0 })));
    }

    // Basis line (taxable / RE only)
    if (wrapperMeta.basis && a.basis_native != null) {
      const gainNative = (a.balance_native || 0) - (a.basis_native || 0);
      const gainUsd = toUsd(gainNative, a.currency);
      left.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } },
        (lang === 'ja' ? '取得原価: ' : 'Basis: ') + fmtNative(a.basis_native, a.currency) +
        '  ·  ' + (lang === 'ja' ? '含み損益: ' : 'Unrealized: ') +
        (gainUsd >= 0 ? '+' : '') + TB.utils.formatUSD(gainUsd, { maximumFractionDigits: 0 })));
    }

    // Notes
    if (a.notes) {
      left.appendChild(el('div', {
        class: 'tb-card-meta',
        style: { marginTop: 'var(--tb-sp-2)', whiteSpace: 'pre-wrap', lineHeight: 'var(--tb-lh-body)' },
      }, a.notes));
    }

    // Beneficiary line — only shown when set.
    if (a.beneficiary) {
      left.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } },
        (lang === 'ja' ? '受取人: ' : 'Beneficiary: ') + a.beneficiary));
    }
    // Last-4 — only shown when set, dimmed.
    if (a.account_number_last4) {
      left.appendChild(el('div', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
        '••••' + a.account_number_last4));
    }

    // Lifecycle countdown badge — colored by severity.
    const lc = lifecycleBadge(a.close_date);
    if (lc) {
      const sevColor = lc.severity === 'past'  ? 'var(--tb-error)'
                     : lc.severity === 'today' ? 'var(--tb-error)'
                     : lc.severity === 'soon'  ? 'var(--tb-warn)'
                     : 'var(--tb-text-soft)';
      const transferSuffix = a.transfer_to
        ? ' ' + t('assets.lifecycle.transferto', { target: a.transfer_to })
        : '';
      left.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-2)',
          display: 'inline-flex', padding: '2px 8px',
          background: sevColor + '18',
          color: sevColor,
          fontSize: 'var(--tb-fs-12)', fontWeight: '600',
          borderRadius: 'var(--tb-radius-pill)',
        },
      }, t(lc.key, lc.vars) + transferSuffix));
    }

    // Status row
    const statusRow = el('div', {
      class: 'tb-card-meta',
      style: { marginTop: 'var(--tb-sp-2)', display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-3)' },
    },
      el('span', {
        style: stale.state === 'stale'
          ? { color: 'var(--tb-warn)', fontWeight: '600' }
          : null,
      }, t(stale.label_key, stale.vars || undefined)),
      a.include_in_sofa === false
        ? el('span', { style: { color: 'var(--tb-text-soft)' } },
            (lang === 'ja' ? '✕ SOFA 集計から除外' : '✕ Excluded from SOFA'))
        : el('span', { style: { color: 'var(--tb-success)' } },
            (lang === 'ja' ? '✓ SOFA 集計対象' : '✓ Feeds SOFA')),
    );
    left.appendChild(statusRow);

    // ── Document Vault back-references ───────────────────────────
    // Documents in the Vault that were linked to this asset account
    // (via the linked_module/linked_id schema added in v0.33) show
    // up here as clickable chips. Each chip opens the doc's edit
    // modal in the Vault module — fast nav back and forth.
    if (TB.docVault && typeof TB.docVault.getDocsLinkedTo === 'function') {
      const linkedDocs = TB.docVault.getDocsLinkedTo('assets', a.id);
      if (linkedDocs && linkedDocs.length > 0) {
        const docRow = el('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: 'var(--tb-sp-2)' },
        });
        docRow.appendChild(el('span', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-12)' } },
          '📂 ' + t('assets.linkedDocs.label') + ':'));
        for (const d of linkedDocs) {
          const docLabel = d.title || (TB.docVault.typeLabel ? TB.docVault.typeLabel(d.type, lang) : d.type);
          docRow.appendChild(el('button', {
            type: 'button',
            class: 'tb-badge',
            style: {
              fontSize: 'var(--tb-fs-12)', background: 'rgba(46, 107, 92, 0.12)',
              color: 'var(--tb-track-ai)', borderColor: 'transparent', cursor: 'pointer',
              padding: '2px 8px',
            },
            onclick: (e) => {
              e.stopPropagation();
              if (TB.docVault && typeof TB.docVault.openEditModal === 'function') {
                TB.docVault.openEditModal(d);
              } else {
                document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'document-vault' } }));
              }
            },
          }, docLabel));
        }
        left.appendChild(docRow);
      }
    }

    // Right column — action buttons
    const right = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-1)' } });
    right.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      style: { padding: 'var(--tb-sp-1) var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' },
      onclick: () => openEditModal(a.id),
    }, t('assets.edit')));
    right.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost',
      type: 'button',
      style: { padding: 'var(--tb-sp-1) var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' },
      onclick: () => { setActive(a.id, archived); rerender(); },
    }, archived ? t('assets.unarchive') : t('assets.archive')));
    // "Ask Taigan about this account" — only shown when the AI module
    // is loaded AND consent allows ask_taigan (we let the gate filter,
    // so the button might prompt; just disable if consent === 'off'
    // explicitly for cleanliness).
    if (TB.askTaigan && typeof TB.askTaigan.openWithContext === 'function') {
      const consentAllow = (TB.ai && typeof TB.ai.isFeatureAllowed === 'function')
        ? TB.ai.isFeatureAllowed('ask_taigan')
        : true;
      if (consentAllow !== false) {
        right.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost',
          type: 'button',
          style: { padding: 'var(--tb-sp-1) var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' },
          title: t('assets.askTaigan.tooltip'),
          onclick: () => {
            TB.askTaigan.openWithContext({
              feature: 'ask_taigan',
              label_en: (a.institution || '?') + (a.name ? ' · ' + a.name : ''),
              label_jp: (a.institution || '?') + (a.name ? ' · ' + a.name : ''),
              prompt_en: 'I have an account at ' + (a.institution || '?') +
                ' (' + (a.country || '?') + ') wrapped as ' + (a.tax_wrapper || '?') +
                '. What are the key tax / planning considerations I should be thinking about for this specific account?',
              prompt_jp: (a.institution || '?') + '(' + (a.country || '?') + ')の' +
                (a.tax_wrapper || '?') + '口座について、税務・プランニング上の主な検討事項を教えてください。',
            });
          },
        }, '💬 ' + t('assets.askTaigan.btn')));
      }
    }

    row.appendChild(left);
    row.appendChild(right);
    return row;
  }

  // ====================================================================
  // Add / Edit modal
  // ====================================================================

  function openEditModal(editId) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const isEdit = !!editId;
    const existing = isEdit ? findById(editId) : null;

    // Working copy for the form
    const draft = existing ? Object.assign({}, existing) : {
      id: TB.utils.uuid(),
      institution: '',
      name: '',
      country: 'US',
      tax_wrapper: 'taxable_brokerage',
      currency: 'USD',
      balance_native: null,
      basis_native: null,
      account_number_last4: null,
      beneficiary: null,
      notes: '',
      updated_at: TB.utils.todayIso(),
      active: true,
      include_in_sofa: true,
      close_date: null,
      transfer_to: null,
    };

    const root = document.getElementById('tb-modal-root');
    if (!root) return;

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal    = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);

    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('button', {
      class: 'tb-modal-close', type: 'button', 'aria-label': 'Close',
      onclick: close,
    }, '×'));

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isEdit ? t('assets.modal.edit.title') : t('assets.modal.add.title')));

    // ---- Upload card (auto-fill via Claude vision) ----------------
    // Sits at the top of the modal so the user sees it before any
    // manual entry. Disabled state when no API key is set, with a
    // jump-to-Settings affordance instead of silently hiding.
    const uploadStatus = el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: 'var(--tb-sp-2)' } });

    const uploadCard = el('div', {
      style: {
        border: '1px dashed var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        marginBottom: 'var(--tb-sp-4)',
        background: 'var(--tb-bg)',
      },
    });
    uploadCard.appendChild(el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-1)' } }, t('assets.upload.title')));
    uploadCard.appendChild(el('div', { class: 'tb-field-help' }, t('assets.upload.help')));

    // ── Upload examples / tutorial ───────────────────────────────
    // Compact 2-col grid showing what kinds of source documents
    // work, with concrete examples. Helps users realize they can
    // upload many things — passbooks, PDFs, screenshots — not just
    // formal "statements". Especially important for JP users with
    // 通帳 (passbooks) which are the only official record some
    // banks issue.
    const examplesGrid = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '6px 12px',
        marginTop: 'var(--tb-sp-2)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg-elev)',
        borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)',
      },
    });
    function ex(emoji, titleKey, bodyKey) {
      return el('div', null,
        el('div', { style: { fontWeight: '600' } }, emoji + ' ' + t(titleKey)),
        el('div', { style: { color: 'var(--tb-text-soft)', lineHeight: '1.4' } }, t(bodyKey)),
      );
    }
    examplesGrid.appendChild(ex('📖', 'assets.upload.ex.passbook.title',   'assets.upload.ex.passbook.body'));
    examplesGrid.appendChild(ex('📄', 'assets.upload.ex.pdf.title',        'assets.upload.ex.pdf.body'));
    examplesGrid.appendChild(ex('📸', 'assets.upload.ex.screenshot.title', 'assets.upload.ex.screenshot.body'));
    examplesGrid.appendChild(ex('🖼️', 'assets.upload.ex.letter.title',     'assets.upload.ex.letter.body'));
    uploadCard.appendChild(examplesGrid);

    // 通帳 callout — JP-specific tip about uploading multi-page
    // passbooks. Even users with EN UI mode benefit (the term shows
    // with furigana via the JP annotator).
    uploadCard.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-2)',
        padding: '6px 10px',
        borderLeft: '3px solid var(--tb-accent)',
        background: 'rgba(183, 71, 42, 0.06)',
        borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)',
        color: 'var(--tb-text-soft)',
      },
    }, '💡 ' + t('assets.upload.passbook.tip')));

    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (!hasKey) {
      uploadCard.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-warn)', fontSize: 'var(--tb-fs-12)' },
      }, t('assets.upload.no_key')));
      uploadCard.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        style: { marginTop: 'var(--tb-sp-2)' },
        onclick: () => {
          close();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
        },
      }, t('assets.upload.go_settings')));
    } else {
      const fileInput = el('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf',
        style: { display: 'none' },
        onchange: (e) => {
          const f = e.target.files && e.target.files[0];
          if (f) handleAssetUpload(f);
          e.target.value = ''; // allow re-uploading same file
        },
      });
      // Opt-out chain: by default we run a 2nd Claude call to enrich
      // notes with institution metadata (HQ, support phone, wrapper
      // reminders). Pure metadata, no PII. Toggle remembered per-modal
      // session via a stored preference.
      const enrichPref = TB.state.get('settings.assets_enrich_after_upload');
      const enrichDefault = enrichPref !== false; // default on
      const enrichCheck = el('input', {
        type: 'checkbox',
        checked: enrichDefault,
        style: { marginRight: '6px' },
        onchange: (e) => {
          TB.state.set('settings.assets_enrich_after_upload', !!e.target.checked);
        },
      });
      uploadCard.appendChild(el('label', {
        style: {
          display: 'flex', alignItems: 'center', marginTop: 'var(--tb-sp-2)',
          fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', cursor: 'pointer',
        },
      }, enrichCheck, t('assets.upload.enrichToggle')));

      const uploadBtn = el('button', {
        class: 'tb-btn',
        type: 'button',
        style: { marginTop: 'var(--tb-sp-2)' },
        onclick: () => fileInput.click(),
      }, t('assets.upload.button'));
      uploadCard.appendChild(uploadBtn);
      uploadCard.appendChild(fileInput);
      // Stash a getter so handleAssetUpload can read the live checkbox state.
      uploadCard._shouldEnrich = () => !!enrichCheck.checked;

      // Drag-and-drop: the upload card itself is the drop zone, so
      // users can drag a statement directly onto the card without
      // ever opening the file picker.
      TB.utils.attachFileDrop(uploadCard, {
        accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
        text: '⤓ ' + t('assets.upload.drop'),
        onFile: (f) => handleAssetUpload(f),
        onError: (msg) => {
          uploadStatus.textContent = t('assets.upload.error', { message: msg });
          uploadStatus.style.color = 'var(--tb-error)';
        },
      });
    }
    uploadCard.appendChild(uploadStatus);
    modal.appendChild(uploadCard);

    // Build form. We hold a refs object so handlers can read other inputs
    // when computing defaults (e.g., when tax_wrapper changes, currency
    // and basis-field visibility update).
    const refs = {};

    // Apply extracted fields to draft + sync inputs. Only overwrites
    // fields that are currently empty in the draft so manual entries
    // aren't clobbered. Returns a list of fields that were filled.
    function applyExtraction(extracted) {
      if (!extracted || typeof extracted !== 'object') return [];
      const filled = [];
      const setIfEmpty = (key, value, refKey) => {
        if (value == null || value === '') return;
        const cur = draft[key];
        if (cur != null && cur !== '' && cur !== 0) return; // user already entered
        draft[key] = value;
        if (refs[refKey]) {
          if (refs[refKey].type === 'checkbox') refs[refKey].checked = !!value;
          else refs[refKey].value = String(value);
        }
        filled.push(key);
      };
      setIfEmpty('institution',          extracted.institution,           'institution');
      setIfEmpty('name',                 extracted.account_name,          'name');
      // country / currency / tax_wrapper need a select-resync pattern.
      // A NEW draft always defaults country to 'US' (see initial draft
      // shape above), so `!draft.country` is never true and extracted
      // country was silently dropped. Mirror buildRecordFromExtraction
      // (the bulk-import path): for a brand-new account the default is
      // untouched by the user, so trust the extracted value whenever it
      // differs from that default. For an edit, keep the safer
      // fill-if-empty behavior so we never clobber a real stored value.
      if (extracted.country && (!isEdit ? extracted.country !== draft.country : !draft.country)) {
        draft.country = extracted.country;
        if (refs.country) refs.country.value = extracted.country;
        filled.push('country');
      }
      if (extracted.currency) {
        // Always trust extracted currency over the default USD.
        draft.currency = extracted.currency;
        if (refs.currency) refs.currency.value = extracted.currency;
        filled.push('currency');
      }
      if (extracted.tax_wrapper_hint && WRAPPER_BY_ID[extracted.tax_wrapper_hint]) {
        draft.tax_wrapper = extracted.tax_wrapper_hint;
        if (refs.tax_wrapper) refs.tax_wrapper.value = extracted.tax_wrapper_hint;
        filled.push('tax_wrapper');
      }
      setIfEmpty('balance_native',       extracted.balance_native,        'balance');
      setIfEmpty('basis_native',         extracted.basis_native,          'basis');
      setIfEmpty('account_number_last4', extracted.account_number_last4,  'account_number_last4');
      // Stamp updated_at to the extracted as_of_date when present.
      if (extracted.as_of_date) {
        draft.updated_at = extracted.as_of_date;
        if (refs.updated_at) refs.updated_at.value = extracted.as_of_date;
        filled.push('updated_at');
      }
      // Notes: append rather than replace so we never lose user typing.
      if (extracted.notes_suggestion) {
        const existing = (draft.notes || '').trim();
        const next = existing ? existing + '\n\n' + extracted.notes_suggestion : extracted.notes_suggestion;
        draft.notes = next;
        if (refs.notes) refs.notes.value = next;
        filled.push('notes');
      }
      // Allocation hint — only apply when the user hasn't customized.
      if (extracted.allocation_hint && typeof extracted.allocation_hint === 'object') {
        const hinted = normalizeAllocation(extracted.allocation_hint);
        const hasAny = ASSET_CLASSES.some((c) => hinted[c] > 0);
        if (hasAny) {
          draft.allocation = hinted;
          if (refs.alloc) {
            for (const cls of ASSET_CLASSES) {
              refs.alloc[cls].value = hinted[cls] > 0 ? (hinted[cls] * 100).toFixed(1) : '';
            }
            updateAllocSum();
          }
          filled.push('allocation');
        }
      }
      // Reflect tax-wrapper-driven UI changes (basis field show/hide,
      // balance label currency).
      if (typeof toggleBasisField === 'function') toggleBasisField();
      if (typeof renderBalanceLabel === 'function') renderBalanceLabel();
      return filled;
    }

    // Convert one extracted entry into a complete asset record ready
    // for upsert. Defaults are filled in for any fields the model
    // didn't return so we never store partially-shaped records.
    function buildRecordFromExtraction(entry, fileName) {
      const wrapperId = entry.tax_wrapper_hint && WRAPPER_BY_ID[entry.tax_wrapper_hint]
        ? entry.tax_wrapper_hint
        : 'other';
      const wrapperMeta = WRAPPER_BY_ID[wrapperId];
      const country = entry.country || (wrapperMeta && wrapperMeta.country) || 'US';
      const currency = entry.currency || (country === 'JP' ? 'JPY' : 'USD');
      const today = TB.utils.todayIso();
      const noteParts = [];
      if (entry.notes_suggestion) noteParts.push(entry.notes_suggestion);
      noteParts.push('Extracted from ' + fileName + ' on ' + today + '.');
      // Allocation: prefer the model's hint, fall back to wrapper default.
      const hinted = entry.allocation_hint && typeof entry.allocation_hint === 'object'
        ? normalizeAllocation(entry.allocation_hint) : null;
      const allocation = (hinted && ASSET_CLASSES.some((c) => hinted[c] > 0))
        ? hinted : defaultAllocFor(wrapperId);

      return {
        id: TB.utils.uuid(),
        institution:           entry.institution || '',
        name:                  entry.account_name || '',
        country,
        tax_wrapper:           wrapperId,
        currency,
        balance_native:        (entry.balance_native != null && isFinite(entry.balance_native)) ? entry.balance_native : null,
        basis_native:          (entry.basis_native != null && isFinite(entry.basis_native)) ? entry.basis_native : null,
        account_number_last4:  entry.account_number_last4 || null,
        beneficiary:           null,
        notes:                 noteParts.join(' '),
        updated_at:            entry.as_of_date || today,
        active:                true,
        include_in_sofa:       true,
        close_date:            null,
        transfer_to:           null,
        allocation,
      };
    }

    async function handleAssetUpload(file) {
      uploadStatus.textContent = t('assets.upload.processing', { filename: file.name });
      uploadStatus.style.color = 'var(--tb-text-soft)';
      try {
        const result = await TB.ai.callClaudeVisionForAssetExtraction(file, {
          country_hint: draft.country || null,
        });
        const cost = (result.cost_usd || 0).toFixed(4);
        const ext = result.extracted || {};
        const accounts = Array.isArray(ext.accounts) ? ext.accounts.filter(Boolean) : [];

        // Empty array → nothing usable came back.
        if (accounts.length === 0) {
          uploadStatus.textContent = t('assets.upload.partial');
          uploadStatus.style.color = 'var(--tb-warn)';
          return;
        }

        // Multi-account on a NEW account (not editing) → bulk-add all
        // accounts directly. Closes the modal so the user lands on the
        // freshly populated list.
        if (accounts.length > 1 && !isEdit) {
          for (const entry of accounts) {
            upsertAccount(buildRecordFromExtraction(entry, file.name));
          }
          uploadStatus.textContent = t('assets.upload.bulkadded', { count: accounts.length, filename: file.name, cost });
          uploadStatus.style.color = 'var(--tb-success)';
          // Defer close + rerender by a tick so the success message is
          // briefly visible before the modal vanishes.
          setTimeout(() => { close(); rerender(); }, 600);
          return;
        }

        // Single account (or edit-mode) → fill the current form. When
        // editing, prefer the primary if specified, else the first.
        const primaryIdx = (typeof ext.primary_index === 'number' && ext.primary_index >= 0 && ext.primary_index < accounts.length)
          ? ext.primary_index : 0;
        const filled = applyExtraction(accounts[primaryIdx]);

        if (filled.length === 0) {
          uploadStatus.textContent = t('assets.upload.partial');
          uploadStatus.style.color = 'var(--tb-warn)';
        } else {
          uploadStatus.textContent = t('assets.upload.done', { filename: file.name, cost });
          uploadStatus.style.color = 'var(--tb-success)';
        }

        // ---- Chained enrichment ----------------------------------
        // After successful single-account extraction, run a 2nd
        // metadata-only call to fill institution details into notes.
        // Skipped if the user unchecked the toggle, or if institution
        // is empty (nothing useful to look up).
        if (filled.length > 0 && uploadCard._shouldEnrich && uploadCard._shouldEnrich() && draft.institution) {
          const enrichLine = el('div', {
            style: { marginTop: 'var(--tb-sp-1)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
          }, t('assets.upload.enriching'));
          uploadStatus.appendChild(enrichLine);
          try {
            const enrichResult = await TB.ai.enrichAssetAccountWithAi(draft);
            if (enrichResult.text) {
              const existing = (draft.notes || '').trim();
              const block = '— Institution info —\n' + enrichResult.text;
              const next = existing ? existing + '\n\n' + block : block;
              draft.notes = next;
              if (refs.notes) refs.notes.value = next;
              const enrichCost = (enrichResult.cost_usd || 0).toFixed(4);
              enrichLine.textContent = t('assets.upload.enrichDone', { cost: enrichCost });
              enrichLine.style.color = 'var(--tb-success)';
            } else {
              enrichLine.textContent = t('assets.upload.enrichEmpty');
            }
          } catch (enrichErr) {
            enrichLine.textContent = t('assets.upload.enrichError', {
              message: (enrichErr && enrichErr.message) || String(enrichErr),
            });
            enrichLine.style.color = 'var(--tb-warn)';
          }
        }

        // If editing and other accounts were also visible, list them so
        // the user can add them separately.
        if (isEdit && accounts.length > 1) {
          const others = accounts
            .filter((_, i) => i !== primaryIdx)
            .map((a) => a.account_name || a.institution)
            .filter(Boolean);
          if (others.length > 0) {
            uploadStatus.appendChild(el('div', {
              style: { marginTop: 'var(--tb-sp-1)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-warn)' },
            }, t('assets.upload.observed', { names: others.join(', ') })));
          }
        }
      } catch (err) {
        uploadStatus.textContent = t('assets.upload.error', { message: (err && err.message) || String(err) });
        uploadStatus.style.color = 'var(--tb-error)';
      }
    }

    function field(labelKey, control, helpKey) {
      const wrap = el('div', { class: 'tb-field' });
      wrap.appendChild(el('label', { class: 'tb-field-label' }, t(labelKey)));
      wrap.appendChild(control);
      if (helpKey) wrap.appendChild(el('div', { class: 'tb-field-help' }, t(helpKey)));
      return wrap;
    }

    refs.institution = el('input', {
      type: 'text', class: 'tb-input', value: draft.institution || '',
      oninput: (e) => { draft.institution = e.target.value; },
    });
    modal.appendChild(field('assets.field.institution', refs.institution, 'assets.field.institution.help'));

    refs.name = el('input', {
      type: 'text', class: 'tb-input', value: draft.name || '',
      oninput: (e) => { draft.name = e.target.value; },
    });
    modal.appendChild(field('assets.field.name', refs.name, 'assets.field.name.help'));

    // Country
    refs.country = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        draft.country = e.target.value;
        // Auto-default currency for JP selection.
        if (draft.country === 'JP' && draft.currency === 'USD') {
          draft.currency = 'JPY';
          refs.currency.value = 'JPY';
        } else if (draft.country === 'US' && draft.currency === 'JPY') {
          draft.currency = 'USD';
          refs.currency.value = 'USD';
        }
        renderBalanceLabel();
      },
    },
      el('option', { value: 'US' },    t('assets.field.country.us')),
      el('option', { value: 'JP' },    t('assets.field.country.jp')),
      el('option', { value: 'OTHER' }, t('assets.field.country.other')),
    );
    Array.from(refs.country.options).forEach((o) => { o.selected = o.value === draft.country; });
    modal.appendChild(field('assets.field.country', refs.country));

    // Tax wrapper
    refs.tax_wrapper = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        draft.tax_wrapper = e.target.value;
        // Auto-set country based on wrapper.
        const wMeta = WRAPPER_BY_ID[draft.tax_wrapper];
        if (wMeta && wMeta.country !== 'OTHER') {
          draft.country = wMeta.country;
          refs.country.value = wMeta.country;
          if (wMeta.country === 'JP' && draft.currency === 'USD') {
            draft.currency = 'JPY'; refs.currency.value = 'JPY';
          }
        }
        toggleBasisField();
        renderBalanceLabel();
      },
    });
    for (const w of WRAPPERS) {
      refs.tax_wrapper.appendChild(el('option', { value: w.id }, t('assets.wrapper.' + w.id)));
    }
    Array.from(refs.tax_wrapper.options).forEach((o) => { o.selected = o.value === draft.tax_wrapper; });
    modal.appendChild(field('assets.field.tax_wrapper', refs.tax_wrapper));

    // Currency
    refs.currency = el('select', {
      class: 'tb-select',
      onchange: (e) => { draft.currency = e.target.value; renderBalanceLabel(); },
    });
    for (const c of CURRENCIES) {
      refs.currency.appendChild(el('option', { value: c }, c));
    }
    Array.from(refs.currency.options).forEach((o) => { o.selected = o.value === draft.currency; });
    modal.appendChild(field('assets.field.currency', refs.currency));

    // Balance (native)
    const balanceWrap = el('div', { class: 'tb-field' });
    const balanceLabel = el('label', { class: 'tb-field-label' });
    refs.balance = el('input', {
      type: 'number', class: 'tb-input', step: 'any',
      value: draft.balance_native != null ? draft.balance_native : '',
      oninput: (e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        draft.balance_native = isFinite(v) ? v : null;
      },
    });
    balanceWrap.appendChild(balanceLabel);
    balanceWrap.appendChild(refs.balance);
    modal.appendChild(balanceWrap);

    function renderBalanceLabel() {
      balanceLabel.textContent = t('assets.field.balance.native', { currency: draft.currency || 'USD' });
    }
    renderBalanceLabel();

    // Basis (taxable / real estate only)
    const basisWrap = el('div', { class: 'tb-field' });
    refs.basis = el('input', {
      type: 'number', class: 'tb-input', step: 'any',
      value: draft.basis_native != null ? draft.basis_native : '',
      oninput: (e) => {
        const v = e.target.value === '' ? null : Number(e.target.value);
        draft.basis_native = isFinite(v) ? v : null;
      },
    });
    basisWrap.appendChild(el('label', { class: 'tb-field-label' }, t('assets.field.basis')));
    basisWrap.appendChild(refs.basis);
    basisWrap.appendChild(el('div', { class: 'tb-field-help' }, t('assets.field.basis.help')));
    modal.appendChild(basisWrap);

    function toggleBasisField() {
      const wMeta = WRAPPER_BY_ID[draft.tax_wrapper];
      basisWrap.style.display = (wMeta && wMeta.basis) ? '' : 'none';
    }
    toggleBasisField();

    // Account number last-4 (display-only disambiguation)
    refs.account_number_last4 = el('input', {
      type: 'text', class: 'tb-input',
      maxlength: '4', pattern: '[0-9]{0,4}',
      value: draft.account_number_last4 || '',
      placeholder: '1234',
      oninput: (e) => {
        const v = String(e.target.value || '').replace(/[^0-9]/g, '').slice(0, 4);
        e.target.value = v;
        draft.account_number_last4 = v || null;
      },
    });
    modal.appendChild(field('assets.field.account_number_last4', refs.account_number_last4, 'assets.field.account_number_last4.help'));

    // Asset allocation — 6 % inputs + "Use defaults" button.
    // The draft.allocation working copy starts as the existing
    // explicit allocation, OR the wrapper default if none set. The
    // user can leave at default or override per-class. Sum is shown
    // live; auto-normalized on save.
    if (!draft.allocation || !ASSET_CLASSES.some((c) => Number(draft.allocation[c]) > 0)) {
      draft.allocation = defaultAllocFor(draft.tax_wrapper);
    }

    refs.alloc = {};
    const allocSumLabel = el('span', {
      style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' },
    }, '100%');

    function updateAllocSum() {
      let s = 0;
      for (const cls of ASSET_CLASSES) {
        const v = parseFloat(refs.alloc[cls].value);
        if (isFinite(v) && v > 0) s += v;
      }
      allocSumLabel.textContent = s.toFixed(1) + '%';
      allocSumLabel.style.color = (Math.abs(s - 100) < 0.5)
        ? 'var(--tb-success)'
        : (s > 0 ? 'var(--tb-warn)' : 'var(--tb-text-soft)');
    }

    function syncAllocInputsFromDraft() {
      for (const cls of ASSET_CLASSES) {
        const v = (draft.allocation && draft.allocation[cls]) || 0;
        refs.alloc[cls].value = v > 0 ? (v * 100).toFixed(1) : '';
      }
      updateAllocSum();
    }

    const allocGrid = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 'var(--tb-sp-2)',
        marginTop: 'var(--tb-sp-2)',
      },
    });
    for (const cls of ASSET_CLASSES) {
      const input = el('input', {
        type: 'number',
        class: 'tb-input',
        min: '0', max: '100', step: '0.1',
        style: { fontFamily: 'var(--tb-font-mono)' },
        value: ((draft.allocation && draft.allocation[cls]) || 0) > 0
          ? ((draft.allocation[cls] * 100).toFixed(1))
          : '',
        oninput: () => updateAllocSum(),
      });
      refs.alloc[cls] = input;
      allocGrid.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)' } },
        el('span', { style: {
          width: '12px', height: '12px', borderRadius: '50%',
          background: ASSET_CLASS_COLOR[cls], display: 'inline-block', flexShrink: '0',
        } }),
        el('label', { style: { flex: '1', fontSize: 'var(--tb-fs-12)' } },
          t('assets.alloc.' + cls)),
        input,
        el('span', { style: { color: 'var(--tb-text-soft)' } }, '%'),
      ));
    }

    const allocFooter = el('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)',
      },
    },
      el('button', {
        class: 'tb-btn tb-btn--ghost',
        type: 'button',
        style: { padding: '2px 10px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          draft.allocation = defaultAllocFor(draft.tax_wrapper);
          syncAllocInputsFromDraft();
        },
      }, t('assets.alloc.useDefault')),
      el('div', null,
        el('span', { style: { color: 'var(--tb-text-soft)', marginRight: 'var(--tb-sp-1)' } },
          t('assets.alloc.sum')), allocSumLabel),
    );

    const allocWrap = el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('assets.alloc.label')),
      el('div', { class: 'tb-field-help' }, t('assets.alloc.help')),
      allocGrid,
      allocFooter,
    );
    modal.appendChild(allocWrap);
    updateAllocSum();

    // When the wrapper changes and the user hasn't customized
    // allocation, slide the allocation inputs to the new default.
    // Detect "uncustomized" by comparing current draft to old wrapper's default.
    const __origToggleBasis = toggleBasisField;
    toggleBasisField = function () {
      __origToggleBasis();
      // If allocation matches old wrapper's default, swap to new wrapper's default.
      // Otherwise leave the user's customization alone.
      const newDefault = defaultAllocFor(draft.tax_wrapper);
      let isDefault = true;
      for (const cls of ASSET_CLASSES) {
        const cur = (draft.allocation && draft.allocation[cls]) || 0;
        const def = (defaultAllocFor(refs.tax_wrapper.dataset._lastWrapper || draft.tax_wrapper)[cls]) || 0;
        if (Math.abs(cur - def) > 0.001) { isDefault = false; break; }
      }
      if (isDefault) {
        draft.allocation = newDefault;
        syncAllocInputsFromDraft();
      }
      refs.tax_wrapper.dataset._lastWrapper = draft.tax_wrapper;
    };
    refs.tax_wrapper.dataset._lastWrapper = draft.tax_wrapper;

    // Beneficiary
    refs.beneficiary = el('input', {
      type: 'text', class: 'tb-input',
      value: draft.beneficiary || '',
      oninput: (e) => { draft.beneficiary = e.target.value || null; },
    });
    modal.appendChild(field('assets.field.beneficiary', refs.beneficiary, 'assets.field.beneficiary.help'));

    // FBAR linkage info (read-only) + Detach button.
    if (draft.fbar_account_id) {
      const fbarAcct = (TB.state.get('fbar.accounts') || []).find((fa) => fa.id === draft.fbar_account_id);
      const fbarBox = el('div', {
        style: {
          background: 'rgba(14, 42, 79, 0.06)',
          borderLeft: '3px solid var(--tb-navy)',
          borderRadius: 'var(--tb-radius-2)',
          padding: 'var(--tb-sp-3)',
          marginBottom: 'var(--tb-sp-4)',
        },
      },
        el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
          '🔗 ' + t('assets.fbar.linked.label')),
        el('p', { class: 'tb-field-help', style: { margin: '0 0 var(--tb-sp-2)' } },
          t('assets.fbar.linked.detail') +
          (fbarAcct ? ' — ' + (fbarAcct.institution_name || '(unnamed)') : '')),
        el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 10px', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-error)' },
          onclick: () => {
            if (!confirm(t('assets.fbar.detach.confirm'))) return;
            // Only clear the FBAR link — persist against a fresh clone
            // of the STORED record (not the in-progress `draft`), so we
            // never commit unsaved/un-normalized edits (e.g. a typo'd
            // balance or an allocation that hasn't gone through the
            // Save handler's normalizeAllocation pass) that happen to
            // be sitting in the form when the user clicks Detach.
            const stored = findById(draft.id);
            if (stored) {
              const clean = Object.assign({}, stored, { fbar_account_id: null });
              upsertAccount(clean);
            }
            draft.fbar_account_id = null;
            close();
            rerender();
          },
        }, t('assets.fbar.detach.button')),
      );
      modal.appendChild(fbarBox);
    }

    // Notes
    refs.notes = el('textarea', {
      class: 'tb-textarea',
      oninput: (e) => { draft.notes = e.target.value; },
    });
    refs.notes.value = draft.notes || '';
    modal.appendChild(field('assets.field.notes', refs.notes, 'assets.field.notes.help'));

    // Updated date
    refs.updated_at = el('input', {
      type: 'date', class: 'tb-input',
      value: draft.updated_at || TB.utils.todayIso(),
      onchange: (e) => { draft.updated_at = e.target.value || null; },
    });
    modal.appendChild(field('assets.field.updated_at', refs.updated_at));

    // Include in SOFA
    const incWrap = el('label', {
      class: 'tb-checkbox',
      style: { cursor: 'pointer' },
    });
    refs.include = el('input', {
      type: 'checkbox',
      checked: draft.include_in_sofa !== false,
      onchange: (e) => { draft.include_in_sofa = e.target.checked; },
    });
    incWrap.appendChild(refs.include);
    incWrap.appendChild(el('div', null,
      el('div', null, t('assets.field.include_in_sofa')),
      el('small', null, t('assets.field.include_in_sofa.help')),
    ));
    modal.appendChild(incWrap);

    // Close date
    refs.close_date = el('input', {
      type: 'date', class: 'tb-input',
      value: draft.close_date || '',
      onchange: (e) => { draft.close_date = e.target.value || null; },
    });
    modal.appendChild(field('assets.field.close_date', refs.close_date));

    // Transfer-to (only meaningful if close_date set)
    refs.transfer_to = el('input', {
      type: 'text', class: 'tb-input',
      value: draft.transfer_to || '',
      placeholder: lang === 'ja' ? '例: Navy Federal MMA' : 'e.g. Navy Federal MMA',
      oninput: (e) => { draft.transfer_to = e.target.value || null; },
    });
    modal.appendChild(field('assets.field.transfer_to', refs.transfer_to));

    // Buttons
    const btnRow = el('div', { class: 'tb-btn-row', style: { justifyContent: 'space-between', marginTop: 'var(--tb-sp-5)' } });

    const leftBtns = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    if (isEdit) {
      leftBtns.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger',
        type: 'button',
        onclick: () => {
          if (window.confirm(t('assets.modal.delete.confirm'))) {
            deleteAccount(draft.id);
            close();
            rerender();
          }
        },
      }, t('assets.delete')));
    }

    const rightBtns = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    rightBtns.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      onclick: close,
    }, t('assets.modal.cancel')));
    rightBtns.appendChild(el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: () => {
        // Read live allocation values from inputs, normalize, persist.
        // Treat blank inputs as 0; auto-normalize so save always
        // produces an allocation summing to 1.0 (or all-zero when
        // the user explicitly wants no allocation tracking).
        const rawAlloc = {};
        for (const cls of ASSET_CLASSES) {
          const v = parseFloat(refs.alloc[cls].value);
          rawAlloc[cls] = (isFinite(v) && v > 0) ? v / 100 : 0;
        }
        draft.allocation = normalizeAllocation(rawAlloc);
        upsertAccount(draft);
        close();
        rerender();
      },
    }, t('assets.modal.save')));

    btnRow.appendChild(leftBtns);
    btnRow.appendChild(rightBtns);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Survivor Binder export
  // ====================================================================
  //
  // Generates a printable HTML doc — what a spouse / executor / trusted
  // friend would need to find every account, the last-4 to disambiguate
  // it, the beneficiary, balance, and any close-date or notes. Opens
  // in a new window with print-optimized CSS and auto-triggers
  // window.print() on load.
  //
  // No PII leaves the browser — this is a pure local render.

  function escapeHtml(s) { return TB.utils.escapeHtml(s); }

  function buildSurvivorBinderHtml() {
    const profile = TB.state.get('profile') || {};
    const lang = TB.i18n.getLang();
    const t = TB.i18n.t;
    const todayIso = TB.utils.todayIso();
    const accounts = getActiveAccounts();

    // Sort: country (US, JP, OTHER), then institution alpha, then name.
    const countryOrder = { US: 1, JP: 2, OTHER: 3 };
    accounts.sort((a, b) => {
      const ca = countryOrder[a.country || 'OTHER'] || 99;
      const cb = countryOrder[b.country || 'OTHER'] || 99;
      if (ca !== cb) return ca - cb;
      const ia = (a.institution || '').toLowerCase();
      const ib = (b.institution || '').toLowerCase();
      if (ia !== ib) return ia.localeCompare(ib);
      return (a.name || '').localeCompare(b.name || '');
    });

    // Group by country → institution.
    const byCountryInst = {};
    for (const a of accounts) {
      const c = a.country || 'OTHER';
      const i = a.institution || (lang === 'ja' ? '(未指定)' : '(Unspecified)');
      if (!byCountryInst[c]) byCountryInst[c] = {};
      if (!byCountryInst[c][i]) byCountryInst[c][i] = [];
      byCountryInst[c][i].push(a);
    }

    const totalUsdVal = totalUsd();

    function fmtBalanceLine(a) {
      const native = fmtNative(a.balance_native, a.currency);
      if (!a.currency || a.currency === 'USD') return escapeHtml(native);
      const usd = TB.utils.formatUSD(toUsd(a.balance_native, a.currency), { maximumFractionDigits: 0 });
      return escapeHtml(native) + ' <span class="usd">(≈ ' + escapeHtml(usd) + ')</span>';
    }

    function accountBlock(a) {
      const wrapperLabel = t('assets.wrapper.' + (a.tax_wrapper || 'other'));
      const rows = [];
      rows.push('<tr><th>' + escapeHtml(t('assets.field.tax_wrapper')) + '</th><td>' + escapeHtml(wrapperLabel) + '</td></tr>');
      if (a.account_number_last4) {
        rows.push('<tr><th>' + escapeHtml(t('assets.field.account_number_last4')) + '</th><td><code>••••' + escapeHtml(a.account_number_last4) + '</code></td></tr>');
      }
      rows.push('<tr><th>' + escapeHtml(t('assets.field.balance')) + '</th><td>' + fmtBalanceLine(a) + '</td></tr>');
      if (a.basis_native != null) {
        rows.push('<tr><th>' + escapeHtml(t('assets.field.basis')) + '</th><td>' + escapeHtml(fmtNative(a.basis_native, a.currency)) + '</td></tr>');
      }
      if (a.beneficiary) {
        rows.push('<tr><th>' + escapeHtml(t('assets.field.beneficiary')) + '</th><td><strong>' + escapeHtml(a.beneficiary) + '</strong></td></tr>');
      }
      if (a.close_date) {
        const tx = a.transfer_to ? ' → ' + a.transfer_to : '';
        rows.push('<tr><th>' + escapeHtml(t('assets.field.close_date')) + '</th><td>' + escapeHtml(a.close_date + tx) + '</td></tr>');
      }
      rows.push('<tr><th>' + escapeHtml(t('assets.field.updated_at')) + '</th><td>' + escapeHtml(a.updated_at || '—') + '</td></tr>');
      if (a.notes) {
        rows.push('<tr><th>' + escapeHtml(t('assets.field.notes')) + '</th><td class="notes">' + escapeHtml(a.notes) + '</td></tr>');
      }

      return '' +
        '<div class="account">' +
          '<h4>' + escapeHtml(a.name || '(unnamed)') + '</h4>' +
          '<table>' + rows.join('') + '</table>' +
        '</div>';
    }

    function countrySection(country, label) {
      const insts = byCountryInst[country];
      if (!insts) return '';
      const instNames = Object.keys(insts).sort((x, y) => x.localeCompare(y));
      let html = '<section class="country-section"><h2>' + escapeHtml(label) + '</h2>';
      for (const inst of instNames) {
        html += '<div class="institution"><h3>' + escapeHtml(inst) + '</h3>';
        for (const a of insts[inst]) html += accountBlock(a);
        html += '</div>';
      }
      html += '</section>';
      return html;
    }

    const displayName = profile.displayName || (lang === 'ja' ? '(本人)' : '(Account holder)');

    const css = '' +
      '@page { size: A4; margin: 18mm; }' +
      'html, body { font-family: Georgia, "Times New Roman", serif; color: #111; line-height: 1.5; }' +
      'body { max-width: 760px; margin: 0 auto; padding: 24px; }' +
      'h1 { font-size: 22pt; margin: 0 0 6pt; }' +
      'h2 { font-size: 16pt; margin: 28pt 0 10pt; padding-bottom: 4pt; border-bottom: 2px solid #444; page-break-before: always; }' +
      'h2:first-of-type { page-break-before: auto; }' +
      'h3 { font-size: 13pt; margin: 18pt 0 6pt; color: #333; }' +
      'h4 { font-size: 12pt; margin: 10pt 0 4pt; }' +
      '.subtitle { color: #555; margin-top: 0; }' +
      '.summary-box { border: 1px solid #999; padding: 10pt 14pt; margin: 18pt 0; background: #fafafa; }' +
      '.summary-box .total { font-size: 20pt; font-weight: 700; }' +
      '.preamble { background: #fffaf0; border-left: 3px solid #b97a1a; padding: 10pt 14pt; margin: 14pt 0; font-size: 11pt; }' +
      '.account { margin: 8pt 0 14pt 0; padding: 6pt 0 0 0; border-top: 1px dotted #aaa; page-break-inside: avoid; }' +
      'table { width: 100%; border-collapse: collapse; font-size: 11pt; }' +
      'table th { text-align: left; font-weight: normal; color: #555; vertical-align: top; padding: 2pt 8pt 2pt 0; width: 28%; }' +
      'table td { padding: 2pt 0; vertical-align: top; }' +
      'td.notes { white-space: pre-wrap; color: #333; }' +
      '.usd { color: #777; }' +
      'code { font-family: "SFMono-Regular", Consolas, Menlo, monospace; font-size: 10.5pt; }' +
      'footer { margin-top: 36pt; padding-top: 10pt; border-top: 1px solid #aaa; color: #555; font-size: 9.5pt; line-height: 1.4; }' +
      '@media print { .no-print { display: none; } }';

    const preamble = lang === 'ja'
      ? 'これは Taigan Bridge から生成された口座一覧です。緊急時に家族や信頼できる人物が金融資産にアクセスするための補助資料として作成されました。'
      : 'This is an account inventory generated by Taigan Bridge. It is intended to help a spouse, executor, or trusted person locate and access financial accounts in an emergency.';
    const verifyNote = lang === 'ja'
      ? '残高や受取人指定は変更されることがあります。実行前に必ず各金融機関で最新情報を確認してください。'
      : 'Balances and beneficiary designations change. Always verify the current state with each institution before acting.';

    const titleStr = (lang === 'ja' ? 'Survivor Binder · 緊急時口座一覧' : 'Survivor Binder · Account Inventory');
    const generatedLabel = lang === 'ja' ? '作成日: ' : 'Generated: ';
    const totalLabel = t('assets.summary.total');
    const totalUsdLabel = lang === 'ja' ? 'USD 合計' : 'Total (USD)';
    const acctCountLabel = lang === 'ja' ? '口座数' : 'Active accounts';
    const printLabel = lang === 'ja' ? '印刷 / PDF 保存' : 'Print / Save as PDF';
    const closeLabel = lang === 'ja' ? '閉じる' : 'Close';

    const sections =
      countrySection('US',    lang === 'ja' ? '🇺🇸 米国口座' : '🇺🇸 United States') +
      countrySection('JP',    lang === 'ja' ? '🇯🇵 日本口座' : '🇯🇵 Japan')         +
      countrySection('OTHER', lang === 'ja' ? '🌐 その他'   : '🌐 Other');

    return '' +
      '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(titleStr) + ' — ' + escapeHtml(displayName) + '</title>' +
      '<style>' + css + '</style></head><body>' +
      '<div class="no-print" style="text-align:right; margin-bottom:12pt;">' +
        '<button onclick="window.print()" style="margin-right:6pt;">' + escapeHtml(printLabel) + '</button>' +
        '<button onclick="window.close()">' + escapeHtml(closeLabel) + '</button>' +
      '</div>' +
      '<h1>' + escapeHtml(titleStr) + '</h1>' +
      '<p class="subtitle">' + escapeHtml(displayName) + '  ·  ' + escapeHtml(generatedLabel + todayIso) + '</p>' +
      '<div class="preamble">' + escapeHtml(preamble) + '</div>' +
      '<div class="summary-box">' +
        '<div>' + escapeHtml(totalLabel) + '</div>' +
        '<div class="total">' + escapeHtml(TB.utils.formatUSD(totalUsdVal, { maximumFractionDigits: 0 })) + '</div>' +
        '<div style="margin-top:6pt; font-size:10pt; color:#555;">' +
          escapeHtml(acctCountLabel + ': ' + accounts.length) +
        '</div>' +
      '</div>' +
      sections +
      buildBinderDocumentsHtml(lang) +
      '<footer>' +
        '<div>' + escapeHtml(verifyNote) + '</div>' +
        '<div style="margin-top:6pt;">Generated by Taigan Bridge · 対岸 — financial planning organizer for Americans in Japan.</div>' +
      '</footer>' +
      '</body></html>';
  }

  // Build the Documents section of the Survivor Binder. Pulls from
  // TB.docVault.getDocsForBinder() — returns empty string if the
  // Document Vault module isn't loaded or has no items.
  function buildBinderDocumentsHtml(lang) {
    if (!TB.docVault || typeof TB.docVault.getDocsForBinder !== 'function') return '';
    const groups = TB.docVault.getDocsForBinder();
    if (!groups || groups.length === 0) return '';
    const sectionTitle = lang === 'ja' ? '📄 重要書類' : '📄 Important Documents';
    const sectionIntro = lang === 'ja'
      ? '実物の保管場所(下記)を確認してください。本書類はインベントリのみで、原本のスキャンは含まれません。'
      : 'Look up the storage location (below) for each document. This binder is an inventory only — original scans are NOT stored here.';
    let html = '<section class="country-section"><h2>' + escapeHtml(sectionTitle) + '</h2>';
    html += '<p style="font-style: italic; color: #555;">' + escapeHtml(sectionIntro) + '</p>';
    for (const group of groups) {
      const groupLabel = group.emoji + ' ' + (lang === 'ja' ? group.label_jp : group.label_en);
      html += '<div class="institution"><h3>' + escapeHtml(groupLabel) + '</h3>';
      for (const it of group.items) {
        const typeLabel = (TB.docVault.typeLabel && TB.docVault.typeLabel(it.type, lang)) || it.type;
        const rows = [];
        rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '種類' : 'Type') + '</th><td>' + escapeHtml(typeLabel) + '</td></tr>');
        if (it.person_name) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '対象者' : 'Person') + '</th><td>' + escapeHtml(it.person_name) + '</td></tr>');
        }
        if (it.reference_number_last4) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '番号(下4桁)' : 'Ref # (last 4)') + '</th><td><code>••••' + escapeHtml(it.reference_number_last4) + '</code></td></tr>');
        }
        if (it.issuing_authority) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '発行元' : 'Issuing authority') + '</th><td>' + escapeHtml(it.issuing_authority) + '</td></tr>');
        }
        if (it.issue_date) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '発行日' : 'Issued') + '</th><td>' + escapeHtml(it.issue_date) + '</td></tr>');
        }
        if (it.expiry_date) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '有効期限' : 'Expires') + '</th><td><strong>' + escapeHtml(it.expiry_date) + '</strong></td></tr>');
        }
        if (it.storage_location) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '📍 保管場所' : '📍 Storage location') + '</th><td><strong>' + escapeHtml(it.storage_location) + '</strong></td></tr>');
        }
        if (it.notes) {
          rows.push('<tr><th>' + escapeHtml(lang === 'ja' ? '備考' : 'Notes') + '</th><td class="notes">' + escapeHtml(it.notes) + '</td></tr>');
        }
        html += '<div class="account">' +
          '<h4>' + escapeHtml(it.title || typeLabel) + '</h4>' +
          '<table>' + rows.join('') + '</table>' +
        '</div>';
      }
      html += '</div>';
    }
    html += '</section>';
    return html;
  }

  function openSurvivorBinder() {
    const html = buildSurvivorBinderHtml();
    const w = window.open('', '_blank');
    if (!w) {
      alert(TB.i18n.t('assets.survivorBinder.popupBlocked'));
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'Assets',
    label_jp: '資産',
    render,
  };

  // Action Center generators — surface the new review-card insights as
  // dashboard action items so users see them without opening Assets.
  function genBeneficiaryMissing() {
    const out = [];
    const missing = accountsMissingBeneficiary();
    if (missing.length === 0) return out;
    out.push({
      id: 'assets_beneficiary_missing',
      group: 'assets', urgency: 'medium', icon: '👥',
      title: TB.i18n.t('assets.action.beneficiaryMissing.title', { count: missing.length }),
      body: TB.i18n.t('assets.action.beneficiaryMissing.body'),
      module: 'assets', snoozable: true,
    });
    return out;
  }
  function genTaxLossOpportunity() {
    const out = [];
    const m = new Date().getMonth() + 1;
    // Only fire in Oct-Dec — the harvesting window before year-end.
    if (m < 10) return out;
    const opps = scanTaxLossHarvest({ minLossUsd: 1000 });
    if (opps.length === 0) return out;
    const totalLoss = opps.reduce((s, o) => s + o.loss_usd, 0);
    out.push({
      id: 'assets_tlh_opportunity_' + new Date().getFullYear(),
      group: 'assets', urgency: 'low', icon: '🍂',
      title: TB.i18n.t('assets.action.tlhOpportunity.title', { amount: '$' + Math.round(totalLoss).toLocaleString() }),
      body: TB.i18n.t('assets.action.tlhOpportunity.body', { count: opps.length }),
      module: 'assets', snoozable: true,
    });
    return out;
  }

  // Public API consumed by other modules (notably SOFA Roth Planner).
  window.TB.assets = {
    aggregateForSofa,
    totalUsd,
    totalUsdByCountry,
    totalUsdByWrapper,
    getActiveAccounts,
    getAccountsForWrapper,
    WRAPPERS,
    WRAPPER_BY_ID,
    toUsd,
    fxIsLive,
    buildSurvivorBinderHtml,
    openSurvivorBinder,
    // Snapshot management — used by Net Worth & Reports module.
    takeSnapshot,
    deleteSnapshot,
    portfolioAllocation,
    // Asset deepening (v0.35) — analytical helpers for other modules
    // (CPA briefing, year-end checkup, projections).
    computeUnrealizedGain,
    unrealizedGainSummary,
    accountsMissingBeneficiary,
    scanTaxLossHarvest,
    yoyChangePerAccount,
    // Action Center surfacing
    actionGenerators: [genBeneficiaryMissing, genTaxLossOpportunity],
  };
})();
