/* Taigan Bridge — utils.js
 *
 * Formatters and tiny helpers shared across modules: currency, date,
 * percentage, ID generators, and an FX rate stub.
 */

(function () {
  'use strict';

  // Hardcoded FX fallback rates (units of the named currency per 1 USD,
  // EXCEPT JPYUSD which is the inverse for FBAR-style display). These
  // are intentionally rough — the user can override per-account, and
  // a future Treasury / BoJ live-fetch will replace these. Source as
  // of asOf is approximate mid-2026 published rates.
  const FX_FALLBACK = {
    asOf: '2026-05-01',
    USDJPY: 152.0,
    JPYUSD: 1 / 152.0,
    // Major-currency table: amount-per-USD. toUsd() divides native by
    // these to compute USD. Add new currencies here as they come up.
    perUsd: {
      USD: 1.0,
      JPY: 152.0,
      EUR: 0.92,
      GBP: 0.79,
      AUD: 1.51,
      CAD: 1.37,
      CHF: 0.88,
      KRW: 1370,
      CNY: 7.20,
      HKD: 7.81,
      SGD: 1.34,
    },
    source: 'hardcoded',
  };

  function formatUSD(n, opts) {
    if (n == null || isNaN(n)) return '—';
    const max = (opts && opts.maximumFractionDigits != null) ? opts.maximumFractionDigits : 2;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: max,
    }).format(n);
  }

  function formatJPY(n) {
    if (n == null || isNaN(n)) return '—';
    return new Intl.NumberFormat('ja-JP', {
      style: 'currency',
      currency: 'JPY',
      maximumFractionDigits: 0,
    }).format(n);
  }

  function formatPercent(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return (n * 100).toFixed(digits == null ? 1 : digits) + '%';
  }

  function formatDate(input, lang) {
    if (!input) return '—';
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return '—';
    const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
    return d.toLocaleDateString(locale, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function isoDate(d) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    // RFC4122-ish fallback.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function shortId(prefix) {
    return (prefix || '') + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsText(file);
    });
  }

  // SHA-256 hex digest of an ArrayBuffer or File (browser-native via
  // SubtleCrypto). Used by the FBAR upload to detect duplicate
  // documents before sending another billable Claude call.
  async function sha256(input) {
    let buf;
    if (input instanceof ArrayBuffer) {
      buf = input;
    } else if (typeof input === 'string') {
      buf = new TextEncoder().encode(input).buffer;
    } else if (input && typeof input.arrayBuffer === 'function') {
      buf = await input.arrayBuffer();
    } else {
      throw new Error('sha256: unsupported input type');
    }
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const arr = Array.from(new Uint8Array(hashBuf));
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // FX rate fetch stub. v0.1 returns the hardcoded rate immediately.
  // TODO(v0.x): swap for a real fetch (e.g., exchangerate.host / BoJ
  // reference rate) gated behind an explicit "Fetch live rate" button
  // so the tool stays offline-by-default.
  function getFxRate() {
    return Promise.resolve(Object.assign({}, FX_FALLBACK));
  }

  // ─── Live "current" FX rates from Treasury Fiscal Data ─────────
  //
  // The Treasury rates_of_exchange dataset is published QUARTERLY
  // (Mar/Jun/Sep/Dec record_date). For Assets-module display purposes
  // that's "live enough" — it beats the hardcoded perUsd fallback and
  // requires no API key. FBAR uses the same dataset for year-end
  // snapshots; we ride alongside but query for the most recent
  // record_date instead of a specific December 31.
  //
  // After a successful fetch we write into state.settings.fx:
  //   current_rates:     { USD: 1, JPY: 152.34, EUR: 0.92, … }
  //   current_fetched_at: ISO timestamp of the fetch
  //   current_as_of:     ISO date of the underlying record
  // Errors land in current_fetch_error (string) for surfacing in UI.

  const TREASURY_RATES_API = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange';

  // Compact desc→ISO map covering the major currencies the Assets
  // module exposes in the dropdown. FBAR carries a fuller table for
  // its FBAR-specific currencies — duplicating the small subset here
  // keeps utils.js standalone and avoids a load-order dependency.
  const TREASURY_DESC_TO_ISO = {
    'JAPAN-YEN': 'JPY',
    'EURO ZONE-EURO': 'EUR',
    'UNITED KINGDOM-POUND': 'GBP',
    'AUSTRALIA-DOLLAR': 'AUD',
    'CANADA-DOLLAR': 'CAD',
    'SWITZERLAND-FRANC': 'CHF',
    'KOREA-WON': 'KRW',
    'CHINA-YUAN RENMINBI': 'CNY',
    'CHINA-RENMINBI': 'CNY',
    'HONG KONG-DOLLAR': 'HKD',
    'SINGAPORE-DOLLAR': 'SGD',
  };

  function descToIso(desc) {
    if (!desc) return null;
    const upper = String(desc).toUpperCase().trim();
    return TREASURY_DESC_TO_ISO[upper] || null;
  }

  async function fetchCurrentTreasuryRates() {
    const url = TREASURY_RATES_API +
      '?fields=country_currency_desc,exchange_rate,record_date' +
      '&sort=-record_date' +
      '&page[size]=200';
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('Treasury API ' + res.status);
    const json = await res.json();
    const rows = (json && json.data) || [];
    if (rows.length === 0) throw new Error('Treasury API returned no data');
    const asOf = rows[0].record_date;
    const out = { USD: 1 };
    for (const row of rows) {
      if (row.record_date !== asOf) break; // only the most recent quarter
      const iso = descToIso(row.country_currency_desc);
      if (!iso) continue;
      const r = parseFloat(row.exchange_rate);
      if (!isFinite(r) || r <= 0) continue;
      out[iso] = r;
    }
    return { rates: out, asOf };
  }

  // exchangerate.host fallback. Open / no-key API. Returns
  // { USD: 1, JPY: x, EUR: y, … } for the requested base USD.
  // Used to fill currencies Treasury doesn't publish (Phase 5).
  async function fetchExchangerateHost(symbols) {
    const url = 'https://api.exchangerate.host/latest?base=USD' +
      (symbols && symbols.length ? '&symbols=' + symbols.join(',') : '');
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error('exchangerate.host ' + res.status);
    const json = await res.json();
    if (!json || !json.rates) throw new Error('exchangerate.host: no rates field');
    const out = { USD: 1 };
    for (const [k, v] of Object.entries(json.rates)) {
      const r = parseFloat(v);
      if (isFinite(r) && r > 0) out[k] = r;
    }
    return { rates: out, asOf: json.date || null };
  }

  // Fetch + persist. Returns { rates, asOf, fetchedAt } on success or
  // throws. Writes into state.settings.fx.* via TB.state.set so any
  // listener (Assets summary card, etc.) sees the new rates.
  //
  // Strategy: Treasury first (preferred — official, quarterly, the
  // same source FBAR uses). Then exchangerate.host to fill in any
  // currencies the user has accounts in that Treasury didn't return
  // (e.g., NOK, SEK, MXN — not in Treasury's published list).
  async function refreshCurrentFx() {
    if (!window.TB || !TB.state) throw new Error('State not available');
    try {
      const { rates, asOf } = await fetchCurrentTreasuryRates();

      // Look up which currencies are actually in use across the
      // user's accounts so we know which extras to backfill.
      let neededExtras = [];
      try {
        const accounts = (TB.state.get('assets.accounts') || []);
        const inUse = new Set();
        for (const a of accounts) if (a && a.currency) inUse.add(a.currency);
        neededExtras = Array.from(inUse).filter((c) => c !== 'USD' && !rates[c]);
      } catch (e) { /* best-effort */ }

      let fallbackUsed = false;
      if (neededExtras.length > 0) {
        try {
          const ex = await fetchExchangerateHost(neededExtras);
          for (const c of neededExtras) {
            if (ex.rates[c] && !rates[c]) rates[c] = ex.rates[c];
          }
          fallbackUsed = true;
        } catch (e) {
          // Non-fatal — Treasury rates still got persisted.
          console.warn('[fx] exchangerate.host fallback failed:', e);
        }
      }

      const fetchedAt = new Date().toISOString();
      TB.state.set('settings.fx.current_rates', rates);
      TB.state.set('settings.fx.current_as_of', asOf);
      TB.state.set('settings.fx.current_fetched_at', fetchedAt);
      TB.state.set('settings.fx.current_fetch_error', null);
      TB.state.set('settings.fx.current_fallback_used', fallbackUsed);
      return { rates, asOf, fetchedAt, fallbackUsed };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      TB.state.set('settings.fx.current_fetch_error', msg);
      throw err;
    }
  }

  // ─── Live FX rate (informational, NOT used for calculations) ─────
  //
  // Treasury publishes USD/JPY quarterly — that's the rate FBAR + the
  // Assets cost-basis math use, but "as of 3/31" feels stale on a
  // Tuesday in May. Users who are about to do a remittance want to
  // see the actual market rate they'd get TODAY, similar to what
  // Google or Yahoo Finance shows.
  //
  // Source priority (each attempt has CORS enabled for `null` origin
  // so `file://` builds work — that ruled out api.frankfurter.app
  // which only allows http/https origins):
  //
  //   1. jsDelivr-hosted @fawazahmed0/currency-api — daily mid-market
  //      rate sourced from open exchange data, served with permissive
  //      CORS by the CDN. Primary.
  //   2. Cloudflare-hosted mirror of the same dataset — used when the
  //      jsDelivr edge node is sluggish or returns 5xx.
  //   3. open.er-api.com — independent provider, also CORS-friendly,
  //      slightly less frequent updates. Final fallback.
  //
  // We fetch at most once per hour and cache in state. Stored fields:
  //   live_jpy:         number (¥ per $1)
  //   live_as_of:       ISO date the rate is dated
  //   live_fetched_at:  ISO timestamp of OUR fetch
  //   live_source:      'jsDelivr currency-api' / 'open.er-api.com' / etc.
  //   live_fetch_error: string when the last attempt failed

  const LIVE_FX_SOURCES = [
    {
      name: 'jsDelivr currency-api',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      parse: (j) => {
        const r = j && j.usd && Number(j.usd.jpy);
        if (!isFinite(r) || r <= 0) return null;
        return { rate: r, asOf: j.date || null };
      },
    },
    {
      name: 'Cloudflare currency-api',
      url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
      parse: (j) => {
        const r = j && j.usd && Number(j.usd.jpy);
        if (!isFinite(r) || r <= 0) return null;
        return { rate: r, asOf: j.date || null };
      },
    },
    {
      name: 'open.er-api.com',
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (j) => {
        const r = j && j.rates && Number(j.rates.JPY);
        if (!isFinite(r) || r <= 0) return null;
        // open.er-api uses "time_last_update_utc" — convert to ISO date.
        let asOf = null;
        if (j.time_last_update_utc) {
          const d = new Date(j.time_last_update_utc);
          if (!isNaN(d.getTime())) asOf = d.toISOString().slice(0, 10);
        }
        return { rate: r, asOf };
      },
    },
  ];
  const LIVE_FX_CACHE_MS = 60 * 60 * 1000; // 1 hour

  async function fetchLiveJpyRate() {
    const errors = [];
    for (const src of LIVE_FX_SOURCES) {
      try {
        const res = await fetch(src.url, { method: 'GET', cache: 'no-store' });
        if (!res.ok) throw new Error(src.name + ' HTTP ' + res.status);
        const json = await res.json();
        const parsed = src.parse(json);
        if (!parsed) throw new Error(src.name + ': no JPY rate in response');
        return { rate: parsed.rate, asOf: parsed.asOf, source: src.name };
      } catch (err) {
        errors.push(src.name + ': ' + ((err && err.message) || err));
        // Try next source
      }
    }
    throw new Error('All live-FX sources failed — ' + errors.join(' · '));
  }

  // Public: refresh the cached live rate. Safe to call frequently —
  // returns the cached value when the previous fetch is still fresh.
  // `force: true` bypasses the cache (used by the manual refresh
  // button in the FX snapshot card).
  async function refreshLiveFx(opts) {
    if (!window.TB || !TB.state) throw new Error('State not available');
    const force = opts && opts.force;
    const cur = TB.state.get('settings.fx') || {};
    if (!force && cur.live_fetched_at) {
      const ageMs = Date.now() - new Date(cur.live_fetched_at).getTime();
      if (isFinite(ageMs) && ageMs < LIVE_FX_CACHE_MS && cur.live_jpy) {
        return { rate: cur.live_jpy, asOf: cur.live_as_of, source: cur.live_source, cached: true };
      }
    }
    try {
      const { rate, asOf, source } = await fetchLiveJpyRate();
      const fetchedAt = new Date().toISOString();
      TB.state.set('settings.fx.live_jpy', rate);
      TB.state.set('settings.fx.live_as_of', asOf);
      TB.state.set('settings.fx.live_fetched_at', fetchedAt);
      TB.state.set('settings.fx.live_source', source);
      TB.state.set('settings.fx.live_fetch_error', null);
      // Notify any listeners (top banner, FX snapshot card) so they
      // can re-render without polling. The detail carries the rate so
      // simple subscribers don't need to re-read state.
      try {
        document.dispatchEvent(new CustomEvent('tb:live-fx-updated', {
          detail: { rate, asOf, source, fetchedAt },
        }));
      } catch (_) { /* no document in odd environments */ }
      return { rate, asOf, source, fetchedAt, cached: false };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      TB.state.set('settings.fx.live_fetch_error', msg);
      throw err;
    }
  }

  // Synchronous accessor — returns the cached live rate without
  // triggering a fetch. Used by the disclaimer-banner widget.
  function getLiveJpyRate() {
    const fx = (window.TB && TB.state && TB.state.get('settings.fx')) || {};
    if (!fx.live_jpy) return null;
    return {
      rate: fx.live_jpy,
      asOf: fx.live_as_of || null,
      fetchedAt: fx.live_fetched_at || null,
      source: fx.live_source || null,
    };
  }

  // ─── Drag-and-drop file upload helper ──────────────────────────────
  //
  // attachFileDrop(zoneElement, opts) wires drag-and-drop file upload
  // to any DOM element. Used everywhere the tool accepts an upload —
  // Assets statement upload, Document Vault, FBAR statements, Settings
  // JSON import. Mirrors the file-picker UX (single file, MIME filter)
  // so behavior is consistent regardless of how the file got there.
  //
  // opts:
  //   accept:  array of MIME types or extensions (e.g.
  //            ['image/png', 'application/pdf'] or ['.pdf']).
  //            Falsy → accept anything.
  //   onFile:  (File) => void   — called when a valid file is dropped
  //   onError: (string) => void — called on rejected (wrong type) drops
  //   text:    optional override for the "Drop to upload" overlay text
  //
  // Returns a detach() function that removes all listeners + classes.
  // Visual feedback is CSS-driven via .tb-dropzone / .tb-dropzone-active.
  function attachFileDrop(zone, opts) {
    opts = opts || {};
    const accept = opts.accept || null;
    const onFile = opts.onFile;
    const onError = opts.onError;
    if (!zone || typeof onFile !== 'function') return function noop() {};

    // Drag enter/leave bubbles up from children, so we use a counter
    // to track "is the file actually over the zone or just passing
    // between nested children". Increment on enter, decrement on
    // leave; only toggle the active class at the boundary.
    let counter = 0;

    function isAccepted(file) {
      if (!accept || accept.length === 0) return true;
      const ft = (file.type || '').toLowerCase();
      const fn = (file.name || '').toLowerCase();
      for (const a of accept) {
        const al = a.toLowerCase();
        if (al === ft) return true;
        if (al.endsWith('/*') && ft.startsWith(al.slice(0, -1))) return true;
        if (al.startsWith('.') && fn.endsWith(al)) return true;
      }
      return false;
    }

    function onDragEnter(e) {
      // Only react to file drags, not text/element drags within the page.
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (e.dataTransfer.types.indexOf('Files') === -1) return;
      e.preventDefault();
      e.stopPropagation();
      counter++;
      if (counter === 1) zone.classList.add('tb-dropzone-active');
    }
    function onDragLeave(e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (e.dataTransfer.types.indexOf('Files') === -1) return;
      e.preventDefault();
      e.stopPropagation();
      counter--;
      if (counter <= 0) {
        counter = 0;
        zone.classList.remove('tb-dropzone-active');
      }
    }
    function onDragOver(e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (e.dataTransfer.types.indexOf('Files') === -1) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(e) {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (e.dataTransfer.types.indexOf('Files') === -1) return;
      e.preventDefault();
      e.stopPropagation();
      counter = 0;
      zone.classList.remove('tb-dropzone-active');
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      const file = files[0]; // single-file paradigm matches our file pickers
      if (!isAccepted(file)) {
        if (onError) onError('Unsupported file type: ' + (file.type || file.name || 'unknown'));
        return;
      }
      onFile(file);
    }

    zone.addEventListener('dragenter', onDragEnter);
    zone.addEventListener('dragleave', onDragLeave);
    zone.addEventListener('dragover', onDragOver);
    zone.addEventListener('drop', onDrop);
    zone.classList.add('tb-dropzone');
    if (opts.text) zone.setAttribute('data-dropzone-text', opts.text);
    else if (!zone.hasAttribute('data-dropzone-text')) {
      zone.setAttribute('data-dropzone-text', '⤓ Drop to upload');
    }

    return function detach() {
      zone.removeEventListener('dragenter', onDragEnter);
      zone.removeEventListener('dragleave', onDragLeave);
      zone.removeEventListener('dragover', onDragOver);
      zone.removeEventListener('drop', onDrop);
      zone.classList.remove('tb-dropzone');
      zone.classList.remove('tb-dropzone-active');
    };
  }

  // ─── Slider component helper ───────────────────────────────────────
  //
  // Returns a DOM node containing a styled range input + label + live
  // value display + tick labels. Updates a CSS variable on the input
  // for the dual-track fill effect, calls onInput(value) on every drag
  // step, and onChange(value) when the user releases. Variant flag
  // selects the accent color ('accent' | 'success' | 'navy').
  //
  // opts: {
  //   label,           // string label shown above
  //   value,           // initial numeric value
  //   min, max, step,  // standard range params
  //   variant,         // 'accent' | 'success' | 'navy' (default 'accent')
  //   ticks,           // array of {at, text} or strings
  //   side,            // small subtitle to the right of the value
  //   help,            // optional help text below
  //   format,          // (v) => string, value display formatter
  //   onInput,         // (v) => void, fires during drag
  //   onChange,        // (v) => void, fires on release
  // }
  function buildSlider(opts) {
    const o = opts || {};
    const min = (o.min != null) ? Number(o.min) : 0;
    const max = (o.max != null) ? Number(o.max) : 100;
    const step = (o.step != null) ? Number(o.step) : 1;
    const startVal = (o.value != null) ? Number(o.value) : min;
    const variant = o.variant ? ('tb-slider--' + o.variant) : '';
    const fmt = o.format || ((v) => String(v));

    const wrap = document.createElement('div');
    wrap.className = ('tb-slider ' + variant).trim();

    const header = document.createElement('div');
    header.className = 'tb-slider-header';
    if (o.label) {
      const lbl = document.createElement('span');
      lbl.className = 'tb-slider-label';
      lbl.textContent = o.label;
      header.appendChild(lbl);
    }
    const valSpan = document.createElement('span');
    valSpan.className = 'tb-slider-value';
    valSpan.textContent = fmt(startVal);
    header.appendChild(valSpan);
    if (o.side) {
      const sideSpan = document.createElement('span');
      sideSpan.className = 'tb-slider-side';
      sideSpan.textContent = o.side;
      header.appendChild(sideSpan);
    }
    wrap.appendChild(header);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(startVal);
    function pct(v) { return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)); }
    input.style.setProperty('--tb-slider-pct', String(pct(startVal)));
    input.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      input.style.setProperty('--tb-slider-pct', String(pct(v)));
      valSpan.textContent = fmt(v);
      if (typeof o.onInput === 'function') o.onInput(v);
    });
    input.addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (typeof o.onChange === 'function') o.onChange(v);
    });
    wrap.appendChild(input);

    if (o.ticks && o.ticks.length) {
      const ticks = document.createElement('div');
      ticks.className = 'tb-slider-ticks';
      for (const t of o.ticks) {
        const span = document.createElement('span');
        span.textContent = (typeof t === 'string') ? t : (t && t.text) || '';
        ticks.appendChild(span);
      }
      wrap.appendChild(ticks);
    }
    if (o.help) {
      const help = document.createElement('div');
      help.className = 'tb-slider-help';
      help.textContent = o.help;
      wrap.appendChild(help);
    }

    return {
      node: wrap,
      setValue(v) {
        input.value = String(v);
        input.style.setProperty('--tb-slider-pct', String(pct(Number(v))));
        valSpan.textContent = fmt(Number(v));
      },
      setSide(text) {
        const existing = wrap.querySelector('.tb-slider-side');
        if (existing) existing.textContent = text;
      },
    };
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // ─── Japanese term annotations ──────────────────────────────────────────
  //
  // Each entry becomes a <ruby class="tb-jp" data-jp-en="…">kanji<rt>かな</rt></ruby>
  // wherever the kanji appears in rendered DOM text. The tooltip shows the
  // English meaning; the <rt> shows the furigana reading (hidden in JP UI).
  //
  // Sorted longest-first so longer compounds match before their components.
  // The annotator wraps each occurrence in <ruby>kanji<rt>furigana</rt></ruby>
  // — furigana shown above only in English UI mode (hidden in JP).
  // The `en` tooltip shows on hover regardless of UI language.
  const JP_TERMS = [
    // ── Multi-kanji compounds (longest-first match precedence) ─────
    { kanji: '小規模宅地等の特例',   furigana: 'しょうきぼたくちとうのとくれい', en: 'small residential property special exception (80% inheritance valuation reduction)' },
    { kanji: '個人型確定拠出年金',   furigana: 'こじんがたかくていきょしゅつねんきん', en: 'iDeCo — individual defined contribution pension' },
    { kanji: '少額投資非課税制度',   furigana: 'しょうがくとうしひかぜいせいど', en: 'NISA — small-amount investment tax exemption' },
    { kanji: '結婚・子育て資金一括贈与', furigana: 'けっこんこそだてしきんいっかつぞうよ', en: 'marriage / child-rearing lump-sum gift exemption' },
    { kanji: '教育資金一括贈与',     furigana: 'きょういくしきんいっかつぞうよ', en: 'education lump-sum gift (¥15M tax-free to grandchildren)' },
    { kanji: '相続時精算課税',       furigana: 'そうぞくじせいさんかぜい', en: 'settlement-at-inheritance taxation system (¥25M lifetime gift cap)' },
    { kanji: '出入国在留管理庁',     furigana: 'しゅつにゅうこくざいりゅうかんりちょう', en: 'Immigration Services Agency of Japan' },
    { kanji: '固定資産税評価額',     furigana: 'こていしさんぜいひょうかがく', en: 'fixed-asset tax assessed value (real estate)' },
    { kanji: '小規模企業共済',       furigana: 'しょうきぼきぎょうきょうさい', en: 'small business mutual aid (deferred-tax retirement plan for self-employed)' },
    { kanji: '生命保険料控除',       furigana: 'せいめいほけんりょうこうじょ', en: 'life insurance premium deduction' },
    { kanji: '地震保険料控除',       furigana: 'じしんほけんりょうこうじょ', en: 'earthquake insurance premium deduction' },
    { kanji: '長期優良住宅',         furigana: 'ちょうきゆうりょうじゅうたく', en: 'long-term excellent housing (¥45M mortgage credit cap)' },
    { kanji: '住宅ローン控除',       furigana: 'じゅうたくろーんこうじょ', en: 'mortgage tax credit (0.7% × balance × 13y)' },
    { kanji: '結婚資金贈与',         furigana: 'けっこんしきんぞうよ', en: 'marriage funds gift exemption' },
    { kanji: '高額療養費',           furigana: 'こうがくりょうようひ', en: 'high-cost medical expense subsidy' },
    { kanji: '高度専門職',           furigana: 'こうどせんもんしょく', en: 'highly skilled professional (HSP visa, fast-track PR)' },
    { kanji: '申告分離課税',         furigana: 'しんこくぶんりかぜい', en: 'separate self-assessment taxation (capital gains)' },
    { kanji: '源泉徴収票',           furigana: 'げんせんちょうしゅうひょう', en: 'gensen choshu hyo — Japan equivalent of W-2' },
    { kanji: '特定贈与信託',         furigana: 'とくていぞうよしんたく', en: 'special-needs trust (for severely disabled heirs)' },
    { kanji: '配偶者控除',           furigana: 'はいぐうしゃこうじょ', en: 'spouse deduction (¥160M inheritance tax-free)' },
    { kanji: '医療費控除',           furigana: 'いりょうひこうじょ', en: 'medical expense deduction (>¥100K/yr)' },
    { kanji: '国民健康保険',         furigana: 'こくみんけんこうほけん', en: 'National Health Insurance (NHI)' },
    { kanji: '出入国管理',           furigana: 'しゅつにゅうこくかんり', en: 'immigration control' },
    { kanji: '帯同家族',             furigana: 'たいどうかぞく', en: 'accompanying family members' },
    { kanji: '扶養家族',             furigana: 'ふようかぞく', en: 'dependent family members' },
    { kanji: '雑損控除',             furigana: 'ざっそんこうじょ', en: 'casualty loss deduction' },
    { kanji: '海外居住者',           furigana: 'かいがいきょじゅうしゃ', en: 'overseas resident (used in IRS expat-extension context)' },
    { kanji: '全世界所得',           furigana: 'ぜんせかいしょとく', en: 'worldwide income (taxed for 永住者 status year 6+)' },
    { kanji: '日本源泉所得',         furigana: 'にほんげんせんしょとく', en: 'Japan-source income' },
    { kanji: '外国税額控除',         furigana: 'がいこくぜいがくこうじょ', en: 'Foreign Tax Credit (JP-side; mirrors US FTC)' },
    { kanji: '確定拠出年金',         furigana: 'かくていきょしゅつねんきん', en: 'Defined Contribution Pension (iDeCo)' },
    { kanji: '取引報告書',           furigana: 'とりひきほうこくしょ', en: 'transaction report (annual; from JP brokerage)' },
    { kanji: '残高証明書',           furigana: 'ざんだかしょうめいしょ', en: 'balance certificate (year-end statement)' },
    { kanji: '税額決定通知書',       furigana: 'ぜいがくけっていつうちしょ', en: 'tax assessment notice (juminze)' },
    { kanji: '送金所得',             furigana: 'そうきんしょとく', en: 'remitted income (taxable for 非永住者)' },
    { kanji: '日本国籍選択届',       furigana: 'にほんこくせきせんたくとどけ', en: 'Japanese Nationality Choice form (filed at 市役所; deadline age 20 if dual since before 18)' },
    { kanji: '国籍喪失届',           furigana: 'こくせきそうしつとどけ', en: 'Notification of Loss of Nationality (filed when choosing US over JP)' },
    { kanji: '居住用不動産',         furigana: 'きょじゅうようふどうさん', en: 'residential real estate' },
    { kanji: '残存有効期間',         furigana: 'ざんぞんゆうこうきかん', en: 'remaining validity period (passport)' },
    { kanji: '米国市民権',           furigana: 'べいこくしみんけん', en: 'US citizenship' },
    { kanji: '直系卑属',             furigana: 'ちょっけいひぞく', en: 'lineal descendant (children, grandchildren — eligible for 教育資金一括贈与)' },
    { kanji: '適格教育機関',         furigana: 'てきかくきょういくきかん', en: 'eligible educational institution (529-qualified)' },
    { kanji: '適格高等教育費',       furigana: 'てきかくこうとうきょういくひ', en: 'qualified higher education expenses (529)' },
    { kanji: '集団訴訟',             furigana: 'しゅうだんそしょう', en: 'class-action lawsuit' },
    { kanji: '介護認定審査会',       furigana: 'かいごにんていしんさかい', en: 'municipal LTC certification committee (assigns 要介護 levels)' },
    { kanji: '医療代理人',           furigana: 'いりょうだいりにん', en: 'medical proxy / healthcare POA' },
    { kanji: '健康代理人',           furigana: 'けんこうだいりにん', en: 'health POA (alt term for 医療代理人)' },
    { kanji: '法定相続情報一覧図',   furigana: 'ほうていそうぞくじょうほういちらんず', en: 'consolidated heir-certification document (filed at 法務局)' },
    { kanji: '公正証書遺言',         furigana: 'こうせいしょうしょいごん', en: 'notarized JP will (skips 家庭裁判所 検認)' },
    { kanji: '事業承継税制',         furigana: 'じぎょうしょうけいぜいせい', en: 'business succession tax regime (defers up to 100% of inheritance tax for qualifying transfers)' },
    { kanji: '遺言執行者',           furigana: 'ゆいごんしっこうしゃ', en: 'will executor' },
    { kanji: '法定相続分',           furigana: 'ほうていそうぞくぶん', en: 'statutory inheritance share (Civil Code §900)' },
    { kanji: '家庭裁判所',           furigana: 'かていさいばんしょ', en: 'family court (handles intestate probate, 検認)' },
    { kanji: '直系尊属',             furigana: 'ちょっけいそんぞく', en: 'lineal ascendant (parent, grandparent — 第2順位 heir)' },
    { kanji: '代襲相続',             furigana: 'だいしゅうそうぞく', en: 'representation inheritance (grandchild takes deceased parent\'s share)' },

    // ── 4-character compounds ─────────────────────────────────────
    { kanji: '確定申告',   furigana: 'かくていしんこく', en: 'kakutei shinkoku — Japan annual tax return (Feb 16 - Mar 15)' },
    { kanji: '予定納税',   furigana: 'よていのうぜい', en: 'estimated tax prepayment (JP mid-year, Jul + Nov)' },
    { kanji: '提出期限',   furigana: 'ていしゅつきげん', en: 'submission deadline' },
    { kanji: '通常期限',   furigana: 'つうじょうきげん', en: 'standard deadline' },
    { kanji: '延長期限',   furigana: 'えんちょうきげん', en: 'extended deadline' },
    { kanji: '自動延長',   furigana: 'じどうえんちょう', en: 'automatic extension' },
    { kanji: '受付開始',   furigana: 'うけつけかいし', en: 'window opens / acceptance begins' },
    { kanji: '合同会社',   furigana: 'ごうどうがいしゃ', en: 'gōdō-gaisha — JP LLC (creates US CFC if US-owned ≥10%)' },
    { kanji: '株式会社',   furigana: 'かぶしきがいしゃ', en: 'kabushiki-gaisha — JP joint-stock company (creates US CFC if US-owned ≥10%)' },
    { kanji: '租税条約',   furigana: 'そぜいじょうやく', en: 'tax treaty (e.g., US-Japan totalization agreement)' },
    { kanji: '二重課税',   furigana: 'にじゅうかぜい', en: 'double taxation (mitigated by FTC + treaty)' },
    { kanji: '外国法人',   furigana: 'がいこくほうじん', en: 'foreign corporation (triggers US Form 5471 for ≥10% owners)' },
    { kanji: '日米地位協定', furigana: 'にちべいちいきょうてい', en: 'US-Japan Status of Forces Agreement (SOFA)' },
    { kanji: '雇用主',     furigana: 'こようぬし', en: 'employer' },
    { kanji: '駐在員',     furigana: 'ちゅうざいいん', en: 'expat / overseas-posted employee' },
    { kanji: '申告書',     furigana: 'しんこくしょ', en: 'tax return / declaration form' },
    { kanji: '法人',       furigana: 'ほうじん', en: 'corporation / legal entity' },
    { kanji: '納税',       furigana: 'のうぜい', en: 'tax payment' },
    { kanji: '銀行',       furigana: 'ぎんこう', en: 'bank' },
    { kanji: '期限',       furigana: 'きげん', en: 'deadline' },
    { kanji: '控え',       furigana: 'ひかえ', en: 'copy / duplicate (e.g., 申告書の控え)' },
    { kanji: '申請',       furigana: 'しんせい', en: 'application / request' },
    { kanji: '第1期',     furigana: 'だいいっき', en: '1st installment / period' },
    { kanji: '第2期',     furigana: 'だいにき', en: '2nd installment / period' },
    { kanji: '国籍選択', furigana: 'こくせきせんたく', en: 'nationality choice (since 2022: by age 20 if dual before 18; otherwise within 2 years of acquiring)' },
    { kanji: '兄弟姉妹', furigana: 'きょうだいしまい', en: 'siblings' },
    { kanji: '都道府県', furigana: 'とどうふけん', en: 'prefectures (47 administrative divisions of Japan)' },
    { kanji: '持ち戻し', furigana: 'もちもどし', en: 'clawback (gifts pulled back into estate; 7y rule)' },
    { kanji: '国籍喪失', furigana: 'こくせきそうしつ', en: 'loss of nationality' },
    { kanji: '国籍法',   furigana: 'こくせきほう', en: 'Japanese Nationality Act' },
    { kanji: '市民権',   furigana: 'しみんけん', en: 'citizenship' },
    { kanji: '領事館',   furigana: 'りょうじかん', en: 'consulate' },
    { kanji: '旅券課',   furigana: 'りょけんか', en: 'passport division (prefectural office)' },
    { kanji: '不可逆',   furigana: 'ふかぎゃく', en: 'irreversible' },
    { kanji: '再帰化',   furigana: 'さいきか', en: 'renaturalization (re-acquiring renounced citizenship)' },
    { kanji: '続柄',     furigana: 'つづきがら', en: 'family relationship (term used in 戸籍 records)' },
    { kanji: '放棄',     furigana: 'ほうき', en: 'renunciation / abandonment' },
    { kanji: '大使館',   furigana: 'たいしかん', en: 'embassy' },
    { kanji: '出国日',   furigana: 'しゅっこくび', en: 'expatriation date (renunciation oath date)' },
    { kanji: '宣誓書',   furigana: 'せんせいしょ', en: 'oath / affidavit' },
    { kanji: '質問票',   furigana: 'しつもんひょう', en: 'questionnaire' },
    { kanji: '節税',     furigana: 'せつぜい', en: 'tax avoidance / minimization' },
    { kanji: '介護保険', furigana: 'かいごほけん', en: 'long-term care insurance (mandatory in JP at age 40+)' },
    { kanji: '生前指示書', furigana: 'せいぜんしじしょ', en: 'advance directive / living will' },
    { kanji: '臓器提供', furigana: 'ぞうきていきょう', en: 'organ donation' },
    { kanji: '蘇生拒否', furigana: 'そせいきょひ', en: 'do-not-resuscitate (DNR) preference' },
    { kanji: '要介護',   furigana: 'ようかいご', en: 'requires care (LTC level 1-5; assigned by 介護認定審査会)' },
    { kanji: '要支援',   furigana: 'ようしえん', en: 'requires support (LTC support level 1-2)' },
    { kanji: '健康保険', furigana: 'けんこうほけん', en: 'health insurance (general term)' },
    { kanji: '社会保険', furigana: 'しゃかいほけん', en: 'employer-provided social insurance (covers health, pension, LTC, employment)' },
    { kanji: '葬儀',     furigana: 'そうぎ', en: 'funeral' },
    { kanji: '為替',     furigana: 'かわせ', en: 'foreign exchange (FX)' },
    // ── Settings / dashboard / accessibility UI terms ──
    { kanji: '抽出',     furigana: 'ちゅうしゅつ', en: 'extraction (e.g., FBAR document data extraction)' },
    { kanji: '集計',     furigana: 'しゅうけい', en: 'aggregation / tally (e.g., monthly cost roll-up)' },
    { kanji: '推移',     furigana: 'すいい', en: 'trend / change over time' },
    { kanji: '累計',     furigana: 'るいけい', en: 'cumulative / lifetime total' },
    { kanji: '推奨',     furigana: 'すいしょう', en: 'recommendation' },
    { kanji: '機能別',   furigana: 'きのうべつ', en: 'by feature (per-feature breakdown)' },
    { kanji: '機関情報', furigana: 'きかんじょうほう', en: 'institution information (FBAR / asset enrichment)' },
    { kanji: '事業経費', furigana: 'じぎょうけいひ', en: 'business expense (potentially tax-deductible)' },
    { kanji: '税控除',   furigana: 'ぜいこうじょ', en: 'tax deduction' },
    { kanji: '照合',     furigana: 'しょうごう', en: 'reconcile / verify' },
    { kanji: '残高',     furigana: 'ざんだか', en: 'balance / remaining amount' },
    { kanji: '購入額',   furigana: 'こうにゅうがく', en: 'purchase amount' },
    { kanji: '上限',     furigana: 'じょうげん', en: 'upper limit / cap' },
    { kanji: '本日',     furigana: 'ほんじつ', en: 'today' },
    { kanji: '今月',     furigana: 'こんげつ', en: 'this month' },
    { kanji: '直近',     furigana: 'ちょっきん', en: 'most recent (e.g., 直近 30 日 = last 30 days)' },
    { kanji: '取得',     furigana: 'しゅとく', en: 'acquire / fetch (e.g., FX rate fetch)' },
    { kanji: '更新',     furigana: 'こうしん', en: 'refresh / update' },
    { kanji: '権限',     furigana: 'けんげん', en: 'permission / authority (workspace permissions)' },
    { kanji: '無効',     furigana: 'むこう', en: 'disabled / invalid' },
    { kanji: '有効',     furigana: 'ゆうこう', en: 'enabled / valid' },
    { kanji: '設定',     furigana: 'せってい', en: 'settings / configuration' },
    { kanji: '経過',     furigana: 'けいか', en: 'elapsed (e.g., days since key was set)' },
    { kanji: '拒否',     furigana: 'きょひ', en: 'reject / deny' },
    { kanji: '脱退一時金', furigana: 'だったいいちじきん', en: 'JP pension lump-sum withdrawal (within 5y of leaving Japan)' },
    { kanji: '年金事務所', furigana: 'ねんきんじむしょ', en: 'JP pension office (Japan Pension Service local branch)' },
    { kanji: '加入証明', furigana: 'かにゅうしょうめい', en: 'coverage certificate (totalization treaty)' },
    { kanji: '任意加入', furigana: 'にんいかにゅう', en: 'voluntary JP pension enrollment (typically ages 60-65)' },
    { kanji: '特例任意加入', furigana: 'とくれいにんいかにゅう', en: 'special voluntary enrollment (extends to age 70 to clear 10y vesting hurdle)' },
    { kanji: '合算対象期間', furigana: 'がっさんたいしょうきかん', en: 'complementary period (counted for vesting only, for naturalized/PR holders)' },
    { kanji: '追納',     furigana: 'ついのう', en: 'back-payment of formally-exempted JP pension contributions (10y window)' },
    { kanji: '時効',     furigana: 'じこう', en: 'statute of limitations (2y standard for late JP pension payment)' },
    { kanji: '免除',     furigana: 'めんじょ', en: 'exemption (income-based JP pension premium waiver)' },
    { kanji: '学生納付特例', furigana: 'がくせいのうふとくれい', en: 'student-deferral special (JP pension premium deferral)' },
    { kanji: '社会保険料控除', furigana: 'しゃかいほけんりょうこうじょ', en: 'social insurance premium deduction (no cap on JP income)' },
    { kanji: '雑所得',   furigana: 'ざつしょとく', en: 'miscellaneous income (JP tax category for pension benefits)' },
    { kanji: '年金ネット', furigana: 'ねんきんネット', en: 'Nenkin Net — online JP pension contribution record portal' },
    { kanji: '帰化',     furigana: 'きか', en: 'naturalization (acquiring Japanese citizenship)' },
    { kanji: 'カラ期間', furigana: 'カラきかん', en: 'カラ期間 — informal name for 合算対象期間 (complementary period)' },
    { kanji: '銀行業務', furigana: 'ぎんこうぎょうむ', en: 'banking operations' },
    { kanji: '中値',     furigana: 'なかね', en: 'mid-market rate (FX)' },
    { kanji: '都市計画税', furigana: 'としけいかくぜい', en: 'urban planning tax (max 0.3% on assessed value, in urbanization zones)' },
    { kanji: '相続登記',  furigana: 'そうぞくとうき', en: 'inheritance deed transfer (mandatory since April 2024 — 3y deadline)' },
    { kanji: '居住用宅地', furigana: 'きょじゅうようたくち', en: 'residential land (qualifies for 小規模宅地等の特例 80% reduction)' },
    { kanji: '空き家問題', furigana: 'あきやもんだい', en: 'vacant-house problem (untended inherited rural property)' },
    { kanji: '納税通知書', furigana: 'のうぜいつうちしょ', en: 'tax assessment / payment notice' },
    { kanji: '主たる居住', furigana: 'しゅたるきょじゅう', en: 'primary residence' },
    { kanji: '別荘',     furigana: 'べっそう', en: 'vacation home / second home' },
    { kanji: '空き家',   furigana: 'あきや', en: 'vacant house' },
    { kanji: '木造',     furigana: 'もくぞう', en: 'wood-frame construction (22y depreciation)' },
    { kanji: '鉄骨',     furigana: 'てっこつ', en: 'steel-frame construction (34y depreciation)' },
    { kanji: '軽量鉄骨', furigana: 'けいりょうてっこつ', en: 'light steel construction (27y depreciation)' },
    { kanji: '賃貸',     furigana: 'ちんたい', en: 'rental / leasing' },
    { kanji: '田舎',     furigana: 'いなか', en: 'rural area / countryside' },
    { kanji: '事業承継', furigana: 'じぎょうしょうけい', en: 'business succession' },
    { kanji: '家族信託', furigana: 'かぞくしんたく', en: 'JP family trust (for incapacity + cross-border succession)' },
    { kanji: '公証役場', furigana: 'こうしょうやくば', en: 'notary office (where 公正証書遺言 is created)' },
    { kanji: '公証人',   furigana: 'こうしょうにん', en: 'notary public (Japanese)' },
    { kanji: '法務局',   furigana: 'ほうむきょく', en: 'Legal Affairs Bureau (real-estate registry, heir certifications)' },
    { kanji: '死亡届',   furigana: 'しぼうとどけ', en: 'death notification (filed at 市役所/区役所 within 7 days)' },
    { kanji: '国庫帰属', furigana: 'こっこきぞく', en: 'escheat to the state (when no statutory heirs)' },
    { kanji: '検認',     furigana: 'けんにん', en: 'probate authentication (家庭裁判所 process; skipped with 公正証書遺言)' },
    { kanji: '民法',     furigana: 'みんぽう', en: 'Civil Code (§887, §889, §890 govern intestacy)' },
    { kanji: '遺産',     furigana: 'いさん', en: 'estate (decedent\'s assets)' },
    { kanji: '遺言',     furigana: 'ゆいごん', en: 'will (testamentary document)' },
    { kanji: '執行者',   furigana: 'しっこうしゃ', en: 'executor' },
    { kanji: '認知症',   furigana: 'にんちしょう', en: 'dementia (often triggers 家族信託 planning)' },
    { kanji: '居住用',   furigana: 'きょじゅうよう', en: 'residential (use)' },
    { kanji: '順位',     furigana: 'じゅんい', en: 'priority order (rank)' },
    { kanji: '生前贈与',   furigana: 'せいぜんぞうよ', en: 'lifetime gifting (inheritance tax mitigation)' },
    { kanji: '暦年贈与',   furigana: 'れきねんぞうよ', en: 'annual ¥1.1M tax-free gift exemption' },
    { kanji: '養子縁組',   furigana: 'ようしえんぐみ', en: 'adoption (expands statutory heirs for inheritance tax)' },
    { kanji: '年末調整',   furigana: 'ねんまつちょうせい', en: 'year-end adjustment (employer-handled tax reconciliation)' },
    { kanji: '厚生年金',   furigana: 'こうせいねんきん', en: 'kosei nenkin — Japan employee pension' },
    { kanji: '国民年金',   furigana: 'こくみんねんきん', en: 'kokumin nenkin — Japan national pension' },
    { kanji: '在留資格',   furigana: 'ざいりゅうしかく', en: 'residence status / visa category' },
    { kanji: '在留カード', furigana: 'ざいりゅうカード', en: 'residence card (issued to mid-long-term residents)' },
    { kanji: '普通預金',   furigana: 'ふつうよきん', en: 'futsu yokin — Japan ordinary savings account' },
    { kanji: '当座預金',   furigana: 'とうざよきん', en: 'toza yokin — Japan checking account' },
    { kanji: '定期預金',   furigana: 'ていきよきん', en: 'teiki yokin — Japan time deposit' },
    { kanji: '定額貯金',   furigana: 'ていがくちょきん', en: 'teigaku chokin — Japan Post fixed-amount savings' },
    { kanji: '据置期間',   furigana: 'すえおききかん', en: 'lockup period (sueokkikan)' },
    { kanji: '給与所得',   furigana: 'きゅうよしょとく', en: 'employment income (kyūyo shotoku)' },
    { kanji: '繰延報酬',   furigana: 'くりのべほうしゅう', en: 'deferred compensation' },
    { kanji: '路線価',     furigana: 'ろせんか', en: 'NTA-published per-square-meter land valuation (typ. 70-80% of market)' },
    { kanji: '公示地価',   furigana: 'こうじちか', en: 'publicly assessed land price (annual gov\'t reference)' },
    { kanji: '投資信託',   furigana: 'とうししんたく', en: 'toshi shintaku — Japan mutual fund (PFIC trap for US persons)' },
    { kanji: 'ふるさと納税', furigana: 'ふるさとのうぜい', en: 'Furusato Nozei — hometown tax donation system' },
    { kanji: '個人事業主', furigana: 'こじんじぎょうぬし', en: 'sole proprietor / self-employed' },
    { kanji: '不動産取得税', furigana: 'ふどうさんしゅとくぜい', en: 'real estate acquisition tax' },
    { kanji: '固定資産税', furigana: 'こていしさんぜい', en: 'fixed asset tax (annual property tax)' },
    { kanji: '相続放棄',   furigana: 'そうぞくほうき', en: 'inheritance renunciation (3-month deadline)' },
    { kanji: '相続税',     furigana: 'そうぞくぜい', en: 'sozokuze — Japanese inheritance tax (10-55% progressive)' },
    { kanji: '法定相続人', furigana: 'ほうていそうぞくにん', en: 'statutory heirs (drives base deduction)' },
    { kanji: '名義変更',   furigana: 'めいぎへんこう', en: 'name change / title transfer' },
    { kanji: '受取人',     furigana: 'うけとりにん', en: 'beneficiary / recipient' },
    { kanji: '寄附金',     furigana: 'きふきん', en: 'charitable donation' },
    { kanji: '所得税',     furigana: 'しょとくぜい', en: 'shotokuze — income tax' },
    { kanji: '満了日',     furigana: 'まんりょうび', en: 'expiry date (manryōbi)' },
    { kanji: '学資保険',   furigana: 'がくしほけん', en: 'gakushi hoken — children\'s education insurance (PFIC trap for US persons)' },
    { kanji: '民事信託',   furigana: 'みんじしんたく', en: 'private (family) trust' },
    { kanji: '永住権',     furigana: 'えいじゅうけん', en: 'permanent residency (immigration status)' },
    { kanji: '永住者',     furigana: 'えいじゅうしゃ', en: 'permanent resident — also Japan tax-permanent status (year 6+)' },
    { kanji: '非永住者',   furigana: 'ひえいじゅうしゃ', en: 'non-permanent resident (Japan tax status, years 1-5)' },
    { kanji: '定住者',     furigana: 'ていじゅうしゃ', en: 'Long-Term Resident visa category (Nikkei descendants, post-divorce JP-spouse, etc.)' },
    { kanji: '就労ビザ',   furigana: 'しゅうろうビザ', en: 'work visa (Engineer/Specialist in Humanities/etc.)' },
    { kanji: '配偶者',     furigana: 'はいぐうしゃ', en: 'spouse' },
    { kanji: '古民家',     furigana: 'こみんか', en: 'kominka — traditional Japanese folk house' },
    { kanji: '退役軍人',   furigana: 'たいえきぐんじん', en: 'military veteran' },
    { kanji: '現役',       furigana: 'げんえき', en: 'active duty (currently serving)' },
    { kanji: '退役',       furigana: 'たいえき', en: 'retired (military)' },
    { kanji: '予備役',     furigana: 'よびえき', en: 'reserve forces' },
    { kanji: '州兵',       furigana: 'しゅうへい', en: 'National Guard' },
    { kanji: '除隊',       furigana: 'じょたい', en: 'separation / discharge from military' },
    { kanji: '従軍',       furigana: 'じゅうぐん', en: 'military service' },
    { kanji: '障害認定',   furigana: 'しょうがいにんてい', en: 'disability rating (e.g., VA rating)' },
    { kanji: '退職',       furigana: 'たいしょく', en: 'retirement (civilian)' },
    { kanji: '自営',       furigana: 'じえい', en: 'self-employed' },
    { kanji: '経営者',     furigana: 'けいえいしゃ', en: 'business owner' },
    { kanji: '駐在',       furigana: 'ちゅうざい', en: 'overseas posting / expat assignment' },
    { kanji: '国防総省',   furigana: 'こくぼうそうしょう', en: 'US Department of Defense (DoD)' },
    { kanji: '文官',       furigana: 'ぶんかん', en: 'civilian (government employee)' },
    { kanji: '契約職員',   furigana: 'けいやくしょくいん', en: 'contract employee' },
    { kanji: '米系企業',   furigana: 'べいけいきぎょう', en: 'US-affiliated company' },
    { kanji: '日系企業',   furigana: 'にっけいきぎょう', en: 'Japanese-affiliated company' },
    { kanji: '米軍',       furigana: 'べいぐん', en: 'US military' },
    { kanji: '米国',       furigana: 'べいこく', en: 'United States' },
    { kanji: '二重国籍',   furigana: 'にじゅうこくせき', en: 'dual citizenship' },
    { kanji: '国籍',       furigana: 'こくせき', en: 'citizenship / nationality' },
    { kanji: '居住者',     furigana: 'きょじゅうしゃ', en: 'resident' },
    { kanji: '居住',       furigana: 'きょじゅう', en: 'residence (act of living somewhere)' },
    { kanji: '申告',       furigana: 'しんこく', en: 'tax filing / declaration' },
    { kanji: '二次相続',   furigana: 'にじそうぞく', en: 'secondary inheritance (when surviving spouse dies)' },
    { kanji: '不動産',     furigana: 'ふどうさん', en: 'real estate' },
    { kanji: '相続人',     furigana: 'そうぞくにん', en: 'heir(s)' },
    { kanji: '被相続人',   furigana: 'ひそうぞくにん', en: 'decedent / deceased' },
    { kanji: '基礎控除',   furigana: 'きそこうじょ', en: 'basic deduction (¥30M + ¥6M × heirs for inheritance tax)' },
    { kanji: '出国税',     furigana: 'しゅっこくぜい', en: 'shukokuze — Japan exit tax (¥100M+ securities)' },
    { kanji: '年金所得',   furigana: 'ねんきんしょとく', en: 'pension income' },
    { kanji: '配当所得',   furigana: 'はいとうしょとく', en: 'dividend income' },
    { kanji: '譲渡所得',   furigana: 'じょうとしょとく', en: 'capital gains income' },
    { kanji: '一般住宅',   furigana: 'いっぱんじゅうたく', en: 'standard residential housing' },
    { kanji: '省エネ住宅', furigana: 'しょうエネじゅうたく', en: 'energy-efficient housing' },
    { kanji: '住民票',     furigana: 'じゅうみんひょう', en: 'juminhyou — Japanese resident registration' },
    { kanji: '住民税',     furigana: 'じゅうみんぜい', en: 'juminze — resident tax (~10%)' },
    { kanji: '退職所得',   furigana: 'たいしょくしょとく', en: 'retirement / lump-sum income' },
    { kanji: '税理士',     furigana: 'ぜいりし', en: 'zeirishi — licensed Japanese tax accountant' },
    { kanji: '行政書士',   furigana: 'ぎょうせいしょし', en: 'gyōseishoshi — administrative scrivener (immigration paperwork)' },
    { kanji: '司法書士',   furigana: 'しほうしょし', en: 'shihōshoshi — judicial scrivener (real estate registration, succession)' },
    { kanji: '弁護士',     furigana: 'べんごし', en: 'bengoshi — attorney' },
    { kanji: '税務署',     furigana: 'ぜいむしょ', en: 'zeimusho — local tax office (where 確定申告 is filed)' },
    { kanji: '国税庁',     furigana: 'こくぜいちょう', en: 'kokuzeicho — National Tax Agency of Japan' },
    { kanji: '市役所',     furigana: 'しやくしょ', en: 'city hall (where 住民票 / 戸籍 are filed)' },
    { kanji: '区役所',     furigana: 'くやくしょ', en: 'ward office (city-equivalent in Tokyo 23 wards)' },
    { kanji: '通帳',       furigana: 'つうちょう', en: 'tsucho — Japanese bank passbook' },
    { kanji: '戸籍',       furigana: 'こせき', en: 'koseki — Japanese family register' },
    { kanji: '謄本',       furigana: 'とうほん', en: 'certified copy (of 戸籍 etc.)' },
    { kanji: '抄本',       furigana: 'しょうほん', en: 'extract / abridged copy' },
    { kanji: '印鑑',       furigana: 'いんかん', en: 'inkan — registered seal' },
    { kanji: '実印',       furigana: 'じついん', en: 'jitsu-in — registered personal seal (legal weight)' },
    // 2-char standalones — placed AFTER all containing compounds so
    // longer matches always win the regex race.
    { kanji: '控除',       furigana: 'こうじょ', en: 'tax deduction / credit (kojo)' },
    { kanji: '年金',       furigana: 'ねんきん', en: 'pension / annuity' },
    { kanji: '会社',       furigana: 'かいしゃ', en: 'company / corporation' },
    { kanji: '所得',       furigana: 'しょとく', en: 'income (shotoku)' },
    { kanji: '令和',       furigana: 'れいわ', en: 'Reiwa era (2019–present)' },
    { kanji: '平成',       furigana: 'へいせい', en: 'Heisei era (1989–2019)' },
    { kanji: '昭和',       furigana: 'しょうわ', en: 'Showa era (1926–1989)' },
    { kanji: '対岸',       furigana: 'たいがん', en: 'taigan — the opposite shore' },
    // 「対岸の火事」(taigan no kaji) appears in the About page and
    // glossary copy — annotate the second half too so users without
    // any JP reading skill see the full reading.
    { kanji: '火事',       furigana: 'かじ', en: 'kaji — fire / house fire' },
  ];

  // Pre-built combined regex (longest-first to avoid partial matches).
  const _jpRe = new RegExp(JP_TERMS.map((t) => t.kanji).join('|'), 'g');

  // Walk all text nodes inside `root`, wrapping known JP terms in ruby elements.
  // Safe to call multiple times — already-annotated nodes are skipped.
  // Uses plain recursion instead of TreeWalker to avoid NodeFilter
  // object compatibility quirks across browser versions.
  function annotateJpTerms(root) {
    if (!root) return;

    function processNode(node) {
      // Text node — the actual replacement target.
      if (node.nodeType === 3) {
        const text = node.textContent;
        _jpRe.lastIndex = 0;
        if (!_jpRe.test(text)) { _jpRe.lastIndex = 0; return; }
        _jpRe.lastIndex = 0;

        const p = node.parentElement;
        if (!p) return;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'RT' ||
            tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (p.closest('ruby')) return;

        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        while ((m = _jpRe.exec(text)) !== null) {
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const term = JP_TERMS.find((t) => t.kanji === m[0]);
          const ruby = document.createElement('ruby');
          ruby.className = 'tb-jp';
          ruby.setAttribute('data-jp-en', term.en);
          ruby.appendChild(document.createTextNode(m[0]));
          const rt = document.createElement('rt');
          rt.textContent = term.furigana;
          ruby.appendChild(rt);
          frag.appendChild(ruby);
          last = m.index + m[0].length;
        }
        _jpRe.lastIndex = 0;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        if (node.parentNode) node.parentNode.replaceChild(frag, node);
        return;
      }

      // Element node — recurse into children. Snapshot the list first
      // because replaceChild inside the recursion modifies childNodes.
      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'RT' ||
            tag === 'RUBY' || tag === 'INPUT' || tag === 'TEXTAREA') return;
        const children = Array.from(node.childNodes);
        for (let i = 0; i < children.length; i++) processNode(children[i]);
      }
    }

    processNode(root);
  }

  // ====================================================================
  // Print helpers
  // ====================================================================
  //
  // printCard(cardEl) prints just one card by:
  //   1. Marking the body as data-print-only (CSS hides everything else)
  //   2. Marking the target card as data-print-target
  //   3. Calling window.print()
  //   4. Cleaning up after the print dialog closes
  //
  // The data-print-target marker has to be on a direct child of .tb-main
  // for the CSS selector to work. If cardEl is nested deeper, walk up
  // to the nearest direct child of .tb-main.
  function printCard(cardEl) {
    if (!cardEl) return;
    // Find the nearest direct child of .tb-main
    let target = cardEl;
    while (target && target.parentElement && !target.parentElement.classList.contains('tb-main')) {
      target = target.parentElement;
    }
    if (!target) target = cardEl;

    document.body.setAttribute('data-print-only', '');
    target.setAttribute('data-print-target', '');

    function cleanup() {
      document.body.removeAttribute('data-print-only');
      target.removeAttribute('data-print-target');
      window.removeEventListener('afterprint', cleanup);
    }
    window.addEventListener('afterprint', cleanup);
    // Belt-and-suspenders for browsers that don't fire afterprint:
    // also clean up on a setTimeout fallback.
    setTimeout(() => {
      // Only clean up if afterprint hasn't already
      if (document.body.hasAttribute('data-print-only')) cleanup();
    }, 5000);

    window.print();
  }

  // Helper to build a "🖨 Print" button for a card. Pass `() => containerEl`
  // (deferred so the DOM is ready) or the card element directly.
  function printButton(cardElOrFn, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-btn tb-btn--ghost';
    btn.style.padding = '4px 12px';
    btn.style.fontSize = 'var(--tb-fs-12)';
    btn.setAttribute('data-print-hide', '');  // hide the button itself when printing
    btn.textContent = '🖨 ' + (label || 'Print');
    btn.addEventListener('click', () => {
      const cardEl = typeof cardElOrFn === 'function' ? cardElOrFn() : cardElOrFn;
      printCard(cardEl);
    });
    return btn;
  }

  window.TB = window.TB || {};
  window.TB.utils = {
    formatUSD, formatJPY, formatPercent, formatDate,
    isoDate, pad, uuid, shortId, escapeHtml,
    downloadFile, readFileAsText, sha256, getFxRate, el,
    annotateJpTerms,
    fetchCurrentTreasuryRates, fetchExchangerateHost, refreshCurrentFx,
    refreshLiveFx, getLiveJpyRate,
    buildSlider, attachFileDrop,
    printCard, printButton,
    FX_FALLBACK,
  };
})();
