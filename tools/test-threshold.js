#!/usr/bin/env node
/*
 * Standalone test harness for the FBAR threshold logic.
 *
 * Re-implements the pure thresholdStatus() function in node and runs
 * the 10 walkthrough scenarios from the v0.2.1 FBAR Tracker spec
 * against it, asserting expected behavior for each.
 *
 * Why a re-implementation rather than loading fbar.js: fbar.js is a
 * browser IIFE that depends on TB.state, TB.utils, TB.i18n, and
 * window. Pulling all that into node would obscure the logic test.
 * The threshold rules below MUST match those in fbar.js — if you
 * change one, change both.
 *
 * Usage: node tools/test-threshold.js
 */

const FBAR_THRESHOLD_USD = 10000;

function isAccountActiveInYear(account, year) {
  const y = parseInt(year, 10);
  if (account.opened_year && parseInt(account.opened_year, 10) > y) return false;
  if (account.closed_year && parseInt(account.closed_year, 10) < y) return false;
  return true;
}

function thresholdStatus(state, filerId, year) {
  const filer = state.filers.find(f => f.id === filerId);
  if (!filer) {
    return { status: 'no_filer', aggregate_usd: 0, threshold: FBAR_THRESHOLD_USD, contributing_accounts: [], warnings: [] };
  }
  if (!filer.isUSPerson) {
    return { status: 'not_us_person', aggregate_usd: 0, threshold: FBAR_THRESHOLD_USD, contributing_accounts: [], warnings: [] };
  }

  const accounts = state.accounts.filter(a =>
    Array.isArray(a.filer_ids) && a.filer_ids.includes(filerId)
  );
  const warnings = [];
  let total = 0;
  const contributing = [];
  let missing = 0;

  for (const acct of accounts) {
    if (acct.country === 'US') continue;
    if (!isAccountActiveInYear(acct, year)) continue;

    const bal = state.yearly_balances.find(b =>
      b.account_id === acct.id && String(b.year) === String(year)
    );
    if (!bal || bal.max_balance_usd == null) {
      missing += 1;
      continue;
    }
    total += Number(bal.max_balance_usd);
    contributing.push(acct.id);
  }

  if (missing > 0) warnings.push(missing + ' account(s) missing a balance entry for ' + year + '.');

  let status;
  if (total > FBAR_THRESHOLD_USD) status = 'at_or_over';
  else if (missing > 0) status = 'insufficient_data';
  else if (contributing.length === 0) status = 'insufficient_data';
  else status = 'under';

  return {
    aggregate_usd: total,
    threshold: FBAR_THRESHOLD_USD,
    status,
    contributing_accounts: contributing,
    warnings,
  };
}

// ----- helpers --------------------------------------------------

function emptyState() {
  return { filers: [], accounts: [], yearly_balances: [], filing_history: [] };
}

function filer(id, opts) {
  return Object.assign({
    id, name_en: id, name_jp: '',
    relationship: 'self',
    isMinor: false, isUSPerson: true,
    ssn_last4: '', dob: '', filing_address: '', notes: '',
  }, opts);
}

function account(id, filerIds, opts) {
  return Object.assign({
    id, filer_ids: filerIds,
    account_type: 'bank',
    institution_name: 'Test Bank',
    institution_address: '',
    account_number_full: '****0000',
    currency: 'JPY', country: 'JP',
    opened_year: 2010, closed_year: null,
    signatory_only: false, notes: '',
  }, opts);
}

function balance(accountId, year, usd, opts) {
  return Object.assign({
    id: 'bal-' + accountId + '-' + year,
    account_id: accountId, year: String(year),
    max_balance_native: usd * 150, max_balance_date: '',
    fx_rate_used: 150, fx_rate_source: 'test',
    fx_rate_overridden: false,
    max_balance_usd: usd, notes: '',
  }, opts);
}

let pass = 0, fail = 0;
function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓', label); }
  else    { fail++; console.log('  ✗', label, '\n      expected:', JSON.stringify(expected), '\n      actual:  ', JSON.stringify(actual)); }
}

