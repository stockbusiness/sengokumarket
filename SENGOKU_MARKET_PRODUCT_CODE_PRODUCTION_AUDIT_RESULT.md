# 戦国マーケット(sengoku-commerce) 商品コード 本番DB集計結果

作成日: 2026-08-21(更新)
確認したリポジトリ: `stockbusiness/sengokumarket`
確認したブランチ/コミット: `main` @ `e681697aff08b0a4861fbf4ee00b4224d4ef9958`(PR #8マージ後)
確認したDB環境: 本番Supabase(運用担当者がSQL Editorから直接実行、結果をチャットで共有)

## 結論: 既存データはほぼ空。複合UNIQUE制約の追加に既存データ由来の障害なし

## 実行結果

### `Product.agencyProductCode`

```sql
select
  count(*) filter (where agency_product_code is null or agency_product_code = '') as null_or_empty,
  count(*) filter (where agency_product_code ~ '^SGCM_[A-Z0-9_]{1,64}$') as matches_new_format,
  count(*) filter (where agency_product_code is not null and agency_product_code <> '' and agency_product_code !~ '^SGCM_[A-Z0-9_]{1,64}$') as legacy_format,
  count(*) as total
from products;
```

| null_or_empty | matches_new_format | legacy_format | total |
|---:|---:|---:|---:|
| 6 | 0 | 0 | 6 |

→ 全6商品中、6件すべてが`agency_product_code`未設定(null/空)。**非null値が0件のため、重複はあり得ない**(重複確認SQLは論理的に不要と判断し未実行)。

### `ProductIntegrationRule.productCode`

```sql
select
  count(*) filter (where product_code is null or product_code = '') as null_or_empty,
  count(*) filter (where product_code ~ '^SGCM_[A-Z0-9_]{1,64}$') as matches_new_format,
  count(*) filter (where product_code is not null and product_code <> '' and product_code !~ '^SGCM_[A-Z0-9_]{1,64}$') as legacy_format,
  count(*) as total
from product_integration_rules;
```

| null_or_empty | matches_new_format | legacy_format | total |
|---:|---:|---:|---:|
| 0 | 0 | 0 | 0 |

→ `product_integration_rules`テーブル自体が**0行**(代理店システム連携ルールがまだ1件も設定されていない)。

### 未実行の補助クエリ(データが無いため不要と判断)

以下は事前に用意していたが、上記の通り両テーブルとも非null値が0件であるため、実質的に対象データが存在せず、実行しても意味のある結果が出ないため未実行とした:

- `agency_product_code`/`product_code`の重複確認(② ④)
- 最大文字数・大文字小文字混在・空白/ハイフン/記号混在の確認
- `archived`商品でのコード再利用状況確認

これらは今後、新規発行(SGCM_プレフィックス運用開始後)にデータが増えた段階で改めて意味を持つ。

## 商品コードを参照している関連テーブル(コードから確認済み・再掲)

- `products.agency_product_code` — 発生源(管理画面での自由入力)
- `product_integration_rules.product_code` — 発生源(別系統、管理画面での自由入力)
- `wallet_claim_items.product_code` — `product_integration_rules.product_code`を決済確定時点でスナップショットしたコピー(参照のみ)

## PR実装前に判断が必要な事項(結論)

- **`legacy_format`は両テーブルとも0件**。既存データのマイグレーション(legacy列の温存・変換表作成)は不要と判断できる。
- **重複は両テーブルとも論理的に0件**(非null値自体が0件のため)。複合UNIQUE制約(`source_system_key` + `agency_product_code`/`product_code`)をそのまま追加して問題ない。
- ロールバック方針: 追加するカラム・制約はいずれも加算型(新規nullable列+UNIQUE制約)であり、万一問題が起きてもマイグレーションのdown(制約・列の削除)で即座に切り戻せる。既存の6商品の`agency_product_code`はすべてnullのため、切り戻しによるデータ損失は発生しない。

## 未確認事項(このリポジトリ側で残っているもの)

- 実際に運用中の商品件数(6件)のうち、`agencyAccessMode`の分布(`none`/`customer_portal`/`agent_portal`)は今回のSQLでは取得していない。PR-SM1でバリデーション設計をする際、`agent_portal`の商品が実際にあるかどうかは参考情報として有用なため、必要なら追加確認する。

## sennokunnft側について

このファイルは戦国マーケット(sengoku-commerce)側の結果のみを扱う。`sennokunnft`側の棚卸しは別ファイル`SENNOKUNNFT_PRODUCT_CODE_AUDIT.md`を参照(現時点でリポジトリアクセス未取得のため未着手)。
