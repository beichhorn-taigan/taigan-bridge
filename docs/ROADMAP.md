# Roadmap

Taigan Bridge is a single-file financial planner for Americans living in Japan, currently at **v1.0.3** (stable). This roadmap describes shipped versions and deferred features.

## Shipped Versions

### v1.0.0 — Initial Release (2026-06-01)

All core modules shipped at production quality:
- **FBAR Tracker**: Multi-year, multi-account with FX conversion, threshold verdict, printable summary
- **Assets**: US and Japan account tracking, FX toggle, net-worth rollups, tax-loss harvesting scanner
- **Projections**: SS/pension/Roth sequencing planner with tax modeling
- **Tax Coordinator**: PFIC/Form 8938 thresholds, FEIE modeling, CPA finder
- **Estate Planning**: Beneficiary tracking, 相続税 estimator, will supplement generator
- **SOFA Roth**: Step-by-step sequencing with cost-of-error calculator
- **Family**: Dual-citizen management, renunciation tracker, education gifting planner
- **Health**: Medical history, lab tracking, insurance gap detection, AI extraction
- **Veteran**: VA rating tracker, TRICARE timeline, DD-214 vault
- **Document Vault**: File organization, expiry tracking, bilingual templates
- **Resident**: 確定申告 reminder, 住民票/PR timeline, 10-year worldwide-asset clock
- **Property**: Foreign real estate tracker, tax exposure
- All modules bilingual (EN/JP) with full i18n coverage

### v1.0.1 — Fact-Check Corrections (2026-06-08)

- Fixed 3 user-reported claim errors (IRMAA thresholds, Form 8938 limits, SS collection ages)
- Updated Form 8938 threshold to $600K (2025 indexed amount)

### v1.0.2 — Framing + Calendar Fix (2026-06-08)

- **Nationality choice framing**: Added "not permanent resident" warning for new renunciation logic
- **Calendar export RFC 5545 fix**: .ics export now produces valid 1-day duration events (DTEND – DTSTART = 1 day)
- Improved onboarding clarity for Japan-residency concepts

### v1.0.3 — Site-Consistency Pass (2026-06-08, current)

- 77 bugs fixed across foundations, compliance, security, and data integrity layers:
  - UTC-vs-JST timezone fixes (~25 date-handling sites)
  - FBAR aggregate unification (removed re-implementations)
  - Contract-drift prevention (centralized state paths + schema assertions)
  - Critical security fixes (RCE vulnerability in update check, CSV injection, API key leakage in exports, state import validation)
  - Compliance deadline gating (教育資金一括贈与 sunset, FEIE figures current to 2026, IRMAA/RMD thresholds)
  - SOFA Roth solar-recapture math fix
  - Beneficiary review card linkage fix
  - 12-module i18n sweep (hardcoded generator strings → full translation coverage)
- Dead code cleanup (20 unused exports removed)
- Full CI/CD pipeline wired (GitHub Actions, state-path assertions, build smoke tests)

## Deferred / Post-Launch Features

The following were planned but remain deferred due to scope or complexity:

### Tax & Compliance (v2.0+)

- **Form 7202 Roth recapture**: Precise calculation of deemed-disposed-basis vs. recovery exclusion
- **Form 8839 Adoption credits**: Integration with child account data
- **Non-SOFA tax module**: 5-year non-PR residency rule, PFIC complex security modeling, exit-tax simulator
- **Pension contribution tracker**: 国民年金 / 厚生年金 with optional totalization agreement modeling

### Family & Estate (v2.0+)

- **529 state comparison matrix**: Multi-state plan performance, tax implications by residence status
- **相続税 simulator**: Full multi-heir scenarios with mitigation strategies
- **Dual-citizen renunciation workflow**: Detailed tax consequences (Form 8854, IRC §877A cliff test)
- **公正証書遺言 vs. US will hybrid estate coordination**
- **Family gifting calendar**: Annual exemption tracking across recipients with tax-year cutoff logic

### Resident Tracking (v2.0+)

- **Prior residency periods**: Support for multiple arrival/departure dates to compute true "10 of 15 years" rule
- **Mortgage credit (existing homes)**: Expand from new-build (2024+) to pre-owned homes (既存住宅)
- **Kaikin notification automation**: Integrated checklist with expiry alerts

### Document & Archive (v2.0+)

- **Encrypted JSON export**: WebCrypto AES-GCM with passphrase-derived key (PBKDF2)
- **Full document library**: 10+ bilingual templates (POA, proxy documents, deed assignment, healthcare directive variants)

### Infrastructure (v2.0+)

- **Production obfuscation**: JavaScript minification and variable mangling via javascript-obfuscator
- **Accessibility audit**: WCAG 2.1 AA compliance sweep (focus mgmt, color contrast, screen-reader testing)
- **Performance profiling**: Asset size optimization, lazy-load module shims

## Non-Goals

- **Backend or sync**: Taigan Bridge is client-only. Privacy depends on it. Sync would be a separate product.
- **Direct e-filing**: The tool prepares records; it doesn't file with government agencies.
- **Real-time market data**: No brokerage integrations, no auto-trading, no live quote streams.
- **Mobile app**: The web version is responsive; that's the extent of mobile support.

---

**Last updated**: 2026-07-06 (v1.0.3 release)
