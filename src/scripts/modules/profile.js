/* Taigan Bridge — modules/profile.js
 *
 * Profile — the user-facing summary of their state. Used to:
 *   - See which tracks are active and WHY (derivation reasoning)
 *   - Review and verify onboarding answers grouped by category
 *   - See quick-stat tiles of how populated each module is
 *   - Jump to settings (theme, language, AI key, FX, export/import)
 *
 * Design: rich and structured rather than the previous flat dl + chip
 * strip. Each onboarding answer is rendered with a human label and
 * decoded value (e.g., "DoD Contractor" instead of "dod_contractor").
 */

(function () {
  'use strict';

  const id = 'profile';

  // ====================================================================
  // Reference data — human-readable labels for onboarding answers
  // ====================================================================

  // Maps onboarding answer KEYS to human-readable labels per language.
  const ANSWER_LABELS = {
    en: {
      display_name:             'Display name (EN)',
      display_name_ja:          'Display name (JP)',
      birth_year:               'Birth year',
      biological_sex:           'Biological sex',
      citizenship:              'Citizenship',
      in_japan:                 'Currently in Japan',
      years_in_japan:           'Years in Japan',
      visa:                     'Visa / SOFA status',
      employment:               'Employment',
      separation_date:          'Separation date',
      veteran:                  'Veteran status',
      juminhyo:                 '住民票 registered',
      tax_status:               'JP tax status',
      non_sofa_jp_income:       'Non-SOFA JP-source income',
      family:                   'Family situation',
      real_estate:              'JP real estate',
      // v2 questions
      jp_filing_responsibility: 'JP-side filing responsibility',
      healthcare_coverage:      'Healthcare coverage',
      retirement_horizon:       'Retirement horizon',
      fx_platforms:             'FX / transfer platforms',
      ai_consent:               'AI consent posture',
      consultations_history:    'CPA / advisor history',
    },
    ja: {
      display_name:             '表示名(英語)',
      display_name_ja:          '表示名(日本語)',
      birth_year:               '生年',
      biological_sex:           '生物学的性別',
      citizenship:              '市民権',
      in_japan:                 '日本居住中',
      years_in_japan:           '日本での年数',
      visa:                     'ビザ・SOFA ステータス',
      employment:               '雇用形態',
      separation_date:          '除隊日',
      veteran:                  '退役軍人ステータス',
      juminhyo:                 '住民票登録',
      tax_status:               '日本税務ステータス',
      non_sofa_jp_income:       'SOFA 対象外の日本所得',
      family:                   '家族構成',
      real_estate:              '日本の不動産',
      // v2 questions
      jp_filing_responsibility: '日本側申告担当',
      healthcare_coverage:      '医療カバレッジ',
      retirement_horizon:       'リタイア時期',
      fx_platforms:             'FX・送金プラットフォーム',
      ai_consent:               'AI 利用方針',
      consultations_history:    'CPA・専門家の利用歴',
    },
  };

  // Maps onboarding answer VALUES (the underscored slugs) to friendly
  // display labels per key. Used to decode "dod_contractor" → "DoD
  // Contractor", etc.
  const VALUE_LABELS = {
    en: {
      // citizenship
      us_only:   'US citizen only',
      us_dual:   'Dual citizen (US + another)',
      us_lpr:    'US Lawful Permanent Resident',
      us_jp_dual: 'US-Japan dual citizen',
      // in_japan
      yes:       'Yes',
      no:        'No',
      partial:   'Yes, part of the year',
      planning:  'Not yet — planning to move',
      // years_in_japan
      under_1:   'Less than 1 year',
      '1_to_5':  '1–5 years',
      '5_to_10': '5–10 years',
      over_10:   'More than 10 years',
      na:        'Not applicable',
      // visa
      sofa:        'SOFA (US-Japan Status of Forces Agreement)',
      spouse_jp:   'Spouse of Japanese national',
      work:        'Work visa',
      permanent:   'Permanent Resident',
      long_term:   'Long-Term Resident (定住者)',
      other:       'Other / outside Japan',
      // employment
      dod_active:     'Active duty US military',
      dod_civilian:   'DoD Civilian',
      dod_contractor: 'DoD Contractor',
      us_company:     'US-company expat in Japan',
      japan_company:  'Japanese company employee',
      self:           'Self-employed / business owner',
      retired_mil:    'Retired military',
      retired_civ:    'Retired civilian',
      // veteran
      active:               'Active duty (currently serving)',
      reserve_ng:           'Reserve / National Guard',
      retired:              'Retired (20+ years OR medical retirement)',
      separated_no_dis:     'Separated — no VA disability rating',
      separated_with_dis:   'Separated — with VA disability rating',
      // juminhyo
      unsure:               'Unsure',
      // tax_status
      japan_resident:       'Japan tax resident',
      japan_filer:          'Non-permanent resident filer',
      sofa_no_file:         'SOFA — not filing in Japan',
      // family
      none:           'None of these / single',
      us_spouse:      'US-citizen spouse',
      jp_spouse:      'Japanese-national spouse',
      third_spouse:   'Spouse of another nationality',
      us_children:    'US-citizen children',
      jp_children:    'Japanese-citizen children',
      dual_children:  'Dual-citizen children (US + Japan)',
      // real_estate
      expected:       'Expect to inherit JP property',
      // jp_filing_responsibility
      auto:           'Auto-detect',
      spouse:         'Spouse / family handles JP-side',
      // biological_sex
      female:              'Female',
      male:                'Male',
      prefer_not_to_say:   'Prefer not to say',
      // healthcare_coverage
      nhi:            '国民健康保険 (NHI)',
      shi:            '社会保険・健康保険 (employer SHI)',
      tricare:        'TRICARE',
      private_intl:   'International plan (incl. employer-provided)',
      us_employer:    'US-domestic employer plan',
      fehb:           'FEHB (Federal Employees Health Benefits)',
      medicare:       'Medicare',
      va_fmp:         'VA Foreign Medical Program',
      // retirement_horizon
      already:        'Already retired',
      lt5y:           'Within 5 years',
      '5_15y':        '5–15 years',
      '15_30y':       '15–30 years',
      gt30y:          '30+ years',
      // fx_platforms
      wise:           'Wise',
      revolut:        'Revolut',
      sony_bank:      'Sony Bank',
      shinsei:        'Shinsei / SBI Shinsei',
      rakuten:        'Rakuten Bank',
      remitly:        'Remitly',
      westernunion:   'Western Union / MoneyGram',
      usaa:           'USAA wire',
      navy_fed:       'Navy Federal wire',
      broker:         'Brokerage wire',
      crypto:         'Crypto rails',
      // ai_consent
      full:           'Full — all AI features enabled',
      per_call:       'Per-call confirm before each AI request',
      vision_only:    'Vision only — document extraction only',
      off:            'Off — disable all AI',
      // consultations_history
      cpa_us_intl:    'US CPA (international)',
      cpa_us:         'US CPA (general)',
      tax_jp:         '税理士 (JP tax accountant)',
      multiple:       'Multiple professionals',
      no_yet:         'Not yet',
      no_diy:         'No — file myself',
    },
    ja: {
      us_only: '米国市民のみ', us_dual: '二重国籍(米国+他)', us_lpr: '米国永住権', us_jp_dual: '日米二重国籍',
      yes: 'はい', no: 'いいえ', partial: '年の一部', planning: '移住計画中',
      under_1: '1年未満', '1_to_5': '1〜5年', '5_to_10': '5〜10年', over_10: '10年以上', na: '該当なし',
      sofa: 'SOFA(日米地位協定)', spouse_jp: '日本人の配偶者', work: '就労ビザ', permanent: '永住者',
      long_term: '定住者', other: 'その他・国外',
      dod_active: '現役米軍', dod_civilian: '国防総省文官', dod_contractor: '国防総省契約職員',
      us_company: '米系企業の駐在', japan_company: '日系企業勤務', self: '自営・経営者',
      retired_mil: '退役軍人(年金受給)', retired_civ: '退職(民間)',
      active: '現役', reserve_ng: '予備役・州兵', retired: '退役者(20年以上または医療退役)',
      separated_no_dis: '除隊済み — VA 障害認定なし', separated_with_dis: '除隊済み — VA 障害認定あり',
      unsure: '不明',
      japan_resident: '日本納税居住者', japan_filer: '非永住者として申告', sofa_no_file: 'SOFA — 日本未申告',
      none: '該当なし', us_spouse: '米国市民の配偶者', jp_spouse: '日本人の配偶者',
      third_spouse: '他国籍の配偶者', us_children: '米国籍の子', jp_children: '日本国籍の子',
      dual_children: '日米二重国籍の子',
      expected: '日本不動産を相続予定',
      // v2 values
      auto: '自動判定', spouse: '配偶者・家族が担当',
      female: '女性', male: '男性', prefer_not_to_say: '回答しない',
      nhi: '国民健康保険(NHI)', shi: '社会保険・健康保険',
      tricare: 'TRICARE', private_intl: '国際保険(雇用主提供含む)',
      us_employer: '米国国内向け企業プラン', fehb: 'FEHB(連邦職員健康給付)',
      medicare: 'Medicare', va_fmp: 'VA 海外医療プログラム',
      already: 'リタイア済み', lt5y: '5 年以内',
      '5_15y': '5〜15 年', '15_30y': '15〜30 年', gt30y: '30 年以上',
      wise: 'Wise', revolut: 'Revolut', sony_bank: 'ソニー銀行',
      shinsei: '新生・SBI 新生', rakuten: '楽天銀行', remitly: 'Remitly',
      westernunion: 'Western Union / MoneyGram', usaa: 'USAA 海外送金',
      navy_fed: 'Navy Federal 海外送金', broker: '証券会社の海外送金',
      crypto: '暗号資産',
      full: 'フル(すべて有効)',
      per_call: '呼び出しごとに確認',
      vision_only: '画像のみ',
      off: 'オフ(AI 機能無効)',
      cpa_us_intl: '米国 CPA(国際)', cpa_us: '米国 CPA(一般)',
      tax_jp: '税理士', multiple: '複数の専門家',
      no_yet: 'まだ', no_diy: '自分で申告',
    },
  };

  function decodeValue(key, value, lang) {
    if (Array.isArray(value)) {
      return value.map((v) => decodeValue(key, v, lang)).join(', ');
    }
    if (value == null || value === '') return '—';
    const labels = (VALUE_LABELS[lang] || VALUE_LABELS.en);
    if (labels[value]) return labels[value];
    return String(value);
  }

  function answerLabel(key, lang) {
    return (ANSWER_LABELS[lang] || ANSWER_LABELS.en)[key] || key;
  }

  // ====================================================================
  // Track derivation reasoning — explains WHY each track was assigned
  // ====================================================================

  function trackReasoning(trackId, answers, lang) {
    const fam = Array.isArray(answers.family) ? answers.family : [answers.family].filter(Boolean);
    const reasons = [];
    if (trackId === 'sofa') {
      if (answers.employment === 'dod_active') reasons.push(lang === 'ja' ? '現役米軍' : 'Active duty military');
      else if (answers.employment === 'dod_civilian') reasons.push(lang === 'ja' ? '国防総省文官' : 'DoD Civilian employment');
      else if (answers.employment === 'dod_contractor') reasons.push(lang === 'ja' ? '国防総省契約職員' : 'DoD Contractor employment');
      if (answers.visa === 'sofa') reasons.push(lang === 'ja' ? 'SOFA ビザ選択' : 'SOFA visa selected');
      if (answers.juminhyo === 'no') reasons.push(lang === 'ja' ? '住民票未登録' : '住民票 not yet registered');
    } else if (trackId === 'veteran') {
      if (answers.veteran && answers.veteran !== 'no') {
        reasons.push((lang === 'ja' ? '退役軍人ステータス: ' : 'Veteran status: ') +
          decodeValue('veteran', answers.veteran, lang));
      }
    } else if (trackId === 'resident') {
      if (answers.tax_status === 'japan_resident' || answers.tax_status === 'japan_filer') {
        reasons.push((lang === 'ja' ? '税務ステータス: ' : 'Tax status: ') +
          decodeValue('tax_status', answers.tax_status, lang));
      }
      if (answers.juminhyo === 'yes') reasons.push(lang === 'ja' ? '住民票登録済み' : '住民票 registered');
      if (answers.years_in_japan === '5_to_10' || answers.years_in_japan === 'over_10') {
        reasons.push((lang === 'ja' ? '日本居住: ' : 'Years in Japan: ') +
          decodeValue('years_in_japan', answers.years_in_japan, lang));
      }
    } else if (trackId === 'family') {
      if (fam.indexOf('jp_spouse') !== -1) reasons.push(lang === 'ja' ? '日本人の配偶者' : 'Japanese spouse');
      if (fam.indexOf('dual_children') !== -1) reasons.push(lang === 'ja' ? '日米二重国籍の子' : 'Dual-citizen children');
      if (fam.indexOf('jp_children') !== -1) reasons.push(lang === 'ja' ? '日本国籍の子' : 'Japanese-citizen children');
    } else if (trackId === 'property') {
      if (answers.real_estate === 'yes') reasons.push(lang === 'ja' ? '日本の不動産所有' : 'Owns JP property');
      if (answers.real_estate === 'expected') reasons.push(lang === 'ja' ? '相続予定' : 'Expected inheritance');
    } else if (trackId === 'core') {
      reasons.push(lang === 'ja' ? '基本設定(他のトラック未該当時のフォールバック)' : 'Default fallback (no other tracks matched)');
    }
    return reasons.length > 0 ? reasons : [lang === 'ja' ? '理由不明' : 'No specific trigger recorded'];
  }

  // ====================================================================
  // Module population check — quick "how many modules have data?"
  // ====================================================================

  function moduleStatus() {
    const status = [];
    const accounts = (TB.state.get('assets.accounts') || []).length;
    const fbarAccounts = (TB.state.get('fbar.accounts') || []).length;
    const docs = (TB.state.get('documentVault.items') || []).length;
    const familyMembers = (TB.state.get('family.members') || []).length;
    const properties = (TB.state.get('property.properties') || []).length;
    const snapshots = (TB.state.get('assets.snapshots') || []).length;
    const giftLog = (TB.state.get('family.gifts_log') || []).length;
    const conversations = (TB.state.get('ai_assistant.conversations') || []).length;

    function row(label, count, unitEn, unitJa) {
      const lang = TB.i18n.getLang();
      return { label, count, unit: lang === 'ja' ? unitJa : unitEn, populated: count > 0 };
    }
    status.push(row(TB.i18n.t('profile.modstat.assets'),    accounts,      'accounts',  '口座'));
    status.push(row(TB.i18n.t('profile.modstat.fbar'),       fbarAccounts,  'accounts',  '口座'));
    status.push(row(TB.i18n.t('profile.modstat.docs'),       docs,          'items',     '件'));
    status.push(row(TB.i18n.t('profile.modstat.family'),     familyMembers, 'members',   '名'));
    status.push(row(TB.i18n.t('profile.modstat.property'),   properties,    'properties','件'));
    status.push(row(TB.i18n.t('profile.modstat.snapshots'),  snapshots,     'snapshots', '件'));
    status.push(row(TB.i18n.t('profile.modstat.gifts'),      giftLog,       'entries',   '件'));
    status.push(row(TB.i18n.t('profile.modstat.ai_chats'),   conversations, 'chats',     '会話'));
    return status;
  }

  // ====================================================================
  // Render
  // ====================================================================

  function render(container) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    container.innerHTML = '';

    const onboarding = TB.state.get('onboarding') || {};
    const answers = onboarding.answers || {};
    const tracks = TB.state.get('tracks') || [];
    const profileState = TB.state.get('profile') || {};
    const completedAt = onboarding.completedAt
      ? TB.utils.formatDate(onboarding.completedAt, lang)
      : null;

    if (!onboarding.complete) {
      container.appendChild(
        el('div', { class: 'tb-card', 'data-track': 'core' },
          el('h2', null, t('profile.title')),
          el('p', { class: 'tb-wizard-help' }, t('profile.empty')),
          el('div', { class: 'tb-btn-row' },
            el('button', {
              class: 'tb-btn',
              onclick: () => document.dispatchEvent(new CustomEvent('tb:start-onboarding')),
            }, t('onboarding.start')),
          ),
        ),
      );
      return;
    }

    container.appendChild(buildHeaderCard(profileState, completedAt));
    container.appendChild(buildQuickStatsCard());
    container.appendChild(buildTracksCard(tracks, answers, lang));
    container.appendChild(buildAnswersCard(answers, lang));
    container.appendChild(buildModuleStatusCard());
    container.appendChild(buildSettingsShortcutsCard());
    container.appendChild(buildDataCard());
  }

  // ─── Header — name + initials avatar + completion date ──────────

  function buildHeaderCard(profileState, completedAt) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const nameEn = (profileState.displayName || '').trim();
    const nameJa = (profileState.displayNameJa || '').trim();
    const displayName = lang === 'ja'
      ? (nameJa || nameEn || t('profile.no_name'))
      : (nameEn || t('profile.no_name'));

    // Initials avatar — first letter of EN name (or '?' if blank)
    const initial = (nameEn || nameJa || '?').trim().slice(0, 2).toUpperCase();

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    const row = el('div', {
      style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-4)', flexWrap: 'wrap' },
    });
    // Avatar circle
    row.appendChild(el('div', {
      style: {
        width: '64px', height: '64px',
        borderRadius: '50%',
        background: 'var(--tb-navy)',
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: '700', fontSize: 'var(--tb-fs-22)',
        flexShrink: '0',
      },
    }, initial));
    // Name + completion date
    const nameCol = el('div', { style: { flex: '1', minWidth: '180px' } });
    nameCol.appendChild(el('h1', { style: { margin: 0, fontSize: 'var(--tb-fs-22)' } }, displayName));
    if (nameEn && nameJa && nameEn !== nameJa) {
      nameCol.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
        lang === 'ja' ? nameEn : nameJa));
    }
    if (completedAt) {
      nameCol.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
        t('profile.onboarded_on') + ': ' + completedAt));
    }
    row.appendChild(nameCol);
    card.appendChild(row);
    return card;
  }

  // ─── Quick stats — at-a-glance numbers ──────────────────────────

  function buildQuickStatsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const tracks = TB.state.get('tracks') || [];
    const unlocked = TB.state.get('modules.unlocked') || [];
    let actionCount = 0;
    try {
      if (TB.actionCenter && typeof TB.actionCenter.deriveActions === 'function') {
        actionCount = TB.actionCenter.deriveActions().length;
      }
    } catch (err) { /* swallow */ }

    let lastReview = null;
    try {
      const reviews = TB.state.get('net_worth.reviews') || [];
      if (reviews.length > 0) lastReview = reviews[reviews.length - 1].completed_at;
    } catch (err) { /* swallow */ }

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📊 ' + t('profile.section.quickstats')));

    function tile(label, value, hint, color) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
          borderTop: '3px solid ' + (color || 'var(--tb-slate)'),
        },
      },
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } }, label),
        el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-22)', fontFamily: 'var(--tb-font-mono)' } }, value),
        hint ? el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginTop: '4px' } }, hint) : null,
      );
    }
    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--tb-sp-3)' },
    });
    grid.appendChild(tile(t('profile.stat.tracks'), String(tracks.length),
      tracks.length > 0 ? t('profile.stat.tracks_active') : null));
    grid.appendChild(tile(t('profile.stat.modules'), String(unlocked.length),
      t('profile.stat.modules_unlocked')));
    grid.appendChild(tile(t('profile.stat.actions'), String(actionCount),
      actionCount > 0 ? t('profile.stat.actions_open') : t('profile.stat.actions_caught_up'),
      actionCount > 0 ? 'var(--tb-warn)' : 'var(--tb-success)'));
    grid.appendChild(tile(t('profile.stat.last_review'),
      lastReview ? new Date(lastReview).toLocaleDateString() : '—',
      lastReview ? null : t('profile.stat.last_review_none')));
    card.appendChild(grid);
    return card;
  }

  // ─── Tracks card with derivation reasoning ──────────────────────

  function buildTracksCard(tracks, answers, lang) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🧭 ' + t('profile.section.tracks')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('profile.tracks.intro')));

    if (tracks.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('profile.tracks.empty')));
      return card;
    }

    tracks.forEach((tk) => {
      const reasons = trackReasoning(tk, answers, lang);
      const label = (TB.tracks && typeof TB.tracks.trackLabel === 'function')
        ? TB.tracks.trackLabel(tk, lang) : tk;
      // Build the row — track name on left with colored chip, reasoning on right
      const row = el('div', {
        style: {
          display: 'grid', gridTemplateColumns: '180px 1fr', gap: 'var(--tb-sp-3)',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', alignItems: 'baseline',
        },
        'data-track': tk,
      });
      // Left: chip showing track color + name (with explicit fallback
      // to prevent the "blank chip" render bug)
      row.appendChild(el('span', {
        class: 'tb-badge tb-badge--track',
        'data-track': tk,
        style: {
          display: 'inline-block',
          padding: '4px 10px',
          fontWeight: '700',
          fontSize: 'var(--tb-fs-12)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: '#fff',
          background: 'var(--tb-track, var(--tb-navy))',
          borderRadius: 'var(--tb-radius-pill)',
          textAlign: 'center',
          alignSelf: 'start',
        },
      }, label || tk.toUpperCase()));
      // Right: derivation reasons + module link
      const rightCol = el('div', null);
      rightCol.appendChild(el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '4px' } },
        t('profile.tracks.triggered_by') + ':'));
      const ul = el('ul', { style: { paddingLeft: '20px', margin: 0 } });
      reasons.forEach((r) => ul.appendChild(el('li', { style: { fontSize: 'var(--tb-fs-14)' } }, r)));
      rightCol.appendChild(ul);
      // Module link if any
      const moduleId = ({ sofa: 'sofa-roth', veteran: 'veteran', resident: 'resident', family: 'family', property: 'property' })[tk];
      if (moduleId && TB.modules && TB.modules[moduleId]) {
        rightCol.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-2)' } },
          el('a', { href: '#', style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' },
            onclick: (e) => {
              e.preventDefault();
              document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: moduleId } }));
            } }, '↗ ' + t('profile.tracks.open_module'))));
      }
      row.appendChild(rightCol);
      card.appendChild(row);
    });

    return card;
  }

  // ─── Onboarding answers — grouped by category, decoded values ──

  function buildAnswersCard(answers, lang) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const groups = [
      { id: 'identity',    label: t('profile.group.identity'),
        keys: ['display_name', 'display_name_ja', 'birth_year', 'biological_sex', 'citizenship'] },
      { id: 'residency',   label: t('profile.group.residency'),
        keys: ['in_japan', 'years_in_japan', 'visa', 'juminhyo', 'tax_status', 'non_sofa_jp_income'] },
      { id: 'employment',  label: t('profile.group.employment'),
        keys: ['employment'] },
      { id: 'veteran',     label: t('profile.group.veteran'),
        keys: ['veteran', 'separation_date'] },
      { id: 'family',      label: t('profile.group.family'),
        keys: ['family', 'jp_filing_responsibility'] },
      { id: 'property',    label: t('profile.group.property'),
        keys: ['real_estate'] },
      // New v2 question groups
      { id: 'health',      label: t('profile.group.health'),
        keys: ['healthcare_coverage'] },
      { id: 'planning',    label: t('profile.group.planning'),
        keys: ['retirement_horizon', 'consultations_history'] },
      { id: 'tools',       label: t('profile.group.tools'),
        keys: ['fx_platforms', 'ai_consent'] },
    ];

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '📝 ' + t('profile.section.answers')),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => document.dispatchEvent(new CustomEvent('tb:start-onboarding')),
      }, '↻ ' + t('profile.rerun')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('profile.answers.intro')));

    groups.forEach((g) => {
      // Only render group if it has at least one answered key
      const filledKeys = g.keys.filter((k) =>
        answers[k] != null && answers[k] !== '' &&
        !(Array.isArray(answers[k]) && answers[k].length === 0));
      if (filledKeys.length === 0) return;

      card.appendChild(el('div', {
        style: {
          marginTop: 'var(--tb-sp-3)', marginBottom: 'var(--tb-sp-2)',
          fontSize: '11px', fontWeight: '600', letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--tb-text-soft)',
        },
      }, g.label));

      // Render every key in the group, even if unanswered, so the user
      // sees the full set of questions and can fill in gaps via the
      // edit pencil. Filled and unanswered rows render differently
      // (dim placeholder for the latter).
      const dl = el('dl', { class: 'tb-dl' });
      g.keys.forEach((k) => {
        const isAnswered = answers[k] != null && answers[k] !== '' &&
          !(Array.isArray(answers[k]) && answers[k].length === 0);
        // Only show unanswered rows for v2 questions (the new ones we
        // expect users to fill in). Skip unanswered rows for legacy v1
        // questions to keep the card tidy for users who haven't re-run.
        const isV2Question = ['jp_filing_responsibility', 'healthcare_coverage',
          'retirement_horizon', 'fx_platforms', 'ai_consent',
          'consultations_history', 'non_sofa_jp_income',
          'birth_year', 'biological_sex'].indexOf(k) !== -1;
        if (!isAnswered && !isV2Question) return;
        const dt = el('dt', null, answerLabel(k, lang));
        const valueNode = isAnswered
          ? el('span', null, decodeValue(k, answers[k], lang))
          : el('em', { style: { color: 'var(--tb-text-soft)' } }, t('profile.answers.not_set'));
        const editBtn = el('button', {
          class: 'tb-btn tb-btn--ghost',
          type: 'button',
          title: t('profile.answers.edit_one'),
          'aria-label': t('profile.answers.edit_one'),
          style: {
            padding: '0 6px', marginLeft: 'var(--tb-sp-2)',
            fontSize: '12px', color: 'var(--tb-text-soft)',
          },
          onclick: () => {
            if (TB.onboarding && typeof TB.onboarding.startEditOne === 'function') {
              TB.onboarding.startEditOne(k, 'profile');
            } else {
              document.dispatchEvent(new CustomEvent('tb:start-onboarding'));
            }
          },
        }, '✎');
        const dd = el('dd', null, valueNode, editBtn);
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      card.appendChild(dl);
    });

    return card;
  }

  // ─── Module population overview ─────────────────────────────────

  function buildModuleStatusCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const status = moduleStatus();
    const populated = status.filter((s) => s.populated).length;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📦 ' + t('profile.section.modstat')));
    card.appendChild(el('p', { class: 'tb-card-meta' },
      t('profile.modstat.intro', { populated, total: status.length })));

    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--tb-sp-2)' },
    });
    status.forEach((s) => {
      grid.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid ' + (s.populated ? 'var(--tb-success)' : 'var(--tb-text-soft)'),
        },
      },
        el('span', { style: { fontWeight: s.populated ? '600' : '400',
          color: s.populated ? 'var(--tb-text)' : 'var(--tb-text-soft)' } },
          (s.populated ? '✓ ' : '○ ') + s.label),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)',
          color: s.populated ? 'var(--tb-text)' : 'var(--tb-text-soft)' } },
          s.count + ' ' + s.unit),
      ));
    });
    card.appendChild(grid);

    return card;
  }

  // ─── Settings shortcuts ────────────────────────────────────────

  function buildSettingsShortcutsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const settings = TB.state.get('settings') || {};
    const apiKeySet = !!(settings.apiKey && settings.apiKey.startsWith('sk-ant-'));
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚙ ' + t('profile.section.settings')));

    function shortcut(label, value, valueColor, action) {
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } }, label),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px',
          color: valueColor || 'var(--tb-text-soft)' } }, value),
      ));
      if (action) {
        row.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
          onclick: action,
        }, '↗ ' + t('profile.settings.open')));
      }
      return row;
    }

    card.appendChild(shortcut(
      t('profile.settings.api_key'),
      apiKeySet ? '✓ ' + t('profile.settings.api_key_set') : '⚠ ' + t('profile.settings.api_key_missing'),
      apiKeySet ? 'var(--tb-success)' : 'var(--tb-warn)',
      () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } })),
    ));
    card.appendChild(shortcut(
      t('profile.settings.theme'),
      (document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? t('profile.settings.theme_dark') : t('profile.settings.theme_light'),
      null,
      () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        const next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('tb-theme', next); } catch (e) { /* ignore */ }
      },
    ));
    card.appendChild(shortcut(
      t('profile.settings.language'),
      lang === 'ja' ? '日本語' : 'English',
      null,
      () => TB.i18n.setLang(lang === 'en' ? 'ja' : 'en'),
    ));
    return card;
  }

  // ─── Data management ───────────────────────────────────────────

  function buildDataCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '💾 ' + t('profile.section.data')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('profile.data.intro')));

    const btnRow = el('div', { class: 'tb-btn-row', style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } });
    btnRow.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)', padding: '6px 12px' },
      onclick: () => {
        const json = TB.state.export();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'taigan-bridge-state-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },
    }, '⬇ ' + t('profile.data.export')));
    btnRow.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)', padding: '6px 12px' },
      onclick: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = (e) => {
          const f = e.target.files[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              if (!confirm(t('profile.data.import_confirm'))) return;
              TB.state.import(reader.result);
              alert(t('profile.data.import_success'));
              render(document.getElementById('tb-view'));
            } catch (err) {
              alert(t('profile.data.import_error') + ': ' + err.message);
            }
          };
          reader.readAsText(f);
        };
        input.click();
      },
    }, '⬆ ' + t('profile.data.import')));
    btnRow.appendChild(el('button', {
      class: 'tb-btn tb-btn--ghost', type: 'button',
      style: { fontSize: 'var(--tb-fs-12)', padding: '6px 12px' },
      onclick: () => document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } })),
    }, t('profile.data.open_settings')));
    card.appendChild(btnRow);

    return card;
  }

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = { id, label_en: 'Profile', label_jp: 'プロフィール', render };
})();
