# Taigan Bridge — Disclaimer Text

These strings are referenced from the persistent banner, the About
modal, and the per-module disclaimers shown the first time a user
opens any planning module. They are kept here so legal-sensitive
language has a single source of truth.

## Persistent banner (top of every screen)

**EN:** Organizational tool only. Not financial, tax, or legal advice.

**JP:** 整理用ツールです。金融・税務・法律のアドバイスではありません。

## Generic module disclaimer (first-view modal)

**EN:**
This module is an organizational tool. It is not financial, tax, or
legal advice. The author is not a licensed CPA, tax attorney, financial
advisor, or fiduciary. The numbers, timelines, and scenarios shown
here are illustrative ranges based on commonly cited examples — not
predictions about your specific situation. Consult qualified
professionals before acting on any output from this tool.

**JP:**
本モジュールは整理用ツールです。金融・税務・法律のアドバイスではありません。
本ツールの作成者は、認定 CPA・税理士・ファイナンシャル・アドバイザーでは
なく、受託者でもありません。表示される数値・タイムライン・シナリオは、
一般に知られている事例に基づく説明的な範囲であり、あなたの個別の状況に
ついての予測ではありません。本ツールの出力に基づいて行動する前に、必ず
有資格の専門家にご相談ください。

## SOFA Roth Sequencing Planner — triple-confirmation language

**EN:**
The order of these four steps — retirement / Roth distribution / 住民票
registration / Japanese health insurance enrollment — has consequences
measured in years of household income. There is no version of this
plan that should be executed without a qualified cross-border CPA in
the loop. Your acknowledgment below is a record that you understand
this tool is *organizing your thinking*, not advising you.

**Step 1 of 3:** I understand that Taigan Bridge is not financial,
tax, or legal advice.

**Step 2 of 3:** I understand that the cost-of-mistake numbers shown
are illustrative ranges, not predictions about my situation.

**Step 3 of 3:** I commit to confirming any sequencing decision with
a qualified cross-border CPA before acting.

**JP:**
本モジュールで扱う4つのステップ —— 退職・Roth 分配・住民票登録・国民
健康保険加入 —— の順序は、家計の数年分の所得に相当する影響をもたらす
可能性があります。クロスボーダーに精通した CPA / 税理士の関与なしに、
この計画を実行すべきではありません。以下の確認は、本ツールが助言ツール
ではなく、思考整理ツールであることを理解した記録となります。

**3 つのうち 1 つ目:** Taigan Bridge は金融・税務・法律のアドバイス
ではないことを理解しています。

**3 つのうち 2 つ目:** 表示される「誤りの代償」の数値は、自分の状況
の予測ではなく、説明的な範囲であることを理解しています。

**3 つのうち 3 つ目:** 順序に関する判断を実行する前に、必ず有資格の
クロスボーダー CPA に確認することを約束します。

## FBAR / FinCEN 114

### Module first-view modal (FBAR Tracker, v0.2.1)

**EN:**
Taigan Bridge helps you organize the information you'll need to
file FBAR (FinCEN Form 114). It does not file on your behalf and
is not a substitute for professional tax advice. FBAR rules,
thresholds, exchange rates, and penalties change. Always verify
current requirements at fincen.gov before filing. If you are
behind on FBAR filings, consult a tax attorney or CPA familiar
with the IRS Streamlined Filing Compliance Procedures before
taking action.

**JP:**
Taigan Bridge は FBAR(FinCEN Form 114)提出に必要な情報を整理する
ためのツールです。提出代行は行わず、専門家のアドバイスに代わるもの
ではありません。FBAR の規則・基準額・為替レート・罰則は変更される
ことがあります。提出前に必ず fincen.gov で最新要件をご確認ください。
過去年度を未提出の場合、IRS の Streamlined Filing Compliance
Procedures に詳しい税理士・税務弁護士に相談してから行動してください。

### Persistent banner (Yearly Balances and Print Summary tabs)

**EN:** Verify current FBAR rules and FX rates at fincen.gov and
fiscal.treasury.gov before filing.

