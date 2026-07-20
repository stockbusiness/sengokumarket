# 千ノ国4システム共通方針書(v2.1)との差分報告

- 対象文書: 「千ノ国 4システム共通認識・連携方針書【完全版】」v2.1 修正版(2026年7月20日)
- 対象システム: 本リポジトリ(戦国楽市楽座 / sengokumarket) = 方針書における「ショッピングシステム」
- 位置づけ: 本書は上位方針書のため、現行実装と異なる箇所があっても独自判断で改修せず、差分・影響範囲・必要API・データ移行の有無を報告するもの。実装範囲は個別指示書で別途確定する。

---

## 0. 前提

このリポジトリは方針書でいう「ショッピングシステム」に相当する。現行実装は単独システムとして設計されており、**「代理店システム内 共通顧客HUB」「千ノ国パスポート」「千ノ国ウォレット」との連携は一切実装されていない**(唯一の外部連携は、代理店階層同期用の`sengoku-ai.com`向け独自API `server/src/routes/integrations/agencies.ts` のみで、これは本書のHUB API群とは別物・別仕様)。そのため差分は「項目単位の差分」よりも「アーキテクチャ全体が前提から異なる」というレベルのものが大半である。

---

## 1. アーキテクチャレベルの差分(最重要)

| 項目 | 本書の方針 | 現行実装 | 影響範囲 |
|---|---|---|---|
| 共通ユーザーID | `common_user_id`を発行し、全システムがこれを軸に連携。`system_account_links`で各システムローカルIDと対応 | `User.id`(このDB内のUUID)のみ。他システムとのID対応表は存在しない | 会員登録・ログイン・ゲスト購入時のアカウント作成・注文の紐づけ全般 |
| 顧客解決の起点 | 新規登録時に必ず共通顧客HUBへ照会(`POST /users/resolve`等) | `prisma.user.findUnique({email})`で自システム内のみ完結 | `server/src/routes/auth.ts`(register/login)、`server/src/services/checkout.ts`(ゲスト購入時のアカウント作成)、`server/src/services/externalOrderImport.ts`(外部購入取り込み) |
| 代理店組織・階層・報酬の正本 | 代理店システムの「代理店業務機能」が正本。ショッピング側は照会・スナップショットのみ | `Agency`/`Influencer`/`ReferralLink`/`Commission`テーブルがこのDB内にあり、報酬率解決・報酬計算(`createCommissionForOrder`)もこのシステム内で完結・確定している | 紹介・報酬機能全体(admin/agencies, admin/referralLinks, admin/referrals, orderFulfillment.ts) |
| 登録経路・登録紹介者・担当代理店・販売担当・クロージング担当の正本 | 共通顧客HUB(代理店システム内)が正本 | `User.referredByAgencyId`等・`Order.agencyId`/`influencerId`/`explainerName`等、すべてこのDB内で確定・保存 | Userモデル、Orderモデル、checkout.ts、explainerMatch.ts |
| クーポンの保有者・残高・仮押さえ状態の正本 | 千ノ国ウォレットが正本。ショップは対象商品・割引額・注文金額計算のみ | `Coupon`/`CouponCustomer`/`CouponUsage`が全てこのDB内で完結(仮押さえ・確定・失効も自前実装) | クーポン機能全体(coupon.ts, admin/coupons.ts) |
| ポイント・ガチャ券・OVE表示残高 | 千ノ国ウォレットの正本領域 | このリポジトリには一切概念が存在しない | 購入後特典付与フロー全体が未着手 |
| 参加国・役割・利用権の付与 | 千ノ国パスポートが正本。購入後に`entitlement.grant`で連携 | このリポジトリは「NFT発行(nft_issues)」を独自の権利表現として持つのみで、外部システムへの権利付与連携は存在しない | NFT発行の位置づけ自体を要整理(5章参照) |
| システム間イベント通知 | `order.paid`/`order.refunded`等をHUB・パスポート・ウォレットへWebhook通知、冪等・再送・処理状態管理 | アウトバウンドのWebhook送信機構自体が存在しない(受信専用: Stripe Webhook、Crossmint連携、sengoku-ai.com向け限定API呼び出しのみ) | 決済確定・返金確定の全フロー(stripeWebhook.ts, bankTransfer.ts, orderFulfillment.ts) |
| 直接DB更新の禁止(§27.1) | 代理店システムが他システムDBへ直接書き込むことを禁止 | 該当なし(現状すべて自己完結のため抵触なし) | ー |

---

## 2. 商品・注文まわりの差分

| 項目 | 本書 | 現行実装 | 影響範囲 |
|---|---|---|---|
| `sales_model`(direct_allowed/agent_required/hybrid) | 商品ごとに設定し、`agent_required`は販売担当未確定の注文を確定させない | `Product`モデルに該当フィールドなし。全商品が「紹介コードは任意入力」で購入可能な一律仕様(事実上hybridに近いが強制力なし) | Productモデル、checkout.ts(注文確定条件)、admin/products.ts |
| 販売コンテキストの確定根拠(§17: 代理店専用URL・署名付き販売担当トークン・商談レコード) | 「担当代理店の自動コピーを販売担当にしてはいけない」 | 現行は`explainerName`(自由入力+名簿照合のベストエフォート一致)のみで、署名付きトークンや代理店専用購入URLに基づく確定フローはない | checkout.ts, explainerMatch.ts |
| `order_sales_agent_id` / `order_closer_agent_id`の分離 | 販売担当とクロージング担当を分けて保存 | `Order.agencyId`/`influencerId`が単一の紐付け(報酬計算対象と同一)。クロージング担当という区分自体がない | Orderモデル、Commission計算ロジック |
| `referral_token_id` / `sales_context_id` / `commission_rule_version`のスナップショット | 注文に必須項目として保存 | 存在しない(`referralLinkId`はあるが、トークンの署名・有効期限管理や販売コンテキストIDという概念はない) | Orderモデル |
| チャージバック管理 | 返金種別の一つとして必須対応 | コード上、Stripeの`charge.dispute.*`系イベントを扱う実装が見当たらない | stripeWebhook.ts |
| 仮顧客(代理店による先行登録) | 代理店が見込み顧客を仮登録→招待→本人認証→正式化 | 該当機能なし。ゲスト購入は「購入と同時に」正式アカウント作成のみ | 新規機能領域 |

