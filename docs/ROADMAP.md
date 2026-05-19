# Roadmap

Versioning follows the principle of "ship a usable artifact at every
release." A user who downloads any version should get a tool whose
boundaries are honestly labeled — placeholder modules carry visible
"coming soon" badges so nobody mistakes a shell for a planner.

## v0.1 — Scaffold (current)

- Project structure, build pipeline, design tokens.
- Onboarding wizard, track assignment, dashboard chrome.
- Working **Profile** and **Settings** modules.
- Placeholder shells for FBAR, Assets, SOFA Roth, Veteran, Document
  Vault.
- BYO Claude API key plumbing (placeholder responses).
- Bilingual EN/JP coverage of the v0.1 surface area.

## v0.2 — FBAR Tracker

- Multi-year, multi-account, max-balance entry per account per year.
- Automatic FX conversion using stored or fetched USD/JPY rates.
- $10K aggregate threshold logic with a clear "you do / don't need
  to file" verdict per year.
- Joint accounts: percent-ownership entry and aggregation handling.
- Children / dependents with their own filings (separate sub-records).
- Printable A4 submission summary mirroring the FinCEN 114 layout.
- Clear disclaimer that the tool prepares records — it does not file.

## v0.3 — SOFA Roth Sequencing Planner + Encrypted Export

- Visual timeline with checkpoints for each of the four steps:
  retire-with-SOFA-docs → Roth distribution to US brokerage →
  register 住民票 only after wire confirmed → same-day NHI + JA共済.
- Cost-of-getting-this-wrong calculator (illustrative ranges).
- Triple-confirmation modal before the calculator produces output.
- Document checklist for each step (what to keep, what to bring).
- Bilingual EN/JP output suitable for sharing with a CPA.
- **Encrypted JSON export.** WebCrypto AES-GCM with a passphrase-
  derived key (PBKDF2 or Argon2). UX includes passphrase prompt on
  export, passphrase prompt on import, and a "passphrase lost = data
  lost" warning. Removes the FBAR module's "exported backups are
  plain JSON" banner once shipped.

## v0.4 — Asset Tracker (basic)

- US accounts, Japan accounts, retirement accounts.
- USD/JPY toggle with stored FX rates.
- Account-type tagging (taxable, retirement, NISA, etc.).
- Net worth summary.

## v0.5 — Veteran skeleton + Document Vault skeleton

- Veteran: VA rating, claims status, TRICARE timeline anchor,
  DD-214 storage location field, military pension treaty notes.
- Document Vault: account index (where, not credentials),
  beneficiary designation tracker, 2-3 bilingual estate templates
  (POA, simple will reference, account-credential index sheet).

## v1.0 — First public release

- All v0.1–v0.5 modules at production quality.
- Final logo and brand mark.
- Production obfuscation pipeline wired into `build.js`.
- Gumroad listing live with build-hash verification instructions.
- Soft launch in the Japan-based US veterans LinkedIn group.

## v2.0 — Deferred items (post-launch)

- Form 8938 Tracker.
- Non-SOFA tax module: 5-year non-permanent-resident rule, PFIC
  awareness, exit tax modeler.
- Pension contribution tracker (国民年金 / 厚生年金) with optional
  totalization-agreement modeling.
- Family module: dual-citizen children renunciation considerations,
  529 limitations vs. Japanese universities, 相続税 modeler,
  cross-border estate coordinator (公正証書遺言 vs. US will).
- Property module: foreign real estate tracker, kominka /
  agricultural land, 名義変更 status, 農業委員会 notification.
- Full document vault library (10+ bilingual templates).
- Encrypted JSON export (currently plain JSON).

## Non-goals

- A backend, accounts, or sync. The privacy posture depends on
  client-only operation. If sync becomes necessary, it's a separate
  product.
- Direct e-filing of FBAR or any tax form. The tool prepares the
  user — it does not transact with the government on their behalf.
- Real-time market data, brokerage integrations, or auto-trading.
- A mobile app. The web build is mobile-responsive; that's the
  ceiling for now.
