# 戦国 評議員NFT販売カート MVP 実装指示書 v1.5

改訂日: 2026-07-05

## v1.5での変更点サマリー(v1.4からの修正)

| # | 変更内容 | 該当セクション |
|---|---------|--------------|
| 1 | **紹介リンク発行画面 `/admin/referral-links` をMVPに追加**(1画面完結型。フルCRUDではない) | 5.9 |
| 2 | 発行フォームから代理店・インフルエンサーを**その場で新規作成**できる仕様を定義 | 5.9 / 13 |
| 3 | 紹介コードの**自動生成ルール**(SGI+連番)を定義 | 5.9 |
| 4 | 紹介マスタ運用を「seed/SQLのみ」から「発行画面で運用」に変更 | 9.6 |
| 5 | referral-links関連のAdmin APIを追加 | 13 |
| 6 | フルCRUD・編集・削除・CSVインポートは次フェーズのまま(間違いはinactive化+再発行で対応) | 5.9 / 17 |

※ v1.4以前の変更履歴は旧版を参照。本書が単独で完結する最新版であり、**Codexへは本書のみを渡すこと**(旧版と併用しない)。

---

## 1. 開発目的

戦国経済圏における「評議員NFT」を販売するためのMVPを実装する。

最初の目的は、大規模ECではなく、以下を最短で成立させること。

- 評議員NFTの商品ページを表示する
- ユーザーがカートに追加できる
- Stripeで決済できる
- 決済完了後に注文が作成される
- ユーザーがマイページで購入履歴とNFT受取案内を確認できる
- 管理者が注文とNFT発行ステータスを管理できる

NFTの自動発行は初期MVPでは実装しない。
初期版では、管理者が手動でNFTを発行し、token ID / transaction hash を管理画面から登録する。

---

## 2. MVPの基本方針

### 実装するもの

- 商品一覧
- 商品詳細
- カート
- 購入者情報入力
- Stripe Checkout決済
- 決済完了ページ
- 会員登録 / ログイン
- マイページ
- 購入履歴
- ウォレットアドレス登録
- トランザクションメール送信(購入完了・ウォレット登録案内・パスワード設定)
- 管理画面
  - 商品管理
  - 注文管理
  - NFT発行管理
  - お知らせ管理
  - CSV商品インポート
  - **紹介リンク発行(1画面完結型)**
- 法務ページ(特定商取引法表記・利用規約・返金ポリシー・プライバシーポリシー)
- 戦国インフルエンサー代理店システム連携
  - 紹介コード / 紹介URLの発行・保存
  - 購入時の代理店・インフルエンサー紐づけ
  - 代理店別売上集計
  - 報酬予定額のCSV出力

### 初期では実装しないもの

- NFT自動ミント
- 暗号資産決済
- OVEトークン決済
- 二次流通
- 代理店報酬の自動振込
- 一部返金の自動処理(全額返金のみ正式対応)
- 紹介マスタのフルCRUD(編集・削除)/ CSVインポート(発行画面+inactive化で運用)
- メタバース連携
- 複数出店者によるマーケットプレイス

ただし、将来拡張できるようにDB設計には余地を持たせる。

---

## 3. 推奨技術構成

- Frontend: React + TypeScript
- Backend: Node.js + Express
- Database: PostgreSQL
- ORM: Prisma
- Payment: Stripe Checkout + Stripe Webhook
- Auth: メールアドレス + パスワード認証(JWT / httpOnly Cookie)
- Mail: Resend(推奨)または SendGrid
- Deploy: Vercel / Render / DigitalOcean など

既存プロジェクトの技術スタックがある場合は、それに合わせてよい。

---

## 4. 画面一覧

### ユーザー画面

#### 4.1 トップページ `/`

役割:評議員NFT販売ページへの導線。

表示内容:

- ヒーローコピー
- 評議員NFTの概要
- 特典の説明
- 購入ボタン
- FAQ
- フッター(特商法・利用規約・返金ポリシー・プライバシーポリシーへのリンク)

購入ボタンは商品詳細ページへ遷移。

---

#### 4.2 商品一覧 `/products`

初期では評議員NFTのみ表示。
将来的に土地NFT、武将NFT、会員商品、物販商品を追加できる構成にする。

表示項目:

- 商品画像
- 商品名
- 価格(税込表記)
- 在庫状況
- 詳細ボタン

---

#### 4.3 商品詳細 `/products/:slug`

URLは商品slug(例 `/products/council-nft`)を正とする。UUIDでのアクセスも許容する(13章参照)。

表示項目:

- 商品画像
- 商品名
- 説明文
- 価格(税込表記)
- バリエーション選択
- 在庫数
- 数量選択
- カートに追加ボタン

初期商品例:

- インフルエンサー評議員NFT Black
- インフルエンサー評議員NFT RED

同じ商品ページ内でバリエーションとして選択できるようにする(バリエーションはURLに含めない)。

URLに `?ref=xxxx` が付与されている場合、紹介情報としてlocalStorageとCookieに保存する(9章参照)。

---

#### 4.4 カート `/cart`

機能:

- カート内商品表示
- 数量変更
- 削除
- 小計表示
- 合計金額表示(税込)
- 購入手続きボタン

**カートの永続化:**

- カート状態はlocalStorageに保存し、リロード・再訪問後も保持する
- 保持期間は7日。期限切れデータは破棄する
- checkout遷移時にサーバー側で在庫・価格を再検証する(`POST /api/cart/validate`)。価格や在庫が変わっていた場合はカート画面に差し戻してユーザーに通知する

---

#### 4.5 購入者情報入力 `/checkout`

入力項目:

- 氏名
- メールアドレス
- 電話番号
- 郵便番号
- 住所
- 紹介コード 任意(localStorageに保存されたrefがあれば自動入力)
- 紹介元表示 任意(代理店名・インフルエンサー名が解決できる場合のみ表示。「紹介元:〇〇」程度。購入者が変更できるのは紹介コードのみ)
- 利用規約・返金ポリシーへの同意チェック(必須。各文書へのリンクを併記)

処理:

1. 入力バリデーション
2. 注文仮作成(payment_status = pending)
3. **在庫の仮引当**(7.4参照)
4. 規約同意の証跡保存(agreed_at / terms_version)
5. Stripe Checkout Session作成(有効期限30分)
6. Stripe決済画面へ遷移

---

#### 4.6 決済完了 `/checkout/success`

表示内容:

- 購入完了メッセージ
- 注文番号
- マイページへの導線
- NFT受取までの流れ(ウォレット登録 → 発行 → マイページで確認)
- ゲスト購入の場合:パスワード設定メールを送信した旨の案内

注意:successページ表示時点ではWebhook未着の可能性がある。orderのpayment_statusをポーリング(または「反映まで数分かかる場合があります」の表示)で対応する。**successページ到達を決済完了と見なす処理は書かないこと。決済確定は必ずWebhookで行う。**

---

#### 4.7 決済キャンセル `/checkout/cancel`

表示内容:

- 決済未完了メッセージ
- カートへ戻るボタン(カート内容は保持されている)

---

#### 4.8 ログイン `/login`

