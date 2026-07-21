# 「千ノ国 全システム横断連携分析」に対する当システム(ショッピング/sengokumarket)側の現状確認

対象文書: `REFERENCE_SYSTEM_INTEGRATION_ANALYSIS_20260721.md`(千ノ国5システム横断分析)
本書の位置づけ: 上記文書のうち、当システムに関わる指摘(K-2章「ショッピング / sengokumarket」、G-3章の不足カラム・API一覧、I-1章のセキュリティ指摘)を、直近実装済みの`docs/sennokuni-integration-implementation-report.md`の内容と突き合わせ、**現状で対応済み・対応中・未対応**を仕分けたもの。新規の外部呼び出し実装は行っていない(方針は前回同様、実接続には未確定の認証情報・エンドポイントが必要なため)。

---

## 1. K-2章「ショッピング」必須変更との対応状況

| 必須変更項目 | 現状 |
|---|---|
| Stripe event処理状態・再処理 | ✅ 対応済み。`stripe_events`をInbox方式の状態機械化(processing/succeeded/failed_retryable/failed_terminal)。文書H-8「Stripe event ID先行登録により再処理不能」は解消済み |
| `users.common_user_id` | ✅ スキーマ追加済み(nullable, unique)。**resolve API呼び出し自体は未実装**のため、値は常にnull(後述4章) |
| sales/closing分離 | ✅ `orders.sales_agent_id`/`orders.closing_agent_id`を新設し、既存の`explainer_*`(購入時の説明担当・報酬対象外の記録用)とは完全に分離。文書D-2の推奨JSON形状と一致 |
| `order/payment/entitlement`イベント送信 | 🟡 一部のみ。`entitlement.granted`/`entitlement.revoked`のみOutbox実装済み(決済確定・全額返金と同一トランザクション)。**`order.created/paid/cancelled`・`payment.succeeded/failed/refunded`の汎用イベントは未送信**(下流の受信契約が確定していないため意図的に見送り。5章参照) |

## 2. G-3章「不足カラム・テーブル」との対応状況

| 項目 | 現状 |
|---|---|
| `users.common_user_id` | ✅ 追加済み |
| `external_identities`(`system_account_links`相当) | ✅ 追加済み(`system_key`+`external_user_id`でunique) |
| `orders.closing_agent_id` | ✅ 追加済み |
| `orders.sales_agent_id`(`explainer_*`と分離) | ✅ 追加済み |
| `integration_outbox_events` | ✅ 追加済み |
| `integration_event_attempts`(送信試行ログの別テーブル) | ❌ 未対応。現状は`integration_outbox_events`本体に`attempt_count`/`last_error`/`next_attempt_at`を持たせる形にとどめており、試行履歴を1行ずつ残す専用テーブルは作っていない。ディスパッチャ実装時に合わせて追加するのが妥当 |
| `stripe_events.status/attempt_count/last_error/processed_at` | ✅ 文書の想定どおりの形で追加済み |

## 3. C-1章 共通ID対応表との整合

文書は当システムを「`common_user_id`: なし、resolve送信: 未実装、判定: ×」としている。今回の対応で**スキーマは追加**したが、resolve API呼び出し自体は依然未実装のため、実態としては「保存先はあるがまだ空(常にnull)」という状態。文書の判定を覆すには4章の外部呼び出し実装が必要。

## 4. 未対応(意図的に見送り。前回報告と同一)

- `common_user_id`解決(`POST /api/common-users/resolve`)の実呼び出し
- `referral_token`のcapture/confirm実呼び出し(文書D-3のcanonical化フロー)
- `order.*`/`payment.*`の汎用イベント送信(entitlementのみ実装)
- Outboxディスパッチャ本体(HMAC署名・実送信・リトライ)
- ウォレット`rewards/grant`・`REVERSAL`呼び出しクライアント
- `integration_event_attempts`相当の試行履歴テーブル

理由は共通: 新契約のHMAC認証情報(`X-SenNoKuni-*`)・各システムの実エンドポイントが未確定であり、確定前に実装すると誤った契約で結線してしまうリスクがあるため。

---

## 5. 新規に確認できたセキュリティ指摘(要判断)

文書I-1「ショッピング」の指摘のうち、**まだ着手していないものを実コードで確認**しました。

> `APP_URL`未設定時Origin検証fail-open → CSRF防御無効化

`server/src/middleware/csrf.ts` の該当箇所:

```ts
const appUrl = process.env.APP_URL;
if (!appUrl) return next(); // ← APP_URL未設定時、Origin検証をスキップして通してしまう
```

現状、`APP_URL`環境変数が(設定ミス・デプロイ設定の不備等で)未設定になった場合、状態変更系API全体のCSRF対策が無効化されます。文書はこれを「本番接続前に修正必須」の項目として挙げています。

**→ 対応済み。** `APP_URL`未設定時はfail-open(通す)ではなく、他のOrigin不一致時と同じ403 `CSRF_ORIGIN_MISMATCH`を返すfail-closedに変更した(`server/src/middleware/csrf.ts`)。あわせて`console.error`で検知できるようにログを追加。回帰テスト(`server/src/routes/auth.test.ts`「APP_URL未設定時はfail-openにせず状態変更系リクエストを403で拒否する」)を追加し、全348件のテストが成功することを確認済み。

**注意(運用上の影響)**: 本番で`APP_URL`が何らかの理由で未設定になった場合、以前は(意図せず)ログイン等がそのまま通っていたが、修正後は明示的に403で拒否されるようになる。これは意図した挙動(fail-closed)だが、`APP_URL`の設定漏れに気づきやすくなる分、設定ミス時の影響範囲が「CSRFが素通りする」から「ログイン等が全面的にできなくなる」に変わる。過去に本番で`APP_URL`関連のOriginミスマッチ障害が実際にあったため、デプロイ後は`APP_URL`が正しく設定されていることを必ず確認すること。

---

## 6. 総括

文書のK-2章が求める変更のうち、**Stripe冪等性・共通ID用スキーマ・担当者分離・entitlement Outbox**は既に実装済みです。未対応は「実際の外部HTTP接続」と「汎用order/paymentイベント送信」に限られ、これらは前回報告時点から状況は変わっていません(認証情報待ち)。

新たにコードレベルで確認できた事項は、5章の`APP_URL`未設定時CSRF fail-openの1点です。対応要否のご判断をお願いします。
