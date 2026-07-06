# 進捗レポート(Step 1〜12 完了 + デプロイ・追加機能実装時点)

作成日: 2026-07-06(初版) / 更新日: 2026-07-06
ブランチ: `claude/confirmation-needed-3wicju`
対象仕様書: `docs/sengoku_nft_cart_codex_instructions_v1_5.md`(v1.5)

---

## 1. 全体状況

仕様書v1.5「12. 実装ステップ」のStep 1〜12が**全て完了**。さらにVercel本番環境へのデプロイが完了し、決済フローの実動作も確認済み。加えて、ユーザー要望による仕様書外の機能拡張(デザイン刷新・法務ページCMS化・代理店システム連携)を実施済み。

| Step | 内容 | 状態 |
|---|---|---|
| 1 | プロジェクト初期化 | ✅ 完了 |
| 2 | DB構築 | ✅ 完了 |
| 3 | 商品表示 | ✅ 完了 |
| 4 | カート | ✅ 完了 |
| 5 | 購入者情報入力 | ✅ 完了 |
| 6 | Stripe決済 | ✅ 完了(本番環境で実決済確認済み) |
| 7 | 認証 | ✅ 完了 |
| 8 | マイページ | ✅ 完了 |
| 9 | 管理画面 | ✅ 完了 |
| 10 | CSVインポート | ✅ 完了 |
| 11 | メール送信 | ✅ 完了(Resendキー未設定のため実送信は未検証) |
| 12 | 法務ページ | ✅ 完了(管理画面から編集可能・初期文面はプレースホルダ) |

Step 1〜12の詳細は「3. 主要な実装ポイント」を、Step 12以降の追加実装は「7. Step 12以降の追加実装」を参照。コミット一覧は「9. コミット一覧」。

---

## 2. 仕様書からの逸脱事項(要確認事項)

進行中にユーザーと相談の上、仕様書に明記のない拡張・変更を行った箇所。

### 2.1 DBにSupabase(PostgreSQL)を採用

仕様書のDB要件(PostgreSQL + Prisma)自体には矛盾しないが、ホスティング先としてSupabaseを採用(リージョン: `ap-northeast-1` 東京、Vercelのhnd1リージョンと合わせて低レイテンシ構成)。

- `DATABASE_URL`: Transaction pooler(ポート6543、`pgbouncer=true`)
- `DIRECT_URL`: Direct connection(ポート5432、Prisma Migrate用)
- **この開発セッションの実行環境からはSupabaseへ直接接続できない**(ネットワークポリシーによりraw TCP不可、HTTPS/443のみ許可)。そのため、migrationとseedデータの投入は、生成したSQLをユーザーがSupabaseのSQL Editorで手動実行する運用にしてきた
- 動作検証は、サンドボックス内に一時的に構築したローカルPostgreSQLに対してmigration/seedを適用し、vitest・Playwrightで行った(検証後は都度破棄しSupabase本体には影響なし)

### 2.2 Stripe/Resendの設定をDB管理に変更(仕様書外の拡張)

ユーザーからの要望により、`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PUBLIC_KEY` / `RESEND_API_KEY` / `MAIL_FROM` / `AGENCY_API_KEY`(後述7.4)の6項目は `.env` ではなく `settings` テーブル(key-value、AES-256-GCMで暗号化)で管理する方式に変更した。

- `DATABASE_URL` / `JWT_SECRET` / `TERMS_VERSION` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `APP_URL` / `SETTINGS_ENCRYPTION_KEY` 等の「アプリ起動に必須な値」は従来通り `.env`(Vercel環境変数)で管理
- 管理画面 `/admin/settings`(Step 9で実装)からマスク表示付きで閲覧・更新できる
- Stripeの各キー・Webhookシークレットは本番登録済みで、実際の決済フローも確認済み(4章参照)

### 2.3 CSRF対策の実装方式

仕様書16章の「CSRFトークンまたはSameSite=Strict + Origin検証」のうち、後者を採用。状態変更系API全体(`/api`配下のPOST/PUT/DELETE)に適用し、Stripe Webhookルートと外部代理店システム連携API(`/api/integrations/agencies`、APIキー認証のため対象外)を除く。