機能:

- メールアドレス
- パスワード
- ログイン
- パスワードを忘れた場合のリセットリンク(メール送信)

**セキュリティ(16章参照):**

- ログイン失敗はアカウント+IP単位で制限(例:5回失敗で15分ロック)
- パスワードリセット要求はメールアドレスの存在有無を返さない(常に「送信しました」表示)

---

#### 4.9 会員登録 `/register` およびゲスト購入時の自動作成

通常登録の入力項目:

- 氏名
- メールアドレス
- パスワード
- 電話番号

**ゲスト購入時のアカウント自動作成(確定仕様):**

1. checkout時に入力されたメールアドレスで既存ユーザーを検索
2. 既存ユーザーがいる場合:その user_id に注文を紐付ける(ログイン誘導は必須としない)
3. 既存ユーザーがいない場合:
   - ランダムなpassword_hashでユーザーを自動作成(role = user)
   - 決済完了後(checkout.session.completed処理内)に**パスワード設定リンク付きメール**を送信する
   - パスワード設定リンクは署名付きトークン(有効期限72時間)。`password_reset_tokens` テーブルで管理する
4. 仮パスワードをメールに平文で記載する方式は禁止

---

#### 4.10 マイページ `/mypage`

表示内容:

- ユーザー情報
- 購入済みNFT一覧
- NFT発行ステータス
- ウォレットアドレス登録状況(未登録の場合は登録を促すバナーを常時表示)
- 購入履歴
- 特典案内
- お知らせ(noticesのpublished分を新しい順に表示)

NFTステータス表示例:

- ウォレット未登録(登録ページへの導線を表示)
- 発行準備中
- 発行済み(token ID を表示)
- 発行エラー(サポート連絡先を表示)

---

#### 4.11 ウォレット登録 `/mypage/wallet`

入力項目:

- ウォレットアドレス
- チェーン種別 初期はPolygon固定(選択UIは出すが選択肢はPolygonのみ)

バリデーション:

- 空欄不可
- 形式チェック(EVMアドレス形式 `^0x[a-fA-F0-9]{40}$`)
- 既存登録がある場合は更新可

**ステータス連動(必須実装):**

ウォレット登録・更新API内で以下をトランザクション実行する。

1. walletsテーブルにupsert
2. 該当ユーザーの `status = 'wallet_required'` のnft_issues全件を `ready_to_issue` に更新
3. 同時に各nft_issuesの `wallet_address` に登録アドレスをスナップショット保存する(後からウォレットを変更しても、発行対象アドレスはnft_issues側の値を正とする)

**ウォレット変更時の挙動:**

- `wallet_required` / `ready_to_issue` のレコード:新アドレスで上書き
- `issued` / `failed` のレコード:変更しない(発行済みNFTの送付先は変わらないため)
- 変更時は確認モーダルで「発行済みのNFTには影響しません」と明示する

---

#### 4.12 法務ページ

以下の静的ページを実装する。コンテンツはMarkdownまたはCMS的なDB管理でもよいが、MVPでは静的ページで十分。

- `/legal/tokushoho` 特定商取引法に基づく表記
- `/legal/terms` 利用規約
- `/legal/refund` 返金ポリシー
- `/legal/privacy` プライバシーポリシー

全ページのフッターおよびcheckout画面からリンクする。文面は別途支給するため、プレースホルダで実装してよい。

---

## 5. 管理画面

管理画面URL例: `/admin`

**全管理画面・管理APIは role = 'admin' のJWT認証必須。**未認証・非adminは401/403を返す。

### 5.1 管理ダッシュボード `/admin`

表示内容:

- 総売上(payment_status = paid の合計)
- 注文件数
- 決済完了件数
- NFT未発行件数(wallet_required + ready_to_issue)
- ウォレット未登録件数
- 在庫残数(バリエーション別)
- 紹介経由売上
- 代理店別売上TOP5
- 未確定報酬予定額(commissions.status = pending の合計)
- **要対応アラート**:一部返金検知・報酬要回収の注文件数(7.3参照)

---

### 5.2 商品管理 `/admin/products`

機能:

- 商品一覧
- 新規作成
- 編集
- 公開 / 非公開
- 在庫変更
- バリエーション管理

商品項目:

- 商品名
- slug
- 説明文
- カテゴリ
- **商品タイプ(item_type)**
- 価格
- 在庫数
- ステータス
- 商品画像URL

---

### 5.3 注文管理 `/admin/orders`

表示項目:

- 注文番号
- 購入者名
- メールアドレス
- 金額
- 決済ステータス
- 注文ステータス
- 決済日時(paid_at)
- 紹介コード
- 代理店名
- インフルエンサー名
- 報酬予定額(orders側キャッシュ値。正はcommissions)
- 報酬ステータス(同上)
- 注文日時

機能:

- 詳細表示
- ステータス変更
- メモ登録

**紹介コードの変更機能は作らない**(9.8参照)。不正・誤登録への対応は報酬側(commissions)のcancelledで行う。

注文ステータス:

- pending
- paid
- cancelled
- refunded

---

### 5.4 NFT発行管理 `/admin/nft-issues`

表示項目:

- 購入者名
- 商品名
- バリエーション
- ウォレットアドレス(nft_issues側のスナップショット値)
- NFTステータス
- token ID
- transaction hash
- 発行日時

機能:

- ステータスによるフィルタ(特に ready_to_issue の一覧表示)
- ステータス変更
- token ID登録
- transaction hash登録
- 管理メモ登録

NFTステータス:

- wallet_required
- ready_to_issue
- issued
- failed

`issued` に変更する際は token_id と transaction_hash の入力を必須とし、issued_at に現在時刻を自動記録する。

---

### 5.5 ウォレット未登録者一覧 `/admin/wallet-missing`

表示項目:

- 購入者名
- メールアドレス
- 注文番号
- 商品名
- 購入日時
- 最終案内メール送信日時(任意実装)

用途:ウォレット未登録者へ案内するため。

---

### 5.6 CSV商品インポート `/admin/import-products`

機能:

- CSVアップロード
- プレビュー
- インポート実行
- エラー表示(行番号とエラー内容)

CSVの想定項目:

- 商品名
- slug
- 商品説明
- カテゴリ
- **商品タイプ(item_type。必須入力とする。誤ってnft_issuesが作られる事故を防ぐため)**
- バリエーション名
- SKU
- 価格
- 在庫数
- 公開ステータス

既存CSVの項目に差異がある場合は、マッピング画面またはコード内マッピングで吸収する。
SKU重複時は既存レコードを更新(upsert)とする。

---

### 5.7 お知らせ管理 `/admin/notices`

機能:

- お知らせ一覧
- 新規作成(タイトル・本文)
- 編集
- 公開 / 非公開(公開時にpublished_atを記録)
- 削除

公開されたお知らせはマイページに新しい順で表示される。

---

### 5.8 代理店・紹介成果管理 `/admin/referrals`

目的:戦国インフルエンサー用の代理店システムと購入データを紐づけ、誰の紹介で購入されたかを管理する。

表示項目:

- 紹介コード
- 代理店名
- インフルエンサー名
- アクセス数(任意。MVPでは未実装可)
- 注文件数
- 決済完了件数
- 売上金額
- 報酬率
- 報酬予定額
- 報酬ステータス

機能:

- 代理店別売上集計
- インフルエンサー別売上集計
- 注文一覧への絞り込み
- 報酬CSV出力(期間指定付き。9.7参照)
- **CSV出力時に対象commissionsをpending→approvedへ一括変更するオプション**(9.7参照)
- 報酬ステータス更新(approved→paidは支払完了後に管理者が手動変更)

**報酬データの正はcommissionsテーブルとする。**
報酬ステータス更新APIはcommissionsを更新し、同一トランザクション内でordersのcommission_status / commission_amountキャッシュを同期する。orders側を直接更新するAPIは作らない。

報酬ステータス:

- pending 未確定
- approved 確定(CSV出力済・支払予定)
- paid 支払済
- cancelled 対象外(返金・不正・報酬率0等)

MVPでは自動振込は実装しない。CSV出力後、経理・運営側で手動支払いする。

---

### 5.9 紹介リンク発行 `/admin/referral-links`(v1.5追加・1画面完結型)

目的:新しいインフルエンサー・代理店に紹介URLをその場で発行する。日常運用のメイン画面。**スマホでの操作を前提にUIを設計する。**

フルCRUD(編集・削除)は作らない。間違えた場合はinactive化して再発行する運用とする。

#### 発行フォーム(画面上部)

入力項目:

1. **代理店**:既存代理店のドロップダウン選択、または「新規作成」を選び名前を入力(その場でagenciesレコード作成。報酬率は任意入力、空欄なら0)
2. **インフルエンサー**:既存のドロップダウン選択(選択した代理店所属でフィルタ)、または「新規作成」で名前を入力(その場でinfluencersレコード作成、選択中の代理店に紐づけ)。**代理店のみ・インフルエンサーなしの発行も可**
3. **報酬率**:任意入力。空欄なら6.13の優先順位で自動継承(継承される率をフォーム上にプレビュー表示する)
4. **ランディング先**:デフォルト `/products/council-nft`(published商品のドロップダウンから選択)
5. 発行ボタン

処理:

- **紹介コードは自動生成**する。形式:`SGI` + ゼロ埋め3桁以上の連番(SGI001, SGI002, ...)。referral_links内でUNIQUEを保証(シーケンスまたはリトライ付き生成)
- 手入力によるコード指定はMVPでは不可(重複・紛らわしいコードの発生を防ぐ)
- 発行成功後、**完成した紹介URLを大きく表示し、コピーボタンを設置**する(例 `https://example.com/products/council-nft?ref=SGI002`)。そのままLINE等で相手に送れる状態にする

#### 発行済みリンク一覧(画面下部)

表示項目:

- 紹介コード
- 紹介URL(**コピーボタン付き**)
- 代理店名
- インフルエンサー名
- 適用報酬率(解決済みの値を表示)
- ステータス(active / inactive)
- 発行日

機能:

- **有効 / 無効の切替のみ**(トグル)。inactive化しても既存注文・確定済み報酬には影響しない(6.13参照)
- 編集・削除機能は作らない

---

## 6. データベース設計

### 6.1 users

```sql
id UUID PRIMARY KEY
name TEXT NOT NULL
email TEXT UNIQUE NOT NULL
phone TEXT
password_hash TEXT NOT NULL
role TEXT DEFAULT 'user'
created_at TIMESTAMP
updated_at TIMESTAMP
```

role:

- user
- admin

---

### 6.2 wallets

```sql
id UUID PRIMARY KEY
user_id UUID UNIQUE REFERENCES users(id)
wallet_address TEXT NOT NULL
chain TEXT DEFAULT 'polygon'
created_at TIMESTAMP
updated_at TIMESTAMP
```

※ user_id にUNIQUE制約(1ユーザー1ウォレット。変更はupsert)

---

### 6.3 products

```sql
id UUID PRIMARY KEY
name TEXT NOT NULL
slug TEXT UNIQUE NOT NULL
description TEXT
category TEXT NOT NULL
item_type TEXT NOT NULL DEFAULT 'nft'
base_price INTEGER NOT NULL
status TEXT DEFAULT 'draft'
image_url TEXT
created_at TIMESTAMP
updated_at TIMESTAMP
```

**slug:**URL用の識別子(例 `council-nft`)。半角英数とハイフンのみ。UNIQUE制約。

**item_type(重要):**

- nft:購入時にnft_issuesを作成する
- physical:物販(名刺・バッジ・チラシ等)。nft_issuesを作成しない
- service:役務・サポート等
- membership:会員権
- fee:事務手数料等

**checkout.session.completed時、nft_issuesを作成するのは `item_type = 'nft'` の商品のみ**(7.2参照)。

status:

- draft
- published
- archived

---

### 6.4 product_variants

```sql
id UUID PRIMARY KEY
product_id UUID REFERENCES products(id)
name TEXT NOT NULL
sku TEXT UNIQUE
price INTEGER NOT NULL
stock INTEGER DEFAULT 0
reserved_stock INTEGER DEFAULT 0
created_at TIMESTAMP
updated_at TIMESTAMP
```

- `stock`:実在庫
- `reserved_stock`:決済中の仮引当数(7.4参照)
- 販売可能数 = stock - reserved_stock
- バリエーションにslugは持たせない(URLに含めないため)

---

### 6.5 orders

```sql
id UUID PRIMARY KEY
order_number TEXT UNIQUE NOT NULL
user_id UUID REFERENCES users(id)
total_amount INTEGER NOT NULL
payment_status TEXT DEFAULT 'pending'
order_status TEXT DEFAULT 'pending'
paid_at TIMESTAMP
refunded_at TIMESTAMP
expired_at TIMESTAMP
stripe_session_id TEXT
stripe_payment_intent_id TEXT
referral_code TEXT
referrer_name TEXT
agency_name TEXT
agency_id UUID
influencer_id UUID
referral_link_id UUID
commission_rate NUMERIC(5,2) DEFAULT 0
commission_amount INTEGER DEFAULT 0
commission_status TEXT DEFAULT 'pending'
customer_name TEXT NOT NULL
customer_email TEXT NOT NULL
customer_phone TEXT
customer_postal_code TEXT
customer_address TEXT
terms_agreed_at TIMESTAMP NOT NULL
terms_version TEXT NOT NULL
admin_note TEXT
created_at TIMESTAMP
updated_at TIMESTAMP
```

**日時カラム:**

- paid_at:checkout.session.completed処理時に記録(Stripeイベントのcreatedを優先、なければWebhook受信時刻)
- refunded_at:charge.refunded(全額返金)処理時に記録
- expired_at:checkout.session.expired処理時に記録
- **報酬CSVの期間条件はpaid_atを正とする**(9.7参照)

**報酬関連カラムの位置づけ(重要):**

orders側の commission_rate / commission_amount / commission_status は**一覧表示用のキャッシュ**である。
報酬データの正は commissions テーブル(6.14)とし、commissionsの作成・更新時に必ずorders側を同期する。orders側だけを単独更新する処理を書いてはならない。