// ----- Scenarios -----------------------------------------------

console.log('\nScenario 1: Single filer, no accounts → "insufficient_data" (no foreign account contribution)');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('status is insufficient_data', r.status, 'insufficient_data');
  assertEq('aggregate is 0', r.aggregate_usd, 0);
}

console.log('\nScenario 2: Single filer, one foreign account, $5,000 USD-equivalent → "under"');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a1', ['f1']));
  s.yearly_balances.push(balance('a1', 2024, 5000));
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('status is under', r.status, 'under');
  assertEq('aggregate is 5000', r.aggregate_usd, 5000);
  assertEq('one contributing account', r.contributing_accounts, ['a1']);
}

console.log('\nScenario 3: Single filer, three foreign accounts each $4,000 → aggregate $12,000 → "at_or_over"');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a1', ['f1']));
  s.accounts.push(account('a2', ['f1']));
  s.accounts.push(account('a3', ['f1']));
  s.yearly_balances.push(balance('a1', 2024, 4000));
  s.yearly_balances.push(balance('a2', 2024, 4000));
  s.yearly_balances.push(balance('a3', 2024, 4000));
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('status is at_or_over', r.status, 'at_or_over');
  assertEq('aggregate is 12000', r.aggregate_usd, 12000);
  assertEq('three contributing accounts', r.contributing_accounts.length, 3);
}

console.log('\nScenario 4: Two filers (self + spouse), joint account at $15,000 → BOTH count the FULL $15,000');
{
  const s = emptyState();
  s.filers.push(filer('self', { relationship: 'self' }));
  s.filers.push(filer('spouse', { relationship: 'spouse' }));
  s.accounts.push(account('joint', ['self', 'spouse']));
  s.yearly_balances.push(balance('joint', 2024, 15000));

  const rSelf = thresholdStatus(s, 'self', '2024');
  const rSpouse = thresholdStatus(s, 'spouse', '2024');
  assertEq('self aggregate = $15,000 (full)', rSelf.aggregate_usd, 15000);
  assertEq('self status at_or_over', rSelf.status, 'at_or_over');
  assertEq('spouse aggregate = $15,000 (full)', rSpouse.aggregate_usd, 15000);
  assertEq('spouse status at_or_over', rSpouse.status, 'at_or_over');
}

console.log('\nScenario 5: Three filers (self + spouse + minor child), child has $11,000 account → child status at_or_over');
{
  const s = emptyState();
  s.filers.push(filer('self'));
  s.filers.push(filer('spouse', { relationship: 'spouse' }));
  s.filers.push(filer('child', { relationship: 'child', isMinor: true }));
  s.accounts.push(account('child-acct', ['child']));
  s.yearly_balances.push(balance('child-acct', 2024, 11000));

  const rChild = thresholdStatus(s, 'child', '2024');
  const rSelf = thresholdStatus(s, 'self', '2024');
  assertEq('child status at_or_over', rChild.status, 'at_or_over');
  assertEq('child aggregate $11,000', rChild.aggregate_usd, 11000);
  assertEq('self has no contributing accounts (insufficient_data)', rSelf.status, 'insufficient_data');
}

console.log('\nScenario 6 [logic check]: Account in unknown currency with manually-entered FX rate → still computes correctly');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a1', ['f1'], { currency: 'XYZ', country: 'OTHER' }));
  // Simulate user manually entering FX rate (computed USD value):
  s.yearly_balances.push(balance('a1', 2024, 11000, {
    max_balance_native: 11000000, fx_rate_used: 1000, fx_rate_overridden: true,
    fx_rate_source: 'Manual override',
  }));
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('status at_or_over with custom currency', r.status, 'at_or_over');
  assertEq('aggregate $11,000', r.aggregate_usd, 11000);
}

console.log('\nScenario 7: One account with missing balance entry → status "insufficient_data" with warning');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a1', ['f1']));
  s.accounts.push(account('a2', ['f1']));
  s.yearly_balances.push(balance('a1', 2024, 4000));
  // a2 has no balance entry
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('status insufficient_data (partial below threshold)', r.status, 'insufficient_data');
  assertEq('aggregate is 4000 (partial)', r.aggregate_usd, 4000);
  assertEq('warning present', r.warnings.length > 0, true);
}

