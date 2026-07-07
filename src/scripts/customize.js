/* Taigan Bridge — customize.js
 *
 * Per-module section visibility infrastructure.
 *
 * Each module declares a SECTIONS registry — an array of:
 *   { id: 'unique', label_en, label_jp, description_en?, description_jp?,
 *     auto_show: () => boolean, always: false }
 *
 * Conditional rendering becomes:
 *
 *   if (TB.customize.isSectionEnabled('family', 'nationality_choice', autoFn)) {
 *     container.appendChild(buildNationalityChoiceCard());
 *   }
 *
 * The user override takes precedence; otherwise the auto-detection
 * predicate decides. State lives in
 * settings.module_customizations.{moduleId}.enabled_sections.{sectionId}
 * with values: true | false | null (null = use auto-detection).
 *
 * Each module appends TB.customize.buildPanel(moduleId, SECTIONS) at the
 * bottom of its render() so users can flip any section on or off.
 */

(function () {
  'use strict';

  function getOverrides(moduleId) {
    const all = TB.state.get('settings.module_customizations') || {};
    return (all[moduleId] && all[moduleId].enabled_sections) || {};
  }

  function setOverride(moduleId, sectionId, value) {
    const all = TB.state.get('settings.module_customizations') || {};
    if (!all[moduleId]) all[moduleId] = { enabled_sections: {} };
    if (!all[moduleId].enabled_sections) all[moduleId].enabled_sections = {};
    if (value === null) delete all[moduleId].enabled_sections[sectionId];
    else all[moduleId].enabled_sections[sectionId] = value;
    TB.state.set('settings.module_customizations', all);
  }

  // Returns true/false based on user override OR auto-detection predicate.
  function isSectionEnabled(moduleId, sectionId, autoFn) {
    const overrides = getOverrides(moduleId);
    if (sectionId in overrides) {
      const v = overrides[sectionId];
      if (v === true) return true;
      if (v === false) return false;
      // null falls through to auto
    }
    if (typeof autoFn === 'function') {
      try { return !!autoFn(); }
      catch (err) { console.warn('[customize] auto-show predicate failed:', err); return true; }
    }
    return true;
  }

  // Returns the current override state for a section: 'auto' | 'on' | 'off'.
  function getSectionState(moduleId, sectionId) {
    const overrides = getOverrides(moduleId);
    if (!(sectionId in overrides)) return 'auto';
    if (overrides[sectionId] === true) return 'on';
    if (overrides[sectionId] === false) return 'off';
    return 'auto';
  }

  // Builds the bottom-of-module Customize panel. `sections` is the
  // module's SECTIONS registry. Sections marked `always: true` aren't
  // shown (no toggle for required sections).
  function buildPanel(moduleId, sections) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const togglable = sections.filter((s) => !s.always);
    if (togglable.length === 0) return el('div', { style: { display: 'none' } });

    const card = el('div', { class: 'tb-card', 'data-print-hide': '' });
    const details = el('details', null);
    details.appendChild(el('summary', {
      style: { cursor: 'pointer', fontWeight: '600' },
    }, '⚙ ' + t('customize.title')));

    details.appendChild(el('p', { class: 'tb-card-meta' }, t('customize.intro')));

    const list = el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' },
    });
    togglable.forEach((s) => {
      const state = getSectionState(moduleId, s.id);
      const autoVisible = typeof s.auto_show === 'function'
        ? (function () { try { return !!s.auto_show(); } catch (e) { return true; } })()
        : true;
      const effective = state === 'auto' ? autoVisible : state === 'on';

      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      });

      // Left: label + auto-state hint
      const left = el('div', { style: { flex: '1', minWidth: '180px' } });
      left.appendChild(el('div', {
        style: { fontWeight: '500',
          color: effective ? 'var(--tb-text)' : 'var(--tb-text-soft)' },
      },
        (effective ? '✓ ' : '○ ') +
        (lang === 'ja' ? s.label_jp : s.label_en)));
      const desc = lang === 'ja' ? s.description_jp : s.description_en;
      if (desc) {
        left.appendChild(el('div', {
          class: 'tb-field-help', style: { marginTop: '2px' },
        }, desc));
      }
      // Auto-state hint
      const autoHint = state === 'auto'
        ? '(' + t('customize.auto') + ': ' +
          (autoVisible ? t('customize.shown') : t('customize.hidden')) + ')'
        : '';
      if (autoHint) {
        left.appendChild(el('div', {
          style: { color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', marginTop: '2px', fontStyle: 'italic' },
        }, autoHint));
      }
      row.appendChild(left);

      // Right: tri-state select
      const sel = el('select', {
        class: 'tb-select',
        style: { maxWidth: '140px' },
        onchange: (e) => {
          const v = e.target.value;
          if (v === 'auto') setOverride(moduleId, s.id, null);
          else if (v === 'on')  setOverride(moduleId, s.id, true);
          else if (v === 'off') setOverride(moduleId, s.id, false);
          // Trigger module rerender via the standard navigation event;
          // each module listens for state changes through its own re-render path.
          document.dispatchEvent(new CustomEvent('tb:customize-changed', {
            detail: { moduleId, sectionId: s.id, value: v },
          }));
        },
      },
        el('option', { value: 'auto', selected: state === 'auto' }, t('customize.opt.auto')),
        el('option', { value: 'on',   selected: state === 'on' },   t('customize.opt.on')),
        el('option', { value: 'off',  selected: state === 'off' },  t('customize.opt.off')),
      );
      row.appendChild(sel);

      list.appendChild(row);
    });
    details.appendChild(list);

    // Reset all
    details.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-3)', textAlign: 'right' } },
      el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          const all = TB.state.get('settings.module_customizations') || {};
          if (all[moduleId]) {
            delete all[moduleId];
            TB.state.set('settings.module_customizations', all);
            document.dispatchEvent(new CustomEvent('tb:customize-changed', {
              detail: { moduleId, reset: true },
            }));
          }
        },
      }, t('customize.reset'))));

    card.appendChild(details);
    return card;
  }

  // Modules call this in their setup to listen for customize changes
  // and re-render. Returns the unsubscribe function.
  function onChange(moduleId, callback) {
    const handler = (e) => {
      if (!e.detail) return;
      if (e.detail.moduleId === moduleId) callback(e.detail);
    };
    document.addEventListener('tb:customize-changed', handler);
    return () => document.removeEventListener('tb:customize-changed', handler);
  }

  window.TB = window.TB || {};
  window.TB.customize = {
    isSectionEnabled,
    buildPanel,
    onChange,
  };
})();