**注文番号生成ルール:**

```text
形式: SG-YYYYMMDD-XXXX
例:   SG-20260705-0001
XXXXは日毎の連番4桁。生成はDBシーケンスまたはトランザクション内カウントで衝突を防ぐ。
```

**規約同意の証跡:**

- terms_agreed_at:同意チェック時刻(注文作成時に記録)
- terms_version:同意した規約のバージョン文字列(環境変数 TERMS_VERSION から取得。例 "2026-07-01")

payment_status:

- pending
- paid
- failed
- refunded
- expired(Checkout Session期限切れ)

order_status:

- pending
- paid
- cancelled
- refunded

commission_status:

- pending
- approved
- paid
- cancelled

---

### 6.6 order_items

```sql
id UUID PRIMARY KEY
order_id UUID REFERENCES orders(id)
product_id UUID REFERENCES products(id)
variant_id UUID REFERENCES product_variants(id)
product_name TEXT NOT NULL
variant_name TEXT
item_type TEXT NOT NULL
quantity INTEGER NOT NULL
unit_price INTEGER NOT NULL
subtotal INTEGER NOT NULL
created_at TIMESTAMP
```

※ item_type は注文時点のproducts.item_typeをスナップショット保存する(後から商品タイプを変更しても過去注文の処理が変わらないようにするため)。

---

### 6.7 nft_issues

```sql
id UUID PRIMARY KEY
order_id UUID REFERENCES orders(id)
order_item_id UUID REFERENCES order_items(id)
user_id UUID REFERENCES users(id)
product_id UUID REFERENCES products(id)
variant_id UUID REFERENCES product_variants(id)
wallet_address TEXT
token_id TEXT
transaction_hash TEXT
chain TEXT DEFAULT 'polygon'
status TEXT DEFAULT 'wallet_required'
issued_at TIMESTAMP
admin_note TEXT
created_at TIMESTAMP
updated_at TIMESTAMP
```

**作成単位(必須ルール):**

- nft_issuesは**NFT1個につき1レコード**作成する。order_itemのquantityが3なら3件作成する
- **`order_items.item_type = 'nft'` の行に対してのみ作成する。**physical / service / membership / fee では作成しない
- token_id / transaction_hash はNFT個体ごとに異なるため、まとめてはいけない

**作成時の初期ステータス:**

- 購入者がウォレット登録済み → `ready_to_issue`(wallet_addressをスナップショット保存)
- 未登録 → `wallet_required`

status:

- wallet_required
- ready_to_issue
- issued
- failed
- cancelled(返金時。7.3参照)

---

### 6.8 notices

```sql
id UUID PRIMARY KEY
title TEXT NOT NULL
body TEXT NOT NULL
status TEXT DEFAULT 'draft'
published_at TIMESTAMP
created_at TIMESTAMP
updated_at TIMESTAMP
```

---

### 6.9 stripe_events(冪等性管理)

```sql
id UUID PRIMARY KEY
stripe_event_id TEXT UNIQUE NOT NULL
event_type TEXT NOT NULL
processed_at TIMESTAMP NOT NULL
created_at TIMESTAMP
```

Webhook受信時、まずstripe_event_idの存在チェックを行い、既存なら200を返して処理をスキップする(7.3参照)。

---

### 6.10 password_reset_tokens

```sql
id UUID PRIMARY KEY
user_id UUID REFERENCES users(id)
token_hash TEXT UNIQUE NOT NULL
expires_at TIMESTAMP NOT NULL
used_at TIMESTAMP
created_at TIMESTAMP
```

ゲスト購入時のパスワード設定、および通常のパスワードリセットの両方で使用する。
トークンはハッシュ化して保存し、平文はメールリンクにのみ含める。有効期限72時間、使用は1回限り。

---

### 6.11 agencies(代理店マスタ)

```sql
id UUID PRIMARY KEY
name TEXT NOT NULL
code TEXT UNIQUE NOT NULL
contact_name TEXT
contact_email TEXT
status TEXT DEFAULT 'active'
default_commission_rate NUMERIC(5,2) DEFAULT 0
created_at TIMESTAMP
updated_at TIMESTAMP
```

※ 紹介リンク発行画面からの新規作成時、codeは自動生成する(`AG` + ゼロ埋め3桁以上の連番)。

status:

- active
- inactive

---

### 6.12 influencers(インフルエンサーマスタ)

```sql
id UUID PRIMARY KEY
agency_id UUID REFERENCES agencies(id)
name TEXT NOT NULL
code TEXT UNIQUE NOT NULL
email TEXT
sns_url TEXT
status TEXT DEFAULT 'active'
default_commission_rate NUMERIC(5,2)
created_at TIMESTAMP
updated_at TIMESTAMP
```

※ 紹介リンク発行画面からの新規作成時、codeは自動生成する(`INF` + ゼロ埋め3桁以上の連番)。
インフルエンサーが代理店に所属しないケースも将来あり得るため、agency_idはNULL許容とする。

---

### 6.13 referral_links(紹介マスタ・唯一の紹介コードマスタ)

紹介コードの検索・報酬率の解決はすべて本テーブルを起点とする。**referral_codesという別テーブルを作ってはならない**(二重マスタ禁止)。

```sql
id UUID PRIMARY KEY
code TEXT UNIQUE NOT NULL
agency_id UUID REFERENCES agencies(id)
influencer_id UUID REFERENCES influencers(id)
commission_rate NUMERIC(5,2)
landing_path TEXT DEFAULT '/'
status TEXT DEFAULT 'active'
created_at TIMESTAMP
updated_at TIMESTAMP
```

- agency_id / influencer_id はどちらか一方でもよい(両方NULLは不可。CHECK制約またはアプリ側バリデーションで担保)
- `commission_rate` はリンク個別の報酬率。NULLの場合は下記の優先順位で解決する
- codeは発行画面で自動生成(`SGI` + ゼロ埋め3桁以上の連番。5.9参照)

**報酬率の解決優先順位(確定仕様):**

```text
1. referral_links.commission_rate(NULLでなければこれを採用)
2. influencers.default_commission_rate(influencer_idがありNULLでなければ)
3. agencies.default_commission_rate(agency_idがありNULLでなければ)
4. いずれもNULL → 0
```

解決した値は注文作成時にordersへ、決済完了時にcommissionsへスナップショット保存する。後からマスタの率を変更しても、確定済み注文の報酬率は変わらない。

status:

- active
- inactive(inactiveのコードは注文に保存はするが報酬率0として扱う)

**運用方法(v1.5確定):**代理店・インフルエンサー・紹介リンクの作成は**管理画面の紹介リンク発行画面(5.9)**で行う。編集・削除は作らず、間違いはinactive化+再発行で対応する。seedはサンプルデータ投入のみに使用する。

紹介URL例:

```text
https://example.com/products/council-nft?ref=SGI001
https://example.com/?ref=SGI001
```

---

### 6.14 commissions(報酬管理・報酬データの正)

