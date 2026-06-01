/* Taigan Bridge — modules/settings.js (v0.2.3)
 *
 * Settings panel:
 *   - AI & API key (key entry + model picker with pricing)
 *   - Token usage monitoring (today's tokens + cost + daily limit)
 *   - API credit balance (remaining + reconcile + progress bar)
 *   - Log a top-up (form + history table)
 *   - Language toggle
 *   - Backup / restore
 *   - Delete all data (danger zone)
 *
 * All AI usage data lives under settings.usage and is populated by
 * TB.ai.recordUsage() from every API call. Credits / top-ups live
 * under settings.credits.
 */

(function () {
  'use strict';

  const id = 'settings';

  function render(container) {
    container.innerHTML = '';
    container.appendChild(buildAiAndApiKeyCard());
    container.appendChild(buildAiConsentCard());
    container.appendChild(buildUsageDashboardCard());
    container.appendChild(buildFxRatesCard());
    container.appendChild(buildAccessibilityCard());
    container.appendChild(buildLanguageCard());
    container.appendChild(buildUpdateCheckCard());
    container.appendChild(buildBackupCard());
    container.appendChild(buildDemoDataCard());
    container.appendChild(buildDangerCard());
  }

  // Demo / sample-data card — load a complete fictional household
  // to evaluate the tool without committing real data, or exit demo
  // mode and wipe back to a clean slate. Both actions are
  // confirmation-gated (see TB.sampleData.loadInteractive / exit).
  function buildDemoDataCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', null, '🧪 ' + t('settings.demo.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('settings.demo.intro')));
    const active = TB.sampleData && TB.sampleData.isDemoActive();
    const row = el('div', { class: 'tb-btn-row' });
    if (active) {
      row.appendChild(el('div', {
        style: {
          padding: '6px 14px',
          background: 'rgba(185, 122, 26, 0.12)',
          color: 'var(--tb-warn, #B97A1A)',
          borderRadius: 'var(--tb-radius-pill, 999px)',
          fontSize: 'var(--tb-fs-12)',
          fontWeight: '600',
        },
      }, '🧪 ' + t('settings.demo.activeBadge')));
      row.appendChild(el('button', {
        class: 'tb-btn tb-btn--danger', type: 'button',
        onclick: () => { if (TB.sampleData) TB.sampleData.exit(); },
      }, t('settings.demo.exitBtn')));
    } else {
      row.appendChild(el('button', {
        class: 'tb-btn', type: 'button',
        onclick: () => { if (TB.sampleData) TB.sampleData.loadInteractive(); },
        title: t('settings.demo.loadTooltip'),
      }, '🧪 ' + t('settings.demo.loadBtn')));
    }
    card.appendChild(row);
    card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
      t('settings.demo.help')));
    return card;
  }

  function rerender() {
    const view = document.getElementById('tb-view');
    if (view) render(view);
  }

  // ====================================================================
  // AI & API KEY (API key + model + usage + credits + topups)
  // ====================================================================

  function buildAiAndApiKeyCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });

    card.appendChild(sectionHeading('🔑', t('settings.ai.title')));
    card.appendChild(buildApiKeyBlock());
    card.appendChild(buildModelBlock());
    card.appendChild(divider());
    card.appendChild(subHeading(t('settings.ai.usage.title')));
    card.appendChild(buildUsageBlock());
    card.appendChild(divider());
    card.appendChild(subHeading('💳 ' + t('settings.ai.credits.title'), {
      right: el('a', {
        href: 'https://console.anthropic.com/settings/billing',
        target: '_blank',
        rel: 'noopener',
        class: 'tb-card-meta',
        style: { textDecoration: 'none' },
      }, '🧾 ' + t('settings.ai.credits.buyLink') + ' →'),
    }));
    card.appendChild(buildCreditsBlock());
    card.appendChild(buildTopupFormBlock());
    card.appendChild(buildTopupHistoryBlock());

    return card;
  }

  // ====================================================================
  // AI USAGE DASHBOARD (cost chart, per-feature + per-model breakdowns,
  //                    monthly aggregates, CSV export)
  // ====================================================================

  function buildUsageDashboardCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(sectionHeading('📊', t('settings.dashboard.title')));
    card.appendChild(el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('settings.dashboard.help'),
    ));

    const usage = TB.ai.getUsage ? TB.ai.getUsage() : (TB.state.get('settings.usage') || { daily: {}, all_time: {} });
    const daily = usage.daily || {};
    const dayKeys = Object.keys(daily).sort(); // ascending

    if (dayKeys.length === 0) {
      card.appendChild(el('div', {
        style: {
          padding: 'var(--tb-sp-4)', textAlign: 'center',
          background: 'var(--tb-bg)', border: '1px dashed var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)', color: 'var(--tb-text-soft)',
        },
      }, '📭 ' + t('settings.dashboard.empty')));
      return card;
    }

    card.appendChild(buildSummaryStrip(usage));
    card.appendChild(divider());
    card.appendChild(subHeading(t('settings.dashboard.chart.title')));
    card.appendChild(buildCostChart(daily, 30));
    card.appendChild(divider());
    card.appendChild(subHeading(t('settings.dashboard.byFeature.title')));
    card.appendChild(buildFeatureBreakdown(usage, daily));
    card.appendChild(divider());
    card.appendChild(subHeading(t('settings.dashboard.byModel.title')));
    card.appendChild(buildModelBreakdown(usage));
    card.appendChild(divider());
    card.appendChild(subHeading(t('settings.dashboard.monthly.title')));
    card.appendChild(buildMonthlyAggregates(daily));
    card.appendChild(divider());
    card.appendChild(buildExportRow(daily));

    return card;
  }

  // ----- Summary strip (this-month-to-date, last 30d, lifetime) ----

  function buildSummaryStrip(usage) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const all = usage.all_time || { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
    const daily = usage.daily || {};

    const today = new Date();
    const monthKey = today.toISOString().slice(0, 7);
    let mtdCost = 0, mtdCalls = 0;
    let last30Cost = 0, last30Calls = 0;
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 29); // last 30 days incl. today
    const cutoffKey = cutoff.toISOString().slice(0, 10);

    for (const [day, info] of Object.entries(daily)) {
      if (day.startsWith(monthKey)) {
        mtdCost += Number(info.cost_usd) || 0;
        mtdCalls += Number(info.calls) || 0;
      }
      if (day >= cutoffKey) {
        last30Cost += Number(info.cost_usd) || 0;
        last30Calls += Number(info.calls) || 0;
      }
    }

    const totalCalls = Number(all.calls) || 0;
    const totalCost = Number(all.cost_usd) || 0;
    const avgPerCall = totalCalls > 0 ? totalCost / totalCalls : 0;

    function statBlock(value, label, sub) {
      return el('div', {
        style: {
          flex: '1 1 160px', padding: 'var(--tb-sp-3) var(--tb-sp-4)',
          background: 'var(--tb-bg)', border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
        },
      },
        el('div', {
          style: {
            fontSize: 'var(--tb-fs-22)', fontWeight: 700,
            fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-success)',
          },
        }, value),
        el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } }, label),
        sub ? el('div', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } }, sub) : null,
      );
    }

    return el('div', {
      style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap' },
    },
      statBlock('$' + mtdCost.toFixed(4), t('settings.dashboard.summary.mtd'),
        t('settings.dashboard.summary.calls', { n: mtdCalls })),
      statBlock('$' + last30Cost.toFixed(4), t('settings.dashboard.summary.last30'),
        t('settings.dashboard.summary.calls', { n: last30Calls })),
      statBlock('$' + totalCost.toFixed(2), t('settings.dashboard.summary.lifetime'),
        t('settings.dashboard.summary.calls', { n: totalCalls })),
      statBlock('$' + avgPerCall.toFixed(4), t('settings.dashboard.summary.avgPerCall'),
        t('settings.dashboard.summary.avgHelp')),
    );
  }

  // ----- 30-day SVG cost chart -----------------------------------

  function buildCostChart(daily, daysBack) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const days = [];
    const today = new Date();
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const info = daily[key] || { cost_usd: 0, calls: 0 };
      days.push({ key, cost: Number(info.cost_usd) || 0, calls: Number(info.calls) || 0 });
    }
    const maxCost = Math.max.apply(null, days.map(d => d.cost).concat(0));
    const totalCost = days.reduce((s, d) => s + d.cost, 0);
    const totalCalls = days.reduce((s, d) => s + d.calls, 0);

    const W = 720, H = 220, PAD_L = 56, PAD_R = 12, PAD_T = 16, PAD_B = 28;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;
    const barGap = 2;
    const barW = Math.max(1, (innerW - barGap * (days.length - 1)) / days.length);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('settings.dashboard.chart.aria', { days: daysBack }));
    svg.style.maxHeight = '260px';
    svg.style.background = 'var(--tb-bg)';
    svg.style.border = '1px solid var(--tb-border)';
    svg.style.borderRadius = 'var(--tb-radius-2)';

    // Y-axis gridlines + labels (4 lines)
    const niceMax = niceCeiling(maxCost) || 0.01;
    for (let i = 0; i <= 4; i++) {
      const y = PAD_T + innerH - (i / 4) * innerH;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', PAD_L); line.setAttribute('x2', W - PAD_R);
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('stroke', 'var(--tb-border)');
      line.setAttribute('stroke-dasharray', i === 0 ? '0' : '2 3');
      svg.appendChild(line);
      const lbl = document.createElementNS(svgNS, 'text');
      lbl.setAttribute('x', PAD_L - 6); lbl.setAttribute('y', y + 4);
      lbl.setAttribute('text-anchor', 'end');
      lbl.setAttribute('font-size', '11');
      lbl.setAttribute('fill', 'var(--tb-text-soft)');
      lbl.setAttribute('font-family', 'var(--tb-font-mono)');
      lbl.textContent = '$' + ((niceMax * i) / 4).toFixed(niceMax < 0.1 ? 4 : (niceMax < 1 ? 3 : 2));
      svg.appendChild(lbl);
    }

    // Bars
    days.forEach((d, idx) => {
      const x = PAD_L + idx * (barW + barGap);
      const h = niceMax > 0 ? (d.cost / niceMax) * innerH : 0;
      const y = PAD_T + innerH - h;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', barW); rect.setAttribute('height', Math.max(0, h));
      rect.setAttribute('fill', d.cost > 0 ? 'var(--tb-success)' : 'var(--tb-border)');
      rect.setAttribute('rx', '1');
      const tip = document.createElementNS(svgNS, 'title');
      tip.textContent = d.key + ' · $' + d.cost.toFixed(4) + ' · ' + d.calls + ' call' + (d.calls === 1 ? '' : 's');
      rect.appendChild(tip);
      svg.appendChild(rect);
    });

    // X-axis labels (every ~7 days)
    const stride = Math.max(1, Math.floor(days.length / 5));
    days.forEach((d, idx) => {
      if (idx % stride !== 0 && idx !== days.length - 1) return;
      const x = PAD_L + idx * (barW + barGap) + barW / 2;
      const lbl = document.createElementNS(svgNS, 'text');
      lbl.setAttribute('x', x); lbl.setAttribute('y', H - 8);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('font-size', '10');
      lbl.setAttribute('fill', 'var(--tb-text-soft)');
      lbl.textContent = d.key.slice(5); // MM-DD
      svg.appendChild(lbl);
    });

    const wrap = el('div', null);
    wrap.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--tb-sp-2)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('div', { class: 'tb-card-meta' },
        t('settings.dashboard.chart.window', { n: daysBack }),
      ),
      el('div', { class: 'tb-card-meta' },
        t('settings.dashboard.chart.totals', {
          cost: '$' + totalCost.toFixed(4),
          calls: totalCalls,
        }),
      ),
    ));
    wrap.appendChild(svg);
    return wrap;
  }

  function niceCeiling(v) {
    if (!isFinite(v) || v <= 0) return 0.01;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const fr = v / base;
    let nice;
    if (fr <= 1) nice = 1;
    else if (fr <= 2) nice = 2;
    else if (fr <= 5) nice = 5;
    else nice = 10;
    return nice * base;
  }

  // ----- Per-feature breakdown table (lifetime + last-30d sparkline) ----

  function buildFeatureBreakdown(usage, daily) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const ids = (TB.ai && TB.ai.FEATURE_IDS) || ['chat'];
    const allTimeByFeature = (usage.all_time && usage.all_time.by_feature) || {};

    // Build last-30-day series per feature for the sparkline
    const today = new Date();
    const last30Keys = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      last30Keys.push(d.toISOString().slice(0, 10));
    }

    const rows = ids.map((fid) => {
      const total = allTimeByFeature[fid] || { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
      const series = last30Keys.map(k => {
        const day = daily[k];
        const f = day && day.by_feature && day.by_feature[fid];
        return f ? (Number(f.cost_usd) || 0) : 0;
      });
      return { fid, total, series, last30Cost: series.reduce((s, v) => s + v, 0) };
    }).filter(r => r.total.calls > 0 || r.last30Cost > 0);

    if (rows.length === 0) {
      return el('div', { class: 'tb-card-meta' }, t('settings.dashboard.byFeature.empty'));
    }

    rows.sort((a, b) => (b.total.cost_usd || 0) - (a.total.cost_usd || 0));
    const grandCost = rows.reduce((s, r) => s + (r.total.cost_usd || 0), 0) || 1;

    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        th(t('settings.dashboard.col.feature')),
        th(t('settings.dashboard.col.calls'), 'right'),
        th(t('settings.dashboard.col.tokens'), 'right'),
        th(t('settings.dashboard.col.last30'), 'right'),
        th(t('settings.dashboard.col.lifetime'), 'right'),
        th(t('settings.dashboard.col.share'), 'right'),
        th(t('settings.dashboard.col.trend'), 'left'),
      ),
    ));
    const tbody = el('tbody');
    for (const r of rows) {
      const share = (r.total.cost_usd || 0) / grandCost;
      tbody.appendChild(el('tr', null,
        td(featureLabel(r.fid)),
        td(formatNum(r.total.calls), 'right'),
        td(formatTokens((r.total.input_tokens || 0) + (r.total.output_tokens || 0)), 'right'),
        td('$' + r.last30Cost.toFixed(4), 'right'),
        td('$' + (r.total.cost_usd || 0).toFixed(4), 'right'),
        td(shareCell(share), 'right'),
        td(sparkline(r.series), 'left'),
      ));
    }
    table.appendChild(tbody);
    return table;
  }

  function featureLabel(fid) {
    const t = TB.i18n.t;
    const key = 'settings.dashboard.feature.' + fid;
    const v = t(key);
    return v === key ? fid : v;
  }

  function shareCell(share) {
    const el = TB.utils.el;
    const pct = (share * 100).toFixed(1) + '%';
    return el('div', {
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)',
      },
    },
      el('div', {
        style: {
          width: '60px', height: '6px', background: 'var(--tb-border)',
          borderRadius: '3px', overflow: 'hidden',
        },
      },
        el('div', {
          style: {
            width: (share * 100).toFixed(1) + '%', height: '100%',
            background: 'var(--tb-success)',
          },
        }),
      ),
      el('span', null, pct),
    );
  }

  function sparkline(series) {
    const W = 120, H = 28;
    const max = Math.max.apply(null, series.concat(0));
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('preserveAspectRatio', 'none');
    if (series.length === 0 || max === 0) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', 0); line.setAttribute('x2', W);
      line.setAttribute('y1', H - 1); line.setAttribute('y2', H - 1);
      line.setAttribute('stroke', 'var(--tb-border)');
      svg.appendChild(line);
      return svg;
    }
    const stepX = W / (series.length - 1 || 1);
    const points = series.map((v, i) => {
      const x = i * stepX;
      const y = H - 2 - (v / max) * (H - 4);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const poly = document.createElementNS(svgNS, 'polyline');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'var(--tb-success)');
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);
    return svg;
  }

  // ----- Per-model breakdown table -------------------------------

  function buildModelBreakdown(usage) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const allTimeByModel = (usage.all_time && usage.all_time.by_model) || {};
    const ids = Object.keys(allTimeByModel);
    if (ids.length === 0) {
      return el('div', { class: 'tb-card-meta' }, t('settings.dashboard.byModel.empty'));
    }
    const rows = ids.map(mid => ({
      mid,
      total: allTimeByModel[mid],
      info: TB.ai.findModel ? TB.ai.findModel(mid) : null,
    }));
    rows.sort((a, b) => (b.total.cost_usd || 0) - (a.total.cost_usd || 0));
    const grand = rows.reduce((s, r) => s + (r.total.cost_usd || 0), 0) || 1;

    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        th(t('settings.dashboard.col.model')),
        th(t('settings.dashboard.col.pricing'), 'right'),
        th(t('settings.dashboard.col.calls'), 'right'),
        th(t('settings.dashboard.col.inTokens'), 'right'),
        th(t('settings.dashboard.col.outTokens'), 'right'),
        th(t('settings.dashboard.col.lifetime'), 'right'),
        th(t('settings.dashboard.col.share'), 'right'),
      ),
    ));
    const tbody = el('tbody');
    for (const r of rows) {
      const label = r.info
        ? (TB.i18n.getLang() === 'ja' && r.info.label_jp ? r.info.label_jp : r.info.label_en)
        : r.mid;
      const priceLbl = r.info && TB.ai.modelPriceLabel ? TB.ai.modelPriceLabel(r.info) : '—';
      const share = (r.total.cost_usd || 0) / grand;
      tbody.appendChild(el('tr', null,
        td(el('div', null,
          el('div', { style: { fontWeight: 500 } }, label),
          el('div', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', fontSize: '11px' } }, r.mid),
        )),
        td(el('span', { style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' } }, priceLbl), 'right'),
        td(formatNum(r.total.calls), 'right'),
        td(formatTokens(r.total.input_tokens || 0), 'right'),
        td(formatTokens(r.total.output_tokens || 0), 'right'),
        td('$' + (r.total.cost_usd || 0).toFixed(4), 'right'),
        td(shareCell(share), 'right'),
      ));
    }
    table.appendChild(tbody);
    return table;
  }

  // ----- Monthly aggregates table --------------------------------

  function buildMonthlyAggregates(daily) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const months = {};
    for (const [day, info] of Object.entries(daily)) {
      const m = day.slice(0, 7);
      if (!months[m]) months[m] = { cost: 0, calls: 0, inT: 0, outT: 0 };
      months[m].cost += Number(info.cost_usd) || 0;
      months[m].calls += Number(info.calls) || 0;
      months[m].inT += Number(info.input_tokens) || 0;
      months[m].outT += Number(info.output_tokens) || 0;
    }
    const keys = Object.keys(months).sort().reverse();
    if (keys.length === 0) {
      return el('div', { class: 'tb-card-meta' }, t('settings.dashboard.monthly.empty'));
    }

    const maxCost = Math.max.apply(null, keys.map(k => months[k].cost));
    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        th(t('settings.dashboard.col.month')),
        th(t('settings.dashboard.col.calls'), 'right'),
        th(t('settings.dashboard.col.inTokens'), 'right'),
        th(t('settings.dashboard.col.outTokens'), 'right'),
        th(t('settings.dashboard.col.cost'), 'right'),
        th('', 'left'),
      ),
    ));
    const tbody = el('tbody');
    for (const k of keys.slice(0, 12)) {
      const m = months[k];
      const frac = maxCost > 0 ? m.cost / maxCost : 0;
      tbody.appendChild(el('tr', null,
        td(el('strong', null, k)),
        td(formatNum(m.calls), 'right'),
        td(formatTokens(m.inT), 'right'),
        td(formatTokens(m.outT), 'right'),
        td('$' + m.cost.toFixed(4), 'right'),
        td(el('div', {
          style: {
            width: '120px', height: '8px', background: 'var(--tb-border)',
            borderRadius: '4px', overflow: 'hidden',
          },
        },
          el('div', {
            style: {
              width: (frac * 100).toFixed(1) + '%', height: '100%',
              background: 'var(--tb-success)',
            },
          }),
        ), 'left'),
      ));
    }
    table.appendChild(tbody);
    return table;
  }

  // ----- CSV export row ------------------------------------------

  function buildExportRow(daily) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap' } },
      el('button', {
        class: 'tb-btn',
        onclick: () => {
          const csv = buildUsageCsv(daily, /*byFeature*/ false);
          TB.utils.downloadFile('taigan-bridge-ai-usage-' + TB.utils.isoDate(new Date()) + '.csv', csv, 'text/csv');
        },
      }, '⤓ ' + t('settings.dashboard.export.csv')),
      el('button', {
        class: 'tb-btn tb-btn--secondary',
        onclick: () => {
          const csv = buildUsageCsv(daily, /*byFeature*/ true);
          TB.utils.downloadFile('taigan-bridge-ai-usage-by-feature-' + TB.utils.isoDate(new Date()) + '.csv', csv, 'text/csv');
        },
      }, '⤓ ' + t('settings.dashboard.export.csvByFeature')),
      el('span', { class: 'tb-card-meta' }, t('settings.dashboard.export.help')),
    );
  }

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildUsageCsv(daily, byFeature) {
    const rows = [];
    const days = Object.keys(daily).sort();
    if (byFeature) {
      rows.push(['date', 'feature', 'calls', 'input_tokens', 'output_tokens', 'cost_usd'].join(','));
      for (const d of days) {
        const info = daily[d] || {};
        const bf = info.by_feature || {};
        const fids = Object.keys(bf);
        if (fids.length === 0) {
          rows.push([d, 'unattributed', info.calls || 0, info.input_tokens || 0, info.output_tokens || 0,
            (Number(info.cost_usd) || 0).toFixed(6)].map(csvEscape).join(','));
          continue;
        }
        for (const fid of fids) {
          const f = bf[fid];
          rows.push([d, fid, f.calls || 0, f.input_tokens || 0, f.output_tokens || 0,
            (Number(f.cost_usd) || 0).toFixed(6)].map(csvEscape).join(','));
        }
      }
    } else {
      rows.push(['date', 'calls', 'input_tokens', 'output_tokens', 'cost_usd'].join(','));
      for (const d of days) {
        const info = daily[d] || {};
        rows.push([d, info.calls || 0, info.input_tokens || 0, info.output_tokens || 0,
          (Number(info.cost_usd) || 0).toFixed(6)].map(csvEscape).join(','));
      }
    }
    return rows.join('\n') + '\n';
  }

  // ====================================================================
  // AI CONSENT (posture + per-feature overrides)
  // ====================================================================
  //
  // Surfaces the current consent posture from settings.ai_consent and
  // lets users:
  //   • Change posture (full / per_call / vision_only / off)
  //   • Set per-feature overrides (allow / inherit / deny) for the
  //     9 features defined by TB.ai.FEATURE_IDS
  //   • See which features are vision (allowed under vision_only) vs
  //     chat (blocked under vision_only)
  //
  // The posture picker mirrors the onboarding question; the override
  // grid is the more powerful tool — lets a "vision_only" user
  // permanently allow asset_enrichment, for instance.

  function buildAiConsentCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const posture = (TB.ai && TB.ai.getConsentPosture) ? TB.ai.getConsentPosture() : 'full';
    const overrides = (TB.ai && TB.ai.getConsentOverrides) ? TB.ai.getConsentOverrides() : {};
    const featureIds = (TB.ai && TB.ai.FEATURE_IDS) || [];
    const visionFeatures = (TB.ai && TB.ai.VISION_FEATURES) || [];

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(sectionHeading('🔒', t('settings.consent.title')));

    // Effect summary banner — colored to match the posture severity.
    const postureColor = {
      full:        'var(--tb-success)',
      per_call:    'var(--tb-track-tax)',
      vision_only: 'var(--tb-warn)',
      off:         'var(--tb-error)',
    }[posture] || 'var(--tb-success)';
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-3)',
        borderLeft: '4px solid ' + postureColor,
        background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
        t('settings.consent.banner.' + posture + '.title')),
      el('div', { class: 'tb-card-meta' },
        t('settings.consent.banner.' + posture + '.body')),
    ));

    // Posture picker — radio group
    card.appendChild(subHeading(t('settings.consent.posture.title')));
    const radioGroup = el('div', { class: 'tb-radio-group', style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)' } });
    ['full', 'per_call', 'vision_only', 'off'].forEach((p) => {
      const isSelected = posture === p;
      radioGroup.appendChild(el('label', {
        class: 'tb-radio' + (isSelected ? ' is-selected' : ''),
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)' },
      },
        el('input', {
          type: 'radio',
          name: 'tb-consent-posture',
          value: p,
          checked: isSelected,
          onchange: () => {
            if (TB.ai && TB.ai.setConsentPosture) TB.ai.setConsentPosture(p);
            rerender();
          },
        }),
        el('div', null,
          el('div', { style: { fontWeight: '500' } }, t('settings.consent.opt.' + p + '.title')),
          el('small', null, t('settings.consent.opt.' + p + '.help')),
        ),
      ));
    });
    card.appendChild(radioGroup);

    // Per-feature override grid
    card.appendChild(divider());
    card.appendChild(subHeading(t('settings.consent.overrides.title')));
    card.appendChild(el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('settings.consent.overrides.intro')));

    const grid = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' } });
    const thead = el('thead', null,
      el('tr', null,
        th(t('settings.consent.col.feature')),
        th(t('settings.consent.col.type'), 'left'),
        th(t('settings.consent.col.override'), 'right'),
      ),
    );
    grid.appendChild(thead);
    const tbody = el('tbody');
    // Skip 'other' and 'health_check' (not meaningful to override).
    featureIds.filter(f => f !== 'other' && f !== 'health_check').forEach((fid) => {
      const isVision = visionFeatures.indexOf(fid) !== -1;
      const ov = overrides[fid] || null;
      const select = el('select', {
        class: 'tb-select',
        style: { maxWidth: '160px' },
        onchange: (e) => {
          const v = e.target.value || null;
          if (TB.ai && TB.ai.setConsentOverride) TB.ai.setConsentOverride(fid, v);
          rerender();
        },
      },
        el('option', { value: '', selected: ov == null }, t('settings.consent.override.inherit')),
        el('option', { value: 'allow', selected: ov === 'allow' }, t('settings.consent.override.allow')),
        el('option', { value: 'deny',  selected: ov === 'deny' }, t('settings.consent.override.deny')),
      );
      tbody.appendChild(el('tr', null,
        td(t('settings.dashboard.feature.' + fid)),
        td(el('span', {
          style: {
            fontSize: '10px', padding: '1px 6px',
            borderRadius: 'var(--tb-radius-pill)',
            background: isVision ? 'rgba(46, 107, 92, 0.12)' : 'rgba(74, 107, 138, 0.12)',
            color: isVision ? 'var(--tb-track-ai)' : 'var(--tb-track-tax)',
            textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '600',
          },
        }, isVision ? t('settings.consent.type.vision') : t('settings.consent.type.chat')), 'left'),
        td(select, 'right'),
      ));
    });
    grid.appendChild(tbody);
    card.appendChild(grid);

    return card;
  }

  // ====================================================================
  // ACCESSIBILITY (font scaling + high contrast + reduced motion)
  // ====================================================================

  function buildAccessibilityCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const a11y = TB.state.get('settings.a11y') || {};
    const fontScale = Number(a11y.fontScale) || 1;
    const highContrast = !!a11y.highContrast;
    const reducedMotion = !!a11y.reducedMotion;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(sectionHeading('♿', t('settings.a11y.title')));
    card.appendChild(el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('settings.a11y.help'),
    ));

    // Font size scaler
    const FONT_STEPS = [
      { v: 0.875, label: 'A' },
      { v: 1.000, label: 'A' },
      { v: 1.125, label: 'A' },
      { v: 1.250, label: 'A' },
      { v: 1.375, label: 'A' },
    ];
    const fontRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap', marginBottom: 'var(--tb-sp-3)' } });
    fontRow.appendChild(el('label', { class: 'tb-field-label', style: { margin: 0 } }, t('settings.a11y.fontScale')));
    const fontGroup = el('div', { class: 'tb-radio-group', style: { display: 'flex', gap: 'var(--tb-sp-1)' } });
    for (const step of FONT_STEPS) {
      const selected = Math.abs(fontScale - step.v) < 0.01;
      fontGroup.appendChild(el('label', {
        class: 'tb-radio' + (selected ? ' is-selected' : ''),
        style: { padding: '4px 10px', fontSize: (16 * step.v) + 'px', lineHeight: 1, cursor: 'pointer' },
        onclick: () => {
          setA11y({ fontScale: step.v });
          rerender();
        },
      }, step.label));
    }
    fontRow.appendChild(fontGroup);
    fontRow.appendChild(el('span', { class: 'tb-card-meta' }, Math.round(fontScale * 100) + '%'));
    card.appendChild(fontRow);

    // High contrast toggle
    card.appendChild(toggleRow(
      t('settings.a11y.highContrast'),
      t('settings.a11y.highContrastHelp'),
      highContrast,
      (next) => { setA11y({ highContrast: next }); rerender(); },
    ));

    // Reduced motion toggle
    card.appendChild(toggleRow(
      t('settings.a11y.reducedMotion'),
      t('settings.a11y.reducedMotionHelp'),
      reducedMotion,
      (next) => { setA11y({ reducedMotion: next }); rerender(); },
    ));

    return card;
  }

  function toggleRow(title, help, checked, onChange) {
    const el = TB.utils.el;
    return el('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 'var(--tb-sp-3)', padding: 'var(--tb-sp-2) 0',
        borderTop: '1px dashed var(--tb-border)',
      },
    },
      el('div', { style: { flex: '1 1 auto' } },
        el('div', { style: { fontWeight: 500 } }, title),
        el('div', { class: 'tb-card-meta' }, help),
      ),
      el('label', {
        class: 'tb-toggle',
        style: { position: 'relative', display: 'inline-block', width: '44px', height: '24px' },
      },
        el('input', {
          type: 'checkbox', checked,
          style: { opacity: 0, width: 0, height: 0 },
          onchange: (e) => onChange(e.target.checked),
        }),
        el('span', {
          style: {
            position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
            background: checked ? 'var(--tb-success)' : 'var(--tb-border)',
            transition: '.2s', borderRadius: '24px',
          },
        }),
        el('span', {
          style: {
            position: 'absolute', height: '18px', width: '18px',
            left: checked ? '23px' : '3px', bottom: '3px',
            background: '#fff', transition: '.2s', borderRadius: '50%',
            pointerEvents: 'none',
          },
        }),
      ),
    );
  }

  function setA11y(patch) {
    const cur = TB.state.get('settings.a11y') || {};
    const next = Object.assign({}, cur, patch);
    TB.state.set('settings.a11y', next);
    applyA11y(next);
  }

  function applyA11y(a11y) {
    const root = document.documentElement;
    const scale = Number(a11y && a11y.fontScale) || 1;
    root.style.setProperty('--tb-fs-scale', String(scale));
    root.style.fontSize = (16 * scale) + 'px';
    if (a11y && a11y.highContrast) {
      root.setAttribute('data-tb-contrast', 'high');
    } else {
      root.removeAttribute('data-tb-contrast');
    }
    if (a11y && a11y.reducedMotion) {
      root.setAttribute('data-tb-motion', 'reduced');
    } else {
      root.removeAttribute('data-tb-motion');
    }
  }

  // Apply on first load (settings.js runs after state is hydrated).
  try { applyA11y(TB.state.get('settings.a11y') || {}); } catch (_) {}

  function sectionHeading(icon, text) {
    const el = TB.utils.el;
    return el('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)',
        background: 'rgba(14, 42, 79, 0.06)',
        margin: 'calc(-1 * var(--tb-sp-5)) calc(-1 * var(--tb-sp-5)) var(--tb-sp-4)',
        padding: 'var(--tb-sp-3) var(--tb-sp-5)',
        borderTopLeftRadius: 'var(--tb-radius-3)',
        borderTopRightRadius: 'var(--tb-radius-3)',
        fontWeight: 600, fontSize: 'var(--tb-fs-14)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--tb-text)',
      },
    }, icon + ' ' + text);
  }

  function subHeading(text, opts) {
    const el = TB.utils.el;
    const right = opts && opts.right ? opts.right : null;
    return el('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginTop: 'var(--tb-sp-4)', marginBottom: 'var(--tb-sp-2)',
        fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        fontWeight: 600,
      },
    }, el('span', null, text), right);
  }

  function divider() {
    const el = TB.utils.el;
    return el('hr', {
      style: {
        border: 0, borderTop: '1px dashed var(--tb-border)',
        margin: 'var(--tb-sp-4) 0',
      },
    });
  }

  // ----- API key block -------------------------------------------

  function buildApiKeyBlock() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const current = TB.state.get('settings.apiKey') || '';
    const isSet = TB.ai.hasKey();
    const masked = current ? current.slice(0, 12) + '…' + current.slice(-4) : '';

    const input = el('input', {
      type: 'password',
      class: 'tb-input',
      placeholder: 'sk-ant-api03-…',
      value: current,
      autocomplete: 'off',
      spellcheck: 'false',
      style: { flex: '1 1 auto' },
    });

    const intro = el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('settings.api.intro.before'),
      el('a', {
        href: 'https://console.anthropic.com/settings/keys',
        target: '_blank',
        rel: 'noopener',
        style: { color: 'var(--tb-navy)' },
      }, t('settings.api.intro.linkLabel')),
      ' ' + t('settings.api.intro.after'),
    );

    const healthStatus = el('div', {
      class: 'tb-card-meta',
      style: { marginTop: 'var(--tb-sp-2)', minHeight: '1.4em' },
    });
    const lastHealth = TB.state.get('settings.api.lastHealthCheck') || null;
    if (lastHealth) {
      renderHealth(healthStatus, lastHealth);
    }

    const healthBtn = el('button', {
      class: 'tb-btn tb-btn--secondary',
      title: t('settings.api.health.title'),
      style: { fontSize: 'var(--tb-fs-12)' },
      onclick: async () => {
        if (!TB.ai.hasKey()) {
          healthStatus.textContent = '⚠ ' + t('settings.api.health.noKey');
          healthStatus.style.color = 'var(--tb-warn)';
          return;
        }
        healthBtn.disabled = true;
        const old = healthBtn.textContent;
        healthBtn.textContent = '⏳ ' + t('settings.api.health.testing');
        healthStatus.textContent = '';
        try {
          const result = await TB.ai.pingApiKey();
          const stamped = Object.assign({}, result, { at: new Date().toISOString() });
          TB.state.set('settings.api.lastHealthCheck', stamped);
          renderHealth(healthStatus, stamped);
        } catch (err) {
          renderHealth(healthStatus, {
            ok: false, error: 'unexpected',
            message: (err && err.message) || String(err),
            at: new Date().toISOString(),
          });
        } finally {
          healthBtn.disabled = false;
          healthBtn.textContent = old;
        }
      },
    }, '🩺 ' + t('settings.api.health.test'));

    // Rotation reminder — Anthropic recommends rotating keys periodically.
    const keySetAt = TB.state.get('settings.api.keySetAt');
    let rotationNote = null;
    if (isSet && keySetAt) {
      const ageMs = Date.now() - new Date(keySetAt).getTime();
      const ageDays = Math.floor(ageMs / (24 * 3600 * 1000));
      if (ageDays >= 180) {
        rotationNote = el('div', {
          class: 'tb-card-meta',
          style: { color: 'var(--tb-warn)', marginTop: 'var(--tb-sp-2)' },
        }, '🔄 ' + t('settings.api.rotation.due', { days: ageDays }));
      }
    }

    return el('div', null,
      intro,
      el('div', {
        style: { display: 'flex', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-2)', flexWrap: 'wrap' },
      },
        input,
        el('button', {
          class: 'tb-btn',
          style: { background: 'var(--tb-accent)', borderColor: 'var(--tb-accent)' },
          onclick: () => {
            const newKey = input.value.trim();
            const oldKey = TB.state.get('settings.apiKey') || '';
            TB.state.set('settings.apiKey', newKey);
            // Track when the key was set so the rotation prompt can fire.
            if (newKey && newKey !== oldKey) {
              TB.state.set('settings.api.keySetAt', new Date().toISOString());
              TB.state.set('settings.api.lastHealthCheck', null);
            }
            rerender();
          },
        }, t('settings.api.save')),
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          title: t('settings.api.clear'),
          onclick: () => {
            if (!confirm(t('settings.api.clear.confirm'))) return;
            TB.state.set('settings.apiKey', '');
            TB.state.set('settings.api.keySetAt', null);
            TB.state.set('settings.api.lastHealthCheck', null);
            rerender();
          },
        }, '🗝️'),
        healthBtn,
      ),
      el('div', { class: 'tb-card-meta' },
        isSet
          ? '🔑 ' + t('settings.api.status.set', { masked })
          : '⚠ ' + t('settings.api.status.unset'),
      ),
      healthStatus,
      rotationNote,
    );
  }

  function renderHealth(node, result) {
    node.innerHTML = '';
    const t = TB.i18n.t;
    const el = TB.utils.el;
    const stamp = result.at ? ' · ' + String(result.at).replace('T', ' ').slice(0, 19) : '';
    if (result.ok) {
      node.style.color = 'var(--tb-success)';
      node.appendChild(el('span', null,
        '✓ ' + t('settings.api.health.ok', {
          model: result.model || '?',
          ms: result.elapsed_ms != null ? result.elapsed_ms : '?',
        }) + stamp,
      ));
    } else {
      node.style.color = 'var(--tb-error)';
      const msgKey = 'settings.api.health.err.' + (result.error || 'unknown');
      let msg = t(msgKey);
      if (msg === msgKey) msg = result.message || result.error || t('settings.api.health.err.unknown');
      node.appendChild(el('span', null, '✗ ' + msg + stamp));
    }
  }

  // ----- Model selector block ------------------------------------

  function buildModelBlock() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const current = TB.ai.getModel();
    const currentInfo = TB.ai.getModelInfo();

    const select = el('select', {
      class: 'tb-select',
      style: { flex: '1 1 auto' },
      onchange: (e) => {
        TB.state.set('settings.model', e.target.value);
        rerender();
      },
    });
    for (const m of TB.ai.MODEL_CATALOG) {
      const label = (lang === 'ja' && m.label_jp) ? m.label_jp : m.label_en;
      select.appendChild(el('option', {
        value: m.id, selected: m.id === current,
      }, label));
    }

    return el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', alignItems: 'center', marginTop: 'var(--tb-sp-3)' } },
      el('label', { class: 'tb-field-label', style: { margin: 0, whiteSpace: 'nowrap' } },
        '🤖 ' + t('settings.ai.model.label'),
      ),
      select,
      el('span', {
        class: 'tb-card-meta',
        style: { whiteSpace: 'nowrap', fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)' },
      }, currentInfo ? TB.ai.modelPriceLabel(currentInfo) : ''),
    );
  }

  // ----- Token usage monitoring block ----------------------------

  function buildUsageBlock() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const today = TB.ai.todayUsage();
    const all = (TB.state.get('settings.usage') || {}).all_time
      || { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

    function statCard(value, label, color) {
      return el('div', {
        style: {
          flex: '1 1 0', textAlign: 'center',
          padding: 'var(--tb-sp-4)',
          background: 'var(--tb-bg)',
          border: '1px solid var(--tb-border)',
          borderRadius: 'var(--tb-radius-2)',
        },
      },
        el('div', {
          style: {
            fontSize: 'var(--tb-fs-22)', fontWeight: 700,
            fontFamily: 'var(--tb-font-mono)',
            color: color || 'var(--tb-text)',
          },
        }, value),
        el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } }, label),
      );
    }

    const limitInput = el('input', {
      type: 'number', step: '0.5', min: '0',
      class: 'tb-input',
      style: { width: '160px', display: 'inline-block' },
      value: TB.ai.dailyLimitUsd() || 0,
      placeholder: '0 = no limit',
      oninput: (e) => {
        TB.ai.setDailyLimitUsd(parseFloat(e.target.value) || 0);
      },
    });

    return el('div', null,
      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap' } },
        statCard(formatNum(today.input_tokens), t('settings.ai.usage.inputToday'), 'var(--tb-accent)'),
        statCard(formatNum(today.output_tokens), t('settings.ai.usage.outputToday'), 'var(--tb-accent)'),
        statCard('$' + (today.cost_usd || 0).toFixed(4), t('settings.ai.usage.costToday'), 'var(--tb-success)'),
      ),
      el('div', {
        style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap' },
      },
        el('label', { class: 'tb-field-label', style: { margin: 0 } },
          t('settings.ai.usage.dailyLimit'),
        ),
        limitInput,
      ),
      el('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
      },
        el('div', { class: 'tb-card-meta' },
          t('settings.ai.usage.allTime', {
            cost: '$' + (all.cost_usd || 0).toFixed(2),
            tokens: formatTokens((all.input_tokens || 0) + (all.output_tokens || 0)),
          }),
        ),
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          style: { fontSize: 'var(--tb-fs-12)' },
          onclick: () => {
            if (!confirm(t('settings.ai.usage.resetConfirm'))) return;
            TB.ai.resetTodayUsage();
            rerender();
          },
        }, '↺ ' + t('settings.ai.usage.resetToday')),
      ),
    );
  }

  // ----- Credit balance block ------------------------------------

  function buildCreditsBlock() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const c = TB.ai.getCredits();
    const bal = TB.ai.computeRemainingBalance();
    const purchased = bal.purchased;
    const remaining = bal.remaining;
    const fraction = purchased > 0 ? Math.min(1, (purchased - remaining) / purchased) : 0;

    const earliestTopup = (c.topups || [])
      .filter(t => TB.ai.isTopupActive(t))
      .map(t => t.date).sort()[0];

    const reconciledNote = c.last_reconciled_at
      ? '✓ ' + t('settings.ai.credits.reconciledOn', {
          date: String(c.last_reconciled_at).slice(0, 10),
        })
      : '';

    return el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', alignItems: 'stretch', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap' } },
      // big balance card
      el('div', {
        style: {
          flex: '0 0 200px',
          background: 'var(--tb-ink)', color: '#fff',
          padding: 'var(--tb-sp-4)',
          borderRadius: 'var(--tb-radius-2)',
          textAlign: 'center',
        },
      },
        el('div', {
          style: { fontSize: 'var(--tb-fs-28)', fontWeight: 700, color: 'var(--tb-success)', fontFamily: 'var(--tb-font-mono)' },
        }, '$' + remaining.toFixed(2)),
        el('div', { style: { fontSize: 'var(--tb-fs-12)', color: '#aab', marginTop: 'var(--tb-sp-1)' } },
          t('settings.ai.credits.remaining'),
        ),
      ),
      // status + progress
      el('div', { style: { flex: '1 1 320px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' } },
        el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)' } },
          t('settings.ai.credits.purchased', { amount: '$' + purchased.toFixed(2) }) + ' · ',
          t('settings.ai.credits.spent', {
            amount: '$' + (bal.anchored ? bal.spent_since_reconcile : bal.spent_total).toFixed(4),
            since: earliestTopup || '—',
          }),
          reconciledNote ? ' · ' + reconciledNote : '',
          ' · ',
          el('a', {
            href: '#',
            style: { color: 'var(--tb-navy)' },
            onclick: (e) => {
              e.preventDefault();
              const v = prompt(t('settings.ai.credits.reconcilePrompt'), remaining.toFixed(2));
              if (v == null) return;
              const n = parseFloat(v);
              if (!isFinite(n) || n < 0) { alert(t('settings.ai.credits.reconcileInvalid')); return; }
              TB.ai.reconcile(n);
              rerender();
            },
          }, '↻ ' + t('settings.ai.credits.reconcile')),
        ),
        el('div', {
          style: {
            height: '12px', background: 'var(--tb-border)',
            borderRadius: 'var(--tb-radius-pill)', overflow: 'hidden',
          },
        },
          el('div', {
            style: {
              width: (fraction * 100).toFixed(1) + '%',
              height: '100%',
              background: fraction > 0.85 ? 'var(--tb-error)' : (fraction > 0.6 ? 'var(--tb-warn)' : 'var(--tb-success)'),
              transition: 'width var(--tb-motion-base) var(--tb-ease)',
            },
          }),
        ),
      ),
    );
  }

  // ----- Top-up form block ---------------------------------------

  function buildTopupFormBlock() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const today = new Date().toISOString().slice(0, 10);

    const purchaseDateInput = el('input', { type: 'date', class: 'tb-input', value: today });
    const amountInput = el('input', { type: 'number', step: '0.01', min: '0', class: 'tb-input', placeholder: t('settings.ai.topup.amountPlaceholder') });
    const typeSelect = el('select', { class: 'tb-select' },
      el('option', { value: 'top_up' }, t('settings.ai.topup.type.topup')),
      el('option', { value: 'credit_grant' }, t('settings.ai.topup.type.grant')),
      el('option', { value: 'refund' }, t('settings.ai.topup.type.refund')),
    );
    const expirationInput = el('input', { type: 'date', class: 'tb-input' });

    return el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { fontSize: 'var(--tb-fs-12)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-3)' } },
        t('settings.ai.topup.title'),
      ),
      el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr)) auto', gap: 'var(--tb-sp-3)', alignItems: 'flex-end' },
      },
        field(t('settings.ai.topup.purchaseDate'), purchaseDateInput),
        field(t('settings.ai.topup.amount'), amountInput),
        field(t('settings.ai.topup.type'), typeSelect),
        field(t('settings.ai.topup.expiration'), expirationInput, t('settings.ai.topup.expirationHint')),
        el('button', {
          class: 'tb-btn',
          style: { whiteSpace: 'nowrap' },
          onclick: () => {
            const amount = parseFloat(amountInput.value);
            if (!isFinite(amount) || amount <= 0) {
              alert(t('settings.ai.topup.invalidAmount'));
              return;
            }
            TB.ai.addTopup({
              date: purchaseDateInput.value || today,
              amount_usd: amount,
              type: typeSelect.value,
              expires: expirationInput.value || null,
              notes: '',
            });
            rerender();
          },
        }, '+ ' + t('settings.ai.topup.add')),
      ),
      el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
        t('settings.ai.topup.help'),
      ),
    );
  }

  // ----- Top-up history table ------------------------------------

  function buildTopupHistoryBlock() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const c = TB.ai.getCredits();
    const topups = c.topups || [];

    const wrap = el('div', { style: { marginTop: 'var(--tb-sp-4)' } });
    wrap.appendChild(el('div', {
      style: { fontSize: 'var(--tb-fs-12)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--tb-text-soft)', marginBottom: 'var(--tb-sp-2)' },
    }, t('settings.ai.topup.historyTitle')));

    if (topups.length === 0) {
      wrap.appendChild(el('div', { class: 'tb-card-meta' }, t('settings.ai.topup.empty')));
      return wrap;
    }

    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        th(t('settings.ai.topup.col.date')),
        th(t('settings.ai.topup.col.type')),
        th(t('settings.ai.topup.col.expires'), 'right'),
        th(t('settings.ai.topup.col.amount'), 'right'),
        th(''),
      ),
    ));
    const tbody = el('tbody');
    for (const tu of topups) {
      const active = TB.ai.isTopupActive(tu);
      tbody.appendChild(el('tr', {
        style: active ? null : { opacity: '0.45' },
      },
        td(tu.date || '—'),
        td(typeLabel(tu.type, t)),
        td(tu.expires || '—', 'right'),
        td('$' + (Number(tu.amount_usd) || 0).toFixed(2), 'right'),
        td(el('button', {
          class: 'tb-btn tb-btn--ghost',
          style: { padding: '2px 8px' },
          onclick: () => {
            if (!confirm(t('settings.ai.topup.removeConfirm'))) return;
            TB.ai.removeTopup(tu.id);
            rerender();
          },
        }, '×'), 'right'),
      ));
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function th(text, align) {
    const el = TB.utils.el;
    return el('th', {
      style: {
        borderBottom: '1px solid var(--tb-border)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        textAlign: align || 'left',
        fontSize: 'var(--tb-fs-12)',
        textTransform: 'uppercase', letterSpacing: '0.04em',
        color: 'var(--tb-text-soft)', fontWeight: 600,
      },
    }, text);
  }

  function td(content, align) {
    const el = TB.utils.el;
    return el('td', {
      style: {
        borderBottom: '1px solid var(--tb-border)',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        textAlign: align || 'left',
        verticalAlign: 'middle',
      },
    }, content);
  }

  function typeLabel(type, t) {
    if (type === 'credit_grant') return t('settings.ai.topup.type.grant');
    if (type === 'refund') return t('settings.ai.topup.type.refund');
    return t('settings.ai.topup.type.topup');
  }

  function field(label, control, help) {
    const el = TB.utils.el;
    return el('label', { class: 'tb-field', style: { marginBottom: 0 } },
      el('span', { class: 'tb-field-label' }, label),
      control,
      help ? el('div', { class: 'tb-field-help' }, help) : null,
    );
  }

  function formatNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString('en-US');
  }

  function formatTokens(n) {
    n = Number(n) || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return Math.round(n / 1_000) + 'K';
    return String(n);
  }

  // ====================================================================
  // Existing sections (Language, Backup, Danger zone)
  // ====================================================================

  // ====================================================================
  // FX RATES (Treasury Reporting Rates of Exchange)
  // ====================================================================

  function buildFxRatesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    if (!TB.fbar || typeof TB.fbar.refreshTreasuryRates !== 'function') {
      // FBAR module not loaded — skip the FX card silently.
      return el('div', { style: { display: 'none' } });
    }

    const fetchedAt = TB.state.get('settings.fx.treasury_fetched_at');
    const stateRates = TB.state.get('settings.fx.treasury_rates') || {};
    const errors = TB.state.get('settings.fx.treasury_fetch_errors') || [];
    const fetchedYears = Object.keys(stateRates).sort();
    const hardcodedYears = Object.keys(TB.fbar.TREASURY_FX || {}).sort();

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(sectionHeading('🌐', t('settings.fx.title')));
    card.appendChild(el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('settings.fx.help'),
    ));

    // Status block
    const status = el('div', {
      style: {
        padding: 'var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { class: 'tb-card-meta' },
        fetchedAt
          ? '✓ ' + t('settings.fx.lastFetched', { when: String(fetchedAt).replace('T', ' ').slice(0, 19) + ' UTC' })
          : '⚠ ' + t('settings.fx.neverFetched'),
      ),
      el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
        '🟢 ' + t('settings.fx.fetchedYears', { years: fetchedYears.length ? fetchedYears.join(', ') : t('settings.fx.none') }),
      ),
      el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
        '🟡 ' + t('settings.fx.hardcodedYears', { years: hardcodedYears.join(', ') }),
      ),
      errors.length
        ? el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-error)' } },
            '✗ ' + t('settings.fx.fetchErrors', { count: errors.length }) + ': ' +
            errors.map(e => e.year).join(', '),
          )
        : null,
    );
    card.appendChild(status);

    // Refresh button
    const refreshBtn = el('button', {
      class: 'tb-btn',
      onclick: async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ ' + t('settings.fx.refreshing');
        try {
          const result = await TB.fbar.refreshTreasuryRates();
          const yearsFetched = Object.keys(result.fetched).length;
          alert(t('settings.fx.refreshSuccess', {
            years: yearsFetched,
            errors: result.errors.length,
          }));
          rerender();
        } catch (err) {
          alert(t('settings.fx.refreshFailed') + ': ' + (err && err.message || err));
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ ' + t('settings.fx.refresh');
        }
      },
    }, '↻ ' + t('settings.fx.refresh'));

    const yearsHelp = el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
      t('settings.fx.refreshScope', { years: TB.fbar.defaultRefreshYears().join(', ') }),
    );

    card.appendChild(el('div', { class: 'tb-btn-row' }, refreshBtn));
    card.appendChild(yearsHelp);

    // Per-year rates table (collapsed by default; click to expand)
    if (fetchedYears.length > 0) {
      card.appendChild(divider());
      card.appendChild(buildFxRatesTable(stateRates, fetchedYears));
    }

    return card;
  }

  function buildFxRatesTable(stateRates, fetchedYears) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const currencies = (TB.fbar && TB.fbar.SUPPORTED_CURRENCIES) || ['JPY', 'EUR', 'GBP', 'CAD', 'AUD'];
    const nonUsd = currencies.filter(c => c !== 'USD');

    const details = el('details', { style: { marginTop: 'var(--tb-sp-2)' } });
    const summary = el('summary', { style: { cursor: 'pointer', color: 'var(--tb-text-soft)', fontSize: 'var(--tb-fs-12)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 'var(--tb-sp-2)' } },
      t('settings.fx.tableToggle'),
    );
    details.appendChild(summary);

    const wrap = el('div', { style: { overflowX: 'auto' } });
    const table = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-3)' } });
    const thead = el('thead', null,
      el('tr', null,
        el('th', { style: tableHeadStyle() }, t('settings.fx.col.year')),
        ...nonUsd.map(c => el('th', { style: tableHeadStyle('right') }, c)),
      ),
    );
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const yr of fetchedYears) {
      const row = el('tr', null,
        el('td', { style: tableCellStyle() }, el('strong', null, yr)),
        ...nonUsd.map(c => {
          const rate = stateRates[yr] && stateRates[yr][c];
          return el('td', {
            style: tableCellStyle('right'),
          }, rate != null ? rate.toFixed(4) : '—');
        }),
      );
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    details.appendChild(wrap);
    return details;
  }

  function tableHeadStyle(align) {
    return {
      borderBottom: '1px solid var(--tb-border)',
      padding: 'var(--tb-sp-2) var(--tb-sp-3)',
      textAlign: align || 'left',
      fontWeight: 600,
      color: 'var(--tb-text-soft)',
      fontSize: 'var(--tb-fs-12)',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    };
  }

  function tableCellStyle(align) {
    return {
      borderBottom: '1px solid var(--tb-border)',
      padding: 'var(--tb-sp-2) var(--tb-sp-3)',
      textAlign: align || 'left',
      fontFamily: 'var(--tb-font-mono)',
    };
  }

  function buildLanguageCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const current = TB.i18n.getLang();
    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', null, t('settings.lang.title')),
      el('div', { class: 'tb-radio-group' },
        ...['en', 'ja'].map((code) => {
          const id = 'tb-lang-' + code;
          const selected = current === code;
          return el('label', {
            class: 'tb-radio' + (selected ? ' is-selected' : ''),
            for: id,
          },
            el('input', {
              type: 'radio', id,
              name: 'tb-lang', value: code, checked: selected,
              onchange: () => {
                TB.i18n.setLang(code);
                rerender();
              },
            }),
            el('div', null, code === 'en' ? 'English' : '日本語'),
          );
        }),
      ),
    );
  }

  // Update-check preferences. Lets the user opt in/out of the daily
  // GitHub release check and trigger a one-shot manual check. See
  // src/scripts/update-check.js for the underlying logic. No-op
  // visually on the hosted demo (the demo is always the latest by
  // definition, so the card would just confuse).
  function buildUpdateCheckCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    // Hide entirely on the hosted preview.
    if (window.TB && TB.hostedDemo && TB.hostedDemo.isHostedDemo && TB.hostedDemo.isHostedDemo()) {
      return el('div', { style: { display: 'none' } });
    }

    const uc = window.TB && TB.updateCheck;
    const state = (uc && uc.getState && uc.getState()) || {};
    const localVersion = (uc && uc._getLocalVersion && uc._getLocalVersion()) ||
                          (document.querySelector('meta[name="tb-version"]')?.content || '');
    const releasesUrl = (uc && uc._RELEASES_URL) ||
                        'https://github.com/beichhorn-taigan/taigan-bridge/releases/latest';
    const enabled = !!state.enabled;
    const hasConsented = state.consented === true || state.consented === false;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h2', null, '⬆ ' + t('updateCheck.settings.title')));
    card.appendChild(el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('updateCheck.settings.help')));

    card.appendChild(el('div', { class: 'tb-field-help', style: { marginBottom: 'var(--tb-sp-3)' } },
      t('updateCheck.settings.currentVersion', { version: localVersion || '?' })));

    // Toggle row — uses the same toggleRow helper as the a11y card.
    card.appendChild(toggleRow(
      t('updateCheck.settings.toggle'),
      t('updateCheck.settings.toggleHelp'),
      enabled,
      (next) => {
        const cur = (TB.state.get('settings.updateCheck')) || {};
        TB.state.set('settings.updateCheck', Object.assign({}, cur, {
          enabled: next,
          // First time the user touches this toggle from Settings,
          // count it as consent — they've clearly understood there
          // is a thing to opt into.
          consented: true,
        }));
        rerender();
      },
    ));

    // Status row: last-checked + last-error (if any).
    const lastChecked = state.lastCheckedAt
      ? new Date(state.lastCheckedAt).toLocaleString()
      : null;
    card.appendChild(el('div', {
      class: 'tb-field-help',
      style: { marginTop: 'var(--tb-sp-3)' },
    }, lastChecked
        ? t('updateCheck.settings.lastChecked', { when: lastChecked })
        : t('updateCheck.settings.lastCheckedNever')));

    // If a newer version is known, surface it inline too. The banner
    // up top is the primary surface, but a Settings line is helpful
    // for users who dismissed it and now want to find the link again.
    if (uc && uc.isNewer && state.lastSeenVersion &&
        uc.isNewer(state.lastSeenVersion, localVersion)) {
      card.appendChild(el('div', {
        class: 'tb-field-help',
        style: {
          marginTop: 'var(--tb-sp-2)',
          color: 'var(--tb-accent, #356390)',
          fontWeight: 600,
        },
      }, t('updateCheck.settings.newer', { version: state.lastSeenVersion })));
    } else if (state.lastCheckedAt && localVersion) {
      // We've checked at least once and we're not behind.
      card.appendChild(el('div', {
        class: 'tb-field-help',
        style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-text-soft)' },
      }, t('updateCheck.settings.upToDate', { version: localVersion })));
    }

    if (state.lastError) {
      card.appendChild(el('div', {
        class: 'tb-field-help',
        style: {
          marginTop: 'var(--tb-sp-2)',
          color: 'var(--tb-warn, #B97A1A)',
        },
      }, t('updateCheck.settings.error', { error: state.lastError })));
    }

    // Buttons: Check now + open releases page in browser.
    const checkBtn = el('button', {
      class: 'tb-btn', type: 'button',
      onclick: () => {
        if (!uc || !uc.checkNow) return;
        checkBtn.disabled = true;
        const originalText = checkBtn.textContent;
        checkBtn.textContent = t('updateCheck.toast.checking');
        uc.checkNow().then(() => {
          rerender();
        }).catch(() => {
          rerender();
        }).then(() => {
          // rerender replaces the DOM so the disabled state resets
          // automatically; if rerender didn't fire (unlikely), at
          // least restore the button text.
          if (document.body.contains(checkBtn)) {
            checkBtn.disabled = false;
            checkBtn.textContent = originalText;
          }
        });
      },
    }, '🔄 ' + t('updateCheck.settings.checkNow'));

    card.appendChild(el('div', {
      class: 'tb-btn-row',
      style: { marginTop: 'var(--tb-sp-3)', gap: '10px', flexWrap: 'wrap' },
    },
      checkBtn,
      el('a', {
        class: 'tb-btn tb-btn--secondary',
        href: releasesUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, '↗ ' + t('updateCheck.settings.releasesLink')),
    ));

    return card;
  }

  function buildBackupCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    // Shared handler for both file-picker selection and drag-drop.
    async function processBackupFile(file) {
      if (!file) return;
      try {
        const text = await TB.utils.readFileAsText(file);
        TB.state.import(text);
        alert(t('settings.import.success'));
        rerender();
      } catch (err) {
        alert(t('settings.import.failed') + ': ' + err.message);
      }
    }

    const fileInput = el('input', {
      type: 'file', accept: 'application/json,.json',
      style: { display: 'none' },
      onchange: (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (file) processBackupFile(file);
      },
    });

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', null, t('settings.export.title')),
      el('p', null, t('settings.export.help')),
      fileInput,
      el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn',
          onclick: () => {
            const date = TB.utils.isoDate(new Date());
            TB.utils.downloadFile(
              `taigan-bridge-backup-${date}.json`,
              TB.state.export(),
              'application/json',
            );
            TB.state.set('settings.lastExportAt', new Date().toISOString());
          },
        }, t('settings.export.do')),
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          onclick: () => fileInput.click(),
        }, t('settings.import.do')),
        el('span', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' } },
          t('settings.import.dropHint')),
      ),
    );

    // Drag-and-drop on the whole backup card so user can just drop
    // a backup .json anywhere onto it.
    TB.utils.attachFileDrop(card, {
      accept: ['application/json', '.json'],
      text: '⤓ ' + t('settings.import.drop'),
      onFile: (f) => processBackupFile(f),
      onError: (msg) => alert(msg),
    });

    return card;
  }

  function buildDangerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', null, t('settings.danger.title')),
      el('p', null, t('settings.danger.help')),
      el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn tb-btn--danger',
          onclick: () => {
            if (!confirm(t('settings.danger.confirm'))) return;
            const typed = prompt(t('settings.danger.confirm2'));
            if (typed !== 'DELETE') return;
            TB.state.clearAll();
            location.reload();
          },
        }, t('settings.danger.do')),
      ),
    );
  }

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = { id, label_en: 'Settings', label_jp: '設定', render };
})();
