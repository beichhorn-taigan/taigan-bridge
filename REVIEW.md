# Taigan Bridge — Deep-Dive Code Review

**Date:** 2026-07-06 · **Version reviewed:** 1.0.3 (working tree, uncommitted changes included) · **Method:** full-codebase review by seven parallel review passes (core runtime; security/network; financial/tax modules; health tracker; feature modules ×2; build/tools/tests/docs), findings verified against source before inclusion.

---

## Snapshot

Single-file HTML financial organizer (~77k lines of source) for Americans in Japan. Vanilla JS, no bundler; `build.js` inlines `src/` into `dist/taigan-bridge.html`. State lives in one localStorage key with versioned migrations (`CURRENT_VERSION = 4`); 23 feature modules register on `window.TB.modules`; BYO Claude API key.

**What's genuinely good** (worth saying before the findings):

- **XSS surface is effectively closed.** All rendering goes through a text-node-safe `el()` helper; the few HTML-string builders (`sharing-backup.js`, `assets.js` survivor binder, `fbar.js`) consistently `escapeHtml()` every user field. No `eval`/`insertAdjacentHTML`/`document.write` anywhere. AI responses render as text nodes — no prompt-injection→XSS chain.
- **The FBAR sanitizer claim is true.** `summarizeFbarForAi()` really sends only category counts; the core `thresholdStatus()` engine implements all four documented FBAR rules exactly.
- **State discipline is clean across all modules** — clone→mutate→`set()`, no listener/subscription leaks found, deep-cloned reads prevent aliasing.
- i18n key parity is literally 3825/3825 en/ja; the CLAIM-LEDGER discipline is real and being followed; dependency surface is one dev-dep with zero audit findings.

**The dominant failure patterns**, accounting for most findings below:

1. **Contract drift** — code reading state paths/field names/wrapper IDs that no longer exist (or never did), failing silently behind `try/catch`. Kills search, contacts auto-derivation, module unlocking, and several heuristics.
2. **Duplicated logic diverging** — FBAR aggregation reimplemented (wrongly) in tax-coordinator; SS scaling differs between projections and decumulation; "today" computed three different ways.
3. **UTC vs JST** — `new Date().toISOString().slice(0,10)` and local-midnight→`toISOString()` round-trips shift dates one day for the app's entire user base (UTC+9), at ~25 call sites.
4. **Bilingual chrome, English guts** — UI keys are fully localized, but generated content (Action Center items, wizard results, reference prose) is hardcoded English.
5. **No safety net** — zero wired tests, no CI build, release-by-hand (currently in a broken state).

---

## CRITICAL

**C1. Tax Coordinator tells over-threshold users "FBAR — Not currently required."**
`src/scripts/modules/tax-coordinator.js:467-471` — `computeFbarAggregateUsd()` compares string years against a `Math.max`-coerced number with strict `!==`, so every balance row is skipped and the aggregate is always $0. A user with ¥20M of recorded balances sees "○ Not currently required" in the Forms Assessment, and FBAR calendar deadlines are suppressed. (Same function also fails to exclude `country === 'US'` accounts and sums household-wide.)
*Fix:* delete this re-implementation and call `TB.fbar.thresholdStatus()` / a shared aggregate helper; at minimum `String(b.year) !== String(latest)`.

**C2. FBAR Yearly Balances verdict card crashes on any real data — `formatNative` is undefined.**
`src/scripts/modules/fbar.js:4488` — `formatNative(native, account.currency)` exists nowhere in the repo. `buildFilerBreakdown` throws for any account with a balance in the active year, so the aggregate/threshold card on the Balances tab never renders, and `refreshAggregateCard` clears then throws on every keystroke, leaving it blank.
*Fix:* define it (or use the existing native-currency formatter used elsewhere in fbar.js).

**C3. FX calculator's JPY→USD math pays the user the spread — the worst platform wins.**
`src/scripts/modules/fx-banking.js:229` divides by a *reduced* rate (`midRate * (1 - bps/10000)`), yielding **more** USD than mid-market; `total_cost_jpy` goes negative and the delivered-descending sort (line 1146) crowns the highest-spread bank 🏆 best. Compounding it, the platform filter at `:1143` ignores the selected direction, so JPY→USD mode includes USD→JPY-only platforms.
*Fix:* divide by `midRate * (1 + bps/10000)` in the JPY→USD branch; filter platforms by the actual selected direction.

