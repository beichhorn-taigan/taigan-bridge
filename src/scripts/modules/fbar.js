/* Taigan Bridge — modules/fbar.js (v0.2.1)
 *
 * FBAR (FinCEN Form 114) tracker. Multi-filer household with
 * normalized tables under state.fbar:
 *
 *   filers[]            — household members who file (or might file)
 *   accounts[]          — foreign financial accounts
 *   yearly_balances[]   — one row per (account_id, year)
 *   filing_history[]    — confirmation of past filings
 *
 * Five sub-views, navigated by tabs:
 *   1. Overview       — at-a-glance threshold status by filer × year
 *   2. Filers         — manage household members
 *   3. Accounts       — manage foreign financial accounts
 *   4. Yearly Balances— core data entry; max balance per account-year
 *   5. Print Summary  — A4 printable per-filer-per-year deliverable
 *
 * Privacy posture:
 *   - SSN: last 4 digits only (the full number is required at the
 *     actual filing, not here).
 *   - Account number: full number stored locally (never transmitted),
 *     last 4 displayed by default with reveal-on-click.
 *   - AI integration: TB.ai.summarizeFbarForAi() returns category
 *     counts only — never raw account numbers, balances, or names.
 *
 * Threshold rule:
 *   FBAR is required if at any point during the calendar year the
 *   AGGREGATE max value across ALL the filer's foreign financial
 *   accounts EXCEEDED $10,000 USD. Joint accounts: each U.S. person
 *   joint owner reports the FULL account value. Signature authority
 *   without financial interest still triggers reporting.
 */

