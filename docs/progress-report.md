# 進捗レポート(Step 1〜12 完了・MVP実装完了時点)

作成日: 2026-07-06(初版) / 更新日: 2026-07-06
ブランチ: `claude/confirmation-needed-3wicju`
対象仕様書: `docs/sengoku_nft_cart_codex_instructions_v1_5.md`(v1.5)

---

## 1. 全体状況

仕様書v1.5「12. 実装ステップ」のStep 1〜12が**全て完了**。MVPとして一通りの機能が揃った状態。

| Step | 内容 | 状態 |
|---|---|---|
| 1 | プロジェクト初期化 | ✅ 完了 |
| 2 | DB構築 | ✅ 完了 |
| 3 | 商品表示 | ✅ 完了 |
| 4 | カート | ✅ 完了 |
| 5 | 購入者情報入力 | ✅ 完了 |
| 6 | Stripe決済 | ✅ 完了(実キー登録済み。最終の実決済確認は未実施) |
| 7 | 認証 | ✅ 完了 |
| 8 | マイページ | ✅ 完了 |
| 9 | 管理画面 | ✅ 完了 |
| 10 | CSVインポート | ✅ 完了 |
| 11 | メール送信 | ✅ 完了(Resendキー未設定のため実送信は未検証) |
| 12 | 法務ページ | ✅ 完了(文面はプレースホルダ) |

各Stepの詳細な実装内容・コミットは末尾の「7. コミット一覧」を参照。

---

## 2. 仕様書からの逸脱事項(要確認事項)

進行中にユーザーと相談の上、仕様書に明記のない拡張・変更を行った箇所。

### 2.1 DBにSupabase(PostgreSQL)を採用

仕様書のDB要件(PostgreSQL + Prisma)自体には矛盾しないが、ホスティング先としてSupabaseを採用(リージョン: `ap-northeast-1` 東京)。

- `DATABASE_URL`: Transaction pooler(ポート6543、`pgbouncer=true`)
- `DIRECT_URL`: Direct connection(ポート5432、Prisma Migrate用)
- **この開発セッションの実行環境からはSupabaseへ直接接続できない**(ネットワークポリシーによりraw TCP不可、HTTPS/443のみ許可)。そのため、migrationとseedデータの投入は、生成したSQLをユーザーがSupabaseのSQL Editorで手動実行する運用にしてきた
- 動作検証は、サンドボックス内に一時的に構築したローカルPostgreSQLに対してmigration/seedを適用し、vitest・Playwrightで行った(検証後は都度破棄しSupabase本体には影響なし)

### 2.2 Stripe/Resendの設定をDB管理に変更(仕様書外の拡張)

ユーザーからの要望により、`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLIC_KEY` / `RESEND_API_KEY` / `MAIL_FROM` の5項目は `.env` ではなく `settings` テーブル(key-value、AES-256-GCMで暗号化)で管理する方式に変更した。

- `DATABASE_URL` / `JWT_SECRET` / `TERMS_VERSION` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `APP_URL` 等の「アプリ起動に必須な値」は従来通り `.env` で管理
- 暗号化キー `SETTINGS_ENCRYPTION_KEY`(32byte hex)を`.env`に追加済み
- 管理画面 `/admin/settings`(Step 9で実装)からマスク表示付きで閲覧・更新できる
- Stripeのシークレットキー・公開可能キーは既に暗号化してSupabaseへ登録済み。Webhookシークレットは未登録(2.4参照)

### 2.3 CSRF対策の実装方式

仕様書16章の「CSRFトークンまたはSameSite=Strict + Origin検証」のうち、後者を採用。状態変更系API全体(`/api`配下のPOST/PUT/DELETE)に適用し、Stripe Webhookルートのみ対象外(署名検証で別途保護)。

### 2.4 ログイン失敗回数制限をDBベースに変更

Vercel(サーバーレス)へのデプロイを見据え、当初のインメモリ実装から専用テーブル `login_attempts`(仕様書外の拡張)へ変更。サーバーレス環境ではインスタンスが使い捨てになるため、インメモリ管理では正しく機能しない。