**C4. Backup restore irreversibly replaces the entire state with any parseable JSON — no validation, no confirmation, no undo.**
`src/scripts/state.js:1196-1203` (`importJson` = parse → migrate → persist; `migrate` at `:1012` even lets JSON **arrays** through), called with no confirm from `modules/settings.js:1858-1868` (which also has drag-drop on the whole card), `modules/profile.js:764`, `modules/sharing-backup.js:940`. Dropping the wrong file (advisor-subset JSON, truncated file, `{"version":4}`) silently wipes years of FBAR/asset/tax data. The Danger Zone requires typed `DELETE` for the same outcome.
*Fix:* validate shape (object, known top-level keys), show a confirm with a diff summary, and auto-write the pre-import state to a second localStorage key first.

**C5. The full backup file contains the live Claude API key in plaintext alongside all PII — and users are told to store it off-device.**
`src/scripts/state.js:1192-1194` exports the whole tree including `settings.apiKey`; `modules/sharing-backup.js:918-921, 1131` writes it to `taigan-bridge-backup-<date>.json`, the auto-backup cadence (wired at `index.html:1171`) prompts for it regularly, and the UI copy says "store it where you keep your other important records." One backup synced to Drive/email = billable-key theft + full financial/health/PII disclosure. (Advisor/survivor exports correctly whitelist fields — only the full backup leaks.)
*Fix:* strip `settings.apiKey` (and `settings.api.*`) from exports and prompt to re-enter after restore; or encrypt the backup with a passphrase.

**C6. The update checker is an integrity-free remote-code channel into an app holding an API key.**
`src/scripts/update-check.js:131-175` injects `<script src="https://cdn.jsdelivr.net/gh/...@latest/version.js">` with no SRI, signature, or pinning; the `payload.schema` check runs *after* the remote file has executed. Anyone who can influence that response (repo/release compromise, CDN account, MITM) executes arbitrary JS that can read the API key and the entire state, re-fired every 24h. Consent-gated, which mitigates — but consenting users carry a persistent supply-chain risk. Secondary: the banner renders `payload.url` into an `href` unvalidated (`:194-208`).
*Fix:* switch to `fetch()` + `JSON.parse` where possible (hosted context), or validate a detached signature over the payload before use; validate `url` is `https://github.com/...`.

---

## HIGH

**H1. Family and Resident modules can never auto-appear on the dashboard.**
`src/scripts/tracks.js:87-92` (and `:81-85`) add the *tracks* but never `modules.add('family')` / `modules.add('resident')`; boot re-derives and overwrites `modules.unlocked` every launch (`index.html:1070-1076`), so it can't be healed by hand.
*Fix:* add the two `modules.add()` calls in `tracks.assign()`.

**H2. Social Security benefit overstated ~24% in every projection.**
`src/scripts/modules/projections.js:847` multiplies the user's *age-70* benefit input by an FRA-relative multiplier (1.24 at 70). Default inputs pay $5,952/mo on a $4,800 input. `decumulation.js:437` does it correctly (divides by 1.24), confirming intended semantics. Skews depletion age and the Roth ladder optimizer.
*Fix:* `baseBenefit = input * 12 * ssBenefitMultiplier(start_age) / ssBenefitMultiplier(70)`.

**H3. Date/timezone defect class: "today" is computed in UTC and computed dates round-trip through UTC — everything shifts a day for JST users.**
The two idioms: `new Date().toISOString().slice(0,10)` ("today" = yesterday until 09:00 JST) and `new Date(local midnight) → .toISOString().slice(0,10)` (renders the day before). Verified sites include:
- Deadlines *displayed one day early*: tax-coordinator.js:972/2072/1980 (April 15 prints 04-14), resident.js:718/1046, family.js:323 (nationality-choice date), action-center.js:837.
- Alerts that *vanish on the deadline day*: resident.js:1032 (確定申告), resident.js:1110 (ふるさと納税), family.js:1539 (year-end gifts) — deadline modeled as 00:00 instead of end-of-day.
- Records *backdated*: health-tracker.js:5238 (med refill), :5266, :3327 and ~17 more; consultations.js:553; fbar.js:4832 (`filed_on`); settings.js:1370 (top-ups); assets/net-worth `updated_at`/snapshot labels.
- Money display: settings.js:182/187/247 usage dashboard uses UTC day/month keys while `ai-client.js:99` records under local keys — today's AI spend invisible until 09:00, MTD wrong on the 1st.
- Invalid output: action-center.js:941 — .ics `DTEND == DTSTART` (RFC 5545 violation) for every JST user.
*Fix:* one shared `TB.utils.localIsoDate()` + end-of-day deadline comparisons; sweep all `toISOString().slice(0,10)` call sites; make settings.js use `TB.ai.todayKey()`.

