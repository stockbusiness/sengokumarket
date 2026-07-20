# 千ノ国代理店システム 外部開発者向け連携ガイド(v3.6.78-draft)実装状況調査

- 対象文書: 「千ノ国 代理店システム 外部開発者向け連携ガイド」Version 3.6.78-draft
- 対象システム: 本リポジトリ(戦国楽市楽座 / sengokumarket、ガイドでいう`sengoku-rr`)
- 目的: 現行の代理店システム(`sengoku-ai.com`)連携コードと本ガイドを突き合わせ、実装状況を報告する

---

## 実装状況サマリー

| 領域 | 状態 | 詳細 |
|---|---|---|
| 認証(受信側 `x-api-key`/`Bearer`) | 実装済み(形式は一致、エラー本文は要更新) | `middleware/integrationAuth.ts` |
| 代理店階層取得API(§7) | ほぼ実装済み(軽微な差分あり) | `services/externalAgencySystem.ts` |
| 代理店同期API(§8, 送信側) | 実装済み(余剰フィールドあり) | `services/externalAgencySystem.ts` |
| SSO(§12) | 実装済み・ガイドの仕様と高い整合性 | `services/agencySso.ts` |
| 共通顧客ID API(§9) | 未実装 | 該当コードなし |
| 紹介・成果連携API(§10) | 未実装 | 該当コードなし |
| イベント受信(§11.1) | 部分実装だった(`connection_test`のみ。他は無条件に代理店upsertとして処理され、形式次第で422になり得た) | `routes/integrations/agencies.ts` |
| エラー・成功レスポンス形式(§13) | 旧バージョン(v3.6.40)の`{success, data}`形式のままだった | `lib/apiError.ts`, `routes/integrations/agencies.ts` |
| 冪等性キー(§6.2) | 未対応だった | 送信側に`Idempotency-Key`なし |

---

## 詳細

### 1. 認証(§6.1)
`requireAgencyApiKey`は`x-api-key`/`Authorization: Bearer`の両方を受け付け、`timingSafeEqual`で照合しており、ガイドの認証方式と一致。

### 2. 代理店階層取得API(§7)
`fetchExternalAgencyHierarchy()`は`GET /api/hierarchy.php?format=tree&include_contact=1`を呼んでおり基本は一致。レスポンスの`tree`/`data`キーのフォールバック順で実害はないが、新規追加された`labels`/`projects`/`lp_urls`/`sso_urls`/`person_name`/`role_label`は未使用。

### 3. 代理店同期API(§8)
`pushAgencyCandidateToExternalSystem()`は`event: 'upsert'`, `source: 'sengoku-rr'`という、ガイド§8.1のリクエスト例にはないフィールドを送信している。相手側が未知フィールドを無視する前提であれば問題ない。

### 4. SSO(§12)
RS256署名検証、JWKS取得(`kid`一致)、`iss`/`aud`/`exp`検証、`jti`のDB一意制約によるリプレイ防止まで実装されており、ガイド§12.5の検証手順とほぼ1対1で対応。現時点で最も新ガイドに準拠している箇所。

### 5. 共通顧客ID API(§9)・紹介成果連携API(§10) — 未実装
- `POST /api/common-users/resolve`: 新規登録・ゲスト購入時のアカウント作成(`auth.ts`, `checkout.ts`)から一切呼ばれていない。`common_user_id`という概念がコード上に存在しない。
- `POST /api/referrals/capture` / `POST /api/referrals/confirm`: 現行の紹介コード解決(`services/referral.ts`)はこのDB内の`ReferralLink`テーブルのみを参照する完全ローカル処理で、`sengoku-ai.com`への問い合わせを一切行っていない。

これは千ノ国5システム方針書の差分報告で指摘した「共通顧客HUB非統合」を、具体的なAPI仕様として裏付けるものであり、影響範囲が大きく(会員登録・ゲスト購入・注文確定のクリティカルパスに外部HTTP呼び出しを追加し、失敗時の扱い・タイムアウト方針・紹介の不変性ルールとの整合を要設計)、**今回は実装対象から除外し、要検討事項として報告に留める**(下記「今回実装しなかった項目」参照)。

### 6. イベント受信(§11.1)
修正前は`event === 'connection_test'`以外のPOSTを全て「代理店の作成・更新」として無条件に処理していたため、`lead_created`や`common_user.merged`等、`external_id`/`name`を持たない形式のイベントが届くと422エラーとなり、相手側で再送対象として溜まり続ける状態だった。今回、既知の代理店ライフサイクル系イベントは既存のupsert処理へ、`common_user.*`・`lead_created`はデータモデルが未整備なため200 OKで受理しつつ処理をスキップする形に修正した(詳細は下記「実施した実装」参照)。

### 7. エラー・成功レスポンス形式(§13)
旧仕様(v3.6.40)の`{success: false, message}` / `{success: true, data: {...}}`から、新ガイドの`{ok: false, error: {code, message}}` / `{ok: true, ...}`(フラット構造)へ更新した。

### 8. 冪等性キー(§6.2)
送信側(`pushAgencyCandidateToExternalSystem`)に`Idempotency-Key`ヘッダーを追加した。

---

## 実施した実装

1. `lib/apiError.ts`: `sendIntegrationError`を`{ok:false, error:{code,message}}`形式に変更(コード引数を追加)
2. `middleware/integrationAuth.ts`: エラーコードを`API_KEY_REQUIRED`/`INVALID_API_KEY`/`AGENCY_API_KEY_NOT_CONFIGURED`に分けて返すよう変更
3. `routes/integrations/agencies.ts`:
   - 成功レスポンスを`{ok:true, ...}`のフラット形式に変更
   - `event`フィールドで分岐し、代理店ライフサイクル系イベント(`admin_created`/`admin_updated`/`role_updated`/`approved`/`promoted`/`deactivated`/`deleted`/`upsert`/未指定)は既存のupsert処理へ、`lead_created`/`common_user.merged`/`common_user.assigned_agent.updated`は200 OKで受理しつつ処理をスキップ(コメントで理由を明記)
   - バリデーションエラーに`VALIDATION_ERROR`コードを付与
4. `services/externalAgencySystem.ts`: 送信時に`Idempotency-Key`ヘッダーを追加。相手からのレスポンス形式が`{ok, ...}`(新)・`{success, data}`(旧)どちらでも解釈できるよう防御的に対応

## 今回実装しなかった項目(要個別確認)

- **共通顧客ID API(§9)・紹介成果連携API(§10)への対応**: `common_user_id`の導入、新規登録・ゲスト購入時の`POST /api/common-users/resolve`呼び出し、紹介コード解決を`POST /api/referrals/capture`/`confirm`経由に置き換えるかどうかは、チェックアウトのクリティカルパスに外部HTTP依存を追加することになり、失敗時の扱い(注文をブロックするか、ベストエフォートで進めるか)、既存の`ReferralLink`ベースの紹介解決との共存方法、千ノ国方針書で未確定だった「代理店・紹介の正本をこのDBに残すか代理店システムへ移管するか」という論点と直結するため、個別の設計確認なしに実装しない
- **`lead_created`/`common_user.merged`/`common_user.assigned_agent.updated`の実処理**: 200 OKで受理はするが、実際にLP問い合わせを保存したり共通顧客情報を反映する処理は、対応するデータモデル(共通顧客HUB関連テーブル)が存在しないため未実装
- **代理店階層レスポンスの新規フィールド(`labels`/`projects`/`lp_urls`/`sso_urls`等)の活用**: 取得はできるが、画面表示等での利用は別途要望次第
