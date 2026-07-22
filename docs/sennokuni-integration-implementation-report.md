# 千ノ国プロジェクト全体連携 実装報告(2026-07-21指示分)

対象指示: `00_COMMON_INTEGRATION_CONTRACT.md` / `02_SHOPPING_SYSTEM_INSTRUCTIONS.md` / `SYSTEM_INTEGRATION_ANALYSIS_全体統合_2026-07-21.md` を踏まえた、ショッピングシステム側の受け入れ実装。

重点指示だった以下5点について、**既存決済フローを壊さないこと最優先**で実装しました。

- common_user_id
- agency_id(4種のロール)
- referral_token
- Stripe後の権利付与
- Webhookの冪等性

結論から: 今回のスコープは「外部システムと安全にやり取りできる土台(スキーマ・記録・冪等性)を作ること」で、**外部システムへの実際のHTTP呼び出しは含んでいません**(理由は「5. 未対応事項」参照)。既存の決済・在庫・NFT発行・報酬計算のロジックには一切手を入れておらず、追加したテーブル・カラムはすべてnull許容またはデフォルト値付きです。

---

## 1. DB変更

マイグレーション: `server/prisma/migrations/20260715020000_sennokuni_integration_contract/migration.sql`
ロールバック手順: 同ディレクトリの `rollback.sql`(新規追加テーブル・カラムのDROPのみ。既存テーブルの既存カラムには触れません)

### 1.1 `stripe_events`(既存テーブルの拡張・Webhook冪等性)

Webhookの冪等性を「Inbox方式」の状態機械に作り替えるための拡張です。

| カラム | 型 | 内容 |
|---|---|---|
| `status` | text, default `'processing'` | `processing` \| `succeeded` \| `failed_retryable` \| `failed_terminal` |
| `attempt_count` | int, default `1` | 試行回数。10回超で`failed_terminal`に固定 |
| `payload_hash` | text, NOT NULL | 受信ペイロードのSHA-256。同一event_idで内容が異なる再送を検知するため |
| `last_error` | text, nullable | 直近の失敗内容 |
| `processing_started_at` | timestamp, nullable | スタック検知(5分)用 |
| `processed_at` | nullable化 | 旧: NOT NULL → 新: nullable(処理未完了の行を許容するため) |

既存1,404件は `processed_at IS NOT NULL` の行を `status='succeeded'`、`payload_hash`は`'legacy-unknown'`で安全にバックフィール済み(ローカルdev DBで`prisma migrate deploy`実行・`psql`で `succeeded | 1404` を確認済み)。

### 1.2 `orders`(既存テーブルの拡張・注文時スナップショット)

契約書にある4種の代理店ロールと共通ユーザーIDを、注文時点の値としてスナップショットするカラムを追加しました。**既存の`agencyId`/`influencerId`/`referralLinkId`(このDB内のUUID・報酬計算の対象)とは完全に別物として扱っており、混同・自動転用は一切していません。**

| カラム | 契約書上の名称 | 用途 |
|---|---|---|
| `common_user_id` | common_user_id | 代理店システムの共通顧客HUBが発行するID(`cu_...`)。このシステムは発番しない |
| `common_user_resolution_status` | - | `unresolved`(既定)\|`resolved`\|`skipped` |
| `registration_referrer_agency_id` | registration_referrer_agency_id | 初回接点の代理店(ロック) |
| `assigned_agency_id` | assigned_agency_id | 現在の担当代理店 |
| `sales_agent_id` | sales_agent_id | 営業担当 |
| `closing_agent_id` | closing_agent_id | クロージング担当 |
| `referral_session_key` | referral_session_key | referral_tokenの正規化後のセッションキー |
| `correlation_id` | correlation_id | 下流イベントの相関ID(未設定時は注文ID自体を使用) |

すべてnullable・現状は常にnull/`unresolved`です(理由は5章)。

### 1.3 `users`(既存テーブルの拡張)

- `common_user_id`(unique, nullable): このユーザーに対応する共通顧客HUBのID

### 1.4 `external_identities`(新規テーブル)

代理店システム等、外部システムのユーザーIDとこのシステムのユーザーの対応表(`system_account_links`相当)。`@@unique([system_key, external_user_id])`、`common_user_id`にインデックス。現状レコードは0件(実際の連携呼び出しがまだ無いため)。

