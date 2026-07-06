# 進捗レポート(Step 1〜7 完了時点)

作成日: 2026-07-06
ブランチ: `claude/confirmation-needed-3wicju`
対象仕様書: `docs/sengoku_nft_cart_codex_instructions_v1_5.md`(v1.5)

---

## 1. 全体状況

仕様書v1.5「12. 実装ステップ」のStep 1〜7が完了。Step 8(マイページ)着手前の状態。

| Step | 内容 | 状態 |
|---|---|---|
| 1 | プロジェクト初期化 | ✅ 完了 |
| 2 | DB構築 | ✅ 完了 |
| 3 | 商品表示 | ✅ 完了 |
| 4 | カート | ✅ 完了 |
| 5 | 購入者情報入力 | ✅ 完了 |
| 6 | Stripe決済 | ✅ 完了(実キー未設定・後述) |
| 7 | 認証 | ✅ 完了(メール送信は未実装) |
| 8 | マイページ | 未着手 |
| 9 | 管理画面 | 未着手 |
| 10 | CSVインポート | 未着手 |
| 11 | メール送信 | 未着手 |
| 12 | 法務ページ | 未着手 |

各Stepの詳細な実装内容・コミットは末尾の「6. コミット一覧」を参照。

---

## 2. 仕様書からの逸脱事項(要確認事項)

進行中にユーザーと相談の上、仕様書に明記のない拡張・変更を行った箇所。

### 2.1 DBにSupabase(PostgreSQL)を採用

仕様書のDB要件(PostgreSQL + Prisma)自体には矛盾しないが、ホスティング先としてSupabaseを採用。

- `DATABASE_URL`: Transaction pooler(ポート6543、`pgbouncer=true`)
- `DIRECT_URL`: Direct connection(ポート5432、Prisma Migrate用)
- **このセッションの実行環境からはSupabaseへ直接接続できない**(ネットワークポリシーによりraw TCP不可、HTTPS/443のみ許可)。そのため、migrationとseedデータの投入は、生成したSQLをユーザーがSupabaseのSQL Editorで手動実行する運用にしている
- 動作検証は、サンドボックス内に一時的に構築したローカルPostgreSQLに対してmigration/seedを適用し、vitest・Playwrightで行った(検証後は都度破棄しSupabase本体には影響なし)

### 2.2 Stripe/Resendの設定をDB管理に変更(仕様書外の拡張)

ユーザーからの要望により、`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLIC_KEY` / `RESEND_API_KEY` / `MAIL_FROM` の5項目は `.env` ではなく `settings` テーブル(key-value、AES-256-GCMで暗号化)で管理する方式に変更した。

- `DATABASE_URL` / `JWT_SECRET` / `TERMS_VERSION` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `APP_URL` 等の「アプリ起動に必須な値」は従来通り `.env` で管理
- 暗号化キー `SETTINGS_ENCRYPTION_KEY`(32byte hex)を新たに`.env`に追加
- **管理画面からの設定変更UI自体はまだ未実装。** 認証(Step 7)と管理画面(Step 9)が揃ってから実装する方針で合意済み
- 現時点ではStripeの実キーが未設定のため、Checkout Session作成は失敗し、仮引当した在庫を解放して注文を`failed`にする補償処理が動く(意図した安全な失敗動作)

### 2.3 CSRF対策の実装方式

仕様書16章の「CSRFトークンまたはSameSite=Strict + Origin検証」のうち、後者を採用。状態変更系API全体(`/api`配下のPOST/PUT/DELETE)に適用し、Stripe Webhookルートのみ対象外(署名検証で別途保護)。

---

## 3. 主要な実装ポイント

### 3.1 データベース(Step 2)

`server/prisma/schema.prisma` に仕様書6章の全14テーブルを実装。

- `orders.agency_id` / `influencer_id` / `referral_link_id` は仕様書DDL通り物理FKなし
- migrationはDB接続不要な `prisma migrate diff` でローカル生成し、`server/prisma/migrations/` にSQLとして保存(Supabase側はSQL Editorで手動適用)
- 仕様書外の拡張として `settings` テーブルを追加(2.2参照)

### 3.2 商品表示・カート(Step 3〜4)

- `GET /api/products`, `GET /api/products/:idOrSlug`(UUID/slug両対応)
- 在庫状況は `stock - reserved_stock` で算出
- `?ref=xxxx` をlocalStorage/Cookieに30日保存(後勝ち)
- カートはlocalStorage永続化(7日でexpire)、`POST /api/cart/validate` でchekout前に価格・在庫を再検証

### 3.3 注文・決済(Step 5〜6)

- `POST /api/checkout/create-session`: 在庫仮引当(行ロック付き)→紹介コード解決(referral_links→influencers→agencies優先順位でスナップショット)→ゲストアカウント自動作成→規約同意証跡保存→Stripe Checkout Session作成、を1トランザクション+後続処理で実施
- Stripe商品名は「NFT」を除去して安全な表記に変換(`toStripeSafeName`)
- `POST /api/stripe/webhook`: `express.raw()`を`express.json()`より前に配線、署名検証、`stripe_events`への冪等性INSERT
  - `checkout.session.completed`: 在庫確定・NFT発行データ作成(item_type=nftのみ・数量分)・報酬確定
  - `checkout.session.expired`: 仮引当解放
  - `payment_intent.payment_failed`: 仮引当維持のままfailedへ
  - `charge.refunded`: 全額返金のみ自動処理(nft_issues/commissionsをcancelled化・注文と同期)、一部返金はadmin_note記録のみ
