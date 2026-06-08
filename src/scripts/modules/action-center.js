/* Taigan Bridge — modules/action-center.js
 *
 * Action Center — the "what should I do today?" surface that pulls
 * from every other module's state and emits a sorted, deep-linkable
 * to-do list. The user dismisses items individually with a per-item
 * "until" date stored in state.action_center.dismissed so annual
 * recurring items (FBAR April 15) come back next year automatically.
 *
 * Two render surfaces:
 *   • renderWidget(host)   — top-N items as a dashboard card
 *   • render(host)         — full module view, grouped by urgency
 *
 * Architecture: each generator is a pure function (state → action[]).
 * deriveActions() runs all generators, filters dismissed items, and
 * sorts by urgency + deadline. Adding a new check is a one-function add.
 */

(function () {
  'use strict';

  const id = 'action-center';

  // Urgency rank for sorting + visual color.
  const URGENCY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const URGENCY_COLOR = {
    critical: 'var(--tb-error)',
    high:     'var(--tb-warn)',
    medium:   'var(--tb-accent)',
    low:      'var(--tb-text-soft)',
    info:     'var(--tb-text-soft)',
  };
  const URGENCY_LABEL = {
    critical: '⚠ CRITICAL',
    high:     '🟠 HIGH',
    medium:   '🟡 MEDIUM',
    low:      '🔵 LOW',
    info:     'ℹ INFO',
  };

  // ====================================================================
  // Generators — each returns 0+ action items based on current state.
  //
  // Action item shape:
  //   { id, group, urgency, icon, title, body, deadline?, module?, snoozable? }
  //
  // Generators get the (already-loaded) state via TB.state.get and
  // current date via Date(). Keep them small, pure, and well-named.
  // ====================================================================

  function todayIso() { return new Date().toISOString().slice(0, 10); }
  function daysUntil(iso) {
    if (!iso) return Infinity;
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return Infinity;
    const t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }
  function fmtUSD(v) { return TB.utils.formatUSD(v, { maximumFractionDigits: 0 }); }

  // ---- FBAR generators -----------------------------------------------

  function genFbarFilingDeadline() {
    const out = [];
    const now = new Date();
    const year = now.getUTCFullYear();
    // Only fire Jan-Apr. Deadline is April 15 of `year` for last year's
    // accounts. Auto-extended to October 15 if missed.
    const month = now.getUTCMonth() + 1;
    if (month > 4) return out;
    const balances = TB.state.get('fbar.yearly_balances') || [];
    const lastYearAccts = balances.filter((b) => Number(b.year) === year - 1);
    if (lastYearAccts.length === 0) return out;

    // Has any account been "filed" for last year already?
    const filings = TB.state.get('fbar.filing_history') || [];
    const filedLastYear = filings.some((f) => Number(f.year) === year - 1);
    if (filedLastYear) return out; // good, dismiss

    const deadline = year + '-04-15';
    out.push({
      id: 'fbar_filing_' + (year - 1),
      group: 'fbar', urgency: month >= 3 ? 'critical' : 'high',
      icon: '🏦',
      title: 'FBAR for ' + (year - 1) + ' due ' + deadline,
      body: 'You have foreign account balances recorded for ' + (year - 1) +
            ' but no filing logged. FinCEN 114 is due ' + deadline +
            ' (auto-extended to Oct 15). Penalty for non-willful failure: up to $16,536 per report.',
      deadline, module: 'fbar', snoozable: true,
    });
    return out;
  }

  function genFbarTreasuryStale() {
    const out = [];
    const fetchedAt = TB.state.get('settings.fx.treasury_fetched_at');
    const balances = TB.state.get('fbar.yearly_balances') || [];
    if (balances.length === 0) return out;
    const lastYear = (new Date()).getUTCFullYear() - 1;
    const haveLastYearRates = (TB.state.get('settings.fx.treasury_rates') || {})[String(lastYear)];
    if (haveLastYearRates) return out;
    out.push({
      id: 'fbar_treasury_' + lastYear,
      group: 'fbar', urgency: 'medium', icon: '💱',
      title: 'Refresh Treasury rates for ' + lastYear,
      body: 'You don\'t have ' + lastYear + ' Treasury Year-End rates loaded. FBAR uses these to convert foreign currency balances to USD. Refresh from fiscaldata.treasury.gov before filing.',
      module: 'fbar', snoozable: true,
    });
    return out;
  }

  // ---- Assets generators ---------------------------------------------

  function genAssetsStaleBalances() {
    const out = [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    const today = new Date();
    const stale = [];
    for (const a of accts) {
      if (!a.updated_at) continue;
      const age = Math.round((today - new Date(a.updated_at + 'T00:00:00')) / 86400000);
      if (age > 120) stale.push({ a, age });
    }
    if (stale.length === 0) return out;
    stale.sort((x, y) => y.age - x.age);
    const top = stale.slice(0, 3);
    const names = top.map((x) =>
      (x.a.institution ? x.a.institution + ' ' : '') + x.a.name + ' (' + x.age + 'd ago)'
    ).join(', ');
    out.push({
      id: 'assets_stale',
      group: 'assets',
      urgency: stale.length > 3 ? 'high' : 'medium',
      icon: '⏱',
      title: stale.length + ' account balance' + (stale.length > 1 ? 's are' : ' is') + ' stale (>120 days)',
      body: 'Refresh: ' + names + (stale.length > 3 ? ' …+' + (stale.length - 3) : '') +
            '. Stale balances make every projection scenario worse.',
      module: 'assets', snoozable: true,
    });
    return out;
  }

  function genAssetsSnapshotDue() {
    const out = [];
    const snaps = TB.state.get('assets.snapshots') || [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    if (accts.length === 0) return out;
    if (snaps.length === 0) {
      out.push({
        id: 'assets_first_snapshot',
        group: 'assets', urgency: 'low', icon: '📸',
        title: 'Take your first portfolio snapshot',
        body: 'Snapshots freeze your portfolio state at a point in time. Useful before any major change AND for year-over-year tracking.',
        module: 'assets', snoozable: true,
      });
      return out;
    }
    const last = snaps[snaps.length - 1];
    const age = Math.round((new Date() - new Date(last.taken_at)) / 86400000);
    if (age > 180) {
      out.push({
        id: 'assets_snapshot_' + last.id,
        group: 'assets', urgency: 'low', icon: '📸',
        title: 'Take a portfolio snapshot (last was ' + age + ' days ago)',
        body: 'Your last snapshot was ' + last.taken_at.slice(0, 10) + '. Snapshots are how you track year-over-year growth.',
        module: 'assets', snoozable: true,
      });
    }
    return out;
  }

  function genAssetsCloseDateApproaching() {
    const out = [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    for (const a of accts) {
      if (!a.close_date) continue;
      const days = daysUntil(a.close_date);
      if (days < 0 || days > 90) continue;
      const urgency = days <= 7 ? 'critical' : days <= 30 ? 'high' : 'medium';
      out.push({
        id: 'asset_close_' + a.id,
        group: 'assets', urgency, icon: '📅',
        title: (a.name || a.institution) + ' closes in ' + days + ' days',
        body: 'Account "' + (a.name || '(unnamed)') + '" has a close_date of ' + a.close_date +
              (a.transfer_to ? ' — funds transfer to ' + a.transfer_to : '') +
              '. Confirm bank instructions and that the transfer target is set up.',
        deadline: a.close_date, module: 'assets', snoozable: false,
      });
    }
    return out;
  }

  function genAssetsNoBeneficiary() {
    // Superseded by TB.assets.genBeneficiaryMissing (registered via
    // TB.assets.actionGenerators) which uses the same predicate logic
    // as the Beneficiary Review card on the Assets page. Kept as a
    // no-op stub for back-compat with any cached dismissed-action IDs
    // ("assets_no_beneficiary") so users don't see the same item under
    // a new ID and have to re-dismiss it.
    return [];
  }

  function genAssetsFxStale() {
    const out = [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    if (accts.length === 0) return out;
    const fetchedAt = TB.state.get('settings.fx.current_fetched_at');
    const liveRates = TB.state.get('settings.fx.current_rates') || {};
    if (!fetchedAt || Object.keys(liveRates).length === 0) {
      out.push({
        id: 'fx_never_fetched',
        group: 'assets', urgency: 'low', icon: '💱',
        title: 'Live FX rates not loaded yet',
        body: 'Currently using hardcoded fallback rates. Click Refresh in Assets to pull live rates from Treasury (free, no auth).',
        module: 'assets', snoozable: true,
      });
      return out;
    }
    const ageDays = Math.round((new Date() - new Date(fetchedAt)) / 86400000);
    if (ageDays > 120) {
      out.push({
        id: 'fx_stale',
        group: 'assets', urgency: 'low', icon: '💱',
        title: 'FX rates are ' + ageDays + ' days old',
        body: 'Treasury publishes quarterly. Refresh in Assets to get the latest rates for your projections.',
        module: 'assets', snoozable: true,
      });
    }
    return out;
  }

  // ---- Projections / tax generators ---------------------------------

  function genProjQuarterlyTax() {
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    // Only fire if user is in retirement (drawing) AND past current_age
    const today = new Date();
    const month = today.getUTCMonth() + 1; // 1-12
    const startYear = today.getUTCFullYear();
    const yearsIn = startYear - (TB.state.get('projections.startYear') || startYear);
    const ageNow = (inputs.current_age || 0) + Math.max(0, yearsIn);
    if (ageNow < (inputs.retire_age || 65)) return out;

    // Quarterly estimated tax months: Apr (Q1), Jun (Q2), Sep (Q3), Jan (Q4-prev).
    // Fire 30 days before each due date.
    const due = [
      { month: 4,  day: 15, label: 'Q1 estimated tax' },
      { month: 6,  day: 15, label: 'Q2 estimated tax' },
      { month: 9,  day: 15, label: 'Q3 estimated tax' },
      { month: 1,  day: 15, label: 'Q4 (prior year) estimated tax' },
    ];
    for (const d of due) {
      // Build the next due date
      let dueYear = startYear;
      if (d.month < month || (d.month === month && d.day < today.getUTCDate())) dueYear = startYear + 1;
      const iso = dueYear + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0');
      const days = daysUntil(iso);
      if (days < 0 || days > 35) continue;
      out.push({
        id: 'proj_qtax_' + dueYear + '_' + d.month,
        group: 'tax', urgency: days <= 7 ? 'high' : 'medium', icon: '🇺🇸',
        title: d.label + ' due ' + iso + ' (in ' + days + 'd)',
        body: 'US estimated tax payment for retirees. Amount = (annual US tax) ÷ 4. See your Projections breakdown for the year-total tax estimate.',
        deadline: iso, module: 'projections', snoozable: false,
      });
    }
    return out;
  }

  function genProjRothWindowJuminhyou() {
    const out = [];
    const sofaProfile = TB.state.get('sofa.profile') || {};
    if (!sofaProfile.juminhyou_target_date) return out;
    const days = daysUntil(sofaProfile.juminhyou_target_date);
    if (days < 0) return out; // already past
    if (days > 540) return out; // too far out, not actionable
    const urgency = days <= 90 ? 'critical' : days <= 180 ? 'high' : 'medium';
    out.push({
      id: 'sofa_juminhyou_window',
      group: 'sofa', urgency, icon: '🟢',
      title: 'Roth conversion window — ' + days + ' days until 住民票',
      body: 'You\'ve set 住民票 registration for ' + sofaProfile.juminhyou_target_date +
            '. Trad → Roth conversions BEFORE that date are US-taxed only. AFTER, Japan also taxes them as ordinary income at 20-45% national + 10% local. Plan your ladder in Projections → Tax Strategy.',
      deadline: sofaProfile.juminhyou_target_date,
      module: 'projections', snoozable: false,
    });
    return out;
  }

  function genProjSsClaimWindow() {
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    const age = inputs.current_age || 0;
    const ssAge = inputs.ss_start_age || 70;
    // Fire when within 2 years of selected SS start age (decision window)
    const yearsToSs = ssAge - age;
    if (yearsToSs < 0 || yearsToSs > 2) return out;
    out.push({
      id: 'proj_ss_decision',
      group: 'tax', urgency: 'medium', icon: '👴',
      title: 'Social Security claim decision window (age ' + ssAge + ' planned)',
      body: 'You\'re within 2 years of your planned SS start age. Compare scenarios at 62 (~70% benefit), 67 (FRA, 100%), and 70 (~124%) in Projections to confirm the optimal claim age for your situation.',
      module: 'projections', snoozable: true,
    });
    return out;
  }

  function genProjRmdYear() {
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    const age = inputs.current_age || 0;
    if (age < 70 || age > 73) return out;
    if (age >= 73) {
      out.push({
        id: 'proj_rmd_now',
        group: 'tax', urgency: 'critical', icon: '⏰',
        title: 'RMD year — Required Minimum Distribution due',
        body: 'Age 73+ requires annual RMDs from Traditional IRA / 401(k) / TSP. Failure = 25% federal excise tax. Confirm your custodian has calculated and set up the distribution.',
        module: 'projections', snoozable: false,
      });
    } else {
      out.push({
        id: 'proj_rmd_approaching',
        group: 'tax', urgency: 'medium', icon: '⏰',
        title: 'RMD age 73 in ' + (73 - age) + ' year(s)',
        body: 'Roth conversions in your low-income window before 73 reduce future RMDs (and the tax burden they create). Use the conversion ladder in Projections → Tax Strategy to plan.',
        module: 'projections', snoozable: true,
      });
    }
    return out;
  }

  function genProjCatchupTransitions() {
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    const age = inputs.current_age || 0;
    if (age === 49) {
      out.push({
        id: 'proj_catchup_50',
        group: 'tax', urgency: 'low', icon: '🎂',
        title: 'You qualify for 50+ catch-up contributions next year',
        body: 'Standard catch-up adds $7,500/yr to 401(k)/403(b)/TSP and $1,000/yr to IRA. Adjust your payroll deferral % at the new year.',
        module: 'projections', snoozable: true,
      });
    } else if (age === 59) {
      out.push({
        id: 'proj_catchup_60',
        group: 'tax', urgency: 'low', icon: '🎂',
        title: 'SECURE 2.0 enhanced catch-up at age 60-63 starts next year',
        body: 'Extra $11,250/yr to 401(k)/403(b)/TSP (vs the standard $7,500). Adjust your deferral % to capture the bigger window before it reverts to standard at 64.',
        module: 'projections', snoozable: true,
      });
    } else if (age === 63) {
      out.push({
        id: 'proj_catchup_64',
        group: 'tax', urgency: 'low', icon: '🎂',
        title: 'Enhanced catch-up reverts to standard $7,500 next year (age 64)',
        body: 'Last year of the SECURE 2.0 enhanced ($11,250) catch-up. Max it now while it\'s available.',
        module: 'projections', snoozable: true,
      });
    }
    return out;
  }

  // ---- SOFA generators ----------------------------------------------

  function genSofaPendingSteps() {
    const out = [];
    const steps = TB.state.get('sofa.steps') || [];
    const sofaProfile = TB.state.get('sofa.profile') || {};
    if (!sofaProfile.juminhyou_target_date) return out;
    const days = daysUntil(sofaProfile.juminhyou_target_date);
    if (days < 0 || days > 365) return out;
    const open = steps.filter((s) =>
      s.status !== 'executed' && s.status !== 'dismissed' &&
      (s.severity === 'critical' || s.severity === 'high')
    );
    if (open.length === 0) return out;
    out.push({
      id: 'sofa_open_critical_steps',
      group: 'sofa',
      urgency: days <= 60 ? 'high' : 'medium', icon: '📋',
      title: open.length + ' critical/high SOFA action' + (open.length > 1 ? 's' : '') + ' still open',
      body: 'You have ' + open.length + ' high-severity sequencer steps marked pending or planned, with 住民票 in ' + days + ' days. Review and execute in SOFA → Sequence.',
      module: 'sofa-roth', snoozable: false,
    });
    return out;
  }

  // ---- Profile generators -------------------------------------------

  function genProfileNoName() {
    const out = [];
    const profile = TB.state.get('profile') || {};
    if (profile.displayName && profile.displayName.trim()) return out;
    out.push({
      id: 'profile_no_name',
      group: 'profile', urgency: 'low', icon: '✏️',
      title: 'Set your name to personalize the dashboard',
      body: 'Re-run onboarding (link at the bottom-right of the dashboard) to add your name — it shows up in the dashboard title.',
      module: null, snoozable: true,
    });
    return out;
  }

  // ---- Master generator list ----------------------------------------

  const GENERATORS = [
    genFbarFilingDeadline,
    genFbarTreasuryStale,
    genAssetsStaleBalances,
    genAssetsSnapshotDue,
    genAssetsCloseDateApproaching,
    genAssetsNoBeneficiary,
    genAssetsFxStale,
    genProjQuarterlyTax,
    genProjRothWindowJuminhyou,
    genProjSsClaimWindow,
    genProjRmdYear,
    genProjCatchupTransitions,
    genSofaPendingSteps,
    genProfileNoName,
  ];

  // Combine the in-file GENERATORS with any externally-registered
  // generator arrays from other modules. Modules expose their
  // generators via TB.<module>.actionGenerators so each module owns
  // its own checks rather than action-center reaching into them.
  function allGenerators() {
    const out = GENERATORS.slice();
    if (TB.docVault && Array.isArray(TB.docVault.actionGenerators)) {
      out.push(...TB.docVault.actionGenerators);
    }
    if (TB.veteran && Array.isArray(TB.veteran.actionGenerators)) {
      out.push(...TB.veteran.actionGenerators);
    }
    if (TB.resident && Array.isArray(TB.resident.actionGenerators)) {
      out.push(...TB.resident.actionGenerators);
    }
    if (TB.taxCoord && Array.isArray(TB.taxCoord.actionGenerators)) {
      out.push(...TB.taxCoord.actionGenerators);
    }
    if (TB.family && Array.isArray(TB.family.actionGenerators)) {
      out.push(...TB.family.actionGenerators);
    }
    if (TB.estate && Array.isArray(TB.estate.actionGenerators)) {
      out.push(...TB.estate.actionGenerators);
    }
    if (TB.netWorth && Array.isArray(TB.netWorth.actionGenerators)) {
      out.push(...TB.netWorth.actionGenerators);
    }
    if (TB.healthcare && Array.isArray(TB.healthcare.actionGenerators)) {
      out.push(...TB.healthcare.actionGenerators);
    }
    if (TB.fxBanking && Array.isArray(TB.fxBanking.actionGenerators)) {
      out.push(...TB.fxBanking.actionGenerators);
    }
    if (TB.decumulation && Array.isArray(TB.decumulation.actionGenerators)) {
      out.push(...TB.decumulation.actionGenerators);
    }
    if (TB.property && Array.isArray(TB.property.actionGenerators)) {
      out.push(...TB.property.actionGenerators);
    }
    if (TB.consultations && Array.isArray(TB.consultations.actionGenerators)) {
      out.push(...TB.consultations.actionGenerators);
    }
    if (TB.assets && Array.isArray(TB.assets.actionGenerators)) {
      out.push(...TB.assets.actionGenerators);
    }
    if (TB.healthTracker && Array.isArray(TB.healthTracker.actionGenerators)) {
      out.push(...TB.healthTracker.actionGenerators);
    }
    if (TB.contacts && Array.isArray(TB.contacts.actionGenerators)) {
      out.push(...TB.contacts.actionGenerators);
    }
    if (TB.sharingBackup && Array.isArray(TB.sharingBackup.actionGenerators)) {
      out.push(...TB.sharingBackup.actionGenerators);
    }
    return out;
  }

  function deriveActions() {
    const dismissed = TB.state.get('action_center.dismissed') || {};
    const today = todayIso();
    const all = [];
    for (const g of allGenerators()) {
      try {
        const items = g() || [];
        for (const item of items) {
          // Filter out dismissed-and-snoozed items.
          const d = dismissed[item.id];
          if (d && d.until && d.until > today) continue;
          all.push(item);
        }
      } catch (err) {
        console.warn('[action-center] generator failed:', err);
      }
    }
    // Sort: urgency first, then deadline ascending (soonest first).
    all.sort((a, b) => {
      const ua = URGENCY_RANK[a.urgency] != null ? URGENCY_RANK[a.urgency] : 99;
      const ub = URGENCY_RANK[b.urgency] != null ? URGENCY_RANK[b.urgency] : 99;
      if (ua !== ub) return ua - ub;
      const da = daysUntil(a.deadline);
      const db = daysUntil(b.deadline);
      return da - db;
    });
    return all;
  }

  function dismissAction(actionId, daysFromNow) {
    daysFromNow = daysFromNow || 365; // default: snooze 1 year
    const dismissed = Object.assign({}, TB.state.get('action_center.dismissed') || {});
    const until = new Date();
    until.setDate(until.getDate() + daysFromNow);
    dismissed[actionId] = { until: until.toISOString().slice(0, 10) };
    TB.state.set('action_center.dismissed', dismissed);
  }

  function clearDismissals() {
    TB.state.set('action_center.dismissed', {});
  }

  // ====================================================================
  // Dashboard widget — top N actions, "View all" link to full module
  // ====================================================================

  function buildWidget() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const actions = deriveActions();
    if (actions.length === 0) {
      // Empty state — still need to give the user a way INTO the
      // module so they can use export/customize/snooze management
      // even when nothing is currently actionable.
      const card = el('div', {
        class: 'tb-card', 'data-track': 'core',
        style: { borderLeft: '4px solid var(--tb-success)' },
      });
      card.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--tb-sp-2)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
      },
        el('div', { style: { fontWeight: '600', color: 'var(--tb-success)' } },
          '✓ ' + t('action.widget.empty.title')),
        el('a', {
          href: '#',
          style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-navy)' },
          onclick: (e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'action-center' } }));
          },
        }, t('action.widget.open') + ' →'),
      ));
      card.appendChild(el('p', { class: 'tb-field-help', style: { margin: 0 } },
        t('action.widget.empty.body')));
      // Quick export shortcut so the calendar export is discoverable
      // even with an empty action list (still has document expiries,
      // family deadlines, RMD milestones, etc. in the source data).
      card.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-2)' } },
        el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            const count = exportToIcs();
            if (count != null) alert(t('action.export.success', { count }));
          },
        }, '📅 ' + t('action.export.button')),
      ));
      return card;
    }

    const TOP_N = 5;
    const top = actions.slice(0, TOP_N);
    const more = actions.length - top.length;

    const card = el('div', {
      class: 'tb-card', 'data-track': 'core',
      style: { borderLeft: '4px solid ' + URGENCY_COLOR[top[0].urgency] },
    });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--tb-sp-2)' } },
      el('h3', { style: { margin: 0 } },
        '🎯 ' + t('action.widget.title', { count: actions.length })),
      el('a', {
        href: '#',
        style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-navy)' },
        onclick: (e) => {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'action-center' } }));
        },
      }, t('action.widget.viewAll') + ' →'),
    ));

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-1)' } });
    for (const a of top) list.appendChild(buildActionRow(a, /* compact */ true));
    card.appendChild(list);
    if (more > 0) {
      card.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
      }, t('action.widget.more', { count: more })));
    }
    return card;
  }

  // ====================================================================
  // Full module — grouped by urgency
  // ====================================================================

  function render(container) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    container.innerHTML = '';

    container.appendChild(el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h1', null, '🎯 ' + t('action.title')),
      el('p', { class: 'tb-card-meta' }, t('action.subtitle')),
      el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            const count = exportToIcs();
            if (count != null) {
              alert(t('action.export.success', { count }));
            }
          },
        }, '📅 ' + t('action.export.button')),
        el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            if (confirm(t('action.clearDismissed.confirm'))) {
              clearDismissals();
              render(container);
            }
          },
        }, t('action.clearDismissed.button')),
      ),
      el('p', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('action.export.help')),
    ));

    const actions = deriveActions();
    if (actions.length === 0) {
      container.appendChild(el('div', { class: 'tb-card', 'data-track': 'core',
        style: { borderLeft: '4px solid var(--tb-success)' } },
        el('h3', { style: { color: 'var(--tb-success)', marginTop: 0 } }, '✓ ' + t('action.empty.title')),
        el('p', null, t('action.empty.body')),
      ));
      return;
    }

    // Group by urgency
    const byUrgency = {};
    for (const a of actions) {
      (byUrgency[a.urgency] = byUrgency[a.urgency] || []).push(a);
    }
    const order = ['critical', 'high', 'medium', 'low', 'info'];
    for (const u of order) {
      if (!byUrgency[u]) continue;
      const card = el('div', { class: 'tb-card', 'data-track': 'core' });
      card.appendChild(el('h3', {
        style: { marginTop: 0, color: URGENCY_COLOR[u] },
      }, URGENCY_LABEL[u] + ' · ' + byUrgency[u].length));
      for (const a of byUrgency[u]) {
        card.appendChild(buildActionRow(a, /* compact */ false));
      }
      container.appendChild(card);
    }
  }

  function buildActionRow(action, compact) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const color = URGENCY_COLOR[action.urgency] || 'var(--tb-text-soft)';
    // Dashboard-widget rows (compact) become clickable when the action
    // points at a module — saves the user the "View all → click" round
    // trip. Full-module rows already have an explicit "Open module"
    // button so they don't need the wrapping click handler.
    const isClickable = compact && !!action.module;
    const wrap = el('div', {
      style: {
        borderLeft: '3px solid ' + color,
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        marginBottom: compact ? 0 : 'var(--tb-sp-2)',
        background: compact ? 'var(--tb-bg)' : 'var(--tb-bg-elev)',
        borderRadius: 'var(--tb-radius-1)',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'background 0.12s ease',
      },
      title: isClickable
        ? t('action.row.clickHint', { module: t('nav.' + action.module) || action.module })
        : null,
      onmouseover: isClickable ? (e) => { e.currentTarget.style.background = 'var(--tb-bg-elev)'; } : null,
      onmouseout:  isClickable ? (e) => { e.currentTarget.style.background = 'var(--tb-bg)'; } : null,
      onclick: isClickable
        ? () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: action.module } }))
        : null,
    });

    const titleRow = el('div', { style: { display: 'flex', alignItems: 'baseline', gap: 'var(--tb-sp-2)' } },
      el('span', { style: { fontSize: compact ? '14px' : '16px' } }, action.icon || '•'),
      el('span', { style: { fontWeight: '600', flex: '1' } }, action.title),
      action.deadline ? el('span', {
        style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', fontFamily: 'var(--tb-font-mono)' },
        title: action.deadline,
      }, action.deadline) : null,
      isClickable ? el('span', {
        style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
      }, '→') : null,
    );
    wrap.appendChild(titleRow);

    if (!compact) {
      wrap.appendChild(el('p', { style: { margin: '4px 0 var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)', lineHeight: '1.5' } },
        action.body));

      const btnRow = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } });
      if (action.module) {
        btnRow.appendChild(el('button', {
          class: 'tb-btn', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: action.module } })),
        }, t('action.row.openModule', { module: t('nav.' + action.module) || action.module }) + ' →'));
      }
      if (action.snoozable !== false) {
        btnRow.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            dismissAction(action.id, 365);
            render(document.getElementById('tb-view'));
          },
        }, t('action.row.snooze')));
      }
      wrap.appendChild(btnRow);
    }
    return wrap;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'Action Center',
    label_jp: 'アクション・センター',
    render,
  };

  // ====================================================================
  // iCal export — turns every date-bearing item into a downloadable
  // .ics file the user can import into Google / Apple / Outlook
  // calendars. Source data: Action Center deadlines + key state
  // dates (passport expiries, 国籍選択 deadlines, RMD age, etc.)
  // that don't necessarily appear in the action list.
  // ====================================================================

  function escapeIcs(str) {
    return String(str || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }
  function icsDate(iso) {
    // YYYY-MM-DD → YYYYMMDD (DTSTART;VALUE=DATE format)
    return iso.slice(0, 10).replace(/-/g, '');
  }
  function icsTimestamp() {
    // YYYYMMDDTHHMMSSZ for DTSTAMP
    const d = new Date();
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  // Builds the full set of dated events for the .ics file. Sources:
  //   1. Every Action Center generator with `deadline` field
  //   2. Document Vault items with expiry_date
  //   3. Family.members passport expiries + 国籍選択 deadlines
  //   4. Estate / Resident derived dates (10y clock, PR eligibility)
  //   5. Decumulation milestones (SS 62/67/70, RMD 73)
  function collectCalendarEvents() {
    const events = [];

    // 1. Action Center deadlines
    try {
      const actions = deriveActions();
      actions.forEach((a) => {
        if (!a.deadline) return;
        events.push({
          uid: 'tb-action-' + a.id,
          date: a.deadline,
          summary: a.title,
          description: a.body || '',
          category: 'Action',
        });
      });
    } catch (err) { console.warn('[ics] action collection failed:', err); }

    // 2. Document Vault expiries
    try {
      const items = TB.state.get('documentVault.items') || [];
      items.forEach((it) => {
        if (!it.expiry_date) return;
        events.push({
          uid: 'tb-vault-' + it.id,
          date: it.expiry_date,
          summary: 'Expires: ' + (it.title || it.type),
          description: 'Document Vault item' + (it.notes ? ': ' + it.notes : ''),
          category: 'Document',
        });
      });
    } catch (err) { /* swallow */ }

    // 3. Family — passports + nationality choice
    try {
      const members = TB.state.get('family.members') || [];
      members.forEach((m) => {
        const name = m.name_en || m.name_jp || 'family member';
        ['passport_us', 'passport_jp'].forEach((k) => {
          const pp = m[k];
          if (!pp || !pp.expires) return;
          events.push({
            uid: 'tb-pp-' + m.id + '-' + k,
            date: pp.expires,
            summary: 'Passport expires: ' + name + ' (' + (k === 'passport_us' ? 'US' : 'JP') + ')',
            description: 'Renew passport — file 9-12 months before expiry to avoid travel disruption.',
            category: 'Passport',
          });
        });
        // 国籍選択 for dual citizens — 20th birthday (acquired before 18)
        if (m.relationship === 'child' && m.birth_date) {
          const cit = m.citizenships || [];
          if (cit.indexOf('US') !== -1 && cit.indexOf('JP') !== -1) {
            const b = new Date(m.birth_date + 'T00:00:00');
            // Dual-from-birth (acquired before 18) → choose by age 20 under
            // the post-2022 Nationality Act Art. 14. (Was +22 pre-2022.)
            b.setFullYear(b.getFullYear() + 20);
            const dateStr = b.toISOString().slice(0, 10);
            events.push({
              uid: 'tb-natchoice-' + m.id,
              date: dateStr,
              summary: '国籍選択 by age 20: ' + name,
              description: 'Japanese Nationality Act Art. 14 — date by which a dual-from-birth national is asked to choose a nationality. This is a non-penalized "duty of effort": missing it carries no automatic loss, and the Ministry\'s formal demand (催告) has never been issued to anyone. Filing 国籍選択届 selecting Japanese does not renounce US citizenship. Confirm the formal record via 戸籍謄本 (法務局 / 行政書士 can verify).',
              category: 'Family',
            });
          }
        }
      });
    } catch (err) { /* swallow */ }

    // 4. Resident — 10-year clock
    try {
      if (TB.resident && typeof TB.resident.tenYearClock === 'function') {
        const clock = TB.resident.tenYearClock();
        if (clock && clock.date && clock.days >= 0) {
          events.push({
            uid: 'tb-tenyear-clock',
            date: clock.date,
            summary: '10-year worldwide-asset clock (永住者 status begins)',
            description: 'JP estate tax expands from JP-situs only to WORLDWIDE assets. Plan inheritance mitigation BEFORE this date.',
            category: 'Estate',
          });
        }
      }
      if (TB.resident && typeof TB.resident.prEligibilityDate === 'function') {
        const elig = TB.resident.prEligibilityDate();
        if (elig && elig.date && elig.days > 0) {
          events.push({
            uid: 'tb-pr-eligibility',
            date: elig.date,
            summary: '永住権 (PR) eligibility date',
            description: 'Based on your visa + arrival date, you become eligible to apply for Japanese Permanent Residency on this date.',
            category: 'Immigration',
          });
        }
      }
    } catch (err) { /* swallow */ }

    // 5. Decumulation milestones — SS claim ages + RMD age
    try {
      const age = TB.state.get('projections.inputs.current_age');
      if (typeof age === 'number') {
        // We have age but not birthday; approximate using current month as a placeholder
        const yearsTo = (target) => target - age;
        [
          { target: 62, key: 'ss62', summary: 'Social Security earliest claim age (62)',
            desc: 'Earliest you can claim US SS, with ~30% reduction below FRA. Trade-off: more years of payments but smaller monthly check.' },
          { target: 65, key: 'medicare65', summary: 'Medicare eligibility (65) + IEP opens',
            desc: 'Initial Enrollment Period: 3 months before, the birthday month, and 3 months after. Late enrollment penalty for life if missed.' },
          { target: 67, key: 'ss_fra', summary: 'Full Retirement Age for Social Security (67)',
            desc: 'No early-claim reduction. Each year of further delay adds ~8% to monthly benefit until age 70.' },
          { target: 70, key: 'ss70', summary: 'Maximum SS benefit age (70)',
            desc: 'No further increase past 70. Claim by this date or lose the additional credits.' },
          { target: 73, key: 'rmd73', summary: 'RMD begins (73) — required minimum distributions',
            desc: 'Required Minimum Distributions from pre-tax accounts begin the year you turn 73. Penalty for missing: 25% of shortfall.' },
        ].forEach((m) => {
          const yrsAway = yearsTo(m.target);
          if (yrsAway < 0 || yrsAway > 30) return;
          // Place the event approximately in the right year — we don't
          // have birthday, so use this year + yrsAway as a rough date.
          const targetYear = new Date().getFullYear() + Math.max(0, yrsAway);
          const dateStr = targetYear + '-01-15';  // arbitrary mid-January
          events.push({
            uid: 'tb-decum-' + m.key,
            date: dateStr,
            summary: m.summary,
            description: m.desc + ' (Approximate — based on current_age=' + age + ' from Projections inputs.)',
            category: 'Retirement',
          });
        });
      }
    } catch (err) { /* swallow */ }

    return events;
  }

  // Builds the .ics text body. RFC 5545 compliant; line-folded.
  function buildIcsString(events) {
    const lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//Taigan Bridge//Tax Calendar//EN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    lines.push('X-WR-CALNAME:Taigan Bridge — Tax & Compliance Calendar');
    lines.push('X-WR-CALDESC:Auto-generated deadlines from Taigan Bridge state. Re-export anytime your data changes.');
    lines.push('X-WR-TIMEZONE:Asia/Tokyo');
    const stamp = icsTimestamp();
    events.forEach((ev) => {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + ev.uid + '@taigan-bridge.local');
      lines.push('DTSTAMP:' + stamp);
      lines.push('DTSTART;VALUE=DATE:' + icsDate(ev.date));
      lines.push('SUMMARY:' + escapeIcs(ev.summary));
      if (ev.description) lines.push('DESCRIPTION:' + escapeIcs(ev.description));
      if (ev.category) lines.push('CATEGORIES:' + escapeIcs(ev.category));
      // 1-day all-day event (DTEND = DTSTART + 1 day)
      const next = new Date(ev.date + 'T00:00:00');
      next.setDate(next.getDate() + 1);
      lines.push('DTEND;VALUE=DATE:' + icsDate(next.toISOString().slice(0, 10)));
      // Add a 7-day-before reminder by default
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + escapeIcs(ev.summary));
      lines.push('TRIGGER:-P7D');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  // Public — generates + downloads a .ics file with all collected events.
  function exportToIcs() {
    const events = collectCalendarEvents();
    if (events.length === 0) {
      alert('No dated events found. Add some state (action items, document expiries, family members) first.');
      return null;
    }
    const ics = buildIcsString(events);
    const today = new Date().toISOString().slice(0, 10);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'taigan-bridge-calendar-' + today + '.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return events.length;
  }

  window.TB.actionCenter = {
    deriveActions,
    buildWidget,
    dismissAction,
    clearDismissals,
    // Calendar export — used by the "📅 Export to calendar (.ics)"
    // button in the Action Center main view.
    collectCalendarEvents,
    buildIcsString,
    exportToIcs,
  };
})();