### 2.4 ログイン失敗回数制限をDBベースに変更

Vercel(サーバーレス)へのデプロイを見据え、当初のインメモリ実装から専用テーブル `login_attempts`(仕様書外の拡張)へ変更。サーバーレス環境ではインスタンスが使い捨てになるため、インメモリ管理では正しく機能しない。

### 2.5 orders.guest_account_created カラムの追加

ゲスト購入時にその場でアカウントを新規作成したかどうかを判定するための仕様書外の拡張カラム。決済完了時に「パスワード設定メールを送るべきか」の判定に使用する(仕様書v1.5 4.9)。

### 2.6 法務ページのDB管理化・代理店システム連携(いずれもユーザー要望による追加、詳細7章)

- 法務ページ(特商法・利用規約・返金ポリシー・プライバシーポリシー)を静的コンポーネントから `legal_documents` テーブル管理に変更し、管理画面から文面を編集可能にした
- 代理店(Agency)に親子階層(ツリー構造)を追加し、外部の代理店システムとサーバー間API連携できるようにした。代理店専用ログイン(代理店ポータル)も追加

---

## 3. 主要な実装ポイント(Step別)

### 3.1 データベース(Step 2)

`server/prisma/schema.prisma` に仕様書6章の全14テーブルを実装。

- `orders.agency_id` / `influencer_id` / `referral_link_id` は仕様書DDL通り物理FKなし
- migrationはDB接続不要な `prisma migrate diff` でローカル生成し、`server/prisma/migrations/` にSQLとして保存(Supabase側はSQL Editorで手動適用)
- 仕様書外の拡張として `settings` / `login_attempts` / `legal_documents` テーブル、`orders.guest_account_created` カラム、`agencies.external_id`/`parent_agency_id`、`users.agency_id` カラムを追加(2章・7章参照)

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
- **本番環境でテストカードによる決済〜success画面到達まで確認済み**(4章参照)

### 3.4 認証(Step 7)

- JWT(httpOnly / SameSite=Strict Cookie)、`localStorage`には保存しない
- `POST /api/auth/register` / `login` / `logout`、`GET /api/auth/me`
- ログイン失敗はアカウント+IP単位で5回失敗→15分ロック(DBベース、2.4参照)
- パスワードリセット申請はメール存在有無を返さない。確定APIはハッシュ化保存したトークン(72時間・1回限り)を検証
- ゲスト購入時のパスワード設定と同じ `password-reset/confirm` を共用する設計
- JWTペイロードに`role`に加え`agencyId`を追加(role=agencyの代理店ログイン用。7.4参照)

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
- 決済・メール設定画面(2.2の拡張): Stripe/Resend/代理店連携APIキーの設定をマスク表示付きで登録
- 法務ページ編集(7.3)・代理店一覧(7.4)を追加

### 3.7 CSVインポート(Step 10)

- `POST /api/admin/import-products`: 行ごとにバリデーション(商品タイプは必須。空欄・不正値は行番号付きエラーとしその行は作成しない)
- dryRunでのプレビューと実インポートの2段階。SKU重複時は更新(upsert)

### 3.8 メール送信(Step 11)

- Resend連携。APIキー未設定または送信失敗時は例外を投げず処理を継続(注文処理・パスワードリセットを失敗させない)
- 購入完了メール(トランザクション外で送信)、ゲストのパスワード設定メール(`guest_account_created`判定)、パスワードリセットメール、代理店ポータルのアカウント設定メール(7.4)

### 3.9 法務ページ(Step 12 → 7.3でCMS化)

- `/legal/tokushoho` `/legal/terms` `/legal/refund` `/legal/privacy` は当初静的コンポーネントとして実装したが、その後管理画面から編集可能な方式に変更(詳細は7.3)
- 全ページ共通フッターから4ページへリンク

---

## 4. 決済フローの本番確認結果

- Stripeテストカードによる決済〜Checkout Session作成〜success画面到達までを本番(Vercel)環境で確認済み
- 確認の過程で、VercelのSPAルーティング設定漏れ(`/checkout/success`など`react-router`側のパスへ直接アクセス/リダイレクトされると404になる)を発見・修正(7.1参照)
- Webhook経由の決済確定(在庫確定・NFT発行データ作成・報酬確定)は仕組みとしては実装・テスト済みだが、本番Webhookエンドポイントでの一連の受信確認はユーザー側で別途実施予定