### 2.5 orders.guest_account_created カラムの追加

ゲスト購入時にその場でアカウントを新規作成したかどうかを判定するための仕様書外の拡張カラム。決済完了時に「パスワード設定メールを送るべきか」の判定に使用する(仕様書v1.5 4.9)。

---

## 3. 主要な実装ポイント(Step別)

### 3.1 データベース(Step 2)

`server/prisma/schema.prisma` に仕様書6章の全14テーブルを実装。

- `orders.agency_id` / `influencer_id` / `referral_link_id` は仕様書DDL通り物理FKなし
- migrationはDB接続不要な `prisma migrate diff` でローカル生成し、`server/prisma/migrations/` にSQLとして保存(Supabase側はSQL Editorで手動適用)
- 仕様書外の拡張として `settings` / `login_attempts` テーブル、`orders.guest_account_created` カラムを追加(2章参照)

### 3.2 商品表示・カート(Step 3〜4)

- `GET /api/products`, `GET /api/products/:idOrSlug`(UUID/slug両対応)
- 在庫状況は `stock - reserved_stock` で算出
- `?ref=xxxx` をlocalStorage/Cookieに30日保存(後勝ち)
- カートはlocalStorage永続化(7日でexpire)、`POST /api/cart/validate` でcheckout前に価格・在庫を再検証

### 3.3 注文・決済(Step 5〜6)

- `POST /api/checkout/create-session`: 在庫仮引当(行ロック付き)→紹介コード解決(referral_links→influencers→agencies優先順位でスナップショット)→ゲストアカウント自動作成→規約同意証跡保存→Stripe Checkout Session作成、を1トランザクション+後続処理で実施
- Stripe商品名は「NFT」を除去して安全な表記に変換(`toStripeSafeName`)
- Stripe呼び出し失敗時は仮引当在庫を解放し注文を`failed`にする補償処理あり
- `POST /api/stripe/webhook`: `express.raw()`を`express.json()`より前に配線、署名検証、`stripe_events`への冪等性INSERT
  - `checkout.session.completed`: 在庫確定・NFT発行データ作成(item_type=nftのみ・数量分)・報酬確定
  - `checkout.session.expired`: 仮引当解放
  - `payment_intent.payment_failed`: 仮引当維持のままfailedへ
  - `charge.refunded`: 全額返金のみ自動処理(nft_issues/commissionsをcancelled化・注文と同期)、一部返金はadmin_note記録のみ
- `GET /api/checkout/session/:sessionId/status`: successページの決済状況ポーリング用(到達自体を決済完了とみなさない)

### 3.4 認証(Step 7)

- JWT(httpOnly / SameSite=Strict Cookie)、`localStorage`には保存しない
- `POST /api/auth/register` / `login` / `logout`、`GET /api/auth/me`
- ログイン失敗はアカウント+IP単位で5回失敗→15分ロック(DBベース、2.4参照)
- パスワードリセット申請はメール存在有無を返さない。確定APIはハッシュ化保存したトークン(72時間・1回限り)を検証
- ゲスト購入時のパスワード設定と同じ `password-reset/confirm` を共用する設計

### 3.5 マイページ(Step 8)

- `GET /api/mypage/orders` / `nfts` / `wallet` / `notices`、`POST /api/mypage/wallet`
- ウォレット登録・更新時に`status=wallet_required`のnft_issuesを`ready_to_issue`へ一括更新しwallet_addressをスナップショット保存(issued/failedは対象外)
- 未ログイン時は`/login`へリダイレクトする`RequireAuth`

### 3.6 管理画面(Step 9)

`requireAdmin`ミドルウェアで`/api/admin`配下を一括保護。

