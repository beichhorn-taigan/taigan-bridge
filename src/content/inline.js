/* Taigan Bridge — content/inline.js
 *
 * Runtime data that the app needs at startup. Lives as a regular JS
 * file (not JSON / not a fetched HTML doc) so the dev source works
 * when opened directly via file://, where fetch() is blocked.
 *
 * The build step inlines this file like any other <script>. The dist
 * pipeline ALSO injects an additional `window.TB.content = {...}`
 * block read from this same file's JSON-equivalent inputs, so the
 * built artifact and the dev source stay consistent.
 */

(function () {
  'use strict';
  window.TB = window.TB || {};
  window.TB.content = window.TB.content || {};

  window.TB.content.onboardingQuestions = [
    {
      id: 'display_name',
      type: 'text',
      question_en: "What's your name?",
      question_jp: 'お名前は?',
      helpText_en: 'Shown on your dashboard ("Ben\'s Dashboard"). Just first name, family name, or full name — your choice.',
      helpText_jp: 'ダッシュボードに表示されます(例:「ベンのダッシュボード」)。名・姓・フルネームなどお好みで。',
    },
    {
      id: 'display_name_ja',
      type: 'text',
      optional: true,
      question_en: 'Japanese rendering of your name (optional)',
      question_jp: 'お名前の日本語表記(任意)',
      helpText_en: 'Shown when the UI is switched to Japanese — e.g., "ベン" or "山田 太郎". Leave blank to use the name above as-is.',
      helpText_jp: '日本語表示時のお名前(例:「ベン」「山田 太郎」)。空欄の場合は上の名前をそのまま使用します。',
    },
    {
      // Birth year is used for: Medicare IEP detection, age-based
      // preventive screening filtering in Health Tracker, RMD timing
      // in Projections / Decumulation, Roth ladder optimizer, and the
      // age-based content gates in Retirement Decumulation. We don't
      // need full DOB — birth year is enough resolution and minimizes
      // sensitivity.
      id: 'birth_year',
      type: 'text',
      optional: true,
      question_en: 'What year were you born? (optional, used for age-based features)',
      question_jp: '生年(任意 — 年齢ベース機能で使用)',
      helpText_en: 'Just the year (e.g., 1980). Used for Medicare IEP, preventive screening filtering, RMD timing, and retirement projections. Stays local — never sent anywhere unless you explicitly use an AI feature.',
      helpText_jp: '西暦のみ(例:1980)。Medicare IEP・予防検診の絞り込み・RMD タイミング・退職プロジェクションに使用。完全ローカル保存 — AI 機能を明示的に使用しない限り外部送信なし。',
    },
    {
      // Biological sex (not gender identity) — used specifically for
      // medically-relevant filtering in Health Tracker: mammogram /
      // pap smear / PSA / AAA ultrasound. We're not asking about
      // gender identity, marital status, etc. — purely the medical-
      // screening filter input.
      id: 'biological_sex',
      type: 'single',
      optional: true,
      question_en: 'Biological sex (optional, used for medically-relevant screening filtering)',
      question_jp: '生物学的性別(任意 — 医学的検診の絞り込みに使用)',
      helpText_en: 'Used only by Health Tracker to filter the screening library (mammogram, Pap smear, PSA, AAA ultrasound, etc.). Doesn\'t affect any other module. "Prefer not to say" works fine — you can also set this per-screening directly.',
      helpText_jp: 'Health Tracker の検診ライブラリの絞り込み(乳がん検診・子宮頸がん検診・PSA・腹部大動脈瘤エコー等)にのみ使用。他のモジュールには影響しません。「回答しない」も選択可能 — 検診ごとに個別設定もできます。',
      options: [
        { value: 'female',             label_en: 'Female',             label_jp: '女性' },
        { value: 'male',               label_en: 'Male',               label_jp: '男性' },
        { value: 'other',              label_en: 'Other / non-binary', label_jp: 'その他・ノンバイナリー' },
        { value: 'prefer_not_to_say',  label_en: 'Prefer not to say',  label_jp: '回答しない' },
      ],
    },
    {
      id: 'citizenship',
      type: 'single',
      question_en: 'What is your citizenship status?',
      question_jp: 'あなたの市民権の状況は?',
      helpText_en: 'Used to determine US tax filing obligations and dual-citizenship considerations.',
      helpText_jp: '米国の納税義務と二重国籍の取り扱いを判定するために使用します。',
      options: [
        { value: 'us_only',    label_en: 'US citizen only',                label_jp: '米国市民のみ' },
        { value: 'us_dual',    label_en: 'Dual citizen (US + another)',    label_jp: '二重国籍(米国+他国)' },
        { value: 'us_lpr',     label_en: 'US Lawful Permanent Resident',   label_jp: '米国永住権保持者' },
        { value: 'us_jp_dual', label_en: 'US-Japan dual citizen',          label_jp: '日米二重国籍' },
      ],
    },
    {
      id: 'in_japan',
      type: 'single',
      question_en: 'Are you currently living in Japan?',
      question_jp: '現在、日本に居住していますか?',
      options: [
        { value: 'yes',      label_en: 'Yes, full-time',               label_jp: 'はい、フルタイムで居住' },
        { value: 'partial',  label_en: 'Yes, part of the year',        label_jp: 'はい、年の一部' },
        { value: 'planning', label_en: 'Not yet — planning to move',   label_jp: 'まだ — 移住を計画中' },
        { value: 'no',       label_en: 'No, but I have ties to Japan', label_jp: 'いいえ、ただし日本と関係あり' },
      ],
    },
    {
      id: 'years_in_japan',
      type: 'single',
      // Hidden when user explicitly answered "no, but I have ties" —
      // duration-of-residence questions don't apply. Still shown for
      // 'planning' so non-residents get a primer on what the 5-year
      // and 10-year clocks will mean once they arrive.
      showIf: (a) => a.in_japan !== 'no',
      question_en: 'How long have you been in Japan?',
      question_jp: '日本での滞在年数は?',
      helpText_en: 'Triggers the 5-year non-permanent-resident rule and PR thresholds.',
      helpText_jp: '非永住者の5年ルールおよび永住権の閾値に関連します。',
      options: [
        { value: 'under_1', label_en: 'Less than 1 year',   label_jp: '1年未満' },
        { value: '1_to_5',  label_en: '1–5 years',          label_jp: '1〜5年' },
        { value: '5_to_10', label_en: '5–10 years',         label_jp: '5〜10年' },
        { value: 'over_10', label_en: 'More than 10 years', label_jp: '10年以上' },
        { value: 'na',      label_en: 'Not applicable',     label_jp: '該当なし' },
      ],
    },
    {
      id: 'visa',
      type: 'single',
      // Skipped for users not in Japan + not planning to move. Anyone
      // 'planning' should still answer because their target visa
      // category drives the SOFA-vs-civilian content branching.
      showIf: (a) => a.in_japan !== 'no',
      question_en: 'What is your visa or status of forces?',
      question_jp: '在留資格 / SOFA の状況は?',
      options: [
        { value: 'sofa',       label_en: 'SOFA (US-Japan Status of Forces Agreement)', label_jp: 'SOFA(日米地位協定)' },
        { value: 'spouse_jp',  label_en: 'Spouse of Japanese national',                label_jp: '日本人の配偶者' },
        { value: 'work',       label_en: 'Work visa (Engineer / Specialist / etc.)',   label_jp: '就労ビザ' },
        { value: 'permanent',  label_en: 'Permanent Resident',                         label_jp: '永住者' },
        { value: 'long_term',  label_en: 'Long-Term Resident (定住者)',                 label_jp: '定住者' },
        { value: 'other',      label_en: "Other / I'm outside Japan",                  label_jp: 'その他 / 日本国外' },
      ],
    },
    {
      id: 'employment',
      type: 'single',
      question_en: 'What is your primary employment situation?',
      question_jp: '主な就業形態は?',
      options: [
        { value: 'dod_active',     label_en: 'Active duty US military',         label_jp: '現役米軍' },
        { value: 'dod_civilian',   label_en: 'DoD civilian',                    label_jp: '国防総省文官' },
        { value: 'dod_contractor', label_en: 'DoD contractor',                  label_jp: '国防総省契約職員' },
        { value: 'us_company',     label_en: 'US-company expat in Japan',       label_jp: '米系企業の駐在' },
        { value: 'japan_company',  label_en: 'Japanese company employee',       label_jp: '日系企業勤務' },
        { value: 'self',           label_en: 'Self-employed / business owner',  label_jp: '自営・経営者' },
        { value: 'retired_mil',    label_en: 'Retired military',                label_jp: '退役軍人(年金受給)' },
        { value: 'retired_civ',    label_en: 'Retired civilian',                label_jp: '退職(民間)' },
        { value: 'other',          label_en: 'Other',                            label_jp: 'その他' },
      ],
    },
    {
      // Moved BEFORE separation_date so the showIf below can hide that
      // question for never-served / still-active users.
      id: 'veteran',
      type: 'single',
      question_en: 'Are you a US military veteran or service member?',
      question_jp: '米軍の退役軍人または現役軍人ですか?',
      helpText_en: 'Unlocks the Veteran module. Your status determines which sections appear (e.g., TRICARE only shows if you\'re retired; the GI Bill section only shows if you\'re still entitled).',
      helpText_jp: '「退役軍人」モジュールを有効化。ステータスに応じて表示セクションが変わります(例:TRICARE は退役者のみ、GI Bill は給付未消化者のみ)。',
      options: [
        { value: 'no',                 label_en: 'No, never served',                              label_jp: 'いいえ(従軍経験なし)' },
        { value: 'active',             label_en: 'Active duty (currently serving)',               label_jp: '現役' },
        { value: 'reserve_ng',         label_en: 'Reserve / National Guard (drilling)',           label_jp: '予備役・州兵(訓練継続中)' },
        { value: 'retired',            label_en: 'Retired (20+ years OR medical retirement)',     label_jp: '退役者(20年以上勤務または医療退役)' },
        { value: 'separated_no_dis',   label_en: 'Separated — no VA disability rating',           label_jp: '除隊済み — VA 障害認定なし' },
        { value: 'separated_with_dis', label_en: 'Separated — with VA disability rating',         label_jp: '除隊済み — VA 障害認定あり' },
      ],
    },
    {
      id: 'separation_date',
      type: 'date',
      optional: true,
      // Only ask about separation date if the user is actually
      // separated or retired. Active-duty / never-served / reserve
      // users have nothing to enter here.
      showIf: (a) => a.veteran === 'retired'
                  || a.veteran === 'separated_no_dis'
                  || a.veteran === 'separated_with_dis',
      question_en: 'Date of separation, retirement, or release from active duty',
      question_jp: '除隊・退役・解放日',
      helpText_en: 'The date drives benefit-window math: VGLI conversion deadline (485 days post-separation, then permanently lost), Post-9/11 GI Bill 15-year delimitation for pre-2013 dischargees, and other time-sensitive benefit checks.',
      helpText_jp: 'VGLI 切替期限(除隊後 485 日で永久喪失)・Post-9/11 GI Bill 15 年期限(2013 年以前除隊者)など、給付の時間制約計算に使用されます。',
    },
    {
      id: 'juminhyo',
      type: 'single',
      // Skip for users not in / not planning Japan, and for users who
      // can't register on 住民票 anyway (active SOFA — Article 9 ¶2
      // exempts them; that exemption is the whole point of SOFA).
      // Still ask non-SOFA visa holders since the SOFA Roth Planner
      // sequencing depends on the answer.
      showIf: (a) => a.in_japan !== 'no' && a.visa !== 'sofa',
      question_en: 'Have you registered 住民票 (jūminhyō) in Japan?',
      question_jp: '日本で住民票を登録していますか?',
      helpText_en: 'Critical for SOFA Roth sequencing — registering before a Roth distribution can change its tax treatment dramatically.',
      helpText_jp: 'SOFA Roth シーケンスにおいて極めて重要 — Roth 分配の前に登録すると、税務上の取り扱いが大きく変わる可能性があります。',
      options: [
        { value: 'yes',    label_en: 'Yes',           label_jp: '登録済み' },
        { value: 'no',     label_en: 'No, not yet',   label_jp: '未登録' },
        { value: 'unsure', label_en: "I'm not sure",  label_jp: '不明' },
      ],
    },
    {
      id: 'tax_status',
      type: 'single',
      // No showIf — the 'us_only' option already covers users with no
      // JP filing obligation, and someone with a past NPR window or
      // pending JP property inheritance still benefits from picking
      // an explicit status.
      question_en: 'What is your Japan tax filing status?',
      question_jp: '日本での納税ステータスは?',
      helpText_en: 'SOFA holders (active military, DoD civ, DoD contractors) are exempt from Japanese income tax under SOFA Article 14 ¶7 and unregistered on 住民票 under Article 9 ¶2 — pick the SOFA option even after years on the ground.',
      helpText_jp: 'SOFA 保持者(現役軍人・国防総省文官・契約職員)は SOFA 第14条第7項により所得税が免除され、第9条第2項により住民票への登録も対象外。長期居住でも該当する場合は SOFA を選択。',
      options: [
        { value: 'japan_resident', label_en: 'Japan tax resident — file in Japan',      label_jp: '日本の納税居住者' },
        { value: 'japan_filer',    label_en: 'File in Japan as non-permanent resident', label_jp: '非永住者として日本で申告' },
        { value: 'sofa_no_file',   label_en: 'SOFA — not filing in Japan',               label_jp: 'SOFA — 日本では申告しない' },
        { value: 'us_only',        label_en: 'Only file in the US',                      label_jp: '米国でのみ申告' },
        { value: 'unsure',         label_en: 'Not sure',                                  label_jp: '不明' },
      ],
    },
    {
      id: 'non_sofa_jp_income',
      type: 'single',
      optional: true,
      // Only relevant for SOFA holders — JP-side income outside the
      // SOFA exemption (rental property, JP brokerage, JP self-
      // employment) IS taxable in Japan and forces a 確定申告 even for
      // an otherwise-exempt SOFA contractor. Branching below keeps
      // this hidden for non-SOFA users.
      showIf: (a) => a.tax_status === 'sofa_no_file',
      question_en: 'Do you have any non-SOFA JP-source income?',
      question_jp: 'SOFA 対象外の日本源泉所得はありますか?',
      helpText_en: 'Examples: a Japanese rental property in your name, a JP brokerage outside SOFA, JP self-employment, a JP-side consulting contract. SOFA exempts US-Forces-source income only — non-SOFA JP income IS taxable in Japan and forces a 確定申告 even for SOFA contractors.',
      helpText_jp: '例:ご自身名義の日本の賃貸不動産・SOFA 適用外の日本証券口座・日本側の自営業・日本企業との顧問契約等。SOFA は米軍関連の所得のみ免除 — それ以外の日本源泉所得は課税対象となり、SOFA 契約者でも確定申告が必要。',
      options: [
        { value: 'no',     label_en: 'No, all my income is SOFA-source',  label_jp: 'いいえ、全所得が SOFA 対象' },
        { value: 'yes',    label_en: 'Yes, I have non-SOFA JP income',    label_jp: 'はい、SOFA 対象外の日本所得あり' },
        { value: 'unsure', label_en: 'Not sure — review with a CPA',      label_jp: '不明 — CPA と確認予定' },
      ],
    },
    {
      id: 'family',
      type: 'multi',
      question_en: 'Family situation in Japan (select all that apply):',
      question_jp: '日本の家族構成(該当するものすべて):',
      options: [
        { value: 'none',          label_en: 'None of these / single',              label_jp: '該当なし / 独身' },
        { value: 'us_spouse',     label_en: 'US-citizen spouse',                   label_jp: '米国市民の配偶者' },
        { value: 'jp_spouse',     label_en: 'Japanese-national spouse',            label_jp: '日本人の配偶者' },
        { value: 'third_spouse',  label_en: 'Spouse of another nationality',       label_jp: '他国籍の配偶者' },
        { value: 'us_children',   label_en: 'US-citizen children',                 label_jp: '米国籍の子' },
        { value: 'jp_children',   label_en: 'Japanese-citizen children',           label_jp: '日本国籍の子' },
        { value: 'dual_children', label_en: 'Dual-citizen children (US + Japan)',  label_jp: '日米二重国籍の子' },
      ],
    },
    {
      id: 'real_estate',
      type: 'single',
      question_en: 'Do you own or expect to inherit real estate in Japan?',
      question_jp: '日本国内の不動産を所有・相続予定ですか?',
      options: [
        { value: 'yes',      label_en: 'Yes, I currently own property',                  label_jp: 'はい、現在所有' },
        { value: 'expected', label_en: 'I expect to inherit (e.g., 古民家, family land)', label_jp: '相続予定(古民家・家業・農地など)' },
        { value: 'no',       label_en: 'No',                                              label_jp: 'いいえ' },
      ],
    },
    {
      // Branch — only when user owns JP property NOW (inherited later
      // gets handled at inheritance time). Drives §469 passive-income
      // treatment, §1250 depreciation tracking, US Form 1116 basket
      // assignment in Property + Tax modules.
      id: 'real_estate_use',
      type: 'single',
      showIf: (a) => a.real_estate === 'yes',
      question_en: 'How is your JP property currently used?',
      question_jp: 'お持ちの日本不動産の現在の用途は?',
      helpText_en: 'Rental income gets US §469 passive treatment + Schedule E reporting; primary residence gets §121 exclusion eligibility (5-year-residency window if you ever sell). The Property module branches on this answer.',
      helpText_jp: '賃貸所得は米国 §469 受動的所得扱い + Schedule E 報告対象。主たる居住用は将来売却時に §121 除外(5 年中 2 年居住要件)の対象。Property モジュールの表示がこの回答で分岐します。',
      options: [
        { value: 'primary',     label_en: 'Primary residence (we live in it)',  label_jp: '主たる居住用(自宅)' },
        { value: 'rental',      label_en: 'Rental property',                    label_jp: '賃貸物件' },
        { value: 'mixed',       label_en: 'Mixed (one residence + one rental, or partial rental)', label_jp: '混合(自宅+賃貸併用、または一部賃貸)' },
        { value: 'second_home', label_en: 'Second home / vacation (not rented)', label_jp: '別荘・セカンドハウス(賃貸なし)' },
      ],
    },
    {
      // Inherited-property branch — kominka / agricultural land have
      // distinct tax + ownership-restriction profiles vs. a standard
      // suburban inheritance. Drives the Property module's "inherited"
      // section + the 小規模宅地等の特例 eligibility flag for Estate.
      id: 'real_estate_inherited_kind',
      type: 'single',
      showIf: (a) => a.real_estate === 'expected',
      question_en: 'What kind of inheritance do you expect?',
      question_jp: '相続予定の不動産の種類は?',
      helpText_en: 'Different rules apply: 古民家 (kominka) often have renovation grants; agricultural land (農地) has resale + use restrictions; standard residential land qualifies for 小規模宅地等の特例 (80% assessment reduction up to 330㎡) if you continue residing.',
      helpText_jp: '種類別にルールが異なります。古民家は改修補助金の対象になる場合あり。農地は売却・用途に制限あり。一般住宅地は居住継続で 小規模宅地等の特例(330 ㎡ まで 80% 評価減)の対象。',
      options: [
        { value: 'residential',  label_en: 'Standard residential land / home',     label_jp: '一般住宅地・住宅' },
        { value: 'kominka',      label_en: '古民家 (traditional Japanese house)',  label_jp: '古民家(伝統的日本家屋)' },
        { value: 'agricultural', label_en: '農地 (agricultural land)',              label_jp: '農地' },
        { value: 'commercial',   label_en: 'Commercial / mixed-use building',     label_jp: '商業・併用ビル' },
        { value: 'unsure',       label_en: 'Unsure / multiple kinds',              label_jp: '不明・複数種類' },
      ],
    },
    {
      // Household-tax-split capture. Default-pre-selects the right value
      // based on tax_status + family answers (SOFA + spouse → 'spouse';
      // SOFA solo → 'na'; non-SOFA → 'self') in onboarding.js. Sets the
      // Tax Coordinator's jp_filing_responsibility on finish so the
      // user doesn't have to discover the picker after the fact.
      id: 'jp_filing_responsibility',
      type: 'single',
      question_en: 'Who in your household files JP-side personal returns?',
      question_jp: '日本側の個人税務申告は世帯内で誰が担当?',
      helpText_en: 'Covers 確定申告, 住民税, ふるさと納税. SOFA holders are exempt from JP income tax and don\'t appear on 住民票 — their JP-national spouse typically files her own return. Choose what matches your household; you can override per-feature later.',
      helpText_jp: '確定申告・住民税・ふるさと納税が対象。SOFA 保持者は日本所得税が免除され住民票にも未登録 — 日本人配偶者がご自身の申告を行うのが典型。世帯状況に合うものを選択(後から個別に変更可)。',
      options: [
        { value: 'auto',   label_en: 'Auto-detect from my answers',                       label_jp: 'オンボーディング回答から自動判定' },
        { value: 'self',   label_en: 'I file my own JP returns',                          label_jp: '自分で日本側申告を行う' },
        { value: 'spouse', label_en: 'My spouse / family member handles JP-side',          label_jp: '配偶者・家族が日本側を担当' },
        { value: 'na',     label_en: 'No JP filing obligation (SOFA exempt / US-only)',    label_jp: '日本側申告義務なし(SOFA 免除・米国のみ)' },
      ],
    },
    {
      id: 'healthcare_coverage',
      type: 'multi',
      question_en: 'How is your healthcare currently covered in Japan? (Select all that apply)',
      question_jp: '日本での医療カバレッジは?(該当するものすべて)',
      helpText_en: 'Drives the Healthcare module. Pick by what your plan COVERS, not who pays. If your employer provides an international plan (CIGNA International, GeoBlue, BUPA Global, Aetna International — common for SOFA contractors and US-company expats), pick "International plan" — the coverage shape (works in JP + globally) matters more than who pays the premium. Reserve "US-domestic employer plan" for plans whose network is US-only (BCBS PPO, Aetna domestic, Kaiser). SOFA contractors are exempt from NHI under Article 9; their JP-resident spouses typically enroll in NHI/SHI separately.',
      helpText_jp: '医療モジュールの表示を制御。何が「カバーされるか」で選択(誰が支払うかではなく)。雇用主が国際保険を提供している場合(CIGNA International・GeoBlue・BUPA Global・Aetna International 等 — SOFA 契約者や米企業駐在員に多い)、「国際保険」を選択 — カバレッジの形(日本 + 全世界で使用可能)が誰が保険料を支払うかより重要。「米国国内向け企業プラン」はネットワークが米国限定のプラン用(BCBS PPO・Aetna 国内・Kaiser 等)。SOFA 契約者は第9条により NHI 適用除外、日本居住の配偶者は通常別途 NHI/SHI に加入。',
      options: [
        { value: 'nhi',          label_en: '国民健康保険 (NHI)',                                   label_jp: '国民健康保険(NHI)' },
        { value: 'shi',          label_en: '社会保険 / 健康保険 (employer SHI)',                   label_jp: '社会保険・健康保険(雇用主提供)' },
        { value: 'tricare',      label_en: 'TRICARE (active duty / retiree / dependent)',          label_jp: 'TRICARE(現役・退役・扶養家族)' },
        { value: 'private_intl', label_en: 'International plan (CIGNA Intl, GeoBlue, BUPA — incl. employer-provided)', label_jp: '国際保険(CIGNA Intl・GeoBlue・BUPA — 雇用主提供含む)' },
        { value: 'us_employer',  label_en: 'US-domestic employer plan (BCBS / Aetna / Kaiser — US-network only)', label_jp: '米国国内向け企業プラン(BCBS・Aetna・Kaiser — 米国ネットワーク限定)' },
        { value: 'fehb',         label_en: 'FEHB (Federal Employees Health Benefits — US + limited overseas reimbursement)', label_jp: 'FEHB(連邦職員健康給付 — 米国 + 海外償還)' },
        { value: 'medicare',     label_en: 'Medicare (Parts A/B/D, with FMP for overseas)',        label_jp: 'Medicare(A/B/D・海外向け FMP)' },
        { value: 'va_fmp',       label_en: 'VA Foreign Medical Program (service-connected)',       label_jp: 'VA 海外医療プログラム(軍務関連障害)' },
        { value: 'none',         label_en: 'None / between coverages',                              label_jp: 'なし・カバレッジ移行中' },
        { value: 'unsure',       label_en: 'Not sure / mixed',                                      label_jp: '不明・複合' },
      ],
    },
    {
      id: 'retirement_horizon',
      type: 'single',
      question_en: 'Roughly when do you plan to retire (or stop drawing W-2 income)?',
      question_jp: 'リタイア(または W-2 給与停止)はおおよそいつ?',
      helpText_en: 'Drives the Decumulation module focus and the Net Worth review cadence. "Already retired" surfaces RMD planning + SS claiming detail; "30+ years" focuses on accumulation + Roth-vs-401k decisions.',
      helpText_jp: '取崩しモジュールの優先表示と純資産レビュー頻度を制御。「リタイア済み」は RMD と SS 受給戦略を、「30 年以上」は積立と Roth vs 401k の選択を中心に表示。',
      options: [
        { value: 'already',   label_en: 'Already retired / no W-2 income',  label_jp: 'リタイア済み・W-2 給与なし' },
        { value: 'lt5y',      label_en: 'Within 5 years',                    label_jp: '5 年以内' },
        { value: '5_15y',     label_en: '5–15 years',                        label_jp: '5〜15 年' },
        { value: '15_30y',    label_en: '15–30 years',                       label_jp: '15〜30 年' },
        { value: 'gt30y',     label_en: '30+ years',                          label_jp: '30 年以上' },
        { value: 'unsure',    label_en: "Don't know yet",                    label_jp: '未定' },
      ],
    },
    {
      id: 'fx_platforms',
      type: 'multi',
      optional: true,
      question_en: 'Which money-transfer / FX platforms do you use? (optional)',
      question_jp: '海外送金・両替プラットフォームは?(任意)',
      helpText_en: 'Pre-fills the FX & Banking module so you don\'t start from a blank page. We don\'t access your accounts — just shows the right platforms and their current fee structure.',
      helpText_jp: 'FX・銀行モジュールを事前入力 — 口座へのアクセスは不要、対応プラットフォームと最新手数料体系を表示。',
      options: [
        { value: 'wise',        label_en: 'Wise (formerly TransferWise)',     label_jp: 'Wise(旧 TransferWise)' },
        { value: 'revolut',     label_en: 'Revolut',                          label_jp: 'Revolut' },
        { value: 'sony_bank',   label_en: 'Sony Bank (foreign currency)',     label_jp: 'ソニー銀行(外貨)' },
        { value: 'shinsei',     label_en: 'Shinsei / SBI Shinsei (GoRemit)',  label_jp: '新生銀行・SBI 新生(GoRemit)' },
        { value: 'rakuten',     label_en: 'Rakuten Bank international',       label_jp: '楽天銀行(国際送金)' },
        { value: 'remitly',     label_en: 'Remitly',                          label_jp: 'Remitly' },
        { value: 'westernunion',label_en: 'Western Union / MoneyGram',        label_jp: 'Western Union / MoneyGram' },
        { value: 'usaa',        label_en: 'USAA wire',                        label_jp: 'USAA 海外送金' },
        { value: 'navy_fed',    label_en: 'Navy Federal wire',                label_jp: 'Navy Federal 海外送金' },
        { value: 'broker',      label_en: 'Brokerage international wire',     label_jp: '証券会社の海外送金' },
        { value: 'crypto',      label_en: 'Crypto rails (USDC / on-chain)',   label_jp: '暗号資産(USDC・オンチェーン)' },
        { value: 'none',        label_en: 'None yet',                          label_jp: 'まだ使用なし' },
      ],
    },
    {
      id: 'ai_consent',
      type: 'single',
      question_en: 'How do you want Claude AI features to behave by default?',
      question_jp: 'Claude AI 機能のデフォルト動作は?',
      helpText_en: 'You always provide your own API key and can change this any time in Settings. "Per-call" gives you a one-line consent prompt before each AI request; "vision-only" lets only document-extraction features run; "off" disables AI entirely.',
      helpText_jp: 'API キーは常にご自身で用意、設定からいつでも変更可能。「呼び出しごとに確認」は各リクエスト前にワンライナーの同意確認、「画像のみ」は書類抽出のみ許可、「オフ」は AI を完全無効化。',
      options: [
        { value: 'full',        label_en: 'Full — chat + vision + enrichment all enabled',            label_jp: 'フル — チャット・画像・エンリッチすべて有効' },
        { value: 'per_call',    label_en: 'Per-call confirm — ask me before each AI request',          label_jp: '呼び出しごとに確認 — 各 AI リクエスト前に確認' },
        { value: 'vision_only', label_en: 'Vision only — document extraction OK, no chat enrichment',  label_jp: '画像のみ — 書類抽出のみ許可、チャット・エンリッチは無効' },
        { value: 'off',         label_en: 'Off — disable all AI features',                              label_jp: 'オフ — AI 機能をすべて無効化' },
      ],
    },
    {
      id: 'consultations_history',
      type: 'single',
      optional: true,
      question_en: 'Have you worked with a CPA, 税理士, or international tax attorney before?',
      question_jp: 'CPA・税理士・国際税務弁護士と過去に相談した経験は?',
      helpText_en: 'Pre-fills the Consultations tracker so you can log past meetings + plan upcoming ones. We don\'t need names — just whether to surface the module prominently.',
      helpText_jp: 'コンサルテーション・トラッカーを事前入力(過去の相談記録 + 今後の予定計画)。具体的な氏名は不要 — モジュールの優先表示の判定のみに使用。',
      options: [
        { value: 'cpa_us_intl', label_en: 'Yes, US CPA with international expertise',  label_jp: 'はい、国際税務専門の米国 CPA' },
        { value: 'cpa_us',      label_en: 'Yes, US CPA (general)',                      label_jp: 'はい、米国 CPA(一般)' },
        { value: 'tax_jp',      label_en: 'Yes, 税理士 in Japan',                       label_jp: 'はい、日本の税理士' },
        { value: 'multiple',    label_en: 'Yes, multiple professionals',                 label_jp: 'はい、複数の専門家' },
        { value: 'no_yet',      label_en: 'Not yet — but I want recommendations',        label_jp: 'まだ — 紹介を希望' },
        { value: 'no_diy',      label_en: 'No — I file myself',                          label_jp: 'なし — 自分で申告' },
      ],
    },
    {
      // PFIC trap — JP-resident US persons who hold Japanese mutual
      // funds, NISA, or iDeCo end up with Form 8621 obligations + the
      // worst-case "default" PFIC tax regime (interest-charge method).
      // We surface this VERY early so people don't accidentally open a
      // NISA before Taigan Bridge has a chance to flag it.
      id: 'pfic_holdings',
      type: 'single',
      // Only relevant for US persons — no point asking a JP-only filer
      // about US-specific PFIC rules.
      showIf: (a) => a.citizenship === 'us_only'
                  || a.citizenship === 'us_dual'
                  || a.citizenship === 'us_lpr'
                  || a.citizenship === 'us_jp_dual',
      question_en: 'Do you hold any Japanese investment funds, NISA, or iDeCo?',
      question_jp: '日本の投資信託・NISA・iDeCo を保有していますか?',
      helpText_en: 'Japanese mutual funds (投資信託), NISA, and iDeCo all count as PFICs (Passive Foreign Investment Companies) for US tax purposes. The default IRS treatment is punitive (Form 8621 + interest-charge method, often 50%+ of gains). We surface this early so the PFIC alert can guide what to do next.',
      helpText_jp: '日本の投資信託・NISA・iDeCo はすべて米国税法上の PFIC(受動的外国投資会社)に該当します。米国税務上のデフォルト処理は懲罰的(Form 8621 + 利子課税方式で利益の 50% 超になることも)。早期に把握しておくことで PFIC 警告から次の対応を案内できます。',
      options: [
        { value: 'yes_some',  label_en: 'Yes, some',                          label_jp: 'はい、一部保有' },
        { value: 'yes_many',  label_en: 'Yes, multiple holdings',             label_jp: 'はい、複数保有' },
        { value: 'no',        label_en: 'No, none',                           label_jp: 'いいえ、なし' },
        { value: 'unsure',    label_en: 'Not sure — need to check',           label_jp: '不明 — 確認が必要' },
      ],
    },
    {
      // Dual-citizen children + 国籍選択 (Article 14 of Nationality
      // Law). The 22nd-birthday deadline is the lever — we group
      // by age band so the Family module can prioritize the imminent
      // ones without asking for each child's birth year here.
      id: 'dual_children_age_band',
      type: 'single',
      showIf: (a) => Array.isArray(a.family) && a.family.indexOf('dual_children') !== -1,
      question_en: 'Roughly how old are your dual-citizen children?',
      question_jp: '日米二重国籍のお子さんの年齢帯は?',
      helpText_en: 'Japanese Nationality Law Article 14 (amended 2022) requires those with multiple nationalities to choose one — by age 20 if the second nationality was acquired before age 18, or within 2 years if acquired at/after 18. The Family module surfaces 国籍選択 deadlines based on this. You can refine per-child later in the Family page.',
      helpText_jp: '日本国籍法第 14 条(2022 年改正)は、複数の国籍を有する者に国籍の選択を求めています。18 歳未満で取得した場合は 20 歳までに、18 歳以降に取得した場合は取得から 2 年以内に選択します。Family モジュールでこの回答に基づき国籍選択の期限を表示します。後で Family ページで個別に調整することもできます。',
      options: [
        { value: 'all_under_18', label_en: 'All under 18 (deadline still distant)',          label_jp: '全員 18 歳未満(期限はまだ先)' },
        { value: 'has_18_20',    label_en: 'At least one is 18–20 (deadline now)',           label_jp: '18〜20 歳の子あり(期限が近い)' },
        { value: 'has_over_20',  label_en: 'At least one is over 20 (deadline passed / chose)', label_jp: '20 歳超の子あり(期限超過 or 選択済み)' },
        { value: 'mixed',        label_en: 'Mixed across the bands',                          label_jp: '複数バンドにまたがる' },
      ],
    },
    {
      // Medicare Part B / IRMAA — relevant for users near or past 65.
      // The Healthcare module already estimates IRMAA from MAGI, but
      // knowing whether the user has actually enrolled (and when)
      // changes whether we surface the IEP / SEP guidance vs. just
      // the ongoing premium tracker.
      id: 'medicare_status',
      type: 'single',
      // Only ask of users who are within range. Hide for clearly-young
      // users (15+ years to retirement = under ~50) so we don't waste
      // their time on a question that won't matter for a decade.
      showIf: (a) => a.retirement_horizon === 'already'
                  || a.retirement_horizon === 'lt5y'
                  || a.retirement_horizon === '5_15y'
                  || a.veteran === 'retired',
      question_en: 'Where are you with Medicare?',
      question_jp: 'Medicare(米国の高齢者医療保険)の状況は?',
      helpText_en: 'Medicare eligibility starts at age 65. Part A is free with 40 quarters of work history; Part B has a monthly premium ($202.90/mo in 2026, with IRMAA surcharges based on MAGI). Living abroad doesn\'t exempt you from Part B premiums if you\'re enrolled, and the late-enrollment penalty is permanent. The Healthcare module surfaces what to do based on this.',
      helpText_jp: 'Medicare の受給開始は 65 歳。Part A は 40 単位以上の労働歴で無料、Part B は月額保険料($202.90/月 2026 年)+ MAGI ベースの IRMAA 加算あり。海外居住でも加入中は Part B 保険料は支払い必要、加入遅延ペナルティは永続。Healthcare モジュールでこの回答に基づき対応を案内します。',
      options: [
        { value: 'enrolled_a_b',   label_en: 'Enrolled in both Part A and Part B',           label_jp: 'Part A・Part B 両方に加入済み' },
        { value: 'enrolled_a_only', label_en: 'Enrolled in Part A only (deferring Part B)',   label_jp: 'Part A のみ加入(Part B 据え置き)' },
        { value: 'eligible_not_enrolled', label_en: 'Eligible (65+) but not yet enrolled',    label_jp: '65 歳以上だが未加入' },
        { value: 'approaching_iep', label_en: 'Approaching 65 — IEP coming up',                label_jp: '65 歳間近 — IEP(初回登録期間)接近中' },
        { value: 'not_yet',        label_en: 'Under 65 — not yet eligible',                    label_jp: '65 歳未満 — まだ対象外' },
      ],
    },
    {
      // JP self-employment / 個人事業主 — affects 確定申告 obligation,
      // 国民年金 vs. 厚生年金 contribution path, 青色申告 election,
      // and crosses into the FX module if they invoice in USD.
      id: 'jp_self_employment',
      type: 'single',
      showIf: (a) => a.employment === 'self' && a.in_japan !== 'no',
      question_en: 'Are you registered as a 個人事業主 (sole proprietor) in Japan?',
      question_jp: '日本で 個人事業主 として開業届を提出済みですか?',
      helpText_en: 'Submitting 開業届 unlocks 青色申告 election (¥650K deduction with proper bookkeeping), enables 経費 deductions, and changes your social-insurance path (国民年金 + 国民健康保険 vs. employee SHI). Important for the Tax Coordinator + Decumulation modules.',
      helpText_jp: '開業届提出により 青色申告(複式簿記で ¥65 万控除)が選択可能になり、経費計上・社会保険の加入区分(国民年金 + 国民健康保険)が変わります。Tax Coordinator・Decumulation モジュールにとって重要な情報です。',
      options: [
        { value: 'aoiro',  label_en: 'Yes, with 青色申告 election',         label_jp: 'はい、青色申告で開業済み' },
        { value: 'shiro',  label_en: 'Yes, but 白色申告 (no election)',     label_jp: 'はい、白色申告で開業済み' },
        { value: 'no_yet', label_en: 'Not yet — planning to register',      label_jp: 'まだ — 開業届提出予定' },
        { value: 'no',     label_en: 'No — operating as a corporation or via US LLC', label_jp: 'いいえ — 法人 or 米国 LLC 経由で運営' },
      ],
    },
    {
      // Renunciation / expatriation — covered-expatriate detection
      // unlocks the Family + Estate modules' renunciation sections
      // and the §877A exit-tax calculator. Asking this gently early
      // lets us surface the right CPA-consultation reminders.
      id: 'renunciation_status',
      type: 'single',
      optional: true,
      // Only relevant for US-side citizens. LPRs follow a different
      // (still applicable) §877A long-term-resident rule, so include
      // them too.
      showIf: (a) => a.citizenship === 'us_only'
                  || a.citizenship === 'us_dual'
                  || a.citizenship === 'us_jp_dual'
                  || a.citizenship === 'us_lpr',
      question_en: 'Have you considered renouncing US citizenship (or expatriating from LPR)?',
      question_jp: '米国市民権の放棄(または LPR からの離脱)を検討したことはありますか?',
      helpText_en: 'Renunciation is irreversible and triggers exit tax for "covered expatriates" (Form 8854). For US persons in Japan, the analysis is non-trivial — you keep all the obligations until you formalize. Picking "considering" surfaces the renunciation section in Family + Estate so you can plan the timing.',
      helpText_jp: '市民権放棄は不可逆で、「covered expatriate」に該当する場合は出国税が発生(Form 8854)。日本居住の米国人にとって判断は複雑 — 正式に放棄するまで義務は継続します。「検討中」を選ぶと Family・Estate モジュールに放棄セクションが表示され、タイミングを計画できます。',
      options: [
        { value: 'never',           label_en: 'No, never considered',                    label_jp: 'いいえ、検討したことなし' },
        { value: 'considering',     label_en: 'Yes, actively considering',               label_jp: 'はい、現在検討中' },
        { value: 'planning',        label_en: 'Yes, planning to renounce within ~2 years', label_jp: 'はい、2 年以内に放棄予定' },
        { value: 'renounced',       label_en: 'Already renounced / expatriated',          label_jp: '既に放棄済み・離脱済み' },
      ],
    },
  ];
})();