---

## 5. テスト・検証方針

- サーバー: vitest + supertest。**ローカルPostgreSQL(サンドボックス内で一時構築)に対して実行**し、確認後は都度破棄。Supabase本体には一切書き込んでいない
- 現時点で **サーバー側 96テスト(25ファイル)** が全て通過(cart / checkout / checkout(Stripe未設定) / settings / stripeWebhook(+mail連携) / auth(+mail連携) / passwordReset / loginAttempts / mail / legal / 管理API各種 / 代理店ポータル / 外部代理店連携API)
- 特にCLAUDE.mdで明記された必須テストをすべてカバー:
  - 同一Webhookイベント2回受信での二重処理防止
  - `item_type != 'nft'` でnft_issuesが作られないこと
  - 報酬率の3段階フォールバック解決
  - 全額返金でcommissionsがcancelledになりordersと同期されること
- 追加機能分のテスト観点:
  - 代理店ポータルは自代理店の紹介URLのみ発行・閲覧でき、他代理店のインフルエンサー指定や他代理店のリンク閲覧はできないこと
  - 外部代理店連携APIはAPIキー認証必須(未指定/不一致で401)、`external_id`による冪等更新、親代理店未登録時は404
- クライアント: Playwright(グローバルにインストール済みのChromiumを使用)で主要フローを実ブラウザ操作で確認
  - 商品一覧→詳細→カート追加→カート操作→checkout
  - success/cancelページの表示・カートクリア動作
  - 会員登録→ログアウト→ログイン→パスワードリセット申請→トークンでの再設定→新パスワードでのログイン
  - マイページ表示・ウォレット登録・発行状況反映
  - 管理画面(ダッシュボード・商品管理・お知らせ管理・紹介リンク発行・CSVインポート・法務ページ編集・代理店一覧)
  - 法務ページ・フッターからの遷移(DB管理化後の表示も確認)
  - 代理店ポータルへのログイン〜紹介URL発行〜一覧表示、および代理店以外でのアクセス拒否

---

## 6. 未解決事項・今後の対応

1. **Resendキー未設定**: メール送信のコードは実装済みだが、実際の送信確認は未実施(代理店ポータルのアカウント設定メールも同様)
2. **法務ページの文面は仮**: 管理画面(`/admin/legal`)から編集可能になったが、初期文面は仮のまま。正式な文面への差し替えが必要
3. **トップページ(4.1)は簡易対応のまま**: 現在`/`は`/products`へリダイレクト。ヒーローコピーやFAQ等を含む本来のトップページは未実装(仕様書12章にステップ番号の明記がないため保留してきた)
4. **本番Webhookの一連確認**: Stripe Webhookエンドポイントの登録・シークレット設定手順は案内済みだが、実際のイベント受信〜在庫確定〜NFT発行データ作成までの本番確認はユーザー側で実施予定
5. **代理店システム側の実装待ち**: `docs/api-agency-integration.md` の仕様に基づき、外部代理店システム側でのAPI呼び出し実装が別途必要

---

## 7. Step 12以降の追加実装(仕様書外の機能拡張)

### 7.1 Vercelデプロイ対応

- モノレポ構成のまま、Express APIをVercel Serverless Functionとして動かす構成を追加
  - `api/index.ts`(ルートエントリポイント。`createApp()`をexport)
  - `vercel.json`(`buildCommand`/`outputDirectory`/`rewrites`)
  - `server/package.json`に`postinstall: prisma generate`を追加
- デプロイ先はVercel(hnd1/東京リージョン)で確定、Supabaseもap-northeast-1に統一
- 発見・修正したバグ:
  - `mypageRouter`が`/api`直下に一括マウントされており、無関係な未定義`/api/*`パスへのアクセスまで401を返していた問題 → `/api/mypage`配下に限定してマウントし直して解消
  - `vercel.json`に`/api/*`用のrewriteしかなく、`/checkout/success`等のReact Router側パスへの直接アクセス/リダイレクトが404になる問題 → API以外を`index.html`にフォールバックするrewriteを追加して解消(4章参照)

