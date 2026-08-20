# 戦国マーケット(sengoku-commerce) 商品コード読み取り専用棚卸し

作成日: 2026-08-20
対象リポジトリ: `stockbusiness/sengokumarket`(本レポートはこのリポジトリのみが対象。`sennokunnft`・Agency・Passport・OVEW Walletは別リポジトリのため、このセッションからは調査できていません)
ステータス: **読み取り専用調査のみ。コード変更・DB変更・一括変換は未実施。**

## 前提: このリポジトリには「商品コード」が2系統存在する

想定されていた単一の`product_code`ではなく、目的の異なる2つの自由入力フィールドが別々のテーブルに存在します。統合的な`source_system_key`カラムは、いずれのテーブルにも**存在しません**。

| フィールド | テーブル | 用途 | 送信先 |
|---|---|---|---|
| `Product.agencyProductCode` | `products` | 代理店ポータルへのアカウント発行連携(PR #4「購入後代理店システム連携」)用 | Agency(`POST /api/purchase-provisioning`のitems[].product_code) |
| `ProductIntegrationRule.productCode` | `product_integration_rules` | Wallet/entitlement系Outboxイベント用 | OVEW Wallet等(entitlementイベントのproduct_code) |
| `WalletClaimItem.productCode` | `wallet_claim_items` | 上記`ProductIntegrationRule.productCode`を決済確定時点でスナップショットしたコピー | (送信はしない。Outbox payload再構築用の内部保持) |

## 1. 現在product_codeを生成している場所

**自動生成ロジックは存在しません。両方とも管理者による自由入力(手入力)です。**

- `Product.agencyProductCode`
  - 入力元: 管理画面の商品新規登録・編集(`/admin/products/new`, `/admin/products/:id/edit`)
  - 実装: `server/src/routes/admin/products.ts`(95, 115, 137, 174, 199, 261行目)
  - バリデーション: `agencyAccessMode='agent_portal'`のとき非空文字列であることのみ強制(`isNonEmptyString`)。フォーマット(プレフィックス等)チェックなし。一意性チェックなし(`findFirst`/`findUnique`による重複検索コードは存在しない)。
- `ProductIntegrationRule.productCode`
  - 入力元: 管理画面の商品編集画面内「連携ルール(代理店システム連携)」セクション
  - 実装: `server/src/routes/admin/productIntegrationRules.ts`(167, 234行目)
  - バリデーション: 空文字列なら`null`に丸めるのみ。フォーマットチェック・一意性チェックともになし。

## 2. DB上のproduct_code列と一意制約

`server/prisma/schema.prisma`確認済み。

| テーブル | カラム | 型 | 制約 |
|---|---|---|---|
| `products` | `agency_product_code` | `String?`(nullable) | **制約なし**(単独INDEXすら無い) |
| `product_integration_rules` | `product_code` | `String?`(nullable) | **制約なし**。同テーブルの`@@unique`は`[productId, entitlementTargetSystemKey, entitlementType]`のみで、`product_code`は対象外 |
| `wallet_claim_items` | `product_code` | `String?`(nullable) | **制約なし**(スナップショット用途のため) |

`source_system_key`相当のカラムはいずれのテーブルにも存在しません。近い概念として`entitlementTargetSystemKey`(`product_integration_rules`)・`destinationSystemKey`(`wallet_claim_items`)がありますが、これらは「送信先システム」を表すもので、「発行元システム」ではありません。

## 3. 実在する既存コードの件数・形式別集計、重複・null件数(本番DB要実行)

このセッションは本番DBへの接続を持たないため、実データは取得できていません。以下のSQLを本番(Supabase)で読み取り専用実行し、結果を共有してください。

```sql
-- Product.agencyProductCode
select
  count(*) filter (where agency_product_code is null or agency_product_code = '') as null_or_empty,
  count(*) filter (where agency_product_code ~ '^SGCM_[A-Z0-9_]{1,64}$') as matches_new_format,
  count(*) filter (where agency_product_code is not null and agency_product_code <> '' and agency_product_code !~ '^SGCM_[A-Z0-9_]{1,64}$') as legacy_format,
  count(*) as total
from products;

-- 重複しているagency_product_code(nullは対象外)
select agency_product_code, count(*)
from products
where agency_product_code is not null and agency_product_code <> ''
group by agency_product_code
having count(*) > 1;

-- ProductIntegrationRule.productCode
select
  count(*) filter (where product_code is null or product_code = '') as null_or_empty,
  count(*) filter (where product_code ~ '^SGCM_[A-Z0-9_]{1,64}$') as matches_new_format,
  count(*) filter (where product_code is not null and product_code <> '' and product_code !~ '^SGCM_[A-Z0-9_]{1,64}$') as legacy_format,
  count(*) as total
from product_integration_rules;

select product_code, count(*)
from product_integration_rules
where product_code is not null and product_code <> ''
group by product_code
having count(*) > 1;
```

## 4. SNFT_/SGCM_を新規発行へ適用する変更箇所

このリポジトリ(sengoku-commerce)は`SGCM_`のみを扱う。変更が必要な箇所:

- `server/src/routes/admin/products.ts`: `agencyProductCode`の入力バリデーションに正規表現`^SGCM_[A-Z0-9_]{1,64}$`のフォーマットチェックを追加(新規作成時のみ強制するか、既存データがある編集時にどう扱うかは3節の集計結果を見てから判断)。
- `server/src/routes/admin/productIntegrationRules.ts`: 同様に`productCode`へ同じ正規表現チェックを追加。
- 両フィールドとも、新規発行時にDBの複合一意制約(5節)で最終的に担保する。

**「認証済みsource_system_keyとプレフィックスの対応検証」について**: このリポジトリには、他システムから`product_code`を含むリクエストを受信する既存のインバウンドAPIが**ありません**(唯一のインバウンド連携API`server/src/routes/integrations/walletClaims.ts`は、HMAC認証済みのwallet claim token単位のやり取りで、`product_code`も`source_system_key`も含みません)。したがって、この検証ロジックは現状「実装すべき既存の受信箇所」が存在せず、将来そうした受信APIが追加された際に組み込む前提の設計事項として記録するに留めます。

## 5. 既存コードを変更せず共存させる方法

ご提示の3案のうち、案2(`legacy_product_code`を保持したまま`canonical_product_code`を新設)を推奨します。理由:

- `agency_product_code`/`product_code`いずれも複数の下流(Agency連携payload、Wallet Outbox payload、`WalletClaimItem`スナップショット)から直接参照されており、列名を変えずに新列を追加する方が影響範囲を局所化できる。
- 3節の集計結果で「legacy_format」件数が0であれば、実質的に新形式強制のみで済み、canonical列の追加自体が不要になる可能性もある(件数次第で再判断)。

## 6. source_system_key + product_code複合化に必要なDB変更(案)

一意性は「このシステムが発行した`product_code`同士の重複がないこと」を保証すれば、現状の用途では十分と考えられます(3節で述べた通り、他システムの`product_code`を受信・照合する既存経路が無いため)。

- `products`テーブルに`source_system_key String @default("sengoku-commerce")`を追加(加算のみ、既存行に既定値を適用)。
- `product_integration_rules`テーブルに同様の`source_system_key`列を追加(既定値`sengoku-commerce`)。
- 一意制約案: `@@unique([sourceSystemKey, agencyProductCode])`(NULLは複数許容されるPostgresのUNIQUE制約の性質上、null値同士は制約に抵触しない。空文字列の扱いはアプリ側で引き続きnullへ丸める)。
- いずれも追加型のmigrationとし、既存行は削除・書き換えしない。

## 未確認・要提供(このリポジトリの範囲外)

- `sennokunnft`・Agency・Passport・OVEW Wallet側の同等の棚卸し結果(別リポジトリのため本セッションからは実施不可)。
- 3節のSQLの本番実行結果。
- 上記が揃うまで、`agencyProductCode`/`productCode`の一括変換・削除・書き換えは行いません。
