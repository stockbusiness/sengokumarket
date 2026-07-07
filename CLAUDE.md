# CLAUDE.md — 戦国 評議員NFT販売カート MVP

## プロジェクト概要

戦国楽市楽座の「評議員NFT(デジタル会員証)」を販売するECカートのMVP。
Stripe決済 + 手動NFT発行管理 + インフルエンサー代理店の紹介報酬管理を含む。

**正式な仕様書は `docs/sengoku_nft_cart_codex_instructions_v1_5.md`(v1.5)。**
本ファイルと仕様書が矛盾する場合は仕様書v1.5を正とする。
旧版(v1.0〜v1.4)の仕様が学習・文脈に混ざっても、必ずv1.5に従うこと。

## 技術スタック

- Frontend: React + TypeScript
- Backend: Node.js + Express
- DB: PostgreSQL + Prisma
- 決済: Stripe Checkout + Webhook
- 認証: JWT(httpOnly / Secure / SameSite Cookie)
- メール: Resend
- pip不使用。パッケージ追加時は理由を一言添える

## 進め方

1. 仕様書の「12. 実装ステップ」のStep 1〜12を**順番に**実装する
2. 各Step完了ごとに、実装内容・作成ファイル・未解決事項を簡潔に報告して停止する(勝手に次Stepへ進まない)
3. 仕様書に書かれていない判断が必要になったら、実装せずに質問する
4. 各Stepで最低限のテスト(特にStep 6のWebhook)を書く

## 絶対禁止事項(仕様書16章より)

- **referral_codesテーブルを作らない。**紹介マスタはreferral_linksのみ(唯一のマスタ)
- **注文の紹介コードを後から変更する機能を作らない**
- **紹介リンクの編集・削除機能を作らない**(inactive化+再発行で運用)
- orders側の報酬カラム(commission_rate / amount / status)を**単独更新しない**。報酬の正はcommissionsテーブルで、更新時に同一トランザクションでorders側キャッシュを同期する
- successページ到達を決済完了とみなす処理を書かない。**決済確定はWebhookのみ**
- 仮パスワードを平文でメール送信しない
- JWTをlocalStorageに保存しない
- Stripeの商品名・statement descriptorに「NFT」を含めない(「デジタル会員証」等を使う)
- 「値上がり」「利益保証」「投資」等の表現をUI文言に使わない

## 実装上の最重要ポイント

### Stripe Webhook(事故多発地帯・慎重に)

- webhookルートのみ `express.raw({ type: 'application/json' })` を適用し、`express.json()` より**前に**ルート定義する
- `stripe.webhooks.constructEvent()` で署名検証。失敗は400
- 検証通過後、stripe_eventsにevent_idをINSERT(UNIQUE)。重複なら即200(冪等性)
- 注文特定の優先順位: metadata.order_id → stripe_payment_intent_id → stripe_session_id → 特定不能ならログ+200
- 返金は**全額返金のみ自動処理**(amount_refunded >= amount)。一部返金はadmin_note記録のみ

### 在庫

- 仮引当方式: checkout時にreserved_stock加算(行ロック付き検証)、completed時にstock減算+仮引当解放、expired時に仮引当解放のみ
- オーバーセル検証: 販売可能数 = stock - reserved_stock

### nft_issues

- `order_items.item_type = 'nft'` の行のみ、**quantity個ぶん個別レコード**を作成
- ウォレット登録APIでwallet_required→ready_to_issue一括更新+アドレスをスナップショット

### 紹介・報酬

- 報酬率解決: referral_links.commission_rate → influencers.default → agencies.default → 0
- 解決値は注文作成時にordersへ、決済完了時にcommissionsへスナップショット(後からマスタを変えても過去注文に影響させない)
- referral_link_idありなら0円でもcommissions作成(0円はstatus=cancelled)
- 紹介コードはSGI+連番の自動生成のみ。手入力指定は不可

## コーディング規約

- スナップショット原則: 注文に関わる名称・価格・率は注文時点の値を保存し、マスタ参照で表示しない
- 金額はすべてINTEGER(円)。浮動小数点で金額計算しない
- 日時はTIMESTAMP(タイムゾーンはJST運用、保存はUTC)
- APIエラーレスポンスは `{ error: { code, message } }` 形式で統一
- 管理APIは認可ミドルウェアで一括保護(ルート個別にチェックを書かない)

## UI方針

- 40代以上にわかりやすく、Web3用語を出さない(NFT→デジタル会員証、Wallet→受取用ウォレット、Mint→発行)
- 価格は税込表記+「(税込)」併記
- 管理画面、特に紹介リンク発行画面(/admin/referral-links)は**スマホ操作前提**でレイアウトする

## 環境変数

`.env.example` を必ず用意する。必要な変数は仕様書14章を参照。
秘密情報をコードにハードコードしない。

## テスト・確認

- 完了条件は仕様書15章。特に以下は必ずテストを書く:
  - 同一Webhookイベント2回受信で二重処理されないこと
  - item_type != 'nft' でnft_issuesが作られないこと
  - 報酬率の3段階フォールバック解決
  - 全額返金でcommissionsがcancelledになりordersと同期されること
- Stripe CLIの `stripe listen --forward-to localhost:PORT/api/stripe/webhook` でローカル検証する