```sql
id UUID PRIMARY KEY
order_id UUID UNIQUE REFERENCES orders(id)
agency_id UUID REFERENCES agencies(id)
influencer_id UUID REFERENCES influencers(id)
referral_code TEXT
base_amount INTEGER NOT NULL
commission_rate NUMERIC(5,2) NOT NULL
commission_amount INTEGER NOT NULL
status TEXT DEFAULT 'pending'
approved_at TIMESTAMP
paid_at TIMESTAMP
admin_note TEXT
created_at TIMESTAMP
updated_at TIMESTAMP
```

- order_id にUNIQUE制約(1注文につき報酬レコードは1件)
- **本テーブルが報酬データの正。**orders側の報酬カラムは表示用キャッシュであり、commissionsの作成・更新と同一トランザクションで同期する

**作成ルール:**

```text
referral_link_id が存在する注文の決済完了時:
  commission_rate > 0 → status = pending で作成
  commission_rate = 0 → commission_amount = 0、status = cancelled で作成
                        (追跡用。承認フローに0円行を混ぜない)

referral_codeのみ保存され referral_link_id が NULL の注文(マスタ不一致の手入力コード等):
  commissionsは作成しない(ordersのreferral_codeで追跡可能)
```

status:

- pending
- approved
- paid
- cancelled

MVPでは決済完了時に作成し、管理画面からCSV出力する。自動振込は実装しない。

---

## 7. Stripe連携仕様

### 7.1 Checkout Session作成

購入者情報入力後にCheckout Sessionを作成する。

必要情報:

- 商品名(表記は「デジタル会員証」等。16章参照)
- 単価
- 数量
- 顧客メールアドレス
- success_url / cancel_url
- expires_at:作成から30分
- metadata

metadataに入れる項目:

- order_id
- user_id
- referral_code

**注意:**metadataは注文特定(order_id)にのみ使用する。決済完了処理での紹介元・報酬率の参照は、注文作成時にordersへスナップショット保存した値を正とする(metadataの値で報酬計算をしない)。

---

### 7.2 checkout.session.completed の処理

以下を**1つのDBトランザクション内**で実行する。

1. 注文を特定(7.3の優先順位に従う)
2. order.payment_status = paid / order.order_status = paid に更新
3. **paid_at を記録**(Stripeイベントのcreatedを優先、なければWebhook受信時刻)
4. stripe_payment_intent_id を保存
5. **在庫確定**:各variantについて `stock -= quantity` かつ `reserved_stock -= quantity`
6. **nft_issues作成**:`order_items.item_type = 'nft'` の各行につき quantity 個のレコードを作成(6.7の初期ステータスルールに従う)。nft以外のitem_typeでは作成しない
7. **commission作成**:6.14の作成ルールに従いcommissionsを作成し、ordersのcommission_amount / commission_statusキャッシュを更新する
8. トランザクション外で購入完了メール送信(7.6)。ゲスト新規ユーザーの場合はパスワード設定メールも送信

### 7.3 Webhook 全体仕様

受信するイベント:

- checkout.session.completed
- checkout.session.expired
- payment_intent.payment_failed
- charge.refunded

**実装上の必須事項:**

1. **raw body処理**:署名検証にはリクエストの生ボディが必要。Expressでは webhookルートのみ `express.raw({ type: 'application/json' })` を適用し、`express.json()` より前に定義する。ここを誤ると全Webhookが署名検証エラーになる
2. **署名検証**:`stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` を必ず使用。検証失敗は400を返す
3. **冪等性**:検証通過後、stripe_eventsテーブルにevent_idをINSERT(UNIQUE制約)。重複キーエラーなら処理済みと判断し即200を返す。これにより在庫二重減算・nft_issues重複作成・commissions重複作成を防ぐ
4. **200レスポンス**:業務処理が失敗した場合のみ500を返し、Stripeのリトライに委ねる

**注文特定の優先順位:**

```text
1. checkout.session系イベント → session.metadata.order_id
2. payment_intent系 / charge系イベント → event内のpayment_intent から
   orders.stripe_payment_intent_id を検索
3. 上記で見つからない場合 → orders.stripe_session_id を検索
4. それでも特定できない場合 → エラーログに記録し200を返す
   (注文外の決済イベントで無限リトライさせない)
```

#### checkout.session.expired

- order.payment_status = expired / **expired_at を記録**
- **仮引当解放**:各variantの `reserved_stock -= quantity`

#### payment_intent.payment_failed

- order.payment_status = failed
- 仮引当はSessionが生きている間は維持(ユーザーがカード変更で再試行できるため)。最終的な解放はexpiredで行う

#### charge.refunded

**MVPは全額返金のみ正式対応とする。**

全額返金判定:

```text
charge.amount_refunded >= charge.amount
```

**全額返金の場合:**

- order.payment_status = refunded / order.order_status = refunded / **refunded_at を記録**
- **NFT発行データの扱い:**
  - `wallet_required` / `ready_to_issue` のnft_issues → `cancelled` に変更
  - `issued` のnft_issues → 変更しない(発行済みNFTの回収は管理者の手動対応。admin_noteに記録)
- **報酬データの扱い:**
  - commissions.status が `pending` / `approved` → `cancelled` に変更し、ordersのcommission_statusキャッシュも同期
  - commissions.status が `paid`(支払済) → statusは変更せず、admin_noteに「返金発生・報酬要回収」と自動記録し、ダッシュボードと紹介成果一覧で警告表示する(回収は運営の手動対応)
- **在庫の扱い:**MVPでは自動で在庫を戻さない。管理者が商品管理画面から手動で在庫を戻す

**一部返金の場合(amount_refunded < amount):**

- 注文ステータス・nft_issues・commissionsは**一切自動変更しない**
- orders.admin_note に「一部返金検知(金額)・要手動確認」と自動記録し、ダッシュボードの要対応アラートに表示する
- 対応(返金継続・報酬調整等)はすべて管理者の手動判断とする

---

### 7.4 在庫仮引当方式

オーバーセル防止のため、以下のフローとする。

```text
checkout時(Session作成前):
  トランザクション内で
    販売可能数(stock - reserved_stock) >= 注文数量 を行ロック付きで検証
    NG → 「在庫が不足しています」エラーを返す
    OK → reserved_stock += quantity

決済成功(completed):
  stock -= quantity
  reserved_stock -= quantity

Session期限切れ(expired):
  reserved_stock -= quantity
```

Prismaでは `$transaction` + `SELECT ... FOR UPDATE`(`$queryRaw`)または楽観ロック(updateの条件句に販売可能数チェックを含める)で実装する。

---

### 7.5 successページの扱い

4.6に記載の通り、success_url到達をもって決済完了処理をしてはならない。決済確定処理はWebhookのみ。successページはorderのステータスを表示するだけとする。

---

### 7.6 メール送信仕様(必須)

送信基盤:Resend(または既存で契約があればSendGrid)。送信元は環境変数 `MAIL_FROM` で指定。

MVPで実装するメール:

| メール | トリガー | 主な内容 |
|-------|---------|---------|
| 購入完了 | checkout.session.completed | 注文番号・購入内容・NFT受取までの流れ・マイページURL |
| パスワード設定案内 | ゲスト新規ユーザーの決済完了時 | パスワード設定リンク(72時間有効) |
| パスワードリセット | ユーザーのリセット要求時 | リセットリンク(72時間有効) |
| ウォレット登録案内 | 購入完了メール内に含める(独立送信は次フェーズ) | 登録ページURL・手順 |

メール送信失敗は注文処理を失敗させない(ログに記録し、管理者が注文管理画面から確認できればよい)。

---

## 8. NFT発行仕様

初期MVPではNFTのブロックチェーン発行処理は実装しない。

### 管理者の手動運用

1. 管理者がNFT発行管理画面を開き、`ready_to_issue` でフィルタ
2. 対象のウォレットアドレス(nft_issuesのスナップショット値)を確認
3. 外部NFT発行ツールまたは管理者ウォレットでNFTを発行
4. token ID / transaction hash を登録
5. ステータスを `issued` に変更(issued_at自動記録)
6. ユーザーのマイページに発行済みとして表示

### ステータス遷移ルール

```text
作成時:
  ウォレット未登録 → wallet_required
  ウォレット登録済 → ready_to_issue(wallet_addressスナップショット)

ウォレット登録/更新時(4.11):
  wallet_required → ready_to_issue(全件一括、wallet_addressスナップショット)

管理者操作:
  ready_to_issue → issued(token_id / transaction_hash必須)
  ready_to_issue → failed(admin_noteに理由)
  failed → ready_to_issue(再試行)

返金時(7.3):
  wallet_required / ready_to_issue → cancelled
```

---

## 9. 紹介コード・代理店システム連携仕様

初期版では、戦国インフルエンサー用の代理店システムと「購入の紐づけ」までを必須実装する。報酬の自動振込は実装しない。

### 9.1 基本フロー

```text
管理画面の紹介リンク発行画面(5.9)で紹介URLを発行
↓
インフルエンサー・代理店がSNS/LINEで紹介
↓
購入者が紹介URLからLPまたは商品詳細へアクセス
↓
refをlocalStorage/Cookieに保存
↓
Stripe決済
↓
注文に紹介コード・代理店ID・インフルエンサーID・報酬率を保存
↓
決済完了時にcommissionsを作成
↓
管理画面で代理店別/インフルエンサー別に売上確認
↓
報酬CSV出力(期間指定・approvedへ一括変更オプション)
↓
支払完了後、管理者がpaidに変更
```

### 9.2 紹介URL形式

```text
https://example.com/products/council-nft?ref=SGI001
https://example.com/?ref=SGI001
```

紹介パラメータは `ref` のみとする(代理店・インフルエンサーの区別はreferral_linksのマスタ側で解決できるため、URLパラメータを増やさない)。

### 9.3 保存ルール

1. URLに `ref` がある場合、localStorageとCookieに保存する
2. 保存期間は30日
3. 後勝ち。同じ端末で別の紹介URLを踏んだ場合、最後のrefで上書きする
4. checkout画面では保存済みrefを紹介コード欄に自動入力する
5. ユーザーが手入力で変更した場合は手入力値を優先する

保存データ例:

```json
{
  "referral_code": "SGI001",
  "source": "url",
  "saved_at": "2026-07-05T12:00:00+09:00",
  "expires_at": "2026-08-04T12:00:00+09:00"
}
```

### 9.4 注文作成時の解決処理

注文作成APIで以下を実行する。

1. referral_codeを受け取る
2. referral_links.code(status = active)を検索
3. 見つかった場合、6.13の優先順位で報酬率を解決し、ordersに以下をスナップショット保存
   - referral_code
   - referrer_name(influencer.name、なければagency.name)
   - agency_name
   - agency_id
   - influencer_id
   - referral_link_id
   - commission_rate(解決済みの値)
4. 見つからない場合(存在しない / inactive)、referral_codeのみ保存し、紹介元情報はNULL、commission_rateは0とする

紹介コードが不明でも購入は止めない。紹介コード不一致で購入機会を失わないことを優先する。

### 9.5 報酬計算と支払先

MVPでは単純計算とする。

```text
報酬予定額 = 決済完了金額(total_amount) × commission_rate / 100
```

**commissions作成ルール:**6.14に従う(referral_link_idがあれば0円でも作成、amount=0はstatus=cancelled)。

**支払先の単位(確定仕様):**

- agency_id がある場合:**報酬は代理店に一括支払い**する。所属インフルエンサーへの分配は代理店側の責任で行う(本システムは関与しない)
- agency_id がなく influencer_id のみの場合:インフルエンサーに直接支払う
- 報酬CSVには「支払先区分(agency / influencer)」「支払先名」を含め、経理が迷わないようにする

送料・税・クーポンを将来導入する場合は、報酬対象金額を別途定義する。現時点ではtotal_amountを対象にしてよい。

### 9.6 外部代理店システムとの連携方式・マスタ運用

**MVPの運用(v1.5確定):**代理店・インフルエンサー・紹介リンクの作成は管理画面の**紹介リンク発行画面(5.9)**で完結させる。seedはサンプルデータ投入のみ。フルCRUD・CSVインポートは次フェーズとする。

将来、別システムと連携する場合は以下のどちらかに拡張する。

- API連携:代理店システムからreferral_linksを作成・更新する
- CSV連携:代理店一覧・インフルエンサー一覧・紹介リンクをCSVインポートする

購入システム側に紹介マスタを持たせることで、外部システム停止時でも購入フローが止まらない。

### 9.7 報酬CSV出力とステータス更新

**抽出条件(必須):**

```text
対象: commissions
条件: orders.payment_status = 'paid'
      AND commissions.status IN ('pending', 'approved')  ※出力対象を選択可能に
      AND orders.paid_at が指定期間内(from / to)
```

- 期間指定(from / to)は必須パラメータとする(月次締め運用を想定)。**基準日はorders.paid_at**
- `cancelled` は出力対象外。`paid`(支払済)は再出力防止のためデフォルト除外とし、オプションで含められるようにする

**CSV出力時のステータス更新:**

```text
出力オプション「対象をapprovedに変更する」(mark_approved=true)を用意する。

mark_approved=true の場合:
  出力対象のうち status = pending の行を approved に一括変更し、
  approved_at を記録。ordersのキャッシュも同期する。
  ※二重支払い防止:次回同条件で出力するとき pending のみを対象にすれば
    既出力分が混ざらない。

支払完了後:
  管理者が紹介成果管理画面から approved → paid に変更(paid_at記録)。
```

CSVには最低限以下を含める。

```text
注文番号
注文日
決済日(orders.paid_at)
購入者名
購入者メール
商品名
購入金額
紹介コード
支払先区分(agency / influencer)
支払先名
代理店名
インフルエンサー名
報酬率
報酬予定額
報酬ステータス
Stripe Payment Intent ID
```

### 9.8 不正・誤登録への対応