console.log('\nScenario 7b: Missing entry but other account already over threshold → status locked at_or_over');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a1', ['f1']));
  s.accounts.push(account('a2', ['f1']));
  s.yearly_balances.push(balance('a1', 2024, 50000));
  // a2 missing
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('status at_or_over despite missing data', r.status, 'at_or_over');
  assertEq('warnings still surface missing entry', r.warnings.length > 0, true);
}

console.log('\nUS account exclusion: Account with country=US is tracked but excluded from FBAR aggregate');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a-us', ['f1'], { country: 'US' }));
  s.accounts.push(account('a-jp', ['f1'], { country: 'JP' }));
  s.yearly_balances.push(balance('a-us', 2024, 100000));
  s.yearly_balances.push(balance('a-jp', 2024, 5000));
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('aggregate excludes US account', r.aggregate_usd, 5000);
  assertEq('status under (US excluded)', r.status, 'under');
  assertEq('contributing only the JP account', r.contributing_accounts, ['a-jp']);
}

console.log('\nNon-US-person spouse on joint account: spouse not subject; US person reports full');
{
  const s = emptyState();
  s.filers.push(filer('us-self', { isUSPerson: true }));
  s.filers.push(filer('jp-spouse', { isUSPerson: false }));
  s.accounts.push(account('joint', ['us-self', 'jp-spouse']));
  s.yearly_balances.push(balance('joint', 2024, 12000));

  const rSelf = thresholdStatus(s, 'us-self', '2024');
  const rSpouse = thresholdStatus(s, 'jp-spouse', '2024');
  assertEq('US self counts full $12,000', rSelf.aggregate_usd, 12000);
  assertEq('US self status at_or_over', rSelf.status, 'at_or_over');
  assertEq('JP spouse status not_us_person', rSpouse.status, 'not_us_person');
  assertEq('JP spouse aggregate 0', rSpouse.aggregate_usd, 0);
}

console.log('\nAccount opened mid-year, closed mid-year: counted only in years it was active');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('a1', ['f1'], { opened_year: 2023, closed_year: 2023 }));
  s.yearly_balances.push(balance('a1', 2023, 11000));
  // No balance for 2024 because account was closed.
  const r2023 = thresholdStatus(s, 'f1', '2023');
  const r2024 = thresholdStatus(s, 'f1', '2024');
  assertEq('2023 status at_or_over (account active)', r2023.status, 'at_or_over');
  assertEq('2024 status insufficient_data (no active accounts at all)', r2024.status, 'insufficient_data');
  assertEq('2024 aggregate is 0', r2024.aggregate_usd, 0);
}

console.log('\nWadachi case: minor with small foreign balance — recordable, not threshold-triggering');
{
  const s = emptyState();
  s.filers.push(filer('f-minor', { relationship: 'child', isMinor: true }));
  s.accounts.push(account('a-jp', ['f-minor']));
  s.yearly_balances.push(balance('a-jp', 2024, 350));   // ¥52,500-ish, well under threshold
  const r = thresholdStatus(s, 'f-minor', '2024');
  assertEq('minor status under', r.status, 'under');
  assertEq('minor aggregate $350', r.aggregate_usd, 350);
}

console.log('\nSignature authority only (no financial interest) — still triggers reporting');
{
  const s = emptyState();
  s.filers.push(filer('f1'));
  s.accounts.push(account('emp-acct', ['f1'], { signatory_only: true }));
  s.yearly_balances.push(balance('emp-acct', 2024, 200000));
  const r = thresholdStatus(s, 'f1', '2024');
  assertEq('signatory-only at_or_over', r.status, 'at_or_over');
  assertEq('signatory-only aggregate $200,000', r.aggregate_usd, 200000);
}

console.log('\n----- Results -----');
console.log('  passed: ' + pass);
console.log('  failed: ' + fail);
process.exit(fail === 0 ? 0 : 1);