### 1.5 `product_integration_rules`(新規テーブル)

商品ごとに「決済確定時、どの下流システムへ何の権利付与イベントを送るか」を設定するルールテーブル。`product_id`にunique制約(1商品1ルール)。

| カラム | 内容 |
|---|---|
| `entitlement_target_system_key` | 送信先(`sengoku-passport`\|`ove-wallet`\|`ai-art-school`等) |
| `entitlement_type` | 権利種別(自由記述) |
| `revoke_on_refund` | 全額返金時に`entitlement.revoked`も送るか(既定true) |

現状レコードは0件です(評議員NFTは本システム単独で完結する運用のため、意図的に未設定)。

### 1.6 `integration_outbox_events`(新規テーブル)

決済確定・全額返金と**同一トランザクション**で記録する送信待ちイベントのOutbox。

| カラム | 内容 |
|---|---|
| `event_id` | `evt_...`形式、unique |
| `event_type` | `entitlement.granted`\|`entitlement.revoked`等 |
| `destination_system_key` | 送信先 |
| `payload` / `payload_hash` | 送信内容とそのハッシュ |
| `status` | `pending`(既定)\|`processing`\|`succeeded`\|`failed`\|`dead` |
| `attempt_count` / `next_attempt_at` / `last_error` | 送信リトライ用(ディスパッチャ未実装のため現状未使用) |

---

## 2. API変更(すべて新規追加。既存APIへの変更なし)

管理API(`/api/admin/...`、`requireAdmin`ミドルウェアで一括保護・`admin`/`admin_viewer`のみ、`staff`は403):

- `GET /api/admin/stripe-events?status=` — Webhook処理状況の一覧(`processing`/`succeeded`/`failed_retryable`/`failed_terminal`で絞り込み可)
- `POST /api/admin/stripe-events/:id/retry` — `failed_retryable`/`failed_terminal`のイベントをStripeから再取得し、管理者が明示的に再処理する
- `GET /api/admin/integration-outbox?status=` — Outboxの送信状況一覧(`pending`/`processing`/`succeeded`/`failed`/`dead`で絞り込み可)

外部連携用の公開API(`common_user_id`解決・`referral_token`のcapture/confirm等)は**未実装**です(5章参照)。

---

## 3. Webhook変更

`server/src/routes/stripeWebhook.ts` を「Inbox方式」の状態機械に書き換えました。

**旧実装の問題点**: `stripe_events`へのINSERT(event_idのUNIQUE制約による重複防止)を、業務処理より前に行っていました。そのため、INSERT後に業務処理(在庫確定・NFT発行キュー作成・報酬計算等)が例外で失敗すると、そのevent_idは既に「記録済み」となり、Stripeが自動再送してきても「重複」として即200を返してしまい、**その支払いの業務処理が永久に行われない**という欠陥がありました。

**新実装**: `claimStripeEventForProcessing`で`payload_hash`検証込みの条件付きクレームを行い、`status='processing'`のまま業務処理を実行、成功した場合のみ`succeeded`に遷移させます。

| 状況 | 挙動 |
|---|---|
| 同一event_id・同一payloadの再送 | `succeeded`済みなら200(重複、再処理しない) |
| 同一event_id・payload不一致 | 409(異常系。想定外の再利用を検知) |
| 処理中に別リクエストが到達 | 200(進行中に委ねる。ただし5分超過でスタック扱いし再クレーム可能) |
| 業務処理が例外を投げた | `failed_retryable`にして500を返す → Stripeが自動再送 → 次回はきちんと業務処理から再実行される |
| 10回失敗 | `failed_terminal`にして200(Stripeの無限リトライを止め、`/admin/stripe-events/:id/retry`での手動再試行を待つ) |

`express.raw()`によるルート定義順序(CLAUDE.md「変更禁止範囲」)は変更していません。

### Stripe後の権利付与(entitlement)

`applyPaidOrderSideEffects`(決済確定・Stripe/銀行振込共通)と`handleChargeRefunded`の全額返金分岐に、`enqueueEntitlementEvents`を追加しました。決済確定・返金と**同一トランザクション**でOutboxに記録するため、下流システムが停止していても「決済が成立した事実」自体を失いません。`product_integration_rules`が未設定の商品(現状すべて)ではno-opです。

---

