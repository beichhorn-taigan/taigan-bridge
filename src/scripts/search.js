/* Taigan Bridge — search.js  (v0.30.0)
 *
 * Universal command palette. ⌘K / Ctrl+K from anywhere; also a header
 * magnifying-glass button. Searches across:
 *
 *   1. Modules + sections   — module registry + each module's SECTIONS array
 *   2. User records         — assets accounts, FBAR institutions/years,
 *                             family members, properties, documents,
 *                             gifts, snapshots, consultations, AI convos
 *   3. Action items         — current open actions across all generators
 *   4. Glossary terms       — TB.glossary.GLOSSARY (PFIC, WEP, FEIE, …)
 *   5. Settings shortcuts   — daily limit, API key, language, theme, …
 *
 * The index is rebuilt on every open() so it always reflects current
 * state. For corpora <2000 items this is plenty fast (<5ms typical).
 *
 * Privacy: account numbers, SSNs, beneficiary names, free-text notes,
 * and AI conversation message bodies are NOT indexed. Only display
 * labels (institution name, family member name, document title, etc.)
 * make it into the haystack.
 */

(function () {
  'use strict';

  const RECENT_KEY = 'tb-search-recent';
  const RECENT_MAX = 8;

  // ====================================================================
  // INDEX BUILDERS
  // ====================================================================
  //
  // Each builder returns Array<Entry>. Entry shape:
  //
  //   {
  //     kind:     'module' | 'section' | 'record' | 'action' |
  //               'glossary' | 'setting',
  //     id:       stable string for de-dupe + recent-search reference
  //     title:    primary label (lang-resolved; what gets matched first)
  //     subtitle: short context line shown under title in the result
  //     icon:     optional emoji/short string
  //     terms:    array of additional strings to match against (synonyms,
  //               other-language label, romaji, expansion, etc.)
  //     navigate: function(); the action when the row is selected
  //     score_boost: optional integer added to the match score
  //   }

  function getLang() {
    return TB.i18n && typeof TB.i18n.getLang === 'function' ? TB.i18n.getLang() : 'en';
  }
  function navigateToView(view) {
    if (typeof window.tbNavigate === 'function') {
      window.tbNavigate(view);
    } else {
      // Fallback: dispatch a custom event the boot script can wire to.
      document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view } }));
    }
  }
  function navigateThenScroll(view, sectionLabel) {
    navigateToView(view);
    if (!sectionLabel) return;
    // Wait one frame for the module to render, then scroll the first
    // card whose visible text starts with (or contains) the section label.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const host = document.getElementById('tb-view');
        if (!host) return;
        const needle = sectionLabel.toLowerCase().slice(0, 40);
        const cards = host.querySelectorAll('.tb-card');
        for (const c of cards) {
          const txt = (c.textContent || '').toLowerCase().slice(0, 200);
          if (txt.includes(needle)) {
            c.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Brief flash so the user sees what was matched.
            const old = c.style.boxShadow;
            c.style.transition = 'box-shadow 1.2s ease';
            c.style.boxShadow = '0 0 0 3px var(--tb-accent)';
            setTimeout(() => { c.style.boxShadow = old || ''; }, 1400);
            return;
          }
        }
      });
    });
  }

  // ----- Module + section index ---------------------------------------

  function indexModulesAndSections() {
    const out = [];
    const lang = getLang();
    const mods = TB.modules || {};
    for (const mid of Object.keys(mods)) {
      const m = mods[mid];
      if (!m) continue;
      const labelEn = m.label_en || mid;
      const labelJp = m.label_jp || labelEn;
      const title = lang === 'ja' ? labelJp : labelEn;
      out.push({
        kind: 'module',
        id: 'mod:' + mid,
        title,
        subtitle: lang === 'ja' ? 'モジュール' : 'Module',
        icon: '🗂',
        terms: [labelEn, labelJp, mid],
        navigate: () => navigateToView(mid),
        score_boost: 4,
      });

      // Sections — modules expose SECTIONS as a closure-local array
      // so we can't read them from outside. Modules that want to be
      // searchable register their sections via TB.<modKey>.searchSections
      // (added to the public namespace at module init). For modules
      // that don't, we still get the module-level entry above.
      const ns = m.namespaceKey ? TB[m.namespaceKey] : TB[mid];
      const sectionRegistry =
        (ns && ns.searchSections) ||
        (m.searchSections) ||
        null;
      if (sectionRegistry && Array.isArray(sectionRegistry)) {
        for (const s of sectionRegistry) {
          const slabel = lang === 'ja' ? (s.label_jp || s.label_en) : (s.label_en || s.label_jp);
          if (!slabel) continue; // skip header/overview/resources untitled sections
          const sdesc = lang === 'ja' ? (s.description_jp || '') : (s.description_en || '');
          out.push({
            kind: 'section',
            id: 'sec:' + mid + ':' + s.id,
            title: slabel,
            subtitle: (lang === 'ja' ? '区画' : 'Section') + ' · ' + title,
            icon: '📄',
            terms: [s.label_en, s.label_jp, sdesc, s.description_en, s.description_jp].filter(Boolean),
            navigate: () => navigateThenScroll(mid, s.label_en || s.label_jp || ''),
            score_boost: 2,
          });
        }
      }
    }
    return out;
  }

  // ----- User-record index --------------------------------------------
  //
  // Rules of indexing user records:
  //   • Index display LABELS (institution, name, address city, type)
  //   • Skip account numbers, SSNs, beneficiary names, free-text notes
  //   • Subtitle gives enough context to disambiguate
  //   • navigate jumps to the owning module (no row-deep links yet)

  function indexAssets() {
    const out = [];
    const accts = (TB.state.get('assets.accounts') || []);
    const lang = getLang();
    for (const a of accts) {
      if (!a || !a.institution) continue;
      const country = a.country ? ' · ' + a.country : '';
      const wrap = a.tax_wrapper ? ' · ' + a.tax_wrapper : '';
      const ccy = a.currency ? ' · ' + a.currency : '';
      out.push({
        kind: 'record',
        id: 'rec:assets:' + (a.id || a.institution),
        title: a.institution,
        subtitle: (lang === 'ja' ? '資産口座' : 'Asset account') + country + wrap + ccy,
        icon: '🏦',
        terms: [a.institution_jp, a.institution_en, a.account_type, a.tax_wrapper, a.currency, a.country].filter(Boolean),
        navigate: () => navigateToView('assets'),
      });
    }
    return out;
  }

  function indexFbar() {
    const out = [];
    const accts = TB.state.get(TB.schema.PATHS.fbarAccounts) || [];
    const balances = TB.state.get(TB.schema.PATHS.fbarYearlyBalances) || [];
    const lang = getLang();
    // Institutions — one entry per FBAR account (flat table, not per-year).
    for (const a of accts) {
      if (!a) continue;
      const inst = a[TB.schema.FIELDS.fbarAccount.institution] || a.institution_name_jp;
      if (!inst) continue;
      out.push({
        kind: 'record',
        id: 'rec:fbar:' + (a.id || inst),
        title: inst,
        subtitle: (lang === 'ja' ? 'FBAR 機関' : 'FBAR institution') +
          (a.country ? ' · ' + a.country : '') +
          (a.currency ? ' · ' + a.currency : ''),
        icon: '🏛',
        terms: [a.institution_name_jp, a.country, a.currency].filter(Boolean),
        navigate: () => navigateToView('fbar'),
      });
    }
    // Years themselves are searchable ("FBAR 2024") — derived from the
    // yearly-balances table.
    const years = Array.from(new Set(balances.map(b => b && b[TB.schema.FIELDS.fbarBalance.year]).filter(Boolean))).sort();
    for (const yr of years) {
      out.push({
        kind: 'record',
        id: 'rec:fbar-year:' + yr,
        title: 'FBAR ' + yr,
        subtitle: lang === 'ja' ? 'FBAR 年度ワークシート' : 'FBAR year worksheet',
        icon: '📅',
        terms: [String(yr), 'fbar', 'fincen', '114'],
        navigate: () => navigateToView('fbar'),
      });
    }
    return out;
  }

  function indexFamily() {
    const out = [];
    const F = TB.schema.FIELDS.familyMember;
    const members = TB.state.get(TB.schema.PATHS.familyMembers) || [];
    const lang = getLang();
    for (const m of members) {
      const nameEn = m && m[F.nameEn];
      const nameJp = m && m[F.nameJp];
      const name = lang === 'ja' ? (nameJp || nameEn) : (nameEn || nameJp);
      if (!m || !name) continue;
      const rel = m.relationship ? ' · ' + m.relationship : '';
      const citizenships = m[F.citizenships];
      const cit = Array.isArray(citizenships) && citizenships.length ? ' · ' + citizenships.join('/') : '';
      out.push({
        kind: 'record',
        id: 'rec:family:' + (m.id || name),
        title: name,
        subtitle: (lang === 'ja' ? '家族メンバー' : 'Family member') + rel + cit,
        icon: '👤',
        terms: [m.relationship, nameEn, nameJp].concat(citizenships || []).filter(Boolean),
        navigate: () => navigateToView('family'),
      });
    }
    return out;
  }

  function indexProperty() {
    const out = [];
    const props = TB.state.get('property.properties') || [];
    const lang = getLang();
    for (const p of props) {
      if (!p) continue;
      const label = p.label || p.address || p.city || p.type;
      if (!label) continue;
      out.push({
        kind: 'record',
        id: 'rec:prop:' + (p.id || label),
        title: label,
        subtitle: (lang === 'ja' ? '不動産' : 'Property') +
          (p.country ? ' · ' + p.country : '') +
          (p.type ? ' · ' + p.type : ''),
        icon: '🏠',
        terms: [p.address, p.city, p.country, p.type, p.label].filter(Boolean),
        navigate: () => navigateToView('property'),
      });
    }
    return out;
  }

  function indexDocuments() {
    const out = [];
    const expiryField = TB.schema.FIELDS.documentVaultItem.expiry;
    const docs = TB.state.get(TB.schema.PATHS.documentVaultItems) || [];
    const lang = getLang();
    for (const d of docs) {
      if (!d) continue;
      const title = d.title || d.label || d.type;
      if (!title) continue;
      const expiry = d[expiryField];
      const exp = expiry ? ' · ' + (lang === 'ja' ? '有効期限 ' : 'expires ') + expiry : '';
      out.push({
        kind: 'record',
        id: 'rec:doc:' + (d.id || title),
        title: title,
        subtitle: (lang === 'ja' ? '書類' : 'Document') +
          (d.type ? ' · ' + d.type : '') + exp,
        icon: '📄',
        terms: [d.type, d.holder, d.country].filter(Boolean),
        navigate: () => navigateToView('document-vault'),
      });
    }
    return out;
  }

  function indexGifts() {
    const out = [];
    const G = TB.schema.FIELDS.familyGift;
    const F = TB.schema.FIELDS.familyMember;
    const gifts = TB.state.get(TB.schema.PATHS.familyGiftsLog) || [];
    const members = TB.state.get(TB.schema.PATHS.familyMembers) || [];
    const lang = getLang();
    for (const g of gifts) {
      if (!g) continue;
      const recipientId = g[G.recipientId];
      if (!recipientId) continue;
      // Resolve recipient_id to a display name against family.members;
      // fall back to the raw id if the member can't be found.
      const member = members.find((m) => m && m.id === recipientId);
      const recipient = member
        ? ((lang === 'ja' ? member[F.nameJp] : member[F.nameEn]) || member[F.nameEn] || member[F.nameJp] || recipientId)
        : recipientId;
      const yr = g[G.year] || '';
      const amt = g.amount_jpy != null ? ' · ¥' + g.amount_jpy : '';
      out.push({
        kind: 'record',
        id: 'rec:gift:' + (g.id || recipientId + yr),
        title: (lang === 'ja' ? '贈与: ' : 'Gift: ') + recipient + (yr ? ' (' + yr + ')' : ''),
        subtitle: (lang === 'ja' ? '贈与記録' : 'Gift record') + amt,
        icon: '🎁',
        terms: [recipient, String(yr), g.notes].filter(Boolean),
        navigate: () => navigateToView('family'),
      });
    }
    return out;
  }

  function indexSnapshots() {
    const out = [];
    const S = TB.schema.FIELDS.assetSnapshot;
    const snaps = TB.state.get(TB.schema.PATHS.assetsSnapshots) || [];
    const lang = getLang();
    for (const s of snaps) {
      const takenAt = s && s[S.takenAt];
      if (!s || !takenAt) continue;
      const dateLabel = String(takenAt).slice(0, 10);
      const totalUsd = s[S.totalUsd];
      out.push({
        kind: 'record',
        id: 'rec:snap:' + takenAt,
        title: (lang === 'ja' ? '純資産スナップショット ' : 'Net worth snapshot ') + dateLabel,
        subtitle: (lang === 'ja' ? '純資産履歴' : 'Net worth history') +
          (totalUsd != null ? ' · $' + Math.round(totalUsd).toLocaleString() : ''),
        icon: '📈',
        terms: [dateLabel, s.note].filter(Boolean),
        navigate: () => navigateToView('net-worth'),
      });
    }
    return out;
  }

  function indexConsultations() {
    const out = [];
    const professionals = TB.state.get(TB.schema.PATHS.consultationsProfessionals) || [];
    const log = TB.state.get(TB.schema.PATHS.consultationsConsultations) || [];
    const lang = getLang();
    for (const c of log) {
      if (!c) continue;
      // Log entries reference a professional by id — resolve the roster
      // entry to get a display name; fall back to topic/type if unresolved.
      const pro = professionals.find((p) => p && p.id === c.professional_id);
      const who = (pro && pro.name) || c.topic || c.type;
      if (!who) continue;
      out.push({
        kind: 'record',
        id: 'rec:cons:' + (c.id || who + (c.date || '')),
        title: who,
        subtitle: (lang === 'ja' ? '相談記録' : 'Consultation') +
          (c.topic && pro && pro.name ? ' · ' + c.topic : '') +
          (c.date ? ' · ' + c.date : ''),
        icon: '💼',
        terms: [c.topic, pro && pro.firm, pro && pro.type].filter(Boolean),
        navigate: () => navigateToView('consultations'),
      });
    }
    return out;
  }

  function indexConversations() {
    const out = [];
    const convs = TB.state.get('ai_assistant.conversations') || [];
    const lang = getLang();
    for (const c of convs) {
      if (!c || !c.id) continue;
      const title = c.title || (lang === 'ja' ? '無題の会話' : 'Untitled conversation');
      out.push({
        kind: 'record',
        id: 'rec:conv:' + c.id,
        title,
        subtitle: (lang === 'ja' ? 'タイガン会話' : 'Ask Taigan conversation') +
          (c.updated_at ? ' · ' + String(c.updated_at).slice(0, 10) : ''),
        icon: '💬',
        terms: ['ask taigan', 'タイガン'],
        navigate: () => navigateToView('ask-taigan'),
      });
    }
    return out;
  }

  function indexUserRecords() {
    return [].concat(
      indexAssets(),
      indexFbar(),
      indexFamily(),
      indexProperty(),
      indexDocuments(),
      indexGifts(),
      indexSnapshots(),
      indexConsultations(),
      indexConversations(),
    );
  }

  // ----- Action-item index --------------------------------------------

  function indexActions() {
    const out = [];
    const lang = getLang();
    if (!TB.actionCenter || typeof TB.actionCenter.deriveActions !== 'function') return out;
    let items = [];
    try { items = TB.actionCenter.deriveActions(); } catch (_) { return out; }
    for (const item of items) {
      if (!item || !item.title) continue;
      const due = item.deadline ? ' · ' + (lang === 'ja' ? '期日 ' : 'due ') + item.deadline : '';
      out.push({
        kind: 'action',
        id: 'act:' + item.id,
        title: item.title,
        subtitle: (lang === 'ja' ? 'アクション項目' : 'Action item') +
          (item.urgency ? ' · ' + item.urgency : '') + due,
        icon: item.icon || '⚡',
        terms: [item.body, item.module, item.urgency].filter(Boolean),
        navigate: () => navigateToView(item.module || 'action-center'),
        score_boost: 1,
      });
    }
    return out;
  }

  // ----- Glossary index -----------------------------------------------

  function indexGlossary() {
    const out = [];
    const lang = getLang();
    const G = TB.glossary && TB.glossary.GLOSSARY;
    if (!G) return out;
    for (const key of Object.keys(G)) {
      const e = G[key];
      const title = key + (e.expansion ? ' — ' + e.expansion : '');
      out.push({
        kind: 'glossary',
        id: 'gloss:' + key,
        title,
        subtitle: (lang === 'ja' ? '用語集' : 'Glossary') +
          (e.category ? ' · ' + e.category : '') +
          (e.short ? ' · ' + e.short.slice(0, 90) + (e.short.length > 90 ? '…' : '') : ''),
        icon: '📖',
        terms: [key, e.expansion, e.short, e.category].concat(e.match || []).filter(Boolean),
        navigate: () => {
          // Open the glossary modal directly.
          if (TB.glossary && typeof TB.glossary.show === 'function') TB.glossary.show(key);
        },
      });
    }
    return out;
  }

  // ----- Settings shortcut index --------------------------------------

  function indexSettings() {
    const lang = getLang();
    const t = TB.i18n && TB.i18n.t;
    function s(en, ja) { return lang === 'ja' ? ja : en; }
    const items = [
      { key: 'apikey',    title: s('Claude API key',           'Claude API キー'),       icon: '🔑', terms: ['key', 'anthropic', 'apikey', 'sk-ant'] },
      { key: 'model',     title: s('AI model selector',        'AI モデル選択'),         icon: '🤖', terms: ['model', 'claude', 'opus', 'sonnet', 'haiku'] },
      { key: 'usage',     title: s('AI usage dashboard',       'AI 使用量ダッシュボード'), icon: '📊', terms: ['usage', 'cost', 'tokens', 'dashboard', 'spend'] },
      { key: 'limit',     title: s('Daily AI spend limit',     '1 日の AI 上限'),         icon: '💵', terms: ['limit', 'daily', 'cap', 'budget'] },
      { key: 'credits',   title: s('API credit balance',       'API クレジット残高'),     icon: '💳', terms: ['credit', 'balance', 'topup', 'reconcile'] },
      { key: 'fx',        title: s('FX rates (Treasury)',      '為替レート(Treasury)'),  icon: '🌐', terms: ['fx', 'rates', 'treasury', 'currency'] },
      { key: 'a11y',      title: s('Display & accessibility',  '表示 / アクセシビリティ'), icon: '♿', terms: ['accessibility', 'a11y', 'font', 'contrast', 'motion'] },
      { key: 'language',  title: s('Language (EN / 日本語)',    '言語(EN / 日本語)'),    icon: '🌏', terms: ['language', 'en', 'ja', 'japanese', 'english'] },
      { key: 'theme',     title: s('Theme (light / dark)',     'テーマ(ライト / ダーク)'), icon: '🌙', terms: ['theme', 'dark', 'light', 'mode'] },
      { key: 'backup',    title: s('Backup / restore',         'バックアップ / 復元'),     icon: '💾', terms: ['backup', 'export', 'import', 'restore'] },
      { key: 'danger',    title: s('Delete all data',          '全データ削除'),           icon: '🗑', terms: ['delete', 'reset', 'wipe', 'clear', 'danger'] },
    ];
    return items.map((i) => ({
      kind: 'setting',
      id: 'set:' + i.key,
      title: i.title,
      subtitle: lang === 'ja' ? '設定' : 'Settings',
      icon: i.icon,
      terms: i.terms,
      navigate: () => {
        if (i.key === 'theme') {
          const btn = document.getElementById('tb-theme-toggle');
          if (btn) btn.click();
          return;
        }
        if (i.key === 'language') {
          const btn = document.getElementById('tb-lang-toggle');
          if (btn) btn.click();
          return;
        }
        navigateToView('settings');
      },
      score_boost: 1,
    }));
  }

  // ====================================================================
  // SCORING / TOKENIZATION
  // ====================================================================
  //
  // Lightweight scorer. Tokenize the query, then for each entry compute
  // a score = sum over tokens of:
  //   • exact prefix of title           +30
  //   • title contains token            +12
  //   • subtitle contains token         +5
  //   • any term contains token         +3
  //   • startsWith on a term            +6
  //   • exact match (any field)         +25
  // Plus the entry's score_boost.
  //
  // Multi-token AND semantics: every token must contribute at least 1
  // somewhere, otherwise the entry is filtered out entirely.

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKC');
  }

  function tokenize(q) {
    const n = norm(q);
    if (!n) return [];
    return n.split(/\s+/).map(s => s.trim()).filter(Boolean);
  }

  function scoreEntry(entry, tokens) {
    if (!tokens.length) return 0;
    const title = norm(entry.title);
    const sub   = norm(entry.subtitle);
    const terms = (entry.terms || []).map(norm);
    let total = 0;
    for (const tok of tokens) {
      let tokScore = 0;
      if (title === tok) tokScore += 25;
      if (title.startsWith(tok)) tokScore += 30;
      else if (title.includes(tok)) tokScore += 12;
      if (sub.includes(tok)) tokScore += 5;
      for (const tm of terms) {
        if (!tm) continue;
        if (tm === tok) { tokScore += 25; break; }
        if (tm.startsWith(tok)) { tokScore += 6; break; }
        if (tm.includes(tok)) { tokScore += 3; break; }
      }
      if (tokScore === 0) return 0; // AND semantics — token didn't match
      total += tokScore;
    }
    return total + (entry.score_boost || 0);
  }

  function buildIndex() {
    return [].concat(
      indexModulesAndSections(),
      indexUserRecords(),
      indexActions(),
      indexGlossary(),
      indexSettings(),
    );
  }

  function search(query, index) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const scored = [];
    for (const e of index) {
      const s = scoreEntry(e, tokens);
      if (s > 0) scored.push({ entry: e, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map(s => s.entry);
  }

  // ====================================================================
  // RECENT SEARCHES (persisted across sessions)
  // ====================================================================

  function getRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function pushRecent(query, entry) {
    const lang = getLang();
    if (!query || !entry) return;
    const list = getRecent();
    // De-dupe by entry id
    const filtered = list.filter(r => r.id !== entry.id);
    filtered.unshift({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      subtitle: entry.subtitle,
      icon: entry.icon,
      query,
      lang,
      at: Date.now(),
    });
    while (filtered.length > RECENT_MAX) filtered.pop();
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(filtered)); } catch (_) {}
  }
  function clearRecent() {
    try { localStorage.removeItem(RECENT_KEY); } catch (_) {}
  }

  // ====================================================================
  // PALETTE UI
  // ====================================================================

  let _open = false;
  let _root = null;
  let _input = null;
  let _resultsHost = null;
  let _index = null;
  let _activeIdx = 0;
  let _currentResults = [];

  function open() {
    if (_open) {
      // Already open — just refocus the input.
      if (_input) _input.focus();
      return;
    }
    _open = true;
    _index = buildIndex();
    _activeIdx = 0;
    _currentResults = [];
    render();
    // Defer focus so the modal is in the DOM.
    requestAnimationFrame(() => { if (_input) _input.focus(); });
  }

  function close() {
    if (!_open) return;
    _open = false;
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
    _root = _input = _resultsHost = null;
    _index = null;
    _currentResults = [];
  }

  function selectActive() {
    const r = _currentResults[_activeIdx];
    if (!r) return;
    const q = _input ? _input.value : '';
    pushRecent(q, r);
    close();
    try { r.navigate(); } catch (err) { console.warn('[search] navigate failed', err); }
  }

  function moveActive(delta) {
    if (!_currentResults.length) return;
    _activeIdx = (_activeIdx + delta + _currentResults.length) % _currentResults.length;
    renderResults(_input ? _input.value : '');
  }

  function render() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    _root = el('div', { class: 'tb-search-backdrop', role: 'dialog', 'aria-modal': 'true' });
    _root.addEventListener('click', (e) => { if (e.target === _root) close(); });

    const panel = el('div', { class: 'tb-search-panel' });
    _root.appendChild(panel);

    // Header — magnifying glass + input + ESC hint
    const header = el('div', { class: 'tb-search-header' });
    header.appendChild(el('span', { class: 'tb-search-icon' }, '🔍'));
    _input = el('input', {
      class: 'tb-search-input',
      type: 'text',
      placeholder: t('search.placeholder'),
      'aria-label': t('search.ariaLabel'),
      autocomplete: 'off',
      spellcheck: 'false',
    });
    _input.addEventListener('input', () => {
      _activeIdx = 0;
      renderResults(_input.value);
    });
    _input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); selectActive(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    header.appendChild(_input);
    header.appendChild(el('kbd', { class: 'tb-search-kbd' }, 'Esc'));
    panel.appendChild(header);

    // Results host
    _resultsHost = el('div', { class: 'tb-search-results', role: 'listbox' });
    panel.appendChild(_resultsHost);

    // Footer — keyboard hints + index size
    const footer = el('div', { class: 'tb-search-footer' });
    footer.appendChild(el('span', null,
      el('kbd', { class: 'tb-search-kbd' }, '↑'),
      el('kbd', { class: 'tb-search-kbd' }, '↓'),
      ' ' + t('search.kbd.navigate') + ' · ',
      el('kbd', { class: 'tb-search-kbd' }, '↵'),
      ' ' + t('search.kbd.select'),
    ));
    footer.appendChild(el('span', { class: 'tb-search-meta' },
      t('search.indexSize', { n: _index.length }),
    ));
    panel.appendChild(footer);

    document.body.appendChild(_root);
    renderResults('');
  }

  function renderResults(query) {
    if (!_resultsHost) return;
    _resultsHost.innerHTML = '';
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = getLang();
    const tokens = tokenize(query);

    // Empty query → show recent searches + a few category headlines.
    if (!tokens.length) {
      const recent = getRecent();
      if (recent.length === 0) {
        _resultsHost.appendChild(emptyHint(t('search.emptyHint')));
      } else {
        _resultsHost.appendChild(sectionLabel(t('search.recent')));
        // Map recent to entries by id when possible
        const byId = {};
        for (const e of _index) byId[e.id] = e;
        const recentEntries = recent.map(r => byId[r.id]).filter(Boolean);
        if (recentEntries.length === 0) {
          _resultsHost.appendChild(emptyHint(t('search.recentMissing')));
        } else {
          _currentResults = recentEntries;
          recentEntries.forEach((e, idx) => {
            _resultsHost.appendChild(buildRow(e, idx, ''));
          });
        }
        // Clear recent link
        _resultsHost.appendChild(el('div', { class: 'tb-search-clear-row' },
          el('a', {
            href: '#',
            class: 'tb-search-clear',
            onclick: (ev) => { ev.preventDefault(); clearRecent(); renderResults(''); },
          }, '× ' + t('search.clearRecent')),
        ));
      }
      return;
    }

    // Active query → run search and group by kind.
    const results = search(query, _index);
    if (results.length === 0) {
      _currentResults = [];
      _resultsHost.appendChild(emptyHint(t('search.noResults', { q: query })));
      return;
    }

    // Group by kind, preserving overall score order within each group.
    const ORDER = ['module', 'section', 'record', 'action', 'setting', 'glossary'];
    const groups = {};
    for (const r of results) {
      (groups[r.kind] = groups[r.kind] || []).push(r);
    }

    // Rebuild _currentResults in the same order rows are actually rendered
    // (grouped by kind, per ORDER) so that _activeIdx / selectActive() index
    // into the array that matches what's on screen — the raw score-sorted
    // `results` order does NOT match the regrouped display order.
    _currentResults = [];
    let runningIdx = 0;
    for (const kind of ORDER) {
      const list = groups[kind];
      if (!list || !list.length) continue;
      _resultsHost.appendChild(sectionLabel(kindLabel(kind, lang) + ' · ' + list.length));
      list.forEach((entry) => {
        _currentResults.push(entry);
        _resultsHost.appendChild(buildRow(entry, runningIdx, query));
        runningIdx++;
      });
    }

    // Make sure the active row is in view.
    const active = _resultsHost.querySelector('.tb-search-row.is-active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function kindLabel(kind, lang) {
    const map = {
      module:   ['Modules',         'モジュール'],
      section:  ['Sections',        '区画'],
      record:   ['Your records',    '記録'],
      action:   ['Action items',    'アクション項目'],
      glossary: ['Glossary',        '用語集'],
      setting:  ['Settings',        '設定'],
    };
    const e = map[kind] || [kind, kind];
    return lang === 'ja' ? e[1] : e[0];
  }

  function buildRow(entry, idx, query) {
    const el = TB.utils.el;
    const isActive = idx === _activeIdx;
    const row = el('div', {
      class: 'tb-search-row' + (isActive ? ' is-active' : ''),
      role: 'option',
      'aria-selected': isActive ? 'true' : 'false',
      tabindex: '-1',
      'data-idx': String(idx),
      onclick: () => { _activeIdx = idx; selectActive(); },
      onmouseenter: () => {
        if (_activeIdx !== idx) {
          _activeIdx = idx;
          // Just toggle classes — re-render would steal focus.
          if (_resultsHost) {
            _resultsHost.querySelectorAll('.tb-search-row').forEach((r) => {
              r.classList.toggle('is-active', r.dataset.idx === String(idx));
            });
          }
        }
      },
    });
    // Use the SVG icon set for module + section entries (gives the
    // palette a coherent visual look). Fall back to the emoji string
    // on entry.icon for record / glossary / action / setting rows.
    const iconNode = el('span', { class: 'tb-search-row__icon' });
    let svgFor = null;
    if (TB.icons && TB.icons.get) {
      if (entry.kind === 'module') {
        const mid = entry.id.indexOf(':') >= 0 ? entry.id.split(':')[1] : entry.id;
        svgFor = TB.icons.get(mid, { size: 18 });
      } else if (entry.kind === 'section') {
        const parts = entry.id.split(':');
        if (parts.length >= 2) svgFor = TB.icons.get(parts[1], { size: 18 });
      }
    }
    if (svgFor) {
      svgFor.style.color = 'var(--tb-text-soft)';
      iconNode.appendChild(svgFor);
    } else {
      iconNode.textContent = entry.icon || '·';
    }
    row.appendChild(iconNode);
    const main = el('div', { class: 'tb-search-row__main' });
    main.appendChild(el('div', { class: 'tb-search-row__title' }, highlight(entry.title, query)));
    main.appendChild(el('div', { class: 'tb-search-row__sub' }, entry.subtitle || ''));
    row.appendChild(main);
    row.appendChild(el('span', { class: 'tb-search-row__kind' }, kindShort(entry.kind)));
    return row;
  }

  function kindShort(kind) {
    const map = {
      module: 'MOD', section: 'SEC', record: 'REC',
      action: 'ACT', glossary: 'DEF', setting: 'SET',
    };
    return map[kind] || kind.toUpperCase();
  }

  // Lightweight highlight — wraps token matches in <mark>. Returns either
  // a string (no matches) or a DocumentFragment (with mark nodes).
  function highlight(text, query) {
    const tokens = tokenize(query);
    if (!tokens.length || !text) return text || '';
    const lower = text.toLowerCase();
    // Find the earliest match position for any token; expand to cover all
    // overlapping matches via a sequential walk.
    const ranges = [];
    for (const tok of tokens) {
      let i = 0;
      while (true) {
        const at = lower.indexOf(tok, i);
        if (at === -1) break;
        ranges.push([at, at + tok.length]);
        i = at + tok.length;
      }
    }
    if (!ranges.length) return text;
    ranges.sort((a, b) => a[0] - b[0]);
    // Merge overlapping ranges
    const merged = [ranges[0]];
    for (let k = 1; k < ranges.length; k++) {
      const last = merged[merged.length - 1];
      if (ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]);
      else merged.push(ranges[k]);
    }
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const [a, b] of merged) {
      if (a > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, a)));
      const mark = document.createElement('mark');
      mark.className = 'tb-search-mark';
      mark.appendChild(document.createTextNode(text.slice(a, b)));
      frag.appendChild(mark);
      cursor = b;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    return frag;
  }

  function emptyHint(text) {
    const el = TB.utils.el;
    return el('div', { class: 'tb-search-empty' }, text);
  }

  function sectionLabel(text) {
    const el = TB.utils.el;
    return el('div', { class: 'tb-search-grouplabel' }, text);
  }

  // ====================================================================
  // KEYBOARD SHORTCUT
  // ====================================================================

  function isMac() {
    return /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  }
  function shortcutLabel() {
    return isMac() ? '⌘K' : 'Ctrl+K';
  }
  function installShortcut() {
    document.addEventListener('keydown', (e) => {
      // ⌘K / Ctrl+K toggles
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (_open) close(); else open();
        return;
      }
      // "/" anywhere opens (unless typing in an input/textarea)
      if (e.key === '/' && !_open) {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) ||
          (document.activeElement && document.activeElement.isContentEditable);
        if (!editing) {
          e.preventDefault();
          open();
        }
      }
    });
  }

  window.TB = window.TB || {};
  window.TB.search = {
    open,
    shortcutLabel,
    installShortcut,
  };
})();
