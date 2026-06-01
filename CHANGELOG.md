# Changelog

All notable changes to Taigan Bridge will be documented in this file.

## [1.0.0] — 2026-06-01 — Initial release

The first public release of Taigan Bridge — a single-file financial,
tax, estate, and health planning organizer for U.S. persons living in
Japan. Everything below ships in this build.

### Core architecture

- **Single-file HTML** distribution. Runs from `file://`, no install,
  no signup, no server. Open the file, the app loads.
- **Local-only state.** Every record lives in your browser's
  `localStorage`. The author has no analytics, no telemetry, no
  tracking. One-click JSON export and one-click full delete.
- **Bilingual EN / JP.** Every UI string, every prompt, every
  notification. Furigana annotation on inline JP terms. JP rendering
  reviewed for naturalness with a native speaker.
- **Track-based onboarding.** A short branching wizard determines
  which modules apply to your situation (SOFA contractor, JP
  spouse, retiree, dual-citizen children, JP property owner, etc.)
  so the dashboard surfaces only what's relevant.
- **BYO Claude API key.** AI-assisted features (document extraction,
  enrichment, Ask Taigan) connect directly from your browser to
  Anthropic using a key you provide. Per-feature consent + a daily
  spend cap.

### Modules

- **Net Worth + Assets** — multi-currency account tracking, year-end
  snapshots with side-by-side YoY review, beneficiary review,
  tax-loss harvesting scanner (Q4), PFIC scan. AI-assisted
  statement extraction from images / PDFs with optional chained
  institution-info enrichment.
- **FBAR (FinCEN 114)** — full year-by-year filing tracker with
  Treasury year-end rates, multi-filer households, vision import
  for passbooks + bank statements, 14-card Filing tab including
  Form 114a generator, late-filing explanation generator, and an
  AI FBAR Advisor Q&A backed by your sanitized FBAR context.
- **Tax Coordinator** — bilingual deadline calendar, forms
  applicability assessment (1040, 2555, 1116, 8938, 8621,
  確定申告), document checklist with Document Vault sync,
  JP-side filing-responsibility split for SOFA + JP-spouse
  households, FEIE-vs-FTC decision support, PFIC alerts, and a
  CPA briefing markdown generator. Vision import for W-2 and
  源泉徴収票.
- **Projections** — long-horizon scenario modeling with NIIT,
  IRMAA, state tax, Roth conversion ladder, QBI, Section 603
  catch-up transitions, scenario compare, monthly view.
  Treaty-aware tax handling and approach-based optimizers.
- **Decumulation** — Social Security claiming strategy with
  WEP/GPO repeal handling, JP pension vesting paths (国民年金 /
  厚生年金 / 追納 / 任意加入 / 合算 / カラ期間), RMD timing,
  healthcare bridge planning. Vision import for 年金定期便
  and SSA statement.
- **SOFA Roth Sequencing Planner** — five-tab planner (Overview,
  Profile, Accounts, Sequence, Risks) for the high-stakes window
  between SOFA status and 住民票 registration. Cost-of-mistake
  warnings before each critical action.
- **Estate** — JP statutory shares (民法 §887–§890) auto-derived
  from family composition, inheritance tax estimation with
  小規模宅地等の特例, will tracker cross-referenced with Document
  Vault, 戸籍 handling for foreign decedents, Letter of Instruction
  generator, and a renunciation / exit-tax (§877A) section.
- **Property** — JP + U.S. real estate with 固定資産税 tracking,
  §121 / §469 / §1250 cross-border treatment, U.S. rental income
  with FEIE / FTC routing, 古民家 / 農地 inheritance scenarios.
  Vision import for 固定資産税通知書.
- **Family** — passport renewal tracking with vision import
  (令和 → ISO conversion handled), 国籍選択 (Japanese Nationality
  Law Article 14) deadline tracking for dual-citizen children,
  education savings (529 vs 教育資金一括贈与), gift pre-positioning
  vehicles (暦年贈与 / 教育資金一括贈与 / 結婚・子育て /
  相続時精算課税), renunciation tracking.
- **Veteran** — VA benefits, FMP for service-connected care
  abroad, TRICARE Overseas, Post-9/11 GI Bill timing,
  survivor benefits (DIC / SBP), VGLI 485-day deadline. All
  status-aware (active / reserve / retired / separated).
- **Healthcare** — Medicare Part B / IRMAA tracking with
  IEP / SEP guidance, FEHB / TRICARE / FMP coverage routing,
  Japan NHI / SHI premium estimation, long-term-care
  (介護保険) timing.
- **Health Tracker** — exam history, lab results with bilingual
  reference ranges and AI-generated explanations, dental
  periodontal tracking with per-tooth findings + trend
  sparklines, medication list with interaction warnings,
  insurance card capture, invoice import, care episodes,
  and a printable Year-in-Review.
