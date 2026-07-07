/* Taigan Bridge — modules/family.js
 *
 * Family module — for US persons with Japanese-national spouses,
 * dual-citizen children, or other Japan-resident family members.
 * Covers the demographic-specific complexity that other tools
 * ignore: 国籍選択 (Japanese nationality choice; by age 20 if dual from before 18), US
 * citizenship transmission rules to next generation, passport
 * renewal cycles across two systems, education savings (529 vs
 * 学資保険 PFIC trap), inheritance pre-positioning via 暦年贈与 /
 * 教育資金一括贈与 / 結婚・子育て / 相続時精算課税, and US
 * citizenship renunciation (covered expatriate + exit tax).
 *
 * Action Center integration via TB.family.actionGenerators —
 * watches passport expiry, 国籍選択 deadlines, year-end gift
 * opportunities, 教育資金一括贈与 sunset, renunciation milestones.
 */

(function () {
  'use strict';

  const id = 'family';

  // ====================================================================
  // Action Center i18n — self-registered strings for genPassportExpiring,
  // genNationalityChoiceApproaching, genYearEndGiftOpportunity,
  // genEduSunsetWarning, genRenunciationConsultation. Keys follow
  // fam.<generatorName>.<field> (title/body only; other fields on the
  // pushed items aren't user-facing strings).
  // ====================================================================

  TB.i18n.extend('en', {
    'fam.genPassportExpiring.title': '{{country}} passport expiring — {{name}} ({{days}}d)',
    'fam.genPassportExpiring.body.us': 'Passport expires {{expires}}. US passport renewal abroad: file Form DS-82 at the embassy/consulate. Allow 6-8 weeks. Many countries require 6mo validity for entry.',
    'fam.genPassportExpiring.body.jp': '日本パスポートは住民登録地の都道府県旅券課で更新。残存有効期間を確認。(Passport expires {{expires}}.)',

    'fam.genNationalityChoiceApproaching.title.past': '国籍選択 — past the formal date (no action forced) — {{name}}',
    'fam.genNationalityChoiceApproaching.title.future': '国籍選択 in {{years}}y — {{name}}',
    'fam.genNationalityChoiceApproaching.body.past': 'Being past the 国籍選択 (nationality-choice) date carries no automatic consequence. The obligation is a non-penalized "duty of effort" (努力義務): Japanese nationality is lost only if the Minister of Justice issues a written demand (催告) and it then goes unanswered for one month — and that demand has never been issued to anyone in Japan\'s history. Hundreds of thousands of dual nationals remain in exactly this position. This is Article 14 (the choice rule), which is separate from Article 11, under which a Japanese citizen who VOLUNTARILY acquires a foreign nationality loses Japanese nationality automatically — Article 11 does not apply to someone who was dual from birth. To confirm the formal record, obtain a 戸籍謄本 (a filed 国籍選択届 would appear there); a 行政書士 or the 法務局 can verify. Note: filing 国籍選択届 selecting Japanese does NOT renounce US citizenship — that is a separate consular process.',
    'fam.genNationalityChoiceApproaching.body.future': 'Japanese law asks dual nationals to choose one nationality: acquired before age 18 → by age 20; at/after 18 → within 2 years. This is a non-penalized "duty of effort" (Article 14) — no fine and no automatic loss for missing it, and the formal demand process has never been used. Filing 国籍選択届 selecting Japanese does NOT renounce US citizenship (separate consular act; only an "endeavor" under Article 16). Many dual nationals keep both. Separate risk worth knowing: Article 11 — voluntarily ACQUIRING a foreign nationality later — causes automatic loss of Japanese nationality, but it does not apply to a child dual from birth.',

    'fam.genYearEndGiftOpportunity.title': '暦年贈与 year-end opportunity — {{count}} recipients unused',
    'fam.genYearEndGiftOpportunity.body': 'You have {{count}} family member(s) eligible for a ¥1.1M tax-free gift this year. Bank transfer must SETTLE by Dec 31 to count. This use-it-or-lose-it cap doesn\'t carry over.',

    'fam.genEduSunsetWarning.title': '教育資金一括贈与 sunset {{sunset}} ({{days}}d) — extension uncertain',
    'fam.genEduSunsetWarning.body': '¥15M tax-free education lump sum (grandparent → grandchild) currently sunsets Mar 31, 2026. Past extensions have been granted but never guaranteed. If grandparents are considering this, review now.',

    'fam.genRenunciationConsultation.title': 'US renunciation — schedule specialist consultation',
    'fam.genRenunciationConsultation.body': 'You\'ve marked renunciation as under consideration but haven\'t flagged a consultation as complete. Renunciation is irrevocable; the covered-expatriate exit-tax math + post-renunciation US tax rules (transfer tax on gifts to US persons, Form 8854 dual-status year) deserve a specialist before filing the DS-4079.',
  });

  TB.i18n.extend('ja', {
    'fam.genPassportExpiring.title': '{{country}}パスポートが期限切れ間近 — {{name}}(残り{{days}}日)',
    'fam.genPassportExpiring.body.us': 'パスポートの有効期限は {{expires}}。海外での米国パスポート更新は大使館・領事館で DS-82 フォームを提出。6~8週間かかります。多くの国は入国に残存有効期間6ヶ月を要求します。',
    'fam.genPassportExpiring.body.jp': '日本パスポートは住民登録地の都道府県旅券課で更新。残存有効期間を確認。(有効期限:{{expires}})',

    'fam.genNationalityChoiceApproaching.title.past': '国籍選択 — 形式上の期限は経過(強制措置なし) — {{name}}',
    'fam.genNationalityChoiceApproaching.title.future': '国籍選択まで{{years}}年 — {{name}}',
    'fam.genNationalityChoiceApproaching.body.past': '国籍選択の期限を過ぎても自動的な不利益はありません。これは非罰則の「努力義務」(第14条)であり、日本国籍を失うのは法務大臣が書面で催告を行い、それに1ヶ月間応答しなかった場合のみです — この催告は日本の歴史上、誰に対しても発せられたことがありません。数十万人の重国籍者がまさにこの状態にあります。これは選択に関する第14条であり、第11条(日本国民が自らの意思で外国籍を取得した場合に日本国籍を自動的に喪失する規定)とは別です — 出生時から重国籍だった人には第11条は適用されません。正式な記録を確認するには戸籍謄本を取得してください(国籍選択届が提出されていればそこに記載されます)。行政書士または法務局で確認可能です。注:日本国籍を選択する国籍選択届の提出は米国市民権の放棄には当たりません — それは別途、領事手続きが必要です。',
    'fam.genNationalityChoiceApproaching.body.future': '日本法は重国籍者に一つの国籍の選択を求めています:18歳未満で重国籍取得→20歳までに、18歳以降に取得→2年以内に。これは非罰則の「努力義務」(第14条)であり、期限を過ぎても罰金や自動喪失はなく、正式な催告手続きが使われたことはありません。日本国籍を選択する国籍選択届の提出は米国市民権を放棄するものではありません(別途の領事手続きであり、第16条の下では「努める」義務に留まります)。多くの重国籍者は両方を保持しています。知っておくべき別のリスク:第11条 — 後に自らの意思で外国籍を取得すると日本国籍を自動的に喪失しますが、出生時から重国籍だった子には適用されません。',

    'fam.genYearEndGiftOpportunity.title': '暦年贈与 年末の贈与機会 — 未利用の受取人{{count}}名',
    'fam.genYearEndGiftOpportunity.body': '今年、¥110万の非課税贈与の対象となる家族が{{count}}名います。銀行振込は12月31日までに着金(決済完了)している必要があります。この非課税枠は使わなければ繰り越せません。',

    'fam.genEduSunsetWarning.title': '教育資金一括贈与 の期限 {{sunset}}(残り{{days}}日)— 延長は未定',
    'fam.genEduSunsetWarning.body': '¥1,500万の教育資金一括贈与(祖父母→孫)非課税枠は現在2026年3月31日で終了予定です。過去にも延長された実績はありますが、保証はありません。祖父母がこの制度の利用を検討している場合は、今すぐ確認してください。',

    'fam.genRenunciationConsultation.title': '米国市民権放棄 — 専門家との相談を予約してください',
    'fam.genRenunciationConsultation.body': '放棄を検討中とマークされていますが、相談完了のフラグが立てられていません。放棄は取り消せません。covered expatriate の出国税計算と放棄後の米国税ルール(米国人への贈与に対する移転税、Form 8854 の二重身分年度)は、DS-4079 提出前に専門家に相談する価値があります。',
  });

  // ====================================================================
  // Reference data
  // ====================================================================

  const RELATIONSHIPS = [
    { id: 'spouse',  label_en: 'Spouse',  label_jp: '配偶者' },
    { id: 'child',   label_en: 'Child',   label_jp: '子' },
    { id: 'parent',  label_en: 'Parent',  label_jp: '親' },
    { id: 'sibling', label_en: 'Sibling', label_jp: '兄弟姉妹' },
    { id: 'other',   label_en: 'Other',   label_jp: 'その他' },
  ];

  // Inheritance pre-positioning vehicles. Per-vehicle cap, eligibility,
  // sunset date (where applicable), and PFIC implications. Sourced
  // from National Tax Agency 国税庁 publications + Civil Code 1044.
  const GIFT_VEHICLES = [
    {
      id: '暦年贈与',
      label_en: 'Annual exclusion (暦年贈与)',
      label_jp: '暦年贈与',
      cap_jpy: 1_100_000,
      cap_unit_en: 'per recipient per year',
      cap_unit_jp: '受取人一人あたり年間',
      sunset: null,
      notes_en: '¥1.1M tax-free gift per recipient per year. Multiple recipients (kids + grandkids + spouse) compound. ⚠ 7-year clawback (expanded from 3y in 2024): gifts within 7y of death pulled back into estate.',
      notes_jp: '受取人一人あたり年間 ¥110 万まで贈与税非課税。複数の受取人(子・孫・配偶者)に対して並列適用可能。⚠ 2024 年改正で持ち戻し期間が 3 年→7 年に延長:死亡前 7 年以内の贈与は相続財産に加算。',
    },
    {
      id: '教育資金一括贈与',
      label_en: 'Education lump-sum (教育資金一括贈与)',
      label_jp: '教育資金一括贈与',
      cap_jpy: 15_000_000,
      cap_unit_en: 'lifetime to grandchildren',
      cap_unit_jp: '生涯・孫まで',
      sunset: (window.TB && TB.constants && TB.constants.GIFT_SUNSET.education) || '2026-03-31',
      notes_en: '¥15M tax-free lump sum to descendants under 30 for school + tuition + lessons. Funds held in earmarked bank account; unspent balance on 30th birthday or donor death = taxed. Closed to NEW contributions after Mar 31, 2026 (the FY2026 reform did not extend it); funds contributed by the deadline remain covered under the existing rules.',
      notes_jp: '30 歳未満の直系卑属に対し、教育費目的で一括贈与最大 ¥1,500 万まで非課税。指定銀行口座で管理。30 歳到達時または贈与者死亡時の残額は課税対象。2026/3/31 をもって新規の申込み受付は終了(令和8年度改正で延長されず)。期限までに拠出した資金は従来の取扱いが継続。',
    },
    {
      id: '結婚・子育て',
      label_en: 'Marriage / childbearing (結婚・子育て資金一括贈与)',
      label_jp: '結婚・子育て資金一括贈与',
      cap_jpy: 10_000_000,
      cap_unit_en: 'lifetime, ages 18-50',
      cap_unit_jp: '生涯・18~50歳',
      sunset: (window.TB && TB.constants && TB.constants.GIFT_SUNSET.marriageChildrearing) || '2027-03-31',
      notes_en: '¥10M lump sum to descendants ages 18-50 for marriage + childcare expenses. Funds in earmarked account. Available through Mar 31, 2027 (extended two years by the FY2025 reform).',
      notes_jp: '18~50 歳の直系卑属に対し、結婚・出産・育児費目的で一括贈与最大 ¥1,000 万まで非課税。指定口座管理。2027/3/31 まで利用可能(令和7年度改正で 2 年延長)。',
    },
    {
      id: '相続時精算課税',
      label_en: 'Settlement-at-inheritance (相続時精算課税)',
      label_jp: '相続時精算課税',
      cap_jpy: 25_000_000,
      cap_unit_en: 'lifetime, then 20% on excess',
      cap_unit_jp: '生涯・超過分は20%課税',
      sunset: null,
      notes_en: 'Lifetime ¥25M tax-free gifting election; gifts above cap taxed at 20% (refundable against future inheritance). 2024 reform added a ¥1.1M annual exclusion ON TOP of the lifetime cap. ⚠ Once elected, you can never go back to 暦年贈与 with that donor.',
      notes_jp: '生涯 ¥2,500 万までの贈与税非課税選択制度。超過分は 20% 課税(相続時に精算)。2024 年改正で年間 ¥110 万の基礎控除が上乗せ追加。⚠ 一度選択すると同一贈与者からの 暦年贈与 に戻せない。',
    },
    {
      id: '配偶者控除',
      label_en: 'Spouse deduction (配偶者控除 / おしどり贈与)',
      label_jp: '配偶者控除(おしどり贈与)',
      cap_jpy: 20_000_000,
      cap_unit_en: 'lifetime, marriage 20y+',
      cap_unit_jp: '生涯一度・婚姻20年以上',
      sunset: null,
      notes_en: '¥20M lifetime tax-free gift for primary residence (or cash to buy one) to a spouse married 20+ years. Separate from inheritance ¥160M spouse deduction. Used once.',
      notes_jp: '婚姻期間 20 年以上の配偶者に対し、居住用不動産または購入資金を生涯一度 ¥2,000 万まで非課税。相続時の配偶者控除(¥1.6 億)とは別枠。',
    },
  ];

  // Education savings vehicles — comparison for parents of dual-citizen
  // or US-citizen children. Two big traps surface here:
  //   - 学資保険 = PFIC for US-person owner (punitive default tax)
  //   - 529 = only "qualified" at FSA-eligible institutions; most
  //     Japanese universities are NOT on the list, so 529 funds spent
  //     on a typical JP school become non-qualified withdrawals
  //     (10% penalty + ordinary income on earnings).
  const EDU_VEHICLES = [
    {
      id: '529',
      label_en: '529 Plan (US-domiciled)',
      label_jp: '529 プラン(米国籍)',
      good_for: 'us_person',
      pfic: false,
      jp_school_warning: true,
      pros_en: [
        'No PFIC issue (US-domiciled)',
        'Tax-free growth + tax-free withdrawals for QUALIFIED expenses at FSA-eligible schools',
        'High contribution limits (~$95K front-loaded × 5y of federal gift exclusion per donor)',
        'Unused funds can roll to a Roth IRA for the beneficiary (up to $35K lifetime, beneficiary 15y rule)',
        'K-12 $10K/yr usable but only at US K-12 schools',
      ],
      pros_jp: [
        'PFIC の問題なし(米国籍ファンド)',
        'FSA 適格校での適格支出であれば、運用益・引き出しとも非課税',
        '拠出限度額が高い(贈与者一人あたり、連邦贈与税非課税枠5年分を前倒しで最大 $95K まで拠出可能)',
        '使い残した資金は受益者の Roth IRA へロールオーバー可能(生涯 $35K まで、受益者15年ルール)',
        'K-12(小中高)は年 $10K まで使用可能だが、米国内の K-12 校限定',
      ],
      cons_en: [
        '🚨 Most Japanese universities are NOT FSA-eligible — using 529 funds there = non-qualified withdrawal. Penalty applies to the EARNINGS portion only: 10% federal penalty + ordinary income tax on earnings. Principal contributions come back tax/penalty-free (you contributed after-tax dollars). The hit scales with how long the account grew.',
        'FSA-eligible JP schools are short list (verify at studentaid.gov): Temple Japan, Lakeland Japan, a handful of others',
        'JP doesn\'t recognize the 529 wrapper — internal growth may be JP-taxable to a JP-resident parent annually',
        'State tax credit only if you\'re a domiciliary of the offering state — non-qualified withdrawal can also trigger state-level recapture of prior credits',
        'Workarounds (avoid the earnings penalty): change beneficiary to a US-resident relative, save for room/board at an FSA-eligible school the kid visits in the US, use for an FSA-eligible JP institution, or roll up to $35K to the beneficiary\'s Roth IRA (SECURE 2.0)',
      ],
      cons_jp: [
        '🚨 ほとんどの日本の大学は FSA 適格校ではありません — そこで 529 資金を使うと非適格引き出しになります。ペナルティは運用益部分にのみ課され、連邦10%ペナルティ+運用益への通常所得税がかかります。元本拠出分は課税・ペナルティなしで戻ります(税引き後のお金を拠出しているため)。運用期間が長いほど負担は大きくなります。',
        'FSA 適格な日本の学校はごく少数(studentaid.gov で要確認):テンプル大学ジャパンキャンパス、レイクランド大学ジャパンキャンパスなど数校',
        '日本は 529 の器を認識しないため、日本居住の親には運用益に毎年日本の課税が生じる可能性があります',
        '州の税額控除は、その州の居住者である場合のみ適用され、非適格引き出しは過去の控除の州レベルでの取り戻し(recapture)を招くこともあります',
        '対策(運用益ペナルティを回避):受益者を米国居住の親族に変更する、米国内の FSA 適格校を訪れる子の寮費・食費に充てる、FSA 適格な日本の学校に使う、または受益者の Roth IRA へ最大 $35K をロールオーバーする(SECURE 2.0)',
      ],
    },
    {
      id: '学資保険',
      label_en: '学資保険 (Japan education insurance)',
      label_jp: '学資保険',
      good_for: 'non_us_person',
      pfic: true,
      pros_en: [
        'Forced-savings discipline — premiums autopay',
        'Death benefit if parent dies before child reaches college age',
        'Modest insurance + savings hybrid',
      ],
      pros_jp: [
        '保険料が自動引き落としのため、強制的な貯蓄になる',
        '子が大学進学年齢に達する前に親が死亡した場合の死亡保険金',
        '保険と貯蓄を組み合わせた手堅い商品性',
      ],
      cons_en: [
        '🚨 PFIC TRAP for US-person parent — punitive default tax on growth',
        'Generally weak returns (~0-1% over policy life)',
        'Inflexible — early surrender = principal loss',
        'Form 8621 every year for the US-person owner',
      ],
      cons_jp: [
        '🚨 米国人の親にとっては PFIC の罠 — 運用益に懲罰的な課税がデフォルトで適用される',
        '一般的にリターンが弱い(契約期間全体で約0~1%)',
        '柔軟性に欠ける — 早期解約すると元本割れ',
        '米国人の契約者は毎年 Form 8621 の提出が必要',
      ],
    },
    {
      id: '教育資金一括贈与',
      label_en: '教育資金一括贈与 (grandparent lump sum)',
      label_jp: '教育資金一括贈与',
      good_for: 'either',
      pfic: false,
      pros_en: [
        '¥15M tax-free from each grandparent (up to ¥60M from 4 grandparents)',
        'Specifically for school/tuition/lessons (defined broadly: tuition + entrance fees + textbooks + lessons up to ¥5M of the cap)',
        'No PFIC issue (it\'s a gift in an earmarked bank account, not an investment)',
        'Funds CAN be used for any school — Japanese, international, or foreign — without the 529 FSA-eligibility limitation',
      ],
      pros_jp: [
        '祖父母一人につき ¥1,500 万まで非課税(祖父母4人からなら最大 ¥6,000 万)',
        '学校・学費・習い事に限定使用(広く定義されており、授業料・入学金・教科書代・習い事は上限内 ¥500 万まで対象)',
        'PFIC の問題なし(投資商品ではなく、指定口座での贈与のため)',
        '529 の FSA 適格性の制限を受けず、日本の学校・インターナショナルスクール・海外の学校いずれにも使用可能',
      ],
      cons_en: [
        'Locked to education spending — non-education use = gift tax retroactively',
        'Sunset Mar 31, 2026 (last extension was 2023 reform; further extension uncertain — verify current status with NTA)',
        'Unused balance on the beneficiary\'s 30th birthday or donor\'s death is taxed',
        'Indirect: a US-person grandchild beneficiary should not personally control the account — foreign-account reporting exposure (FBAR / 8938)',
      ],
      cons_jp: [
        '教育費使用に限定 — 教育目的以外に使うと遡って贈与税が課税される',
        '2026年3月31日で終了予定(前回の延長は2023年度改正。さらなる延長は未定 — 国税庁で最新状況を要確認)',
        '受益者の30歳到達時または贈与者死亡時の残額は課税対象',
        '間接的な論点:米国人である孫の受益者が口座を自ら管理すべきではない — 外国口座報告義務(FBAR/8938)の対象になり得る',
      ],
    },
    {
      id: 'taxable_brokerage',
      label_en: 'US-domiciled brokerage (taxable, in parent\'s name)',
      label_jp: '米国籍課税口座(親名義)',
      good_for: 'us_person',
      pfic: false,
      pros_en: [
        'Maximum flexibility — no use-it-on-education restriction, no school-eligibility list',
        'No PFIC issue if holding US-domiciled funds (VTI, VOO, etc.)',
        'Long-term capital gains rates on growth (0% / 15% / 20%)',
        'JP FTC offsets US capital-gains tax to the extent JP taxes the same gains',
        'Best fit if school will be in Japan and FSA-ineligible (most likely case)',
      ],
      pros_jp: [
        '最大限の柔軟性 — 教育費使用の制限も学校適格性リストもなし',
        '米国籍ファンド(VTI、VOO 等)を保有していれば PFIC の問題なし',
        '運用益に長期キャピタルゲイン税率が適用(0%/15%/20%)',
        '日本が同じ譲渡益に課税する範囲で、外国税額控除(FTC)により米国キャピタルゲイン税を相殺できる',
        '学校が日本にあり FSA 非適格の場合(最も可能性が高いケース)に最適',
      ],
      cons_en: [
        'No tax-deferred growth (vs 529 / Roth)',
        'Counts as parental asset on FAFSA — modest financial-aid impact (≤5.6% of asset value)',
      ],
      cons_jp: [
        '課税繰延の運用益なし(529 / Roth と比較して)',
        'FAFSA(米国の学生支援申請)では親の資産として算入される — 資産評価額の5.6%以下と、財政支援への影響は小さい',
      ],
    },
  ];

  // Renunciation thresholds — covered expatriate test (any of three).
  // Sourced from IRC §877A. Inflation-adjusted annually.
  //   - net_worth_usd       : $2M (statutory, NOT inflation-adjusted)
  //   - avg_tax_5y_usd      : ~$201K (2024) → $206K (2025) → ~$212K (2026)
  //                           IRS Rev. Proc. each year sets the figure
  //   - exclusion_usd       : §877A gain-exclusion amount, inflation-adj
  //                           ($821K in 2024, $890K in 2025, ~$916K in 2026)
  //   - fee_dos_usd         : DOS administrative fee for CLN processing.
  //                           $450 effective Apr 13, 2026 (final rule
  //                           in Fed Reg 2026-04931, published Mar 13,
  //                           2026, reducing from the $2,350 figure
  //                           that had been in place since Sep 2014).
  //                           No retroactive refunds for the higher fee.
  //                           Non-waivable, non-refundable; paid on
  //                           day of consulate interview. (US Embassy
  //                           Japan confirms the $450 figure on
  //                           jp.usembassy.gov fees page.)
  const COVERED_EXPATRIATE = {
    net_worth_usd: 2_000_000,
    avg_tax_5y_usd: 206_000,
    exclusion_usd: 890_000,
    fee_dos_usd: 450,
    fee_dos_effective_date: '2026-04-13',
    fee_dos_prior_usd: 2_350,
  };

  // ====================================================================
  // State accessors
  // ====================================================================

  function getFamily()       { return TB.state.get('family') || {}; }
  function getMembers()      { return getFamily().members || []; }
  function getRenunciation() { return getFamily().renunciation || {}; }
  function getGiftsLog()     { return getFamily().gifts_log || []; }

  function setMembers(arr) {
    const f = getFamily();
    f.members = arr;
    TB.state.set('family', f);
  }
  function setRenunciation(value) {
    const f = getFamily();
    f.renunciation = value;
    TB.state.set('family', f);
  }
  function setGiftsLog(arr) {
    const f = getFamily();
    f.gifts_log = arr;
    TB.state.set('family', f);
  }

  function upsertMember(m) {
    const arr = getMembers();
    const i = arr.findIndex((x) => x.id === m.id);
    if (i >= 0) arr[i] = m;
    else arr.push(m);
    setMembers(arr);
  }
  function deleteMember(id) {
    setMembers(getMembers().filter((x) => x.id !== id));
  }

  function uuid() {
    return 'fam-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ====================================================================
  // Passport vision import (v0.60)
  // ====================================================================
  //
  // Drops a passport photo or PDF into the document-vision extraction
  // and pre-fills the bound last4 + expires inputs. The draft object
  // closed over by the modal is mutated directly so saving picks up
  // the new values without forcing a re-render of the whole modal.
  //
  // Privacy: extraction prompt only returns LAST 4 of the passport
  // number — never the full number. Wareki dates (令和/平成) get
  // converted to ISO before reaching us.
  async function runPassportVision(file, ppKey, expectedType, last4Input, expiresInput, statusEl) {
    const t = TB.i18n.t;
    statusEl.textContent = '⏳ ' + t('family.passport.import.processing');
    statusEl.style.color = 'var(--tb-text-soft)';
    try {
      const result = await TB.ai.callClaudeVisionForDocumentExtraction(file, {
        expected_type: expectedType,
        feature: 'document_vision',
      });
      const ext = (result && result.extracted) || {};
      const cost = (result.cost_usd || 0).toFixed(4);
      const filled = [];
      if (ext.reference_number_last4) {
        last4Input.value = ext.reference_number_last4;
        last4Input.dispatchEvent(new Event('input', { bubbles: true }));
        filled.push('last4');
      }
      if (ext.expiry_date) {
        expiresInput.value = ext.expiry_date;
        expiresInput.dispatchEvent(new Event('input', { bubbles: true }));
        filled.push('expires');
      }
      if (filled.length === 0) {
        statusEl.textContent = '⚠ ' + t('family.passport.import.nothing') + ' · $' + cost;
        statusEl.style.color = 'var(--tb-warn)';
      } else {
        statusEl.textContent = '✓ ' + t('family.passport.import.done', { n: filled.length, cost });
        statusEl.style.color = 'var(--tb-success)';
      }
    } catch (err) {
      statusEl.textContent = '✗ ' + (err.message || err);
      statusEl.style.color = 'var(--tb-error)';
    }
  }

  // ====================================================================
  // Computed helpers
  // ====================================================================

  function ageInYears(birth_date) {
    if (!birth_date) return null;
    const b = new Date(birth_date + 'T00:00:00');
    if (isNaN(b.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    const mDelta = now.getMonth() - b.getMonth();
    if (mDelta < 0 || (mDelta === 0 && now.getDate() < b.getDate())) age--;
    return age;
  }

  function daysUntil(iso) {
    if (!iso) return null;
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }

  // 国籍選択 deadline. Nationality Act Article 14, as amended effective
  // 2022-04-01 (when Japanese adulthood dropped to 18): multiple
  // nationality acquired BEFORE age 18 → choose by age 20; acquired
  // AT/AFTER 18 → within 2 years of acquisition. We track birth_date,
  // which covers the common dual-from-birth case (acquired before 18 →
  // 20th birthday). The later-acquisition case (deadline = acquisition
  // date + 2 years) can't be derived from birth_date alone, so the UI
  // explains that rule in text. (Pre-2022 law used age 22; that was the
  // source of the bug Ray's 2026-06 audit caught — see CLAIM-LEDGER.)
  function nationalityChoiceDate(birth_date) {
    if (!birth_date) return null;
    const b = new Date(birth_date + 'T00:00:00');
    b.setFullYear(b.getFullYear() + 20);
    return TB.utils.localIsoDate(b);
  }

  function isDualCitizen(member) {
    const c = member.citizenships || [];
    return c.indexOf('US') !== -1 && c.indexOf('JP') !== -1;
  }

  // ====================================================================
  // Onboarding-aware predicates (check BOTH onboarding answers AND
  // roster — so users who add members without re-running onboarding
  // still get the right sections, and users who picked categories at
  // onboarding still see relevant sections before adding roster entries)
  // ====================================================================

  function onboardingFamily() {
    const a = TB.state.get('onboarding.answers') || {};
    return Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
  }
  function indicatedSpouse() {
    const fam = onboardingFamily();
    return fam.indexOf('us_spouse') !== -1 || fam.indexOf('jp_spouse') !== -1
        || fam.indexOf('third_spouse') !== -1
        || getMembers().some((m) => m.relationship === 'spouse');
  }
  function indicatedChildren() {
    const fam = onboardingFamily();
    return fam.indexOf('us_children') !== -1 || fam.indexOf('jp_children') !== -1
        || fam.indexOf('dual_children') !== -1
        || getMembers().some((m) => m.relationship === 'child');
  }
  function indicatedDualChildren() {
    const fam = onboardingFamily();
    return fam.indexOf('dual_children') !== -1 || hasDualCitizenChildren();
  }

  // ====================================================================
  // Section registry
  // ====================================================================

  const SECTIONS = [
    { id: 'header',            always: true,  builder: () => buildHeaderCard() },
    { id: 'roster',            always: true,  builder: () => buildRosterCard() },
    {
      id: 'nationality_choice',
      label_en: '国籍選択 tracker',
      label_jp: '国籍選択トラッカー',
      description_en: 'Per-dual-citizen-child countdown to the age-20 nationality choice date (non-penalized duty of effort).',
      description_jp: '二重国籍の各お子様について、20 歳の国籍選択期限までのカウントダウン。',
      auto_show: indicatedDualChildren,
      builder: () => buildNationalityChoiceCard(),
    },
    {
      id: 'transmission',
      label_en: 'US citizenship transmission',
      label_jp: '米国市民権の継承',
      description_en: 'Physical-presence rules (INA §301(g)) for grandchildren born abroad.',
      description_jp: '海外出生孫向けの物理的存在ルール(INA §301(g))。',
      auto_show: indicatedDualChildren,
      builder: () => buildTransmissionCard(),
    },
    {
      id: 'passports',
      label_en: 'Passport renewal tracker',
      label_jp: 'パスポート更新追跡',
      description_en: 'All US + JP passports across family members with expiry alerts.',
      description_jp: '家族全員の米国 + 日本パスポートと有効期限警告。',
      auto_show: () => indicatedSpouse() || indicatedChildren() || getMembers().length > 0,
      builder: () => buildPassportTrackerCard(),
    },
    {
      id: 'edu_savings',
      label_en: 'Education savings strategy',
      label_jp: '教育費貯蓄戦略',
      description_en: '529 vs 学資保険 vs 教育資金一括贈与 comparison.',
      description_jp: '529・学資保険・教育資金一括贈与の比較。',
      auto_show: indicatedChildren,
      builder: () => buildEduSavingsCard(),
    },
    {
      id: 'pre_positioning',
      label_en: 'Inheritance pre-positioning',
      label_jp: '相続前の生前贈与',
      description_en: '暦年贈与, 教育資金一括贈与, 結婚・子育て, 相続時精算課税, 配偶者控除.',
      description_jp: '暦年贈与・教育資金一括贈与・結婚・子育て・相続時精算課税・配偶者控除。',
      auto_show: () => true,  // anyone may have heirs eventually
      builder: () => buildPrePositioningCard(),
    },
    {
      id: 'gift_log',
      label_en: 'Gift log',
      label_jp: '贈与記録',
      description_en: 'Year-by-year record of gifts. Used for 7y clawback computation.',
      description_jp: '年次贈与記録。7 年持ち戻し計算に使用。',
      auto_show: () => true,
      builder: () => buildGiftLogCard(),
    },
    {
      id: 'renunciation',
      label_en: 'US citizenship renunciation',
      label_jp: '米国市民権放棄',
      description_en: 'Covered-expatriate analysis + process / fee / consulate details.',
      description_jp: '対象拡大者分析と手続き・費用・領事館詳細。',
      auto_show: () => true,  // gated internally by "contemplating" checkbox
      builder: () => buildRenunciationCard(),
    },
    {
      id: 'resources',           always: true, builder: () => buildResourcesCard(),
    },
  ];

  // ====================================================================
  // Module render
  // ====================================================================

  let host = null;
  let listenerSet = false;

  function render(container) {
    host = container;
    if (!listenerSet) {
      TB.customize.onChange(id, () => rerender());
      listenerSet = true;
    }
    container.innerHTML = '';
    SECTIONS.forEach((s) => {
      if (s.always || TB.customize.isSectionEnabled(id, s.id, s.auto_show)) {
        container.appendChild(s.builder());
      }
    });
    container.appendChild(TB.customize.buildPanel(id, SECTIONS));
  }

  function rerender() { if (host) render(host); }

  // ─── Header ───────────────────────────────────────────────────────

  function buildHeaderCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    return el('div', { class: 'tb-card', 'data-track': 'family' },
      el('div', { class: 'tb-card-meta' },
        el('span', { class: 'tb-badge tb-badge--track', 'data-track': 'family' },
          t('family.badge')),
      ),
      el('h1', null, '👨‍👩‍👧 ' + t('family.title')),
      el('p', { class: 'tb-card-meta' }, t('family.subtitle')),
    );
  }

  // ─── Family roster ────────────────────────────────────────────────

  function buildRosterCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const members = getMembers();

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, t('family.section.roster')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openMemberModal(null) }, '＋ ' + t('family.member.add')),
    ));

    if (members.length === 0) {
      const a = TB.state.get('onboarding.answers') || {};
      const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
      const hints = [];
      if (fam.indexOf('us_spouse') !== -1)     hints.push(t('family.hint.us_spouse'));
      if (fam.indexOf('jp_spouse') !== -1)     hints.push(t('family.hint.jp_spouse'));
      if (fam.indexOf('third_spouse') !== -1)  hints.push(t('family.hint.third_spouse'));
      if (fam.indexOf('us_children') !== -1)   hints.push(t('family.hint.us_children'));
      if (fam.indexOf('jp_children') !== -1)   hints.push(t('family.hint.jp_children'));
      if (fam.indexOf('dual_children') !== -1) hints.push(t('family.hint.dual_children'));
      if (hints.length > 0) {
        card.appendChild(el('div', {
          style: {
            padding: 'var(--tb-sp-2) var(--tb-sp-3)',
            background: 'var(--tb-bg)', borderLeft: '3px solid var(--tb-track-family)',
            borderRadius: 'var(--tb-radius-1)', fontSize: 'var(--tb-fs-12)',
            marginTop: 'var(--tb-sp-2)',
          },
        },
          el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, t('family.hint.label')),
          el('ul', { style: { paddingLeft: '20px', margin: 0 } },
            hints.map((h) => el('li', null, h))),
        ));
      } else {
        card.appendChild(el('p', { class: 'tb-field-help' }, t('family.roster.empty')));
      }
      return card;
    }

    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-3)' } });
    members.forEach((m) => {
      const age = ageInYears(m.birth_date);
      const cit = (m.citizenships || []).join(' / ') || '—';
      const rel = (RELATIONSHIPS.find((r) => r.id === m.relationship) || {});
      const relLabel = lang === 'ja' ? rel.label_jp : rel.label_en;
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-family)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          gap: 'var(--tb-sp-3)', flexWrap: 'wrap',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } },
          (lang === 'ja' && m.name_jp ? m.name_jp : m.name_en) || (lang === 'ja' ? '(無題)' : '(untitled)'),
          relLabel ? el('span', { style: { color: 'var(--tb-text-soft)', marginLeft: '8px', fontWeight: '400', fontSize: 'var(--tb-fs-12)' } },
            '· ' + relLabel) : null,
        ),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          (age != null ? (lang === 'ja' ? age + ' 歳 · ' : age + 'y · ') : '') + cit
          + (m.jp_resident ? (lang === 'ja' ? ' · 日本居住' : ' · JP resident') : '')),
      ));
      row.appendChild(el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
          style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
          onclick: () => openMemberModal(m) }, '✎'),
      ));
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
  }

  function openMemberModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isNew = !existing;
    const draft = Object.assign({
      id: uuid(),
      relationship: 'child',
      name_en: '',
      name_jp: '',
      birth_date: '',
      citizenships: [],
      gender: '',
      jp_resident: true,
      ssn_or_itin: null,
      passport_us: { number_last4: '', expires: null, renewed_at: null },
      passport_jp: { number_last4: '', expires: null, renewed_at: null },
      nationality_choice_made: null,
      notes: '',
      created_at: new Date().toISOString(),
    }, existing || {});
    if (!draft.passport_us) draft.passport_us = { number_last4: '', expires: null, renewed_at: null };
    if (!draft.passport_jp) draft.passport_jp = { number_last4: '', expires: null, renewed_at: null };

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isNew ? t('family.modal.add_member') : t('family.modal.edit_member')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    // Relationship
    modal.appendChild(field(t('family.field.relationship'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.relationship = e.target.value; } },
        ...RELATIONSHIPS.map((r) => el('option', {
          value: r.id, selected: draft.relationship === r.id,
        }, lang === 'ja' ? r.label_jp : r.label_en)),
      )));

    // Name (EN + JP)
    const nameRow = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--tb-sp-2)' } });
    nameRow.appendChild(field(t('family.field.name_en'),
      el('input', { type: 'text', class: 'tb-input', value: draft.name_en || '',
        oninput: (e) => { draft.name_en = e.target.value; } })));
    nameRow.appendChild(field(t('family.field.name_jp'),
      el('input', { type: 'text', class: 'tb-input', value: draft.name_jp || '',
        oninput: (e) => { draft.name_jp = e.target.value; } })));
    modal.appendChild(nameRow);

    // Birth date
    modal.appendChild(field(t('family.field.birth_date'),
      el('input', { type: 'date', class: 'tb-input', value: draft.birth_date || '',
        oninput: (e) => { draft.birth_date = e.target.value || ''; } })));

    // Citizenships — checkboxes for US, JP, Other
    const cits = new Set(draft.citizenships || []);
    function citCheck(code, label) {
      const cb = el('input', {
        type: 'checkbox', checked: cits.has(code),
        style: { marginRight: '6px' },
        onchange: (e) => {
          if (e.target.checked) cits.add(code); else cits.delete(code);
          draft.citizenships = Array.from(cits);
        },
      });
      return el('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '12px' } },
        cb, label);
    }
    modal.appendChild(field(t('family.field.citizenships'),
      el('div', null,
        citCheck('US', 'US'),
        citCheck('JP', 'JP'),
        citCheck('OTHER', t('family.field.citizenships.other'))),
      t('family.field.citizenships.help')));

    // JP resident
    const jpCheck = el('input', { type: 'checkbox', checked: !!draft.jp_resident,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.jp_resident = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        jpCheck, t('family.field.jp_resident'))));

    // SSN / ITIN
    modal.appendChild(field(t('family.field.ssn_or_itin'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.ssn_or_itin = e.target.value || null; } },
        el('option', { value: '', selected: !draft.ssn_or_itin }, '—'),
        el('option', { value: 'ssn',  selected: draft.ssn_or_itin === 'ssn'  }, 'SSN'),
        el('option', { value: 'itin', selected: draft.ssn_or_itin === 'itin' }, 'ITIN'),
        el('option', { value: 'none', selected: draft.ssn_or_itin === 'none' }, t('family.field.ssn_or_itin.none')),
      ),
      t('family.field.ssn_or_itin.help')));

    // Passports — collapsed sections with optional vision import
    function passportFields(prefix, ppKey) {
      const wrap = el('details', { style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-2)' } });
      wrap.appendChild(el('summary', { style: { cursor: 'pointer', fontWeight: '600' } }, prefix + ' ' + t('family.field.passport')));
      const inner = el('div', { style: { marginTop: 'var(--tb-sp-2)' } });
      const last4Input = el('input', { type: 'text', class: 'tb-input', maxlength: '4',
        value: draft[ppKey].number_last4 || '',
        oninput: (e) => { draft[ppKey].number_last4 = e.target.value; } });
      const expiresInput = el('input', { type: 'date', class: 'tb-input',
        value: draft[ppKey].expires || '',
        oninput: (e) => { draft[ppKey].expires = e.target.value || null; } });
      inner.appendChild(field(t('family.field.passport_last4'), last4Input));
      inner.appendChild(field(t('family.field.passport_expires'), expiresInput));
      // Vision import: photo/PDF of passport bio page → expiry + last4
      // pre-fill. Uses the existing document-vision extraction so we
      // get bilingual handling (and 和暦 conversion for JP passports).
      // Only the LAST 4 of the passport number are stored — never the full number.
      if (TB.ai && typeof TB.ai.callClaudeVisionForDocumentExtraction === 'function') {
        const expectedType = ppKey === 'passport_us' ? 'passport_us' : 'passport_jp';
        const fileInput = el('input', {
          type: 'file',
          accept: 'image/png,image/jpeg,image/jpg,image/webp,application/pdf',
          style: { display: 'none' },
          onchange: async (e) => {
            const f = e.target.files && e.target.files[0];
            if (f) await runPassportVision(f, ppKey, expectedType, last4Input, expiresInput, status);
            e.target.value = '';
          },
        });
        const status = el('div', { style: { fontSize: '11px', color: 'var(--tb-text-soft)', marginTop: '4px', minHeight: '1em' } });
        const importBtn = el('button', {
          class: 'tb-btn tb-btn--secondary', type: 'button',
          style: { padding: '4px 10px', fontSize: '11px', marginTop: '4px' },
          onclick: (e) => { e.preventDefault(); fileInput.click(); },
        }, '📎 ' + t('family.passport.import.btn'));
        inner.appendChild(el('div', { style: { marginTop: 'var(--tb-sp-2)' } },
          importBtn, fileInput, status));
      }
      wrap.appendChild(inner);
      return wrap;
    }
    modal.appendChild(passportFields('US', 'passport_us'));
    modal.appendChild(passportFields('JP', 'passport_jp'));

    // 国籍選択 result (for dual citizens)
    if (cits.has('US') && cits.has('JP')) {
      modal.appendChild(field(t('family.field.nationality_choice'),
        el('select', { class: 'tb-select',
          onchange: (e) => { draft.nationality_choice_made = e.target.value || null; } },
          el('option', { value: '', selected: !draft.nationality_choice_made }, t('family.field.nationality_choice.pending')),
          el('option', { value: 'us',        selected: draft.nationality_choice_made === 'us' }, t('family.field.nationality_choice.us')),
          el('option', { value: 'jp',        selected: draft.nationality_choice_made === 'jp' }, t('family.field.nationality_choice.jp')),
          el('option', { value: 'kept_both', selected: draft.nationality_choice_made === 'kept_both' }, t('family.field.nationality_choice.both')),
        ),
        t('family.field.nationality_choice.help')));
    }

    // Notes
    modal.appendChild(field(t('family.field.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    // Buttons
    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)' } });
    if (!isNew) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          if (confirm(t('family.confirm.delete'))) { deleteMember(draft.id); close(); rerender(); }
        } }, '🗑 ' + t('family.delete')));
    } else {
      btnRow.appendChild(el('div', null));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('family.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        draft.updated_at = new Date().toISOString();
        upsertMember(draft);
        close();
        rerender();
      } }, t('family.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── 国籍選択 tracker ─────────────────────────────────────────────

  function hasDualCitizenChildren() {
    return getMembers().some((m) => m.relationship === 'child' && isDualCitizen(m));
  }

  function buildNationalityChoiceCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const dualKids = getMembers().filter((m) => m.relationship === 'child' && isDualCitizen(m));

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '⚖ ' + t('family.section.nationality_choice')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('family.nationality_choice.intro')));

    dualKids.forEach((kid) => {
      const age = ageInYears(kid.birth_date);
      const choiceDate = nationalityChoiceDate(kid.birth_date);
      const days = daysUntil(choiceDate);
      const made = kid.nationality_choice_made;
      let color, badge;
      if (made === 'us' || made === 'jp') {
        color = 'var(--tb-success)';
        badge = '✓ ' + t('family.nationality_choice.made_' + made);
      } else if (made === 'kept_both') {
        color = 'var(--tb-warn)';
        badge = '⚠ ' + t('family.nationality_choice.made_both');
      } else if (days != null && days < 0) {
        // Past the formal date — calm/neutral, not a warning. Art. 14 is a
        // non-penalized duty of effort; no automatic loss (see intro).
        color = 'var(--tb-text-soft)';
        badge = t('family.nationality_choice.overdue');
      } else if (days != null && days <= 365 * 2) {
        color = 'var(--tb-warn)';
        badge = days + 'd';
      } else {
        color = 'var(--tb-track-family)';
        badge = days != null ? Math.floor(days / 365) + 'y' : '—';
      }

      const wrap = el('div', {
        style: {
          padding: 'var(--tb-sp-3)', borderLeft: '4px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      wrap.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--tb-sp-2)' } },
        el('div', null,
          el('div', { style: { fontWeight: '700' } },
            (lang === 'ja' && kid.name_jp ? kid.name_jp : kid.name_en) || '(untitled)',
            age != null ? el('span', { style: { color: 'var(--tb-text-soft)', marginLeft: '8px', fontWeight: '400' } },
              age + (lang === 'ja' ? ' 歳' : 'y')) : null,
          ),
          choiceDate ? el('div', { class: 'tb-field-help', style: { fontFamily: 'var(--tb-font-mono)' } },
            t('family.nationality_choice.deadline') + ': ' + choiceDate) : null,
        ),
        el('span', { class: 'tb-badge', style: { background: color, color: '#fff' } }, badge),
      ));
      // Body text
      if (made === 'us' || made === 'jp' || made === 'kept_both') {
        const noteKey = 'family.nationality_choice.note_' + made;
        wrap.appendChild(el('p', { style: { margin: 'var(--tb-sp-2) 0 0', fontSize: 'var(--tb-fs-12)' } },
          t(noteKey)));
      } else {
        wrap.appendChild(el('p', { style: { margin: 'var(--tb-sp-2) 0 0', fontSize: 'var(--tb-fs-12)' } },
          t('family.nationality_choice.action')));
      }
      card.appendChild(wrap);
    });

    // 国籍留保 — the separate, harder-edged rule for children BORN ABROAD.
    // Unlike the (toothless) Art. 14 choice, missing this 3-month reservation
    // DOES destroy Japanese nationality, so it gets a standing warning callout.
    const ryuhoCallout = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185, 122, 26, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)',
      },
    });
    ryuhoCallout.appendChild(el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
      '⚠ ' + t('family.nationality_choice.ryuho_title')));
    ryuhoCallout.appendChild(el('p', { style: { margin: 0 } }, t('family.nationality_choice.ryuho_body')));
    card.appendChild(ryuhoCallout);

    return card;
  }

  // ─── US citizenship transmission to next generation ───────────────

  function buildTransmissionCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🌐 ' + t('family.section.transmission')));
    card.appendChild(el('p', null, t('family.transmission.intro')));

    const callout = el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185, 122, 26, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)',
      },
    });
    callout.appendChild(el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
      t('family.transmission.rule_label')));
    callout.appendChild(el('p', { style: { margin: 0 } }, t('family.transmission.rule_body')));
    card.appendChild(callout);

    // Action steps
    const ul = el('ul', { style: { paddingLeft: '20px', marginTop: 'var(--tb-sp-3)' } });
    [
      'family.transmission.step1',
      'family.transmission.step2',
      'family.transmission.step3',
      'family.transmission.step4',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);
    return card;
  }

  // ─── Passport renewal tracker ─────────────────────────────────────

  function buildPassportTrackerCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const members = getMembers();

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🛂 ' + t('family.section.passports')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('family.passports.intro')));

    // Build flat list of (member, passport_kind, expiry)
    const rows = [];
    members.forEach((m) => {
      ['passport_us', 'passport_jp'].forEach((k) => {
        const pp = m[k];
        if (!pp || !pp.expires) return;
        rows.push({ member: m, kind: k, expires: pp.expires, last4: pp.number_last4 });
      });
    });

    if (rows.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('family.passports.empty')));
      return card;
    }

    rows.sort((a, b) => a.expires.localeCompare(b.expires));
    rows.forEach((r) => {
      const days = daysUntil(r.expires);
      const color = days < 0 ? 'var(--tb-error)'
                  : days <= 90 ? 'var(--tb-error)'
                  : days <= 180 ? 'var(--tb-warn)'
                  : days <= 365 ? 'var(--tb-warn)'
                  : 'var(--tb-success)';
      const label = days < 0 ? t('family.passports.expired')
                  : days + 'd';
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + color,
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      const country = r.kind === 'passport_us' ? 'US' : 'JP';
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } },
          el('span', { style: {
            display: 'inline-block', padding: '1px 6px', marginRight: '6px',
            fontSize: 'var(--tb-fs-12)', fontWeight: '700', letterSpacing: '0.04em',
            borderRadius: 'var(--tb-radius-pill)', color: '#fff',
            background: country === 'JP' ? '#B23A3A' : '#1A4480',
          } }, country),
          ((lang === 'ja' && r.member.name_jp) ? r.member.name_jp : r.member.name_en) || '(untitled)'),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px', fontFamily: 'var(--tb-font-mono)' } },
          r.expires + (r.last4 ? ' · ····' + r.last4 : '')),
      ));
      row.appendChild(el('div', {
        style: {
          textAlign: 'right', fontFamily: 'var(--tb-font-mono)',
          fontSize: 'var(--tb-fs-12)', color: color, whiteSpace: 'nowrap',
        },
      }, label));
      card.appendChild(row);
    });
    return card;
  }

  // ─── Education savings strategy ───────────────────────────────────

  function buildEduSavingsCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🎓 ' + t('family.section.edu_savings')));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('family.edu_savings.intro')));

    // Two headline traps — each gets its own callout so neither
    // gets buried inside the per-vehicle tile.
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-error)',
        background: 'rgba(178, 58, 58, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginBottom: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '🚨 ' + t('family.edu_savings.pfic_warning_label')),
      el('p', { style: { margin: 0 } }, t('family.edu_savings.pfic_warning_body')),
    ));
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-error)',
        background: 'rgba(178, 58, 58, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginBottom: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-14)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, '🚨 ' + t('family.edu_savings.jp_529_warning_label')),
      el('p', { style: { margin: 0 } }, t('family.edu_savings.jp_529_warning_body')),
      el('div', { style: { marginTop: '6px', fontSize: 'var(--tb-fs-12)' } },
        el('a', { href: 'https://studentaid.gov/h/apply-for-aid/fafsa/filling-out/help/school-codes',
          target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)' } },
          t('family.edu_savings.jp_529_lookup') + ' →')),
    ));

    // Vehicle comparison
    const grid = el('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--tb-sp-3)' },
    });
    EDU_VEHICLES.forEach((v) => {
      const tile = el('div', {
        style: {
          padding: 'var(--tb-sp-3)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-2)',
          border: v.pfic ? '2px solid var(--tb-error)' : '1px solid var(--tb-border)',
        },
      });
      tile.appendChild(el('div', { style: { fontWeight: '700', marginBottom: '4px' } },
        lang === 'ja' ? v.label_jp : v.label_en,
        v.pfic ? el('span', { style: { marginLeft: '6px', color: 'var(--tb-error)', fontSize: 'var(--tb-fs-12)' } }, '⚠ PFIC') : null,
      ));
      const ulPros = el('ul', { style: { paddingLeft: '20px', margin: 0 } });
      const pros = (lang === 'ja' && v.pros_jp) ? v.pros_jp : v.pros_en;
      const cons = (lang === 'ja' && v.cons_jp) ? v.cons_jp : v.cons_en;
      pros.forEach((p) => ulPros.appendChild(el('li', { style: { fontSize: 'var(--tb-fs-12)', marginBottom: '4px', color: 'var(--tb-success)' } }, '✓ ' + p)));
      cons.forEach((c) => ulPros.appendChild(el('li', { style: { fontSize: 'var(--tb-fs-12)', marginBottom: '4px', color: 'var(--tb-text-soft)' } }, '✗ ' + c)));
      tile.appendChild(ulPros);
      grid.appendChild(tile);
    });
    card.appendChild(grid);

    return card;
  }

  // ─── Inheritance pre-positioning ──────────────────────────────────

  function buildPrePositioningCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '🎁 ' + t('family.section.pre_positioning')));
    card.appendChild(el('p', null, t('family.pre_positioning.intro')));

    // Vehicle comparison
    GIFT_VEHICLES.forEach((v) => {
      const sunsetWarn = v.sunset && v.sunset < TB.utils.todayIso();
      const wrap = el('details', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid ' + (sunsetWarn ? 'var(--tb-text-soft)' : 'var(--tb-track-family)'),
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      });
      const summary = el('summary', { style: { cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--tb-sp-2)' } });
      summary.appendChild(el('span', { style: { fontWeight: '600' } },
        lang === 'ja' ? v.label_jp : v.label_en));
      summary.appendChild(el('span', { style: { fontSize: 'var(--tb-fs-12)', color: 'var(--tb-text-soft)', whiteSpace: 'nowrap', fontFamily: 'var(--tb-font-mono)' } },
        '¥' + v.cap_jpy.toLocaleString() + ' · ' + ((lang === 'ja' && v.cap_unit_jp) ? v.cap_unit_jp : v.cap_unit_en)));
      wrap.appendChild(summary);
      wrap.appendChild(el('p', { style: { marginTop: 'var(--tb-sp-2)', marginBottom: 0, fontSize: 'var(--tb-fs-12)' } },
        lang === 'ja' ? v.notes_jp : v.notes_en));
      if (v.sunset) {
        wrap.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-1)' } },
          (sunsetWarn ? '⚠ ' : '') + t('family.pre_positioning.sunset') + ': ' + v.sunset));
      }
      card.appendChild(wrap);
    });

    // 7-year clawback emphasis
    card.appendChild(el('div', {
      style: {
        padding: 'var(--tb-sp-2) var(--tb-sp-3)', borderLeft: '3px solid var(--tb-warn)',
        background: 'rgba(185, 122, 26, 0.06)', borderRadius: 'var(--tb-radius-1)',
        marginTop: 'var(--tb-sp-3)', fontSize: 'var(--tb-fs-12)',
      },
    },
      el('div', { style: { fontWeight: '600', marginBottom: '4px' } },
        '⚠ ' + t('family.pre_positioning.clawback_label')),
      el('p', { style: { margin: 0 } }, t('family.pre_positioning.clawback_body')),
    ));
    return card;
  }

  // ─── Gift log ─────────────────────────────────────────────────────

  function buildGiftLogCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const log = getGiftsLog();
    const members = getMembers();

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '📒 ' + t('family.section.gift_log')),
      el('button', { class: 'tb-btn', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openGiftModal(null) }, '＋ ' + t('family.gift.add')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('family.gift_log.intro')));

    if (log.length === 0) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('family.gift_log.empty')));
      return card;
    }

    // Year totals first
    const totalsByYear = {};
    log.forEach((g) => {
      totalsByYear[g.year] = (totalsByYear[g.year] || 0) + (g.amount_jpy || 0);
    });
    const totalRow = el('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 'var(--tb-sp-2)',
        padding: 'var(--tb-sp-2)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-1)', marginBottom: 'var(--tb-sp-2)',
        fontSize: 'var(--tb-fs-12)',
      },
    });
    Object.keys(totalsByYear).sort((a, b) => b - a).forEach((yr) => {
      totalRow.appendChild(el('span', null,
        el('strong', null, yr + ': '),
        '¥' + totalsByYear[yr].toLocaleString()));
    });
    card.appendChild(totalRow);

    // Individual entries
    log.slice().sort((a, b) => (b.year - a.year) || ((b.created_at || '').localeCompare(a.created_at || ''))).forEach((g) => {
      const recipient = members.find((m) => m.id === g.recipient_id);
      const recipName = recipient
        ? ((lang === 'ja' && recipient.name_jp) ? recipient.name_jp : recipient.name_en)
        : t('family.gift.unknown_recipient');
      const row = el('div', {
        style: {
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-family)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)', gap: 'var(--tb-sp-3)',
        },
      });
      row.appendChild(el('div', null,
        el('div', { style: { fontWeight: '600' } },
          g.year + ' · ' + recipName),
        el('div', { class: 'tb-field-help', style: { marginTop: '2px' } },
          g.vehicle + (g.notes ? ' · ' + g.notes : '')),
      ));
      row.appendChild(el('div', {
        style: { fontFamily: 'var(--tb-font-mono)', fontWeight: '600', whiteSpace: 'nowrap' },
      }, '¥' + (g.amount_jpy || 0).toLocaleString()));
      row.appendChild(el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '2px 8px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openGiftModal(g) }, '✎'));
      card.appendChild(row);
    });
    return card;
  }

  function openGiftModal(existing) {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const lang = TB.i18n.getLang();
    const root = document.getElementById('tb-modal-root');
    const isNew = !existing;
    const draft = Object.assign({
      id: 'gift-' + Date.now().toString(36),
      year: new Date().getFullYear(),
      recipient_id: null,
      amount_jpy: 0,
      vehicle: '暦年贈与',
      notes: '',
      created_at: new Date().toISOString(),
    }, existing || {});

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } },
      isNew ? t('family.modal.add_gift') : t('family.modal.edit_gift')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    modal.appendChild(field(t('family.gift.year'),
      el('input', { type: 'number', class: 'tb-input', min: '1990', max: '2100',
        value: draft.year || '',
        oninput: (e) => { draft.year = parseInt(e.target.value, 10) || draft.year; } })));

    modal.appendChild(field(t('family.gift.recipient'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.recipient_id = e.target.value || null; } },
        el('option', { value: '', selected: !draft.recipient_id }, '—'),
        ...getMembers().map((m) => el('option', {
          value: m.id, selected: draft.recipient_id === m.id,
        }, ((lang === 'ja' && m.name_jp) ? m.name_jp : m.name_en) || '(untitled)')),
      )));

    modal.appendChild(field(t('family.gift.vehicle'),
      el('select', { class: 'tb-select',
        onchange: (e) => { draft.vehicle = e.target.value; } },
        ...GIFT_VEHICLES.map((v) => el('option', {
          value: v.id, selected: draft.vehicle === v.id,
        }, lang === 'ja' ? v.label_jp : v.label_en)),
      )));

    modal.appendChild(field(t('family.gift.amount'),
      el('input', { type: 'number', class: 'tb-input', step: '10000', min: '0',
        value: draft.amount_jpy || 0,
        oninput: (e) => { draft.amount_jpy = parseFloat(e.target.value) || 0; } })));

    modal.appendChild(field(t('family.field.notes'),
      el('textarea', { class: 'tb-input', rows: 2,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--tb-sp-4)' } });
    if (!isNew) {
      btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--danger', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => {
          if (confirm(t('family.confirm.delete_gift'))) {
            setGiftsLog(getGiftsLog().filter((g) => g.id !== draft.id));
            close();
            rerender();
          }
        } }, '🗑 ' + t('family.delete')));
    } else {
      btnRow.appendChild(el('div', null));
    }
    const right = el('div', { style: { display: 'flex', gap: 'var(--tb-sp-2)' } });
    right.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('family.cancel')));
    right.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => {
        const log = getGiftsLog();
        const i = log.findIndex((g) => g.id === draft.id);
        if (i >= 0) log[i] = draft; else log.push(draft);
        setGiftsLog(log);
        close();
        rerender();
      } }, t('family.save')));
    btnRow.appendChild(right);
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Renouncing US citizenship ────────────────────────────────────

  function buildRenunciationCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const r = getRenunciation();

    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
      el('h2', { style: { margin: 0 } }, '🪪 ' + t('family.section.renunciation')),
      el('button', { class: 'tb-btn tb-btn--ghost', type: 'button',
        style: { padding: '4px 12px', fontSize: 'var(--tb-fs-12)' },
        onclick: () => openRenunciationModal() }, '✎ ' + t('family.edit')),
    ));
    card.appendChild(el('p', { class: 'tb-card-meta' }, t('family.renunciation.intro')));

    if (!r.contemplating) {
      card.appendChild(el('p', { class: 'tb-field-help' }, t('family.renunciation.not_contemplating')));
      return card;
    }

    // Covered expatriate analysis
    const nw = r.estimated_net_worth_usd || 0;
    const tx = r.estimated_avg_tax_5y_usd || 0;
    const isCoveredByWorth = nw >= COVERED_EXPATRIATE.net_worth_usd;
    const isCoveredByTax = tx >= COVERED_EXPATRIATE.avg_tax_5y_usd;
    const isCovered = isCoveredByWorth || isCoveredByTax;

    const analysis = el('div', {
      style: {
        padding: 'var(--tb-sp-3)', background: 'var(--tb-bg)',
        borderRadius: 'var(--tb-radius-2)', borderLeft: '4px solid ' +
          (isCovered ? 'var(--tb-error)' : 'var(--tb-warn)'),
        marginBottom: 'var(--tb-sp-3)',
      },
    });
    analysis.appendChild(el('div', { style: { fontWeight: '700', fontSize: 'var(--tb-fs-18)', marginBottom: '6px' } },
      isCovered ? '⚠ ' + t('family.renunciation.is_covered') : '○ ' + t('family.renunciation.not_covered')));

    const lines = [];
    lines.push({
      label: t('family.renunciation.test.net_worth'),
      value: '$' + nw.toLocaleString() + ' / $' + COVERED_EXPATRIATE.net_worth_usd.toLocaleString(),
      hit: isCoveredByWorth,
    });
    lines.push({
      label: t('family.renunciation.test.avg_tax'),
      value: '$' + tx.toLocaleString() + ' / $' + COVERED_EXPATRIATE.avg_tax_5y_usd.toLocaleString(),
      hit: isCoveredByTax,
    });
    lines.push({
      label: t('family.renunciation.test.compliance'),
      value: t('family.renunciation.test.compliance.value'),
      hit: false,
      info: true,
    });
    lines.forEach((line) => {
      analysis.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 'var(--tb-fs-12)' },
      },
        el('span', null,
          el('span', { style: { color: line.hit ? 'var(--tb-error)' : (line.info ? 'var(--tb-text-soft)' : 'var(--tb-success)'), marginRight: '6px', fontWeight: '700' } },
            line.hit ? '✓' : (line.info ? 'ℹ' : '○')),
          line.label),
        el('span', { style: { fontFamily: 'var(--tb-font-mono)', color: line.hit ? 'var(--tb-error)' : 'var(--tb-text-soft)' } }, line.value),
      ));
    });
    card.appendChild(analysis);

    // Process & cost overview
    const ul = el('ul', { style: { paddingLeft: '20px' } });
    [
      'family.renunciation.process.fee',
      'family.renunciation.process.consulate',
      'family.renunciation.process.cln',
      'family.renunciation.process.exit_tax',
      'family.renunciation.process.irrevocable',
      'family.renunciation.process.children',
    ].forEach((k) => ul.appendChild(el('li', { style: { marginBottom: '6px' } }, t(k))));
    card.appendChild(ul);

    // Status
    if (r.target_year) {
      card.appendChild(el('div', { class: 'tb-field-help', style: { marginTop: 'var(--tb-sp-2)' } },
        t('family.renunciation.target_year') + ': ' + r.target_year));
    }
    if (r.consultation_complete) {
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'rgba(47, 111, 78, 0.06)',
          borderLeft: '3px solid var(--tb-success)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
      }, '✓ ' + t('family.renunciation.consultation_done')));
    } else {
      card.appendChild(el('div', {
        style: { padding: 'var(--tb-sp-2) var(--tb-sp-3)', background: 'rgba(185, 122, 26, 0.06)',
          borderLeft: '3px solid var(--tb-warn)', borderRadius: 'var(--tb-radius-1)',
          marginTop: 'var(--tb-sp-2)', fontSize: 'var(--tb-fs-12)' },
      }, '⚠ ' + t('family.renunciation.consultation_pending')));
    }
    return card;
  }

  function openRenunciationModal() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const root = document.getElementById('tb-modal-root');
    const draft = Object.assign({}, getRenunciation());

    const backdrop = el('div', { class: 'tb-modal-backdrop' });
    const modal = el('div', { class: 'tb-modal' });
    backdrop.appendChild(modal);
    function close() { root.innerHTML = ''; }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    modal.appendChild(el('h2', { style: { marginTop: 0 } }, t('family.modal.renunciation')));

    function field(label, input, help) {
      return el('div', { class: 'tb-field' },
        el('label', { class: 'tb-field-label' }, label),
        input,
        help ? el('div', { class: 'tb-field-help' }, help) : null,
      );
    }

    const cb1 = el('input', { type: 'checkbox', checked: !!draft.contemplating,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.contemplating = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        cb1, t('family.renunciation.contemplating'))));

    modal.appendChild(field(t('family.renunciation.target_year'),
      el('input', { type: 'number', class: 'tb-input', min: '2024', max: '2050',
        value: draft.target_year || '',
        oninput: (e) => { draft.target_year = parseInt(e.target.value, 10) || null; } })));

    modal.appendChild(field(t('family.renunciation.estimated_net_worth'),
      el('input', { type: 'number', class: 'tb-input', step: '10000', min: '0',
        value: draft.estimated_net_worth_usd != null ? draft.estimated_net_worth_usd : '',
        placeholder: '2000000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.estimated_net_worth_usd = isFinite(v) ? v : null;
        } }),
      t('family.renunciation.estimated_net_worth.help')));

    modal.appendChild(field(t('family.renunciation.estimated_avg_tax'),
      el('input', { type: 'number', class: 'tb-input', step: '1000', min: '0',
        value: draft.estimated_avg_tax_5y_usd != null ? draft.estimated_avg_tax_5y_usd : '',
        placeholder: '50000',
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          draft.estimated_avg_tax_5y_usd = isFinite(v) ? v : null;
        } }),
      t('family.renunciation.estimated_avg_tax.help')));

    const cb2 = el('input', { type: 'checkbox', checked: !!draft.consultation_complete,
      style: { marginRight: '8px' },
      onchange: (e) => { draft.consultation_complete = !!e.target.checked; } });
    modal.appendChild(el('div', { class: 'tb-field' },
      el('label', { class: 'tb-field-label', style: { display: 'flex', alignItems: 'center' } },
        cb2, t('family.renunciation.consultation_complete'))));

    modal.appendChild(field(t('family.field.notes'),
      el('textarea', { class: 'tb-input', rows: 3,
        oninput: (e) => { draft.notes = e.target.value; } }, draft.notes || '')));

    const btnRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--tb-sp-2)', marginTop: 'var(--tb-sp-4)' } });
    btnRow.appendChild(el('button', { class: 'tb-btn tb-btn--secondary', type: 'button', onclick: close }, t('family.cancel')));
    btnRow.appendChild(el('button', { class: 'tb-btn', type: 'button',
      onclick: () => { setRenunciation(draft); close(); rerender(); } }, t('family.save')));
    modal.appendChild(btnRow);

    root.innerHTML = '';
    root.appendChild(backdrop);
  }

  // ─── Resources ────────────────────────────────────────────────────

  function buildResourcesCard() {
    const el = TB.utils.el;
    const t = TB.i18n.t;
    const card = el('div', { class: 'tb-card', 'data-track': 'family' });
    card.appendChild(el('h2', { style: { marginTop: 0 } }, '📚 ' + t('family.section.resources')));

    function resource(title, desc, url) {
      return el('div', {
        style: {
          padding: 'var(--tb-sp-2) var(--tb-sp-3)',
          borderLeft: '3px solid var(--tb-track-family)',
          background: 'var(--tb-bg)', borderRadius: 'var(--tb-radius-1)',
          marginBottom: 'var(--tb-sp-2)',
        },
      },
        el('div', { style: { fontWeight: '600' } }, title),
        el('div', { class: 'tb-field-help', style: { margin: '4px 0' } }, desc),
        url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--tb-navy)', fontSize: 'var(--tb-fs-12)' } }, url + ' →') : null,
      );
    }
    card.appendChild(resource(t('family.resources.moj.title'), t('family.resources.moj.body'),
      'https://www.moj.go.jp/EN/MINJI/minji06.html'));
    card.appendChild(resource(t('family.resources.state_renunciation.title'), t('family.resources.state_renunciation.body'),
      'https://travel.state.gov/content/travel/en/legal/travel-legal-considerations/Relinquishing-US-Nationality-Abroad.html'));
    card.appendChild(resource(t('family.resources.embassy_japan.title'), t('family.resources.embassy_japan.body'),
      'https://jp.usembassy.gov/services/citizenship-services/loss-u-s-citizenship/'));
    card.appendChild(resource(t('family.resources.irs_expatriation.title'), t('family.resources.irs_expatriation.body'),
      'https://www.irs.gov/individuals/international-taxpayers/expatriation-tax'));
    card.appendChild(resource(t('family.resources.nta_gift.title'), t('family.resources.nta_gift.body'),
      'https://www.nta.go.jp/english/taxes/individual/12011.htm'));
    return card;
  }

  // ====================================================================
  // Action Center generators
  // ====================================================================

  function genPassportExpiring() {
    const t = TB.i18n.t;
    const out = [];
    getMembers().forEach((m) => {
      ['passport_us', 'passport_jp'].forEach((k) => {
        const pp = m[k];
        if (!pp || !pp.expires) return;
        const days = daysUntil(pp.expires);
        if (days == null) return;
        if (days < 0 || days > 270) return;
        const country = k === 'passport_us' ? 'US' : 'JP';
        const name = m.name_en || m.name_jp || 'family member';
        out.push({
          id: 'family_passport_' + m.id + '_' + k,
          group: 'family',
          urgency: days <= 60 ? 'high' : days <= 120 ? 'medium' : 'low',
          icon: '🛂',
          title: t('fam.genPassportExpiring.title', { country, name, days }),
          body: t('fam.genPassportExpiring.body.' + (country === 'US' ? 'us' : 'jp'), { expires: pp.expires }),
          deadline: pp.expires,
          module: 'family',
          snoozable: days > 60,
        });
      });
    });
    return out;
  }

  function genNationalityChoiceApproaching() {
    const t = TB.i18n.t;
    const out = [];
    getMembers().forEach((m) => {
      if (m.relationship !== 'child') return;
      if (!isDualCitizen(m)) return;
      if (m.nationality_choice_made) return;
      const choiceDate = nationalityChoiceDate(m.birth_date);
      const days = daysUntil(choiceDate);
      if (days == null) return;
      if (days > 365 * 3) return; // start showing 3y out
      const name = m.name_en || m.name_jp || 'child';
      const past = days < 0;
      // Article 14 is a non-penalized "duty of effort" (努力義務): missing the
      // date triggers NO automatic loss. Japanese nationality is lost only if
      // the Minister of Justice issues a written demand (催告) and it goes
      // unanswered for a month — and that demand has never been issued to
      // anyone. So a past deadline is LOW urgency + dismissible, not a red
      // "OVERDUE" alarm. (Article 11 — automatic loss on VOLUNTARILY acquiring
      // a foreign nationality — is the provision with teeth, and it does not
      // apply to a child who was dual from birth.)
      const urgency = past ? 'low' : (days <= 365 ? 'medium' : 'low');
      const years = Math.floor(days / 365);
      const title = t('fam.genNationalityChoiceApproaching.title.' + (past ? 'past' : 'future'), { name, years });
      const body = t('fam.genNationalityChoiceApproaching.body.' + (past ? 'past' : 'future'), { name, years });
      out.push({
        id: 'family_natchoice_' + m.id,
        group: 'family',
        urgency,
        icon: '⚖',
        title,
        body: body,
        deadline: choiceDate,
        module: 'family',
        snoozable: true,
      });
    });
    return out;
  }

  function genYearEndGiftOpportunity() {
    const t = TB.i18n.t;
    const out = [];
    const today = new Date();
    const month = today.getMonth() + 1;
    if (month < 11) return out;  // only fire Nov + Dec
    // Have we logged any gifts this year?
    const yr = today.getFullYear();
    const giftsThisYear = getGiftsLog().filter((g) => g.year === yr && g.vehicle === '暦年贈与');
    const recipients = getMembers().filter((m) =>
      m.relationship === 'child' || m.relationship === 'spouse'
    );
    if (recipients.length === 0) return out;
    const usedRecipients = new Set(giftsThisYear.map((g) => g.recipient_id));
    const availableRecipients = recipients.filter((r) => !usedRecipients.has(r.id));
    if (availableRecipients.length === 0) return out;
    const dec31 = new Date(yr + '-12-31T00:00:00');
    const days = TB.utils.daysUntil(dec31);
    if (TB.utils.isPastDeadline(dec31)) return out;
    out.push({
      id: 'family_year_end_gift_' + yr,
      group: 'family',
      urgency: days <= 14 ? 'high' : 'medium',
      icon: '🎁',
      title: t('fam.genYearEndGiftOpportunity.title', { count: availableRecipients.length }),
      body: t('fam.genYearEndGiftOpportunity.body', { count: availableRecipients.length }),
      deadline: TB.utils.localIsoDate(dec31),
      module: 'family',
      snoozable: true,
    });
    return out;
  }

  function genEduSunsetWarning() {
    const t = TB.i18n.t;
    const out = [];
    const sunset = (window.TB && TB.constants && TB.constants.GIFT_SUNSET.education) || '2026-03-31';
    const days = daysUntil(sunset);
    if (days == null || days < 0 || days > 540) return out;
    // Only fire if user has dual or JP children (potential grandchildren in scope)
    const a = TB.state.get('onboarding.answers') || {};
    const fam = Array.isArray(a.family) ? a.family : [a.family].filter(Boolean);
    const hasKids = fam.some((f) => f === 'us_children' || f === 'jp_children' || f === 'dual_children')
      || getMembers().some((m) => m.relationship === 'child');
    if (!hasKids) return out;
    out.push({
      id: 'family_edu_lump_sunset',
      group: 'family',
      urgency: days <= 90 ? 'high' : 'medium',
      icon: '🎓',
      title: t('fam.genEduSunsetWarning.title', { sunset, days }),
      body: t('fam.genEduSunsetWarning.body'),
      deadline: sunset,
      module: 'family',
      snoozable: true,
    });
    return out;
  }

  function genRenunciationConsultation() {
    const t = TB.i18n.t;
    const r = getRenunciation();
    if (!r.contemplating) return [];
    if (r.consultation_complete) return [];
    return [{
      id: 'family_renunciation_consult',
      group: 'family',
      urgency: 'medium',
      icon: '🪪',
      title: t('fam.genRenunciationConsultation.title'),
      body: t('fam.genRenunciationConsultation.body'),
      module: 'family',
      snoozable: true,
    }];
  }

  // ====================================================================
  // Module registration + public API
  // ====================================================================

  window.TB = window.TB || {};
  window.TB.modules = window.TB.modules || {};
  window.TB.modules[id] = { id, label_en: 'Family', label_jp: '家族', render, searchSections: SECTIONS };

  window.TB.family = {
    actionGenerators: [
      genPassportExpiring, genNationalityChoiceApproaching,
      genYearEndGiftOpportunity, genEduSunsetWarning, genRenunciationConsultation,
    ],
    getMembers, isDualCitizen, ageInYears, nationalityChoiceDate,
    GIFT_VEHICLES, EDU_VEHICLES, COVERED_EXPATRIATE, RELATIONSHIPS,
  };
})();