---

## 3. 必要になるAPI(呼び出し側・提供側)

本書§27の論理APIに対応させると、このシステムが**呼び出す側**として最低限必要になるのはおおよそ以下(実URL・認証は現行実装確認後に確定):

- `POST /users/resolve`(新規登録・ゲスト購入時のアカウント作成前に必ず呼ぶ)
- `POST /users`(HUB未登録の新規顧客作成)
- `GET /users/{common_user_id}/sales-context`(注文確定前に販売担当・クロージング担当を取得)
- `POST /orders/{order_id}/sales-context/confirm`(注文確定時にHUBへ販売コンテキストを確定通知)
- `POST /wallet/credits`(決済確定後、購入特典ポイント・クーポン等を付与依頼)
- `POST /entitlements/grant` / `POST /entitlements/revoke`(購入後の権利付与・返金時の権利取消)
- `order.paid` / `order.cancelled` / `order.refunded` / `order.partially_refunded` / `order.chargeback`のイベント発火(Webhook送信側)

このシステムが**提供する側**として必要になりそうなのは:

- 決済状態・注文情報の照会API(HUB・パスポート・ウォレットが表示目的で参照する用)
- Webhook受信済みイベントの冪等性・再送状態を確認できる内部API(既存の管理画面「連携管理」相当機能がまだない)

いずれも現行にはゼロベースで追加する形になる。

---

## 4. データ移行の要否

| 対象 | 移行要否 | 内容 |
|---|---|---|
| 既存`User` → `common_user_id`紐付け | **要** | 全既存会員(および代理店ポータルアカウント)についてHUBへ照会/新規発行し、`common_user_id`との対応を`system_account_links`相当に記録する必要あり。本書§14の照合ルール(認証済みメール/電話番号は確認、氏名のみ一致は不可)に従う |
| 既存`Agency`/`Influencer`/`ReferralLink` | **要検討** | これらの正本を代理店システム側に一本化するなら、既存データのエクスポート・突合・重複排除が必要。今後もこのDBを正本として残す設計にするなら移行不要(要方針確認) |
| 既存`Order`の紹介・報酬スナップショット | **要マッピング** | `agencyId`/`influencerId`/`referralCode`等の既存フィールドを、本書の`order_sales_agent_id`/`order_closer_agent_id`等の新語彙にどうマッピングするか要整理。過去注文のスナップショットは「原則変更しない」(§17)ため、遡及変換はせず新旧フィールド併存 or 変換ビューで対応する方針が無難 |
| 既存`Coupon`/`CouponCustomer`/`CouponUsage` | **要検討(規模大)** | ウォレットへ保有者・残高正本を移すなら、保有者ごとの残クーポン・仮押さえ中の状態を含めて移行が必要。決済中の仮押さえ中注文がある状態での移行はタイミングに注意 |
| ポイント・ガチャ券・OVE残高 | 該当データなし | 新規構築のみ |
| `WalletReminderEmail`, `nft_issues`等、本書に対応概念がない拡張データ | 判断保留 | 本書は上位方針であり、NFT発行の扱い(パスポートの`entitlement`と統合するか、このシステム独自の権利表現として残すか)が個別指示書待ち |

---

## 5. 現行実装との一致点(参考)

差分ではないが、個別指示書の検討材料として:

- **スナップショット原則**(注文確定時に紹介・報酬情報を確定し以後変更しない)は、CLAUDE.mdの既存絶対ルールと本書§17が本質的に同じ方向を向いている。フィールド名の整理だけで済む可能性がある。
- **全額返金の自動処理・部分返金は手動記録のみ**という既存ルールは、本書§22の「返金起点はショッピング」という方針と矛盾しない。
- **冪等性**(Stripe Webhookのevent_id UNIQUE制御)は既に実装済みで、本書§29.1の要求と同じ設計思想。アウトバウンド側(HUB等への通知)にも同じパターンを流用できる。

---

## 6. 未確定・要確認事項(本書§39相当、このシステムに関するもの)

- 既存`referral_links`/`agencies`/`influencers`/`commissions`の正本を今後もこのDBに残すか、代理店システム側へ移管するか
- `sales_model`を導入する場合、既存の全商品(現状ほぼ全て紹介コード任意)をどの区分に初期分類するか
- 既存クーポンの仮押さえ中注文がある状態でウォレット移管をどう安全に行うか
- NFT発行(nft_issues)と本書の`entitlement.granted`の関係(NFT保有=権利証明のままにするか、パスポート側の役割データと二重管理になるか)
- HUB・パスポート・ウォレットの実エンドポイント・認証方式(現状は未確定・論理APIのみ)

以上が現時点での差分報告。実装は個別指示書の到着後に着手する。