**H4. The FBAR filing reminder — the app's most compliance-critical action — goes silent after May 1.**
`src/scripts/modules/action-center.js:68-70` — `if (month > 4) return out;` even when no filing is logged, while the body text itself explains the Oct 15 auto-extension.
*Fix:* keep the action alive (re-labeled for the extension window) through Oct 15, and after that until filed.

**H5. Search is broken two ways: most records are never indexed, and Enter can open the wrong result.**
`src/scripts/search.js:172-329` — 6 of 9 record indexers read state paths that don't exist (`fbar.years`, `m.name`/`citizenship`, `documents`/`d.expires`, `family.gifts`, `net_worth.snapshots`, `consultations.log`) — FBAR accounts, family members, vault docs, gifts, snapshots, consultations never appear in ⌘K. And `:734` — rows render regrouped by kind while selection resolves against the score-sorted array, so Enter/click can open a different result than the one highlighted.
*Fix:* point the indexers at the real schema (`fbar.accounts`/`yearly_balances`, `name_en/name_jp`, `documentVault.items`, `family.gifts_log`, `assets.snapshots`, `consultations.*`); build `_currentResults` in display order.

**H6. The release pipeline is currently broken in production.**
v1.0.3 was committed (`0ef073a`) but **never tagged** (`git tag -l` ends at v1.0.2), so jsDelivr `@latest` still serves `stable: "1.0.2"` — no install is told v1.0.3 exists, three weeks on. Meanwhile the working tree holds uncommitted release content (2025 Treasury FX corrections, IRMAA 2026, §877A in `constants.js`/`glossary.js`/`i18n.js`) already described by the committed 1.0.3 changelog — tagging as-is ships a tag that doesn't contain its own release notes' fixes. `build.js:38-42` compounds this: every dev build dirties the committed `version.js` with a new random `buildHash`.
*Fix:* commit the pending fixes, tag v1.0.3, push the tag; add a release script/checklist that enforces commit→tag; make `buildHash` deterministic (e.g., git SHA) or stop regenerating `version.js` on non-release builds.

**H7. The README's headline privacy claims are contradicted by the shipped file.**
README.md:177-187 says "no fonts loaded from a CDN — search the file and there is nothing to find" and "Zero outbound traffic at boot." But `src/styles/tokens.css:8` `@import`s Google Fonts (verified present in `dist/taigan-bridge.html`), and `index.html:1182` calls `refreshLiveFx()` on every boot, fetching from up to three third-party CDNs unconditionally (`utils.js:313-366`) — chosen specifically for `file://`-friendly CORS. `docs/BUILD.md:30-31` even admits the fonts exception. For a privacy-positioned financial tool, this is the most damaging doc-vs-reality gap.
*Fix:* self-host/subset the font (or drop the import) and gate the FX fetch behind the existing consent mechanism — or rewrite the claims to match reality.

**H8. Stored FBAR USD conversions are never recomputed when official Treasury rates arrive, yet render with a Treasury label.**
`src/scripts/modules/fbar.js:4197-4212` freezes `fx_rate_used`/`max_balance_usd` at entry time; `refreshTreasuryRates` (:659-686) updates only the rates cache; the source cell (:4296-4301) shows "Treasury Year-End {year}" whenever any auto rate exists — even when the stored number came from the approximate offline fallback. Near-threshold verdicts can be wrong in either direction under an official-looking label.
*Fix:* on rate refresh, recompute rows whose `fx_rate_overridden` is false; label from the row's actual `fx_rate_source`.

