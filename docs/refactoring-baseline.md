# 保守性・拡張性改善 Phase 0: 安全網とベースライン

対象指示書: `MAINTAINABILITY_MODULARIZATION_INSTRUCTIONS_sengokumarket.md`。基本方針(全面リライト禁止・段階的モジュラーモノリス化)に沿い、構造変更前の現状を記録する。

## 基準コミット

`6a9a7af2373b203c8e70a6836a5e1a55c1cd934f`(ブランチ `claude/confirmation-needed-3wicju`)

## Phase 0 受入条件の確認結果

| 項目 | 結果 |
|---|---|
| 正式ブランチでGitHub Actionsが動作する | ✅ 確認済み(直近3回のpushすべて`conclusion: success`。run #1〜#3) |
| server tests全件成功 | ✅ 405件成功 |
| client build成功 | ✅ 成功 |
| Prisma migration(空DB・既存DBコピー) | ✅ 両方で成功確認済み(直近のマイグレーション`20260722050000_integration_outbox_updated_at`まで) |
| Characterization Test | ✅ 下記12項目すべて既存テストでカバー済み(新規追加不要と判断) |

## テスト件数

```
Test Files  60 passed (60)
     Tests  405 passed (405)
```

`npx tsc --noEmit`もクリーン。

## Characterization Test対象と既存カバー状況

指示書5.3が列挙する12ユースケースは、いずれも既存のテストスイートで既にカバーされている(新規のCharacterization Testを追加する代わりに、対応する既存テストファイルをここに記録し、今後の構造変更時の回帰検知に用いる)。

| ユースケース | 主なテストファイル |
|---|---|
| Stripe決済完了 | `server/src/routes/stripeWebhook.test.ts` |
| Stripe再送(冪等性) | `server/src/services/stripeEventInbox.test.ts`、`server/src/routes/stripeWebhook.test.ts` |
| 銀行振込入金確認 | `server/src/routes/admin/orders.test.ts` |
| 在庫仮引当 | `server/src/routes/checkout.test.ts` |
| 在庫確定 | `server/src/routes/stripeWebhook.test.ts` |
| 紹介者永久帰属 | `server/src/routes/checkout.test.ts`、`server/src/routes/mypage.test.ts` |
| `agent_required`(代理店限定販売) | `server/src/routes/checkout.test.ts`、`server/src/routes/admin/products.test.ts` |
| クーポン予約・確定・解放 | `server/src/services/coupon.test.ts` |
| 報酬作成 | `server/src/routes/admin/orders.test.ts`、`server/src/routes/agency/orders.test.ts` |
| 全額返金 | `server/src/routes/stripeWebhook.test.ts` |
| NFT発行キュー | `server/src/services/nftMintProcessing.test.ts`、`server/src/services/nftMint.test.ts` |
| entitlement Outbox | `server/src/services/integrationOutbox.test.ts`、`server/src/services/integrationOutboxDispatcher.test.ts` |

## 主要ファイル行数(指示書1章で指摘された巨大ファイル)

### バックエンド

| ファイル | 行数 |
|---|---:|
| `server/src/routes/admin/coupons.ts` | 356 |
| `server/src/services/checkout.ts` | 314 |
| `server/src/services/externalOrderImport.ts` | 311 |
| `server/src/routes/admin/products.ts` | 294 |
| `server/src/routes/integrations/agencies.ts` | 290 |
| `server/src/routes/admin/referrals.ts` | 247 |
| `server/src/routes/mypage.ts` | 244 |
| `server/src/services/coupon.ts` | 229 |
| `server/src/services/agencySso.ts` | 215 |
| `server/src/services/integrationOutboxDispatcher.ts` | 202 |

### フロントエンド

| ファイル | 行数 |
|---|---:|
| `client/src/lib/adminApi.ts` | 601 |
| `client/src/pages/admin/AdminProductEditPage.tsx` | 384 |
| `client/src/pages/CheckoutPage.tsx` | 359 |
| `client/src/App.tsx` | 308 |
| `client/src/pages/admin/AdminExternalOrdersPage.tsx` | 264 |
| `client/src/lib/api.ts` | 254 |
| `client/src/pages/admin/AdminProductCreatePage.tsx` | 253 |
| `client/src/pages/admin/AdminSettingsPage.tsx` | 241 |

指示書14.5のファイルサイズ目安(Route 150行・API Client 200行・React Page 250行)と比較すると、`checkout.ts`(Phase 4対象)・`integrations/agencies.ts`(Phase 3対象)・`adminApi.ts`(Phase 1対象)・`App.tsx`(Phase 1対象)が特に超過している。

## 現行API一覧(マウント構造)

`server/src/app.ts`のマウント構成:

```
POST /api/integrations/agencies          … requireAgencyApiKey(外部代理店システム専用)
GET  /api/internal/cron/*                … requireCronSecret(Vercel Cron専用)
/api/*                                   … requireSameOrigin(CSRF、GET/HEAD/OPTIONS除く)
  ├─ /api/products, /api/products/:idOrSlug
  ├─ /api/legal/*
  ├─ /api/cart/*
  ├─ /api/checkout/*
  ├─ /api/referrals/*
  ├─ /api/auth/*
  ├─ /api/mypage/*                       … requireAuth
  ├─ /api/admin/*                        … requireAdmin(+ staff/admin_viewer別途制限)
  └─ /api/agency/*                       … requireAgencyAuth
POST /api/stripe/webhook                 … express.raw()、署名検証(express.json()より前に登録)
```

ルーター定義箇所は99エンドポイント(`router.get/post/put/delete/patch`の総数)。個別一覧はPhase毎の対象ルーターのみ都度記録する方針とする(全件を本ファイルに列挙すると保守コストが高いため)。

## 改修禁止範囲

指示書3章の内容をそのまま踏襲する(決済/在庫/紹介・代理店/報酬/NFT・ウォレット/Outbox/ID再採番)。CLAUDE.mdの絶対禁止事項(referral_codesテーブル禁止、紹介コード事後変更禁止、紹介リンク編集・削除禁止、報酬カラム単独更新禁止等)と完全に一致しており、矛盾はない。

## 結論(Phase 0)

Phase 0の受入条件(機能変更なし・全テスト成功・client build成功・migration成功・基準文書作成)を満たした。Phase 1(フロント低リスク分割)へ進む。

---

# Phase 1: フロント低リスク分割(完了報告)

## 6.1 `adminApi.ts` 分割

601行の単一ファイルを、指示書6.1の分割方針どおり機能別に分割した。

```text
client/src/shared/api/adminClient.ts        … adminFetch/adminSend/adminSendForm(共通処理)
client/src/features/admin-dashboard/api.ts
client/src/features/admin-products/api.ts
client/src/features/admin-orders/api.ts
client/src/features/admin-nft-issues/api.ts
client/src/features/admin-wallet-missing/api.ts
client/src/features/admin-notices/api.ts
client/src/features/admin-agencies/api.ts
client/src/features/admin-referrals/api.ts
client/src/features/admin-settings/api.ts       … 銀行振込設定・接続テストも含む
client/src/features/admin-import-products/api.ts
client/src/features/admin-external-orders/api.ts
client/src/features/admin-legal/api.ts
client/src/features/admin-audit-logs/api.ts
client/src/features/admin-users/api.ts
client/src/features/admin-coupons/api.ts
```

`client/src/lib/adminApi.ts`(旧ファイル)は、指示書6.5の受入条件どおり**全19箇所の既存import元を変更せずに済む互換re-export(バレル)**にした(601行→18行)。新規コードは`features/admin-*/api.ts`から直接importすること。

## 6.2 DTO分離

`ProductPayload = Partial<Omit<AdminProduct, 'variants'>>`(読取型からの派生、本来送信すべきでないフィールドも型上送信可能だった問題)を廃止し、指示書の推奨どおり`CreateProductRequest`/`UpdateProductRequest`/`NewVariantRequest`/`UpdateVariantRequest`を独立した送信専用型として定義した(`features/admin-products/api.ts`)。同様にクーポンも`CreateCouponRequest`/`UpdateCouponRequest`を分離した。

## 6.3 `App.tsx` 分割

308行から40行に削減。分割先:

```text
client/src/app/NavBar.tsx                  … ナビゲーション
client/src/app/permissions.ts              … 権限判定(6.4参照)
client/src/app/routes/publicRoutes.tsx     … 一般公開ページ
client/src/app/routes/memberRoutes.tsx     … マイページ
client/src/app/routes/adminRoutes.tsx      … 管理画面(RequireAdmin/RequireFullAdmin含む)
client/src/app/routes/agencyRoutes.tsx     … 代理店ポータル
```

`<Routes>`はJSX子要素としてRoute要素を静的に検出するため、各ルートモジュールは「呼び出すとRoute要素のFragmentを返す関数」として実装し、`App.tsx`側で`{publicRoutes()}{memberRoutes()}{adminRoutes()}{agencyRoutes()}`のように直接呼び出す形にしている(コンポーネントとして`<PublicRoutes />`のようにレンダリングすると`<Routes>`がRoute子要素を検出できないため)。

## 6.4 権限関数統一

`client/src/app/permissions.ts`に`canAccessAdmin`/`canAccessFullAdmin`/`canAccessAgencyPortal`を新設し、以下すべてで同じ関数を使うよう統一した。

- `NavBar.tsx`(管理画面・代理店ポータルへのリンク表示条件)
- `RequireAdmin.tsx` / `RequireFullAdmin.tsx` / `RequireAgency.tsx`(Route Guard)
- `AdminLayout.tsx`(スタッフ向けバナー表示・ナビ項目の絞り込み)

**実際に発見・修正した不整合**: 指示書1.4が指摘したとおり、`RequireAdmin`は`staff`ロールの`/admin`入室を許可していたが、旧`NavBar`のリンク表示条件(`user.role === 'admin' || user.role === 'admin_viewer'`)には`staff`が含まれておらず、**staffアカウントには管理画面へのリンク自体が表示されない**(URLを直接知っていないと入れない)という実際のバグがあった。今回の統一でこれを修正した。

## 動作確認

- `npx tsc --noEmit`・`npx vitest run`(405件)・`npm run build --workspace=client`いずれも成功。
- ローカルでdev server(server:4000 / client:5173)を起動し、Playwrightで実際にブラウザ操作して確認:
  - 匿名ユーザーのトップページ・ナビ表示
  - **staffアカウントでログイン → ナビに「管理画面」リンクが表示されることを確認(修正の直接確認)**
  - staffで`/admin`(日次業務系)に入室できること
  - staffで`/admin/referral-links`(RequireFullAdmin対象)にアクセスすると`/admin`へ差し戻されること
  - agencyアカウントでログイン → ナビに「代理店ポータル」リンクが表示され、`/agency`に入室できること
  - 全ケースでコンソールに実質的なエラーが出ていないこと(匿名時の`/api/auth/me` 401は仕様どおりの想定内)

## ファイル行数の変化

| ファイル | Phase 0時点 | Phase 1後 |
|---|---:|---:|
| `client/src/lib/adminApi.ts` | 601 | 18(re-exportのみ) |
| `client/src/App.tsx` | 308 | 40 |

新規ファイルはいずれも200行以内(最大は`adminRoutes.tsx`の115行)で、指示書14.5の目安(API Client 200行・Route 150行)に収まっている。

## 結論(Phase 1)

指示書6.5の受入条件(画面・API動作に変更なし・staffへの管理画面リンク表示・server側認可は変更しない・adminApi.tsは互換re-exportのみ・client build成功・主要管理画面のsmoke test成功)をすべて満たした。Phase 2(共有Contracts追加)以降は、着手のご指示があり次第対応する。

---

# Phase 2: 共有Contracts追加(完了報告)

## 7章方針に沿った実装

指示書7.2「初期実装: 依存ライブラリを増やさず、まずTypeScriptの型と`as const`定数だけを共有する」を採用。ビルドステップなしの新規ワークスペース`packages/contracts`を追加した(`main`/`types`とも`src/index.ts`を直接指す。dist生成なし)。

```text
packages/contracts/src/auth.ts         … USER_ROLES / ADMIN_ROLES / FULL_ADMIN_ROLES
packages/contracts/src/product.ts      … ITEM_TYPES / PRODUCT_STATUSES / SALES_MODELS
packages/contracts/src/order.ts        … ORDER_STATUSES / COMMISSION_STATUSES / COUPON_USAGE_STATUSES
packages/contracts/src/payment.ts      … PAYMENT_STATUSES / STRIPE_EVENT_STATUSES
packages/contracts/src/nft.ts          … NFT_ISSUE_STATUSES
packages/contracts/src/integration.ts  … INTEGRATION_OUTBOX_STATUSES
packages/contracts/src/index.ts        … barrel re-export
```

Vercelの実デプロイ経路(`api/index.ts`が`server/src/app.ts`をTypeScript原文のままesbuildで束ねる方式であり、`server`独自の`tsc`ビルド成果物`dist/`はデプロイに使われていない)を確認済みのため、ビルドステップを持たないパッケージでも本番・開発いずれの経路でも問題なく解決できると判断した。dev(`tsx`)・vitest・client(Vite)・server(`tsc --noEmit`)の4経路すべてで動作確認済み。

## 重複解消した箇所

サーバー・クライアント間で内容が完全一致していた状態定数・ロール定数を、以下の11箇所で`@sengoku/contracts`からの単一importに統一した。

| 定数 | 統一した箇所 |
|---|---|
| `ITEM_TYPES` / `PRODUCT_STATUSES` / `SALES_MODELS` | `server/src/routes/admin/products.ts`、`server/src/services/csvImport.ts`、`client/src/lib/productPricing.ts`(既存の再export形式で維持) |
| `ORDER_STATUSES` | `server/src/routes/admin/orders.ts`、`client/src/pages/admin/AdminOrdersPage.tsx` |
| `COMMISSION_STATUSES` | `server/src/routes/admin/referrals.ts`、`client/src/pages/admin/AdminReferralsPage.tsx` |
| `NFT_ISSUE_STATUSES` | `server/src/routes/admin/nftIssues.ts`、`client/src/pages/admin/AdminNftIssuesPage.tsx` |
| `ADMIN_ROLES` / `FULL_ADMIN_ROLES` | `server/src/routes/admin/adminUsers.ts`、`server/src/middleware/auth.ts`、`client/src/app/permissions.ts`、`client/src/features/admin-users/api.ts`(`AdminUser.role`の型) |
| `STRIPE_EVENT_STATUSES` | `server/src/routes/admin/stripeEvents.ts` |
| `INTEGRATION_OUTBOX_STATUSES` | `server/src/routes/admin/integrationOutbox.ts` |

`COUPON_USAGE_STATUSES`・`PAYMENT_STATUSES`は契約定義のみ追加し、消費側(`server/src/services/coupon.ts`、決済系サービス)は今回あえて変更していない(下記「対象外」を参照)。

## ドリフト発見と対応

型を突き合わせる過程で以下の食い違いを発見し、指示書7章の想定どおり「型を合わせる前に実際の仕様を確認」した:

- `OrderStatus`(`orders.order_status`、4値: pending/paid/cancelled/refunded)と`PaymentStatus`(`orders.payment_status`、5値: pending/paid/failed/refunded/expired)は名称が紛らわしいが別概念であり、統合しなかった(それぞれ`order.ts`/`payment.ts`に分離定義し、コメントで明記)。
- `server/src/routes/integrations/agencies.ts:245`のログイン済みロール判定用の3値リストは、`ADMIN_ROLES`と値が近いが業務的に異なる概念のため、あえて統一対象から除外した(コメントで理由を明記)。
- `readonly`タプルを`Array.prototype.includes`に渡す際、値側が`any`ではなく明示的に`string`型の場合は`(X as readonly string[]).includes(...)`のキャストが必要になる箇所が6箇所あり(`middleware/auth.ts`、`admin/integrationOutbox.ts`、`admin/referrals.ts`、`admin/stripeEvents.ts`、`services/csvImport.ts`×2)、いずれも動作を変えずに型エラーのみ解消した。あわせて`StatusSelect`コンポーネントの`options`propを`string[]`から`readonly string[]`に緩和した(`AdminOrdersPage`等3箇所で`readonly`配列をそのまま渡せるようにするため)。
- `server/prisma/schema.prisma`の`User.role`列コメントが`staff`ロールの記載漏れだったため、ドキュメントのみ修正した(挙動変更なし)。

## 対象外(意図的に見送った箇所)

指示書の「低リスク」の範囲を超えるため、Phase 2では以下のコア決済・在庫・報酬ロジックファイルには手を入れていない(inline文字列比較のまま維持):

- `server/src/services/checkout.ts`、`stripeWebhookHandlers.ts`、`bankTransfer.ts`(Phase 4: Checkoutモジュール化の対象)
- `server/src/services/coupon.ts`(`CouponUsageStatus`のinline比較はそのまま)
- `server/src/services/stripeEventInbox.ts`、`integrationOutboxDispatcher.ts`(冪等性・Outboxのコア状態機械)

## 動作確認

- `npx tsc --noEmit`(server)・`npx tsc -b --noEmit`(client)いずれもクリーン。
- `npx vitest run`: 405件全成功(Phase 0/1と同数、リグレッションなし)。
- `npm run build --workspace=client`成功。

## 結論(Phase 2)

指示書7章の受入条件(ビルドステップなしでの型・定数共有、既存の重複定義を実際の値と突き合わせて統一、コアの決済・在庫・報酬ロジックは変更しない)を満たした。Phase 3(代理店連携モジュール化)以降は、着手のご指示があり次第対応する。

---

# Phase 3: 代理店連携モジュール化(完了報告)

## 8.2 分割構成

`server/src/routes/integrations/agencies.ts`(291行、HTTP・入力検証・親解決・循環判定・代理店upsert・pending parent再紐付け・ログインユーザー作成/昇格・メール送信・レスポンス生成が単一ファイルに混在)を、指示書8.2の構成どおり分割した。

```text
server/src/modules/agencies/
├─ http/
│  ├─ agencyIntegration.routes.ts       … 入力取得・UseCase呼び出し・Presenter・HTTPレスポンスのみ(71行)
│  ├─ agencyIntegration.schema.ts       … 形式的な入力検証(81行)
│  └─ agencyIntegration.presenter.ts    … レスポンス整形(23行)
├─ application/
│  ├─ upsertAgency.usecase.ts           … 親解決・作成/更新・再紐付け・ログイン作成の一連の流れ(112行)
│  ├─ provisionAgencyAccount.usecase.ts … ログインユーザー作成/昇格の判断(56行)
│  └─ reconcilePendingParents.usecase.ts(11行)
├─ domain/
│  ├─ agencyHierarchy.policy.ts         … 循環判定(Prisma非依存、単体テスト追加)
│  ├─ agencyEvent.policy.ts             … 対応イベント種別判定
│  └─ agency.types.ts                   … 共有型・ドメインエラー
└─ infrastructure/
   ├─ prismaAgency.repository.ts        … Prismaアクセスを集約、Domain型を返す(143行)
   └─ agencyNotification.adapter.ts     … メール送信・トークン発行(18行)
```

旧`server/src/routes/integrations/agencies.ts`は削除し、`app.ts`のimportを新モジュールへ直接差し替えた(参照元がapp.tsのみだったため、Phase1のadminApi.tsのような互換re-exportバレルは不要と判断)。テストファイルも`modules/agencies/http/agencyIntegration.routes.test.ts`へ移動。

## 8.4 トランザクション境界の是正(実際に発見・修正したバグ)

指示書1.2が指摘する「DB更新とメール送信が同一Route内で逐次実行されるため、部分成功が発生しうる」を調査した結果、実際に以下の部分成功バグが存在することを確認した。

- 旧実装: 代理店のcreate/update → pending parent再紐付け(別クエリ) → ログインユーザー作成/昇格、の順に**逐次・非トランザクション**で実行しており、`login_email`が既に他の管理者/代理店アカウントに使われていた場合の409エラーは、**代理店自体が既にDBへcommitされた後**に返っていた(代理店だけ作成され、ログインは作成されない不整合な状態が残る)。
- 修正: 代理店のcreate/update・pending parent再紐付け・ログインユーザー作成/昇格を`upsertAgency.usecase.ts`内の単一`prisma.$transaction`にまとめた。`provisionAgencyAccount.usecase.ts`がlogin_email競合を検知すると`AgencyLoginConflictError`を投げてトランザクション全体をロールバックするため、409になるケースで代理店が作成されることはなくなった。
- メール送信(`sendAgencyAccountSetupEmail`/`sendAgencyAccessGrantedEmail`)とパスワード再設定トークン発行(`createPasswordResetToken`、既存の共有サービスで独自にトランザクションを持つため今回の主トランザクションには含めない)は、指示書8.4のとおりトランザクションのcommit後に実行する(`agencyNotification.adapter.ts`)。送信失敗によりDB更新が巻き戻ることはない。

新規テスト`login_emailが衝突した場合、代理店自体も作成されない(部分成功を防ぐ・Phase3で修正)`でこの修正を確認済み。

## ドリフト・注意点

- `wouldCreateCycle`(循環判定)はPrisma・Expressに依存しない純粋なPolicyとして抽出し、親ID解決を呼び出し側から関数として注入する形にした。DBなしのDomain Unit Testを4件追加(`agencyHierarchy.policy.test.ts`)。
- 「自分自身を親に指定」バリデーションは、既存代理店の有無・DBの親解決と密接に関わるため、HTTP層の`schema.ts`ではなくapplication層の`upsertAgency.usecase.ts`内(`resolveParentAssignment`)に置いた(純粋な入力形式検証と、DBアクセスを伴うドメイン解決を分離)。
- `createPasswordResetToken`は代理店以外(管理者アカウント・一般パスワード再設定)でも使われる共有サービスで、既存の呼び出し規約(グローバル`prisma`を使い、呼び出し元のトランザクションには参加しない)を今回変更していない。この関数自体をトランザクション対応させることはPhase3の対象(agencies.tsの分割)を超えるため見送った。

## 動作確認

- `npx tsc --noEmit`(server)クリーン。
- `npx vitest run`: 410件全成功(既存405件 + 部分成功防止テスト1件 + Domain Unit Test 4件)。既存20件の代理店連携APIテストはすべてそのまま(挙動変更なし)で成功。
- `npx prisma migrate deploy`: 変更なし(今回はスキーマ変更なし)。
- `npx tsc -b --noEmit`(client)・`npm run build --workspace=client`成功(本Phaseはサーバー専用のためclientへの影響なし)。

## ファイル行数の変化

| ファイル | Phase 0時点 | Phase 3後 |
|---|---:|---:|
| `server/src/routes/integrations/agencies.ts` | 290〜291 | 削除(`modules/agencies/`へ分割、最大ファイルは`prismaAgency.repository.ts`の143行) |

## 対象外(意図的に見送った箇所)

指示書8.5「Notification Outbox」・8.6「未対応イベントの`integration_inbox_events`への保存」は、いずれも指示書内で「新規テーブル候補」と位置づけられており必須ではないこと、また通知の仕組み自体の本格的なモジュール化はPhase 7(通知モジュール化)の対象であることから、今回は見送った。対応外イベントの扱い(200で受理・処理はスキップ)自体は既存仕様のまま維持しており、動作に変更はない。新規テーブル・マイグレーションを伴わない範囲(Route分割・トランザクション境界の是正)にPhase 3のスコープを絞った。

## 結論(Phase 3)

指示書8.7の受入条件のうち、既存API request/response互換・部分成功なし(今回新たに修正)・メール失敗でDB更新を巻き戻さない・同一イベント再送で重複作成しない・循環代理店を拒否・pending parentが後続登録で解決する、を満たした。対応外イベントの監査可能な永続化(8.6)は上記のとおり今回のスコープ外とした。Phase 4(Checkoutモジュール化)以降は、着手のご指示があり次第対応する。