- ダッシュボード(総売上・件数・在庫・要対応アラート等)
- 商品管理、注文管理(紹介コード変更不可を維持)
- NFT発行管理(issuedへの変更はtoken_id/transaction_hash必須、issued_at自動記録)
- ウォレット未登録者一覧、お知らせ管理(公開時にpublished_at記録)
- 紹介リンク発行(`/admin/referral-links`): 代理店・インフルエンサーのその場新規作成+コード自動生成(AG/INF/SGI連番)、URLコピー、有効/無効切替のみ。スマホ操作前提のレイアウト
- 代理店・紹介成果管理: 報酬ステータス更新(commissionsが正・ordersキャッシュを同期)、報酬CSV出力(期間指定、cancelled常時除外・paidデフォルト除外、mark_approvedで一括承認)
- 決済・メール設定画面(2.2の拡張): Stripe/Resendの設定をマスク表示付きで登録

### 3.7 CSVインポート(Step 10)

- `POST /api/admin/import-products`: 行ごとにバリデーション(商品タイプは必須。空欄・不正値は行番号付きエラーとしその行は作成しない)
- dryRunでのプレビューと実インポートの2段階。SKU重複時は更新(upsert)

### 3.8 メール送信(Step 11)

- Resend連携。APIキー未設定または送信失敗時は例外を投げず処理を継続(注文処理・パスワードリセットを失敗させない)
- 購入完了メール(トランザクション外で送信)、ゲストのパスワード設定メール(`guest_account_created`判定)、パスワードリセットメール

### 3.9 法務ページ(Step 12)

- `/legal/tokushoho` `/legal/terms` `/legal/refund` `/legal/privacy` を静的ページとして実装(文面はプレースホルダ、明示的な注記あり)
- 全ページ共通フッターから4ページへリンク

---

## 4. テスト・検証方針

- サーバー: vitest + supertest。**ローカルPostgreSQL(サンドボックス内で一時構築)に対して実行**し、確認後は都度破棄。Supabase本体には一切書き込んでいない
- 現時点で **サーバー側 81テスト** が全て通過(cart / checkout / checkout(Stripe未設定) / settings / stripeWebhook(+mail連携) / auth(+mail連携) / passwordReset / loginAttempts / mail / admin配下9ファイル)
- 特にCLAUDE.mdで明記された必須テストをすべてカバー:
  - 同一Webhookイベント2回受信での二重処理防止
  - `item_type != 'nft'` でnft_issuesが作られないこと
  - 報酬率の3段階フォールバック解決
  - 全額返金でcommissionsがcancelledになりordersと同期されること
- クライアント: Playwright(グローバルにインストール済みのChromiumを使用)で主要フローを実ブラウザ操作で確認
  - 商品一覧→詳細→カート追加→カート操作→checkout
  - success/cancelページの表示・カートクリア動作
  - 会員登録→ログアウト→ログイン→パスワードリセット申請→トークンでの再設定→新パスワードでのログイン
  - マイページ表示・ウォレット登録・発行状況反映
  - 管理画面(ダッシュボード・商品管理・お知らせ管理・紹介リンク発行・CSVインポート)
  - 法務ページ・フッターからの遷移

---

## 5. 未解決事項・今後の対応

1. **Stripeの実決済フローの最終確認が未実施**: シークレットキー・公開可能キーは登録済みだが、Webhookシークレットが未登録のため、実際にCheckout Session作成→決済→Webhook受信までの一連を本番相当で試せていない
2. **Resendキー未設定**: メール送信のコードは実装済みだが、実際の送信確認は未実施
3. **法務ページの文面は仮**: 特商法表記・利用規約・返金ポリシー・プライバシーポリシーは正式な文面への差し替えが必要
4. **トップページ(4.1)は簡易対応のまま**: 現在`/`は`/products`へリダイレクト。ヒーローコピーやFAQ等を含む本来のトップページは未実装(仕様書12章にステップ番号の明記がないため保留してきた)
5. **デプロイ未実施**: Vercel(hnd1リージョン)へのデプロイが次の作業

---

## 6. デプロイに向けて