## 4. 接続テスト結果

**外部システムとの実接続テストは今回実施していません**(実施できません)。理由:

- 新契約(`X-SenNoKuni-Key-Id/Timestamp/Nonce/Signature`のHMAC方式)の認証情報(Key/Secret)が未発行
- OVE Walletの独自HMAC方式(`X-OVE-*`)も同様に認証情報未発行
- 代理店システム側の`common_user_id`解決・`referral_token`capture/confirmの各エンドポイントの実URLが未確定(既存の外部開発者向けガイドとcommon contractとで仕様の差異が残っており未解消。前回報告済みの`docs/cross-system-integration-status.md`参照)

代わりに、以下の**内部自動テスト**をすべて実行し、全件成功しています。

```
Test Files  54 passed (54)
     Tests  347 passed (347)
```

うち、今回の変更に関連する新規テスト:

- `server/src/services/stripeEventInbox.test.ts`(8件): クレーム・成功・失敗・スタック再クレーム・最大試行超過・payload不一致検知など状態機械の全遷移
- `server/src/routes/stripeWebhook.test.ts` 追加分: `failed_retryable`→Stripe再送→実際に業務処理が再実行され注文がpaidになる、という中核の回帰シナリオ
- `server/src/services/integrationOutbox.test.ts`(4件): `enqueueOutboxEvent`の基本動作、ルール未設定商品でno-opになること(=既存商品すべてに対して無害であることの確認)、ルール設定時のペイロード形状、`revoke_on_refund=false`の挙動
- `server/src/routes/admin/integrationOutbox.test.ts`(4件)・`stripeEvents`関連: 管理API一覧・絞り込み・権限(admin_viewer閲覧可・staff403・未認証401)
- `server/src/routes/admin/staffAccess.test.ts`: 新設の`/stripe-events`・`/integration-outbox`もstaffには403であることを追加確認

また `npx tsc --noEmit` もクリーンです。

---

## 5. 未対応事項(意図的にスコープ外とした項目)

以下は「未着手」ではなく、認証情報・確定仕様が無い中で実接続コードを書くと事故の元になるため、**今回は意図的に見送りました**。土台(スキーマ・記録・冪等性)は用意済みのため、認証情報・仕様確定後に安全に着手できます。

1. **`common_user_id`解決の実呼び出し**(`POST /api/common-users/resolve`相当): HMAC認証情報が無いため未実装。`orders.common_user_id`/`common_user_resolution_status`は常にnull/`unresolved`のまま。
2. **`referral_token`のcapture/confirm実呼び出し**: 同様に未実装。加えて、新contractの`referral_token`の形状が、以前確認した代理店システムの外部開発者向けガイドと一部食い違っている点が未解消(要すり合わせ)。
3. **Outboxディスパッチャ(実HTTP送信・HMAC署名・リトライ)**: `integration_outbox_events`への記録・トランザクション連動までは実装済みですが、実際に下流へ送信する処理は未実装です。送信先が未確定の間は"安全に停止している"設計であり、宛先確定後にディスパッチャを追加すればそのまま送信を開始できます。
4. **OVE Wallet専用のHMACクライアント・`order_wallet_transactions`テーブル**: OVE Walletは独自の署名方式(`X-OVE-*`、idempotency_keyがヘッダでなくボディ)を使うため、汎用Outboxとは別に専用クライアントが必要と認識していますが、今回は未着手です。
5. **`product_integration_rules`の管理画面UI**: テーブル・APIの読み取りのみ実装済み。現状はルールが必要になった時点でDBに直接INSERTする運用です。
6. **パスポート連携**: 「一旦特にパスポート側との連携は不要」とのご回答を踏まえ、対応していません。
7. **AIアート教室連携**: 商品・価格情報が未共有のため対応不可(引き続き先方からの情報待ち)。
8. **Phase 0(契約合意)ゲートの状態**: 5システム全体でこのゲートが正式に通過しているかどうかは、ショッピングシステム側では確認できません。

### 参考: フィーチャーフラグ・残存リスク

