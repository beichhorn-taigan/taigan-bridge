/* Taigan Bridge — about-overlays.js
 *
 * Modal overlays for the four hash anchors that appear in the About
 * page footer (and the global page footer):
 *
 *   #license   → License (LICENSE.md, inlined at build time)
 *   #changelog → What's new (CHANGELOG.md, inlined at build time)
 *   #feedback  → Send feedback (mailto + form options)
 *   #tip       → Buy me a coffee (Ko-fi / BMaC / GitHub Sponsors links)
 *
 * Implemented as plain DOM modals using the existing .tb-modal /
 * .tb-modal-backdrop classes. Wired by listening for click events on
 * any anchor whose href matches one of the four hashes. We use event
 * delegation so dynamically-rendered anchors (the About card gets
 * re-rendered on nav) don't have to be re-bound.
 *
 * Lives outside index.html on purpose — the HTML file is already
 * dense and these overlays don't need to be on the critical-path
 * boot script.
 */
(function () {
  'use strict';

  // ─── Tip jar config ────────────────────────────────────────────────
  // Hard-coded here rather than in i18n — these are URLs, not
  // translatable strings. All three platforms reach the same person;
  // the user picks whichever flow they prefer. GitHub Sponsors leads
  // because the project is hosted on GitHub and many visitors will
  // already be signed in there. The BMaC handle is case-sensitive
  // in the URL ("TaiganBridge"); Ko-fi's is not.
  const TIP_LINKS = [
    {
      id: 'github',
      label_en: 'GitHub Sponsors (monthly or one-time)',
      label_jp: 'GitHub Sponsors(月額・一回いずれも可)',
      url: 'https://github.com/sponsors/beichhorn-taigan',
      icon: '💖',
      desc_en: 'Best fit if you already have a GitHub account. Supports recurring monthly or one-time. Same person as the repo owner.',
      desc_jp: 'GitHub アカウントをお持ちの方に最適。月額継続・一回限りどちらも可能。リポジトリ所有者と同一人物に届きます。',
    },
    {
      id: 'kofi',
      label_en: 'Ko-fi (one-time tip, no signup)',
      label_jp: 'Ko-fi(サインアップ不要、ワンタイム)',
      url: 'https://ko-fi.com/taiganbridge',
      icon: '☕',
      desc_en: 'Lowest friction. Card payment, no account required, US$3 per "coffee".',
      desc_jp: '最も簡単。カード決済のみ、アカウント不要、1 杯 US$3。',
    },
    {
      id: 'bmac',
      label_en: 'Buy Me a Coffee',
      label_jp: 'Buy Me a Coffee',
      url: 'https://www.buymeacoffee.com/TaiganBridge',
      icon: '🥐',
      desc_en: 'Same idea as Ko-fi — pick whichever you prefer.',
      desc_jp: 'Ko-fi と同じ仕組み。お好みでどうぞ。',
    },
  ];

  const FEEDBACK_EMAIL = 'benjamin.eichhorn@gmail.com';

  // ─── DOM helpers ───────────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    return TB.utils.el(tag, attrs, ...children);
  }
  function t(key, vars) {
    return (TB.i18n && TB.i18n.t) ? TB.i18n.t(key, vars) : key;
  }

  function getModalRoot() {
    let root = document.getElementById('tb-modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tb-modal-root';
      document.body.appendChild(root);
    }
    return root;
  }

  // Open a modal with a given header + body. The body callback
  // receives a `close()` function so action buttons inside the body
  // can dismiss the modal cleanly.
  function openModal(opts) {
    const root = getModalRoot();
    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', {
      class: 'tb-modal',
      style: { maxWidth: opts.maxWidth || '720px', maxHeight: '88vh', overflow: 'auto' },
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tb-overlay-title',
    });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function escClose(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escClose);
      }
    });

    // Header row — title + close button
    modal.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 'var(--tb-sp-3)', gap: 'var(--tb-sp-3)' },
    },
      el('h2', { id: 'tb-overlay-title', style: { margin: 0 } }, opts.title),
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 10px' },
        onclick: close,
        'aria-label': t('overlay.close'),
      }, '✕'),
    ));

    // Body
    const bodyHost = el('div', null);
    modal.appendChild(bodyHost);
    opts.renderBody(bodyHost, close);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Markdown → HTML (minimal) ─────────────────────────────────────
  // Both LICENSE.md and CHANGELOG.md are author-controlled and have a
  // narrow set of constructs we need to render:
  //   #/##/### headings, **bold**, *italic*, `code`, links, lists,
  //   horizontal rules, paragraphs. No tables / images / embedded
  //   HTML. Keeping this in-house instead of pulling in marked.js
  //   avoids a new dep + dist-size bump.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function inlineFmt(s) {
    return escapeHtml(s)
      // links: [text](url) — render as external link
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
        const safe = /^https?:\/\/|^mailto:/.test(url) ? url : '#';
        return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
      })
      // **bold**
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // *italic*
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // `code`
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inList = false;
    let listType = null;
    let inPara = false;
    function closeList() { if (inList) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; listType = null; } }
    function closePara() { if (inPara) { out.push('</p>'); inPara = false; } }
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line) { closeList(); closePara(); continue; }
      // Horizontal rule
      if (/^---+$/.test(line)) { closeList(); closePara(); out.push('<hr>'); continue; }
      // Headings
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        closeList(); closePara();
        const level = h[1].length;
        out.push('<h' + level + '>' + inlineFmt(h[2]) + '</h' + level + '>');
        continue;
      }
      // Unordered list item
      if (/^\s*[-*+]\s+/.test(line)) {
        closePara();
        if (!inList || listType !== 'ul') { closeList(); out.push('<ul>'); inList = true; listType = 'ul'; }
        out.push('<li>' + inlineFmt(line.replace(/^\s*[-*+]\s+/, '')) + '</li>');
        continue;
      }
      // Ordered list item
      if (/^\s*\d+\.\s+/.test(line)) {
        closePara();
        if (!inList || listType !== 'ol') { closeList(); out.push('<ol>'); inList = true; listType = 'ol'; }
        out.push('<li>' + inlineFmt(line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
        continue;
      }
      // Paragraph
      if (!inPara) { closeList(); out.push('<p>'); inPara = true; }
      else { out.push(' '); }
      out.push(inlineFmt(line));
    }
    closeList(); closePara();
    return out.join('\n');
  }

  // ─── License modal ─────────────────────────────────────────────────
  function openLicense() {
    openModal({
      title: '📜 ' + t('overlay.license.title'),
      maxWidth: '780px',
      renderBody: (host) => {
        const text = (TB.content && TB.content.licenseText) || '';
        if (!text) {
          host.appendChild(el('p', { class: 'tb-card-meta' }, t('overlay.license.missing')));
          return;
        }
        const wrap = el('div', { class: 'tb-md-body' });
        wrap.innerHTML = mdToHtml(text);
        host.appendChild(wrap);
      },
    });
  }

  // ─── Changelog (What's new) modal ──────────────────────────────────
  function openChangelog() {
    openModal({
      title: '✨ ' + t('overlay.changelog.title'),
      maxWidth: '820px',
      renderBody: (host) => {
        const text = (TB.content && TB.content.changelogText) || '';
        if (!text) {
          host.appendChild(el('p', { class: 'tb-card-meta' }, t('overlay.changelog.missing')));
          return;
        }
        host.appendChild(el('p', { class: 'tb-card-meta' }, t('overlay.changelog.intro')));
        const wrap = el('div', { class: 'tb-md-body' });
        wrap.innerHTML = mdToHtml(text);
        host.appendChild(wrap);
      },
    });
  }

  // ─── Feedback modal ────────────────────────────────────────────────
  // Browsers can't send mail without involving the user's mail client,
  // and we don't run a backend. So the feedback flow is: pre-fill a
  // mailto: with the user's draft, plus offer a "Copy to clipboard"
  // path for users without a mail client (web-mail-only users on
  // managed devices, etc.). Privacy-safe: the whole flow happens in
  // the browser, the author only sees what the user actually sends.
  function openFeedback() {
    openModal({
      title: '💬 ' + t('overlay.feedback.title'),
      maxWidth: '640px',
      renderBody: (host, close) => {
        host.appendChild(el('p', null, t('overlay.feedback.intro')));

        // Subject + body inputs — pre-populated with version/build so
        // bug reports always carry the build hash.
        const v = document.querySelector('meta[name="tb-version"]')?.content || '';
        const h = document.querySelector('meta[name="tb-build-hash"]')?.content || '';
        const subject = '[Taigan Bridge] feedback — v' + v;
        const bodyTemplate = [
          '',
          '',
          '',
          '— — — — — — — — — — — — — — —',
          'Build: v' + v + ' (' + h + ')',
          'Browser: ' + (navigator.userAgent || 'unknown'),
          'Lang: ' + ((TB.i18n && TB.i18n.getLang) ? TB.i18n.getLang() : 'unknown'),
        ].join('\n');

        const subjectInput = el('input', {
          type: 'text', class: 'tb-input',
          style: { width: '100%', marginBottom: 'var(--tb-sp-2)', fontFamily: 'inherit' },
          value: subject,
        });
        const bodyInput = el('textarea', {
          class: 'tb-input',
          rows: 10,
          style: { width: '100%', fontFamily: 'inherit', fontSize: 'var(--tb-fs-14)', lineHeight: '1.5' },
          placeholder: t('overlay.feedback.placeholder'),
        }, bodyTemplate);

        host.appendChild(el('label', { class: 'tb-field-label' }, t('overlay.feedback.subject')));
        host.appendChild(subjectInput);
        host.appendChild(el('label', { class: 'tb-field-label', style: { marginTop: 'var(--tb-sp-2)' } },
          t('overlay.feedback.body')));
        host.appendChild(bodyInput);

        // Action row
        const actions = el('div', {
          style: { display: 'flex', gap: 'var(--tb-sp-2)', flexWrap: 'wrap',
            marginTop: 'var(--tb-sp-3)', justifyContent: 'flex-end' },
        });
        // Open in mail client (mailto:)
        actions.appendChild(el('button', {
          class: 'tb-btn', type: 'button',
          onclick: () => {
            const url = 'mailto:' + encodeURIComponent(FEEDBACK_EMAIL)
              + '?subject=' + encodeURIComponent(subjectInput.value)
              + '&body=' + encodeURIComponent(bodyInput.value);
            window.location.href = url;
          },
        }, '✉ ' + t('overlay.feedback.openMail')));
        // Copy to clipboard
        actions.appendChild(el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            const orig = btn.textContent;
            try {
              const blob = 'To: ' + FEEDBACK_EMAIL + '\nSubject: ' + subjectInput.value + '\n\n' + bodyInput.value;
              await navigator.clipboard.writeText(blob);
              btn.textContent = '✓ ' + t('overlay.feedback.copied');
              setTimeout(() => { btn.textContent = orig; }, 2000);
            } catch (err) {
              btn.textContent = '✗ ' + (err.message || 'failed');
              setTimeout(() => { btn.textContent = orig; }, 2500);
            }
          },
        }, '📋 ' + t('overlay.feedback.copy')));
        actions.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          onclick: close,
        }, t('overlay.close')));
        host.appendChild(actions);

        // Privacy footnote
        host.appendChild(el('p', {
          class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' },
        }, t('overlay.feedback.privacy', { email: FEEDBACK_EMAIL })));
      },
    });
  }

  // ─── Tip jar (Buy me a coffee) modal ───────────────────────────────
  function openTipJar() {
    const lang = (TB.i18n && TB.i18n.getLang) ? TB.i18n.getLang() : 'en';
    openModal({
      title: '☕ ' + t('overlay.tip.title'),
      maxWidth: '560px',
      renderBody: (host) => {
        host.appendChild(el('p', null, t('overlay.tip.intro')));
        host.appendChild(el('p', { class: 'tb-field-help' }, t('overlay.tip.where')));

        const list = el('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)',
            marginTop: 'var(--tb-sp-2)' },
        });
        TIP_LINKS.forEach((tip) => {
          const label = lang === 'ja' ? tip.label_jp : tip.label_en;
          const desc = lang === 'ja' ? tip.desc_jp : tip.desc_en;
          list.appendChild(el('a', {
            href: tip.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: {
              display: 'block', padding: 'var(--tb-sp-2) var(--tb-sp-3)',
              background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
              borderLeft: '3px solid var(--tb-accent, var(--tb-track-fx))',
              textDecoration: 'none', color: 'var(--tb-text)',
            },
          },
            el('div', { style: { fontWeight: '600' } }, tip.icon + ' ' + label + ' →'),
            el('div', { class: 'tb-card-meta', style: { marginTop: '2px' } }, desc),
          ));
        });
        host.appendChild(list);

        host.appendChild(el('p', {
          class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-3)' },
        }, t('overlay.tip.thanks')));
      },
    });
  }

  // ─── Hash router ───────────────────────────────────────────────────
  // Single delegated click listener catches ANY <a href="#license">,
  // <a href="#changelog">, etc. — works for the static footer in
  // index.html, the dynamic About-card content, and any future place
  // these anchors get embedded.
  const HANDLERS = {
    '#license':   openLicense,
    '#changelog': openChangelog,
    '#feedback':  openFeedback,
    '#tip':       openTipJar,
  };

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    const handler = HANDLERS[href];
    if (!handler) return;
    e.preventDefault();
    handler();
  });

  // Also respond to direct hash navigation (page-load with #license,
  // or programmatic hash changes). Use a small allowlist so other
  // hash routes (#dashboard, #profile, etc.) keep working.
  function handleHash() {
    const hash = window.location.hash;
    if (!hash) return;
    const handler = HANDLERS[hash];
    if (!handler) return;
    handler();
    // Clear the hash so closing the modal doesn't get the user stuck
    // — otherwise they'd have to manually edit the URL to reopen.
    try { history.replaceState(null, '', window.location.pathname + window.location.search); }
    catch (_) { /* old browsers — leave the hash */ }
  }
  window.addEventListener('hashchange', handleHash);
  if (document.readyState !== 'loading') {
    handleHash();
  } else {
    document.addEventListener('DOMContentLoaded', handleHash);
  }

  // Public API for programmatic open from anywhere (Settings, etc.)
  window.TB = window.TB || {};
  window.TB.aboutOverlays = {
    openLicense, openChangelog, openFeedback, openTipJar,
  };
})();
