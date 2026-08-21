# 戦国マーケット(sengoku-commerce) 商品コード 本番DB集計結果

作成日: 2026-08-21
確認したリポジトリ: `stockbusiness/sengokumarket`
確認したブランチ/コミット: `main` @ `e681697aff08b0a4861fbf4ee00b4224d4ef9958`(PR #8マージ後)
確認したDB環境: **未実行(下記参照)**

## 結論: 本番DBへの接続手段がなく、集計SQLを実行できていません

このセッション(Claude Codeの実行環境)には、本番Supabase/Vercelへの接続情報・認証情報が一切設定されていません。確認した内容:

- 環境変数に`DATABASE_URL`/`SUPABASE_*`/`POSTGRES_*`/`VERCEL_*`系の値なし
- Vercel CLIの認証情報なし(`~/.vercel/`に設定ファイルなし)
- リポジトリ内に本番接続文字列を含むファイルなし(`.env`はローカル開発用ダミー値のみ、`.env.example`はプレースホルダーのみ)

このリポジトリのアーキテクチャ上、本番DBはVercel上のサーバープロセスからのみ到達可能で、ローカル開発環境からの直接接続経路は用意されていません(意図的な設計であり、不備ではありません)。

**したがって、集計結果(件数・null/空文字数・重複数・形式別集計など)はこのセッションからは取得できません。**

## 実行されるべきSQL(再掲、変更なし)

`SENGOKU_MARKET_PRODUCT_CODE_AUDIT.md`(PR #8、既にmainへ統合済み)に記載済みの以下のSQLを、本番DBへread-onlyでアクセスできる方(運用担当者・DBA等)に実行していただく必要があります。

```sql
-- Product.agencyProductCode
select
  count(*) filter (where agency_product_code is null or agency_product_code = '') as null_or_empty,
  count(*) filter (where agency_product_code ~ '^SGCM_[A-Z0-9_]{1,64}$') as matches_new_format,
  count(*) filter (where agency_product_code is not null and agency_product_code <> '' and agency_product_code !~ '^SGCM_[A-Z0-9_]{1,64}$') as legacy_format,
  count(*) as total
from products;

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

ご依頼にあった追加観点(最大文字数・大文字小文字混在・空白/ハイフン/記号の有無・削除済み/無効商品でのコード再利用状況)を確認するための追加SQL案を以下に用意しました。あわせて実行いただけると、より完全な集計になります。

```sql
-- 最大文字数・記号混在の確認(agency_product_code)
select
  max(length(agency_product_code)) as max_len,
  count(*) filter (where agency_product_code ~ '[a-z]') as has_lowercase,
  count(*) filter (where agency_product_code ~ '[A-Z]') as has_uppercase,
  count(*) filter (where agency_product_code ~ '\s') as has_whitespace,
  count(*) filter (where agency_product_code ~ '-') as has_hyphen,
  count(*) filter (where agency_product_code ~ '[^A-Za-z0-9_]') as has_other_symbol
from products
where agency_product_code is not null and agency_product_code <> '';

-- 同様にproduct_integration_rules.product_codeにも同じクエリを実行

-- 削除済み/無効商品でのコード再利用状況
-- statusカラム(products.status: draft|published|archived)別に集計し、
-- archived(削除相当)の商品と published/draft の商品でagency_product_codeが重複していないか確認
select
  p1.agency_product_code,
  array_agg(distinct p1.status) as statuses,
  count(*) as total_rows
from products p1
where p1.agency_product_code is not null and p1.agency_product_code <> ''
group by p1.agency_product_code
having count(distinct p1.status) > 1 or count(*) > 1;
```

## 商品コードを参照している関連テーブル(コードから確認済み・再掲)

`SENGOKU_MARKET_PRODUCT_CODE_AUDIT.md`(PR #8)に記載済みの通り:

- `products.agency_product_code` — 発生源(管理画面での自由入力)
- `product_integration_rules.product_code` — 発生源(別系統、管理画面での自由入力)
- `wallet_claim_items.product_code` — `product_integration_rules.product_code`を決済確定時点でスナップショットしたコピー(参照のみ、独立した入力経路ではない)

このリポジトリの`Product`モデルには論理削除(ソフトデリート)専用のカラムはなく、`status`列(`draft | published | archived`)で状態管理している。`archived`にした商品の行自体はDBに残り続けるため、「削除済み商品のコード再利用」を判定するには上記の最後のSQLのように`status`をグルーピングに含めて重複を見る必要がある。

## 未確認事項

- 上記すべての集計結果(本番DB read-only実行が必要)
- 実際に運用中の商品件数、`agencyAccessMode`の分布

## PR実装前に判断が必要な事項

- 上記集計の結果、`legacy_format`(SGCM_形式に一致しない既存コード)が0件であれば、複合UNIQUE制約の追加は既存データへの影響なしに実施可能と判断できる。1件以上あれば、`SENGOKU_MARKET_PRODUCT_CODE_AUDIT.md`5節で提案した「legacy列を残し新規canonical列を追加」方式が必要かどうかの判断が要る。
- 重複が0件であれば複合UNIQUE制約はそのまま追加可能。1件以上あれば、先に重複解消(どちらを正とするかの業務判断)が必要で、これはPR-SM1のコードレベルの変更だけでは解決できない。

## 依頼事項

- 本番Supabaseへread-onlyでアクセスできる方に、上記SQLの実行と結果の共有をお願いします。
- 個別の商品コード・商品名を共有する際は、機密情報・個人情報が含まれていないことをご確認のうえで、集計結果を優先して共有してください。