- 今回の変更にフィーチャーフラグは導入していません(すべて追加のみ・既定値はno-op/dormantのため、フラグなしでも安全側に倒れます)。
- 残存リスク: (a) Webhookのスタック再クレーム閾値(5分)はヒューリスティックであり、実際に5分以上かかる処理があれば見直しが必要、(b) `failed_terminal`到達後は管理者の手動操作が必須(自動回復しない、意図した設計)、(c) Outboxはディスパッチャが無い間、`pending`のまま蓄積し続けるため、ディスパッチャ実装前に運用期間が長引く場合は定期的な件数監視を推奨します(`GET /admin/integration-outbox`で確認可能)。

---

## 追記: 2026-07-22指示書対応(P0・本番接続前必須事項)

対象指示書: `NEXT_IMPLEMENTATION_INSTRUCTIONS_20260722.md`(調査基準コミット`25da924`)。前回報告のInbox方式・共通IDスキーマ・CSRF fail-close等は維持したまま、以下5点を追加対応しました。外部連携の実HTTP接続は今回も追加していません。

### 変更ファイル一覧

```text
server/prisma/schema.prisma
server/prisma/migrations/20260722010000_stripe_event_processing_token/migration.sql
server/prisma/migrations/20260722010000_stripe_event_processing_token/rollback.sql
server/src/services/stripeEventInbox.ts
server/src/services/stripeEventInbox.test.ts
server/src/routes/stripeWebhook.ts
server/src/routes/admin/stripeEvents.ts
server/src/routes/admin/stripeEvents.test.ts(新規)
server/src/routes/admin/products.ts
server/src/routes/admin/products.test.ts
server/src/middleware/csrf.ts
server/src/routes/auth.test.ts
.github/workflows/ci.yml
docs/sennokuni-integration-implementation-report.md(本追記)
```

client側(`AdminProductEditPage.tsx`/`adminApi.ts`)は、既存の型・送信内容(`{ id, stock }`等の部分送信)がそのままサーバー側の修正と整合するため変更していません。

### Stage1: Stripe Inboxの所有権・競合修正

`stripe_events`に`processing_token`(nullable)を追加しました。staleなprocessing行の再クレームは、読み込んだ時点の`processing_started_at`/`processing_token`をWHERE条件に含めたCompare-And-Swapに変更し、`markStripeEventSucceeded`/`markStripeEventFailed`も呼び出し元が取得した`processing_token`が一致する場合のみ状態を更新するようにしました(`server/src/services/stripeEventInbox.ts`)。値が変化しないUPDATE(processing→processing)は行ロックだけでは同時実行を排除できないため、CASの鍵となる値自体を毎回更新する設計です。Webhook側(`stripeWebhook.ts`)と管理画面の手動再試行API(`admin/stripeEvents.ts`)の両方を、返却されたtokenを渡す形に変更しました。

### Stage2: 移行前(legacy)Stripeイベントとの互換性

`payload_hash='legacy-unknown'`かつ`status='succeeded'`の行は、実ペイロードのハッシュと一致しなくても`already_succeeded`として扱い、payload不一致判定より優先するようにしました。新方式で保存されたイベントのpayload不一致検知(409)は従来どおりです。

### Stage3: 商品バリエーション部分更新の修正

`admin/products.ts`のバリエーション更新をPATCH相当の部分更新に変更しました。未指定の`name`/`price`/`stock`は既存値を維持し、`sku`のみ、明示的に`null`を渡した場合だけ解除できるようにしています(旧実装は`sku: v.sku ?? null`により、未指定のたびにSKUが`null`へ上書きされていました)。**この問題は仮説ではなく、管理画面の在庫だけ編集するUI(`AdminProductEditPage.tsx`のクイック在庫編集)が実際に`{ id, stock }`のみを送信しているため、この修正前は在庫編集のたびに既存SKUが消失する実害が発生していました。** 新規バリエーション作成時は`name`・`price`を引き続き必須検証します。

### Stage4: CSRF Origin/Referer比較の厳密化

`Origin`・`Referer`・`APP_URL`をすべて`new URL(...).origin`でparseし、schema+host+portの厳密一致に変更しました(`server/src/middleware/csrf.ts`)。旧実装の`referer.startsWith(appUrl)`は、`APP_URL=https://example.com`に対し`https://example.com.evil.example/path`のような別オリジンを誤って通す文字列前方一致のバイパス経路があったため廃止しています。`APP_URL`が未設定・不正なURL文字列のいずれの場合もfail-closed(403)のままです。

### Stage5: CI・ブランチ

