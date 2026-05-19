/* Taigan Bridge — modules/ask-taigan.js
 *
 * "Ask Taigan" — chat with a Claude-powered assistant that knows your
 * full Taigan Bridge state. Each turn injects a curated state digest
 * (markdown, ~2-4K tokens) so answers are specific to YOUR situation
 * rather than generic expat-finance advice.
 *
 * Architecture:
 *
 *   1. State digest builder (TB.askTaigan.buildStateDigest) walks every
 *      module's state and produces a compact markdown summary. Sensitive
 *      values (full account numbers, exact balances if user opts) are
 *      already excluded by the contract that other modules' "for AI"
 *      surfaces honor (e.g., FBAR's summarizeFbarForAi).
 *
 *   2. Chat surface — Claude Sonnet by default. System prompt frames
 *      Taigan as a Japan-resident-US-expat domain expert with hard
 *      rules: (a) cite which module a fact came from, (b) call out
 *      when professional advice is needed, (c) use Japanese terms with
 *      English explanations, (d) reference user's actual numbers.
 *
 *   3. Conversations persisted in state. Each conversation auto-titles
 *      from the first user message. New conversation, switch, delete.
 *
 *   4. Module navigation links — when the assistant references a module
 *      via the [Module Name](#module-id) markdown link pattern, the
 *      renderer parses these and turns them into in-app navigation.
 *
 * Cost: each turn sends ~2-4K state tokens + conversation history. At
 * Sonnet pricing ($3/M input, $15/M output), a typical exchange costs
 * <$0.05. The state digest is regenerated each turn (state may have
 * changed since last message).
 */