- **注文の紹介コードを後から変更する機能は作らない。**paid後の紹介元変更はcommissionsとの整合を壊すため
- 自己購入(インフルエンサー本人が自分のコードで購入)の自動判定はMVPでは行わない(ユーザーとインフルエンサーが別マスタのため)
- 不正・誤登録が判明した場合の対応は**報酬側で行う**:管理者が紹介成果管理画面から該当commissionsを `cancelled` に変更し(orders同期)、admin_noteに理由を記録する
- 紹介リンク自体を止めたい場合は発行画面からinactiveに切り替える(以降の新規注文は報酬率0扱い。既存注文には影響しない)
- 発行内容を間違えた場合も同様にinactive化し、正しい内容で再発行する(編集機能は作らない)

---

## 10. 初期データ

### 管理者ユーザー

環境変数 ADMIN_EMAIL / ADMIN_PASSWORD からseedで作成(role = admin)。
**初回ログイン時にパスワード変更を促す画面を表示する**(強制ではなく推奨表示でよい)。

### 商品

```text
商品名:インフルエンサー評議員NFT
slug:council-nft
カテゴリ:評議員NFT
item_type:nft
説明:戦国経済圏に参加する評議員向けの限定NFTです。
基本価格:25000(税込)
ステータス:published
```

### バリエーション

```text
Black / SKU: council-nft-black / 価格: 25000 / 在庫: 100
RED / SKU: council-nft-red / 価格: 25000 / 在庫: 100
```

### 代理店・インフルエンサー・紹介リンク(サンプル)

```text
agencies:
  code: AG001 / name: 戦国インフルエンサー代理店サンプル / default_commission_rate: 20

influencers:
  code: INF001 / name: サンプルインフルエンサー / agency_code: AG001 / default_commission_rate: NULL

referral_links:
  code: SGI001 / agency_code: AG001 / influencer_code: INF001
  / commission_rate: NULL(→ influencer NULL → agency 20% が適用される)
  / landing_path: /products/council-nft
```

※ 連番自動生成はこのサンプルの続き(AG002 / INF002 / SGI002〜)から始まるように実装する。

---

## 11. デザイン方針

### 全体トーン

- 戦国らしさ
- 高級感
- NFT会員証らしさ
- 40代以上にもわかりやすいUI
- Web3用語を出しすぎない

### 管理画面

- **紹介リンク発行画面(5.9)は特にスマホ操作を前提に設計する**(運営者がスマホから発行してLINEで送る運用のため)
- 紹介URLのコピーボタンはタップしやすいサイズにする

### 価格表示

- 全ページで**税込価格**を表示し「(税込)」を併記する
- 領収書はStripeのレシートメール機能で代替する(Checkout Sessionで `receipt_email` 相当の設定を有効化)

### 文言方針

難しい言葉は避ける。

例:

- NFTを受け取る → デジタル会員証を受け取る
- Wallet → 受取用ウォレット
- Mint → 発行
- DAO → 参加型コミュニティ

---

## 12. 実装ステップ

### Step 1: プロジェクト初期化

- React + TypeScript
- Express API
- PostgreSQL
- Prisma
- 環境変数設定

### Step 2: DB構築

- Prisma schema作成(stripe_events / password_reset_tokens / agencies / influencers / referral_links / commissions、slug / item_type / paid_at等のカラム含む)
- migration実行
- seedデータ投入(管理者・商品・バリエーション・代理店・インフルエンサー・紹介リンク)

### Step 3: 商品表示

- 商品一覧API / 商品詳細API(id / slug両対応)
- 商品一覧画面 / 商品詳細画面
- refパラメータのlocalStorage / Cookie保存

### Step 4: カート

- localStorage永続化付きカート状態管理
- 数量変更 / 削除 / 合計金額計算
- cart validate API

### Step 5: 購入者情報入力

- checkoutフォーム(規約同意チェック含む)
- 入力バリデーション
- 注文仮作成API(在庫仮引当・同意証跡保存・紹介コード解決/報酬率スナップショット・order_items.item_typeスナップショット含む)

### Step 6: Stripe決済

- Checkout Session作成API(expires_at 30分)
- success / cancel画面
- Webhook実装(raw body・署名検証・冪等性・4イベント対応・注文特定優先順位・全額/一部返金判定)
- nft_issues作成(item_type = nftのみ・数量分)/ commissions作成 / 各種日時記録

### Step 7: 認証

- 会員登録 / ログイン / ログアウト(JWT httpOnly Cookie)
- ログイン失敗回数制限
- ゲスト購入時の自動アカウント作成 + パスワード設定メール
- パスワードリセット(存在有無を返さない)
- マイページ保護

### Step 8: マイページ

- 購入履歴表示
- NFT発行状況表示
- ウォレット登録(nft_issuesステータス連動)
- お知らせ表示

### Step 9: 管理画面

- 管理者認可ミドルウェア + CSRF対策
- ダッシュボード(要対応アラート含む)/ 商品管理 / 注文管理 / NFT発行管理 / ウォレット未登録一覧 / お知らせ管理
- **紹介リンク発行画面(発行フォーム+一覧+コード自動生成+URLコピー+active/inactive切替)**
- 代理店・紹介成果管理 / 報酬ステータス更新(orders同期含む)/ 報酬CSV出力(期間指定・approved一括変更オプション)

### Step 10: CSVインポート

- CSVアップロード / プレビュー / upsertインポート / エラー表示(item_type必須)

### Step 11: メール送信

- Resend連携
- 購入完了 / パスワード設定 / パスワードリセット

### Step 12: 法務ページ

- 特商法 / 利用規約 / 返金ポリシー / プライバシーポリシー(プレースホルダ可)
- フッター・checkoutからのリンク

---

## 13. API設計

### Public API

```text
GET  /api/products
GET  /api/products/:idOrSlug     ※ UUID形式ならid、それ以外はslugとして解決
POST /api/cart/validate
POST /api/checkout/create-session
GET  /api/referrals/resolve?code=:code
POST /api/stripe/webhook          ※ express.raw適用・署名検証必須
```

**GET /api/referrals/resolve の制限(必須):**

- 返却するのは表示名(referrer_name相当)のみ。agency_id / influencer_id / 報酬率・連絡先などの内部情報は返さない
- 存在しない・inactiveなコードは一律 `{ found: false }` を返す(存在有無を区別させない)
- IPベースのレート制限(例:10回/分)を適用し、コード総当たりによるマスタ列挙を防ぐ

### Auth API

```text
POST /api/auth/register
POST /api/auth/login              ※ 失敗回数制限あり
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/password-reset/request   ※ メール存在有無を返さない
POST /api/auth/password-reset/confirm   ※ ゲスト購入のパスワード設定と共用
```

### User API(要ログイン)

```text
GET  /api/mypage/orders
GET  /api/mypage/nfts
GET  /api/mypage/wallet
POST /api/mypage/wallet            ※ nft_issuesステータス連動を含む
GET  /api/mypage/notices
```

### Admin API(要ログイン + role = admin。認可ミドルウェアで一括保護 + CSRF対策)