### 7.2 デザインの刷新

仕様書の方向性(戦国らしさ・高級感・NFT会員証らしさ)に沿って、顧客向け・管理画面ともに全面的にデザインを刷新。

- 配色: 深紅(`--primary`)・金(`--accent`)・生成り(`--bg`)を基調とした和風高級感のあるトークン設計。ライト/ダークモード両対応
- タイポグラフィ: 見出しにShippori Mincho(明朝)、本文にNoto Sans JPを採用
- ヘッダー/フッターのグラデーション化、商品カードのホバー演出、ボタンの陰影・ホバーアニメーション、管理画面ナビの選択中ハイライト、テーブルの行ホバーなど、全体の質感を底上げ
- マイページのNFT発行状況を「デジタル会員証」らしいカードUIに変更
- favicon・ページタイトル・Google Fontsの読み込みも合わせて調整

### 7.3 法務ページのCMS化(`/admin/legal`)

- `legal_documents`テーブル(slug/title/body)を追加し、特商法・利用規約・返金ポリシー・プライバシーポリシーの4ページを管理画面から編集可能にした
- 本文は簡易記法のプレーンテキストで管理(`## `見出し、`!`注意書き、`項目名|値`でテーブル行)。HTMLをそのまま保存・描画する方式は取らず、XSSリスクを避けている
- 公開ページ・管理画面の編集プレビューの両方で同じレンダラー(`client/src/lib/legalContent.tsx`)を使用し、表示のずれを防止

### 7.4 代理店システム連携・代理店ポータル

ユーザー要望「LP→問い合わせ→代理店が説明→購入時に代理店専用URLを渡す」という運用フローに対応するための拡張。

- **代理店の多階層ツリー構造**: `agencies`テーブルに`external_id`(外部代理店システム側のID)と`parent_agency_id`(自己参照)を追加し、親子代理店の階層を持てるようにした
- **外部代理店システム連携API**(`/api/integrations/agencies`、詳細は`docs/api-agency-integration.md`):
  - Cookie/JWTではなくAPIキー認証(`x-api-key`ヘッダー、管理画面で発行)
  - `POST /`: 代理店の登録・更新(`external_id`による冪等upsert)。親代理店の指定、既定報酬率、担当者情報、ログインアカウント発行(`login_email`)に対応
  - `GET /` / `GET /:external_id`: 一覧・詳細(子代理店一覧含む)取得
  - 親代理店が未登録の状態で子を登録しようとした場合は404
- **代理店ポータルログイン**(`/agency`):
  - 既存の`users`テーブルに`role=agency`と`agencyId`を追加し、既存のログイン/パスワードリセットの仕組みをそのまま流用(新しい認証基盤を作らずに済ませた)
  - ログインアカウントは連携API経由で発行され、仮パスワードは平文送信せず、パスワード設定メール(既存のトークン方式を流用)で本人が初期設定する
  - ログイン後は自代理店の紹介URLの発行・一覧のみが可能(他代理店のインフルエンサー指定・他代理店の紹介URL閲覧は不可であることをテストで確認)
- **管理画面への追加**: 「代理店一覧」ページ(`/admin/agencies`)で、外部システムから登録された代理店のツリー構造・ログイン設定状況を確認可能(読み取り専用)
- 紹介URL発行のコアロジック(`referralLinkService.ts`)は管理画面用・代理店ポータル用で共通化し、重複実装を避けた

---

## 8. デプロイ状況

