/* Taigan Bridge — modules/net-worth.js
 *
 * Net Worth & Reports — the temporal layer over Assets.
 *
 * The tool already shows the FUTURE (Projections) and the PRESENT
 * (every other module). This module gives users a sense of the PAST:
 *
 *   1. Snapshot history — frozen-in-time copies of all asset balances,
 *      stored in assets.snapshots[]. Created manually OR auto-triggered
 *      (post-FBAR upload, year-end reminder).
 *
 *   2. Net worth chart — vanilla SVG line chart over time, with
 *      USD/JPY toggle. Historical JPY values use the FX rate captured
 *      at snapshot time (more meaningful than re-converting at current
 *      rate).
 *
 *   3. Year-over-year comparison — table showing growth/decline by
 *      period, allocation drift, savings-rate proxy.
 *
 *   4. Annual review wizard — guided 7-step flow asking "anything
 *      change?" through each module. Logs the review.
 *
 *   5. Annual report generator — Markdown export bundling tax package
 *      summary + asset summary + survivor binder + LoI + projection
 *      state into one shareable document. Extends the Letter-of-
 *      Instruction pattern.
 *
 * State lives in net_worth.preferences / .reviews / .annual_reports.
 * Snapshots themselves live in assets.snapshots[] (canonical source).
 */

