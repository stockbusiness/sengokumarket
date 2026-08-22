# NFT作品マーケット(sennokunnft) 商品コード棚卸し

作成日: 2026-08-22(更新)
確認したリポジトリ: `stockbusiness/sennokunnft`(公開リポジトリのため、GitHub Web経由で読み取り専用調査を実施。このセッションにはGitHub API/clone権限がないため、`github.com`/`raw.githubusercontent.com`の通常Webページ経由で確認)
確認したブランチ/コミット: `main` @ `eb7c1aa32efbb6e9d262d23b4dd1562b03848ae5`
確認したDB環境: **本番DBへの接続手段なし。以下はすべてコードレベル(スキーマ定義・API契約定義)の調査のみ。**

## 結論: `product_code`という概念自体がこのシステムに存在しない

戦国マーケット側とは前提が異なり、`sennokunnft`には`product_code`/`productCode`/`sku`/`asset_code`に相当するフィールドが**一切存在しません**。実在する識別子は以下の3種類です。

| 識別子 | モデル/場所 | 型・制約 | 用途 |
|---|---|---|---|
| `id` | `Artwork` | UUID、主キー | 内部一意識別子 |
| `slug` | `Artwork` | `String @unique`。小文字英数字とハイフンのみ、最大80文字(`^[a-z0-9]+(?:-[a-z0-9]+)*$`) | 公開URL用の人間可読な識別子 |
| `serialNo` | `Entitlement` | `Int`、`@@unique([artworkId, serialNo])` | 同一作品内でのシリアル番号(NFTの通し番号) |

## 1. product_code相当の列は存在するか

存在しない。`packages/database/prisma/schema.prisma`のフィールドを"code"/"sku"/"slug"等のキーワードで確認した結果、ヒットしたのは上記`Artwork.slug`のみ。`product_code`という語自体、コード検索(GitHubの検索UI)でも0件だった。

## 2. 実際に商品識別へ使われている列

- 内部処理: `Artwork.id`(UUID)
- 外部公開・URL: `Artwork.slug`
- NFTトークン単位: `Entitlement.serialNo`(`artworkId`との複合)

## 3. コードを生成しているファイル/関数

`packages/contracts/src/catalog.ts`の`createArtworkRequestSchema`で、`slug`はAPIリクエストの入力フィールドとして定義されている(zodバリデーションのみで、フォーマットチェック済み)。**自動採番ロジックかどうか(作成者/管理者が指定するのか、システムがタイトルから自動生成するのか)は、リクエストスキーマの定義からは断定できず、実際のAPIハンドラー実装(`apps/`配下)まで追う必要がある。今回はその深さまでは未確認。**

## 4. DB上の一意制約

- `Artwork.slug`: `@unique`(単独)
- `Entitlement`: `@@unique([artworkId, serialNo])`
- `source_system_key`相当のカラムはどのテーブルにも存在しない

## 5. null/空文字/重複件数、既存コードの形式別集計

本番DBへの接続手段がないため未確認。`slug`は`@unique`制約と非nullable(schema上`String`型でnullable修飾子`?`なし)のため、**そもそもnull/空文字/重複はDB制約上発生し得ない**設計になっている(戦国マーケット側の`agencyProductCode`/`productCode`が完全に無制約なのとは対照的)。

## 6. 購入履歴・注文・Entitlement・Outboxからの参照

`packages/contracts/src/events.ts`で定義される外部公開イベントを確認した結果:

| イベント | 含まれる識別子 |
|---|---|
| `order.paid` | `lines[].artworkId`(UUID) |
| `entitlement.issued` | `artworkId`(UUID)、`serialNo` |
| `entitlement.claimed` | `artworkId`(UUID)、`serialNo` |
| `mint.succeeded` / `mint.failed` | `entitlementId`のみ(artwork識別子なし。チェーン側の`chainRef`/`tokenRef`等を使用) |

いずれも**UUID(`artworkId`)を直接送信しており、`slug`も`product_code`も外部イベントには含まれていない**。

`packages/contracts/src/wallet-delivery.ts`(Wallet連携契約)では`entitlementId` + `targetSiteKey`のみを使用し、artwork識別子自体は含まれない。これは戦国マーケット側の指示書にあった「Wallet側はsource_system_key→entitlement_id→product_codeの順で識別」という設計方針と実質的に整合している(product_codeが無くても`entitlement_id`単体で識別が完結している)。

## 7. product_code変更時に影響する箇所

該当なし(存在しない概念のため)。ただし、もし今後`slug`のフォーマットを変更するとなれば、`packages/contracts/src/catalog.ts`の複数スキーマ(`artworkSummarySchema`, `artworkDetailSchema`, `publicListingSchema`, `createArtworkRequestSchema`, `adminArtworkSchema`)すべてに影響する。**`slug`は公開URLの一部として使われている可能性が高く(README概要から、作品ページの公開URLに使われる設計と推測される)、既存`slug`を書き換えるのは戦国マーケット側の`slug`(商品ページURL、CLAUDE.mdで「登録後は変更できません」と明記)と同様に、URLが変わってしまうリスクを伴う。**

## 8. `SNFT_`プレフィックス導入が可能か

技術的には可能だが、**導入先をどこにするかで難易度が大きく変わる**:

- **案A(推奨)**: `Artwork`に新規`sourceProductCode`相当のフィールド(nullable、既定値なし)を追加し、そこにのみ`SNFT_`形式を適用する。既存`slug`・URLには一切影響しない。戦国マーケット側で提案した「既存を変更せず新規発行分だけ強制」というアプローチと対称的で一貫性がある。
- **案B(非推奨)**: 既存`slug`自体を`SNFT_`形式に合わせる。`slug`は現在小文字限定(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)で、提案フォーマット`^SNFT_[A-Z0-9_]{1,64}$`(大文字)とは正規表現レベルで非互換。全既存作品のURLが変わる、または二重管理(大文字版canonical + 既存slugを維持)が必要になり、影響範囲が大きい。

## 9. `source_system_key` + `product_code`複合一意化の必要性

現状の外部イベントは`artworkId`(UUID)をそのまま使っており、UUIDの衝突確率は実質ゼロのため、**複合一意化の緊急性は低い**。ただし案Aで新規フィールドを追加する場合は、そのフィールドに対して`source_system_key`との複合UNIQUE制約を新設する設計が、戦国マーケット側と一貫性がありのぞましい。

## 未確認事項

- 本番DBの実データ(既存`Artwork`件数、`slug`の実際の値の傾向)
- `slug`が実際に自動生成なのか、作成者(クリエイター)による手入力なのか(`apps/`配下のAPIハンドラー実装は未調査)
- `slug`が実際に公開URLの一部として使われているかどうかの最終確認(README・スキーマからの推測であり、フロントエンド実装までは未確認)
- このリポジトリへの読み取りアクセスは公開Webページ経由のみで取得したものであり、非公開ブランチ・Issue・PR内の議論等は確認していない

## PR実装前に判断が必要な事項

- `SNFT_`プレフィックスの適用先を「新規フィールド追加(案A)」にするか「既存slugの変換(案B)」にするか。**このリポジトリの設計(sluggの`@unique`かつnon-nullable制約、URL用途の可能性)を踏まえると、戦国マーケット側と同様に案A(新規フィールド追加・既存は不変)を強く推奨する。**
- `sennokunnft`側の担当者による最終確認(本監査はコードの静的読解のみに基づき、実際の運用・データは未検証のため)。
