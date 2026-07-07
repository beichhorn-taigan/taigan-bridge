# Taigan Bridge — fact-check claim ledger

Product: Taigan Bridge (constants live in `src/scripts/constants.js`)
Originally audited: 2026-06-07 by Ray Proper against `taigan-bridge-v1.0.0.html`
(build `7fb571bf`) — independent source-verification, adversarial second pass
by a context-free verifier.
Status: **Active. The v1.0.0 errors in the Rejected table below were corrected
in v1.0.1** — every "Value to use" here is now what the app ships.
Risk tier: Level 3 (financial / legal / health — wrong claims harm the user)
Ledger status: Current for the claims listed; NOT exhaustive (see Scope)
Last full verification: 2026-06-08 (v1.0.3 corrections finalized)
Next required verification: 2027-01-15 (annual constants batch — see Recheck queue)

**How to use this file:** one row per factual claim shipped in the app. "Value
to use" is the exact correct fact as of the verification date — app strings
should say this and nothing more specific. "Recheck by" is when the value can
silently change; an expired row means re-verify before trusting. The Rejected
table records the wrong values found in v1.0.0 so they never get resurrected.
The time-decaying values now live in one place — `src/scripts/constants.js`
(`TB.constants`) — so a correction is a one-file diff. **When you change a
value in constants.js, update its row here in the same commit.**

**Scope:** legal / tax / pension / benefit rule-claims and hand-entered
constants in the shipped file and repo docs. Not covered: demo-profile sample
data, JP translation register, module logic beyond the documented FBAR rules.

---

## Current verified claim ledger

### FBAR (FinCEN Form 114)

