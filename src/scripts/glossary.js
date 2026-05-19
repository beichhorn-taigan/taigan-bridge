/* Taigan Bridge — glossary.js
 *
 * Click-to-define glossary system. A central registry of acronyms
 * and key concepts; an annotator that wraps occurrences in rendered
 * text with clickable buttons; a modal that displays the full
 * definition with related terms (themselves clickable for navigation).
 *
 * Sits alongside the JP-term annotator (utils.js → annotateJpTerms):
 *   • annotateJpTerms wraps Japanese kanji in <ruby> with furigana
 *     above and an English tooltip on hover.
 *   • TB.glossary.annotate wraps English acronyms (PFIC, NISA, …)
 *     and Japanese terms with definitions in <button> elements that
 *     open this modal on click.
 *
 * Both annotators run via the MutationObserver in index.html boot.
 *
 * To add a term: extend the GLOSSARY object below. Keys are matched
 * case-sensitively against text (so "PFIC" matches but "Pfic" does
 * not — appropriate for acronyms). Multi-word terms supported.
 */

(function () {
  'use strict';

  // ====================================================================
  // GLOSSARY DATA
  // ====================================================================
  //
  // Each entry:
  //   term          — display string (also the match key by default)
  //   match         — optional: alternate strings that should match
  //   expansion     — what the acronym stands for
  //   short         — one-sentence definition (shown at top of modal)
  //   long          — full explanation, multiple paragraphs allowed
  //   why           — "why it matters" / "applies to" — actionable framing
  //   category      — 'us-tax' | 'jp-tax' | 'retirement' | 'investing' | 'jp-banking' | 'sofa'
  //   related       — array of other glossary keys, shown as chips
  //   refs          — array of { label, url } external references

  const GLOSSARY = {
    // ── US TAX / RETIREMENT ──────────────────────────────────────────
    'PFIC': {
      expansion: 'Passive Foreign Investment Company',
      short: 'A US tax classification for non-US-domiciled mutual funds, ETFs, and similar pooled investments. Triggers punitive tax treatment for US persons.',
      long: 'A foreign corporation is a PFIC if 75%+ of gross income is passive (dividends, interest, rents) OR 50%+ of assets produce passive income. Almost all Japanese mutual funds, NISA holdings, and iDeCo investments qualify. US persons holding a PFIC face: (1) tax on "excess distributions" at the highest marginal rate plus an interest charge for each year held; (2) loss of LTCG preferential rates; (3) no step-up in basis at death; (4) annual Form 8621 filings per fund (typical CPA cost: $300-500 per fund per year). The QEF and MTM elections soften but never eliminate the cost.',
      why: 'If you are a US person living in Japan, do NOT buy Japanese mutual funds, ETFs, NISA, or iDeCo investments. Stick to US-domiciled funds (VTI, VXUS, etc.) held in US brokerages.',
      category: 'us-tax',
      related: ['NISA', 'iDeCo', 'Form 8621', '投資信託'],
      refs: [
        { label: 'IRS Form 8621 instructions', url: 'https://www.irs.gov/forms-pubs/about-form-8621' },
      ],
    },
    'NISA': {
      expansion: '少額投資非課税制度 (Nippon Individual Savings Account)',
      short: 'Japan\'s tax-free investment account, expanded in 2024 to ¥3.6M/yr and ¥18M lifetime cap.',
      long: 'NISA allows Japanese residents to invest in stocks and funds without paying tax on dividends or capital gains. The 新NISA (new NISA) introduced in 2024 has two slots: つみたて投資枠 (Tsumitate, ¥1.2M/yr in approved index funds) and 成長投資枠 (Growth, ¥2.4M/yr in stocks/ETFs). Lifetime contribution cap: ¥18M. Sounds great — except for US persons.',
      why: 'For US persons, NISA is a TRAP. The investments inside are Japanese funds → PFIC under US law → punitive tax that destroys the JP tax savings. Available cleanly only to non-US-person spouses.',
      category: 'jp-tax',
      related: ['PFIC', 'iDeCo', '投資信託'],
    },
    'iDeCo': {
      expansion: '個人型確定拠出年金 (Individual Defined Contribution Pension)',
      short: 'Japan\'s individual DC pension — tax-deductible contributions, tax-deferred growth, taxed at withdrawal.',
      long: 'iDeCo allows JP residents to contribute to a personal pension account (max varies: ¥144K-¥816K/yr depending on employment status). Contributions reduce JP taxable income dollar-for-dollar; growth is JP-tax-free until age 60+; withdrawal taxed favorably as either a lump sum (退職所得控除) or annuity (公的年金等控除). Like NISA, iDeCo invests in Japanese mutual funds.',
      why: 'For US persons: PFIC trap, same as NISA. Skip it. For non-US-person spouses with JP income, it\'s a powerful tax-deferred vehicle.',
      category: 'jp-tax',
      related: ['PFIC', 'NISA', '厚生年金'],
    },
    'SECURE 2.0': {
      expansion: 'Setting Every Community Up for Retirement Enhancement Act 2.0',
      short: '2022 US legislation that reshaped retirement account rules — most provisions phased in 2023-2026.',
      long: 'Major SECURE 2.0 changes: RMD age raised from 72 to 73 (eventually 75 by 2033); enhanced catch-up contributions for ages 60-63 ($11,250 vs the standard $7,500 starting 2025); Section 603 mandates Roth-only catch-up for high earners (>$145K prior-year wages, starting 2026); 401(k) auto-enrollment for new plans; Roth SEP/SIMPLE IRAs allowed; 529-to-Roth rollovers allowed.',
      why: 'Three SECURE 2.0 provisions hit retirement projections: enhanced 60-63 catch-up, Section 603 Roth requirement for high earners, and the RMD-age push. The Projections engine models all three.',
      category: 'us-tax',
      related: ['Section 603', 'Section 109', 'RMD', 'Catch-up Contribution', 'Roth IRA'],
    },
    'Section 603': {
      expansion: 'SECURE 2.0 Section 603',
      short: 'Starting 2026, mandatory Roth treatment for catch-up contributions by high earners (>$145K prior-year wages).',
      long: 'If your prior-year FICA wages exceed $145K (indexed for inflation), your $7,500 (or $11,250 at age 60-63) catch-up contribution MUST go into a Roth 401(k) account, not Traditional. If your plan doesn\'t offer a Roth 401(k) option, you forfeit the catch-up entirely. Originally scheduled for 2024, delayed to 2026.',
      why: 'If you are a high earner planning catch-up contributions, you need a Roth 401(k) account in your employer plan starting 2026. The Projections engine flags this in the Tax Strategy tab.',
      category: 'us-tax',
      related: ['SECURE 2.0', 'Catch-up Contribution', 'Roth 401(k)'],
    },
    'Section 109': {
      expansion: 'SECURE 2.0 Section 109',
      short: 'Enhanced catch-up contribution limit at ages 60-63 — $11,250 instead of the standard $7,500.',
      long: 'For 2025+, workers aged 60, 61, 62, or 63 can make catch-up contributions of the GREATER of $10,000 or 150% of the standard age-50+ catch-up amount (~$11,250 for 2025). Reverts to the standard $7,500 at age 64. Inflation-adjusted thereafter.',
      why: 'A four-year window of bonus retirement-savings room. The Projections engine\'s irs401kLimitDetail() automatically applies the enhanced amount in years where you\'re 60-63.',
      category: 'us-tax',
      related: ['SECURE 2.0', 'Catch-up Contribution'],
    },
    'Catch-up Contribution': {
      expansion: 'IRS retirement plan catch-up',
      short: 'Extra retirement-account contribution allowed for workers age 50+, on top of the regular limit.',
      long: 'IRS lets workers 50+ contribute extra to 401(k), 403(b), TSP ($7,500 in 2024 + indexed) and IRAs ($1,000). SECURE 2.0 enhanced the 401(k)/403(b)/TSP catch-up to $11,250 at ages 60-63.',
      category: 'us-tax',
      related: ['SECURE 2.0', 'Section 109', 'Section 603'],
    },
    'Rule of 55': {
      expansion: 'IRS Rule of 55',
      short: 'Lets workers who separate from their employer at age 55+ withdraw from that employer\'s 401(k)/TSP/403(b) without the 10% early-withdrawal penalty.',
      long: 'Normally, distributions from retirement accounts before age 59½ trigger a 10% federal penalty on top of income tax. Rule of 55 carves out an exception: if you separate from your employer in or after the calendar year you turn 55, you can withdraw from THAT employer\'s plan penalty-free. Income tax still applies to traditional pre-tax distributions. Does NOT apply to IRAs (Trad or Roth) — rolling 401(k) into an IRA before 59½ forfeits this benefit.',
      why: 'If you\'re retiring early (55-59), keep money in your 401(k) — don\'t roll it to an IRA — until you\'re 59½ or older. Plan the rollover timing carefully.',
      category: 'retirement',
      related: ['401(k)', '72(t) SEPP', 'RMD'],
    },
    'RMD': {
      expansion: 'Required Minimum Distribution',
      short: 'Mandatory annual withdrawal from pre-tax retirement accounts (Traditional IRA, 401k, TSP) starting at age 73.',
      long: 'IRS requires annual minimum distributions from Traditional IRAs, 401(k)s, 403(b)s, and TSP starting the year you turn 73 (was 70½ before SECURE; raised to 72 by SECURE 1.0; raised to 73 by SECURE 2.0; rises to 75 in 2033). Amount = prior-year balance ÷ IRS life-expectancy factor. Failure to take an RMD triggers a 25% excise tax (was 50% before SECURE 2.0). Roth IRAs are EXEMPT during the owner\'s lifetime; Roth 401(k)s also exempt as of SECURE 2.0.',
      why: 'Drives Roth conversion strategy: convert pre-tax → Roth in low-income years BEFORE 73 to reduce future RMDs. The Projections engine flags your first RMD year in the Tax Strategy tab.',
      category: 'retirement',
      related: ['Traditional IRA', '401(k)', 'Roth IRA', 'Roth Conversion', 'SECURE 2.0'],
    },
    'Roth Conversion': {
      expansion: 'Traditional → Roth IRA conversion',
      short: 'Move money from a pre-tax (Traditional IRA / 401k) account into a Roth account, paying ordinary income tax on the converted amount today in exchange for tax-free withdrawals later.',
      long: 'A Roth conversion is taxed as ordinary income in the year of conversion. After conversion, the money grows tax-free in the Roth account and qualified withdrawals are tax-free. Strategic value: pay tax in low-bracket years (early retirement, between salary and SS) to avoid higher-bracket tax later AND eliminate RMDs on the converted balance.',
      why: 'For US persons in Japan: must convert BEFORE 住民票 registration. After 住民票, Japan also taxes the conversion as ordinary income (20-45% national + 10% local) on top of US tax — making the conversion 35-55% expensive. The Projections Tax Strategy tab includes a conversion ladder editor.',
      category: 'us-tax',
      related: ['Roth IRA', 'Traditional IRA', '住民票', 'Bracket Fill', 'SOFA'],
    },
    'Bracket Fill': {
      expansion: 'Tax-bracket filling strategy',
      short: 'Realize income (Roth conversion, capital gains harvesting) up to the top of your current tax bracket but no further.',
      long: 'In low-income years, deliberately recognize taxable income up to a target bracket ceiling. E.g., if you\'re in the 22% bracket with $40K of headroom, convert $40K from Traditional to Roth — paying 22% now to avoid 24-32% later. Stay below the ceiling to avoid jumping brackets.',
      why: 'The most common application is a Roth conversion ladder during early retirement (low salary years between work and SS).',
      category: 'us-tax',
      related: ['Roth Conversion', 'LTCG'],
    },
    'Roth IRA': {
      expansion: 'Roth Individual Retirement Account',
      short: 'Post-tax US retirement account; contributions are not deductible but qualified withdrawals (after age 59½ + 5-year rule) are entirely tax-free.',
      long: 'Annual contribution limit $7K (2024, indexed). Income limits apply (single < $161K, MFJ < $240K). Contributions can be withdrawn at any time tax-free; earnings withdrawn before 59½ subject to penalty + tax. Conversions from Traditional accounts have a 5-year clock per conversion. NOT recognized by Japan — JP taxes Roth distributions as ordinary income.',
      category: 'us-tax',
      related: ['Roth Conversion', 'Backdoor Roth', 'Traditional IRA', 'RMD'],
    },
    'Roth 401(k)': {
      expansion: 'Roth 401(k)',
      short: 'Employer 401(k) plan contributions made post-tax; growth and qualified withdrawals tax-free. Higher contribution limit than Roth IRA, no income limits.',
      long: 'Up to the standard 401(k) limit ($23K + catch-up). No income limits like Roth IRA has. Subject to Rule of 55. Required for catch-up contributions of high earners under SECURE 2.0 Section 603 starting 2026.',
      category: 'us-tax',
      related: ['Roth IRA', 'Section 603', 'Rule of 55'],
    },
    'Traditional IRA': {
      expansion: 'Traditional Individual Retirement Account',
      short: 'Pre-tax US retirement account; contributions may be deductible; growth tax-deferred; withdrawals taxed as ordinary income.',
      long: 'Annual limit $7K. Subject to RMDs starting age 73. Withdrawals before 59½ subject to 10% penalty (Rule of 55 does NOT apply). Conversions to Roth allowed any time, with tax due on the converted amount.',
      category: 'us-tax',
      related: ['Roth IRA', 'Roth Conversion', 'RMD', '401(k)'],
    },
    '401(k)': {
      expansion: '401(k) employer-sponsored retirement plan',
      short: 'US employer-sponsored retirement plan, named for IRC section 401(k). Employee contributions are pre-tax (or Roth); employer match is pre-tax.',
      long: 'Employee deferral limit $23K (2024) + age-50+ catch-up. Employer contribution + employee deferral combined cap $69K. Subject to RMDs at 73 (Roth 401(k) exempt as of SECURE 2.0). Rule of 55 applies if you separate from the sponsor at 55+.',
      category: 'us-tax',
      related: ['Roth 401(k)', 'TSP', '403(b)', 'Rule of 55', 'SECURE 2.0'],
    },
    'TSP': {
      expansion: 'Thrift Savings Plan',
      short: 'The federal-employee equivalent of a 401(k) — for civilian federal workers, US military, and CIA employees.',
      long: 'TSP is the largest defined-contribution plan in the world. Same contribution limits as 401(k). Five core funds (G, F, C, S, I) plus L (lifecycle) funds. Roth TSP available. Federal Employees Retirement System (FERS) participants get a 5% employer match. Subject to RMDs at 73; Rule of 55 applies.',
      category: 'retirement',
      related: ['401(k)', 'SOFA', 'DoD'],
    },
    '403(b)': {
      expansion: '403(b) plan',
      short: 'Tax-deferred retirement plan for non-profit employees (schools, hospitals, religious organizations).',
      long: 'Similar to 401(k) but for 501(c)(3) organizations and public schools. Same contribution limits. May offer Roth option. Sometimes called a "tax-sheltered annuity" because historically annuity-only.',
      category: 'us-tax',
      related: ['401(k)', 'TSP'],
    },
    'HSA': {
      expansion: 'Health Savings Account',
      short: 'Triple-tax-advantaged US account: pre-tax contributions, tax-free growth, tax-free withdrawals for qualified medical expenses.',
      long: 'Requires enrollment in a high-deductible health plan (HDHP). 2024 limits: $4.15K self / $8.3K family + $1K age-55+ catch-up. After 65, non-medical withdrawals taxed as ordinary income (no penalty). Before 65, non-medical = 20% penalty + tax. Not recognized by Japan — JP taxes growth and withdrawals.',
      why: 'HSA is the most tax-efficient US account if you have an HDHP. But Japan ignores the wrapper — distributions during JP residency are JP-taxable.',
      category: 'us-tax',
      related: ['IRMAA', 'Medicare'],
    },
    'RSU': {
      expansion: 'Restricted Stock Unit',
      short: 'Employer compensation in the form of company shares that vest over time. Taxed as ordinary income at vest, then capital gains/loss on subsequent sale.',
      long: 'Common at tech companies. Taxed at vest based on FMV; tax withholding usually via "sell-to-cover" of vested shares. Subsequent sale generates capital gain/loss vs vest-date basis. For US persons in Japan, the Japan-source portion of the vest is JP-taxable based on workdays in Japan during the vest period.',
      why: 'RSU vesting after 住民票 registration creates split-source income that is taxable in both the US and Japan. Coordinate with employer payroll on the W-2 / 給与所得 split BEFORE 住民票.',
      category: 'us-tax',
      related: ['NSO', 'ISO', '給与所得'],
    },
    'NSO': {
      expansion: 'Non-qualified Stock Option',
      short: 'Stock option that taxes the bargain element (FMV minus strike price) as ordinary income at exercise.',
      long: 'Compared to ISOs, NSOs are simpler tax-wise but lose the AMT-deferral benefit. Subject to FICA. Common for non-employees (consultants, board members) and broad employee grants.',
      category: 'us-tax',
      related: ['ISO', 'RSU', 'AMT'],
    },
    'ISO': {
      expansion: 'Incentive Stock Option',
      short: 'Tax-advantaged stock option that defers tax until sale, with potential AMT impact at exercise.',
      long: 'Holding ISO shares 1+ years post-exercise AND 2+ years post-grant qualifies for LTCG treatment on the spread. Bargain element at exercise is an AMT preference item.',
      category: 'us-tax',
      related: ['NSO', 'AMT', 'LTCG'],
    },
    'AMT': {
      expansion: 'Alternative Minimum Tax',
      short: 'Parallel US tax system designed to ensure high-income filers pay a minimum. ISO exercise is a common trigger.',
      long: 'AMT recalculates taxable income with fewer deductions and preferences, then taxes it at 26%/28%. You owe the higher of regular tax or AMT.',
      category: 'us-tax',
      related: ['ISO', 'NIIT'],
    },
    'LTCG': {
      expansion: 'Long-Term Capital Gain',
      short: 'Profit from selling an investment held more than one year. Taxed at preferential US rates (0/15/20%).',
      long: 'Long-term = held more than 12 months. US LTCG rate depends on income: 0% in lowest brackets, 15% middle, 20% top. NIIT adds 3.8% above MAGI thresholds. Japan taxes LTCG at 20.315% (national + local) without preferential treatment.',
      category: 'us-tax',
      related: ['NIIT', 'Bracket Fill'],
    },
    'NIIT': {
      expansion: 'Net Investment Income Tax',
      short: 'A 3.8% US tax on investment income above MAGI thresholds ($200K single / $250K MFJ).',
      long: 'Applies to interest, dividends, capital gains, rental income, and royalties. Stacks on top of regular income tax + LTCG. Cannot be offset by foreign tax credit.',
      category: 'us-tax',
      related: ['LTCG', 'AMT'],
    },
    'IRMAA': {
      expansion: 'Income-Related Monthly Adjustment Amount',
      short: 'Higher Medicare Part B and Part D premiums for retirees with income above thresholds.',
      long: 'Determined from your tax return two years prior (2024 IRMAA based on 2022 income). Tiered surcharges from $0 to $400+/month per person above thresholds starting at $103K single / $206K MFJ.',
      why: 'A big income year (Roth conversion, RSU vest) two years before Medicare enrollment can spike your Part B premiums. Time conversions accordingly.',
      category: 'retirement',
      related: ['Medicare', 'RMD', 'Roth Conversion'],
    },
    'Medicare': {
      expansion: 'US Medicare program',
      short: 'US federal health insurance for age 65+ and certain disabilities. Part A (hospital) typically free; Part B (medical) ~$175+/month; Part D (drugs) varies.',
      long: 'Eligibility at 65 if you have 40+ quarters of Medicare-covered employment. Coordinates with US-Japan Totalization Agreement. Premiums increase via IRMAA for higher-income retirees. Does NOT cover medical care abroad except in specific border situations.',
      category: 'retirement',
      related: ['IRMAA', 'Social Security'],
    },
    'Social Security': {
      expansion: 'US Social Security retirement benefit',
      short: 'US federal retirement income program. Claim age 62-70; full retirement age (FRA) is 67 for those born 1960+.',
      long: 'Benefit is calculated from your highest 35 years of inflation-adjusted earnings. Claim early at 62 = ~70% of FRA benefit. Claim late at 70 = 124% of FRA benefit. SS is taxed as ordinary income above income thresholds. US-Japan totalization agreement prevents loss of benefits for splitting career between countries.',
      category: 'retirement',
      related: ['FRA', 'Medicare', 'Totalization Agreement'],
    },
    'FRA': {
      expansion: 'Full Retirement Age',
      short: 'The age at which you receive your full Social Security benefit — 67 for anyone born 1960 or later.',
      long: 'For folks born 1955-1959 the FRA gradually increases from 66 to 67. Claiming before FRA permanently reduces your benefit; claiming after FRA (up to 70) increases it 8% per year.',
      category: 'retirement',
      related: ['Social Security'],
    },
    'FBAR': {
      expansion: 'Report of Foreign Bank and Financial Accounts (FinCEN Form 114)',
      short: 'Annual US disclosure of foreign financial accounts when their aggregate maximum value during the year exceeded $10,000.',
      long: 'Required of US persons (citizens, green-card holders, residents) with signature authority over foreign accounts. Filed electronically with FinCEN by April 15 (auto-extended to October 15). Penalties for non-filing: $10K per non-willful violation, $129K or 50% of account balance per willful violation. The Taigan Bridge FBAR Tracker module helps you stay compliant.',
      why: 'If you have ANY Japanese bank or brokerage account and you\'re a US person, you almost certainly need to file FBAR every year.',
      category: 'us-tax',
      related: ['Form 8938', 'FATCA', 'FinCEN'],
      refs: [
        { label: 'FinCEN BSA filing', url: 'https://bsaefiling.fincen.treas.gov/' },
      ],
    },
    'Form 8938': {
      expansion: 'Statement of Specified Foreign Financial Assets',
      short: 'IRS form attached to your 1040 reporting foreign financial assets above thresholds. Separate from FBAR.',
      long: 'Required when aggregate foreign asset value exceeds: $50K single / $100K MFJ (US-resident); $200K single / $400K MFJ (foreign-resident). Year-end + max during year both matter. Penalties: $10K per failure, additional $50K for continued failure. Filed with your 1040, NOT with FinCEN.',
      category: 'us-tax',
      related: ['FBAR', 'FATCA'],
    },
    'FATCA': {
      expansion: 'Foreign Account Tax Compliance Act',
      short: 'US law requiring foreign financial institutions to report US-person account holders to the IRS.',
      long: 'Passed 2010. JP banks ask US persons to fill out a W-9 and disclose to the IRS via the Japanese government. Why some JP banks decline US-person customers entirely. Drives the need for Forms 8938 and 8621.',
      category: 'us-tax',
      related: ['FBAR', 'Form 8938'],
    },
    'Form 8621': {
      expansion: 'Information Return by a Shareholder of a PFIC',
      short: 'IRS form filed annually for each PFIC holding. CPA cost typically $300-500 per fund per year.',
      long: 'Required for any year you hold a PFIC. Three modes: default (excess distributions), QEF election (treat as flow-through), MTM election (mark-to-market annually). Each election has nuances; default mode is punitive. The form itself is so complex it\'s standard CPA territory.',
      category: 'us-tax',
      related: ['PFIC', 'NISA'],
    },
    'FEIE': {
      expansion: 'Foreign Earned Income Exclusion',
      short: 'Excludes up to ~$126K (2024) of foreign-earned income from US taxation if you meet residency tests.',
      long: 'Claimed on Form 2555. Two qualifying tests: bona fide residence (full tax year abroad) or physical presence (330 days in any 12-month period). Excludes earned income only, not investment income. Can\'t be used in conjunction with Foreign Tax Credit on the same income — usually FTC wins for high earners in Japan since JP rates exceed US rates.',
      why: 'Most US persons in Japan use FTC instead of FEIE because JP tax rates are higher than US — the FTC fully offsets US tax. FEIE is better only for low-income or zero-tax-jurisdiction folks.',
      category: 'us-tax',
      related: ['FTC', 'Article 17'],
    },
    'FTC': {
      expansion: 'Foreign Tax Credit',
      short: 'Dollar-for-dollar US credit for income taxes paid to a foreign country. Claimed on Form 1116.',
      long: 'For each US dollar of qualified foreign income tax paid, you get $1 of US tax credit. Separated into "baskets" — passive income, general income, etc. — each with its own limitation. Carryforward 10 years for unused credit. The cross-claim makes effective burden ≈ max(US rate, JP rate) rather than the sum.',
      category: 'us-tax',
      related: ['FEIE', 'Article 17'],
    },
    'Article 17': {
      expansion: 'US-Japan Tax Treaty Article 17 (Pensions)',
      short: 'Treaty article that, in theory, lets pensions be taxed only in the residence country. In practice, the US "saving clause" overrides it for US citizens.',
      long: 'Article 17 of the US-Japan Tax Treaty says pension income (incl. 401(k), IRA, Social Security) is taxable ONLY in the residence country. But the US saving clause in Article 1 allows the US to tax its citizens as if the treaty didn\'t exist. Effect: as a JP-resident US citizen, you owe tax in BOTH countries on pension distributions, then claim FTC to avoid double taxation.',
      category: 'us-tax',
      related: ['FTC', 'Saving Clause', 'Social Security'],
    },
    'Saving Clause': {
      expansion: 'US Tax Treaty Saving Clause',
      short: 'Boilerplate clause in every US tax treaty letting the US tax its citizens as if the treaty didn\'t exist.',
      long: 'Why US persons abroad still face US filing obligations. Carve-outs exist for specific articles (e.g., child support, certain SS benefits) but most income articles are overridden by the saving clause for US citizens.',
      category: 'us-tax',
      related: ['Article 17'],
    },
    'Form 1116': {
      expansion: 'Foreign Tax Credit (Individual)',
      short: 'IRS form claiming dollar-for-dollar credit for foreign income tax paid. Most JP-resident US persons use this instead of FEIE.',
      long: 'Filed with 1040. Each income category ("basket" — general, passive, lump-sum, certain re-sourced) gets its own Form 1116 with its own limitation. Excess foreign tax credit carries back 1 year, forward 10. JP marginal rates exceed US for most income above ¥7M, so FTC typically eliminates US tax entirely on foreign-earned income.',
      category: 'us-tax',
      related: ['FTC', 'FEIE', 'Form 2555'],
    },
    'Form 2555': {
      expansion: 'Foreign Earned Income Exclusion',
      short: 'IRS form claiming the FEIE. Excludes ~$126,500 (2024) of foreign earned income from US tax.',
      long: 'Either bona-fide-residence or physical-presence (330d/12mo) test. Election binding for 5 years if revoked. For most JP residents, FTC (Form 1116) is better — it doesn\'t cap, covers all income types, and JP tax rates fully offset US tax.',
      category: 'us-tax',
      related: ['FEIE', 'FTC', 'Form 1116'],
    },
    'Form 5471': {
      expansion: 'Information Return of US Persons w/ Foreign Corporation',
      short: 'IRS form required if you own ≥10% of a foreign corp (合同会社, 株式会社, GK, KK). Triggers GILTI computation.',
      long: 'One of the most punitive non-filing penalty regimes ($10K per form per year). Often required even when there\'s no taxable income (informational reporting). GILTI (Global Intangible Low-Taxed Income) regime can create phantom US income from undistributed foreign corp earnings. Specialist CPA territory — generalists frequently miss this.',
      category: 'us-tax',
      related: ['CFC', 'GILTI'],
    },
    'CFC': {
      expansion: 'Controlled Foreign Corporation',
      short: 'Foreign corporation more than 50%-owned by US persons (each holding ≥10%). Triggers Form 5471 + GILTI.',
      long: 'Even minority US ownership can create CFC status if the aggregate US ownership exceeds 50%. As a CFC shareholder, you owe US tax on certain undistributed earnings (Subpart F income, GILTI) annually. Most JP self-employed who form a 合同会社 or 株式会社 inadvertently create a CFC.',
      category: 'us-tax',
      related: ['Form 5471', 'GILTI'],
    },
    'GILTI': {
      expansion: 'Global Intangible Low-Taxed Income',
      short: 'TCJA-era anti-deferral regime taxing US persons on certain undistributed foreign corp earnings.',
      long: 'Originally aimed at multinational tax havens; small-business owners abroad got swept up. Effective rate is ~10.5-13.125% for C-corp shareholders (50% deduction); individuals get full 37% unless they make the §962 election. Computed on Form 8992. JP CFC shareholders often face surprise US tax bills under GILTI even when leaving everything in the JP entity.',
      category: 'us-tax',
      related: ['Form 5471', 'CFC'],
    },
    'ITIN': {
      expansion: 'Individual Taxpayer Identification Number',
      short: 'IRS-issued tax ID for non-US persons who need to file or be claimed on a US return. Issued via Form W-7.',
      long: 'Required for non-US-person spouses if you want to file MFJ via §6013(g) election, and for any non-US-person dependents you claim. Application requires certified copies of identity documents (passport). Usually 7-11 weeks processing. The ITIN expires after 3 consecutive non-use years.',
      category: 'us-tax',
      related: ['MFJ', 'MFS'],
    },
    'Totalization': {
      expansion: 'US-Japan Totalization Agreement',
      short: 'Bilateral treaty preventing double payment of social security / pension contributions.',
      long: 'Without totalization, a US citizen working in Japan could owe US Social Security AND Japanese 厚生年金 on the same wages. The treaty assigns coverage to ONE country based on residency / employer. JP-resident self-employed get a Japanese coverage certificate to avoid US SE tax. Cross-credits help meet minimum-quarter requirements for SS or 国民年金 benefit eligibility.',
      category: 'us-tax',
      related: ['SE Tax', '厚生年金', 'Social Security'],
    },
    'SE Tax': {
      expansion: 'Self-Employment Tax (US)',
      short: '15.3% US tax on self-employed earnings (Social Security + Medicare). Not excluded by FEIE.',
      long: 'Schedule SE. Even if FEIE excludes your foreign earned income from regular income tax, SE tax still applies. Mitigation for JP residents: get a Japanese coverage certificate under the totalization treaty — exempts you from US SE tax (because you\'re paying JP equivalent).',
      category: 'us-tax',
      related: ['Totalization', 'FEIE'],
    },
    'TCJA': {
      expansion: 'Tax Cuts and Jobs Act (2017)',
      short: 'Major US tax reform. Created GILTI, capped SALT deduction, expanded standard deduction, lowered corporate rates.',
      long: 'For US persons abroad: TCJA introduced GILTI (taxing undistributed foreign-corp earnings of US persons holding ≥10% of a CFC), tightened §965 transition tax on previously-deferred earnings, and raised the standard deduction (reducing the value of itemized deductions for many).',
      category: 'us-tax',
      related: ['GILTI', 'CFC'],
    },
    'Subpart F': {
      expansion: 'Subpart F Income (Anti-Deferral)',
      short: 'Pre-TCJA anti-deferral regime taxing CFC shareholders on certain passive / mobile income annually.',
      long: 'Sections 951-965 of the IRC. Taxes US shareholders of a CFC on pro-rata Subpart F income (passive income, sales/services to related parties, etc.) as if distributed, even when actually retained in the foreign corp. GILTI broadened this dramatically post-2017.',
      category: 'us-tax',
      related: ['CFC', 'GILTI', 'Form 5471'],
    },
    'FinCEN': {
      expansion: 'Financial Crimes Enforcement Network',
      short: 'US Treasury bureau that runs the BSA E-Filing system where FBAR is filed.',
      long: 'Distinct from the IRS, though both report to Treasury. FBAR (FinCEN 114) goes to FinCEN; Form 8938 (FATCA) goes to the IRS with your 1040. Two separate filings covering overlapping but not identical sets of foreign assets.',
      category: 'us-tax',
      related: ['FBAR', 'BSA E-Filing'],
    },
    'Form 4868': {
      expansion: 'Application for Automatic Extension of Time (1040)',
      short: 'IRS form requesting a 6-month extension to file your 1040 (to October 15). Does NOT extend time to PAY.',
      long: 'Filed by the original deadline (April 15 for domestic; June 15 for the automatic 2-month expat extension). Pushes the filing deadline to October 15. Estimated tax must still be paid by the original deadline to avoid interest + penalty. JP-resident expats often file 4868 to wait for their 確定申告 (March 15) before finalizing the FTC computation on their US return.',
      category: 'us-tax',
      related: ['FTC', '1040'],
    },
    'BSA E-Filing': {
      expansion: 'Bank Secrecy Act E-Filing System',
      short: 'FinCEN portal where FBAR (FinCEN 114) is filed. Separate from IRS — you cannot file FBAR with your 1040.',
      long: 'bsaefiling.fincen.treas.gov. Free, no account required for individual filers. Returns a confirmation number (BSA ID) you should save with your tax records.',
      category: 'us-tax',
      related: ['FBAR', 'FinCEN'],
    },
    '6013(g) Election': {
      expansion: 'IRC §6013(g) — Spouse Treated as US Resident',
      short: 'Election letting a US person file MFJ with a non-US-person spouse. Subjects the spouse\'s worldwide income to US tax.',
      long: 'Once made, the election binds for all subsequent years until revoked, and revocation triggers a 5-year bar on re-electing. The non-US spouse needs an ITIN. Frequently a TRAP for JP-spouse couples — JP-resident spouses commonly hold 投資信託 / 学資保険 / 確定拠出年金 which all become PFICs once the spouse is in the US system. Run the math both ways (MFJ vs MFS) before electing.',
      category: 'us-tax',
      related: ['MFJ', 'MFS', 'ITIN', 'PFIC'],
    },
    'CLN': {
      expansion: 'Certificate of Loss of Nationality',
      short: 'State Department certificate documenting loss of US citizenship. Issued 6-12 months after consulate renunciation appointment.',
      long: 'Form DS-4083. Required documentation that you\'re no longer a US person — banks (US and foreign) often request a copy. Without a CLN, you remain a US person for tax purposes regardless of intent. Note: your expatriation date is the date of the renunciation OATH, not the date the CLN is later issued. Filing of Form 8854 with the IRS is separately required to formally exit the US tax system.',
      category: 'us-tax',
      related: ['Form 8854', 'Renunciation'],
    },
    'Form 8854': {
      expansion: 'Initial and Annual Expatriation Statement',
      short: 'IRS form filed by a US person renouncing citizenship or surrendering green card. Establishes covered-expatriate status + computes exit tax.',
      long: 'Filed with the final dual-status return for the year of expatriation, due Apr 15 of the following year. Reports your worldwide net worth (for the $2M covered-expatriate test), 5y average tax (~$206K threshold in 2025; inflation-adjusted), and certifies 5y of tax compliance. Failing to file Form 8854 (or filing incorrectly) is itself one of the three covered-expatriate triggers, regardless of net worth or tax level.',
      category: 'us-tax',
      related: ['CLN', 'Renunciation', 'Exit Tax'],
    },
    'Renunciation': {
      expansion: 'Renouncing US Citizenship',
      short: 'Voluntary, irrevocable exit from US citizenship. Requires consulate appointment + DS-4079/4080/4081 + $450 DOS fee (since April 13, 2026; was $2,350 from 2014-2026).',
      long: 'Process: schedule embassy/consulate appointment (wait times range from a few weeks to several months by post), execute DS-4079 (questionnaire) + DS-4080 (oath of renunciation) + DS-4081 (statement of understanding), pay $450 fee. CLN (DS-4083) is approved by the State Department in Washington and arrives several months later. The fee was raised from $450 to $2,350 in 2014, then reduced back to $450 effective April 13, 2026 (Federal Register doc 2026-04931). NO retroactive refunds for those who paid $2,350. Separate from the IRS exit tax (Form 8854 + §877A mark-to-market on covered expatriates). Re-naturalization is theoretically possible but treated as any new immigrant — no special path. The Reed Amendment can bar re-entry for tax-motivated renunciants (rarely enforced).',
      category: 'us-tax',
      related: ['CLN', 'Form 8854', 'Exit Tax', 'Wagner v. Blinken'],
    },
    'Exit Tax': {
      expansion: 'IRC §877A Mark-to-Market Exit Tax',
      short: 'Tax imposed on covered expatriates as if all assets were sold the day before expatriation.',
      long: 'Applies only to covered expatriates ($2M net worth, OR ~$206K avg 5y US tax, OR failed 5y compliance certification on Form 8854). Mark-to-market gain above the §877A exclusion (~$890K in 2025, indexed annually) is taxed at applicable rates. Some assets get special treatment: deferred comp can elect 30% withholding instead, certain trusts deferred until distribution. Deferral of payment available with security posting + interest charge. POST-expatriation: gifts or bequests from a covered expat to a US-person recipient trigger §2801 transfer tax — at the highest gift/estate rate (currently 40%) — on the RECIPIENT, not the giver. This often dwarfs the exit tax for covered expats with US-citizen heirs.',
      category: 'us-tax',
      related: ['Renunciation', 'Form 8854'],
    },
    'Wagner v. Blinken': {
      expansion: 'Wagner v. Blinken (D.D.C. 2023)',
      short: 'Class-action lawsuit by the Association of Accidental Americans challenging the $2,350 renunciation fee. Resolved by State Dept rule reducing the fee to $450 effective April 13, 2026.',
      long: 'Filed by the Association of Accidental Americans, challenging the 2014 fee hike from $450 to $2,350 as unlawful under the Administrative Procedure Act and disproportionate under the Eighth Amendment. After a multi-year procedural fight, the State Department published a final rule (Federal Register doc 2026-04931, March 13, 2026) reducing the fee back to $450 effective April 13, 2026. The State Department EXPRESSLY rejected calls for retroactive refunds, fee waivers, or limited-means relief — anyone who paid $2,350 between 2014 and April 2026 cannot recover the difference. Useful precedent for understanding government accountability for arbitrary fee-setting; less useful for those who already paid.',
      category: 'us-tax',
      related: ['Renunciation'],
    },
    'Reed Amendment': {
      expansion: 'Reed Amendment (1996, INA §212(a)(10)(E))',
      short: 'Statute barring former US citizens who renounced for tax-avoidance purposes from re-entering the US.',
      long: 'On its face, makes any tax-motivated renunciant inadmissible. In practice, almost never enforced — DHS lacks a workable mechanism to determine a renunciant\'s motive, and the State Department has historically refused to share Form 8854 data with DHS. Cited in renunciation literature as a theoretical risk worth knowing about; not a practical bar for most renunciants.',
      category: 'us-tax',
      related: ['Renunciation'],
    },
    '529': {
      expansion: '529 Education Savings Plan',
      short: 'US state-sponsored tax-advantaged account for "qualified higher education expenses" at "eligible educational institutions" (FSA-listed schools).',
      long: 'Earnings grow tax-free; withdrawals tax-free for qualified expenses. ELIGIBLE INSTITUTION = school with a Federal School Code in the US Department of Education FSA database (lookup at studentaid.gov). Most major Japanese universities (Tokyo, Kyoto, Waseda, Keio, Sophia) are NOT on this list. Non-qualified withdrawal mechanics: ONLY the earnings portion is penalized — 10% federal penalty on earnings + ordinary income tax on earnings + possible state recapture. Principal contributions come back tax/penalty-free (you contributed after-tax dollars). The hit therefore scales with how long the account grew. JP-eligible options are short (Temple Japan, Lakeland Japan, a handful more). Workarounds for JP-resident families that avoid the penalty: change the beneficiary to a US-resident relative, save for room/board at an FSA-eligible school, roll up to $35K to the beneficiary\'s Roth IRA (SECURE 2.0), or accept the earnings-portion penalty. K-12 use is also restricted to US K-12 schools.',
      category: 'us-tax',
      related: ['学資保険', 'PFIC'],
    },
    'FSA': {
      expansion: 'Federal Student Aid (US Dept of Education)',
      short: 'US federal student-aid program. A school is "529-eligible" only if it has an FSA Federal School Code.',
      long: 'studentaid.gov maintains the FAFSA school code lookup. International schools must independently apply and qualify for FSA participation — a small number of foreign universities do (mostly with US-affiliated programs). For JP-resident families, the practical impact is that 529 plans are useless for most Japanese-domestic universities; verify the school code BEFORE assuming 529 will cover JP tuition.',
      category: 'us-tax',
      related: ['529'],
    },
    'CRBA': {
      expansion: 'Consular Report of Birth Abroad',
      short: 'Official US documentation of citizenship for a child born abroad to a US-citizen parent.',
      long: 'Filed at the US embassy/consulate, ideally within the child\'s first year. Requires evidence of parent\'s US citizenship + transmission requirements (physical presence in US: 5y for one US-citizen parent, including 2y after age 14). The CRBA serves as a US birth certificate for passport and SSN purposes.',
      category: 'us-tax',
      related: ['INA §301(g)'],
    },
    'INA §301(g)': {
      expansion: 'Immigration & Nationality Act §301(g) — Citizenship Transmission',
      short: 'Statute governing US citizenship transmission to children born abroad to one US-citizen parent.',
      long: 'For a child born abroad to one US-citizen + one non-US-citizen parent: the US-citizen parent must have been physically present in the US for at least 5 years before the child\'s birth, INCLUDING 2 years after age 14. Falls short → child does NOT acquire US citizenship at birth. Plan teenage years carefully if your child might later have kids abroad.',
      category: 'us-tax',
      related: ['CRBA', 'INA §322'],
    },
    'INA §322': {
      expansion: 'Immigration & Nationality Act §322 — Naturalization for Foreign-Born Children',
      short: 'Path to US citizenship for foreign-born children of US-citizen parents who don\'t qualify under §301(g).',
      long: 'A US-citizen parent of a foreign-born child can apply for naturalization while the child is under 18, IF a US-citizen GRANDPARENT meets the 5y physical presence rule. Useful when the parent didn\'t accumulate enough US presence themselves but the grandparent did. Application is N-600K + traveling to the US for the oath.',
      category: 'us-tax',
      related: ['INA §301(g)', 'CRBA'],
    },
    'TOD': {
      expansion: 'Transfer-on-Death',
      short: 'US-only beneficiary designation that transfers a brokerage/bank account directly to a named person on death — bypasses probate entirely.',
      long: 'Standard at US brokerages (Schwab, Fidelity, Vanguard) and many US banks. Asset moves to beneficiary by operation of law, no will needed for that account, no probate fees, no court delay. JP financial institutions almost universally do NOT recognize TOD/POD — for JP-situs accounts you need a will or 家族信託 instead. Free to set up, can be changed anytime, and overrides any conflicting will provision for that specific account.',
      category: 'us-tax',
      related: ['POD', 'JTWROS', 'Probate'],
    },
    'POD': {
      expansion: 'Pay-on-Death',
      short: 'Bank-account version of TOD. Beneficiary named on the account receives the balance directly on death.',
      long: 'Identical mechanics to TOD but used for bank accounts (checking, savings, CDs) rather than brokerage. Same rules: US-only, free to set up, override wills for that account, bypass probate. JP banks essentially never offer POD — joint accounts in Japan are rare and don\'t carry survivorship rights.',
      category: 'us-tax',
      related: ['TOD', 'JTWROS', 'Probate'],
    },
    'JTWROS': {
      expansion: 'Joint Tenancy With Right of Survivorship',
      short: 'US joint-ownership form where the surviving owner takes the entire asset by operation of law on the other\'s death.',
      long: 'Standard at US brokerages and possible at some US banks (depending on state). Distinct from "tenancy in common" where each owner\'s share goes through probate. JP banks generally do NOT offer JTWROS — joint accounts in Japan are rare and pass per the will/intestacy rather than auto-survivorship. For US-situs only.',
      category: 'us-tax',
      related: ['TOD', 'POD', 'Probate'],
    },
    'Probate': {
      expansion: 'Probate / Court-Supervised Estate Administration',
      short: 'Court process to validate a will (or apply intestacy) and oversee asset distribution to heirs.',
      long: 'In the US: handled by the surrogate/probate court of the decedent\'s domicile state. Length: weeks to years depending on state and complexity. Avoidable for individual assets via TOD/POD, JTWROS, beneficiary designations, or revocable living trust. In Japan: 家庭裁判所 handles intestate cases or unauthenticated wills. 公正証書遺言 (notarized JP will) bypasses 家庭裁判所 検認 entirely — banks and the 法務局 accept it directly.',
      category: 'us-tax',
      related: ['TOD', 'JTWROS', '公正証書遺言'],
    },
    '§2801': {
      expansion: 'IRC §2801 — Transfer Tax on Gifts/Bequests from Covered Expatriates',
      short: '40% tax on US-person recipients of gifts or bequests from a covered-expatriate former US citizen.',
      long: 'Created by HEART Act 2008 alongside §877A exit tax. The economic burden falls on the RECIPIENT (your US-person heirs), not on the covered expatriate. Rate equals the highest gift/estate tax rate (currently 40%). For those renouncing US citizenship who intend to leave assets to US-citizen children/spouse, this often dwarfs the §877A exit tax itself. Plan around it: distribute pre-renunciation, or distribute to non-US-person heirs.',
      category: 'us-tax',
      related: ['Renunciation', 'Exit Tax'],
    },
    'LPR': {
      expansion: 'Lawful Permanent Resident (US Green Card)',
      short: 'US permanent resident status. Same tax obligations as US citizens (worldwide income, FBAR, FATCA).',
      long: 'Long-term LPRs (held green card in 8 of last 15 years) face the same exit-tax regime as renouncing citizens when they formally surrender the card via Form I-407. Just letting it expire abroad doesn\'t legally end LPR status — the I-407 surrender or an immigration judge order is required to start the tax exit clock.',
      category: 'us-tax',
      related: ['Renunciation', 'Form 8854'],
    },
    'Bona Fide Residence': {
      expansion: 'Bona Fide Residence Test (Form 2555)',
      short: 'One of two FEIE qualifying tests. Requires you to be a resident of a foreign country for an uninterrupted full tax year.',
      long: 'More flexible than the Physical Presence test for long-term expats: trips back to the US don\'t break the test as long as you maintain a bona fide foreign tax home and intent to remain. Once established, you generally remain "bona fide resident" for as long as you live abroad.',
      category: 'us-tax',
      related: ['FEIE', 'Physical Presence', 'Form 2555'],
    },
    'Physical Presence': {
      expansion: 'Physical Presence Test (Form 2555)',
      short: 'One of two FEIE qualifying tests. Requires 330 full days physically outside the US in any rolling 12-month period.',
      long: 'Counted in 24-hour days; partial days don\'t count. Days in international airspace / waters DO count as foreign. Pure mechanical test — useful for first-year arrivals and short-term assignments where Bona Fide Residence isn\'t yet established.',
      category: 'us-tax',
      related: ['FEIE', 'Bona Fide Residence', 'Form 2555'],
    },
    'Totalization Agreement': {
      expansion: 'US-Japan Totalization Agreement',
      short: 'Bilateral agreement that lets you combine US Social Security and Japanese 厚生年金 quarters to qualify for benefits in either country.',
      long: 'Signed 2005. If you have <40 US quarters, JP credits can fill the gap. Also prevents double Social Security tax — you only pay into the system of the country where you primarily work.',
      category: 'retirement',
      related: ['Social Security', '厚生年金'],
    },
    '72(t) SEPP': {
      expansion: '72(t) Substantially Equal Periodic Payments',
      short: 'IRS provision that lets you take penalty-free distributions from an IRA before 59½ via a fixed-formula schedule.',
      long: 'Three IRS-approved formulas for calculating annual distributions. Once started, must continue for 5 years OR until 59½, whichever is later — interrupting triggers retroactive 10% penalty + interest on all prior distributions. Useful for early retirees who don\'t qualify for Rule of 55 (because Rule of 55 only applies to 401(k), not IRA).',
      category: 'retirement',
      related: ['Rule of 55', 'Traditional IRA'],
    },
    'Section 121': {
      expansion: 'IRC Section 121 — Home Sale Exclusion',
      short: 'Excludes up to $250K (single) / $500K (MFJ) of capital gain from sale of your primary US residence.',
      long: 'Must have owned and used the home as primary residence for 2 of the last 5 years. Once-every-2-years frequency cap. NOT recognized by Japan — JP taxes the gain post-住民票 with its own (often punitive) JPY-basis recomputation.',
      why: 'If you have a US home with significant unrealized gain, sell it BEFORE 住民票 registration to claim §121 at US-only tax cost.',
      category: 'us-tax',
      related: ['LTCG', '住民票'],
    },

    // ── JAPAN TERMS ──────────────────────────────────────────────────
    '住民票': {
      expansion: 'juminhyou — Japanese Resident Registration Card',
      short: 'The official Japanese resident registration. Marks the binary line where you become a Japan tax resident.',
      long: 'Filed at your local 市役所 (city office) when you take up residence in Japan. SOFA-status individuals are NOT registered as residents and instead use military ID. Once 住民票 is filed, you become a Japan tax resident, subject to Japanese national + local taxes on worldwide income, NHI premiums, and the 5/10/year residency clocks for exit tax / inheritance tax.',
      why: 'For US expats, 住民票 registration is THE event that switches the tax math. Pre-住民票: most distributions and gains are US-tax-only. Post-住民票: Japan ALSO taxes them, often at higher rates and without recognizing US tax wrappers (Roth, HSA, §121).',
      category: 'jp-tax',
      related: ['住民税', 'SOFA', '出国税', 'NHI'],
    },
    '住民税': {
      expansion: 'juminze — Japanese Resident Tax',
      short: 'Japan local tax (~10% combined prefectural + municipal), assessed on prior-year income, paid in current year.',
      long: 'Calculated from your prior-year taxable income reported on 確定申告 or by your employer. Usually paid via salary deduction or in 4 installments. Lags income by a year — a big income year drives the next year\'s 住民税 up.',
      category: 'jp-tax',
      related: ['住民票', 'NHI', '確定申告'],
    },
    '出国税': {
      expansion: 'shukokuze — Japan Exit Tax',
      short: 'Tax on unrealized gains in financial securities when leaving Japan, if you held ¥100M+ and were resident 5+ of last 10 years.',
      long: 'Treats your departure as if you sold all financial securities at exit at FMV. Tax rate is the standard 20.315% securities rate. Includes US-domiciled holdings. Defer-and-bond-posting available — gain not taxed if you return within 5 years and reverse the deemed sale. Plan portfolio composition to stay under threshold OR exit before the 5-year clock.',
      category: 'jp-tax',
      related: ['住民票', 'LTCG'],
    },
    '給与所得': {
      expansion: 'kyuyo shotoku — Japan Employment Income',
      short: 'Wage / salary income for Japanese tax purposes, calculated after employee-equivalent deductions.',
      long: 'JP payroll system reduces gross salary by 給与所得控除 (a standardized employment-expense deduction) before calculating taxable income. RSU vests count as 給与所得 to the extent of Japan workdays during the vesting period.',
      category: 'jp-tax',
      related: ['RSU', '住民税'],
    },
    'ふるさと納税': {
      expansion: 'Furusato Nozei — Hometown Tax Donation',
      short: 'Japanese tax-deductible donation system. Donate to a JP municipality, get rice/wagyu/sake gifts, deduct from JP resident tax.',
      long: 'Donations to participating municipalities reduce your 住民税 + 所得税 dollar-for-dollar above a ¥2,000 floor. You receive a "thank-you gift" worth ~30% of the donation. Annual limit depends on your prior-year income (calculator at furusato-tax.jp). Available to US persons — it\'s a charitable contribution, not an investment, so no PFIC issue.',
      why: 'One of the few traditional Japanese tax-saving strategies that works cleanly for US-person residents.',
      category: 'jp-tax',
      related: ['住民税'],
    },
    '投資信託': {
      expansion: 'toshi shintaku — Japanese Mutual Fund',
      short: 'Japanese-domiciled pooled investment vehicle. Treated as PFIC under US tax law.',
      long: 'Common building block of NISA and iDeCo holdings. Even index-fund versions of these JP-domiciled products are PFICs from the US perspective. The cure: use US-domiciled equivalents (VT, VTI, VXUS) held in US brokerages.',
      category: 'jp-tax',
      related: ['PFIC', 'NISA', 'iDeCo'],
    },
    '定額貯金': {
      expansion: 'teigaku chokin — Japan Post fixed-amount savings',
      short: 'A Japan Post Bank time deposit. 6-month lockup, then can be redeemed any time within 10-year max term.',
      long: 'Common in older Japanese accounts. Earns a fixed rate posted at deposit. The "secondary date" on the deposit row is the lockup-expiry (deposit date + 6 months) — NOT the maturity date. The true maturity is on a separate payment row.',
      category: 'jp-banking',
      related: [],
    },

    // ── INVESTING / GENERAL ──────────────────────────────────────────
    'SOFA': {
      expansion: 'Status of Forces Agreement',
      short: 'US-Japan agreement giving US military, DoD civilians, and certain DoD contractors special legal status while stationed in Japan.',
      long: 'SOFA-status individuals are NOT Japanese tax residents and don\'t register 住民票. They use military ID, file US taxes only, and are exempt from JP NHI / 厚生年金. Status is tied to military orders or DoD employment. Family members generally derive status from the principal.',
      why: 'SOFA status is the foundation of the SOFA Roth Sequencing strategy: while SOFA, you\'re US-tax-only; transitioning out of SOFA and into 住民票 registration triggers Japanese tax on distributions / conversions.',
      category: 'sofa',
      related: ['住民票', 'DoD', 'TSP'],
    },
    'DoD': {
      expansion: 'United States Department of Defense',
      short: 'US executive department for military operations. Employer of military, civilian, and contractor personnel under SOFA in Japan.',
      category: 'sofa',
      related: ['SOFA', 'TSP'],
    },
    'NHI': {
      expansion: '国民健康保険 — National Health Insurance',
      short: 'Japan\'s public health insurance for non-employee residents. Premiums calculated on prior-year income.',
      long: 'JP-resident workers in companies enroll in 健康保険; everyone else (self-employed, retirees, freelancers) enrolls in NHI via their municipality. NHI premium calculated annually each June from prior-year income — capped around ¥1M/year per person but the cap is reached at modest income levels. Non-residents (SOFA included) are exempt.',
      why: 'A big income year (Roth conversion, RSU vest) drives the following year\'s NHI premium up. Time large income events to minimize NHI cliff effects.',
      category: 'jp-tax',
      related: ['住民票', '住民税', 'Medicare'],
    },
    '厚生年金': {
      expansion: 'kosei nenkin — Japanese Employees\' Pension',
      short: 'Japan\'s workplace pension. Combined with 国民年金 forms the public pension system.',
      long: 'Mandatory for company employees. Combined employee+employer rate ~18.3% of standard monthly compensation. Benefits paid from age 65 (gradually rising). US-Japan Totalization Agreement lets you combine 厚生年金 quarters with US Social Security quarters.',
      category: 'jp-tax',
      related: ['Totalization Agreement', 'Social Security', 'iDeCo'],
    },
    '永住権': {
      expansion: 'eijuken — Japanese Permanent Residency',
      short: 'Permanent resident status in Japan. Removes visa-renewal requirements but does not affect tax treatment.',
      long: 'Granted typically after 10 years residency (less for spouses and high-skilled professionals). Doesn\'t change tax residency status — that\'s based on physical presence, not visa type.',
      category: 'jp-tax',
      related: ['住民票'],
    },
    'TIPS': {
      expansion: 'Treasury Inflation-Protected Securities',
      short: 'US Treasury bonds whose principal adjusts with CPI inflation. Marketable Treasury security.',
      category: 'investing',
      related: ['Treasury', 'Series I'],
    },
    'Backdoor Roth': {
      expansion: 'Backdoor Roth IRA Strategy',
      short: 'A way for high earners (above Roth income limits) to fund a Roth IRA via a Traditional IRA contribution + immediate conversion.',
      long: 'Step 1: Contribute to a non-deductible Traditional IRA (no income limit). Step 2: Convert to Roth (no income limit on conversions). Tax cost: zero IF you have NO other pre-tax IRA balances (the pro-rata rule taxes part of the conversion if you do).',
      category: 'us-tax',
      related: ['Roth IRA', 'Roth Conversion', 'Mega Backdoor Roth'],
    },
    'Mega Backdoor Roth': {
      expansion: 'Mega Backdoor Roth Strategy',
      short: 'Plan-sponsored after-tax 401(k) contributions, immediately converted to Roth — fills the $69K total 401(k) limit with Roth money.',
      long: 'Requires (a) employer plan permits after-tax contributions, (b) plan permits in-service Roth conversions (in-plan or to a Roth IRA). Lets high earners convert up to ($69K - employee deferral - employer match) into Roth annually.',
      category: 'us-tax',
      related: ['Roth IRA', 'Backdoor Roth', '401(k)'],
    },
    'Series I': {
      expansion: 'Series I US Savings Bond',
      short: 'US Treasury savings bond with a fixed rate + inflation-adjustment kicker. Federal-tax-deferred until redemption.',
      long: 'Sold via TreasuryDirect.gov. $10K/year per person purchase limit (+$5K via tax refund). 30-year maximum holding. Interest exempt from state/local tax. Federal tax can be deferred until redemption OR reported annually.',
      category: 'investing',
      related: ['TIPS'],
    },

    // ── Phase 4 additions ───────────────────────────────────────────
    'MAGI': {
      expansion: 'Modified Adjusted Gross Income',
      short: 'Your AGI plus certain add-backs (foreign earned income exclusion, tax-exempt interest, etc.). Drives multiple income-based phaseouts.',
      long: 'Used to determine eligibility/limits for: Roth IRA contributions, NIIT, IRMAA, traditional IRA deductibility, premium tax credits, student loan interest deduction. Each program has slightly different add-backs, but for projection purposes we approximate it as: taxable income + Roth conversions + 85% of Social Security benefits.',
      why: 'A "big income year" (Roth conversion, RSU vest, large distribution) drives up MAGI and can trigger NIIT, IRMAA, or kick you out of Roth eligibility. Time large income events to manage MAGI.',
      category: 'us-tax',
      related: ['NIIT', 'IRMAA', 'Roth IRA', 'Roth Conversion'],
    },
    'AGI': {
      expansion: 'Adjusted Gross Income',
      short: 'Your gross income minus "above-the-line" deductions (HSA contributions, traditional IRA contributions, etc.). The starting point for many tax calculations.',
      long: 'Reported on line 11 of Form 1040. Lower than gross income, higher than taxable income (which subtracts the standard or itemized deduction from AGI).',
      category: 'us-tax',
      related: ['MAGI'],
    },
    'COLA': {
      expansion: 'Cost-of-Living Adjustment',
      short: 'Annual inflation adjustment to Social Security benefits, IRS contribution limits, tax brackets, and most government benefits.',
      long: 'SSA computes COLA each October from the 3rd-quarter CPI-W. Recent COLAs: 8.7% (2023), 3.2% (2024), 2.5% (2025). The Projections engine applies a configurable ss_cola_pct (default 2.5%) to your SS benefit each year of distribution.',
      category: 'retirement',
      related: ['Social Security', 'CPI'],
    },
    'CPI': {
      expansion: 'Consumer Price Index',
      short: 'BLS\'s primary measure of US inflation, published monthly. Drives COLA, tax bracket adjustments, and many indexed thresholds.',
      long: 'Two main variants: CPI-U (urban consumers, the headline number) and CPI-W (urban wage earners, used for SS COLA). Long-term US inflation runs 2-3% on average; recent volatility (2021-2023) saw 4-9% prints.',
      category: 'investing',
      related: ['COLA', 'TIPS', 'Series I'],
    },
    'MFJ': {
      expansion: 'Married Filing Jointly',
      short: 'US tax filing status for married couples filing one combined return. Higher brackets and credits than single filers.',
      long: 'MFJ thresholds are roughly 2× single in lower brackets but compress in higher brackets ("marriage penalty"). NIIT threshold $250K (vs $200K single); Roth IRA phaseout $230K-$240K (vs $146K-$161K single); standard deduction $29.2K (vs $14.6K single, 2024).',
      category: 'us-tax',
      related: ['MFS', 'NIIT', 'Roth IRA'],
    },
    'MFS': {
      expansion: 'Married Filing Separately',
      short: 'US tax filing status for married couples filing two separate returns. Usually less favorable than MFJ but sometimes optimal for non-resident-spouse situations.',
      long: 'Common reason to choose MFS: spouse is a non-US person and you don\'t want to subject their income to US tax. Loses many credits (most education credits, EITC, etc.) and uses tighter Roth IRA phaseouts ($0-$10K).',
      category: 'us-tax',
      related: ['MFJ'],
    },
    'HoH': {
      expansion: 'Head of Household',
      short: 'US tax filing status for unmarried filers who maintain a household for a qualifying dependent. Better brackets than Single.',
      category: 'us-tax',
      related: ['MFJ'],
    },
    'FICA': {
      expansion: 'Federal Insurance Contributions Act',
      short: 'US payroll tax: 6.2% Social Security + 1.45% Medicare. Employer matches.',
      long: 'Social Security portion capped at $168,600 (2024) wage base. Medicare uncapped + additional 0.9% for high earners ($200K+ single, $250K+ MFJ).',
      category: 'us-tax',
      related: ['Social Security', 'Medicare'],
    },
    'TSA': {
      expansion: 'Tax-Sheltered Annuity',
      short: 'Older name for the 403(b) plan.',
      category: 'retirement',
      related: ['403(b)'],
    },
    'QEF': {
      expansion: 'Qualified Electing Fund',
      short: 'PFIC tax election to treat foreign fund income as if it were a US partnership — flows through annually.',
      long: 'Most favorable PFIC election but requires the fund to provide an annual PFIC Statement, which Japanese funds essentially never do. Hence default mode (excess distributions) is the practical reality for most US persons holding JP funds.',
      category: 'us-tax',
      related: ['PFIC', 'Form 8621'],
    },
    'MTM': {
      expansion: 'Mark-to-Market Election',
      short: 'PFIC tax election to treat the fund as if sold at year-end FMV every year. Available only for "marketable" PFICs.',
      long: 'Annual gains taxed as ordinary income (not LTCG); annual losses limited. Less punitive than default but still loses the LTCG preference and basis step-up.',
      category: 'us-tax',
      related: ['PFIC', 'QEF', 'Form 8621'],
    },
    // ── Japan inheritance tax — sub-set added with Phase 4 audit ──
    '相続税': {
      expansion: 'sozokuze — Japanese Inheritance Tax',
      short: 'Japan\'s inheritance tax. Among the world\'s most aggressive: 10-55% progressive rates with low thresholds.',
      long: 'Tax-free threshold = ¥30M base + ¥6M per statutory heir. For a typical family of 4 (spouse + 2 kids): ¥30M + 3×¥6M = ¥48M (~$315K) before any tax. Rates are progressive: 10% under ¥10M taxable → 55% over ¥600M. Foreign nationals: applies only to JP-situs assets for the first 10 years of residency, then expands to worldwide assets.',
      why: 'For long-term JP-resident US persons with US 401(k)/IRA/brokerage holdings, this is THE single largest tax exposure in retirement planning. Multiple legal mitigation strategies exist — see the Inheritance tax mitigation section in the Tax Strategy tab.',
      category: 'jp-tax',
      related: ['生前贈与', '配偶者控除', '養子縁組', '小規模宅地等の特例', '路線価', '住民票'],
      refs: [
        { label: 'NTA inheritance tax overview', url: 'https://www.nta.go.jp/english/taxes/individual/12010.htm' },
      ],
    },
    '生前贈与': {
      expansion: 'seizen zoyo — Lifetime Gifting',
      short: 'Transferring assets during your lifetime to reduce the eventual inheritance tax base.',
      long: 'The two main paths in Japan: (1) 暦年贈与 — annual ¥1.1M tax-free per donor-recipient pair, indefinite duration. (2) 相続時精算課税 — elect the "settlement at inheritance" system: ¥25M lifetime gift tax-free, but those gifts are added back to the estate at death. The annual exemption typically wins for long-horizon planning; settlement system wins for one-time large gifts to a specific heir.',
      why: 'The most powerful "I have time" mitigation: a couple gifting ¥1.1M to each of 2 children annually for 20 years removes ¥44M from the estate, potentially saving ¥10M+ in inheritance tax. Subject to a 7-year lookback rule (gifts within 7 years of death are pulled back) — start early.',
      category: 'jp-tax',
      related: ['相続税', '暦年贈与', '相続時精算課税'],
    },
    '暦年贈与': {
      expansion: 'rekinen zoyo — Annual Gift Tax Exemption',
      short: 'Each donor-recipient pair gets ¥1.1M/year of tax-free gift transfer in Japan.',
      long: 'No reporting required if under ¥1.1M. Above ¥1.1M, gift tax of 10-55% applies (similar to inheritance tax bands). Couple gifting to a child = ¥2.2M/year tax-free. To grandchildren = additional ¥1.1M each. Critical caveat: gifts within 7 years of donor\'s death are pulled back into the estate (extended from 3 years by 2024 reform). Start gifting at least 8 years before expected death.',
      category: 'jp-tax',
      related: ['生前贈与', '相続時精算課税'],
    },
    '相続時精算課税': {
      expansion: 'sozokuji seisan kazei seido — Settlement at Time of Inheritance Taxation System',
      short: 'Optional system for gifts ≥60-year-olds to ≥18-year-olds: ¥25M lifetime gift tax-free, added back to estate at death.',
      long: 'Once elected for a specific donor-recipient pair, you cannot revert to the annual ¥1.1M exemption with that pair. Valuation at gift time, not death — useful when the asset is expected to appreciate (lock in lower valuation now). After 2024 reform, ¥1.1M/year additional exemption available alongside the ¥25M lifetime cap (the new annual exemption is NOT added back to the estate). Best for gifting growth assets early.',
      category: 'jp-tax',
      related: ['生前贈与', '暦年贈与', '相続税'],
    },
    '配偶者控除': {
      expansion: 'haigūsha kōjo — Spouse Inheritance Deduction',
      short: 'Surviving spouse pays NO inheritance tax on inherited assets up to ¥160M OR 50% of total estate, whichever is greater.',
      long: 'The single most generous inheritance tax provision in Japan. Available only to the legal spouse (not common-law partners). Strategy nuance: leaving everything to the spouse defers but does not eliminate inheritance tax — the spouse\'s eventual death triggers a "second inheritance" (二次相続) on those same assets, often at higher effective rates because the heirs are now adult children with no spouse-deduction protection. Optimal split is often 60/40 or 50/50 spouse-vs-children rather than 100% spouse.',
      category: 'jp-tax',
      related: ['相続税', '生前贈与'],
    },
    '小規模宅地等の特例': {
      expansion: 'shōkibo takuchi tō no tokurei — Small Residential Property Special Exception',
      short: 'Reduces taxable valuation of inherited residential land by 80% (up to 330m²) when the heir continues to live there.',
      long: 'Conditions: heir must be the spouse OR a co-resident child OR a non-homeowner child ("家なき子" — "homeless child" rule). The property must be the deceased\'s primary residence. Holding period requirement (must keep until tax filing deadline). Also applies (50% reduction, up to 200m²) to land used for the family business. Combined with other exemptions, can dramatically reduce inheritance tax on a Tokyo home.',
      why: 'A ¥200M Tokyo home becomes valued at ¥40M for inheritance tax purposes — potentially saving ¥50M+ in inheritance tax. Often the deciding factor in whether children should keep or sell the family home.',
      category: 'jp-tax',
      related: ['相続税', '路線価'],
    },
    '養子縁組': {
      expansion: 'yōshi engumi — Adoption (for inheritance tax purposes)',
      short: 'Legally adopting a person adds them to your statutory heirs, increasing the base deduction (¥6M per heir) and life-insurance exemption (¥5M per heir).',
      long: 'Limit: only 1 adopted child counts toward statutory heirs if you have biological children; 2 if you don\'t. Common practice: adopting a grandchild (孫養子) — note this triggers a 20% surcharge on that grandchild\'s inheritance tax, but the family-level base deduction increase often more than offsets. Also bypasses one generation of inheritance taxation. Adoption IS a real legal status in Japan with legal/social consequences beyond tax — consult a 税理士 + lawyer.',
      category: 'jp-tax',
      related: ['相続税'],
    },
    '路線価': {
      expansion: 'rosenka — Roadside Land Price (NTA-published valuation)',
      short: 'NTA-published per-square-meter land valuation along each road, used to value real estate for inheritance and gift tax. Typically 70-80% of market value.',
      long: 'Published annually each July; effective for January-December of the same year. NTA aims for rosenka to be ~80% of "publicly assessed land price" (公示地価), which itself trails actual transaction prices. Combined with the 30% rental-property reduction (賃貸割合) on income-producing real estate, JP real estate is valued at 40-60% of market price for inheritance tax — a key reason wealthy Japanese families hold real estate in retirement.',
      category: 'jp-tax',
      related: ['相続税', '小規模宅地等の特例'],
    },
    '二次相続': {
      expansion: 'niji sozoku — Secondary Inheritance',
      short: 'The inheritance triggered when the surviving spouse dies, transferring the same assets that previously avoided tax via the spouse deduction.',
      long: 'Often produces higher effective tax than the first inheritance because: (1) no spouse to claim the spouse deduction, (2) one fewer statutory heir reducing the base deduction, (3) any appreciation since first inheritance is taxed. Optimal strategy in many cases is to NOT use the full spouse deduction in the first inheritance — split assets so children get some via first inheritance to flatten the two-stage burden.',
      category: 'jp-tax',
      related: ['配偶者控除', '相続税'],
    },
    '確定申告': {
      expansion: 'kakutei shinkoku — Japan annual tax return',
      short: 'Annual Japan income tax filing for the prior calendar year. Window: February 16 — March 15.',
      long: 'Required for: self-employed, those with multiple employers, those with foreign-source income (US persons usually), those wanting to claim deductions not handled by year-end adjustment (医療費控除, ふるさと納税, 住宅ローン控除, 雑損控除, etc.). File via e-Tax (online) or paper to your local 税務署. Late filing penalty: 5-15% delinquent tax + interest. US persons in Japan must reconcile JP income with US 1040 — claim Foreign Tax Credit on US side for JP tax paid.',
      why: 'For US-person JP residents: filing 確定申告 is the JP-side leg of dual-country tax compliance. Coordinate with your US CPA so the FTC math (Form 1116) lines up with what you reported in JP.',
      category: 'jp-tax',
      related: ['住民税', '住民票', 'FTC', 'ふるさと納税', '住宅ローン控除'],
      refs: [
        { label: 'NTA 確定申告 overview', url: 'https://www.nta.go.jp/taxes/shiraberu/shinkoku/' },
      ],
    },
    '住宅ローン控除': {
      expansion: 'jūtaku rōn kōjo — Mortgage tax credit',
      short: 'Annual JP income tax credit of 0.7% of year-end home loan balance, for first 13 years of a primary-residence mortgage. Cap depends on property type.',
      long: '2024 caps (loan amount eligible for the 0.7% credit): standard new construction ¥30M, 長期優良住宅 (long-term excellent housing) ¥45M, 省エネ住宅 (energy-efficient) ¥40M. Used home: lower caps + 10-year window. Claimed via 確定申告 in year 1, then via 年末調整 (year-end adjustment) by employer in years 2-13. Available to US persons (no PFIC issue — it\'s a tax credit, not an investment).',
      category: 'jp-tax',
      related: ['確定申告'],
    },
    '非永住者': {
      expansion: 'hi-eijūsha — Non-Permanent Resident (tax status)',
      short: 'Japan tax status for the FIRST 5 of any 10-year window of residency. Foreign-source income NOT remitted to Japan is exempt from JP tax during this period.',
      long: 'Different from immigration "Permanent Resident" — this is a TAX classification. For US persons: years 1-5 of JP residency, you can keep US dividends/capital gains/interest in US accounts (not remitted to JP) and they\'re JP-tax-exempt. Year 6 onward you become 永住者 (tax-permanent), and worldwide income is fully JP-taxable. Plan large US-source income events (Roth conversions, LTCG realization) BEFORE year 6 to maximize this window.',
      why: 'Major planning lever for US persons in years 1-5 of JP residency. Combined with the SOFA pre-住民票 window (if applicable), you may have a multi-year runway for US-tax-only Roth conversions and LTCG harvesting.',
      category: 'jp-tax',
      related: ['永住者', '住民票', 'Roth Conversion'],
    },
    '永住者': {
      expansion: 'eijūsha — Permanent Resident (tax status)',
      short: 'Japan tax status from year 6 of residency. ALL worldwide income becomes JP-taxable. (Note: this is the TAX status, not the immigration permanent residency 永住権.)',
      long: 'Different from 永住権 (immigration PR visa). The 5-year non-permanent resident rule expires automatically — no application needed. Once 永住者 for tax purposes, all worldwide income (US dividends, JP salary, foreign rental, etc.) is JP-taxable. Foreign Tax Credit available on JP side for foreign-source taxes paid (mirrors US FTC).',
      category: 'jp-tax',
      related: ['非永住者', '永住権'],
    },
    '源泉徴収票': {
      expansion: 'gensen chōshūhyō — Withholding tax statement',
      short: 'Japan equivalent of US W-2. Issued by employer in January for the prior calendar year. Required for 確定申告 if filing.',
      long: 'Shows: gross income, tax withheld at source, year-end adjustment (年末調整) result, applied deductions, dependents claimed. Multiple jobs = multiple 源泉徴収票. For US-person filers, this is what you reconcile against your US W-2 / 1099 to compute foreign-source income for FTC purposes.',
      category: 'jp-tax',
      related: ['確定申告', '住民税'],
    },
    '医療費控除': {
      expansion: 'iryōhi kōjo — Medical expense deduction',
      short: 'JP income tax deduction for unreimbursed medical expenses exceeding ¥100,000 (or 5% of income, whichever is lower) per household per year.',
      long: 'Family-aggregated. Includes prescription drugs, transportation to medical facilities, dental, some over-the-counter (セルフメディケーション税制 alternative). Claimed via 確定申告 with receipts. Save ALL medical receipts throughout the year if you might exceed the threshold.',
      category: 'jp-tax',
      related: ['確定申告', 'NHI'],
    },

    '税理士': {
      expansion: 'zeirishi — Licensed Japanese Tax Accountant',
      short: 'Japan\'s licensed tax professional. Required for any complex inheritance tax planning or filing.',
      long: 'Different from a US CPA — zeirishi are tax-only specialists licensed by the National Tax Agency. Typical inheritance tax engagement runs ¥500K-¥2M+ depending on estate size and complexity. Only zeirishi can sign and file inheritance tax returns. Many also handle real estate registration (登記), trust setup, and family succession planning.',
      category: 'jp-tax',
      related: ['相続税', '住民票'],
    },

    // ── Veteran / military terms ───────────────────────────────────
    'VA': {
      expansion: 'US Department of Veterans Affairs',
      short: 'Federal department administering benefits for US veterans — disability compensation, healthcare, education, home loans, life insurance, survivor benefits.',
      long: 'For Asia-Pacific veterans, the VA Manila Regional Office handles benefit claims. The Foreign Medical Program (FMP) covers service-connected care abroad. Direct VA healthcare facilities in Japan are limited; most care is fee-basis through Japanese providers.',
      category: 'sofa',
      related: ['DD-214', 'FMP', 'TRICARE', 'GI Bill'],
      refs: [
        { label: 'VA.gov main', url: 'https://www.va.gov/' },
        { label: 'VA Manila RO', url: 'https://www.va.gov/manila-regional-benefit-office/' },
      ],
    },
    'DD-214': {
      expansion: 'Certificate of Release or Discharge from Active Duty (DD Form 214)',
      short: 'The single most important US military document — proof of service, character of discharge, dates, and earned awards. Required for almost every VA benefit claim.',
      long: 'Issued at separation. Two versions: short-form (member copy) for general use, long-form (member copy 4) showing character of discharge and reason for separation — the long form is what the VA requires. If lost, request a replacement via the National Archives (eVetRecs system, free, 4-12 week turnaround).',
      why: 'For Japan-resident vets: keep a scanned copy in your Document Vault AND a paper copy in a known location. If you die without it accessible, your survivors lose access to DIC, VA life insurance proceeds, and burial benefits.',
      category: 'sofa',
      related: ['VA', 'DIC'],
      refs: [
        { label: 'eVetRecs replacement DD-214', url: 'https://www.archives.gov/veterans/military-service-records' },
      ],
    },
    'TRICARE': {
      expansion: 'TRICARE military health insurance',
      short: 'US Department of Defense health program for active duty, retirees, and their dependents. TRICARE Overseas Program (TOP) covers OCONUS (outside continental US).',
      long: 'Active duty in Japan: TRICARE Prime Remote / Overseas Prime. Retirees in Japan: TRICARE Select Overseas (file claims for reimbursement) or TRICARE for Life if Medicare-eligible. SOFA-status non-retirees lose TRICARE 180 days after end of orders unless retired.',
      why: 'For Japan-resident retirees: TRICARE Select Overseas operates as a reimbursement program — pay Japanese providers cash, file claims, get reimbursed. Keep all receipts in Document Vault.',
      category: 'sofa',
      related: ['VA', 'FMP', 'Medicare'],
      refs: [
        { label: 'TRICARE Overseas Program', url: 'https://tricare.mil/Plans/HealthPlans/TOP' },
      ],
    },
    'FMP': {
      expansion: 'VA Foreign Medical Program',
      short: 'VA program that pays foreign providers (or reimburses you) for treatment of VA-rated service-connected conditions outside the US.',
      long: 'Only covers conditions the VA has rated as service-connected. Doesn\'t cover non-SC conditions, dependents, or routine care. You can use any qualified Japanese provider — no network restriction. Submit claims via VA Manila or by mail. Reimbursement, not direct billing.',
      why: 'For Japan-resident vets with even a single SC condition: enroll in FMP. Most providers won\'t bill the VA directly, so you pay cash and submit reimbursement claims yourself.',
      category: 'sofa',
      related: ['VA', 'TRICARE'],
      refs: [
        { label: 'FMP overview', url: 'https://www.va.gov/COMMUNITYCARE/programs/veterans/FMP/index.asp' },
      ],
    },
    'GI Bill': {
      expansion: 'GI Bill (Post-9/11 Ch. 33 / Montgomery Ch. 30)',
      short: 'US education benefit for veterans. Post-9/11 GI Bill is the modern version — pays tuition, housing allowance, and a books stipend for 36 months at an approved school.',
      long: 'Post-9/11 (most common today): full in-state public tuition + monthly housing allowance + $1K/yr books stipend, transferable to spouse/children if you transfer while still on active duty (you must serve 4 more years after the transfer request). Pre-2013 dischargees have a 15-year delimitation date; post-2013 dischargees benefit from the Forever GI Bill (no expiration). Yellow Ribbon program covers tuition over the in-state cap at participating private schools.',
      why: 'For Japan-resident vets: most US schools have foreign-study programs. Some Japanese universities accept GI Bill (must be VA-approved). Online US degrees work fully.',
      category: 'sofa',
      related: ['VA', 'DD-214'],
      refs: [
        { label: 'GI Bill comparison', url: 'https://www.va.gov/education/about-gi-bill-benefits/post-9-11/' },
      ],
    },
    'SGLI': {
      expansion: 'Servicemembers\' Group Life Insurance',
      short: 'Low-cost group term life insurance for active duty and drilling reserve. Default coverage is the maximum $400,000.',
      long: 'Premium ~$25/mo for $400K coverage. Covers active duty, ready reserve, members of the Commissioned Corps. Also pays $100K for spouse coverage. Auto-enrolled at maximum on accession. You can opt out or reduce coverage in $50K increments. Coverage ends 120 days after separation.',
      category: 'sofa',
      related: ['VGLI', 'DIC'],
    },
    'VGLI': {
      expansion: 'Veterans\' Group Life Insurance',
      short: 'Post-separation continuation of SGLI. Convert SGLI → VGLI within 240 days of separation with no medical underwriting.',
      long: 'Critical timing: within 240 days of separation, you can convert SGLI to VGLI WITHOUT any medical questions, up to your SGLI amount (max $400K). Day 240-485 you can still convert but must answer medical questions and may be denied. After day 485 the option is permanently lost. Premiums are age-based and increase every 5 years — affordable through ~age 60, expensive after. Most vets eventually convert to civilian term life.',
      why: 'For ANY separating servicemember: even if you don\'t need the coverage now, the no-medical 240-day window is irreplaceable insurance optionality. Converting and dropping later is reversible; missing the window is not.',
      category: 'sofa',
      related: ['SGLI', 'VA'],
    },
    'DIC': {
      expansion: 'Dependency and Indemnity Compensation',
      short: 'Tax-free monthly payment to surviving spouse / children of a service member who died in service OR a veteran who died of a service-connected condition.',
      long: 'Base 2024 rate: $1,612.75/mo for surviving spouse, +$300/mo per dependent child. Available regardless of how long ago the qualifying death occurred. NOT taxable as US federal income.',
      category: 'sofa',
      related: ['SGLI', 'VGLI', 'VA'],
    },
    'IU': {
      expansion: 'Individual Unemployability (TDIU)',
      short: 'A VA benefit that pays disability compensation at the 100% rate even if your combined rating is below 100%, when service-connected conditions prevent you from working.',
      long: 'Eligibility: at least one SC condition rated 60%+, OR two+ SC conditions with combined rating 70%+ and at least one rated 40%+. Plus inability to maintain substantially gainful employment due to SC conditions. "Marginal employment" (under federal poverty line) doesn\'t disqualify. Significant income increase: 100% rate vs e.g. 70% rate is roughly +$1,200/mo tax-free in 2024.',
      category: 'sofa',
      related: ['VA'],
    },
    'TDIU': {
      expansion: 'Total Disability based on Individual Unemployability',
      short: 'Same as IU — full name of the benefit.',
      category: 'sofa',
      related: ['IU', 'VA'],
    },
    'COE': {
      expansion: 'Certificate of Eligibility (VA Home Loan)',
      short: 'Document confirming you qualify for a VA home loan. Required to use VA loan benefit for a home purchase or refinance.',
      long: 'Request via VA.gov\'s online portal or through your lender. Typical turnaround: instant for active duty/recent separations, 1-2 weeks otherwise. The benefit can be used for US property only — not for purchasing Japanese real estate.',
      category: 'sofa',
      related: ['VA', 'DD-214'],
    },
    'SBP': {
      expansion: 'Survivor Benefit Plan',
      short: 'Election made AT military retirement to continue 55% of your pension to your spouse after you die. Premium ~6.5% of pension.',
      long: 'A one-shot decision at retirement: opt in (default) and your spouse gets 55% of your pension for life. Opt out and they get $0 — but you must have spouse-signed concurrence to decline. Premium continues for 30 years OR until death. Once paid in full at 30 years (paid-up), the SBP coverage continues for free. Children-only coverage and former-spouse coverage are also options.',
      why: 'For Japan-resident retirees: SBP payments to a JP-resident surviving spouse are deposited to the JP bank like the original pension. Subject to JP income tax under residence-state rule + US under saving clause; FTC offsets.',
      category: 'sofa',
      related: ['VGLI', 'DIC', 'CRDP', 'CRSC'],
      refs: [
        { label: 'DFAS SBP overview', url: 'https://www.dfas.mil/RetiredMilitary/provide/sbp/' },
      ],
    },
    'CRDP': {
      expansion: 'Concurrent Retirement and Disability Pay',
      short: 'Lets military retirees with 50%+ VA disability rating receive BOTH full retirement pay AND VA disability comp — no offset.',
      long: 'Pre-2004 rule: military retirement pay was reduced dollar-for-dollar by VA disability comp. CRDP eliminates the offset for retirees rated 50%+. Auto-enrolled — no application required. Phased in 2004-2014; now fully implemented. Significantly increases retiree income for those with both 20+ years AND a meaningful disability rating.',
      category: 'sofa',
      related: ['CRSC', 'VA', 'IU'],
    },
    'CRSC': {
      expansion: 'Combat-Related Special Compensation',
      short: 'Tax-free monthly payment to retirees with combat-related disabilities — alternative to CRDP, useful for those rated <50%.',
      long: 'Available for combat-related disabilities (combat zone, hazardous service, instrumentality of war, simulating war). Unlike CRDP, you can elect CRSC at any rating level. Tax-free. You can\'t collect CRDP and CRSC simultaneously — must elect one annually. Use VA\'s comparison calculator to choose.',
      category: 'sofa',
      related: ['CRDP', 'VA'],
    },
    'USERRA': {
      expansion: 'Uniformed Services Employment and Reemployment Rights Act',
      short: 'Federal law guaranteeing civilian re-employment rights, seniority, and benefits when reservists or National Guard return from active service.',
      long: 'Civilian employer must re-employ you in the same or comparable position after activation up to 5 years cumulative. Health insurance continuation (COBRA-like) for up to 24 months. Pension contributions credited as if you\'d been at work. Discrimination protection. Enforced by US Department of Labor.',
      category: 'sofa',
      related: ['SCRA'],
      refs: [
        { label: 'USERRA overview', url: 'https://www.dol.gov/agencies/vets/programs/userra' },
      ],
    },
    'VR&E': {
      expansion: 'Vocational Rehabilitation & Employment (Chapter 31)',
      short: 'VA program that pays full tuition + housing + employment services for vets with service-connected disabilities. Often more generous than the GI Bill.',
      long: 'Eligibility: 20%+ VA disability rating + employment handicap related to SC condition. Benefits: full tuition (NO cap, unlike Post-9/11), monthly housing allowance (BAH-equivalent), all books + supplies, vocational counseling, job placement. Up to 48 months of training. 12+ year window from separation. Must apply via VA.gov.',
      why: 'Higher-rated separated vets often miss this — VR&E pays significantly more than the Post-9/11 GI Bill at expensive private schools (no tuition cap = full ride at any approved program).',
      category: 'sofa',
      related: ['VA', 'GI Bill'],
      refs: [
        { label: 'VR&E program', url: 'https://www.va.gov/careers-employment/vocational-rehabilitation/' },
      ],
    },
    'BRS': {
      expansion: 'Blended Retirement System',
      short: 'Modern military retirement (post-2018 entrants OR opted-in 2018 transitioners). Combines a smaller pension (40% at 20yr) with TSP matching (5%) + continuation pay.',
      long: 'Pre-2018 entrants stayed under "High-3" / Final Pay (50%+ pension at 20yr, no TSP match). 2018 entrants forward are auto-enrolled in BRS. Mid-career service members (entered 2006-2017) had a one-time choice in 2018. BRS is portable (TSP) but pays less in pension form. Continuation pay = bonus at 12-year mark to keep folks in service.',
      category: 'sofa',
      related: ['TSP', 'CRDP'],
    },
    'BAH': {
      expansion: 'Basic Allowance for Housing',
      short: 'Tax-free monthly housing stipend for active duty service members. Rate set by duty location ZIP code + dependency status + rank.',
      long: 'In Japan, BAH is replaced by OHA (Overseas Housing Allowance) which reimburses ACTUAL rent up to a per-location cap rather than paying a flat amount. OHA includes utility allowance + move-in housing allowance for first-month deposits and key money.',
      category: 'sofa',
      related: ['BAS', 'OHA'],
    },
    'BAS': {
      expansion: 'Basic Allowance for Subsistence',
      short: 'Tax-free monthly food stipend. Paid to all enlisted unless on subsistence-in-kind (mess hall coverage).',
      long: '2024 rates: ~$460/mo enlisted, ~$320/mo officer. Continues regardless of duty location. Always tax-free.',
      category: 'sofa',
      related: ['BAH'],
    },
    'OHA': {
      expansion: 'Overseas Housing Allowance',
      short: 'BAH equivalent for service members stationed outside CONUS. Reimburses actual rent (up to a cap) rather than paying a flat amount.',
      long: 'Includes Utility/Recurring Maintenance Allowance (URMA) and Move-In Housing Allowance (MIHA) for one-time costs (key money / 礼金, deposit / 敷金, agent fees common in Japan rentals).',
      category: 'sofa',
      related: ['BAH', 'SOFA'],
    },
    'SCRA': {
      expansion: 'Servicemembers Civil Relief Act',
      short: 'Federal protections for active duty: 6% interest cap on pre-service debts, lease termination rights for orders, foreclosure protection, default judgment protection.',
      long: 'Trigger: entry onto active duty. The 6% cap applies retroactively — bank/credit-card must reduce your rate AND refund the difference upon notice + orders. Lease termination requires written notice + orders. Auto repossession + mortgage foreclosure stays available without court process.',
      category: 'sofa',
      related: ['USERRA'],
    },
    'TFL': {
      expansion: 'TRICARE for Life',
      short: 'TRICARE benefit for Medicare-eligible retirees (age 65+). Acts as secondary to Medicare.',
      long: 'Free enrollment (must have Medicare Parts A + B). Medicare pays first; TFL covers most of what Medicare doesn\'t. CRITICAL caveat for Japan: Medicare does NOT cover care abroad except in narrow border cases. TFL alone covers care overseas under TRICARE Overseas rules — file claims for reimbursement.',
      category: 'sofa',
      related: ['TRICARE', 'Medicare', 'IRMAA'],
    },
    'TOP': {
      expansion: 'TRICARE Overseas Program',
      short: 'TRICARE plans for active-duty / retiree / family members living outside the US.',
      long: 'Includes TRICARE Prime Overseas (active-duty + family in designated areas), TRICARE Select Overseas (retirees, fee-for-service), and TRICARE Overseas Program coverage in remote locations. Mostly cashless at participating providers in major Japanese cities; otherwise pay cash and submit claims via the TOP claims processor (International SOS / WPS) for 100% reimbursement (active duty) or after copay (retiree / family).',
      category: 'sofa',
      related: ['TRICARE', 'TFL'],
    },
    'USFHP': {
      expansion: 'US Family Health Plan',
      short: 'TRICARE Prime alternative offered by 6 designated non-profit health systems in specific US regions only.',
      long: 'Not available outside the US — irrelevant for Japan-based retirees but worth knowing about if planning a US repatriation to one of the served regions (parts of WA, NY, MA, MD, TX, ME). Typically lower out-of-pocket than TRICARE Select.',
      category: 'sofa',
      related: ['TRICARE'],
    },
    'IEP': {
      expansion: 'Initial Enrollment Period (Medicare)',
      short: '7-month window around your 65th birthday: 3 months before, the birthday month, and 3 months after.',
      long: 'Missing the IEP doesn\'t bar enrollment but creates lifetime late-enrollment penalties for Part B (10% of premium per 12 months delayed) and Part D (1% per month delayed). The General Enrollment Period (Jan-Mar each year) is the fallback, but the penalties stick. JP-resident expats often miss the IEP because they don\'t realize the deadline is independent of where they live.',
      category: 'us-tax',
      related: ['Medicare', 'IRMAA'],
    },
    'DNR': {
      expansion: 'Do Not Resuscitate',
      short: 'Medical order to forgo CPR and other resuscitation if your heart stops or you stop breathing.',
      long: 'Made via your advance directive (生前指示書) and ideally also a portable medical order (POLST in the US, similar JP forms). Different from "withdrawing all care" — you can be DNR but still receive comfort care, antibiotics, surgery, etc. For cross-border families, document in both languages and make sure your medical proxy knows.',
      category: 'us-tax',
      related: ['Advance Directive'],
    },
    'Advance Directive': {
      expansion: 'Advance Healthcare Directive',
      short: 'Document specifying medical wishes for situations where you can\'t communicate (vegetative state, severe dementia, terminal illness).',
      long: 'Two main components: (1) the living will — your specific wishes about life support, feeding tubes, DNR; (2) durable power of attorney for healthcare — naming who decides for you. JP residents should consider both US and JP versions: 生前指示書 / リビング・ウィル on the JP side, state-specific advance directive on the US side. Without one, JP medical defaults often skew aggressive; US defaults vary by state.',
      category: 'us-tax',
      related: ['DNR', 'POA'],
    },
    '介護保険': {
      expansion: 'Long-term Care Insurance (Japan)',
      short: 'Japan\'s universal long-term care insurance system. Mandatory at age 40+; premium auto-deducted via NHI/SHI.',
      long: 'Two enrollee categories: (1) ages 40-64, premium-only, eligible only for specific aging-related conditions; (2) ages 65+, full eligibility. Care levels assigned by 介護認定審査会 (municipal LTC certification committee): 要支援1-2 (lighter support) and 要介護1-5 (heavier care). Services include home help, day care, residential care, assistive devices. 10% copay (20% for higher-income); no copay for poverty-level enrollees. JP-resident US persons typically skip US private LTC insurance because 介護保険 covers most needs.',
      category: 'jp',
      related: ['NHI', '高額療養費'],
    },

    'WEP': {
      expansion: 'Windfall Elimination Provision (REPEALED Jan 2025)',
      short: 'Pre-2025 SSA rule that reduced US Social Security by up to 50% for those also receiving a pension from non-SS-covered work (incl. JP 厚生年金).',
      long: 'Repealed by the Social Security Fairness Act, signed Jan 2025, with retroactive effect to Jan 2024. For decades WEP forced JP-pension recipients (and US state/local pension recipients) to take large reductions on US SS. Now: full SS for everyone, regardless of foreign or non-covered pensions. SSA is processing back-pay; affected retirees should verify benefit recalculation via SSA.gov/myaccount.',
      category: 'us-tax',
      related: ['GPO', 'Fairness Act', 'Social Security'],
    },
    'GPO': {
      expansion: 'Government Pension Offset (REPEALED Jan 2025)',
      short: 'Pre-2025 SSA rule that reduced spousal/survivor SS benefits by 2/3 of any non-covered pension. Often eliminated spousal benefits entirely.',
      long: 'Repealed alongside WEP by the Social Security Fairness Act (Jan 2025). Affected JP-resident widows/widowers + retirees with US state/local pensions. Like WEP, retroactive to Jan 2024 — back-pay being processed by SSA.',
      category: 'us-tax',
      related: ['WEP', 'Fairness Act'],
    },
    'Fairness Act': {
      expansion: 'Social Security Fairness Act (Jan 2025)',
      short: 'Bipartisan law that repealed both WEP and GPO. Roughly 3M US retirees affected; ~$200B cost over 10 years.',
      long: 'Signed into law January 2025 with retroactive effect to January 2024. Eliminates the SS reductions that previously applied to recipients of "non-covered" pensions (foreign government pensions like 厚生年金, US state/local government pensions, etc.). For JP-residing US persons receiving 厚生年金, this means full US SS benefits going forward AND back-pay for the WEP/GPO amount withheld since Jan 2024.',
      category: 'us-tax',
      related: ['WEP', 'GPO', 'Social Security'],
    },
    'QCD': {
      expansion: 'Qualified Charitable Distribution',
      short: 'Direct transfer from IRA to qualified charity, available to IRA owners age 70½+. Counts toward RMD; reduces AGI.',
      long: 'Up to $108,000 (2025; indexed) per year per person can be transferred directly from a Traditional IRA to a 501(c)(3) charity. The amount is excluded from AGI (reduces tax better than itemizing) AND counts toward your RMD requirement. Especially valuable for those whose RMD would push them into higher Medicare IRMAA tiers or NIIT. Requires direct transfer (custodian → charity); doing it as personal withdrawal then donation forfeits the QCD treatment.',
      category: 'us-tax',
      related: ['RMD', 'IRMAA'],
    },
    'COBRA': {
      expansion: 'Consolidated Omnibus Budget Reconciliation Act',
      short: 'US law allowing former employees to continue employer health coverage for 18mo (sometimes 36mo) at full premium + 2% admin fee.',
      long: 'Useful as a healthcare bridge between employment and Medicare (or relocation). Can be elected from abroad — coverage continues per the plan terms. Often expensive ($1,500-$2,500/mo for family coverage typical). For JP-bound retirees: usually replaced after first 18mo with private international (CIGNA, Aetna) or NHI / SHI.',
      category: 'us-tax',
      related: ['ACA', 'Medicare'],
    },
    'ACA': {
      expansion: 'Affordable Care Act / Marketplace',
      short: 'US health insurance exchange — only available when residing in the US. PTC subsidies based on income.',
      long: 'Healthcare.gov plans with Premium Tax Credit (PTC) subsidies based on income relative to federal poverty level. Available only to US residents — does not work as overseas coverage. JP residents: irrelevant unless repatriating before Medicare eligibility. The Inflation Reduction Act extended enhanced PTCs through 2025.',
      category: 'us-tax',
      related: ['PTC', 'COBRA', 'Medicare'],
    },
    'PTC': {
      expansion: 'Premium Tax Credit (ACA)',
      short: 'Income-based subsidy on ACA Marketplace health insurance premiums. Reconciled on Form 8962 with the 1040.',
      long: 'For US residents enrolled in ACA Marketplace coverage. Sliding scale based on household income vs federal poverty level. Available either as advance credit (reducing monthly premium) or as a refundable credit on the 1040. Estimating income wrong → tax bill at filing time. Not available to overseas residents.',
      category: 'us-tax',
      related: ['ACA'],
    },
    '§988': {
      expansion: 'IRC §988 — Foreign Currency Transactions',
      short: 'Treats personal foreign-currency holdings as ordinary income/loss when converted, not capital gains.',
      long: 'When you hold JPY and later convert it back to USD, the gain/loss vs your USD basis is ORDINARY income (not capital). For frequent converters or large positions this matters: gains taxed at marginal rate (up to 37% federal), losses fully deductible against ordinary income. Personal-use exception ($200/transaction) covers small everyday FX. Document basis if you cycle large amounts USD↔JPY.',
      category: 'us-tax',
      related: ['FX'],
    },
    '日米地位協定': {
      expansion: 'US-Japan Status of Forces Agreement (SOFA)',
      short: 'Bilateral treaty governing the legal status of US military personnel + DoD civilians + contractors in Japan.',
      long: 'Among other things, exempts SOFA-status individuals from JP NHI/SHI enrollment requirements + JP residency tax in some cases. The exemption is tied to your specific SOFA status; it ends when you transition to a non-SOFA visa (work visa, spouse visa, etc.) — which is typically when 住民票 registration becomes appropriate.',
      category: 'sofa',
      related: ['SOFA', '住民票'],
    },
    '§121': {
      expansion: 'IRC §121 — Sale of Principal Residence Exclusion',
      short: 'Excludes up to $250K (single) / $500K (MFJ) of gain on sale of primary residence. Requires 2-of-5-year ownership + use test.',
      long: 'One of the largest individual tax breaks. Available once every 2 years. Both spouses must meet the use test for the $500K MFJ amount; only one needs to meet the ownership test. Partial exclusion available for "qualifying reasons" (job change ≥50mi, health, unforeseen circumstances) — pro-rated by months of qualified use. Depreciation taken during any rental period IS recaptured separately at 25% (§1250 unrecaptured gain) even when §121 fully shelters the rest.',
      category: 'us-tax',
      related: ['§1250', 'Schedule E'],
    },
    '§469': {
      expansion: 'IRC §469 — Passive Activity Loss Rules',
      short: 'Limits deduction of passive activity losses (mostly rental real estate) to passive income. Up to $25K of rental loss deductible against ordinary income if AGI ≤ $100K.',
      long: '$25K allowance phases out completely by $150K AGI. Real estate professionals (>50% of work time + 750 hours/yr in real estate) escape the limit. Suspended losses carry forward indefinitely until passive income generated OR property fully disposed (sold to non-related party) — at which point all suspended losses release. Critical for passive landlords planning a sale.',
      category: 'us-tax',
      related: ['Schedule E', 'AGI'],
    },
    '§1250': {
      expansion: 'IRC §1250 — Depreciation Recapture on Real Property',
      short: 'On sale of depreciated real estate, the depreciation portion of the gain is taxed at the "unrecaptured §1250 gain" rate of 25% (capped).',
      long: 'Applies even when §121 primary-residence exclusion fully shelters the rest of the gain. The "allowed or allowable" doctrine — the IRS treats you as having taken depreciation whether you actually claimed it or not, so always claim it during the rental period. Combined with state tax + JP capital gains for cross-border sellers can be substantial. Form 4797 + Schedule D mechanics on the US side.',
      category: 'us-tax',
      related: ['§121', 'Schedule E'],
    },
    'Schedule E': {
      expansion: 'IRS Schedule E — Supplemental Income and Loss',
      short: 'IRS form for reporting rental real estate, royalties, partnership/S-corp income, trust income.',
      long: 'For rental property: one column per property. Report gross rents minus operating expenses (repairs, mgmt fees, insurance, supplies, utilities, etc.) + depreciation + mortgage interest. Net flows to Form 1040. Net rental income is PASSIVE under §469 — losses limited unless you qualify as real-estate professional. Different from Schedule C (active business income).',
      category: 'us-tax',
      related: ['§469', '§1250'],
    },
    'JIRA': {
      expansion: 'Joint Individual Retirement Account',
      short: 'Common informal name for an IRA owned by one spouse, often referenced when discussing IRA strategy in MFJ context. Note: each IRA is individually owned (the I in IRA), there is no actually "joint" IRA.',
      category: 'us-tax',
      related: ['Traditional IRA', 'Roth IRA'],
    },
  };

  // Build a sorted list of match patterns longest-first so multi-word
  // terms match before their components ("Roth Conversion" before
  // "Roth IRA" before "Roth"). Matches are case-sensitive — acronyms
  // and proper-noun terms only.
  const SORTED_KEYS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

  // Escape regex special chars for literal matching.
  function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Combined regex. Word-boundary on the OUTSIDE so we don't match
  // mid-word (e.g., "PFIC" should not match inside "PFICabc"). For
  // CJK terms we don't need word boundaries — kanji aren't word chars
  // in JS regex — but the outer (?:^|...) (?:$|...) handles the
  // common cases.
  // Use a non-capturing alternation. The flag 'g' lets us iterate.
  const _glossRe = new RegExp('(?:' + SORTED_KEYS.map(reEscape).join('|') + ')', 'g');

  // ====================================================================
  // Annotator — wraps occurrences in <button class="tb-glossary-term">
  // ====================================================================

  function annotate(root) {
    if (!root) return;

    function processNode(node) {
      if (node.nodeType === 3) {
        const text = node.textContent;
        _glossRe.lastIndex = 0;
        if (!_glossRe.test(text)) { _glossRe.lastIndex = 0; return; }
        _glossRe.lastIndex = 0;

        const p = node.parentElement;
        if (!p) return;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'RT' ||
            tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' ||
            tag === 'A' || tag === 'LABEL' || tag === 'OPTION') return;
        if (p.closest('button.tb-glossary-term')) return;
        if (p.closest('.tb-glossary-modal')) return;

        const frag = document.createDocumentFragment();
        let last = 0, m;
        while ((m = _glossRe.exec(text)) !== null) {
          // Word-boundary check for ASCII matches — skip if surrounded
          // by alphanumeric chars that would suggest mid-word match.
          const prevCh = m.index > 0 ? text[m.index - 1] : '';
          const nextCh = m.index + m[0].length < text.length ? text[m.index + m[0].length] : '';
          const isAscii = /^[A-Za-z]/.test(m[0][0]);
          if (isAscii) {
            if (/[A-Za-z0-9]/.test(prevCh) || /[A-Za-z0-9]/.test(nextCh)) continue;
          }
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tb-glossary-term';
          btn.dataset.glossary = m[0];
          btn.textContent = m[0];
          frag.appendChild(btn);
          last = m.index + m[0].length;
        }
        _glossRe.lastIndex = 0;
        if (last === 0) return; // nothing wrapped (all skipped by boundary check)
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        if (node.parentNode) node.parentNode.replaceChild(frag, node);
        return;
      }

      if (node.nodeType === 1) {
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'RT' ||
            tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' ||
            tag === 'A' || tag === 'OPTION') return;
        if (node.classList && node.classList.contains('tb-glossary-modal')) return;
        const children = Array.from(node.childNodes);
        for (let i = 0; i < children.length; i++) processNode(children[i]);
      }
    }
    processNode(root);
  }

  // ====================================================================
  // Modal display
  // ====================================================================

  function show(termKey) {
    const entry = GLOSSARY[termKey];
    if (!entry) return;
    const root = document.getElementById('tb-modal-root');
    if (!root) return;

    const lang = (window.TB && TB.i18n) ? TB.i18n.getLang() : 'en';
    const isJp = lang === 'ja';

    function close() { root.innerHTML = ''; }

    const backdrop = document.createElement('div');
    backdrop.className = 'tb-modal-backdrop tb-glossary-modal';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const modal = document.createElement('div');
    modal.className = 'tb-modal';
    modal.style.maxWidth = '600px';
    backdrop.appendChild(modal);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tb-modal-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', close);
    modal.appendChild(closeBtn);

    // Header — term + expansion
    const header = document.createElement('div');
    header.style.marginBottom = 'var(--tb-sp-3)';
    const h2 = document.createElement('h2');
    h2.style.marginTop = '0';
    h2.style.marginBottom = 'var(--tb-sp-1)';
    h2.textContent = termKey;
    header.appendChild(h2);
    if (entry.expansion) {
      const exp = document.createElement('div');
      exp.style.color = 'var(--tb-text-soft)';
      exp.style.fontStyle = 'italic';
      exp.textContent = entry.expansion;
      header.appendChild(exp);
    }
    if (entry.category) {
      const catBadge = document.createElement('span');
      catBadge.className = 'tb-badge';
      catBadge.style.marginTop = 'var(--tb-sp-2)';
      catBadge.style.display = 'inline-block';
      catBadge.textContent = categoryLabel(entry.category, isJp);
      header.appendChild(catBadge);
    }
    modal.appendChild(header);

    // Short summary
    if (entry.short) {
      const shortP = document.createElement('p');
      shortP.style.fontSize = 'var(--tb-fs-16)';
      shortP.style.fontWeight = '500';
      shortP.style.marginTop = '0';
      shortP.textContent = entry.short;
      modal.appendChild(shortP);
    }

    // Long explanation
    if (entry.long) {
      const longP = document.createElement('p');
      longP.style.color = 'var(--tb-text)';
      longP.style.lineHeight = 'var(--tb-lh-loose)';
      longP.textContent = entry.long;
      modal.appendChild(longP);
    }

    // Why it matters
    if (entry.why) {
      const whyBox = document.createElement('div');
      whyBox.style.borderLeft = '3px solid var(--tb-accent)';
      whyBox.style.padding = 'var(--tb-sp-2) var(--tb-sp-3)';
      whyBox.style.background = 'var(--tb-bg)';
      whyBox.style.borderRadius = 'var(--tb-radius-1)';
      whyBox.style.marginTop = 'var(--tb-sp-3)';
      const whyLabel = document.createElement('div');
      whyLabel.style.fontWeight = '600';
      whyLabel.style.color = 'var(--tb-accent)';
      whyLabel.style.fontSize = 'var(--tb-fs-12)';
      whyLabel.style.textTransform = 'uppercase';
      whyLabel.style.letterSpacing = '0.04em';
      whyLabel.style.marginBottom = '4px';
      whyLabel.textContent = isJp ? 'なぜ重要か' : 'Why it matters';
      whyBox.appendChild(whyLabel);
      const whyP = document.createElement('div');
      whyP.textContent = entry.why;
      whyBox.appendChild(whyP);
      modal.appendChild(whyBox);
    }

    // Related terms — clickable chips that re-open the modal
    if (entry.related && entry.related.length) {
      const relWrap = document.createElement('div');
      relWrap.style.marginTop = 'var(--tb-sp-3)';
      const relLabel = document.createElement('div');
      relLabel.style.color = 'var(--tb-text-soft)';
      relLabel.style.fontSize = 'var(--tb-fs-12)';
      relLabel.style.textTransform = 'uppercase';
      relLabel.style.letterSpacing = '0.04em';
      relLabel.style.marginBottom = '4px';
      relLabel.textContent = isJp ? '関連用語' : 'Related';
      relWrap.appendChild(relLabel);
      const chips = document.createElement('div');
      chips.style.display = 'flex';
      chips.style.flexWrap = 'wrap';
      chips.style.gap = 'var(--tb-sp-1)';
      for (const rel of entry.related) {
        if (!GLOSSARY[rel]) continue;
        const chip = document.createElement('button');
        chip.className = 'tb-btn tb-btn--secondary';
        chip.type = 'button';
        chip.style.padding = '2px 10px';
        chip.style.fontSize = 'var(--tb-fs-12)';
        chip.textContent = rel;
        chip.addEventListener('click', () => show(rel));
        chips.appendChild(chip);
      }
      relWrap.appendChild(chips);
      modal.appendChild(relWrap);
    }

    // External references
    if (entry.refs && entry.refs.length) {
      const refsWrap = document.createElement('div');
      refsWrap.style.marginTop = 'var(--tb-sp-3)';
      const refsLabel = document.createElement('div');
      refsLabel.style.color = 'var(--tb-text-soft)';
      refsLabel.style.fontSize = 'var(--tb-fs-12)';
      refsLabel.style.textTransform = 'uppercase';
      refsLabel.style.letterSpacing = '0.04em';
      refsLabel.style.marginBottom = '4px';
      refsLabel.textContent = isJp ? '参考資料' : 'References';
      refsWrap.appendChild(refsLabel);
      const list = document.createElement('ul');
      list.style.margin = '0';
      list.style.paddingLeft = '20px';
      for (const r of entry.refs) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = r.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = r.label;
        li.appendChild(a);
        list.appendChild(li);
      }
      refsWrap.appendChild(list);
      modal.appendChild(refsWrap);
    }

    // Footer disclaimer
    const disc = document.createElement('p');
    disc.className = 'tb-field-help';
    disc.style.marginTop = 'var(--tb-sp-4)';
    disc.style.marginBottom = '0';
    disc.style.fontSize = 'var(--tb-fs-12)';
    disc.textContent = isJp
      ? '組織化のための説明であり、税務・財務・法律のアドバイスではありません。詳細は CPA 等の専門家に相談してください。'
      : 'Reference summary, not tax/financial/legal advice. Confirm specifics with a qualified CPA or tax professional.';
    modal.appendChild(disc);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  function categoryLabel(cat, isJp) {
    const labels = {
      'us-tax':     isJp ? '米国税制' : 'US Tax',
      'jp-tax':     isJp ? '日本税制' : 'Japan Tax',
      'retirement': isJp ? '退職計画' : 'Retirement',
      'investing':  isJp ? '投資'   : 'Investing',
      'jp-banking': isJp ? '日本銀行' : 'JP Banking',
      'sofa':       'SOFA',
    };
    return labels[cat] || cat;
  }

  // List of all glossary keys — useful for a future "View full glossary" page.
  function listKeys() {
    return SORTED_KEYS.slice().sort();
  }

  window.TB = window.TB || {};
  window.TB.glossary = {
    GLOSSARY,
    annotate,
    show,
    listKeys,
  };
})();