- デプロイ先: Vercel(hnd1リージョン)で確定
- DB: Supabase(ap-northeast-1、東京)で確定、リージョンは揃っている
- 検討・準備が必要な事項:
  - Express APIをVercel Serverless Functionsとして動かす構成(vercel.json、エントリポイント調整)
  - 環境変数(`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `APP_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TERMS_VERSION`)をVercelプロジェクトに設定
  - Stripe Webhookエンドポイントの本番URL確定とWebhookシークレットの登録

---

## 7. コミット一覧

```
8d16464 Step 1: プロジェクト初期化(React+TS / Express+TS / Prisma雛形)
b67023e Supabase接続用にDIRECT_URLを追加
b488532 Step 2: DB構築(Prisma schema・migration・seedスクリプト)
5be3183 Step 3: 商品表示(商品一覧・詳細API/画面、ref保存)
32b97d0 Step 4: カート(localStorage永続化・数量変更・削除・cart validate API)
b94aac9 Step 5: 購入者情報入力(注文仮作成API・checkoutフォーム)
342794f Step 6: Stripe決済・Webhook(設定はDB管理・仕様書外の拡張含む)
eb9e72a Step 7: 認証(会員登録・ログイン・ログアウト・パスワードリセット)
f0bb5ab docs: Step 1〜7時点の進捗レポートを追加
bc5d94e ログイン失敗回数制限をインメモリからDBベースに変更
33f03c9 Step 8: マイページ(購入履歴・NFT発行状況・ウォレット登録・お知らせ)
d842d71 Step 9: 管理画面(ダッシュボード・商品/注文/NFT発行/お知らせ管理・紹介リンク発行・報酬管理・設定)
12208e7 Step 10: CSV商品インポート
14980bc Step 11: メール送信(Resend連携。APIキー未設定でも安全に動作)
ab74570 Step 12: 法務ページ(特商法・利用規約・返金ポリシー・プライバシーポリシー)
```

## 8. ディレクトリ構成(主要ファイル)

```
server/
  prisma/
    schema.prisma
    migrations/
      20260705143147_init/                        … 全14テーブル
      20260705224911_add_settings/                … settingsテーブル(仕様書外拡張)
      20260706021859_add_login_attempts/          … login_attemptsテーブル(仕様書外拡張)
      20260706025851_add_guest_account_created/   … orders.guest_account_created(仕様書外拡張)
    seed.ts
  src/
    app.ts                      … Express設定(webhook生ボディ順序、CSRF等)
    lib/
      prisma.ts, apiError.ts, httpError.ts, validation.ts, csv.ts
      authCookie.ts, settingsCrypto.ts, stripeClient.ts
    middleware/
      auth.ts (requireAuth/requireAdmin), csrf.ts (requireSameOrigin)
    routes/
      products.ts, cart.ts, checkout.ts, referrals.ts, auth.ts,
      mypage.ts, stripeWebhook.ts (+各 .test.ts)
      admin/ dashboard, products, orders, nftIssues, walletMissing,
             notices, agencies, referralLinks, referrals, settings,
             importProducts (+各 .test.ts)
    services/
      checkout.ts, orderNumber.ts, referral.ts, orderLookup.ts,
      settings.ts, stripeCheckout.ts, stripeWebhookHandlers.ts,
      jwt.ts, loginAttempts.ts, passwordReset.ts, mail.ts,
      mailTemplates.ts, referralCodeGenerator.ts, csvImport.ts (+各 .test.ts)
    test/ adminAgent.ts

client/
  src/
    components/ RequireAuth, RequireAdmin, AdminLayout, Footer
    context/ CartContext.tsx, AuthContext.tsx
    lib/ api.ts, adminApi.ts, cart.ts, referral.ts
    pages/
      ProductListPage, ProductDetailPage, CartPage,
      CheckoutPage, CheckoutSuccessPage, CheckoutCancelPage,
      LoginPage, RegisterPage,
      PasswordResetRequestPage, PasswordResetConfirmPage,
      MyPage, WalletPage
      admin/ AdminDashboardPage, AdminProductsPage, AdminImportProductsPage,
             AdminOrdersPage, AdminNftIssuesPage, AdminWalletMissingPage,
             AdminNoticesPage, AdminReferralLinksPage, AdminReferralsPage,
             AdminSettingsPage
      legal/ TokushohoPage, TermsPage, RefundPolicyPage, PrivacyPolicyPage
```