(function () {
  'use strict';

  const id = 'net-worth';

  // ====================================================================
  // i18n — wizard step-result strings + Action Center generator strings
  //
  // These get PERSISTED (wizard results are saved verbatim into
  // net_worth.reviews[].steps[].result) or shown as Action Center
  // items, so they must go through TB.i18n.t() rather than staying as
  // hardcoded English literals. Registered here via TB.i18n.extend()
  // so this module can self-contain its own translation table instead
  // of touching the shared i18n.js dictionary.
  // ====================================================================

  TB.i18n.extend('en', {
    'nw.wizard.fx.treasury_years':      'Treasury: {{years}}y',
    'nw.wizard.fx.treasury_failed':     'Treasury: failed',
    'nw.wizard.fx.current_ok':          'Current: ✓',
    'nw.wizard.fx.current_failed':      'Current: failed',
    'nw.wizard.fx.nothing_to_refresh':  'Nothing to refresh',

    'nw.wizard.snapshot.noAssets':      'No assets to snapshot — add accounts first',
    'nw.wizard.snapshot.saved':         'Snapshot saved · {{amount}}',

    'nw.wizard.balances.noActive':      'No active accounts',
    'nw.wizard.balances.allFresh':      'All {{count}} balances are fresh (<90d)',
    'nw.wizard.balances.someStale':     '{{stale}} of {{total}} accounts have stale balances — open Assets to update',

    'nw.wizard.pfic.noAccounts':        'No accounts to scan',
    'nw.wizard.pfic.noFlags':           '✓ No PFIC flags',
    'nw.wizard.pfic.flagged':           '⚠ {{count}} flag(s): {{names}}{{more}}',

    'nw.wizard.fbar.required':          '⚠ FBAR REQUIRED — aggregate {{amount}}{{suffix}}',
    'nw.wizard.fbar.incomplete':        '○ Aggregate {{amount}}{{suffix}} — some year-max balances missing; verdict incomplete',
    'nw.wizard.fbar.belowThreshold':    '✓ Below threshold — {{amount}} / $10,000{{suffix}}',
    'nw.wizard.fbar.assetsUnavailable': 'Assets module not available',
    'nw.wizard.fbar.roughEstimate':     '○ ~{{amount}} rough estimate from current balances — enter year-max balances in the FBAR tracker for the real test (aggregate of each account\'s year-max at the Treasury year-end rate vs $10,000)',
    'nw.wizard.fbar.suffix.withYear':   ' ({{year}} year-max, Treasury rate)',
    'nw.wizard.fbar.suffix.noYear':     ' (year-max, Treasury rate)',

    'nw.wizard.family.noMembers':       'No family members tracked yet',
    'nw.wizard.family.noExpiring':      '✓ {{count}} members tracked, no passport expiries in next 12mo',
    'nw.wizard.family.expiring':        '⚠ {{count}} passport(s) expire <12mo: {{names}}',

    'nw.wizard.healthcare.noDob':       'Add date of birth to enable Medicare IEP detection',
    'nw.wizard.healthcare.ready':       'Healthcare module ready — open to review premiums',
    'nw.wizard.healthcare.iepOpensSoon':'🩺 Medicare IEP opens in ~{{months}} months — start gathering paperwork now',
    'nw.wizard.healthcare.iepWindow':   '⚠ Medicare IEP window — enroll before age 65 + 3 months',

    'nw.wizard.report.downloaded':      '✓ Year-end report downloaded',
    'nw.wizard.report.failed':          'Report generation failed: {{error}}',

    'nw.gen.snapshotFirst.title':       'Take your first net worth snapshot',
    'nw.gen.snapshotFirst.body':        'You have {{count}} accounts in your Asset tracker but no net-worth snapshots yet. A snapshot freezes today\'s totals so you can chart growth over time.',
    'nw.gen.snapshotStale.title':       'Net-worth snapshot is {{days}} days old',
    'nw.gen.snapshotStale.body':        'Take a fresh snapshot to capture current balances. Snapshots are how the chart shows growth over time.',

    'nw.gen.reviewFirst.title.window':  'Run your first year-end checkup',
    'nw.gen.reviewFirst.title.normal':  'Try the year-end checkup wizard',
    'nw.gen.reviewFirst.body':          'A 12-step guided flow that refreshes FX rates, takes a net-worth snapshot, runs the PFIC scanner, checks FBAR threshold, and generates a year-end report — all inline. ~15 minutes.',
    'nw.gen.reviewDueWindow.title':     'Year-end checkup due — last run {{days}} days ago',
    'nw.gen.reviewDueWindow.body':      'Year-end is the right moment for FBAR aggregation, snapshot capture, and CPA-prep doc gathering. Run the wizard before Dec 31 to lock in your annual record.',
    'nw.gen.reviewOverdue.title':       'Year-end checkup overdue (last: {{years}}y ago)',
    'nw.gen.reviewOverdue.body':        'Run the year-end checkup wizard to refresh FX, snapshot net worth, scan for PFIC drift, and confirm FBAR threshold status.',

    'nw.gen.reportNotGenerated.title':  'Year-end report for {{year}} not yet generated',
    'nw.gen.reportNotGenerated.body':   'Generate the year-end annual report to bundle tax package + asset summary + estate state into one Markdown document. Useful for CPA review, year-end archive, or sharing with spouse.',
  });

  TB.i18n.extend('ja', {
    'nw.wizard.fx.treasury_years':      '財務省レート: {{years}}年分',
    'nw.wizard.fx.treasury_failed':     '財務省レート: 失敗',
    'nw.wizard.fx.current_ok':          '現在レート: ✓',
    'nw.wizard.fx.current_failed':      '現在レート: 失敗',
    'nw.wizard.fx.nothing_to_refresh':  '更新対象なし',

    'nw.wizard.snapshot.noAssets':      'スナップショット対象の資産がありません — 先に口座を追加してください',
    'nw.wizard.snapshot.saved':         'スナップショット保存済み · {{amount}}',

    'nw.wizard.balances.noActive':      'アクティブな口座がありません',
    'nw.wizard.balances.allFresh':      '{{count}} 件すべての残高が最新です(90日以内)',
    'nw.wizard.balances.someStale':     '{{total}} 件中 {{stale}} 件の口座残高が古くなっています — Assets を開いて更新してください',

    'nw.wizard.pfic.noAccounts':        'スキャン対象の口座がありません',
    'nw.wizard.pfic.noFlags':           '✓ PFIC の該当なし',
    'nw.wizard.pfic.flagged':           '⚠ {{count}} 件該当: {{names}}{{more}}',

    'nw.wizard.fbar.required':          '⚠ FBAR 提出が必要 — 合計 {{amount}}{{suffix}}',
    'nw.wizard.fbar.incomplete':        '○ 合計 {{amount}}{{suffix}} — 一部の年間最高残高が未入力のため判定不完全',
    'nw.wizard.fbar.belowThreshold':    '✓ 基準額未満 — {{amount}} / $10,000{{suffix}}',
    'nw.wizard.fbar.assetsUnavailable': 'Assets モジュールが利用できません',
    'nw.wizard.fbar.roughEstimate':     '○ ~{{amount}}(現在残高からの概算) — 正式な判定には FBAR トラッカーで各口座の年間最高残高(財務省年末レート、$10,000 基準)を入力してください',
    'nw.wizard.fbar.suffix.withYear':   '({{year}} 年間最高残高、財務省レート)',
    'nw.wizard.fbar.suffix.noYear':     '(年間最高残高、財務省レート)',

    'nw.wizard.family.noMembers':       'まだ家族が登録されていません',
    'nw.wizard.family.noExpiring':      '✓ {{count}} 名を管理中、今後12ヶ月以内の パスポート期限切れはありません',
    'nw.wizard.family.expiring':        '⚠ {{count}} 件のパスポートが12ヶ月以内に期限切れ: {{names}}',

    'nw.wizard.healthcare.noDob':       '生年月日を登録すると Medicare IEP を検出できます',
    'nw.wizard.healthcare.ready':       'Healthcare モジュール準備完了 — 開いて保険料を確認してください',
    'nw.wizard.healthcare.iepOpensSoon':'🩺 Medicare IEP は約 {{months}} ヶ月後に開始 — 今から書類準備を',
    'nw.wizard.healthcare.iepWindow':   '⚠ Medicare IEP 期間中 — 65歳+3ヶ月までに登録してください',

    'nw.wizard.report.downloaded':      '✓ 年末レポートをダウンロードしました',
    'nw.wizard.report.failed':          'レポート生成に失敗しました: {{error}}',

    'nw.gen.snapshotFirst.title':       '最初の純資産スナップショットを取得',
    'nw.gen.snapshotFirst.body':        'Asset トラッカーに {{count}} 件の口座がありますが、純資産スナップショットはまだありません。スナップショットで本日時点の合計を記録すると、推移をグラフ化できます。',
    'nw.gen.snapshotStale.title':       '純資産スナップショットが {{days}} 日前のものです',
    'nw.gen.snapshotStale.body':        '最新の残高を反映したスナップショットを取得してください。グラフの推移表示はスナップショットに基づきます。',

    'nw.gen.reviewFirst.title.window':  '初めての年末チェックアップを実行',
    'nw.gen.reviewFirst.title.normal':  '年末チェックアップ・ウィザードを試す',
    'nw.gen.reviewFirst.body':          'FX レート更新・純資産スナップショット・PFIC スキャン・FBAR 基準チェック・年末レポート生成をその場で行う 12 ステップガイド。所要約15分。',
    'nw.gen.reviewDueWindow.title':     '年末チェックアップ推奨 — 前回から {{days}} 日経過',
    'nw.gen.reviewDueWindow.body':      '年末は FBAR 集計・スナップショット取得・CPA 提出書類準備に最適なタイミングです。12月31日までにウィザードを実行し、年次記録を確定してください。',
    'nw.gen.reviewOverdue.title':       '年末チェックアップ期限超過(前回: 約{{years}}年前)',
    'nw.gen.reviewOverdue.body':        '年末チェックアップ・ウィザードを実行し、FX 更新・純資産スナップショット・PFIC ドリフトのスキャン・FBAR 基準状況の確認を行ってください。',

    'nw.gen.reportNotGenerated.title':  '{{year}} 年の年末レポートが未生成です',
    'nw.gen.reportNotGenerated.body':   '年末レポートを生成し、税務パッケージ・資産サマリー・相続状況を1つの Markdown 文書にまとめてください。CPA レビュー・年末アーカイブ・配偶者との共有に便利です。',
  });

  // ====================================================================
  // State accessors
  // ====================================================================

  function getNw()       { return TB.state.get('net_worth') || {}; }
  function getPrefs()    { return getNw().preferences || {}; }
  function getReviews()  { return getNw().reviews || []; }
  function getReports()  { return getNw().annual_reports || []; }

  function setPrefs(value) {
    const nw = getNw();
    nw.preferences = value;
    TB.state.set('net_worth', nw);
  }
  function setReviews(arr) {
    const nw = getNw();
    nw.reviews = arr;
    TB.state.set('net_worth', nw);
  }
  function setReports(arr) {
    const nw = getNw();
    nw.annual_reports = arr;
    TB.state.set('net_worth', nw);
  }

  function getSnapshots() {
    return TB.state.get('assets.snapshots') || [];
  }

  // ====================================================================
  // Snapshot helpers (delegated to Assets module)
  // ====================================================================

  function takeSnapshot(label) {
    if (!TB.assets || typeof TB.assets.takeSnapshot !== 'function') return null;
    return TB.assets.takeSnapshot(label);
  }
  function deleteSnapshot(snapshotId) {
    if (!TB.assets || typeof TB.assets.deleteSnapshot !== 'function') return;
    TB.assets.deleteSnapshot(snapshotId);
  }

  // Snapshot value in the user's chosen currency. For older snapshots
  // that pre-date our total_jpy capture, fall back to converting
  // total_usd at the current FX rate (less accurate but better than
  // missing data).
  function snapshotValue(snap, currency) {
    if (currency === 'jpy') {
      if (snap.total_jpy != null) return snap.total_jpy;
      if (snap.total_usd != null && TB.assets && typeof TB.assets.toUsd === 'function') {
        const oneUsdInJpy = 1 / TB.assets.toUsd(1, 'JPY');
        return snap.total_usd * oneUsdInJpy;
      }
    }
    return snap.total_usd || 0;
  }

  function fmtCurrency(value, currency) {
    if (currency === 'jpy') {
      return '¥' + Math.round(value || 0).toLocaleString();
    }
    return '$' + Math.round(value || 0).toLocaleString();
  }

  // Filter snapshots to the chosen time range.
  function filterByRange(snaps, range) {
    if (!range || range === 'all') return snaps.slice();
    const yearMap = { '1y': 1, '5y': 5, '10y': 10 };
    const yrs = yearMap[range];
    if (!yrs) return snaps.slice();
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - yrs);
    return snaps.filter((s) => new Date(s.taken_at) >= cutoff);
  }

  // ====================================================================
  // Auto-snapshot triggers (called by other modules)
  // ====================================================================

  // Returns days since the most recent snapshot, or null if none.
  function daysSinceLastSnapshot() {
    const snaps = getSnapshots();
    if (snaps.length === 0) return null;
    const latest = snaps.reduce((m, s) =>
      Math.max(m, new Date(s.taken_at).getTime()), 0);
    return Math.floor((Date.now() - latest) / 86400000);
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  function hasSnapshots() { return getSnapshots().length > 0; }
  function hasMultipleSnapshots() { return getSnapshots().length >= 2; }

  const SECTIONS = [
    { id: 'header',    always: true, builder: () => buildHeaderCard() },
    { id: 'snapshot',  always: true, builder: () => buildSnapshotCard() },
    {
      id: 'chart',
      label_en: 'Net worth chart',
      label_jp: '純資産推移グラフ',
      description_en: 'Line chart of total net worth over time. Requires ≥2 snapshots.',
      description_jp: '純資産の推移を線グラフで表示。スナップショット 2 件以上が必要。',
      auto_show: hasMultipleSnapshots,
      builder: () => buildChartCard(),
    },
    {
      id: 'yoy',
      label_en: 'Year-over-year comparison',
      label_jp: '年次比較',
      description_en: 'Period-on-period growth, allocation drift, savings rate proxy.',
      description_jp: '期間別成長率・配分のドリフト・貯蓄率の概算。',
      auto_show: hasMultipleSnapshots,
      builder: () => buildYoYCard(),
    },
    {
      id: 'history_list',
      label_en: 'Snapshot history (full list)',
      label_jp: 'スナップショット履歴',
      description_en: 'All snapshots with delete button.',
      description_jp: 'すべてのスナップショットと削除ボタン。',
      auto_show: hasSnapshots,
      builder: () => buildHistoryListCard(),
    },
    {
      id: 'annual_review',
      label_en: 'Year-end checkup wizard',
      label_jp: '年末チェックアップ・ウィザード',
      description_en: '12-step guided flow that performs FX refresh, snapshot, PFIC scan, FBAR threshold check, and generates a year-end report.',
      description_jp: 'FX 更新・スナップショット・PFIC スキャン・FBAR 基準チェックを実行し、年末レポートを生成する 12 ステップガイド。',
      auto_show: () => true,
      builder: () => buildAnnualReviewCard(),
    },
    {
      id: 'annual_report',
      label_en: 'Annual report exporter',
      label_jp: '年次レポート出力',
      description_en: 'Markdown export bundling tax package + asset summary + estate state.',
      description_jp: '税務パッケージ・資産サマリー・相続状況を統合した Markdown 出力。',
      auto_show: () => true,
      builder: () => buildReportExportCard(),
    },
    {
      id: 'preferences',
      label_en: 'Preferences',
      label_jp: '設定',
      description_en: 'Chart currency, default time range, auto-snapshot triggers.',
      description_jp: 'グラフ通貨・既定期間・自動スナップショット発動条件。',
      auto_show: () => true,
      builder: () => buildPreferencesCard(),
    },
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
    return el('div', { class: 'tb-card', 'data-track': 'history' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'history' },
          t('nw.badge')),
      ),
      el('h1', null, '📈 ' + t('nw.title')),
      el('p', { class: 'tb-card-meta' }, t('nw.subtitle')),
    );
  }

  // ─── Snapshot card (take snapshot + latest summary) ───────────────

  function buildSnapshotCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const snaps = getSnapshots();
    const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
    const days = daysSinceLastSnapshot();
    const prefs = getPrefs();
    const currency = prefs.chart_currency || 'usd';

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '📸 ' + t('nw.section.snapshot')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openSnapshotModal() }, '＋ ' + t('nw.snapshot.take_now')),
    ));

    if (!latest) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('nw.snapshot.empty')));
      return card;
    }

    // Latest snapshot summary
    const tiles = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)' },
    });
    function tile(label, value, hint, color) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
          borderTop: '3px solid ' + (color || 'var(--tb-track-history)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' } }, value),
        hint ? el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' } }, hint) : null,
      );
    }

    const latestVal = snapshotValue(latest, currency);
    tiles.appendChild(tile(
      t('nw.snapshot.latest_value'),
      fmtCurrency(latestVal, currency),
      latest.taken_at.slice(0, 10),
    ));

    // Previous snapshot delta
    if (snaps.length >= 2) {
      const prev = snaps[snaps.length - 2];
      const prevVal = snapshotValue(prev, currency);
      const delta = latestVal - prevVal;
      const pct = prevVal !== 0 ? (delta / prevVal) * 100 : 0;
      tiles.appendChild(tile(
        t('nw.snapshot.delta_from_prev'),
        (delta >= 0 ? '+' : '') + fmtCurrency(delta, currency),
        pct.toFixed(1) + '% · vs ' + prev.taken_at.slice(0, 10),
        delta >= 0 ? 'var(--tb-success)' : 'var(--tb-error)',
      ));
    }

    // Days since
    if (days != null) {
      const staleColor = days > 365 ? 'var(--tb-error)'
                       : days > 180 ? 'var(--tb-warn)'
                       : 'var(--tb-success)';
      tiles.appendChild(tile(
        t('nw.snapshot.days_since'),
        days + 'd',
        days > 90 ? t('nw.snapshot.consider_new') : null,
        staleColor,
      ));
    }

    // Snapshot count
    tiles.appendChild(tile(
      t('nw.snapshot.total_count'),
      String(snaps.length),
      snaps.length === 1 ? t('nw.snapshot.need_more_for_chart') : null,
    ));

    card.appendChild(tiles);
    return card;
  }

  function openSnapshotModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    let label = TB.utils.todayIso();

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('nw.snapshot.modal_title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('nw.snapshot.modal_help')));

    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('nw.snapshot.label')),
      el('input', { type: 'text', class: 'tb-input', value: label,
        oninput: (e) => { label = e.target.value; } }),
      el('div', { class: 'tb-field-help' }, t('nw.snapshot.label_help')),
    ));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('nw.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { takeSnapshot(label.trim() || undefined); close(); rerender(); } },
      '📸 ' + t('nw.snapshot.take')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Net worth chart ──────────────────────────────────────────────

  function buildChartCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const prefs = getPrefs();
    const currency = prefs.chart_currency || 'usd';
    const range = prefs.chart_range || 'all';

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });

    // Header + currency / range toggles
    const header = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } });
    header.appendChild(el('h2', { style: { margin: 0 } }, '📊 ' + t('nw.section.chart')));
    const controls = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    controls.appendChild(el('select', {
      class: 'tb-select',
      style: { fontSize: 'var(--tb-fs-12)', padding: '4px 8px' },
      onchange: (e) => {
        const p = Object.assign({}, prefs);
        p.chart_currency = e.target.value;
        setPrefs(p);
        rerender();
      },
    },
      el('option', { value: 'usd', selected: currency === 'usd' }, 'USD'),
      el('option', { value: 'jpy', selected: currency === 'jpy' }, 'JPY'),
    ));
    controls.appendChild(el('select', {
      class: 'tb-select',
      style: { fontSize: 'var(--tb-fs-12)', padding: '4px 8px' },
      onchange: (e) => {
        const p = Object.assign({}, prefs);
        p.chart_range = e.target.value;
        setPrefs(p);
        rerender();
      },
    },
      el('option', { value: 'all', selected: range === 'all' }, t('nw.chart.range.all')),
      el('option', { value: '1y',  selected: range === '1y' },  '1y'),
      el('option', { value: '5y',  selected: range === '5y' },  '5y'),
      el('option', { value: '10y', selected: range === '10y' }, '10y'),
    ));
    header.appendChild(controls);
    card.appendChild(header);

    // Chart
    const snaps = filterByRange(getSnapshots(), range)
      .slice()
      .sort((a, b) => new Date(a.taken_at) - new Date(b.taken_at));
    if (snaps.length < 2) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('nw.chart.need_more')));
      return card;
    }
    card.appendChild(renderChart(snaps, currency));

    return card;
  }

  // SVG line chart. Width fills container; height fixed.
  function renderChart(snaps, currency) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const W = 760, H = 300;
    const PAD_L = 70, PAD_R = 20, PAD_T = 20, PAD_B = 50;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;

    const points = snaps.map((s) => ({
      ts: new Date(s.taken_at).getTime(),
      val: snapshotValue(s, currency),
      snap: s,
    }));
    const minTs = points[0].ts;
    const maxTs = points[points.length - 1].ts;
    const tsRange = Math.max(1, maxTs - minTs);

    const minVal = 0;  // start chart at zero for honesty
    const maxVal = Math.max(...points.map((p) => p.val)) * 1.1 || 1;

    function xFor(ts) { return PAD_L + ((ts - minTs) / tsRange) * innerW; }
    function yFor(v)  { return PAD_T + (1 - (v - minVal) / (maxVal - minVal)) * innerH; }

    // SVG container
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('style', 'width: 100%; height: auto; max-height: 320px; margin-top: var(--tb-sp-3);');

    function svgEl(name, attrs) {
      const e = document.createElementNS(svgNS, name);
      Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
      return e;
    }

    // Background
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'var(--tb-bg)' }));

    // Y-axis gridlines (5 lines)
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const y = PAD_T + (i / ticks) * innerH;
      const v = maxVal - (i / ticks) * (maxVal - minVal);
      svg.appendChild(svgEl('line', {
        x1: PAD_L, y1: y, x2: W - PAD_R, y2: y,
        stroke: 'var(--tb-border)', 'stroke-width': '0.5', 'stroke-dasharray': '2,4',
      }));
      const label = svgEl('text', {
        x: PAD_L - 8, y: y + 4,
        'text-anchor': 'end', 'font-size': '10', fill: 'var(--tb-text-soft)',
        'font-family': 'var(--tb-font-mono)',
      });
      label.textContent = currency === 'jpy'
        ? '¥' + Math.round(v / 1_000_000).toLocaleString() + 'M'
        : '$' + Math.round(v / 1000).toLocaleString() + 'K';
      svg.appendChild(label);
    }

    // X-axis date labels (first, middle, last)
    [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]
      .forEach((p) => {
        const x = xFor(p.ts);
        const date = TB.utils.localIsoDate(new Date(p.ts));
        const label = svgEl('text', {
          x, y: H - PAD_B + 18,
          'text-anchor': 'middle', 'font-size': '10',
          fill: 'var(--tb-text-soft)', 'font-family': 'var(--tb-font-mono)',
        });
        label.textContent = date;
        svg.appendChild(label);
      });

    // Axis lines
    svg.appendChild(svgEl('line', {
      x1: PAD_L, y1: PAD_T, x2: PAD_L, y2: H - PAD_B,
      stroke: 'var(--tb-border)', 'stroke-width': '1',
    }));
    svg.appendChild(svgEl('line', {
      x1: PAD_L, y1: H - PAD_B, x2: W - PAD_R, y2: H - PAD_B,
      stroke: 'var(--tb-border)', 'stroke-width': '1',
    }));

    // Filled area under line (subtle)
    let areaPath = '';
    points.forEach((p, i) => {
      const x = xFor(p.ts), y = yFor(p.val);
      areaPath += (i === 0 ? 'M ' : 'L ') + x + ' ' + y + ' ';
    });
    areaPath += 'L ' + xFor(points[points.length - 1].ts) + ' ' + (H - PAD_B) + ' ';
    areaPath += 'L ' + xFor(points[0].ts) + ' ' + (H - PAD_B) + ' Z';
    svg.appendChild(svgEl('path', {
      d: areaPath, fill: 'var(--tb-track-history)', 'fill-opacity': '0.15',
    }));

    // Line
    let linePath = '';
    points.forEach((p, i) => {
      const x = xFor(p.ts), y = yFor(p.val);
      linePath += (i === 0 ? 'M ' : 'L ') + x + ' ' + y + ' ';
    });
    svg.appendChild(svgEl('path', {
      d: linePath, fill: 'none',
      stroke: 'var(--tb-track-history)', 'stroke-width': '2.5',
      'stroke-linejoin': 'round',
    }));

    // Data points + hover targets
    const tooltip = el('div', {
      style: {
        position: 'absolute', display: 'none',
        background: 'var(--tb-bg-elev)', border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-1)', padding: '6px 10px',
        fontSize: 'var(--tb-fs-12)', pointerEvents: 'none',
        boxShadow: 'var(--tb-shadow-2)', zIndex: '10',
        whiteSpace: 'nowrap',
      },
    });
    points.forEach((p) => {
      const x = xFor(p.ts), y = yFor(p.val);
      // Visible dot
      svg.appendChild(svgEl('circle', {
        cx: x, cy: y, r: '3.5',
        fill: 'var(--tb-track-history)',
        stroke: 'var(--tb-bg)', 'stroke-width': '2',
      }));
      // Larger invisible hover target
      const hoverDot = svgEl('circle', {
        cx: x, cy: y, r: '14', fill: 'transparent',
        style: 'cursor: pointer;',
      });
      hoverDot.addEventListener('mouseenter', (e) => {
        tooltip.style.display = 'block';
        tooltip.innerHTML = '';
        const dateText = document.createElement('div');
        dateText.textContent = p.snap.taken_at.slice(0, 10) +
          (p.snap.label !== p.snap.taken_at.slice(0, 10) ? ' · ' + p.snap.label : '');
        dateText.style.color = 'var(--tb-text-soft)';
        dateText.style.fontSize = '10px';
        const valText = document.createElement('div');
        valText.style.fontWeight = '700';
        valText.style.fontFamily = 'var(--tb-font-mono)';
        valText.textContent = fmtCurrency(p.val, currency);
        tooltip.appendChild(dateText);
        tooltip.appendChild(valText);
      });
      hoverDot.addEventListener('mousemove', (e) => {
        const rect = wrapper.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 30) + 'px';
      });
      hoverDot.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
      });
      svg.appendChild(hoverDot);
    });

    const wrapper = el('div', { style: { position: 'relative' } });
    wrapper.appendChild(svg);
    wrapper.appendChild(tooltip);
    return wrapper;
  }

  // ─── Year-over-year comparison ────────────────────────────────────

  function buildYoYCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const prefs = getPrefs();
    const currency = prefs.chart_currency || 'usd';
    const snaps = getSnapshots().slice().sort((a, b) => new Date(a.taken_at) - new Date(b.taken_at));

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🔀 ' + t('nw.section.yoy')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('nw.yoy.intro')));

    // Build period rows: Latest vs 90d ago, vs 1y ago, vs 5y ago.
    // Pick the snapshot closest (within ±60 days) to the target date.
    if (snaps.length < 2) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('nw.yoy.need_more')));
      return card;
    }
    const latest = snaps[snaps.length - 1];
    const latestVal = snapshotValue(latest, currency);
    const latestTs = new Date(latest.taken_at).getTime();

    const periods = [
      { id: '90d', label: t('nw.yoy.period.90d'), days: 90 },
      { id: '1y', label: t('nw.yoy.period.1y'), days: 365 },
      { id: '3y', label: t('nw.yoy.period.3y'), days: 365 * 3 },
      { id: '5y', label: t('nw.yoy.period.5y'), days: 365 * 5 },
    ];

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    periods.forEach((p) => {
      const target = latestTs - p.days * 86400000;
      // Find closest snapshot within ±60 days
      let best = null;
      let bestDelta = Infinity;
      snaps.forEach((s) => {
        if (s === latest) return;
        const ts = new Date(s.taken_at).getTime();
        const delta = Math.abs(ts - target);
        if (delta < bestDelta && delta <= 60 * 86400000) {
          best = s;
          bestDelta = delta;
        }
      });
      if (!best) return;
      const baseVal = snapshotValue(best, currency);
      const change = latestVal - baseVal;
      const pct = baseVal !== 0 ? (change / baseVal) * 100 : 0;
      const annualizedYears = (latestTs - new Date(best.taken_at).getTime()) / (365.25 * 86400000);
      const cagr = baseVal > 0 && annualizedYears > 0
        ? (Math.pow(latestVal / baseVal, 1 / annualizedYears) - 1) * 100
        : 0;
      list.appendChild(el('div', {
        style: {
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr',
          gap: 'var(--tb-sp-2)', alignItems: 'baseline',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid ' + (change >= 0 ? 'var(--tb-success)' : 'var(--tb-error)'),
        },
      },
        el('span', null,
          el('div', { style: { fontWeight: '600' } }, p.label),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } }, best.taken_at.slice(0, 10)),
        ),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)' } }, fmtCurrency(baseVal, currency)),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600',
          color: change >= 0 ? 'var(--tb-success)' : 'var(--tb-error)' } },
          (change >= 0 ? '+' : '') + fmtCurrency(change, currency) + ' (' + pct.toFixed(1) + '%)'),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)',
          color: 'var(--tb-text-soft)' } },
          'CAGR ' + (cagr >= 0 ? '+' : '') + cagr.toFixed(1) + '%'),
      ));
    });
    if (list.children.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('nw.yoy.no_matches')));
      return card;
    }
    card.appendChild(list);

    // Allocation drift (latest vs earliest)
    const earliest = snaps[0];
    if (earliest.allocation && latest.allocation) {
      card.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)' } }, t('nw.yoy.allocation_drift')));
      const driftList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
      const classes = Object.keys(latest.allocation).filter((k) =>
        latest.allocation[k] > 0 || (earliest.allocation && earliest.allocation[k] > 0));
      classes.forEach((c) => {
        const oldPct = (earliest.allocation[c] || 0) * 100;
        const newPct = (latest.allocation[c] || 0) * 100;
        const drift = newPct - oldPct;
        driftList.appendChild(el('div', {
          style: {
            display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px',
            gap: 'var(--tb-sp-2)', padding: '4px var(--tb-sp-3)',
            background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
            fontSize: 'var(--tb-fs-12)',
          },
        },
          el('span', null, c.replace(/_/g, ' ')),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right' } },
            oldPct.toFixed(1) + '%'),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right' } },
            newPct.toFixed(1) + '%'),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', textAlign: 'right',
            color: Math.abs(drift) > 5 ? 'var(--tb-warn)' : 'var(--tb-text-soft)' } },
            (drift >= 0 ? '+' : '') + drift.toFixed(1) + 'pp'),
        ));
      });
      card.appendChild(driftList);
    }

    return card;
  }

  // ─── Snapshot history list ────────────────────────────────────────

  function buildHistoryListCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const prefs = getPrefs();
    const currency = prefs.chart_currency || 'usd';
    const snaps = getSnapshots().slice().reverse();  // newest first

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('nw.section.history')));

    if (snaps.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('nw.history.empty')));
      return card;
    }

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
    snaps.forEach((s) => {
      const val = snapshotValue(s, currency);
      list.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-history)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-3)',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } }, s.label || s.taken_at.slice(0, 10)),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
            s.taken_at.slice(0, 10) + ' · ' + (s.accounts || []).length + ' ' + t('nw.history.accounts')),
        ),
        el('div', { style: { display: 'flex', alignItems: 'baseline', gap: 'var(--tb-sp-3)' } },
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600' } },
            fmtCurrency(val, currency)),
          el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
            onclick: () => {
              if (confirm(t('nw.history.confirm_delete'))) {
                deleteSnapshot(s.id);
                rerender();
              }
            } }, '🗑'),
        ),
      ));
    });
    card.appendChild(list);
    return card;
  }

  // ─── Annual review wizard ────────────────────────────────────────

  function buildAnnualReviewCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const reviews = getReviews();
    const last = reviews.length > 0 ? reviews[reviews.length - 1] : null;

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🔄 ' + t('nw.section.review')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openReviewWizard() }, '▶ ' + t('nw.review.start')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('nw.review.intro')));

    if (!last) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('nw.review.never')));
      return card;
    }

    const days = Math.floor((Date.now() - new Date(last.completed_at).getTime()) / 86400000);
    const color = days > 365 ? 'var(--tb-error)'
                : days > 180 ? 'var(--tb-warn)'
                : 'var(--tb-success)';
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid ' + color,
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)',
      },
    },
      el('div', { style: { fontWeight: '600' } },
        t('nw.review.last') + ': ' + last.completed_at.slice(0, 10) + ' (' + days + 'd ago)'),
      last.notes ? el('div', { class: 'tb-field-help', style: { marginTop: '4px' } }, last.notes) : null,
    ));
    return card;
  }

  // ────────────────────────────────────────────────────────────────────
  // YEAR-END CHECKUP WIZARD (v2 — comprehensive, action-performing)
  // ────────────────────────────────────────────────────────────────────
  //
  // Replaces the legacy 7-step "anything change?" wizard with a
  // ~12-step year-end checkup that:
  //   • Performs the action inline when possible (refresh FX, take
  //     snapshot, run PFIC scan) — no need to bounce to the module
  //     for one-click work
  //   • Shows a status line per step: "✓ Done" / "○ Skipped" / live
  //     result of the inline action ("✓ FX refreshed: 4 years")
  //   • Generates a year-end Markdown report on completion
  //   • Logs the review with timestamp, step statuses, and notes
  //
  // The legacy 7-step state (annual_reviews[]) is reused; the new flow
  // appends to the same array so prior reviews stay in history.
  function openReviewWizard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');

    // Each step:
    //   id              — stable identifier (used in completion log)
    //   label_key       — i18n base key; .title / .body are appended
    //   module          — optional view id for "Open module ↗" link
    //   action          — optional async fn that runs the action; returns
    //                     a result string shown in the step status row,
    //                     or throws to show an error
    //   showIf          — optional fn(state) → bool; hide when false
    const STEPS = [
      {
        id: 'fx_refresh',
        label_key: 'nw.review2.step.fx_refresh',
        module: 'settings',
        action: async () => {
          const out = [];
          // Treasury year-end rates (FBAR-relevant)
          if (TB.fbar && typeof TB.fbar.refreshTreasuryRates === 'function') {
            try {
              const r = await TB.fbar.refreshTreasuryRates();
              const yrs = Object.keys(r.fetched || {}).length;
              if (yrs > 0) out.push(t('nw.wizard.fx.treasury_years', { years: yrs }));
            } catch (e) { out.push(t('nw.wizard.fx.treasury_failed')); }
          }
          // Current spot rates (FX module)
          if (TB.utils && typeof TB.utils.refreshCurrentFx === 'function') {
            try {
              await TB.utils.refreshCurrentFx();
              out.push(t('nw.wizard.fx.current_ok'));
            } catch (e) { out.push(t('nw.wizard.fx.current_failed')); }
          }
          return out.join(' · ') || t('nw.wizard.fx.nothing_to_refresh');
        },
      },
      {
        id: 'snapshot',
        label_key: 'nw.review2.step.snapshot',
        action: async () => {
          const yr = new Date().getFullYear();
          const snap = takeSnapshot('Year-end ' + yr);
          if (!snap) return t('nw.wizard.snapshot.noAssets');
          return t('nw.wizard.snapshot.saved', { amount: '$' + Math.round(snap.total_usd).toLocaleString() });
        },
      },
      {
        id: 'asset_balances',
        label_key: 'nw.review2.step.asset_balances',
        module: 'assets',
        action: async () => {
          const accts = (TB.state.get('assets.accounts') || []).filter(a => a.active);
          if (accts.length === 0) return t('nw.wizard.balances.noActive');
          const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
          const stale = accts.filter(a => {
            if (!a.updated_at) return true;
            return new Date(a.updated_at).getTime() < cutoff;
          });
          if (stale.length === 0) return t('nw.wizard.balances.allFresh', { count: accts.length });
          return t('nw.wizard.balances.someStale', { stale: stale.length, total: accts.length });
        },
      },
      {
        id: 'pfic_scan',
        label_key: 'nw.review2.step.pfic_scan',
        module: 'tax-coordinator',
        action: async () => {
          const accts = (TB.state.get('assets.accounts') || []);
          if (accts.length === 0) return t('nw.wizard.pfic.noAccounts');
          const KEYWORDS = ['投資信託', '学資保険', 'mutual fund', 'fund', 'etf', 'NISA', 'iDeCo'];
          const flagged = [];
          for (const a of accts) {
            if (a.country === 'US') continue;
            const hay = ((a.name || '') + ' ' + (a.notes || '') + ' ' + (a.institution || '')).toLowerCase();
            if (KEYWORDS.some(k => hay.indexOf(k.toLowerCase()) !== -1)) {
              const isJustBank = ['jp_savings', 'jp_checking', 'jp_fixed_deposit'].indexOf(a.tax_wrapper) !== -1;
              if (!isJustBank) flagged.push(a.institution || a.name || '?');
            }
          }
          if (flagged.length === 0) return t('nw.wizard.pfic.noFlags');
          return t('nw.wizard.pfic.flagged', {
            count: flagged.length,
            names: flagged.slice(0, 3).join(', '),
            more: flagged.length > 3 ? '…' : '',
          });
        },
      },
      {
        id: 'fbar_threshold',
        label_key: 'nw.review2.step.fbar_threshold',
        module: 'fbar',
        action: async () => {
          // Prefer the real FBAR test: aggregate of each account's year-max
          // balance at the Treasury year-end rate (TB.fbar.aggregateForYear),
          // not current balances at the current spot rate.
          if (TB.fbar && typeof TB.fbar.aggregateForYear === 'function') {
            const agg = TB.fbar.aggregateForYear();
            if (agg && agg.status !== 'no_data') {
              const usd = '$' + Math.round(agg.aggregate_usd || 0).toLocaleString();
              const yr = agg.year ? String(agg.year) : '';
              const suffix = yr
                ? t('nw.wizard.fbar.suffix.withYear', { year: yr })
                : t('nw.wizard.fbar.suffix.noYear');
              if (agg.any_filer_over || agg.status === 'at_or_over') {
                return t('nw.wizard.fbar.required', { amount: usd, suffix });
              }
              if (agg.status === 'insufficient_data') {
                return t('nw.wizard.fbar.incomplete', { amount: usd, suffix });
              }
              return t('nw.wizard.fbar.belowThreshold', { amount: usd, suffix });
            }
          }
          // No FBAR data: current balances are only a rough proxy — do NOT
          // render a pass/fail verdict from them.
          const accts = (TB.state.get('assets.accounts') || []).filter(a => a.active && a.country !== 'US');
          if (!TB.assets || typeof TB.assets.toUsd !== 'function') return t('nw.wizard.fbar.assetsUnavailable');
          let total = 0;
          for (const a of accts) {
            total += TB.assets.toUsd(a.balance_native, a.currency);
          }
          return t('nw.wizard.fbar.roughEstimate', { amount: '$' + Math.round(total).toLocaleString() });
        },
      },
      {
        id: 'family_passports',
        label_key: 'nw.review2.step.family',
        module: 'family',
        action: async () => {
          const members = (TB.state.get('family.members') || []);
          if (members.length === 0) return t('nw.wizard.family.noMembers');
          // Find passports expiring in next 12 months
          const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() + 12);
          const expiring = [];
          for (const m of members) {
            for (const p of (m.passports || [])) {
              if (p.expires) {
                const e = new Date(p.expires);
                if (!isNaN(e.getTime()) && e <= cutoff) expiring.push(m.name + ' (' + p.country + ')');
              }
            }
          }
          if (expiring.length === 0) return t('nw.wizard.family.noExpiring', { count: members.length });
          return t('nw.wizard.family.expiring', { count: expiring.length, names: expiring.slice(0, 3).join(', ') });
        },
      },
      {
        id: 'property_review',
        label_key: 'nw.review2.step.property',
        module: 'property',
        showIf: () => {
          const props = TB.state.get('property.properties') || [];
          return props.length > 0;
        },
      },
      {
        id: 'healthcare_review',
        label_key: 'nw.review2.step.healthcare',
        module: 'healthcare',
        action: async () => {
          // Surface Medicare IEP if user is approaching 65.
          const profile = TB.state.get('profile') || {};
          const dob = profile.dob || profile.birth_year;
          if (!dob) return t('nw.wizard.healthcare.noDob');
          const dobDate = typeof dob === 'string' && dob.length >= 4 ? new Date(dob.slice(0, 10)) : null;
          if (!dobDate || isNaN(dobDate.getTime())) return t('nw.wizard.healthcare.ready');
          const sixtyFive = new Date(dobDate);
          sixtyFive.setFullYear(sixtyFive.getFullYear() + 65);
          const monthsTo65 = Math.round((sixtyFive - new Date()) / (30 * 24 * 3600 * 1000));
          if (monthsTo65 > 6 && monthsTo65 < 9) {
            return t('nw.wizard.healthcare.iepOpensSoon', { months: monthsTo65 - 3 });
          }
          if (monthsTo65 >= -3 && monthsTo65 <= 6) {
            return t('nw.wizard.healthcare.iepWindow');
          }
          return t('nw.wizard.healthcare.ready');
        },
      },
      {
        id: 'tax_docs',
        label_key: 'nw.review2.step.tax_docs',
        module: 'tax-coordinator',
      },
      {
        id: 'consultations',
        label_key: 'nw.review2.step.consultations',
        module: 'consultations',
      },
      {
        id: 'spouse_handoff',
        label_key: 'nw.review2.step.spouse_handoff',
        module: 'sharing-backup',
        showIf: () => {
          const fam = TB.state.get('onboarding.answers.family') || [];
          const arr = Array.isArray(fam) ? fam : [fam];
          return arr.includes('jp_spouse') || arr.includes('us_spouse') || arr.includes('third_spouse');
        },
      },
      {
        id: 'report_generate',
        label_key: 'nw.review2.step.report',
        action: async () => {
          try {
            generateAndDownloadReport();
            return t('nw.wizard.report.downloaded');
          } catch (e) {
            return t('nw.wizard.report.failed', { error: e.message || e });
          }
        },
      },
    ];

    // Filter out hidden steps before rendering.
    const visibleSteps = STEPS.filter(s => typeof s.showIf !== 'function' || s.showIf());

    let stepIdx = 0;
    let notes = '';
    const stepStatus = visibleSteps.map(() => null); // 'ok' | 'changed' | 'skip' | { result }
    const stepResults = visibleSteps.map(() => null); // string result from inline action

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '640px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }

    function paint() {
      modal.innerHTML = '';
      modal.appendChild(el('h2', { style: { marginTop: 0 } }, '🔄 ' + t('nw.review2.modal_title')));
      modal.appendChild(el('p', { class: 'tb-card-meta' }, t('nw.review2.modal_intro')));

      // Progress bar
      const progress = el('div', {
        style: { display: 'flex', gap: '3px', marginBottom: 'var(--tb-sp-3)' },
      });
      visibleSteps.forEach((_, i) => {
        progress.appendChild(el('div', {
          style: {
            flex: 1, height: '6px', borderRadius: 'var(--tb-radius-pill)',
            background: i < stepIdx ? 'var(--tb-success)' :
                        i === stepIdx ? 'var(--tb-track-history)' : 'var(--tb-border)',
          },
        }));
      });
      modal.appendChild(progress);

      if (stepIdx < visibleSteps.length) {
        const step = visibleSteps[stepIdx];
        modal.appendChild(el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } },
          t('nw.review2.step_label', { current: stepIdx + 1, total: visibleSteps.length })));
        modal.appendChild(el('h3', { style: { marginTop: 0 } }, t(step.label_key + '.title')));
        modal.appendChild(el('p', null, t(step.label_key + '.body')));

        // Show last action result if available (lets users see what
        // "Run now" produced before deciding Confirm vs Skip).
        if (stepResults[stepIdx]) {
          modal.appendChild(el('div', {
            style: {
              padding: 'var(--tb-sp-2) var(--tb-sp-3)',
              background: 'var(--tb-bg)',
              borderLeft: '3px solid var(--tb-success)',
              borderRadius: 'var(--tb-radius-1)',
              marginBottom: 'var(--tb-sp-2)',
              fontFamily: 'var(--tb-font-mono)',
              fontSize: 'var(--tb-fs-12)',
            },
          }, stepResults[stepIdx]));
        }

        // Open-module link (always shown when step.module is set)
        if (step.module) {
          modal.appendChild(el('p', { style: { marginBottom: 'var(--tb-sp-2)' } },
            el('a', { href: '#', style: { color: 'var(--tb-navy)' },
              onclick: (e) => {
                e.preventDefault();
                close();
                document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: step.module } }));
              },
            }, '↗ ' + t('nw.review2.open_module')),
          ));
        }

        // Action row
        const btns = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap' } });

        // "Run now" button — only when the step has an inline action
        if (typeof step.action === 'function') {
          const runBtn = el('button', {
            class: 'tb-btn',
            type: 'button',
            onclick: async () => {
              runBtn.disabled = true;
              const old = runBtn.textContent;
              runBtn.textContent = '⏳ ' + t('nw.review2.btn.running');
              try {
                const result = await step.action();
                stepResults[stepIdx] = result;
                stepStatus[stepIdx] = 'ok';
                paint();
              } catch (err) {
                stepResults[stepIdx] = '✗ ' + (err.message || err);
                runBtn.disabled = false;
                runBtn.textContent = old;
                paint();
              }
            },
          }, '▶ ' + t('nw.review2.btn.run_now'));
          btns.appendChild(runBtn);
        }

        // Confirm — mark done without inline action
        btns.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button',
          onclick: () => {
            if (!stepStatus[stepIdx]) stepStatus[stepIdx] = 'ok';
            stepIdx += 1; paint();
          } },
          '✓ ' + t('nw.review2.btn.next')));

        // Skip
        btns.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
          onclick: () => { stepStatus[stepIdx] = 'skip'; stepIdx += 1; paint(); } },
          t('nw.review2.btn.skip')));

        modal.appendChild(btns);

        // Cancel
        modal.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-3)', textAlign: 'right' } },
          el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
            style: { fontSize: 'var(--tb-fs-12)' },
            onclick: close }, t('nw.cancel'))));
      } else {
        // Final step — summary + complete
        modal.appendChild(el('h3', { style: { marginTop: 0 } }, '✓ ' + t('nw.review2.complete_title')));
        modal.appendChild(el('p', null, t('nw.review2.complete_body')));

        // Per-step summary
        const summary = el('ul', { style: { paddingLeft: '20px', fontSize: 'var(--tb-fs-12)' } });
        visibleSteps.forEach((step, i) => {
          const status = stepStatus[i] || 'skip';
          const icon = status === 'ok' ? '✓' : status === 'changed' ? '✎' : '○';
          const result = stepResults[i] ? ' · ' + stepResults[i] : '';
          summary.appendChild(el('li', null, icon + ' ' + t(step.label_key + '.title') + result));
        });
        modal.appendChild(summary);

        modal.appendChild(el('div', { class: 'tb-field' },
          el('label', { class: 'tb-field-label' }, t('nw.review2.notes_label')),
          el('textarea', { class: 'tb-input', rows: 3,
            placeholder: t('nw.review2.notes_placeholder'),
            oninput: (e) => { notes = e.target.value; } }),
        ));

        const btns = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)' } });
        btns.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('nw.cancel')));
        btns.appendChild(el('button', { class: 'tb-btn', type: 'button',
          onclick: () => {
            const reviews = getReviews();
            reviews.push({
              id: 'rev-' + Date.now().toString(36),
              completed_at: new Date().toISOString(),
              type: 'year_end_v2',
              notes,
              steps: visibleSteps.map((s, i) => ({
                id: s.id,
                status: stepStatus[i] || 'skip',
                result: stepResults[i] || null,
              })),
            });
            setReviews(reviews);
            close();
            rerender();
          },
        }, '✓ ' + t('nw.review2.btn.complete')));
        modal.appendChild(btns);
      }
    }

    paint();
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Annual report exporter ──────────────────────────────────────

  function buildReportExportCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const reports = getReports();

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '📄 ' + t('nw.section.report')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => generateAndDownloadReport() }, '⬇ ' + t('nw.report.generate')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('nw.report.intro')));

    if (reports.length > 0) {
      const last = reports[reports.length - 1];
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('nw.report.last_generated') + ': ' + new Date(last.generated_at).toLocaleDateString() +
        ' · ' + last.year));
    }
    return card;
  }

  // The "report year" a given date targets: in January, the report is
  // for the prior (just-ended) calendar year; otherwise it's the
  // current year. Shared with genYearEndReport's nag logic below so
  // the report generator and the nag always agree on which year is due.
  function reportYearFor(date) {
    return date.getMonth() + 1 === 1 ? date.getFullYear() - 1 : date.getFullYear();
  }

  // Generates a year-end Markdown report bundling state from all
  // modules. Downloads as .md. Logs metadata in net_worth.annual_reports.
  function generateAndDownloadReport() {
    const profile = TB.state.get('profile') || {};
    const today = new Date();
    const year = reportYearFor(today);
    const dateStr = TB.utils.todayIso();
    const prefs = getPrefs();
    const currency = prefs.chart_currency || 'usd';
    const snaps = getSnapshots();
    const latest = snaps.length > 0 ? snaps[snaps.length - 1] : null;

    const lines = [];
    lines.push('# Annual Financial Report — ' + year);
    lines.push('');
    lines.push('**Prepared for:** ' + (profile.displayName || '(unspecified)'));
    lines.push('**Generated:** ' + dateStr);
    lines.push('');
    lines.push('> *This report bundles your Taigan Bridge state into a single document for review, sharing with your CPA / financial advisor, or year-end archive. Generated entirely from local state — no information was sent to any service to produce this.*');
    lines.push('');

    // 1. Executive summary
    lines.push('## 1. Executive Summary');
    lines.push('');
    if (latest) {
      const val = snapshotValue(latest, currency);
      lines.push('- **Net worth (latest snapshot):** ' + fmtCurrency(val, currency) + ' (as of ' + latest.taken_at.slice(0, 10) + ')');
    }
    if (snaps.length >= 2) {
      const first = snaps[0];
      const yoyDays = (new Date(latest.taken_at) - new Date(first.taken_at)) / 86400000;
      if (yoyDays >= 300) {  // worth noting if at least 10 months
        const oldVal = snapshotValue(first, currency);
        const newVal = snapshotValue(latest, currency);
        const pct = oldVal > 0 ? ((newVal - oldVal) / oldVal) * 100 : 0;
        lines.push('- **Change since first snapshot:** ' + (newVal - oldVal >= 0 ? '+' : '') +
          fmtCurrency(newVal - oldVal, currency) + ' (' + pct.toFixed(1) + '%) over ' +
          (yoyDays / 365.25).toFixed(1) + ' years');
      }
    }
    const tracks = TB.state.get('tracks') || [];
    if (tracks.length > 0) {
      lines.push('- **Active tracks:** ' + tracks.join(', '));
    }
    lines.push('');

    // 2. Asset inventory
    if (TB.assets && typeof TB.assets.getActiveAccounts === 'function') {
      const accounts = TB.assets.getActiveAccounts();
      if (accounts.length > 0) {
        lines.push('## 2. Asset Inventory');
        lines.push('');
        lines.push('| Institution | Account | Country | Wrapper | Currency | Balance | USD |');
        lines.push('|-------------|---------|---------|---------|----------|---------|-----|');
        accounts.forEach((a) => {
          lines.push('| ' + (a.institution || '—') +
            ' | ' + (a.name || '—') +
            ' | ' + (a.country || '—') +
            ' | ' + (a.tax_wrapper || '—') +
            ' | ' + (a.currency || '—') +
            ' | ' + (a.balance_native != null ? a.balance_native.toLocaleString() : '—') +
            ' | $' + Math.round(TB.assets.toUsd(a.balance_native, a.currency)).toLocaleString() + ' |');
        });
        lines.push('');
        const total = accounts.reduce((s, a) => s + TB.assets.toUsd(a.balance_native, a.currency), 0);
        lines.push('**Total: $' + Math.round(total).toLocaleString() + '**');
        lines.push('');
      }
    }

    // 3. Tax filing summary
    if (TB.taxCoord && typeof TB.taxCoord.buildContext === 'function') {
      try {
        const ctx = TB.taxCoord.buildContext();
        lines.push('## 3. Tax Filing Summary (Year ' + year + ')');
        lines.push('');
        lines.push('- **Filing status:** ' + ctx.filing_status_label);
        lines.push('- **FEIE/FTC election:** ' + (ctx.feie_choice || 'undecided'));
        lines.push('- **JP tax resident:** ' + (ctx.is_jp_resident ? 'yes' : 'no'));
        lines.push('- **Foreign assets:** $' + Math.round(ctx.foreign_assets_usd).toLocaleString());
        lines.push('- **FBAR aggregate:** $' + Math.round(ctx.fbar_aggregate_usd).toLocaleString() +
          (ctx.fbar_aggregate_usd > 10000 ? ' (FBAR required)' : ''));
        if (ctx.has_pfic) {
          lines.push('- **⚠ PFIC detected:** ' + (ctx.pfic_account_names || []).join(', '));
        }
        if (ctx.has_foreign_corp) {
          lines.push('- **Foreign corp ownership:** yes (Form 5471 required)');
        }
        lines.push('');
      } catch (err) { /* swallow */ }
    }

    // 4. Estate snapshot
    if (TB.estate && typeof TB.estate.computeJpInheritanceTax === 'function') {
      try {
        const tax = TB.estate.computeJpInheritanceTax();
        const heirs = TB.estate.deriveStatutoryHeirs();
        if (heirs.all_heirs.length > 0 || tax.gross_jpy > 0) {
          lines.push('## 4. Estate Snapshot');
          lines.push('');
          lines.push('- **Statutory heirs:** ' + heirs.all_heirs.length);
          lines.push('- **JP estate (in scope):** ¥' + Math.round(tax.gross_jpy).toLocaleString());
          lines.push('- **Projected JP 相続税:** ¥' + Math.round(tax.net_tax).toLocaleString() +
            ' (after spouse credit ¥' + Math.round(tax.spouse_credit).toLocaleString() + ')');
          lines.push('- **永住者 status active:** ' + (tax.is_pr_for_tax ? 'yes (worldwide assets in scope)' : 'no (JP-situs only)'));
          lines.push('');
        }
      } catch (err) { /* swallow */ }
    }

    // 5. Family + gifts
    const family = TB.state.get('family.members') || [];
    if (family.length > 0) {
      lines.push('## 5. Family Roster');
      lines.push('');
      lines.push('| Name | Relationship | Citizenships | Birth date |');
      lines.push('|------|--------------|--------------|------------|');
      family.forEach((m) => {
        lines.push('| ' + (m.name_en || m.name_jp || '(unnamed)') +
          ' | ' + m.relationship +
          ' | ' + (m.citizenships || []).join(', ') +
          ' | ' + (m.birth_date || '—') + ' |');
      });
      lines.push('');
    }
    const gifts = TB.state.get('family.gifts_log') || [];
    if (gifts.length > 0) {
      lines.push('### Gifts logged (' + gifts.length + ' entries)');
      lines.push('');
      const cutoff = year - 7;
      const inWindow = gifts.filter((g) => g.year >= cutoff);
      lines.push('- ' + inWindow.length + ' within 7-year clawback window, ' +
        '¥' + inWindow.reduce((s, g) => s + (g.amount_jpy || 0), 0).toLocaleString() + ' total');
      lines.push('');
    }

    // 6. Action items pending
    if (TB.actionCenter && typeof TB.actionCenter.deriveActions === 'function') {
      try {
        const actions = TB.actionCenter.deriveActions();
        if (actions.length > 0) {
          lines.push('## 6. Outstanding Action Items');
          lines.push('');
          actions.slice(0, 15).forEach((a) => {
            lines.push('- [' + (a.urgency || 'med') + '] ' + a.title);
          });
          if (actions.length > 15) {
            lines.push('- ... and ' + (actions.length - 15) + ' more');
          }
          lines.push('');
        }
      } catch (err) { /* swallow */ }
    }

    // 7. Snapshot history (compact)
    if (snaps.length > 0) {
      lines.push('## 7. Net Worth History');
      lines.push('');
      lines.push('| Date | Label | USD | JPY |');
      lines.push('|------|-------|-----|-----|');
      snaps.slice(-10).reverse().forEach((s) => {
        lines.push('| ' + s.taken_at.slice(0, 10) +
          ' | ' + (s.label || '—') +
          ' | $' + Math.round(s.total_usd || 0).toLocaleString() +
          ' | ¥' + Math.round(snapshotValue(s, 'jpy') || 0).toLocaleString() + ' |');
      });
      if (snaps.length > 10) {
        lines.push('');
        lines.push('*(showing 10 most recent of ' + snaps.length + ' snapshots)*');
      }
      lines.push('');
    }

    // Annual review log
    const reviews = getReviews();
    if (reviews.length > 0) {
      const last = reviews[reviews.length - 1];
      lines.push('## 8. Last Annual Review');
      lines.push('');
      lines.push('- **Completed:** ' + last.completed_at.slice(0, 10));
      if (last.notes) {
        lines.push('- **Notes:** ' + last.notes);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by Taigan Bridge — single-file HTML, runs entirely in your browser. State exported here is yours to share, archive, or discard. Not a substitute for professional financial / tax / legal advice.*');

    const md = lines.join('\n');

    // Log report metadata
    const reports = getReports();
    reports.push({
      id: 'rpt-' + Date.now().toString(36),
      year,
      generated_at: today.toISOString(),
      total_usd: latest ? latest.total_usd : 0,
    });
    setReports(reports);

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'taigan-bridge-annual-report-' + year + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    rerender();
  }

  // ─── Preferences ──────────────────────────────────────────────────

  function buildPreferencesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const prefs = getPrefs();

    const card = el('div', { class: 'tb-card', 'data-track': 'history' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚙ ' + t('nw.section.preferences')));

    function row(labelKey, helpKey, key) {
      const cb = el('input', { type: 'checkbox', checked: !!prefs[key],
        style: { marginRight: '8px' },
        onchange: (e) => {
          const p = Object.assign({}, prefs);
          p[key] = !!e.target.checked;
          setPrefs(p);
        } });
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
          cb, t(labelKey)),
        el('div', { class: 'tb-field-help' }, t(helpKey)),
      );
    }
    card.appendChild(row('nw.prefs.auto_fbar', 'nw.prefs.auto_fbar.help', 'auto_snapshot_on_fbar'));
    card.appendChild(row('nw.prefs.auto_year_end', 'nw.prefs.auto_year_end.help', 'auto_snapshot_year_end'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genSnapshotStale() {
    const t = TB.i18n.t;
    const days = daysSinceLastSnapshot();
    if (days == null) {
      // Have accounts but never snapshotted?
      const accounts = (TB.assets && typeof TB.assets.getActiveAccounts === 'function')
        ? TB.assets.getActiveAccounts() : [];
      if (accounts.length === 0) return [];
      return [{
        id: 'nw_snapshot_first',
        group: 'history',
        urgency: 'low',
        icon: '📸',
        title: t('nw.gen.snapshotFirst.title'),
        body: t('nw.gen.snapshotFirst.body', { count: accounts.length }),
        module: 'net-worth',
        snoozable: true,
      }];
    }
    if (days < 90) return [];
    const urgency = days > 365 ? 'high' : days > 180 ? 'medium' : 'low';
    return [{
      id: 'nw_snapshot_stale',
      group: 'history',
      urgency,
      icon: '📸',
      title: t('nw.gen.snapshotStale.title', { days }),
      body: t('nw.gen.snapshotStale.body'),
      module: 'net-worth',
      snoozable: true,
    }];
  }

  function genAnnualReviewDue() {
    const t = TB.i18n.t;
    const reviews = getReviews();
    // The "year-end window" — Nov 15 → Jan 31 — is when the checkup
    // matters most (FBAR aggregation, year-end balances, year-end
    // snapshot, tax-doc gathering). Inside the window we bump urgency
    // and re-frame the title; outside, we hold off on first-run
    // nagging until day 365 of inactivity.
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    const inYearEndWindow = (month === 11 && day >= 15) || month === 12 || month === 1;

    if (reviews.length === 0) {
      // First-time prompt only fires if the user has at least one
      // active asset account — empty state isn't actionable.
      const accts = (TB.state.get('assets.accounts') || []).filter(a => a.active);
      if (accts.length === 0) return [];
      return [{
        id: 'nw_review_first',
        group: 'history',
        urgency: inYearEndWindow ? 'medium' : 'low',
        icon: '🔄',
        title: inYearEndWindow
          ? t('nw.gen.reviewFirst.title.window')
          : t('nw.gen.reviewFirst.title.normal'),
        body: t('nw.gen.reviewFirst.body'),
        module: 'net-worth',
        snoozable: true,
      }];
    }

    const last = reviews[reviews.length - 1];
    const days = Math.floor((Date.now() - new Date(last.completed_at).getTime()) / 86400000);

    // In year-end window: prompt if last review was >300 days ago
    // (so the same calendar year doesn't get reviewed twice).
    if (inYearEndWindow && days > 300) {
      return [{
        id: 'nw_year_end_checkup_due',
        group: 'history',
        urgency: 'high',
        icon: '🔄',
        title: t('nw.gen.reviewDueWindow.title', { days }),
        body: t('nw.gen.reviewDueWindow.body'),
        module: 'net-worth',
        snoozable: true,
      }];
    }

    // Outside the window: only nag at >365 days.
    if (days < 365) return [];
    return [{
      id: 'nw_review_due',
      group: 'history',
      urgency: 'medium',
      icon: '🔄',
      title: t('nw.gen.reviewOverdue.title', { years: Math.floor(days / 365) }),
      body: t('nw.gen.reviewOverdue.body'),
      module: 'net-worth',
      snoozable: true,
    }];
  }

  function genYearEndReport() {
    const t = TB.i18n.t;
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    // Only fire in December (after the 15th) or January (before the 31st)
    const inWindow = (month === 12 && day >= 15) || (month === 1);
    if (!inWindow) return [];
    const reports = getReports();
    const year = reportYearFor(today);
    const alreadyGenerated = reports.some((r) => r.year === year);
    if (alreadyGenerated) return [];
    return [{
      id: 'nw_year_end_report_' + year,
      group: 'history',
      urgency: 'low',
      icon: '📄',
      title: t('nw.gen.reportNotGenerated.title', { year }),
      body: t('nw.gen.reportNotGenerated.body'),
      module: 'net-worth',
      snoozable: true,
    }];
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Net Worth & Reports', label_jp: '純資産・レポート', render,
    searchSections: SECTIONS,
  };

  window.TB.netWorth = {
    actionGenerators: [genSnapshotStale, genAnnualReviewDue, genYearEndReport],
    takeSnapshot, deleteSnapshot, snapshotValue, daysSinceLastSnapshot,
    generateAndDownloadReport,
  };
})();
