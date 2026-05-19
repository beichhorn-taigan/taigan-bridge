/* Taigan Bridge — modules/document-vault.js
 *
 * Document Vault — INVENTORY of important documents (passport, will,
 * deed, tax returns, etc.) with extracted metadata, expiry tracking,
 * and storage location. Pairs with the Survivor Binder.
 *
 * Inventory-only by design: we don't store the actual file bytes,
 * just the extracted fields + a free-form storage location ("safe
 * deposit box at Mizuho 渋谷", "iCloud Drive / Documents / Tax",
 * "physical fireproof box top shelf"). Keeps localStorage light AND
 * keeps sensitive scans off the device. Vision extraction is the
 * speed-of-entry tool, not a storage tool.
 *
 * Action Center integration:
 *   • passport_us / passport_jp expiring within 6 months → action
 *   • drivers_license / residence_card / visa within 90 days → action
 *   • will not updated in 5+ years → action
 *   • Critical missing docs (no passport, no will) → low-priority action
 *
 * Survivor Binder integration: docs surface in the printed binder
 * grouped by category, with title / expiry / storage location.
 */

(function () {
  'use strict';

  const id = 'document-vault';

  // ====================================================================
  // Taxonomy
  // ====================================================================

  const CATEGORIES = [
    { id: 'identification', emoji: '🪪', label_en: 'Identification',     label_jp: '身分証明書' },
    { id: 'immigration',    emoji: '🛂', label_en: 'Immigration / Visa', label_jp: '入国管理・ビザ' },
    { id: 'family',         emoji: '👨‍👩‍👧', label_en: 'Family',         label_jp: '家族' },
    { id: 'military_sofa',  emoji: '🪖', label_en: 'Military / SOFA',    label_jp: '軍関連・SOFA' },
    { id: 'estate',         emoji: '📜', label_en: 'Estate planning',    label_jp: '相続・遺言' },
    { id: 'property',       emoji: '🏠', label_en: 'Property',           label_jp: '不動産' },
    { id: 'insurance',      emoji: '🛡️', label_en: 'Insurance',          label_jp: '保険' },
    { id: 'tax',            emoji: '🧾', label_en: 'Tax records',        label_jp: '税務書類' },
    { id: 'medical',        emoji: '🏥', label_en: 'Medical',            label_jp: '医療' },
    { id: 'legal',          emoji: '⚖️', label_en: 'Legal',              label_jp: '法務' },
    { id: 'other',          emoji: '📄', label_en: 'Other',              label_jp: 'その他' },
  ];

  const TYPES = {
    passport_us:           { cat: 'identification', label_en: 'US Passport',                label_jp: '米国パスポート',       expirable: true },
    passport_jp:           { cat: 'identification', label_en: 'Japanese Passport',          label_jp: '日本国パスポート',     expirable: true },
    passport_other:        { cat: 'identification', label_en: 'Other Passport',             label_jp: 'その他パスポート',     expirable: true },
    drivers_license_us:    { cat: 'identification', label_en: 'US Driver\'s License',       label_jp: '米国運転免許証',       expirable: true },
    drivers_license_jp:    { cat: 'identification', label_en: 'Japanese Driver\'s License', label_jp: '日本運転免許証',       expirable: true },
    drivers_license_intl:  { cat: 'identification', label_en: 'International Driving Permit', label_jp: '国際運転免許証',     expirable: true },
    residence_card_jp:     { cat: 'immigration',    label_en: 'Japanese Residence Card (在留カード)', label_jp: '在留カード', expirable: true },
    my_number_card_jp:     { cat: 'identification', label_en: 'My Number Card (マイナンバー)', label_jp: 'マイナンバーカード', expirable: true },
    ssn_card:              { cat: 'identification', label_en: 'Social Security Card',       label_jp: '社会保障カード',       expirable: false },
    naturalization_cert:   { cat: 'immigration',    label_en: 'Naturalization Certificate', label_jp: '帰化証明書',           expirable: false },
    green_card:            { cat: 'immigration',    label_en: 'US Green Card (LPR)',        label_jp: '米国永住権カード',     expirable: true },
    visa:                  { cat: 'immigration',    label_en: 'Visa',                       label_jp: 'ビザ',                 expirable: true },
    dd214:                 { cat: 'military_sofa',  label_en: 'DD-214',                     label_jp: 'DD-214',               expirable: false },
    military_id:           { cat: 'military_sofa',  label_en: 'Military ID',                label_jp: '軍人身分証',           expirable: true },
    sofa_orders:           { cat: 'military_sofa',  label_en: 'SOFA Orders',                label_jp: 'SOFA 命令書',          expirable: false },
    birth_cert:            { cat: 'family',         label_en: 'Birth Certificate',          label_jp: '出生証明書',           expirable: false },
    marriage_cert:         { cat: 'family',         label_en: 'Marriage Certificate',       label_jp: '婚姻証明書',           expirable: false },
    divorce_decree:        { cat: 'family',         label_en: 'Divorce Decree',             label_jp: '離婚判決書',           expirable: false },
    will:                  { cat: 'estate',         label_en: 'Will',                       label_jp: '遺言書',               expirable: false },
    trust_doc:             { cat: 'estate',         label_en: 'Trust Document',             label_jp: '信託書類',             expirable: false },
    poa:                   { cat: 'estate',         label_en: 'Power of Attorney',          label_jp: '委任状(POA)',         expirable: false },
    advance_directive:     { cat: 'estate',         label_en: 'Advance Directive / Living Will', label_jp: '事前指示書',       expirable: false },
    beneficiary_designation: { cat: 'estate',       label_en: 'Beneficiary Designation',    label_jp: '受取人指定書',         expirable: false },
    property_deed:         { cat: 'property',       label_en: 'Property Deed',              label_jp: '不動産権利証',         expirable: false },
    mortgage_doc:          { cat: 'property',       label_en: 'Mortgage Document',          label_jp: '住宅ローン書類',       expirable: false },
    vehicle_title:         { cat: 'property',       label_en: 'Vehicle Title',              label_jp: '自動車所有権証書',     expirable: false },
    insurance_health:      { cat: 'insurance',      label_en: 'Health Insurance',           label_jp: '健康保険',             expirable: true },
    insurance_life:        { cat: 'insurance',      label_en: 'Life Insurance',             label_jp: '生命保険',             expirable: false },
    insurance_auto:        { cat: 'insurance',      label_en: 'Auto Insurance',             label_jp: '自動車保険',           expirable: true },
    insurance_home:        { cat: 'insurance',      label_en: 'Home Insurance',             label_jp: '住宅保険',             expirable: true },
    tax_return_us:         { cat: 'tax',            label_en: 'US Tax Return',              label_jp: '米国納税申告書',       expirable: false },
    tax_return_jp:         { cat: 'tax',            label_en: 'Japan Tax Return (確定申告)', label_jp: '確定申告書',           expirable: false },
    fbar_confirmation:     { cat: 'tax',            label_en: 'FBAR BSA Confirmation',      label_jp: 'FBAR 受領確認',        expirable: false },
    w2:                    { cat: 'tax',            label_en: 'W-2',                        label_jp: 'W-2 源泉徴収票',       expirable: false },
    ten99:                 { cat: 'tax',            label_en: '1099 Form',                  label_jp: '1099 フォーム',        expirable: false },
    employment_contract:   { cat: 'legal',          label_en: 'Employment Contract',        label_jp: '雇用契約書',           expirable: false },
    vaccination_record:    { cat: 'medical',        label_en: 'Vaccination Record',         label_jp: '予防接種記録',         expirable: false },
    medical_record:        { cat: 'medical',        label_en: 'Medical Record',             label_jp: '診療記録',             expirable: false },
    other:                 { cat: 'other',          label_en: 'Other',                      label_jp: 'その他',               expirable: false },
  };

  // Renewal checklists. Per document type, the typical "what do I need
  // to gather + where do I go" for a renewal. Surfaced in the edit
  // modal as a collapsible section + by the Action Center generators
  // when the document is approaching expiry. Bilingual; fact-checked
  // against US State Department + 日本国外務省 + 警視庁 public guidance.
  const RENEWAL_CHECKLISTS = {
    passport_us: {
      where_en: 'US Embassy Tokyo / US Consulates (Osaka-Kobe, Naha, Sapporo, Fukuoka). DS-82 by mail if no name change + previous passport issued at age 16+ within last 15 years; otherwise DS-11 in person.',
      where_jp: '東京の米国大使館 / 領事館(大阪・神戸・那覇・札幌・福岡)。改名なし + 16 歳以上で発行された前パスポートが 15 年以内なら DS-82 で郵送、それ以外は DS-11 で本人出頭。',
      needs_en: [
        'Previous passport (or police report if lost/stolen)',
        '2 passport photos (US-spec 2"×2", white background, taken within 6 months)',
        'Form DS-82 (renewal by mail) or DS-11 (in person)',
        'Payment by check/money order to "U.S. Department of State" — no cash, no credit at posts',
        'Proof of name change if applicable (marriage certificate, court order)',
      ],
      needs_jp: [
        '旧パスポート(紛失・盗難の場合は警察証明書)',
        'パスポート用写真 2 枚(米国規格 2"×2"・白背景・6 ヶ月以内撮影)',
        'DS-82 申請書(郵送更新)または DS-11(本人出頭)',
        '"U.S. Department of State" 宛の小切手・マネーオーダー(現金・クレジット不可)',
        '改名がある場合の証明書(婚姻証明書・裁判所命令等)',
      ],
      lead_time_en: '6–10 weeks routine, 2–3 weeks expedited',
      lead_time_jp: '通常 6〜10 週・速達 2〜3 週',
    },
    passport_jp: {
      where_en: 'Prefectural passport office (旅券課) — every prefecture has one. Renew up to 1 year before expiry. Children under 18 need parental consent.',
      where_jp: '各都道府県の旅券課。有効期限 1 年前から更新可能。18 歳未満は親権者同意が必要。',
      needs_en: [
        '一般旅券発給申請書 (passport application form, available at the 旅券課)',
        'Current passport',
        '戸籍謄本 or 戸籍抄本 (issued within 6 months) — required for first-time AND name-change renewals',
        '6-month-recent passport photo (4.5×3.5 cm, JP-spec)',
        '手数料 (¥16,000 for 10y / ¥11,000 for 5y, by 収入印紙 + 都道府県収入証紙)',
        'For dual-citizen children: confirmation that 国籍選択 won\'t be an issue (renewal does not by itself count as choosing JP nationality)',
      ],
      needs_jp: [
        '一般旅券発給申請書(旅券課窓口で入手)',
        '現有パスポート',
        '戸籍謄本または戸籍抄本(発行から 6 ヶ月以内) — 初回および改名時に必須',
        '6 ヶ月以内に撮影したパスポート写真(4.5×3.5cm・日本規格)',
        '手数料(10 年用 ¥16,000・5 年用 ¥11,000・収入印紙 + 都道府県収入証紙で納付)',
        '二重国籍の子の場合:更新自体は国籍選択行為ではない点を確認',
      ],
      lead_time_en: '1 week (申請から受領まで)',
      lead_time_jp: '申請から受領まで約 1 週間',
    },
    residence_card_jp: {
      where_en: 'Local immigration office (入国管理局 → 出入国在留管理庁). Apply 3 months before expiry for renewal of period of stay.',
      where_jp: '管轄の入国管理局(出入国在留管理庁)。在留期間更新は満了日の 3 ヶ月前から申請可能。',
      needs_en: [
        '申請書 (form depends on visa category — work, spouse, PR, etc.)',
        'Current residence card',
        'Passport',
        '住民票 (issued within 3 months)',
        '在職証明書 / 雇用契約書 (employment proof, if work visa)',
        '所得税関連書類 (gensen choshu hyo / kakutei shinkoku copy)',
        '住民税納税証明書 (resident-tax payment certificate)',
        'Photo (4×3 cm, taken within 3 months)',
        '手数料 ¥4,000 (収入印紙 paid on grant)',
      ],
      needs_jp: [
        '在留期間更新許可申請書(ビザカテゴリーにより異なる:就労・配偶者・永住等)',
        '現在の在留カード',
        'パスポート',
        '住民票(発行 3 ヶ月以内)',
        '在職証明書または雇用契約書(就労ビザの場合)',
        '所得税関連書類(源泉徴収票・確定申告書の写し)',
        '住民税納税証明書',
        '写真(4×3cm・3 ヶ月以内撮影)',
        '手数料 ¥4,000(許可時に収入印紙で納付)',
      ],
      lead_time_en: '2 weeks – 3 months processing',
      lead_time_jp: '審査期間 2 週間〜3 ヶ月',
    },
    drivers_license_us: {
      where_en: 'US state DMV. Most states allow online renewal, otherwise in-person. Check expiry date — most states won\'t renew more than 6 months early.',
      where_jp: '米国の州 DMV。多くの州はオンライン更新可、それ以外は窓口。早期更新は通常 6 ヶ月前まで。',
      needs_en: [
        'Current driver\'s license',
        'State-specific renewal form (often online)',
        'Vision test (most states)',
        'Updated address if different (Real ID compliance requires US address documentation)',
      ],
      needs_jp: [
        '現在の運転免許証',
        '州別の更新申請書(多くはオンライン)',
        '視力検査(ほとんどの州)',
        '住所更新(変更がある場合・Real ID は米国住所の証明書類が必要)',
      ],
      lead_time_en: '2-6 weeks for physical card; some states issue temporary printout same-day',
      lead_time_jp: '物理カード受領まで 2〜6 週・一部の州は仮免許を即日発行',
    },
    drivers_license_jp: {
      where_en: 'Run by 警察 — go to your prefecture\'s 運転免許試験場 OR designated 警察署. Renew within 1 month before/after birthday in the renewal year. Gold license (5y) vs blue (3y) vs green (3y, new driver).',
      where_jp: '警察管轄。所轄の運転免許試験場または指定警察署。更新年の誕生日 1 ヶ月前〜1 ヶ月後に手続き。優良(ゴールド・5 年)・一般(ブルー・3 年)・新規(グリーン・3 年)。',
      needs_en: [
        '更新連絡書 (renewal notice mailed ~30-45 days before expiry)',
        'Current 運転免許証',
        '住民票 or マイナンバーカード (some prefectures need address verification)',
        '更新時講習料 (¥3,000-¥3,850 by violation history)',
        '写真 — taken on-site at most centers',
        'Vision test (on-site)',
      ],
      needs_jp: [
        '更新連絡書(有効期限の 30〜45 日前に郵送される)',
        '現在の運転免許証',
        '住民票またはマイナンバーカード(都道府県により住所確認に必要)',
        '更新時講習料(違反歴により ¥3,000〜¥3,850)',
        '写真 — ほとんどのセンターで現地撮影',
        '視力検査(現地)',
      ],
      lead_time_en: 'Same day at most centers',
      lead_time_jp: 'ほとんどのセンターで即日交付',
    },
    visa: {
      where_en: 'Same as residence_card_jp — handled by 出入国在留管理庁.',
      where_jp: 'residence_card_jp と同様 — 出入国在留管理庁が管轄。',
      needs_en: ['See residence card renewal — same paperwork.'],
      needs_jp: ['在留カード更新と同じ書類セット。'],
      lead_time_en: '2 weeks – 3 months',
      lead_time_jp: '審査期間 2 週間〜3 ヶ月',
    },
    green_card: {
      where_en: 'USCIS Form I-90 (online or paper). Renew within 6 months of expiry. If outside the US for >6 months, expect secondary inspection on return.',
      where_jp: 'USCIS Form I-90(オンラインまたは紙)。有効期限の 6 ヶ月以内に更新。6 ヶ月以上の米国外滞在後の再入国は二次審査の対象。',
      needs_en: [
        'Form I-90 (currently $540 + $85 biometrics)',
        'Two passport-style photos',
        'Copy of expiring green card',
        'Proof of continued US residence intent (US tax returns, US property, etc.) — important for expats',
      ],
      needs_jp: [
        'Form I-90(現行 $540 + 生体認証 $85)',
        'パスポート規格写真 2 枚',
        '失効間近の永住権カードのコピー',
        '米国居住意思の証明(米国納税申告書・米国不動産等)— 国外居住者には重要',
      ],
      lead_time_en: '6-12 months processing; receipt notice extends validity by 24 months',
      lead_time_jp: '審査 6〜12 ヶ月・受領通知で有効期限が 24 ヶ月延長',
    },
    my_number_card_jp: {
      where_en: '区役所 / 市役所 — your local municipality. Renew electronic certificate (5y) and physical card (10y for adults / 5y for minors) at the city hall counter.',
      where_jp: 'お住まいの区役所・市役所。電子証明書(5 年)と物理カード(成人 10 年・未成年 5 年)を市役所窓口で更新。',
      needs_en: [
        '更新案内 (mailed by your municipality before expiry)',
        'Current my number card',
        'Photo ID (if card is expired)',
      ],
      needs_jp: [
        '更新案内(満了前に自治体から郵送)',
        '現在のマイナンバーカード',
        '写真付き身分証明書(カード失効済みの場合)',
      ],
      lead_time_en: 'Same day for electronic certificate; 2-4 weeks for new physical card',
      lead_time_jp: '電子証明書は即日・新規物理カードは 2〜4 週',
    },
  };

  function getRenewalChecklist(typeId) { return RENEWAL_CHECKLISTS[typeId] || null; }

  // ====================================================================
  // Cross-module linkage
  // ====================================================================
  //
  // A document can reference a record in another module: a passport
  // belongs to a family member, a deed to a property, a beneficiary
  // form to an asset account. Schema:
  //
  //   linked_module : 'family' | 'property' | 'assets' | null
  //   linked_id     : string id within that module
  //
  // The pickers below build {id, label} lists from each linked module
  // so the edit modal can offer real choices, not free-text. Each
  // module's display label is built lang-aware.

  function linkableModulesForType(typeId) {
    const t = TYPES[typeId];
    if (!t) return [];
    switch (t.cat) {
      case 'identification':
      case 'immigration':
      case 'family':
        return ['family'];
      case 'medical':
        // Medical docs can link to family (whose record) AND to the
        // Health Tracker for binder-style cross-reference.
        return ['family', 'health-tracker'];
      case 'property':
        return ['property', 'assets'];
      case 'estate':
        return ['family', 'property', 'assets'];
      case 'tax':
        return ['assets', 'family', 'property'];
      case 'insurance':
        // Insurance health cards link to Health Tracker; others (life,
        // auto, home) link to the existing modules.
        return ['health-tracker', 'assets', 'family', 'property'];
      default:
        return ['family', 'property', 'assets'];
    }
  }

  function linkableRecords(moduleId, lang) {
    if (moduleId === 'family') {
      const members = (TB.state.get('family.members') || []);
      return members
        .filter(m => m && (m.id || m.name))
        .map(m => ({
          id: m.id || m.name,
          label: (m.name || '?') + (m.relationship ? ' (' + m.relationship + ')' : ''),
        }));
    }
    if (moduleId === 'property') {
      const props = (TB.state.get('property.properties') || []);
      return props
        .filter(p => p && p.id)
        .map(p => ({
          id: p.id,
          label: (p.label || p.address || p.city || p.type || p.id) +
            (p.country ? ' · ' + p.country : ''),
        }));
    }
    if (moduleId === 'assets') {
      const accts = (TB.state.get('assets.accounts') || []);
      return accts
        .filter(a => a && a.id)
        .map(a => ({
          id: a.id,
          label: (a.institution || '?') + (a.name ? ' · ' + a.name : '') +
            (a.country ? ' · ' + a.country : ''),
        }));
    }
    if (moduleId === 'health-tracker') {
      // Health Tracker has a small set of singleton records that docs
      // can be linked to. Episodes are listed when present.
      const out = [];
      out.push({ id: 'insurance_summary', label: lang === 'ja' ? '保険サマリー' : 'Insurance summary' });
      const eps = (TB.state.get('health_tracker.episodes') || []);
      for (const ep of eps) {
        if (!ep || !ep.id) continue;
        out.push({
          id: ep.id,
          label: (lang === 'ja' ? 'ケアエピソード: ' : 'Care episode: ') + (ep.title || ep.id),
        });
      }
      return out;
    }
    return [];
  }

  function moduleLabel(moduleId, lang) {
    const map = {
      family:   { en: 'Family member', jp: '家族メンバー' },
      property: { en: 'Property',      jp: '不動産' },
      assets:   { en: 'Asset account', jp: '資産口座' },
      'health-tracker': { en: 'Health Tracker', jp: 'ヘルストラッカー' },
    };
    const e = map[moduleId];
    return e ? (lang === 'ja' ? e.jp : e.en) : moduleId;
  }

  // Public helper: given a (moduleId, recordId), return the list of
  // documents linked to it. Used by other modules to render "Linked
  // documents" sections — passports, deeds, statements, etc.
  function getDocsLinkedTo(moduleId, recordId) {
    if (!moduleId || !recordId) return [];
    return getItems().filter(d => d.linked_module === moduleId && d.linked_id === recordId);
  }

  function typeLabel(typeId, lang) {
    const t = TYPES[typeId];
    if (!t) return typeId;
    return lang === 'ja' ? t.label_jp : t.label_en;
  }
  function categoryLabel(catId, lang) {
    const c = CATEGORIES.find((x) => x.id === catId);
    return c ? (lang === 'ja' ? c.label_jp : c.label_en) : catId;
  }
  function categoryEmoji(catId) {
    const c = CATEGORIES.find((x) => x.id === catId);
    return c ? c.emoji : '📄';
  }

  // ====================================================================
  // State accessors
  // ====================================================================

  function getItems()      { return TB.state.get('documentVault.items') || []; }
  function setItemsList(arr)   { TB.state.set('documentVault.items', arr); }
  function upsertItem(it)  {
    const arr = getItems();
    const i = arr.findIndex((x) => x.id === it.id);
    if (i >= 0) arr[i] = it;
    else arr.push(it);
    setItemsList(arr);
  }
  function deleteItem(itemId) {
    setItemsList(getItems().filter((x) => x.id !== itemId));
  }

  // ====================================================================
  // Expiry helpers
  // ====================================================================

  function daysUntil(iso) {
    if (!iso) return Infinity;
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return Infinity;
    const t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }
  function expiryStatus(iso) {
    if (!iso) return null;
    const days = daysUntil(iso);
    if (days < 0) return { state: 'expired', days, color: 'var(--tb-error)', label: 'Expired' };
    if (days <= 30) return { state: 'critical', days, color: 'var(--tb-error)', label: '⚠ ' + days + 'd' };
    if (days <= 90) return { state: 'soon', days, color: 'var(--tb-warn)', label: '⚠ ' + days + 'd' };
    if (days <= 180) return { state: 'upcoming', days, color: 'var(--tb-warn)', label: days + 'd' };
    return { state: 'ok', days, color: 'var(--tb-text-soft)', label: days + 'd' };
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let filterCategory = 'all';

  function render(container) {
    host = container;
    container.innerHTML = '';
    container.appendChild(buildHeaderCard());
    container.appendChild(buildExpiryHeatmapCard());
    container.appendChild(buildToolbar());
    container.appendChild(buildList());
  }
  function rerender() { if (host) render(host); }

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const items = getItems();
    const expiringSoon = items.filter((it) => {
      const s = expiryStatus(it.expiry_date);
      return s && (s.state === 'critical' || s.state === 'expired' || s.state === 'soon');
    });

    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h1', null, '🗄 ' + t('docvault.title')),
      el('p', { class: 'tb-card-meta' }, t('docvault.subtitle')),
      el('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)' },
      },
        statBadge(t('docvault.stat.total'),     items.length),
        statBadge(t('docvault.stat.expiring'),  expiringSoon.length, expiringSoon.length > 0 ? 'var(--tb-warn)' : null),
      ),
      el('div', { class: 'tb-disclaimer-inline', style: { marginTop: 'var(--tb-sp-3)' } },
        '🔒 ' + t('docvault.privacy')),
    );
  }

  function statBadge(label, value, color) {
    return TB.utils.el('div', {
      style: {
        background: 'var(--tb-bg)',
        padding: '4px 12px',
        borderRadius: 'var(--tb-radius-1)',
        fontSize: 'var(--tb-fs-12)',
      },
    },
      TB.utils.el('span', { style: { color: 'var(--tb-text-soft)' } }, label + ': '),
      TB.utils.el('span', { style: { fontWeight: '700', color: color || 'var(--tb-text)' } }, String(value)),
    );
  }

  function buildToolbar() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const catSelect = el('select', {
      class: 'tb-select',
      style: { maxWidth: '240px' },
      onchange: (e) => { filterCategory = e.target.value; rerender(); },
    },
      el('option', { value: 'all', selected: filterCategory === 'all' }, t('docvault.filter.all')),
      ...CATEGORIES.map((c) => el('option', {
        value: c.id, selected: filterCategory === c.id,
      }, c.emoji + ' ' + (lang === 'ja' ? c.label_jp : c.label_en))),
    );

    const addBtn = el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: () => openEditModal(null),
    }, '+ ' + t('docvault.add'));

    // Bulk-vision-import button — only visible when an API key is set.
    // Accepts up to 10 files, processes sequentially, opens a review
    // queue when done.
    const buttons = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    if (TB.ai && TB.ai.hasKey && TB.ai.hasKey()) {
      const bulkBtn = el('button', {
        class: 'tb-btn tb-btn--secondary',
        type: 'button',
        onclick: () => openBulkImportModal(),
        title: t('docvault.bulk.tooltip'),
      }, '📦 ' + t('docvault.bulk.button'));
      buttons.appendChild(bulkBtn);
    }
    buttons.appendChild(addBtn);

    return el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--tb-sp-3)' },
    },
      catSelect,
      buttons,
    );
  }

  // ====================================================================
  // Expiry heatmap calendar
  // ====================================================================
  //
  // 12-month grid (current month + 11 forward). Each cell = a month;
  // color intensity = count of documents expiring that month; click
  // opens a small modal listing those documents. Quick mental scan of
  // "when am I going to be busy with renewals?"

  function buildExpiryHeatmapCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const items = getItems();
    // Bucket items by YYYY-MM of expiry_date over the next 12 months
    // (plus a single "already expired" bucket and a "later than 12mo"
    // bucket shown as compact tags below the grid).
    const today = new Date(); today.setHours(0,0,0,0);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      months.push({
        key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
        label: lang === 'ja'
          ? d.getFullYear() + '/' + (d.getMonth() + 1)
          : d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'short', year: '2-digit' }),
        docs: [],
      });
    }
    const expired = [];
    const future = [];
    for (const it of items) {
      if (!it.expiry_date) continue;
      const d = new Date(it.expiry_date + 'T00:00:00');
      if (isNaN(d.getTime())) continue;
      if (d < today) { expired.push(it); continue; }
      const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const bucket = months.find((m) => m.key === mk);
      if (bucket) bucket.docs.push(it);
      else future.push(it);
    }
    // No expiring docs at all → render compact "nothing to renew" state.
    const hasAny = expired.length > 0 || future.length > 0 ||
      months.some((m) => m.docs.length > 0);
    if (!hasAny) {
      return el('div', { class: 'tb-card', 'data-track': 'core' },
        el('h3', { style: { marginTop: 0 } }, '📅 ' + t('docvault.heatmap.title')),
        el('p', { class: 'tb-field-help' }, t('docvault.heatmap.empty')),
      );
    }

    const maxCount = Math.max.apply(null, months.map((m) => m.docs.length).concat([1]));
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('h3', { style: { margin: 0 } }, '📅 ' + t('docvault.heatmap.title')),
      el('span', { class: 'tb-card-meta' }, t('docvault.heatmap.subtitle')),
    ));

    // Already-expired warning strip
    if (expired.length > 0) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderLeft: '4px solid var(--tb-error)',
          borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { fontWeight: '600', color: 'var(--tb-error)' } },
          '⚠ ' + t('docvault.heatmap.expired', { n: expired.length })),
        el('div', { class: 'tb-field-help', style: { marginTop: '4px' } },
          expired.slice(0, 5).map((it) => it.title || typeLabel(it.type, lang)).join(', ') +
          (expired.length > 5 ? '…' : '')),
      ));
    }

    // 12-month grid: 4 columns × 3 rows. Each cell shows month label,
    // count, and a fill bar; clicking opens a list modal.
    const grid = el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
        gap: 'var(--tb-sp-2)',
        marginTop: 'var(--tb-sp-2)',
      },
    });
    months.forEach((m) => {
      const intensity = m.docs.length / maxCount;
      const fillColor = m.docs.length === 0
        ? 'transparent'
        : intensity > 0.66 ? 'rgba(178, 58, 58, 0.18)'
        : intensity > 0.33 ? 'rgba(185, 122, 26, 0.18)'
        : 'rgba(46, 107, 92, 0.14)';
      const cell = el('button', {
        type: 'button',
        style: {
          padding: 'var(--tb-sp-2)',
          background: fillColor,
          border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
          textAlign: 'left',
          cursor: m.docs.length > 0 ? 'pointer' : 'default',
          font: 'inherit',
          color: 'var(--tb-text)',
        },
        onclick: () => {
          if (m.docs.length === 0) return;
          openHeatmapMonthModal(m);
        },
      },
        el('div', {
          style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' },
        }, m.label),
        el('div', {
          style: { fontSize: 'var(--tb-fs-22)', fontWeight: '700', fontFamily: 'var(--tb-font-mono)', marginTop: '2px' },
        }, m.docs.length === 0 ? '·' : String(m.docs.length)),
      );
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    if (future.length > 0) {
      card.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
        '+ ' + t('docvault.heatmap.later', { n: future.length })));
    }
    return card;
  }

  function openHeatmapMonthModal(month) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '520px' } });
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) root.innerHTML = ''; });
    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      '📅 ' + t('docvault.heatmap.month_title', { label: month.label, n: month.docs.length })));
    month.docs.sort((a, b) => (a.expiry_date || '').localeCompare(b.expiry_date || ''));
    for (const it of month.docs) {
      const row = el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderBottom: '1px dashed var(--tb-border)',
          cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        },
        onclick: () => { root.innerHTML = ''; openEditModal(it); },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } }, it.title || typeLabel(it.type, lang)),
          el('div', { class: 'tb-card-meta' }, typeLabel(it.type, lang)),
        ),
        el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
          it.expiry_date),
      );
      modal.appendChild(row);
    }
    const btnRow = el('div', { style: { textAlign: 'right', marginTop: 'var(--tb-sp-3)' } },
      el('button', { class: 'tb-btn tb-btn--secondary', type: 'button',
        onclick: () => { root.innerHTML = ''; } }, t('docvault.close')),
    );
    modal.appendChild(btnRow);
    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Bulk vision import
  // ====================================================================
  //
  // User picks (or drag-and-drops) up to 10 files. Each is sent to
  // callClaudeVisionForDocumentExtraction sequentially. As each result
  // comes back, the row updates with extracted fields. User reviews
  // each, can edit before save, then commits in a batch. Single
  // consent prompt per file (gate runs inside the vision call).

  const BULK_MAX = 10;

  function openBulkImportModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal', style: { maxWidth: '720px' } });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, '📦 ' + t('docvault.bulk.title')));
    modal.appendChild(el('p', { class: 'tb-card-meta' }, t('docvault.bulk.intro', { max: BULK_MAX })));

    const status = el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } });
    modal.appendChild(status);

    const rowsHost = el('div');
    modal.appendChild(rowsHost);

    // State for the in-progress import. Each entry: { id, file, status:
    // 'queued'|'processing'|'done'|'error', extracted, error, draft }
    const entries = [];

    function renderRow(entry) {
      const row = el('div', {
        style: {
          padding: 'var(--tb-sp-3)',
          border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      const icon = entry.status === 'done' ? '✓'
                  : entry.status === 'error' ? '✗'
                  : entry.status === 'processing' ? '⏳' : '○';
      const iconColor = entry.status === 'done' ? 'var(--tb-success)'
                       : entry.status === 'error' ? 'var(--tb-error)'
                       : 'var(--tb-text-soft)';
      row.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--tb-sp-3)' },
      },
        el('div', null,
          el('span', { style: { color: iconColor, fontWeight: '700', marginRight: '8px' } }, icon),
          el('span', { style: { fontWeight: '600' } }, entry.file.name),
          el('span', { class: 'tb-card-meta', style: { marginLeft: '8px' } },
            (entry.file.size / 1024).toFixed(0) + ' KB'),
        ),
        el('span', { class: 'tb-card-meta' },
          entry.status === 'queued' ? t('docvault.bulk.status.queued')
          : entry.status === 'processing' ? t('docvault.bulk.status.processing')
          : entry.status === 'done' ? t('docvault.bulk.status.done')
          : entry.status === 'error' ? t('docvault.bulk.status.error') : ''),
      ));
      if (entry.status === 'done' && entry.draft) {
        const d = entry.draft;
        row.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
          (d.title || typeLabel(d.type, lang) || '?') +
          (d.expiry_date ? ' · ' + (lang === 'ja' ? '有効期限 ' : 'expires ') + d.expiry_date : '') +
          (d.person_name ? ' · ' + d.person_name : '')));
      }
      if (entry.status === 'error') {
        row.appendChild(el('div', {
          style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-error)', fontSize: 'var(--tb-fs-12)' },
        }, entry.error || t('docvault.bulk.status.error')));
      }
      return row;
    }
    function repaintRows() {
      rowsHost.innerHTML = '';
      entries.forEach((e) => rowsHost.appendChild(renderRow(e)));
    }

    function buildDraftFromExtraction(ext) {
      const draft = {
        id: TB.utils.uuid(),
        category: 'other',
        type: 'other',
        title: '',
        person_name: TB.state.get('profile.displayName') || '',
        issuing_authority: '',
        issue_date: null,
        expiry_date: null,
        reference_number_last4: null,
        storage_location: '',
        notes: '',
        linked_module: null,
        linked_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (ext.document_type && TYPES[ext.document_type]) {
        draft.type = ext.document_type;
        draft.category = TYPES[ext.document_type].cat;
      }
      if (ext.title) draft.title = ext.title;
      if (ext.person_name) draft.person_name = ext.person_name;
      if (ext.issuing_authority) draft.issuing_authority = ext.issuing_authority;
      if (ext.issue_date) draft.issue_date = ext.issue_date;
      if (ext.expiry_date) draft.expiry_date = ext.expiry_date;
      if (ext.reference_number_last4) draft.reference_number_last4 = ext.reference_number_last4;
      if (ext.notes_suggestion) draft.notes = ext.notes_suggestion;
      return draft;
    }

    async function processQueue() {
      const total = entries.length;
      let totalCost = 0;
      for (const e of entries) {
        if (e.status !== 'queued') continue;
        e.status = 'processing';
        repaintRows();
        try {
          const result = await TB.ai.callClaudeVisionForDocumentExtraction(e.file, {});
          e.extracted = result.extracted || {};
          e.draft = buildDraftFromExtraction(e.extracted);
          e.status = 'done';
          totalCost += Number(result.cost_usd) || 0;
        } catch (err) {
          e.status = 'error';
          e.error = (err && err.message) || String(err);
        }
        repaintRows();
      }
      status.style.color = 'var(--tb-success)';
      status.textContent = t('docvault.bulk.complete', {
        n: entries.filter((x) => x.status === 'done').length,
        total,
        cost: totalCost.toFixed(4),
      });
      saveBtn.disabled = entries.filter((x) => x.status === 'done').length === 0;
    }

    // File picker + drop zone
    const fileInput = el('input', {
      type: 'file',
      multiple: 'multiple',
      accept: 'image/png,image/jpeg,image/jpg,image/webp,image/gif,application/pdf',
      style: { display: 'none' },
      onchange: (e) => {
        const fs = Array.from(e.target.files || []);
        addFiles(fs);
        e.target.value = '';
      },
    });
    const dropZone = el('div', {
      style: {
        border: '1px dashed var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-4)',
        textAlign: 'center',
        background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-2)' } },
        t('docvault.bulk.dropTitle')),
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } },
        t('docvault.bulk.dropHelp', { max: BULK_MAX })),
      el('button', {
        class: 'tb-btn',
        type: 'button',
        onclick: () => fileInput.click(),
      }, '📎 ' + t('docvault.bulk.choose')),
      fileInput,
    );
    TB.utils.attachFileDrop(dropZone, {
      accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
      text: '⤓ ' + t('docvault.bulk.dropOver'),
      onFiles: (files) => addFiles(Array.from(files)),
      onFile: (f) => addFiles([f]),  // fallback if onFiles isn't supported
      onError: (msg) => {
        status.style.color = 'var(--tb-error)';
        status.textContent = msg;
      },
    });
    modal.insertBefore(dropZone, status);

    function addFiles(files) {
      if (!files || files.length === 0) return;
      for (const f of files) {
        if (entries.length >= BULK_MAX) break;
        entries.push({ id: TB.utils.uuid(), file: f, status: 'queued' });
      }
      status.textContent = t('docvault.bulk.queued', { n: entries.length });
      status.style.color = 'var(--tb-text-soft)';
      repaintRows();
    }

    // Action buttons
    const btnRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    });
    const startBtn = el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: async () => {
        if (entries.length === 0) return;
        startBtn.disabled = true;
        await processQueue();
        startBtn.style.display = 'none';
      },
    }, '▶ ' + t('docvault.bulk.start'));
    const saveBtn = el('button', {
      class: 'tb-btn',
      type: 'button',
      disabled: true,
      onclick: () => {
        const successful = entries.filter((e) => e.status === 'done' && e.draft);
        for (const e of successful) {
          e.draft.updated_at = new Date().toISOString();
          upsertItem(e.draft);
        }
        close();
        rerender();
      },
    }, '💾 ' + t('docvault.bulk.save'));
    btnRow.appendChild(el('button', {
      class: 'tb-btn tb-btn--secondary',
      type: 'button',
      onclick: close,
    }, t('docvault.cancel')));
    btnRow.appendChild(el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } },
      startBtn, saveBtn));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  function buildList() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const items = getItems().filter((it) => filterCategory === 'all' || it.category === filterCategory);

    if (items.length === 0) {
      return el('div', { class: 'tb-card', 'data-track': 'core' },
        el('p', { class: 'tb-field-help' }, t('docvault.empty')));
    }

    const byCat = {};
    for (const it of items) {
      (byCat[it.category || 'other'] = byCat[it.category || 'other'] || []).push(it);
    }

    const wrap = el('div');
    for (const cat of CATEGORIES) {
      if (!byCat[cat.id]) continue;
      const card = el('div', { class: 'tb-card', 'data-track': 'core' });
      card.appendChild(el('h3', { style: { marginTop: 0 } },
        cat.emoji + ' ' + (lang === 'ja' ? cat.label_jp : cat.label_en) +
        ' (' + byCat[cat.id].length + ')'));
      byCat[cat.id].sort((a, b) => {
        const da = daysUntil(a.expiry_date);
        const db = daysUntil(b.expiry_date);
        if (da !== db) return da - db;
        return (a.title || '').localeCompare(b.title || '');
      });
      for (const it of byCat[cat.id]) card.appendChild(buildItemRow(it));
      wrap.appendChild(card);
    }
    return wrap;
  }

  function buildItemRow(item) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const expStatus = expiryStatus(item.expiry_date);

    return el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        borderBottom: '1px dashed var(--tb-border)',
        alignItems: 'center',
        cursor: 'pointer',
      },
      onclick: () => openEditModal(item),
    },
      el('div', null,
        el('div', { style: { fontWeight: '600' } },
          item.title || typeLabel(item.type, lang) || '(untitled)',
          item.person_name ? el('span', { style: { color: 'var(--tb-text-soft)', fontWeight: '400', marginLeft: '8px' } },
            ' · ' + item.person_name) : null,
        ),
        el('div', { class: 'tb-card-meta' },
          typeLabel(item.type, lang),
          item.reference_number_last4 ? '  ·  ••••' + item.reference_number_last4 : '',
          item.storage_location ? '  ·  📍 ' + item.storage_location : '',
        ),
      ),
      el('div', { style: { textAlign: 'right' } },
        item.expiry_date ? el('div', null,
          el('div', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } },
            item.expiry_date),
          expStatus ? el('div', {
            style: { color: expStatus.color, fontSize: 'var(--tb-fs-12)', fontWeight: '600' },
          }, expStatus.label) : null,
        ) : el('span', { style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)' } },
          t('docvault.no_expiry')),
      ),
    );
  }

  // ====================================================================
  // Add / Edit modal
  // ====================================================================

  function openEditModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isEdit = !!existing;
    const draft = existing ? Object.assign({}, existing) : {
      id: TB.utils.uuid(),
      category: 'identification',
      type: 'passport_us',
      title: '',
      person_name: TB.state.get('profile.displayName') || '',
      issuing_authority: '',
      issue_date: null,
      expiry_date: null,
      reference_number_last4: null,
      storage_location: '',
      notes: '',
      // Cross-module linkage. linked_module ∈ {'family','property',
      // 'assets'} and linked_id references that module's record id.
      // Drives back-references shown in those modules, and forms
      // the basis of the "Sakura's documents" view.
      linked_module: null,
      linked_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const refs = {};

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isEdit ? t('docvault.modal.edit') : t('docvault.modal.add')));

    // Upload card
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
    uploadCard.appendChild(el('div', { style: { fontWeight: '600', marginBottom: 'var(--tb-sp-1)' } },
      t('docvault.upload.title')));
    uploadCard.appendChild(el('div', { class: 'tb-field-help' }, t('docvault.upload.help')));

    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (!hasKey) {
      uploadCard.appendChild(el('div', {
        style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-warn)', fontSize: 'var(--tb-fs-12)' },
      }, t('docvault.upload.no_key')));
    } else {
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
      const uploadBtn = el('button', {
        class: 'tb-btn',
        type: 'button',
        style: { marginTop: 'var(--tb-sp-2)' },
        onclick: () => fileInput.click(),
      }, '📎 ' + t('docvault.upload.button'));
      uploadCard.appendChild(uploadBtn);
      uploadCard.appendChild(fileInput);

      // Drag-and-drop on the upload card itself.
      TB.utils.attachFileDrop(uploadCard, {
        accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
        text: '⤓ ' + t('docvault.upload.drop'),
        onFile: (f) => handleUpload(f),
        onError: (msg) => {
          uploadStatus.textContent = t('docvault.upload.error', { message: msg });
          uploadStatus.style.color = 'var(--tb-error)';
        },
      });
    }
    uploadCard.appendChild(uploadStatus);
    modal.appendChild(uploadCard);

    function handleUpload(file) {
      uploadStatus.textContent = t('docvault.upload.processing', { filename: file.name });
      uploadStatus.style.color = 'var(--tb-text-soft)';
      TB.ai.callClaudeVisionForDocumentExtraction(file, { expected_type: draft.type })
        .then((result) => {
          const ext = result.extracted || {};
          const cost = (result.cost_usd || 0).toFixed(4);
          const filled = applyExtraction(ext);
          if (filled.length === 0) {
            uploadStatus.textContent = t('docvault.upload.partial');
            uploadStatus.style.color = 'var(--tb-warn)';
          } else {
            uploadStatus.textContent = t('docvault.upload.done', { filename: file.name, cost });
            uploadStatus.style.color = 'var(--tb-success)';
          }
        })
        .catch((err) => {
          uploadStatus.textContent = t('docvault.upload.error', { message: (err && err.message) || String(err) });
          uploadStatus.style.color = 'var(--tb-error)';
        });
    }

    function applyExtraction(ext) {
      const filled = [];
      function setIf(field, value, refKey) {
        if (value == null || value === '') return;
        draft[field] = value;
        if (refs[refKey]) refs[refKey].value = String(value);
        filled.push(field);
      }
      if (ext.document_type && TYPES[ext.document_type]) {
        draft.type = ext.document_type;
        draft.category = TYPES[ext.document_type].cat;
        if (refs.category) refs.category.value = draft.category;
        rebuildTypeSelect();
        filled.push('type');
      }
      setIf('title', ext.title, 'title');
      setIf('person_name', ext.person_name, 'person_name');
      setIf('issuing_authority', ext.issuing_authority, 'issuing_authority');
      setIf('issue_date', ext.issue_date, 'issue_date');
      setIf('expiry_date', ext.expiry_date, 'expiry_date');
      setIf('reference_number_last4', ext.reference_number_last4, 'reference_number_last4');
      if (ext.notes_suggestion) {
        const cur = (draft.notes || '').trim();
        draft.notes = cur ? cur + '\n\n' + ext.notes_suggestion : ext.notes_suggestion;
        if (refs.notes) refs.notes.value = draft.notes;
        filled.push('notes');
      }
      return filled;
    }

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    refs.category = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        draft.category = e.target.value;
        rebuildTypeSelect();
      },
    },
      ...CATEGORIES.map((c) => el('option', {
        value: c.id, selected: draft.category === c.id,
      }, c.emoji + ' ' + (lang === 'ja' ? c.label_jp : c.label_en))),
    );
    modal.appendChild(field(t('docvault.field.category'), refs.category));

    const typeFieldWrap = el('div');
    function rebuildTypeSelect() {
      typeFieldWrap.innerHTML = '';
      const types = Object.entries(TYPES).filter(([, v]) => v.cat === draft.category);
      if (!types.find(([k]) => k === draft.type)) {
        draft.type = types.length > 0 ? types[0][0] : 'other';
      }
      refs.type = el('select', {
        class: 'tb-select',
        onchange: (e) => { draft.type = e.target.value; },
      },
        ...types.map(([k, v]) => el('option', {
          value: k, selected: draft.type === k,
        }, lang === 'ja' ? v.label_jp : v.label_en)),
      );
      typeFieldWrap.appendChild(field(t('docvault.field.type'), refs.type));
    }
    rebuildTypeSelect();
    modal.appendChild(typeFieldWrap);

    refs.title = el('input', {
      type: 'text', class: 'tb-input',
      value: draft.title || '',
      placeholder: t('docvault.field.title.placeholder'),
      oninput: (e) => { draft.title = e.target.value; },
    });
    modal.appendChild(field(t('docvault.field.title'), refs.title));

    refs.person_name = el('input', {
      type: 'text', class: 'tb-input',
      value: draft.person_name || '',
      placeholder: t('docvault.field.person.placeholder'),
      oninput: (e) => { draft.person_name = e.target.value; },
    });
    modal.appendChild(field(t('docvault.field.person'), refs.person_name));

    refs.issue_date = el('input', {
      type: 'date', class: 'tb-input',
      value: draft.issue_date || '',
      oninput: (e) => { draft.issue_date = e.target.value || null; },
    });
    refs.expiry_date = el('input', {
      type: 'date', class: 'tb-input',
      value: draft.expiry_date || '',
      oninput: (e) => { draft.expiry_date = e.target.value || null; },
    });
    modal.appendChild(el('div', {
      style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-3)' },
    },
      field(t('docvault.field.issue_date'), refs.issue_date),
      field(t('docvault.field.expiry_date'), refs.expiry_date),
    ));

    refs.issuing_authority = el('input', {
      type: 'text', class: 'tb-input',
      value: draft.issuing_authority || '',
      placeholder: t('docvault.field.issuing_authority.placeholder'),
      oninput: (e) => { draft.issuing_authority = e.target.value; },
    });
    modal.appendChild(field(t('docvault.field.issuing_authority'), refs.issuing_authority));

    refs.reference_number_last4 = el('input', {
      type: 'text', class: 'tb-input',
      maxlength: '4',
      value: draft.reference_number_last4 || '',
      placeholder: '1234',
      oninput: (e) => {
        const v = String(e.target.value || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
        e.target.value = v;
        draft.reference_number_last4 = v || null;
      },
    });
    modal.appendChild(field(t('docvault.field.reference'), refs.reference_number_last4,
      t('docvault.field.reference.help')));

    refs.storage_location = el('input', {
      type: 'text', class: 'tb-input',
      value: draft.storage_location || '',
      placeholder: t('docvault.field.storage.placeholder'),
      oninput: (e) => { draft.storage_location = e.target.value; },
    });
    modal.appendChild(field('📍 ' + t('docvault.field.storage'), refs.storage_location,
      t('docvault.field.storage.help')));

    // ─── Cross-module linkage ────────────────────────────────────
    // "This document belongs to → which record in which module?"
    // The module picker offers only modules sensible for this type
    // (a passport → family member; a deed → property/asset; etc.).
    const linkWrap = el('div');
    function rebuildLinkUi() {
      linkWrap.innerHTML = '';
      const allowedModules = linkableModulesForType(draft.type);
      // If the current linked_module is no longer in the allowed
      // set (because the user changed type), clear it.
      if (draft.linked_module && allowedModules.indexOf(draft.linked_module) === -1) {
        draft.linked_module = null;
        draft.linked_id = null;
      }

      const moduleSel = el('select', {
        class: 'tb-select',
        onchange: (e) => {
          draft.linked_module = e.target.value || null;
          draft.linked_id = null;
          rebuildLinkUi();
        },
      },
        el('option', { value: '', selected: !draft.linked_module }, t('docvault.field.link.none')),
        ...allowedModules.map(m => el('option', {
          value: m, selected: draft.linked_module === m,
        }, moduleLabel(m, lang))),
      );

      const recordWrap = el('div', { style: { marginTop: 'var(--tb-sp-2)' } });
      if (draft.linked_module) {
        const records = linkableRecords(draft.linked_module, lang);
        if (records.length === 0) {
          recordWrap.appendChild(el('div', { class: 'tb-field-help' },
            t('docvault.field.link.no_records', { module: moduleLabel(draft.linked_module, lang) })));
        } else {
          const recordSel = el('select', {
            class: 'tb-select',
            onchange: (e) => { draft.linked_id = e.target.value || null; },
          },
            el('option', { value: '', selected: !draft.linked_id }, '— ' + t('docvault.field.link.choose') + ' —'),
            ...records.map(r => el('option', {
              value: r.id, selected: draft.linked_id === r.id,
            }, r.label)),
          );
          recordWrap.appendChild(recordSel);
        }
      }

      linkWrap.appendChild(field(
        '🔗 ' + t('docvault.field.link.label'),
        el('div', null, moduleSel, recordWrap),
        t('docvault.field.link.help'),
      ));
    }
    rebuildLinkUi();
    // Re-render link UI when type changes (handled by rebuildTypeSelect's onchange).
    // We need to monkey-patch the type select to also rebuild link.
    // Simpler: override the existing type select onchange.
    if (refs.type) {
      const origOnChange = refs.type.onchange;
      refs.type.onchange = (e) => {
        if (origOnChange) origOnChange(e);
        rebuildLinkUi();
      };
    }
    modal.appendChild(linkWrap);

    // ─── Renewal checklist ──────────────────────────────────────
    // Shown collapsed by default; expanded when expiry is near or
    // when user clicks. Type-driven; if no checklist exists for the
    // selected type the section is hidden entirely.
    const renewalWrap = el('div');
    function rebuildRenewal() {
      renewalWrap.innerHTML = '';
      const cl = getRenewalChecklist(draft.type);
      if (!cl) return;
      const expSt = expiryStatus(draft.expiry_date);
      const expandByDefault = expSt && (expSt.state === 'critical' || expSt.state === 'expired' || expSt.state === 'soon');
      const details = el('details', {
        open: expandByDefault ? 'open' : null,
        style: {
          marginTop: 'var(--tb-sp-3)',
          padding: 'var(--tb-sp-3)',
          background: 'var(--tb-bg)',
          border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
        },
      });
      details.appendChild(el('summary', {
        style: { cursor: 'pointer', fontWeight: '600' },
      }, '📝 ' + t('docvault.renewal.title')));
      details.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        '📍 ' + (lang === 'ja' ? cl.where_jp : cl.where_en)));
      const list = el('ul', { style: { marginTop: 'var(--tb-sp-2)', paddingLeft: '20px' } });
      const items = lang === 'ja' ? cl.needs_jp : cl.needs_en;
      items.forEach((n) => list.appendChild(el('li', null, n)));
      details.appendChild(list);
      details.appendChild(el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
        '⏱ ' + (lang === 'ja' ? cl.lead_time_jp : cl.lead_time_en)));
      renewalWrap.appendChild(details);
    }
    rebuildRenewal();
    // Refresh on type change AND on expiry change so the auto-expand
    // logic stays current.
    if (refs.type) {
      const prev = refs.type.onchange;
      refs.type.onchange = (e) => { if (prev) prev(e); rebuildRenewal(); };
    }
    if (refs.expiry_date) {
      const prev = refs.expiry_date.oninput;
      refs.expiry_date.oninput = (e) => { if (prev) prev(e); rebuildRenewal(); };
    }
    modal.appendChild(renewalWrap);

    refs.notes = el('textarea', {
      class: 'tb-textarea',
      value: draft.notes || '',
      oninput: (e) => { draft.notes = e.target.value; },
    });
    modal.appendChild(field(t('docvault.field.notes'), refs.notes));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 'var(--tb-sp-4)' } });
    if (isEdit) {
      btnRow.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => {
          if (!confirm(t('docvault.delete.confirm'))) return;
          deleteItem(draft.id);
          close();
          rerender();
        },
      }, t('docvault.delete')));
    } else {
      btnRow.appendChild(el('span'));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('docvault.cancel')));
    right.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        draft.updated_at = new Date().toISOString();
        upsertItem(draft);
        close();
        rerender();
      },
    }, t('docvault.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ====================================================================
  // Action Center generators (registered with TB.actionCenter)
  // ====================================================================

  function genPassportExpiring() {
    const out = [];
    const items = getItems();
    for (const it of items) {
      if (!/^passport_/.test(it.type) || !it.expiry_date) continue;
      const days = daysUntil(it.expiry_date);
      if (days < 0) {
        out.push({
          id: 'docvault_passport_expired_' + it.id,
          group: 'docvault', urgency: 'critical', icon: '🛂',
          title: (it.title || 'Passport') + ' EXPIRED',
          body: (it.title || 'Passport') + ' expired ' + it.expiry_date + '. Renew immediately — most countries require 6 months validity beyond travel dates.',
          deadline: it.expiry_date, module: 'document-vault', snoozable: false,
        });
      } else if (days <= 90) {
        out.push({
          id: 'docvault_passport_critical_' + it.id,
          group: 'docvault', urgency: 'critical', icon: '🛂',
          title: (it.title || 'Passport') + ' expires in ' + days + ' days',
          body: 'US/JP renewal currently takes 6-10 weeks. Many countries deny entry within 6 months of passport expiry. Start renewal NOW.',
          deadline: it.expiry_date, module: 'document-vault', snoozable: false,
        });
      } else if (days <= 180) {
        out.push({
          id: 'docvault_passport_soon_' + it.id,
          group: 'docvault', urgency: 'high', icon: '🛂',
          title: (it.title || 'Passport') + ' expires in ' + days + ' days',
          body: 'Many countries require 6 months passport validity beyond your travel dates. Renew within the next 60 days to avoid travel disruption.',
          deadline: it.expiry_date, module: 'document-vault', snoozable: true,
        });
      }
    }
    return out;
  }

  function genVisaResidenceExpiring() {
    const out = [];
    const items = getItems();
    const watched = ['visa', 'residence_card_jp', 'green_card', 'drivers_license_us', 'drivers_license_jp', 'my_number_card_jp'];
    for (const it of items) {
      if (watched.indexOf(it.type) === -1 || !it.expiry_date) continue;
      const days = daysUntil(it.expiry_date);
      if (days < 0) {
        out.push({
          id: 'docvault_id_expired_' + it.id,
          group: 'docvault', urgency: 'critical', icon: '🪪',
          title: (it.title || typeLabel(it.type, 'en')) + ' EXPIRED',
          body: 'Expired on ' + it.expiry_date + '. Renew or replace immediately to avoid status / driving / banking issues.',
          deadline: it.expiry_date, module: 'document-vault', snoozable: false,
        });
      } else if (days <= 60) {
        out.push({
          id: 'docvault_id_soon_' + it.id,
          group: 'docvault', urgency: 'high', icon: '🪪',
          title: (it.title || typeLabel(it.type, 'en')) + ' expires in ' + days + ' days',
          body: 'Renewal often requires in-person appointment + waiting period. Start within the next 30 days.',
          deadline: it.expiry_date, module: 'document-vault', snoozable: false,
        });
      } else if (days <= 120) {
        out.push({
          id: 'docvault_id_warning_' + it.id,
          group: 'docvault', urgency: 'medium', icon: '🪪',
          title: (it.title || typeLabel(it.type, 'en')) + ' expires in ' + days + ' days',
          body: 'Plan the renewal — check requirements, schedule appointment if needed.',
          deadline: it.expiry_date, module: 'document-vault', snoozable: true,
        });
      }
    }
    return out;
  }

  function genWillStale() {
    const out = [];
    const items = getItems();
    const wills = items.filter((it) => it.type === 'will');
    if (wills.length === 0) return out;
    for (const w of wills) {
      const ageStr = w.issue_date || w.updated_at || w.created_at;
      if (!ageStr) continue;
      const refDate = ageStr.length > 10 ? ageStr : ageStr + 'T00:00:00';
      const ageDays = Math.round((new Date() - new Date(refDate)) / 86400000);
      if (ageDays > 5 * 365) {
        out.push({
          id: 'docvault_will_stale_' + w.id,
          group: 'docvault', urgency: 'medium', icon: '📜',
          title: 'Will is ' + Math.floor(ageDays / 365) + ' years old — review recommended',
          body: 'Wills should be reviewed every 3-5 years OR after life events: marriage, divorce, birth/death of family member, big asset change, move to new jurisdiction. Confirm beneficiaries + executor still appropriate.',
          module: 'document-vault', snoozable: true,
        });
      }
    }
    return out;
  }

  function genCriticalDocsMissing() {
    const out = [];
    const items = getItems();
    const types = new Set(items.map((it) => it.type));
    const missing = [];
    if (!types.has('passport_us') && !types.has('passport_jp') && !types.has('passport_other')) missing.push('passport');
    if (!types.has('will')) missing.push('will');
    const family = (TB.state.get('onboarding.answers.family')) || [];
    if (Array.isArray(family) && family.indexOf('jp_spouse') !== -1 && !types.has('marriage_cert')) {
      missing.push('marriage certificate');
    }
    if (missing.length === 0) return out;
    out.push({
      id: 'docvault_critical_missing',
      group: 'docvault', urgency: 'low', icon: '📋',
      title: 'Critical documents not in your vault: ' + missing.join(', '),
      body: 'Add these to the Document Vault so your family / executor can find them in an emergency. Use the upload button to auto-extract metadata from a photo.',
      module: 'document-vault', snoozable: true,
    });
    return out;
  }

  // ====================================================================
  // Survivor Binder integration
  // ====================================================================

  function getDocsForBinder() {
    const items = getItems();
    if (items.length === 0) return [];
    const byCat = {};
    for (const it of items) {
      (byCat[it.category || 'other'] = byCat[it.category || 'other'] || []).push(it);
    }
    const out = [];
    for (const cat of CATEGORIES) {
      if (!byCat[cat.id]) continue;
      out.push({ category: cat.id, label_en: cat.label_en, label_jp: cat.label_jp, emoji: cat.emoji,
        items: byCat[cat.id].sort((a, b) => (a.title || '').localeCompare(b.title || '')) });
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
    label_en: 'Document Vault',
    label_jp: 'ドキュメント保管庫',
    render,
  };

  window.TB.docVault = {
    getItems, getDocsForBinder, getDocsLinkedTo,
    getRenewalChecklist,
    openEditModal,  // used by back-references in other modules to edit
    upsertItem,     // used by other modules to add docs from their own import flows (Health Tracker insurance card)
    deleteItem,
    actionGenerators: [genPassportExpiring, genVisaResidenceExpiring, genWillStale, genCriticalDocsMissing],
    CATEGORIES, TYPES, typeLabel, categoryLabel, categoryEmoji,
  };
})();