(function () {
  'use strict';

  const id = 'fbar';
  const REQUIRED_DISCLAIMER_VERSION = 'v0.2.1';
  const FBAR_THRESHOLD_USD = 10000;

  // ====================================================================
  // Treasury Year-End Reporting Rates of Exchange
  // ====================================================================
  //
  // FBAR converts each account's maximum value using the U.S. Treasury
  // year-end (Dec 31) Reporting Rate of Exchange for the filing year.
  //
  // Runtime source of truth: the OFFICIAL rates are auto-fetched from the
  // Treasury Fiscal Data API when this module opens (maybeAutoRefreshTreasury
  // below) and stored in state.settings.fx.treasury_rates; fxRateFor()
  // prefers those over the table below.
  //
  // TREASURY_FX is the OFFLINE FALLBACK — used before the live fetch
  // completes or when offline. It comes from constants.js
  // (TB.constants.TREASURY_FX_FALLBACK), where the values are corrected
  // and source-stamped (JPY exact for every year; see docs/CLAIM-LEDGER.md).
  //
  // Convention: foreign currency units per 1 USD (e.g., USD/JPY = 152
  // means 1 USD = 152 JPY; convert JPY → USD by dividing).
  // ====================================================================

  const TREASURY_FX = (window.TB && TB.constants && TB.constants.TREASURY_FX_FALLBACK) || {};

  // ISO 4217 — comprehensive list covering virtually every currency
  // a U.S. expat would plausibly hold. The Treasury Fiscal Data API
  // publishes rates for most of these. Currencies outside this list
  // can still be represented via the COUNTRY_CODES "OTHER" route, but
  // this dropdown handles ~99% of cases. Keep alphabetical so adds
  // are diff-friendly.
  const SUPPORTED_CURRENCIES = [
    'USD',
    'AED', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AZN',
    'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BWP', 'BYN', 'BZD',
    'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CVE', 'CZK',
    'DJF', 'DKK', 'DOP', 'DZD',
    'EGP', 'ETB', 'EUR',
    'FJD',
    'GBP', 'GEL', 'GHS', 'GMD', 'GNF', 'GTQ', 'GYD',
    'HKD', 'HNL', 'HTG', 'HUF',
    'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
    'JMD', 'JOD', 'JPY',
    'KES', 'KGS', 'KHR', 'KRW', 'KWD', 'KYD', 'KZT',
    'LAK', 'LBP', 'LKR', 'LRD', 'LSL',
    'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN',
    'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
    'OMR',
    'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
    'QAR',
    'RON', 'RSD', 'RUB', 'RWF',
    'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SZL',
    'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
    'UAH', 'UGX', 'UYU', 'UZS',
    'VES', 'VND', 'VUV',
    'WST',
    'XAF', 'XCD', 'XOF', 'XPF',
    'YER',
    'ZAR', 'ZMW', 'ZWL',
  ];

  // Countries where U.S. expats commonly hold accounts. Code = ISO
  // 3166-1 alpha-2. Sorted alphabetically by label except for the
  // top three (JP / US / GB) which surface first because they cover
  // the bulk of users. "OTHER" is the catch-all fallback.
  const COUNTRY_CODES = [
    { code: 'JP', label: 'Japan' },
    { code: 'US', label: 'United States' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'AE', label: 'United Arab Emirates' },
    { code: 'AR', label: 'Argentina' },
    { code: 'AT', label: 'Austria' },
    { code: 'AU', label: 'Australia' },
    { code: 'BD', label: 'Bangladesh' },
    { code: 'BE', label: 'Belgium' },
    { code: 'BR', label: 'Brazil' },
    { code: 'CA', label: 'Canada' },
    { code: 'CH', label: 'Switzerland' },
    { code: 'CL', label: 'Chile' },
    { code: 'CN', label: 'China' },
    { code: 'CO', label: 'Colombia' },
    { code: 'CR', label: 'Costa Rica' },
    { code: 'CZ', label: 'Czech Republic' },
    { code: 'DE', label: 'Germany' },
    { code: 'DK', label: 'Denmark' },
    { code: 'DO', label: 'Dominican Republic' },
    { code: 'EC', label: 'Ecuador' },
    { code: 'EG', label: 'Egypt' },
    { code: 'ES', label: 'Spain' },
    { code: 'FI', label: 'Finland' },
    { code: 'FR', label: 'France' },
    { code: 'GR', label: 'Greece' },
    { code: 'GT', label: 'Guatemala' },
    { code: 'HK', label: 'Hong Kong' },
    { code: 'HU', label: 'Hungary' },
    { code: 'ID', label: 'Indonesia' },
    { code: 'IE', label: 'Ireland' },
    { code: 'IL', label: 'Israel' },
    { code: 'IN', label: 'India' },
    { code: 'IS', label: 'Iceland' },
    { code: 'IT', label: 'Italy' },
    { code: 'JM', label: 'Jamaica' },
    { code: 'KE', label: 'Kenya' },
    { code: 'KH', label: 'Cambodia' },
    { code: 'KR', label: 'Korea' },
    { code: 'KW', label: 'Kuwait' },
    { code: 'LK', label: 'Sri Lanka' },
    { code: 'LU', label: 'Luxembourg' },
    { code: 'MA', label: 'Morocco' },
    { code: 'MT', label: 'Malta' },
    { code: 'MX', label: 'Mexico' },
    { code: 'MY', label: 'Malaysia' },
    { code: 'NG', label: 'Nigeria' },
    { code: 'NL', label: 'Netherlands' },
    { code: 'NO', label: 'Norway' },
    { code: 'NP', label: 'Nepal' },
    { code: 'NZ', label: 'New Zealand' },
    { code: 'PA', label: 'Panama' },
    { code: 'PE', label: 'Peru' },
    { code: 'PH', label: 'Philippines' },
    { code: 'PK', label: 'Pakistan' },
    { code: 'PL', label: 'Poland' },
    { code: 'PT', label: 'Portugal' },
    { code: 'QA', label: 'Qatar' },
    { code: 'RO', label: 'Romania' },
    { code: 'RU', label: 'Russia' },
    { code: 'SA', label: 'Saudi Arabia' },
    { code: 'SE', label: 'Sweden' },
    { code: 'SG', label: 'Singapore' },
    { code: 'TH', label: 'Thailand' },
    { code: 'TR', label: 'Turkey' },
    { code: 'TW', label: 'Taiwan' },
    { code: 'UA', label: 'Ukraine' },
    { code: 'UG', label: 'Uganda' },
    { code: 'UY', label: 'Uruguay' },
    { code: 'VE', label: 'Venezuela' },
    { code: 'VN', label: 'Vietnam' },
    { code: 'ZA', label: 'South Africa' },
    { code: 'OTHER', label: 'Other / not listed' },
  ];

  // ====================================================================
  // Late-filing explanation templates (FinCEN Form 114, "Other" reason)
  // ====================================================================
  //
  // The BSA E-Filing portal caps the Explanation field at 750 characters.
  // Each template below is < 750 chars and reads as a self-contained
  // narrative when pasted verbatim. Categories are auto-detected from
  // the filer record (relationship + isMinor) but the user can override.
  //
  // The narratives are intentionally generic ("the filer", not a name)
  // so they don't leak more PII into the form than necessary; FinCEN
  // already has the filer's identity from Part I. Templates remain in
  // English regardless of UI language — the BSA E-Filing form is in
  // English and the Explanation field is read by FinCEN reviewers.
  // ====================================================================

  const LATE_FILING_CATEGORIES = ['minor_in_japan', 'adult_us_in_japan', 'adult_us_dual_national', 'spouse_no_signature', 'custom'];

  const LATE_FILING_TEMPLATES = {
    minor_in_japan:
      "The filer is a minor residing in Japan and holds local Japanese financial accounts for routine living and savings. " +
      "The accounts are managed by the filer's non-U.S. parent (Japanese citizen). " +
      "The filer was unaware of U.S. FBAR reporting requirements for foreign financial accounts. " +
      "The U.S. parent had no signature authority over the accounts. " +
      "These accounts were maintained in Japan, where the filer resides, and were not established for any purpose of concealment. " +
      "Upon becoming aware of the obligation, the filer (with assistance) is submitting all required FBARs promptly. " +
      "There was no intent to conceal or misreport information.",

    adult_us_in_japan:
      "The filer is a U.S. person residing long-term in Japan. " +
      "The accounts are routine local Japanese accounts maintained for everyday living, salary deposits, and savings at the filer's place of residence. " +
      "The filer was unaware of the U.S. FBAR reporting requirement for foreign financial accounts until recently. " +
      "The accounts were not established for any purpose of concealment, were never moved or restructured to evade reporting, and produced no significant U.S. tax liability. " +
      "Upon becoming aware of the obligation, the filer is submitting all required FBARs promptly. " +
      "There was no intent to conceal or misreport information.",

    adult_us_dual_national:
      "The filer is a U.S. person by birth who has resided primarily in Japan for most of their life and holds Japanese tax residency. " +
      "All accounts in question are routine local Japanese accounts maintained at the filer's permanent residence for everyday living and savings. " +
      "The filer was unaware of the U.S. FBAR reporting requirement for foreign financial accounts. " +
      "The accounts were not established for any purpose of concealment and produced no significant U.S. tax liability. " +
      "Upon becoming aware, the filer is submitting all required FBARs promptly. " +
      "There was no intent to conceal or misreport information.",

    spouse_no_signature:
      "The filer is a U.S. person residing in Japan whose spouse is a non-U.S. person (Japanese citizen). " +
      "The accounts in question are jointly held or were opened in the spouse's name; the filer either has signature authority added for household convenience or is named as a joint owner. " +
      "The accounts are maintained at the filer's place of residence in Japan for routine living and savings. " +
      "The filer was unaware of the FBAR reporting requirement. " +
      "The accounts were not established for concealment. " +
      "Upon becoming aware, the filer is submitting all required FBARs promptly. " +
      "There was no intent to conceal.",

    custom: '',
  };

  const LATE_FILING_EXPLANATION_LIMIT = 750;

  function autoDetectLateFilingCategory(filer) {
    if (!filer) return 'custom';
    if (filer.isMinor) return 'minor_in_japan';
    if (filer.relationship === 'spouse') return 'spouse_no_signature';
    if (filer.relationship === 'self') return 'adult_us_in_japan';
    return 'custom';
  }

  // ====================================================================
  // Module-local UI state
  // ====================================================================

  let host = null;
  let activeTab = 'overview';
  let activeYear = null;
  let printState = { filerId: '', year: '' };
  let filingState = { filerId: '', year: '' };
  let revealedAccountNumbers = {};   // { [accountId]: bool }, per-session
  let dismissedBanners = {};          // { fxUnverified: bool, encryption: bool }, per-session
  let accountFilters = { filerId: '', year: '', currency: '' };
  let balancesFilterFilerId = '';     // '' = all filers
  let lastUploadFilerIds = [];        // sticky default for the upload filer chooser
  let jointUiRevealed = {};           // { [accountId]: bool } — transient "joint" toggle state for the redesigned owners section

  // ====================================================================
  // State accessors (normalized table I/O)
  // ====================================================================

  function getFilers()           { return TB.state.get('fbar.filers') || []; }
  function getAccounts()         { return TB.state.get('fbar.accounts') || []; }
  function getBalances()         { return TB.state.get('fbar.yearly_balances') || []; }
  function getFilingHistory()    { return TB.state.get('fbar.filing_history') || []; }

  function setFilers(arr)        { TB.state.set('fbar.filers', arr); }
  function setAccounts(arr)      { TB.state.set('fbar.accounts', arr); }
  function setBalances(arr)      { TB.state.set('fbar.yearly_balances', arr); }
  function setFilingHistory(arr) { TB.state.set('fbar.filing_history', arr); }

  function findFiler(id)   { return getFilers().find(f => f.id === id) || null; }
  function findAccount(id) { return getAccounts().find(a => a.id === id) || null; }

  function blankFiler() {
    return {
      id: TB.utils.uuid(),
      name_en: '',
      name_jp: '',
      ssn_last4: '',
      dob: '',
      relationship: 'self',
      isMinor: false,
      isUSPerson: true,
      filing_address: '',
      notes: '',
    };
  }

  function blankAccount() {
    return {
      id: TB.utils.uuid(),
      filer_ids: [],
      account_type: 'bank',
      institution_name: '',         // English / romanized form (used on FBAR)
      institution_name_jp: '',      // Japanese form (kanji/katakana, optional)
      institution_address: '',      // English / romanized form (used on FBAR)
      institution_address_jp: '',   // Japanese form (optional)
      account_number_full: '',
      currency: 'JPY',
      country: 'JP',
      opened_year: null,
      closed_year: null,
      signatory_only: false,
      notes: '',
    };
  }

  function blankBalance(accountId, year) {
    return {
      id: TB.utils.uuid(),
      account_id: accountId,
      year: year,
      max_balance_native: null,
      max_balance_date: '',
      fx_rate_used: null,
      fx_rate_source: '',
      fx_rate_overridden: false,
      max_balance_usd: null,
      notes: '',
    };
  }

  // True if the string contains any kanji or kana — used to route
  // a single extracted institution_name to the correct field.
  function containsJapanese(s) {
    if (!s) return false;
    // Hiragana, Katakana, CJK Unified Ideographs (kanji)
    return /[぀-ヿ㐀-䶿一-鿿]/.test(String(s));
  }

  function masked(accountNumberFull) {
    if (!accountNumberFull) return '';
    const trimmed = String(accountNumberFull).replace(/\s+/g, '');
    if (trimmed.length <= 4) return '****' + trimmed;
    return '****' + trimmed.slice(-4);
  }

  // ====================================================================
  // Year helpers
  // ====================================================================

  function defaultYear() {
    // Default to the most recently completed calendar year — that's
    // the FBAR year currently in scope between Jan 1 and Oct 15 of
    // the following year.
    const now = new Date();
    return String(now.getUTCFullYear() - 1);
  }

  function knownYears() {
    const years = new Set();
    for (const b of getBalances()) years.add(String(b.year));
    for (const a of getAccounts()) {
      if (a.opened_year) years.add(String(a.opened_year));
      if (a.closed_year) years.add(String(a.closed_year));
    }
    Object.keys(TREASURY_FX).forEach(y => years.add(y));
    if (years.size === 0) years.add(defaultYear());
    return Array.from(years).sort().reverse();
  }

  function recentSixYears() {
    // For Overview heatmap. Always show six years ending at default.
    const end = parseInt(defaultYear(), 10);
    const out = [];
    for (let y = end; y > end - 6; y--) out.push(String(y));
    return out;
  }

  function isAccountActiveInYear(account, year) {
    const y = parseInt(year, 10);
    if (account.opened_year && parseInt(account.opened_year, 10) > y) return false;
    if (account.closed_year && parseInt(account.closed_year, 10) < y) return false;
    // Fallback when opened_year is missing: treat the earliest year
    // for which the account has a NON-NULL balance entry as a soft
    // floor. This prevents accounts uploaded for years 2025-2026 from
    // appearing in 2012's balance table just because no opening date
    // was visible on the document. Placeholder balance rows (created
    // on demand by buildBalanceRow with max_balance_native = null) do
    // NOT count, so the floor is data-driven, not view-driven.
    if (!account.opened_year) {
      const balances = getBalances();
      let earliest = null;
      for (const b of balances) {
        if (b.account_id !== account.id) continue;
        if (b.max_balance_native == null) continue;
        const by = parseInt(b.year, 10);
        if (!isFinite(by)) continue;
        if (earliest === null || by < earliest) earliest = by;
      }
      if (earliest !== null && earliest > y) return false;
    }
    return true;
  }

  function fxRateFor(currency, year) {
    if (currency === 'USD') return { rate: 1, source: 'USD' };
    const yr = String(year);
    // Prefer live rates fetched from the Treasury Fiscal Data API
    // and stored in state.settings.fx.treasury_rates.
    const stateFx = (TB.state.get('settings.fx.treasury_rates') || {})[yr];
    if (stateFx && typeof stateFx[currency] === 'number') {
      const fetchedAt = TB.state.get('settings.fx.treasury_fetched_at');
      const stamp = fetchedAt ? String(fetchedAt).slice(0, 10) : '';
      return {
        rate: stateFx[currency],
        source: 'Treasury Year-End ' + year + (stamp ? ' (fetched ' + stamp + ')' : ''),
      };
    }
    // Fall back to the offline table (constants.js). JPY is the exact
    // official rate; refresh from Treasury for official non-JPY rates.
    const table = TREASURY_FX[yr];
    if (!table) return { rate: null, source: '' };
    const r = table[currency];
    if (!r) return { rate: null, source: '' };
    return { rate: r, source: 'Treasury Year-End ' + year + ' (offline fallback)' };
  }

  // ====================================================================
  // Treasury Fiscal Data API — live FX rate fetch
  // ====================================================================
  //
  // Endpoint: https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange
  // Free, public, CORS-enabled. Returns "Reporting Rates of
  // Exchange" — the rates the U.S. Treasury publishes quarterly.
  // FBAR uses the December 31 (year-end) rate of the reporting year.
  //
  // Treasury's `country_currency_desc` field is human-readable
  // (e.g., "JAPAN-YEN") rather than ISO 4217. We map a curated
  // subset back to ISO codes.
  // ====================================================================

  const TREASURY_API = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange';

  // Treasury description → ISO 4217. The Fiscal Data API returns
  // entries keyed by `country_currency_desc` like "JAPAN-YEN" rather
  // than ISO codes, so we map them back. Descriptions vary slightly
  // in punctuation / wording across years; the fuzzy matcher in
  // descToCurrency() handles that. Goal: cover every currency in
  // SUPPORTED_CURRENCIES, plus common synonyms.
  const TREASURY_CURRENCY_MAP = {
    // Core (most-used)
    'JAPAN-YEN': 'JPY',
    'EURO ZONE-EURO': 'EUR',
    'UNITED KINGDOM-POUND STERLING': 'GBP',
    'UNITED KINGDOM-POUND': 'GBP',
    'CANADA-DOLLAR': 'CAD',
    'AUSTRALIA-DOLLAR': 'AUD',
    'SWITZERLAND-FRANC': 'CHF',
    'SINGAPORE-DOLLAR': 'SGD',
    'HONG KONG-DOLLAR': 'HKD',
    'KOREA-WON': 'KRW',
    'KOREA (SOUTH)-WON': 'KRW',
    'CHINA-RENMINBI': 'CNY',
    'CHINA-YUAN': 'CNY',
    'NEW ZEALAND-DOLLAR': 'NZD',
    'THAILAND-BAHT': 'THB',
    'MEXICO-PESO': 'MXN',
    'MEXICO-NEW PESO': 'MXN',
    'BRAZIL-REAL': 'BRL',
    'BRAZIL-CRUZEIRO REAL': 'BRL',
    // Nordics
    'NORWAY-KRONE': 'NOK',
    'SWEDEN-KRONA': 'SEK',
    'DENMARK-KRONE': 'DKK',
    'ICELAND-KRONA': 'ISK',
    // Middle East
    'ISRAEL-SHEKEL': 'ILS',
    'ISRAEL-NEW SHEKEL': 'ILS',
    'UNITED ARAB EMIRATES-DIRHAM': 'AED',
    'SAUDI ARABIA-RIYAL': 'SAR',
    'QATAR-RIYAL': 'QAR',
    'KUWAIT-DINAR': 'KWD',
    'BAHRAIN-DINAR': 'BHD',
    'OMAN-RIAL': 'OMR',
    'JORDAN-DINAR': 'JOD',
    'LEBANON-POUND': 'LBP',
    'IRAQ-DINAR': 'IQD',
    'YEMEN-RIAL': 'YER',
    // Asia
    'INDIA-RUPEE': 'INR',
    'PAKISTAN-RUPEE': 'PKR',
    'BANGLADESH-TAKA': 'BDT',
    'NEPAL-RUPEE': 'NPR',
    'SRI LANKA-RUPEE': 'LKR',
    'MALDIVES-RUFIYAA': 'MVR',
    'INDONESIA-RUPIAH': 'IDR',
    'MALAYSIA-RINGGIT': 'MYR',
    'PHILIPPINES-PESO': 'PHP',
    'VIETNAM-DONG': 'VND',
    'TAIWAN-DOLLAR': 'TWD',
    'TAIWAN-NEW DOLLAR': 'TWD',
    'MACAO-PATACA': 'MOP',
    'MACAU-PATACA': 'MOP',
    'CAMBODIA-RIEL': 'KHR',
    'LAOS-KIP': 'LAK',
    'MYANMAR (BURMA)-KYAT': 'MMK',
    'BURMA-KYAT': 'MMK',
    'MONGOLIA-TUGRIK': 'MNT',
    'KAZAKHSTAN-TENGE': 'KZT',
    'UZBEKISTAN-SOM': 'UZS',
    'KYRGYZSTAN-SOM': 'KGS',
    'TAJIKISTAN-SOMONI': 'TJS',
    'TURKMENISTAN-MANAT': 'TMT',
    'AZERBAIJAN-NEW MANAT': 'AZN',
    'AZERBAIJAN-MANAT': 'AZN',
    'ARMENIA-DRAM': 'AMD',
    'GEORGIA-LARI': 'GEL',
    'BRUNEI-DOLLAR': 'BND',
    'PAPUA NEW GUINEA-KINA': 'PGK',
    'FIJI-DOLLAR': 'FJD',
    'SOLOMON ISLANDS-DOLLAR': 'SBD',
    'TONGA-PA\'ANGA': 'TOP',
    'TONGA-PAANGA': 'TOP',
    'SAMOA-TALA': 'WST',
    'WESTERN SAMOA-TALA': 'WST',
    'VANUATU-VATU': 'VUV',
    'PACIFIC FRANC-FRANC': 'XPF',
    'CFP FRANC-FRANC': 'XPF',
    // Europe (non-Eurozone)
    'POLAND-ZLOTY': 'PLN',
    'CZECH REPUBLIC-KORUNA': 'CZK',
    'HUNGARY-FORINT': 'HUF',
    'ROMANIA-LEU': 'RON',
    'ROMANIA-NEW LEU': 'RON',
    'BULGARIA-LEV': 'BGN',
    'SERBIA-DINAR': 'RSD',
    'MACEDONIA-DENAR': 'MKD',
    'NORTH MACEDONIA-DENAR': 'MKD',
    'ALBANIA-LEK': 'ALL',
    'BOSNIA-MARKA': 'BAM',
    'BOSNIA AND HERZEGOVINA-MARKA': 'BAM',
    'MOLDOVA-LEU': 'MDL',
    'UKRAINE-HRYVNIA': 'UAH',
    'BELARUS-RUBLE': 'BYN',
    'BELARUS-NEW RUBLE': 'BYN',
    'RUSSIA-RUBLE': 'RUB',
    'TURKEY-LIRA': 'TRY',
    'TURKEY-NEW LIRA': 'TRY',
    // Latin America / Caribbean
    'ARGENTINA-PESO': 'ARS',
    'CHILE-PESO': 'CLP',
    'COLOMBIA-PESO': 'COP',
    'PERU-SOL': 'PEN',
    'PERU-NUEVO SOL': 'PEN',
    'VENEZUELA-BOLIVAR': 'VES',
    'VENEZUELA-BOLIVAR FUERTE': 'VES',
    'VENEZUELA-BOLIVAR SOBERANO': 'VES',
    'COSTA RICA-COLON': 'CRC',
    'DOMINICAN REPUBLIC-PESO': 'DOP',
    'GUATEMALA-QUETZAL': 'GTQ',
    'HONDURAS-LEMPIRA': 'HNL',
    'NICARAGUA-CORDOBA': 'NIO',
    'PANAMA-BALBOA': 'PAB',
    'URUGUAY-PESO': 'UYU',
    'PARAGUAY-GUARANI': 'PYG',
    'BOLIVIA-BOLIVIANO': 'BOB',
    'BELIZE-DOLLAR': 'BZD',
    'GUYANA-DOLLAR': 'GYD',
    'SURINAME-DOLLAR': 'SRD',
    'JAMAICA-DOLLAR': 'JMD',
    'TRINIDAD AND TOBAGO-DOLLAR': 'TTD',
    'TRINIDAD-DOLLAR': 'TTD',
    'BARBADOS-DOLLAR': 'BBD',
    'BAHAMAS-DOLLAR': 'BSD',
    'BERMUDA-DOLLAR': 'BMD',
    'CAYMAN ISLANDS-DOLLAR': 'KYD',
    'NETHERLANDS ANTILLES-GUILDER': 'ANG',
    'EAST CARIBBEAN-DOLLAR': 'XCD',
    'HAITI-GOURDE': 'HTG',
    'EL SALVADOR-COLON': 'SVC',
    // Africa
    'SOUTH AFRICA-RAND': 'ZAR',
    'EGYPT-POUND': 'EGP',
    'MOROCCO-DIRHAM': 'MAD',
    'TUNISIA-DINAR': 'TND',
    'ALGERIA-DINAR': 'DZD',
    'SUDAN-POUND': 'SDG',
    'SOUTH SUDAN-POUND': 'SSP',
    'ETHIOPIA-BIRR': 'ETB',
    'KENYA-SHILLING': 'KES',
    'TANZANIA-SHILLING': 'TZS',
    'UGANDA-SHILLING': 'UGX',
    'RWANDA-FRANC': 'RWF',
    'BURUNDI-FRANC': 'BIF',
    'DJIBOUTI-FRANC': 'DJF',
    'CONGO-FRANC': 'CDF',
    'CONGO, DEMOCRATIC REPUBLIC-FRANC': 'CDF',
    'NIGERIA-NAIRA': 'NGN',
    'GHANA-CEDI': 'GHS',
    'GAMBIA-DALASI': 'GMD',
    'GUINEA-FRANC': 'GNF',
    'SIERRA LEONE-LEONE': 'SLL',
    'LIBERIA-DOLLAR': 'LRD',
    'CAPE VERDE-ESCUDO': 'CVE',
    'MAURITANIA-OUGUIYA': 'MRU',
    'CENTRAL AFRICAN-FRANC': 'XAF',
    'WEST AFRICAN-FRANC': 'XOF',
    'ZAMBIA-KWACHA': 'ZMW',
    'ZIMBABWE-DOLLAR': 'ZWL',
    'MALAWI-KWACHA': 'MWK',
    'MOZAMBIQUE-METICAL': 'MZN',
    'MADAGASCAR-ARIARY': 'MGA',
    'SEYCHELLES-RUPEE': 'SCR',
    'MAURITIUS-RUPEE': 'MUR',
    'BOTSWANA-PULA': 'BWP',
    'NAMIBIA-DOLLAR': 'NAD',
    'SWAZILAND-LILANGENI': 'SZL',
    'ESWATINI-LILANGENI': 'SZL',
    'LESOTHO-LOTI': 'LSL',
    'ANGOLA-KWANZA': 'AOA',
    'SAO TOME-DOBRA': 'STN',
    'SOMALIA-SHILLING': 'SOS',
    'IRAN-RIAL': 'IRR',
  };

  function descToCurrency(desc) {
    if (!desc) return null;
    const upper = String(desc).toUpperCase().trim();
    if (TREASURY_CURRENCY_MAP[upper]) return TREASURY_CURRENCY_MAP[upper];
    // Fuzzy: split on "-" and check if either half matches.
    for (const [k, v] of Object.entries(TREASURY_CURRENCY_MAP)) {
      if (upper.startsWith(k.split('-')[0])) return v;
    }
    return null;
  }

  async function fetchTreasuryYearEnd(year) {
    const dateStr = year + '-12-31';
    const url = TREASURY_API +
      '?fields=country_currency_desc,exchange_rate,record_date' +
      '&filter=record_date:eq:' + dateStr +
      '&page[size]=200';
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error('Treasury API ' + res.status + ' for ' + dateStr);
    }
    const json = await res.json();
    const rows = (json && json.data) || [];
    const out = {};
    for (const row of rows) {
      const cur = descToCurrency(row.country_currency_desc);
      if (!cur) continue;
      const r = parseFloat(row.exchange_rate);
      if (!isFinite(r) || r <= 0) continue;
      out[cur] = r;
    }
    return out;
  }

  // Refresh Treasury rates for a list of years. Returns
  // { fetched: {year: {currency: rate}}, errors: [{year, error}] }.
  // Writes successful fetches into state.settings.fx.treasury_rates.
  async function refreshTreasuryRates(years) {
    const yearsToFetch = (years && years.length)
      ? years.slice()
      : defaultRefreshYears();
    const results = await Promise.allSettled(
      yearsToFetch.map(y => fetchTreasuryYearEnd(y).then(rates => ({ year: String(y), rates }))),
    );
    const existing = TB.state.get('settings.fx.treasury_rates') || {};
    const next = Object.assign({}, existing);
    const fetched = {};
    const errors = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const yr = String(yearsToFetch[i]);
      if (r.status === 'fulfilled') {
        if (Object.keys(r.value.rates).length > 0) {
          next[yr] = r.value.rates;
          fetched[yr] = r.value.rates;
        }
      } else {
        errors.push({ year: yr, error: String(r.reason && r.reason.message || r.reason) });
      }
    }
    TB.state.set('settings.fx.treasury_rates', next);
    TB.state.set('settings.fx.treasury_fetched_at', new Date().toISOString());
    TB.state.set('settings.fx.treasury_fetch_errors', errors);
    return { fetched, errors };
  }

  // Auto-fetch official Treasury year-end rates when the FBAR module is
  // opened, so users get correct rates without clicking Refresh. This runs
  // on module entry — NOT at app boot — which preserves the "no outbound
  // requests at boot" guarantee. Throttled to once per app load, and
  // skipped when rates were fetched within the last 7 days. Silent on
  // failure: the corrected offline fallback table (constants.js) remains.
  let autoRefreshAttempted = false;
  function maybeAutoRefreshTreasury() {
    try {
      if (autoRefreshAttempted) return;
      if (!window.TB || !TB.state) return;
      // Never auto-fetch on the hosted demo (it re-seeds; stays offline).
      if (TB.hostedDemo && TB.hostedDemo.isHostedDemo && TB.hostedDemo.isHostedDemo()) return;
      const fetchedAt = TB.state.get('settings.fx.treasury_fetched_at');
      const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
      if (fetchedAt && (Date.now() - new Date(fetchedAt).getTime()) < FRESH_MS) return;
      autoRefreshAttempted = true;
      refreshTreasuryRates().then((res) => {
        if (res && res.fetched && Object.keys(res.fetched).length) {
          // Refresh the active tab so the FX reference table shows the
          // newly-fetched official rates (no-ops if FBAR isn't mounted).
          try { renderActiveTab(); } catch (_) { /* ignore */ }
        }
      }).catch(() => { /* silent — offline fallback remains in effect */ });
    } catch (_) { /* never block render */ }
  }

  function defaultRefreshYears() {
    // Fetch every year between earliest balance year and last
    // completed calendar year (FBAR uses year-end rates; the current
    // year's December 31 rate doesn't exist until next year).
    const balances = getBalances();
    const today = new Date().getUTCFullYear();
    const lastCompleted = today - 1;
    let earliest = lastCompleted - 5;
    for (const b of balances) {
      const y = parseInt(b.year, 10);
      if (isFinite(y) && y < earliest) earliest = y;
    }
    earliest = Math.max(earliest, 2015);
    const out = [];
    for (let y = earliest; y <= lastCompleted; y++) out.push(String(y));
    return out;
  }

  // ====================================================================
  // Threshold logic — pure functions
  // ====================================================================

  /**
   * For a given filer and year, return:
   *   { aggregate_usd, threshold, status, contributing_accounts, warnings }
   *
   * status ∈ {"under", "at_or_over", "insufficient_data", "not_us_person", "no_filer"}
   *
   * Rules:
   * - Aggregate sums max_balance_usd across ALL accounts where
   *   filer.id ∈ account.filer_ids, regardless of joint status.
   *   For joint accounts, the FULL account value counts for each
   *   joint US-person owner (FBAR rule).
   * - US accounts (account.country === 'US') are tracked but
   *   excluded from the FBAR aggregate.
   * - If any active account is missing a balance entry for the
   *   year, the result is "insufficient_data" (unless balances
   *   present already exceed threshold — in that case the verdict
   *   is still "at_or_over" since adding more would only raise it).
   * - Filers with isUSPerson: false are not subject to FBAR;
   *   status returns "not_us_person" with aggregate_usd: 0.
   */
  function thresholdStatus(filerId, year) {
    const filer = findFiler(filerId);
    if (!filer) {
      return { status: 'no_filer', aggregate_usd: 0, threshold: FBAR_THRESHOLD_USD, contributing_accounts: [], warnings: [] };
    }
    if (!filer.isUSPerson) {
      return { status: 'not_us_person', aggregate_usd: 0, threshold: FBAR_THRESHOLD_USD, contributing_accounts: [], warnings: [] };
    }

    const balances = getBalances();
    const accounts = getAccounts().filter(a =>
      Array.isArray(a.filer_ids) && a.filer_ids.includes(filerId)
    );
    const warnings = [];
    let total = 0;
    const contributing = [];
    let missing = 0;

    for (const acct of accounts) {
      if (acct.country === 'US') continue;            // US accounts excluded
      if (!isAccountActiveInYear(acct, year)) continue;

      const bal = balances.find(b => b.account_id === acct.id && String(b.year) === String(year));
      if (!bal || bal.max_balance_usd == null) {
        missing += 1;
        continue;
      }
      total += Number(bal.max_balance_usd);
      contributing.push(acct.id);

      // Surface FX-unverified warning per contributing currency.
      if (bal.fx_rate_source && bal.fx_rate_source.indexOf('UNVERIFIED') !== -1) {
        warnings.push('FX rate for ' + acct.currency + ' in ' + year + ' is unverified.');
      }
    }

    if (missing > 0) {
      warnings.push(missing + ' account(s) missing a balance entry for ' + year + '.');
    }

    let status;
    if (total > FBAR_THRESHOLD_USD) {
      status = 'at_or_over';   // verdict locked in regardless of missing
    } else if (missing > 0) {
      status = 'insufficient_data';
    } else if (contributing.length === 0) {
      status = 'insufficient_data';
    } else {
      status = 'under';
    }

    return {
      aggregate_usd: total,
      threshold: FBAR_THRESHOLD_USD,
      status,
      contributing_accounts: contributing,
      warnings: Array.from(new Set(warnings)),
    };
  }

  // ====================================================================
  // AI sanitizer — exposed via TB.ai.summarizeFbarForAi()
  // ====================================================================
  //
  // Returns a non-identifying category summary suitable for sending to
  // an LLM. Never includes filer names, account numbers, balances,
  // institution names, dates, or addresses. The structure is:
  //
  //   {
  //     filers: { total, us_persons, minors },
  //     accounts: { total, by_type: {bank, securities, other},
  //                 by_country: {JP: n, US: n, OTHER: n},
  //                 by_currency: {JPY: n, USD: n, ...} },
  //     years_with_data: ["2024", "2023", ...],
  //     filers_over_threshold_by_year: { "2024": [n], ... }  // count only
  //   }
  // ====================================================================

  function summarizeFbarForAi() {
    const filers = getFilers();
    const accounts = getAccounts();
    const balances = getBalances();

    const summary = {
      filers: {
        total: filers.length,
        us_persons: filers.filter(f => f.isUSPerson).length,
        minors: filers.filter(f => f.isMinor).length,
      },
      accounts: {
        total: accounts.length,
        by_type: {},
        by_country: {},
        by_currency: {},
      },
      years_with_data: [],
      filers_over_threshold_by_year: {},
    };

    for (const a of accounts) {
      summary.accounts.by_type[a.account_type] = (summary.accounts.by_type[a.account_type] || 0) + 1;
      summary.accounts.by_country[a.country] = (summary.accounts.by_country[a.country] || 0) + 1;
      summary.accounts.by_currency[a.currency] = (summary.accounts.by_currency[a.currency] || 0) + 1;
    }

    const years = new Set(balances.map(b => String(b.year)));
    summary.years_with_data = Array.from(years).sort().reverse();

    for (const y of summary.years_with_data) {
      let count = 0;
      for (const f of filers) {
        if (!f.isUSPerson) continue;
        const s = thresholdStatus(f.id, y);
        if (s.status === 'at_or_over') count += 1;
      }
      summary.filers_over_threshold_by_year[y] = count;
    }

    return summary;
  }

  // ====================================================================
  // Disclaimer ack
  // ====================================================================

  function hasAcknowledgedDisclaimer() {
    return TB.state.get('settings.disclaimer_acks.fbar') === REQUIRED_DISCLAIMER_VERSION;
  }

  function acknowledgeDisclaimer() {
    TB.state.set('settings.disclaimer_acks.fbar', REQUIRED_DISCLAIMER_VERSION);
  }

  // ====================================================================
  // Top-level render
  // ====================================================================

  function render(container) {
    host = container;
    container.innerHTML = '';

    if (!hasAcknowledgedDisclaimer()) {
      container.appendChild(buildDisclaimerCard());
      return;
    }

    if (!activeYear) activeYear = defaultYear();

    // Pull official Treasury year-end rates on entering FBAR (throttled,
    // silent fallback to the corrected offline table). Not at app boot.
    maybeAutoRefreshTreasury();

    container.appendChild(buildShellCard());
    const tabHost = TB.utils.el('div', { id: 'tb-fbar-tab-host' });
    container.appendChild(tabHost);
    renderActiveTab();
  }

  function renderActiveTab() {
    const tabHost = host && host.querySelector('#tb-fbar-tab-host');
    if (!tabHost) return;
    tabHost.innerHTML = '';
    switch (activeTab) {
      case 'filers':   renderFilers(tabHost);   break;
      case 'accounts': renderAccounts(tabHost); break;
      case 'balances': renderBalances(tabHost); break;
      case 'filing':   renderFiling(tabHost);   break;
      case 'print':    renderPrint(tabHost);    break;
      default:         renderOverview(tabHost);
    }
  }

  // ====================================================================
  // Disclaimer modal (rendered in-line inside the module container)
  // ====================================================================

  function buildDisclaimerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h1', null, t('fbar.title')),
      el('p', null, t('fbar.subtitle')),
      el('h2', null, t('fbar.disclaimer.modal.title')),
      el('div', { class: 'tb-disclaimer-inline' }, t('fbar.disclaimer.modal.body')),
      el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn',
          onclick: () => { acknowledgeDisclaimer(); render(host); },
        }, t('fbar.disclaimer.modal.acknowledge')),
      ),
    );
  }

  // ====================================================================
  // Shell — title + subtitle + tabs + persistent banners
  // ====================================================================

  function buildShellCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const tabs = [
      { id: 'overview', label: t('fbar.tab.overview') },
      { id: 'filers',   label: t('fbar.tab.filers') },
      { id: 'accounts', label: t('fbar.tab.accounts') },
      { id: 'balances', label: t('fbar.tab.balances') },
      { id: 'filing',   label: t('fbar.tab.filing') },
      { id: 'print',    label: t('fbar.tab.print') },
    ];

    const tabBar = el('div', {
      class: 'tb-fbar-tabs',
      style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' },
    },
      ...tabs.map(tab => el('button', {
        class: 'tb-btn ' + (activeTab === tab.id ? '' : 'tb-btn--secondary'),
        onclick: () => { activeTab = tab.id; renderActiveTab(); render(host); },
      }, tab.label)),
    );

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h1', null, t('fbar.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.subtitle')),
      tabBar,
    );

    if (!dismissedBanners.fxUnverified) {
      card.appendChild(buildBanner('fxUnverified', t('fbar.banner.fx-unverified'), 'warn'));
    }
    if (!dismissedBanners.encryption) {
      card.appendChild(buildBanner('encryption', t('fbar.banner.encryption.notice'), 'warn'));
    }
    return card;
  }

  function buildBanner(key, text, severity) {
    const el = TB.utils.el;
    const colorVar = severity === 'error' ? 'var(--tb-error)' : 'var(--tb-warn)';
    const wrap = el('div', {
      class: 'tb-disclaimer-inline',
      style: { borderLeftColor: colorVar, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)' },
    },
      el('span', null, text),
      el('button', {
        class: 'tb-btn tb-btn--ghost',
        onclick: () => { dismissedBanners[key] = true; render(host); },
      }, TB.i18n.t('fbar.banner.dismiss')),
    );
    return wrap;
  }

  // ====================================================================
  // OVERVIEW
  // ====================================================================

  function renderOverview(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filers = getFilers();
    const accounts = getAccounts();
    const lang = TB.i18n.getLang();

    if (filers.length === 0) {
      tabHost.appendChild(emptyCard(t('fbar.overview.empty.no-filers'), () => {
        activeTab = 'filers'; render(host);
      }, t('fbar.filers.add')));
      return;
    }
    if (accounts.length === 0) {
      tabHost.appendChild(emptyCard(t('fbar.overview.empty.no-accounts'), () => {
        activeTab = 'accounts'; render(host);
      }, t('fbar.accounts.add')));
      return;
    }

    // Heatmap card.
    const years = recentSixYears();
    const heatmapCard = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', null, t('fbar.overview.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.overview.threshold.legend')),
    );

    const table = el('table', {
      class: 'tb-fbar-heatmap',
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
    });
    const thead = el('thead', null,
      el('tr', null,
        el('th', { style: thStyle() }, t('fbar.tab.filers')),
        ...years.map(y => el('th', { style: thStyle('center') }, y)),
      ),
    );
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const filer of filers) {
      const row = el('tr');
      const labelCell = el('td', { style: tdStyle() },
        el('strong', null, displayName(filer, lang) || '—'),
        filer.isMinor ? el('div', { class: 'tb-card-meta' }, t('fbar.overview.minor-note')) : null,
        !filer.isUSPerson ? el('div', { class: 'tb-card-meta' }, '(non-U.S. person — not subject to FBAR)') : null,
      );
      row.appendChild(labelCell);

      for (const y of years) {
        const status = thresholdStatus(filer.id, y);
        const filingRec = getFilingRecord(filer.id, y);
        const isFiled = !!(filingRec && filingRec.filed_on);
        const cellLabel = formatHeatCell(status) + (isFiled ? ' ✓' : '');
        const cell = el('td', { style: tdStyle('center') }, cellLabel);
        cell.title = heatmapTitle(filer, y, status, t)
          + (isFiled ? '\n\n✓ Filed on ' + filingRec.filed_on
              + (filingRec.bsa_id ? ' (BSA ID ' + filingRec.bsa_id + ')' : '') : '');
        if (isFiled && status.status === 'at_or_over') {
          // Threshold met AND filed — flip from warn to success.
          cell.style.background = 'rgba(47, 111, 78, 0.14)';
          cell.style.color = 'var(--tb-success)';
          cell.style.fontWeight = '600';
        } else if (status.status === 'at_or_over') {
          cell.style.background = 'rgba(185, 122, 26, 0.18)';
          cell.style.color = 'var(--tb-warn)';
          cell.style.fontWeight = '600';
        } else if (status.status === 'under') {
          cell.style.background = 'rgba(47, 111, 78, 0.14)';
          cell.style.color = 'var(--tb-success)';
        } else if (status.status === 'not_us_person') {
          cell.style.color = 'var(--tb-text-soft)';
        } else {
          cell.style.color = 'var(--tb-text-soft)';
        }
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    heatmapCard.appendChild(table);
    tabHost.appendChild(heatmapCard);

    // Required-filing call-outs, split into two buckets:
    //   - outstanding: threshold met AND no filing recorded → warning
    //   - filed:       threshold met AND filing_history has filed_on → success
    // The user toggles "I have filed this" on the Filing tab to move
    // entries from outstanding → filed.
    const outstanding = [];
    const filed = [];
    for (const filer of filers) {
      if (!filer.isUSPerson) continue;
      for (const y of years) {
        const s = thresholdStatus(filer.id, y);
        if (s.status !== 'at_or_over') continue;
        const rec = getFilingRecord(filer.id, y);
        if (rec && rec.filed_on) {
          filed.push({ filer, year: y, status: s, record: rec });
        } else {
          outstanding.push({ filer, year: y, status: s });
        }
      }
    }
    if (outstanding.length > 0) {
      const calloutCard = el('div', { class: 'tb-card', 'data-track': 'core' });
      calloutCard.appendChild(el('h2', null, '⚠ ' + t('fbar.threshold.required.headline')));
      for (const r of outstanding) {
        calloutCard.appendChild(el('div', {
          class: 'tb-disclaimer-inline',
          style: { borderLeftColor: 'var(--tb-warn)' },
        }, t('fbar.overview.threshold.required', { name: displayName(r.filer, lang), year: r.year })));
      }
      tabHost.appendChild(calloutCard);
    }
    if (filed.length > 0) {
      const filedCard = el('div', { class: 'tb-card', 'data-track': 'core' });
      filedCard.appendChild(el('h2', null, '✓ ' + t('fbar.overview.filed.headline')));
      for (const r of filed) {
        filedCard.appendChild(el('div', {
          class: 'tb-disclaimer-inline',
          style: { borderLeftColor: 'var(--tb-success, #2f6f4e)' },
        }, t('fbar.overview.filed.body', {
          name: displayName(r.filer, lang),
          year: r.year,
          date: r.record.filed_on,
          bsa: r.record.bsa_id ? ' · BSA ID ' + r.record.bsa_id : '',
        })));
      }
      tabHost.appendChild(filedCard);
    }

    // Quick links card.
    const ql = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', null, t('fbar.overview.quicklinks')),
      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'accounts'; render(host); } }, t('fbar.overview.ql.add-account')),
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'balances'; render(host); } }, t('fbar.overview.ql.add-balance')),
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'filing'; render(host); } }, t('fbar.overview.ql.filing')),
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: () => { activeTab = 'print'; render(host); } }, t('fbar.overview.ql.print-year', { year: defaultYear() })),
      ),
    );
    tabHost.appendChild(ql);
  }

  function formatHeatCell(status) {
    if (status.status === 'no_filer') return '—';
    if (status.status === 'not_us_person') return 'N/A';
    if (status.status === 'insufficient_data') return '?';
    if (status.aggregate_usd == null) return '—';
    return TB.utils.formatUSD(status.aggregate_usd, { maximumFractionDigits: 0 });
  }

  function heatmapTitle(filer, year, status, t) {
    if (status.status === 'at_or_over') {
      return t('fbar.threshold.required.body', { year, aggregate: TB.utils.formatUSD(status.aggregate_usd) });
    }
    if (status.status === 'under') {
      return t('fbar.threshold.under.body', { year, aggregate: TB.utils.formatUSD(status.aggregate_usd) });
    }
    if (status.status === 'insufficient_data') {
      return t('fbar.threshold.insufficient.body', { year });
    }
    return '';
  }

  function thStyle(align) {
    return {
      borderBottom: '1px solid var(--tb-border)',
      padding: 'var(--tb-sp-2) var(--tb-sp-3)',
      textAlign: align || 'left',
      fontWeight: '600',
      color: 'var(--tb-text-soft)',
      fontSize: 'var(--tb-fs-12)',
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    };
  }

  function tdStyle(align) {
    return {
      borderBottom: '1px solid var(--tb-border)',
      padding: 'var(--tb-sp-3)',
      textAlign: align || 'left',
      verticalAlign: 'top',
    };
  }

  function emptyCard(text, onAction, actionLabel) {
    const el = TB.utils.el;
    return el('div', { class: 'tb-card', 'data-track': 'core' },
      el('p', { class: 'tb-wizard-help' }, text),
      onAction
        ? el('div', { class: 'tb-btn-row' },
            el('button', { class: 'tb-btn', onclick: onAction }, actionLabel),
          )
        : null,
    );
  }

  function displayName(filer, lang) {
    if (lang === 'ja' && filer.name_jp) return filer.name_jp;
    return filer.name_en || filer.name_jp || '';
  }

  // ====================================================================
  // FILERS
  // ====================================================================

  function renderFilers(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filers = getFilers();

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-3)' } },
        el('h2', { style: { margin: 0 } }, t('fbar.filers.title')),
        el('button', { class: 'tb-btn', onclick: addFiler }, '+ ' + t('fbar.filers.add')),
      ),
      el('p', { class: 'tb-card-meta' }, t('fbar.filers.intro')),
    );

    if (filers.length === 0) {
      card.appendChild(el('p', { class: 'tb-wizard-help' }, t('fbar.filers.empty')));
    }
    tabHost.appendChild(card);

    for (let i = 0; i < filers.length; i++) {
      tabHost.appendChild(buildFilerCard(filers[i], i));
    }
  }

  function buildFilerCard(filer, idx) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    function bind(field, parser) {
      return (e) => {
        const target = e.target;
        const raw = target.type === 'checkbox' ? target.checked : target.value;
        const val = parser ? parser(raw) : raw;
        const filers = getFilers();
        if (!filers[idx]) return;
        filers[idx] = Object.assign({}, filers[idx], { [field]: val });
        setFilers(filers);
      };
    }

    return el('div', { class: 'tb-card', 'data-track': 'core', style: { background: 'var(--tb-bg)' } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--tb-sp-3)' } },
        el('strong', null, displayName(filer, TB.i18n.getLang()) || ('Filer ' + (idx + 1))),
        el('button', {
          class: 'tb-btn tb-btn--ghost',
          onclick: () => removeFiler(filer.id),
        }, '× ' + t('fbar.filers.delete')),
      ),

      grid2col(
        field(t('fbar.filers.name_en'), el('input', {
          class: 'tb-input', type: 'text', value: filer.name_en || '', oninput: bind('name_en'),
        })),
        field(t('fbar.filers.name_jp'), el('input', {
          class: 'tb-input', type: 'text', value: filer.name_jp || '', oninput: bind('name_jp'), lang: 'ja',
        }), t('fbar.filers.name_jp.help')),
      ),

      grid2col(
        field(t('fbar.filers.relationship'), el('select', {
          class: 'tb-select', onchange: bind('relationship'),
        },
          el('option', { value: 'self',      selected: filer.relationship === 'self' },      t('fbar.filers.relationship.self')),
          el('option', { value: 'spouse',    selected: filer.relationship === 'spouse' },    t('fbar.filers.relationship.spouse')),
          el('option', { value: 'child',     selected: filer.relationship === 'child' },     t('fbar.filers.relationship.child')),
          el('option', { value: 'dependent', selected: filer.relationship === 'dependent' }, t('fbar.filers.relationship.dependent')),
        )),
        field(t('fbar.filers.dob'), buildYearMonthDayPicker(filer.dob || '', (val) => {
          const filers = getFilers();
          if (!filers[idx]) return;
          filers[idx] = Object.assign({}, filers[idx], { dob: val });
          setFilers(filers);
        })),
      ),

      grid2col(
        field(t('fbar.filers.ssn_last4'),
          el('input', {
            class: 'tb-input', type: 'text', maxlength: '4', inputmode: 'numeric',
            placeholder: '1234', value: filer.ssn_last4 || '',
            oninput: bind('ssn_last4', (v) => String(v).replace(/\D/g, '').slice(0, 4)),
            autocomplete: 'off',
          }),
          t('fbar.filers.ssn_last4.help'),
        ),
        field(t('fbar.filers.address'), el('input', {
          class: 'tb-input', type: 'text', value: filer.filing_address || '', oninput: bind('filing_address'),
        })),
      ),

      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-4)', flexWrap: 'wrap', marginBottom: 'var(--tb-sp-3)' } },
        el('label', { class: 'tb-checkbox', style: { flex: '1 1 280px' } },
          el('input', { type: 'checkbox', checked: !!filer.isMinor, onchange: bind('isMinor') }),
          el('div', null,
            el('div', null, t('fbar.filers.isMinor')),
            el('small', null, t('fbar.filers.isMinor.help')),
          ),
        ),
        el('label', { class: 'tb-checkbox', style: { flex: '1 1 280px' } },
          el('input', { type: 'checkbox', checked: !!filer.isUSPerson, onchange: bind('isUSPerson') }),
          el('div', null,
            el('div', null, t('fbar.filers.isUSPerson')),
            el('small', null, t('fbar.filers.isUSPerson.help')),
          ),
        ),
      ),

      field(t('fbar.filers.notes'), el('textarea', {
        class: 'tb-textarea', oninput: bind('notes'),
      }, filer.notes || '')),
    );
  }

  function addFiler() {
    openFilerModal(null);   // null = new filer
  }

  function editFiler(filerId) {
    openFilerModal(filerId); // existing filer id = edit mode
  }

  // Modal-based filer add / edit. For ADD: holds a working copy in
  // module state; commits to TB.state only on Save. For EDIT: starts
  // from a clone of the existing filer; replaces it on Save.
  function openFilerModal(filerId) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const isEdit = !!filerId;
    const original = isEdit ? findFiler(filerId) : null;
    if (isEdit && !original) return;

    // Working copy — separate from state, mutated only by the modal
    // form's input handlers. Cancel discards; Save commits.
    let working = isEdit
      ? Object.assign({}, original)
      : Object.assign(blankFiler(), {
          relationship: getFilers().length === 0 ? 'self' : 'spouse',
        });

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    function bind(field, parser) {
      return (e) => {
        const target = e.target;
        const raw = target.type === 'checkbox' ? target.checked : target.value;
        working[field] = parser ? parser(raw) : raw;
      };
    }

    function save() {
      // Validate: at least name_en or name_jp required.
      if (!working.name_en && !working.name_jp) {
        alert(t('fbar.filers.modal.nameRequired'));
        return;
      }
      const filers = getFilers();
      if (isEdit) {
        const i = filers.findIndex(f => f.id === filerId);
        if (i >= 0) {
          filers[i] = Object.assign({}, filers[i], working);
          setFilers(filers);
        }
      } else {
        filers.push(working);
        setFilers(filers);
      }
      closeModal();
      renderActiveTab();
    }

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } },
        isEdit ? t('fbar.filers.modal.editTitle') : t('fbar.filers.modal.addTitle'),
      ),

      grid2col(
        field(t('fbar.filers.name_en') + ' *',
          el('input', {
            class: 'tb-input', type: 'text', value: working.name_en || '',
            placeholder: 'BENJAMIN EICHHORN',
            oninput: bind('name_en'),
          }),
        ),
        field(t('fbar.filers.name_jp'),
          el('input', {
            class: 'tb-input', type: 'text', value: working.name_jp || '',
            placeholder: 'アイコーン ベンジャミン',
            oninput: bind('name_jp'), lang: 'ja',
          }),
          t('fbar.filers.name_jp.help'),
        ),
      ),

      grid2col(
        field(t('fbar.filers.relationship'),
          el('select', { class: 'tb-select', onchange: bind('relationship') },
            el('option', { value: 'self',      selected: working.relationship === 'self' },      t('fbar.filers.relationship.self')),
            el('option', { value: 'spouse',    selected: working.relationship === 'spouse' },    t('fbar.filers.relationship.spouse')),
            el('option', { value: 'child',     selected: working.relationship === 'child' },     t('fbar.filers.relationship.child')),
            el('option', { value: 'dependent', selected: working.relationship === 'dependent' }, t('fbar.filers.relationship.dependent')),
          ),
        ),
        field(t('fbar.filers.dob'),
          buildYearMonthDayPicker(working.dob || '', (val) => {
            working.dob = val;
          }),
        ),
      ),

      grid2col(
        field(t('fbar.filers.ssn_last4'),
          el('input', {
            class: 'tb-input', type: 'text', maxlength: '4', inputmode: 'numeric',
            placeholder: '1234', value: working.ssn_last4 || '',
            oninput: bind('ssn_last4', (v) => String(v).replace(/\D/g, '').slice(0, 4)),
            autocomplete: 'off',
          }),
          t('fbar.filers.ssn_last4.help'),
        ),
        field(t('fbar.filers.address'),
          el('input', {
            class: 'tb-input', type: 'text', value: working.filing_address || '',
            oninput: bind('filing_address'),
          }),
        ),
      ),

      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', flexWrap: 'wrap', marginBottom: 'var(--tb-sp-3)' } },
        el('label', { class: 'tb-checkbox', style: { flex: '1 1 280px' } },
          el('input', { type: 'checkbox', checked: !!working.isMinor, onchange: bind('isMinor') }),
          el('div', null,
            el('div', null, t('fbar.filers.isMinor')),
            el('small', null, t('fbar.filers.isMinor.help')),
          ),
        ),
        el('label', { class: 'tb-checkbox', style: { flex: '1 1 280px' } },
          el('input', { type: 'checkbox', checked: !!working.isUSPerson, onchange: bind('isUSPerson') }),
          el('div', null,
            el('div', null, t('fbar.filers.isUSPerson')),
            el('small', null, t('fbar.filers.isUSPerson.help')),
          ),
        ),
      ),

      field(t('fbar.filers.notes'),
        el('textarea', {
          class: 'tb-textarea',
          oninput: bind('notes'),
        }, working.notes || ''),
      ),

      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: closeModal },
          t('fbar.action.cancel')),
        el('button', { class: 'tb-btn', onclick: save },
          isEdit ? t('fbar.filers.modal.saveEdit') : t('fbar.filers.modal.saveAdd')),
      ),
    );

    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);
    modalRoot.appendChild(backdrop);
  }

  function removeFiler(filerId) {
    const filer = findFiler(filerId);
    if (!filer) return;
    const name = displayName(filer, TB.i18n.getLang()) || 'this filer';
    if (!confirm(TB.i18n.t('fbar.filers.delete.confirm', { name }))) return;
    setFilers(getFilers().filter(f => f.id !== filerId));
    // Unlink from accounts but don't delete the accounts (user
    // may want to keep records or re-assign).
    const accounts = getAccounts().map(a =>
      Object.assign({}, a, { filer_ids: (a.filer_ids || []).filter(id => id !== filerId) })
    );
    setAccounts(accounts);
    renderActiveTab();
  }

  // ====================================================================
  // ACCOUNTS
  // ====================================================================

  function renderAccounts(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const allAccounts = getAccounts();
    const filers = getFilers();

    // Upload button wrapped in a small drop-target card so users can
    // drag a passbook/statement/screenshot onto it as an alternative
    // to clicking the button + using the OS file picker. The card
    // and the button both end up routing through processUploadedFile.
    const uploadCard = el('div', {
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 'var(--tb-sp-2)',
        padding: '4px 10px',
        border: '1px dashed var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        background: 'var(--tb-bg)',
      },
    },
      el('button', {
        class: 'tb-btn tb-btn--secondary',
        onclick: openUploadDialog,
        title: t('fbar.upload.button.tooltip'),
      }, '⬆ ' + t('fbar.upload.button')),
      el('span', {
        style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)' },
      }, t('fbar.upload.dropHint')),
    );
    TB.utils.attachFileDrop(uploadCard, {
      accept: ['image/png','image/jpeg','image/jpg','image/webp','image/gif','application/pdf','.pdf'],
      text: '⤓ ' + t('fbar.upload.drop'),
      onFile: (f) => processUploadedFile(f),
    });

    const headerCard = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-3)' } },
        el('h2', { style: { margin: 0 } }, t('fbar.accounts.title')),
        el('div', { class: 'tb-btn-row', style: { margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)' } },
          uploadCard,
          el('button', { class: 'tb-btn', onclick: addAccount }, '+ ' + t('fbar.accounts.add')),
        ),
      ),
      el('p', { class: 'tb-card-meta' }, t('fbar.accounts.intro')),
      buildAccountFilters(filers),
    );
    tabHost.appendChild(headerCard);

    const filtered = applyAccountFilters(allAccounts);

    if (filtered.length === 0) {
      tabHost.appendChild(emptyCard(allAccounts.length === 0 ? t('fbar.accounts.empty') : 'No accounts match the current filters.'));
      return;
    }

    for (const acct of filtered) {
      tabHost.appendChild(buildAccountCard(acct));
    }
  }

  function buildAccountFilters(filers) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const allCurrencies = Array.from(new Set(getAccounts().map(a => a.currency))).sort();
    const allYears = knownYears();

    return el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-3)' } },
      field(t('fbar.accounts.filter.byFiler'), el('select', {
        class: 'tb-select',
        onchange: (e) => { accountFilters.filerId = e.target.value; renderActiveTab(); },
      },
        el('option', { value: '', selected: !accountFilters.filerId }, t('fbar.accounts.filter.all')),
        ...filers.map(f => el('option', {
          value: f.id, selected: accountFilters.filerId === f.id,
        }, displayName(f, TB.i18n.getLang()) || '—')),
      )),
      field(t('fbar.accounts.filter.byYear'), el('select', {
        class: 'tb-select',
        onchange: (e) => { accountFilters.year = e.target.value; renderActiveTab(); },
      },
        el('option', { value: '', selected: !accountFilters.year }, t('fbar.accounts.filter.all')),
        ...allYears.map(y => el('option', { value: y, selected: accountFilters.year === y }, y)),
      )),
      field(t('fbar.accounts.filter.byCurrency'), el('select', {
        class: 'tb-select',
        onchange: (e) => { accountFilters.currency = e.target.value; renderActiveTab(); },
      },
        el('option', { value: '', selected: !accountFilters.currency }, t('fbar.accounts.filter.all')),
        ...allCurrencies.map(c => el('option', { value: c, selected: accountFilters.currency === c }, c)),
      )),
    );
  }

  function applyAccountFilters(accounts) {
    return accounts.filter(a => {
      if (accountFilters.filerId && !(a.filer_ids || []).includes(accountFilters.filerId)) return false;
      if (accountFilters.year && !isAccountActiveInYear(a, accountFilters.year)) return false;
      if (accountFilters.currency && a.currency !== accountFilters.currency) return false;
      return true;
    });
  }

  function buildAccountCard(acct) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filers = getFilers();
    const lang = TB.i18n.getLang();
    const ownerNames = (acct.filer_ids || [])
      .map(id => filers.find(f => f.id === id))
      .filter(Boolean)
      .map(f => displayName(f, lang))
      .join(', ') || '—';

    function bind(field, parser) {
      return (e) => {
        const target = e.target;
        const raw = target.type === 'checkbox' ? target.checked : target.value;
        const val = parser ? parser(raw) : raw;
        const accounts = getAccounts();
        const i = accounts.findIndex(a => a.id === acct.id);
        if (i < 0) return;
        accounts[i] = Object.assign({}, accounts[i], { [field]: val });
        setAccounts(accounts);
      };
    }

    function bindSelect(field, parser) {
      return (e) => {
        const accounts = getAccounts();
        const i = accounts.findIndex(a => a.id === acct.id);
        if (i < 0) return;
        const val = parser ? parser(e.target.value) : e.target.value;
        accounts[i] = Object.assign({}, accounts[i], { [field]: val });
        setAccounts(accounts);
        renderActiveTab(); // currency/country changes affect display
      };
    }

    function toggleOwner(filerId, on) {
      const accounts = getAccounts();
      const i = accounts.findIndex(a => a.id === acct.id);
      if (i < 0) return;
      const set = new Set(accounts[i].filer_ids || []);
      if (on) set.add(filerId); else set.delete(filerId);
      accounts[i] = Object.assign({}, accounts[i], { filer_ids: Array.from(set) });
      setAccounts(accounts);
      renderActiveTab();
    }

    // Display name in card header: prefer English; if absent, fall
    // back to the Japanese form so newly-uploaded passbooks (which
    // typically only extract the Japanese name) still have a label.
    const displayInst = acct.institution_name
      || acct.institution_name_jp
      || '(unnamed account)';
    const altInst = (acct.institution_name && acct.institution_name_jp)
      ? acct.institution_name_jp
      : null;

    const head = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--tb-sp-3)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('div', null,
        el('strong', null, displayInst),
        altInst
          ? el('span', { class: 'tb-card-meta', style: { marginLeft: 'var(--tb-sp-2)' }, lang: 'ja' }, '/ ' + altInst)
          : null,
        el('div', { class: 'tb-card-meta' },
          acct.country + ' · ' + acct.currency + ' · ' +
          t('fbar.accounts.account_type.' + acct.account_type) + ' · ' +
          (acct.closed_year
            ? t('fbar.accounts.status.closed', { year: acct.closed_year })
            : t('fbar.accounts.status.open')),
        ),
        el('div', { class: 'tb-card-meta' }, t('fbar.accounts.col.owners') + ': ' + ownerNames),
      ),
      el('div', { class: 'tb-btn-row', style: { margin: 0 } },
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          onclick: () => openEnrichConsentModal(acct.id),
          title: t('fbar.enrich.button.tooltip'),
          disabled: !acct.institution_name && !acct.institution_name_jp,
        }, '✨ ' + t('fbar.enrich.button')),
        el('button', {
          class: 'tb-btn tb-btn--ghost',
          onclick: () => removeAccount(acct.id),
        }, '× ' + t('fbar.accounts.delete')),
      ),
    );

    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--tb-sp-3)' },
    },
      field(t('fbar.accounts.institution_name'),
        el('input', {
          class: 'tb-input', type: 'text', value: acct.institution_name || '',
          placeholder: 'e.g. Akita Bank',
          oninput: bind('institution_name'),
        }),
        t('fbar.accounts.institution_name.help'),
      ),
      field(t('fbar.accounts.institution_name_jp'),
        el('input', {
          class: 'tb-input', type: 'text', value: acct.institution_name_jp || '',
          placeholder: 'e.g. 秋田銀行',
          oninput: bind('institution_name_jp'),
          lang: 'ja',
        }),
      ),
      field(t('fbar.accounts.institution_address'),
        el('input', {
          class: 'tb-input', type: 'text', value: acct.institution_address || '',
          placeholder: 'e.g. 3-2-1 Sanno, Akita-shi, Akita 010-8655, Japan',
          oninput: bind('institution_address'),
        }),
        t('fbar.accounts.institution_address.help'),
      ),
      field(t('fbar.accounts.institution_address_jp'),
        el('input', {
          class: 'tb-input', type: 'text', value: acct.institution_address_jp || '',
          placeholder: 'e.g. 〒010-8655 秋田県秋田市山王三丁目2番1号',
          oninput: bind('institution_address_jp'),
          lang: 'ja',
        }),
      ),
      buildAccountNumberField(acct),
      field(t('fbar.accounts.account_type'), el('select', {
        class: 'tb-select', onchange: bindSelect('account_type'),
      },
        el('option', { value: 'bank', selected: acct.account_type === 'bank' }, t('fbar.accounts.account_type.bank')),
        el('option', { value: 'securities', selected: acct.account_type === 'securities' }, t('fbar.accounts.account_type.securities')),
        el('option', { value: 'other', selected: acct.account_type === 'other' }, t('fbar.accounts.account_type.other')),
      )),
      field(t('fbar.accounts.currency'), el('select', {
        class: 'tb-select', onchange: bindSelect('currency'),
      },
        ...SUPPORTED_CURRENCIES.map(c => el('option', { value: c, selected: acct.currency === c }, c)),
      )),
      field(t('fbar.accounts.country'), el('select', {
        class: 'tb-select', onchange: bindSelect('country'),
      },
        ...COUNTRY_CODES.map(c => el('option', { value: c.code, selected: acct.country === c.code }, c.code + ' — ' + c.label)),
      )),
      field(t('fbar.accounts.opened_year'), el('input', {
        class: 'tb-input', type: 'number', min: '1900', max: '2100', step: '1',
        value: acct.opened_year || '', oninput: bind('opened_year', toIntOrNull),
      })),
      field(t('fbar.accounts.closed_year'), el('input', {
        class: 'tb-input', type: 'number', min: '1900', max: '2100', step: '1',
        value: acct.closed_year || '', oninput: bind('closed_year', toIntOrNull),
      }), t('fbar.accounts.closed_year.help')),
    );

    // ----- Owners section: primary dropdown + joint toggle + co-owners -----
    // Cleaner mental model than the old "check all owners" grid.
    // The primary owner is filer_ids[0]; co-owners are filer_ids[1+].
    // Toggling Joint reveals the co-owner checkbox grid.
    const filerIds = acct.filer_ids || [];
    const primaryId = filerIds[0] || '';
    const isJoint = filerIds.length > 1 || !!jointUiRevealed[acct.id];

    function setOwners(newPrimary, newCoOwners) {
      const accounts = getAccounts();
      const i = accounts.findIndex(a => a.id === acct.id);
      if (i < 0) return;
      const list = newPrimary ? [newPrimary, ...(newCoOwners || [])] : (newCoOwners || []);
      accounts[i] = Object.assign({}, accounts[i], { filer_ids: list });
      setAccounts(accounts);
      renderActiveTab();
    }

    function changePrimary(newPrimaryId) {
      const coOwners = (filerIds.slice(1)).filter(id => id !== newPrimaryId);
      setOwners(newPrimaryId, coOwners);
    }

    function toggleJoint(on) {
      jointUiRevealed[acct.id] = on;
      if (!on) {
        // Drop co-owners when un-jointing.
        setOwners(primaryId, []);
      } else {
        // Just reveal the UI; data unchanged until co-owner picked.
        renderActiveTab();
      }
    }

    function toggleCoOwner(filerId, on) {
      const cur = filerIds.slice(1);
      const next = on ? Array.from(new Set([...cur, filerId])) : cur.filter(id => id !== filerId);
      setOwners(primaryId, next);
    }

    const primarySelect = filers.length === 0
      ? null
      : el('select', {
          class: 'tb-select',
          onchange: (e) => changePrimary(e.target.value),
        },
          el('option', { value: '', selected: !primaryId }, '— ' + t('fbar.accounts.primary.none') + ' —'),
          ...filers.map(f => el('option', {
            value: f.id, selected: primaryId === f.id,
          },
            (displayName(f, lang) || '—') + ' · ' + t('fbar.filers.relationship.' + f.relationship),
          )),
        );

    const jointToggle = filers.length < 2
      ? null
      : el('label', {
          class: 'tb-checkbox' + (isJoint ? ' is-selected' : ''),
          style: { marginTop: 'var(--tb-sp-3)' },
        },
          el('input', {
            type: 'checkbox', checked: isJoint,
            onchange: (e) => toggleJoint(e.target.checked),
          }),
          el('div', null,
            el('div', null, t('fbar.accounts.is_joint')),
            el('small', null, t('fbar.accounts.is_joint.help')),
          ),
        );

    const coOwnersGrid = isJoint && filers.length >= 2
      ? el('div', { style: { marginTop: 'var(--tb-sp-3)' } },
          el('div', { class: 'tb-field-label' }, t('fbar.accounts.coowners')),
          el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--tb-sp-2)' } },
            ...filers
              .filter(f => f.id !== primaryId)
              .map(f => {
                const checked = filerIds.includes(f.id);
                return el('label', {
                  class: 'tb-checkbox' + (checked ? ' is-selected' : ''),
                },
                  el('input', {
                    type: 'checkbox', checked,
                    onchange: (e) => toggleCoOwner(f.id, e.target.checked),
                  }),
                  el('div', null,
                    el('div', null, displayName(f, lang) || '—'),
                    el('small', null, t('fbar.filers.relationship.' + f.relationship) +
                      (!f.isUSPerson ? ' · non-U.S.' : '') +
                      (f.isMinor ? ' · minor' : '')),
                  ),
                );
              }),
          ),
        )
      : null;

    const ownersBlock = el('div', null,
      el('div', { class: 'tb-field-label' }, t('fbar.accounts.primary_owner')),
      filers.length === 0
        ? el('div', { class: 'tb-field-help' }, t('fbar.filers.empty'))
        : primarySelect,
      jointToggle,
      coOwnersGrid,
    );

    const sigCheckbox = el('label', { class: 'tb-checkbox', style: { marginTop: 'var(--tb-sp-3)' } },
      el('input', { type: 'checkbox', checked: !!acct.signatory_only, onchange: bind('signatory_only') }),
      el('div', null,
        el('div', null, t('fbar.accounts.signatory_only')),
        el('small', null, t('fbar.accounts.signatory_only.help')),
      ),
    );

    const notes = field(t('fbar.accounts.notes'), el('textarea', {
      class: 'tb-textarea', oninput: bind('notes'),
    }, acct.notes || ''));

    const extractedBanner = (acct._extracted_from && !acct._verified)
      ? buildExtractedBanner(acct)
      : null;

    return el('div', { class: 'tb-card', 'data-track': 'core', style: { background: 'var(--tb-bg)' } },
      head, extractedBanner, grid, ownersBlock, sigCheckbox, notes,
    );
  }

  function buildExtractedBanner(acct) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const conf = acct._extracted_confidence;
    const confLabel = conf
      ? ' (' + t('fbar.upload.banner.confidence') + ': ' + conf + ')'
      : '';
    const holderHint = (acct._extracted_holder_name || acct._extracted_holder_name_jp)
      ? el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
          t('fbar.upload.banner.holderDetected') + ': ' +
          [acct._extracted_holder_name, acct._extracted_holder_name_jp].filter(Boolean).join(' / '),
        )
      : null;

    const years = Array.isArray(acct._extracted_years) ? acct._extracted_years : [];
    const yearsLine = years.length > 0
      ? el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
          '📊 ' + t('fbar.upload.banner.balancesCreated', { count: years.length }) + ': ',
          el('strong', null, years.join(' · ')),
          ' · ',
          el('a', {
            href: '#',
            style: { color: 'var(--tb-navy)' },
            onclick: (e) => {
              e.preventDefault();
              activeTab = 'balances';
              if (years.length) activeYear = String(years[years.length - 1]);
              render(host);
            },
          }, t('fbar.upload.banner.viewBalances') + ' →'),
        )
      : el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-warn)' } },
          '⚠ ' + t('fbar.upload.banner.noBalances'),
        );

    const partialNote = acct._extracted_partial
      ? el('div', {
          class: 'tb-card-meta',
          style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-warn)', fontWeight: 500 },
        }, '⚠ ' + t('fbar.upload.banner.partial'))
      : null;

    const multiNote = acct._extracted_multi_account
      ? el('div', {
          class: 'tb-card-meta',
          style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-navy)', fontWeight: 500 },
        }, '🧩 ' + t('fbar.upload.banner.multiAccount', {
          index: (acct._extracted_sibling_index || 0) + 1,
          count: acct._extracted_sibling_count || 1,
        }))
      : null;

    // Deep-passbook extraction signals — surface 合算 ranges, FD
    // references, and warnings so the user knows about extraction-
    // quality issues that need verification.
    const consolidatedNote = (Array.isArray(acct._extracted_consolidated_entries) && acct._extracted_consolidated_entries.length > 0)
      ? el('div', {
          class: 'tb-card-meta',
          style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-warn)' },
        },
          '⚠ ' + t('fbar.upload.banner.consolidated', { count: acct._extracted_consolidated_entries.length }),
          el('ul', { style: { margin: 'var(--tb-sp-1) 0 0', paddingLeft: 'var(--tb-sp-4)', fontSize: 'var(--tb-fs-12)' } },
            ...acct._extracted_consolidated_entries.map(c =>
              el('li', null,
                (c.start_date || '?') + ' → ' + (c.end_date || '?') +
                (c.count ? ' (' + c.count + ' txns)' : '') +
                (c.ending_balance != null ? ', end bal ' + c.ending_balance : ''),
              ),
            ),
          ),
        )
      : null;

    const fdNote = (Array.isArray(acct._extracted_fd_references) && acct._extracted_fd_references.length > 0)
      ? el('div', {
          class: 'tb-card-meta',
          style: { marginTop: 'var(--tb-sp-2)' },
        },
          '🔒 ' + t('fbar.upload.banner.fdReferences', { count: acct._extracted_fd_references.length }),
          el('ul', { style: { margin: 'var(--tb-sp-1) 0 0', paddingLeft: 'var(--tb-sp-4)', fontSize: 'var(--tb-fs-12)' } },
            ...acct._extracted_fd_references.map(f =>
              el('li', null,
                'cert ' + (f.cert_number || '?') +
                (f.fd_number ? ' (FD#' + f.fd_number + ')' : '') +
                (f.amount != null ? ', ¥' + f.amount.toLocaleString() : '') +
                (f.maturity_date ? ', matures ' + f.maturity_date : '') +
                (f.status ? ' · ' + f.status : ''),
              ),
            ),
          ),
        )
      : null;

    const warningsNote = (Array.isArray(acct._extracted_warnings) && acct._extracted_warnings.length > 0)
      ? el('div', {
          class: 'tb-card-meta',
          style: { marginTop: 'var(--tb-sp-2)', color: 'var(--tb-warn)' },
        },
          '⚠ ' + t('fbar.upload.banner.warnings', { count: acct._extracted_warnings.length }),
          el('ul', { style: { margin: 'var(--tb-sp-1) 0 0', paddingLeft: 'var(--tb-sp-4)', fontSize: 'var(--tb-fs-12)' } },
            ...acct._extracted_warnings.map(w => el('li', null, w)),
          ),
        )
      : null;

    const carryOverNote = (acct._extracted_carry_over_balance != null)
      ? el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)' } },
          '📒 ' + t('fbar.upload.banner.carryOver', {
            amount: acct._extracted_carry_over_balance.toLocaleString(),
            currency: acct.currency,
          }),
        )
      : null;

    const enrichedNote = (Array.isArray(acct._enriched_filled) && acct._enriched_filled.length > 0)
      ? el('div', {
          class: 'tb-card-meta',
          style: { marginTop: 'var(--tb-sp-2)' },
        },
          '✨ ' + t('fbar.upload.banner.autoEnriched', {
            count: acct._enriched_filled.length,
            fields: acct._enriched_filled.join(', '),
          }),
          acct._enriched_summary
            ? el('div', { style: { marginTop: 'var(--tb-sp-1)', fontStyle: 'italic' } },
                '💡 ' + acct._enriched_summary,
              )
            : null,
        )
      : null;

    return el('div', {
      class: 'tb-disclaimer-inline',
      style: {
        borderLeftColor: acct._extracted_partial ? 'var(--tb-warn)' : 'var(--tb-navy)',
        background: acct._extracted_partial ? 'rgba(185, 122, 26, 0.08)' : 'rgba(14, 42, 79, 0.06)',
        marginBottom: 'var(--tb-sp-3)',
      },
    },
      el('div', { style: { fontWeight: 600 } },
        '⚡ ' + t('fbar.upload.banner.from', { file: acct._extracted_from }) + confLabel,
      ),
      el('div', { class: 'tb-card-meta' }, t('fbar.upload.banner.verify')),
      holderHint,
      multiNote,
      partialNote,
      enrichedNote,
      carryOverNote,
      consolidatedNote,
      fdNote,
      warningsNote,
      yearsLine,
      el('div', { class: 'tb-btn-row', style: { marginTop: 'var(--tb-sp-2)' } },
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          onclick: () => {
            const list = getAccounts();
            const i = list.findIndex(a => a.id === acct.id);
            if (i < 0) return;
            list[i] = Object.assign({}, list[i], { _verified: true });
            setAccounts(list);
            renderActiveTab();
          },
        }, t('fbar.upload.banner.markVerified')),
      ),
    );
  }

  function buildAccountNumberField(acct) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const revealed = !!revealedAccountNumbers[acct.id];

    const input = el('input', {
      class: 'tb-input',
      type: revealed ? 'text' : 'password',
      value: acct.account_number_full || '',
      oninput: (e) => {
        const accounts = getAccounts();
        const i = accounts.findIndex(a => a.id === acct.id);
        if (i < 0) return;
        accounts[i] = Object.assign({}, accounts[i], { account_number_full: e.target.value });
        setAccounts(accounts);
        // Update the masked display sibling if present.
        const maskedEl = host.querySelector(`[data-fbar-acct-masked="${acct.id}"]`);
        if (maskedEl) maskedEl.textContent = masked(e.target.value);
      },
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const toggleBtn = el('button', {
      class: 'tb-btn tb-btn--ghost',
      type: 'button',
      onclick: () => {
        revealedAccountNumbers[acct.id] = !revealed;
        renderActiveTab();
      },
    }, revealed ? t('fbar.accounts.hide_full') : t('fbar.accounts.show_full'));

    return el('label', { class: 'tb-field', style: { marginBottom: 0 } },
      el('span', { class: 'tb-field-label' }, t('fbar.accounts.account_number_full')),
      el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } }, input, toggleBtn),
      el('div', { class: 'tb-card-meta' },
        t('fbar.accounts.account_number_masked') + ': ',
        el('span', { 'data-fbar-acct-masked': acct.id }, masked(acct.account_number_full)),
      ),
      el('div', { class: 'tb-field-help' }, t('fbar.accounts.account_number_full.help')),
    );
  }

  function toIntOrNull(v) {
    if (v === '' || v == null) return null;
    const n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }

  function addAccount() {
    const accounts = getAccounts();
    const fresh = blankAccount();
    // If only one filer, auto-attach.
    const filers = getFilers();
    if (filers.length === 1) fresh.filer_ids = [filers[0].id];
    accounts.push(fresh);
    setAccounts(accounts);
    renderActiveTab();
  }

  // ====================================================================
  // VISION-BASED UPLOAD (user-initiated, consent-gated)
  // ====================================================================

  function openUploadDialog() {
    if (!TB.ai || !TB.ai.hasKey()) {
      const msg = TB.i18n.t('fbar.upload.noKey.body');
      if (confirm(msg + '\n\n' + TB.i18n.t('fbar.upload.noKey.openSettings') + '?')) {
        document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
      }
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';
    input.style.display = 'none';
    input.onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      document.body.removeChild(input);
      if (file) processUploadedFile(file);
    };
    document.body.appendChild(input);
    input.click();
  }

  // Extracted from openUploadDialog so both file-picker selection and
  // drag-drop drops feed the same dedup → filer-chooser → consent flow.
  async function processUploadedFile(file) {
    if (!TB.ai || !TB.ai.hasKey()) {
      const msg = TB.i18n.t('fbar.upload.noKey.body');
      if (confirm(msg + '\n\n' + TB.i18n.t('fbar.upload.noKey.openSettings') + '?')) {
        document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
      }
      return;
    }
    // Compute SHA-256 BEFORE the consent modal so we can skip the
    // (billable) Claude call if this document was already uploaded.
    let hash = null;
    try { hash = await TB.utils.sha256(file); }
    catch (err) { console.warn('[fbar.upload] hash failed, skipping dedup:', err); }
    const dup = hash ? findAccountByHash(hash) : null;
    if (dup) {
      openDuplicateModal(file, hash, dup);
      return;
    }
    // Multi-filer households: ask up-front who this account is for.
    const filers = getFilers();
    if (filers.length >= 2) {
      openUploadFilerChooser(filers, (chosenFilerIds) => {
        showConsentModal(file, hash, null, chosenFilerIds);
      });
    } else {
      showConsentModal(file, hash, null, null);
    }
  }

  // Pre-upload chooser. Asks "this account belongs to whom?" so
  // multi-filer households (parent + spouse + children, etc.) don't
  // have to fix ownership AFTER extraction. Calls onChoose with an
  // array of filer ids — the first id is the "primary" owner; any
  // additional ids are joint co-owners.
  function openUploadFilerChooser(filers, onChoose) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    // Default the chooser to the last-used filer set (sticky), or
    // the first filer if no prior upload in this session.
    const initialPrimary = (lastUploadFilerIds[0]
      && filers.find(f => f.id === lastUploadFilerIds[0]))
        ? lastUploadFilerIds[0]
        : filers[0].id;
    const initialCoOwners = lastUploadFilerIds.slice(1).filter(
      id => filers.find(f => f.id === id),
    );
    const state = {
      primaryId: initialPrimary,
      isJoint: initialCoOwners.length > 0,
      coOwnerIds: new Set(initialCoOwners),
    };

    function rebuild() {
      modalRoot.innerHTML = '';
      modalRoot.appendChild(buildModal());
    }

    function buildCoOwnerList() {
      return el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-2)' },
      },
        ...filers
          .filter(f => f.id !== state.primaryId)
          .map(f => {
            const checked = state.coOwnerIds.has(f.id);
            return el('label', {
              class: 'tb-checkbox' + (checked ? ' is-selected' : ''),
            },
              el('input', {
                type: 'checkbox', checked,
                onchange: (e) => {
                  if (e.target.checked) state.coOwnerIds.add(f.id);
                  else state.coOwnerIds.delete(f.id);
                },
              }),
              el('div', null,
                el('div', null, displayName(f, lang) || '—'),
                el('small', null, t('fbar.filers.relationship.' + f.relationship)),
              ),
            );
          }),
      );
    }

    function buildModal() {
      const primarySelect = el('select', {
        class: 'tb-select',
        onchange: (e) => {
          state.primaryId = e.target.value;
          // If primary changed, drop them from co-owners (no-op for
          // most cases since co-owner list is filtered above, but
          // re-render to refresh the checkboxes).
          state.coOwnerIds.delete(state.primaryId);
          rebuild();
        },
      },
        ...filers.map(f => el('option', {
          value: f.id, selected: state.primaryId === f.id,
        }, displayName(f, lang) || '—')),
      );

      const jointCheckbox = el('label', {
        class: 'tb-checkbox' + (state.isJoint ? ' is-selected' : ''),
        style: { marginTop: 'var(--tb-sp-3)' },
      },
        el('input', {
          type: 'checkbox', checked: state.isJoint,
          onchange: (e) => {
            state.isJoint = e.target.checked;
            if (!state.isJoint) state.coOwnerIds.clear();
            rebuild();
          },
        }),
        el('div', null,
          el('div', null, t('fbar.upload.chooser.joint')),
          el('small', null, t('fbar.upload.chooser.joint.help')),
        ),
      );

      function commit() {
        const chosen = [state.primaryId, ...Array.from(state.coOwnerIds)];
        lastUploadFilerIds = chosen.slice();
        closeModal();
        onChoose(chosen);
      }

      return el('div', { class: 'tb-modal-backdrop' },
        el('div', { class: 'tb-modal' },
          el('h2', { style: { marginTop: 0 } }, t('fbar.upload.chooser.title')),
          el('p', { class: 'tb-card-meta' }, t('fbar.upload.chooser.body')),
          field(t('fbar.upload.chooser.primary'), primarySelect),
          jointCheckbox,
          state.isJoint
            ? el('div', { style: { marginTop: 'var(--tb-sp-3)' } },
                el('div', { class: 'tb-field-label' }, t('fbar.upload.chooser.coowners')),
                buildCoOwnerList(),
              )
            : null,
          el('div', { class: 'tb-btn-row' },
            el('button', { class: 'tb-btn tb-btn--secondary', onclick: closeModal },
              t('fbar.action.cancel')),
            el('button', { class: 'tb-btn', onclick: commit },
              t('fbar.upload.chooser.continue')),
          ),
        ),
      );
    }

    rebuild();
  }

  function findAccountByHash(hash) {
    if (!hash) return null;
    return getAccounts().find(a => a._extracted_source_hash === hash) || null;
  }

  // Loose match for account numbers: strip non-alphanumeric characters
  // and compare case-insensitive. Catches the "12340-67890123" vs
  // "1234067890123" vs "12340 67890123" formatting variations.
  function normalizeAccountNumber(s) {
    return String(s || '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
  }

  function findAccountByNumber(rawNumber) {
    const norm = normalizeAccountNumber(rawNumber);
    if (!norm || norm.length < 4) return null;  // too short to be confident
    return getAccounts().find(a => normalizeAccountNumber(a.account_number_full) === norm) || null;
  }

  function showConsentModal(file, hash, existingAccount, preselectedFilerIds) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const cls = TB.ai.classifyFile(file);
    if (!cls) {
      alert(t('fbar.upload.error.unsupported'));
      return;
    }
    const isUpdate = !!existingAccount;

    const cost = TB.ai.estimateCost(file);
    const sizeKb = (file.size / 1024).toFixed(1);
    // Approx cost of the optional follow-on enrichment call
    // (text-only at Sonnet 4.6 pricing, ~700 in + ~500 out tokens).
    const enrichCost = 0.005;
    const totalCost = (cost ? cost.approxUsd : 0) + enrichCost;

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }

    function closeModal() { modalRoot.innerHTML = ''; }
    // Per-upload state (closed over by send()). The checkbox in the
    // modal mutates this so the chain runs only when opted in.
    const uploadOpts = { autoEnrich: true };

    async function sendToClaude() {
      const sendBtn = modalRoot.querySelector('[data-send]');
      const cancelBtn = modalRoot.querySelector('[data-cancel]');
      const status = modalRoot.querySelector('[data-status]');
      sendBtn.disabled = true;
      cancelBtn.disabled = true;
      status.style.display = 'block';
      status.style.color = '';
      status.textContent = '⏳ ' + t('fbar.upload.status.sending', { name: file.name });
      try {
        const result = await TB.ai.callClaudeVisionForExtraction(
          file,
          'generic',
          { year: activeYear },
        );
        const partialNote = result.extracted && result.extracted._partial
          ? ' ⚠ ' + t('fbar.upload.status.partial')
          : '';
        const costNote = result.cost_usd
          ? ' · $' + result.cost_usd.toFixed(4)
          : '';
        status.textContent = '✓ ' + t('fbar.upload.status.applying') + partialNote + costNote;
        // Account-number-based merge check (post-extraction).
        // Hash check (pre-extraction) catches re-uploads of the same
        // file. But two different scans of the same physical account
        // (e.g. early-passbook + later-passbook for one account)
        // have different file hashes — we have to compare the
        // EXTRACTED account number against existing records to catch
        // those. Only runs for new uploads (the user already chose
        // "merge" in the hash-dup path if applicable).
        let mergeTarget = null;
        if (!isUpdate && result.extracted && result.extracted.account_number) {
          mergeTarget = findAccountByNumber(result.extracted.account_number);
        }

        // If the extracted account number matches an existing account
        // AND the user hasn't already chosen the merge path via the
        // duplicate-modal flow, ask them now whether to merge.
        if (mergeTarget) {
          const decision = await openAccountNumberMergeChoice(mergeTarget, result, file);
          if (decision === 'cancel') {
            closeModal();
            return;
          }
          if (decision === 'merge') {
            try {
              applyExtractionToExistingAccount(mergeTarget.id, result.extracted, file.name, hash, result.usage);
            } catch (applyErr) {
              console.error('[fbar.upload] merge apply threw:', applyErr);
            }
            closeModal();
            try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
            return;
          }
          // 'new' falls through to the normal new-account path
        }

        // Apply the extraction. Capture the resulting account id +
        // any pending name-conflict; we'll open the conflict modal
        // AFTER closeModal to avoid the modal-stacking gotcha
        // (consent modal's closeModal() does innerHTML='' on the
        // shared modal-root, wiping anything appended underneath).
        let accountIdForEnrich = null;
        let pendingNameConflict = null;
        try {
          if (isUpdate) {
            applyExtractionToExistingAccount(existingAccount.id, result.extracted, file.name, hash, result.usage);
            accountIdForEnrich = existingAccount.id;
          } else {
            const out = applyExtractionToNewAccount(result.extracted, file.name, result.usage, hash, preselectedFilerIds);
            if (out && typeof out === 'object') {
              accountIdForEnrich = out.accountId;
              pendingNameConflict = out.pendingNameConflict || null;
            } else {
              accountIdForEnrich = out;  // legacy callers returning bare id
            }
          }
        } catch (applyErr) {
          console.error('[fbar.upload] apply step threw:', applyErr);
        }

        // Auto-enrich chain. Only fills empty fields — never
        // overwrites extracted data. Failures here are non-fatal:
        // the upload is already complete; we just log and move on.
        if (uploadOpts.autoEnrich && accountIdForEnrich) {
          status.textContent = '✨ ' + t('fbar.upload.status.enriching');
          try {
            const enrichResult = await runAutoEnrichForAccount(accountIdForEnrich);
            if (enrichResult.filled.length > 0) {
              console.info('[fbar.upload] auto-enrich filled', enrichResult.filled);
            }
            status.textContent = '✓ ' + t('fbar.upload.status.applying') +
              ' · enriched ' + enrichResult.filled.length + ' field(s)' +
              (enrichResult.cost_usd ? ' · $' + (result.cost_usd + enrichResult.cost_usd).toFixed(4) : '');
          } catch (enrichErr) {
            console.warn('[fbar.upload] auto-enrich failed (non-fatal):', enrichErr);
          }
        }

        closeModal();
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}

        // NOW open the conflict modal — modal-root is empty, so the
        // newly-appended modal won't get wiped.
        if (pendingNameConflict) {
          openNameConflictModal(pendingNameConflict);
        }
      } catch (err) {
        console.error('[fbar.upload]', err);
        status.style.color = 'var(--tb-error)';
        status.textContent = '✗ ' + (err && err.message ? err.message : String(err));
        sendBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    }

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } }, t('fbar.upload.modal.title')),
      el('div', {
        class: 'tb-card-meta',
        style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)' },
      },
        el('div', null, '📎 ', el('strong', null, file.name)),
        el('div', null, sizeKb + ' KB · ' + (file.type || 'unknown') + ' · ' + cls.toUpperCase()),
      ),
      el('div', { class: 'tb-disclaimer-inline', style: { borderLeftColor: 'var(--tb-warn)' } },
        t('fbar.upload.modal.body'),
      ),
      el('div', { class: 'tb-card-meta' },
        el('div', null, t('fbar.upload.modal.destination') + ': api.anthropic.com'),
        el('div', null, t('fbar.upload.modal.model') + ': ' + TB.ai.getModel()),
        cost ? el('div', { 'data-cost-line': '' }, '') : null,
      ),
      // Auto-enrich opt-in checkbox. Defaults ON because Ben asked
      // for AI features that logically chain to do so by default
      // (see feedback memory: "Chain AI features by default").
      el('label', {
        class: 'tb-checkbox',
        style: { marginTop: 'var(--tb-sp-3)' },
      },
        el('input', {
          type: 'checkbox',
          checked: uploadOpts.autoEnrich,
          onchange: (e) => {
            uploadOpts.autoEnrich = !!e.target.checked;
            updateCostLine();
          },
        }),
        el('div', null,
          el('div', null, t('fbar.upload.autoEnrich.label')),
          el('small', null, t('fbar.upload.autoEnrich.help')),
        ),
      ),
      el('div', {
        'data-status': '',
        class: 'tb-card-meta',
        style: { display: 'none', marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
      }),
      el('div', { class: 'tb-btn-row' },
        el('button', {
          'data-cancel': '',
          class: 'tb-btn tb-btn--secondary',
          onclick: closeModal,
        }, t('fbar.upload.cancel')),
        el('button', {
          'data-send': '',
          class: 'tb-btn',
          onclick: sendToClaude,
        }, t('fbar.upload.send')),
      ),
    );

    function updateCostLine() {
      const node = modalRoot.querySelector('[data-cost-line]');
      if (!node || !cost) return;
      const enrichLine = uploadOpts.autoEnrich
        ? ' + ~$' + enrichCost.toFixed(3) + ' enrich = ~$' + totalCost.toFixed(3) + ' total'
        : '';
      node.textContent = t('fbar.upload.modal.cost') + ': ~$' + cost.approxUsd.toFixed(3) +
        ' (' + cost.approxInputTokens + ' in + ' + cost.approxOutputTokens + ' out)' + enrichLine;
    }
    setTimeout(updateCostLine, 0);

    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);

    modalRoot.appendChild(backdrop);
  }

  // ====================================================================
  // AI ENRICH ACCOUNT — institution-info lookup, user-initiated
  // ====================================================================
  //
  // Click "✨ AI enrich" on an account card to ask Claude to fill in
  // canonical institution facts (HQ address, English name, etc.) for
  // that institution. Only the institution-level summary leaves the
  // browser — never the account number, filers, balances, or notes.
  //
  // Flow: openEnrichConsentModal → Claude call → openEnrichReviewModal
  // → user picks per-field which suggestions to apply → state update.

  function openEnrichConsentModal(accountId) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const acct = findAccount(accountId);
    if (!acct) return;

    if (!TB.ai || !TB.ai.hasKey()) {
      const msg = t('fbar.upload.noKey.body');
      if (confirm(msg + '\n\n' + t('fbar.upload.noKey.openSettings') + '?')) {
        document.dispatchEvent(new CustomEvent('tb:navigate', { detail: { view: 'settings' } }));
      }
      return;
    }

    const summary = TB.ai.buildEnrichmentInput(acct);

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    async function send() {
      const sendBtn = modalRoot.querySelector('[data-send]');
      const cancelBtn = modalRoot.querySelector('[data-cancel]');
      const status = modalRoot.querySelector('[data-status]');
      sendBtn.disabled = true;
      cancelBtn.disabled = true;
      status.style.display = 'block';
      status.style.color = '';
      status.textContent = '⏳ ' + t('fbar.enrich.status.sending', {
        name: acct.institution_name,
      });
      try {
        const result = await TB.ai.enrichAccountWithAi(summary);
        const costNote = result.cost_usd ? ' · $' + result.cost_usd.toFixed(4) : '';
        status.textContent = '✓ ' + t('fbar.enrich.status.review') + costNote;
        // Close the consent modal FIRST, then open the review modal.
        // Both modals share the same #tb-modal-root container; if we
        // close after opening, closeModal() (innerHTML='') wipes the
        // review modal we just appended.
        closeModal();
        openEnrichReviewModal(accountId, result.suggestions);
      } catch (err) {
        console.error('[fbar.enrich]', err);
        status.style.color = 'var(--tb-error)';
        status.textContent = '✗ ' + (err && err.message ? err.message : String(err));
        sendBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    }

    const summaryRows = el('div', {
      style: {
        background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
        padding: 'var(--tb-sp-3)', marginBottom: 'var(--tb-sp-3)',
        fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)',
      },
    });
    for (const [k, v] of Object.entries(summary)) {
      summaryRows.appendChild(el('div', null,
        el('span', { style: { color: 'var(--tb-text-soft)' } }, k + ': '),
        el('span', null, v == null ? 'null' : String(v)),
      ));
    }

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } }, '✨ ' + t('fbar.enrich.modal.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.enrich.modal.body')),
      el('div', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-2)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 'var(--tb-fs-12)' } },
        t('fbar.enrich.modal.willSend'),
      ),
      summaryRows,
      el('div', { class: 'tb-disclaimer-inline' },
        t('fbar.enrich.modal.privacy'),
      ),
      el('div', { class: 'tb-card-meta' },
        el('div', null, t('fbar.upload.modal.destination') + ': api.anthropic.com'),
        el('div', null, t('fbar.upload.modal.model') + ': ' + TB.ai.getModel()),
        el('div', null, t('fbar.enrich.modal.costEstimate')),
      ),
      el('div', {
        'data-status': '',
        class: 'tb-card-meta',
        style: { display: 'none', marginTop: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)' },
      }),
      el('div', { class: 'tb-btn-row' },
        el('button', { 'data-cancel': '', class: 'tb-btn tb-btn--secondary', onclick: closeModal },
          t('fbar.upload.cancel')),
        el('button', { 'data-send': '', class: 'tb-btn', onclick: send },
          t('fbar.enrich.modal.send')),
      ),
    );
    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);
    modalRoot.appendChild(backdrop);
  }

  // Per-field review modal. Shows current value vs AI suggestion for
  // each field; user checks the suggestions to accept and clicks
  // Apply. Suggestions for fields where current and AI agree (or AI
  // returned null) are not shown.
  function openEnrichReviewModal(accountId, suggestions) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const acct = findAccount(accountId);
    if (!acct || !suggestions) return;

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    // Map AI output fields → account fields. Each AI field maps to
    // a DISTINCT account field — don't double-map (e.g., earlier
    // versions had institution_name_en and institution_name_jp both
    // mapping to acct.institution_name, which made one always
    // overwrite the other).
    const candidates = [
      { aiField: 'institution_name_en',    acctField: 'institution_name',        label: t('fbar.accounts.institution_name') },
      { aiField: 'institution_name_jp',    acctField: 'institution_name_jp',     label: t('fbar.accounts.institution_name_jp') },
      { aiField: 'institution_address',    acctField: 'institution_address',     label: t('fbar.accounts.institution_address') },
      { aiField: 'institution_address_jp', acctField: 'institution_address_jp',  label: t('fbar.accounts.institution_address_jp') },
      { aiField: 'country',                acctField: 'country',                 label: t('fbar.accounts.country') },
      { aiField: 'currency_suggestion',    acctField: 'currency',                label: t('fbar.accounts.currency') },
      { aiField: 'account_type_suggestion', acctField: 'account_type',           label: t('fbar.accounts.account_type'),
        renderValue: (v) => v ? t('fbar.accounts.account_type.' + v) : '—' },
      { aiField: 'notes',                  acctField: 'notes',                   label: t('fbar.accounts.notes'),
        appendMode: true },
    ];

    console.info('[fbar.enrich] Suggestions from Claude:', suggestions);

    // Filter to only fields where AI returned a value AND it differs
    // from the current account value (or current is empty).
    const rows = [];
    for (const c of candidates) {
      const aiVal = suggestions[c.aiField];
      if (aiVal == null || aiVal === '') continue;
      const curVal = acct[c.acctField] != null ? acct[c.acctField] : '';
      // Skip when current value matches the suggestion exactly.
      if (String(curVal).trim() === String(aiVal).trim() && !c.appendMode) continue;
      rows.push({
        ...c,
        currentValue: curVal,
        suggestedValue: aiVal,
        accept: !curVal,   // default: accept if field was empty
      });
    }

    const conf = suggestions.confidence;
    const confLabel = conf
      ? ' (' + t('fbar.enrich.review.confidence') + ': ' + conf + ')'
      : '';

    function applyAccepted() {
      const accounts = getAccounts();
      const idx = accounts.findIndex(a => a.id === accountId);
      if (idx < 0) {
        console.warn('[fbar.enrich] Account not found:', accountId);
        closeModal();
        return;
      }
      const patch = {};
      for (const r of rows) {
        console.info('[fbar.enrich] Row', r.label, '— accept:', r.accept, '— current:', r.currentValue, '— suggested:', r.suggestedValue);
        if (!r.accept) continue;
        if (r.appendMode) {
          const cur = accounts[idx][r.acctField] || '';
          const sep = cur ? '\n\n' : '';
          patch[r.acctField] = cur + sep + '[AI enrich] ' + r.suggestedValue;
        } else {
          patch[r.acctField] = r.suggestedValue;
        }
      }
      console.info('[fbar.enrich] Patch to apply:', patch);
      if (Object.keys(patch).length > 0) {
        accounts[idx] = Object.assign({}, accounts[idx], patch);
        setAccounts(accounts);
        console.info('[fbar.enrich] Applied', Object.keys(patch).length, 'field(s) to account', accountId, '— resulting account:', accounts[idx]);
      } else {
        console.info('[fbar.enrich] No fields accepted — nothing applied');
      }
      closeModal();
      renderActiveTab();
    }

    function buildRow(r, i) {
      const checkbox = el('input', {
        type: 'checkbox', checked: r.accept,
        onchange: (e) => { rows[i].accept = e.target.checked; },
      });
      const renderFn = r.renderValue || ((v) => v == null || v === '' ? '—' : String(v));
      return el('label', {
        class: 'tb-checkbox' + (r.accept ? ' is-selected' : ''),
        style: { alignItems: 'flex-start', display: 'flex', gap: 'var(--tb-sp-3)', padding: 'var(--tb-sp-3)' },
      },
        checkbox,
        el('div', { style: { flex: '1 1 auto' } },
          el('div', { style: { fontWeight: 500, marginBottom: 'var(--tb-sp-1)' } }, r.label),
          el('div', { style: { display: 'grid', gridTemplateColumns: '90px 1fr', gap: 'var(--tb-sp-1) var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)' } },
            el('span', { style: { color: 'var(--tb-text-soft)' } }, t('fbar.conflict.existing') + ':'),
            el('span', null, renderFn(r.currentValue)),
            el('span', { style: { color: 'var(--tb-text-soft)' } }, '⚡ ' + t('fbar.conflict.extracted') + ':'),
            el('span', { style: { color: 'var(--tb-navy)', fontWeight: 500 } }, renderFn(r.suggestedValue)),
          ),
          r.appendMode
            ? el('small', { style: { color: 'var(--tb-text-soft)' } }, t('fbar.enrich.review.appendMode'))
            : null,
        ),
      );
    }

    const list = rows.length === 0
      ? el('p', { class: 'tb-card-meta' }, '✓ ' + t('fbar.enrich.review.nothingToApply'))
      : el('div', { style: { display: 'grid', gap: 'var(--tb-sp-2)' } },
          ...rows.map(buildRow),
        );

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } }, '✨ ' + t('fbar.enrich.review.title') + confLabel),
      el('p', { class: 'tb-card-meta' }, t('fbar.enrich.review.body', {
        institution: acct.institution_name || '—',
      })),
      suggestions.notes
        ? el('div', { class: 'tb-disclaimer-inline', style: { borderLeftColor: 'var(--tb-navy)' } },
            '💡 ', el('strong', null, suggestions.notes),
          )
        : null,
      list,
      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: closeModal },
          t('fbar.action.cancel')),
        rows.length > 0
          ? el('button', { class: 'tb-btn', onclick: applyAccepted },
              t('fbar.enrich.review.apply'))
          : el('button', { class: 'tb-btn', onclick: closeModal },
              t('fbar.action.done')),
      ),
    );

    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);
    modalRoot.appendChild(backdrop);
  }

  function applyExtractionToNewAccount(extracted, sourceFile, usage, sourceHash, preselectedFilerIds) {
    if (!extracted) return;
    // Always log the full extraction for diagnostics. The user can
    // open DevTools → Console to see exactly what the model returned
    // when extraction quality is in question.
    console.info('[fbar.upload] Extraction result for', sourceFile, ':', extracted);

    // Multi-account dispatch: if the model returned `accounts[]` with
    // 2+ entries, treat the document as a multi-account source (FD
    // certificate with sub-deposits, etc.) and create N records,
    // each inheriting shared metadata from the top-level fields.
    if (Array.isArray(extracted.accounts) && extracted.accounts.length >= 2) {
      console.info('[fbar.upload] multi-account dispatch:', extracted.accounts.length, 'sub-accounts');
      return applyMultiAccountExtraction(extracted, sourceFile, usage, sourceHash, preselectedFilerIds);
    }

    const filers = getFilers();
    const accounts = getAccounts();

    const fresh = blankAccount();
    // Institution name: model may return either a plain `institution_name`
    // (older path) OR both `institution_name_en` and `institution_name_jp`
    // (preferred). Route them to the appropriate fields.
    if (extracted.institution_name_en)  fresh.institution_name = extracted.institution_name_en;
    else if (extracted.institution_name && !containsJapanese(extracted.institution_name)) {
      fresh.institution_name = extracted.institution_name;
    }
    if (extracted.institution_name_jp)  fresh.institution_name_jp = extracted.institution_name_jp;
    else if (extracted.institution_name && containsJapanese(extracted.institution_name)) {
      fresh.institution_name_jp = extracted.institution_name;
    }
    if (extracted.institution_address) fresh.institution_address = extracted.institution_address;
    if (extracted.institution_address_jp) fresh.institution_address_jp = extracted.institution_address_jp;
    if (extracted.country)             fresh.country = String(extracted.country).toUpperCase().slice(0, 5);
    if (extracted.currency)            fresh.currency = String(extracted.currency).toUpperCase().slice(0, 4);
    if (extracted.account_type && ['bank', 'securities', 'other'].indexOf(extracted.account_type) !== -1) {
      fresh.account_type = extracted.account_type;
    }
    if (extracted.account_number)      fresh.account_number_full = String(extracted.account_number);
    if (extracted.extraction_notes)    fresh.notes = extracted.extraction_notes;

    // Filer ownership: prefer the user's explicit pre-upload choice
    // from the chooser modal. If none was supplied (single-filer
    // household, or chooser cancelled), fall back to the
    // auto-attach for one-filer households. Resolved BEFORE the
    // open/close-year validation below so the DOB sanity check can
    // look up the primary filer.
    if (Array.isArray(preselectedFilerIds) && preselectedFilerIds.length > 0) {
      // Filter to valid filer ids only.
      const validIds = preselectedFilerIds.filter(
        id => filers.find(f => f.id === id),
      );
      if (validIds.length > 0) fresh.filer_ids = validIds;
    } else if (filers.length === 1) {
      fresh.filer_ids = [filers[0].id];
    }

    // opened_year / closed_year — only set if the model EXPLICITLY
    // returned them (i.e., there was a visible opening/closure date
    // on the document). DO NOT infer from years_covered earliest;
    // that conflated "year had activity" with "account opened".
    //
    // Multiple sanity checks catch era-misconversion bugs (R5 read
    // as 2005 instead of 2023, H17 confused with H7, etc.) and
    // deposit/payment-row confusion on Japanese passbook scans:
    //   - opened_year > today          → reject (future)
    //   - opened_year < filer DOB year → reject (impossible)
    //   - closed_year < opened_year    → reject (impossible)
    //   - closed_year === opened_year  → warn (often a misread)
    {
      const todayYr = new Date().getUTCFullYear();

      // Look up primary filer's DOB year, if any, so we can reject
      // open dates earlier than the account holder was born.
      const primaryFiler = filers.find(f => f.id === fresh.filer_ids[0]);
      let filerDobYear = null;
      if (primaryFiler && primaryFiler.dob) {
        const dy = parseInt(String(primaryFiler.dob).slice(0, 4), 10);
        if (dy >= 1900 && dy <= 2200) filerDobYear = dy;
      }

      const warn = (msg) => {
        fresh._extracted_warnings = (fresh._extracted_warnings || []).concat([msg]);
        console.warn('[fbar.upload]', msg);
      };

      const oy = parseInt(extracted.opened_year, 10);
      let openYrValid = false;
      if (isFinite(oy)) {
        if (oy > todayYr) {
          warn('Extracted opened_year "' + oy + '" is in the future — likely a Japanese-era misread. Year Opened left blank.');
        } else if (filerDobYear && oy < filerDobYear) {
          warn('Extracted opened_year "' + oy + '" is before the account owner\'s ' +
            'date of birth (' + primaryFiler.dob + ') — impossible. Likely an era ' +
            'misread (e.g., R5 read as 2005 instead of 2023). Year Opened left blank.');
        } else if (oy < 1900) {
          warn('Extracted opened_year "' + oy + '" is before 1900 — ignored.');
        } else {
          openYrValid = true;
          fresh.opened_year = oy;
        }
      }

      const cy = parseInt(extracted.closed_year, 10);
      if (isFinite(cy)) {
        if (cy > todayYr + 100) {
          warn('Extracted closed_year "' + cy + '" is more than 100 years out — likely an era misconversion. Year Closed left blank.');
        } else if (filerDobYear && cy < filerDobYear) {
          warn('Extracted closed_year "' + cy + '" is before the account owner\'s date of birth — impossible. Year Closed left blank.');
        } else if (openYrValid && cy === oy) {
          warn('Extracted closed_year (' + cy + ') is the SAME YEAR as opened_year — ' +
            'unusual for a fixed deposit and a common indicator of date confusion ' +
            '(e.g., a payment-row date misread as the open date). Year Closed left blank for review.');
        } else if (openYrValid && cy < oy) {
          warn('Extracted closed_year (' + cy + ') is BEFORE opened_year (' + oy + ') — impossible. Year Closed left blank.');
        } else if (cy >= 1900 && cy <= todayYr) {
          fresh.closed_year = cy;
        }
        // Future closed_year (cy > today, ≤ today+100): leave blank;
        // FD may still be in its term.
      }
    }

    // If exactly one filer is on this account, try to backfill that
    // filer's name fields from what the scan extracted. Empty fields
    // get auto-filled silently; conflicts (existing value differs from
    // scan) are queued for a resolution modal after the main render.
    let pendingNameConflict = null;
    if (fresh.filer_ids.length === 1) {
      pendingNameConflict = maybePopulateFilerFromExtraction(fresh.filer_ids[0], extracted);
    }

    // Metadata for the verification banner. Underscore prefix = transient
    // metadata, not part of the FBAR record itself; the user can clear
    // it by clicking "Mark verified."
    fresh._extracted_from = sourceFile;
    fresh._extracted_at = new Date().toISOString();
    fresh._extracted_source_hash = sourceHash || null;
    fresh._extracted_confidence = extracted.confidence || null;
    fresh._extracted_holder_name = extracted.account_holder_name || null;
    fresh._extracted_holder_name_jp = extracted.account_holder_name_jp || null;
    fresh._extracted_usage = usage || null;
    fresh._extracted_partial = !!extracted._partial;
    fresh._verified = false;
    // Deep-extraction outputs: only persist if non-trivial.
    if (Array.isArray(extracted.warnings) && extracted.warnings.length > 0) {
      fresh._extracted_warnings = extracted.warnings.slice();
    }
    if (Array.isArray(extracted.consolidated_entries) && extracted.consolidated_entries.length > 0) {
      fresh._extracted_consolidated_entries = extracted.consolidated_entries.slice();
    }
    if (Array.isArray(extracted.fd_references) && extracted.fd_references.length > 0) {
      fresh._extracted_fd_references = extracted.fd_references.slice();
    }
    if (extracted.carry_over_balance != null) {
      const co = parseFloat(extracted.carry_over_balance);
      if (isFinite(co)) fresh._extracted_carry_over_balance = co;
    }

    accounts.unshift(fresh);
    setAccounts(accounts);

    // Create yearly_balance rows. Three-tier fallback so the multi-
    // year case works regardless of which output shape the model
    // returns:
    //
    //   (1) Preferred — model populated `years_covered`. One entry
    //       per calendar year with that year's max + date.
    //
    //   (2) Fallback — model populated only `balance_entries` (raw
    //       transaction rows). We group by ISO year prefix and take
    //       the per-year max client-side. This covers the case where
    //       the model returns the chronological transaction list
    //       (which is what the prompt explicitly asks for) but
    //       forgets to also produce the years_covered summary.
    //
    //   (3) Single-year fallback — only `extracted.year` and
    //       `max_balance_native` are set. Used for screenshots and
    //       short statements that genuinely cover one year.
    let yearEntries = [];

    if (Array.isArray(extracted.years_covered) && extracted.years_covered.length > 0) {
      for (const e of extracted.years_covered) {
        const yr = parseInt(e && e.year, 10);
        const max = parseFloat(e && e.max_balance_native);
        if (!isFinite(max) || !(yr >= 1900 && yr <= 2200)) continue;
        yearEntries.push({
          year: yr,
          max: max,
          date: (e && e.max_balance_date) || '',
        });
      }
    }

    if (yearEntries.length === 0
        && Array.isArray(extracted.balance_entries)
        && extracted.balance_entries.length > 0) {
      const byYear = {};
      for (const e of extracted.balance_entries) {
        if (!e) continue;
        const date = String(e.date || '');
        const yr = parseInt(date.slice(0, 4), 10);
        const bal = parseFloat(e.balance_native);
        if (!isFinite(bal) || !(yr >= 1900 && yr <= 2200)) continue;
        if (!byYear[yr] || bal > byYear[yr].max) {
          byYear[yr] = { max: bal, date };
        }
      }
      yearEntries = Object.entries(byYear).map(([yr, info]) => ({
        year: parseInt(yr, 10),
        max: info.max,
        date: info.date,
      }));
      if (yearEntries.length > 0) {
        console.info('[fbar.upload] derived', yearEntries.length, 'years from balance_entries fallback');
      }
    }

    // Deep-passbook fallback: if the model returned `transactions[]`
    // (every-row format from the deep-analysis prompt) but skipped
    // `years_covered`, derive per-year max from those rows. Each row
    // has `balance` (running 差引残高 after the row).
    if (yearEntries.length === 0
        && Array.isArray(extracted.transactions)
        && extracted.transactions.length > 0) {
      const byYear = {};
      for (const e of extracted.transactions) {
        if (!e) continue;
        const date = String(e.date || '');
        const yr = parseInt(date.slice(0, 4), 10);
        const bal = parseFloat(e.balance);
        if (!isFinite(bal) || !(yr >= 1900 && yr <= 2200)) continue;
        if (!byYear[yr] || bal > byYear[yr].max) {
          byYear[yr] = { max: bal, date };
        }
      }
      yearEntries = Object.entries(byYear).map(([yr, info]) => ({
        year: parseInt(yr, 10),
        max: info.max,
        date: info.date,
      }));
      if (yearEntries.length > 0) {
        console.info('[fbar.upload] derived', yearEntries.length, 'years from transactions[] fallback');
      }
    }

    if (yearEntries.length === 0
        && extracted.year
        && extracted.max_balance_native != null) {
      const yr = parseInt(extracted.year, 10);
      const max = parseFloat(extracted.max_balance_native);
      if (isFinite(max) && yr >= 1900 && yr <= 2200) {
        yearEntries.push({
          year: yr,
          max: max,
          date: extracted.max_balance_date || '',
        });
      }
    }

    let extractedYearsList = [];
    let carryForwardCount = 0;
    if (yearEntries.length > 0 && fresh.currency) {
      const balances = getBalances();
      // Sort ascending so older years come first in state.
      yearEntries.sort((a, b) => a.year - b.year);

      // Defensive carry-forward fill. The model is asked to handle
      // dormant years itself (per the prompt's CARRY-FORWARD section)
      // but we backfill any gaps it leaves between extracted years
      // AND extend forward to the current year if the account has no
      // closed_year set. A dormant account's max balance for a year
      // with no transactions is the prior year's closing balance —
      // we approximate using the prior year's max (conservative for
      // FBAR purposes; user can edit).
      const filledEntries = fillCarryForwardYears(yearEntries, fresh.closed_year);

      for (const entry of filledEntries) {
        const fxInfo = fxRateFor(fresh.currency, entry.year);
        const usd = fresh.currency === 'USD'
          ? entry.max
          : (fxInfo.rate ? entry.max / fxInfo.rate : null);
        const noteSuffix = entry._carry_forward
          ? 'Carry-forward from ' + entry._carried_from + ' (no transactions detected — verify before filing)'
          : 'AI-extracted from ' + sourceFile;
        balances.push({
          id: TB.utils.uuid(),
          account_id: fresh.id,
          year: String(entry.year),
          max_balance_native: entry.max,
          max_balance_date: entry.date,
          fx_rate_used: fxInfo.rate,
          fx_rate_source: fxInfo.source || (fresh.currency === 'USD' ? 'USD' : ''),
          fx_rate_overridden: false,
          max_balance_usd: usd,
          notes: noteSuffix,
        });
        extractedYearsList.push(entry.year);
        if (entry._carry_forward) carryForwardCount += 1;
      }
      setBalances(balances);
      if (carryForwardCount > 0) {
        console.info('[fbar.upload] Filled', carryForwardCount, 'carry-forward year(s) for dormant periods.');
      }
      // Stamp the extracted-years list onto the account record so
      // the verification banner can show it. NOTE: deliberately do
      // NOT widen opened_year from the earliest extracted year —
      // that conflated "year had visible activity" with "account
      // opened in that year". opened_year is now set ONLY from an
      // explicit account-opening date on the document (handled
      // earlier in this function via extracted.opened_year).
      const accountsAfter = getAccounts();
      const myIdx = accountsAfter.findIndex(a => a.id === fresh.id);
      if (myIdx >= 0) {
        accountsAfter[myIdx] = Object.assign({}, accountsAfter[myIdx], {
          _extracted_years: extractedYearsList.slice(),
        });
        setAccounts(accountsAfter);
      }
      // Default the Yearly Balances tab to the latest extracted
      // year so the user immediately sees data when they navigate
      // there.
      activeYear = String(extractedYearsList[extractedYearsList.length - 1]);
    }

    console.info('[fbar.upload] Created', extractedYearsList.length, 'balance entries for years:', extractedYearsList);

    // Clear any active account filters so the freshly-unshifted
    // account is always visible. Otherwise an existing filter
    // (e.g., "show filer = Filer A") could hide a new account
    // that auto-attached to a different filer (e.g., Filer B),
    // making the upload look like it silently failed.
    accountFilters = { filerId: '', year: '', currency: '' };
    balancesFilterFilerId = '';

    activeTab = 'accounts';
    render(host);

    // Return BOTH the new account id AND the pending name conflict
    // (if any). The caller (sendToClaude) is responsible for opening
    // the conflict modal AFTER the consent modal closes — opening
    // them in the wrong order causes the consent modal's
    // `closeModal()` (innerHTML='' on shared modal-root) to wipe the
    // freshly-opened conflict modal.
    return { accountId: fresh.id, pendingNameConflict };
  }

  // Auto-enrich for a freshly-uploaded account. Runs the same
  // enrichAccountWithAi call as the explicit "✨ AI enrich" button,
  // but applies suggestions ONLY to empty fields (never overwrites
  // extracted data). Returns { filled: [], cost_usd: number }.
  async function runAutoEnrichForAccount(accountId) {
    const acct = findAccount(accountId);
    if (!acct) return { filled: [], cost_usd: 0 };
    if (!TB.ai.hasKey()) return { filled: [], cost_usd: 0 };

    const summary = TB.ai.buildEnrichmentInput(acct);
    const result = await TB.ai.enrichAccountWithAi(summary);
    const suggestions = result.suggestions || {};

    // Same field map as the explicit enrich review modal — but
    // applied silently and only to empty fields.
    const candidates = [
      { ai: 'institution_name_en',    acct: 'institution_name' },
      { ai: 'institution_name_jp',    acct: 'institution_name_jp' },
      { ai: 'institution_address',    acct: 'institution_address' },
      { ai: 'institution_address_jp', acct: 'institution_address_jp' },
      { ai: 'country',                acct: 'country' },
      // currency and account_type intentionally omitted — they have
      // non-empty defaults (JPY, bank) so the "only-if-empty" gate
      // wouldn't trigger anyway, and the model's suggestion isn't
      // necessarily better than what extraction picked up.
    ];

    const accounts = getAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return { filled: [], cost_usd: result.cost_usd || 0 };

    const patch = {};
    const filled = [];
    for (const c of candidates) {
      const aiVal = suggestions[c.ai];
      if (aiVal == null || aiVal === '') continue;
      const curVal = accounts[idx][c.acct] || '';
      if (String(curVal).trim()) continue; // skip non-empty
      patch[c.acct] = aiVal;
      filled.push(c.acct);
    }
    // Stash enrichment-summary notes onto the account for the
    // verification banner without touching the user-visible notes
    // field (which extraction populates with anomaly info).
    if (suggestions.notes) {
      patch._enriched_summary = String(suggestions.notes).slice(0, 500);
    }
    patch._enriched_at = new Date().toISOString();
    patch._enriched_filled = filled;

    if (Object.keys(patch).length > 0) {
      accounts[idx] = Object.assign({}, accounts[idx], patch);
      setAccounts(accounts);
      renderActiveTab();
    }
    return { filled, cost_usd: result.cost_usd || 0, summary: suggestions.notes || null };
  }

  // ====================================================================
  // DEFERRED — Auto-close filing from filed FBAR PDF (v0.3.x roadmap)
  // ====================================================================
  //
  // The "📥 Import FBAR" feature was removed in v0.2.36. It tried to
  // do too much (backfill years of accounts AND balances from a filed
  // PDF) and muddied the new-account flow.
  //
  // The narrower successor we want: when the user uploads a filed
  // FBAR PDF, extract just the BSA confirmation ID and filing date,
  // then look up the matching `filing_history` record by (filer, year)
  // and auto-toggle "I have filed this" with those values populated.
  // No account / balance backfill — that's what re-uploading bank
  // documents is for.
  //
  // Sketch:
  //   1. User on Filing tab → "Upload filed FBAR PDF" button
  //   2. Vision extracts: filer name, year, BSA confirmation ID, filed_on
  //   3. Match (filer, year) against filing_history; upsertFilingRecord
  //      with the extracted values
  //   4. Show a one-line confirmation: "✓ FBAR for {name} {year} marked
  //      as filed on {date} (BSA ID {id})"
  //
  // Build when there's actual demand. Until then, users mark filings
  // by hand on the Filing tab.

  // ====================================================================
  // EXISTING-ACCOUNT MERGE — re-uploaded document
  // ====================================================================
  //
  // When the user re-uploads a document we've already seen (matched
  // by SHA-256 of the file bytes), we DON'T create a second account.
  // Instead, we extract again and merge any newly-discovered yearly
  // balances into the existing account's balance set.
  //
  // Merge rules:
  //   - For each extracted year not in existing balances → ADD it.
  //   - For each extracted year that IS in existing balances:
  //       - if the values match → SKIP (no change).
  //       - if values differ → UPDATE the existing row to the
  //         extracted value and note the change. The new scan is
  //         assumed to be more recent / authoritative.
  //   - Account-level fields (institution_name, address, etc.) are
  //     left alone — the user has already curated those. Re-upload
  //     should add new data, not overwrite curation.
  //
  // Shows a summary modal afterwards listing what was added /
  // updated / skipped.
  // Multi-account documents (FD certificates with N sub-deposits,
  // brokerage statements with multiple sub-accounts, etc.) get one
  // top-level extraction containing an `accounts[]` array. We create
  // N separate account records, each:
  //   - inheriting shared metadata (institution, country, currency,
  //     address, etc.) from the top-level fields
  //   - overriding with per-entry fields when present
  //   - sharing the parent SHA-256 hash so all N hit the same
  //     duplicate-detection bucket on re-upload
  //   - cross-linked via `_extracted_sibling_ids` so the verification
  //     banner can show "1 of 5 accounts from this document".
  function applyMultiAccountExtraction(extracted, sourceFile, usage, sourceHash, preselectedFilerIds) {
    const filers = getFilers();
    const allAccounts = getAccounts();
    const subAccounts = extracted.accounts || [];
    if (subAccounts.length === 0) return null;

    // Resolve filer ownership once for all N children.
    let filerIds = [];
    if (Array.isArray(preselectedFilerIds) && preselectedFilerIds.length > 0) {
      filerIds = preselectedFilerIds.filter(id => filers.find(f => f.id === id));
    } else if (filers.length === 1) {
      filerIds = [filers[0].id];
    }

    // Pre-allocate ids so we can cross-reference siblings.
    const newIds = subAccounts.map(() => TB.utils.uuid());
    const created = [];

    subAccounts.forEach((sub, i) => {
      const fresh = blankAccount();
      fresh.id = newIds[i];
      fresh.filer_ids = filerIds.slice();

      // Inherit shared metadata from top-level
      if (extracted.institution_name)        fresh.institution_name = extracted.institution_name;
      if (extracted.institution_name_en)     fresh.institution_name = extracted.institution_name_en;
      if (extracted.institution_name_jp)     fresh.institution_name_jp = extracted.institution_name_jp;
      if (extracted.institution_address)     fresh.institution_address = extracted.institution_address;
      if (extracted.institution_address_jp)  fresh.institution_address_jp = extracted.institution_address_jp;
      if (extracted.country)                 fresh.country = String(extracted.country).toUpperCase().slice(0, 5);
      if (extracted.currency)                fresh.currency = String(extracted.currency).toUpperCase().slice(0, 4);
      if (extracted.account_type && ['bank', 'securities', 'other'].indexOf(extracted.account_type) !== -1) {
        fresh.account_type = extracted.account_type;
      }

      // Per-entry overrides
      if (sub.account_number)  fresh.account_number_full = String(sub.account_number);
      if (sub.account_type && ['bank', 'securities', 'other'].indexOf(sub.account_type) !== -1) {
        fresh.account_type = sub.account_type;
      }
      if (sub.currency) fresh.currency = String(sub.currency).toUpperCase().slice(0, 4);

      // Notes: combine per-entry notes with FD-specific structured info
      const noteParts = [];
      if (sub.notes) noteParts.push(String(sub.notes));
      if (sub.principal_amount != null) {
        noteParts.push('Principal: ' + Number(sub.principal_amount).toLocaleString() + ' ' + fresh.currency);
      }
      if (sub.interest_rate_pct != null) {
        noteParts.push('Rate: ' + sub.interest_rate_pct + '%');
      }
      if (sub.open_date) noteParts.push('Opened: ' + sub.open_date);
      if (sub.maturity_date) noteParts.push('Matures: ' + sub.maturity_date);
      if (noteParts.length > 0) fresh.notes = noteParts.join(' · ');

      // Opened/closed-year sanity checks. Vision extraction on aged
      // Japanese passbook scans can misread era prefixes (R5 vs H17
      // vs 平成24, etc.) or confuse deposit-row dates with payment-row
      // dates. The apply path enforces several invariants and rejects
      // values that violate them, surfacing warnings for user review.
      const today = new Date().getUTCFullYear();

      // Look up the primary filer's DOB year, if any — accounts can't
      // be opened before the account holder is born.
      const primaryFiler = filers.find(f => f.id === fresh.filer_ids[0]);
      let filerDobYear = null;
      if (primaryFiler && primaryFiler.dob) {
        const dy = parseInt(String(primaryFiler.dob).slice(0, 4), 10);
        if (dy >= 1900 && dy <= 2200) filerDobYear = dy;
      }

      const openYr = sub.open_date ? parseInt(String(sub.open_date).slice(0, 4), 10) : null;
      const matYr = sub.maturity_date ? parseInt(String(sub.maturity_date).slice(0, 4), 10) : null;

      function warn(msg) {
        if (!fresh._extracted_warnings) fresh._extracted_warnings = [];
        fresh._extracted_warnings.push(msg);
        console.warn('[fbar.upload]', msg);
      }

      let openYrValid = false;
      if (openYr != null && isFinite(openYr)) {
        if (openYr > today) {
          warn('Extracted open_date "' + sub.open_date + '" is in the future — ' +
            'likely a Japanese-era misconversion (平成 vs 令和, or maturity ' +
            'confused with deposit). Year Opened left blank.');
        } else if (filerDobYear && openYr < filerDobYear) {
          warn('Extracted open_date "' + sub.open_date + '" is before the account ' +
            'owner\'s date of birth (' + primaryFiler.dob + ') — impossible. ' +
            'Likely an era misread (e.g., R5 read as 2005 instead of 2023). ' +
            'Year Opened left blank.');
        } else if (openYr < 1900) {
          warn('Extracted open_date "' + sub.open_date + '" is before 1900 — ignored.');
        } else {
          openYrValid = true;
          fresh.opened_year = openYr;
        }
      }

      if (matYr != null && isFinite(matYr)) {
        if (matYr > today + 100) {
          warn('Extracted maturity_date "' + sub.maturity_date + '" is more than 100 ' +
            'years out — likely an era misconversion. Year Closed left blank.');
        } else if (filerDobYear && matYr < filerDobYear) {
          warn('Extracted maturity_date "' + sub.maturity_date + '" is before the ' +
            'account owner\'s date of birth — impossible. Year Closed left blank.');
        } else if (openYrValid && matYr === openYr) {
          // Same-year open and close: possible for very short-term
          // FDs but unusual. The model may have read a payment-row
          // date as the open_date — common 通帳 misread. Don't
          // auto-set closed_year; let the user verify.
          warn('Extracted maturity_date (' + sub.maturity_date + ') is the SAME YEAR as ' +
            'open_date (' + sub.open_date + ') — unusual for a fixed deposit and a ' +
            'common indicator of date confusion. Year Closed left blank for review.');
        } else if (openYrValid && matYr < openYr) {
          warn('Extracted maturity_date (' + sub.maturity_date + ') is BEFORE open_date ' +
            '(' + sub.open_date + ') — impossible. Year Closed left blank.');
        } else if (matYr >= 1900 && matYr < today) {
          fresh.closed_year = matYr;
        }
        // Future maturity dates (matYr >= today, < today+100): leave
        // closed_year null — FD is still in its term.
      }

      // Metadata
      fresh._extracted_from = sourceFile;
      fresh._extracted_at = new Date().toISOString();
      fresh._extracted_source_hash = sourceHash || null;
      fresh._extracted_confidence = extracted.confidence || null;
      fresh._extracted_usage = usage || null;
      fresh._extracted_partial = !!extracted._partial;
      fresh._verified = false;
      fresh._extracted_multi_account = true;
      fresh._extracted_sibling_ids = newIds.slice();
      fresh._extracted_sibling_index = i;
      fresh._extracted_sibling_count = subAccounts.length;

      allAccounts.unshift(fresh);
      created.push({ account: fresh, sub });
    });
    setAccounts(allAccounts);

    // Build yearly_balance rows for each sub-account
    const balances = getBalances();
    const yearsCreated = new Set();
    created.forEach(({ account, sub }) => {
      let yearEntries = [];
      if (Array.isArray(sub.years_covered) && sub.years_covered.length > 0) {
        for (const e of sub.years_covered) {
          const yr = parseInt(e && e.year, 10);
          const max = parseFloat(e && e.max_balance_native);
          if (!isFinite(max) || !(yr >= 1900 && yr <= 2200)) continue;
          yearEntries.push({ year: yr, max, date: (e && e.max_balance_date) || '' });
        }
      }
      const filled = fillCarryForwardYears(yearEntries, account.closed_year);
      const trackedYears = [];
      for (const entry of filled) {
        const fxInfo = fxRateFor(account.currency, entry.year);
        const usd = account.currency === 'USD'
          ? entry.max
          : (fxInfo.rate ? entry.max / fxInfo.rate : null);
        const noteSuffix = entry._carry_forward
          ? 'Carry-forward from ' + entry._carried_from + ' (no transactions detected — verify before filing)'
          : 'AI-extracted from ' + sourceFile;
        balances.push({
          id: TB.utils.uuid(),
          account_id: account.id,
          year: String(entry.year),
          max_balance_native: entry.max,
          max_balance_date: entry.date,
          fx_rate_used: fxInfo.rate,
          fx_rate_source: fxInfo.source || (account.currency === 'USD' ? 'USD' : ''),
          fx_rate_overridden: false,
          max_balance_usd: usd,
          notes: noteSuffix,
        });
        trackedYears.push(entry.year);
        yearsCreated.add(entry.year);
      }
      // Stamp the years on the account record so the verification banner
      // can show them.
      const allAfter = getAccounts();
      const idx = allAfter.findIndex(a => a.id === account.id);
      if (idx >= 0) {
        allAfter[idx] = Object.assign({}, allAfter[idx], { _extracted_years: trackedYears.slice() });
        setAccounts(allAfter);
      }
    });
    setBalances(balances);

    // Surface successful multi-account creation in console + reset
    // module filters so all new accounts are visible.
    console.info('[fbar.upload] multi-account: created', created.length, 'records, years touched:',
      Array.from(yearsCreated).sort());
    accountFilters = { filerId: '', year: '', currency: '' };
    balancesFilterFilerId = '';
    if (yearsCreated.size > 0) {
      activeYear = String(Math.max.apply(null, Array.from(yearsCreated)));
    }
    activeTab = 'accounts';
    render(host);

    // Return the FIRST sub-account's id so any downstream chain
    // (e.g. auto-enrich) targets a real record. Multi-account skips
    // the name-conflict path because there's no single "primary"
    // filer-name field to compare against.
    return { accountId: newIds[0], pendingNameConflict: null };
  }

  function applyExtractionToExistingAccount(accountId, extracted, sourceFile, sourceHash, usage) {
    if (!extracted) return;
    console.info('[fbar.upload-merge] Re-extraction for existing account', accountId, ':', extracted);

    const accounts = getAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    if (idx < 0) return;
    const existingAccount = accounts[idx];

    // Build the same yearEntries array as the new-account path.
    let yearEntries = [];
    if (Array.isArray(extracted.years_covered) && extracted.years_covered.length > 0) {
      for (const e of extracted.years_covered) {
        const yr = parseInt(e && e.year, 10);
        const max = parseFloat(e && e.max_balance_native);
        if (!isFinite(max) || !(yr >= 1900 && yr <= 2200)) continue;
        yearEntries.push({ year: yr, max, date: (e && e.max_balance_date) || '' });
      }
    }
    if (yearEntries.length === 0
        && Array.isArray(extracted.balance_entries)
        && extracted.balance_entries.length > 0) {
      const byYear = {};
      for (const e of extracted.balance_entries) {
        if (!e) continue;
        const date = String(e.date || '');
        const yr = parseInt(date.slice(0, 4), 10);
        const bal = parseFloat(e.balance_native);
        if (!isFinite(bal) || !(yr >= 1900 && yr <= 2200)) continue;
        if (!byYear[yr] || bal > byYear[yr].max) byYear[yr] = { max: bal, date };
      }
      yearEntries = Object.entries(byYear).map(([yr, info]) => ({
        year: parseInt(yr, 10), max: info.max, date: info.date,
      }));
    }
    if (yearEntries.length === 0
        && extracted.year && extracted.max_balance_native != null) {
      const yr = parseInt(extracted.year, 10);
      const max = parseFloat(extracted.max_balance_native);
      if (isFinite(max) && yr >= 1900 && yr <= 2200) {
        yearEntries.push({ year: yr, max, date: extracted.max_balance_date || '' });
      }
    }
    yearEntries.sort((a, b) => a.year - b.year);

    // Apply carry-forward fill same as the new-account path.
    const filled = fillCarryForwardYears(yearEntries, existingAccount.closed_year);

    const balances = getBalances();
    const summary = { added: [], updated: [], unchanged: [] };

    for (const entry of filled) {
      const yrStr = String(entry.year);
      const existingBal = balances.find(
        b => b.account_id === accountId && String(b.year) === yrStr,
      );
      if (!existingBal) {
        // Add new year row.
        const fxInfo = fxRateFor(existingAccount.currency, entry.year);
        const usd = existingAccount.currency === 'USD'
          ? entry.max
          : (fxInfo.rate ? entry.max / fxInfo.rate : null);
        const noteSuffix = entry._carry_forward
          ? 'Carry-forward from ' + entry._carried_from + ' (no transactions detected — verify before filing)'
          : 'AI-extracted from ' + sourceFile + ' (re-upload)';
        balances.push({
          id: TB.utils.uuid(),
          account_id: accountId,
          year: yrStr,
          max_balance_native: entry.max,
          max_balance_date: entry.date,
          fx_rate_used: fxInfo.rate,
          fx_rate_source: fxInfo.source || (existingAccount.currency === 'USD' ? 'USD' : ''),
          fx_rate_overridden: false,
          max_balance_usd: usd,
          notes: noteSuffix,
        });
        summary.added.push(entry.year);
      } else {
        // Existing year. Compare values.
        const sameMax = Math.abs((Number(existingBal.max_balance_native) || 0) - entry.max) < 0.01;
        if (sameMax) {
          summary.unchanged.push(entry.year);
        } else {
          // Update the existing balance — extracted value is treated
          // as the more recent / authoritative scan.
          const i = balances.findIndex(b => b.id === existingBal.id);
          if (i >= 0) {
            const fxInfo = fxRateFor(existingAccount.currency, entry.year);
            const usd = existingAccount.currency === 'USD'
              ? entry.max
              : (fxInfo.rate ? entry.max / fxInfo.rate : null);
            balances[i] = Object.assign({}, balances[i], {
              max_balance_native: entry.max,
              max_balance_date: entry.date || balances[i].max_balance_date,
              max_balance_usd: usd,
              notes: 'Updated from re-uploaded ' + sourceFile + ' (was ' + existingBal.max_balance_native + ')',
            });
            summary.updated.push({ year: entry.year, from: existingBal.max_balance_native, to: entry.max });
          }
        }
      }
    }
    setBalances(balances);

    // Refresh account metadata: bump _extracted_at, store new hash
    // (could be different from existing if user replaced a partial
    // upload with a full one).
    accounts[idx] = Object.assign({}, accounts[idx], {
      _extracted_at: new Date().toISOString(),
      _extracted_source_hash: sourceHash || accounts[idx]._extracted_source_hash,
      _extracted_from: sourceFile + ' (re-upload)',
    });
    setAccounts(accounts);

    accountFilters = { filerId: '', year: '', currency: '' };
    balancesFilterFilerId = '';
    activeTab = 'accounts';
    render(host);

    // Show what changed.
    setTimeout(() => openMergeSummaryModal(existingAccount, summary, sourceFile), 80);
  }

  function openMergeSummaryModal(account, summary, sourceFile) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    const fmtList = (arr) => arr.length ? arr.join(' · ') : '—';
    const fmtUpdates = summary.updated.length
      ? summary.updated.map(u => u.year + ' (' + u.from + ' → ' + u.to + ')').join(', ')
      : '—';

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } }, '🔁 ' + t('fbar.dup.summary.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.dup.summary.body', {
        institution: account.institution_name || account.institution_name_jp || '—',
        file: sourceFile,
      })),
      el('div', {
        style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)' },
      },
        el('div', null,
          el('strong', { style: { color: 'var(--tb-success)' } }, '✓ ' + t('fbar.dup.summary.added') + ': '),
          fmtList(summary.added),
        ),
        el('div', { style: { marginTop: 'var(--tb-sp-2)' } },
          el('strong', { style: { color: 'var(--tb-warn)' } }, '↻ ' + t('fbar.dup.summary.updated') + ': '),
          fmtUpdates,
        ),
        el('div', { style: { marginTop: 'var(--tb-sp-2)' } },
          el('strong', { style: { color: 'var(--tb-text-soft)' } }, '· ' + t('fbar.dup.summary.unchanged') + ': '),
          fmtList(summary.unchanged),
        ),
      ),
      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn', onclick: closeModal }, t('fbar.action.done')),
      ),
    );
    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);
    modalRoot.appendChild(backdrop);
  }

  // Promise-based modal that fires when an upload's EXTRACTED
  // account number matches an existing record (different file, same
  // account). Resolves to "merge" / "new" / "cancel".
  function openAccountNumberMergeChoice(existingAccount, result, file) {
    return new Promise((resolve) => {
      const el = TB.utils.el;
      const t = TB.i18n.t;
      const lang = TB.i18n.getLang();

      let modalRoot = document.getElementById('tb-modal-root');
      if (!modalRoot) {
        modalRoot = el('div', { id: 'tb-modal-root' });
        document.body.appendChild(modalRoot);
      }
      // Remove the consent modal we were showing before opening this.
      modalRoot.innerHTML = '';

      function pick(answer) {
        modalRoot.innerHTML = '';
        resolve(answer);
      }

      const ownerNames = (existingAccount.filer_ids || [])
        .map(id => findFiler(id))
        .filter(Boolean)
        .map(f => displayName(f, lang))
        .join(', ') || '—';
      const inst = existingAccount.institution_name
        || existingAccount.institution_name_jp
        || '(unnamed)';
      const extractedAcct = result.extracted && result.extracted.account_number || '—';

      const card = el('div', { class: 'tb-modal' },
        el('h2', { style: { marginTop: 0 } }, '🔀 ' + t('fbar.acctmatch.title')),
        el('p', { class: 'tb-card-meta' }, t('fbar.acctmatch.body')),
        el('div', {
          style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)' },
        },
          el('div', null,
            el('strong', null, inst),
            el('span', { class: 'tb-card-meta', style: { marginLeft: 'var(--tb-sp-2)' } },
              existingAccount.country + ' · ' + existingAccount.currency,
            ),
          ),
          el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } },
            '👤 ' + ownerNames,
          ),
          el('div', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', marginTop: 'var(--tb-sp-2)' } },
            t('fbar.acctmatch.existingNum') + ': ' + (existingAccount.account_number_full || '—'),
          ),
          el('div', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-navy)' } },
            t('fbar.acctmatch.extractedNum') + ': ' + extractedAcct,
          ),
        ),
        el('div', { class: 'tb-disclaimer-inline' }, t('fbar.acctmatch.explainer')),
        el('div', { style: { display: 'grid', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)' } },
          el('button', {
            class: 'tb-btn',
            onclick: () => pick('merge'),
          }, '↻ ' + t('fbar.acctmatch.choice.merge')),
          el('button', {
            class: 'tb-btn tb-btn--secondary',
            onclick: () => pick('new'),
          }, '+ ' + t('fbar.acctmatch.choice.new')),
          el('button', {
            class: 'tb-btn tb-btn--ghost',
            onclick: () => pick('cancel'),
          }, t('fbar.action.cancel')),
        ),
      );
      const backdrop = el('div', {
        class: 'tb-modal-backdrop',
        onclick: (e) => { if (e.target === backdrop) pick('cancel'); },
      }, card);
      modalRoot.appendChild(backdrop);
    });
  }

  function openDuplicateModal(file, hash, existingAccount) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    const ownerNames = (existingAccount.filer_ids || [])
      .map(id => findFiler(id))
      .filter(Boolean)
      .map(f => displayName(f, lang))
      .join(', ') || '—';
    const inst = existingAccount.institution_name
      || existingAccount.institution_name_jp
      || '(unnamed)';
    const originalUpload = existingAccount._extracted_at
      ? String(existingAccount._extracted_at).replace('T', ' ').slice(0, 19)
      : '—';

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } }, '🔁 ' + t('fbar.dup.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.dup.body')),
      el('div', {
        style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)', marginBottom: 'var(--tb-sp-3)' },
      },
        el('div', null,
          el('strong', null, inst),
          el('span', { class: 'tb-card-meta', style: { marginLeft: 'var(--tb-sp-2)' } },
            existingAccount.country + ' · ' + existingAccount.currency,
          ),
        ),
        el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } },
          '👤 ' + ownerNames,
        ),
        el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-1)' } },
          t('fbar.dup.originalFile') + ': ' + (existingAccount._extracted_from || '—'),
        ),
        el('div', { class: 'tb-card-meta' },
          t('fbar.dup.originalUpload') + ': ' + originalUpload,
        ),
        el('div', { class: 'tb-card-meta', style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-2)' } },
          'sha256: ' + (hash ? hash.slice(0, 16) + '…' : '—'),
        ),
      ),
      el('div', { class: 'tb-disclaimer-inline' }, t('fbar.dup.explainer')),
      el('div', { style: { display: 'grid', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)' } },
        el('button', {
          class: 'tb-btn',
          onclick: () => { closeModal(); showConsentModal(file, hash, existingAccount); },
        }, '↻ ' + t('fbar.dup.choice.update')),
        el('button', {
          class: 'tb-btn tb-btn--secondary',
          onclick: () => { closeModal(); showConsentModal(file, hash, null); },
        }, '+ ' + t('fbar.dup.choice.addNew')),
        el('button', {
          class: 'tb-btn tb-btn--ghost',
          onclick: closeModal,
        }, t('fbar.action.cancel')),
      ),
    );
    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);
    modalRoot.appendChild(backdrop);
  }

  function maybePopulateFilerFromExtraction(filerId, extracted) {
    if (!extracted) return null;
    const filers = getFilers();
    const i = filers.findIndex(f => f.id === filerId);
    if (i < 0) return null;
    const filer = filers[i];
    const exJp = extracted.account_holder_name_jp || null;
    const exEn = extracted.account_holder_name || null;

    const patch = {};
    let conflict = null;

    if (exJp) {
      if (!filer.name_jp) {
        patch.name_jp = exJp;
      } else if (normalizeName(filer.name_jp) !== normalizeName(exJp)) {
        conflict = {
          filerId,
          field: 'name_jp',
          existing: filer.name_jp,
          extracted: exJp,
          source: extracted._extracted_source || 'the uploaded document',
        };
      }
    }

    // English name: only auto-fill if empty. Conflict is rarely
    // useful here (many casing variations) so we don't prompt.
    if (exEn && !filer.name_en) {
      patch.name_en = exEn;
    }

    if (Object.keys(patch).length > 0) {
      filers[i] = Object.assign({}, filer, patch);
      setFilers(filers);
      console.info('[fbar.upload] Auto-filled filer fields from scan:', Object.keys(patch));
    }
    return conflict;
  }

  // Loose comparison for names — strips whitespace and trailing
  // punctuation. "鈴木 さくら" vs "鈴木さくら" → same.
  function normalizeName(s) {
    return String(s || '').replace(/\s+/g, '').replace(/[.,、・]/g, '').toLowerCase();
  }

  // Modal that asks the user to pick between two candidate values
  // for a filer name field after a scan turned up a different value.
  function openNameConflictModal(conflict) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filer = findFiler(conflict.filerId);
    if (!filer) return;

    let modalRoot = document.getElementById('tb-modal-root');
    if (!modalRoot) {
      modalRoot = el('div', { id: 'tb-modal-root' });
      document.body.appendChild(modalRoot);
    }
    function closeModal() { modalRoot.innerHTML = ''; }

    function applyChoice(value) {
      const filers = getFilers();
      const i = filers.findIndex(f => f.id === conflict.filerId);
      if (i >= 0) {
        filers[i] = Object.assign({}, filers[i], { [conflict.field]: value });
        setFilers(filers);
      }
      closeModal();
      renderActiveTab();
    }

    const fieldLabel = conflict.field === 'name_jp'
      ? t('fbar.filers.name_jp')
      : t('fbar.filers.name_en');

    const card = el('div', { class: 'tb-modal' },
      el('h2', { style: { marginTop: 0 } }, t('fbar.conflict.title')),
      el('p', { class: 'tb-card-meta' },
        t('fbar.conflict.body', {
          field: fieldLabel,
          filer: displayName(filer, TB.i18n.getLang()) || filer.name_en || '—',
        }),
      ),

      // Existing value
      el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          border: '1px solid var(--tb-border)', borderRadius: 'var(--tb-radius-2)',
          marginBottom: 'var(--tb-sp-3)',
        },
      },
        el('div', null,
          el('div', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-12)', textTransform: 'uppercase', letterSpacing: '0.06em' } },
            t('fbar.conflict.existing'),
          ),
          el('div', { style: { fontSize: 'var(--tb-fs-18)', marginTop: 'var(--tb-sp-1)' }, lang: 'ja' },
            conflict.existing,
          ),
        ),
        el('button', {
          class: 'tb-btn',
          onclick: () => applyChoice(conflict.existing),
        }, t('fbar.conflict.keep')),
      ),

      // Extracted value
      el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
          border: '1px solid var(--tb-navy)', borderRadius: 'var(--tb-radius-2)',
          marginBottom: 'var(--tb-sp-3)',
        },
      },
        el('div', null,
          el('div', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-12)', textTransform: 'uppercase', letterSpacing: '0.06em' } },
            '⚡ ' + t('fbar.conflict.extracted'),
          ),
          el('div', { style: { fontSize: 'var(--tb-fs-18)', marginTop: 'var(--tb-sp-1)' }, lang: 'ja' },
            conflict.extracted,
          ),
        ),
        el('button', {
          class: 'tb-btn',
          onclick: () => applyChoice(conflict.extracted),
        }, t('fbar.conflict.replace')),
      ),

      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn tb-btn--secondary', onclick: closeModal },
          t('fbar.conflict.skip')),
      ),
    );

    const backdrop = el('div', {
      class: 'tb-modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) closeModal(); },
    }, card);
    modalRoot.appendChild(backdrop);
  }

  // Defensively fill in dormant-year entries for an extracted set of
  // year balances. A bank account that has no transactions in a year
  // is still reportable for FBAR — the prior year's closing balance
  // carries forward. The vision model is asked to do this itself,
  // but we backfill any gaps it leaves AND extend to the current
  // calendar year if the account has no closed_year.
  //
  // Inputs:
  //   yearEntries    — array of {year, max, date}, presumed sorted asc.
  //   closedYear     — number | null. If set, no carry-forward past
  //                    this year.
  //
  // Output:
  //   array of {year, max, date, _carry_forward, _carried_from} where
  //   _carry_forward is true for synthesized entries.
  function fillCarryForwardYears(yearEntries, closedYear) {
    if (!Array.isArray(yearEntries) || yearEntries.length === 0) return [];

    const today = new Date().getUTCFullYear();

    // Defense in depth: drop any extracted entries whose year is in
    // the future. This catches FD certificates and other documents
    // where the model might extract a maturity date as a year, and
    // any other case where a future year ends up in years_covered.
    const sorted = yearEntries
      .filter(e => Number(e.year) <= today)
      .slice()
      .sort((a, b) => a.year - b.year);
    if (sorted.length === 0) return [];

    const filled = [];
    const map = {};
    for (const e of sorted) map[e.year] = e;

    const earliest = sorted[0].year;

    // End year: NEVER extend into the future. Cap at today's
    // calendar year (or earlier if the account was closed).
    // Previously used Math.max(today, latestExtracted) which let
    // future-year entries extend the carry-forward range past today.
    const endYear = closedYear
      ? Math.min(today, parseInt(closedYear, 10))
      : today;

    let lastBalance = null;
    let lastDate = '';
    let lastSourceYear = null;

    for (let y = earliest; y <= endYear; y++) {
      if (map[y]) {
        filled.push({
          year: map[y].year,
          max: map[y].max,
          date: map[y].date || '',
          _carry_forward: false,
        });
        lastBalance = map[y].max;
        lastDate = map[y].date || '';
        lastSourceYear = y;
      } else if (lastBalance != null) {
        filled.push({
          year: y,
          max: lastBalance,
          date: '',
          _carry_forward: true,
          _carried_from: lastSourceYear,
        });
      }
      // If we have no prior balance to carry from (gap before
      // earliest data), skip — there's nothing to infer from.
    }

    return filled;
  }

  function removeAccount(accountId) {
    if (!confirm(TB.i18n.t('fbar.accounts.delete.confirm'))) return;
    setAccounts(getAccounts().filter(a => a.id !== accountId));
    setBalances(getBalances().filter(b => b.account_id !== accountId));
    renderActiveTab();
  }

  // ====================================================================
  // YEARLY BALANCES
  // ====================================================================

  function renderBalances(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    if (!activeYear) activeYear = defaultYear();
    const accounts = getAccounts();
    const filers = getFilers();
    const yrs = knownYears();
    if (!yrs.includes(activeYear)) yrs.unshift(activeYear);

    const yearSelect = el('select', {
      class: 'tb-select',
      style: { maxWidth: '180px' },
      onchange: (e) => { activeYear = e.target.value; renderActiveTab(); },
    },
      ...yrs.map(y => el('option', { value: y, selected: y === activeYear }, y)),
    );

    // Per-filer filter dropdown — when set, restricts the balance
    // table AND the per-filer aggregate card to that filer's
    // accounts. Default '' = show every filer.
    const filerFilterSelect = el('select', {
      class: 'tb-select',
      style: { maxWidth: '240px' },
      onchange: (e) => { balancesFilterFilerId = e.target.value; renderActiveTab(); },
    },
      el('option', { value: '', selected: !balancesFilterFilerId }, t('fbar.balances.allFilers')),
      ...filers.map(f => el('option', {
        value: f.id, selected: balancesFilterFilerId === f.id,
      }, displayName(f, TB.i18n.getLang()) || '—')),
    );

    const headerCard = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-3)' } },
        el('h2', { style: { margin: 0 } }, t('fbar.balances.title')),
        el('div', { class: 'tb-btn-row', style: { margin: 0 } },
          el('label', { class: 'tb-field', style: { marginBottom: 0 } },
            el('span', { class: 'tb-field-label' }, t('fbar.balances.year')),
            yearSelect,
          ),
          el('button', { class: 'tb-btn tb-btn--secondary', onclick: addYearPrompt }, '+ ' + t('fbar.year.add')),
          el('button', { class: 'tb-btn tb-btn--secondary', onclick: copyFromPrevYear }, t('fbar.balances.copy_prev', { year: prevYearOf(activeYear) })),
        ),
      ),
      el('p', { class: 'tb-card-meta' }, t('fbar.balances.intro')),
      // Filer filter — appears only if there are 2+ filers
      filers.length >= 2
        ? el('div', { style: { display: 'flex', gap: 'var(--tb-sp-3)', alignItems: 'center', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap' } },
            el('label', { class: 'tb-field-label', style: { margin: 0, whiteSpace: 'nowrap' } },
              t('fbar.balances.filerFilter'),
            ),
            filerFilterSelect,
            balancesFilterFilerId
              ? el('button', {
                  class: 'tb-btn tb-btn--ghost',
                  style: { padding: '2px 10px' },
                  onclick: () => { balancesFilterFilerId = ''; renderActiveTab(); },
                }, '× ' + t('fbar.balances.clearFilter'))
              : null,
          )
        : null,
      buildYearsOnFileStrip(),
    );
    tabHost.appendChild(headerCard);

    if (accounts.length === 0) {
      tabHost.appendChild(emptyCard(t('fbar.accounts.empty'), () => { activeTab = 'accounts'; render(host); }, t('fbar.accounts.add')));
      return;
    }

    let activeAccounts = accounts.filter(a => isAccountActiveInYear(a, activeYear));
    if (balancesFilterFilerId) {
      activeAccounts = activeAccounts.filter(a => (a.filer_ids || []).includes(balancesFilterFilerId));
    }
    if (activeAccounts.length === 0) {
      const msg = balancesFilterFilerId
        ? t('fbar.balances.no-accounts-for-filer', { year: activeYear })
        : t('fbar.balances.no-accounts-active', { year: activeYear });
      tabHost.appendChild(emptyCard(msg));
      return;
    }

    // The balances table.
    const tableWrap = el('div', { class: 'tb-card', 'data-track': 'core' });
    tableWrap.appendChild(el('h3', null, activeYear));
    const table = el('table', {
      class: 'tb-fbar-balances-table',
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', { style: thStyle() }, t('fbar.balances.col.account')),
        el('th', { style: thStyle() }, t('fbar.balances.col.currency')),
        el('th', { style: thStyle('right') }, t('fbar.balances.col.max_native')),
        el('th', { style: thStyle() }, t('fbar.balances.col.max_date')),
        el('th', { style: thStyle('right') }, t('fbar.balances.col.fx_rate')),
        el('th', { style: thStyle() }, t('fbar.balances.col.fx_source')),
        el('th', { style: thStyle('right') }, t('fbar.balances.col.max_usd')),
        el('th', { style: thStyle() }, ''),
      ),
    ));

    const tbody = el('tbody', { id: 'tb-fbar-balances-tbody' });
    let missingCount = 0;
    for (const acct of activeAccounts) {
      const { row, missing } = buildBalanceRow(acct, activeYear);
      if (missing) missingCount++;
      tbody.appendChild(row);
    }
    table.appendChild(tbody);

    const wrapInScroll = el('div', { style: { overflowX: 'auto' } }, table);
    tableWrap.appendChild(wrapInScroll);

    if (missingCount > 0) {
      tableWrap.appendChild(el('div', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)', marginTop: 'var(--tb-sp-3)' },
      }, t('fbar.balances.missing-warning', { count: missingCount })));
    }

    tabHost.appendChild(tableWrap);

    // Per-filer aggregate card. Honors the filer filter — when set,
    // shows only the selected filer's aggregate.
    const aggregateFilers = balancesFilterFilerId
      ? filers.filter(f => f.id === balancesFilterFilerId)
      : filers;
    tabHost.appendChild(buildAggregateCard(aggregateFilers, activeYear));
  }

  function buildYearsOnFileStrip() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const yearsWithData = new Set();
    for (const b of getBalances()) {
      if (b.max_balance_native != null) yearsWithData.add(String(b.year));
    }
    const sorted = Array.from(yearsWithData).sort();
    if (sorted.length === 0) return null;

    return el('div', {
      style: {
        marginTop: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
      },
    },
      el('div', {
        class: 'tb-card-meta',
        style: { marginBottom: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)', textTransform: 'uppercase', letterSpacing: '0.06em' },
      }, t('fbar.balances.yearsOnFile', { count: sorted.length })),
      el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
        ...sorted.map(y => el('button', {
          class: 'tb-btn ' + (y === activeYear ? '' : 'tb-btn--secondary'),
          style: { padding: '4px 14px', fontSize: 'var(--tb-fs-14)', fontFamily: 'var(--tb-font-mono)' },
          onclick: () => { activeYear = y; renderActiveTab(); },
        }, y)),
      ),
    );
  }

  function buildBalanceRow(acct, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const balances = getBalances();
    let bal = balances.find(b => b.account_id === acct.id && String(b.year) === String(year));
    if (!bal) {
      // Create a placeholder balance row in state on demand so user
      // edits persist immediately.
      bal = blankBalance(acct.id, year);
      // Pre-fill FX rate.
      const fx = fxRateFor(acct.currency, year);
      bal.fx_rate_used = fx.rate;
      bal.fx_rate_source = fx.source || (acct.currency === 'USD' ? 'USD' : '');
      balances.push(bal);
      setBalances(balances);
    }

    function recomputeAndSave(patch) {
      const allBalances = getBalances();
      const i = allBalances.findIndex(b => b.id === bal.id);
      if (i < 0) return;
      const updated = Object.assign({}, allBalances[i], patch);

      const native = parseFloat(updated.max_balance_native);
      const rate = parseFloat(updated.fx_rate_used);
      if (isFinite(native) && isFinite(rate) && rate > 0) {
        updated.max_balance_usd = acct.currency === 'USD' ? native : (native / rate);
      } else {
        updated.max_balance_usd = null;
      }
      allBalances[i] = updated;
      setBalances(allBalances);

      // Update the row's USD cell + the aggregate card without
      // touching the input being edited.
      const cell = host.querySelector(`[data-fbar-balance-usd="${bal.id}"]`);
      if (cell) cell.textContent = updated.max_balance_usd == null ? '—' : TB.utils.formatUSD(updated.max_balance_usd);
      refreshAggregateCard(year);
    }

    const nativeInput = el('input', {
      class: 'tb-input',
      type: 'number', step: 'any', min: '0',
      value: bal.max_balance_native == null ? '' : bal.max_balance_native,
      oninput: (e) => recomputeAndSave({ max_balance_native: e.target.value === '' ? null : parseFloat(e.target.value) }),
      style: { textAlign: 'right' },
    });

    const dateInput = el('input', {
      class: 'tb-input',
      type: 'date',
      value: bal.max_balance_date || '',
      onchange: (e) => recomputeAndSave({ max_balance_date: e.target.value }),
    });

    const fxInput = el('input', {
      class: 'tb-input',
      type: 'number', step: 'any', min: '0',
      value: bal.fx_rate_used == null ? '' : bal.fx_rate_used,
      oninput: (e) => {
        const v = e.target.value === '' ? null : parseFloat(e.target.value);
        const auto = fxRateFor(acct.currency, year).rate;
        // Source labeling:
        //   - empty input + auto present → Treasury label
        //   - empty input + no auto      → "missing"
        //   - value matches auto         → Treasury label, not overridden
        //   - value differs from auto    → Manual override
        //   - value present + no auto    → Manual override (user supplied a rate the table didn't have)
        let overridden, sourceStored, sourceLabel;
        if (v == null) {
          overridden = false;
          sourceStored = auto != null ? ('Treasury Year-End ' + year + ' (UNVERIFIED)') : t('fbar.balances.fx.missing');
          sourceLabel = auto != null ? t('fbar.balances.fx.auto', { year }) : t('fbar.balances.fx.missing');
        } else if (auto != null && Math.abs(v - auto) <= 1e-9) {
          overridden = false;
          sourceStored = 'Treasury Year-End ' + year + ' (UNVERIFIED)';
          sourceLabel = t('fbar.balances.fx.auto', { year });
        } else {
          overridden = true;
          sourceStored = t('fbar.balances.fx.override');
          sourceLabel = t('fbar.balances.fx.override');
        }
        recomputeAndSave({
          fx_rate_used: v,
          fx_rate_overridden: overridden,
          fx_rate_source: sourceStored,
        });
        const srcCell = host.querySelector(`[data-fbar-balance-src="${bal.id}"]`);
        if (srcCell) srcCell.textContent = sourceLabel;
      },
      style: { textAlign: 'right', width: '100%' },
      disabled: acct.currency === 'USD',
    });

    const usdCell = el('td', {
      style: tdStyle('right'),
      'data-fbar-balance-usd': bal.id,
    }, bal.max_balance_usd == null ? '—' : TB.utils.formatUSD(bal.max_balance_usd));

    const sourceLabel = acct.currency === 'USD'
      ? 'USD'
      : (bal.fx_rate_overridden ? t('fbar.balances.fx.override')
        : fxRateFor(acct.currency, year).rate != null
          ? t('fbar.balances.fx.auto', { year })
          : t('fbar.balances.fx.missing'));

    const isCarryForward = String(bal.notes || '').startsWith('Carry-forward from');
    const carryHint = isCarryForward
      ? el('div', {
          class: 'tb-card-meta',
          style: { color: 'var(--tb-warn)', fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-1)' },
        }, 'ℹ ' + t('fbar.balances.carryForwardHint'))
      : null;

    // Owner / filer names — surfaces which household member each
    // row belongs to. Critical when two filers have similarly-named
    // accounts (e.g., parent + child both at Japan Post Bank).
    const lang = TB.i18n.getLang();
    const ownerNames = (acct.filer_ids || [])
      .map(id => findFiler(id))
      .filter(Boolean)
      .map(f => displayName(f, lang) || '—');
    const ownerLine = ownerNames.length > 0
      ? el('div', {
          class: 'tb-card-meta',
          style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-1)', fontWeight: 500, color: 'var(--tb-navy)' },
        }, '👤 ' + ownerNames.join(' · '))
      : el('div', {
          class: 'tb-card-meta',
          style: { fontSize: 'var(--tb-fs-12)', marginTop: 'var(--tb-sp-1)', color: 'var(--tb-warn)' },
        }, '⚠ ' + t('fbar.balances.unowned'));

    const deleteBtn = el('button', {
      class: 'tb-btn tb-btn--ghost',
      style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
      title: t('fbar.balances.row.delete.tooltip'),
      onclick: () => {
        if (!confirm(t('fbar.balances.row.delete.confirm', {
          institution: acct.institution_name || acct.institution_name_jp || '—',
          year: year,
        }))) return;
        const all = getBalances().filter(b => b.id !== bal.id);
        setBalances(all);
        renderActiveTab();
      },
    }, '×');

    const row = el('tr',
      acct.country === 'US' ? { style: { background: 'rgba(0,0,0,0.03)' } } : null,
      el('td', { style: tdStyle() },
        el('strong', null, acct.institution_name || acct.institution_name_jp || '(unnamed)'),
        el('div', { class: 'tb-card-meta' },
          acct.country + (acct.country === 'US' ? ' · excluded from FBAR aggregate' : '') +
          ' · ' + t('fbar.accounts.account_type.' + acct.account_type),
        ),
        ownerLine,
        carryHint,
      ),
      el('td', { style: tdStyle() }, acct.currency),
      el('td', { style: tdStyle('right') }, nativeInput),
      el('td', { style: tdStyle() }, dateInput),
      el('td', { style: tdStyle('right') }, fxInput),
      el('td', { style: tdStyle(), 'data-fbar-balance-src': bal.id }, sourceLabel),
      usdCell,
      el('td', { style: tdStyle() }, deleteBtn),
    );

    return { row, missing: bal.max_balance_native == null };
  }

  function buildAggregateCard(filers, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', {
      class: 'tb-card',
      'data-track': 'core',
      id: 'tb-fbar-aggregate-card',
    });
    refreshAggregateCardInto(card, filers, year);
    return card;
  }

  function refreshAggregateCard(year) {
    const card = host && host.querySelector('#tb-fbar-aggregate-card');
    if (!card) return;
    refreshAggregateCardInto(card, getFilers(), year);
  }

  function refreshAggregateCardInto(card, filers, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    card.innerHTML = '';
    card.appendChild(el('h2', null, t('fbar.balances.aggregate.title', { year })));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.balances.aggregate.threshold')));

    if (filers.length === 0) {
      card.appendChild(el('p', { class: 'tb-wizard-help' }, t('fbar.filers.empty')));
      return;
    }

    const lang = TB.i18n.getLang();
    const list = el('div', { style: { display: 'grid', gap: 'var(--tb-sp-3)' } });
    for (const f of filers) {
      const status = thresholdStatus(f.id, year);
      const verdict = verdictBadge(status, t);
      const summaryRow = el('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'var(--tb-sp-3)',
          background: status.status === 'at_or_over' ? 'rgba(185,122,26,0.10)'
                    : status.status === 'under' ? 'rgba(47,111,78,0.08)'
                    : 'var(--tb-bg)',
          borderRadius: 'var(--tb-radius-2)',
          border: '1px solid var(--tb-border)',
          gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      },
        el('div', null,
          el('strong', null, displayName(f, lang) || '—'),
          el('div', { class: 'tb-card-meta' },
            t('fbar.filers.relationship.' + f.relationship) +
            (f.isMinor ? ' · ' + t('fbar.filers.isMinor') : '') +
            (!f.isUSPerson ? ' · non-U.S. (FBAR N/A)' : ''),
          ),
        ),
        el('div', { style: { textAlign: 'right' } },
          el('div', { style: { fontSize: 'var(--tb-fs-22)', fontWeight: 600 } },
            f.isUSPerson ? TB.utils.formatUSD(status.aggregate_usd) : 'N/A',
          ),
          verdict,
        ),
      );

      list.appendChild(el('div', null,
        summaryRow,
        buildFilerBreakdown(f, year),
      ));
    }
    card.appendChild(list);
  }

  // Expandable per-filer breakdown showing EVERY account where the
  // filer is listed and exactly how each one is being treated by the
  // threshold logic — so the user can verify FDs / time deposits /
  // joint accounts are being counted (or correctly excluded).
  function buildFilerBreakdown(filer, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const allAccounts = getAccounts().filter(
      a => Array.isArray(a.filer_ids) && a.filer_ids.includes(filer.id),
    );
    if (allAccounts.length === 0) {
      return el('div', { class: 'tb-card-meta', style: { marginTop: 'var(--tb-sp-2)', paddingLeft: 'var(--tb-sp-3)' } },
        t('fbar.balances.breakdown.noAccounts'),
      );
    }

    const balances = getBalances();

    function row(account) {
      const bal = balances.find(
        b => b.account_id === account.id && String(b.year) === String(year),
      );
      const usd = bal && bal.max_balance_usd != null ? Number(bal.max_balance_usd) : null;
      const native = bal && bal.max_balance_native != null ? Number(bal.max_balance_native) : null;

      let included = false;
      let reason = '';
      if (!filer.isUSPerson) {
        reason = t('fbar.balances.breakdown.reason.notUsPerson');
      } else if (account.country === 'US') {
        reason = t('fbar.balances.breakdown.reason.usDomiciled');
      } else if (!isAccountActiveInYear(account, year)) {
        reason = t('fbar.balances.breakdown.reason.inactive', {
          opened: account.opened_year || '—',
          closed: account.closed_year || t('fbar.balances.breakdown.stillOpen'),
        });
      } else if (!bal || bal.max_balance_native == null) {
        reason = t('fbar.balances.breakdown.reason.noBalance');
      } else if (bal.max_balance_usd == null) {
        reason = t('fbar.balances.breakdown.reason.noFx', { currency: account.currency });
      } else {
        included = true;
      }

      const inst = account.institution_name
        || account.institution_name_jp
        || '(unnamed)';
      const typeLabel = t('fbar.accounts.account_type.' + account.account_type);
      const sigSuffix = account.signatory_only ? ' · ' + t('fbar.balances.breakdown.signatoryOnly') : '';
      const nativeStr = native != null ? formatNative(native, account.currency) : '—';
      const usdStr = usd != null ? TB.utils.formatUSD(usd) : '—';

      return el('div', {
        style: {
          display: 'flex', alignItems: 'flex-start',
          gap: 'var(--tb-sp-3)',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          fontSize: 'var(--tb-fs-12)',
          borderBottom: '1px solid var(--tb-border)',
        },
      },
        el('div', { style: { flex: '0 0 28px', fontSize: 'var(--tb-fs-14)' } },
          included ? '✓' : '⊘',
        ),
        el('div', { style: { flex: '1 1 auto', minWidth: '180px' } },
          el('strong', null, inst),
          el('div', { class: 'tb-card-meta' },
            account.country + ' · ' + account.currency + ' · ' + typeLabel + sigSuffix,
          ),
          included
            ? null
            : el('div', { style: { color: 'var(--tb-text-soft)', fontStyle: 'italic', marginTop: 'var(--tb-sp-1)' } }, reason),
        ),
        el('div', { style: { flex: '0 0 auto', textAlign: 'right', fontFamily: 'var(--tb-font-mono)', minWidth: '160px' } },
          el('div', null, nativeStr),
          el('div', {
            style: {
              fontWeight: 600,
              color: included ? 'var(--tb-success)' : 'var(--tb-text-soft)',
            },
          }, usdStr),
        ),
      );
    }

    let totalContributing = 0;
    for (const a of allAccounts) {
      const bal = balances.find(
        b => b.account_id === a.id && String(b.year) === String(year),
      );
      if (filer.isUSPerson
          && a.country !== 'US'
          && isAccountActiveInYear(a, year)
          && bal
          && bal.max_balance_usd != null) {
        totalContributing += Number(bal.max_balance_usd);
      }
    }

    return el('details', {
      style: {
        marginTop: 'var(--tb-sp-2)',
        padding: '0 var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
      },
    },
      el('summary', {
        style: { padding: 'var(--tb-sp-2) 0', cursor: 'pointer', fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 },
      }, t('fbar.balances.breakdown.toggle', { count: allAccounts.length })),
      el('div', { style: { paddingBottom: 'var(--tb-sp-2)' } },
        ...allAccounts.map(row),
        el('div', {
          style: {
            display: 'flex', justifyContent: 'space-between',
            padding: 'var(--tb-sp-3) 0 var(--tb-sp-2)',
            fontWeight: 600, fontSize: 'var(--tb-fs-14)',
          },
        },
          el('span', null, t('fbar.balances.breakdown.totalContributing')),
          el('span', { style: { fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-success)' } },
            TB.utils.formatUSD(totalContributing),
          ),
        ),
      ),
    );
  }

  function verdictBadge(status, t) {
    const el = TB.utils.el;
    if (status.status === 'at_or_over') {
      return el('span', {
        class: 'tb-badge',
        style: { background: 'var(--tb-warn)', color: '#fff', borderColor: 'transparent' },
      }, t('fbar.threshold.required.headline'));
    }
    if (status.status === 'under') {
      return el('span', {
        class: 'tb-badge',
        style: { background: 'var(--tb-success)', color: '#fff', borderColor: 'transparent' },
      }, t('fbar.threshold.under.headline'));
    }
    if (status.status === 'insufficient_data') {
      return el('span', { class: 'tb-badge' }, t('fbar.threshold.insufficient.headline'));
    }
    if (status.status === 'not_us_person') {
      return el('span', { class: 'tb-badge' }, 'Not subject');
    }
    return el('span', { class: 'tb-badge' }, '—');
  }

  function prevYearOf(year) {
    return String(parseInt(year, 10) - 1);
  }

  function addYearPrompt() {
    const v = prompt(TB.i18n.t('fbar.balances.year') + ':', defaultYear());
    if (!v) return;
    const yr = String(v).trim();
    if (!/^\d{4}$/.test(yr)) return;
    activeYear = yr;
    renderActiveTab();
  }

  function copyFromPrevYear() {
    const prev = prevYearOf(activeYear);
    const accountsToCopy = getAccounts().filter(a => isAccountActiveInYear(a, prev));
    if (accountsToCopy.length === 0) {
      alert('No accounts active in ' + prev + ' to copy from.');
      return;
    }
    const balances = getBalances();
    let added = 0;
    for (const acct of accountsToCopy) {
      const exists = balances.find(b => b.account_id === acct.id && String(b.year) === String(activeYear));
      if (exists) continue;
      const fresh = blankBalance(acct.id, activeYear);
      const fx = fxRateFor(acct.currency, activeYear);
      fresh.fx_rate_used = fx.rate;
      fresh.fx_rate_source = fx.source || (acct.currency === 'USD' ? 'USD' : '');
      balances.push(fresh);
      added += 1;
    }
    if (added > 0) setBalances(balances);
    renderActiveTab();
  }

  // ====================================================================
  // FILING HELPER (Phase 1 — prep checklist)
  // ====================================================================
  //
  // A per-filer-per-year checklist that maps every value the user must
  // enter on the BSA E-Filing form (Form 114, and Form 114a for
  // third-party preparation) to a row in this view, populated from
  // the household's filer + account data already in state.
  //
  // The "Mark as filed" toggle persists to fbar.filing_history with
  // the BSA confirmation #, the filing date, the mode (self vs
  // third-party), and free-form notes. Checklist content is derived
  // from filer records — there's nothing to "save" on the checklist
  // itself; edit a filer on the Filers tab and the checklist updates.
  // ====================================================================

  function getFilingRecord(filerId, year) {
    if (!filerId || !year) return null;
    const all = getFilingHistory();
    return all.find(r => r.filer_id === filerId && String(r.year) === String(year)) || null;
  }

  function upsertFilingRecord(filerId, year, patch) {
    if (!filerId || !year) return null;
    const all = getFilingHistory();
    const i = all.findIndex(r => r.filer_id === filerId && String(r.year) === String(year));
    if (i >= 0) {
      all[i] = Object.assign({}, all[i], patch);
    } else {
      all.push(Object.assign({
        id: TB.utils.uuid(),
        filer_id: filerId,
        year: String(year),
        filed_on: '',
        bsa_id: '',
        method: '',
        notes: '',
        mode: 'self',
        preparer_filer_id: '',
      }, patch));
    }
    setFilingHistory(all);
    return getFilingRecord(filerId, year);
  }

  function renderFiling(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filers = getFilers();
    const lang = TB.i18n.getLang();

    if (filers.length === 0) {
      tabHost.appendChild(emptyCard(t('fbar.filing.empty.noFilers'), () => {
        activeTab = 'filers'; render(host);
      }, t('fbar.filers.add')));
      return;
    }

    if (!filingState.filerId) filingState.filerId = filers[0].id;
    if (!filingState.year) filingState.year = defaultYear();

    const yrs = knownYears();
    if (!yrs.includes(filingState.year)) yrs.unshift(filingState.year);

    // Header — filer + year selectors.
    const headerCard = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', { style: { margin: 0 } }, t('fbar.filing.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.filing.intro')),
      grid2col(
        field(t('fbar.filing.select.filer'), el('select', {
          class: 'tb-select',
          onchange: (e) => { filingState.filerId = e.target.value; renderActiveTab(); },
        },
          ...filers.map(f => el('option', {
            value: f.id, selected: filingState.filerId === f.id,
          }, displayName(f, lang) || '—')),
        )),
        field(t('fbar.filing.select.year'), el('select', {
          class: 'tb-select',
          onchange: (e) => { filingState.year = e.target.value; renderActiveTab(); },
        },
          ...yrs.map(y => el('option', { value: y, selected: filingState.year === y }, y)),
        )),
      ),
    );
    tabHost.appendChild(headerCard);

    const filer = findFiler(filingState.filerId);
    if (!filer) return;
    const year = filingState.year;

    // Threshold gate — show a heads-up when FBAR isn't required, but
    // still let the user view the checklist (some filers prepare
    // anyway for record-keeping). For a not-US-person filer, hide
    // the checklist entirely since FBAR doesn't apply.
    if (filer.isUSPerson === false) {
      tabHost.appendChild(emptyCard(t('fbar.filing.empty.notUSPerson', {
        name: displayName(filer, lang) || '—',
      })));
      return;
    }

    const status = thresholdStatus(filer.id, year);
    if (status.status === 'under') {
      tabHost.appendChild(el('div', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)' },
      }, t('fbar.filing.notice.underThreshold', {
        name: displayName(filer, lang) || '—', year,
      })));
    } else if (status.status === 'unknown' || status.status === 'missing_data') {
      tabHost.appendChild(el('div', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)' },
      }, t('fbar.filing.notice.unknownThreshold', { year })));
    }

    // 1. Filed-status card (top, so the user sees the most important
    //    state first).
    tabHost.appendChild(buildFilingStatusCard(filer, year));

    // 2. Filing mode card (drives which checklist sections show).
    tabHost.appendChild(buildFilingModeCard(filer, year));

    const record = getFilingRecord(filer.id, year);
    const mode = (record && record.mode) || 'self';
    const preparer = mode !== 'self' && record && record.preparer_filer_id
      ? findFiler(record.preparer_filer_id)
      : null;

    // 3. Critical Fixes — wording varies by mode.
    tabHost.appendChild(buildFilingCriticalFixesCard(filer, mode, preparer));

    // 4. Filer Identity (Part I) — auto-populated from the filer
    //    record. Always shown.
    tabHost.appendChild(buildFilingPartIIdentityCard(filer));

    // 5. Account Information (Parts II / III / IV) — the bulk of the
    //    actual form. Walks through every reportable account for
    //    this filer + year, grouped by ownership type.
    tabHost.appendChild(buildFilingAccountInformationCard(filer, year));

    // 6. Preparer Identity (Part V) — only when filing mode is
    //    third-party.
    if (mode !== 'self') {
      tabHost.appendChild(buildFilingPartVPreparerCard(filer, mode, preparer));
      // 7. Form 114a (preparer authorization) — only relevant when a
      //    third party is signing on the filer's behalf. The form is
      //    retained by the preparer for 5 years and is NOT submitted
      //    to FinCEN.
      tabHost.appendChild(buildFiling114aCard(filer, year, mode, preparer));
    }

    // 7. Common Mistakes — static checklist of failure modes.
    tabHost.appendChild(buildFilingCommonMistakesCard());

    // 8. Late Filing Explanation generator (for "Other" reason on
    //    the BSA E-Filing portal — only relevant when filing late).
    tabHost.appendChild(buildFilingLateExplanationCard(filer, year));

    // 9. Treasury rates reference table — quick lookup so the user
    //    doesn't have to flip to fiscal.treasury.gov mid-filing.
    tabHost.appendChild(buildFilingRatesReferenceCard());

    // 10. AI Advisor — chat-style Q&A backed by Claude. Quick-prompt
    //     buttons for the most common questions; free-text below.
    tabHost.appendChild(buildFilingAiAdvisorCard());
  }

  // --------------------------------------------------------------------
  // Filed-status card — the "I have filed this" toggle.
  // --------------------------------------------------------------------

  function buildFilingStatusCard(filer, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const record = getFilingRecord(filer.id, year);
    const isFiled = !!(record && record.filed_on);

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });

    const headerRow = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--tb-sp-3)' },
    },
      el('h3', { style: { margin: 0 } }, t('fbar.filing.status.title')),
      isFiled
        ? el('span', {
            class: 'tb-pill',
            style: { background: 'var(--tb-ok)', color: 'white', padding: '4px 12px', borderRadius: '999px', fontSize: 'var(--tb-fs-13)', fontWeight: '600' },
          }, t('fbar.filing.status.filed', { date: record.filed_on }))
        : el('span', {
            class: 'tb-pill',
            style: { background: 'var(--tb-bg)', color: 'var(--tb-text-muted)', padding: '4px 12px', borderRadius: '999px', fontSize: 'var(--tb-fs-13)', border: '1px solid var(--tb-border)' },
          }, t('fbar.filing.status.notFiled')),
    );
    card.appendChild(headerRow);

    const toggle = el('label', {
      style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)', cursor: 'pointer' },
    },
      el('input', {
        type: 'checkbox',
        checked: isFiled,
        onchange: (e) => {
          if (e.target.checked) {
            // Pre-fill filed_on with today if blank.
            const today = new Date();
            const iso = today.getUTCFullYear() + '-'
              + String(today.getUTCMonth() + 1).padStart(2, '0') + '-'
              + String(today.getUTCDate()).padStart(2, '0');
            upsertFilingRecord(filer.id, year, {
              filed_on: (record && record.filed_on) || iso,
            });
          } else {
            upsertFilingRecord(filer.id, year, { filed_on: '', bsa_id: '' });
          }
          renderActiveTab();
        },
      }),
      el('span', null, t('fbar.filing.status.toggleLabel', {
        name: displayName(filer, lang) || '—', year,
      })),
    );
    card.appendChild(toggle);

    if (isFiled) {
      const detailWrap = el('div', { style: { marginTop: 'var(--tb-sp-3)' } },
        grid2col(
          field(t('fbar.filing.status.dateLabel'), el('input', {
            type: 'date',
            class: 'tb-input',
            value: record.filed_on || '',
            onchange: (e) => {
              upsertFilingRecord(filer.id, year, { filed_on: e.target.value });
              renderActiveTab();
            },
          })),
          field(t('fbar.filing.status.bsaIdLabel'), el('input', {
            type: 'text',
            class: 'tb-input',
            value: record.bsa_id || '',
            placeholder: 'e.g., 31000078901234',
            onchange: (e) => {
              upsertFilingRecord(filer.id, year, { bsa_id: e.target.value.trim() });
            },
          })),
        ),
        field(t('fbar.filing.status.notesLabel'), el('textarea', {
          class: 'tb-input',
          rows: 2,
          style: { resize: 'vertical', minHeight: '40px' },
          placeholder: t('fbar.filing.status.notesPlaceholder'),
          onchange: (e) => {
            upsertFilingRecord(filer.id, year, { notes: e.target.value });
          },
        }, record.notes || '')),
      );
      card.appendChild(detailWrap);
    }

    return card;
  }

  // --------------------------------------------------------------------
  // Filing-mode card — self / household-preparer / external-preparer.
  // --------------------------------------------------------------------

  function buildFilingModeCard(filer, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const record = getFilingRecord(filer.id, year);
    const mode = (record && record.mode) || 'self';
    const preparerId = (record && record.preparer_filer_id) || '';

    // Other adult filers in the household — candidates for preparer
    // when mode = household_preparer.
    const otherFilers = getFilers().filter(f => f.id !== filer.id && !f.isMinor);

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h3', { style: { margin: 0 } }, t('fbar.filing.mode.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.filing.mode.help')),
    );

    const radioRow = (value, label) => el('label', {
      style: { display: 'flex', alignItems: 'center', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-2)', cursor: 'pointer' },
    },
      el('input', {
        type: 'radio',
        name: 'tb-fbar-filing-mode',
        value,
        checked: mode === value,
        onchange: (e) => {
          if (!e.target.checked) return;
          const patch = { mode: value };
          if (value === 'self') patch.preparer_filer_id = '';
          if (value === 'household_preparer' && !preparerId && otherFilers.length > 0) {
            patch.preparer_filer_id = otherFilers[0].id;
          }
          if (value === 'external_preparer') patch.preparer_filer_id = '';
          upsertFilingRecord(filer.id, year, patch);
          renderActiveTab();
        },
      }),
      el('span', null, label),
    );

    card.appendChild(radioRow('self', t('fbar.filing.mode.self')));
    card.appendChild(radioRow('household_preparer', t('fbar.filing.mode.household')));
    if (mode === 'household_preparer') {
      if (otherFilers.length === 0) {
        card.appendChild(el('p', {
          class: 'tb-disclaimer-inline',
          style: { borderLeftColor: 'var(--tb-warn)', marginLeft: '24px' },
        }, t('fbar.filing.mode.household.noCandidates')));
      } else {
        const sel = el('select', {
          class: 'tb-select',
          style: { marginLeft: '24px', maxWidth: '320px' },
          onchange: (e) => {
            upsertFilingRecord(filer.id, year, { preparer_filer_id: e.target.value });
            renderActiveTab();
          },
        },
          el('option', { value: '' }, '—'),
          ...otherFilers.map(f => el('option', {
            value: f.id, selected: preparerId === f.id,
          }, displayName(f, lang) || '—')),
        );
        card.appendChild(field(t('fbar.filing.mode.household.preparerLabel'), sel,
          t('fbar.filing.mode.household.preparerHelp')));
      }
    }
    card.appendChild(radioRow('external_preparer', t('fbar.filing.mode.external')));
    if (mode === 'external_preparer') {
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-info, var(--tb-accent))', marginLeft: '24px' },
      }, t('fbar.filing.mode.external.note')));
    }

    if (mode !== 'self') {
      card.appendChild(el('p', {
        class: 'tb-card-meta',
        style: { marginTop: 'var(--tb-sp-3)' },
      }, t('fbar.filing.mode.114a.reminder')));
    }

    return card;
  }

  // --------------------------------------------------------------------
  // Critical Fixes card — items the user MUST get right or the BSA
  // E-Filing form will reject submission.
  // --------------------------------------------------------------------

  function buildFilingCriticalFixesCard(filer, mode, preparer) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const isPreparer = mode !== 'self';
    const preparerName = preparer ? (displayName(preparer, lang) || '—') : '—';

    const rows = [];

    // Item 50 — Self-Employed checkbox (preparer side).
    rows.push({
      item: '50',
      field: t('fbar.filing.critical.item.50'),
      action: isPreparer
        ? t('fbar.filing.critical.item.50.action.preparer')
        : t('fbar.filing.critical.item.50.action.self'),
    });
    // Item 44a — Third-Party Preparer checkbox.
    rows.push({
      item: '44a',
      field: t('fbar.filing.critical.item.44a'),
      action: isPreparer
        ? t('fbar.filing.critical.item.44a.action.preparer', {
            preparer: preparerName,
            filer: displayName(filer, lang) || '—',
          })
        : t('fbar.filing.critical.item.44a.action.self'),
    });
    // Item 45 — Filer Title — always blank.
    rows.push({
      item: '45',
      field: t('fbar.filing.critical.item.45'),
      action: t('fbar.filing.critical.item.45.action'),
    });
    // Item 53 — Firm Name — blank when 50 checked.
    if (isPreparer) {
      rows.push({
        item: '53',
        field: t('fbar.filing.critical.item.53'),
        action: t('fbar.filing.critical.item.53.action'),
      });
      // Item 54 — Firm EIN — blank when 50 checked.
      rows.push({
        item: '54',
        field: t('fbar.filing.critical.item.54'),
        action: t('fbar.filing.critical.item.54.action'),
      });
      // Item 54a — TIN Type — SSN.
      rows.push({
        item: '54a',
        field: t('fbar.filing.critical.item.54a'),
        action: t('fbar.filing.critical.item.54a.action', { name: preparerName }),
      });
    }

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-warn)' } },
      el('h3', { style: { margin: 0 } }, t('fbar.filing.critical.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.filing.critical.intro')),
      buildChecklistTable(rows),
    );
    return card;
  }

  // --------------------------------------------------------------------
  // Filer Identity (Part I) card — values come from the filer record.
  // --------------------------------------------------------------------

  function buildFilingPartIIdentityCard(filer) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const fullName = filer.name_en || filer.name_jp || '—';
    const fullNameJp = filer.name_jp ? ' / ' + filer.name_jp : '';
    const ssn = filer.ssn_last4 ? '•••-••-' + filer.ssn_last4 : t('fbar.filing.partI.value.ssnMissing');
    const addr = filer.filing_address || t('fbar.filing.partI.value.addressMissing');
    const dob = filer.dob || t('fbar.filing.partI.value.dobMissing');

    const rows = [
      {
        item: '1-3',
        field: t('fbar.filing.partI.item.name'),
        action: fullName + fullNameJp,
        warn: !filer.name_en && !filer.name_jp,
      },
      {
        item: '4',
        field: t('fbar.filing.partI.item.tin'),
        action: ssn,
        warn: !filer.ssn_last4,
      },
      {
        item: '5-8',
        field: t('fbar.filing.partI.item.address'),
        action: addr,
        warn: !filer.filing_address,
      },
      {
        item: '2',
        field: t('fbar.filing.partI.item.type'),
        action: t('fbar.filing.partI.value.individual'),
      },
      {
        item: '—',
        field: t('fbar.filing.partI.item.dob'),
        action: dob,
        warn: !filer.dob,
      },
      {
        item: '45',
        field: t('fbar.filing.partI.item.title'),
        action: t('fbar.filing.partI.value.titleBlank'),
      },
    ];

    const subtitle = t('fbar.filing.partI.subtitle', {
      name: displayName(filer, lang) || '—',
    });

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-accent, #4a90e2)' } },
      el('h3', { style: { margin: 0 } }, t('fbar.filing.partI.title')),
      el('p', { class: 'tb-card-meta' }, subtitle),
      buildChecklistTable(rows),
    );

    if (filer.isMinor) {
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-info, var(--tb-accent))' },
      }, t('fbar.filing.partI.minorNote')));
    }

    return card;
  }

  // --------------------------------------------------------------------
  // Account Information (Parts II / III / IV) card — the bulk of the
  // actual FinCEN 114 form. Walks through every reportable account
  // for this filer + year, grouped by ownership type:
  //
  //   Part II  — Separately owned (filer is the sole interest holder)
  //   Part III — Jointly owned (account has 2+ filers in the household)
  //   Part IV  — Signature authority only (signatory_only = true)
  //
  // Each account block shows the field values that go onto the form,
  // pulled directly from the account record + the year's balance row.
  // Missing data is flagged so the user can fix it before filing.
  // --------------------------------------------------------------------

  function buildFilingAccountInformationCard(filer, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const allAccounts = getAccounts();
    const balances = getBalances();

    // All accounts where this filer has any interest, active in this year.
    const filerAccounts = allAccounts.filter(a =>
      (a.filer_ids || []).indexOf(filer.id) !== -1
      && isAccountActiveInYear(a, year)
    );

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-accent, #4a90e2)' } });
    card.appendChild(el('h3', { style: { margin: 0 } }, t('fbar.filing.accounts.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.filing.accounts.intro')));

    // Pre-flight reminder: re-scan documents before filling in the form.
    // Most field values come from the most recent extraction; if balance
    // data is stale, the form will be wrong.
    const reminderRow = el('div', {
      class: 'tb-disclaimer-inline',
      style: { borderLeftColor: 'var(--tb-warn)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--tb-sp-3)', flexWrap: 'wrap' },
    },
      el('span', null, t('fbar.filing.accounts.rescanReminder')),
      el('button', {
        class: 'tb-btn tb-btn--ghost',
        onclick: () => { activeTab = 'accounts'; render(host); },
      }, t('fbar.filing.accounts.gotoAccounts')),
    );
    card.appendChild(reminderRow);

    if (filerAccounts.length === 0) {
      card.appendChild(el('p', { class: 'tb-wizard-help', style: { marginTop: 'var(--tb-sp-3)' } },
        t('fbar.filing.accounts.empty', {
          name: displayName(filer, lang) || '—', year,
        })));
      return card;
    }

    // Group by FBAR Part. Note: a "joint" account here means
    // multiple filers in the household share interest. Joint with a
    // non-U.S. spouse who is not a household filer would appear in
    // Part II under this model — the user can add the spouse as a
    // non-US-person filer if they want it grouped under Part III.
    const partII = [];   // separately owned
    const partIII = [];  // jointly owned (2+ household filers)
    const partIV = [];   // signature authority only
    for (const a of filerAccounts) {
      if (a.signatory_only) partIV.push(a);
      else if ((a.filer_ids || []).length >= 2) partIII.push(a);
      else partII.push(a);
    }

    // Summary row at the top of the card showing counts per part.
    const summary = el('div', {
      style: { display: 'flex', gap: 'var(--tb-sp-3)', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap' },
    },
      buildPartSummaryPill(t('fbar.filing.accounts.part2'), partII.length),
      buildPartSummaryPill(t('fbar.filing.accounts.part3'), partIII.length),
      buildPartSummaryPill(t('fbar.filing.accounts.part4'), partIV.length),
    );
    card.appendChild(summary);

    // Render each part in sequence. Skip empty parts.
    if (partII.length > 0) {
      card.appendChild(buildAccountPartSection('II', partII, filer, year, balances, allAccounts));
    }
    if (partIII.length > 0) {
      card.appendChild(buildAccountPartSection('III', partIII, filer, year, balances, allAccounts));
    }
    if (partIV.length > 0) {
      card.appendChild(buildAccountPartSection('IV', partIV, filer, year, balances, allAccounts));
    }

    // Surface accounts that are active this year but have no balance
    // entry — those are the most common "I forgot to update" failure
    // mode and the form will be wrong if submitted as-is.
    const missingBalance = filerAccounts.filter(a => {
      const b = balances.find(bb => bb.account_id === a.id && String(bb.year) === String(year));
      return !b || b.max_balance_native == null;
    });
    if (missingBalance.length > 0) {
      card.appendChild(el('div', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)', marginTop: 'var(--tb-sp-3)' },
      },
        el('strong', null, t('fbar.filing.accounts.missingHeader', { count: missingBalance.length, year })),
        el('ul', { style: { margin: 'var(--tb-sp-2) 0 0', paddingLeft: 'var(--tb-sp-4)' } },
          ...missingBalance.map(a => el('li', null,
            (a.institution_name || a.institution_name_jp || '—')
              + ' · ' + masked(a.account_number_full)
              + (a.currency ? ' · ' + a.currency : ''),
          )),
        ),
      ));
    }

    return card;
  }

  function buildPartSummaryPill(label, count) {
    const el = TB.utils.el;
    return el('div', {
      style: {
        flex: '1 1 0',
        minWidth: '120px',
        padding: 'var(--tb-sp-2) var(--tb-sp-3)',
        background: 'var(--tb-bg)',
        border: '1px solid var(--tb-border)',
        borderRadius: 'var(--tb-radius-2)',
        textAlign: 'center',
      },
    },
      el('div', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', marginBottom: '2px' } }, label),
      el('div', { style: { fontSize: '20px', fontWeight: '700', fontFamily: 'var(--tb-font-mono)' } }, String(count)),
    );
  }

  function buildAccountPartSection(partRoman, accounts, filer, year, balances, allAccounts) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const headerKey = 'fbar.filing.accounts.part' + partRoman + '.header';
    const subtitleKey = 'fbar.filing.accounts.part' + partRoman + '.subtitle';

    const wrap = el('div', { style: { marginTop: 'var(--tb-sp-4)' } });
    wrap.appendChild(el('h4', {
      style: { margin: '0 0 4px', borderBottom: '1px solid var(--tb-border)', paddingBottom: 'var(--tb-sp-2)' },
    }, t(headerKey)));
    wrap.appendChild(el('p', { class: 'tb-card-meta', style: { marginBottom: 'var(--tb-sp-3)' } }, t(subtitleKey)));

    accounts.forEach((acct, i) => {
      wrap.appendChild(buildAccountFbarItemBlock(acct, year, filer, partRoman, i + 1, accounts.length, balances, allAccounts));
    });

    return wrap;
  }

  function buildAccountFbarItemBlock(acct, year, filer, partRoman, idx, total, balances, allAccounts) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const bal = balances.find(b => b.account_id === acct.id && String(b.year) === String(year));
    const native = bal && bal.max_balance_native != null ? bal.max_balance_native : null;
    const usd = bal && bal.max_balance_usd != null ? bal.max_balance_usd : null;
    const fxRate = bal && bal.fx_rate_used != null ? bal.fx_rate_used : null;
    const fxSource = bal ? (bal.fx_rate_source || '') : '';
    const maxDate = bal ? (bal.max_balance_date || '') : '';

    const acctNumberFull = acct.account_number_full || '';
    const institutionName = acct.institution_name || acct.institution_name_jp || '';
    const institutionAddr = acct.institution_address || acct.institution_address_jp || '';

    // Type label.
    const typeLabel = acct.account_type
      ? t('fbar.accounts.account_type.' + acct.account_type)
      : '—';

    // Joint owners (Part III) — list co-filers besides the active one.
    let jointOwnerLines = null;
    if (partRoman === 'III') {
      const others = (acct.filer_ids || [])
        .filter(id => id !== filer.id)
        .map(id => findFiler(id))
        .filter(Boolean);
      jointOwnerLines = others.length > 0
        ? others.map(o => (displayName(o, lang) || '—')
            + (o.ssn_last4 ? ' · TIN •••-••-' + o.ssn_last4 : ''))
        : [t('fbar.filing.accounts.joint.unknown')];
    }

    // Build the rows.
    const rows = [];

    // Max value
    rows.push({
      field: t('fbar.filing.accounts.field.maxValue'),
      value: usd != null
        ? TB.utils.formatUSD(usd) + ' · ' + (native != null ? new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US').format(native) + ' ' + (acct.currency || '') : '—')
        : t('fbar.filing.accounts.value.missing'),
      warn: usd == null,
      help: t('fbar.filing.accounts.field.maxValue.help'),
    });

    rows.push({
      field: t('fbar.filing.accounts.field.maxDate'),
      value: maxDate || t('fbar.filing.accounts.value.missing'),
      warn: !maxDate,
      help: t('fbar.filing.accounts.field.maxDate.help'),
    });

    rows.push({
      field: t('fbar.filing.accounts.field.fxRate'),
      value: fxRate != null
        ? fxRate + (fxSource ? ' · ' + fxSource : '')
        : t('fbar.filing.accounts.value.fxMissing'),
      warn: fxRate == null,
      help: t('fbar.filing.accounts.field.fxRate.help'),
    });

    rows.push({
      field: t('fbar.filing.accounts.field.acctType'),
      value: typeLabel + (acct.account_type === 'other' ? ' · ' + t('fbar.filing.accounts.field.acctType.otherHelp') : ''),
    });

    rows.push({
      field: t('fbar.filing.accounts.field.institutionName'),
      value: institutionName || t('fbar.filing.accounts.value.missing'),
      warn: !institutionName,
    });

    rows.push({
      field: t('fbar.filing.accounts.field.acctNumber'),
      value: acctNumberFull || t('fbar.filing.accounts.value.missing'),
      warn: !acctNumberFull,
      mono: true,
    });

    rows.push({
      field: t('fbar.filing.accounts.field.address'),
      value: institutionAddr || t('fbar.filing.accounts.value.missing'),
      warn: !institutionAddr,
    });

    rows.push({
      field: t('fbar.filing.accounts.field.country'),
      value: acct.country || t('fbar.filing.accounts.value.missing'),
      warn: !acct.country,
    });

    rows.push({
      field: t('fbar.filing.accounts.field.currency'),
      value: acct.currency || t('fbar.filing.accounts.value.missing'),
      warn: !acct.currency,
    });

    if (partRoman === 'III' && jointOwnerLines) {
      rows.push({
        field: t('fbar.filing.accounts.field.jointOwners'),
        value: jointOwnerLines.join(' · '),
        help: t('fbar.filing.accounts.field.jointOwners.help'),
      });
      rows.push({
        field: t('fbar.filing.accounts.field.jointCount'),
        value: String((acct.filer_ids || []).length),
      });
    }

    if (partRoman === 'IV') {
      rows.push({
        field: t('fbar.filing.accounts.field.signatoryNote'),
        value: t('fbar.filing.accounts.field.signatoryNote.value'),
        help: t('fbar.filing.accounts.field.signatoryNote.help'),
      });
    }

    // Build the block.
    const block = el('div', {
      class: 'tb-card',
      style: {
        background: 'var(--tb-bg)',
        marginBottom: 'var(--tb-sp-3)',
        padding: 'var(--tb-sp-3) var(--tb-sp-4)',
      },
    });

    const blockHeader = el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-2)' },
    },
      el('strong', null, 'Part ' + partRoman + ' · ' + t('fbar.filing.accounts.accountIndex', { idx, total })),
      el('span', { class: 'tb-card-meta', style: { fontSize: 'var(--tb-fs-13)', margin: 0 } },
        institutionName + (acctNumberFull ? ' · ····' + acctNumberFull.slice(-4) : '')),
    );
    block.appendChild(blockHeader);

    // Rows table.
    const tbl = el('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)' } });
    const tbody = el('tbody');
    for (const r of rows) {
      const valStyle = Object.assign({}, tdStyle(),
        r.mono ? { fontFamily: 'var(--tb-font-mono)' } : {},
        r.warn ? { color: 'var(--tb-warn)', fontStyle: 'italic' } : {});
      const tr = el('tr', null,
        el('td', { style: Object.assign({}, tdStyle(), { width: '180px', fontWeight: '600', color: 'var(--tb-text-soft)' }) }, r.field),
        el('td', { style: valStyle },
          r.value,
          r.help ? el('div', {
            style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', fontStyle: 'normal', marginTop: '2px' },
          }, r.help) : null,
        ),
      );
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    block.appendChild(tbl);

    return block;
  }

  // --------------------------------------------------------------------
  // Preparer Identity (Part V) card — only when mode is third-party.
  // --------------------------------------------------------------------

  function buildFilingPartVPreparerCard(filer, mode, preparer) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-accent, #4a90e2)' } });
    card.appendChild(el('h3', { style: { margin: 0 } }, t('fbar.filing.partV.title')));

    if (mode === 'external_preparer') {
      card.appendChild(el('p', {
        class: 'tb-card-meta',
      }, t('fbar.filing.partV.external.subtitle')));
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-info, var(--tb-accent))' },
      }, t('fbar.filing.partV.external.note')));
      return card;
    }

    if (!preparer) {
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)' },
      }, t('fbar.filing.partV.noPreparer')));
      return card;
    }

    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.filing.partV.subtitle', {
      name: displayName(preparer, lang) || '—',
    })));

    // Parse the preparer's address into city / state / zip / country
    // best-effort. The household keeps a single filing_address string;
    // we surface it whole and call out that the user may need to
    // split it into the form's discrete address fields.
    const prepAddr = preparer.filing_address || t('fbar.filing.partV.value.addressMissing');
    const prepName = preparer.name_en || preparer.name_jp || '—';
    const prepLast = (preparer.name_en || '').split(/\s+/).slice(-1)[0] || prepName;
    const prepFirst = (preparer.name_en || '').split(/\s+/).slice(0, -1).join(' ') || '—';
    const prepSsn = preparer.ssn_last4 ? '•••-••-' + preparer.ssn_last4 : t('fbar.filing.partI.value.ssnMissing');

    const rows = [
      {
        item: '44a',
        field: t('fbar.filing.partV.item.44a'),
        action: t('fbar.filing.partV.value.checked'),
      },
      {
        item: '47',
        field: t('fbar.filing.partV.item.47'),
        action: prepLast,
        warn: !preparer.name_en,
      },
      {
        item: '48',
        field: t('fbar.filing.partV.item.48'),
        action: prepFirst,
        warn: !preparer.name_en,
      },
      {
        item: '49',
        field: t('fbar.filing.partV.item.49'),
        action: t('fbar.filing.partV.item.49.value'),
      },
      {
        item: '50',
        field: t('fbar.filing.partV.item.50'),
        action: t('fbar.filing.partV.value.checked'),
      },
      {
        item: '51',
        field: t('fbar.filing.partV.item.51'),
        action: prepSsn + ' ' + t('fbar.filing.partV.item.51.suffix', {
          name: displayName(preparer, lang) || '—',
        }),
        warn: !preparer.ssn_last4,
      },
      {
        item: '54a',
        field: t('fbar.filing.partV.item.54a'),
        action: t('fbar.filing.partV.item.54a.value'),
      },
      {
        item: '53',
        field: t('fbar.filing.partV.item.53'),
        action: t('fbar.filing.partV.value.blank'),
      },
      {
        item: '54',
        field: t('fbar.filing.partV.item.54'),
        action: t('fbar.filing.partV.value.blank'),
      },
      {
        item: '55-59',
        field: t('fbar.filing.partV.item.address'),
        action: prepAddr,
        warn: !preparer.filing_address,
      },
      {
        item: '—',
        field: t('fbar.filing.partV.item.contact'),
        action: t('fbar.filing.partV.item.contact.value'),
      },
    ];

    card.appendChild(buildChecklistTable(rows));
    card.appendChild(el('p', {
      class: 'tb-card-meta',
      style: { marginTop: 'var(--tb-sp-3)' },
    }, t('fbar.filing.partV.114a.reminder')));
    return card;
  }

  // --------------------------------------------------------------------
  // Common Mistakes card — static checklist of failure modes.
  // --------------------------------------------------------------------

  function buildFilingCommonMistakesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const items = [
      t('fbar.filing.mistakes.item.filerName'),
      t('fbar.filing.mistakes.item.title'),
      t('fbar.filing.mistakes.item.44a'),
      t('fbar.filing.mistakes.item.50'),
      t('fbar.filing.mistakes.item.114peryear'),
      t('fbar.filing.mistakes.item.yearEnd'),
      t('fbar.filing.mistakes.item.fxRate'),
      t('fbar.filing.mistakes.item.jointMarking'),
      t('fbar.filing.mistakes.item.under10k'),
    ];

    const list = el('ul', { style: { margin: '0', paddingLeft: 'var(--tb-sp-4)' } },
      ...items.map(text => el('li', {
        style: { marginBottom: 'var(--tb-sp-2)', lineHeight: '1.5' },
      },
        el('span', { style: { color: 'var(--tb-warn)', marginRight: 'var(--tb-sp-2)', fontWeight: '700' } }, '✗'),
        text,
      )),
    );

    return el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-warn)' } },
      el('h3', { style: { margin: 0 } }, t('fbar.filing.mistakes.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.filing.mistakes.intro')),
      list,
    );
  }

  // --------------------------------------------------------------------
  // Late Filing Explanation card — parametric 750-char narrative for
  // the FinCEN Form 114 "Other" late-filing reason. Auto-detects the
  // right template from the filer record but the user can override.
  // The narrative stays in English (BSA E-Filing is English-only).
  // --------------------------------------------------------------------

  function buildFilingLateExplanationCard(filer, year) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const record = getFilingRecord(filer.id, year);

    // Resolve the active category: explicit choice on the record, or
    // auto-detected from the filer's role.
    const explicitCategory = record && record.late_filing_category;
    const activeCategory = explicitCategory && LATE_FILING_CATEGORIES.indexOf(explicitCategory) !== -1
      ? explicitCategory
      : autoDetectLateFilingCategory(filer);

    const template = LATE_FILING_TEMPLATES[activeCategory] || '';
    const persistedText = (record && record.late_filing_explanation) || '';
    const text = persistedText || template;
    const isUserEdited = persistedText && persistedText !== template;

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-accent, #4a90e2)' } });
    card.appendChild(el('h3', { style: { margin: 0 } }, t('fbar.filing.late.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.filing.late.intro')));

    // Category dropdown — auto-detected on first view, user-overridable.
    const catSelect = el('select', {
      class: 'tb-select',
      onchange: (e) => {
        const newCat = e.target.value;
        // Switching category overwrites any user edits with the new
        // template, so the user sees the new narrative as the start
        // point. They can edit again. We persist the new category and
        // clear the explanation so the renderer falls back to the
        // template (and so re-rendering after this change is idempotent).
        upsertFilingRecord(filer.id, year, {
          late_filing_category: newCat,
          late_filing_explanation: '',
        });
        renderActiveTab();
      },
    },
      ...LATE_FILING_CATEGORIES.map(c => el('option', {
        value: c, selected: c === activeCategory,
      }, t('fbar.filing.late.category.' + c))),
    );

    if (!explicitCategory) {
      card.appendChild(field(t('fbar.filing.late.categoryLabel'), catSelect,
        t('fbar.filing.late.autoDetected', { category: t('fbar.filing.late.category.' + activeCategory) })));
    } else {
      card.appendChild(field(t('fbar.filing.late.categoryLabel'), catSelect));
    }

    // Live editable textarea. Idempotent persistence: writes on input
    // (no debounce — TB.state writes are cheap because state is held
    // in memory and serialized on a separate persistence pass).
    const textarea = el('textarea', {
      class: 'tb-input',
      rows: 8,
      style: { width: '100%', resize: 'vertical', minHeight: '160px', fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-13)', lineHeight: '1.5' },
    });
    textarea.value = text;

    const counter = el('span', {
      style: { fontFamily: 'var(--tb-font-mono)', fontSize: 'var(--tb-fs-13)' },
    });
    function updateCounter(val) {
      const n = (val || '').length;
      counter.textContent = n + ' / ' + LATE_FILING_EXPLANATION_LIMIT;
      counter.style.color = n > LATE_FILING_EXPLANATION_LIMIT
        ? 'var(--tb-error, var(--tb-warn))'
        : (n > LATE_FILING_EXPLANATION_LIMIT - 50 ? 'var(--tb-warn)' : 'var(--tb-text-muted)');
      counter.style.fontWeight = n > LATE_FILING_EXPLANATION_LIMIT ? '700' : '400';
    }
    updateCounter(text);

    textarea.oninput = (e) => {
      const v = e.target.value;
      updateCounter(v);
      // Persist immediately. If the user has typed back to exactly
      // the template, we clear the persisted text so the auto-template
      // path resumes — keeps state minimal.
      upsertFilingRecord(filer.id, year, {
        late_filing_explanation: v === LATE_FILING_TEMPLATES[activeCategory] ? '' : v,
        late_filing_category: activeCategory,
      });
    };

    card.appendChild(textarea);

    // Actions row: char counter + Copy + (optional) Reset.
    const copyBtn = el('button', {
      class: 'tb-btn tb-btn--secondary',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(textarea.value);
          copyBtn.textContent = '✓ ' + t('fbar.filing.late.copied');
          setTimeout(() => { copyBtn.textContent = t('fbar.filing.late.copy'); }, 1500);
        } catch (err) {
          // Fallback: select the textarea so the user can ctrl+C.
          textarea.select();
        }
      },
    }, t('fbar.filing.late.copy'));

    const actionsRow = el('div', {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 'var(--tb-sp-2)',
        gap: 'var(--tb-sp-3)',
        flexWrap: 'wrap',
      },
    },
      counter,
      el('div', { class: 'tb-btn-row', style: { margin: 0 } },
        isUserEdited
          ? el('button', {
              class: 'tb-btn tb-btn--ghost',
              onclick: () => {
                upsertFilingRecord(filer.id, year, { late_filing_explanation: '' });
                renderActiveTab();
              },
            }, t('fbar.filing.late.reset'))
          : null,
        copyBtn,
      ),
    );
    card.appendChild(actionsRow);

    // Footer help: tells the user where this string goes on the BSA
    // E-Filing portal.
    card.appendChild(el('p', {
      class: 'tb-card-meta',
      style: { marginTop: 'var(--tb-sp-3)', fontStyle: 'italic' },
    }, t('fbar.filing.late.footerHelp')));

    return card;
  }

  // --------------------------------------------------------------------
  // Form 114a (Preparer Authorization) card — only shown when filing
  // mode is third-party. Generates a printable A4 page with all the
  // fields auto-filled from filer + preparer records.
  //
  // 114a is NOT submitted to FinCEN. The preparer retains it for 5
  // years as proof that the actual filer authorized the e-filing.
  // --------------------------------------------------------------------

  function buildFiling114aCard(filer, year, mode, preparer) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'core', style: { borderLeft: '4px solid var(--tb-accent, #4a90e2)' } });
    card.appendChild(el('h3', { style: { margin: 0 } }, t('fbar.filing.f114a.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.filing.f114a.intro')));

    // Status checks: external mode means we don't have the preparer's
    // info in the household (the CPA fills out 114a themselves), and
    // we just generate a stub with the filer's info.
    if (mode === 'external_preparer') {
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-info, var(--tb-accent))' },
      }, t('fbar.filing.f114a.external.note')));
      card.appendChild(el('div', { class: 'tb-btn-row' },
        el('button', {
          class: 'tb-btn',
          onclick: () => openForm114aPrintWindow(filer.id, year, 'external_preparer', null),
        }, t('fbar.filing.f114a.print')),
      ));
      return card;
    }

    if (!preparer) {
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)' },
      }, t('fbar.filing.f114a.noPreparer')));
      return card;
    }

    // Preview rows — what's going onto the printed form.
    const fullName = filer.name_en || filer.name_jp || '—';
    const prepName = preparer.name_en || preparer.name_jp || '—';
    const prepFirm = preparer.notes && /firm:\s*(.+)/i.test(preparer.notes)
      ? preparer.notes.match(/firm:\s*(.+)/i)[1].trim()
      : t('fbar.filing.f114a.preview.firmBlank');

    const previewRows = [
      { label: t('fbar.filing.f114a.preview.filerName'), value: fullName },
      { label: t('fbar.filing.f114a.preview.filerSsn'),
        value: filer.ssn_last4 ? '•••-••-' + filer.ssn_last4 : t('fbar.filing.f114a.preview.ssnMissing'),
        warn: !filer.ssn_last4 },
      { label: t('fbar.filing.f114a.preview.filerAddress'),
        value: filer.filing_address || t('fbar.filing.f114a.preview.addressMissing'),
        warn: !filer.filing_address },
      { label: t('fbar.filing.f114a.preview.preparerName'), value: prepName },
      { label: t('fbar.filing.f114a.preview.preparerFirm'), value: prepFirm },
      { label: t('fbar.filing.f114a.preview.preparerAddress'),
        value: preparer.filing_address || t('fbar.filing.f114a.preview.addressMissing'),
        warn: !preparer.filing_address },
      { label: t('fbar.filing.f114a.preview.preparerTin'),
        value: preparer.ssn_last4 ? '•••-••-' + preparer.ssn_last4 : t('fbar.filing.f114a.preview.ssnMissing'),
        warn: !preparer.ssn_last4 },
      { label: t('fbar.filing.f114a.preview.years'), value: year },
    ];

    const previewTable = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)', marginTop: 'var(--tb-sp-3)' },
    });
    const ptbody = el('tbody');
    for (const r of previewRows) {
      ptbody.appendChild(el('tr', null,
        el('td', { style: Object.assign({}, tdStyle(), { width: '220px', fontWeight: '600', color: 'var(--tb-text-soft)' }) }, r.label),
        el('td', { style: r.warn ? Object.assign({}, tdStyle(), { color: 'var(--tb-warn)', fontStyle: 'italic' }) : tdStyle() }, r.value),
      ));
    }
    previewTable.appendChild(ptbody);
    card.appendChild(el('div', { style: { overflowX: 'auto' } }, previewTable));

    card.appendChild(el('div', { class: 'tb-btn-row', style: { marginTop: 'var(--tb-sp-3)' } },
      el('button', {
        class: 'tb-btn',
        onclick: () => openForm114aPrintWindow(filer.id, year, mode, preparer),
      }, t('fbar.filing.f114a.print')),
    ));

    card.appendChild(el('p', {
      class: 'tb-card-meta',
      style: { marginTop: 'var(--tb-sp-3)', fontStyle: 'italic' },
    }, t('fbar.filing.f114a.footerHelp')));

    return card;
  }

  function openForm114aPrintWindow(filerId, year, mode, preparer) {
    const filer = findFiler(filerId);
    if (!filer) { alert('Filer not found.'); return; }
    const html = buildForm114aHtml(filer, year, mode, preparer);
    const win = window.open('', '_blank', 'noopener');
    if (!win) {
      alert('Pop-up blocked. Allow pop-ups for this site to open the printable form.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  function buildForm114aHtml(filer, year, mode, preparer) {
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const esc = TB.utils.escapeHtml;
    const versionMeta = document.querySelector('meta[name="tb-version"]');
    const version = versionMeta ? versionMeta.content : '';
    const buildHashMeta = document.querySelector('meta[name="tb-build-hash"]');
    const buildHash = buildHashMeta ? buildHashMeta.content : '';

    const filerName = filer.name_en || filer.name_jp || '';
    const filerSsn = filer.ssn_last4 ? '_____ - ____ - ' + filer.ssn_last4 : '__________';
    const filerAddr = filer.filing_address || '';

    const isExternal = mode === 'external_preparer';
    const prepName = isExternal ? '' : (preparer ? (preparer.name_en || preparer.name_jp || '') : '');
    const prepAddr = isExternal ? '' : (preparer ? (preparer.filing_address || '') : '');
    const prepSsn = isExternal ? '__________' : (preparer && preparer.ssn_last4
      ? '_____ - ____ - ' + preparer.ssn_last4
      : '__________');

    const inner = `
      <header class="hdr">
        <h1>FinCEN Form 114a</h1>
        <h2>Record of Authorization to Electronically File FBARs</h2>
        <div class="meta">For tax year ${esc(year)} · Generated by Taigan Bridge</div>
      </header>

      <div class="auth-statement">
        <p>I (the filer) authorize the preparer named below to electronically file FBARs (FinCEN Form 114) on my behalf for the calendar year(s) noted below.</p>
      </div>

      <h3>Part I — Filer (Account Holder)</h3>
      <table class="form-table">
        <tr>
          <td class="label">Filer name</td>
          <td class="value">${esc(filerName) || '<span class="blank">______________________________</span>'}</td>
        </tr>
        <tr>
          <td class="label">Filer TIN (SSN)</td>
          <td class="value mono">${esc(filerSsn)}<br><span class="hint">⚠ Enter your full SSN by hand. Taigan Bridge stores last 4 only.</span></td>
        </tr>
        <tr>
          <td class="label">Filer address</td>
          <td class="value">${esc(filerAddr) || '<span class="blank">______________________________</span>'}</td>
        </tr>
      </table>

      <h3>Part II — Preparer</h3>
      ${isExternal ? `
      <p class="hint">External preparer (CPA / attorney): preparer fills in their own information here.</p>
      <table class="form-table">
        <tr><td class="label">Preparer name</td><td class="value"><span class="blank">______________________________</span></td></tr>
        <tr><td class="label">Firm name</td><td class="value"><span class="blank">______________________________</span></td></tr>
        <tr><td class="label">Preparer address</td><td class="value"><span class="blank">______________________________</span></td></tr>
        <tr><td class="label">Preparer TIN</td><td class="value mono">__________</td></tr>
      </table>
      ` : `
      <table class="form-table">
        <tr>
          <td class="label">Preparer name</td>
          <td class="value">${esc(prepName) || '<span class="blank">______________________________</span>'}</td>
        </tr>
        <tr>
          <td class="label">Firm name</td>
          <td class="value"><em>blank — self-employed (Item 50 checked)</em></td>
        </tr>
        <tr>
          <td class="label">Preparer address</td>
          <td class="value">${esc(prepAddr) || '<span class="blank">______________________________</span>'}</td>
        </tr>
        <tr>
          <td class="label">Preparer TIN (SSN)</td>
          <td class="value mono">${esc(prepSsn)}<br><span class="hint">⚠ Enter full SSN by hand.</span></td>
        </tr>
      </table>
      `}

      <h3>Part III — Authorization</h3>
      <table class="form-table">
        <tr>
          <td class="label">Calendar year(s) authorized</td>
          <td class="value mono"><strong>${esc(year)}</strong></td>
        </tr>
      </table>

      <div class="signature-block">
        <div class="sig">
          <div class="sig-line">______________________________</div>
          <div class="sig-label">Filer signature</div>
        </div>
        <div class="sig">
          <div class="sig-line">______________________________</div>
          <div class="sig-label">Date</div>
        </div>
      </div>

      <div class="signature-block">
        <div class="sig">
          <div class="sig-line">______________________________</div>
          <div class="sig-label">Preparer signature</div>
        </div>
        <div class="sig">
          <div class="sig-line">______________________________</div>
          <div class="sig-label">Date</div>
        </div>
      </div>

      <footer class="ftr">
        <strong>RETAIN, DO NOT SUBMIT.</strong> Form 114a is retained by the preparer for 5 years following the FBAR filing. Do NOT submit to FinCEN.<br>
        Generated by Taigan Bridge v${esc(version)}, build ${esc(buildHash)} on ${new Date().toISOString().slice(0, 10)}.
        Educational organizational tool only — verify all field values against the official FinCEN 114a before signing.
      </footer>
    `;

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>FinCEN Form 114a — ${esc(year)} — ${esc(filerName)}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    body { font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif; color: #1a1f2a; }
    .hdr { border-bottom: 2px solid #1a1f2a; padding-bottom: 8px; margin-bottom: 16px; }
    .hdr h1 { margin: 0; font-size: 22px; }
    .hdr h2 { margin: 4px 0 0; font-size: 14px; font-weight: 500; color: #555; }
    .meta { color: #666; font-size: 11px; margin-top: 6px; }
    h3 { margin: 18px 0 6px; font-size: 13px; border-bottom: 1px solid #ccc; padding-bottom: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
    .auth-statement { background: #f5f5f5; border-left: 3px solid #4a90e2; padding: 10px 12px; margin: 12px 0; font-size: 12px; }
    .auth-statement p { margin: 0; }
    .form-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    .form-table td { border: 1px solid #d0d0d0; padding: 6px 10px; vertical-align: top; }
    .form-table td.label { width: 180px; background: #f3efe6; font-weight: 600; }
    .form-table td.value { font-size: 12px; }
    .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
    .blank { color: #aaa; letter-spacing: 0.5px; }
    .hint { color: #8a4d00; font-size: 10px; display: block; margin-top: 2px; }
    .signature-block { display: flex; gap: 24px; margin: 18px 0; }
    .sig { flex: 1; }
    .sig-line { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 14px; letter-spacing: 0.5px; color: #aaa; }
    .sig-label { font-size: 10px; color: #555; margin-top: 2px; }
    .ftr { margin-top: 28px; padding-top: 10px; border-top: 1px solid #d0d0d0; font-size: 10px; color: #555; line-height: 1.4; }
  </style>
</head>
<body>
${inner}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 200));<\/script>
</body>
</html>`;
  }

  // --------------------------------------------------------------------
  // Treasury Rates Reference card — quick lookup for $10K threshold in
  // foreign currencies, year by year. Source: TREASURY_FX (hardcoded
  // unverified placeholders) overridden by state.settings.fx if the
  // user has refreshed from fiscal.treasury.gov via Settings.
  // --------------------------------------------------------------------

  function buildFilingRatesReferenceCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    // Years to show: union of (years that appear in user data) +
    // (years in TREASURY_FX), recent N years.
    const years = knownYears().filter(y => /^\d{4}$/.test(y));
    years.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    const showYears = years.slice(0, 8);

    // Currencies to show: ONLY ones that actually appear in the
    // household's accounts. USD is the reference (no rate needed).
    // No forced fallbacks — if all accounts are USD the table is
    // hidden behind an informational message; if there are no
    // accounts at all, ditto.
    const accounts = getAccounts();
    const userCurrencies = new Set();
    for (const a of accounts) {
      if (a.currency && a.currency !== 'USD') userCurrencies.add(a.currency);
    }
    const showCurrencies = Array.from(userCurrencies).sort();

    const card = el('div', { class: 'tb-card', 'data-track': 'core' });
    card.appendChild(el('h3', { style: { margin: 0 } }, t('fbar.filing.rates.title')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.filing.rates.intro')));

    // Edge case 1: no accounts at all yet.
    if (accounts.length === 0) {
      card.appendChild(el('p', { class: 'tb-wizard-help' }, t('fbar.filing.rates.empty')));
      return card;
    }

    // Edge case 2: every account is USD. No FX conversion needed for
    // FBAR — all max balances are already in the reporting currency.
    if (showCurrencies.length === 0) {
      card.appendChild(el('div', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-info, var(--tb-accent))' },
      }, t('fbar.filing.rates.allUsd')));
      return card;
    }

    if (showYears.length === 0) {
      card.appendChild(el('p', { class: 'tb-wizard-help' }, t('fbar.filing.rates.noYears')));
      return card;
    }

    // Edge case 3: a currency in the user's accounts is not in our
    // TREASURY_FX table (e.g. obscure currency, typo). Surface it
    // separately so the user knows the row will be empty.
    const unknownCurrencies = [];
    for (const c of showCurrencies) {
      let hasAnyRate = false;
      for (const y of showYears) {
        const fx = fxRateFor(c, y);
        if (fx.rate != null) { hasAnyRate = true; break; }
      }
      if (!hasAnyRate) unknownCurrencies.push(c);
    }

    const table = el('table', {
      style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--tb-fs-14)', marginTop: 'var(--tb-sp-3)' },
    });
    const headRow = el('tr', null,
      el('th', { style: thStyle() }, t('fbar.filing.rates.col.year')),
      ...showCurrencies.map(c => el('th', { style: thStyle('right') }, c + ' / USD')),
      ...showCurrencies.map(c => el('th', { style: thStyle('right') }, '$10K in ' + c)),
    );
    table.appendChild(el('thead', null, headRow));

    const tbody = el('tbody');
    for (const y of showYears) {
      const row = el('tr', null,
        el('td', { style: Object.assign({}, tdStyle(), { fontWeight: '600' }) }, y),
        ...showCurrencies.map(c => {
          const fx = fxRateFor(c, y);
          const rate = fx.rate;
          return el('td', { style: Object.assign({}, tdStyle('right'), { fontFamily: 'var(--tb-font-mono)' }) },
            rate != null ? rate.toFixed(rate > 100 ? 2 : 3) : '—');
        }),
        ...showCurrencies.map(c => {
          const fx = fxRateFor(c, y);
          const rate = fx.rate;
          return el('td', { style: Object.assign({}, tdStyle('right'), { fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-soft)' }) },
            rate != null
              ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(rate * 10000)
              : '—');
        }),
      );
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    card.appendChild(el('div', { style: { overflowX: 'auto' } }, table));

    // Edge-case warning: any currency we couldn't price for any
    // year. The row is still in the table (with em-dashes) but the
    // user needs to know the rates aren't from Treasury — they have
    // to look those up manually.
    if (unknownCurrencies.length > 0) {
      card.appendChild(el('div', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)', marginTop: 'var(--tb-sp-3)' },
      }, t('fbar.filing.rates.unknownCurrency', {
        currencies: unknownCurrencies.join(', '),
      })));
    }

    // Source label + refresh button.
    const fetchedAt = TB.state.get('settings.fx.treasury_fetched_at');
    const sourceLabel = fetchedAt
      ? t('fbar.filing.rates.source.fetched', { date: String(fetchedAt).slice(0, 10) })
      : t('fbar.filing.rates.source.placeholder');

    card.appendChild(el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-3)', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' },
    },
      el('span', { class: 'tb-card-meta', style: { margin: 0 } }, sourceLabel),
      el('button', {
        class: 'tb-btn tb-btn--secondary',
        onclick: async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = t('fbar.filing.rates.refreshing');
          try {
            await refreshTreasuryRates(showYears);
            renderActiveTab();
          } catch (err) {
            alert(t('fbar.filing.rates.refreshFailed') + '\n\n' + (err && err.message || err));
            btn.disabled = false;
            btn.textContent = t('fbar.filing.rates.refresh');
          }
        },
      }, t('fbar.filing.rates.refresh')),
    ));

    return card;
  }

  // --------------------------------------------------------------------
  // AI FBAR Advisor card — quick-prompt buttons + free-text Q&A backed
  // by Claude. Per-session only (no persistence). Always shows a
  // "configure API key" pointer if the user hasn't set one in Settings.
  // --------------------------------------------------------------------

  let advisorState = { lastQuery: '', lastAnswer: '', loading: false };

  function buildFilingAiAdvisorCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const card = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h3', { style: { margin: 0 } }, t('fbar.filing.advisor.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.filing.advisor.intro')),
    );

    const hasKey = TB.ai && TB.ai.hasKey && TB.ai.hasKey();
    if (!hasKey) {
      card.appendChild(el('p', {
        class: 'tb-disclaimer-inline',
        style: { borderLeftColor: 'var(--tb-warn)' },
      }, t('fbar.filing.advisor.noKey')));
      return card;
    }

    // Quick-prompt buttons.
    const presets = [
      { key: 'overview',  promptKey: 'fbar.filing.advisor.preset.overview.prompt',  labelKey: 'fbar.filing.advisor.preset.overview.label' },
      { key: 'deadlines', promptKey: 'fbar.filing.advisor.preset.deadlines.prompt', labelKey: 'fbar.filing.advisor.preset.deadlines.label' },
      { key: 'risks',     promptKey: 'fbar.filing.advisor.preset.risks.prompt',     labelKey: 'fbar.filing.advisor.preset.risks.label' },
    ];

    const presetRow = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)', marginBottom: 'var(--tb-sp-3)' } },
      ...presets.map(p => el('button', {
        class: 'tb-btn tb-btn--secondary',
        onclick: () => {
          input.value = t(p.promptKey);
          submitAdvisorQuery();
        },
      }, t(p.labelKey))),
    );
    card.appendChild(presetRow);

    const inputRow = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)', alignItems: 'stretch', marginBottom: 'var(--tb-sp-3)' } });
    const input = el('input', {
      type: 'text',
      class: 'tb-input',
      style: { flex: '1 1 0' },
      placeholder: t('fbar.filing.advisor.placeholder'),
      onkeydown: (e) => { if (e.key === 'Enter') submitAdvisorQuery(); },
    });
    if (advisorState.lastQuery) input.value = advisorState.lastQuery;

    const askBtn = el('button', {
      class: 'tb-btn',
      onclick: submitAdvisorQuery,
    }, t('fbar.filing.advisor.ask'));
    inputRow.appendChild(input);
    inputRow.appendChild(askBtn);
    card.appendChild(inputRow);

    // Answer area.
    const answerArea = el('div', {
      id: 'tb-fbar-advisor-answer',
      style: { whiteSpace: 'pre-wrap', lineHeight: '1.55', minHeight: '32px' },
    });
    if (advisorState.loading) {
      answerArea.appendChild(el('p', { class: 'tb-card-meta' }, t('fbar.filing.advisor.loading')));
    } else if (advisorState.lastAnswer) {
      answerArea.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)', border: '1px solid var(--tb-border)', borderRadius: 'var(--tb-radius-2)' },
      }, advisorState.lastAnswer));
    }
    card.appendChild(answerArea);

    card.appendChild(el('p', {
      class: 'tb-card-meta',
      style: { marginTop: 'var(--tb-sp-3)', fontStyle: 'italic' },
    }, t('fbar.filing.advisor.disclaimer')));

    function submitAdvisorQuery() {
      const q = (input.value || '').trim();
      if (!q || advisorState.loading) return;
      advisorState.lastQuery = q;
      advisorState.loading = true;
      advisorState.lastAnswer = '';
      renderActiveTab();

      const sys = 'You are a tax-information assistant explaining FBAR (FinCEN Form 114) rules to a U.S. person living abroad. ' +
        'Provide accurate, conservative answers. Always recommend the user verify with fincen.gov and consult a qualified tax professional before filing. ' +
        'Do not offer legal advice. Be concise — prefer 3-6 sentences over long-form. ' +
        'If the question is outside FBAR scope (general tax, immigration, etc.), say so briefly and redirect.';

      // live: true is required to actually hit the API — without it,
      // callClaude returns a placeholder response by design.
      TB.ai.callClaudeWithFbarContext(q, { system: sys, maxTokens: 700, live: true })
        .then(resp => {
          advisorState.loading = false;
          const txt = resp && resp.content && resp.content[0] && resp.content[0].text;
          advisorState.lastAnswer = txt || t('fbar.filing.advisor.errorEmpty');
          renderActiveTab();
        })
        .catch(err => {
          advisorState.loading = false;
          advisorState.lastAnswer = t('fbar.filing.advisor.errorPrefix') + '\n\n' + (err && err.message || err);
          renderActiveTab();
        });
    }

    return card;
  }

  // --------------------------------------------------------------------
  // Generic checklist table — rows of { item, field, action, warn? }.
  // --------------------------------------------------------------------

  function buildChecklistTable(rows) {
    const el = TB.utils.el;
    const t = TB.i18n.t;

    const table = el('table', {
      class: 'tb-fbar-filing-checklist',
      style: {
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 'var(--tb-fs-14)',
        marginTop: 'var(--tb-sp-3)',
      },
    });
    table.appendChild(el('thead', null,
      el('tr', null,
        el('th', { style: Object.assign({}, thStyle(), { width: '70px' }) }, t('fbar.filing.col.item')),
        el('th', { style: Object.assign({}, thStyle(), { width: '220px' }) }, t('fbar.filing.col.field')),
        el('th', { style: thStyle() }, t('fbar.filing.col.action')),
      ),
    ));

    const tbody = el('tbody');
    for (const r of rows) {
      const actionStyle = r.warn
        ? Object.assign({}, tdStyle(), { color: 'var(--tb-warn)', fontStyle: 'italic' })
        : tdStyle();
      tbody.appendChild(el('tr', null,
        el('td', { style: Object.assign({}, tdStyle(), { fontFamily: 'var(--tb-font-mono)', color: 'var(--tb-text-muted)' }) }, r.item),
        el('td', { style: Object.assign({}, tdStyle(), { fontWeight: '600' }) }, r.field),
        el('td', { style: actionStyle }, r.action),
      ));
    }
    table.appendChild(tbody);

    return el('div', { style: { overflowX: 'auto' } }, table);
  }

  // ====================================================================
  // PRINT SUMMARY
  // ====================================================================

  function renderPrint(tabHost) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const filers = getFilers();
    const yrs = knownYears();
    const lang = TB.i18n.getLang();

    if (!printState.filerId && filers.length > 0) printState.filerId = filers[0].id;
    if (!printState.year) printState.year = defaultYear();

    const headerCard = el('div', { class: 'tb-card', 'data-track': 'core' },
      el('h2', null, t('fbar.print.title')),
      el('p', { class: 'tb-card-meta' }, t('fbar.print.intro')),
      grid2col(
        field(t('fbar.print.select.filer'), el('select', {
          class: 'tb-select',
          onchange: (e) => { printState.filerId = e.target.value; renderActiveTab(); },
        },
          el('option', { value: '' }, '—'),
          ...filers.map(f => el('option', {
            value: f.id, selected: printState.filerId === f.id,
          }, displayName(f, lang) || '—')),
        )),
        field(t('fbar.print.select.year'), el('select', {
          class: 'tb-select',
          onchange: (e) => { printState.year = e.target.value; renderActiveTab(); },
        },
          ...yrs.map(y => el('option', { value: y, selected: printState.year === y }, y)),
        )),
      ),
      el('div', { class: 'tb-btn-row' },
        el('button', { class: 'tb-btn', onclick: openPrintWindow }, t('fbar.print.print')),
      ),
    );
    tabHost.appendChild(headerCard);

    const previewCard = el('div', { class: 'tb-card', 'data-track': 'core' });
    previewCard.appendChild(el('h3', null, t('fbar.print.preview.title')));
    if (!printState.filerId || !printState.year) {
      previewCard.appendChild(el('p', { class: 'tb-wizard-help' }, t('fbar.print.empty')));
    } else {
      const summary = buildPrintSummaryHtml(printState.filerId, printState.year, false);
      const previewWrap = el('div', { class: 'tb-fbar-print-preview' });
      previewWrap.innerHTML = summary;
      previewCard.appendChild(previewWrap);
    }
    tabHost.appendChild(previewCard);
  }

  function buildPrintSummaryHtml(filerId, year, fullDoc) {
    const filer = findFiler(filerId);
    if (!filer) return '<p>Filer not found.</p>';
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const status = thresholdStatus(filerId, year);
    const accounts = getAccounts().filter(a => (a.filer_ids || []).includes(filerId) && isAccountActiveInYear(a, year));
    const balances = getBalances();
    const esc = TB.utils.escapeHtml;

    const meta = document.querySelector('meta[name="tb-version"]');
    const version = meta ? meta.content : '';
    const hashMeta = document.querySelector('meta[name="tb-build-hash"]');
    const buildHash = hashMeta ? hashMeta.content : '';

    const accountRows = accounts.map((a, i) => {
      const bal = balances.find(b => b.account_id === a.id && String(b.year) === String(year));
      const ownerNames = (a.filer_ids || [])
        .map(id => findFiler(id))
        .filter(Boolean)
        .map(f => esc(displayName(f, lang)))
        .join(', ');
      const native = bal && bal.max_balance_native != null
        ? new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US').format(bal.max_balance_native) + ' ' + esc(a.currency)
        : '—';
      const usd = bal && bal.max_balance_usd != null ? TB.utils.formatUSD(bal.max_balance_usd) : '—';
      const fxLine = bal && bal.fx_rate_used != null
        ? bal.fx_rate_used + ' (' + esc(bal.fx_rate_source || '') + ')'
        : '—';
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(a.institution_name || '')}<br><small>${esc(a.institution_address || '')}</small></td>
          <td>${esc(a.country)}</td>
          <td>${esc(masked(a.account_number_full))}</td>
          <td>${esc(t('fbar.accounts.account_type.' + a.account_type))}${a.signatory_only ? '<br><small>signature authority only</small>' : ''}</td>
          <td>${esc(a.currency)}</td>
          <td style="text-align:right">${native}</td>
          <td style="text-align:right">${usd}</td>
          <td>${fxLine}</td>
          <td>${ownerNames || '—'}</td>
        </tr>`;
    }).join('');

    const verdictHtml = status.status === 'at_or_over'
      ? `<div class="verdict required"><strong>FBAR REQUIRED</strong> for ${esc(displayName(filer, lang))} for ${esc(year)}. Aggregate ${TB.utils.formatUSD(status.aggregate_usd)} exceeds the $10,000 threshold. File via the FinCEN BSA E-Filing System by April 15 (auto-extended to October 15).</div>`
      : status.status === 'under'
      ? `<div class="verdict ok"><strong>FBAR not required</strong> for ${esc(year)}. Aggregate ${TB.utils.formatUSD(status.aggregate_usd)} is at or under the $10,000 threshold.</div>`
      : status.status === 'not_us_person'
      ? `<div class="verdict info">Filer is not a U.S. person — FBAR does not apply.</div>`
      : `<div class="verdict warn"><strong>Insufficient data.</strong> One or more accounts are missing balance entries for ${esc(year)}. Threshold cannot be determined.</div>`;

    const warnings = (status.warnings || []).length
      ? '<ul class="warnings">' + status.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>'
      : '';

    const filerInfoHtml = `
      <h2>Filer</h2>
      <table class="info">
        <tr><th>Name</th><td>${esc(filer.name_en || '—')}${filer.name_jp ? ' / <span lang="ja">' + esc(filer.name_jp) + '</span>' : ''}</td></tr>
        <tr><th>Relationship</th><td>${esc(t('fbar.filers.relationship.' + filer.relationship))}${filer.isMinor ? ' (minor — parent may sign on the minor\'s behalf)' : ''}</td></tr>
        <tr><th>Date of birth</th><td>${esc(filer.dob || '—')}</td></tr>
        <tr><th>SSN (last 4)</th><td>***-**-${esc(filer.ssn_last4 || '----')}</td></tr>
        <tr><th>Address</th><td>${esc(filer.filing_address || '—')}</td></tr>
        <tr><th>U.S. person</th><td>${filer.isUSPerson ? 'Yes' : 'No'}</td></tr>
      </table>`;

    const accountsTable = `
      <h2>Foreign accounts active in ${esc(year)}</h2>
      <table class="accounts">
        <thead><tr>
          <th>#</th><th>Institution</th><th>Country</th><th>Account #</th>
          <th>Type</th><th>Cur</th><th style="text-align:right">Max (native)</th>
          <th style="text-align:right">Max (USD)</th><th>FX rate</th><th>Owners</th>
        </tr></thead>
        <tbody>${accountRows || '<tr><td colspan="10"><em>No foreign accounts active in ' + esc(year) + '.</em></td></tr>'}</tbody>
      </table>`;

    const filerNotes = filer.notes ? `<h2>Notes</h2><p>${esc(filer.notes)}</p>` : '';

    const inner = `
      <header class="hdr">
        <h1>FBAR Summary — ${esc(year)}</h1>
        <div class="meta">For: ${esc(displayName(filer, lang) || '—')} · Generated by Taigan Bridge</div>
      </header>

      ${verdictHtml}
      ${warnings}

      ${filerInfoHtml}

      ${accountsTable}

      ${filerNotes}

      <footer class="ftr">
        Generated by Taigan Bridge v${esc(version)}, build ${esc(buildHash)} on ${new Date().toISOString()}.
        Educational organizational tool only — not a filing.
        File at <strong>bsaefiling.fincen.treas.gov</strong>.
        <br>FX rates in this build are <strong>UNVERIFIED</strong> placeholders;
        confirm against fiscal.treasury.gov before filing.
      </footer>
    `;

    if (!fullDoc) return printPreviewStyles() + inner;

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>FBAR Summary — ${esc(year)} — ${esc(displayName(filer, lang) || '')}</title>
  ${printDocStyles()}
</head>
<body>
${inner}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 100));<\/script>
</body>
</html>`;
  }

  function printPreviewStyles() {
    return `<style>
      .tb-fbar-print-preview .hdr h1 { margin: 0 0 4px; font-size: 20px; }
      .tb-fbar-print-preview .meta { color: var(--tb-text-soft); font-size: var(--tb-fs-12); margin-bottom: var(--tb-sp-4); }
      .tb-fbar-print-preview h2 { margin: 18px 0 8px; font-size: 14px; border-bottom: 1px solid var(--tb-border); padding-bottom: 2px; }
      .tb-fbar-print-preview table { width: 100%; border-collapse: collapse; font-size: var(--tb-fs-12); }
      .tb-fbar-print-preview th, .tb-fbar-print-preview td { border: 1px solid var(--tb-border); padding: 4px 6px; vertical-align: top; }
      .tb-fbar-print-preview th { background: var(--tb-paper); text-align: left; font-weight: 600; }
      .tb-fbar-print-preview .verdict { padding: 10px 12px; border-radius: 6px; margin: 10px 0; }
      .tb-fbar-print-preview .verdict.required { background: rgba(185,122,26,0.15); color: var(--tb-warn); }
      .tb-fbar-print-preview .verdict.ok { background: rgba(47,111,78,0.10); color: var(--tb-success); }
      .tb-fbar-print-preview .verdict.warn { background: rgba(178,58,58,0.08); color: var(--tb-error); }
      .tb-fbar-print-preview .verdict.info { background: var(--tb-bg); color: var(--tb-text-soft); }
      .tb-fbar-print-preview .warnings { margin: 8px 0; padding-left: 20px; color: var(--tb-warn); font-size: var(--tb-fs-12); }
      .tb-fbar-print-preview .ftr { margin-top: 24px; font-size: var(--tb-fs-12); color: var(--tb-text-soft); line-height: 1.4; }
      .tb-fbar-print-preview table.info th { width: 160px; }
    </style>`;
  }

  function printDocStyles() {
    return `<style>
      @page { size: A4; margin: 18mm; }
      body { font: 12px/1.45 system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif; color: #1a1f2a; }
      h1 { margin: 0 0 4px; font-size: 20px; }
      h2 { margin: 18px 0 6px; font-size: 14px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
      .meta { color: #666; font-size: 11px; margin-bottom: 14px; }
      .verdict { padding: 10px 12px; border-radius: 6px; margin: 12px 0; }
      .verdict.required { background: #fff4e0; color: #8a4d00; border: 1px solid #e2b573; }
      .verdict.ok { background: #e9f4ec; color: #1f5b3b; border: 1px solid #9ec7ad; }
      .verdict.warn { background: #fdecec; color: #8b2a2a; border: 1px solid #d99898; }
      .verdict.info { background: #f5f5f5; color: #555; border: 1px solid #ddd; }
      .warnings { margin: 8px 0; padding-left: 20px; color: #8a4d00; font-size: 11px; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th, td { border: 1px solid #d0d0d0; padding: 4px 6px; vertical-align: top; }
      th { background: #f3efe6; text-align: left; font-weight: 600; }
      table.info th { width: 160px; }
      table.accounts thead tr { page-break-after: avoid; }
      table.accounts tr { page-break-inside: avoid; }
      .ftr { margin-top: 24px; font-size: 10px; color: #666; line-height: 1.4; }
    </style>`;
  }

  function openPrintWindow() {
    if (!printState.filerId || !printState.year) {
      alert('Select a filer and year first.');
      return;
    }
    const html = buildPrintSummaryHtml(printState.filerId, printState.year, true);
    const win = window.open('', '_blank', 'noopener');
    if (!win) {
      alert('Pop-up blocked. Allow pop-ups for this site to print the summary.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // ====================================================================
  // Small UI helpers used across sub-views
  // ====================================================================

  // Three-dropdown date picker (Year / Month / Day). Native HTML5
  // <input type="date"> is awful for dates that need to scroll back
  // many years (DOB) — picking a 2017 birth from a 2026 starting
  // point requires either typing manually or scrolling year-by-year.
  // Three selects let the user jump straight to the right year.
  //
  // currentValue: ISO date string "YYYY-MM-DD" or empty.
  // onChange(newValueOrEmpty): called when all three are set or any
  //   is cleared.
  function buildYearMonthDayPicker(currentValue, onChange) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const fmt = new Intl.DateTimeFormat(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'long' });
    const monthNames = Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));

    const parts = String(currentValue || '').split('-');
    const state = {
      year: parts[0] || '',
      month: parts[1] || '',
      day: parts[2] || '',
    };

    const today = new Date();
    const thisYear = today.getFullYear();
    const yearOptions = [];
    for (let y = thisYear; y >= thisYear - 110; y--) yearOptions.push(String(y));

    function commit() {
      if (state.year && state.month && state.day) {
        const m = String(state.month).padStart(2, '0');
        const d = String(state.day).padStart(2, '0');
        onChange(state.year + '-' + m + '-' + d);
      } else if (!state.year && !state.month && !state.day) {
        onChange('');
      }
      // Partial selection: don't commit yet — wait for all three.
    }

    const yearSelect = el('select', {
      class: 'tb-select',
      style: { flex: '1 1 0', minWidth: '90px' },
      onchange: (e) => { state.year = e.target.value; commit(); },
    },
      el('option', { value: '', selected: !state.year }, t('fbar.dob.year')),
      ...yearOptions.map(y => el('option', { value: y, selected: state.year === y }, y)),
    );

    const monthSelect = el('select', {
      class: 'tb-select',
      style: { flex: '1 1 0', minWidth: '110px' },
      onchange: (e) => { state.month = e.target.value; commit(); },
    },
      el('option', { value: '', selected: !state.month }, t('fbar.dob.month')),
      ...monthNames.map((name, i) => {
        const val = String(i + 1).padStart(2, '0');
        return el('option', { value: val, selected: state.month === val }, name);
      }),
    );

    const daySelect = el('select', {
      class: 'tb-select',
      style: { flex: '0 0 80px' },
      onchange: (e) => { state.day = e.target.value; commit(); },
    },
      el('option', { value: '', selected: !state.day }, t('fbar.dob.day')),
      ...Array.from({ length: 31 }, (_, i) => {
        const val = String(i + 1).padStart(2, '0');
        return el('option', { value: val, selected: state.day === val }, String(i + 1));
      }),
    );

    return el('div', {
      style: { display: 'flex', gap: 'var(--tb-sp-2)' },
    }, yearSelect, monthSelect, daySelect);
  }

  function field(label, control, help) {
    const el = TB.utils.el;
    return el('label', { class: 'tb-field', style: { marginBottom: 0 } },
      el('span', { class: 'tb-field-label' }, label),
      control,
      help ? el('div', { class: 'tb-field-help' }, help) : null,
    );
  }

  function grid2col() {
    const el = TB.utils.el;
    return el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--tb-sp-3)', marginBottom: 'var(--tb-sp-3)' },
    }, ...arguments);
  }

  // ====================================================================
  // Module registration
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = {
    id,
    label_en: 'FBAR Tracker',
    label_jp: 'FBAR トラッカー',
    render,
  };

  // Expose pure functions for tests / AI sanitizer integration.
  window.TB.fbar = {
    thresholdStatus,
    summarizeFbarForAi,
    FBAR_THRESHOLD_USD,
    TREASURY_FX,
    fxRateFor,
    refreshTreasuryRates,
    defaultRefreshYears,
    SUPPORTED_CURRENCIES,
  };
})();
