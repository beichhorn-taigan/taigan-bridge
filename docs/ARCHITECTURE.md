# Architecture

## Single-file principle

Taigan Bridge ships as a single HTML file. There is no backend, no
build server, no telemetry, no accounts. The file opens from the
filesystem with `file://...` and runs the same as it does when served
over HTTP.

Development uses a multi-file source tree for editor ergonomics; the
build step inlines everything. See [BUILD.md](BUILD.md).

## Modular branching

The first run is an onboarding wizard (10 questions). The answers are
fed into `TB.tracks.assign(answers)`, a pure function that returns:

```js
{ tracks: ["sofa", "veteran", "family"], modules: ["profile", "fbar", ...] }
```

The dashboard then renders only the modules whose IDs are in the
`modules` array. Modules belonging to a track wear that track's
accent color via `data-track="<track-id>"` on their card root.

Tracks (and the answers that activate them):

| Track       | Activated when…                                                    |
|-------------|--------------------------------------------------------------------|
| `sofa`      | DoD active / civ / contractor AND (visa = SOFA OR 住民票 not yet). |
| `veteran`   | `veteran === 'yes'`.                                                |
| `resident`  | Japan tax resident, or 住民票 registered (and not SOFA), or 5+ yrs.|
| `family`    | JP-national spouse, JP children, or US-Japan dual-citizen children.|
| `property`  | Owns or expects to inherit Japanese real estate.                   |

The full source of truth is `src/scripts/tracks.js`. Add a new track
by extending `assign()` and adding a label to `trackLabel()`.

## State shape

A single localStorage entry under the key `taigan-bridge-state`:

```js
{
  version: 1,
  onboarding: { complete: bool, answers: {...}, completedAt: iso },
  tracks: ["sofa", "veteran", ...],
  modules: { unlocked: ["profile", "fbar", ...] },
  profile: { displayName: "", displayNameJa: "" },
  fbar: { filers: [...], accounts: [...], yearly_balances: [...], filing_history: [...] },
  assets: { accounts: [...] },
  sofa: { sequence: { confirmed: bool, steps: {...} } },
  veteran: { dd214Stored: bool, vaRating: number|null },
  documentVault: { items: [...] },
  family: { members: [...] },
  settings: {
    apiKey: "",                   // Claude API key, browser-only
    model: "claude-sonnet-4-20250514",
    language: "en"|"ja",
    lastExportAt: iso|null,
  },
}
```

`TB.state.get(path)` and `TB.state.set(path, value)` use dotted
paths. `TB.state.subscribe(fn)` returns an unsubscribe function.
`TB.state.export()` returns a JSON string; `TB.state.import(text)`
replaces the state (after running it through migration).

## Module interface

Every module attaches to `window.TB.modules[<id>]` with this shape:

```js
TB.modules['fbar'] = {
  id: 'fbar',
  label_en: 'FBAR Tracker',
  label_jp: 'FBAR トラッカー',
  render(container) {
    // Mount your UI inside `container`. The dashboard guarantees
    // `container.innerHTML = ''` is safe to run as the first line.
  },
};
```

The dashboard looks up the module by ID and calls `render(container)`.
Modules read and write state via `TB.state` directly. They MUST NOT
touch the global DOM outside their assigned container, and they
MUST NOT mutate state for modules they don't own.

## Globals (`window.TB`)

| Namespace      | Purpose                                              |
|----------------|------------------------------------------------------|
| `TB.state`     | localStorage-backed state with subscriptions.        |
| `TB.i18n`      | Translation: `t(key)`, `setLang`, `applyDom`.        |
| `TB.tracks`    | `assign(answers)`, `trackLabel(id, lang)`.           |
| `TB.onboarding`| `start(container, opts)`, `loadQuestions()`.         |
| `TB.ai`        | `callClaude(prompt, opts)`, `hasKey()`.              |
| `TB.utils`     | Formatters, `el()` DOM helper, FX rate stub.         |
| `TB.modules`   | Map of `{id: {render, ...}}`.                        |
| `TB.app`       | Boot + dashboard glue (defined inline in index.html).|

Vanilla JS, no module loader, no bundler. v0.1 is small enough that
this stays readable; if the script count grows past ~25 we'll
revisit ES modules.

## FBAR data model (v0.2.1+)