**H9. Negative balances subtract from the FBAR aggregate.**
`src/scripts/modules/fbar.js:4237-4243` — `min: '0'` on the input but `parseFloat` stored unvalidated; `thresholdStatus` just sums, so a stray minus sign can flip "at_or_over" → "under."
*Fix:* clamp/reject negatives in `recomputeAndSave` (guard `native >= 0` next to the existing `rate > 0`).

**H10. Rate alerts promise the live rate but evaluate a stale one.**
`src/scripts/modules/fx-banking.js:1602-1606, 1781-1785` evaluate against `currentJpyPerUsd()` (Treasury snapshot, up to 7 days old, or a built-in 150 fallback) while the UI copy says "when the **live** USD/JPY rate crosses this value." An alert for >160 stays silent while the market sits at 162. Related half-finished wiring: `alert.active` is never checked and `last_triggered_at` never written (:1649), so alerts can't be paused and nag forever.
*Fix:* evaluate against `settings.fx.live_jpy` when fresh (falling back with an explicit "stale rate" caveat); honor `active`; write `last_triggered_at` for crossing dedup.

**H11. AI-imported medications fabricate a dosage unit — "75 mcg" can display as "75mg".**
`src/scripts/modules/health-tracker.js:3324` — `dosage_unit: m.dosage_unit || 'mg'` when extraction omits the unit (a 1000× display error for mcg meds); `:3326` also hardcodes `route: 'oral'`.
*Fix:* default to empty/unknown and visually flag "unit not detected — verify" instead of inventing one.

**H12. Every "Open module" button in the full Action Center renders a raw i18n key — "Open nav.fbar →".**
`src/scripts/modules/action-center.js:691, 723` — `t('nav.' + action.module)` for keys that don't exist; `t()` returns the key itself so the `||` fallback is unreachable.
*Fix:* use the module registry's `label_en/label_jp` (or add the `nav.*` keys).

**H13. Contacts module: both auto-derivation sources are dead, and the edit modal loses data.**
`src/scripts/modules/contacts.js:271-272` reads `m.name`/`m.display_name` — family stores `name_en`/`name_jp`, so family contacts never appear. `:294-297` reads `consultations.entries` — real state is `consultations.professionals`/`consultations`, so professionals never appear. `:1117-1123` sets textarea values via `setAttribute` (a no-op), so Address/Notes render blank on every edit. `:798-804` shows the edit pencil on auto-derived contacts but Save doesn't set `linked_source`, creating permanent duplicates. `:729-734` rebuilds the view on every debounced keystroke, destroying search-field focus.
*Fix:* point readers at the real schema; set textarea content as a child text node (as consultations.js does); set `linked_source` on edit-promote; re-render only the results list on search input.

**H14. Assets "Beneficiary Review" card passes an object where an ID is expected — edit opens a blank modal; Save creates a blank duplicate; Delete silently no-ops.**
`src/scripts/modules/assets.js:1472` — `openEditModal(a)` vs the correct `openEditModal(a.id)` at `:1896`.
*Fix:* pass `a.id`.