GitHub Actions APIで実行履歴を確認したところ`total_count: 0`——このリポジトリでCIは一度も実行されていませんでした。原因は`ci.yml`のpushトリガーが`main`のみである一方、実際の唯一のブランチは`claude/confirmation-needed-3wicju`で`main`は存在しないためです。今回は暫定対応として、pushトリガーに現行ブランチを追加しました(`branches: [main, claude/confirmation-needed-3wicju]`)。GitHub既定ブランチの`main`への統一・Vercel Production Branchの変更・branch protection設定は、権限・影響範囲の確認が必要なためこのセッションでは実施していません(下記「本番未確認事項」参照)。

### 商品価格仕様の判断ゲート(セクション9)について

このセッションからは本番DB(Supabase)に接続できないため、ローカル開発DBのみで確認しました(商品1件のみのデータで、価格差異なし)。**本番の実データはこのセッションからは確認できていません。** 本番での確認には、Supabase SQL Editorで以下を実行してください。

```sql
SELECT product_id, COUNT(DISTINCT price) AS distinct_prices
FROM product_variants GROUP BY product_id HAVING COUNT(DISTINCT price) > 1;
```

バリエーション別価格を許可するかどうかの仕様判断は行っておらず、価格仕様(basePrice変更時の全variant追従)自体も変更していません。

### テスト件数と結果

```
Test Files  55 passed (55)
     Tests  370 passed (370)
```

前回報告時(348件)から22件追加。`npx tsc --noEmit`も全ワークスペースでクリーン、`npm run build --workspace=client`も成功。

- **stale同時claimテスト結果**: 新規イベントへ5並列リクエスト→`process`1件・`in_progress`4件(`attempt_count`は1のまま)。staleなprocessing行へ5並列再クレーム→`process`1件・`in_progress`4件(`attempt_count`は2)。手動再試行とStripe自動再送(webhook側)が同一`failed_retryable`イベントへ同時到達するケースも、成功は必ず1件のみであることを確認(`stripeEventInbox.test.ts`・`admin/stripeEvents.test.ts`)。
- **古いtokenでの上書き防止テスト結果**: staleなprocessing行を先に別リクエストが再クレームした後、古い`processingToken`での`markStripeEventSucceeded`/`markStripeEventFailed`はどちらも状態を変更しない(0件更新で無視される)ことを確認。
- **legacy event互換テスト結果**: `payload_hash='legacy-unknown'`かつ`succeeded`の行は、異なる実ペイロードで再送しても`already_succeeded`(業務処理を再実行しない)。新方式でのpayload不一致は従来どおり`payload_mismatch`。
- **SKU保持テスト結果**: `{ id, stock }`のみの更新でSKU・name・priceが維持されること、`{ id, price }`のみの更新でSKU・name・stockが維持されること、`sku: null`を明示した場合のみSKUが解除されること、存在しないvariant IDは404で既存データも変更されないこと、負の価格は400になることを確認(`admin/products.test.ts`)。
- **CSRF origin比較テスト結果**: 正しいOrigin/Refererは通過、`APP_URL`末尾スラッシュの有無で誤拒否しない、`APP_URL`不正値(URLとしてparse不可)は403、`https://example.com.evil.example/path`のような前方一致のみのなりすましは403、を確認(`auth.test.ts`)。
- **CI実行結果**: GitHub Actions上での実行はこの追記時点では未確認(pushしてから実際に実行されるかはこの後の確認事項)。ローカルでは`npm ci`相当の依存関係のもとで`prisma migrate deploy`(空DB・既存DBの両方)・`tsc -b --noEmit`・`vitest run`・`npm run build --workspace=client`をすべて実行し成功を確認済みです。

### 本番未確認事項

- GitHub Actionsが実際にpush後に実行されるかどうか(ローカル確認のみ)。
- GitHub既定ブランチ・Vercel Production Branch・branch protectionの現状設定と、`main`への正式統一の可否(権限確認が必要)。
- 本番DBでのバリエーション別価格の実データ状況(上記SQLの実行結果)。
- 本番Supabaseへの`processing_token`カラム追加マイグレーションの手動適用(このリポジトリの既存運用どおり、Vercelはmigrationを自動実行しないため)。

### 外部接続未実装事項(この追記より前の状態)

