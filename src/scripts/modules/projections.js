/* Taigan Bridge — modules/projections.js
 *
 * Financial Projections (v0.7.x — Phase 1)
 *
 * Year-by-year wealth projection engine. Reads starting balances and
 * allocation from assets.accounts (no double entry), reads 住民票 date
 * and tax assumptions from sofa.profile / sofa.tax_assumptions, and
 * produces a per-year row stream of balances, contributions,
 * withdrawals, taxes, Social Security, and net monthly income.
 *
 * Three tabs:
 *   • Inputs       — career, retirement timing, growth, drawdown order
 *   • Projection   — headline tiles + SVG chart + per-year breakdown
 *   • Tax Strategy — SOFA-aware Roth window, RMD reminder, bracket fill
 *
 * Tax model (Phase 1 — intentionally simplified, deepens in later phases):
 *   • Pre-住民票 — U.S. tax only. Trad IRA/401k → ordinary income at
 *     us_marginal_pct. Taxable brokerage assumed 50% gain at us_ltcg_pct.
 *     Treasuries assumed 40% interest at ordinary income.
 *     Roth/HSA/banking principal → 0.
 *   • Post-住民票 — Japan ALSO taxes everything as ordinary income or
 *     LTCG (Roth not recognized). Layered on top of U.S. tax.
 *
 * Chart: vanilla SVG, no CDN. Stacked bars for accumulation,
 * line overlay for distribution, dual y-axis (portfolio left,
 * monthly income right).
 */

