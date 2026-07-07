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

  // ====================================================================
  // i18n — this module owns its own Action Center generator strings
  // (title/body/alert text produced by the gen*() functions below and
  // the .ics calendar-export summaries) rather than adding them to the
  // shared src/scripts/i18n.js table. English values are verbatim the
  // original hardcoded strings; Japanese are natural translations that
  // preserve every figure/deadline/form-number exactly.
  // ====================================================================
  TB.i18n = TB.i18n || {};
  if (typeof TB.i18n.extend === 'function') {
    TB.i18n.extend('en', {
      'ac.fbarFilingDeadline.title.overdue':     'FBAR for {{year}} is overdue (extension expired {{octDeadline}})',
      'ac.fbarFilingDeadline.title.extended':    'FBAR for {{year}} due {{octDeadline}} (auto-extension)',
      'ac.fbarFilingDeadline.title.upcoming':    'FBAR for {{year}} due {{aprDeadline}}',
      'ac.fbarFilingDeadline.body.overdue':      'You have foreign account balances recorded for {{year}} but no filing logged, and the automatic extension to {{octDeadline}} has passed. FinCEN 114 is now overdue. Penalty for non-willful failure: up to $16,536 per report — file as soon as possible.',
      'ac.fbarFilingDeadline.body.extended':     'You have foreign account balances recorded for {{year}} but no filing logged. The April 15 deadline passed, but FinCEN 114 is automatically extended to {{octDeadline}} — no separate extension request needed. Penalty for non-willful failure: up to $16,536 per report.',
      'ac.fbarFilingDeadline.body.upcoming':     'You have foreign account balances recorded for {{year}} but no filing logged. FinCEN 114 is due {{aprDeadline}} (auto-extended to Oct 15). Penalty for non-willful failure: up to $16,536 per report.',

      'ac.fbarTreasuryStale.title':              'Refresh Treasury rates for {{year}}',
      'ac.fbarTreasuryStale.body':                'You don\'t have {{year}} Treasury Year-End rates loaded. FBAR uses these to convert foreign currency balances to USD. Refresh from fiscaldata.treasury.gov before filing.',

      'ac.assetsStaleBalances.title.one':        '1 account balance is stale (>120 days)',
      'ac.assetsStaleBalances.title.many':       '{{count}} account balances are stale (>120 days)',
      'ac.assetsStaleBalances.body':              'Refresh: {{names}}{{overflow}}. Stale balances make every projection scenario worse.',

      'ac.assetsSnapshotDue.first.title':        'Take your first portfolio snapshot',
      'ac.assetsSnapshotDue.first.body':          'Snapshots freeze your portfolio state at a point in time. Useful before any major change AND for year-over-year tracking.',
      'ac.assetsSnapshotDue.overdue.title':       'Take a portfolio snapshot (last was {{age}} days ago)',
      'ac.assetsSnapshotDue.overdue.body':        'Your last snapshot was {{date}}. Snapshots are how you track year-over-year growth.',

      'ac.assetsCloseDateApproaching.title':      '{{name}} closes in {{days}} days',
      'ac.assetsCloseDateApproaching.body':       'Account "{{name}}" has a close_date of {{closeDate}}{{transferNote}}. Confirm bank instructions and that the transfer target is set up.',
      'ac.assetsCloseDateApproaching.transferNote': ' — funds transfer to {{transferTo}}',

      'ac.assetsFxStale.neverFetched.title':      'Live FX rates not loaded yet',
      'ac.assetsFxStale.neverFetched.body':       'Currently using hardcoded fallback rates. Click Refresh in Assets to pull live rates from Treasury (free, no auth).',
      'ac.assetsFxStale.stale.title':             'FX rates are {{age}} days old',
      'ac.assetsFxStale.stale.body':               'Treasury publishes quarterly. Refresh in Assets to get the latest rates for your projections.',

      'ac.projQuarterlyTax.title':                '{{label}} due {{date}} (in {{days}}d)',
      'ac.projQuarterlyTax.body':                  'US estimated tax payment for retirees. Amount = (annual US tax) ÷ 4. See your Projections breakdown for the year-total tax estimate.',
      'ac.projQuarterlyTax.label.q1':              'Q1 estimated tax',
      'ac.projQuarterlyTax.label.q2':              'Q2 estimated tax',
      'ac.projQuarterlyTax.label.q3':              'Q3 estimated tax',
      'ac.projQuarterlyTax.label.q4':              'Q4 (prior year) estimated tax',

      'ac.projRothWindowJuminhyou.title':          'Roth conversion window — {{days}} days until 住民票',
      'ac.projRothWindowJuminhyou.body':           'You\'ve set 住民票 registration for {{date}}. Trad → Roth conversions BEFORE that date are US-taxed only. AFTER, Japan also taxes them as ordinary income at 20-45% national + 10% local. Plan your ladder in Projections → Tax Strategy.',

      'ac.projSsClaimWindow.title':                'Social Security claim decision window (age {{ssAge}} planned)',
      'ac.projSsClaimWindow.body':                 'You\'re within 2 years of your planned SS start age. Compare scenarios at 62 (~70% benefit), 67 (FRA, 100%), and 70 (~124%) in Projections to confirm the optimal claim age for your situation.',

      'ac.projRmdYear.now.title':                  'RMD year — Required Minimum Distribution due',
      'ac.projRmdYear.now.body':                    'Age 73+ requires annual RMDs from Traditional IRA / 401(k) / TSP. Failure = 25% federal excise tax. Confirm your custodian has calculated and set up the distribution.',
      'ac.projRmdYear.approaching.title':           'RMD age 73 in {{years}} year(s)',
      'ac.projRmdYear.approaching.body':            'Roth conversions in your low-income window before 73 reduce future RMDs (and the tax burden they create). Use the conversion ladder in Projections → Tax Strategy to plan.',

      'ac.projCatchupTransitions.at50.title':       'You qualify for 50+ catch-up contributions next year',
      'ac.projCatchupTransitions.at50.body':        'Standard catch-up adds $7,500/yr to 401(k)/403(b)/TSP and $1,000/yr to IRA. Adjust your payroll deferral % at the new year.',
      'ac.projCatchupTransitions.at60.title':       'SECURE 2.0 enhanced catch-up at age 60-63 starts next year',
      'ac.projCatchupTransitions.at60.body':        'Extra $11,250/yr to 401(k)/403(b)/TSP (vs the standard $7,500). Adjust your deferral % to capture the bigger window before it reverts to standard at 64.',
      'ac.projCatchupTransitions.at64.title':       'Enhanced catch-up reverts to standard $7,500 next year (age 64)',
      'ac.projCatchupTransitions.at64.body':        'Last year of the SECURE 2.0 enhanced ($11,250) catch-up. Max it now while it\'s available.',

      'ac.sofaPendingSteps.title.one':              '1 critical/high SOFA action still open',
      'ac.sofaPendingSteps.title.many':             '{{count}} critical/high SOFA actions still open',
      'ac.sofaPendingSteps.body':                    'You have {{count}} high-severity sequencer steps marked pending or planned, with 住民票 in {{days}} days. Review and execute in SOFA → Sequence.',

      'ac.profileNoName.title':                     'Set your name to personalize the dashboard',
      'ac.profileNoName.body':                       'Re-run onboarding (link at the bottom-right of the dashboard) to add your name — it shows up in the dashboard title.',

      'ac.export.noEvents':                          'No dated events found. Add some state (action items, document expiries, family members) first.',

      'ac.ics.vault.summary':                        'Expires: {{title}}',
      'ac.ics.vault.description':                     'Document Vault item{{notes}}',
      'ac.ics.vault.description.notesSuffix':         ': {{notes}}',

      'ac.ics.passport.summary':                      'Passport expires: {{name}} ({{country}})',
      'ac.ics.passport.description':                   'Renew passport — file 9-12 months before expiry to avoid travel disruption.',
      'ac.ics.passport.fallbackName':                  'family member',

      'ac.ics.natChoice.summary':                      '国籍選択 by age 20: {{name}}',
      'ac.ics.natChoice.description':                   'Japanese Nationality Act Art. 14 — date by which a dual-from-birth national is asked to choose a nationality. This is a non-penalized "duty of effort": missing it carries no automatic loss, and the Ministry\'s formal demand (催告) has never been issued to anyone. Filing 国籍選択届 selecting Japanese does not renounce US citizenship. Confirm the formal record via 戸籍謄本 (法務局 / 行政書士 can verify).',

      'ac.ics.tenYearClock.summary':                   '10-year worldwide-asset clock (永住者 status begins)',
      'ac.ics.tenYearClock.description':                'JP estate tax expands from JP-situs only to WORLDWIDE assets. Plan inheritance mitigation BEFORE this date.',

      'ac.ics.prEligibility.summary':                   '永住権 (PR) eligibility date',
      'ac.ics.prEligibility.description':                'Based on your visa + arrival date, you become eligible to apply for Japanese Permanent Residency on this date.',

      'ac.ics.decum.ss62.summary':                      'Social Security earliest claim age (62)',
      'ac.ics.decum.ss62.description':                  'Earliest you can claim US SS, with ~30% reduction below FRA. Trade-off: more years of payments but smaller monthly check.',
      'ac.ics.decum.medicare65.summary':                'Medicare eligibility (65) + IEP opens',
      'ac.ics.decum.medicare65.description':            'Initial Enrollment Period: 3 months before, the birthday month, and 3 months after. Late enrollment penalty for life if missed.',
      'ac.ics.decum.ssFra.summary':                     'Full Retirement Age for Social Security (67)',
      'ac.ics.decum.ssFra.description':                 'No early-claim reduction. Each year of further delay adds ~8% to monthly benefit until age 70.',
      'ac.ics.decum.ss70.summary':                      'Maximum SS benefit age (70)',
      'ac.ics.decum.ss70.description':                  'No further increase past 70. Claim by this date or lose the additional credits.',
      'ac.ics.decum.rmd73.summary':                     'RMD begins (73) — required minimum distributions',
      'ac.ics.decum.rmd73.description':                 'Required Minimum Distributions from pre-tax accounts begin the year you turn 73. Penalty for missing: 25% of shortfall.',
      'ac.ics.decum.description.approxSuffix':          ' (Approximate — based on current_age={{age}} from Projections inputs.)',
    });
    TB.i18n.extend('ja', {
      'ac.fbarFilingDeadline.title.overdue':     '{{year}}年分の FBAR が期限超過です(延長期限 {{octDeadline}} を経過)',
      'ac.fbarFilingDeadline.title.extended':    '{{year}}年分の FBAR は {{octDeadline}} が期限(自動延長)',
      'ac.fbarFilingDeadline.title.upcoming':    '{{year}}年分の FBAR は {{aprDeadline}} が期限',
      'ac.fbarFilingDeadline.body.overdue':      '{{year}}年分の海外口座残高は記録されていますが、提出履歴がなく、自動延長期限の {{octDeadline}} も既に経過しています。FinCEN 114 は期限超過の状態です。非故意の未提出に対する罰則は報告書1件につき最大 $16,536 — できるだけ早く提出してください。',
      'ac.fbarFilingDeadline.body.extended':     '{{year}}年分の海外口座残高は記録されていますが、提出履歴がありません。4月15日の期限は過ぎましたが、FinCEN 114 は {{octDeadline}} まで自動延長されます(別途の延長申請は不要)。非故意の未提出に対する罰則は報告書1件につき最大 $16,536。',
      'ac.fbarFilingDeadline.body.upcoming':     '{{year}}年分の海外口座残高は記録されていますが、提出履歴がありません。FinCEN 114 の期限は {{aprDeadline}}(10月15日まで自動延長)。非故意の未提出に対する罰則は報告書1件につき最大 $16,536。',

      'ac.fbarTreasuryStale.title':              '{{year}}年分の財務省レートを更新してください',
      'ac.fbarTreasuryStale.body':                '{{year}}年の財務省年末レートが未取得です。FBAR では外貨口座残高を USD に換算する際にこのレートを使用します。提出前に fiscaldata.treasury.gov から更新してください。',

      'ac.assetsStaleBalances.title.one':        '口座残高 1 件が古いままです(120日超)',
      'ac.assetsStaleBalances.title.many':       '口座残高 {{count}} 件が古いままです(120日超)',
      'ac.assetsStaleBalances.body':              '更新対象:{{names}}{{overflow}}。残高が古いままだと、すべての試算シナリオが実態より悪化します。',

      'ac.assetsSnapshotDue.first.title':        '最初のポートフォリオ・スナップショットを取得しましょう',
      'ac.assetsSnapshotDue.first.body':          'スナップショットはある時点のポートフォリオ状態を固定記録します。大きな変更の前や、年次の推移確認に有用です。',
      'ac.assetsSnapshotDue.overdue.title':       'ポートフォリオ・スナップショットを取得しましょう(前回は{{age}}日前)',
      'ac.assetsSnapshotDue.overdue.body':        '前回のスナップショットは {{date}} でした。スナップショットは年次の資産推移を追跡する手段です。',

      'ac.assetsCloseDateApproaching.title':      '{{name}} はあと {{days}} 日で解約されます',
      'ac.assetsCloseDateApproaching.body':       '口座「{{name}}」の close_date(解約日)は {{closeDate}} です{{transferNote}}。振込先の設定と銀行側の手続きを確認してください。',
      'ac.assetsCloseDateApproaching.transferNote': ' — 資金は {{transferTo}} へ移されます',

      'ac.assetsFxStale.neverFetched.title':      'ライブ FX レートが未取得です',
      'ac.assetsFxStale.neverFetched.body':       '現在は組み込みのフォールバック・レートを使用中です。「Assets」の更新ボタンから財務省のライブレートを取得してください(無料・認証不要)。',
      'ac.assetsFxStale.stale.title':             'FX レートが取得から{{age}}日経過しています',
      'ac.assetsFxStale.stale.body':               '財務省のレートは四半期ごとに更新されます。「Assets」で更新して、試算に最新レートを反映してください。',

      'ac.projQuarterlyTax.title':                '{{label}}の期限は {{date}}(あと{{days}}日)',
      'ac.projQuarterlyTax.body':                  '退職者向けの米国予定納税です。金額の目安 = (年間の米国税額)÷ 4。年間の税額試算は Projections の内訳を参照してください。',
      'ac.projQuarterlyTax.label.q1':              '第1四半期予定納税',
      'ac.projQuarterlyTax.label.q2':              '第2四半期予定納税',
      'ac.projQuarterlyTax.label.q3':              '第3四半期予定納税',
      'ac.projQuarterlyTax.label.q4':              '第4四半期(前年分)予定納税',

      'ac.projRothWindowJuminhyou.title':          'Roth コンバージョンの猶予期間 — 住民票登録まであと{{days}}日',
      'ac.projRothWindowJuminhyou.body':           '住民票の登録日を {{date}} に設定済みです。その日より前の Trad → Roth コンバージョンは米国課税のみで済みます。その日以降は日本でも総合課税(国税20-45%+住民税10%)の対象になります。Projections → Tax Strategy でコンバージョンの計画を立ててください。',

      'ac.projSsClaimWindow.title':                '社会保障(SS)受給開始の判断期間(想定受給開始年齢 {{ssAge}} 歳)',
      'ac.projSsClaimWindow.body':                 '想定している SS 受給開始年齢まで2年以内です。62歳(給付額の約70%)、67歳(FRA・満額100%)、70歳(約124%)のシナリオを Projections で比較し、最適な受給開始年齢を確認してください。',

      'ac.projRmdYear.now.title':                  'RMD 年 — 必要最低限度分配(RMD)が必要です',
      'ac.projRmdYear.now.body':                    '73歳以上は Traditional IRA / 401(k) / TSP から毎年 RMD が必要です。未実施の場合は連邦消費税25%が課されます。金融機関側で分配額の計算と設定が済んでいるか確認してください。',
      'ac.projRmdYear.approaching.title':           'RMD 開始年齢(73歳)まであと{{years}}年',
      'ac.projRmdYear.approaching.body':            '73歳前の低所得の期間に Roth コンバージョンを行うと、将来の RMD(とそれに伴う税負担)を減らせます。Projections → Tax Strategy のコンバージョン・ラダーで計画してください。',

      'ac.projCatchupTransitions.at50.title':       '来年から50歳以上のキャッチアップ拠出の対象になります',
      'ac.projCatchupTransitions.at50.body':        '通常のキャッチアップ拠出は 401(k)/403(b)/TSP に年$7,500、IRA に年$1,000 追加できます。年が変わるタイミングで給与天引き率を調整してください。',
      'ac.projCatchupTransitions.at60.title':       '来年から60-63歳向け SECURE 2.0 拡大キャッチアップが始まります',
      'ac.projCatchupTransitions.at60.body':        '401(k)/403(b)/TSP への追加額は通常の$7,500に代えて$11,250になります。64歳で通常額に戻る前に、この拡大枠を活用できるよう天引き率を調整してください。',
      'ac.projCatchupTransitions.at64.title':       '来年、拡大キャッチアップが通常の$7,500に戻ります(64歳)',
      'ac.projCatchupTransitions.at64.body':        'SECURE 2.0 拡大キャッチアップ($11,250)が使える最後の年です。使えるうちに上限まで拠出しましょう。',

      'ac.sofaPendingSteps.title.one':              '重要度の高い SOFA アクションが 1 件、未対応です',
      'ac.sofaPendingSteps.title.many':             '重要度の高い SOFA アクションが {{count}} 件、未対応です',
      'ac.sofaPendingSteps.body':                    '重要度が高い(critical/high)シーケンサーのステップが「保留」または「予定」のまま {{count}} 件あり、住民票登録まであと{{days}}日です。SOFA → Sequence で確認・実行してください。',

      'ac.profileNoName.title':                     'お名前を設定してダッシュボードをパーソナライズしましょう',
      'ac.profileNoName.body':                       'オンボーディングを再実行(ダッシュボード右下のリンク)してお名前を追加すると、ダッシュボードのタイトルに表示されます。',

      'ac.export.noEvents':                          '日付付きのイベントが見つかりませんでした。まずアクション項目・書類の有効期限・家族情報などのデータを追加してください。',

      'ac.ics.vault.summary':                        '有効期限:{{title}}',
      'ac.ics.vault.description':                     'Document Vault の項目{{notes}}',
      'ac.ics.vault.description.notesSuffix':         ':{{notes}}',

      'ac.ics.passport.summary':                      'パスポート有効期限:{{name}}({{country}})',
      'ac.ics.passport.description':                   'パスポート更新 — 渡航への支障を避けるため、有効期限の9-12か月前に申請してください。',
      'ac.ics.passport.fallbackName':                  '家族',

      'ac.ics.natChoice.summary':                      '国籍選択(20歳まで):{{name}}',
      'ac.ics.natChoice.description':                   '日本国籍法第14条 — 出生により重国籍となった者が国籍を選択するよう求められる期限。これは罰則のない「努力義務」であり、期限を過ぎても自動的な国籍喪失はなく、法務大臣による催告が行われた例はこれまでありません。国籍選択届で日本国籍を選択しても、米国籍が自動的に喪失するわけではありません。正式な記録は戸籍謄本で確認してください(法務局・行政書士に確認可能)。',

      'ac.ics.tenYearClock.summary':                   '10年ルール(全世界資産)の起算(永住者ステータス開始)',
      'ac.ics.tenYearClock.description':                '日本の相続税の課税対象が国内財産のみから全世界の財産に拡大します。この日より前に相続対策を計画してください。',

      'ac.ics.prEligibility.summary':                   '永住権(PR)申請資格取得日',
      'ac.ics.prEligibility.description':                'お持ちのビザと来日日に基づき、この日から日本の永住権を申請できる資格が得られます。',

      'ac.ics.decum.ss62.summary':                      '社会保障(SS)の最短受給開始年齢(62歳)',
      'ac.ics.decum.ss62.description':                  '米国 SS を最も早く受給できる年齢。FRA(満額支給年齢)より約30%減額されます。トレードオフ:受給期間は長くなりますが月々の受給額は少なくなります。',
      'ac.ics.decum.medicare65.summary':                'メディケア受給資格(65歳)+ IEP(加入手続き期間)開始',
      'ac.ics.decum.medicare65.description':            '当初加入期間(IEP):誕生月の3か月前から、誕生月、その3か月後まで。加入が遅れると生涯にわたる遅延加入ペナルティが発生します。',
      'ac.ics.decum.ssFra.summary':                     '社会保障(SS)の満額支給年齢(FRA・67歳)',
      'ac.ics.decum.ssFra.description':                 '早期受給による減額はありません。70歳になるまで、繰り下げ1年ごとに月々の受給額が約8%増加します。',
      'ac.ics.decum.ss70.summary':                      'SS 受給額が最大になる年齢(70歳)',
      'ac.ics.decum.ss70.description':                  '70歳を超えるとそれ以上の増額はありません。この時点までに受給を開始しないと、繰り下げによる増額分を失います。',
      'ac.ics.decum.rmd73.summary':                     'RMD 開始(73歳)— 必要最低限度分配',
      'ac.ics.decum.rmd73.description':                 '税繰り延べ口座からの必要最低限度分配(RMD)は73歳になる年から始まります。未実施の場合、不足額の25%が罰則として課されます。',
      'ac.ics.decum.description.approxSuffix':          '(概算 — Projections の入力にある current_age={{age}} を基に算出)',
    });
  }

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

  function todayIso() { return TB.utils.todayIso(); }
  function daysUntil(iso) {
    if (!iso) return Infinity;
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return Infinity;
    const t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }
  function fmtUSD(v) { return TB.utils.formatUSD(v, { maximumFractionDigits: 0 }); }

  // `projections.inputs.current_age` is a static number the user typed
  // into the Inputs tab — projections.js never stamps a capture year
  // (the once-planned `projections.startYear` field is dead: nothing
  // ever wrote it, per schema.js's canonical-names note), so without
  // this helper current_age would be frozen forever at whatever value
  // was last saved. We approximate elapsed real-world years using
  // `onboarding.completedAt` (an ISO timestamp state.js always records
  // when onboarding finishes) as a stand-in for "when this age was
  // roughly true." Not exact if the user edits current_age later
  // without re-running onboarding, but far better than a hardcoded 0.
  function yearsSinceOnboarding() {
    const completedAt = TB.state.get('onboarding.completedAt');
    if (!completedAt) return 0;
    const then = new Date(completedAt);
    if (isNaN(then.getTime())) return 0;
    const years = (new Date() - then) / (365.25 * 86400000);
    return Math.max(0, Math.floor(years));
  }

  // Look up a module's own display label from the module registry
  // (TB.modules[id], same pattern used by profile.js's track→module
  // links). This avoids the old pattern of guessing at i18n keys like
  // 'nav.' + id, which would render as raw keys when undefined.
  function moduleLabel(moduleId) {
    const mod = TB.modules && TB.modules[moduleId];
    if (!mod) return moduleId;
    return TB.i18n.getLang() === 'ja'
      ? (mod.label_jp || mod.label_en || moduleId)
      : (mod.label_en || mod.label_jp || moduleId);
  }

  // ---- FBAR generators -----------------------------------------------

  function genFbarFilingDeadline() {
    const t = TB.i18n.t;
    const out = [];
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const balances = TB.state.get('fbar.yearly_balances') || [];
    const lastYearAccts = balances.filter((b) => Number(b.year) === year - 1);
    if (lastYearAccts.length === 0) return out;

    // Has any account been "filed" for last year already? This is the
    // ONLY thing allowed to suppress this reminder — it must stay alive
    // through the automatic Oct 15 extension and indefinitely afterward
    // (a missed FBAR doesn't stop being late) until an actual filing is
    // logged, per Fix H4.
    const filings = TB.state.get('fbar.filing_history') || [];
    const filedLastYear = filings.some((f) => Number(f.year) === year - 1);
    if (filedLastYear) return out; // good, dismiss

    const aprDeadline = year + '-04-15';
    const octDeadline = year + '-10-15';
    const pastApril = month > 4;
    const pastOctober = daysUntil(octDeadline) < 0;
    const deadline = pastApril ? octDeadline : aprDeadline;
    const urgency = pastOctober ? 'critical'
      : pastApril ? (daysUntil(octDeadline) <= 30 ? 'critical' : 'high')
      : (month >= 3 ? 'critical' : 'high');
    const filedYear = year - 1;
    const title = pastOctober
      ? t('ac.fbarFilingDeadline.title.overdue', { year: filedYear, octDeadline })
      : pastApril
        ? t('ac.fbarFilingDeadline.title.extended', { year: filedYear, octDeadline })
        : t('ac.fbarFilingDeadline.title.upcoming', { year: filedYear, aprDeadline });
    const body = pastOctober
      ? t('ac.fbarFilingDeadline.body.overdue', { year: filedYear, octDeadline })
      : pastApril
        ? t('ac.fbarFilingDeadline.body.extended', { year: filedYear, octDeadline })
        : t('ac.fbarFilingDeadline.body.upcoming', { year: filedYear, aprDeadline });

    out.push({
      id: 'fbar_filing_' + (year - 1),
      group: 'fbar', urgency,
      icon: '🏦',
      title,
      body,
      deadline, module: 'fbar', snoozable: true,
    });
    return out;
  }

  function genFbarTreasuryStale() {
    const t = TB.i18n.t;
    const out = [];
    const fetchedAt = TB.state.get('settings.fx.treasury_fetched_at');
    const balances = TB.state.get('fbar.yearly_balances') || [];
    if (balances.length === 0) return out;
    const lastYear = (new Date()).getFullYear() - 1;
    const haveLastYearRates = (TB.state.get('settings.fx.treasury_rates') || {})[String(lastYear)];
    if (haveLastYearRates) return out;
    out.push({
      id: 'fbar_treasury_' + lastYear,
      group: 'fbar', urgency: 'medium', icon: '💱',
      title: t('ac.fbarTreasuryStale.title', { year: lastYear }),
      body: t('ac.fbarTreasuryStale.body', { year: lastYear }),
      module: 'fbar', snoozable: true,
    });
    return out;
  }

  // ---- Assets generators ---------------------------------------------

  function genAssetsStaleBalances() {
    const t = TB.i18n.t;
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
    const overflow = stale.length > 3 ? ' …+' + (stale.length - 3) : '';
    out.push({
      id: 'assets_stale',
      group: 'assets',
      urgency: stale.length > 3 ? 'high' : 'medium',
      icon: '⏱',
      title: stale.length > 1
        ? t('ac.assetsStaleBalances.title.many', { count: stale.length })
        : t('ac.assetsStaleBalances.title.one'),
      body: t('ac.assetsStaleBalances.body', { names, overflow }),
      module: 'assets', snoozable: true,
    });
    return out;
  }

  function genAssetsSnapshotDue() {
    const t = TB.i18n.t;
    const out = [];
    const snaps = TB.state.get('assets.snapshots') || [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    if (accts.length === 0) return out;
    if (snaps.length === 0) {
      out.push({
        id: 'assets_first_snapshot',
        group: 'assets', urgency: 'low', icon: '📸',
        title: t('ac.assetsSnapshotDue.first.title'),
        body: t('ac.assetsSnapshotDue.first.body'),
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
        title: t('ac.assetsSnapshotDue.overdue.title', { age }),
        body: t('ac.assetsSnapshotDue.overdue.body', { date: last.taken_at.slice(0, 10) }),
        module: 'assets', snoozable: true,
      });
    }
    return out;
  }

  function genAssetsCloseDateApproaching() {
    const t = TB.i18n.t;
    const out = [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    for (const a of accts) {
      if (!a.close_date) continue;
      const days = daysUntil(a.close_date);
      if (days < 0 || days > 90) continue;
      const urgency = days <= 7 ? 'critical' : days <= 30 ? 'high' : 'medium';
      const transferNote = a.transfer_to
        ? t('ac.assetsCloseDateApproaching.transferNote', { transferTo: a.transfer_to })
        : '';
      out.push({
        id: 'asset_close_' + a.id,
        group: 'assets', urgency, icon: '📅',
        title: t('ac.assetsCloseDateApproaching.title', { name: (a.name || a.institution), days }),
        body: t('ac.assetsCloseDateApproaching.body', {
          name: (a.name || '(unnamed)'),
          closeDate: a.close_date,
          transferNote,
        }),
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
    const t = TB.i18n.t;
    const out = [];
    const accts = (TB.state.get('assets.accounts') || []).filter((a) => a.active);
    if (accts.length === 0) return out;
    const fetchedAt = TB.state.get('settings.fx.current_fetched_at');
    const liveRates = TB.state.get('settings.fx.current_rates') || {};
    if (!fetchedAt || Object.keys(liveRates).length === 0) {
      out.push({
        id: 'fx_never_fetched',
        group: 'assets', urgency: 'low', icon: '💱',
        title: t('ac.assetsFxStale.neverFetched.title'),
        body: t('ac.assetsFxStale.neverFetched.body'),
        module: 'assets', snoozable: true,
      });
      return out;
    }
    const ageDays = Math.round((new Date() - new Date(fetchedAt)) / 86400000);
    if (ageDays > 120) {
      out.push({
        id: 'fx_stale',
        group: 'assets', urgency: 'low', icon: '💱',
        title: t('ac.assetsFxStale.stale.title', { age: ageDays }),
        body: t('ac.assetsFxStale.stale.body'),
        module: 'assets', snoozable: true,
      });
    }
    return out;
  }

  // ---- Projections / tax generators ---------------------------------

  function genProjQuarterlyTax() {
    const t = TB.i18n.t;
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    // Only fire if user is in retirement (drawing) AND past current_age
    const today = new Date();
    const month = today.getMonth() + 1; // 1-12
    const startYear = today.getFullYear();
    const ageNow = (inputs.current_age || 0) + yearsSinceOnboarding();
    if (ageNow < (inputs.retire_age || 65)) return out;

    // Quarterly estimated tax months: Apr (Q1), Jun (Q2), Sep (Q3), Jan (Q4-prev).
    // Fire 30 days before each due date.
    const due = [
      { month: 4,  day: 15, labelKey: 'ac.projQuarterlyTax.label.q1' },
      { month: 6,  day: 15, labelKey: 'ac.projQuarterlyTax.label.q2' },
      { month: 9,  day: 15, labelKey: 'ac.projQuarterlyTax.label.q3' },
      { month: 1,  day: 15, labelKey: 'ac.projQuarterlyTax.label.q4' },
    ];
    for (const d of due) {
      // Build the next due date
      let dueYear = startYear;
      if (d.month < month || (d.month === month && d.day < today.getDate())) dueYear = startYear + 1;
      const iso = dueYear + '-' + String(d.month).padStart(2, '0') + '-' + String(d.day).padStart(2, '0');
      const days = daysUntil(iso);
      if (days < 0 || days > 35) continue;
      out.push({
        id: 'proj_qtax_' + dueYear + '_' + d.month,
        group: 'tax', urgency: days <= 7 ? 'high' : 'medium', icon: '🇺🇸',
        title: t('ac.projQuarterlyTax.title', { label: t(d.labelKey), date: iso, days }),
        body: t('ac.projQuarterlyTax.body'),
        deadline: iso, module: 'projections', snoozable: false,
      });
    }
    return out;
  }

  function genProjRothWindowJuminhyou() {
    const t = TB.i18n.t;
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
      title: t('ac.projRothWindowJuminhyou.title', { days }),
      body: t('ac.projRothWindowJuminhyou.body', { date: sofaProfile.juminhyou_target_date }),
      deadline: sofaProfile.juminhyou_target_date,
      module: 'projections', snoozable: false,
    });
    return out;
  }

  function genProjSsClaimWindow() {
    const t = TB.i18n.t;
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    const age = (inputs.current_age || 0) + yearsSinceOnboarding();
    const ssAge = inputs.ss_start_age || 70;
    // Fire when within 2 years of selected SS start age (decision window)
    const yearsToSs = ssAge - age;
    if (yearsToSs < 0 || yearsToSs > 2) return out;
    out.push({
      id: 'proj_ss_decision',
      group: 'tax', urgency: 'medium', icon: '👴',
      title: t('ac.projSsClaimWindow.title', { ssAge }),
      body: t('ac.projSsClaimWindow.body'),
      module: 'projections', snoozable: true,
    });
    return out;
  }

  function genProjRmdYear() {
    const t = TB.i18n.t;
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    const age = (inputs.current_age || 0) + yearsSinceOnboarding();
    if (age < 70 || age > 73) return out;
    if (age >= 73) {
      out.push({
        id: 'proj_rmd_now',
        group: 'tax', urgency: 'critical', icon: '⏰',
        title: t('ac.projRmdYear.now.title'),
        body: t('ac.projRmdYear.now.body'),
        module: 'projections', snoozable: false,
      });
    } else {
      out.push({
        id: 'proj_rmd_approaching',
        group: 'tax', urgency: 'medium', icon: '⏰',
        title: t('ac.projRmdYear.approaching.title', { years: (73 - age) }),
        body: t('ac.projRmdYear.approaching.body'),
        module: 'projections', snoozable: true,
      });
    }
    return out;
  }

  function genProjCatchupTransitions() {
    const t = TB.i18n.t;
    const out = [];
    const inputs = TB.state.get('projections.inputs') || {};
    const age = (inputs.current_age || 0) + yearsSinceOnboarding();
    if (age === 49) {
      out.push({
        id: 'proj_catchup_50',
        group: 'tax', urgency: 'low', icon: '🎂',
        title: t('ac.projCatchupTransitions.at50.title'),
        body: t('ac.projCatchupTransitions.at50.body'),
        module: 'projections', snoozable: true,
      });
    } else if (age === 59) {
      out.push({
        id: 'proj_catchup_60',
        group: 'tax', urgency: 'low', icon: '🎂',
        title: t('ac.projCatchupTransitions.at60.title'),
        body: t('ac.projCatchupTransitions.at60.body'),
        module: 'projections', snoozable: true,
      });
    } else if (age === 63) {
      out.push({
        id: 'proj_catchup_64',
        group: 'tax', urgency: 'low', icon: '🎂',
        title: t('ac.projCatchupTransitions.at64.title'),
        body: t('ac.projCatchupTransitions.at64.body'),
        module: 'projections', snoozable: true,
      });
    }
    return out;
  }

  // ---- SOFA generators ----------------------------------------------

  function genSofaPendingSteps() {
    const t = TB.i18n.t;
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
      title: open.length > 1
        ? t('ac.sofaPendingSteps.title.many', { count: open.length })
        : t('ac.sofaPendingSteps.title.one'),
      body: t('ac.sofaPendingSteps.body', { count: open.length, days }),
      module: 'sofa-roth', snoozable: false,
    });
    return out;
  }

  // ---- Profile generators -------------------------------------------

  function genProfileNoName() {
    const t = TB.i18n.t;
    const out = [];
    const profile = TB.state.get('profile') || {};
    if (profile.displayName && profile.displayName.trim()) return out;
    out.push({
      id: 'profile_no_name',
      group: 'profile', urgency: 'low', icon: '✏️',
      title: t('ac.profileNoName.title'),
      body: t('ac.profileNoName.body'),
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
    dismissed[actionId] = { until: TB.utils.localIsoDate(until) };
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
        ? t('action.row.clickHint', { module: moduleLabel(action.module) })
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
        }, t('action.row.openModule', { module: moduleLabel(action.module) }) + ' →'));
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
    const t = TB.i18n.t;
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
          summary: t('ac.ics.vault.summary', { title: (it.title || it.type) }),
          description: t('ac.ics.vault.description', {
            notes: it.notes ? t('ac.ics.vault.description.notesSuffix', { notes: it.notes }) : '',
          }),
          category: 'Document',
        });
      });
    } catch (err) { /* swallow */ }

    // 3. Family — passports + nationality choice
    try {
      const members = TB.state.get('family.members') || [];
      members.forEach((m) => {
        const name = m.name_en || m.name_jp || t('ac.ics.passport.fallbackName');
        ['passport_us', 'passport_jp'].forEach((k) => {
          const pp = m[k];
          if (!pp || !pp.expires) return;
          events.push({
            uid: 'tb-pp-' + m.id + '-' + k,
            date: pp.expires,
            summary: t('ac.ics.passport.summary', { name, country: (k === 'passport_us' ? 'US' : 'JP') }),
            description: t('ac.ics.passport.description'),
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
            const dateStr = TB.utils.localIsoDate(b);
            events.push({
              uid: 'tb-natchoice-' + m.id,
              date: dateStr,
              summary: t('ac.ics.natChoice.summary', { name }),
              description: t('ac.ics.natChoice.description'),
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
            summary: t('ac.ics.tenYearClock.summary'),
            description: t('ac.ics.tenYearClock.description'),
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
            summary: t('ac.ics.prEligibility.summary'),
            description: t('ac.ics.prEligibility.description'),
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
          { target: 62, key: 'ss62', summaryKey: 'ac.ics.decum.ss62.summary', descKey: 'ac.ics.decum.ss62.description' },
          { target: 65, key: 'medicare65', summaryKey: 'ac.ics.decum.medicare65.summary', descKey: 'ac.ics.decum.medicare65.description' },
          { target: 67, key: 'ss_fra', summaryKey: 'ac.ics.decum.ssFra.summary', descKey: 'ac.ics.decum.ssFra.description' },
          { target: 70, key: 'ss70', summaryKey: 'ac.ics.decum.ss70.summary', descKey: 'ac.ics.decum.ss70.description' },
          { target: 73, key: 'rmd73', summaryKey: 'ac.ics.decum.rmd73.summary', descKey: 'ac.ics.decum.rmd73.description' },
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
            summary: t(m.summaryKey),
            description: t(m.descKey) + t('ac.ics.decum.description.approxSuffix', { age }),
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
      lines.push('DTEND;VALUE=DATE:' + icsDate(TB.utils.localIsoDate(next)));
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
      alert(TB.i18n.t('ac.export.noEvents'));
      return null;
    }
    const ics = buildIcsString(events);
    const today = TB.utils.todayIso();
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