- **Document Vault** — inventory of where every important
  document lives (passport, will, deed, insurance, tax returns)
  with AI document classification, expiry alerts, bulk import.
- **Contacts** — unified address book that auto-pulls from
  every other module (medical providers, insurance plans,
  family, professionals) plus built-in Japan emergency numbers
  and onboarding-driven contacts (US Embassy Tokyo, AMINET, VA).
- **Consultations** — track CPAs, 税理士, lawyers, immigration
  attorneys you've engaged. Per-meeting log + follow-up
  reminders. Surfaces "have you consulted on X?" prompts based
  on your data.
- **Resident** — non-SOFA Japan-resident specific: 確定申告 prep,
  permanent residency timing, 10-year worldwide-asset clock,
  ふるさと納税, 住宅ローン控除, 国民健康保険.
- **FX & Cross-Border Banking** — live mid-market USD/JPY
  reference (Frankfurter / Cloudflare / open.er-api fallback
  cascade), Treasury rate (used for FBAR + all calculations),
  bidirectional transfer-cost calculator (USD→JPY and JPY→USD)
  across major remittance platforms (Wise, Revolut, SBI Sumishin,
  Sony Bank, Schwab International, etc.) with FBAR threshold
  callouts.
- **Action Center** — the "what should I do today?" surface that
  aggregates time-sensitive items from every module: FBAR
  deadlines, document expiries, RMD windows, passport renewals,
  backup overdue. Dashboard widget rows are clickable for direct
  navigation.
- **Sharing & Backup** — Spouse Handoff HTML (bilingual when a
  JP spouse is detected), Survivor Guide formatted for printing
  and storing with the will, Advisor JSON, full-state backup
  with optional auto-prompt schedule.
- **Ask Taigan** — opt-in AI assistant with read-only access to
  your Taigan Bridge state for situation-specific questions in
  either language.

### AI integration architecture

- **Per-feature consent gates** — each AI feature is opt-in via
  Settings, with four global modes: Full, Per-call confirm,
  Vision only, Off.
- **Chained workflows** — when an AI step has a logical successor
  (e.g., dental invoice extraction → provider info enrichment),
  the chain runs automatically with a visible opt-out checkbox.
  Documented in the chain-by-default architectural rule.
- **Image / PDF vision** wired into every module that ingests
  structured records: Assets, FBAR, Document Vault, Health
  Tracker (exams, dental, invoices, insurance cards), Family
  (passports), Property (固定資産税通知書), Tax (W-2 /
  源泉徴収票), Decumulation (年金定期便, SSA statement).
- **和暦 → ISO date conversion** (令和 / 平成 / 昭和) handled
  in every prompt that touches Japanese documents.
- **Daily spend cap** (default $5 / day, configurable) prevents
  runaway costs from stuck loops.

### Distribution & updates

- **GitHub Releases as the official channel.** Each release attaches
  a single `taigan-bridge-vX.Y.Z.html` you download and open from
  your own disk.
- **Hosted demo, clearly fenced.** A static preview is published to
  GitHub Pages for try-before-you-download. When the app detects it's
  running from a non-`file://` origin it pins a red "LIVE DEMO"
  banner, auto-loads a fictional sample household, and re-seeds it on
  refresh — so the shared preview can't be mistaken for your private
  copy, and nobody accidentally enters real data into it. The demo
  behavior is a complete no-op when you open your downloaded file.
- **Opt-in update notifications.** A downloaded copy can check once
  per day whether a newer release has shipped and surface a
  dismissable banner with a download link. Off until you say yes via
  a one-time consent prompt; togglable anytime under Settings →
  Updates; never auto-updates anything — you always download and
  replace the file yourself. See the Privacy note for exactly what
  the check sends.
- **Support the project (optional).** A footer "Tips" link and an
  About-page chooser point to Ko-fi and Buy Me a Coffee. No tip is
  ever expected or required; every feature works the same regardless.

### Privacy

- No analytics. No telemetry. No tracking pixels. No fonts loaded
  from a CDN. No outbound network requests at boot on a fresh install.
- Optional outbound calls only on explicit user action or opt-in:
  Treasury / live FX rate fetches (no PII), Claude API calls (your
  key, your prompts), and — only if you enable it — the daily update
  check.
- **Update-check disclosure.** If you opt into update checks
  (Settings → Updates, off by default), the app fetches a small static
  `version.js` via the jsDelivr CDN at most once per day. The request
  sends nothing about you — no account, no usage data, no identifying
  query parameters. Because jsDelivr publishes aggregate, anonymous
  hit counts for public files, the author can see a coarse tally of
  how many installs check for updates. That is the only usage signal
  that exists anywhere in the app; it is opt-in and carries no
  identifying information. Turn the toggle off and even that stops.
- Forensic build identifiers and canary markers embedded in the
  distribution for the purpose of identifying unauthorized copies.

### License

Free for personal, non-commercial use. Redistribution and
modification require written permission. See `LICENSE.md`.