(function () {
  'use strict';

  const id = 'projections';

  // ====================================================================
  // State accessors
  // ====================================================================

  function getInputs() {
    return Object.assign({}, TB.state.get('projections.inputs') || {});
  }
  function setInputField(field, value) {
    const i = getInputs();
    i[field] = value;
    TB.state.set('projections.inputs', i);
  }
  function getUiState() {
    return Object.assign({}, TB.state.get('projections.ui_state') || { active_tab: 'projection' });
  }
  function setUiField(field, value) {
    const u = getUiState();
    u[field] = value;
    TB.state.set('projections.ui_state', u);
  }

  // ====================================================================
  // Compute engine — pure functions
  // ====================================================================

  // 2024 IRS 401(k) elective deferral limit ($23,000), grown at a
  // 2.5%/year inflation assumption. SECURE 2.0 catch-up structure:
  //   • Age 50-59 / 64+ : +$7,500 (regular catch-up)
  //   • Age 60-63       : +$11,250 (Section 109 enhanced — 150% of std)
  //
  // Returns a detail object so callers can show which tier applies
  // and route catch-up dollars to the right wrapper (e.g., Section 603
  // high-earner Roth requirement).
  function irs401kLimitDetail(year, age, catchUpEnabled) {
    const inflation = Math.pow(1.025, year - 2024);
    const base = 23000 * inflation;
    let catchUp = 0;
    let catchUpKind = null; // null | 'standard50' | 'secure_60_63'
    if (catchUpEnabled && age >= 50) {
      if (age >= 60 && age <= 63) {
        catchUp = 11250 * inflation;
        catchUpKind = 'secure_60_63';
      } else {
        catchUp = 7500 * inflation;
        catchUpKind = 'standard50';
      }
    }
    return { base, catchUp, total: base + catchUp, catchUpKind, inflation };
  }
  // Back-compat alias — returns just the total. Kept so external
  // callers (TB.projections.irs401kLimit in the public API) don't break.
  function irs401kLimit(year, age, catchUpEnabled) {
    return irs401kLimitDetail(year, age, catchUpEnabled).total;
  }

  // SECURE 2.0 Section 603 — starting 2026, catch-up contributions
  // for "high earners" (prior-year FICA wages > $145K, indexed)
  // MUST go into a Roth account. If the user is over the threshold,
  // the engine routes the catch-up portion to the Roth 401(k) account
  // (falling back to the Trad 401(k) only if no Roth 401(k) exists,
  // and surfaces a warning in milestones). The base contribution
  // continues to follow the user's chosen Trad/Roth split.
  const SECTION_603_THRESHOLD_2024 = 145000;
  function section603HighEarner(year, priorYearSalary) {
    if (year < 2026) return false;
    const inflation = Math.pow(1.025, year - 2024);
    return priorYearSalary > SECTION_603_THRESHOLD_2024 * inflation;
  }

  // Find a Roth 401(k)-ish account for routing Section 603 catch-up.
  function pickRoth401k(accountState) {
    for (const a of accountState) {
      if (a.tax_wrapper === 'roth_401k' && !a.closed) return a;
    }
    return null;
  }

  // ─── Phase 4 tax helpers: NIIT / IRMAA / state / SS COLA ──────────

  // NIIT (Net Investment Income Tax) — 3.8% on net investment
  // income above MAGI thresholds. Thresholds inflation-adjusted at
  // the 2.5% baseline (in line with how IRS has historically moved
  // them — actual indexing started 2024).
  const NIIT_THRESHOLDS_2024 = {
    single: 200000, mfs: 125000, mfj: 250000, hoh: 200000,
  };
  function niitThreshold(filingStatus, year) {
    const inflation = Math.pow(1.025, Math.max(0, year - 2024));
    return (NIIT_THRESHOLDS_2024[filingStatus] || NIIT_THRESHOLDS_2024.mfj) * inflation;
  }

  // Compute NIIT for a year given the investment income (LTCG +
  // dividends + interest portion of distributions) and MAGI proxy
  // (total taxable income for the year). Returns 0 if disabled or
  // below threshold.
  function computeNiit(investmentIncome, magi, filingStatus, year, enabled) {
    if (!enabled) return 0;
    const threshold = niitThreshold(filingStatus, year);
    if (magi <= threshold) return 0;
    const overage = magi - threshold;
    const taxableInvIncome = Math.min(investmentIncome, overage);
    return Math.max(0, taxableInvIncome * 0.038);
  }

  // IRMAA — Medicare Part B + D income-related surcharge tiers.
  // Tiers from 2024 (single/MFJ); we estimate a per-person monthly
  // surcharge that grows with MAGI. Lookup uses MAGI from 2 years
  // prior (real IRS lag).
  // Returns annual surcharge dollars (12 × monthly).
  const IRMAA_TIERS_SINGLE = [
    { magi:        0, surcharge: 0 },     // standard premium only
    { magi:   103000, surcharge: 69 },    // tier 1
    { magi:   129000, surcharge: 173 },   // tier 2
    { magi:   161000, surcharge: 277 },   // tier 3
    { magi:   193000, surcharge: 381 },   // tier 4
    { magi:   500000, surcharge: 416 },   // tier 5 (cap)
  ];
  const IRMAA_TIERS_MFJ = [
    { magi:        0, surcharge: 0 },
    { magi:   206000, surcharge: 69 },
    { magi:   258000, surcharge: 173 },
    { magi:   322000, surcharge: 277 },
    { magi:   386000, surcharge: 381 },
    { magi:  1000000, surcharge: 416 },
  ];
  function irmaaSurcharge(magi, filingStatus, year) {
    const tiers = (filingStatus === 'mfj') ? IRMAA_TIERS_MFJ : IRMAA_TIERS_SINGLE;
    const inflation = Math.pow(1.025, Math.max(0, year - 2024));
    let monthly = 0;
    for (const t of tiers) {
      if (magi >= t.magi * inflation) monthly = t.surcharge * inflation;
      else break;
    }
    return monthly * 12;
  }

  // State tax — simple flat % on taxable income (rough but useful).
  function computeStateTax(taxableIncome, statePct) {
    if (!statePct || statePct <= 0) return 0;
    return taxableIncome * (statePct / 100);
  }

  // ─── Roth conversion processing (Phase 3) ─────────────────────────
  //
  // Each conversion moves `amount` USD from the largest available
  // Traditional wrapper (traditional_401k_tsp first, then traditional_ira)
  // to the largest Roth wrapper (roth_401k first, then roth_ira). The
  // converted amount is added to the year's ordinary income and taxed
  // at the user's US marginal rate (and JP marginal rate post-住民票,
  // which is exactly the trap the SOFA Roth Planner exists to surface).
  //
  // Returns { converted, us_tax, jp_tax } so the caller can record
  // these in the row separately from withdrawal taxes.

  function pickTradAccount(accountState) {
    for (const w of ['traditional_401k_tsp', 'traditional_ira']) {
      let best = null;
      for (const a of accountState) {
        if (a.tax_wrapper === w && !a.closed && a.balance_usd > 0) {
          if (!best || a.balance_usd > best.balance_usd) best = a;
        }
      }
      if (best) return best;
    }
    return null;
  }
  function pickRothAccount(accountState) {
    for (const w of ['roth_401k', 'roth_ira']) {
      let best = null;
      for (const a of accountState) {
        if (a.tax_wrapper === w && !a.closed) {
          if (!best || a.balance_usd > best.balance_usd) best = a;
        }
      }
      if (best) return best;
    }
    return null;
  }

  function processRothConversion(accountState, requested, isPostJuminhyou, taxAssump) {
    if (!requested || requested <= 0) return { converted: 0, us_tax: 0, jp_tax: 0 };
    const trad = pickTradAccount(accountState);
    if (!trad) return { converted: 0, us_tax: 0, jp_tax: 0, no_trad: true };
    const roth = pickRothAccount(accountState);
    if (!roth) return { converted: 0, us_tax: 0, jp_tax: 0, no_roth: true };
    const actual = Math.min(requested, trad.balance_usd);
    trad.balance_usd -= actual;
    if (trad.balance_usd <= 0.01) { trad.balance_usd = 0; trad.closed = true; }
    roth.balance_usd += actual;
    // Tax: ordinary-income treatment in both jurisdictions when
    // post-住民票. Pre-住民票 = US only.
    const usOrd = (taxAssump.us_marginal_pct || 22) / 100;
    const jpOrd = (taxAssump.jp_marginal_pct || 25) / 100;
    return {
      converted: actual,
      us_tax: actual * usOrd,
      jp_tax: isPostJuminhyou ? actual * jpOrd : 0,
    };
  }

  // ─── Early-withdrawal penalty model (Rule of 55) ──────────────────
  //
  // Phase 2 addition: a 10% (or 20% for HSA) federal early-withdrawal
  // penalty applies when distributions come out of certain wrappers
  // before age 59½ (or 65 for HSA). Rule of 55 exempts 401(k)/TSP/
  // 403(b) distributions if the participant separated from service
  // in or after the year they turn 55 (i.e., retire_age >= 55).
  //
  // Caveats: doesn't model 72(t) SEPP, doesn't model the Roth 5-year
  // rule (treats Roth 401(k) as covered by Rule of 55 when applicable;
  // treats Roth IRA as fully penalized for simplicity — which is wrong
  // for contribution-portion withdrawals but right enough for planning).
  function computePenalty(byWrapper, age, retireAge) {
    if (age >= 59.5) return 0; // standard exemption age
    let pen = 0;
    for (const [w, amt] of Object.entries(byWrapper || {})) {
      if (!amt) continue;
      // Employer plans — Rule of 55 exempts when separated at 55+.
      if (w === 'traditional_401k_tsp' || w === 'roth_401k') {
        if (retireAge >= 55) continue;
        pen += amt * 0.10;
      }
      // IRAs — Rule of 55 does NOT apply. Always 10% before 59½.
      else if (w === 'traditional_ira' || w === 'roth_ira') {
        pen += amt * 0.10;
      }
      // HSA — 20% (not 10%) before age 65, only on non-medical withdrawals.
      // We can't tell medical from non-medical at projection time; assume
      // worst case (non-medical) and let the user see the cost.
      else if (w === 'hsa' && age < 65) {
        pen += amt * 0.20;
      }
    }
    return pen;
  }

  // SS benefit multiplier vs. PIA (the 100% benefit at FRA = 67).
  // 70% at age 62 (early), 124% at age 70 (delayed). Linear-ish
  // interpolation that matches the SSA published reduction/credit
  // schedule closely enough for planning use.
  function ssBenefitMultiplier(startAge) {
    if (startAge <= 62) return 0.70;
    if (startAge >= 70) return 1.24;
    if (startAge < 67) return 0.70 + (startAge - 62) * (0.30 / 5);
    return 1.00 + (startAge - 67) * (0.24 / 3);
  }

  // Convert allocation map → blended growth rate using per-class rates
  // from inputs. Returns a decimal (e.g., 0.063 = 6.3%).
  function blendGrowthRate(alloc, inputs) {
    const a = alloc || {};
    return (
      (a.equity_us    || 0) * (inputs.growth_equity_us_pct    / 100) +
      (a.equity_intl  || 0) * (inputs.growth_equity_intl_pct  / 100) +
      (a.bond         || 0) * (inputs.growth_bond_pct         / 100) +
      (a.cash         || 0) * (inputs.growth_cash_pct         / 100) +
      (a.real_estate  || 0) * (inputs.growth_real_estate_pct  / 100) +
      (a.alternative  || 0) * (inputs.growth_alternative_pct  / 100)
    );
  }

  // Resolve allocation: prefer account.allocation, fall back to wrapper
  // default from the assets module.
  function resolveAllocation(account) {
    if (TB.assets && typeof TB.assets.getActiveAccounts === 'function') {
      const explicit = account && account.allocation;
      const hasAny = explicit && Object.values(explicit).some((v) => Number(v) > 0);
      if (hasAny) return explicit;
    }
    // Fallback wrapper-driven default
    const wrappers = (TB.assets && TB.assets.WRAPPER_BY_ID) || {};
    const defaults = {
      taxable_brokerage:    { equity_us: 0.85, equity_intl: 0.15 },
      traditional_ira:      { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
      traditional_401k_tsp: { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
      roth_ira:             { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
      roth_401k:            { equity_us: 0.70, equity_intl: 0.20, bond: 0.10 },
      hsa: { cash: 1 }, us_checking: { cash: 1 }, us_savings: { cash: 1 }, us_cd: { cash: 1 },
      jp_savings: { cash: 1 }, jp_checking: { cash: 1 }, jp_fixed_deposit: { cash: 1 },
      us_savings_bond: { bond: 1 }, us_treasury: { bond: 1 },
      us_real_estate: { real_estate: 1 }, '529': { equity_us: 0.85, bond: 0.15 },
      rsu_unvested: { equity_us: 1 }, nso_iso: { equity_us: 1 }, deferred_comp: { equity_us: 1 },
      other: { cash: 1 },
    };
    return defaults[(account && account.tax_wrapper) || 'other'] || { cash: 1 };
  }

  // Pick the "primary" 401(k)-ish account to credit annual employee
  // contribs + employer match into. Order: traditional_401k_tsp first
  // (most common), then roth_401k, then traditional_ira, roth_ira.
  // Returns null when no eligible account exists.
  function pickPrimary401k(accountState) {
    const order = ['traditional_401k_tsp', 'roth_401k', 'traditional_ira', 'roth_ira'];
    for (const wrapper of order) {
      for (const a of accountState) {
        if (a.tax_wrapper === wrapper && !a.closed) return a;
      }
    }
    return null;
  }

  // Sum balances across all non-closed accounts.
  function sumPortfolio(accountState) {
    let sum = 0;
    for (const a of accountState) if (!a.closed) sum += a.balance_usd;
    return sum;
  }

  // Apply withdrawal across accounts in the configured drawdown order.
  // Returns { actual_withdrawn, by_wrapper: { wrapper_id: amount } }.
  // Mutates accountState (subtracts balances, marks closed when zeroed).
  function applyDrawdown(accountState, target, drawdownOrder) {
    let remaining = target;
    const byWrapper = {};
    for (const wrapper of drawdownOrder) {
      if (remaining <= 0) break;
      for (const a of accountState) {
        if (a.tax_wrapper !== wrapper || a.closed) continue;
        const take = Math.min(a.balance_usd, remaining);
        a.balance_usd -= take;
        remaining -= take;
        byWrapper[wrapper] = (byWrapper[wrapper] || 0) + take;
        if (a.balance_usd <= 0.01) {
          a.balance_usd = 0;
          a.closed = true;
        }
      }
    }
    return { actual: target - remaining, by_wrapper: byWrapper };
  }

  // U.S. federal tax on the year's withdrawals. Simplified Phase-1
  // model — see header comment for caveats.
  function computeUsTax(byWrapper, taxAssump) {
    const ord = (taxAssump.us_marginal_pct || 22) / 100;
    const ltcg = (taxAssump.us_ltcg_pct || 15) / 100;
    let tax = 0;
    for (const [w, amt] of Object.entries(byWrapper || {})) {
      if (w === 'traditional_ira' || w === 'traditional_401k_tsp') tax += amt * ord;
      else if (w === 'taxable_brokerage')                          tax += amt * 0.5 * ltcg;
      else if (w === 'us_savings_bond' || w === 'us_treasury')     tax += amt * 0.4 * ord;
      // roth_ira / roth_401k / hsa / banking / real_estate principal: 0
    }
    return tax;
  }

  // Japan tax stacked on top of U.S. tax once 住民票 is registered.
  // Roth wrappers are NOT recognized — JP taxes their distributions
  // as ordinary income.
  function computeJpTax(byWrapper, taxAssump) {
    const ord = (taxAssump.jp_marginal_pct || 25) / 100;
    const ltcg = (taxAssump.jp_ltcg_pct || 20.315) / 100;
    let tax = 0;
    for (const [w, amt] of Object.entries(byWrapper || {})) {
      if (w === 'traditional_ira' || w === 'traditional_401k_tsp' ||
          w === 'roth_ira' || w === 'roth_401k') {
        tax += amt * ord;
      } else if (w === 'taxable_brokerage') {
        tax += amt * 0.5 * ltcg;
      } else if (w === 'us_savings_bond' || w === 'us_treasury') {
        tax += amt * 0.4 * ord;
      }
    }
    return tax;
  }

  // ====================================================================
  // Roth Conversion Ladder Optimizer (v0.36)
  // ====================================================================
  //
  // Computes the optimal annual Roth conversion ladder by filling the
  // user's target US bracket each year between now and 住民票
  // registration (after which JP also taxes the conversion as ordinary
  // income, making it punitive).
  //
  // Strategy:
  //   For each pre-住民票 year, project base taxable income (salary +
  //   taxable SS + 4% withdrawal proxy if drawing) − standard deduction,
  //   then convert ENOUGH to fill the chosen bracket without spilling
  //   into the next. Cap at remaining Traditional balance.
  //
  // Fact-check anchor: 2025 IRS brackets + standard deductions. Future
  // years inflation-adjust at 2.5% (matching irs401kLimit + niitThreshold).
  //
  // US 2025 bracket tops (single):
  //   10%   $11,925  /  12%   $48,475  /  22%  $103,350
  //   24%  $197,300  /  32%  $250,525  /  35%  $626,350  /  37% >$626,350
  // MFJ 2025:
  //   10%   $23,850  /  12%   $96,950  /  22%  $206,700
  //   24%  $394,600  /  32%  $501,050  /  35%  $751,600  /  37% >$751,600
  // Standard deduction 2025:
  //   single $15,000  /  mfj $30,000  /  mfs $15,000  /  hoh $22,500

  const US_BRACKETS_2025 = {
    single: [
      { rate: 10, top: 11925 },
      { rate: 12, top: 48475 },
      { rate: 22, top: 103350 },
      { rate: 24, top: 197300 },
      { rate: 32, top: 250525 },
      { rate: 35, top: 626350 },
      { rate: 37, top: Infinity },
    ],
    mfs: [
      { rate: 10, top: 11925 },
      { rate: 12, top: 48475 },
      { rate: 22, top: 103350 },
      { rate: 24, top: 197300 },
      { rate: 32, top: 250525 },
      { rate: 35, top: 375800 },
      { rate: 37, top: Infinity },
    ],
    mfj: [
      { rate: 10, top: 23850 },
      { rate: 12, top: 96950 },
      { rate: 22, top: 206700 },
      { rate: 24, top: 394600 },
      { rate: 32, top: 501050 },
      { rate: 35, top: 751600 },
      { rate: 37, top: Infinity },
    ],
    hoh: [
      { rate: 10, top: 17000 },
      { rate: 12, top: 64850 },
      { rate: 22, top: 103350 },
      { rate: 24, top: 197300 },
      { rate: 32, top: 250500 },
      { rate: 35, top: 626350 },
      { rate: 37, top: Infinity },
    ],
  };
  const US_STD_DEDUCTION_2025 = { single: 15000, mfs: 15000, mfj: 30000, hoh: 22500 };

  function bracketsForYear(filingStatus, year) {
    const baseFs = (filingStatus && US_BRACKETS_2025[filingStatus]) ? filingStatus : 'mfj';
    const inflation = Math.pow(1.025, year - 2025);
    return US_BRACKETS_2025[baseFs].map((b) => ({
      rate: b.rate,
      top: isFinite(b.top) ? b.top * inflation : Infinity,
    }));
  }

  function stdDeductionForYear(filingStatus, year) {
    const base = US_STD_DEDUCTION_2025[filingStatus] != null
      ? US_STD_DEDUCTION_2025[filingStatus] : US_STD_DEDUCTION_2025.mfj;
    return base * Math.pow(1.025, year - 2025);
  }

  // "Top of bracket" lookup — for a given filing status + target rate
  // (e.g., 22), returns the top dollar amount of THAT bracket (i.e.,
  // the most you can earn and still pay no more than 22% on any dollar).
  function bracketTopAtRate(filingStatus, year, targetRate) {
    const brackets = bracketsForYear(filingStatus, year);
    const b = brackets.find((x) => x.rate === targetRate);
    return b ? b.top : null;
  }

  // Compute taxable Social Security. SSA Provisional Income method:
  //   • Up to 50% of benefits taxable when combined income exceeds
  //     base ($25k single / $32k MFJ)
  //   • Up to 85% taxable when combined income exceeds upper ($34k / $44k)
  // For optimizer purposes we use the 85% upper-bound for any year SS
  // is being claimed AND base income > upper threshold — most retirees
  // with $100k+ income hit this. Conservative for ladder sizing.
  function taxableSsForOptimizer(ssMonthly, otherIncome, filingStatus) {
    if (!ssMonthly || ssMonthly <= 0) return 0;
    const annualSs = ssMonthly * 12;
    const upper = filingStatus === 'mfj' ? 44000 : 34000;
    if (otherIncome + annualSs * 0.5 > upper) return annualSs * 0.85;
    const lower = filingStatus === 'mfj' ? 32000 : 25000;
    if (otherIncome + annualSs * 0.5 > lower) return annualSs * 0.50;
    return 0;
  }

  // Optimizer entry point. Returns an array of { year, age, amount_usd,
  // base_taxable, headroom, target_top, capped_by } sorted by year.
  // capped_by ∈ 'bracket' (filled to top) | 'balance' (ran out of Trad)
  // | 'window' (last year before 住民票).
  //
  // opts:
  //   target_rate    : 12 | 22 | 24 | 32 (default 22)
  //   stop_at_juminhyou : default true — skip conversions in/after 住民票 year
  //   include_post_retire_acceleration : default true — in pre-RMD post-retire
  //                    years with very low income, push to TOP of bracket
  //   max_per_year   : optional cap (e.g., user only wants $X/yr max)
  function optimizeRothLadder(inputs, accounts, sofaProfile, opts) {
    opts = opts || {};
    const targetRate = opts.target_rate || 22;
    const stopAtJ = opts.stop_at_juminhyou !== false;
    const accelerate = opts.include_post_retire_acceleration !== false;
    const maxPerYear = opts.max_per_year != null ? Number(opts.max_per_year) : null;

    const startYear = new Date().getFullYear();
    const startAge = inputs.current_age;
    const filingStatus = inputs.filing_status || 'mfj';

    // Determine 住民票 year (last optimal year is the one before it).
    let juminhyouYear = null;
    if (sofaProfile && sofaProfile.juminhyou_target_date) {
      const m = String(sofaProfile.juminhyou_target_date).match(/^(\d{4})/);
      if (m) juminhyouYear = parseInt(m[1], 10);
    }

    // Total Traditional balance available to convert. Optimizer won't
    // recommend more than this in aggregate.
    let tradBalance = 0;
    for (const a of accounts) {
      if (a.tax_wrapper === 'traditional_ira' || a.tax_wrapper === 'traditional_401k_tsp') {
        tradBalance += TB.assets.toUsd(a.balance_native, a.currency) || 0;
      }
    }
    if (tradBalance <= 0) return { rows: [], total_converted_usd: 0, reason: 'no_trad_balance' };

    // Horizon — extend out to retirement + 5 (cap at 住民票 if set).
    const endYear = juminhyouYear != null && stopAtJ
      ? juminhyouYear - 1
      : Math.max(startYear + (inputs.retire_age - inputs.current_age) + 5, startYear + 3);
    if (endYear <= startYear) return { rows: [], total_converted_usd: 0, reason: 'window_closed' };

    const rows = [];
    let remainingBalance = tradBalance;

    for (let year = startYear + 1; year <= endYear; year++) {
      if (remainingBalance <= 0) break;
      const age = startAge + (year - startYear);

      // Estimated base taxable income for the year:
      //   salary while working
      //   taxable SS once claimed
      //   small drawdown proxy if retired (4% of taxable brokerage est.)
      let baseTaxableIncome = 0;
      const retireYear = startYear + (inputs.retire_age - inputs.current_age);
      const isWorking = year < retireYear;
      if (isWorking && inputs.current_salary_usd) {
        const yearsFromNow = year - startYear;
        baseTaxableIncome += (inputs.current_salary_usd || 0) * Math.pow(1.03, yearsFromNow);
      }
      // SS taxable portion if claimed
      if (inputs.ss_start_age && age >= inputs.ss_start_age) {
        const monthly = (inputs.ss_monthly_at_70_usd || 0) * ssBenefitMultiplier(inputs.ss_start_age);
        baseTaxableIncome += taxableSsForOptimizer(monthly, baseTaxableIncome, filingStatus);
      }
      // Subtract standard deduction
      const stdDed = stdDeductionForYear(filingStatus, year);
      const taxableBeforeConv = Math.max(0, baseTaxableIncome - stdDed);

      // Compute bracket headroom — amount of conversion that fills
      // the target bracket without spilling.
      const targetTop = bracketTopAtRate(filingStatus, year, targetRate);
      if (targetTop == null) continue;
      let headroom = Math.max(0, targetTop - taxableBeforeConv);

      // In post-retirement, pre-RMD years (62 → 72), be more aggressive:
      // these are typically very low-income years where a 22-24% bracket
      // fill is the highest-leverage move. Already handled by the
      // headroom math, but skip the noise floor.
      if (accelerate && !isWorking && age >= 62 && age <= 72) {
        // Push to top of next-higher bracket if user picked 22% but
        // headroom there is already > $100k (signals they have lots
        // of room to convert at low rates).
        const nextTier = targetRate === 22 ? 24 : targetRate === 24 ? 32 : null;
        if (nextTier && headroom > 100000) {
          const nextTop = bracketTopAtRate(filingStatus, year, nextTier);
          if (nextTop != null) {
            // Don't actually expand — but flag this for the UI to
            // show "consider 24% bracket here for $X more conversion".
          }
        }
      }

      if (maxPerYear != null) headroom = Math.min(headroom, maxPerYear);

      // Cap at remaining balance
      let amount = Math.min(headroom, remainingBalance);
      // Skip tiny amounts — they're not worth the recordkeeping
      if (amount < 1000) continue;
      // Round to nearest $1k for a cleaner ladder
      amount = Math.round(amount / 1000) * 1000;
      if (amount <= 0) continue;

      const capped_by = (amount >= headroom - 1) ? 'bracket' :
                        (amount >= remainingBalance - 1) ? 'balance' : 'partial';
      rows.push({
        year, age,
        amount_usd: amount,
        base_taxable: Math.round(baseTaxableIncome),
        target_top: Math.round(targetTop),
        headroom: Math.round(headroom),
        capped_by,
        approx_us_tax: amount * targetRate / 100,
      });
      remainingBalance -= amount;
    }

    // Tag the last row's reason for stopping the ladder.
    if (rows.length > 0 && stopAtJ && juminhyouYear != null && rows[rows.length - 1].year === juminhyouYear - 1) {
      rows[rows.length - 1].capped_by = 'window';
    }

    const totalConverted = rows.reduce((s, r) => s + r.amount_usd, 0);
    const totalUsTax = rows.reduce((s, r) => s + r.approx_us_tax, 0);
    return {
      rows,
      total_converted_usd: totalConverted,
      total_us_tax_usd: totalUsTax,
      remaining_trad_balance_usd: remainingBalance,
      juminhyou_year: juminhyouYear,
      target_rate: targetRate,
      effective_rate_pct: totalConverted > 0 ? (totalUsTax / totalConverted) * 100 : 0,
    };
  }

  // The main projection engine. Pure function — does not touch state.
  // Returns { rows: [...], totals: {...}, milestones: {...} }.
  function computeProjection(inputs, accounts, sofaProfile, sofaTaxAssump) {
    const startYear = new Date().getFullYear();
    const startAge = inputs.current_age;
    const endAge = Math.max(startAge + 1, inputs.project_to_age);

    // Snapshot per-account state. Allocation resolved once at start —
    // we do not model glide-path rebalancing in v1.
    // Phase 2: capture close_date and transfer_to so events can fire
    // during the year loop. close_year is parsed from the YYYY-MM-DD
    // string; transfer_to is matched by name + institution at the
    // start of the year that includes close_date.
    const toUsd = (TB.assets && TB.assets.toUsd) || ((amt) => amt || 0);
    const accountState = (accounts || []).map((a) => ({
      id: a.id,
      name: a.name || '',
      institution: a.institution || '',
      tax_wrapper: a.tax_wrapper || 'other',
      currency: a.currency || 'USD',
      balance_usd: toUsd(a.balance_native, a.currency),
      allocation: resolveAllocation(a),
      blended_growth: 0,
      close_year: a.close_date && /^\d{4}/.test(a.close_date) ? parseInt(a.close_date.slice(0, 4), 10) : null,
      transfer_to: a.transfer_to || null,
      closed: false,
    }));

    // Build a name → account-state map for transfer-to resolution.
    function findTransferTarget(transferTo, fromAcct) {
      if (!transferTo) return null;
      const t = String(transferTo).toLowerCase();
      // Try exact "Institution -- Name", just Name, or just Institution.
      for (const a of accountState) {
        if (a.id === fromAcct.id || a.closed) continue;
        const inst = (a.institution || '').toLowerCase();
        const name = (a.name || '').toLowerCase();
        const combo = (inst + ' -- ' + name).toLowerCase();
        if (combo === t || name === t || inst === t) return a;
        if (t.indexOf(name) >= 0 && name) return a;
      }
      return null;
    }
    for (const a of accountState) a.blended_growth = blendGrowthRate(a.allocation, inputs);

    const juminhyouDate = sofaProfile && sofaProfile.juminhyou_target_date;
    const juminhyouYear = juminhyouDate && /^\d{4}/.test(juminhyouDate)
      ? parseInt(juminhyouDate.slice(0, 4), 10) : null;
    const taxAssump = sofaTaxAssump || {};

    const dampener = (inputs.retirement_growth_dampener_pct || 70) / 100;
    const floor = (inputs.retirement_growth_floor_pct || 4) / 100;

    const rows = [];
    let depleted = false;

    for (let age = startAge; age <= endAge; age++) {
      const year = startYear + (age - startAge);
      const isWorkingYear = age < inputs.retire_age;
      const isPostJuminhyou = juminhyouYear != null && year >= juminhyouYear;

      // 1. Salary
      const yearsWorked = age - startAge;
      const salary = isWorkingYear
        ? inputs.base_salary_usd * Math.pow(1 + (inputs.salary_growth_pct || 0) / 100, yearsWorked)
        : 0;

      // 2. Contributions + employer match (working years only).
      // SECURE 2.0 catch-up structure tracked separately so the UI
      // can show "$7.5K (50+)" or "$11.25K (60-63)" inline.
      let empContrib = 0;
      let catchUpContrib = 0;
      let catchUpKind = null;
      let employerMatch = 0;
      let priorYearSalary = 0;
      if (isWorkingYear && salary > 0) {
        const limit = irs401kLimitDetail(year, age, !!inputs.catch_up_at_50);
        const target = salary * (inputs.contrib_401k_pct || 0) / 100;
        // Allocate base limit first, catch-up second. The base number
        // is what shows up under the standard contribution; the
        // catch-up is a separate display line.
        const baseFill = Math.min(target, limit.base);
        const catchUpFill = Math.max(0, Math.min(target - baseFill, limit.catchUp));
        empContrib = baseFill;
        catchUpContrib = catchUpFill;
        catchUpKind = catchUpFill > 0 ? limit.catchUpKind : null;
        // Employer match capped at the input ceiling; LM-style 100%-on-6%
        // + 4% auto = 10% default. Real plan rules vary; user adjusts.
        employerMatch = salary * Math.min(inputs.employer_match_max_pct || 0, 100) / 100;
        // Prior-year salary for Section 603 evaluation — for the FIRST
        // year we don't have history; use current salary as a reasonable
        // approximation (within 3% inflation, the threshold check is
        // effectively the same).
        priorYearSalary = (yearsWorked > 0)
          ? inputs.base_salary_usd * Math.pow(1 + (inputs.salary_growth_pct || 0) / 100, yearsWorked - 1)
          : salary;
      }
      const section603Active = isWorkingYear && catchUpContrib > 0 &&
        section603HighEarner(year, priorYearSalary);

      // 2.4. Roth conversions for this year. Fires BEFORE growth so
      // the converted dollars compound in Roth (tax-free) for the
      // remainder of the year, and BEFORE close-date events so
      // conversions can drain a Trad account that's about to close.
      let conversionAmount = 0;
      let conversionUsTax = 0;
      let conversionJpTax = 0;
      let conversionWarnings = [];
      const yearConversions = (inputs.roth_conversions || []).filter((c) => c.year === year && c.amount_usd > 0);
      for (const c of yearConversions) {
        const r = processRothConversion(accountState, c.amount_usd, isPostJuminhyou, taxAssump);
        conversionAmount += r.converted;
        conversionUsTax  += r.us_tax;
        conversionJpTax  += r.jp_tax;
        if (r.no_trad) conversionWarnings.push('no_trad');
        if (r.no_roth) conversionWarnings.push('no_roth');
      }

      // 2.5. Account close_date events. Fires AT THE START of the
      // close_year — the account stops growing for that year and its
      // balance transfers to the designated target (or, if none, just
      // closes and the user's drawdown sequencing picks up from the
      // remaining accounts). Tracked in row.events for display.
      const yearEvents = [];
      for (const a of accountState) {
        if (a.closed || a.close_year !== year) continue;
        const target = findTransferTarget(a.transfer_to, a);
        if (target) {
          target.balance_usd += a.balance_usd;
          yearEvents.push({
            type: 'transfer',
            from_id: a.id, from_name: a.name,
            to_id: target.id, to_name: target.name,
            amount_usd: a.balance_usd,
          });
        } else {
          yearEvents.push({
            type: 'close',
            from_id: a.id, from_name: a.name,
            amount_usd: a.balance_usd,
          });
        }
        a.balance_usd = 0;
        a.closed = true;
      }

      // 3. Per-account growth
      for (const a of accountState) {
        if (a.closed) continue;
        const g = isWorkingYear ? a.blended_growth : Math.max(a.blended_growth * dampener, floor);
        a.balance_usd = a.balance_usd * (1 + g);
      }

      // 4. Credit contributions to accounts.
      //   • Base + employer match → primary 401(k) account
      //   • Catch-up:
      //       - Section 603 active → must go to Roth 401(k) if available;
      //         otherwise still credited to primary with a warning milestone
      //       - Otherwise → primary 401(k) (mirrors base contribution)
      const primary = pickPrimary401k(accountState);
      if (primary && (empContrib + employerMatch) > 0) {
        primary.balance_usd += empContrib + employerMatch;
      }
      let section603RothMissing = false;
      if (catchUpContrib > 0) {
        if (section603Active) {
          const rothTarget = pickRoth401k(accountState);
          if (rothTarget) {
            rothTarget.balance_usd += catchUpContrib;
          } else {
            // No Roth 401(k) account — credit to primary anyway but
            // flag the issue. Real-world: the user must open one or
            // forfeit the catch-up.
            if (primary) primary.balance_usd += catchUpContrib;
            section603RothMissing = true;
          }
        } else if (primary) {
          primary.balance_usd += catchUpContrib;
        }
      }

      // 5. Withdrawal + tax + early-withdrawal penalty (retirement years).
      let target = 0, drawResult = { actual: 0, by_wrapper: {} };
      let usTax = 0, jpTax = 0, penalty = 0;
      if (!isWorkingYear) {
        const totalNow = sumPortfolio(accountState);
        target = inputs.monthly_target_usd
          ? inputs.monthly_target_usd * 12
          : totalNow * (inputs.withdrawal_rate_pct || 0) / 100;
        drawResult = applyDrawdown(accountState, target, inputs.drawdown_order || []);
        usTax = computeUsTax(drawResult.by_wrapper, taxAssump);
        jpTax = isPostJuminhyou ? computeJpTax(drawResult.by_wrapper, taxAssump) : 0;
        penalty = computePenalty(drawResult.by_wrapper, age, inputs.retire_age);
      }

      // 6. Social Security with annual COLA inflation. Benefit at
      // start age uses ssBenefitMultiplier; each subsequent year
      // grows by ss_cola_pct (separate from general inflation so
      // user can model COLA suppression scenarios).
      let ssAnnual = 0;
      if (age >= inputs.ss_start_age) {
        const baseBenefit = inputs.ss_monthly_at_70_usd * 12 * ssBenefitMultiplier(inputs.ss_start_age);
        const yearsCollecting = age - inputs.ss_start_age;
        const cola = (inputs.ss_cola_pct || 0) / 100;
        ssAnnual = baseBenefit * Math.pow(1 + cola, yearsCollecting);
      }

      // 6.5. Phase 4 — additional taxes/fees layered on the year's
      // total income picture. NIIT and state tax based on combined
      // ordinary + investment income. IRMAA based on MAGI from 2
      // years prior (real IRS lag).
      let niit = 0;
      let stateTax = 0;
      let irmaa = 0;
      if (!isWorkingYear) {
        // MAGI proxy = withdrawal + conversion + SS (taxable portion
        // approximated as 85% — common simplification for high-income).
        const ssTaxablePortion = ssAnnual * 0.85;
        const magi = drawResult.actual + conversionAmount + ssTaxablePortion;
        // Investment income portion = LTCG + dividends/interest from
        // taxable_brokerage and treasury wrappers.
        const invIncome = (drawResult.by_wrapper.taxable_brokerage || 0) * 0.5
                        + (drawResult.by_wrapper.us_savings_bond || 0) * 0.4
                        + (drawResult.by_wrapper.us_treasury || 0) * 0.4;
        niit = computeNiit(invIncome, magi, inputs.filing_status, year, inputs.niit_enabled);
        stateTax = computeStateTax(magi, inputs.state_tax_pct);
        // IRMAA at 65+. Uses MAGI from 2 years prior — look up the
        // row that's already been computed.
        if (age >= 65 && inputs.irmaa_enabled) {
          const lookbackRow = rows.find((r) => r.year === year - 2);
          const magiLookback = lookbackRow ? (lookbackRow.withdraw_actual + (lookbackRow.roth_conversion || 0) + lookbackRow.ss_annual * 0.85) : magi;
          irmaa = irmaaSurcharge(magiLookback, inputs.filing_status, year);
        }
      } else {
        // Working years — state tax on salary.
        stateTax = computeStateTax(salary, inputs.state_tax_pct);
      }

      // 7. Milestones
      const milestones = [];
      if (age === inputs.retire_age) milestones.push('retire');
      if (age === inputs.ss_start_age) milestones.push('ss_start');
      if (age === 50 && inputs.catch_up_at_50) milestones.push('catch_up');
      if (age === 60 && inputs.catch_up_at_50) milestones.push('catch_up_secure');
      if (age === 64 && inputs.catch_up_at_50) milestones.push('catch_up_revert');
      if (age === 55 && inputs.retire_age >= 55 && inputs.retire_age < 60) milestones.push('rule_of_55');
      if (Math.abs(age - 59.5) < 0.5) milestones.push('age_59_half');
      if (age === 65) milestones.push('medicare');
      if (age === 73) milestones.push('rmd');
      if (year === juminhyouYear) milestones.push('juminhyou');
      if (section603Active) milestones.push('section_603');
      if (section603RothMissing) milestones.push('section_603_no_roth');
      if (conversionAmount > 0) milestones.push('roth_conversion');
      if (conversionWarnings.indexOf('no_trad') !== -1) milestones.push('roth_conversion_no_trad');
      if (conversionWarnings.indexOf('no_roth') !== -1) milestones.push('roth_conversion_no_roth');

      const totalUsd = sumPortfolio(accountState);
      if (!depleted && !isWorkingYear && totalUsd <= 0) {
        milestones.push('depleted');
        depleted = true;
      }

      rows.push({
        year, age,
        phase: isWorkingYear ? 'accum' : 'dist',
        salary,
        emp_contrib: empContrib,
        catch_up_contrib: catchUpContrib,
        catch_up_kind: catchUpKind, // 'standard50' | 'secure_60_63' | null
        section_603_active: section603Active,
        employer_match: employerMatch,
        total_usd: totalUsd,
        by_account: accountState.map((a) => ({
          id: a.id, name: a.name, tax_wrapper: a.tax_wrapper,
          balance_usd: a.balance_usd, closed: a.closed,
        })),
        withdraw_target: target,
        withdraw_actual: drawResult.actual,
        withdraw_by_wrapper: drawResult.by_wrapper,
        us_tax: usTax + conversionUsTax,           // include conversion tax
        jp_tax: jpTax + conversionJpTax,
        penalty,                                    // Phase 2 early-withdrawal penalty
        roth_conversion: conversionAmount,          // Phase 3
        roth_conversion_us_tax: conversionUsTax,
        roth_conversion_jp_tax: conversionJpTax,
        // Phase 4 — additional taxes/fees
        niit,
        state_tax: stateTax,
        irmaa,
        ss_annual: ssAnnual,
        net_monthly_usd: ((drawResult.actual - usTax - jpTax - penalty - conversionUsTax - conversionJpTax - niit - stateTax - irmaa) + ssAnnual) / 12,
        is_post_juminhyou: isPostJuminhyou,
        milestones,
        events: yearEvents,
      });

      if (depleted && totalUsd <= 0 && ssAnnual <= 0) break;
    }

    // Compute headline summary tiles.
    const tileFor = (targetAge) => rows.find((r) => r.age === targetAge) || null;
    const summary = {
      portfolio_at_retire: tileFor(inputs.retire_age) ? tileFor(inputs.retire_age).total_usd : null,
      portfolio_at_80: tileFor(80) ? tileFor(80).total_usd : null,
      portfolio_at_90: tileFor(90) ? tileFor(90).total_usd : null,
      monthly_draw_at_retire: tileFor(inputs.retire_age) ? tileFor(inputs.retire_age).withdraw_actual / 12 : null,
      ss_monthly_at_start: inputs.ss_monthly_at_70_usd * ssBenefitMultiplier(inputs.ss_start_age),
      depletion_age: rows.find((r) => r.milestones.indexOf('depleted') !== -1) ? rows.find((r) => r.milestones.indexOf('depleted') !== -1).age : null,
      total_monthly_at_retire: (() => {
        const r = tileFor(inputs.retire_age);
        if (!r) return null;
        return r.net_monthly_usd;
      })(),
    };

    return { rows, summary, juminhyou_year: juminhyouYear };
  }

  // ====================================================================
  // Tab rendering
  // ====================================================================

  let host = null;
  let cachedResult = null;

  function render(container) {
    host = container;
    container.innerHTML = '';
    container.appendChild(buildScenarioBar());
    container.appendChild(buildShellCard());
    const tabHost = TB.utils.el('div', { id: 'tb-proj-tab-host' });
    container.appendChild(tabHost);
    renderActiveTab();
  }

  // ─── Scenarios bar ────────────────────────────────────────────────
  //
  // Persistent bar above the tabs. Active scenario dropdown + Save /
  // Save as new / Duplicate / Delete buttons. Marks "(unsaved)" when
  // the working inputs differ from the active scenario's saved copy.

  function buildScenarioBar() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const scenarios = TB.state.get('projections.scenarios') || [];
    const ui = getUiState();
    const inputs = getInputs();
    const active = scenarios.find((s) => s.id === ui.scenario_id) || null;
    const isDirty = active ? !inputsEqual(active.inputs, inputs) : scenarios.length > 0;

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { padding: 'var(--tb-sp-3) var(--tb-sp-4)', marginBottom: 'var(--tb-sp-3)' } });

    const row = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--tb-sp-2)',
      },
    });

    row.appendChild(el('span', {
      style: { fontWeight: '600', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', letterSpacing: '0.04em', textTransform: 'uppercase', marginRight: 'var(--tb-sp-2)' },
    }, t('proj.scenario.title')));

    const select = el('select', {
      class: 'tb-select',
      style: { maxWidth: '260px', minWidth: '180px' },
      onchange: (e) => {
        const id = e.target.value || null;
        if (!id) {
          setUiField('scenario_id', null);
          render(host);
          return;
        }
        const s = scenarios.find((x) => x.id === id);
        if (!s) return;
        TB.state.set('projections.inputs', Object.assign({}, s.inputs));
        setUiField('scenario_id', id);
        render(host);
      },
    });
    select.appendChild(el('option', { value: '' }, t('proj.scenario.draft')));
    for (const s of scenarios) {
      const opt = el('option', { value: s.id }, s.name);
      if (s.id === ui.scenario_id) opt.selected = true;
      select.appendChild(opt);
    }
    row.appendChild(select);

    if (isDirty && active) {
      row.appendChild(el('span', {
        style: { color: 'var(--tb-warn)', fontSize: 'var(--tb-fs-12)', fontStyle: 'italic' },
      }, t('proj.scenario.unsaved')));
    }

    // Save (overwrite active)
    if (active) {
      row.appendChild(el('button', {
        class: 'tb-btn',
        type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          const list = (TB.state.get('projections.scenarios') || []).map((s) =>
            s.id === active.id ? Object.assign({}, s, { inputs: Object.assign({}, inputs) }) : s,
          );
          TB.state.set('projections.scenarios', list);
          render(host);
        },
      }, t('proj.scenario.save')));
    }

    // Save as new
    row.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        const name = prompt(t('proj.scenario.namePrompt'), defaultScenarioName(scenarios));
        if (!name) return;
        const newScen = {
          id: TB.utils.uuid(),
          name: name.trim(),
          created_at: new Date().toISOString(),
          inputs: Object.assign({}, inputs),
        };
        const list = (TB.state.get('projections.scenarios') || []).slice();
        list.push(newScen);
        TB.state.set('projections.scenarios', list);
        setUiField('scenario_id', newScen.id);
        render(host);
      },
    }, '+ ' + t('proj.scenario.saveAs')));

    // Compare — only useful when there are 2+ saved scenarios.
    if (scenarios.length >= 2) {
      row.appendChild(el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openComparisonModal(),
      }, '🔀 ' + t('proj.scenario.compare')));
    }

    // Duplicate
    if (active) {
      row.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost',
        type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          const newScen = {
            id: TB.utils.uuid(),
            name: active.name + ' (copy)',
            created_at: new Date().toISOString(),
            inputs: Object.assign({}, inputs),
          };
          const list = (TB.state.get('projections.scenarios') || []).slice();
          list.push(newScen);
          TB.state.set('projections.scenarios', list);
          setUiField('scenario_id', newScen.id);
          render(host);
        },
      }, t('proj.scenario.duplicate')));

      row.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost',
        type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-error)' },
        onclick: () => {
          if (!confirm(t('proj.scenario.deleteConfirm', { name: active.name }))) return;
          const list = (TB.state.get('projections.scenarios') || []).filter((s) => s.id !== active.id);
          TB.state.set('projections.scenarios', list);
          setUiField('scenario_id', null);
          render(host);
        },
      }, '🗑'));
    }

    card.appendChild(row);

    if (scenarios.length > 0) {
      card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)', marginBottom: 0 } },
        t('proj.scenario.help')));
    }

    return card;
  }

  // Compare two inputs objects field-by-field. Used to flag "unsaved"
  // when working inputs differ from the active scenario's saved copy.
  function inputsEqual(a, b) {
    if (!a || !b) return a === b;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const va = a[k], vb = b[k];
      if (Array.isArray(va) && Array.isArray(vb)) {
        if (va.length !== vb.length) return false;
        for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
      } else if (va !== vb) {
        return false;
      }
    }
    return true;
  }

  function defaultScenarioName(existing) {
    const base = 'Scenario ' + ((existing && existing.length) ? existing.length + 1 : 1);
    return base;
  }

  // ─── Scenario comparison modal (Phase 3) ──────────────────────────
  //
  // 2-way side-by-side comparison. User picks scenario A and B from
  // dropdowns; we compute both projections and show paired headline
  // tiles with deltas (e.g., "Portfolio at 80: $4.2M (Scenario B is
  // +$340K vs Scenario A)"). Underneath, paired lifetime tax totals
  // and a quick-glance "Which is better?" verdict by net portfolio
  // outcome.

  function computeScenarioResult(scenarioInputs) {
    const accounts = (TB.assets && TB.assets.getActiveAccounts)
      ? TB.assets.getActiveAccounts() : [];
    const sofaProfile = TB.state.get('sofa.profile') || {};
    const sofaTaxAssump = TB.state.get('sofa.tax_assumptions') || {};
    return computeProjection(scenarioInputs, accounts, sofaProfile, sofaTaxAssump);
  }

  // Two-line overlay chart for the Compare modal. No bars / no
  // hover panel — just both totals on the same axes so the user
  // can see the divergence point and outcome gap.
  function renderComparisonSvg(ra, rb, nameA, nameB) {
    const W = 820, H = 280;
    const padL = 64, padR = 24, padT = 16, padB = 36;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const all = ra.rows.concat(rb.rows);
    const yearMin = all.reduce((m, r) => Math.min(m, r.year), Infinity);
    const yearMax = all.reduce((m, r) => Math.max(m, r.year), -Infinity);
    const yearSpan = Math.max(yearMax - yearMin, 1);
    const maxTotal = all.reduce((m, r) => Math.max(m, r.total_usd), 0);
    const yMax = niceCeil(maxTotal * 1.1);

    const xFor = (y) => padL + ((y - yearMin) / yearSpan) * innerW;
    const yFor = (v) => padT + innerH - (v / yMax) * innerH;

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%',
      style: 'background: var(--tb-bg-elev); border: 1px solid var(--tb-border); border-radius: var(--tb-radius-2);',
    });

    // Y gridlines + labels
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const v = yMax * (i / ySteps);
      const y = yFor(v);
      svg.appendChild(svgEl('line', {
        x1: padL, y1: y, x2: W - padR, y2: y,
        stroke: 'var(--tb-border)', 'stroke-dasharray': '2,3',
      }));
      svg.appendChild(svgEl('text', {
        x: padL - 6, y: y + 4, 'text-anchor': 'end',
        'font-size': '10', fill: 'var(--tb-text-soft)',
      }, fmtAxisM(v)));
    }

    // X-axis year ticks every ~5y
    const tickEvery = Math.max(1, Math.round(yearSpan / 8));
    for (let yr = yearMin; yr <= yearMax; yr++) {
      if ((yr - yearMin) % tickEvery !== 0 && yr !== yearMax) continue;
      svg.appendChild(svgEl('text', {
        x: xFor(yr), y: H - padB + 14, 'text-anchor': 'middle',
        'font-size': '10', fill: 'var(--tb-text-soft)',
      }, String(yr)));
    }

    function pathFor(rows, color, dash) {
      if (!rows.length) return null;
      const d = rows.map((r, i) =>
        (i === 0 ? 'M' : 'L') + xFor(r.year).toFixed(1) + ',' + yFor(r.total_usd).toFixed(1)
      ).join(' ');
      return svgEl('path', {
        d, fill: 'none', stroke: color, 'stroke-width': '2.5',
        'stroke-dasharray': dash || '',
      });
    }
    svg.appendChild(pathFor(ra.rows, '#D4A017'));
    svg.appendChild(pathFor(rb.rows, 'var(--tb-navy)'));

    // Mark divergence point — first year where totals differ by >5%.
    const aByYear = {}; ra.rows.forEach((r) => { aByYear[r.year] = r.total_usd; });
    const divergeYear = rb.rows.find((r) => {
      const aVal = aByYear[r.year];
      if (!aVal || aVal === 0) return false;
      return Math.abs(r.total_usd - aVal) / aVal > 0.05;
    });
    if (divergeYear) {
      const x = xFor(divergeYear.year);
      svg.appendChild(svgEl('line', {
        x1: x, y1: padT, x2: x, y2: padT + innerH,
        stroke: 'var(--tb-text-soft)', 'stroke-dasharray': '4,4', 'stroke-width': '1',
      }));
      svg.appendChild(svgEl('text', {
        x, y: padT - 4, 'text-anchor': 'middle',
        'font-size': '9', fill: 'var(--tb-text-soft)',
      }, 'diverge ' + divergeYear.year));
    }

    return svg;
  }

  function openComparisonModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const scenarios = TB.state.get('projections.scenarios') || [];
    if (scenarios.length < 2) return;

    // Default selections: first two scenarios.
    let aId = scenarios[0].id;
    let bId = scenarios[1].id;

    function close() { root.innerHTML = ''; }

    function render() {
      const a = scenarios.find((s) => s.id === aId);
      const b = scenarios.find((s) => s.id === bId);
      if (!a || !b) return;
      const ra = computeScenarioResult(a.inputs);
      const rb = computeScenarioResult(b.inputs);

      const backdrop = el('div', { class: 'tb-modal-backdrop' });
      const modal = el('div', { class: 'tb-modal', style: { maxWidth: '900px' } });
      backdrop.appendChild(modal);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      modal.appendChild(el('button', {
        class: 'tb-modal-close', type: 'button', onclick: close,
      }, '✕'));
      modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('proj.compare.title')));
      modal.appendChild(el('p', { class: 'tb-field-help' }, t('proj.compare.help')));

      // Scenario picker row
      function pick(side, currentId, onChange) {
        const sel = el('select', {
          class: 'tb-select',
          style: { flex: '1', maxWidth: '320px' },
          onchange: (e) => onChange(e.target.value),
        });
        for (const s of scenarios) {
          const opt = el('option', { value: s.id }, s.name);
          if (s.id === currentId) opt.selected = true;
          sel.appendChild(opt);
        }
        return sel;
      }
      modal.appendChild(el('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)', marginBottom: 'var(--tb-sp-4)' },
      },
        el('div', null,
          el('label', { class: 'tb-field-label' }, t('proj.compare.scenarioA')),
          pick('a', aId, (id) => { aId = id; render(); }),
        ),
        el('div', null,
          el('label', { class: 'tb-field-label' }, t('proj.compare.scenarioB')),
          pick('b', bId, (id) => { bId = id; render(); }),
        ),
      ));

      // Compare tiles
      function pairedTile(labelKey, va, vb, mode, atAge) {
        const opts = mode === 'mo' ? { suffix: '/mo' } : {};
        const valNode = (v) => (v != null && isFinite(v))
          ? fmtCurrencyPair(v, opts)
          : document.createTextNode('—');
        const delta = (va != null && vb != null) ? (vb - va) : null;
        const deltaPct = (va != null && va !== 0 && vb != null) ? ((vb - va) / Math.abs(va)) * 100 : null;
        const sign = (delta != null && delta >= 0) ? '+' : '';
        const deltaColor = delta == null ? 'var(--tb-text-soft)'
                         : delta >= 0 ? 'var(--tb-success)' : 'var(--tb-error)';
        const inlineOpts = Object.assign({}, opts, { layout: 'inline' });
        const deltaRow = delta != null ? el('div', {
          style: { color: deltaColor, fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', marginTop: '4px' },
        },
          el('span', null, sign),
          fmtCurrencyPair(delta, inlineOpts),
          el('span', null, deltaPct != null ? ' (' + sign + deltaPct.toFixed(1) + '%)' : ''),
        ) : null;
        return el('div', {
          style: {
            background: 'var(--tb-bg)', border: '1px solid var(--tb-border)',
            borderRadius: 'var(--tb-radius-2)', padding: 'var(--tb-sp-3)',
          },
        },
          el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
            t(labelKey) + (atAge != null ? ' ' + t('proj.tile.at_age', { age: atAge }) : '')),
          el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '4px' } },
            el('div', null,
              el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } }, a.name),
              el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, valNode(va)),
            ),
            el('div', null,
              el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } }, b.name),
              el('div', { style: { fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, valNode(vb)),
            ),
          ),
          deltaRow,
        );
      }

      const sa = ra.summary, sb = rb.summary;
      modal.appendChild(el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--tb-sp-3)' },
      },
        pairedTile('proj.tile.portfolio_at_retire', sa.portfolio_at_retire, sb.portfolio_at_retire, 'usd', a.inputs.retire_age),
        pairedTile('proj.tile.monthly_draw',        sa.monthly_draw_at_retire, sb.monthly_draw_at_retire, 'mo'),
        pairedTile('proj.tile.total_monthly',       sa.total_monthly_at_retire, sb.total_monthly_at_retire, 'mo'),
        pairedTile('proj.tile.portfolio_at_80',     sa.portfolio_at_80, sb.portfolio_at_80, 'usd'),
        pairedTile('proj.tile.portfolio_at_90',     sa.portfolio_at_90, sb.portfolio_at_90, 'usd'),
      ));

      // ─── Overlay chart — both total-portfolio lines on one SVG ────
      const chartCard = el('div', {
        style: {
          marginTop: 'var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
          padding: 'var(--tb-sp-3)',
        },
      });
      chartCard.appendChild(el('h3', { style: { marginTop: 0 } }, t('proj.compare.chart.title')));
      chartCard.appendChild(renderComparisonSvg(ra, rb, a.name, b.name));
      // Mini legend
      chartCard.appendChild(el('div', {
        style: { display: 'flex', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
      },
        el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
          el('span', { style: { width: '12px', height: '3px', background: '#D4A017', display: 'inline-block' } }),
          el('span', null, a.name)),
        el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
          el('span', { style: { width: '12px', height: '3px', background: 'var(--tb-navy)', display: 'inline-block' } }),
          el('span', null, b.name)),
      ));
      modal.appendChild(chartCard);

      // Lifetime totals + verdict
      function sumOver(rows, key) { let s = 0; for (const r of rows) s += (r[key] || 0); return s; }
      const aUs = sumOver(ra.rows, 'us_tax');
      const aJp = sumOver(ra.rows, 'jp_tax');
      const aPen = sumOver(ra.rows, 'penalty');
      const bUs = sumOver(rb.rows, 'us_tax');
      const bJp = sumOver(rb.rows, 'jp_tax');
      const bPen = sumOver(rb.rows, 'penalty');
      const aLifetime = aUs + aJp + aPen;
      const bLifetime = bUs + bJp + bPen;

      const taxCard = el('div', {
        style: {
          background: 'var(--tb-bg)', border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)', padding: 'var(--tb-sp-3)',
          marginTop: 'var(--tb-sp-3)',
        },
      });
      taxCard.appendChild(el('h3', { style: { marginTop: 0 } }, t('proj.compare.lifetime')));
      taxCard.appendChild(el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' } },
        el('div', null,
          el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, a.name),
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
            t('proj.tax.lifetime.us') + ': ', fmtCurrencyPair(aUs, { layout: 'inline' })),
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
            t('proj.tax.lifetime.jp') + ': ', fmtCurrencyPair(aJp, { layout: 'inline' })),
          aPen > 0 ? el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-error)' } },
            t('proj.tax.lifetime.penalty') + ': ', fmtCurrencyPair(aPen, { layout: 'inline' })) : null,
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', marginTop: '4px' } },
            t('proj.compare.totalTax') + ': ', fmtCurrencyPair(aLifetime, { layout: 'inline' })),
        ),
        el('div', null,
          el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, b.name),
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
            t('proj.tax.lifetime.us') + ': ', fmtCurrencyPair(bUs, { layout: 'inline' })),
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
            t('proj.tax.lifetime.jp') + ': ', fmtCurrencyPair(bJp, { layout: 'inline' })),
          bPen > 0 ? el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-error)' } },
            t('proj.tax.lifetime.penalty') + ': ', fmtCurrencyPair(bPen, { layout: 'inline' })) : null,
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', marginTop: '4px' } },
            t('proj.compare.totalTax') + ': ', fmtCurrencyPair(bLifetime, { layout: 'inline' })),
        ),
      ));

      // Verdict — by portfolio at end-of-projection (most actionable
      // single number; lower lifetime tax is good but doesn't tell
      // the whole story).
      const aLast = ra.rows[ra.rows.length - 1];
      const bLast = rb.rows[rb.rows.length - 1];
      const aEnd = aLast ? aLast.total_usd : 0;
      const bEnd = bLast ? bLast.total_usd : 0;
      const winner = aEnd > bEnd ? a : b;
      const margin = Math.abs(aEnd - bEnd);
      taxCard.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'rgba(47, 111, 78, 0.08)', borderRadius: 'var(--tb-radius-1)',
          fontWeight: '600',
        },
      },
        el('span', null, t('proj.compare.verdict.lead', { name: winner.name }) + ' '),
        fmtCurrencyPair(margin, { layout: 'inline' }),
        el('span', null, ' ' + t('proj.compare.verdict.trail')),
      ));
      modal.appendChild(taxCard);

      modal.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' },
      },
        el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          onclick: close,
        }, t('assets.modal.close')),
      ));

      root.innerHTML = '';
      root.appendChild(backdrop);
    }

    render();
  }

  function buildShellCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ui = getUiState();
    const tabs = [
      { id: 'projection',    label: t('proj.tab.projection') },
      { id: 'inputs',        label: t('proj.tab.inputs') },
      { id: 'tax_strategy',  label: t('proj.tab.tax_strategy') },
    ];
    const tabBar = el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' },
    },
      ...tabs.map((tab) => el('button', {
        class: 'tb-btn ' + (ui.active_tab === tab.id ? '' : 'tb-btn--secondary'),
        onclick: () => { setUiField('active_tab', tab.id); renderActiveTab(); render(host); },
      }, tab.label)),
    );
    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge' }, t('proj.badge')),
      ),
      el('h1', null, t('proj.title')),
      el('p', { class: 'tb-card-meta' }, t('proj.subtitle')),
      tabBar,
    );
  }

  function renderActiveTab() {
    const tabHost = host && host.querySelector('#tb-proj-tab-host');
    if (!tabHost) return;
    tabHost.innerHTML = '';
    const ui = getUiState();
    cachedResult = computeForCurrentState();
    if (ui.active_tab === 'inputs') return renderInputsTab(tabHost);
    if (ui.active_tab === 'tax_strategy') return renderTaxStrategyTab(tabHost);
    return renderProjectionTab(tabHost);
  }

  function computeForCurrentState() {
    const inputs = getInputs();
    const accounts = (TB.assets && TB.assets.getActiveAccounts)
      ? TB.assets.getActiveAccounts() : [];
    const sofaProfile = TB.state.get('sofa.profile') || {};
    const sofaTaxAssump = TB.state.get('sofa.tax_assumptions') || {};
    return computeProjection(inputs, accounts, sofaProfile, sofaTaxAssump);
  }

  // ====================================================================
  // Inputs tab
  // ====================================================================

  function renderInputsTab(host) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const inputs = getInputs();

    // SOFA window countdown banner — only shown for SOFA-status users
    // with a 住民票 target date. Conveys "this many years of tax-
    // advantaged conversion runway remain" and the cost-per-year of
    // inaction. Anchors the optimizer + bracket-fill buttons in the
    // Tax Strategy tab.
    const sofaProfile = TB.state.get('sofa.profile') || {};
    if (sofaProfile.juminhyou_target_date) {
      const today = new Date();
      const target = new Date(sofaProfile.juminhyou_target_date + 'T00:00:00');
      const days = Math.round((target - today) / (1000 * 60 * 60 * 24));
      const years = days / 365.25;
      if (days > 0) {
        // Estimated annual conversion runway at 22% target bracket
        const accounts = (TB.assets && TB.assets.getActiveAccounts) ? TB.assets.getActiveAccounts() : [];
        const opt = optimizeRothLadder(inputs, accounts, sofaProfile, { target_rate: 22 });
        const yearsOfRunway = opt.rows.length;
        const totalConvertible = Math.round(opt.total_converted_usd);
        const perYearEstimate = yearsOfRunway > 0 ? Math.round(opt.total_converted_usd / yearsOfRunway) : 0;
        const banner = el('div', {
          class: 'tb-card',
          style: {
            borderLeft: '4px solid var(--tb-warn)',
            background: 'rgba(185, 122, 26, 0.08)',
            marginBottom: 'var(--tb-sp-3)',
          },
        });
        banner.appendChild(el('div', {
          style: { fontWeight: '600', color: 'var(--tb-warn)', marginBottom: '4px', fontSize: 'var(--tb-fs-16)' },
        }, '⏳ ' + t('proj.inputs.window.title', {
          years: years.toFixed(1),
          date: sofaProfile.juminhyou_target_date,
        })));
        if (yearsOfRunway > 0 && totalConvertible > 0) {
          banner.appendChild(el('p', { style: { margin: '0 0 var(--tb-sp-2)' } },
            t('proj.inputs.window.body', {
              n: yearsOfRunway,
              total: '$' + totalConvertible.toLocaleString(),
              perYear: '$' + perYearEstimate.toLocaleString(),
            })));
        } else {
          banner.appendChild(el('p', { style: { margin: '0 0 var(--tb-sp-2)' } },
            t('proj.inputs.window.noOpps')));
        }
        // Quick-link to Tax Strategy tab where the optimizer lives.
        banner.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary',
          type: 'button',
          style: { fontSize: 'var(--tb-fs-12)' },
          onclick: () => { setUiField('active_tab', 'tax_strategy'); renderActiveTab(); },
        }, '🎯 ' + t('proj.inputs.window.gotoOptimizer')));
        host.appendChild(banner);
      }
    }

    function numField(labelKey, helpKey, field, opts) {
      opts = opts || {};
      const input = el('input', {
        type: 'number', class: 'tb-input',
        step: opts.step || 'any', min: opts.min, max: opts.max,
        value: inputs[field] != null ? inputs[field] : '',
        onchange: (e) => {
          const v = parseFloat(e.target.value);
          setInputField(field, isFinite(v) ? v : null);
          renderActiveTab();
        },
      });
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, t(labelKey)),
        input,
        helpKey ? el('div', { class: 'tb-field-help' }, t(helpKey)) : null,
      );
    }

    function checkField(labelKey, helpKey, field) {
      const input = el('input', {
        type: 'checkbox', checked: !!inputs[field],
        style: { marginRight: '8px' },
        onchange: (e) => { setInputField(field, !!e.target.checked); renderActiveTab(); },
      });
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
          input, t(labelKey)),
        helpKey ? el('div', { class: 'tb-field-help' }, t(helpKey)) : null,
      );
    }

    function section(titleKey, ...children) {
      return el('div', {
        class: 'tb-card',
        style: { background: 'var(--tb-bg)', marginBottom: 'var(--tb-sp-3)' },
      },
        el('h3', { style: { marginTop: 0 } }, t(titleKey)),
        ...children,
      );
    }

    function grid(...children) {
      return el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--tb-sp-3)' },
      }, ...children);
    }

    const out = el('div');

    // Career
    out.appendChild(section('proj.section.career',
      grid(
        numField('proj.field.base_salary',     'proj.field.base_salary.help',     'base_salary_usd'),
        numField('proj.field.salary_growth',   'proj.field.salary_growth.help',   'salary_growth_pct',   { step: '0.1' }),
        numField('proj.field.contrib_401k',    'proj.field.contrib_401k.help',    'contrib_401k_pct',    { step: '0.5', min: '0', max: '100' }),
        numField('proj.field.employer_match',  'proj.field.employer_match.help',  'employer_match_max_pct', { step: '0.5', min: '0', max: '100' }),
      ),
      checkField('proj.field.catch_up', 'proj.field.catch_up.help', 'catch_up_at_50'),
    ));

    // Retirement
    out.appendChild(section('proj.section.retirement',
      grid(
        numField('proj.field.current_age',      null, 'current_age',         { step: '1', min: '18', max: '90' }),
        numField('proj.field.retire_age',       'proj.field.retire_age.help', 'retire_age',  { step: '1', min: '40', max: '80' }),
        numField('proj.field.ss_start_age',     'proj.field.ss_start_age.help', 'ss_start_age', { step: '1', min: '62', max: '70' }),
        numField('proj.field.ss_monthly',       'proj.field.ss_monthly.help',  'ss_monthly_at_70_usd', { step: '50' }),
        numField('proj.field.project_to_age',   null, 'project_to_age',      { step: '1', min: '70', max: '110' }),
      ),
    ));

    // Draw
    out.appendChild(section('proj.section.draw',
      grid(
        numField('proj.field.withdrawal_rate',  'proj.field.withdrawal_rate.help', 'withdrawal_rate_pct', { step: '0.1', min: '0', max: '20' }),
        numField('proj.field.monthly_target',   'proj.field.monthly_target.help',  'monthly_target_usd',  { step: '100' }),
      ),
    ));

    // Tax detail (Phase 4)
    function selectField(labelKey, helpKey, field, options) {
      const sel = el('select', {
        class: 'tb-select',
        onchange: (e) => { setInputField(field, e.target.value); renderActiveTab(); },
      },
        ...options.map((o) => el('option', {
          value: o.value, ...(inputs[field] === o.value ? { selected: true } : {}),
        }, o.label)),
      );
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, t(labelKey)),
        sel,
        helpKey ? el('div', { class: 'tb-field-help' }, t(helpKey)) : null,
      );
    }
    out.appendChild(section('proj.section.taxdetail',
      grid(
        selectField('proj.field.filing_status', 'proj.field.filing_status.help', 'filing_status', [
          { value: 'single', label: 'Single' },
          { value: 'mfj',    label: 'Married filing jointly' },
          { value: 'mfs',    label: 'Married filing separately' },
          { value: 'hoh',    label: 'Head of household' },
        ]),
        numField('proj.field.state_tax', 'proj.field.state_tax.help', 'state_tax_pct', { step: '0.1', min: '0', max: '15' }),
        numField('proj.field.ss_cola',   'proj.field.ss_cola.help',   'ss_cola_pct',   { step: '0.1', min: '0', max: '8' }),
      ),
      grid(
        checkField('proj.field.niit',  'proj.field.niit.help',  'niit_enabled'),
        checkField('proj.field.irmaa', 'proj.field.irmaa.help', 'irmaa_enabled'),
      ),
    ));

    // Monthly events (Phase 4)
    out.appendChild(section('proj.section.monthly_events',
      grid(
        numField('proj.field.bonus_month', 'proj.field.bonus_month.help', 'bonus_month', { step: '1', min: '1', max: '12' }),
        numField('proj.field.bonus_pct',   'proj.field.bonus_pct.help',   'bonus_pct_of_salary', { step: '1', min: '0', max: '100' }),
      ),
    ));

    // Growth (per asset class)
    out.appendChild(section('proj.section.growth',
      grid(
        numField('proj.field.growth_equity_us',   null, 'growth_equity_us_pct',   { step: '0.1' }),
        numField('proj.field.growth_equity_intl', null, 'growth_equity_intl_pct', { step: '0.1' }),
        numField('proj.field.growth_bond',        null, 'growth_bond_pct',        { step: '0.1' }),
        numField('proj.field.growth_cash',        null, 'growth_cash_pct',        { step: '0.1' }),
        numField('proj.field.growth_real_estate', null, 'growth_real_estate_pct', { step: '0.1' }),
        numField('proj.field.growth_alternative', null, 'growth_alternative_pct', { step: '0.1' }),
      ),
      grid(
        numField('proj.field.dampener', 'proj.field.dampener.help', 'retirement_growth_dampener_pct', { step: '5', min: '0', max: '100' }),
        numField('proj.field.floor',    'proj.field.floor.help',    'retirement_growth_floor_pct',    { step: '0.1', min: '0' }),
      ),
    ));

    // Drawdown order
    out.appendChild(section('proj.section.drawdown',
      el('p', { class: 'tb-field-help' }, t('proj.section.drawdown.help')),
      buildDrawdownOrderList(),
    ));

    host.appendChild(out);
  }

  function buildDrawdownOrderList() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const inputs = getInputs();
    const order = inputs.drawdown_order.slice();
    const wrappers = (TB.assets && TB.assets.WRAPPERS) || [];
    const list = el('ol', { style: { paddingLeft: '24px', margin: '0' } });
    for (let i = 0; i < order.length; i++) {
      const wid = order[i];
      const w = wrappers.find((w) => w.id === wid);
      const label = t('assets.wrapper.' + wid) || wid;
      list.appendChild(el('li', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 0', borderBottom: '1px dashed var(--tb-border)',
        },
      },
        el('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('span', {
            style: {
              width: '8px', height: '20px',
              background: (w && w.color) || 'var(--tb-text-soft)',
              borderRadius: '2px', flexShrink: '0',
            },
          }),
          el('span', null, label),
        ),
        el('span', { style: { display: 'flex', gap: '4px' } },
          el('button', {
            class: 'tb-btn tb-btn--ghost', type: 'button',
            disabled: i === 0,
            style: { padding: '0 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => { swap(order, i, i - 1); persistOrder(order); },
          }, '↑'),
          el('button', {
            class: 'tb-btn tb-btn--ghost', type: 'button',
            disabled: i === order.length - 1,
            style: { padding: '0 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => { swap(order, i, i + 1); persistOrder(order); },
          }, '↓'),
        ),
      ));
    }
    return list;

    function swap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }
    function persistOrder(arr) {
      setInputField('drawdown_order', arr);
      renderActiveTab();
    }
  }

  // ====================================================================
  // Projection tab — tiles + chart + breakdown table
  // ====================================================================

  // Live-refresh containers — stable DOM nodes that get re-populated
  // by liveRefresh() without tearing down the controls. This is what
  // makes slider drags feel native: only tiles/chart/table update.
  let tilesContainer = null;
  let chartContainer = null;
  let tableContainer = null;
  let scenarioBarContainer = null;

  function renderProjectionTab(host) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const result = cachedResult;
    if (!result || !result.rows.length) {
      host.appendChild(el('p', { class: 'tb-field-help' }, t('proj.empty')));
      return;
    }
    // Projection Controls card (sliders + inflation toggle)
    host.appendChild(buildControlsCard());
    // Stable containers for live-refresh
    tilesContainer = el('div', { id: 'tb-proj-tiles' });
    chartContainer = el('div', { id: 'tb-proj-chart' });
    tableContainer = el('div', { id: 'tb-proj-table' });
    host.appendChild(tilesContainer);
    host.appendChild(chartContainer);
    host.appendChild(tableContainer);
    // Initial fill
    fillLiveContainers();
  }

  // Recompute + re-render only the live containers (tiles/chart/table).
  // Called on slider drag, scenario load, inflation toggle, etc. —
  // anything that changes inputs without requiring a full tab rebuild.
  function liveRefresh() {
    cachedResult = computeForCurrentState();
    fillLiveContainers();
  }

  function fillLiveContainers() {
    if (!cachedResult || !tilesContainer) return;
    tilesContainer.innerHTML = '';
    chartContainer.innerHTML = '';
    tableContainer.innerHTML = '';
    tilesContainer.appendChild(buildHeadlineTiles(cachedResult));
    chartContainer.appendChild(buildChartCard(cachedResult));
    tableContainer.appendChild(buildBreakdownTable(cachedResult));
  }

  // ─── Projection Controls card (sliders) ───────────────────────────
  //
  // Five primary sliders that drive the most-tweaked inputs. Each
  // slider lives-updates inputs + triggers liveRefresh() on every
  // drag step. The Inputs tab still has the granular fields for
  // less-frequently-changed values (per-class growth, drawdown order).

  function buildControlsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const inputs = getInputs();
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h3', { style: { marginTop: 0 } },
      el('span', null, '🎚 ' + t('proj.controls.title'))));

    const startYear = new Date().getFullYear();
    const retireYear = startYear + (inputs.retire_age - inputs.current_age);
    const ssYear = startYear + (inputs.ss_start_age - inputs.current_age);
    // Annual contribution preview (for the slider's side text).
    const annualContrib = Math.round(inputs.base_salary_usd * (inputs.contrib_401k_pct / 100));
    const monthlyDrawPreview = (() => {
      const last = cachedResult && cachedResult.summary;
      return last && last.monthly_draw_at_retire
        ? '$' + Math.round(last.monthly_draw_at_retire).toLocaleString() + '/mo' : '';
    })();

    const grid = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 'var(--tb-sp-4) var(--tb-sp-5)',
      },
    });

    // Retire age
    const retireSide = el('span');
    retireSide.textContent = 'Year ' + retireYear;
    const retireSlider = TB.utils.buildSlider({
      label: t('proj.field.retire_age'),
      value: inputs.retire_age,
      min: 50, max: 75, step: 1,
      variant: 'accent',
      ticks: ['50', '55', '60', '65', '70', '75'],
      side: 'Year ' + retireYear,
      onInput: (v) => {
        setInputField('retire_age', v);
        retireSlider.setSide('Year ' + (startYear + (v - inputs.current_age)));
        liveRefresh();
      },
    });
    grid.appendChild(retireSlider.node);

    // SS start age
    const ssMult = ssBenefitMultiplier(inputs.ss_start_age);
    const ssMonthly = inputs.ss_monthly_at_70_usd * ssMult;
    const ssSlider = TB.utils.buildSlider({
      label: t('proj.field.ss_start_age'),
      value: inputs.ss_start_age,
      min: 62, max: 70, step: 1,
      variant: 'success',
      ticks: ['62 (-30%)', '67 (FRA)', '70 (+24%)'],
      side: '$' + Math.round(ssMonthly).toLocaleString() + '/mo',
      onInput: (v) => {
        setInputField('ss_start_age', v);
        const mo = inputs.ss_monthly_at_70_usd * ssBenefitMultiplier(v);
        ssSlider.setSide('$' + Math.round(mo).toLocaleString() + '/mo');
        liveRefresh();
      },
    });
    grid.appendChild(ssSlider.node);

    // 401k contribution %
    const contribSlider = TB.utils.buildSlider({
      label: t('proj.field.contrib_401k'),
      value: inputs.contrib_401k_pct,
      min: 0, max: 30, step: 0.5,
      variant: 'accent',
      ticks: ['0%', '6% match', '15%', '30%'],
      format: (v) => v + '%',
      side: '$' + annualContrib.toLocaleString() + '/yr',
      onInput: (v) => {
        setInputField('contrib_401k_pct', v);
        const c = Math.round(inputs.base_salary_usd * (v / 100));
        contribSlider.setSide('$' + c.toLocaleString() + '/yr');
        liveRefresh();
      },
    });
    grid.appendChild(contribSlider.node);

    // Withdrawal rate
    const drawSlider = TB.utils.buildSlider({
      label: t('proj.field.withdrawal_rate'),
      value: inputs.withdrawal_rate_pct,
      min: 2, max: 6, step: 0.1,
      variant: 'accent',
      ticks: ['2%', '3%', '4%', '5%', '6%'],
      format: (v) => v.toFixed(1) + '%',
      side: monthlyDrawPreview,
      help: t('proj.controls.draw.help'),
      onInput: (v) => {
        setInputField('withdrawal_rate_pct', v);
        liveRefresh();
        // Update side text from the new computed result.
        const r = cachedResult && cachedResult.summary;
        if (r && r.monthly_draw_at_retire) {
          drawSlider.setSide('$' + Math.round(r.monthly_draw_at_retire).toLocaleString() + '/mo');
        }
      },
    });
    grid.appendChild(drawSlider.node);

    card.appendChild(grid);

    // Monthly target slider — full-width below the grid because the
    // help text explaining "no cap" is too long for a grid cell.
    const mtVal = inputs.monthly_target_usd || 0;
    const mtSide = mtVal > 0 ? '' : t('proj.controls.no_cap');
    const mtSlider = TB.utils.buildSlider({
      label: t('proj.field.monthly_target'),
      value: mtVal,
      min: 0, max: 20000, step: 250,
      variant: 'navy',
      ticks: ['Off', '$5K', '$10K', '$15K', '$20K'],
      format: (v) => v > 0 ? '$' + Number(v).toLocaleString() : t('proj.controls.no_cap'),
      side: mtSide,
      help: t('proj.controls.monthly_target.help'),
      onInput: (v) => {
        setInputField('monthly_target_usd', v > 0 ? v : null);
        liveRefresh();
      },
    });
    const mtWrap = el('div', { style: { marginTop: 'var(--tb-sp-4)' } }, mtSlider.node);
    card.appendChild(mtWrap);

    // Inflation toggle — button row + slider for the inflation rate.
    const ui = getUiState();
    const inflBtn = (mode, label) => el('button', {
      class: 'tb-btn ' + (ui.inflation_view === mode ? '' : 'tb-btn--secondary'),
      type: 'button',
      style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
      onclick: () => {
        setUiField('inflation_view', mode);
        liveRefresh();
        renderActiveTab();
      },
    }, label);
    const viewRow = el('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)',
        marginTop: 'var(--tb-sp-4)', fontSize: 'var(--tb-fs-12)', flexWrap: 'wrap',
      },
    },
      el('span', { style: { color: 'var(--tb-text-soft)' } }, t('proj.controls.view') + ':'),
      inflBtn('nominal', t('proj.controls.nominal')),
      inflBtn('real',    t('proj.controls.real') + ' (' + ui.inflation_pct + '%)'),
    );
    card.appendChild(viewRow);
    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-1)', marginBottom: 0 } }, t('proj.controls.view.help')));

    // Inflation rate slider — only visible when Real view is active
    // (changing it in Nominal view has no visible effect, would confuse).
    if (ui.inflation_view === 'real') {
      const inflSlider = TB.utils.buildSlider({
        label: t('proj.controls.inflation'),
        value: ui.inflation_pct,
        min: 0, max: 6, step: 0.1,
        variant: 'navy',
        ticks: ['0%', '2%', '4%', '6%'],
        format: (v) => v.toFixed(1) + '%',
        side: t('proj.controls.inflation.side'),
        help: t('proj.controls.inflation.help'),
        onInput: (v) => {
          setUiField('inflation_pct', v);
          liveRefresh();
        },
      });
      card.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-3)' } }, inflSlider.node));
    }

    return card;
  }

  // ─── Currency-pair display (Phase 4) ──────────────────────────────
  //
  // Every USD amount in the Projections UI is rendered with its JPY
  // equivalent in smaller parens — clickable to toggle which currency
  // is primary. Single global preference (projections.ui_state.
  // primary_currency) controls the active mode for the whole module.

  // USD → JPY rate: prefer live Treasury rate from settings.fx, fall
  // back to FX_FALLBACK.perUsd.JPY, fall back to 152.
  function jpyPerUsd() {
    try {
      const live = TB.state.get('settings.fx.current_rates') || {};
      if (live.JPY && live.JPY > 0) return live.JPY;
    } catch (e) { /* ignore */ }
    const fb = (TB.utils && TB.utils.FX_FALLBACK && TB.utils.FX_FALLBACK.perUsd) || {};
    return fb.JPY || 152;
  }

  // Format a USD amount and its JPY equivalent. Returns a DOM span
  // with two children: a primary value + a clickable secondary value.
  //
  // Two layout variants (CSS-driven):
  //   • 'stacked' (default) — primary on top at full size; secondary
  //     below, much smaller (~0.6em), dim, slightly indented to the
  //     right. Solves truncation issues in tiles and table cells
  //     and gives the primary number visual prominence.
  //   • 'inline' — primary then "(secondary)" on the same line. Used
  //     in flowing paragraphs (lifetime tax callouts) where stacking
  //     would break sentence flow.
  //
  // opts:
  //   suffix: '/mo' to append a "/mo" or "/月" suffix
  //   layout: 'stacked' | 'inline' (default 'stacked')
  function fmtCurrencyPair(usd, opts) {
    opts = opts || {};
    if (usd == null || !isFinite(usd)) {
      const t = document.createElement('span');
      t.textContent = '—';
      return t;
    }
    const ui = getUiState();
    const primary = ui.primary_currency || 'usd';
    const jpy = usd * jpyPerUsd();
    const suffix = opts.suffix || '';
    const layout = opts.layout || 'stacked';

    function fmtUsd(v) {
      const s = TB.utils.formatUSD(v, { maximumFractionDigits: 0 });
      return suffix === '/mo' ? s + '/mo' : s;
    }
    function fmtJpy(v) {
      const s = '¥' + Math.round(v).toLocaleString();
      return suffix === '/mo' ? s + '/月' : s;
    }

    const wrap = document.createElement('span');
    wrap.className = 'tb-currency-pair tb-currency-pair--' + layout;

    const primaryStr   = primary === 'jpy' ? fmtJpy(jpy) : fmtUsd(usd);
    const secondaryStr = primary === 'jpy' ? fmtUsd(usd) : fmtJpy(jpy);

    const primarySpan = document.createElement('span');
    primarySpan.className = 'tb-currency-primary';
    primarySpan.textContent = primaryStr;
    wrap.appendChild(primarySpan);

    const secondarySpan = document.createElement('span');
    secondarySpan.className = 'tb-currency-secondary';
    secondarySpan.setAttribute('data-toggle-currency', '1');
    secondarySpan.title = 'Click to make this currency primary';
    // Inline layout adds parens to look natural in sentence flow;
    // stacked layout omits them since the visual offset already
    // signals "this is the alternate currency".
    secondarySpan.textContent = layout === 'inline'
      ? '(' + secondaryStr + ')'
      : secondaryStr;
    wrap.appendChild(secondarySpan);

    return wrap;
  }

  // Toggle primary currency between USD and JPY. Re-renders the
  // active tab so all display sites pick up the new preference.
  function toggleCurrency() {
    const cur = (getUiState().primary_currency) || 'usd';
    setUiField('primary_currency', cur === 'usd' ? 'jpy' : 'usd');
    if (host) renderActiveTab();
  }

  // Format a single USD axis-label value with primary-currency
  // awareness. Used in chart Y-axis labels.
  function fmtAxisPrimary(usd) {
    const ui = getUiState();
    const primary = ui.primary_currency || 'usd';
    if (primary === 'jpy') {
      const v = usd * jpyPerUsd();
      if (v >= 1e8) return '¥' + (v / 1e8).toFixed(v >= 1e9 ? 0 : 1) + '億';
      if (v >= 1e4) return '¥' + (v / 1e4).toFixed(0) + '万';
      return '¥' + Math.round(v).toLocaleString();
    }
    return fmtAxisM(usd);
  }

  // Deflate a future-year nominal value into today's dollars when
  // the user has toggled "Real" view. infl is decimal (e.g., 0.025).
  // Returns the value unchanged in 'nominal' mode.
  function deflated(nominal, year, ui) {
    if (!ui || ui.inflation_view !== 'real' || nominal == null) return nominal;
    const startYear = new Date().getFullYear();
    const yearsOut = Math.max(0, year - startYear);
    const infl = (ui.inflation_pct || 0) / 100;
    return nominal / Math.pow(1 + infl, yearsOut);
  }

  // Find the row at a target age — used by tiles to look up the
  // year that corresponds to "Portfolio at 80" etc.
  function rowAtAge(rows, targetAge) {
    return rows.find((r) => r.age === targetAge) || null;
  }

  function buildHeadlineTiles(result) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const inputs = getInputs();
    const ui = getUiState();
    const s = result.summary;
    // Re-derive tiles in current view mode (real vs nominal).
    const retireRow = rowAtAge(result.rows, inputs.retire_age);
    const ssRow     = rowAtAge(result.rows, inputs.ss_start_age);
    const r80       = rowAtAge(result.rows, 80);
    const r90       = rowAtAge(result.rows, 90);
    const portRetire = retireRow ? deflated(retireRow.total_usd, retireRow.year, ui) : null;
    const drawRetire = retireRow ? deflated(retireRow.withdraw_actual / 12, retireRow.year, ui) : null;
    const ssMonthly  = ssRow     ? deflated(ssRow.ss_annual / 12,           ssRow.year,     ui) : (s.ss_monthly_at_start);
    const totalMo    = retireRow ? deflated(retireRow.net_monthly_usd,      retireRow.year, ui) : null;
    const port80     = r80       ? deflated(r80.total_usd, r80.year, ui) : null;
    const port90     = r90       ? deflated(r90.total_usd, r90.year, ui) : null;
    const fxRate = (TB.assets && TB.assets.toUsd) ? (1 / TB.assets.toUsd(1, 'JPY') || 152) : 152;

    // Tile body now accepts a DOM node (the currency-pair display)
    // rather than a string, so the JPY parenthetical can be clickable.
    function tile(labelKey, valueNode, sub) {
      return el('div', {
        style: {
          background: 'var(--tb-bg-elev)',
          border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
          padding: 'var(--tb-sp-3)',
        },
      },
        el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } }, t(labelKey)),
        el('div', { style: { fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' }, class: 'tb-tile-value' },
          valueNode != null ? valueNode : document.createTextNode('—')),
        sub ? el('div', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } }, sub) : null,
      );
    }
    const pair    = (v) => fmtCurrencyPair(v);
    const pairMo  = (v) => fmtCurrencyPair(v, { suffix: '/mo' });

    const viewBadge = ui.inflation_view === 'real'
      ? el('span', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginLeft: 'var(--tb-sp-2)', fontWeight: 'normal' } },
          t('proj.controls.real') + ' (today\'s $)')
      : el('span', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginLeft: 'var(--tb-sp-2)', fontWeight: 'normal' } },
          t('proj.controls.nominal') + ' (future $)');

    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h3', { style: { marginTop: 0 } }, t('proj.tiles.title'), viewBadge),
      el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)' },
      },
        tile('proj.tile.portfolio_at_retire', pair(portRetire),    t('proj.tile.at_age', { age: inputs.retire_age })),
        tile('proj.tile.monthly_draw',        pairMo(drawRetire)),
        tile('proj.tile.ss_monthly',          pairMo(ssMonthly),   t('proj.tile.at_age', { age: inputs.ss_start_age })),
        tile('proj.tile.total_monthly',       pairMo(totalMo)),
        tile('proj.tile.portfolio_at_80',     pair(port80)),
        tile('proj.tile.portfolio_at_90',     pair(port90)),
        tile('proj.tile.depletion',
          document.createTextNode(s.depletion_age != null ? t('proj.tile.depleted_at', { age: s.depletion_age }) : t('proj.tile.no_depletion'))),
      ),
    );
  }

  function buildChartCard(result) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ui = getUiState();
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h3', { style: { marginTop: 0 } }, t('proj.chart.title')));

    // Year-zoom chip strip.
    card.appendChild(buildYearChips(result, ui));

    // Two-column layout: chart on left, hover details on right.
    // On narrow screens, panel stacks below the chart (auto-fit).
    const visibleRows = filterRowsByYear(result.rows, ui.year_filter);
    const layout = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 220px',
        gap: 'var(--tb-sp-3)',
        alignItems: 'start',
        marginTop: 'var(--tb-sp-2)',
      },
    });

    const chartCol = el('div', { style: { minWidth: '0' } });
    const hoverPanel = el('div', {
      style: {
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-3)',
        fontSize: 'var(--tb-fs-12)',
        minHeight: '200px',
      },
    });
    // Initial hover panel content: remembered year if set, else
    // last visible year (most relevant to long-horizon planning).
    const initialYear = ui.chart_hover_year && visibleRows.find((r) => r.year === ui.chart_hover_year)
      ? ui.chart_hover_year
      : (visibleRows.length ? visibleRows[visibleRows.length - 1].year : null);
    fillHoverPanel(hoverPanel, result, initialYear);

    chartCol.appendChild(renderProjectionSvg(result, hoverPanel));
    layout.appendChild(chartCol);
    layout.appendChild(hoverPanel);
    card.appendChild(layout);

    // Concise legend below — only wrappers with non-zero balance in
    // the visible range, plus the always-shown total / income markers.
    card.appendChild(buildChartLegend(result));

    // One-line help.
    card.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } }, t('proj.chart.help')));

    return card;
  }

  // Slice rows by year_filter. null filter = all rows.
  function filterRowsByYear(rows, filter) {
    if (!filter) return rows;
    return rows.filter((r) => r.year >= filter.from && r.year <= filter.to);
  }

  // Year zoom chips. Click year = zoom to that year. Shift+click = range
  // from previous-clicked to this. Click an already-selected single year
  // = clear (full range restored).
  function buildYearChips(result, ui) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filter = ui.year_filter;
    const wrap = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '2px',
        padding: 'var(--tb-sp-2) 0', alignItems: 'center',
      },
    });
    wrap.appendChild(el('span', {
      style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', marginRight: 'var(--tb-sp-2)' },
    }, t('proj.chart.zoomHint')));

    for (const r of result.rows) {
      const inRange = filter ? (r.year >= filter.from && r.year <= filter.to) : true;
      const isSingle = filter && filter.from === r.year && filter.to === r.year;
      const chip = el('button', {
        type: 'button',
        style: {
          padding: '2px 6px',
          fontSize: 'var(--tb-fs-12)',
          fontFamily: 'var(--tb-font-mono)',
          background: inRange ? 'var(--tb-navy)' : 'transparent',
          color: inRange ? '#fff' : 'var(--tb-text-soft)',
          border: '1px solid ' + (inRange ? 'var(--tb-navy)' : 'var(--tb-border)'),
          borderRadius: '3px', cursor: 'pointer',
        },
        onclick: (e) => {
          if (e.shiftKey && filter) {
            // Range: extend filter to include r.year.
            const lo = Math.min(filter.from, r.year);
            const hi = Math.max(filter.to,   r.year);
            setUiField('year_filter', { from: lo, to: hi });
          } else if (isSingle) {
            // Click again on the only selected year = clear.
            setUiField('year_filter', null);
          } else {
            // Single-year zoom.
            setUiField('year_filter', { from: r.year, to: r.year });
          }
          renderActiveTab();
        },
      }, String(r.year));
      wrap.appendChild(chip);
    }
    if (filter) {
      wrap.appendChild(el('button', {
        type: 'button',
        style: {
          marginLeft: 'var(--tb-sp-2)', padding: '2px 8px',
          fontSize: 'var(--tb-fs-12)', background: 'transparent',
          color: 'var(--tb-text-soft)', border: '1px solid var(--tb-border)',
          borderRadius: '3px', cursor: 'pointer',
        },
        onclick: () => { setUiField('year_filter', null); renderActiveTab(); },
      }, '✕ ' + t('proj.chart.clearZoom')));
    }
    return wrap;
  }

  // Fill the hover panel with year-specific details. Mirrors the
  // retirement tool's right-side detail panel — shows account
  // breakdown for the hovered year + total, with allocation context.
  function fillHoverPanel(panel, result, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ui = getUiState();
    const dfl = (v, yr) => deflated(v, yr, ui);

    panel.innerHTML = '';
    const row = result.rows.find((r) => r.year === year);
    if (!row) {
      panel.appendChild(el('div', { style: { color: 'var(--tb-text-soft)' } }, t('proj.chart.hover.empty')));
      return;
    }
    setUiField('chart_hover_year', year); // remember last hover

    // Header
    panel.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--tb-sp-2)' },
    },
      el('span', { style: { fontSize: 'var(--tb-fs-22)', fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, String(row.year)),
      el('span', { style: { color: 'var(--tb-text-soft)' } }, t('proj.tile.at_age', { age: row.age })),
    ));

    // Phase pill
    panel.appendChild(el('div', {
      style: { marginBottom: 'var(--tb-sp-2)' },
    },
      el('span', {
        style: {
          padding: '1px 8px', borderRadius: '3px', fontSize: '10px',
          background: row.phase === 'accum' ? 'var(--tb-success)' : 'var(--tb-warn)',
          color: '#fff',
        },
      }, t('proj.phase.' + row.phase)),
      row.is_post_juminhyou ? el('span', {
        style: { marginLeft: '6px', color: 'var(--tb-error)', fontSize: '10px', fontWeight: '600' },
      }, '住民票↑') : null,
    ));

    // Per-account list — group by tax_wrapper, sorted by balance desc.
    const wrappers = (TB.assets && TB.assets.WRAPPERS) || [];
    const wrapperColors = {};
    for (const w of wrappers) wrapperColors[w.id] = w.color;

    const accts = row.by_account
      .filter((a) => a.balance_usd > 0)
      .sort((a, b) => b.balance_usd - a.balance_usd);
    for (const a of accts) {
      panel.appendChild(el('div', {
        style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' },
      },
        el('span', {
          style: {
            width: '8px', height: '8px', borderRadius: '50%',
            background: wrapperColors[a.tax_wrapper] || 'var(--tb-text-soft)',
            flexShrink: '0',
          },
        }),
        el('span', {
          style: { flex: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 'var(--tb-fs-12)' },
          title: a.name + ' (' + (t('assets.wrapper.' + a.tax_wrapper) || a.tax_wrapper) + ')',
        }, a.name || (t('assets.wrapper.' + a.tax_wrapper) || a.tax_wrapper)),
        el('span', {
          style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600', fontSize: 'var(--tb-fs-12)' },
        }, fmtCurrencyPair(dfl(a.balance_usd, row.year))),
      ));
    }

    // Divider + total
    panel.appendChild(el('div', { style: { borderTop: '1px solid var(--tb-border)', margin: '8px 0 6px' } }));
    panel.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', fontWeight: '700' },
    },
      el('span', null, t('proj.chart.hover.total')),
      el('span', { style: { fontFamily: 'var(--tb-font-mono)' } },
        fmtCurrencyPair(dfl(row.total_usd, row.year))),
    ));

    // Income detail in distribution years
    if (row.phase === 'dist') {
      panel.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-2)', padding: 'var(--tb-sp-2)', background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)' },
      },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          el('span', { style: { color: 'var(--tb-text-soft)' } }, t('proj.table.col.draw') + '/mo'),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, fmtCurrencyPair(dfl(row.withdraw_actual / 12, row.year), { suffix: '/mo' })),
        ),
        row.ss_annual > 0 ? el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
          el('span', { style: { color: 'var(--tb-text-soft)' } }, t('proj.table.col.ss') + '/mo'),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, fmtCurrencyPair(dfl(row.ss_annual / 12, row.year), { suffix: '/mo' })),
        ) : null,
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: '600', marginTop: '4px' } },
          el('span', null, t('proj.table.col.net_mo')),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, fmtCurrencyPair(dfl(row.net_monthly_usd, row.year), { suffix: '/mo' })),
        ),
      ));
    }

    // Conversion / event annotations
    if (row.roth_conversion > 0) {
      panel.appendChild(el('div', {
        style: { marginTop: '6px', padding: '4px 8px', background: 'rgba(47, 111, 78, 0.08)', borderLeft: '2px solid var(--tb-success)', fontSize: 'var(--tb-fs-12)' },
      }, '🟢 Roth conv: ' + TB.utils.formatUSD(row.roth_conversion, { maximumFractionDigits: 0 })));
    }
    if (row.events && row.events.length) {
      for (const ev of row.events) {
        const text = ev.type === 'transfer'
          ? '🔁 ' + ev.from_name + ' → ' + ev.to_name
          : '🔒 ' + ev.from_name;
        panel.appendChild(el('div', {
          style: { marginTop: '4px', padding: '4px 8px', background: 'rgba(183, 71, 42, 0.08)', borderLeft: '2px solid var(--tb-accent)', fontSize: 'var(--tb-fs-12)' },
        }, text));
      }
    }
  }

  // Vanilla SVG chart. Stacked bars by tax_wrapper for accumulation
  // years (each wrapper colored using assets.WRAPPER colors); a gold
  // line traces total portfolio across both phases; a translucent
  // green line traces annual draw + SS in distribution. Dual y-axes:
  // portfolio (left, $M), monthly income (right, $K).
  function renderProjectionSvg(result, hoverPanel) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ui = getUiState();
    const allRows = result.rows;
    const rows = filterRowsByYear(allRows, ui.year_filter);
    if (!rows.length) return el('div', null, t('proj.empty'));

    const dfl = (v, yr) => deflated(v, yr, ui);

    const W = 880, H = 360;
    const padL = 64, padR = 64, padT = 24, padB = 56;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const yearMin = rows[0].year, yearMax = rows[rows.length - 1].year;
    const yearSpan = Math.max(yearMax - yearMin, 1);

    // Wrapper color map from assets.WRAPPERS
    const wrappers = (TB.assets && TB.assets.WRAPPERS) || [];
    const wrapperColors = {};
    for (const w of wrappers) wrapperColors[w.id] = w.color;

    // Accumulate balances per wrapper per year for stacking.
    // Apply inflation deflation when in 'real' view.
    const wrapperOrder = (TB.assets && TB.assets.WRAPPERS)
      ? TB.assets.WRAPPERS.map((w) => w.id) : [];
    const stackedByYear = rows.map((r) => {
      const byW = {};
      for (const a of r.by_account) byW[a.tax_wrapper] = (byW[a.tax_wrapper] || 0) + dfl(a.balance_usd, r.year);
      return byW;
    });

    // Y-axis max — round up to a clean number above the largest total.
    const maxTotal = rows.reduce((m, r) => Math.max(m, dfl(r.total_usd, r.year)), 0);
    const yMax = niceCeil(maxTotal * 1.1);

    // Right axis (income): max of monthly draw + ss
    const maxIncomeMo = rows.reduce((m, r) => Math.max(m, dfl((r.withdraw_actual + r.ss_annual) / 12, r.year)), 0);
    const yMaxRight = niceCeil(maxIncomeMo * 1.2);

    const xFor = (year) => padL + ((year - yearMin) / yearSpan) * innerW;
    const yFor = (val) => padT + innerH - (val / yMax) * innerH;
    const yForRight = (val) => padT + innerH - (val / Math.max(yMaxRight, 1)) * innerH;
    const barWidth = Math.max(2, (innerW / Math.max(rows.length, 1)) * 0.75);

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%',
      style: 'background: var(--tb-bg); border: 1px solid var(--tb-border); border-radius: var(--tb-radius-2);',
    });

    // Y gridlines + labels. Left axis uses primary-currency labels
    // (USD or JPY based on ui.primary_currency); right axis (income
    // /mo) follows the same convention.
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const v = yMax * (i / ySteps);
      const y = yFor(v);
      svg.appendChild(svgEl('line', {
        x1: padL, y1: y, x2: W - padR, y2: y,
        stroke: 'var(--tb-border)', 'stroke-dasharray': '2,3',
      }));
      svg.appendChild(svgEl('text', {
        x: padL - 6, y: y + 4, 'text-anchor': 'end',
        'font-size': '10', fill: 'var(--tb-text-soft)',
      }, fmtAxisPrimary(v)));
      // right axis (monthly income)
      const vRight = yMaxRight * (i / ySteps);
      const moSuffix = (ui.primary_currency === 'jpy') ? '/月' : '/mo';
      svg.appendChild(svgEl('text', {
        x: W - padR + 6, y: y + 4, 'text-anchor': 'start',
        'font-size': '10', fill: 'var(--tb-text-soft)',
      }, fmtAxisPrimary(vRight) + moSuffix));
    }

    // Draw stacked bars (accumulation) and unstacked bars (dist) per row.
    rows.forEach((row, idx) => {
      const x = xFor(row.year) - barWidth / 2;
      let cursor = 0;
      for (const wid of wrapperOrder) {
        const v = stackedByYear[idx][wid] || 0;
        if (v <= 0) continue;
        const yTop = yFor(cursor + v);
        const yBot = yFor(cursor);
        svg.appendChild(svgEl('rect', {
          x, y: yTop, width: barWidth, height: Math.max(yBot - yTop, 0.5),
          fill: wrapperColors[wid] || 'var(--tb-text-soft)',
          opacity: row.phase === 'dist' ? '0.45' : '0.85',
        }, [
          svgEl('title', null, row.year + ' age ' + row.age + ' — ' +
            (TB.i18n.t('assets.wrapper.' + wid) || wid) + ': ' +
            TB.utils.formatUSD(v, { maximumFractionDigits: 0 })),
        ]));
        cursor += v;
      }
    });

    // Total portfolio line
    const totalPath = rows.map((r, i) =>
      (i === 0 ? 'M' : 'L') + xFor(r.year).toFixed(1) + ',' + yFor(dfl(r.total_usd, r.year)).toFixed(1)
    ).join(' ');
    svg.appendChild(svgEl('path', {
      d: totalPath, fill: 'none', stroke: '#D4A017', 'stroke-width': '2.2',
    }));

    // Income line (right axis): only in distribution years
    const distRows = rows.filter((r) => r.phase === 'dist');
    if (distRows.length > 1) {
      const incPath = distRows.map((r, i) =>
        (i === 0 ? 'M' : 'L') + xFor(r.year).toFixed(1) + ',' + yForRight(dfl((r.withdraw_actual + r.ss_annual) / 12, r.year)).toFixed(1)
      ).join(' ');
      svg.appendChild(svgEl('path', {
        d: incPath, fill: 'none', stroke: 'var(--tb-success)', 'stroke-width': '2',
        'stroke-dasharray': '4,3',
      }));
    }

    // Roth conversion markers — green upward triangle ▲ at the
    // year of each conversion, on the total line. Bigger triangle =
    // bigger conversion. Tooltip shows amount + tax incurred.
    const maxConv = rows.reduce((m, r) => Math.max(m, r.roth_conversion || 0), 0);
    rows.forEach((r) => {
      if (!r.roth_conversion || r.roth_conversion <= 0) return;
      const x = xFor(r.year);
      const y = yFor(dfl(r.total_usd, r.year));
      const sizeBoost = maxConv > 0 ? (r.roth_conversion / maxConv) : 1;
      const half = 4 + sizeBoost * 4; // 4 → 8 px
      svg.appendChild(svgEl('polygon', {
        points: x + ',' + (y - half - 4) + ' ' + (x + half) + ',' + (y - 4) + ' ' + (x - half) + ',' + (y - 4),
        fill: 'var(--tb-success)', stroke: '#fff', 'stroke-width': '1.5',
      }, [
        svgEl('title', null,
          r.year + ' — Roth conversion: $' + Math.round(r.roth_conversion).toLocaleString() +
          ' · US tax: $' + Math.round(r.roth_conversion_us_tax).toLocaleString() +
          (r.roth_conversion_jp_tax > 0 ? ' · JP tax: $' + Math.round(r.roth_conversion_jp_tax).toLocaleString() : '')),
      ]));
    });

    // Account event markers — diamond ◇ at the year of each
    // close_date / transfer event, on the total line.
    rows.forEach((r) => {
      if (!r.events || !r.events.length) return;
      const x = xFor(r.year);
      const y = yFor(dfl(r.total_usd, r.year));
      svg.appendChild(svgEl('polygon', {
        points: x + ',' + (y - 6) + ' ' + (x + 5) + ',' + y + ' ' + x + ',' + (y + 6) + ' ' + (x - 5) + ',' + y,
        fill: 'var(--tb-accent)', stroke: '#fff', 'stroke-width': '1.5',
      }, [
        svgEl('title', null, r.events.map((ev) => {
          if (ev.type === 'transfer') return r.year + ' — ' + ev.from_name + ' → ' + ev.to_name + ' ($' + Math.round(ev.amount_usd).toLocaleString() + ')';
          return r.year + ' — ' + ev.from_name + ' closed';
        }).join('\n')),
      ]));
    });

    // Vertical reference lines: retire, juminhyou
    const inputs = getInputs();
    const retireYear = rows.find((r) => r.age === inputs.retire_age);
    if (retireYear) {
      const x = xFor(retireYear.year);
      svg.appendChild(svgEl('line', {
        x1: x, y1: padT, x2: x, y2: padT + innerH,
        stroke: 'var(--tb-warn)', 'stroke-dasharray': '4,4', 'stroke-width': '1.5',
      }));
      svg.appendChild(svgEl('text', {
        x, y: padT - 4, 'text-anchor': 'middle',
        'font-size': '10', fill: 'var(--tb-warn)', 'font-weight': '600',
      }, t('proj.chart.retire')));
    }
    if (result.juminhyou_year) {
      const x = xFor(result.juminhyou_year);
      svg.appendChild(svgEl('line', {
        x1: x, y1: padT, x2: x, y2: padT + innerH,
        stroke: 'var(--tb-error)', 'stroke-dasharray': '4,4', 'stroke-width': '1.5',
      }));
      svg.appendChild(svgEl('text', {
        x, y: padT - 4, 'text-anchor': 'middle',
        'font-size': '10', fill: 'var(--tb-error)', 'font-weight': '600',
      }, '住民票'));
    }

    // X-axis: year ticks every ~5 years
    const tickEvery = Math.max(1, Math.round(yearSpan / 10));
    for (let yr = yearMin; yr <= yearMax; yr++) {
      if ((yr - yearMin) % tickEvery !== 0 && yr !== yearMax) continue;
      const x = xFor(yr);
      svg.appendChild(svgEl('text', {
        x, y: H - padB + 14, 'text-anchor': 'middle',
        'font-size': '10', fill: 'var(--tb-text-soft)',
      }, String(yr)));
    }

    // Axis titles
    svg.appendChild(svgEl('text', {
      x: padL, y: padT - 10, 'text-anchor': 'start',
      'font-size': '10', fill: 'var(--tb-text-soft)',
    }, t('proj.chart.axis_left')));
    svg.appendChild(svgEl('text', {
      x: W - padR, y: padT - 10, 'text-anchor': 'end',
      'font-size': '10', fill: 'var(--tb-text-soft)',
    }, t('proj.chart.axis_right')));

    // Vertical hover guide line (hidden until mouseover).
    const hoverLine = svgEl('line', {
      x1: padL, y1: padT, x2: padL, y2: padT + innerH,
      stroke: 'var(--tb-text)', 'stroke-width': '1', 'stroke-dasharray': '2,2',
      opacity: '0', 'pointer-events': 'none',
    });
    svg.appendChild(hoverLine);

    // Year label at the top of the hover line.
    const hoverLabel = svgEl('text', {
      x: padL, y: padT - 2, 'text-anchor': 'middle',
      'font-size': '10', fill: 'var(--tb-text)', 'font-weight': '600',
      opacity: '0', 'pointer-events': 'none',
    });
    svg.appendChild(hoverLabel);

    // Invisible mouse-capture rect over the plot area. SVG mousemove
    // listener finds the nearest year and updates both the in-chart
    // hover guide and the side panel.
    const captureRect = svgEl('rect', {
      x: padL, y: padT, width: innerW, height: innerH,
      fill: 'transparent', cursor: 'crosshair',
    });
    captureRect.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      // Map clientX to viewBox x using the SVG's rendered scale.
      const scaleX = W / rect.width;
      const xInSvg = (e.clientX - rect.left) * scaleX;
      const yearAtX = yearMin + ((xInSvg - padL) / innerW) * yearSpan;
      const nearest = rows.reduce((best, r) =>
        Math.abs(r.year - yearAtX) < Math.abs(best.year - yearAtX) ? r : best, rows[0]);
      const x = xFor(nearest.year);
      hoverLine.setAttribute('x1', x);
      hoverLine.setAttribute('x2', x);
      hoverLine.setAttribute('opacity', '0.6');
      hoverLabel.setAttribute('x', x);
      hoverLabel.textContent = String(nearest.year);
      hoverLabel.setAttribute('opacity', '1');
      if (hoverPanel) fillHoverPanel(hoverPanel, result, nearest.year);
    });
    captureRect.addEventListener('mouseleave', () => {
      // Keep last hovered state visible — don't clear panel.
      // Just dim the guide line a little.
      hoverLine.setAttribute('opacity', '0.2');
    });
    svg.appendChild(captureRect);

    return svg;
  }

  // Concise chart legend. Top row: always-shown reference markers
  // (total / income / retirement / 住民票). Bottom row: ONLY the
  // wrappers that actually have non-zero balance in the visible
  // year range — otherwise the legend bloats to 20 wrappers most
  // users don't have.
  function buildChartLegend(result) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ui = getUiState();
    const visibleRows = filterRowsByYear(result.rows, ui.year_filter);
    const presentWrappers = new Set();
    for (const r of visibleRows) {
      for (const a of r.by_account) {
        if (a.balance_usd > 0) presentWrappers.add(a.tax_wrapper);
      }
    }
    const wrappers = ((TB.assets && TB.assets.WRAPPERS) || [])
      .filter((w) => presentWrappers.has(w.id));

    function chip(color, label) {
      return el('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '8px',
        },
      },
        el('span', {
          style: { width: '10px', height: '10px', borderRadius: '50%', background: color, display: 'inline-block' },
        }),
        el('span', null, label),
      );
    }
    const refRow = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)',
      },
    });
    refRow.appendChild(chip('#D4A017', t('proj.legend.total')));
    refRow.appendChild(chip('var(--tb-success)', t('proj.legend.income')));
    refRow.appendChild(chip('var(--tb-success)', '▲ ' + t('proj.legend.roth_marker')));
    refRow.appendChild(chip('var(--tb-accent)', '◆ ' + t('proj.legend.event_marker')));
    refRow.appendChild(chip('var(--tb-warn)', t('proj.legend.retire')));
    refRow.appendChild(chip('var(--tb-error)', '住民票'));

    const wrapperRow = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '6px 12px',
        marginTop: '6px', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
      },
    });
    if (wrappers.length === 0) {
      wrapperRow.appendChild(el('span', null, t('proj.legend.no_wrappers')));
    } else {
      for (const w of wrappers) {
        wrapperRow.appendChild(el('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
        },
          el('span', { style: { width: '10px', height: '10px', borderRadius: '2px', background: w.color, display: 'inline-block' } }),
          el('span', null, t('assets.wrapper.' + w.id) || w.id),
        ));
      }
    }

    return el('div', null, refRow, wrapperRow);
  }

  // Toggle a hidden "monthly" tr that follows the year row in the
  // breakdown table. v1 model: all annual figures divided by 12;
  // future events (CD maturity, RSU vest, bonus) get inserted at
  // their actual month. For Phase 3 we just split annuals + flag
  // the close_date events at their actual month if present.
  function toggleMonthlyRow(parentTr, row) {
    const next = parentTr.nextElementSibling;
    const toggle = parentTr.querySelector('[data-mo-toggle]');
    if (next && next.dataset.monthlyFor === String(row.year)) {
      next.remove();
      if (toggle) toggle.textContent = '▸';
      return;
    }
    const monthlyTr = buildMonthlyRow(row);
    parentTr.parentNode.insertBefore(monthlyTr, parentTr.nextSibling);
    if (toggle) toggle.textContent = '▾';
  }

  function buildMonthlyRow(row) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ui = getUiState();
    const dfl = (v, yr) => deflated(v, yr, ui);

    const tr = document.createElement('tr');
    tr.dataset.monthlyFor = String(row.year);
    tr.style.background = row.is_post_juminhyou ? 'rgba(178, 58, 58, 0.04)' : 'var(--tb-bg)';

    const td = document.createElement('td');
    td.colSpan = 13; // matches our header column count
    td.style.padding = 'var(--tb-sp-3)';
    td.style.borderBottom = '1px solid var(--tb-border)';

    const wrap = el('div');

    // Full milestone + event text shown prominently here — the
    // breakdown table's Notes column is intentionally clipped to
    // keep the table dense, so this is where users see everything.
    const milestoneNote = (row.milestones || []).map((m) => t('proj.milestone.' + m)).filter(Boolean).join(' · ');
    const eventNote = (row.events || []).map((ev) => {
      if (ev.type === 'transfer') return '🔁 ' + ev.from_name + ' → ' + ev.to_name + ' ($' + Math.round(ev.amount_usd).toLocaleString() + ')';
      if (ev.type === 'close')    return '🔒 ' + ev.from_name + ' closed';
      return '';
    }).filter(Boolean).join(' · ');
    const fullNotes = [milestoneNote, eventNote].filter(Boolean).join('  ·  ');
    if (fullNotes) {
      wrap.appendChild(el('div', {
        style: {
          fontSize: 'var(--tb-fs-12)',
          padding: '6px 10px',
          marginBottom: 'var(--tb-sp-2)',
          background: 'var(--tb-bg-elev)',
          borderLeft: '3px solid var(--tb-navy)',
          borderRadius: 'var(--tb-radius-1)',
          fontWeight: '600',
        },
      }, fullNotes));
    }

    wrap.appendChild(el('div', {
      style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-2)', fontStyle: 'italic' },
    }, t('proj.monthly.help')));

    // Month-by-month table.
    const moTable = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-12)' },
    });
    const thStyle = { textAlign: 'right', padding: '3px 8px', borderBottom: '1px solid var(--tb-border)', color: 'var(--tb-text-soft)', fontWeight: '600' };
    const thStyleL = Object.assign({}, thStyle, { textAlign: 'left' });
    moTable.appendChild(el('thead', null,
      el('tr', null,
        el('th', { style: thStyleL }, t('proj.monthly.col.month')),
        el('th', { style: thStyle  }, t('proj.monthly.col.salary')),
        el('th', { style: thStyle  }, t('proj.monthly.col.contrib')),
        el('th', { style: thStyle  }, t('proj.monthly.col.draw')),
        el('th', { style: thStyle  }, t('proj.monthly.col.tax')),
        el('th', { style: thStyle  }, t('proj.monthly.col.ss')),
        el('th', { style: thStyle  }, t('proj.monthly.col.net')),
        el('th', { style: thStyleL }, t('proj.monthly.col.events')),
      ),
    ));
    const tdStyle = { textAlign: 'right', padding: '3px 8px', borderBottom: '1px dashed var(--tb-border)', fontFamily: 'var(--tb-font-mono)' };
    const tdStyleL = Object.assign({}, tdStyle, { textAlign: 'left' });

    // Annual amounts → monthly with REAL events (Phase 4):
    //   • Salary spread evenly except bonus_month gets the bonus
    //     (bonus_pct_of_salary % of base salary) added on top
    //   • Contributions follow salary pattern (extra contrib in
    //     bonus month if matched)
    //   • Estimated tax payments hit Apr/Jun/Sep/Jan (US quarterly)
    //   • JP 住民税 payments hit Jun/Aug/Oct/Jan (4 installments)
    //   • RSU vests on rsu_vest_months — adds to monthly income +
    //     extra contrib + extra tax that month
    //   • Roth conversions placed at month 3 (typical Q1 timing)
    //   • close_date events fire at month 1 (start of year)
    const inputs = getInputs();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const bonusMonth = (inputs.bonus_month || 3) - 1; // 0-indexed
    const bonusPct = (inputs.bonus_pct_of_salary || 0) / 100;
    const baseMo = row.salary * (1 - bonusPct) / 12;       // base salary spread, excluding bonus
    const bonusOnce = row.salary * bonusPct;                // bonus paid once

    const fullContrib = row.emp_contrib + row.employer_match + (row.catch_up_contrib || 0);
    // Match contribution pattern to salary so bonus month sees an
    // outsized contribution (matching reality for percentage-based
    // contributions).
    const contribBase = fullContrib * (1 - bonusPct) / 12;
    const contribBonus = fullContrib * bonusPct;

    const moDraw = row.withdraw_actual / 12;
    const ssMo = row.ss_annual / 12;
    const annualTax = row.us_tax + row.jp_tax + (row.penalty || 0) + (row.niit || 0) + (row.state_tax || 0);
    // US estimated tax — 4 quarterly payments. JP juminze — 4 installments.
    // For working-year US tax, withholding is monthly via paycheck.
    // For retirement-year US tax, model as 4 quarterly estimated.
    function taxThisMonth(m) {
      if (row.phase === 'accum') {
        // Withholding model — spread evenly with paycheck.
        return annualTax / 12;
      }
      // Distribution — quarterly estimated payments (Apr/Jun/Sep/Jan).
      // Months: 0=Jan, 3=Apr, 5=Jun, 8=Sep
      if (m === 3 || m === 5 || m === 8 || m === 0) return annualTax / 4;
      return 0;
    }
    // IRMAA Medicare premium — paid monthly when 65+.
    const irmaaMo = (row.irmaa || 0) / 12;
    // Medicare base premium ($175/mo standard 2024) — only when 65+.
    const medicareBaseMo = row.age >= 65 ? (inputs.medicare_part_b_base_monthly || 175) : 0;

    const fmt = (v) => v ? TB.utils.formatUSD(v, { maximumFractionDigits: 0 }) : '—';

    // RSU vest schedule — distribute any "RSU income" evenly across
    // vest months. We don't model RSU income explicitly yet, so this
    // is just a label: shows "RSU vest" event marker.
    const rsuMonths = (inputs.rsu_vest_months || []).map((m) => m - 1);

    const tbody = el('tbody');
    for (let m = 0; m < 12; m++) {
      const events = [];
      // close_date events fire at month 1 (start of year).
      if (m === 0 && row.events && row.events.length) {
        for (const ev of row.events) {
          if (ev.type === 'transfer') events.push('🔁 ' + ev.from_name + ' → ' + ev.to_name);
          if (ev.type === 'close')    events.push('🔒 ' + ev.from_name + ' closed');
        }
      }
      if (m === 2 && row.roth_conversion > 0) {
        events.push('🟢 Roth conv $' + Math.round(row.roth_conversion).toLocaleString());
      }
      if (m === bonusMonth && bonusOnce > 0) {
        events.push('💰 Bonus $' + Math.round(bonusOnce).toLocaleString());
      }
      if (rsuMonths.indexOf(m) !== -1 && row.phase === 'accum') {
        events.push('📈 RSU vest');
      }
      // US estimated tax payment marker
      if (row.phase === 'dist' && (m === 3 || m === 5 || m === 8 || m === 0)) {
        events.push('🇺🇸 Q tax');
      }
      // JP juminze installment marker (post-住民票 only)
      if (row.is_post_juminhyou && (m === 5 || m === 7 || m === 9 || m === 0)) {
        events.push('🇯🇵 住民税');
      }
      // Medicare/IRMAA marker — first month of 65
      if (row.age === 65 && m === 0) {
        events.push('🏥 Medicare starts');
      }

      const moSalary = baseMo + (m === bonusMonth ? bonusOnce : 0);
      const moContrib = contribBase + (m === bonusMonth ? contribBonus : 0);
      const moTax = taxThisMonth(m);
      const moMedicare = medicareBaseMo + irmaaMo;
      // Net monthly = income - tax - medicare
      const moNet = moSalary + ssMo + moDraw - moTax - moMedicare;

      tbody.appendChild(el('tr', null,
        el('td', { style: tdStyleL }, months[m]),
        el('td', { style: tdStyle  }, fmt(dfl(moSalary, row.year))),
        el('td', { style: tdStyle  }, fmt(dfl(moContrib, row.year))),
        el('td', { style: tdStyle  }, fmt(dfl(moDraw, row.year))),
        el('td', { style: tdStyle  }, fmt(dfl(moTax, row.year))),
        el('td', { style: tdStyle  }, fmt(dfl(ssMo, row.year))),
        el('td', { style: Object.assign({}, tdStyle, { fontWeight: '600' }) }, fmt(dfl(moNet, row.year))),
        el('td', { style: Object.assign({}, tdStyleL, { color: 'var(--tb-text-soft)' }) }, events.join(' · ')),
      ));
    }
    moTable.appendChild(tbody);
    wrap.appendChild(moTable);
    td.appendChild(wrap);
    tr.appendChild(td);
    return tr;
  }

  // CSV export — download the year-by-year breakdown table as a
  // spreadsheet-friendly file. Includes all numeric columns + notes.
  // Quotes any cell with a comma so Excel parses cleanly.
  function exportBreakdownCsv(result) {
    const t = TB.i18n.t;
    const cols = [
      { key: 'year',                 label: 'Year' },
      { key: 'age',                  label: 'Age' },
      { key: 'phase',                label: 'Phase' },
      { key: 'is_post_juminhyou',    label: 'Post 住民票' },
      { key: 'salary',               label: 'Salary' },
      { key: 'emp_contrib',          label: 'Emp Contrib' },
      { key: 'catch_up_contrib',     label: 'Catch-up' },
      { key: 'employer_match',       label: 'Employer Match' },
      { key: 'total_usd',            label: 'Portfolio Total' },
      { key: 'withdraw_actual',      label: 'Withdraw' },
      { key: 'roth_conversion',      label: 'Roth Conversion' },
      { key: 'us_tax',               label: 'US Tax' },
      { key: 'jp_tax',               label: 'JP Tax' },
      { key: 'state_tax',            label: 'State Tax' },
      { key: 'niit',                 label: 'NIIT' },
      { key: 'irmaa',                label: 'IRMAA' },
      { key: 'penalty',              label: 'Early Penalty' },
      { key: 'ss_annual',            label: 'Social Security' },
      { key: 'net_monthly_usd',      label: 'Net Monthly' },
      { key: 'milestones',           label: 'Milestones' },
      { key: 'events',               label: 'Events' },
    ];
    const rows = result.rows || [];
    function csvEscape(v) {
      if (v == null) return '';
      const s = String(v);
      if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
        return '"' + s.replaceAll('"', '""') + '"';
      }
      return s;
    }
    function fmtCell(r, key) {
      const v = r[key];
      if (key === 'milestones' && Array.isArray(v)) {
        return v.map((m) => t('proj.milestone.' + m) || m).join(' · ');
      }
      if (key === 'events' && Array.isArray(v)) {
        return v.map((ev) => {
          if (ev.type === 'transfer') return ev.from_name + ' → ' + ev.to_name + ' ($' + Math.round(ev.amount_usd) + ')';
          if (ev.type === 'close')    return ev.from_name + ' closed';
          return '';
        }).filter(Boolean).join(' · ');
      }
      if (key === 'is_post_juminhyou') return v ? 'YES' : '';
      if (typeof v === 'number') return v.toFixed(2);
      return v != null ? String(v) : '';
    }
    const header = cols.map((c) => csvEscape(c.label)).join(',');
    const body = rows.map((r) =>
      cols.map((c) => csvEscape(fmtCell(r, c.key))).join(',')
    ).join('\n');
    const csv = header + '\n' + body + '\n';

    // Filename includes scenario name + date for tidy archiving.
    const ui = getUiState();
    const scenarios = TB.state.get('projections.scenarios') || [];
    const active = scenarios.find((s) => s.id === ui.scenario_id);
    const scenarioLabel = active ? active.name.replace(/[^a-z0-9_-]+/gi, '_') : 'working';
    const today = new Date().toISOString().slice(0, 10);
    const filename = 'taigan-projection-' + scenarioLabel + '-' + today + '.csv';

    TB.utils.downloadFile(filename, csv, 'text/csv;charset=utf-8');
  }

  function buildBreakdownTable(result) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    // Title row with CSV export button on the right.
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--tb-sp-2)' },
    },
      el('h3', { style: { margin: 0 } }, t('proj.table.title')),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => exportBreakdownCsv(result),
      }, '⬇ ' + t('proj.table.csv')),
    ));
    card.appendChild(el('p', { class: 'tb-field-help' }, t('proj.table.help')));

    const wrap = el('div', { style: { overflowX: 'auto' } });
    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-12)', whiteSpace: 'nowrap', tableLayout: 'auto' },
    });
    const thStyle = { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--tb-border)', color: 'var(--tb-text-soft)', fontWeight: '600' };
    const thStyleL = Object.assign({}, thStyle, { textAlign: 'left' });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', { style: thStyleL }, t('proj.table.col.year')),
        el('th', { style: thStyleL }, t('proj.table.col.age')),
        el('th', { style: thStyleL }, t('proj.table.col.phase')),
        el('th', { style: thStyle  }, t('proj.table.col.salary')),
        el('th', { style: thStyle  }, t('proj.table.col.contrib')),
        el('th', { style: thStyle  }, t('proj.table.col.total')),
        el('th', { style: thStyle  }, t('proj.table.col.draw')),
        el('th', { style: thStyle  }, t('proj.table.col.roth_conv')),
        el('th', { style: thStyle  }, t('proj.table.col.us_tax')),
        el('th', { style: thStyle  }, t('proj.table.col.jp_tax')),
        el('th', { style: thStyle  }, t('proj.table.col.penalty')),
        el('th', { style: thStyle  }, t('proj.table.col.ss')),
        el('th', { style: thStyle  }, t('proj.table.col.net_mo')),
        el('th', { style: thStyleL }, t('proj.table.col.notes')),
      ),
    ));

    const tbody = el('tbody');
    const tdR = { textAlign: 'right', padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)', fontFamily: 'var(--tb-font-mono)' };
    const tdL = { textAlign: 'left',  padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)' };
    // Notes cell: clipped to one line with ellipsis. Full text shown
    // in the title attribute (browser tooltip) AND in the click-to-
    // expand monthly view, so nothing is hidden — just collapsed for
    // table density. Fixed width so it doesn't push other columns.
    const tdNotes = {
      textAlign: 'left', padding: '4px 8px', borderBottom: '1px dashed var(--tb-border)',
      color: 'var(--tb-text-soft)',
      maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };
    const fmt = (v) => v ? TB.utils.formatUSD(v, { maximumFractionDigits: 0 }) : '—';

    const ui = getUiState();
    const dfl = (v, yr) => deflated(v, yr, ui);
    // pairCell wraps fmtCurrencyPair so each table cell shows USD or
    // JPY primary with the other in the clickable parenthetical. The
    // function is local because it captures `dfl` for inflation view.
    function pairCell(v, year) {
      if (v == null || !isFinite(v) || v === 0) {
        const t = document.createElement('span');
        t.textContent = '—';
        return t;
      }
      return fmtCurrencyPair(dfl(v, year));
    }

    for (const r of result.rows) {
      const milestoneNote = r.milestones.map((m) => t('proj.milestone.' + m)).filter(Boolean).join(' · ');
      const eventNotes = (r.events || []).map((ev) => {
        if (ev.type === 'transfer') return '🔁 ' + ev.from_name + ' → ' + ev.to_name + ' ($' + Math.round(ev.amount_usd).toLocaleString() + ')';
        if (ev.type === 'close')    return '🔒 ' + ev.from_name + ' closed';
        return '';
      }).filter(Boolean).join(' · ');
      const allNotes = [milestoneNote, eventNotes].filter(Boolean).join(' · ');
      // Build the contrib cell with a tooltip listing the SECURE 2.0
      // catch-up tier when one applies, e.g. "$23.5K base + $7.5K (50+)".
      const contribTotal = r.emp_contrib + r.employer_match + (r.catch_up_contrib || 0);
      let contribTooltip = '';
      if (r.catch_up_contrib > 0) {
        const tierLabel = r.catch_up_kind === 'secure_60_63' ? 'SECURE 2.0 60-63'
                        : r.catch_up_kind === 'standard50'   ? '50+ catch-up'
                        : 'catch-up';
        contribTooltip = 'Base $' + Math.round(r.emp_contrib).toLocaleString() +
                         ' + Catch-up $' + Math.round(r.catch_up_contrib).toLocaleString() + ' (' + tierLabel + ')' +
                         ' + Match $' + Math.round(r.employer_match).toLocaleString() +
                         (r.section_603_active ? '  ·  Section 603: catch-up routed to Roth' : '');
      }

      const tr = el('tr', {
        style: Object.assign({ cursor: 'pointer' }, r.is_post_juminhyou ? { background: 'rgba(178, 58, 58, 0.04)' } : {}),
        title: t('proj.table.row.expand'),
        onclick: (e) => {
          // Don't toggle if a child input/button was clicked.
          if (e.target.closest('input,button,a,select')) return;
          toggleMonthlyRow(tr, r);
        },
      },
        el('td', { style: tdL },
          el('span', { 'data-mo-toggle': '', style: { color: 'var(--tb-text-soft)', marginRight: '4px', fontSize: '10px', display: 'inline-block', width: '10px' } }, '▸'),
          String(r.year)),
        el('td', { style: tdL }, String(r.age)),
        el('td', { style: tdL },
          el('span', {
            style: {
              padding: '1px 6px', borderRadius: '3px', fontSize: '10px',
              background: r.phase === 'accum' ? 'var(--tb-success)' : 'var(--tb-warn)',
              color: '#fff',
            },
          }, t('proj.phase.' + r.phase))),
        el('td', { style: tdR }, pairCell(r.salary, r.year)),
        el('td', {
          style: Object.assign({}, tdR, r.catch_up_contrib > 0 ? { color: 'var(--tb-success)' } : {}),
          title: contribTooltip,
        }, pairCell(contribTotal, r.year)),
        el('td', { style: Object.assign({}, tdR, { fontWeight: '600' }) }, pairCell(r.total_usd, r.year)),
        el('td', { style: tdR }, pairCell(r.withdraw_actual, r.year)),
        el('td', {
          style: Object.assign({}, tdR, (r.roth_conversion || 0) > 0 ? { color: 'var(--tb-success)', fontWeight: '600' } : {}),
          title: (r.roth_conversion_jp_tax || 0) > 0
            ? 'Conversion taxed by JP at marginal rate (post-住民票) — costly!' : '',
        }, pairCell(r.roth_conversion, r.year)),
        el('td', { style: tdR }, pairCell(r.us_tax, r.year)),
        el('td', { style: Object.assign({}, tdR, r.jp_tax > 0 ? { color: 'var(--tb-error)' } : {}) }, pairCell(r.jp_tax, r.year)),
        el('td', {
          style: Object.assign({}, tdR, r.penalty > 0 ? { color: 'var(--tb-error)', fontWeight: '600' } : {}),
          title: r.penalty > 0 ? '10% early-withdrawal penalty (or 20% for HSA before 65). Rule of 55 exempts 401(k)/TSP when retiring at 55+.' : '',
        }, pairCell(r.penalty, r.year)),
        el('td', { style: tdR }, pairCell(r.ss_annual, r.year)),
        el('td', { style: Object.assign({}, tdR, { fontWeight: '600' }) }, pairCell(r.net_monthly_usd, r.year)),
        el('td', { style: tdNotes, title: allNotes || '' }, allNotes),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  // ====================================================================
  // Japan Inheritance Tax Mitigation — sub-section under Tax Strategy
  // ====================================================================
  //
  // The headline jpinheritance callout warns about the 10-year worldwide-
  // assets clock and rates. This section presents the concrete legal
  // mitigation strategies — each as its own colored callout so users
  // can scan and act. Sourced from Japan tax code + reference summary
  // at tax-ms.jp/how-to-reduce-inheritance-tax-in-japan-legal-methods.
  //
  // Important caveat embedded in every callout: this is reference
  // material, not advice. Inheritance tax planning ALWAYS requires a
  // licensed Japanese 税理士 (zeirishi) — most strategies have multi-
  // year lookback rules and tight documentation requirements.

  function buildInheritanceMitigationSection() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const wrap = el('div', {
      style: {
        marginLeft: 'var(--tb-sp-3)',
        paddingLeft: 'var(--tb-sp-3)',
        borderLeft: '2px dotted var(--tb-warn)',
        marginTop: 'var(--tb-sp-3)',
        marginBottom: 'var(--tb-sp-3)',
      },
    });
    wrap.appendChild(el('h4', { style: { marginTop: 0, color: 'var(--tb-warn)' } },
      '📜 ' + t('proj.tax.jpinhmitigation.section.title')));
    wrap.appendChild(el('p', { class: 'tb-field-help', style: { margin: '0 0 var(--tb-sp-3)' } },
      t('proj.tax.jpinhmitigation.section.help')));

    function smallCallout(severity, titleKey, bodyKey) {
      const colors = {
        warn:    'var(--tb-warn)',
        info:    'var(--tb-text-soft)',
        success: 'var(--tb-success)',
        error:   'var(--tb-error)',
      };
      const color = colors[severity] || colors.info;
      return el('div', {
        style: {
          borderLeft: '3px solid ' + color,
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          marginBottom: 'var(--tb-sp-2)',
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)',
          fontSize: 'var(--tb-fs-14)',
        },
      },
        el('div', { style: { fontWeight: '600', color, marginBottom: '4px' } }, t(titleKey)),
        el('p', { style: { margin: 0, lineHeight: '1.55' } }, t(bodyKey)),
      );
    }

    // Order: most-leveraged / lowest-friction first
    wrap.appendChild(smallCallout('success', 'proj.tax.jpinhmit.gifting.title',          'proj.tax.jpinhmit.gifting.body'));
    wrap.appendChild(smallCallout('success', 'proj.tax.jpinhmit.spouse.title',           'proj.tax.jpinhmit.spouse.body'));
    wrap.appendChild(smallCallout('success', 'proj.tax.jpinhmit.lifeinsurance.title',    'proj.tax.jpinhmit.lifeinsurance.body'));
    wrap.appendChild(smallCallout('success', 'proj.tax.jpinhmit.smallres.title',         'proj.tax.jpinhmit.smallres.body'));
    wrap.appendChild(smallCallout('info',    'proj.tax.jpinhmit.education.title',        'proj.tax.jpinhmit.education.body'));
    wrap.appendChild(smallCallout('info',    'proj.tax.jpinhmit.marriage.title',         'proj.tax.jpinhmit.marriage.body'));
    wrap.appendChild(smallCallout('info',    'proj.tax.jpinhmit.realestate.title',       'proj.tax.jpinhmit.realestate.body'));
    wrap.appendChild(smallCallout('info',    'proj.tax.jpinhmit.rental.title',           'proj.tax.jpinhmit.rental.body'));
    wrap.appendChild(smallCallout('info',    'proj.tax.jpinhmit.adoption.title',         'proj.tax.jpinhmit.adoption.body'));
    wrap.appendChild(smallCallout('warn',    'proj.tax.jpinhmit.settlementtax.title',    'proj.tax.jpinhmit.settlementtax.body'));
    wrap.appendChild(smallCallout('error',   'proj.tax.jpinhmit.preten.title',           'proj.tax.jpinhmit.preten.body'));
    wrap.appendChild(smallCallout('warn',    'proj.tax.jpinhmit.ustreaty.title',         'proj.tax.jpinhmit.ustreaty.body'));
    wrap.appendChild(smallCallout('error',   'proj.tax.jpinhmit.notrust.title',          'proj.tax.jpinhmit.notrust.body'));

    // Reference link — National Tax Agency primary source.
    wrap.appendChild(el('div', {
      style: { marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
    },
      t('proj.tax.jpinhmit.section.references') + ' ',
      el('a', {
        href: 'https://www.nta.go.jp/english/taxes/individual/12010.htm',
        target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'var(--tb-navy)' },
      }, 'NTA inheritance tax overview'),
    ));

    return wrap;
  }

  // ====================================================================
  // Roth Conversion Ladder editor (Phase 3)
  // ====================================================================
  //
  // Per-year list of {year, amount_usd}. Adds/edits/deletes; live-
  // refreshes the projection on every change. Bracket-fill auto-
  // suggest pre-fills conversions for every pre-住民票 year up to a
  // configurable headroom (default $50K) so the user can see what a
  // standard ladder looks like, then tune from there.

  function getConversions() {
    const c = TB.state.get('projections.inputs.roth_conversions');
    return Array.isArray(c) ? c.slice() : [];
  }
  function setConversions(arr) {
    setInputField('roth_conversions', arr);
  }

  // Roth ladder optimizer modal. Shows a preview of the optimal
  // conversion ladder for the user's currently-selected target bracket,
  // displays year-by-year amounts + capping reasons (bracket / balance
  // / window), and lets the user accept to overwrite the current
  // conversion entries.
  function openOptimizerModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const inputs = getInputs();
    const accounts = (TB.assets && TB.assets.getActiveAccounts)
      ? TB.assets.getActiveAccounts() : [];
    const sofaProfile = TB.state.get('sofa.profile') || {};

    let targetRate = 22;
    let maxPerYear = null;

    function close() { root.innerHTML = ''; }

    function paint() {
      const result = optimizeRothLadder(inputs, accounts, sofaProfile, {
        target_rate: targetRate,
        max_per_year: maxPerYear,
      });
      root.innerHTML = '';
      const backdrop = el('div', { class: 'tb-modal-backdrop' });
      const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
      backdrop.appendChild(modal);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      modal.appendChild(el('button', { class: 'tb-modal-close', type: 'button', onclick: close }, '×'));
      modal.appendChild(el('h2', { style: { marginTop: 0 } },
        '🎯 ' + t('proj.optimize.title')));
      modal.appendChild(el('p', { class: 'tb-card-meta' }, t('proj.optimize.intro')));

      // Strategy controls
      const ctrlRow = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap', marginBottom: 'var(--tb-sp-3)' } });
      ctrlRow.appendChild(el('div', null,
        el('label', { class: 'tb-field-label' }, t('proj.optimize.targetBracket')),
        el('select', {
          class: 'tb-select',
          onchange: (e) => { targetRate = parseInt(e.target.value, 10); paint(); },
        },
          [12, 22, 24, 32].map((r) => el('option', {
            value: r, selected: r === targetRate,
          }, t('proj.optimize.bracket', { pct: r }))),
        ),
      ));
      ctrlRow.appendChild(el('div', null,
        el('label', { class: 'tb-field-label' }, t('proj.optimize.maxPerYear')),
        el('input', {
          type: 'number', class: 'tb-input',
          style: { maxWidth: '160px' },
          value: maxPerYear || '',
          placeholder: t('proj.optimize.noLimit'),
          step: 10000, min: 0,
          oninput: (e) => {
            const v = parseFloat(e.target.value);
            maxPerYear = isFinite(v) && v > 0 ? v : null;
            paint();
          },
        }),
      ));
      modal.appendChild(ctrlRow);

      // Reason — no ladder possible.
      if (result.rows.length === 0) {
        let reason = t('proj.optimize.empty');
        if (result.reason === 'no_trad_balance') reason = t('proj.optimize.noTradBalance');
        else if (result.reason === 'window_closed') reason = t('proj.optimize.windowClosed');
        modal.appendChild(el('div', { class: 'tb-field-help' }, reason));
        const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--tb-sp-3)' } },
          el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('proj.optimize.close')),
        );
        modal.appendChild(btnRow);
        root.appendChild(backdrop);
        return;
      }

      // Headline stats
      modal.appendChild(el('div', {
        style: {
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)',
        },
      },
        miniStat(t('proj.optimize.stat.years'), result.rows.length),
        miniStat(t('proj.optimize.stat.converted'),
          '$' + Math.round(result.total_converted_usd).toLocaleString()),
        miniStat(t('proj.optimize.stat.usTax'),
          '$' + Math.round(result.total_us_tax_usd).toLocaleString()),
        miniStat(t('proj.optimize.stat.effectiveRate'),
          result.effective_rate_pct.toFixed(1) + '%'),
        result.remaining_trad_balance_usd > 0 ? miniStat(
          t('proj.optimize.stat.unconverted'),
          '$' + Math.round(result.remaining_trad_balance_usd).toLocaleString(),
          'var(--tb-warn)',
        ) : null,
      ));

      // Window-closing warning
      if (result.juminhyou_year != null) {
        modal.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'rgba(185, 122, 26, 0.10)',
            borderLeft: '3px solid var(--tb-warn)',
            borderRadius: 'var(--tb-radius-1)',
            marginBottom: 'var(--tb-sp-3)',
            fontSize: 'var(--tb-fs-12)',
          },
        }, '⏳ ' + t('proj.optimize.windowNote', { year: result.juminhyou_year })));
      }

      // Per-year preview table
      const table = el('table', {
        style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-12)' },
      });
      table.appendChild(el('thead', null,
        el('tr', null,
          th(t('proj.optimize.col.year')),
          th(t('proj.optimize.col.age'), 'right'),
          th(t('proj.optimize.col.baseIncome'), 'right'),
          th(t('proj.optimize.col.bracketTop'), 'right'),
          th(t('proj.optimize.col.convert'), 'right'),
          th(t('proj.optimize.col.cappedBy'), 'left'),
        ),
      ));
      const tbody = el('tbody');
      const reasonLabel = {
        bracket: t('proj.optimize.capped.bracket'),
        balance: t('proj.optimize.capped.balance'),
        window:  t('proj.optimize.capped.window'),
        partial: t('proj.optimize.capped.partial'),
      };
      for (const r of result.rows) {
        tbody.appendChild(el('tr', null,
          td(r.year),
          td(r.age, 'right'),
          td('$' + r.base_taxable.toLocaleString(), 'right'),
          td('$' + r.target_top.toLocaleString(), 'right'),
          td(el('strong', null, '$' + r.amount_usd.toLocaleString()), 'right'),
          td(reasonLabel[r.capped_by] || r.capped_by, 'left'),
        ));
      }
      table.appendChild(tbody);
      modal.appendChild(table);

      modal.appendChild(el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' } },
        t('proj.optimize.disclaimer')));

      // Action buttons
      const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } });
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('proj.optimize.cancel')));
      btnRow.appendChild(el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => {
          if ((getConversions() || []).length > 0) {
            if (!confirm(t('proj.optimize.replaceConfirm'))) return;
          }
          const ladder = result.rows.map((r) => ({ year: r.year, amount_usd: r.amount_usd }));
          setConversions(ladder);
          close();
          renderActiveTab();
          liveRefresh();
        },
      }, '✓ ' + t('proj.optimize.apply')));
      modal.appendChild(btnRow);

      root.appendChild(backdrop);
    }

    function miniStat(label, value, color) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          border: '1px solid var(--tb-border)',
        },
      },
        el('div', { style: { fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--tb-text-soft)', fontWeight: '600' } }, label),
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '700', color: color || 'var(--tb-text)', fontSize: 'var(--tb-fs-16)', marginTop: '2px' } }, value),
      );
    }
    function th(text, align) {
      return el('th', {
        style: {
          padding: '6px 8px', textAlign: align || 'left',
          borderBottom: '1px solid var(--tb-border)',
          fontSize: '10px', fontWeight: '600', textTransform: 'uppercase',
          letterSpacing: '0.04em', color: 'var(--tb-text-soft)',
        },
      }, text);
    }
    function td(content, align) {
      return el('td', {
        style: {
          padding: '5px 8px', textAlign: align || 'left',
          borderBottom: '1px dashed var(--tb-border)',
          fontFamily: align === 'right' ? 'var(--tb-font-mono)' : 'inherit',
        },
      }, content);
    }

    paint();
  }

  function buildConversionEditor() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const inputs = getInputs();
    const conversions = getConversions().slice().sort((a, b) => a.year - b.year);
    const sofaProfile = TB.state.get('sofa.profile') || {};
    const taxAssump = TB.state.get('sofa.tax_assumptions') || {};

    const card = el('div', {
      style: {
        borderLeft: '3px solid var(--tb-success)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        marginBottom: 'var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
      },
    });

    card.appendChild(el('div', { style: { fontWeight: '600', color: 'var(--tb-success)', marginBottom: 'var(--tb-sp-1)' } },
      t('proj.roth.title')));
    card.appendChild(el('p', { class: 'tb-field-help', style: { margin: 0 } }, t('proj.roth.help')));

    // Back-link to SOFA Roth Sequencer for the strategic context.
    card.appendChild(el('p', { class: 'tb-field-help', style: { margin: '6px 0 0' } },
      el('a', {
        href: '#',
        style: { color: 'var(--tb-success)' },
        onclick: (e) => {
          e.preventDefault();
          try { TB.state.set('sofa.ui_state.active_tab', 'sequence'); } catch (err) {}
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'sofa-roth' } }));
        },
      }, '↗ ' + t('proj.roth.viewInSofa')),
    ));

    // Lifetime conversion summary (from current cached result)
    const result = cachedResult;
    if (result) {
      let totalConv = 0, totalUs = 0, totalJp = 0;
      for (const r of result.rows) {
        totalConv += (r.roth_conversion || 0);
        totalUs   += (r.roth_conversion_us_tax || 0);
        totalJp   += (r.roth_conversion_jp_tax || 0);
      }
      if (totalConv > 0) {
        const stat = el('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-3)',
            margin: 'var(--tb-sp-2) 0',
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)',
            fontSize: 'var(--tb-fs-12)', fontFamily: 'var(--tb-font-mono)',
          },
        },
          el('span', null, t('proj.roth.summary.converted') + ': ', fmtCurrencyPair(totalConv, { layout: 'inline' })),
          el('span', { style: { color: 'var(--tb-text-soft)' } },
            t('proj.roth.summary.us_tax') + ': ', fmtCurrencyPair(totalUs, { layout: 'inline' })),
          totalJp > 0 ? el('span', { style: { color: 'var(--tb-error)' } },
            t('proj.roth.summary.jp_tax') + ': ', fmtCurrencyPair(totalJp, { layout: 'inline' })) : null,
        );
        card.appendChild(stat);
      }
    }

    // Current ladder rows
    const list = el('div', { style: { marginTop: 'var(--tb-sp-2)' } });
    if (conversions.length === 0) {
      list.appendChild(el('p', { class: 'tb-field-help', style: { fontStyle: 'italic' } }, t('proj.roth.empty')));
    } else {
      // Table-style layout
      const startYear = new Date().getFullYear();
      for (let i = 0; i < conversions.length; i++) {
        const c = conversions[i];
        const ageInYear = inputs.current_age + (c.year - startYear);
        const juminhyouDate = sofaProfile.juminhyou_target_date;
        const jYear = juminhyouDate && /^\d{4}/.test(juminhyouDate) ? parseInt(juminhyouDate.slice(0, 4), 10) : null;
        const isPostJ = jYear != null && c.year >= jYear;

        const row = el('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)',
            padding: '6px 8px',
            borderRadius: 'var(--tb-radius-1)',
            background: isPostJ ? 'rgba(178, 58, 58, 0.06)' : 'var(--tb-bg-elev)',
            marginBottom: '4px',
          },
        });
        // Year input
        const yearInput = el('input', {
          type: 'number', class: 'tb-input',
          style: { width: '90px', padding: '4px 8px' },
          value: c.year, min: startYear, max: startYear + 60,
          onchange: (e) => {
            const v = parseInt(e.target.value, 10);
            if (isFinite(v)) {
              const arr = getConversions();
              arr[i] = Object.assign({}, arr[i], { year: v });
              setConversions(arr);
              renderActiveTab();
            }
          },
        });
        // Amount input
        const amtInput = el('input', {
          type: 'number', class: 'tb-input',
          style: { width: '140px', padding: '4px 8px', fontFamily: 'var(--tb-font-mono)' },
          value: c.amount_usd, min: 0, step: 1000,
          onchange: (e) => {
            const v = parseFloat(e.target.value);
            const arr = getConversions();
            arr[i] = Object.assign({}, arr[i], { amount_usd: isFinite(v) && v > 0 ? v : 0 });
            setConversions(arr);
            renderActiveTab();
            liveRefresh();
          },
        });
        row.appendChild(el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', minWidth: '32px' } }, '#' + (i + 1)));
        row.appendChild(yearInput);
        row.appendChild(el('span', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
          t('proj.roth.row.age', { age: ageInYear })));
        row.appendChild(el('span', { style: { color: 'var(--tb-text-soft)' } }, '$'));
        row.appendChild(amtInput);
        if (isPostJ) {
          row.appendChild(el('span', {
            style: { color: 'var(--tb-error)', fontSize: 'var(--tb-fs-12)', fontWeight: '600' },
            title: t('proj.roth.row.postJ.tip'),
          }, '⚠ post-住民票'));
        }
        // Delete button
        row.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { marginLeft: 'auto', padding: '2px 8px', color: 'var(--tb-error)' },
          onclick: () => {
            const arr = getConversions();
            arr.splice(i, 1);
            setConversions(arr);
            renderActiveTab();
            liveRefresh();
          },
        }, '🗑'));
        list.appendChild(row);
      }
    }
    card.appendChild(list);

    // Buttons row
    const buttonsRow = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' } });

    buttonsRow.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        const arr = getConversions();
        // Default to next year + $50K
        const startYear = new Date().getFullYear();
        const proposedYear = arr.length > 0
          ? Math.max(...arr.map(c => c.year)) + 1
          : startYear + 1;
        arr.push({ year: proposedYear, amount_usd: 50000 });
        setConversions(arr);
        renderActiveTab();
        liveRefresh();
      },
    }, '+ ' + t('proj.roth.add')));

    // Bracket-fill auto-suggest. Fills every year between now and
    // 住民票 (or retire_age, whichever is sooner) with a default
    // headroom amount. Replaces existing entries; user can edit after.
    buttonsRow.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary', type: 'button',
      onclick: () => {
        const startYear = new Date().getFullYear();
        const jDate = sofaProfile.juminhyou_target_date;
        const jYear = jDate && /^\d{4}/.test(jDate) ? parseInt(jDate.slice(0, 4), 10) : (startYear + 5);
        // Cap at retire year and 住民票, whichever comes first.
        const retireYear = startYear + (inputs.retire_age - inputs.current_age);
        const endYear = Math.min(jYear, retireYear) - 1;
        if (endYear < startYear + 1) {
          alert(t('proj.roth.fill.tooSoon'));
          return;
        }
        const headroom = parseFloat(prompt(t('proj.roth.fill.prompt'), '50000'));
        if (!isFinite(headroom) || headroom <= 0) return;
        const arr = [];
        for (let y = startYear + 1; y <= endYear; y++) {
          arr.push({ year: y, amount_usd: headroom });
        }
        setConversions(arr);
        renderActiveTab();
        liveRefresh();
      },
    }, '✨ ' + t('proj.roth.fill.button')));

    // Real optimizer — opens a modal where the user picks a target
    // bracket, sees a preview of the suggested ladder, and accepts to
    // replace their current entries. Smarter than the flat-amount fill.
    buttonsRow.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => openOptimizerModal(),
    }, '🎯 ' + t('proj.roth.optimize.button')));

    if (conversions.length > 0) {
      buttonsRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { color: 'var(--tb-error)' },
        onclick: () => {
          if (!confirm(t('proj.roth.clear.confirm'))) return;
          setConversions([]);
          renderActiveTab();
          liveRefresh();
        },
      }, t('proj.roth.clear.button')));
    }

    card.appendChild(buttonsRow);
    return card;
  }

  // ====================================================================
  // Tax Strategy tab — SOFA-aware callouts
  // ====================================================================

  function renderTaxStrategyTab(host) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const inputs = getInputs();
    const sofaProfile = TB.state.get('sofa.profile') || {};
    const taxAssump = TB.state.get('sofa.tax_assumptions') || {};
    const result = cachedResult;

    function callout(severity, titleKey, body) {
      const colors = {
        warn:    'var(--tb-warn)',
        error:   'var(--tb-error)',
        info:    'var(--tb-text-soft)',
        success: 'var(--tb-success)',
      };
      const color = colors[severity] || colors.info;
      return el('div', {
        style: {
          borderLeft: '3px solid ' + color,
          padding: 'var(--tb-sp-3) var(--tb-sp-4)',
          marginBottom: 'var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)',
        },
      },
        el('div', { style: { fontWeight: '600', color, marginBottom: 'var(--tb-sp-1)' } }, t(titleKey)),
        typeof body === 'string' ? el('p', { style: { margin: 0 } }, body) : body,
      );
    }

    const out = el('div');

    // 住民票 conversion window
    if (sofaProfile.juminhyou_target_date) {
      const today = new Date();
      const target = new Date(sofaProfile.juminhyou_target_date + 'T00:00:00');
      const days = Math.round((target - today) / (1000 * 60 * 60 * 24));
      out.appendChild(callout(days > 0 ? 'warn' : 'info', 'proj.tax.juminhyou.title',
        days > 0
          ? t('proj.tax.juminhyou.future', { date: sofaProfile.juminhyou_target_date, days })
          : t('proj.tax.juminhyou.past',   { date: sofaProfile.juminhyou_target_date })));
    } else {
      out.appendChild(callout('info', 'proj.tax.juminhyou.title', t('proj.tax.juminhyou.unset')));
    }

    // RMD reminder
    const rmdYear = (new Date()).getFullYear() + (73 - inputs.current_age);
    out.appendChild(callout(inputs.current_age >= 73 ? 'error' : 'info', 'proj.tax.rmd.title',
      inputs.current_age >= 73
        ? t('proj.tax.rmd.now')
        : t('proj.tax.rmd.future', { year: rmdYear, age: 73 })));

    // Rule of 55 — applicable only when retiring 55-59 (employer plans only).
    if (inputs.retire_age >= 55 && inputs.retire_age < 60) {
      out.appendChild(callout('success', 'proj.tax.rule55.title',
        t('proj.tax.rule55.applies', { age: inputs.retire_age })));
    } else if (inputs.retire_age < 55) {
      out.appendChild(callout('warn', 'proj.tax.rule55.title',
        t('proj.tax.rule55.tooEarly', { age: inputs.retire_age })));
    } else {
      out.appendChild(callout('info', 'proj.tax.rule55.title',
        t('proj.tax.rule55.notNeeded', { age: inputs.retire_age })));
    }

    // SECURE 2.0 catch-up tiers — quick reference card.
    out.appendChild(callout('info', 'proj.tax.secure20.title', t('proj.tax.secure20.body')));

    // ─── Phase 4 — NIIT / IRMAA awareness ────────────────────────
    if (result && result.rows.some((r) => r.niit > 0)) {
      const totalNiit = result.rows.reduce((s, r) => s + (r.niit || 0), 0);
      out.appendChild(callout('warn', 'proj.tax.niit.title',
        t('proj.tax.niit.applies', { total: TB.utils.formatUSD(totalNiit, { maximumFractionDigits: 0 }) })));
    } else {
      out.appendChild(callout('info', 'proj.tax.niit.title', t('proj.tax.niit.body')));
    }

    if (result && result.rows.some((r) => r.irmaa > 0)) {
      const firstIrmaa = result.rows.find((r) => r.irmaa > 0);
      const totalIrmaa = result.rows.reduce((s, r) => s + (r.irmaa || 0), 0);
      out.appendChild(callout('warn', 'proj.tax.irmaa.title',
        t('proj.tax.irmaa.applies', {
          year: firstIrmaa.year,
          age: firstIrmaa.age,
          total: TB.utils.formatUSD(totalIrmaa, { maximumFractionDigits: 0 }),
        })));
    } else {
      out.appendChild(callout('info', 'proj.tax.irmaa.title', t('proj.tax.irmaa.body')));
    }

    // State tax awareness — only if user set a non-zero state tax.
    if (inputs.state_tax_pct > 0) {
      out.appendChild(callout('info', 'proj.tax.state.title',
        t('proj.tax.state.body', { pct: inputs.state_tax_pct })));
    }

    // Section 603 — only flag if any projection year had it active.
    if (result && result.rows.some((r) => r.section_603_active)) {
      const firstActive = result.rows.find((r) => r.section_603_active);
      const hasRoth = (TB.assets && TB.assets.getActiveAccounts)
        ? TB.assets.getActiveAccounts().some((a) => a.tax_wrapper === 'roth_401k') : false;
      out.appendChild(callout(hasRoth ? 'warn' : 'error', 'proj.tax.section603.title',
        hasRoth
          ? t('proj.tax.section603.routed', { year: firstActive.year })
          : t('proj.tax.section603.noRoth', { year: firstActive.year })));
    }

    // Bracket fill suggestion
    const usMarg = taxAssump.us_marginal_pct || 22;
    out.appendChild(callout('success', 'proj.tax.bracket.title',
      t('proj.tax.bracket.body', { pct: usMarg })));

    // Roth conversion window
    if (sofaProfile.juminhyou_target_date) {
      const target = new Date(sofaProfile.juminhyou_target_date + 'T00:00:00');
      const today = new Date();
      const days = Math.round((target - today) / (1000 * 60 * 60 * 24));
      if (days > 0) {
        out.appendChild(callout('warn', 'proj.tax.rothwindow.title',
          t('proj.tax.rothwindow.body', { days, date: sofaProfile.juminhyou_target_date })));
      }
    }

    // ─── Japan-resident strategies — applies whether or not the
    // user is SOFA-status. Anyone who is (or will be) a Japanese tax
    // resident holding US accounts faces these. ──────────────────
    out.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-5)',
        paddingTop: 'var(--tb-sp-3)',
        borderTop: '2px solid var(--tb-border)',
      },
    },
      el('h3', { style: { marginTop: 0, marginBottom: 'var(--tb-sp-1)' } },
        '🇯🇵 ' + t('proj.tax.jp.section.title')),
      el('p', { class: 'tb-field-help', style: { margin: 0 } },
        t('proj.tax.jp.section.help')),
    ));

    // PFIC trap (now in JP section — was orphaned before)
    out.appendChild(callout('error', 'proj.tax.pfic.title', t('proj.tax.pfic.body')));

    // NISA / iDeCo specific PFIC warning (more specific than the
    // generic one — these are the most-pushed JP vehicles)
    out.appendChild(callout('error', 'proj.tax.nisa.title', t('proj.tax.nisa.body')));

    // Furusato Nozei — the rare JP tax move that works cleanly for
    // US persons (it's a pre-tax JP donation, not an investment).
    out.appendChild(callout('success', 'proj.tax.furusato.title', t('proj.tax.furusato.body')));

    // Japan inheritance tax — 10-year residency clock is the key.
    // Applies to worldwide assets after 10y residency; rates 10-55%.
    out.appendChild(callout('warn', 'proj.tax.jpinheritance.title', t('proj.tax.jpinheritance.body')));

    // Inheritance tax mitigation sub-section. Each strategy is its
    // own callout so the user can scan, expand, and act on them
    // individually. Sourced from tax-ms.jp + Japan tax code references.
    out.appendChild(buildInheritanceMitigationSection());

    // Japan exit tax — 出国税 for ¥100M+ securities holders leaving.
    out.appendChild(callout('warn', 'proj.tax.jpexit.title', t('proj.tax.jpexit.body')));

    // US-Japan Tax Treaty Article 17 — pension treatment.
    out.appendChild(callout('info', 'proj.tax.treaty17.title', t('proj.tax.treaty17.body')));

    // Foreign Tax Credit cross-claims — most actionable for retirees
    // taking distributions while resident in Japan.
    out.appendChild(callout('info', 'proj.tax.ftc.title', t('proj.tax.ftc.body')));

    // NHI premium timing — premiums lag prior-year income by ~6 months.
    out.appendChild(callout('warn', 'proj.tax.nhi.title', t('proj.tax.nhi.body')));

    // iDeCo paradox — for US persons it's PFIC-trapped, but for non-
    // US-person spouses it's still a powerful deduction.
    out.appendChild(callout('info', 'proj.tax.ideco.title', t('proj.tax.ideco.body')));

    // Mortgage credit — if owning a Japan home as primary residence.
    out.appendChild(callout('info', 'proj.tax.jpmortgage.title', t('proj.tax.jpmortgage.body')));

    // ─── Back to projection-level: Roth Conversion Ladder editor ──
    out.appendChild(buildConversionEditor());

    // Total US tax + JP tax + early-withdrawal penalty over horizon.
    if (result && result.rows.length) {
      let usTotal = 0, jpTotal = 0, penTotal = 0;
      for (const r of result.rows) {
        usTotal += r.us_tax;
        jpTotal += r.jp_tax;
        penTotal += (r.penalty || 0);
      }
      const children = [
        el('p', { style: { margin: 0 } },
          t('proj.tax.lifetime.us') + ': ', fmtCurrencyPair(usTotal, { layout: 'inline' })),
        el('p', { style: { margin: 0 } },
          t('proj.tax.lifetime.jp') + ': ', fmtCurrencyPair(jpTotal, { layout: 'inline' })),
      ];
      if (penTotal > 0) {
        children.push(el('p', { style: { margin: 0, color: 'var(--tb-error)' } },
          t('proj.tax.lifetime.penalty') + ': ', fmtCurrencyPair(penTotal, { layout: 'inline' })));
      }
      children.push(el('p', { class: 'tb-field-help', style: { margin: 'var(--tb-sp-1) 0 0' } }, t('proj.tax.lifetime.note')));
      out.appendChild(callout('info', 'proj.tax.lifetime.title', el('div', null, ...children)));
    }

    // ─── Lifetime savings comparison: with-vs-without conversions ──
    // Runs a second projection with conversions zeroed out and shows
    // the lifetime tax delta. This makes the value of the Roth ladder
    // legible — without it, the conversion editor is just numbers.
    out.appendChild(buildSavingsComparisonCard());

    // ─── Cross-link to Decumulation module ──────────────────────────
    // Projections has shallow SS treatment (single claim age × benefit
    // amount). Decumulation has the full claim-age sensitivity + JP
    // pension paths + WEP/GPO repeal context. Surface that link
    // prominently here.
    out.appendChild(el('div', {
      style: {
        marginTop: 'var(--tb-sp-5)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        background: 'var(--tb-bg)',
        borderLeft: '3px solid var(--tb-track-retire)',
        borderRadius: 'var(--tb-radius-2)',
      },
    },
      el('div', { style: { fontWeight: '600', color: 'var(--tb-track-retire)', marginBottom: '4px' } },
        '🌅 ' + t('proj.tax.decumulationLink.title')),
      el('p', { style: { margin: '0 0 var(--tb-sp-2)' } },
        t('proj.tax.decumulationLink.body')),
      el('a', {
        href: '#',
        style: { color: 'var(--tb-track-retire)', fontWeight: '600' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'decumulation' } }));
        },
      }, '↗ ' + t('proj.tax.decumulationLink.open')),
    ));

    host.appendChild(out);
  }

  // Lifetime tax savings comparison — runs a "no conversions" baseline
  // projection alongside the current one and surfaces the delta. Shows
  // the user what they're getting (or paying) for the Roth ladder.
  function buildSavingsComparisonCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const result = cachedResult;
    const conversions = getConversions() || [];
    if (!result || conversions.length === 0) return el('div'); // nothing to compare

    // Compute a baseline result with conversions zeroed out.
    const inputs = getInputs();
    const accounts = (TB.assets && TB.assets.getActiveAccounts)
      ? TB.assets.getActiveAccounts() : [];
    const sofaProfile = TB.state.get('sofa.profile') || {};
    const taxAssump = TB.state.get('sofa.tax_assumptions') || {};

    // Temporarily override conversions to []. computeProjection reads
    // from state, so we save + restore.
    const savedConversions = TB.state.get('projections.conversions');
    TB.state.set('projections.conversions', []);
    let baseline;
    try {
      baseline = computeProjection(inputs, accounts, sofaProfile, taxAssump);
    } finally {
      TB.state.set('projections.conversions', savedConversions);
    }
    if (!baseline || !baseline.rows.length) return el('div');

    let curUs = 0, curJp = 0, baseUs = 0, baseJp = 0;
    for (const r of result.rows)  { curUs += r.us_tax; curJp += r.jp_tax; }
    for (const r of baseline.rows) { baseUs += r.us_tax; baseJp += r.jp_tax; }
    const totalDelta = (baseUs + baseJp) - (curUs + curJp);  // positive = savings
    const portfolioCur = (result.summary && result.summary.portfolio_at_90) || 0;
    const portfolioBase = (baseline.summary && baseline.summary.portfolio_at_90) || 0;
    const portfolioDelta = portfolioCur - portfolioBase;

    const card = el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
        background: 'var(--tb-bg)',
        borderLeft: '3px solid ' + (totalDelta >= 0 ? 'var(--tb-success)' : 'var(--tb-error)'),
        borderRadius: 'var(--tb-radius-2)',
      },
    });
    card.appendChild(el('div', { style: { fontWeight: '600', color: totalDelta >= 0 ? 'var(--tb-success)' : 'var(--tb-error)', marginBottom: 'var(--tb-sp-1)' } },
      (totalDelta >= 0 ? '✓ ' : '⚠ ') + t('proj.tax.savings.title')));
    card.appendChild(el('p', { class: 'tb-field-help', style: { margin: '0 0 var(--tb-sp-2)' } },
      t('proj.tax.savings.intro')));

    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-2)' },
    });
    function statBlock(label, baselineVal, currentVal, deltaIsBetter) {
      const delta = currentVal - baselineVal;
      const better = deltaIsBetter === 'lower' ? delta < 0 : delta > 0;
      const color = delta === 0 ? 'var(--tb-text-soft)'
                  : better ? 'var(--tb-success)' : 'var(--tb-error)';
      const sign = delta >= 0 ? '+' : '';
      return el('div', {
        style: { padding: 'var(--tb-sp-2)', background: 'var(--tb-bg-elev)', borderRadius: 'var(--tb-radius-1)' },
      },
        el('div', { style: { fontSize: '10px', color: 'var(--tb-text-soft)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600' } }, label),
        el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 'var(--tb-fs-12)', fontFamily: 'var(--tb-font-mono)' } },
          el('span', { style: { color: 'var(--tb-text-soft)' } }, '$' + Math.round(baselineVal).toLocaleString()),
          el('span', null, '→'),
          el('span', null, '$' + Math.round(currentVal).toLocaleString()),
        ),
        el('div', { style: { color, fontWeight: '700', fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-14)', marginTop: '2px' } },
          sign + '$' + Math.round(delta).toLocaleString()),
      );
    }
    grid.appendChild(statBlock(t('proj.tax.savings.usTotal'), baseUs, curUs, 'lower'));
    if (curJp > 0 || baseJp > 0) {
      grid.appendChild(statBlock(t('proj.tax.savings.jpTotal'), baseJp, curJp, 'lower'));
    }
    grid.appendChild(statBlock(t('proj.tax.savings.portfolioAt90'), portfolioBase, portfolioCur, 'higher'));
    card.appendChild(grid);

    const headline = el('div', {
      style: { marginTop: 'var(--tb-sp-2)', fontFamily: 'var(--tb-font-mono)',
        fontSize: 'var(--tb-fs-16)', fontWeight: '700',
        color: totalDelta >= 0 ? 'var(--tb-success)' : 'var(--tb-error)' },
    },
      (totalDelta >= 0 ? t('proj.tax.savings.saves') : t('proj.tax.savings.costs')) + ': ' +
      (totalDelta >= 0 ? '+' : '-') + '$' + Math.round(Math.abs(totalDelta)).toLocaleString() +
      ' ' + t('proj.tax.savings.lifetimeTax'));
    card.appendChild(headline);

    return card;
  }

  // ====================================================================
  // SVG helpers + formatting
  // ====================================================================

  function svgEl(name, attrs, children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    // Text-content children: if a string is the first child, set as textContent.
    if (typeof children === 'string') {
      node.textContent = children;
    } else if (Array.isArray(children)) {
      for (const c of children) if (c) node.appendChild(c);
    }
    return node;
  }

  function niceCeil(v) {
    if (v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    let nice;
    if (f <= 1) nice = 1;
    else if (f <= 2) nice = 2;
    else if (f <= 5) nice = 5;
    else nice = 10;
    return nice * exp;
  }

  function fmtAxisM(v) {
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v.toFixed(0);
  }
  function fmtAxisK(v) {
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'Projections',
    label_jp: '将来予測',
    render,
  };

  // Public API for other modules / tests
  window.TB.projections = {
    computeProjection,
    irs401kLimit,
    irs401kLimitDetail,
    section603HighEarner,
    computePenalty,
    ssBenefitMultiplier,
    blendGrowthRate,
    applyDrawdown,
    computeUsTax,
    computeJpTax,
    toggleCurrency,
    // v0.36 Roth ladder optimizer
    optimizeRothLadder,
    bracketsForYear,
    stdDeductionForYear,
    bracketTopAtRate,
  };
})();