**H15. Tax-loss-harvest scanner uses wrapper IDs that don't exist — it can advise harvesting inside an IRA.**
`src/scripts/modules/assets.js:1213` — exclusion set has `ira_traditional`/`k401_traditional`/… but the taxonomy is `traditional_ira`/`roth_ira`/`traditional_401k_tsp`/`roth_401k` (:38-41), so sheltered accounts are never excluded.
*Fix:* use the real `WRAPPERS` IDs (reference the constant, don't retype strings).

**H16. Net-worth wizard's "stale balances" step checks a field that is never written — every account is always stale.**
`src/scripts/modules/net-worth.js:852` — `a.balance_updated_at` doesn't exist anywhere; the schema field is `updated_at`. The year-end checkup permanently reports "12 of 12 accounts have stale balances."
*Fix:* read `a.updated_at`.

**H17. §121 home-sale exclusion defaults to "eligible" for an audience that has, by definition, moved to Japan.**
`src/scripts/modules/property.js:229-237` — when `lived_2_of_5_years` is unset, eligibility is inferred from *ownership length alone*; the card shows "✓ eligible — $250,000/$500,000" for users whose 2-of-5 **use** test has likely lapsed.
*Fix:* unknown → "verify the use test" warning state, never a green check.

**H18. There is no automated verification at all around 77k lines of financial logic.**
No `test` script (`package.json:8-12`), no CI build (the only workflow deploys a redirect page — `.github/workflows/deploy-pages.yml`), and the single test file `tools/test-threshold.js` tests a **re-implementation** of the threshold rules, not the shipped `fbar.js` code (its own header admits they can drift). C1, C2, H1, H5, H13–H16 are all bugs a thin test layer would have caught mechanically.
*Fix:* wire a `test` script; test the real `thresholdStatus`/`fxRateFor` via a TB shim; add a CI job that runs `node build.js`, asserts every `src/scripts` file appears as `data-source` in the dist, and runs the tests. Top-5 highest-value test targets: `fbar.thresholdStatus`+`fxRateFor`; `state.js` migrations + `importJson`; `estate.deriveStatutoryHeirs`; `projections.js` tax functions (`computeNiit`, `irmaaSurcharge`, `computeUsTax`, `computeJpTax`); `tracks.assign`.

---

## MEDIUM

### Compliance / financial correctness
- **M1.** FBAR carry-forward rows copy the prior year's *peak* (not year-end balance), asserting "FBAR REQUIRED" for dormant accounts that were drained — `fbar.js:3078-3105, 3962-4019`. *Fix:* carry forward as "needs verification," not as a verdict input.
- **M2.** Failed Treasury fetches stamp `treasury_fetched_at` anyway: no retry for 7 days, "Live Treasury rates · last fetched {today}" shown while using offline fallback, manual Refresh reports silent success offline — `fbar.js:682-703, 6109-6133`. *Fix:* only stamp on ≥1 success; surface per-year failures.
- **M3.** Roth ladder "lifetime savings" card always shows +$0 — baseline save/restore uses the wrong state key and passes the same `inputs` object to both runs — `projections.js:3960-3967`. *Fix:* clone inputs with `roth_conversions: []` for the baseline.
- **M4.** RMD age hardcoded at 73; the app's own ledger records SECURE 2.0's rise to 75 (turning 73 after 2032) — `projections.js:894, 3747`; `decumulation.js:414-421`. *Fix:* compute statutory age from birth year via a constants helper.
- **M5.** Decumulation FRA fallback divides by 1.24 regardless of chosen age — a claim-at-62 estimate understates ~44% — `decumulation.js:435-437`. *Fix:* divide by the multiplier for the age the estimate is stated at.
- **M6.** Constants drift: `TB.constants.FEIE`, `FBAR_NONWILLFUL_MAX`, `FBAR_WILLFUL_MIN` exist but nothing reads them; FEIE hardcoded stale as "$126,500 (2024)" (`tax-coordinator.js:69-70, 1323`); estate Letter of Instruction hardcodes 2025's "$13.99M" (`estate.js:1649`) while `estate.js:95-96` defines the right values unused; penalty figures hand-copied in i18n.js:608, action-center.js:87, fx-banking.js:1770. *Fix:* wire the constants through; ledger should audit *wiring*, not just values.
- **M7.** Estate Action Center still recommends 教育資金一括贈与, which closed to new contributions 2026-03-31 per the app's own constants — `estate.js:1885`. *Fix:* gate on `GIFT_SUNSET`.
- **M8.** 小規模宅地 estimate applies a full 80% reduction on an assumed 50% of JP value with no 330㎡ cap (anti-conservative); the 7-year clawback ignores the 2024-reform phase-in — `estate.js:349-354, 292-299`. *Fix:* surface the assumption in the UI and lean conservative.
- **M9.** SOFA sequence history silently destroyed: `deriveSequence()` (a render-path "pure" function) rewrites `sofa.steps` with only currently-emitted steps, dropping executed records when triggers lapse — `sofa-roth.js:389`. *Fix:* merge-preserve executed/dismissed steps; never write state in render.
- **M10.** Net-worth wizard's FBAR step renders a ✓/✗ verdict from *current* balances at *current* rates; the real test is per-account year-*max* at Treasury *year-end* rates — `net-worth.js:886-898`. *Fix:* call `TB.fbar.thresholdStatus` or label it explicitly as a rough proxy.
- **M11.** Resident 10-year 相続税 clock models "10 years since arrival," not the statutory "more than 10 of the past 15 years" (prior stints ignored) — `resident.js:184-193`; and `:1066` suppresses the warning for PR holders with a comment admitting that's wrong. `:74-78` mortgage-credit caps predate the 2024 rules (uncertified new construction gets ¥0, not ¥30M). *Fix:* model 10-of-15 with prior-residence input; remove the PR suppression; update caps.
- **M12.** Family gift log promises 7-year clawback computation (section registry text) but none exists; totals aggregate across all recipients/vehicles so the ¥1.1M-per-recipient cap is never checked — `family.js:419, 1087-1105`. *Fix:* per-recipient-per-year rollup + cap flag, or drop the promise.
- **M13.** FX/FBAR transfer callout renders a green "drops you back below the threshold" for a *peak-based* aggregate that can never decrease — `fx-banking.js:1057-1077`. *Fix:* suppress the success state when `source === 'fbar_peak'`.
- **M14.** `applyExtraction` never applies the AI-extracted country (new drafts default `country:'US'`, which is truthy) — a scanned 通帳 stays "US," excluding it from FBAR aggregates — `assets.js:2150` (the bulk path at `:2213` is correct). *Fix:* compare against the *user-touched* flag, not truthiness.
- **M15.** "Detach from FBAR" persists the whole in-progress edit draft without Save's normalization — typo'd balances silently committed — `assets.js:2623-2630`. *Fix:* detach should mutate only the link fields on the stored record.
- **M16.** `takeSnapshot` happily stores $0 snapshots for empty portfolios (net-worth chart dives to zero); net-worth.js's guard for exactly this is dead because the function never returns falsy — `assets.js:977-1010`; `net-worth.js:838-840`. *Fix:* return null on zero active accounts.
- **M17.** Year-end report generated in January is titled/logged for the *new* year, so the "report not yet generated" nag never clears — `net-worth.js:1188 vs :1533`. *Fix:* use the same target-year logic in both.
- **M18.** Action Center reads `projections.startYear`, which projections.js never writes — user age is frozen at its onboarding value forever, so quarterly-tax/RMD/SS-window reminders drift or never fire — `action-center.js:240`. *Fix:* write `startYear` from projections, or derive age from a birth-year field.
- **M19.** Credits reconcile math mixes a UTC boundary date with local day keys and uses `>` (excludes same-day spend) — remaining-credit over/understated depending on reconcile time — `settings.js:1337`; `ai-client.js:544-548`. *Fix:* timestamp-based boundary, single day-key helper.

### Data safety / robustness
- **M20.** `persist()` swallows localStorage failures (quota, Safari private mode) with only a console.error — edits appear saved, all work vanishes on reload — `state.js:1140-1146`. *Fix:* surface a persistent banner on write failure.
- **M21.** Corrupt stored state is discarded to defaults and then overwritten on first `set()` — no salvage copy, no UI notice — `state.js:1127-1138`. *Fix:* copy the raw string to `taigan-bridge-state-corrupt` before proceeding.
- **M22.** `deepMerge` lets stored arrays and `null`s clobber structured defaults — schema growth inside arrays never heals; an advisor-subset import with `"tax_coordinator": null` leaves it null — `state.js:1000-1009`. *Fix:* treat `null` patches as "use default"; consider per-migration array upgrades.
- **M23.** Single-question onboarding edit force-marks onboarding complete (`complete: get(...) || true` is always true) — `onboarding.js:303`. *Fix:* `get('onboarding.complete') === true`.
- **M24.** Boot deadlock with no UI if onboarding content is missing: unhandled async rejection leaves "Loading…" forever — `index.html:895-899`; `onboarding.js:58-62`. *Fix:* `.catch` → visible error state.
- **M25.** No CSP anywhere (`index.html`, hence dist). A `<meta http-equiv>` CSP (`connect-src` allowlist, `script-src 'self' 'unsafe-inline'`) would blunt C6 and cap any future injection. *Fix:* add one to `src/index.html`.
- **M26.** Full plaintext API key written into a DOM `value` attribute (visible in Inspect Element, saved pages, DOM-serializing extensions) — `settings.js:1032`. *Fix:* set `.value` as a property post-creation, not via `setAttribute`.
- **M27.** Re-importing the same lab PDF and choosing "merge" duplicates every lab row, doubling trend charts — `health-tracker.js:3555`. *Fix:* dedup on (test, date, value).
- **M28.** Episode cost silently drops invoices whose USD conversion was unavailable at entry (`amount_usd_calc` null contributes $0 while counting in `count`) — `health-tracker.js:2543-2556`. *Fix:* recompute at read time or show "N invoices unconverted."
- **M29.** `computeAge` uses year subtraction only (overstates age before the birthday → screening nags fire up to a year early) and disagrees with healthcare.js's correct DOB math — `health-tracker.js:2796-2808`. *Fix:* one shared age helper.
- **M30.** Consultations follow-up reminders *vanish* once >365 days overdue instead of escalating — `consultations.js:709-710`. *Fix:* drop the upper bound.
- **M31.** Contacts auto-IDs strip all non-ASCII, so two Japanese-named institutions collide (`auto-assets--jp`) and dedup/enhance misbehaves — for a Japan-focused app — `contacts.js:92, 252`. *Fix:* hash the raw name instead of slugifying.
- **M32.** `enhanceContact` spends a paid Claude call before checking the built-in guard, then discards the result — `contacts.js:936-968`. *Fix:* check first.

### Docs / build
- **M33.** ARCHITECTURE.md materially stale: `version: 1` vs actual 4, dead `sofa.sequence` shape, wrong default model, documents a nonexistent `TB.app`, "10 questions" vs 24, veteran-track rule wrong (FBAR/FX sections are accurate) — `docs/ARCHITECTURE.md:15-102`. *Fix:* refresh or mark historical.
- **M34.** ROADMAP.md says "v0.1 (current)" at v1.0.3 and lists obfuscation + Gumroad as v1.0 deliverables (neither exists); BUILD.md's "Gumroad, required email collection" contradicts README's "No email collection" — `docs/ROADMAP.md:8, 59-65`; `docs/BUILD.md:62-68`. *Fix:* update both.
- **M35.** build.js silent-failure modes (all verified by execution): script tags with whitespace before `</script>` are silently *not inlined* (`:72`); `stampMetadata` requires `name=` first or ships version 0.1.0 (`:130-135`); the visible-stamp regex rewrites JS string literals (two `data-version` spans in the current dist prove it) (`:138-143`). *Fix:* tolerant regexes + a post-build assertion that every src script appears as `data-source` (also catches the first bug forever).
- **M36.** Ask Taigan sends extensive raw PII (family names/ages, VA rating, meds/diagnoses, emergency contacts) to the API — by design, consent-gated, first-party — but ARCHITECTURE.md's sanitizer section implies a stricter posture than the chat path has. *Fix:* document the two tiers explicitly.

---

## NICE-TO-HAVE / LOW

**Dead code & never-wired features** (safe deletions or finish-the-feature):
- `TB.state.subscribe` has zero call sites (notify machinery runs for nothing) — `state.js:1187`; `TB.utils.getFxRate` unused — `utils.js:149`.
- `fx-banking.js`: alert edit modal unreachable (:1593), `preferences.primary_platform`/`show_all_platforms` never read; `t(...) || default_rec` fallback dead (:1550, `t()` returns the key).
- `property.js`: depreciation/planned-sale fields collected but never computed (:50-57, 654); `JP_ACQUISITION_TAX` exported, unused; `usdToJpy`/`getPrefs` dead; `totalGross` accumulated, never rendered (:814).
- `veteran.js`: `dd214Stored`/`vaRating`/`notes` schema never touched; `fbar.js:1336` `editFiler` dead; `action-center.js:58` `fmtUSD` dead; contacts reads never-written `support_*` fields (:98); consultations' customize integration is structurally inert (:216-227); health-tracker `getPrefs`/`units` pref dead (imperial support promised, absent); vestigial empty `listenerSet` block — `health-tracker.js:3663`.
- `TB.utils.FX_FALLBACK.JPY` guard in fx-banking.js:428 is always undefined (tier-4 fallback dead); property.js hardcodes `/150` vs the shipped 152.

**i18n polish** (beyond the Medium-class generated-content gap):
- All 157 glossary entries English-only in the JA UI — `glossary.js` (the single biggest JA-experience gap; consider at least the top-20 terms).
- Cross-cutting hardcoded English in generated content: Action Center titles/bodies in ~8 modules, net-worth wizard results (stored permanently into history!), veteran `BENEFITS_BY_STATUS` guide, family `EDU_VEHICLES` prose, fx `PLATFORMS` pros/cons, .ics summaries, various alerts. One sweep with `t()` keys.
- Duplicate i18n key `family.renunciation.target_year` (`i18n.js:2460, 6776`); live-FX age strings, dropzone/print fallbacks hardcoded (`index.html:1208`; `utils.js:514, 1061`); `'(untitled)'` localized in one of four places (`family.js:804`).

**Small correctness / UX:**
- Negative deltas render "$-1,234" — `net-worth.js:283`; credit progress bar unclamped below 0 — `settings.js:1292`.
- Space key on dashboard tiles scrolls the page (`index.html:601` missing `preventDefault`).
- `Date.now().toString(36)` IDs without a random suffix collide in-millisecond — `health-tracker.js:3213`; `family.js:1146`.
- CSV export lacks a spreadsheet formula-injection guard (`=HYPERLINK` in an extracted lab name goes live in Excel) — `health-tracker.js:11814`.
- Manually typed rate equal to the auto rate gets labeled "(UNVERIFIED)" and print footer *always* claims placeholder rates — `fbar.js:4266, 6445`.
- PFIC `'fund'` substring false-positives ("refund", "Fundrise") — `tax-coordinator.js:489`; `net-worth.js:864` (which also scans inactive accounts).
- `juminhyou` typo — CPA briefing always prints 住民票 "(not specified)" — `tax-coordinator.js:1910`.
- Glossary buttons nest inside `<ruby>` elements (screen-reader/styling fragility) — `glossary.js:1249`; search highlight misaligns on full-width chars — `search.js:842`; escClose listener leak pattern — `about-overlays.js:101`.
- Onboarding name-clear never clears (`onboarding.js:452`); profile theme toggle doesn't re-render (:707); 0%-rate mortgages skip payment entirely — `property.js:1043`; `fmtNative` shows `$` for EUR/GBP (:195).
- Stale prose: WEP/GPO "repealed late 2024" vs own ledger (`decumulation.js:1317`), VGLI "120-day" header vs 240/485 code (`veteran.js:12`), "2024 rates" VA tables (:170), sofa-roth deadline comment inverted (:150), assets.js "Phase 2 deferred" header for shipped features, LICENSE.md still names taiganbridge.com, CHANGELOG 1.0.3 date mismatch.
- `package.json`: no `engines` field; `build:obfuscate` is an `exit 0` stub; `tools/obfuscate.config.js` is config for a pipeline that doesn't exist — delete or build it.

**Structural (recommended, not urgent):**
- **Split health-tracker.js (12,215 lines, 16% of the codebase).** Natural fault lines already exist: LAB_INFO/LAB_CANONICAL reference data (~1,150 lines) → pure data file; the dental tab (~2,000 lines) → own module; the AI extraction/merge pipeline (~2,500 lines) → shared service. ~3,000 lines removable at near-zero risk.
- **One FBAR aggregation source of truth.** fbar.js, tax-coordinator.js, net-worth.js, and fx-banking.js each compute "the aggregate" differently; C1, M10, M13 are all symptoms.
- **Shared schema constants** for state paths and wrapper/vehicle IDs — H5, H13, H15, H16, M18 are all the same retyped-string disease; a 50-line path-assertion test would catch every future case.

---

## Suggested fix order

1. **Compliance-verdict batch** (an afternoon, high stakes): C1, C2, H9, H4, H8-label, M13 — everything that shows a wrong FBAR answer.
2. **Money-math batch:** C3, H2, M3, M5 — wrong numbers steering real decisions.
3. **Data-safety batch:** C4 (validate + confirm + pre-import backup), C5 (strip key from exports), M20/M21.
4. **Release hygiene** (30 minutes, currently live-broken): commit the pending constants fixes, tag v1.0.3, push; then H18's CI smoke job so this can't recur silently.
5. **Supply chain:** C6 + M25 (CSP).
6. **The date helper sweep:** H3 — one `localIsoDate()` + end-of-day deadline semantics fixes ~25 sites and three "alert vanishes on deadline day" bugs.
7. **Contract-drift sweep:** H1, H5, H13, H15, H16, M18 + the path-assertion test that prevents recurrence.
8. **Truth-in-docs:** H7 (fonts/boot-fetch vs README), M33/M34.
9. Then the i18n generated-content sweep and the health-tracker split.
