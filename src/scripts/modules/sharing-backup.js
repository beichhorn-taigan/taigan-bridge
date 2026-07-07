/* Taigan Bridge — modules/sharing-backup.js
 *
 * Sharing & Backup — generates shareable views for the typical
 * secondary consumers in this demographic's life:
 *
 *   1. Spouse handoff       — read-only HTML snapshot of the user's
 *                             situation. Self-contained .html file
 *                             with inline CSS, no JS, prints cleanly,
 *                             works offline.
 *   2. Survivor mode        — extended Letter of Instruction as a
 *                             standalone HTML file. Includes
 *                             immediate-action checklist, account
 *                             inventory, document locations,
 *                             funeral preferences, contacts.
 *   3. Advisor share (JSON) — tax-relevant subset for CPA review.
 *                             User-controllable scope (balances,
 *                             documents list, family anonymization).
 *   4. Full backup          — complete state.json export.
 *   5. Restore              — JSON import with confirmation.
 *
 * Each generation logs an entry in sharing.shares_log so the user
 * can see what they've shared and when. Files download directly to
 * the user's device — nothing is uploaded anywhere.
 */

(function () {
  'use strict';

  const id = 'sharing-backup';

  // ====================================================================
  // i18n — Action Center generator strings (self-registered so this
  // module doesn't need to touch the shared i18n.js dictionary file).
  // ====================================================================

  TB.i18n.extend('en', {
    'sb.genBackupOverdue.never.title': 'Back up your Taigan Bridge data',
    'sb.genBackupOverdue.never.body': 'You\'ve entered substantial data but haven\'t backed up yet. A single-file backup downloads as one JSON you can store anywhere. Click to back up now.',
    'sb.genBackupOverdue.overdue.title': 'Last backup was {{days}} days ago',
    'sb.genBackupOverdue.overdue.body': 'Consider downloading a fresh backup. The export is a single JSON file with everything you\'ve entered — store it where you keep your other important records.',
  });

  TB.i18n.extend('ja', {
    'sb.genBackupOverdue.never.title': 'Taigan Bridge のデータをバックアップしましょう',
    'sb.genBackupOverdue.never.body': 'かなりの量のデータを入力済みですが、まだバックアップしていません。バックアップは 1 つの JSON ファイルとしてダウンロードされ、どこにでも保存できます。クリックして今すぐバックアップ。',
    'sb.genBackupOverdue.overdue.title': '前回のバックアップから {{days}} 日経過',
    'sb.genBackupOverdue.overdue.body': '最新のバックアップのダウンロードをご検討ください。エクスポートは入力済みの全データを含む単一の JSON ファイルです — 他の重要な記録と同じ場所に保管してください。',
  });

  // ====================================================================
  // State accessors
  // ====================================================================

  function getSharing()    { return TB.state.get('sharing') || {}; }
  function getLog()        { return getSharing().shares_log || []; }
  function getPrefs()      { return getSharing().preferences || {}; }
  function setPrefs(value) {
    const s = getSharing();
    s.preferences = value;
    TB.state.set('sharing', s);
  }
  function appendLog(entry) {
    const s = getSharing();
    s.shares_log = (s.shares_log || []).concat([entry]);
    TB.state.set('sharing', s);
  }

  // ====================================================================
  // HTML generation utilities
  // ====================================================================

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Shared inline CSS for generated HTML files. Light + dark friendly,
  // print-clean. Self-contained — no external font/image deps.
  //
  // The @media print block is intentionally large because survivor /
  // spouse guides are designed to be printed and stored alongside the
  // physical will. Browser default printing leaves orphaned headings
  // at page bottoms, splits checklists across page breaks, and prints
  // colored backgrounds (which look terrible photocopied). Every rule
  // below addresses one of those failure modes.
  const SHARED_CSS = `
    body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      max-width: 900px; margin: 0 auto; padding: 32px 24px; line-height: 1.55; color: #14181F; background: #FAF7EF; }
    h1 { font-size: 1.75rem; margin: 0 0 8px; color: #0E2A4F; }
    h2 { font-size: 1.25rem; margin: 32px 0 12px; color: #0E2A4F; border-bottom: 1px solid #DCD5C4; padding-bottom: 6px; }
    h3 { font-size: 1rem; margin: 24px 0 8px; }
    p { margin: 0 0 12px; }
    .meta { color: #5C6470; font-size: 0.85rem; margin-bottom: 16px; }
    .banner { padding: 12px 16px; border-left: 4px solid #B7472A; background: #FFF7F2; border-radius: 4px; margin-bottom: 24px; font-size: 0.9rem; }
    .banner.success { border-color: #2F6F4E; background: #F2FAF5; }
    .banner.warn { border-color: #B97A1A; background: #FFF7E8; }
    .card { padding: 16px 20px; background: #FFFFFF; border: 1px solid #DCD5C4; border-radius: 8px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #DCD5C4; font-size: 0.9rem; vertical-align: top; }
    th { background: #F0EBDD; font-weight: 600; font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; color: #5C6470; }
    .label { color: #5C6470; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-top: 16px; }
    .stat { font-family: "JetBrains Mono", "Consolas", monospace; font-weight: 700; font-size: 1.5rem; color: #14181F; }
    .stat-row { display: flex; gap: 24px; flex-wrap: wrap; margin: 16px 0; }
    .stat-tile { flex: 1; min-width: 160px; padding: 12px 16px; background: #FFFFFF; border-radius: 8px; border: 1px solid #DCD5C4; }
    .toc { padding: 12px 16px; background: #F0EBDD; border-radius: 8px; margin-bottom: 24px; }
    .toc a { color: #0E2A4F; text-decoration: none; margin-right: 16px; display: inline-block; padding: 2px 0; }
    .toc a:hover { text-decoration: underline; }
    ul.checklist { list-style: none; padding: 0; }
    ul.checklist li { padding: 8px 12px; border: 1px solid #DCD5C4; border-radius: 4px; margin-bottom: 6px; background: #FFFFFF; }
    ul.checklist li::before { content: "☐ "; color: #5C6470; margin-right: 6px; }
    .footer { margin-top: 48px; padding: 16px; border-top: 1px solid #DCD5C4; color: #5C6470; font-size: 0.8rem; text-align: center; }

    /* Floating Print button — only visible on screen. The generated
       file is meant to be filed with paper records, so we make the
       print step one click away on first open. Hidden via @media
       print so it doesn't render onto the page itself. */
    .tb-print-btn {
      position: fixed; top: 16px; right: 16px;
      padding: 10px 18px; background: #0E2A4F; color: #fff;
      border: none; border-radius: 6px; cursor: pointer;
      font-size: 0.9rem; font-weight: 600;
      box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      z-index: 9999;
    }
    .tb-print-btn:hover { background: #1A3D6E; }

    @media print {
      /* Page setup — US Letter with reasonable margins, page numbers
         in the footer. Most browsers honor these. The named "info"
         counter increments via @page, surfaced by a footer rule below. */
      @page {
        size: letter;
        margin: 0.75in 0.75in 0.9in;
        @bottom-center {
          content: "Page " counter(page) " of " counter(pages);
          font-family: -apple-system, system-ui, sans-serif;
          font-size: 9pt;
          color: #5C6470;
        }
      }

      /* Black on white. The cream/off-white look is fine on screen
         but wastes ink and bleeds through cheap paper. */
      body {
        background: #fff;
        color: #000;
        max-width: none;
        padding: 0;
        font-size: 10.5pt;
        line-height: 1.5;
      }

      /* Strip decorative chrome — boxes, shadows, color fills.
         Borders stay (they help readability of cards / banners as
         standalone sections) but the colored backgrounds drop. */
      .banner, .card, .toc, ul.checklist li, .stat-tile, th {
        background: #fff !important;
        box-shadow: none !important;
      }
      .banner { border: 1px solid #999; padding: 8px 12px; }
      .card   { border: 1px solid #999; padding: 8px 12px; }
      .toc    { display: none; } /* anchor links are dead on paper */

      /* Headings stay with their content. h2 starts a new section
         visually — and prefers a fresh page when more than ~3 lines
         from the previous section's bottom (browser-dependent but
         saves us from "Section 4" appearing alone at page bottom). */
      h1, h2, h3 { color: #000; page-break-after: avoid; break-after: avoid; }
      h2 {
        margin-top: 24pt;
        padding-top: 4pt;
        border-bottom: 1pt solid #000;
        page-break-before: auto;
        break-before: auto;
      }
      h2 + p, h2 + ul, h2 + table, h2 + .card,
      h3 + p, h3 + ul, h3 + table { page-break-before: avoid; break-before: avoid; }

      /* Tables — the bread and butter of survivor / spouse guides
         (account inventory, document locations, statutory shares).
         Repeat the header on each page when a long table breaks. */
      table { page-break-inside: auto; break-inside: auto; }
      thead { display: table-header-group; }
      tr    { page-break-inside: avoid; break-inside: avoid; }
      th, td { font-size: 9.5pt; padding: 6pt 8pt; border-bottom: 0.5pt solid #999; }

      /* Checklist items — keep individual items intact, and drop
         the colored card chrome so they read like a printed form. */
      ul.checklist li {
        page-break-inside: avoid; break-inside: avoid;
        border: none;
        border-bottom: 0.5pt solid #ccc;
        padding: 4pt 0 4pt 18pt;
        margin-bottom: 0;
        position: relative;
      }
      ul.checklist li::before {
        content: "☐";
        position: absolute; left: 0; top: 4pt;
        font-size: 11pt;
      }

      /* Links — print the URL after the link text so the printed
         doc is still navigable. Skip mailto/tel and intra-doc anchors. */
      a { color: #000; text-decoration: underline; }
      a[href^="http"]::after {
        content: " (" attr(href) ")";
        font-size: 8.5pt;
        color: #555;
        word-break: break-all;
      }

      /* Hide everything tagged as screen-only chrome. */
      .tb-print-btn,
      .no-print,
      [data-no-print] { display: none !important; }

      /* Footer — re-style the existing footer block to print as a
         small caption under the last section, since @page already
         provides page numbers. */
      .footer {
        margin-top: 24pt;
        padding-top: 8pt;
        border-top: 0.5pt solid #999;
        font-size: 8.5pt;
        color: #555;
      }
    }
  `;

  // Wraps body content in a complete standalone HTML document. The
  // floating Print button hooks into window.print() so users can go
  // straight from "I just opened the file" to a printed copy without
  // hunting for a menu — survivor guides are routinely printed and
  // filed with the will, so the print path needs to be obvious.
  function wrapHtml(title, bodyHtml) {
    return '<!DOCTYPE html>\n' +
      '<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + escapeHtml(title) + '</title>' +
      '<style>' + SHARED_CSS + '</style>' +
      '</head><body>' +
      '<button class="tb-print-btn" onclick="window.print()" type="button" ' +
        'title="Print this document — formatted for US Letter, page numbers included">' +
        '🖨 Print</button>' +
      bodyHtml +
      '<div class="footer">Generated by Taigan Bridge — ' + new Date().toISOString().slice(0, 10) +
      '. Read-only snapshot. State is yours.</div>' +
      '</body></html>';
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ====================================================================
  // Generators
  // ====================================================================

  function fmtUsd(v) { return '$' + Math.round(v || 0).toLocaleString(); }
  function fmtJpy(v) { return '¥' + Math.round(v || 0).toLocaleString(); }

  // Build the Spouse Handoff HTML — a read-only snapshot of the user's
  // current state organized for someone who isn't the primary user
  // (typically a spouse) to navigate and understand.
  function buildSpouseHandoffHtml() {
    const profile = TB.state.get('profile') || {};
    const onboarding = TB.state.get('onboarding') || {};
    const prefs = getPrefs();
    const today = new Date().toISOString().slice(0, 10);
    const name = profile.displayName || profile.displayNameJa || 'User';

    // Detect a JP-national spouse — if present, prepend a Japanese
    // mirror of the intro + key sections so the spouse can read the
    // document without bouncing through a translator. We still keep
    // the English version below for the user's own re-read.
    const fam = onboarding.answers && onboarding.answers.family;
    const famArr = Array.isArray(fam) ? fam : [fam].filter(Boolean);
    const hasJpSpouse = famArr.indexOf('jp_spouse') !== -1;
    const nameJa = profile.displayNameJa || profile.displayName || name;

    let html = '';
    html += '<h1>' + escapeHtml(name) + '’s Taigan Bridge — Read-Only Snapshot</h1>';
    html += '<div class="meta">Generated ' + today + ' for spouse / partner reference. Static HTML — does not connect to anything live.</div>';

    // Bilingual top-of-page intro for JP spouse. The Japanese text is
    // written for someone who has not used Taigan Bridge — explains
    // what this document is, what isn't there (live data), and what
    // the JP-side filer (typically her) should DO with it.
    if (hasJpSpouse) {
      html += '<div class="banner" style="border-color:#6E2A3A;background:#FBF5F6">';
      html += '<strong>📖 配偶者の方へ / To my spouse</strong><br><br>';
      html += '<div lang="ja">これは ' + escapeHtml(nameJa) + ' の Taigan Bridge(US-JP 個人財務管理ツール)の';
      html += '読み取り専用スナップショットです。生成日:' + today + '。';
      html += '<br><br>';
      html += '<strong>このファイルでできること:</strong>';
      html += '<ul>';
      html += '<li>世帯の財務状況の全体像を一目で確認</li>';
      html += '<li>日本側の申告(確定申告・住民税・ふるさと納税)に必要な情報の所在を把握</li>';
      html += '<li>緊急時に書類・口座・保険の場所を確認</li>';
      html += '</ul>';
      html += '<strong>このファイルでできないこと:</strong>';
      html += '<ul>';
      html += '<li>データの編集(ライブツールではありません)</li>';
      html += '<li>口座へのアクセス(これは情報のインベントリのみ)</li>';
      html += '</ul>';
      html += '<strong>あなたの担当箇所(SOFA 世帯の典型例):</strong>';
      html += '<ul>';
      html += '<li>確定申告(2月16日〜3月15日):住民票登録者として自身の所得を申告</li>';
      html += '<li>住民税:税額決定通知書(6月頃郵送)の確認</li>';
      html += '<li>ふるさと納税:年間限度額内で 12 月 31 日までに決済</li>';
      html += '<li>子のパスポート更新・国籍選択(該当する場合)</li>';
      html += '<li>世帯の医療カバレッジ(NHI / SHI / 介護保険)</li>';
      html += '</ul>';
      html += '</div>';
      html += '<hr style="border:0;border-top:1px solid #DCD5C4;margin:16px 0"/>';
      html += '<div>This is a READ-ONLY snapshot of ' + escapeHtml(name) + '\'s Taigan Bridge state at the time of generation. To see live data or make changes, open the actual Taigan Bridge tool. Re-share periodically as data changes.</div>';
      html += '</div>';
    } else {
      html += '<div class="banner">📖 This is a READ-ONLY snapshot of ' + escapeHtml(name) + '’s Taigan Bridge state at the time of generation. To see live data or make changes, open the actual Taigan Bridge tool. Re-share periodically as data changes.</div>';
    }

    // TOC
    html += '<div class="toc"><strong>Sections:</strong> ';
    html += '<a href="#snapshot">Snapshot</a> ';
    html += '<a href="#tracks">Status</a> ';
    html += '<a href="#assets">Assets</a> ';
    html += '<a href="#tax">Tax filing</a> ';
    html += '<a href="#estate">Estate</a> ';
    html += '<a href="#family">Family</a> ';
    html += '<a href="#docs">Documents</a> ';
    html += '<a href="#actions">Action items</a>';
    html += '</div>';

    // Snapshot
    html += '<h2 id="snapshot">📊 Snapshot</h2>';
    html += '<div class="stat-row">';
    try {
      const accounts = TB.assets ? TB.assets.getActiveAccounts() : [];
      const total = accounts.reduce((s, a) => s + TB.assets.toUsd(a.balance_native, a.currency), 0);
      if (prefs.spouse_include_balances !== false) {
        html += '<div class="stat-tile"><div class="label">Total assets</div><div class="stat">' + fmtUsd(total) + '</div></div>';
        html += '<div class="stat-tile"><div class="label">Account count</div><div class="stat">' + accounts.length + '</div></div>';
      } else {
        html += '<div class="stat-tile"><div class="label">Account count</div><div class="stat">' + accounts.length + '</div></div>';
      }
    } catch (err) { /* swallow */ }
    try {
      const tracks = TB.state.get('tracks') || [];
      html += '<div class="stat-tile"><div class="label">Active tracks</div><div class="stat">' + tracks.length + '</div></div>';
    } catch (err) { /* swallow */ }
    html += '</div>';

    // Tracks
    html += '<h2 id="tracks">🧭 Status</h2>';
    const tracks = TB.state.get('tracks') || [];
    const tlabels = { sofa: 'SOFA', veteran: 'Veteran', resident: 'Long-Term Resident', family: 'Family', property: 'Property', core: 'Core' };
    html += '<div class="card"><strong>Tracks:</strong> ' + tracks.map((t) => escapeHtml(tlabels[t] || t)).join(', ') + '</div>';
    const a = onboarding.answers || {};
    html += '<table><tr><th>Field</th><th>Value</th></tr>';
    [['citizenship', a.citizenship], ['Years in Japan', a.years_in_japan],
     ['Visa', a.visa], ['Employment', a.employment], ['Veteran status', a.veteran],
     ['住民票 registered', a.juminhyo], ['Tax status', a.tax_status]].forEach(([k, v]) => {
      if (v) html += '<tr><td>' + escapeHtml(k) + '</td><td>' + escapeHtml(v) + '</td></tr>';
    });
    html += '</table>';

    // Assets
    html += '<h2 id="assets">💼 Assets</h2>';
    try {
      const accounts = TB.assets ? TB.assets.getActiveAccounts() : [];
      if (accounts.length === 0) {
        html += '<p>No accounts recorded.</p>';
      } else {
        html += '<table><tr><th>Institution</th><th>Account</th><th>Country</th><th>Wrapper</th>' +
          (prefs.spouse_include_balances !== false ? '<th>Balance</th>' : '') +
          '<th>Beneficiary</th></tr>';
        accounts.forEach((a) => {
          html += '<tr>';
          html += '<td>' + escapeHtml(a.institution || '—') + '</td>';
          html += '<td>' + escapeHtml(a.name || '—') + '</td>';
          html += '<td>' + escapeHtml(a.country || '—') + '</td>';
          html += '<td>' + escapeHtml(a.tax_wrapper || '—') + '</td>';
          if (prefs.spouse_include_balances !== false) {
            html += '<td style="font-family:monospace">' +
              fmtUsd(TB.assets.toUsd(a.balance_native, a.currency)) + '</td>';
          }
          html += '<td>' + escapeHtml(a.beneficiary || '—') + '</td>';
          html += '</tr>';
        });
        html += '</table>';
      }
    } catch (err) { html += '<p>(Assets unavailable)</p>'; }

    // Tax filing
    html += '<h2 id="tax">📋 Tax Filing</h2>';
    try {
      if (TB.taxCoord && typeof TB.taxCoord.buildContext === 'function') {
        const ctx = TB.taxCoord.buildContext();
        html += '<table>';
        html += '<tr><td>Filing status</td><td>' + escapeHtml(ctx.filing_status_label) + '</td></tr>';
        html += '<tr><td>FEIE / FTC election</td><td>' + escapeHtml(ctx.feie_choice || 'undecided') + '</td></tr>';
        html += '<tr><td>JP tax resident</td><td>' + (ctx.is_jp_resident ? 'Yes' : 'No') + '</td></tr>';
        html += '<tr><td>Foreign assets total</td><td style="font-family:monospace">' + fmtUsd(ctx.foreign_assets_usd) + '</td></tr>';
        html += '<tr><td>FBAR aggregate</td><td style="font-family:monospace">' + fmtUsd(ctx.fbar_aggregate_usd) +
          (ctx.fbar_aggregate_usd > 10000 ? ' <strong>(FBAR required)</strong>' : '') + '</td></tr>';
        if (ctx.has_pfic) html += '<tr><td>⚠ PFIC detected</td><td>' + escapeHtml((ctx.pfic_account_names || []).join(', ')) + '</td></tr>';
        html += '</table>';
      }
    } catch (err) { /* swallow */ }

    // Estate
    html += '<h2 id="estate">🪦 Estate</h2>';
    try {
      if (TB.estate && typeof TB.estate.deriveStatutoryHeirs === 'function') {
        const heirs = TB.estate.deriveStatutoryHeirs();
        const tax = TB.estate.computeJpInheritanceTax();
        if (heirs.all_heirs.length > 0) {
          html += '<h3>Statutory heirs (法定相続人)</h3><table><tr><th>Name</th><th>Role</th><th>Share</th></tr>';
          heirs.all_heirs.forEach((h) => {
            const m = h.member;
            html += '<tr><td>' + escapeHtml(m.name_en || m.name_jp || '—') + '</td>' +
              '<td>' + escapeHtml(h.role) + '</td>' +
              '<td>' + (h.share * 100).toFixed(1) + '%</td></tr>';
          });
          html += '</table>';
        }
        html += '<p><strong>Projected JP 相続税:</strong> ' + fmtJpy(tax.net_tax) +
          ' (after spouse credit ' + fmtJpy(tax.spouse_credit) + ')</p>';
      }
    } catch (err) { /* swallow */ }

    // Family
    html += '<h2 id="family">👨‍👩‍👧 Family</h2>';
    try {
      const members = TB.state.get('family.members') || [];
      if (members.length === 0) {
        html += '<p>No family members recorded.</p>';
      } else {
        html += '<table><tr><th>Name</th><th>Relationship</th><th>Citizenships</th><th>Birth date</th></tr>';
        members.forEach((m) => {
          html += '<tr><td>' + escapeHtml(m.name_en || m.name_jp || '—') + '</td>' +
            '<td>' + escapeHtml(m.relationship || '—') + '</td>' +
            '<td>' + escapeHtml((m.citizenships || []).join('/')) + '</td>' +
            '<td>' + escapeHtml(m.birth_date || '—') + '</td></tr>';
        });
        html += '</table>';
      }
    } catch (err) { /* swallow */ }

    // Documents
    if (prefs.spouse_include_documents !== false) {
      html += '<h2 id="docs">📂 Documents (titles + locations only)</h2>';
      try {
        const items = TB.state.get('documentVault.items') || [];
        if (items.length === 0) {
          html += '<p>No documents recorded.</p>';
        } else {
          html += '<table><tr><th>Title</th><th>Type</th><th>Storage location</th><th>Expires</th></tr>';
          items.forEach((it) => {
            html += '<tr><td>' + escapeHtml(it.title || '—') + '</td>' +
              '<td>' + escapeHtml(it.type || '—') + '</td>' +
              '<td>' + escapeHtml(it.storage_location || '—') + '</td>' +
              '<td>' + escapeHtml(it.expiry_date || '—') + '</td></tr>';
          });
          html += '</table>';
        }
      } catch (err) { /* swallow */ }
    }

    // Action items
    if (prefs.spouse_include_action_items !== false) {
      html += '<h2 id="actions">🎯 Open action items</h2>';
      try {
        if (TB.actionCenter) {
          const actions = TB.actionCenter.deriveActions();
          if (actions.length === 0) {
            html += '<p>✓ No open action items at the time of generation.</p>';
          } else {
            html += '<ul class="checklist">';
            actions.slice(0, 20).forEach((act) => {
              html += '<li><strong>[' + escapeHtml(act.urgency) + ']</strong> ' + escapeHtml(act.title) + '</li>';
            });
            html += '</ul>';
            if (actions.length > 20) html += '<p><em>… and ' + (actions.length - 20) + ' more</em></p>';
          }
        }
      } catch (err) { /* swallow */ }
    }

    return wrapHtml(name + ' — Taigan Bridge Snapshot — ' + today, html);
  }

  // Build the Survivor HTML — extended Letter of Instruction.
  function buildSurvivorHtml() {
    const profile = TB.state.get('profile') || {};
    const today = new Date().toISOString().slice(0, 10);
    const name = profile.displayName || profile.displayNameJa || 'the deceased';

    let html = '';
    html += '<h1>If you’re reading this — guidance for survivors of ' + escapeHtml(name) + '</h1>';
    html += '<div class="meta">Generated ' + today + '. This is informational guidance assembled from the deceased’s Taigan Bridge state. NOT a will. NOT legal advice. Coordinate with the named executor + attorney.</div>';
    html += '<div class="banner warn">⚠ First read this entire document. Then take the actions in Section 1 before anything else.</div>';

    // Section 1: First 7 days
    html += '<h2>1. First 7 days — immediate actions</h2>';
    html += '<ul class="checklist">';
    html += '<li>Obtain death certificate (multiple certified copies — both jurisdictions if applicable)</li>';
    html += '<li>If in Japan: file 死亡届 at city hall (市役所/区役所) within 7 days — REQUIRED BY LAW</li>';
    html += '<li>If US-citizen: notify Social Security Administration (1-800-772-1213) — stops SS payments</li>';
    html += '<li>Notify named executor / attorney</li>';
    html += '<li>Locate and READ both wills (US + JP if dual)</li>';
    html += '<li>Preserve mail, email, phone access — institutions will start sending notices</li>';
    html += '<li>Do NOT distribute assets yet — let the executor / probate process handle</li>';
    html += '</ul>';

    // Section 2: First 30 days
    html += '<h2>2. First 30 days</h2>';
    html += '<ul class="checklist">';
    html += '<li>Notify all banks, brokerages, retirement plan administrators (use death certificate)</li>';
    html += '<li>If JP tax resident: engage 税理士 — 10-month clock for 相続税申告書 begins</li>';
    html += '<li>If US-citizen decedent: engage CPA for final 1040 + estate-tax return if required</li>';
    html += '<li>Cancel/transfer credit cards, utilities, subscriptions</li>';
    html += '<li>If named beneficiary on retirement accounts: file claims directly (those bypass probate)</li>';
    html += '<li>Update beneficiaries on surviving spouse’s accounts</li>';
    html += '<li>If applicable: file VA claim for survivor benefits (DIC, SBP)</li>';
    html += '</ul>';

    // Section 3: Account inventory
    html += '<h2>3. Account inventory</h2>';
    try {
      const accounts = TB.assets ? TB.assets.getActiveAccounts() : [];
      if (accounts.length > 0) {
        html += '<table><tr><th>Institution</th><th>Account</th><th>Country</th><th>Approx balance</th><th>Beneficiary on file</th></tr>';
        accounts.forEach((a) => {
          html += '<tr><td>' + escapeHtml(a.institution || '—') + '</td>' +
            '<td>' + escapeHtml(a.name || '—') + '</td>' +
            '<td>' + escapeHtml(a.country || '—') + '</td>' +
            '<td style="font-family:monospace">' + fmtUsd(TB.assets.toUsd(a.balance_native, a.currency)) + '</td>' +
            '<td>' + escapeHtml(a.beneficiary || '⚠ NOT SET') + '</td></tr>';
        });
        html += '</table>';
      } else {
        html += '<p>No accounts recorded in the source state.</p>';
      }
    } catch (err) { /* swallow */ }

    // Section 4: Documents
    html += '<h2>4. Important documents — locations</h2>';
    try {
      const items = TB.state.get('documentVault.items') || [];
      if (items.length > 0) {
        html += '<table><tr><th>Document</th><th>Stored at</th><th>Notes</th></tr>';
        items.forEach((it) => {
          html += '<tr><td><strong>' + escapeHtml(it.title || it.type) + '</strong></td>' +
            '<td>' + escapeHtml(it.storage_location || '—') + '</td>' +
            '<td>' + escapeHtml(it.notes || '') + '</td></tr>';
        });
        html += '</table>';
      } else {
        html += '<p>No documents recorded in the source state. Search the home for: will, POA, life insurance policies, deeds, passport, 戸籍, insurance documents.</p>';
      }
    } catch (err) { /* swallow */ }

    // Section 5: Family + heirs
    html += '<h2>5. Family + statutory heirs</h2>';
    try {
      const members = TB.state.get('family.members') || [];
      if (members.length > 0) {
        html += '<table><tr><th>Name</th><th>Relationship</th><th>Citizenships</th></tr>';
        members.forEach((m) => {
          html += '<tr><td>' + escapeHtml(m.name_en || m.name_jp || '—') + '</td>' +
            '<td>' + escapeHtml(m.relationship || '—') + '</td>' +
            '<td>' + escapeHtml((m.citizenships || []).join('/')) + '</td></tr>';
        });
        html += '</table>';
      }
      if (TB.estate && typeof TB.estate.deriveStatutoryHeirs === 'function') {
        const heirs = TB.estate.deriveStatutoryHeirs();
        if (heirs.all_heirs.length > 0) {
          html += '<h3>Statutory shares (Civil Code §887, §889, §890)</h3>';
          html += '<table><tr><th>Name</th><th>Role</th><th>Share</th></tr>';
          heirs.all_heirs.forEach((h) => {
            const m = h.member;
            html += '<tr><td>' + escapeHtml(m.name_en || m.name_jp || '—') + '</td>' +
              '<td>' + escapeHtml(h.role) + '</td>' +
              '<td>' + (h.share * 100).toFixed(1) + '%</td></tr>';
          });
          html += '</table>';
        }
      }
    } catch (err) { /* swallow */ }

    // Section 6: Funeral preferences
    try {
      const eol = TB.state.get('healthcare.end_of_life') || {};
      const loi = TB.state.get('estate.letter_of_instruction') || {};
      const funeral = loi.funeral_preferences || eol.funeral_preference_notes || '';
      if (funeral) {
        html += '<h2>6. Funeral wishes</h2>';
        html += '<div class="card">' + escapeHtml(funeral).replace(/\n/g, '<br>') + '</div>';
      }
      if (loi.pet_instructions) {
        html += '<h3>Pets</h3><div class="card">' + escapeHtml(loi.pet_instructions).replace(/\n/g, '<br>') + '</div>';
      }
      if (loi.digital_accounts_note) {
        html += '<h3>Digital accounts</h3><div class="card">' + escapeHtml(loi.digital_accounts_note).replace(/\n/g, '<br>') + '</div>';
      }
    } catch (err) { /* swallow */ }

    // Section 7: Contacts (from LoI + consultations)
    html += '<h2>7. Important contacts</h2>';
    try {
      const loi = TB.state.get('estate.letter_of_instruction') || {};
      const contacts = loi.important_contacts || [];
      const pros = (TB.state.get('consultations.professionals') || []);
      if (contacts.length === 0 && pros.length === 0) {
        html += '<p>No contacts recorded.</p>';
      } else {
        html += '<table><tr><th>Name</th><th>Role / Specialty</th><th>Contact</th></tr>';
        contacts.forEach((c) => {
          html += '<tr><td>' + escapeHtml(c.name || '—') + '</td>' +
            '<td>' + escapeHtml(c.role || c.relationship || '—') + '</td>' +
            '<td>' + escapeHtml(c.contact || '—') + '</td></tr>';
        });
        pros.forEach((p) => {
          html += '<tr><td>' + escapeHtml(p.name || '—') + (p.firm ? ' (' + escapeHtml(p.firm) + ')' : '') + '</td>' +
            '<td>' + escapeHtml(p.type) + (p.specialty ? ' — ' + escapeHtml(p.specialty) : '') + '</td>' +
            '<td>' + escapeHtml(p.contact || '—') + '</td></tr>';
        });
        html += '</table>';
      }
    } catch (err) { /* swallow */ }

    return wrapHtml('For survivors of ' + name + ' — ' + today, html);
  }

  // Build the Advisor JSON — tax-relevant subset only.
  function buildAdvisorJson() {
    const prefs = getPrefs();
    const today = new Date().toISOString().slice(0, 10);

    const out = {
      generated_at: today,
      generated_by: 'Taigan Bridge sharing-backup module',
      scope: 'advisor',
      profile: {
        display_name: TB.state.get('profile.displayName') || '',
      },
      onboarding: TB.state.get('onboarding.answers') || {},
      tax_coordinator: TB.state.get('tax_coordinator') || {},
    };

    // Assets — optional balances
    try {
      const accounts = TB.assets ? TB.assets.getActiveAccounts() : [];
      out.assets = accounts.map((a) => {
        const base = {
          institution: a.institution, name: a.name, country: a.country,
          tax_wrapper: a.tax_wrapper, currency: a.currency,
        };
        if (prefs.advisor_include_balances !== false) {
          base.balance_native = a.balance_native;
          base.balance_usd_approx = TB.assets.toUsd(a.balance_native, a.currency);
        }
        if (a.basis_native != null) base.basis_native = a.basis_native;
        return base;
      });
    } catch (err) { out.assets = null; }

    // FBAR — summary only (no PII)
    try {
      if (TB.fbar && typeof TB.fbar.summarizeFbarForAi === 'function') {
        out.fbar_summary = TB.fbar.summarizeFbarForAi();
      }
    } catch (err) { /* swallow */ }

    // Documents (titles only)
    if (prefs.advisor_include_documents_list !== false) {
      try {
        const items = TB.state.get('documentVault.items') || [];
        out.documents = items.map((it) => ({
          title: it.title, type: it.type, expiry_date: it.expiry_date,
        }));
      } catch (err) { /* swallow */ }
    }

    // Family — anonymized if user opted in
    try {
      const members = TB.state.get('family.members') || [];
      out.family_members = members.map((m) => ({
        relationship: m.relationship,
        name: prefs.advisor_anonymize_family ? '[REDACTED]' : (m.name_en || m.name_jp || ''),
        citizenships: m.citizenships || [],
        birth_year: m.birth_date ? m.birth_date.slice(0, 4) : null,  // year only, not full date
      }));
      out.gifts_log = TB.state.get('family.gifts_log') || [];
    } catch (err) { /* swallow */ }

    // Property
    try {
      out.properties = (TB.state.get('property.properties') || []).map((p) => ({
        country: p.country, type: p.type, currency: p.currency,
        purchase_date: p.purchase_date,
        purchase_price_native: p.purchase_price_native,
        current_value_native: p.current_value_native,
        rental_status: p.rental_status,
        monthly_rent_native: p.monthly_rent_native,
      }));
    } catch (err) { /* swallow */ }

    return JSON.stringify(out, null, 2);
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  const SECTIONS = [
    { id: 'header',       always: true, builder: () => buildHeaderCard() },
    {
      id: 'spouse',
      label_en: 'Spouse handoff (read-only HTML)',
      label_jp: '配偶者引継ぎ(読み取り専用 HTML)',
      description_en: 'Self-contained HTML snapshot for spouse / partner reference. Loads in any browser; does not require Taigan Bridge.',
      description_jp: '配偶者・パートナー参照用の自己完結型 HTML。任意のブラウザで開け、Taigan Bridge 不要。',
      auto_show: () => true,
      builder: () => buildSpouseCard(),
    },
    {
      id: 'survivor',
      label_en: '"If you\'re reading this" survivor mode',
      label_jp: '「これを読んでいる方へ」遺族モード',
      description_en: 'Standalone HTML guide for survivors — first-7-days actions, account inventory, document locations, contacts.',
      description_jp: '遺族向け自己完結型 HTML ガイド — 最初 7 日のアクション・口座一覧・書類所在・連絡先。',
      auto_show: () => true,
      builder: () => buildSurvivorCard(),
    },
    {
      id: 'advisor',
      label_en: 'Advisor share (tax-only JSON)',
      label_jp: 'アドバイザー共有(税務のみ JSON)',
      description_en: 'Tax-relevant subset for CPA review. User-controllable scope (balances, document list, family anonymization).',
      description_jp: 'CPA レビュー用の税務関連サブセット。スコープ調整可(残高・書類リスト・家族匿名化)。',
      auto_show: () => true,
      builder: () => buildAdvisorCard(),
    },
    {
      id: 'backup',
      label_en: 'Full backup / restore',
      label_jp: '完全バックアップ・復元',
      description_en: 'Export full state to JSON (for backup or device migration). Import overwrites all current data.',
      description_jp: '全状態を JSON にエクスポート(バックアップまたはデバイス移行用)。インポートは全現在データを上書き。',
      auto_show: () => true,
      builder: () => buildBackupCard(),
    },
    {
      id: 'history',
      label_en: 'Share history',
      label_jp: '共有履歴',
      description_en: 'Log of every share / backup generated — what, when, scope.',
      description_jp: '生成した共有・バックアップの履歴 — 種別・日時・スコープ。',
      auto_show: () => getLog().length > 0,
      builder: () => buildHistoryCard(),
    },
    { id: 'preferences', always: true, builder: () => buildPreferencesCard() },
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
    return el('div', { class: 'tb-card', 'data-track': 'share' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'share' }, t('share.badge')),
      ),
      el('h1', null, '🤝 ' + t('share.title')),
      el('p', { class: 'tb-card-meta' }, t('share.subtitle')),
    );
  }

  // ─── Card builders for each share type ──────────────────────────

  function shareCard(track, icon, titleKey, descKey, btnLabel, action, lastAt) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'share' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, icon + ' ' + t(titleKey)));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t(descKey)));
    if (lastAt) {
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-2)' } },
        t('share.last_generated') + ': ' + new Date(lastAt).toLocaleDateString()));
    }
    card.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      style: { padding: '6px 16px' },
      onclick: action,
    }, '⬇ ' + t(btnLabel)));
    return card;
  }

  function lastShareOf(type) {
    const log = getLog();
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].type === type) return log[i].generated_at;
    }
    return null;
  }

  function buildSpouseCard() {
    return shareCard('share', '👫', 'share.section.spouse', 'share.spouse.intro',
      'share.spouse.generate',
      () => {
        const html = buildSpouseHandoffHtml();
        const fn = 'taigan-bridge-spouse-snapshot-' + new Date().toISOString().slice(0, 10) + '.html';
        downloadFile(fn, html, 'text/html;charset=utf-8');
        appendLog({ id: 'sh-' + Date.now().toString(36), type: 'spouse',
          generated_at: new Date().toISOString(), filename: fn });
        rerender();
      },
      lastShareOf('spouse'));
  }

  function buildSurvivorCard() {
    return shareCard('share', '🕊', 'share.section.survivor', 'share.survivor.intro',
      'share.survivor.generate',
      () => {
        const html = buildSurvivorHtml();
        const fn = 'if-youre-reading-this-' + new Date().toISOString().slice(0, 10) + '.html';
        downloadFile(fn, html, 'text/html;charset=utf-8');
        appendLog({ id: 'sh-' + Date.now().toString(36), type: 'survivor',
          generated_at: new Date().toISOString(), filename: fn });
        rerender();
      },
      lastShareOf('survivor'));
  }

  function buildAdvisorCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'share' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '👔 ' + t('share.section.advisor')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('share.advisor.intro')));

    const lastAt = lastShareOf('advisor');
    if (lastAt) {
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-2)' } },
        t('share.last_generated') + ': ' + new Date(lastAt).toLocaleDateString()));
    }

    // Scope checkboxes
    const prefs = getPrefs();
    function pref(label, key, defaultOn) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = prefs[key] !== false && (defaultOn || prefs[key] === true);
      cb.style.marginRight = '8px';
      cb.onchange = (e) => {
        const p = Object.assign({}, getPrefs());
        p[key] = !!e.target.checked;
        setPrefs(p);
      };
      return el('label', { style: { display: 'flex', alignItems: 'center', fontSize: 'var(--tb-fs-12)', marginBottom: '4px' } },
        cb, label);
    }
    card.appendChild(el('div', { style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)',
      background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
      marginBottom: 'var(--tb-sp-2)' } },
      el('div', { style: { fontWeight: '600', marginBottom: '6px', fontSize: 'var(--tb-fs-12)' } },
        t('share.advisor.scope_label')),
      pref(t('share.advisor.include_balances'),       'advisor_include_balances',       true),
      pref(t('share.advisor.include_documents_list'), 'advisor_include_documents_list', true),
      pref(t('share.advisor.anonymize_family'),       'advisor_anonymize_family',       false),
    ));

    card.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      style: { padding: '6px 16px' },
      onclick: () => {
        const json = buildAdvisorJson();
        const fn = 'taigan-bridge-advisor-share-' + new Date().toISOString().slice(0, 10) + '.json';
        downloadFile(fn, json, 'application/json;charset=utf-8');
        appendLog({ id: 'sh-' + Date.now().toString(36), type: 'advisor',
          generated_at: new Date().toISOString(), filename: fn });
        rerender();
      },
    }, '⬇ ' + t('share.advisor.generate')));

    return card;
  }

  function buildBackupCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'share' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '💾 ' + t('share.section.backup')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('share.backup.intro')));

    const lastAt = lastShareOf('backup');
    if (lastAt) {
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-2)' } },
        t('share.last_generated') + ': ' + new Date(lastAt).toLocaleDateString()));
    }

    const btnRow = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap' } });
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      style: { padding: '6px 16px' },
      onclick: () => {
        const json = TB.state.export();
        const fn = 'taigan-bridge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        downloadFile(fn, json, 'application/json;charset=utf-8');
        appendLog({ id: 'sh-' + Date.now().toString(36), type: 'backup',
          generated_at: new Date().toISOString(), filename: fn });
        rerender();
      },
    }, '⬇ ' + t('share.backup.export')));
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button',
      style: { padding: '6px 16px' },
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
              if (!confirm(t('share.backup.import_confirm'))) return;
              TB.state.import(reader.result);
              alert(t('share.backup.import_success'));
              window.location.reload();
            } catch (err) {
              alert(t('share.backup.import_error') + ': ' + err.message);
            }
          };
          reader.readAsText(f);
        };
        input.click();
      },
    }, '⬆ ' + t('share.backup.import')));
    card.appendChild(btnRow);

    return card;
  }

  function buildHistoryCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const log = getLog().slice().reverse();  // newest first

    const card = el('div', { class: 'tb-card', 'data-track': 'share' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('share.section.history')));

    if (log.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('share.history.empty')));
      return card;
    }

    const TYPE_LABELS = {
      spouse:   '👫 ' + t('share.section.spouse'),
      survivor: '🕊 ' + t('share.section.survivor'),
      advisor:  '👔 ' + t('share.section.advisor'),
      backup:   '💾 ' + t('share.section.backup'),
    };

    log.slice(0, 20).forEach((entry) => {
      card.appendChild(el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: '4px', gap: 'var(--tb-sp-3)',
        },
      },
        el('div', null,
          el('div', { style: { fontWeight: '600' } }, TYPE_LABELS[entry.type] || entry.type),
          el('div', { class: 'tb-field-help', style: { marginTop: '2px', fontFamily: 'var(--tb-font-mono)' } },
            entry.filename || '(no filename)'),
        ),
        el('div', { class: 'tb-field-help', style: { fontFamily: 'var(--tb-font-mono)', whiteSpace: 'nowrap' } },
          new Date(entry.generated_at).toLocaleString()),
      ));
    });
    if (log.length > 20) {
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('share.history.more', { count: log.length - 20 })));
    }
    return card;
  }

  function buildPreferencesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const prefs = getPrefs();
    const card = el('div', { class: 'tb-card', 'data-track': 'share' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚙ ' + t('share.section.preferences')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('share.preferences.intro')));

    function row(labelKey, helpKey, key, defaultOn) {
      const cb = el('input', { type: 'checkbox',
        checked: prefs[key] !== false && (defaultOn || prefs[key] === true),
        style: { marginRight: '8px' },
        onchange: (e) => {
          const p = Object.assign({}, getPrefs());
          p[key] = !!e.target.checked;
          setPrefs(p);
        } });
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
          cb, t(labelKey)),
        el('div', { class: 'tb-field-help' }, t(helpKey)),
      );
    }
    card.appendChild(row('share.prefs.spouse_balances', 'share.prefs.spouse_balances.help', 'spouse_include_balances', true));
    card.appendChild(row('share.prefs.spouse_documents', 'share.prefs.spouse_documents.help', 'spouse_include_documents', true));
    card.appendChild(row('share.prefs.spouse_actions', 'share.prefs.spouse_actions.help', 'spouse_include_action_items', true));

    // Auto-backup interval — when set, app prompts on load if last
    // backup is older than the threshold. Off by default.
    const autoBackupSel = el('select', {
      class: 'tb-select',
      style: { fontSize: 'var(--tb-fs-12)', padding: '4px 8px' },
      onchange: (e) => {
        const p = Object.assign({}, getPrefs());
        const v = Number(e.target.value);
        if (!v) delete p.auto_backup_days; else p.auto_backup_days = v;
        // Clear any active snooze when the user changes the interval.
        delete p.auto_backup_snoozed_until;
        setPrefs(p);
      },
    },
      el('option', { value: '0',   selected: !prefs.auto_backup_days }, t('share.prefs.autoBackup.off')),
      el('option', { value: '30',  selected: prefs.auto_backup_days === 30 },  t('share.prefs.autoBackup.30')),
      el('option', { value: '90',  selected: prefs.auto_backup_days === 90 },  t('share.prefs.autoBackup.90')),
      el('option', { value: '180', selected: prefs.auto_backup_days === 180 }, t('share.prefs.autoBackup.180')),
    );
    card.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label' }, t('share.prefs.autoBackup.label')),
      autoBackupSel,
      el('div', { class: 'tb-field-help' }, t('share.prefs.autoBackup.help')),
    ));
    return card;
  }

  // ====================================================================
  // Module registration
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Sharing & Backup', label_jp: '共有・バックアップ', render,
    searchSections: SECTIONS,
  };

  // ====================================================================
  // Backup action generators (v0.58)
  // ====================================================================
  //
  // Single-file HTML apps don't have automatic cloud sync — if the
  // browser cache is cleared or the device dies, state is gone. We
  // surface "back up now" reminders through the action center on a
  // 30-day cadence so the user doesn't drift into years-no-backup
  // territory.

  function lastBackupAt() {
    const log = (TB.state.get('sharing') || {}).shares_log || [];
    let latest = null;
    for (const entry of log) {
      if (entry.type !== 'backup' || !entry.generated_at) continue;
      if (!latest || entry.generated_at > latest) latest = entry.generated_at;
    }
    return latest;
  }

  function genBackupOverdue() {
    const out = [];
    const last = lastBackupAt();
    if (!last) {
      // Never backed up — only nag once the user has actual state to
      // protect. Otherwise empty installs would show this on day 1.
      const stateBlob = TB.state.export ? TB.state.export() : '{}';
      // Heuristic: state JSON > 8 KB means there's real data worth backing up.
      if (!stateBlob || stateBlob.length < 8000) return out;
      out.push({
        id: 'backup_never',
        group: 'maintenance', urgency: 'medium', icon: '💾',
        title: TB.i18n.t('sb.genBackupOverdue.never.title'),
        body: TB.i18n.t('sb.genBackupOverdue.never.body'),
        module: 'sharing-backup', snoozable: true,
      });
      return out;
    }
    const lastDate = new Date(last);
    const now = new Date();
    const days = Math.floor((now.getTime() - lastDate.getTime()) / 86400000);
    if (days < 30) return out;
    const urgency = days > 180 ? 'high' : days > 90 ? 'medium' : 'low';
    out.push({
      id: 'backup_overdue',
      group: 'maintenance', urgency, icon: '💾',
      title: TB.i18n.t('sb.genBackupOverdue.overdue.title', { days }),
      body: TB.i18n.t('sb.genBackupOverdue.overdue.body'),
      deadline: null,
      module: 'sharing-backup', snoozable: true,
    });
    return out;
  }

  // ====================================================================
  // Public API
  // ====================================================================

  // One-click backup that any module can call. Triggers a JSON download
  // and stamps the share log so the action-center reminder resets.
  function runBackupNow() {
    if (!TB.state || typeof TB.state.export !== 'function') {
      throw new Error('TB.state.export not available');
    }
    const json = TB.state.export();
    const fn = 'taigan-bridge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    downloadFile(fn, json, 'application/json;charset=utf-8');
    appendLog({
      id: 'sh-' + Date.now().toString(36),
      type: 'backup',
      generated_at: new Date().toISOString(),
      filename: fn,
    });
    return fn;
  }

  // ====================================================================
  // Auto-backup (v0.60)
  // ====================================================================
  //
  // Browsers can't silently write files to disk — every download
  // requires a user gesture. So "auto-backup" really means: when the
  // user has opted in via prefs.auto_backup_days (30 / 90 / 180), and
  // the last backup is older than that, surface a confirm() prompt on
  // app load asking whether to back up now. One click executes; one
  // click defers (snoozes for 7 days). Default is OFF — no surprise
  // downloads on first run.
  //
  // The snooze field lives on prefs as `auto_backup_snoozed_until` so
  // it survives reloads but auto-clears on a fresh-day boot.
  function maybeAutoBackup() {
    const prefs = getPrefs();
    const interval = Number(prefs.auto_backup_days || 0);
    if (!interval || interval < 7) return false; // off
    const last = lastBackupAt();
    const lastDays = last
      ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000)
      : Infinity;
    if (lastDays < interval) return false; // not yet due
    // Honor snooze (7 days from "remind me later")
    if (prefs.auto_backup_snoozed_until) {
      if (new Date(prefs.auto_backup_snoozed_until).getTime() > Date.now()) return false;
    }
    // Need real data to be worth backing up — same threshold as the
    // never-backed-up reminder so the two checks agree.
    const stateBlob = TB.state.export ? TB.state.export() : '{}';
    if (!stateBlob || stateBlob.length < 8000) return false;

    const t = (TB.i18n && TB.i18n.t) ? TB.i18n.t : ((k) => k);
    const msg = last
      ? t('share.autoBackup.confirm.overdue', { days: lastDays })
      : t('share.autoBackup.confirm.never');
    if (confirm(msg)) {
      try { runBackupNow(); }
      catch (e) { console.error('[autobackup] download failed:', e); }
    } else {
      // Snooze 7 days
      const snoozeUntil = new Date(Date.now() + 7 * 86400000).toISOString();
      const p = Object.assign({}, getPrefs());
      p.auto_backup_snoozed_until = snoozeUntil;
      setPrefs(p);
    }
    return true;
  }

  window.TB.sharingBackup = {
    buildSpouseHandoffHtml, buildSurvivorHtml, buildAdvisorJson,
    runBackupNow, lastBackupAt, maybeAutoBackup,
    actionGenerators: [genBackupOverdue],
  };
})();