- デプロイ先: Vercel(hnd1リージョン)で運用中
- DB: Supabase(ap-northeast-1、東京)
- 環境変数(`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `APP_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TERMS_VERSION`)はVercelプロジェクトに設定済み
- Stripeキー・Webhookシークレット・代理店連携APIキーは`/admin/settings`経由でDBに登録
- スキーマ変更(法務ページ・代理店ツリー等)はSupabase側でSQL Editorから手動適用する運用を継続中(2.1参照)

---

## 9. コミット一覧

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
8e9b111 docs: 進捗レポートをStep 1〜12完了時点に更新
e96305f Vercelデプロイ準備(サーバーレスエントリポイント・設定ファイル)
6a0b031 design: 戦国らしい高級感のあるデザインシステムを導入
7cbad25 fix: VercelでSPAルート直アクセス時の404を修正
e1b3015 feat: 法務ページを管理画面から編集可能にし、デザインをさらに洗練
0b66143 feat: 代理店の多階層ツリー・外部システム連携API・代理店ポータルログインを追加
e000e9e docs: 代理店システム連携APIの仕様書を追加
```

---

## 10. ディレクトリ構成(主要ファイル)

```
server/
  prisma/
    schema.prisma
    migrations/
      20260705143147_init/                                … 全14テーブル
      20260705224911_add_settings/                         … settingsテーブル(仕様書外拡張)
      20260706021859_add_login_attempts/                   … login_attemptsテーブル(仕様書外拡張)
      20260706025851_add_guest_account_created/            … orders.guest_account_created(仕様書外拡張)
      20260706050733_add_legal_documents/                  … legal_documentsテーブル(7.3)
      20260706060000_add_agency_hierarchy_and_agency_login/ … agencies.external_id/parent_agency_id, users.agency_id(7.4)
    seed.ts
  src/
    app.ts                      … Express設定(webhook生ボディ順序、CSRF、代理店連携APIのマウント順序等)
    lib/
      prisma.ts, apiError.ts, httpError.ts, validation.ts, csv.ts
      authCookie.ts, settingsCrypto.ts, stripeClient.ts
    middleware/
      auth.ts (requireAuth/requireAdmin/requireAgency), csrf.ts (requireSameOrigin),
      integrationAuth.ts (requireAgencyApiKey, 7.4)
    routes/
      products.ts, cart.ts, checkout.ts, referrals.ts, auth.ts, legal.ts(7.3),
      mypage.ts, stripeWebhook.ts (+各 .test.ts)
      admin/ dashboard, products, orders, nftIssues, walletMissing,
             notices, agencies, referralLinks, referrals, settings,
             importProducts, legal(7.3) (+各 .test.ts)
      agency/ index.ts, referralLinks.ts (+.test.ts)(7.4 代理店ポータル)
      integrations/ agencies.ts (+.test.ts)(7.4 外部連携API)
    services/
      checkout.ts, orderNumber.ts, referral.ts, orderLookup.ts,
      settings.ts, stripeCheckout.ts, stripeWebhookHandlers.ts,
      jwt.ts, loginAttempts.ts, passwordReset.ts, mail.ts,
      mailTemplates.ts, referralCodeGenerator.ts, referralLinkService.ts(7.4), csvImport.ts (+各 .test.ts)
    test/ adminAgent.ts

client/
  src/
    components/ RequireAuth, RequireAdmin, RequireAgency(7.4), AdminLayout,
                 AgencyLayout(7.4), Footer
    context/ CartContext.tsx, AuthContext.tsx
    lib/ api.ts, adminApi.ts, agencyApi.ts(7.4), cart.ts, referral.ts, legalContent.tsx(7.3)
    pages/
      ProductListPage, ProductDetailPage, CartPage,
      CheckoutPage, CheckoutSuccessPage, CheckoutCancelPage,
      LoginPage, RegisterPage,
      PasswordResetRequestPage, PasswordResetConfirmPage,
      MyPage, WalletPage
      admin/ AdminDashboardPage, AdminProductsPage, AdminImportProductsPage,
             AdminOrdersPage, AdminNftIssuesPage, AdminWalletMissingPage,
             AdminNoticesPage, AdminReferralLinksPage, AdminReferralsPage,
             AdminSettingsPage, AdminLegalPage(7.3), AdminAgenciesPage(7.4)
      agency/ AgencyReferralLinksPage(7.4)
      legal/ TokushohoPage, TermsPage, RefundPolicyPage, PrivacyPolicyPage, LegalDocumentPage(7.3)

api/
  index.ts                      … Vercel Serverless Functionエントリポイント(7.1)
vercel.json                     … デプロイ設定・SPAルーティングのrewrite(7.1)

docs/
  sengoku_nft_cart_codex_instructions_v1_5.md … 正式仕様書
  progress-report.md                          … 本ドキュメント
  api-agency-integration.md                   … 外部代理店システム連携API仕様書(7.4)
```