```text
GET  /api/admin/dashboard
GET  /api/admin/products
POST /api/admin/products
PUT  /api/admin/products/:id
GET  /api/admin/orders
GET  /api/admin/orders/:id
PUT  /api/admin/orders/:id
GET  /api/admin/nft-issues
PUT  /api/admin/nft-issues/:id
GET  /api/admin/wallet-missing
POST /api/admin/import-products
GET  /api/admin/notices
POST /api/admin/notices
PUT  /api/admin/notices/:id
DELETE /api/admin/notices/:id
GET  /api/admin/agencies                    ※ 発行フォームのドロップダウン用(id / name のみ)
GET  /api/admin/influencers?agency_id=:id   ※ 同上(代理店で絞り込み)
GET  /api/admin/referral-links
POST /api/admin/referral-links              ※ v1.5追加。下記参照
PUT  /api/admin/referral-links/:id/status   ※ active / inactive 切替のみ
GET  /api/admin/referrals/summary
GET  /api/admin/referrals/orders
GET  /api/admin/referrals/commissions
PUT  /api/admin/referrals/commissions/:id   ※ commissions更新+orders同期を1トランザクションで実行
GET  /api/admin/referrals/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&status=pending,approved&mark_approved=true|false
```

**POST /api/admin/referral-links の仕様(v1.5追加):**

リクエスト例:

```json
{
  "agency": { "id": "既存UUID" } または { "new_name": "新規代理店名", "default_commission_rate": 20 },
  "influencer": { "id": "既存UUID" } または { "new_name": "新規名" } または null,
  "commission_rate": null,
  "landing_path": "/products/council-nft"
}
```

処理(1トランザクション):

1. agencyが `new_name` の場合、agenciesを作成(code自動生成 AG+連番)
2. influencerが `new_name` の場合、influencersを作成(code自動生成 INF+連番、agency紐づけ)
3. referral_linksを作成(code自動生成 SGI+連番、UNIQUE保証)
4. レスポンスで完成した紹介URL・解決済み報酬率を返す

---

## 14. 環境変数

```env
DATABASE_URL=
JWT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PUBLIC_KEY=
APP_URL=
ADMIN_EMAIL=
ADMIN_PASSWORD=
RESEND_API_KEY=
MAIL_FROM=
TERMS_VERSION=2026-07-01
```

※ 紹介URLの生成にはAPP_URLを使用する。

---

## 15. 完了条件

MVP完了条件:

- 商品ページ(slug URL)から評議員NFTを購入できる
- Stripe決済が完了する
- 決済完了後に注文ステータスがpaidになり、paid_atが記録される(Webhook経由)
- 在庫が減る(仮引当 → 確定のフローが正しく動く)
- Session期限切れで仮引当が解放され、expired_atが記録される
- **同一Webhookイベントを2回受信しても在庫・nft_issues・commissionsが二重処理されない**
- **nft_issuesがitem_type = 'nft' の商品のみ・購入数量分作成される**(nft以外の商品では作成されない)
- ユーザーがマイページで購入履歴を確認できる
- ユーザーがウォレットアドレスを登録でき、該当nft_issuesがready_to_issueになる
- ゲスト購入でアカウントが自動作成され、パスワード設定メールが届く
- 購入完了メールが届く
- 管理者がNFT発行ステータスを変更でき、token ID / transaction hash を保存できる
- 全額返金Webhookで未発行のnft_issuesがcancelledになり、refunded_atが記録される
- 全額返金Webhookでpending/approvedのcommissionsがcancelledになり、ordersのキャッシュも同期される
- 一部返金では自動変更されず、admin_note記録とダッシュボード警告のみ行われる
- 管理画面が非adminからアクセスできない
- 法務4ページが存在しフッターからリンクされている
- 規約同意日時とバージョンが注文に記録されている
- **管理画面の紹介リンク発行画面から、新規代理店・新規インフルエンサーをその場で作成しつつ紹介リンクを発行できる(コード自動生成・URLコピー可能)**
- **発行した紹介リンクをinactiveに切り替えられ、以降の新規注文が報酬率0扱いになる(既存注文には影響しない)**
- 紹介URL `?ref=SGI001` から購入した注文に referral_code / agency_id / influencer_id / commission_rate(解決済み)が保存される
- referral_links.commission_rateがNULLの場合、influencer → agency の順で報酬率が解決される
- 決済完了時にcommissionsが作成される(referral_link_idありなら0円でも作成、0円はcancelled)
- 管理画面で代理店別・インフルエンサー別の売上が確認できる
- paid_at基準の期間指定付きで報酬CSVを出力でき、mark_approved=trueで対象がapprovedに一括変更される
- 管理者がapproved → paidに変更できる

---

## 16. 注意点

### 表現・法務

- 初期版ではNFTの法的・金融商品的な表現は避ける
- 「値上がり」「利益保証」「投資商品」などの表現は使わない
- Stripe決済ではNFTという表現より「デジタル会員証」「会員権」「参加証明」として設計する方が安全。Stripeの商品名・statement descriptorにも「NFT」を含めない
- 購入画面には利用規約・返金ポリシー・特定商取引法表記へのリンクを設置し、同意チェックを必須とする

### 決済・データ整合性

- Webhookは署名検証・冪等性処理を必ず実装する(raw body注意)
- 在庫は仮引当方式とし、確定減算は決済成功後に実行する
- 報酬データの正はcommissionsテーブル。orders側は表示用キャッシュであり単独更新禁止
- 紹介マスタはreferral_linksのみ。referral_codesテーブルを作ってはならない
- 注文の紹介コードを後から変更する機能を作ってはならない(9.8)
- 紹介リンクの編集・削除機能を作ってはならない(inactive化+再発行で運用する)

### セキュリティ

- 管理画面・Admin APIは必ず認証+admin認可必須にする
- **JWTはhttpOnly / Secure / SameSite属性付きCookieで保持する**(localStorageに保存しない)
- Cookie認証のため、状態変更系API(POST/PUT/DELETE)には**CSRF対策**(CSRFトークンまたはSameSite=Strict + Origin検証)を実装する
- **ログイン失敗回数制限**を入れる(例:アカウント+IP単位で5回失敗→15分ロック)
- パスワードリセット要求はメールアドレスの存在有無を返さない
- 管理者の初期パスワード(環境変数由来)は初回ログイン後に変更を促す
- パスワードはbcrypt等でハッシュ化。平文パスワードのメール送信は禁止
- token ID / transaction hash は管理者入力値のため、形式バリデーション(tx hashは `^0x[a-fA-F0-9]{64}$`)を入れる

---

## 17. 将来拡張

次フェーズで追加する候補:

- 代理店・インフルエンサー・紹介リンクのフルCRUD(編集・削除)/ CSVインポート
- NFT自動発行(nft_issuesのready_to_issueをキューとして処理する設計にしてあるため接続しやすい)
- 一部返金の自動処理
- 紹介リンクのアクセス数計測(referral_clicksテーブル)
- ウォレット登録案内メールの自動リマインド
- クーポン
- 土地NFT販売 / 武将NFT販売(item_type設計により同一カートで販売可能)
- 物販商品(名刺・バッジ等。item_type = physical)・配送管理
- 月額会員商品(item_type = membership)
- OVEトークン連携
- メタバース店舗連携
- クリエイター出店機能