前回報告時点では、認証情報・実エンドポイント・署名契約が未確定のため、`common_user_id`解決・`referral_token` capture/confirm・Outboxディスパッチャ・HMAC署名・外部システムへのHTTP送信・ウォレット`rewards/grant`/`REVERSAL`・`order.*`/`payment.*`汎用イベント送信を実装していませんでした。以下の追記で、これらを**Feature Flagで無効化したままの実装(dormant実装)**として追加しています。

---

## 追記2: 「02_SHOPPING_SYSTEM_PACKAGE.zip」対応(2026-07-22)

対象パッケージ: `00_READ_ME_FIRST.md` / `01_SYSTEM_INTEGRATION_CURRENT_STATE_2026-07-22.md` / `02_COMMON_INTERFACE_CONTRACT_V1_1_DRAFT.md` / `03_NEXT_ACTION_INSTRUCTIONS.md` / `04_SYSTEM_ANALYSIS_REFERENCE.md`。

このパッケージの確認結果、新たに実バグ2件を検出・修正し、また03章の「必須改修」(common_user resolve・referral capture/confirm・Outbox実送信・ウォレットreward連携)を、**`SENNOKUNI_INTEGRATION_ENABLED`環境変数(既定`false`)で無効化したdormant実装**として追加しました。共通契約(`02_COMMON_INTERFACE_CONTRACT_V1_1_DRAFT.md`)がDRAFTであり「署名テストベクトルとevent versionの合意前は本番有効化禁止」と明記されているため、実際の外部送信はこのフラグが明示的に`true`にならない限り一切発生しません。

### A. 新規バグ修正

1. **メールアドレスの大文字小文字正規化なし**(`04_SYSTEM_ANALYSIS_REFERENCE.md` 15.5): `User@example.com`と`user@example.com`で別アカウントが作れてしまう問題。登録・ログイン・パスワード再設定・代理店SSO・外部注文取込・代理店連携APIの全てのユーザー検索/作成箇所を、大文字小文字を区別しない検索(`findFirst`+`mode: 'insensitive'`)と、新規登録時の正規化(小文字化)保存に統一しました(`server/src/lib/validation.ts`の`normalizeEmail`/`emailFilterInsensitive`)。
2. **紹介限定アクセスの`ref`クエリ未検証**(15.3): `?ref=`クエリが空でなければ内容を検証せず通過させていたため、実在しないコードでも非公開の商品カタログが閲覧できていた問題。`referral_links.code`(`status='active'`)と実際に照合するよう修正しました(`server/src/middleware/referralAccess.ts`)。

### B. dormant実装(Feature Flag無効時は既存動作と完全に同一)

| 項目 | 実装ファイル |
|---|---|
| common_user_id解決クライアント | `server/src/services/externalCommonUserClient.ts` |
| referral capture/confirmクライアント | `server/src/services/externalReferralClient.ts` |
| 登録・購入時のオーケストレーター | `server/src/services/sennokuniOrderLinking.ts` |
| OVE Wallet reward grant/reversalクライアント(共通契約とは別のHMAC方式) | `server/src/services/oveWalletRewardClient.ts`、`server/src/lib/oveWalletHmac.ts` |
| Outbox dispatcher(claim・指数バックオフ・dead・stale再クレーム) | `server/src/services/integrationOutboxDispatcher.ts` |
| 共通契約HMAC署名(暫定実装) | `server/src/lib/sennokuniHmac.ts` |
| Feature Flag・接続設定の読み出し | `server/src/services/sennokuniIntegrationConfig.ts` |
| cron配線(`GET /api/internal/cron/process-integration-outbox`) | `server/src/routes/internalCron.ts`、`vercel.json` |

新規設定キー(`server/src/services/settings.ts`、管理画面の既存`/admin/settings`から編集可能): `sennokuni_hmac_key_id` / `sennokuni_hmac_secret` / `sennokuni_agency_hub_base_url` / `integration_endpoint_sengoku_passport` / `integration_endpoint_ai_art_school` / `ove_wallet_base_url` / `ove_wallet_api_key_id` / `ove_wallet_hmac_secret`。

**登録・購入フローへの組み込み**: `server/src/routes/auth.ts`の会員登録後、`server/src/routes/checkout.ts`の注文作成後に、それぞれベストエフォート(例外を握りつぶし・DBトランザクション完了後・レスポンスをブロックしない)で呼び出しています。Feature Flag無効時はこれらの呼び出しが即座に返るため、既存の決済・登録フローへの影響はありません。