(function () {
  'use strict';

  const id = 'ask-taigan';

  // ====================================================================
  // System prompt — defines Taigan's role + behavior
  // ====================================================================

  const SYSTEM_PROMPT_BASE =
`You are Taigan, the AI assistant for Taigan Bridge — a financial planning tool for US persons living in Japan. The user is asking a question and you have access to their full Taigan Bridge state, provided as a markdown digest in the next system message.

Your role:
- Answer the user's question using THEIR state. Reference specific numbers, account names, family members, and dates from the digest.
- When you reference a fact, cite which module it came from in parentheses, e.g. "(from Family roster)" or "(from Asset tracker)".
- When you suggest the user check or update something, link to the relevant module using markdown: [Module Name](#module-id). Module IDs: action-center, tax-coordinator, fbar, assets, projections, document-vault, sofa-roth, veteran, resident, family, estate, ask-taigan, settings.
- Use Japanese terms (確定申告, 配偶者控除, 法定相続人, etc.) with brief English explanations the first time they appear in a response.
- Currency: show JPY amounts with ¥, USD with $. Convert when helpful.

Hard rules:
- This is informational guidance, NOT legal, tax, immigration, or investment advice. When the question requires professional expertise, say so explicitly and recommend the right specialist (CPA / 税理士 / 司法書士 / 弁護士 / 行政書士 / immigration attorney / VA-accredited claims agent).
- If the state digest doesn't contain the information needed to answer specifically, say so — don't fabricate. You can suggest the user populate the relevant module.
- If the user asks about a topic where they haven't unlocked the relevant module (e.g., asks about veteran benefits but no Veteran data), suggest they enable that module section via Customize.
- Be concise. Default to ≤300 words unless the question genuinely requires more depth. Use bullets and short paragraphs.
- Never invent specific tax brackets, deadlines, or legal thresholds beyond what's in the digest. The digest contains current 2026 figures.
- For sensitive areas (renunciation, exit tax, PFIC remediation), always emphasize the irrevocability or severity AND recommend specialist consultation.

Tone: direct, knowledgeable, respectful of the user's time. You're talking to someone who's already savvy about cross-border finance — don't over-explain basics they know.`;

  // ====================================================================
  // State digest builder — produces a markdown summary for the AI
  // ====================================================================

  // Returns a markdown string summarizing the user's Taigan Bridge
  // state. Designed to be ~2-4K tokens. Walks each module's data
  // through public summarization APIs where they exist.
  function buildStateDigest() {
    const lines = [];
    const today = new Date().toISOString().slice(0, 10);

    lines.push('# Taigan Bridge State Digest');
    lines.push('Generated: ' + today);
    lines.push('');

    // ── User profile ────────────────────────────────────────────────
    const profile = TB.state.get('profile') || {};
    lines.push('## User Profile');
    if (profile.displayName) lines.push('- Name: ' + profile.displayName);
    if (profile.displayNameJa) lines.push('- 氏名: ' + profile.displayNameJa);
    lines.push('');

    // ── Onboarding answers ──────────────────────────────────────────
    const a = TB.state.get('onboarding.answers') || {};
    if (Object.keys(a).length > 0) {
      lines.push('## Onboarding Answers');
      const interesting = [
        'citizenship', 'in_japan', 'years_in_japan', 'visa',
        'employment', 'separation_date', 'veteran', 'juminhyou',
        'tax_status', 'family', 'real_estate',
      ];
      interesting.forEach((k) => {
        if (a[k] != null && a[k] !== '') {
          const v = Array.isArray(a[k]) ? a[k].join(', ') : a[k];
          lines.push('- ' + k + ': ' + v);
        }
      });
      lines.push('');
    }

    // ── Tracks unlocked ────────────────────────────────────────────
    const tracks = TB.state.get('tracks') || [];
    if (tracks.length > 0) {
      lines.push('## Active Tracks');
      lines.push(tracks.join(', '));
      lines.push('');
    }

    // ── Action Center: top items ────────────────────────────────────
    if (TB.actionCenter && typeof TB.actionCenter.deriveActions === 'function') {
      try {
        const actions = TB.actionCenter.deriveActions().slice(0, 5);
        if (actions.length > 0) {
          lines.push('## Top Action Items (next 5)');
          actions.forEach((act) => {
            lines.push('- [' + (act.urgency || 'med') + '] ' + act.title);
          });
          lines.push('');
        }
      } catch (err) { /* swallow */ }
    }

    // ── Assets summary ──────────────────────────────────────────────
    if (TB.assets && typeof TB.assets.getActiveAccounts === 'function') {
      try {
        const accounts = TB.assets.getActiveAccounts();
        const totalUsd = accounts.reduce((s, x) =>
          s + TB.assets.toUsd(x.balance_native, x.currency), 0);
        const usCount = accounts.filter((x) => x.country === 'US').length;
        const jpCount = accounts.filter((x) => x.country === 'JP').length;
        lines.push('## Assets');
        lines.push('- Total: ~$' + Math.round(totalUsd).toLocaleString() + ' USD across ' + accounts.length + ' active accounts');
        lines.push('- ' + usCount + ' US-situs, ' + jpCount + ' JP-situs');
        // Wrapper breakdown (top 5)
        const byWrapper = {};
        accounts.forEach((x) => {
          byWrapper[x.tax_wrapper || 'other'] = (byWrapper[x.tax_wrapper || 'other'] || 0) +
            TB.assets.toUsd(x.balance_native, x.currency);
        });
        const top = Object.entries(byWrapper).sort((p, q) => q[1] - p[1]).slice(0, 5);
        top.forEach(([w, v]) => {
          lines.push('  - ' + w + ': $' + Math.round(v).toLocaleString());
        });
        lines.push('');
      } catch (err) { /* swallow */ }
    }

    // ── FBAR (no PII; summary only) ────────────────────────────────
    if (TB.fbar && typeof TB.fbar.summarizeFbarForAi === 'function') {
      try {
        const summary = TB.fbar.summarizeFbarForAi();
        if (summary && summary.account_count > 0) {
          lines.push('## FBAR (foreign accounts)');
          lines.push('- ' + summary.account_count + ' accounts across ' + (summary.filer_count || 0) + ' filers');
          if (summary.years_with_filings) {
            lines.push('- Filed for years: ' + (summary.years_with_filings || []).join(', '));
          }
          lines.push('');
        }
      } catch (err) { /* swallow */ }
    }

    // ── Family roster ──────────────────────────────────────────────
    const familyMembers = TB.state.get('family.members') || [];
    if (familyMembers.length > 0) {
      lines.push('## Family Roster');
      familyMembers.forEach((m) => {
        const cit = (m.citizenships || []).join('/');
        const age = m.birth_date ? computeAge(m.birth_date) + 'y' : '';
        lines.push('- ' + (m.name_en || m.name_jp || '(unnamed)') +
          ' — ' + m.relationship + (age ? ', ' + age : '') +
          (cit ? ', ' + cit : ''));
      });
      lines.push('');
    }
    const giftsLog = TB.state.get('family.gifts_log') || [];
    if (giftsLog.length > 0) {
      const cutoff = new Date().getFullYear() - 7;
      const inWindow = giftsLog.filter((g) => g.year >= cutoff);
      if (inWindow.length > 0) {
        const total = inWindow.reduce((s, g) => s + (g.amount_jpy || 0), 0);
        lines.push('## Gifts in 7y Clawback Window');
        lines.push('- ' + inWindow.length + ' gifts, ¥' + total.toLocaleString() + ' total');
        lines.push('');
      }
    }
    const renunciation = TB.state.get('family.renunciation') || {};
    if (renunciation.contemplating) {
      lines.push('## Renunciation Status');
      lines.push('- Contemplating renunciation: yes');
      if (renunciation.target_year) lines.push('- Target year: ' + renunciation.target_year);
      if (renunciation.estimated_net_worth_usd) {
        lines.push('- Estimated net worth: $' + renunciation.estimated_net_worth_usd.toLocaleString() +
          (renunciation.estimated_net_worth_usd >= 2000000 ? ' (≥$2M = covered expatriate threshold)' : ''));
      }
      lines.push('- Specialist consultation complete: ' + (renunciation.consultation_complete ? 'yes' : 'NO'));
      lines.push('');
    }

    // ── Resident / 永住権 / 確定申告 ────────────────────────────────
    if (TB.resident && typeof TB.resident.yearsInJapan === 'function') {
      const yrs = TB.resident.yearsInJapan();
      const residency = TB.state.get('resident.residency') || {};
      if (yrs != null || residency.arrival_date || residency.visa_status) {
        lines.push('## Japan Residency');
        if (yrs != null) lines.push('- Years in Japan: ~' + yrs);
        if (residency.arrival_date) lines.push('- Arrival: ' + residency.arrival_date);
        if (residency.visa_status) lines.push('- Visa: ' + residency.visa_status);
        if (residency.juminhyo_status) lines.push('- 住民票: ' + residency.juminhyo_status);
        if (residency.permanent_residency) lines.push('- 永住者 (PR) granted: yes');
        if (yrs != null && yrs >= 6) lines.push('- 永住者 tax status: ACTIVE (worldwide assets in JP scope)');
        lines.push('');
      }
      try {
        const clock = TB.resident.tenYearClock();
        if (clock) {
          lines.push('## 10-year Worldwide-Asset Clock');
          if (clock.days < 0) {
            lines.push('- PAST: worldwide-asset scope already active for ' +
              Math.abs(Math.round(clock.days / 365)) + 'y');
          } else {
            lines.push('- ' + Math.floor(clock.days / 365) + 'y ' +
              Math.round((clock.days % 365) / 30) + 'mo until JP estate scope expands to worldwide');
          }
          lines.push('');
        }
      } catch (err) { /* swallow */ }
    }

    // ── Veteran ─────────────────────────────────────────────────────
    if (a.veteran && a.veteran !== 'no') {
      lines.push('## Veteran Status');
      lines.push('- Service status: ' + a.veteran);
      if (a.separation_date) lines.push('- Separation date: ' + a.separation_date);
      const vet = TB.state.get('veteran') || {};
      if (vet.disability && vet.disability.overall_rating_pct) {
        lines.push('- VA disability rating: ' + vet.disability.overall_rating_pct + '%');
      }
      if (vet.healthcare && vet.healthcare.tricare_eligible) {
        lines.push('- TRICARE: ' + (vet.healthcare.tricare_plan || 'eligible'));
      }
      if (vet.education && vet.education.benefit_type) {
        lines.push('- GI Bill: ' + vet.education.benefit_type +
          (vet.education.months_remaining != null ? ', ' + vet.education.months_remaining + 'mo remaining' : ''));
      }
      lines.push('');
    }

    // ── Tax Coordinator: applicable forms ──────────────────────────
    if (TB.taxCoord && typeof TB.taxCoord.buildContext === 'function') {
      try {
        const ctx = TB.taxCoord.buildContext();
        lines.push('## Tax Filing Context');
        lines.push('- Filing status: ' + ctx.filing_status_label);
        if (ctx.feie_choice && ctx.feie_choice !== 'undecided') {
          lines.push('- FEIE/FTC election: ' + ctx.feie_choice);
        } else {
          lines.push('- FEIE/FTC election: undecided');
        }
        lines.push('- JP tax resident: ' + (ctx.is_jp_resident ? 'yes' : 'no'));
        lines.push('- Foreign assets total: $' + Math.round(ctx.foreign_assets_usd).toLocaleString());
        lines.push('- FBAR aggregate (year-end proxy): $' + Math.round(ctx.fbar_aggregate_usd).toLocaleString());
        if (ctx.has_pfic === true) {
          lines.push('- ⚠ PFIC detected: ' + (ctx.pfic_account_names || []).join(', '));
        }
        if (ctx.has_foreign_corp === true) {
          lines.push('- Owns foreign corporation (Form 5471 required)');
        }
        lines.push('');
      } catch (err) { /* swallow */ }
    }

    // ── Estate ──────────────────────────────────────────────────────
    if (TB.estate && typeof TB.estate.computeJpInheritanceTax === 'function') {
      try {
        const tax = TB.estate.computeJpInheritanceTax();
        const heirs = TB.estate.deriveStatutoryHeirs();
        if (heirs.all_heirs.length > 0) {
          lines.push('## Estate Snapshot');
          lines.push('- Statutory heirs: ' + heirs.all_heirs.length +
            ' (priority class: ' + (heirs.rank === 1 ? 'descendants' :
              heirs.rank === 2 ? 'ascendants' : heirs.rank === 3 ? 'siblings' : 'spouse only') + ')');
          if (tax.net_tax > 0) {
            lines.push('- Projected JP 相続税: ¥' + Math.round(tax.net_tax).toLocaleString() +
              ' (after spouse credit ¥' + Math.round(tax.spouse_credit).toLocaleString() + ')');
          } else {
            lines.push('- Projected JP 相続税: ¥0 (below taxable threshold)');
          }
          lines.push('');
        }
      } catch (err) { /* swallow */ }
    }

    // ── Document Vault: counts only (not contents) ─────────────────
    const vault = TB.state.get('documentVault.items') || [];
    if (vault.length > 0) {
      const byCat = {};
      vault.forEach((v) => { byCat[v.category] = (byCat[v.category] || 0) + 1; });
      lines.push('## Document Vault');
      lines.push('- ' + vault.length + ' items across ' + Object.keys(byCat).length + ' categories');
      Object.entries(byCat).forEach(([cat, n]) => {
        lines.push('  - ' + cat + ': ' + n);
      });
      lines.push('');
    }

    // ── Projections summary ────────────────────────────────────────
    const proj = TB.state.get('projections.inputs') || {};
    if (proj.current_age) {
      lines.push('## Projection Inputs');
      lines.push('- Age: ' + proj.current_age + ', planned retirement: ' + proj.retire_age);
      if (proj.base_salary_usd) lines.push('- Base salary: $' + proj.base_salary_usd.toLocaleString());
      if (proj.ss_start_age) lines.push('- SS start: age ' + proj.ss_start_age +
        (proj.ss_monthly_at_70_usd ? ' ($' + proj.ss_monthly_at_70_usd + '/mo at 70)' : ''));
      const ladderCount = (proj.roth_conversions || []).length;
      if (ladderCount > 0) lines.push('- Roth conversion ladder: ' + ladderCount + ' planned conversions');
      lines.push('');
    }

    // ── Health Tracker — comprehensive snapshot (v0.57) ────────────
    const ht = TB.state.get('health_tracker') || {};
    if (ht.exams || ht.medications || ht.dental || ht.insurance_summary) {
      lines.push('## Health Tracker');

      // Recent exams (last 3) — date, type, provider, key facts
      const exams = (ht.exams || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 3);
      if (exams.length > 0) {
        lines.push('### Recent exams');
        for (const e of exams) {
          const bits = [e.date || '?', e.type || 'exam'];
          if (e.provider) bits.push(e.provider);
          if (e.facility && e.facility !== e.provider) bits.push(e.facility);
          const flaggedLabs = (e.lab_results || []).filter((lr) =>
            lr.flag === 'high' || lr.flag === 'low' || lr.flag === 'critical');
          if (flaggedLabs.length > 0) {
            bits.push(flaggedLabs.length + ' flagged labs');
          }
          if ((e.diagnoses || []).length > 0) {
            bits.push('Dx: ' + e.diagnoses.slice(0, 3).join(', '));
          }
          lines.push('- ' + bits.join(' · '));
        }
        lines.push('');
      }

      // Active medications
      const activeMeds = (ht.medications || []).filter((m) => !m.ended_date);
      if (activeMeds.length > 0) {
        lines.push('### Active medications (' + activeMeds.length + ')');
        for (const m of activeMeds.slice(0, 10)) {
          lines.push('- ' + (m.name || '?') +
            (m.dosage != null ? ' · ' + m.dosage + (m.dosage_unit || '') : '') +
            (m.frequency ? ' · ' + m.frequency : '') +
            (m.purpose ? ' (for ' + m.purpose + ')' : '') +
            (m.next_refill_date ? ' · refill ' + m.next_refill_date : ''));
        }
        if (activeMeds.length > 10) lines.push('- … +' + (activeMeds.length - 10) + ' more');
        lines.push('');
      }

      // Care plan — concerns + screenings due
      const cp = ht.care_plan || {};
      if ((cp.primary_concerns || []).length > 0) {
        lines.push('### Primary health concerns');
        for (const c of cp.primary_concerns.slice(0, 8)) {
          if (c && c.text) lines.push('- ' + c.text);
        }
        lines.push('');
      }
      // Screenings overdue (uses computeScreeningsDue if available)
      if (TB.healthTracker && typeof TB.healthTracker.computeScreeningsDue === 'function') {
        try {
          const screenings = TB.healthTracker.computeScreeningsDue();
          const overdue = screenings.filter((s) => s.status === 'critical' || s.status === 'due');
          if (overdue.length > 0) {
            lines.push('### Preventive screenings overdue');
            for (const s of overdue.slice(0, 6)) {
              lines.push('- ' + s.label_en + ' · last ' + (s.last_done || 'never') + ' · ' + s.status);
            }
            lines.push('');
          }
        } catch (_) {}
      }

      // Insurance — per-card benefits summary
      const cards = (ht.insurance_summary && ht.insurance_summary.cards) || [];
      if (cards.length > 0) {
        lines.push('### Insurance cards (' + cards.length + ')');
        for (const c of cards) {
          const head = [c.insurer || '?', c.plan_name].filter(Boolean).join(' — ');
          lines.push('- ' + head + ' · ' + (c.card_type || 'medical') +
            (c.network_type ? ' · ' + c.network_type : '') +
            (c.expiry_date ? ' · expires ' + c.expiry_date : ''));
          const b = c.benefits || {};
          if (b.deductible_individual != null || b.oop_max_individual != null) {
            const ded = b.deductible_individual != null
              ? 'Ded ' + (b.currency === 'JPY' ? '¥' : '$') + b.deductible_individual.toLocaleString() : null;
            const oop = b.oop_max_individual != null
              ? 'OOP ' + (b.currency === 'JPY' ? '¥' : '$') + b.oop_max_individual.toLocaleString() : null;
            lines.push('  Benefits: ' + [ded, oop].filter(Boolean).join(' · ') +
              (b.referral_required === false ? ' · no referral' : b.referral_required === true ? ' · referral required' : ''));
          }
          if (b.rx_coverage) lines.push('  Rx: ' + b.rx_coverage);
        }
        lines.push('');
      }

      // Dental — providers, perio stats, latest cleaning
      const dent = ht.dental || {};
      if ((dent.providers && dent.providers.length > 0) || dent.last_cleaning || (dent.notes_log && dent.notes_log.length > 0)) {
        lines.push('### Dental');
        if (dent.last_cleaning) lines.push('- Last cleaning: ' + dent.last_cleaning);
        if (dent.periodontal) {
          const p = dent.periodontal;
          const perioBits = [];
          if (p.pockets_4mm_pct != null) perioBits.push('Pockets 4mm+: ' + p.pockets_4mm_pct + '%');
          if (p.bleeding_on_probing_pct != null) perioBits.push('BoP: ' + p.bleeding_on_probing_pct + '%');
          if (p.mobile_teeth != null) perioBits.push('Mobile: ' + p.mobile_teeth);
          if (perioBits.length > 0) lines.push('- Periodontal: ' + perioBits.join(' · '));
        }
        const dentProvs = (dent.providers || []).slice(0, 5);
        if (dentProvs.length > 0) {
          lines.push('- Providers: ' + dentProvs.map((p) => p.name_en || p.name_jp || '?').join(', '));
        }
        // Latest dental note action items still open
        const notes = dent.notes_log || [];
        const openItems = [];
        for (const n of notes) {
          if (n.status === 'complete') continue;
          for (const ai of (n.action_items || [])) {
            if (ai && ai.text && !ai.checked) openItems.push(ai.text);
          }
        }
        if (openItems.length > 0) {
          lines.push('- Open dental action items: ' + openItems.slice(0, 3).join('; ') +
            (openItems.length > 3 ? ' (+ ' + (openItems.length - 3) + ' more)' : ''));
        }
        lines.push('');
      }

      // Active care episodes
      const episodes = (ht.episodes || []).filter((e) => e.status !== 'completed' && e.status !== 'cancelled');
      if (episodes.length > 0) {
        lines.push('### Active care episodes');
        for (const ep of episodes.slice(0, 5)) {
          const bits = [ep.title || '?'];
          if (ep.specialty) bits.push(ep.specialty);
          if (ep.provider) bits.push(ep.provider);
          if (ep.started_date) bits.push('since ' + ep.started_date);
          lines.push('- ' + bits.join(' · '));
          if (ep.related_condition) lines.push('  Re: ' + ep.related_condition);
        }
        lines.push('');
      }

      // Total medical spend this year (invoices)
      const thisYear = String(new Date().getFullYear());
      const yearInvoices = (ht.invoices || []).filter((i) => i.date && i.date.startsWith(thisYear));
      if (yearInvoices.length > 0) {
        let totalUsd = 0, currencyHint = 'USD';
        for (const inv of yearInvoices) {
          if (typeof inv.amount_usd_calc === 'number' && isFinite(inv.amount_usd_calc)) {
            totalUsd += inv.amount_usd_calc;
          }
          if (inv.currency) currencyHint = inv.currency;
        }
        lines.push('### Medical spend ' + thisYear);
        lines.push('- ' + yearInvoices.length + ' invoices · ≈ $' + Math.round(totalUsd).toLocaleString() + ' USD equivalent');
        lines.push('');
      }
    }

    // ── Contacts summary (v0.57) — counts by category + key entries
    if (TB.contacts && typeof TB.contacts.getAllContacts === 'function') {
      try {
        const all = TB.contacts.getAllContacts();
        if (all.length > 0) {
          lines.push('## Contacts');
          // Count by category
          const byCat = {};
          for (const c of all) {
            byCat[c.category] = (byCat[c.category] || 0) + 1;
          }
          const catLabels = {
            emergency: 'Emergency', family: 'Family', medical: 'Medical',
            dental: 'Dental', insurance: 'Insurance', financial: 'Financial',
            military_va: 'Military/VA', us_government: 'US Gov',
            japan_government: 'JP Gov', professional: 'Professional', personal: 'Personal',
          };
          const catBits = Object.entries(byCat).map(([k, n]) => (catLabels[k] || k) + ': ' + n);
          lines.push('- ' + catBits.join(' · '));
          // Emergency contacts surfaced explicitly (high signal in
          // medical / urgent questions)
          const emergency = all.filter((c) => c.category === 'emergency' || c.is_emergency);
          if (emergency.length > 0) {
            lines.push('- Emergency contacts:');
            for (const c of emergency.slice(0, 5)) {
              lines.push('  - ' + c.name + (c.phone ? ' · ' + c.phone : '') + (c.type ? ' (' + c.type + ')' : ''));
            }
          }
          lines.push('');
        }
      } catch (_) {}
    }

    return lines.join('\n');
  }

  function computeAge(birth_date) {
    const b = new Date(birth_date + 'T00:00:00');
    if (isNaN(b.getTime())) return '?';
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    const md = now.getMonth() - b.getMonth();
    if (md < 0 || (md === 0 && now.getDate() < b.getDate())) age--;
    return age;
  }

  // ====================================================================
  // Suggested questions — surfaces in "How to use" + as starter chips
  // ====================================================================

  // Returns context-aware suggested prompts. The list adapts: if user
  // has a JP spouse, surface MFJ vs MFS questions; if PFIC detected,
  // surface remediation questions; etc.
  function buildSuggestedQuestions() {
    const a = TB.state.get('onboarding.answers') || {};
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    const tracks = TB.state.get('tracks') || [];
    const out = [];

    // Universal starters
    out.push({
      en: 'What should I do this month?',
      jp: '今月、私は何をすべきですか?',
      cat: 'getting_started',
    });
    out.push({
      en: 'Summarize my financial situation in 5 bullets.',
      jp: '私の財務状況を 5 つの箇条書きで要約してください。',
      cat: 'getting_started',
    });

    // Tax-related (always relevant for US persons)
    out.push({
      en: 'Which tax forms do I actually need to file this year?',
      jp: '今年、私が実際に提出する必要のある税務フォームは?',
      cat: 'tax',
    });
    if (tracks.indexOf('resident') !== -1 || a.tax_status === 'japan_resident') {
      out.push({
        en: 'Should I elect FEIE or FTC for my US 1040?',
        jp: '米国 1040 で FEIE と FTC のどちらを選ぶべきですか?',
        cat: 'tax',
      });
    }

    // Family-specific
    if (fam.indexOf('jp_spouse') !== -1) {
      out.push({
        en: 'My spouse is Japanese — should I make the §6013(g) election to file MFJ?',
        jp: '配偶者が日本人 — MFJ で申告するため §6013(g) を選択すべきですか?',
        cat: 'family',
      });
    }
    if (fam.indexOf('dual_children') !== -1) {
      out.push({
        en: 'When does each of my dual-citizen children need to make 国籍選択?',
        jp: '各二重国籍の子は、いつ国籍選択を行う必要がありますか?',
        cat: 'family',
      });
      out.push({
        en: 'How does US citizenship transmit to my future grandchildren?',
        jp: '米国市民権は将来の孫にどのように継承されますか?',
        cat: 'family',
      });
    }
    if (fam.indexOf('us_children') !== -1 || fam.indexOf('jp_children') !== -1 ||
        fam.indexOf('dual_children') !== -1) {
      out.push({
        en: 'Should I open a 529 plan or use 学資保険 for my kids?',
        jp: '子供のために 529 プランと 学資保険 のどちらを使うべきですか?',
        cat: 'family',
      });
    }

    // PFIC
    if (TB.taxCoord && typeof TB.taxCoord.buildContext === 'function') {
      try {
        const ctx = TB.taxCoord.buildContext();
        if (ctx.has_pfic === true) {
          out.push({
            en: 'PFIC was detected in my Assets — what are my mitigation options?',
            jp: 'Asset で PFIC が検出されました — 緩和策の選択肢は?',
            cat: 'tax',
          });
        }
      } catch (err) { /* swallow */ }
    }

    // Estate-related
    if (tracks.indexOf('resident') !== -1 || a.years_in_japan === '5_to_10' ||
        a.years_in_japan === 'over_10') {
      out.push({
        en: 'How much would my heirs owe in JP 相続税 if I died this year?',
        jp: '今年私が亡くなったら、相続人は日本相続税をいくら支払うことになりますか?',
        cat: 'estate',
      });
      out.push({
        en: 'What\'s the 10-year worldwide-asset clock and how does it affect me?',
        jp: '10 年全世界資産時計とは何で、私にどう影響しますか?',
        cat: 'estate',
      });
    }
    if (fam.indexOf('us_spouse') !== -1 || fam.indexOf('jp_spouse') !== -1) {
      out.push({
        en: 'How should I balance the 配偶者控除 against 二次相続 risk?',
        jp: '配偶者控除 と 二次相続 リスクのバランスはどう取るべきですか?',
        cat: 'estate',
      });
    }

    // Renunciation
    const renun = TB.state.get('family.renunciation') || {};
    if (renun.contemplating) {
      out.push({
        en: 'Walk me through my renunciation timeline and exit-tax exposure.',
        jp: '放棄スケジュールと出国税の影響を順を追って説明してください。',
        cat: 'estate',
      });
    }

    // Veteran-related
    if (a.veteran && a.veteran !== 'no') {
      out.push({
        en: 'Which VA benefits actually work for me in Japan?',
        jp: '日本で実際に利用できる VA 給付は何ですか?',
        cat: 'veteran',
      });
    }

    // Roth/projections
    if (tracks.indexOf('sofa') !== -1) {
      out.push({
        en: 'When\'s the optimal window for Roth conversions before I register 住民票?',
        jp: '住民票登録前の Roth 転換の最適タイミングは?',
        cat: 'projections',
      });
    }

    // Cross-cutting
    out.push({
      en: 'Are there any deadlines I\'m about to miss?',
      jp: 'もうすぐ期限切れの項目はありますか?',
      cat: 'getting_started',
    });
    out.push({
      en: 'Where do I have potential gaps in my financial setup?',
      jp: '私の財務設計に潜在的なギャップはどこにありますか?',
      cat: 'getting_started',
    });

    return out;
  }

  // ====================================================================
  // State accessors
  // ====================================================================

  function getAssistantState() { return TB.state.get('ai_assistant') || {}; }
  function getConversations() { return getAssistantState().conversations || []; }
  function getActiveId() { return getAssistantState().active_conversation_id; }
  function getActiveConversation() {
    const id = getActiveId();
    if (!id) return null;
    return getConversations().find((c) => c.id === id) || null;
  }

  function setConversations(arr) {
    const s = getAssistantState();
    s.conversations = arr;
    TB.state.set('ai_assistant', s);
  }
  function setActiveId(id) {
    const s = getAssistantState();
    s.active_conversation_id = id;
    TB.state.set('ai_assistant', s);
  }

  function newConversation() {
    const conv = {
      id: 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      title: '(new conversation)',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [],
    };
    const arr = getConversations();
    arr.unshift(conv);  // newest first
    setConversations(arr);
    setActiveId(conv.id);
    return conv;
  }

  function deleteConversation(id) {
    const arr = getConversations().filter((c) => c.id !== id);
    setConversations(arr);
    if (getActiveId() === id) {
      setActiveId(arr.length > 0 ? arr[0].id : null);
    }
  }

  function appendMessage(convId, role, content) {
    const arr = getConversations();
    const conv = arr.find((c) => c.id === convId);
    if (!conv) return;
    conv.messages.push({ role, content, ts: new Date().toISOString() });
    conv.updated_at = new Date().toISOString();
    // Auto-title from first user message (truncate to 60 chars)
    if (role === 'user' && (conv.title === '(new conversation)' || !conv.title)) {
      const oneLine = content.split('\n')[0].trim();
      conv.title = oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine;
    }
    setConversations(arr);
  }

  // ====================================================================
  // Send a message — assemble request, call API, append response
  // ====================================================================

  async function sendMessage(userText) {
    if (!userText || !userText.trim()) return;
    if (!TB.ai.hasKey()) {
      throw new Error('No API key. Add your Claude key in Settings to use Ask Taigan.');
    }

    let conv = getActiveConversation();
    if (!conv) conv = newConversation();
    appendMessage(conv.id, 'user', userText);

    // Build the messages array for Claude. Convert our stored messages
    // into the API format. The state digest is sent as a SYSTEM message
    // separate from the base prompt so the model treats it as context
    // rather than as part of its persona.
    const digest = buildStateDigest();
    const apiMessages = (getActiveConversation().messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const systemCombined = SYSTEM_PROMPT_BASE +
      '\n\n---\n\n# CURRENT USER STATE (treat as factual context):\n\n' + digest;

    const json = await TB.ai.callClaude(null, {
      live: true,
      system: systemCombined,
      messages: apiMessages,
      maxTokens: 2048,
      temperature: 0.6,
      feature: 'ask_taigan',
    });

    let assistantText = '';
    if (json && json.content && Array.isArray(json.content)) {
      assistantText = json.content
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('\n')
        .trim();
    }
    if (!assistantText) assistantText = '(no response)';

    appendMessage(conv.id, 'assistant', assistantText);
    return assistantText;
  }

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;

  function render(container) {
    host = container;
    container.innerHTML = '';
    container.appendChild(buildHeaderCard());
    container.appendChild(buildHowToUseCard());
    container.appendChild(buildConversationsCard());
    container.appendChild(buildChatCard());
    container.appendChild(buildPrivacyCard());
  }

  function rerender() { if (host) render(host); }

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'ai' },
      el('h1', null, '💬 ' + t('ask.title')),
      el('p', { class: 'tb-card-meta' }, t('ask.subtitle')),
      !TB.ai.hasKey() ? el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-warn)',
          background: 'rgba(185,122,26,0.06)',
          borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)',
          fontSize: 'var(--tb-fs-14)',
        },
      },
        '⚠ ' + t('ask.no_key_warning'),
        ' ',
        el('a', {
          href: '#', style: { color: 'var(--tb-navy)' },
          onclick: (e) => {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
          },
        }, t('ask.go_to_settings') + ' →'),
      ) : null,
    );
  }

  function buildHowToUseCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const card = el('div', { class: 'tb-card', 'data-track': 'ai' });
    const details = el('details', { open: true });  // open by default
    details.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
      '📖 ' + t('ask.how_to_use')));

    details.appendChild(el('p', { class: 'tb-card-meta' }, t('ask.how_intro')));

    // Three columns: What it knows / What to ask / What it can't do
    const grid = el('div', {
      style: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-2)',
      },
    });
    function tile(emoji, title, body) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)', border: '1px solid var(--tb-border)',
        },
      },
        el('div', { style: { fontWeight: '700', marginBottom: '6px' } }, emoji + ' ' + title),
        el('div', { style: { fontSize: 'var(--tb-fs-12)' } }, body),
      );
    }
    grid.appendChild(tile('🧠', t('ask.what_knows.title'), t('ask.what_knows.body')));
    grid.appendChild(tile('❓', t('ask.what_ask.title'), t('ask.what_ask.body')));
    grid.appendChild(tile('🚫', t('ask.what_cant.title'), t('ask.what_cant.body')));
    details.appendChild(grid);

    // Suggested question chips — clickable to populate input
    const suggestions = buildSuggestedQuestions();
    if (suggestions.length > 0) {
      details.appendChild(el('h3', { style: { marginTop: 'var(--tb-sp-4)', marginBottom: 'var(--tb-sp-2)' } },
        t('ask.suggested_label')));
      const chips = el('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      });
      suggestions.forEach((s) => {
        const text = lang === 'ja' ? s.jp : s.en;
        chips.appendChild(el('button', {
          class: 'tb-btn tb-btn--ghost', type: 'button',
          style: {
            padding: '4px 10px', fontSize: 'var(--tb-fs-12)',
            border: '1px solid var(--tb-border)', borderRadius: 'var(--tb-radius-pill)',
            cursor: 'pointer', textAlign: 'left',
          },
          onclick: () => {
            // Populate the chat input + scroll
            const input = document.getElementById('ask-taigan-input');
            if (input) {
              input.value = text;
              input.focus();
              input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          },
        }, text));
      });
      details.appendChild(chips);
    }

    card.appendChild(details);
    return card;
  }

  function buildConversationsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const conversations = getConversations();
    const activeId = getActiveId();
    if (conversations.length === 0) return el('div', { style: { display: 'none' } });

    const card = el('div', { class: 'tb-card', 'data-track': 'ai' });
    const wrap = el('div', {
      style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    });
    wrap.appendChild(el('div', null,
      el('div', { style: { fontWeight: '600' } }, '🗂 ' + t('ask.conversations')),
      el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
        conversations.length + ' ' + t('ask.conversations_count')),
    ));
    wrap.appendChild(el('button', {
      class: 'tb-btn', type: 'button',
      style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
      onclick: () => { newConversation(); rerender(); },
    }, '＋ ' + t('ask.new_conversation')));
    card.appendChild(wrap);

    // List (collapsible)
    const details = el('details', { style: { marginTop: 'var(--tb-sp-2)' } });
    details.appendChild(el('summary', { style: { cursor: 'pointer', fontSize: 'var(--tb-fs-12)' } },
      t('ask.show_all')));
    const list = el('div', {
      style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: 'var(--tb-sp-2)' },
    });
    conversations.forEach((c) => {
      const isActive = c.id === activeId;
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          background: isActive ? 'var(--tb-bg-elev)' : 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-1)',
          borderLeft: '3px solid ' + (isActive ? 'var(--tb-navy)' : 'var(--tb-border)'),
          gap: 'var(--tb-sp-2)',
        },
      });
      row.appendChild(el('button', {
        type: 'button',
        style: {
          flex: 1, textAlign: 'left', background: 'transparent', border: '0',
          cursor: 'pointer', font: 'inherit', color: 'var(--tb-text)',
        },
        onclick: () => { setActiveId(c.id); rerender(); },
      },
        el('div', { style: { fontWeight: isActive ? '600' : '400' } }, c.title || '(untitled)'),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          (c.messages || []).length + ' ' + t('ask.messages') + ' · ' +
          new Date(c.updated_at).toLocaleDateString()),
      ));
      row.appendChild(el('button', {
        class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          if (confirm(t('ask.confirm_delete'))) { deleteConversation(c.id); rerender(); }
        },
      }, '🗑'));
      list.appendChild(row);
    });
    details.appendChild(list);
    card.appendChild(details);
    return card;
  }

  function buildChatCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const conv = getActiveConversation();

    const card = el('div', { class: 'tb-card', 'data-track': 'ai' });

    // Message list
    const list = el('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)',
        minHeight: '120px', maxHeight: '60vh', overflowY: 'auto',
        padding: 'var(--tb-sp-2)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
      },
    });
    if (!conv || conv.messages.length === 0) {
      list.appendChild(el('div', {
        style: { color: 'var(--tb-text-soft)', fontStyle: 'italic',
          textAlign: 'center', padding: 'var(--tb-sp-4)' },
      }, t('ask.start_chatting')));
    } else {
      conv.messages.forEach((m) => list.appendChild(buildMessageBubble(m)));
    }
    card.appendChild(list);

    // Input
    const inputWrap = el('div', {
      style: { display: 'flex', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)',
        alignItems: 'flex-end' },
    });
    const ta = el('textarea', {
      id: 'ask-taigan-input',
      class: 'tb-input',
      placeholder: t('ask.input_placeholder'),
      rows: 3,
      style: { flex: 1, resize: 'vertical' },
      onkeydown: (e) => {
        // Cmd/Ctrl+Enter to send
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          handleSend();
        }
      },
    });
    // If the active conversation was opened via openWithContext(),
    // pre-fill the textarea with the seeded prompt. Clear it on the
    // conversation so subsequent renders don't re-fill after the user
    // edits and sends.
    (function applyPendingPrompt() {
      const conv = getActiveConversation();
      if (conv && conv.pending_prompt) {
        ta.value = conv.pending_prompt;
        conv.pending_prompt = null;
        setConversations(getConversations().map((c) => c.id === conv.id ? conv : c));
        // Move cursor to end + focus after the layout settles.
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        });
      }
    })();
    const sendBtn = el('button', {
      class: 'tb-btn',
      type: 'button',
      onclick: handleSend,
    }, t('ask.send'));
    inputWrap.appendChild(ta);
    inputWrap.appendChild(sendBtn);
    card.appendChild(inputWrap);

    // Hint
    card.appendChild(el('div', {
      class: 'tb-field-help',
      style: { marginTop: 'var(--tb-sp-2)' },
    }, t('ask.send_hint')));

    function handleSend() {
      const text = ta.value.trim();
      if (!text) return;
      if (!TB.ai.hasKey()) {
        alert(t('ask.no_key_alert'));
        return;
      }
      // Disable + show pending state
      ta.value = '';
      ta.disabled = true;
      sendBtn.disabled = true;
      sendBtn.textContent = '...';

      // Append user msg immediately for snappy UI
      list.appendChild(buildMessageBubble({ role: 'user', content: text, ts: new Date().toISOString() }));
      const pending = el('div', {
        style: { color: 'var(--tb-text-soft)', fontStyle: 'italic',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)' },
      }, '🥷 ' + t('ask.thinking'));
      list.appendChild(pending);
      list.scrollTop = list.scrollHeight;

      sendMessage(text)
        .then(() => {
          ta.disabled = false;
          sendBtn.disabled = false;
          sendBtn.textContent = t('ask.send');
          ta.focus();
          rerender();
        })
        .catch((err) => {
          ta.disabled = false;
          sendBtn.disabled = false;
          sendBtn.textContent = t('ask.send');
          pending.textContent = '⚠ ' + (err && err.message ? err.message : 'Request failed');
          pending.style.color = 'var(--tb-error)';
          console.error('[ask-taigan] send error:', err);
        });
    }

    return card;
  }

  // Message bubble. Parses [Module Name](#module-id) markdown links and
  // turns them into in-app navigation. Other markdown rendering is
  // intentionally minimal (line breaks, basic emphasis) — full
  // markdown isn't worth the dependency for chat-style content.
  function buildMessageBubble(msg) {
    const el = TB.utils.el;
    const isUser = msg.role === 'user';
    const wrap = el('div', {
      style: {
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      },
    });
    const bubble = el('div', {
      style: {
        maxWidth: '85%',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: isUser ? 'var(--tb-navy)' : 'var(--tb-bg-elev)',
        color: isUser ? '#fff' : 'var(--tb-text)',
        borderRadius: 'var(--tb-radius-2)',
        whiteSpace: 'pre-wrap',
        fontSize: 'var(--tb-fs-14)',
        lineHeight: 'var(--tb-lh-body)',
      },
    });

    if (isUser) {
      bubble.textContent = msg.content;
    } else {
      // Parse and render assistant content: handle [text](#module-id)
      // module nav links inline; preserve other text as-is.
      const text = msg.content || '';
      const parts = parseModuleLinks(text);
      parts.forEach((p) => {
        if (p.type === 'text') {
          bubble.appendChild(document.createTextNode(p.text));
        } else if (p.type === 'link') {
          bubble.appendChild(el('a', {
            href: '#',
            style: { color: 'inherit', textDecoration: 'underline' },
            onclick: (e) => {
              e.preventDefault();
              document.dispatchEvent(new CustomEvent('tb:navigate', {
                detail: { view: p.target },
              }));
            },
          }, p.text));
        }
      });
    }
    wrap.appendChild(bubble);
    return wrap;
  }

  // Tiny inline-link parser for [Text](#module-id). Returns an array of
  // segments: { type: 'text', text } or { type: 'link', text, target }.
  function parseModuleLinks(s) {
    const out = [];
    const re = /\[([^\]]+)\]\(#([\w-]+)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) {
        out.push({ type: 'text', text: s.slice(last, m.index) });
      }
      out.push({ type: 'link', text: m[1], target: m[2] });
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
    return out;
  }

  function buildPrivacyCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'ai' });
    const details = el('details', null);
    details.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } },
      '🔒 ' + t('ask.privacy_title')));
    details.appendChild(el('p', { style: { marginTop: 'var(--tb-sp-2)' } },
      t('ask.privacy_body')));
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-2)' } });
    ['ask.privacy.point1', 'ask.privacy.point2', 'ask.privacy.point3', 'ask.privacy.point4']
      .forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '4px' } }, t(k))));
    details.appendChild(ul);
    card.appendChild(details);
    return card;
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id, label_en: 'Ask Taigan', label_jp: 'タイガンに聞く', render,
  };

  // Open the Ask Taigan module with a pre-filled prompt seeded from
  // another module's context (e.g., "ask about this specific asset
  // account", "ask about FBAR aggregation"). Starts a fresh conversation
  // titled after the context label so the chat history shows what
  // was asked about. The user can edit the seeded prompt before sending.
  //
  // ctx shape:
  //   feature   — 'ask_taigan' (consent attribution; defaults to that)
  //   label_en  — short context label for the conversation title
  //   label_jp  — Japanese equivalent
  //   prompt_en — full pre-filled prompt (English)
  //   prompt_jp — full pre-filled prompt (Japanese)
  //
  // Honors the AI consent gate: blocks via friendly alert when posture
  // === 'off' or per-feature deny. Per-call posture lets the user
  // confirm at send time.
  function openWithContext(ctx) {
    ctx = ctx || {};
    const lang = TB.i18n.getLang();
    // Consent fast-path: surface a friendly message if blocked rather
    // than failing silently when the user clicks Send.
    if (TB.ai && typeof TB.ai.isFeatureAllowed === 'function') {
      const ok = TB.ai.isFeatureAllowed(ctx.feature || 'ask_taigan');
      if (ok === false) {
        const msg = TB.i18n.t('ask.context.blocked');
        alert(msg);
        document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
        return;
      }
    }
    // Start a fresh conversation with a context-aware title.
    const conv = newConversation();
    conv.title = (lang === 'ja' ? '質問: ' : 'About: ') + (lang === 'ja' ? (ctx.label_jp || ctx.label_en || '') : (ctx.label_en || ''));
    const arr = getConversations();
    const idx = arr.findIndex((c) => c.id === conv.id);
    if (idx >= 0) { arr[idx] = conv; setConversations(arr); }
    // Stash the seed prompt on the conversation so the render() in
    // Ask Taigan picks it up and pre-fills the input box.
    conv.pending_prompt = lang === 'ja' ? (ctx.prompt_jp || ctx.prompt_en || '') : (ctx.prompt_en || '');
    setConversations(getConversations().map((c) => c.id === conv.id ? conv : c));
    // Navigate to Ask Taigan.
    document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'ask-taigan' } }));
  }

  window.TB.askTaigan = {
    buildStateDigest,
    buildSuggestedQuestions,
    sendMessage,
    newConversation,
    openWithContext,
  };
})();
