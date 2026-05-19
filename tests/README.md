# Test fixtures — Taigan Bridge

Synthetic, fabricated documents for verifying the FBAR upload flow
end-to-end without exposing real account data.

**No fixture in this directory contains real names, real account
numbers, or real balances.** Bank brand names (ゆうちょ銀行, Wise,
Sony Bank) are real; everything else is invented for testing.

## Fixtures

| File | Format | Currency | Year(s) | Peak balance (native) | Peak USD | Threshold |
|---|---|---|---|---:|---:|---|
| [`fixtures/jp-passbook-sakura-2024.html`](fixtures/jp-passbook-sakura-2024.html) | Japanese passbook (通帳) — multi-year, 和暦 dates | JPY | 平成30年〜令和6年 (2018-2024) | ¥1,725,432 (令6.04.05) | ≈ $10,975 | 🟡 first crosses in 令和3年 (2021) |
| [`fixtures/wise-usd-statement-2024.html`](fixtures/wise-usd-statement-2024.html) | Wise USD statement | USD | 2024 | $14,820.41 | $14,820.41 | 🔴 well over |
| [`fixtures/sony-bank-dashboard-2024.html`](fixtures/sony-bank-dashboard-2024.html) | Online banking dashboard screenshot | JPY (also shows USD/EUR tabs) | 2024 | ¥5,142,800 (annual high) / ¥4,820,000 (snapshot) | ≈ $32,718 / ≈ $30,668 | 🔴 well over |

USD conversions use the v0.2.1 Treasury Year-End 2024 rate
(unverified placeholder, USD/JPY = 157.20).

## How to use

1. Build and open Taigan Bridge:
   ```bash
   npm install
   npm run build
   open dist/taigan-bridge.html
   ```
   Complete onboarding (or use existing state).

2. Open one of the fixture HTML files in a browser. Each one renders
   to look like the real document type.

3. Capture it as an image or PDF:
   - **Windows:** `Win + Shift + S` → drag the document area → save
     to disk
   - **macOS:** `Cmd + Shift + 4` → drag → saves to Desktop by default
   - **Either OS:** `Ctrl/Cmd + P` → "Save as PDF"
   - Both image and PDF formats are accepted by the upload feature.

4. In Taigan Bridge:
   - Settings → paste your Claude API key (`sk-ant-...`) → Save key.
   - FBAR Tracker → acknowledge the disclaimer → Filers tab → add a
     filer (e.g., yourself).
   - Accounts tab → click **⬆ Upload bank document** → select your
     captured image/PDF.
   - Read the consent modal → confirm → wait for extraction.
   - The new account card appears at the top of the Accounts list
     with a blue "AI-extracted from {filename}" banner.
   - Verify every field, edit anything wrong, then click **Mark
     verified**.
   - Switch to the Yearly Balances tab → confirm the auto-created
     balance row for 2024 looks right.
   - Switch to the Overview tab → verify the threshold heatmap
     reflects the new aggregate.

## Expected extraction (rough acceptance criteria)

For each fixture, a "good" extraction should populate:

### `jp-passbook-sakura-2024.html`

This fixture exercises **multi-year extraction with 和暦 dates**.

| Field | Expected |
|---|---|
| `institution_name` | "ゆうちょ銀行" or "Japan Post Bank" |
| `country` | `JP` |
| `currency` | `JPY` |
| `account_type` | `bank` |
| `account_number` | string containing `12340` and `67890123` |
| `account_holder_name` | `Sakura Suzuki` or similar |
| `account_holder_name_jp` | `鈴木 さくら` |
| `years_covered` | array with 7 entries: |

```
[
  { year: 2018, max_balance_native: ~420400,  max_balance_date: "2018-12-30" },
  { year: 2019, max_balance_native: ~575403,  max_balance_date: "2019-12-31" },
  { year: 2020, max_balance_native: ~720407,  max_balance_date: "2020-12-31" },
  { year: 2021, max_balance_native: ~1420414, max_balance_date: "2021-12-31" },
  { year: 2022, max_balance_native: ~1560422, max_balance_date: "2022-12-31" },
  { year: 2023, max_balance_native: ~1670422, max_balance_date: "2023-08-15" },
  { year: 2024, max_balance_native: ~1725432, max_balance_date: "2024-04-05" }
]
```

**Key checks:**
- All dates in extraction MUST be Western YYYY-MM-DD, not 和暦 strings.
- `令和元年` rows must convert to `2019` (not `2001` from a literal "令01" misread).
- `平成31年` (Jan-Apr 2019, before era change) must convert to `2019`, NOT to `1931` or `2031`.
- Balance peaks per year reflect the highest `差引残高` row visible in that year, not just the year-end balance.
- After upload, the FBAR Yearly Balances tab should show 7 rows (one per year). The Overview heatmap should show 2018-2020 in green and 2021-2024 in amber for 鈴木さくら.

### `wise-usd-statement-2024.html`

| Field | Expected |
|---|---|
| `institution_name` | "Wise" |
| `country` | `GB` (Wise Payments Ltd is UK) — `BE` or `IE` also defensible |
| `currency` | `USD` |
| `account_type` | `bank` |
| `account_number` | `8311 2204 6573 9912` (or stripped variant) |
| `account_holder_name` | `Alex Tanaka` |
| `year` | `2024` |
| `max_balance_native` | `14820.41` (March 8, 2024) |
| `max_balance_date` | `2024-03-08` |

### `sony-bank-dashboard-2024.html`

| Field | Expected |
|---|---|
| `institution_name` | "Sony Bank" or "ソニー銀行" |
| `country` | `JP` |
| `currency` | `JPY` (the active tab shown) |
| `account_type` | `bank` |
| `account_number` | contains `100` and `0123456789` |
| `account_holder_name` | `Alex Tanaka` |
| `account_holder_name_jp` | `アレックス タナカ` |
| `year` | `2024` |
| `max_balance_native` | `5142800` (the explicit "年中最高残高" / annual high) — **not** the current `4820000` |
| `max_balance_date` | `2024-08-22` |
| `extraction_notes` | should mention multi-currency tabs (JPY / USD / EUR) |

## What "good enough" looks like

Extraction is fuzzy by nature. Don't expect perfection. A passing
result is one where:

- **Institution, country, currency, account type are correct.** These
  drive the FBAR aggregate logic. If they're wrong, the threshold
  verdict will be wrong.
- **Max balance is within ±5% of the true peak** (or, ideally,
  exactly right when the source document explicitly labels the
  annual high — as the Sony Bank fixture does).
- **The model does NOT fabricate fields it cannot see.** A `null`
  or empty string is correct when a field is absent. Hallucinated
  values are a failure even if they look plausible.
- **The `confidence` field is calibrated.** A clear PDF should
  return `"high"`; a low-resolution screenshot of a noisy passbook
  should return `"low"`.

If extraction is consistently wrong on one field across multiple
fixtures, the `buildExtractionPrompt()` function in
[`src/scripts/ai-client.js`](../src/scripts/ai-client.js) is the
place to refine instructions.

## Privacy posture (fixture handling)

These fixtures are safe to commit to the repository — no real PII.
Real bank documents must NEVER end up in this directory. They
belong only in the user's own browser localStorage, transmitted
only via their own API key when they explicitly initiate an upload.

If you find yourself wanting to commit a real account scan for
debugging, **stop**, redact it, and replace identifying details
with fabricated ones — then commit the redacted version instead.