### C. 既知の暫定事項(本番有効化前に確認・確定が必要)

1. **HMAC署名フォーマットは契約書7.1が未確定のため暫定実装**: `sennokuniHmac.ts`は`keyId\ntimestamp\nnonce\nMETHOD\npath\nrawBody`を独自に採用しています。統合責任者が正式テストベクトルを確定した際は、この1ファイルの修正で対応できるよう分離しています。
2. **Outbox dispatcherの送信先エンドポイントパスは暫定**: パスポート・AIアート教室向けは`/shopping/webhook`(AIアート教室側分析で確認できたパス)を両送信先で仮に使用しています。正式なパスは契約確定待ちです。
3. **OVE Walletのreward取消(REVERSAL)の紐付けは簡易実装**: 返金時、対応する`entitlement.granted`のOutbox行(同一`order_item_id`・`status=succeeded`)を検索し、その`payload.ove_transaction_id`を使って取消しています。専用の`order_wallet_transactions`テーブルは未実装であり(前回報告済みの既知の未対応事項)、今回はOutboxのpayload内に簡易的に記録するにとどめています。
4. **代理店HUB・パスポート・AIアート教室で同一のHMAC鍵(`sennokuni_hmac_*`)を共用する設計**: 各送信先が個別の鍵を要求する場合は、送信先ごとの認証情報分離が別途必要です。
5. **`agency-system`宛の`order.*`/`payment.*`汎用イベント送信は実装していません**: 今回のOutbox実送信は`entitlement.granted/revoked`のみが対象で、`product_integration_rules`が未設定の商品(現状すべて)はno-opです。

### D. テスト・確認結果

```
Test Files  60 passed (60)
     Tests  405 passed (405)
```

前回報告(370件)から35件追加。`npx tsc --noEmit`もクリーン、`npm run build --workspace=client`も成功。マイグレーション(`20260722050000_integration_outbox_updated_at`)は空DB・既存DBの両方で適用成功を確認済みです。

新規テストの内訳:
- `externalCommonUserClient.test.ts`(7件): Feature Flag無効/未設定時の即時no-op、HMACヘッダー付き送信、非2xx時の挙動、ベストエフォートラッパーの例外握りつぶし
- `externalReferralClient.test.ts`(5件): capture/confirmそれぞれのFeature Flag無効時no-op・成功時の解析
- `sennokuniOrderLinking.test.ts`(4件): Feature Flag無効時に注文へ一切影響しないこと(最重要)、resolve→confirmの一連の流れ、common_user_id未解決時の部分保存、referralCode無し注文でのno-op
- `oveWalletRewardClient.test.ts`(4件): grant/reverseそれぞれのFeature Flag無効時no-op・OVE独自HMACヘッダーの送信確認
- `integrationOutboxDispatcher.test.ts`(8件): Feature Flag無効時の完全no-op、OVE Wallet宛grant/revoke連携、対応するgrantが無いrevokeのリトライ、最大試行超過でdead、汎用送信先へのHMAC付き送信、接続先未設定時のリトライ、staleなprocessing行の再クレーム
- `auth.test.ts`追加分(2件): メール大文字小文字違いの重複登録拒否・ログイン成功
- `products.test.ts`追加分(2件): refクエリの実在チェック・inactiveコードの拒否

### E. 本番未確認事項・接続テストが必要な事項

- `SENNOKUNI_INTEGRATION_ENABLED`は本番では`false`のまま(未設定)であることの確認。
- 実際の代理店HUB・パスポート・AIアート教室・OVE Walletとの接続テストは未実施(認証情報・確定エンドポイントが無いため実施不可)。
- 上記C章の暫定事項(署名フォーマット・エンドポイントパス・鍵共用設計)は、統合責任者の正式確定後に見直しが必要です。
- 新規設定キー追加分のマイグレーションはなし(Settingテーブルの既存キー追加のみのため、スキーマ変更は`integration_outbox_events.updated_at`カラム追加のみ)。本番Supabaseへの適用が必要です。

---

以上、ご確認のほどよろしくお願いいたします。実接続に必要な認証情報・エンドポイントが確定次第、対応いたします。