- `GET /api/checkout/session/:sessionId/status`: successページの決済状況ポーリング用(到達自体を決済完了とみなさない)

### 3.4 認証(Step 7)

- JWT(httpOnly / SameSite=Strict Cookie)、`localStorage`には保存しない
- `POST /api/auth/register` / `login` / `logout`、`GET /api/auth/me`
- ログイン失敗はアカウント+IP単位で5回失敗→15分ロック(インメモリ)
- パスワードリセット申請はメール存在有無を返さない。確定APIはハッシュ化保存したトークン(72時間・1回限り)を検証
- ゲスト購入時のパスワード設定と同じ `password-reset/confirm` を共用する設計

---

## 4. テスト・検証方針

- サーバー: vitest + supertest。**ローカルPostgreSQL(サンドボックス内で一時構築)に対して実行**し、確認後は都度破棄。Supabase本体には一切書き込んでいない
- 現時点で **7ファイル・33テスト** が全て通過(cart / checkout / checkout(Stripe未設定) / settings / stripeWebhook / auth / passwordReset)
- 特にCLAUDE.mdで明記された必須テストをすべてカバー:
  - 同一Webhookイベント2回受信での二重処理防止
  - `item_type != 'nft'` でnft_issuesが作られないこと
  - 報酬率の3段階フォールバック解決
  - 全額返金でcommissionsがcancelledになりordersと同期されること
- クライアント: Playwright(グローバルにインストール済みのChromiumを使用)で主要フローを実ブラウザ操作で確認
  - 商品一覧→詳細→カート追加→カート操作→checkout→(Stripe未設定のためエラー表示までを確認)
  - success/cancelページの表示・カートクリア動作
  - 会員登録→ログアウト→ログイン→パスワード誤り→パスワードリセット申請→トークンでの再設定→新パスワードでのログイン

---

## 5. 未解決事項・今後の対応

1. **Supabaseへの最新migration適用**: `server/prisma/migrations/20260705224911_add_settings/migration.sql`(settingsテーブル作成)がまだSupabase側に未適用の可能性。SQL Editorでの実行が必要
2. **Stripeキー未設定**: 実際の`sk_test_...` / `whsec_...`をいただき次第、暗号化してDBに登録し、実際のCheckout Session作成・Webhook配信の最終動作確認を行う
3. **メール送信(Step 11)未実装**: 購入完了メール・ゲストのパスワード設定メール・パスワードリセットメールはまだ送信されない(トークン自体はDBに正しく作成される)
4. **管理画面からのStripe/Resend設定UI未実装**: Step 7(認証)は完了したので、Step 9(管理画面)で実装予定
5. **マイページ(Step 8)未着手**: 購入履歴・NFT発行状況・ウォレット登録・お知らせ表示
6. **トップページ(4.1)は未実装**: 現在`/`は`/products`へリダイレクトする暫定対応。どのStepで本実装するか要確認(仕様書12章に明記のステップ番号がないため)
7. 法務ページ(特商法・利用規約・返金ポリシー・プライバシーポリシー)はStep 12まで未実装のため、checkoutページの同意チェック欄のリンクは現状404になる

---

## 6. コミット一覧

```
8d16464 Step 1: プロジェクト初期化(React+TS / Express+TS / Prisma雛形)
b67023e Supabase接続用にDIRECT_URLを追加
b488532 Step 2: DB構築(Prisma schema・migration・seedスクリプト)
5be3183 Step 3: 商品表示(商品一覧・詳細API/画面、ref保存)
32b97d0 Step 4: カート(localStorage永続化・数量変更・削除・cart validate API)
b94aac9 Step 5: 購入者情報入力(注文仮作成API・checkoutフォーム)
342794f Step 6: Stripe決済・Webhook(設定はDB管理・仕様書外の拡張含む)
eb9e72a Step 7: 認証(会員登録・ログイン・ログアウト・パスワードリセット)
```

## 7. ディレクトリ構成(主要ファイル)

```
server/
  prisma/
    schema.prisma
    migrations/
      20260705143147_init/migration.sql          … 全14テーブル
      20260705224911_add_settings/migration.sql   … settingsテーブル(仕様書外拡張)
    seed.ts
  src/
    app.ts                      … Express設定(webhook生ボディ順序、CSRF等)
    lib/
      prisma.ts, apiError.ts, httpError.ts, validation.ts
      authCookie.ts, settingsCrypto.ts, stripeClient.ts
    middleware/
      auth.ts (requireAuth/requireAdmin), csrf.ts (requireSameOrigin)
    routes/
      products.ts, cart.ts, checkout.ts, referrals.ts,
      auth.ts, stripeWebhook.ts (+各 .test.ts)
    services/
      checkout.ts, orderNumber.ts, referral.ts, orderLookup.ts,
      settings.ts, stripeCheckout.ts, stripeWebhookHandlers.ts,
      jwt.ts, loginAttempts.ts, passwordReset.ts (+各 .test.ts)

client/
  src/
    context/ CartContext.tsx, AuthContext.tsx
    lib/ api.ts, cart.ts, referral.ts
    pages/
      ProductListPage, ProductDetailPage, CartPage,
      CheckoutPage, CheckoutSuccessPage, CheckoutCancelPage,
      LoginPage, RegisterPage,
      PasswordResetRequestPage, PasswordResetConfirmPage
```
