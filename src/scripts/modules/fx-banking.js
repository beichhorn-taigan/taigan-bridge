/* Taigan Bridge — modules/fx-banking.js
 *
 * FX & Cross-Border Banking — daily-decision module for the routine
 * USD↔JPY questions every JP-resident US person faces:
 *
 *   - Which platform to use for transfers?
 *   - When to convert (and how much)?
 *   - How to hold multi-currency?
 *   - What's the actual delivered rate after fees?
 *
 * Cards:
 *   1. Header
 *   2. Current FX snapshot (uses utils.refreshCurrentFx + cached rates)
 *   3. Transfer cost calculator (input USD → see what each platform delivers)
 *   4. Platform comparison matrix
 *   5. Account-by-purpose decision tree
 *   6. Multi-currency holding strategy
 *   7. Rate alerts (configurable thresholds)
 *   8. Resources
 *
 * The platform fee figures below are illustrative defaults based on
 * publicly published rates as of mid-2026. Rates drift quarterly;
 * users can override per-platform in the comparison card.
 */

(function () {
  'use strict';

  const id = 'fx-banking';

  // ====================================================================
  // Reference data — platforms
  // ====================================================================

  // Each platform: id, name, type, direction, typical fee structure.
  // Fee fields are mid-2026 published-rate approximations; users can
  // override via the recorded_fees state for their actual experience.
  //
  // typical_spread_bps: extra basis points charged above mid-market rate
  // typical_fee_pct: percentage fee on top of spread (Wise model)
  // fixed_fee_usd: flat per-transfer fee (wire model)
  const PLATFORMS = [
    {
      id: 'wise',
      name: 'Wise',
      type: 'fintech',
      direction: 'both',
      typical_spread_bps: 0,                 // mid-market
      typical_fee_pct: 0.55,                 // ~0.4-0.7%
      fixed_fee_usd: 0,
      speed: 'minutes-to-hours',
      pricing_url: 'https://wise.com/us/pricing/send-money',
      pros: ['Mid-market rate', 'Multi-currency hold (USD + JPY balances)', 'Low cost for amounts ≤$50K'],
      cons: ['Per-transaction limits ($50K typical)', 'Cumulative annual limits exist'],
    },
    {
      id: 'sony_bank',
      name: 'Sony Bank',
      type: 'jp_bank',
      direction: 'both',
      typical_spread_bps: 25,                // ~0.25%
      typical_fee_pct: 0,
      fixed_fee_usd: 0,
      speed: 'instant-to-1d',
      pricing_url: 'https://moneykit.net/visitor/fx/fx05.html',
      pros: ['JP online bank with USD account', 'Instant FX between USD ↔ JPY balances', 'Reasonable for ongoing residents'],
      cons: ['Monthly FX-trade caps for promotional rate', 'JP bank account required (not for SOFA-only users)'],
    },
    {
      id: 'shinsei',
      name: 'Shinsei (PowerFlex / SBI Shinsei)',
      type: 'jp_bank',
      direction: 'both',
      typical_spread_bps: 50,
      typical_fee_pct: 0,
      fixed_fee_usd: 0,
      speed: 'instant-to-1d',
      pricing_url: 'https://www.sbishinseibank.co.jp/english/retail/foreign_currency/',
      pros: ['English banking interface', 'USD account', 'Foreign-friendly account opening'],
      cons: ['Spread less competitive than Wise/Sony', 'ATM withdrawal limits abroad'],
    },
    {
      id: 'sbi_sumishin',
      name: 'SBI Sumishin Net Bank',
      type: 'jp_bank',
      direction: 'both',
      typical_spread_bps: 15,                // very competitive
      typical_fee_pct: 0,
      fixed_fee_usd: 0,
      speed: 'instant-to-1d',
      pricing_url: 'https://www.netbk.co.jp/contents/service/foreign_currency/',
      pros: ['Among the best JP-bank FX spreads', 'Strong online interface', 'JP residency required'],
      cons: ['JP-only signup; mostly Japanese interface'],
    },
    {
      id: 'schwab_us',
      name: 'Schwab International (wire from US)',
      type: 'us_brokerage',
      direction: 'usd_to_jpy',
      typical_spread_bps: 100,               // ~1% on cash transfer
      typical_fee_pct: 0,
      fixed_fee_usd: 25,                     // outgoing wire
      speed: '1-3d',
      pricing_url: 'https://www.schwab.com/legal/schwab-pricing-guide',
      pros: ['Best for moving large amounts at once ($100K+)', 'Treasury-direct holding remains', 'Schwab debit card refunds ATM fees worldwide'],
      cons: ['Wire fee + spread combo', 'Slower than fintech', 'Schwab brokerage account required'],
    },
    {
      id: 'revolut',
      name: 'Revolut',
      type: 'fintech',
      direction: 'both',
      typical_spread_bps: 0,                 // mid-market on weekdays
      typical_fee_pct: 0,                    // free under monthly limit
      fixed_fee_usd: 0,
      speed: 'minutes-to-hours',
      pricing_url: 'https://www.revolut.com/en-US/our-pricing-plans/',
      pros: ['Free FX up to monthly cap (~$1K-$5K depending on tier)', 'Multi-currency wallet', 'Weekday mid-market rate'],
      cons: ['Weekend markup ~1%', 'JP availability via Revolut Japan limited', 'Free tier caps apply'],
    },
    {
      id: 'paypal_xoom',
      name: 'PayPal / Xoom',
      type: 'fintech',
      direction: 'usd_to_jpy',
      typical_spread_bps: 200,               // ~2%
      typical_fee_pct: 0,
      fixed_fee_usd: 5,
      speed: 'hours',
      pricing_url: 'https://www.xoom.com/japan/send-money',
      pros: ['Easy onboarding for one-off transfers', 'Brand recognition'],
      cons: ['Worse FX spread than Wise/banks', 'Limits on receiving amounts'],
    },
    {
      id: 'jp_megabank_wire',
      name: 'JP megabank (MUFG / Mizuho / SMBC) — incoming USD wire',
      type: 'jp_bank',
      direction: 'usd_to_jpy',
      typical_spread_bps: 100,
      typical_fee_pct: 0,
      fixed_fee_usd: 30,                     // ¥4,500 typical lifting/recv fee
      speed: '1-3d',
      pricing_url: 'https://www.bk.mufg.jp/global/global_e/fees/index.html',
      pros: ['Universal availability', 'Necessary if your JP employer pays in JPY only via megabank'],
      cons: ['Worst-of-class spread', 'Lifting fees + receiving fees stack', 'Only consider for must-use cases'],
    },
  ];

  // Returns the fee fields for a platform, preferring user-recorded
  // overrides (from the "Update fees" workflow) over the hardcoded
  // typical values. The override carries last_verified_at so the UI
  // can show staleness.
  function effectiveFees(platform) {
    const recorded = (TB.state.get('fx_banking.recorded_fees') || {})[platform.id];
    if (recorded) {
      return {
        spread_bps: recorded.spread_bps != null ? recorded.spread_bps : platform.typical_spread_bps,
        fee_pct:    recorded.fee_pct    != null ? recorded.fee_pct    : platform.typical_fee_pct,
        fixed_fee:  recorded.fixed_fee_usd != null ? recorded.fixed_fee_usd : platform.fixed_fee_usd,
        last_verified_at: recorded.last_verified_at || null,
        is_user_recorded: true,
        source_url: recorded.source_url || platform.pricing_url || null,
        notes: recorded.notes || '',
      };
    }
    return {
      spread_bps: platform.typical_spread_bps,
      fee_pct:    platform.typical_fee_pct,
      fixed_fee:  platform.fixed_fee_usd,
      last_verified_at: null,
      is_user_recorded: false,
      source_url: platform.pricing_url || null,
      notes: '',
    };
  }

  // Days since last user-recorded verification (or null if never).
  function feeAgeDays(platform) {
    const f = effectiveFees(platform);
    if (!f.last_verified_at) return null;
    const ms = Date.now() - new Date(f.last_verified_at).getTime();
    return Math.floor(ms / 86400000);
  }

  // What this platform actually delivers, in either direction.
  //
  // Args:
  //   platform — entry from PLATFORMS
  //   amount   — number, in the SOURCE currency (USD if usd_to_jpy,
  //              JPY if jpy_to_usd)
  //   midRate  — JPY per 1 USD (mid-market reference)
  //   direction — 'usd_to_jpy' (default, back-compat) | 'jpy_to_usd'
  //
  // The fee model:
  //   - spread_bps reduces the rate the user receives (always
  //     disadvantageous, regardless of direction)
  //   - fee_pct is a percentage on the source amount
  //   - fixed_fee is a per-transfer flat fee, denominated in USD by
  //     convention (matches how all the platform configs were captured)
  //
  // For JPY→USD we convert the USD-denominated fixed fee into JPY at
  // the mid rate before subtracting from the source side, so the same
  // fee is felt whichever way money moves.
  //
  // Returns a normalized result with `delivered` / `delivered_currency`
  // and `effective_rate` (always JPY per USD, for stable sorting).
  // The `jpy_delivered` / `total_cost_jpy` legacy fields stay populated
  // for any caller that wasn't updated. Total cost is reported in BOTH
  // currencies so callers don't have to convert.
  function platformDelivers(platform, amount, midRate, direction) {
    if (!isFinite(amount) || amount <= 0) return null;
    direction = direction || 'usd_to_jpy';
    const fees = effectiveFees(platform);
    const spreadFactor = 1 - ((fees.spread_bps || 0) / 10000);
    const effectiveRate = midRate * spreadFactor; // JPY/USD after spread
    const fixedFeeUsd = fees.fixed_fee || 0;
    const feePct = (fees.fee_pct || 0) / 100;

    let delivered, deliveredCurrency, sourceCurrency, jpyAtMid, totalCostJpy;
    if (direction === 'jpy_to_usd') {
      sourceCurrency = 'JPY';
      deliveredCurrency = 'USD';
      // Convert fixed fee to source-side JPY so the math is symmetric.
      const fixedFeeJpy = fixedFeeUsd * midRate;
      const jpyAfterFixedFee = Math.max(0, amount - fixedFeeJpy);
      const jpyAfterPctFee = jpyAfterFixedFee * (1 - feePct);
      // jpy / (jpy/usd) = usd, but at the spread-adjusted rate the
      // user only gets fewer USD per yen sold.
      delivered = jpyAfterPctFee / effectiveRate;
      jpyAtMid = amount; // mid-market source-side reference is the input
      totalCostJpy = amount - (delivered * midRate);
    } else {
      sourceCurrency = 'USD';
      deliveredCurrency = 'JPY';
      const usdAfterFixedFee = Math.max(0, amount - fixedFeeUsd);
      const usdAfterPctFee = usdAfterFixedFee * (1 - feePct);
      delivered = usdAfterPctFee * effectiveRate;
      jpyAtMid = amount * midRate;
      totalCostJpy = jpyAtMid - delivered;
    }
    const totalCostPct = jpyAtMid > 0 ? (totalCostJpy / jpyAtMid) * 100 : 0;
    // Effective rate normalized to JPY/USD so the sort + display logic
    // is direction-agnostic (best = highest JPY-per-USD always).
    const effRateJpyPerUsd = direction === 'jpy_to_usd'
      ? (delivered > 0 ? amount / delivered : 0)
      : (amount > 0 ? delivered / amount : 0);
    return {
      delivered,
      delivered_currency: deliveredCurrency,
      source_currency: sourceCurrency,
      effective_rate: effRateJpyPerUsd, // always JPY per 1 USD
      total_cost_jpy: totalCostJpy,
      total_cost_usd: totalCostJpy / midRate,
      total_cost_pct: totalCostPct,
      fees_used: fees,
      direction,
      // Back-compat aliases (older callers) — kept for the
      // comparison card et al. that haven't been updated yet.
      jpy_delivered: direction === 'usd_to_jpy' ? delivered : null,
      jpy_at_mid: jpyAtMid,
    };
  }

  // Persist a per-platform fee override.
  function setRecordedFees(platformId, fees) {
    const all = Object.assign({}, getRecorded());
    if (fees == null) {
      delete all[platformId];
    } else {
      all[platformId] = Object.assign({}, fees, {
        last_verified_at: new Date().toISOString(),
      });
    }
    setRecorded(all);
  }

  // ====================================================================
  // State accessors
  // ====================================================================

  function getFx()         { return TB.state.get('fx_banking') || {}; }
  function getAlerts()     { return getFx().rate_alerts || []; }
  function getPrefs()      { return getFx().preferences || {}; }
  function getRecorded()   { return getFx().recorded_fees || {}; }

  function setAlerts(arr) {
    const x = getFx();
    x.rate_alerts = arr;
    TB.state.set('fx_banking', x);
  }
  function setPrefs(value) {
    const x = getFx();
    x.preferences = value;
    TB.state.set('fx_banking', x);
  }
  function setRecorded(map) {
    const x = getFx();
    x.recorded_fees = map;
    TB.state.set('fx_banking', x);
  }

  // ====================================================================
  // FBAR aggregate computation
  // ====================================================================
  //
  // FBAR (FinCEN 114) is required of any US person whose aggregate
  // foreign account peak exceeds $10,000 USD at ANY POINT during the
  // calendar year. The threshold is per-person across ALL accounts —
  // a single $5K savings + a single $5.5K checking already trips it.
  //
  // We compute the current foreign aggregate from two sources, in
  // priority order:
  //   1. fbar.yearly_balances (canonical FBAR data, current year peak
  //      per account, summed). Most accurate when user has filed FBAR.
  //   2. Live asset balances from TB.assets (non-US accounts in USD).
  //      Used when no FBAR data exists yet for the current year.
  //
  // Returns { usd, year, source, peak_or_current }. peak_or_current
  // tells callers whether they're looking at FBAR's tracked peak
  // ('peak') or a current-balance approximation ('current').

  const FBAR_THRESHOLD_USD = 10000;

  function computeForeignAggregateUsd() {
    const year = new Date().getFullYear();
    const fbar = TB.state.get('fbar') || {};
    const yb = Array.isArray(fbar.yearly_balances) ? fbar.yearly_balances : [];

    // Priority 1: FBAR yearly_balances for current year
    const currentYearEntries = yb.filter((b) => b.year === year);
    if (currentYearEntries.length > 0) {
      const sum = currentYearEntries.reduce((s, b) => s + (b.max_balance_usd || 0), 0);
      return { usd: sum, year, source: 'fbar_peak', peak_or_current: 'peak' };
    }

    // Priority 2: live asset balances for non-US accounts
    if (TB.assets && typeof TB.assets.getActiveAccounts === 'function') {
      let sum = 0;
      TB.assets.getActiveAccounts().forEach((a) => {
        if (a.country === 'US') return;
        sum += TB.assets.toUsd(a.balance_native, a.currency);
      });
      return { usd: sum, year, source: 'assets_current', peak_or_current: 'current' };
    }

    return { usd: 0, year, source: 'none', peak_or_current: 'current' };
  }

  // Status helper — categorizes aggregate vs threshold for color coding.
  function fbarStatus(aggregateUsd) {
    if (aggregateUsd >= FBAR_THRESHOLD_USD) {
      return { level: 'required', color: 'var(--tb-warn)' };
    }
    if (aggregateUsd >= FBAR_THRESHOLD_USD * 0.75) {
      return { level: 'approaching', color: 'var(--tb-warn)' };
    }
    if (aggregateUsd >= FBAR_THRESHOLD_USD * 0.5) {
      return { level: 'monitor', color: 'var(--tb-track-fx)' };
    }
    return { level: 'safe', color: 'var(--tb-success)' };
  }

  // ====================================================================
  // Current FX snapshot
  // ====================================================================

  // Reads the freshest available USD/JPY rate. Source priority:
  //   1. settings.fx.current_rates  — written by TB.utils.refreshCurrentFx
  //                                    (Treasury + exchangerate.host
  //                                    fallback). Most recent if user
  //                                    has clicked Refresh recently.
  //   2. settings.fx.treasury_rates — older year-keyed Treasury cache
  //                                    (FBAR uses this for historical).
  //   3. assets.toUsd inverse        — derived from whatever rate the
  //                                    Asset module has been using.
  //   4. FX_FALLBACK constant        — final backstop, shipped value.
  //
  // Returns { rate, source, asOf, fetchedAt, isFresh } where:
  //   - source     : human label ("Treasury", "Treasury (live)", etc.)
  //   - asOf       : the rate's effective date (Treasury record_date)
  //   - fetchedAt  : when WE fetched it (for staleness UX)
  //   - isFresh    : true if fetched within last 7 days
  function currentJpyPerUsd() {
    const settings = TB.state.get('settings.fx') || {};

    // 1. Most-recent fetched rates (refreshCurrentFx target)
    if (settings.current_rates && settings.current_rates.JPY) {
      const fetchedAt = settings.current_fetched_at;
      const isFresh = fetchedAt &&
        (Date.now() - new Date(fetchedAt).getTime()) < 7 * 86400000;
      return {
        rate: settings.current_rates.JPY,
        source: settings.current_fallback_used ? 'Treasury + exchangerate.host' : 'Treasury (live)',
        asOf: settings.current_as_of,
        fetchedAt: fetchedAt,
        isFresh: !!isFresh,
      };
    }

    // 2. Year-keyed Treasury cache (legacy / FBAR-side path)
    const treasury = settings.treasury_rates || {};
    const year = String(new Date().getFullYear());
    if (treasury[year] && treasury[year].JPY) {
      return {
        rate: treasury[year].JPY, source: 'Treasury (' + year + ' cached)',
        asOf: settings.treasury_fetched_at, fetchedAt: settings.treasury_fetched_at, isFresh: false,
      };
    }
    const years = Object.keys(treasury).sort().reverse();
    for (const y of years) {
      if (treasury[y] && treasury[y].JPY) {
        return {
          rate: treasury[y].JPY, source: 'Treasury (' + y + ' cached)',
          asOf: settings.treasury_fetched_at, fetchedAt: settings.treasury_fetched_at, isFresh: false,
        };
      }
    }

    // 3. Derived from assets.toUsd
    if (TB.assets && typeof TB.assets.toUsd === 'function') {
      const oneUsdInJpy = 1 / TB.assets.toUsd(1, 'JPY');
      if (isFinite(oneUsdInJpy)) {
        return { rate: oneUsdInJpy, source: 'Asset cache', asOf: null, fetchedAt: null, isFresh: false };
      }
    }

    // 4. Hardcoded fallback
    if (TB.utils && TB.utils.FX_FALLBACK && TB.utils.FX_FALLBACK.JPY) {
      return { rate: TB.utils.FX_FALLBACK.JPY, source: 'Fallback (built-in)', asOf: null, fetchedAt: null, isFresh: false };
    }
    return { rate: 150, source: 'Default', asOf: null, fetchedAt: null, isFresh: false };
  }

  // Live mid-market USD/JPY (informational — what Google / Yahoo
  // shows). Used by the Transfer cost calculator since "what would
  // I actually get if I send today" is a real-time question. Falls
  // back to the Treasury rate when no live rate has been fetched
  // (e.g., user is offline) so the calculator never shows an empty
  // table. The returned `isLive` flag lets the UI surface which
  // rate it actually used.
  function liveJpyPerUsd() {
    const settings = TB.state.get('settings.fx') || {};
    if (settings.live_jpy && isFinite(settings.live_jpy) && settings.live_jpy > 0) {
      return {
        rate: settings.live_jpy,
        source: settings.live_source || 'Live',
        asOf: settings.live_as_of || null,
        fetchedAt: settings.live_fetched_at || null,
        isLive: true,
      };
    }
    // Live not available — degrade to Treasury (what was used pre-v0.61).
    const treasury = currentJpyPerUsd();
    return Object.assign({}, treasury, { isLive: false });
  }

  // Triggers a fresh fetch + re-renders the module on completion.
  // Used by the Refresh buttons on the snapshot + calculator cards.
  // Returns the same promise as TB.utils.refreshCurrentFx so callers
  // can chain UI state.
  function refreshAndRerender() {
    if (!TB.utils || typeof TB.utils.refreshCurrentFx !== 'function') {
      return Promise.reject(new Error('FX refresh helper unavailable'));
    }
    return TB.utils.refreshCurrentFx().then((res) => {
      rerender();
      return res;
    });
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  function isJpResident() {
    const a = TB.state.get('onboarding.answers') || {};
    const tracks = TB.state.get('tracks') || [];
    return a.juminhyou === 'yes' ||
      a.years_in_japan === '5_to_10' || a.years_in_japan === 'over_10' ||
      tracks.indexOf('resident') !== -1;
  }

  const SECTIONS = [
    { id: 'header',    always: true, builder: () => buildHeaderCard() },
    { id: 'snapshot',  always: true, builder: () => buildSnapshotCard() },
    {
      id: 'fbar_awareness',
      label_en: 'FBAR threshold awareness',
      label_jp: 'FBAR 閾値の認識',
      description_en: 'Live tracker of your foreign account aggregate vs the $10,000 FBAR threshold. Cross-references FBAR module + Assets.',
      description_jp: '外国口座総額と $10,000 FBAR 閾値のライブトラッカー。FBAR モジュール + Asset と連携。',
      auto_show: () => true,
      builder: () => buildFbarAwarenessCard(),
    },
    {
      id: 'calculator',
      label_en: 'Transfer cost calculator',
      label_jp: '送金コスト計算機',
      description_en: 'Input a USD amount; see what each platform delivers in JPY after spread + fees. Surfaces an FBAR threshold warning when a transfer would push your aggregate across $10K.',
      description_jp: 'ドル金額を入力すると、各プラットフォームのスプレッド+手数料控除後の円受取額を表示。送金で総額が $10K を超える場合は FBAR 閾値警告を表示。',
      auto_show: () => true,
      builder: () => buildCalculatorCard(),
    },
    {
      id: 'comparison',
      label_en: 'Platform comparison matrix',
      label_jp: 'プラットフォーム比較表',
      description_en: 'Side-by-side overview of every supported platform with pros and cons.',
      description_jp: '対応プラットフォームの長短を一覧比較。',
      auto_show: () => true,
      builder: () => buildComparisonCard(),
    },
    {
      id: 'decision_tree',
      label_en: 'Account-by-purpose decision tree',
      label_jp: '用途別口座選択ガイド',
      description_en: 'Which platform / account for which purpose: receiving SS, paying JP rent, transferring savings.',
      description_jp: '用途別の最適プラットフォーム・口座:SS 受取・JP 家賃支払・貯蓄送金。',
      auto_show: () => true,
      builder: () => buildDecisionTreeCard(),
    },
    {
      id: 'holding',
      label_en: 'Multi-currency holding strategy',
      label_jp: '複数通貨保有戦略',
      description_en: 'When to convert vs hold; rules of thumb by income type and JP-resident status.',
      description_jp: '転換タイミング vs 保有判断;所得種別・日本居住ステータス別の指針。',
      auto_show: () => true,
      builder: () => buildHoldingCard(),
    },
    {
      id: 'alerts',
      label_en: 'Rate alerts',
      label_jp: 'レートアラート',
      description_en: 'Set thresholds (e.g. "tell me if USD/JPY > 160"); surfaces in Action Center.',
      description_jp: '閾値設定(例:USD/JPY > 160 で通知);アクションセンターに表示。',
      auto_show: () => true,
      builder: () => buildAlertsCard(),
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

  // Re-render the FX module when the boot script's deferred live-FX
  // fetch resolves (or fails) — without this, a user already on the
  // FX page when the rate lands sees a stale "Fetching live rate…"
  // until they navigate away and back. The handler is attached at
  // module-init time and lives for the page lifetime; rerender() is
  // a no-op when host is null (other modules visible), so it's safe
  // to leave attached unconditionally.
  document.addEventListener('tb:live-fx-updated', () => { rerender(); });

  // ─── Header ───────────────────────────────────────────────────────

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'fx' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'fx' },
          t('fx.badge')),
      ),
      el('h1', null, '💱 ' + t('fx.title')),
      el('p', { class: 'tb-card-meta' }, t('fx.subtitle')),
    );
  }

  // ─── Snapshot card ──────────────────────────────────────────────

  function buildSnapshotCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const fx = currentJpyPerUsd();
    const live = (TB.utils && typeof TB.utils.getLiveJpyRate === 'function')
      ? TB.utils.getLiveJpyRate() : null;

    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    const refreshBtn = buildRefreshButton(t('fx.snapshot.refresh'));
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '📊 ' + t('fx.section.snapshot')),
      refreshBtn,
    ));

    // Two-column layout: Treasury (calculations) + Live (informational)
    // side by side. Treasury rate keeps the prominent green border on
    // a fresh fetch — that's the rate that powers FBAR and Asset math.
    // Live rate uses an accent border to signal "informational" — it
    // matches what Google / Yahoo show but isn't used for any number
    // anywhere else in the app.
    const grid = el('div', {
      style: {
        display: 'grid', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
      },
    });

    // Treasury card
    const treasuryCard = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
        borderLeft: '4px solid ' + (fx.isFresh ? 'var(--tb-success)' : 'var(--tb-track-fx)'),
      },
    },
      el('div', {
        style: {
          fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em',
          color: 'var(--tb-text-soft)', fontWeight: '700',
        },
      }, t('fx.snapshot.treasury.label')),
      el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '2px' } },
        t('fx.snapshot.usd_to_jpy_label')),
      el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-40)', fontFamily: 'var(--tb-font-mono)' } },
        '¥' + fx.rate.toFixed(2)),
      buildFreshnessRow(fx),
      el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-1)', fontSize: '11px' } },
        '↳ ' + t('fx.snapshot.treasury.usedFor')),
    );
    grid.appendChild(treasuryCard);

    // Live card — built whether we have data or not, but content
    // varies. Empty state gets a "Fetching…" placeholder + a refresh
    // button so the user can retry if the auto-fetch failed.
    const liveCard = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
        borderLeft: '4px solid var(--tb-accent, var(--tb-track-fx))',
      },
    });
    liveCard.appendChild(el('div', {
      style: {
        fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--tb-text-soft)', fontWeight: '700',
      },
    }, t('fx.snapshot.live.label')));
    liveCard.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '2px' } },
      t('fx.snapshot.usd_to_jpy_label')));
    const liveErr = (TB.state.get('settings.fx') || {}).live_fetch_error;
    if (live && live.rate) {
      liveCard.appendChild(el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-40)', fontFamily: 'var(--tb-font-mono)' } },
        '¥' + live.rate.toFixed(2)));
      const liveBits = [];
      if (live.source) liveBits.push(t('fx.snapshot.source') + ': ' + live.source);
      if (live.asOf) liveBits.push(t('fx.snapshot.as_of') + ' ' + new Date(live.asOf).toLocaleDateString());
      if (live.fetchedAt) {
        const ageMin = Math.floor((Date.now() - new Date(live.fetchedAt).getTime()) / 60000);
        const ageStr = ageMin < 1 ? t('fx.snapshot.justNow')
          : ageMin < 60 ? t('fx.snapshot.minAgo', { n: ageMin })
          : t('fx.snapshot.hoursAgo', { n: Math.floor(ageMin / 60) });
        liveBits.push(t('fx.snapshot.fetched') + ' ' + ageStr);
      }
      liveCard.appendChild(el('div', {
        style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' },
      }, liveBits.join(' · ')));
    } else if (liveErr) {
      // Fetch attempted and failed — surface the error in the card
      // so the user understands why the rate is missing without
      // having to open devtools. Trimmed because some failure
      // strings are very long ("All live-FX sources failed — …").
      liveCard.appendChild(el('div', {
        style: { fontWeight: '700', fontSize: 'var(--tb-fs-40)', fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-soft)' },
      }, '—'));
      liveCard.appendChild(el('div', {
        style: {
          fontSize: 'var(--tb-fs-12)', color: 'var(--tb-warn)', marginTop: '4px',
          maxWidth: '100%', wordBreak: 'break-word',
        },
        title: liveErr,
      }, '⚠ ' + t('fx.snapshot.live.failed') + ' — ' +
         (liveErr.length > 120 ? liveErr.slice(0, 120) + '…' : liveErr)));
    } else {
      liveCard.appendChild(el('div', {
        style: { fontWeight: '700', fontSize: 'var(--tb-fs-40)', fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-soft)' },
      }, '—'));
      liveCard.appendChild(el('div', {
        style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' },
      }, t('fx.snapshot.live.fetching')));
    }
    liveCard.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-1)', fontSize: '11px' } },
      '↳ ' + t('fx.snapshot.live.usedFor')));
    // Manual refresh — bypasses the 1-hour cache.
    liveCard.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { marginTop: 'var(--tb-sp-2)', padding: '4px 10px', fontSize: '11px' },
      onclick: (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = '… ' + t('fx.snapshot.refreshing');
        TB.utils.refreshLiveFx({ force: true })
          .then(() => { rerender(); })
          .catch((err) => {
            btn.disabled = false;
            btn.textContent = '⚠ ' + (err && err.message ? err.message.slice(0, 40) : 'failed');
            setTimeout(() => { btn.textContent = orig; }, 4000);
          });
      },
    }, '↻ ' + t('fx.snapshot.live.refresh')));
    grid.appendChild(liveCard);

    card.appendChild(grid);

    // Plain-language note explaining the two-rate model. Sits below
    // the cards so the user has the rationale in front of them the
    // first few times they load this page.
    card.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', lineHeight: '1.55',
      },
    }, t('fx.snapshot.bothRates.note')));

    // Reverse rate for context — uses Treasury rate (the calculation
    // basis). Live equivalent is shown in the live card itself.
    card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
      t('fx.snapshot.reverse') + ': ¥1,000 = $' + (1000 / fx.rate).toFixed(2) +
      ' · $1,000 = ¥' + Math.round(fx.rate * 1000).toLocaleString()));

    return card;
  }

  // ─── Shared freshness UI helpers (used by snapshot + calculator) ──

  // Builds a refresh button with built-in loading state, success
  // confirmation, and error display. Re-renders the module on success.
  function buildRefreshButton(label) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const btn = el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
    }, '↻ ' + label);
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '… ' + t('fx.snapshot.refreshing');
      refreshAndRerender()
        .then(() => {
          // The module re-renders on success — this btn instance is gone
        })
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = '⚠ ' + (err && err.message ? err.message.slice(0, 40) : 'failed');
          btn.title = err && err.message ? err.message : '';
          // Restore label after a few seconds
          setTimeout(() => { btn.textContent = '↻ ' + label; btn.title = ''; }, 4000);
        });
    });
    return btn;
  }

  // Builds the small "Source: X · As of: Y · Fetched: Z (Nd ago)" row.
  // Color-coded by freshness — green if fetched within 7d, gray otherwise.
  function buildFreshnessRow(fx) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const parts = [];
    parts.push(t('fx.snapshot.source') + ': ' + fx.source);
    if (fx.asOf) parts.push(t('fx.snapshot.as_of') + ' ' + new Date(fx.asOf).toLocaleDateString());
    if (fx.fetchedAt) {
      const ageDays = Math.floor((Date.now() - new Date(fx.fetchedAt).getTime()) / 86400000);
      const ageStr = ageDays === 0 ? t('fx.snapshot.today')
        : ageDays === 1 ? t('fx.snapshot.yesterday')
        : ageDays + 'd ' + t('fx.snapshot.ago');
      parts.push(t('fx.snapshot.fetched') + ' ' + ageStr);
    } else {
      parts.push(t('fx.snapshot.never_fetched'));
    }
    return el('div', {
      style: {
        fontSize: 'var(--tb-fs-12)',
        color: fx.isFresh ? 'var(--tb-success)' : 'var(--tb-text-soft)',
        marginTop: '4px',
      },
    }, parts.join(' · '));
  }

  // ─── FBAR awareness card ────────────────────────────────────────

  function buildFbarAwarenessCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const agg = computeForeignAggregateUsd();
    const status = fbarStatus(agg.usd);
    const fx = currentJpyPerUsd();

    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🚨 ' + t('fx.section.fbar_awareness')),
      el('a', { href: '#', style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'fbar' } }));
        } }, t('fx.fbar.open_fbar') + ' →'),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.fbar.intro')));

    // Aggregate vs threshold display
    const tile = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)', marginTop: 'var(--tb-sp-2)',
        borderLeft: '4px solid ' + status.color,
      },
    });
    tile.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
      el('div', null,
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
          t('fx.fbar.current_aggregate') + ' (' + agg.year + ')'),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-28)', fontFamily: 'var(--tb-font-mono)' } },
          '$' + Math.round(agg.usd).toLocaleString()),
        el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
          '¥' + Math.round(agg.usd * fx.rate).toLocaleString() + ' · ' +
          (agg.peak_or_current === 'peak' ? t('fx.fbar.from_fbar') : t('fx.fbar.from_assets'))),
      ),
      el('div', { style: { textAlign: 'right' } },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
          t('fx.fbar.threshold')),
        el('div', { style: { fontWeight: '600', fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-18)' } },
          '$' + FBAR_THRESHOLD_USD.toLocaleString()),
      ),
    ));

    // Distance / status banner
    const headroom = FBAR_THRESHOLD_USD - agg.usd;
    let bannerLabel, bannerHint;
    if (status.level === 'required') {
      bannerLabel = '⚠ ' + t('fx.fbar.status.required');
      bannerHint = t('fx.fbar.status.required_hint', { excess: '$' + Math.round(agg.usd - FBAR_THRESHOLD_USD).toLocaleString() });
    } else if (status.level === 'approaching') {
      bannerLabel = '⚠ ' + t('fx.fbar.status.approaching');
      bannerHint = t('fx.fbar.status.headroom', { headroom: '$' + Math.round(headroom).toLocaleString() });
    } else if (status.level === 'monitor') {
      bannerLabel = '○ ' + t('fx.fbar.status.monitor');
      bannerHint = t('fx.fbar.status.headroom', { headroom: '$' + Math.round(headroom).toLocaleString() });
    } else {
      bannerLabel = '✓ ' + t('fx.fbar.status.safe');
      bannerHint = t('fx.fbar.status.headroom', { headroom: '$' + Math.round(headroom).toLocaleString() });
    }
    tile.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)',
      },
    },
      el('div', { style: { fontWeight: '600' } }, bannerLabel),
      el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, bannerHint),
    ));

    // Visual progress bar
    const pct = Math.min(100, (agg.usd / FBAR_THRESHOLD_USD) * 100);
    tile.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-2)', height: '8px',
      background: 'var(--tb-border)', borderRadius: 'var(--tb-radius-pill)', overflow: 'hidden' } },
      el('div', {
        style: {
          height: '100%', width: pct.toFixed(1) + '%',
          background: status.color,
          transition: 'width var(--tb-motion-base) var(--tb-ease)',
        },
      }),
    ));
    card.appendChild(tile);

    // Education content
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)' } });
    [
      'fx.fbar.point.10k_aggregate',
      'fx.fbar.point.peak_not_year_end',
      'fx.fbar.point.all_account_types',
      'fx.fbar.point.fincen_not_irs',
      'fx.fbar.point.deadline',
      'fx.fbar.point.penalty',
      'fx.fbar.point.transfer_trigger',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── Calculator card ────────────────────────────────────────────

  function buildCalculatorCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    // Two rates: live for what-you'd-actually-get-today math, Treasury
    // for the FBAR threshold check (FBAR is a regulatory calculation
    // and must use the Treasury rate). Falls through to Treasury if
    // live isn't available.
    const liveFx = liveJpyPerUsd();
    const treasuryFx = currentJpyPerUsd();
    const prefs = getPrefs();
    // Direction state: 'usd_to_jpy' or 'jpy_to_usd'. Persisted in
    // prefs so user gets their last choice next visit.
    let direction = prefs.calc_direction === 'jpy_to_usd' ? 'jpy_to_usd' : 'usd_to_jpy';
    // Two persisted amounts so toggling direction doesn't lose what
    // the user typed in either field.
    let amountUsd = prefs.monthly_estimate_usd || 1000;
    let amountJpy = prefs.monthly_estimate_jpy || Math.round(amountUsd * liveFx.rate / 1000) * 1000;

    function currentAmount() { return direction === 'jpy_to_usd' ? amountJpy : amountUsd; }
    function currentSourceCurrency() { return direction === 'jpy_to_usd' ? 'JPY' : 'USD'; }
    function currentDeliveredCurrency() { return direction === 'jpy_to_usd' ? 'USD' : 'JPY'; }

    function fmtSource(amt) {
      return direction === 'jpy_to_usd'
        ? '¥' + Math.round(amt).toLocaleString()
        : '$' + Math.round(amt).toLocaleString();
    }
    function fmtDelivered(amt) {
      return direction === 'jpy_to_usd'
        ? '$' + (amt).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : '¥' + Math.round(amt).toLocaleString();
    }

    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });

    // Header with refresh button — refresh both rates so the calculator
    // stays in sync with the snapshot card.
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
      el('h2', { style: { margin: 0 } }, '🧮 ' + t('fx.section.calculator')),
      buildRefreshButton(t('fx.calculator.refresh_rate')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.calculator.intro')));

    // Direction toggle — pill-style segmented control.
    function buildDirToggle() {
      const wrap = el('div', {
        style: {
          display: 'inline-flex', borderRadius: 'var(--tb-radius-pill)',
          background: 'var(--tb-bg)', padding: '3px', gap: '2px',
          marginBottom: 'var(--tb-sp-3)',
        },
      });
      function pill(dir, label) {
        const active = direction === dir;
        return el('button', {
          type: 'button',
          class: 'tb-btn ' + (active ? '' : 'tb-btn--ghost'),
          style: {
            padding: '4px 14px', fontSize: 'var(--tb-fs-12)',
            borderRadius: 'var(--tb-radius-pill)',
            background: active ? 'var(--tb-track-fx)' : 'transparent',
            color: active ? '#fff' : 'var(--tb-text)',
            fontWeight: active ? '700' : '500',
          },
          onclick: () => {
            if (direction === dir) return;
            direction = dir;
            const p = Object.assign({}, getPrefs());
            p.calc_direction = direction;
            setPrefs(p);
            rerender();
          },
        }, label);
      }
      wrap.appendChild(pill('usd_to_jpy', t('fx.calculator.dir.usd_to_jpy')));
      wrap.appendChild(pill('jpy_to_usd', t('fx.calculator.dir.jpy_to_usd')));
      return wrap;
    }
    card.appendChild(buildDirToggle());

    // Compact freshness banner — uses the LIVE rate now since that's
    // what the calculator math is based on. Marks it as live so the
    // user sees this is the daily mid-market reference, not the
    // quarterly Treasury rate.
    const liveAge = liveFx.fetchedAt
      ? Math.floor((Date.now() - new Date(liveFx.fetchedAt).getTime()) / 60000)
      : null;
    const liveAgeStr = liveAge == null ? ''
      : liveAge < 1 ? t('fx.snapshot.justNow')
      : liveAge < 60 ? t('fx.snapshot.minAgo', { n: liveAge })
      : t('fx.snapshot.hoursAgo', { n: Math.floor(liveAge / 60) });
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        borderLeft: '3px solid ' + (liveFx.isLive ? 'var(--tb-accent, var(--tb-track-fx))' : 'var(--tb-warn)'),
        marginBottom: 'var(--tb-sp-3)',
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 'var(--tb-sp-2)',
      },
    },
      el('div', null,
        el('span', { style: { fontWeight: '600' } },
          (liveFx.isLive ? t('fx.calculator.using_live') : t('fx.calculator.using_treasury_fallback')) + ' '),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700' } },
          '¥' + liveFx.rate.toFixed(2) + ' / $1'),
        liveFx.isLive && liveAgeStr ? el('span', {
          style: { marginLeft: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
        }, '· ' + liveAgeStr) : null,
      ),
    ));
    card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: '-12px', marginBottom: 'var(--tb-sp-3)', fontSize: '11px' } },
      t('fx.calculator.rateExplain', {
        treasury: '¥' + treasuryFx.rate.toFixed(2),
      })));

    // Input
    const inputWrap = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', alignItems: 'center', marginBottom: 'var(--tb-sp-3)', flexWrap: 'wrap' } });
    inputWrap.appendChild(el('label', { style: { fontSize: 'var(--tb-fs-14)' } }, t('fx.calculator.amount')));
    const input = el('input', {
      type: 'number', class: 'tb-input',
      style: { width: '180px', fontFamily: 'var(--tb-font-mono)' },
      step: direction === 'jpy_to_usd' ? '10000' : '100',
      min: '0',
      value: currentAmount(),
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        const safe = isFinite(v) ? v : 0;
        if (direction === 'jpy_to_usd') amountJpy = safe; else amountUsd = safe;
        repaintResults();
        // Persist both amounts independently — switching direction
        // shouldn't blow away the other side's last typed value.
        const p = Object.assign({}, getPrefs());
        if (direction === 'jpy_to_usd') p.monthly_estimate_jpy = amountJpy;
        else p.monthly_estimate_usd = amountUsd;
        setPrefs(p);
      },
    });
    inputWrap.appendChild(input);
    inputWrap.appendChild(el('span', { style: { color: 'var(--tb-text-soft)' } }, currentSourceCurrency()));
    card.appendChild(inputWrap);

    // FBAR contextual callout — shown when this transfer would push
    // the foreign aggregate near or across the $10K threshold. Updates
    // live as the user types. Always uses the Treasury rate (FBAR is
    // a regulatory calculation, not a market-rate one).
    const fbarCallout = el('div', { style: { marginBottom: 'var(--tb-sp-3)' } });
    card.appendChild(fbarCallout);

    function repaintFbarCallout() {
      fbarCallout.innerHTML = '';
      const agg = computeForeignAggregateUsd();
      // FBAR threshold: USD→JPY ADDS to the foreign aggregate (sending
      // money INTO Japan), JPY→USD SUBTRACTS from it (pulling out).
      // Express the transfer in USD using the TREASURY rate so this
      // matches what the FBAR module would record.
      const transferUsd = direction === 'jpy_to_usd'
        ? -(currentAmount() / treasuryFx.rate)
        : currentAmount();
      const projected = Math.max(0, agg.usd + transferUsd);
      // Don't render unless we're near or over the threshold either before
      // or after the transfer
      const showBefore = agg.usd >= FBAR_THRESHOLD_USD * 0.5;
      const showAfter = projected >= FBAR_THRESHOLD_USD * 0.5;
      if (!showBefore && !showAfter) return;

      const wasOver = agg.usd >= FBAR_THRESHOLD_USD;
      const willBeOver = projected >= FBAR_THRESHOLD_USD;
      let color, icon, label, body;
      if (direction === 'jpy_to_usd' && wasOver && !willBeOver) {
        // Pulling out — drops back below threshold
        color = 'var(--tb-success)'; icon = '✓';
        label = t('fx.calculator.fbar_dropping_below.label');
        body = t('fx.calculator.fbar_dropping_below.body', {
          before: '$' + Math.round(agg.usd).toLocaleString(),
          after: '$' + Math.round(projected).toLocaleString(),
        });
      } else if (direction === 'jpy_to_usd' && wasOver) {
        // Pulling out but still over
        color = 'var(--tb-track-fx)'; icon = 'ℹ';
        label = t('fx.calculator.fbar_pulling_out.label');
        body = t('fx.calculator.fbar_pulling_out.body', {
          before: '$' + Math.round(agg.usd).toLocaleString(),
          after: '$' + Math.round(projected).toLocaleString(),
        });
      } else if (!wasOver && willBeOver) {
        // The transfer crosses the threshold — biggest signal
        color = 'var(--tb-warn)'; icon = '🚨';
        label = t('fx.calculator.fbar_crossing.label');
        body = t('fx.calculator.fbar_crossing.body', {
          before: '$' + Math.round(agg.usd).toLocaleString(),
          after: '$' + Math.round(projected).toLocaleString(),
        });
      } else if (wasOver) {
        // Already over — adding to the existing requirement
        color = 'var(--tb-track-fx)'; icon = 'ℹ';
        label = t('fx.calculator.fbar_already.label');
        body = t('fx.calculator.fbar_already.body', {
          before: '$' + Math.round(agg.usd).toLocaleString(),
          after: '$' + Math.round(projected).toLocaleString(),
        });
      } else {
        // Approaching — useful heads-up
        color = 'var(--tb-track-fx)'; icon = 'ℹ';
        label = t('fx.calculator.fbar_approaching.label');
        body = t('fx.calculator.fbar_approaching.body', {
          after: '$' + Math.round(projected).toLocaleString(),
          headroom: '$' + Math.round(FBAR_THRESHOLD_USD - projected).toLocaleString(),
        });
      }
      fbarCallout.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          fontSize: 'var(--tb-fs-12)',
        },
      },
        el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, icon + ' ' + label),
        el('div', null, body),
        // Footnote: clarify the conversion rate basis so the user knows
        // why $X here might differ from $Y in the snapshot (Treasury
        // for FBAR threshold math, vs live for the platform calc).
        el('div', { class: 'tb-field-help', style: { marginTop: '4px', fontSize: '11px' } },
          t('fx.calculator.fbar.rateBasis', { rate: '¥' + treasuryFx.rate.toFixed(2) })),
      ));
    }
    repaintFbarCallout();

    // Results table
    const resultsContainer = el('div', null);
    card.appendChild(resultsContainer);

    function repaintResults() {
      // Recompute FBAR callout too on every input change
      repaintFbarCallout();
      resultsContainer.innerHTML = '';
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });

      // Sort platforms by delivered amount descending (best first).
      // Always uses the LIVE rate for the math.
      const computed = PLATFORMS
        .filter((p) => p.direction === 'both' || p.direction === 'usd_to_jpy')
        .map((p) => ({ p, r: platformDelivers(p, currentAmount(), liveFx.rate, direction) }))
        .filter((x) => x.r != null)
        .sort((a, b) => (b.r.delivered || 0) - (a.r.delivered || 0));

      const best = computed[0] && computed[0].r ? computed[0].r.delivered : 0;
      const deliveredCcy = currentDeliveredCurrency();

      computed.forEach((row, idx) => {
        const r = row.r;
        const lossVsBest = best - r.delivered;
        const isBest = idx === 0;
        // 0.5% loss vs. best is the "noticeable" threshold
        const lossWarnThreshold = best * 0.005;
        list.appendChild(el('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: '1fr 130px 90px 110px',
            gap: 'var(--tb-sp-2)',
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'var(--tb-bg)',
            borderRadius: 'var(--tb-radius-1)',
            borderLeft: '3px solid ' + (isBest ? 'var(--tb-success)' :
              lossVsBest > lossWarnThreshold ? 'var(--tb-warn)' : 'var(--tb-track-fx)'),
            alignItems: 'baseline',
          },
        },
          el('span', null,
            el('span', { style: { fontWeight: isBest ? '700' : '500' } },
              (isBest ? '🏆 ' : '') + row.p.name),
            el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, row.p.type)),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right', fontWeight: '600' } },
            fmtDelivered(r.delivered)),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right',
            fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
            // Effective rate is always normalized to JPY/USD so the
            // sort + comparison stay consistent across directions.
            '¥' + r.effective_rate.toFixed(2)),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right',
            fontSize: 'var(--tb-fs-12)',
            color: isBest ? 'var(--tb-success)' :
              lossVsBest > 0 ? 'var(--tb-warn)' : 'var(--tb-text-soft)' } },
            isBest ? '✓ ' + t('fx.calculator.best') :
              '−' + (deliveredCcy === 'JPY' ? '¥' : '$') +
              (deliveredCcy === 'JPY'
                ? Math.round(lossVsBest).toLocaleString()
                : lossVsBest.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))),
        ));
      });
      resultsContainer.appendChild(list);

      // Headers
      const headers = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '1fr 130px 90px 110px',
          gap: 'var(--tb-sp-2)',
          padding: '4px var(--tb-sp-3)',
          marginTop: '6px',
          fontSize: 'var(--tb-fs-12)',
          color: 'var(--tb-text-soft)',
        },
      },
        el('span', null, t('fx.calculator.col.platform')),
        el('span', { style: { textAlign: 'right' } },
          t('fx.calculator.col.delivered') + ' (' + deliveredCcy + ')'),
        el('span', { style: { textAlign: 'right' } }, t('fx.calculator.col.eff_rate')),
        el('span', { style: { textAlign: 'right' } }, t('fx.calculator.col.vs_best')),
      );
      resultsContainer.insertBefore(headers, list);
    }
    repaintResults();

    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
      t('fx.calculator.note')));

    return card;
  }

  // ─── Comparison card ────────────────────────────────────────────

  function buildComparisonCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
      el('h2', { style: { margin: 0 } }, '📋 ' + t('fx.section.comparison')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openBulkVerifyModal() }, '✓ ' + t('fx.comparison.bulk_verify')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.comparison.intro')));

    PLATFORMS.forEach((p) => {
      const fees = effectiveFees(p);
      const ageDays = feeAgeDays(p);
      const wrap = el('details', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (fees.is_user_recorded
            ? (ageDays != null && ageDays > 90 ? 'var(--tb-warn)' : 'var(--tb-success)')
            : 'var(--tb-track-fx)'),
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      const summary = el('summary', { style: { cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
      summary.appendChild(el('span', { style: { fontWeight: '600' } }, p.name));
      const summaryRight = el('span', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', whiteSpace: 'nowrap' } });
      const feeStr = ((fees.spread_bps || 0) > 0 ? fees.spread_bps + 'bp' : '0bp') +
        ((fees.fee_pct || 0) > 0 ? ' + ' + fees.fee_pct + '%' : '') +
        ((fees.fixed_fee || 0) > 0 ? ' + $' + fees.fixed_fee : '');
      summaryRight.textContent = feeStr + ' · ' + p.speed;
      summary.appendChild(summaryRight);
      wrap.appendChild(summary);

      const body = el('div', { style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' } });

      // Verification status row + edit + visit-pricing-page links
      const statusRow = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          gap: 'var(--tb-sp-2)', flexWrap: 'wrap',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      let statusLabel, statusColor;
      if (fees.is_user_recorded && ageDays != null) {
        if (ageDays === 0)      statusLabel = '✓ ' + t('fx.comparison.verified_today');
        else if (ageDays === 1) statusLabel = '✓ ' + t('fx.comparison.verified_yesterday');
        else if (ageDays > 90) {
          statusLabel = '⚠ ' + t('fx.comparison.verified_stale', { days: ageDays });
          statusColor = 'var(--tb-warn)';
        } else                  statusLabel = '✓ ' + t('fx.comparison.verified_ago', { days: ageDays });
        if (!statusColor) statusColor = 'var(--tb-success)';
      } else {
        statusLabel = '○ ' + t('fx.comparison.using_typical');
        statusColor = 'var(--tb-text-soft)';
      }
      statusRow.appendChild(el('span', { style: { color: statusColor, fontWeight: '500' } }, statusLabel));
      const linkGroup = el('span', { style: { display: 'flex', gap: 'var(--tb-sp-3)', alignItems: 'baseline' } });
      if (fees.source_url) {
        linkGroup.appendChild(el('a', {
          href: fees.source_url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)' },
        }, t('fx.comparison.visit_pricing') + ' →'));
      }
      linkGroup.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openFeeUpdateModal(p),
      }, '✎ ' + t('fx.comparison.update_fees')));
      if (fees.is_user_recorded) {
        linkGroup.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
          title: t('fx.comparison.reset_to_default'),
          onclick: () => {
            if (confirm(t('fx.comparison.confirm_reset'))) {
              setRecordedFees(p.id, null);
              rerender();
            }
          },
        }, '↺'));
      }
      statusRow.appendChild(linkGroup);
      body.appendChild(statusRow);

      // User notes (if any)
      if (fees.is_user_recorded && fees.notes) {
        body.appendChild(el('div', {
          style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-track-fx)',
            background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)',
            marginBottom: 'var(--tb-sp-2)' },
        }, fees.notes));
      }

      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } });
      const prosCol = el('div', null,
        el('div', { style: { fontWeight: '600', color: 'var(--tb-success)', marginBottom: '4px' } }, t('fx.comparison.pros')),
        el('ul', { style: { paddingLeft: '20px', margin: 0 } },
          p.pros.map((line) => el('li', { style: { marginBottom: '2px' } }, line))),
      );
      const consCol = el('div', null,
        el('div', { style: { fontWeight: '600', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, t('fx.comparison.cons')),
        el('ul', { style: { paddingLeft: '20px', margin: 0 } },
          p.cons.map((line) => el('li', { style: { marginBottom: '2px' } }, line))),
      );
      grid.appendChild(prosCol);
      grid.appendChild(consCol);
      body.appendChild(grid);
      wrap.appendChild(body);
      card.appendChild(wrap);
    });

    return card;
  }

  // Per-platform fee update modal. User enters current published fees
  // (or pastes from the platform's pricing page) — saves with timestamp.
  function openFeeUpdateModal(platform) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const cur = effectiveFees(platform);
    const draft = {
      spread_bps: cur.spread_bps,
      fee_pct: cur.fee_pct,
      fixed_fee_usd: cur.fixed_fee,
      source_url: cur.source_url || platform.pricing_url || '',
      notes: cur.notes || '',
    };

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('fx.update.modal_title') + ': ' + platform.name));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.update.intro')));

    if (platform.pricing_url) {
      modal.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)',
        },
      },
        '🔗 ',
        el('a', { href: platform.pricing_url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)' } },
          t('fx.update.open_pricing') + ': ' + platform.pricing_url + ' →'),
      ));
    }

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }
    function num(label, key, help, step) {
      return field(label,
        el('input', { type: 'number', class: 'tb-input', step: step || '1', min: '0',
          value: draft[key] != null ? draft[key] : '',
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            draft[key] = isFinite(v) ? v : null;
          } }),
        help);
    }

    modal.appendChild(num(t('fx.update.spread_bps'), 'spread_bps',
      t('fx.update.spread_bps.help'), '5'));
    modal.appendChild(num(t('fx.update.fee_pct'), 'fee_pct',
      t('fx.update.fee_pct.help'), '0.05'));
    modal.appendChild(num(t('fx.update.fixed_fee_usd'), 'fixed_fee_usd',
      t('fx.update.fixed_fee_usd.help'), '1'));

    modal.appendChild(field(t('fx.update.source_url'),
      el('input', { type: 'url', class: 'tb-input',
        value: draft.source_url || '',
        placeholder: 'https://…',
        oninput: (e) => { draft.source_url = e.target.value; } }),
      t('fx.update.source_url.help')));

    modal.appendChild(field(t('fx.update.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || ''),
      t('fx.update.notes.help')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('fx.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setRecordedFees(platform.id, draft); close(); rerender(); } },
      '✓ ' + t('fx.update.save_verified')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // Bulk-verify modal — opens a modal listing every platform with
  // links + an "I've checked, all current" button to bulk-stamp
  // verification timestamps without changing values.
  function openBulkVerifyModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('fx.bulk.modal_title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.bulk.intro')));

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: 'var(--tb-sp-3)' } });
    PLATFORMS.forEach((p) => {
      const ageDays = feeAgeDays(p);
      list.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-2)', flexWrap: 'wrap',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } }, p.name),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
            ageDays != null
              ? (ageDays === 0 ? t('fx.comparison.verified_today')
                  : ageDays === 1 ? t('fx.comparison.verified_yesterday')
                  : t('fx.comparison.verified_ago', { days: ageDays }))
              : t('fx.comparison.using_typical')),
        ),
        el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } },
          p.pricing_url ? el('a', {
            href: p.pricing_url, target: '_blank', rel: 'noopener noreferrer',
            style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' },
          }, t('fx.bulk.open') + ' →') : null,
          el('button', {
            class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => { openFeeUpdateModal(p); },
          }, '✎'),
        ),
      ));
    });
    modal.appendChild(list);

    // Bulk action — stamp ALL platforms as verified at current values
    modal.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderLeft: '3px solid var(--tb-track-fx)',
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)',
      },
    }, '💡 ' + t('fx.bulk.tip')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)', flexWrap: 'wrap' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        if (confirm(t('fx.bulk.confirm_stamp'))) {
          PLATFORMS.forEach((p) => {
            const cur = effectiveFees(p);
            setRecordedFees(p.id, {
              spread_bps: cur.spread_bps,
              fee_pct: cur.fee_pct,
              fixed_fee_usd: cur.fixed_fee,
              source_url: cur.source_url,
              notes: cur.notes,
            });
          });
          close(); rerender();
        }
      } }, '✓ ' + t('fx.bulk.stamp_all')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button', onclick: close }, t('fx.bulk.done')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Decision tree card ─────────────────────────────────────────

  function buildDecisionTreeCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🌳 ' + t('fx.section.decision_tree')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.decision_tree.intro')));

    const scenarios = [
      { key: 'small_recurring',  default_rec: 'Wise (multi-currency Wise account auto-transfers each month)' },
      { key: 'large_lump',       default_rec: 'Schwab International wire (best for $50K+ at one time)' },
      { key: 'jp_employer_payroll', default_rec: 'JP megabank required (employer typically only pays into MUFG/Mizuho/SMBC)' },
      { key: 'ss_pension',       default_rec: 'Schwab US receiving + Wise transfer to JP (or direct deposit to Wise USD account)' },
      { key: 'cash_out_in_jp',   default_rec: 'Schwab debit card (worldwide ATM fee refunds, mid-market FX)' },
      { key: 'pay_jp_rent',      default_rec: 'JP bank account (megabank or Sony) with auto-debit set up' },
      { key: 'gift_to_jp_family', default_rec: 'Wise to recipient\'s JP bank (low cost) or Sony Bank transfer (if you both use Sony)' },
      { key: 'reserve_emergency', default_rec: 'Hold USD in Schwab brokerage / Sony Bank USD account; convert as needed' },
    ];
    scenarios.forEach((s) => {
      card.appendChild(el('div', {
        style: {
          display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--tb-sp-3)',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', alignItems: 'baseline',
        },
      },
        el('div', { style: { fontWeight: '600' } }, t('fx.decision_tree.scenario.' + s.key)),
        el('div', { style: { fontSize: 'var(--tb-fs-12)' } },
          '→ ' + (t('fx.decision_tree.rec.' + s.key) || s.default_rec)),
      ));
    });

    return card;
  }

  // ─── Multi-currency holding card ────────────────────────────────

  function buildHoldingCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚖ ' + t('fx.section.holding')));
    card.appendChild(el('p', null, t('fx.holding.intro')));

    const ul = el('ul', { style: { paddingLeft: '20px' } });
    [
      'fx.holding.point.match_currency',
      'fx.holding.point.dollar_cost_average',
      'fx.holding.point.tax_lots',
      'fx.holding.point.emergency_buffer',
      'fx.holding.point.no_market_timing',
      'fx.holding.point.large_one_time',
      'fx.holding.point.fbar_trigger',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '8px' } }, t(k))));
    card.appendChild(ul);

    return card;
  }

  // ─── Rate alerts card ───────────────────────────────────────────

  function buildAlertsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const alerts = getAlerts();

    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🔔 ' + t('fx.section.alerts')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openAlertModal(null) }, '＋ ' + t('fx.alerts.add')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fx.alerts.intro')));

    if (alerts.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('fx.alerts.empty')));
      return card;
    }

    const fx = currentJpyPerUsd();
    alerts.forEach((a) => {
      const triggered = a.direction === 'gt'
        ? fx.rate > a.threshold_jpy_per_usd
        : fx.rate < a.threshold_jpy_per_usd;
      card.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (triggered ? 'var(--tb-warn)' : 'var(--tb-track-fx)'),
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } },
            (triggered ? '🔔 ' : '○ ') +
            t('fx.alerts.usd_jpy') + ' ' + (a.direction === 'gt' ? '>' : '<') + ' ¥' + a.threshold_jpy_per_usd),
          a.label
            ? el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, a.label)
            : null,
        ),
        el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            if (confirm(t('fx.alerts.confirm_delete'))) {
              setAlerts(alerts.filter((x) => x.id !== a.id));
              rerender();
            }
          } }, '🗑'),
      ));
    });

    return card;
  }

  function openAlertModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const fx = currentJpyPerUsd();
    const draft = Object.assign({
      id: 'fxalert-' + Date.now().toString(36),
      direction: 'gt',
      threshold_jpy_per_usd: Math.round(fx.rate),
      label: '',
      active: true,
      last_triggered_at: null,
    }, existing || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('fx.alerts.modal_title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' },
      t('fx.alerts.modal_intro') + ' ¥' + fx.rate.toFixed(2)));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('fx.alerts.direction'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.direction = e.target.value; } },
        el('option', { value: 'gt', selected: draft.direction === 'gt' }, t('fx.alerts.gt')),
        el('option', { value: 'lt', selected: draft.direction === 'lt' }, t('fx.alerts.lt')),
      )));
    modal.appendChild(field(t('fx.alerts.threshold'),
      el('input', { type: 'number', class: 'tb-input', step: '0.5', min: '0',
        value: draft.threshold_jpy_per_usd,
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.threshold_jpy_per_usd = isFinite(v) ? v : draft.threshold_jpy_per_usd;
        } }),
      t('fx.alerts.threshold.help')));
    modal.appendChild(field(t('fx.alerts.label'),
      el('input', { type: 'text', class: 'tb-input',
        value: draft.label || '',
        placeholder: t('fx.alerts.label.placeholder'),
        oninput: (e) => { draft.label = e.target.value; } })));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('fx.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        const arr = getAlerts();
        const i = arr.findIndex((x) => x.id === draft.id);
        if (i >= 0) arr[i] = draft; else arr.push(draft);
        setAlerts(arr);
        close(); rerender();
      } }, t('fx.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Resources ──────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'fx' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('fx.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-fx)',
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
    card.appendChild(resource(t('fx.resources.wise.title'), t('fx.resources.wise.body'), 'https://wise.com/jp/compare/'));
    card.appendChild(resource(t('fx.resources.treasury.title'), t('fx.resources.treasury.body'),
      'https://fiscaldata.treasury.gov/datasets/treasury-reporting-rates-exchange/treasury-reporting-rates-of-exchange'));
    card.appendChild(resource(t('fx.resources.sony.title'), t('fx.resources.sony.body'), 'https://moneykit.net/'));
    card.appendChild(resource(t('fx.resources.schwab.title'), t('fx.resources.schwab.body'), 'https://international.schwab.com/'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  // FBAR threshold approach — fires when foreign aggregate is between
  // 75% and 100% of $10K (heads-up before the rule trips), or when
  // already over but no FBAR filed for the current year.
  function genFbarThresholdApproaching() {
    const out = [];
    const agg = computeForeignAggregateUsd();
    const status = fbarStatus(agg.usd);
    const fbar = TB.state.get('fbar') || {};
    const filings = Array.isArray(fbar.filing_history) ? fbar.filing_history : [];
    const filedThisYear = filings.some((f) => f.year === agg.year);

    if (status.level === 'approaching') {
      out.push({
        id: 'fx_fbar_approaching_' + agg.year,
        group: 'fx',
        urgency: 'medium',
        icon: '🚨',
        title: 'FBAR threshold approaching — $' + Math.round(agg.usd).toLocaleString() + ' of $10K',
        body: 'Your foreign account aggregate is within 25% of the $10K FBAR threshold. Crossing it (at any point during the year, even briefly) requires filing FinCEN 114 by April 15. Plan transfers carefully — open FX & Banking → FBAR threshold awareness for context.',
        module: 'fx-banking', snoozable: true,
      });
    } else if (status.level === 'required' && !filedThisYear) {
      out.push({
        id: 'fx_fbar_required_unfiled_' + agg.year,
        group: 'fx',
        urgency: 'high',
        icon: '🚨',
        title: 'FBAR required but not yet filed for ' + agg.year,
        body: 'Your foreign account aggregate ($' + Math.round(agg.usd).toLocaleString() +
          ') exceeded the $10K FBAR threshold. FinCEN 114 due April 15 (auto-extended to October 15). File via the BSA E-Filing System (separate from your 1040). Penalties for non-filing: up to $16,536 per report (non-willful), or the greater of $165,353 or 50% of the balance (willful).',
        module: 'fx-banking', snoozable: false,
      });
    }
    return out;
  }

  function genRateAlertTriggered() {
    const out = [];
    const alerts = getAlerts();
    if (alerts.length === 0) return out;
    const fx = currentJpyPerUsd();
    alerts.forEach((a) => {
      const triggered = a.direction === 'gt'
        ? fx.rate > a.threshold_jpy_per_usd
        : fx.rate < a.threshold_jpy_per_usd;
      if (!triggered) return;
      out.push({
        id: 'fx_alert_' + a.id,
        group: 'fx',
        urgency: 'medium',
        icon: '🔔',
        title: 'USD/JPY ' + (a.direction === 'gt' ? 'above' : 'below') + ' ¥' +
          a.threshold_jpy_per_usd + ' (now ¥' + fx.rate.toFixed(2) + ')',
        body: 'Your rate alert is triggered' + (a.label ? ': ' + a.label : '') +
          '. Open FX & Banking → Transfer cost calculator to lock in the rate, OR review the multi-currency holding strategy if you want to hold instead of convert.',
        module: 'fx-banking', snoozable: true,
      });
    });
    return out;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'FX & Banking', label_jp: '為替・銀行', render,
    searchSections: SECTIONS,
  };

  window.TB.fxBanking = {
    actionGenerators: [genFbarThresholdApproaching, genRateAlertTriggered],
    currentJpyPerUsd, liveJpyPerUsd, platformDelivers, PLATFORMS,
    computeForeignAggregateUsd, fbarStatus, FBAR_THRESHOLD_USD,
  };
})();