| # | Claim | Value to use | Tier | Source URL | Verified | Recheck by | Stability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Filing threshold | File if aggregate value of all foreign financial accounts exceeds $10,000 at any time in the calendar year | T1 | https://www.irs.gov/businesses/small-businesses-self-employed/report-of-foreign-bank-and-financial-accounts-fbar | 2026-06-07 | stable | Stable | Statutory; unchanged since inception |
| 2 | Joint accounts | Each US-person joint owner counts the FULL account value toward their aggregate (not divided shares) | T1 | https://www.irs.gov/pub/irs-pdf/p5569.pdf | 2026-06-07 | stable | Stable | App logic implements this correctly |
| 3 | Signature authority | Signature/other authority alone, with no financial interest, triggers the filing requirement | T1 | same as #1 | 2026-06-07 | stable | Stable | App logic correct |
| 4 | US-located accounts | Accounts at US-located institutions are excluded from the FBAR aggregate (incl. foreign banks' US branches) | T1 | same as #1 | 2026-06-07 | stable | Stable | App logic correct |
| 5 | Form 114a | Record of Authorization to Electronically File FBARs — signed and RETAINED by filer, not submitted | T1 | same as #1 | 2026-06-07 | stable | Stable | — |
| 6 | Deadline | April 15, automatic extension to October 15, no extension form required | T1 | https://www.fincen.gov/ (FBAR due-date notices) | 2026-06-07 | 2027-01-15 | Semi-stable | FinCEN re-announces annually |
| 7 | Conversion rate rule | Convert each account's maximum value using the Treasury year-end (Dec 31) Reporting Rate of Exchange | T1 | https://www.fincen.gov/reporting-maximum-account-value | 2026-06-07 | stable | Stable | — |
| 8 | Non-willful penalty | Up to **$16,536 per report** (inflation-adjusted Jan 2025; statutory base $10,000; *Bittner* 2023: per report, not per account) | T1 | 31 CFR 1010.821; Bittner v. US, 598 U.S. 85 (2023) | 2026-06-07 | 2027-01-31 | Variable | `TB.constants.FBAR_NONWILLFUL_MAX`. FinCEN adjusts every January — v1.0.0 shipped stale values (see Rejected R3/R4), fixed v1.0.1 |
| 9 | Willful penalty | Greater of **$165,353** or 50% of the account balance (inflation-adjusted Jan 2025) | T1 | 31 CFR 1010.821 | 2026-06-07 | 2027-01-31 | Variable | `TB.constants.FBAR_WILLFUL_MIN`. Same annual adjustment |
| 10 | Treasury rate API | `api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange` — live, tested 2026-06-07 | T1 | https://fiscaldata.treasury.gov/datasets/treasury-reporting-rates-exchange/ | 2026-06-07 | stable | Stable | Auto-fetched on FBAR module open (v1.0.1) |

### Treasury year-end JPY rates (the TREASURY_FX correction set)

Live values are auto-fetched from the Fiscal Data API; the figures below are the
corrected **offline fallback** in `TB.constants.TREASURY_FX_FALLBACK`.

| # | Claim | Value to use | Tier | Source URL | Verified | Recheck by | Stability | Notes |
|---|---|---|---|---|---|---|---|---|
| 11 | JPY 2019-12-31 | **108.53** | T1 | Treasury Fiscal Data API (record_date 2019-12-31) | 2026-06-07 | stable | Stable | v1.0.0: 108.66 |
| 12 | JPY 2020-12-31 | **103.08** | T1 | same, 2020-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 103.25 |
| 13 | JPY 2021-12-31 | **115.04** | T1 | same, 2021-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 115.08 |
| 14 | JPY 2022-12-31 | **131.83** | T1 | same, 2022-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 131.81 |
| 15 | JPY 2023-12-31 | **141.47** | T1 | same, 2023-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 141.40 |
| 16 | JPY 2024-12-31 | **156.85** | T1 | same, 2024-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 157.20; ARCHITECTURE.md example was 151.39 |
| 17 | JPY 2025-12-31 | **156.61** | T1 | same, 2025-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 150.27 — ~4% off (see Rejected R2), fixed v1.0.1 |
| 18 | EUR / KRW / CAD 2024-12-31 | 0.961 / 1473.27 / 1.438 | T1 | same, 2024-12-31 | 2026-06-07 | stable | Stable | v1.0.0: 0.965 / 1472.5 / 1.439 — pattern: market rates, not Treasury. Live fetch re-pulls the full table |

### US tax & retirement

| # | Claim | Value to use | Tier | Source URL | Verified | Recheck by | Stability | Notes |
|---|---|---|---|---|---|---|---|---|
| 19 | FEIE amount | $132,900 (2026, IRS inflation adj.); $130,000 (2025, Rev. Proc. 2024-40); $126,500 (2024) — update annually | T1 | https://www.irs.gov/individuals/international-taxpayers/foreign-earned-income-exclusion | 2026-06-08 | 2026-11-30 | Variable | `TB.constants.FEIE`. 2026 = $132,900 confirmed; matches TaiganJP guides |
| 20 | Form 8938 thresholds (abroad) | Unmarried: >$200,000 year-end or >$300,000 anytime; MFJ: double both | T1 | https://www.irs.gov/instructions/i8938 | 2026-06-07 | 2027-01-15 | Semi-stable | Unchanged for years but statutory-regulatory |
| 21 | RMD start age | 73 (SECURE 2.0, since 2023); rises to 75 for those turning 73 after 2032; first RMD deferrable to Apr 1 following year | T1 | https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs | 2026-06-07 | 2033-01-01 | Semi-stable | — |
| 22 | WEP/GPO | Repealed — Social Security Fairness Act, signed 2025-01-05, applies to benefits payable Jan 2024+ | T1 | https://www.ssa.gov/benefits/retirement/social-security-fairness-act.html | 2026-06-07 | stable | Stable | App handles correctly |
| 23 | PFIC framing | Japanese 投資信託 are *generally treated as* PFICs (practitioner consensus under IRC §1297; Form 8621) — keep framed as analysis, no official IRS designation exists | T2 | https://www.irs.gov/instructions/i8621 (mechanics only) | 2026-06-07 | stable | Stable | Highest tier available; do not state as official designation |

### US healthcare & veteran benefits

| # | Claim | Value to use | Tier | Source URL | Verified | Recheck by | Stability | Notes |
|---|---|---|---|---|---|---|---|---|
| 24 | Part B standard premium | **$202.90/month (2026)**; $185.00 (2025); IRMAA surcharges on top by MAGI | T1 | https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles | 2026-06-07 | 2026-11-30 | Variable | `TB.constants.PART_B_PREMIUM_MONTHLY`. CMS announces each November — v1.0.0 shipped $175+/$185+ (see Rejected R5), fixed v1.0.1 |
| 25 | Medicare abroad | Medicare generally does not cover care outside the US (narrow exceptions); Part B premiums continue if enrolled | T1 | https://www.medicare.gov/coverage/travel-outside-the-u.s. | 2026-06-07 | stable | Stable | App states correctly |
| 26 | VGLI window | Apply within 1 year + 120 days (485 days) of separation; within 240 days no proof of good health required | T1 | https://www.va.gov/life-insurance/options-eligibility/vgli/ | 2026-06-07 | 2027-06-07 | Semi-stable | App's 485-day figure correct |

### Japan — nationality, pension, tax, estate

| # | Claim | Value to use | Tier | Source URL | Verified | Recheck by | Stability | Notes |
|---|---|---|---|---|---|---|---|---|
| 27 | 国籍選択 deadline + enforcement | Acquired **before age 18 → choose by age 20**; at/after 18 → within 2 years (Nationality Act **Art. 14**, since 2022-04-01). Art. 14 is a non-penalized **duty of effort (努力義務)**: missing the date = no fine, no automatic loss; loss occurs only after an unanswered Ministry **催告** written demand (one-month window), which has **never been issued to anyone**. Distinct from **Art. 11** (automatic loss on *voluntarily acquiring* a foreign nationality — does NOT apply to dual-from-birth). Filing 国籍選択届 ≠ US renunciation (Art. 16 = "endeavor"). Confirm status via 戸籍謄本. | T1 | https://www.moj.go.jp/MINJI/minji06.html ; https://www.moj.go.jp/MINJI/minji05.html | 2026-06-08 | stable | Stable | v1.0.0 "by 22" → fixed v1.0.1; calm framing + Art.11/14 split + .ics calendar +22→+20 bug → fixed v1.0.2 |
| 28 | Pension vesting | 老齢年金 requires 10 years (120 months) of qualifying periods | T1 | https://www.nenkin.go.jp/service/jukyu/seido/roureinenkin/jukyu-yoken/20150401-02.html | 2026-06-07 | stable | Stable | — |
| 29 | カラ期間 | 合算対象期間 counts toward the 10-year vesting but not the benefit amount; includes overseas-residence periods of Japanese nationals | T1 | https://www.nenkin.go.jp/service/jukyu/seido/roureinenkin/jukyu-yoken/20140421-05.html | 2026-06-07 | stable | Stable | — |
| 30 | 追納 | Back-payment of exempted/deferred contributions allowed within 10 years | T1 | https://www.nenkin.go.jp/service/kokunen/menjo/20150331.html | 2026-06-07 | stable | Stable | — |
| 31 | 任意加入 | Voluntary enrollment ages 60–65 domestic; ages 20–65 for Japanese nationals abroad | T1 | https://www.nenkin.go.jp/service/kokunen/kanyu/20140627-02.html | 2026-06-07 | stable | Stable | — |
| 32 | Statutory heirs | 民法 Arts. **887, 889, 890** (888 deleted 1962): spouse always heir; order = children → direct ascendants → siblings | T1 | https://laws.e-gov.go.jp/law/325AC0000000147/ | 2026-06-07 | stable | Stable | Cite as three articles, not a range — fixed v1.0.1 |
| 33 | Inheritance tax top rate | 55% on the portion of each statutory-share amount over ¥600M (deduction ¥72M) | T1 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4155.htm | 2026-06-07 | 2027-01-15 | Semi-stable | Rate table can move with tax reform |
| 34 | 小規模宅地等の特例 | Residential: 80% valuation reduction up to 330㎡ (business 400㎡; combined up to 730㎡) | T1 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm | 2026-06-07 | 2027-01-15 | Semi-stable | — |
| 35 | 10-year rule | Foreign national is outside worldwide-asset scope only if jusho-in-Japan periods total ≤10 of the 15 years before the inheritance/gift (一時居住者 etc.) | T1 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4138.htm | 2026-06-07 | 2027-01-15 | Semi-stable | — |
| 36 | 暦年贈与 clawback | Gifts within 7 years of death added back to the estate (2024 reform; phased from 3 years through 2031 transition) | T1 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4161.htm | 2026-06-07 | 2027-01-15 | Semi-stable | App states correctly |
| 37 | おしどり贈与 | ¥20M spousal gift-tax deduction for primary residence, marriage 20+ years (+¥1.1M annual exclusion) | T1 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4452.htm | 2026-06-07 | 2027-01-15 | Semi-stable | App caps correct |
| 38 | 教育資金一括贈与 | **Closed to new contributions 2026-03-31** (FY2026 reform did not extend); funds contributed by the deadline remain covered; ¥15M cap, recipients under 30 | T1 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4510.htm ; https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_02.htm | 2026-06-07 | stable | Stable | `TB.constants.GIFT_SUNSET.education`. Resolved app's "延長の可能性あり"; rendered as closed (v1.0.1) |
| 39 | 結婚・子育て資金一括贈与 | **Available until 2027-03-31** (extended 2 years by FY2025 reform); ¥10M cap (¥3M of it for marriage costs), recipients 18–50 | T1 | https://www.cfa.go.jp/policies/shoushika/zouyozei | 2026-06-07 | 2026-12-31 | Variable | `TB.constants.GIFT_SUNSET.marriageChildrearing`. Watch FY2027 reform 大綱 (Dec 2026) — v1.0.0 showed it dead (see Rejected R6), fixed v1.0.1 |

---

## Rejected / do not use

All rows below were the **wrong** values shipped in v1.0.0; each was corrected
in v1.0.1.

| # | Rejected claim (as shipped in v1.0.0) | Why rejected | Correct value | Date |
|---|---|---|---|---|
| R1 | 国籍選択 "choose by age 22" (all strings, age bands, glossary, deadline math) | Pre-2022 law; Art. 14 amended effective 2022-04-01 | Before-18 acquirers: by age 20; at/after-18: within 2 years (row 27) | 2026-06-07 |
| R2 | TREASURY_FX 2025 JPY = 150.27 | Not the Treasury rate; ~4% deviation, distorts every 2025 FBAR USD value | 156.61 (row 17) | 2026-06-07 |
| R3 | FBAR non-willful penalty "$10,000 per violation" | Statutory base, not current adjusted cap; "per violation" reads per-account, contra *Bittner* (2023) | Up to $16,536 per report (row 8) | 2026-06-07 |
| R4 | FBAR willful penalty "up to $129,000" | Outdated adjusted figure (c. 2019) | Greater of $165,353 or 50% of balance (row 9) | 2026-06-07 |
| R5 | Part B premium "$175+ in 2026" and "$185+/mo in 2026" | Two conflicting figures; both wrong — $174.70 was 2024, $185.00 was 2025 | $202.90 (2026) (row 24) | 2026-06-07 |
| R6 | 結婚・子育て sunset 2025-03-31 "already past" | Extended to 2027-03-31 by FY2025 reform | Row 39 | 2026-06-07 |
| R7 | TREASURY_FX table generally (all years/currencies sampled) | Values are market-rate approximations, none matches the official Treasury rate exactly | JPY corrected exactly (rows 11–18); live fetch re-pulls the full table | 2026-06-07 |
| R8 | ARCHITECTURE.md example fx_rate 151.39 "Treasury Year-End 2024" | Matches no Treasury record | 156.85 (row 16) | 2026-06-07 |

## Verification passes

### 2026-06-07 — initial full audit (v1.0.0)
Scope: all legal/tax/pension/benefit rule-claims + hand-entered constants in
shipped file and repo docs. Method: T1-only sourcing (issuing authorities),
primary-language-first for Japan claims, independent adversarial pass by a
context-free verifier (22 external claims: 20 confirmed, 1 wrong, 1 tier-flagged
→ 91% convergence), plus in-file string/data audit. Confirmed: rows 1–7, 10,
19–23, 25–26, 28–37 as shipped (with row-19 staleness note). Changed/corrected:
R1–R8. Unresolved: demo-profile data, JP register, undocumented module logic
(declared out of scope).

### 2026-06-08 — corrections applied (v1.0.1)
All Rejected rows R1–R8 corrected in source. Time-decaying values centralized in
`src/scripts/constants.js`. FBAR now auto-fetches official Treasury year-end
rates on module open (offline fallback = corrected constants table). Nationality
deadline math changed from +22y to +20y; every "by 22" string updated EN+JP.

### 2026-06-08 — 国籍選択 enforcement framing (v1.0.2)
Follow-up research on Article 14 enforcement (row 27). Reframed the past-deadline
state from a high-urgency "OVERDUE" alarm to a calm, dismissible informational
note: the obligation is a non-penalized 努力義務, the 催告 demand has never been
issued, and there is no automatic loss. Added the Art. 11 vs Art. 14 distinction
and the "filing ≠ renunciation" clarification (EN+JP). Fixed a residual bug: the
exported .ics calendar event still computed the date at birth +22y (corrected to
+20y, matching the in-app deadline).

### 2026-06-08 — drift audit vs the TaiganJP guide site (v1.0.3)
Cross-checked the tool against the TaiganJP guides + their `watched-facts.yaml`.
~95% already consistent. Tool-side corrections applied:
- **veteran.js** treaty articles fixed — government/military pensions are **Art. 18**
  (not 17; Art. 17 = private pensions + SS); VA disability JP treatment reframed
  from a false "exempt under Article 19" to the correct **unsettled** stance,
  matching the site's flagship `va-disability-japan-tax` guide.
- **US estate exemption** — added 2026 = **$15.0M** (OBBBA permanent) and removed
  the stale "~$7M TCJA sunset" comment (`estate.js`).
- **Part B premium** — six prose/help strings hardcoded **$195** → **$202.90**
  (now consistent with `TB.constants.PART_B_PREMIUM_MONTHLY`).
- **FEIE 2026 = $132,900** added (row 19); **SS wage base** glossary $168,600(2024)
  → **$184,500 (2026)**; **高額療養費** gained the "under-revision-2026-27" hedge the
  site carries; WEP/GPO label corrected to "signed Jan 2025."
- **国籍留保** (3-month overseas-birth nationality reservation) coverage ADDED to the
  Family module + glossary — closing the one consequential gap vs the site.
- Note (nenkin): tool's FY2026 国民年金 ¥17,920 confirmed correct; the SITE registry
  (¥17,510/FY2025) was the stale side and was updated there.
- **Offline FX fallback** — the 2025 row in `constants.js` was re-pulled to the
  FULL official Treasury year-end rate set (all currencies, not just JPY), so it
  now matches the TaiganJP fbar-calculator's official 2025 table exactly. **IRMAA**
  glossary thresholds → 2026 ($109K single / $218K MFJ). **§877A** covered-expat
  avg-tax help strings $201K (2024) → $206K (2025), matching the family.js constant.

## Source notes

**Preferred T1 sources:** irs.gov · fincen.gov · fiscaldata.treasury.gov (API) ·
ssa.gov · va.gov · cms.gov / medicare.gov · nta.go.jp (タックスアンサー) ·
moj.go.jp · nenkin.go.jp · mof.go.jp (税制改正大綱) · cfa.go.jp · laws.e-gov.go.jp
**Known weak sources — discovery only, never cite:** expat-tax-firm blogs and
aggregator guides (convergent and frequently stale on penalties/premiums; three
agreeing is evidence of a shared stale upstream, not accuracy).

## Recheck queue (annual constants batch — suggested every January 15)

- Treasury year-end FX (published ~early Jan) → rows 11–18 / `TREASURY_FX_FALLBACK`
- FinCEN penalty inflation adjustment (published ~mid Jan) → rows 8–9 / `FBAR_*`
- FBAR due-date notice → row 6
- Japan tax-reform 大綱 outcomes from prior December → rows 33–39 / `GIFT_SUNSET`
- Off-cycle: FEIE (fall Rev. Proc.) → row 19 / `FEIE` · Part B premium (November
  CMS) → row 24 / `PART_B_PREMIUM_MONTHLY` · 結婚・子育て extension watch
  (December 2026) → row 39