**JP:** 提出前に fincen.gov および fiscal.treasury.gov で最新の
FBAR 規則と為替レートをご確認ください。

### FX rate verification banner

**EN:** FX rates require verification — confirm against
fiscal.treasury.gov before filing.

**JP:** 為替レートは要確認 — 提出前に fiscal.treasury.gov で照合
してください。

### Encryption notice (until v0.3 ships encrypted export)

**EN:** Heads up: in this build, exported backups are plain JSON.
Encrypted export ships in v0.3. If your backup will leave this
machine, encrypt the file at the OS level (e.g., a password-
protected zip) for now.

**JP:** お知らせ:本ビルドではエクスポートしたバックアップは平文 JSON
です。暗号化エクスポートは v0.3 で提供予定です。バックアップを本端末
外へ持ち出す場合は、暫定的に OS レベルでパスワード付き ZIP 等として
保護してください。

### What the tool will and will NOT collect

The FBAR module deliberately collects:
- SSN: last 4 digits only.
- Account numbers: stored locally in plaintext, displayed masked
  by default.
- Filer names, balances, FX rates: stored locally in localStorage.

The FBAR module deliberately does NOT collect:
- Full SSNs (the actual FBAR filing on FinCEN BSA E-Filing System
  requires the full number; that's where it goes — not here).
- Bank passwords, online banking credentials, security questions.
- Anything that would let an intruder access your accounts.

The AI integration sanitizer (TB.ai.callClaudeWithFbarContext)
sends only category counts (e.g., "3 bank accounts in JP, 1
securities account, aggregate over threshold for 2024"), never
raw account numbers, balances, names, or dates.

### Vision-based document upload (v0.2.2 — user-initiated only)

When the user explicitly clicks **Upload bank document** on the
FBAR Accounts tab, the selected image or PDF is sent directly from
the browser to api.anthropic.com using the user's own API key.
This is the one path where raw FBAR data leaves the browser, and
it is gated by:

- A **per-image consent modal** that names the destination
  (api.anthropic.com), shows the file name / size / type, and
  states an approximate cost. The user must click "Send to
  Claude" each time — there is no "trust this site / always
  allow" option.
- **Memory-only handling**. The image bytes never touch
  localStorage or any other persistent store. Garbage-collected
  as soon as the modal closes.
- **No author visibility**. The author cannot intercept the
  request — it goes browser → api.anthropic.com directly.
  Anthropic's privacy policy applies to what they receive.
- **Verification banner**. Every account record created from an
  upload carries an "AI-extracted from <filename> — please verify
  every field" banner that persists until the user clicks "Mark
  verified."

Background AI features (suggestions, explanations) continue to
use only the sanitized category-count summary. The "no raw FBAR
data to AI" rule is now precisely: "no *background* raw data to
AI; user-initiated calls via per-action consent modals are the
documented exceptions."

### AI Enrich Account (v0.2.9 — second user-initiated exception)

Clicking "✨ AI enrich" on an account card sends ONLY the
institution-level metadata to Claude:

  - institution_name
  - institution_address
  - country
  - currency
  - account_type

Account number (full or masked), filer names, balances, and notes
are **never** included in the enrichment payload. The consent
modal explicitly displays the complete payload before any
transmission so the user can verify nothing PII-bearing leaks.

Claude returns canonical institution facts (HQ address, romanized
English name, SWIFT/BIC, primary deposit currency) using its
training knowledge. Every suggestion goes through a per-field
review modal where the user explicitly checks the boxes for
suggestions they want to apply. Nothing is auto-applied.

## Document Vault

**EN:**
Do not store passwords, account numbers, or other secrets in this
tool. The Document Vault is an *index* — it records WHERE your
accounts and documents are, not the credentials themselves. Store
secrets in a dedicated password manager.

**JP:**
本ツールにパスワード・口座番号・その他の機密情報を保存しないでください。
ドキュメント保管庫は「インデックス」です — 口座や書類が「どこにあるか」
を記録するもので、認証情報そのものを保存するものではありません。秘密
情報は専用のパスワードマネージャーに保管してください。