`state.fbar` uses normalized tables, not nested per-year structures:

```js
state.fbar = {
  filers: [          // household members who file (or might file)
    { id, name_en, name_jp, ssn_last4, dob,
      relationship: "self"|"spouse"|"child"|"dependent",
      isMinor: bool, isUSPerson: bool,
      filing_address: "", notes: "" }
  ],
  accounts: [        // foreign financial accounts
    { id, filer_ids: [uuid, ...],
      account_type: "bank"|"securities"|"other",
      institution_name, institution_address,
      account_number_full,            // displayed as ****1234 by default
      currency: "JPY", country: "JP",
      opened_year: 2018, closed_year: null,
      signatory_only: bool, notes: "" }
  ],
  yearly_balances: [ // one row per (account_id, year)
    { id, account_id, year: "2024",
      max_balance_native: 1500000, max_balance_date: "2024-08-15",
      fx_rate_used: 151.39, fx_rate_source: "Treasury Year-End 2024 (UNVERIFIED)",
      fx_rate_overridden: false,
      max_balance_usd: 9908.18,       // = native / fx_rate_used
      notes: "" }
  ],
  filing_history: [  // confirmation of past filings (free-form)
    { id, filer_id, year, filed_on, bsa_id, method: "self"|"preparer", notes }
  ]
}
```

The shape change happened in `CURRENT_VERSION = 2`. The migration in
`state.js` resets `state.fbar` to the new defaults if a v1 store is
detected; the prior year-keyed shape only existed for ~3 days in dev.

## FBAR threshold logic

`TB.fbar.thresholdStatus(filerId, year)` is a pure function. It
returns:

```js
{
  aggregate_usd: number,
  threshold: 10000,
  status: "under" | "at_or_over" | "insufficient_data" | "not_us_person" | "no_filer",
  contributing_accounts: [accountId, ...],
  warnings: [string, ...]
}
```

Rules:

- Aggregate sums `max_balance_usd` across every account where
  `filer.id ∈ account.filer_ids`, regardless of joint status. Joint
  accounts contribute the FULL value to each US-person joint owner
  (FBAR rule, not divided shares).
- Accounts with `country === 'US'` are tracked but excluded from
  the FBAR aggregate.
- Filers with `isUSPerson: false` get `status: "not_us_person"` and
  `aggregate_usd: 0` — they don't have an FBAR obligation.
- If any active account is missing a balance entry for the year,
  the result is `"insufficient_data"` UNLESS the partial sum
  already exceeds threshold (in which case the verdict is locked
  in regardless of missing data).
- `signatory_only: true` accounts still count toward the filer's
  threshold (FBAR triggers on signature authority alone).

## FBAR FX rates

`TB.fbar.TREASURY_FX` is a hardcoded, **UNVERIFIED** placeholder
table covering 2019-2024 × 14 currencies (JPY, EUR, GBP, CAD, AUD,
CHF, SGD, HKD, KRW, CNY, NZD, THB, MXN, BRL). The Yearly Balances
view auto-fills the FX rate from this table when entering a balance,
labels the source as `"Treasury Year-End YYYY (UNVERIFIED)"`, and
the user can override per-balance with their own documented rate.
A persistent yellow banner on the FBAR module surfaces the
verification requirement.

`TODO(v0.x)`: replace with a real fetch from
`https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange`,
gated behind an explicit "Refresh from Treasury" button (offline-by-
default principle).

## FBAR ↔ AI integration: hard sanitizer

`TB.ai.callClaudeWithFbarContext(prompt, options)` automatically
prepends a system message containing only
`TB.fbar.summarizeFbarForAi()` — category counts (account types,
countries, currencies, filer counts, threshold-met counts per year).

Account numbers, balances, names, dates, and addresses **never**
leave the browser via the AI client. There is no opt-in to send raw
FBAR data; future features that need it must build their own
per-call confirmation UI.

## Liability layering

1. Persistent banner (always-on, top of the viewport).
2. Generic disclaimer modal on first view of any planning module.
3. Triple-confirmation modal before SOFA Roth Sequencing Planner
   produces any output.
4. Footer attribution + license link on every render.

The strings live in `src/content/disclaimers.md` so legal-sensitive
language has a single source of truth and isn't scattered across
JS files.
