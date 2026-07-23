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

---

# Phase 4: Checkoutモジュール化(完了報告)

## 9.2 分割構成

`server/src/services/checkout.ts`(315行、入力検証・在庫行ロック・在庫仮引当・購入者解決・紹介帰属・sales_model判定・注文番号生成・金額計算・説明担当者照合・注文/明細作成・クーポン予約が単一ファイルに集中)を、指示書9.2の構成どおり分割した。

```text
server/src/modules/checkout/
├─ application/
│  ├─ createPendingOrder.usecase.ts       … 全体のオーケストレーション(138行)
│  └─ cancelOrderReservation.usecase.ts   … Stripeセッション作成失敗時の補償処理(21行)
├─ domain/
│  ├─ checkoutInput.ts                    … リクエストボディの形式検証(48行)
│  ├─ stockAvailability.policy.ts         … 在庫可否判定(Prisma非依存、18行)
│  ├─ salesModel.policy.ts                … agent_required判定(Prisma非依存、25行)
│  ├─ orderPricing.service.ts             … 割引前合計金額の算出(10行)
│  └─ checkout.types.ts                   … 共有型
└─ infrastructure/
   ├─ checkoutItem.repository.ts          … FOR UPDATE行ロック・在庫仮引当/解放(77行)
   ├─ purchaserAccount.repository.ts      … 購入者解決・ゲスト作成・紹介帰属の永続化(55行)
   ├─ orderWriter.repository.ts           … 注文・明細の作成、クーポン価格の反映(115行)
   └─ couponReservation.adapter.ts        … 既存services/coupon.tsへの薄いAdapter(24行)
```

紹介帰属の解決自体(`resolveReferral`/`resolveReferralByAttribution`)・クーポンの検証/予約ロジック自体(`services/coupon.ts`)は指示書9.3のとおり**変更せず**、Checkout側のオーケストレーション(いつ・どの順番で呼ぶか)だけを`createPendingOrder.usecase.ts`に集約した。

## 9.4 トランザクション境界

指示書9.4「`createPendingOrder.usecase.ts`の外側で1つのPrismaトランザクションを維持する」を踏襲し、`prisma.$transaction`は`createPendingOrder.usecase.ts`にのみ存在する。`checkoutItem.repository.ts`・`purchaserAccount.repository.ts`・`orderWriter.repository.ts`・`couponReservation.adapter.ts`はいずれも独自にトランザクションを開始せず、呼び出し元から渡された`tx`のみを使う。

## 互換性の維持

`server/src/services/checkout.ts`は削除せず、新モジュールへの**互換re-exportバレル**として残した(指示書18.1「新モジュールを互換Facade経由で呼び出す」)。

理由: `services/checkout.ts`からのimportはPhase3の代理店連携(参照元がapp.tsのみ)と異なり、本体コード(`routes/checkout.ts`)に加えテストファイル5件(`checkout.test.ts`・`internalCron.test.ts`・`stripeWebhook.test.ts`・`stripeWebhook.coupon.test.ts`・`stripeWebhook.mail.test.ts`)からも直接`createPendingOrder`が使われており、Phase1の`adminApi.ts`と同様、既存の呼び出し元を一切変更せずに済む方式を採用した。

## 動作確認

- `npx tsc --noEmit`(server)クリーン。
- `npx vitest run`: 418件全成功(既存410件 + Domain Unit Test 8件)。`checkout.test.ts`(在庫仮引当・オーバーセル防止・agent_required・紹介永久帰属・階層記録・説明責任者・銀行振込)・`stripeWebhook*.test.ts`・`internalCron.test.ts`はすべて**無変更のまま**成功しており、既存API request/response・在庫ロック・仮引当・紹介永久帰属・agent_required・ゲスト購入・クーポン自動適用・注文スナップショットのいずれも既存挙動を維持していることを確認した。
- Domain Unit Test(指示書15.1「stock availability」「sales model」)を新規追加: `stockAvailability.policy.test.ts`(在庫充足/不足/未公開/存在しない商品)・`salesModel.policy.test.ts`(agent_required充足/未充足/direct_allowed)、いずれもDBなしで実行。
- `npx prisma migrate deploy`: 変更なし(今回はスキーマ変更なし)。
- `npx tsc -b --noEmit`(client)・`npm run build --workspace=client`成功(本Phaseはサーバー専用のためclientへの影響なし)。

## ファイル行数の変化

| ファイル | Phase 0時点 | Phase 4後 |
|---|---:|---:|
| `server/src/services/checkout.ts` | 314〜315 | 5行(互換re-exportバレルのみ)。実装は`modules/checkout/`へ分割、最大ファイルは`createPendingOrder.usecase.ts`の138行 |

## 結論(Phase 4)

指示書9.5の受入条件(既存API request/response互換・在庫ロック維持・仮引当維持・紹介永久帰属維持・agent_required維持・ゲスト購入維持・クーポン自動適用維持・手入力クーポン失敗時の挙動維持・注文スナップショット維持・全Checkoutテスト成功)をすべて満たした。Phase 5(Config・Adapter統一)以降は、着手のご指示があり次第対応する。

---

# Phase 5: Config・外部Adapter統一(完了報告)

## 事前調査で判明した設計上の前提

このリポジトリはStripe/Resend/外部代理店システム等の**秘密情報(APIキー・HMAC鍵等)をすでに`.env`ではなくDB(`settingsテーブル`、`services/settings.ts`、AES-256-GCM暗号化)で管理する設計**になっている(CLAUDE.md「環境変数」章・`.env.example`に明記済み)。したがって指示書10.1の「Config」が主に指すのは、`.env`側に残る非秘密の起動時設定(`APP_URL`・`JWT_SECRET`・`TERMS_VERSION`・`SETTINGS_ENCRYPTION_KEY`・`DATABASE_URL`等)の集約・起動時検証であると解釈した。

## 10.1 Config

```text
server/src/shared/config/
├─ env.ts               … assertRequiredEnv()。起動必須5値(DATABASE_URL/JWT_SECRET/APP_URL/
│                          TERMS_VERSION/SETTINGS_ENCRYPTION_KEY)を検証し、不足時はエラーメッセージに
│                          不足変数名を列挙する
├─ appConfig.ts          … appUrl/termsVersion/port/isProduction/jwtSecret/settingsEncryptionKeyHex/
│                          cronSecretのgetter
└─ integrationConfig.ts  … nftMintProvider/nftChain/crossmintCollectionId/blobReadWriteTokenのgetter
```

`assertRequiredEnv()`は`server/src/index.ts`(実際のプロセス起動点)からのみ呼び出す。`createApp()`自体には組み込まない(`createApp()`は63件のテストファイルから直接呼ばれており、テスト環境固有の値でも動作できる必要があるため)。

`process.env`の直接参照は指示書10.3が「段階的に削減」と明記するとおり、今回は**必須5値の主要な参照箇所**を`appConfig`経由に置き換えた: `services/jwt.ts`(JWT_SECRET)・`lib/settingsCrypto.ts`(SETTINGS_ENCRYPTION_KEY)・`middleware/csrf.ts`・`app.ts`(APP_URL)・`modules/checkout/application/createPendingOrder.usecase.ts`・`services/externalOrderImport.ts`(TERMS_VERSION)。`SENNOKUNI_INTEGRATION_ENABLED`は既存の`services/sennokuniIntegrationConfig.ts`が既に専用の設定モジュール(DB認証情報取得と一体)として機能しているため、`integrationConfig`には重複させなかった。残りの`process.env`直接参照(`CRON_SECRET`・`NODE_ENV`・`PORT`・`BLOB_READ_WRITE_TOKEN`の一部呼び出し箇所等)は今回のスコープ外とし、次項で明記する。

## 10.2 外部Adapter

```text
server/src/shared/http/
└─ httpClient.ts  … fetchWithTimeout()。AbortController によるtimeout(既定10秒)・
                     correlation ID発行・構造化ログ(JSON1行、APIキー等の秘密ヘッダはマスク)・
                     ネットワーク断/タイムアウトのIntegrationTransportErrorへの正規化
```

`fetchWithTimeout()`は**レスポンス自体(res.ok・本文)をそのまま呼び出し元へ返す**設計にした。HTTPステータスに基づく成否判定・エラーメッセージの組み立ては各Adapterの既存ロジックのままで、通信レベルの失敗(ネットワーク断・タイムアウト)だけを正規化する。この設計により、生の`fetch()`を`fetchWithTimeout()`へ置き換えるだけで済み、各Adapter固有の業務ロジックを一切変更せずに retrofit できた。

適用したファイル(いずれもタイムアウトなしの生`fetch()`を使っていた):

- `services/externalAgencySystem.ts`(外部代理店システムの階層取得・代理店同期API。フラグなしの実運用コード)
- `services/agencySso.ts`(代理店SSOのJWKS取得)
- `services/nftMintProviders/crossmint.ts`(Crossmint Mint API。合わせて`CROSSMINT_COLLECTION_ID`の読み取りも`integrationConfig`経由に統一)

## 対象外(意図的に見送った箇所)

- **Stripe(`lib/stripeClient.ts`)・Resend(`services/mailTemplates.ts`)**: 公式SDK経由の呼び出しであり、SDK自体が既にtimeout/retryを内包する。生fetchの薄いAdapterを重ねる利益がなく、指示書14.4の「Repository/Adapter: 外部APIを隠蔽する」はSDKラッパーの形で既に満たされている。
- **`services/externalCommonUserClient.ts`・`services/externalReferralClient.ts`・`services/integrationOutboxDispatcher.ts`・`services/oveWalletRewardClient.ts`**: `SENNOKUNI_INTEGRATION_ENABLED`(既定OFF)配下のdormant実装で、実HTTP送信は統合責任者の正式承認まで発生しない。前セッションで既にテストが整備済みであり、今回のPhaseでリライトして回帰リスクを取る理由がない(指示書20章「外部システムとの実接続は少なくともPhase 0/2/3/5の完了後」を踏まえても、実接続を有効化する段階で改めて着手するのが安全)。
- **`server/src/integrations/{agency-system,common-user-hub,ove-wallet,crossmint}/`への物理的なディレクトリ移動**: 指示書4.1が示す目標構成だが、「すべてを一度に移動しない」という同章の方針に従い、今回はコード内容(timeout・ログ・エラー正規化)の統一を優先し、ファイルの物理移動は見送った(移動自体はimport元の変更を伴うだけで安全性向上には直結しないため)。

## 動作確認

- `npx tsc --noEmit`(server)クリーン。
- `npx vitest run`: 425件全成功(既存418件 + `httpClient.test.ts`4件 + `env.test.ts`3件)。`externalAgencySystem.test.ts`・`crossmint.test.ts`・`agencySso.test.ts`はいずれも**無変更のまま**成功しており、Adapter retrofitが既存の`vi.stubGlobal('fetch', ...)`によるモックとレスポンス解釈ロジックに影響しないことを確認した。
- `npx tsx src/index.ts`を実際に起動し、`assertRequiredEnv()`によるエラーなく`server listening on port 4000`まで到達することを確認(現在の`.env`が必須5値をすべて満たしているため)。
- `npx prisma migrate deploy`: 変更なし(今回はスキーマ変更なし)。
- `npx tsc -b --noEmit`(client)・`npm run build --workspace=client`成功。

## 結論(Phase 5)

指示書10.3の受入条件のうち、外部fetchへのtimeout追加・エラー形式の統一(通信レベル)・秘密情報のログ非出力・Adapter単体テスト追加を満たした。`process.env`の直接参照削減は「段階的」の方針どおり必須5値の主要箇所に絞って対応し、残りの箇所・dormant integrations・Stripe/Resend SDKラッパー・`integrations/`ディレクトリへの物理移動は上記のとおり明示的にスコープ外とした。Phase 6(状態遷移Policy)以降は、着手のご指示があり次第対応する。

---

# Phase 6: 状態遷移Policy(完了報告)

## 事前調査

指示書11.1が挙げる7種類のステータス(OrderStatus/PaymentStatus/CommissionStatus/NftIssueStatus/StripeEventStatus/IntegrationOutboxStatus/CouponUsageStatus)について、実際にどの遷移が使われているかをコード(Stripe Webhook・銀行振込確認・admin route・coupon.ts・stripeEventInbox.ts・integrationOutboxDispatcher.ts)と既存テストを1件ずつ確認したうえで遷移表を定義した(指示書1.7が例示する`paid→pending`・`issued→wallet_required`のような不正遷移を推測ではなく実挙動から拒否対象と確定させるため)。

この調査の過程で、`admin/orders.test.ts`が実際に**`paid→cancelled`(Stripe返金を伴わない「返品対応済み」の手動キャンセル)をAPI経由でテスト済み**であることが判明し、指示書11.2の例(`paid: ['refunded']`のみ)をそのまま採用すると既存の正当な操作を壊すことが分かった。遷移表は指示書の例を出発点としつつ、実際にテストされている操作をすべて許可するように調整した。

## ユーザー判断が必要だった箇所

報酬ステータス(pending→paidを直接許可するか、approvedを必ず経由させるか)は、仕様書5.8が示す運用フロー(CSV出力でpending→approved一括変更→支払後にapproved→paidへ手動変更)を裏付けとしつつも、明示的な禁止は書かれておらず、実務上の判断が必要だったためユーザーに確認した。**「approvedを必ず経由させる」を選択**いただき、pending→paidの直接変更は拒否対象とした。

## 11.1〜11.2 実装

```text
server/src/shared/errors/domainError.ts        … DomainError(code, message)。Policy共通のエラー型
server/src/shared/statusPolicy/
├─ statusTransition.ts             … 7Policy共通の判定ロジック(同一状態への再設定は常に許可)
├─ orderStatus.policy.ts           … pending→[paid,cancelled] / paid→[refunded,cancelled] / 他終端
├─ commissionStatus.policy.ts      … pending→[approved,cancelled] / approved→[paid,cancelled,pending] / paid,cancelledは終端
├─ nftIssueStatus.policy.ts        … wallet_required→ready_to_issue→processing→issued の基本線 +
│                                     管理画面からの直接issued記録を許可、issuedは終端
├─ paymentStatus.policy.ts         … 参照用(未組み込み。下記参照)
├─ stripeEventStatus.policy.ts     … 参照用(未組み込み)
├─ integrationOutboxStatus.policy.ts … 参照用(未組み込み)
└─ couponUsageStatus.policy.ts     … 参照用(未組み込み)
```

## 適用箇所

不正遷移を実際に拒否する形で組み込んだのは、従来「ステータス値そのものの妥当性(`STATUSES.includes()`)」しか検証しておらず、遷移そのものは無制限だった3つの管理画面API(いずれも指示書11.4「管理画面からも不正遷移不可」の対象)のみ:

- `admin/orders.ts` PUT `/orders/:id`(`assertOrderTransition`)
- `admin/referrals.ts` PUT `/referrals/commissions/:id`(`assertCommissionTransition`)
- `admin/nftIssues.ts` PUT `/nft-issues/:id`(`assertNftIssueTransition`)

不正遷移は409 `INVALID_*_STATUS_TRANSITION`で拒否する。

## 意図的に組み込まなかった箇所(指示書11.4「Webhook処理に影響しない」を優先)

- **PaymentStatus / StripeEventStatus**: Stripe Webhook・stripeEventInbox.tsの冪等性クレーム処理(条件付きUPDATE)は変更禁止範囲の核心であり、既に独自の防御(status='processing'等をWHERE句に含むアトミックなclaim)を持つ。二重に遷移チェックを追加するとかえって複雑化・リグレッションリスクが増すため、Policyは定義のみで組み込まない。
- **CouponUsageStatus**: `services/coupon.ts`は在庫のreserved_stockと同じ考え方で行ロック+検証を行う変更禁止範囲のため、同様に組み込まない。
- **IntegrationOutboxStatus**: 現時点で管理画面からの手動ステータス変更エンドポイント自体が存在しない(読み取り専用)ため、適用先がない。
- `admin/stripeEvents.ts`の再試行エンドポイントは、既に`existing.status !== 'failed_retryable' && existing.status !== 'failed_terminal'`という専用の事前条件を持っており、これは実質的に指示書11.2と同じ役割を果たしている。二重にPolicyを被せることはせず現状維持とした。

## 11.3 DB制約

既存データを確認したところ、ローカル開発DBでは大半のテーブルが空(テストのafterAllで都度削除されるため)であり、**本番Supabaseのデータをこの環境から検証することはできない**。CHECK制約の追加は新規マイグレーション(本番はVercelが自動適用しないため、これまでと同様Supabase SQL Editorでの手動適用が必要)を伴う操作であり、本番データを未検証のまま追加すると意図せず失敗する可能性があるため、今回は見送った。本番データの値点検後に着手することを推奨する(次のご指示があれば対応する)。

## 動作確認

- `npx tsc --noEmit`(server)クリーン。
- `npx vitest run`: 462件全成功(既存425件 + 7つのPolicyのDomain Unit Test 35件 + 3つの管理画面APIでの不正遷移拒否テスト)。既存の`admin/orders.test.ts`(`paid→cancelled`を含む)・`admin/referrals.test.ts`(`pending→approved`)・`admin/nftIssues.test.ts`(`ready_to_issue→issued`)はいずれも**無変更のまま**成功しており、正常遷移が壊れていないことを確認した。
- `npx prisma migrate deploy`: 変更なし(今回はスキーマ変更なし)。
- `npx tsc -b --noEmit`(client)・`npm run build --workspace=client`成功(本Phaseはサーバー専用のためclientへの影響なし)。

## 結論(Phase 6)

指示書11.4の受入条件のうち、正常遷移の維持・不正遷移の拒否・APIエラーコードの定義・管理画面からの不正遷移防止・Webhook処理への無影響をすべて満たした。DB CHECK制約(11.3)は本番データ未検証のため見送り、次のご指示があれば対応する。Phase 7(通知モジュール化)以降は、着手のご指示があり次第対応する。

---

# Phase 7: 通知モジュール化(完了報告)

## 事前調査で判明した実際のセキュリティ上の欠陥

`server/src/services/mailTemplates.ts`(155行、9通のメール送信関数)を調査した結果、**顧客が自由入力する値(customerName・explainerName等)や商品名が、HTMLエスケープなしでメール本文のテンプレート文字列へ直接埋め込まれていた**ことを確認した。例えば注文時に入力する氏名に`<script>...</script>`のような文字列を入れると、購入完了メール等の本文にそのまま挿入される状態だった。これは指示書1.8が指摘する問題そのものであり、指示書12.3の受入条件「顧客名・商品名・銀行情報をエスケープ」に対応する形で、本Phaseの実質的な修正の中心とした。

## 12.1 分割構成

```text
server/src/modules/notifications/
├─ domain/
│  └─ notification.types.ts        … EmailMessage型(to/subject/html/text)
├─ renderers/
│  ├─ htmlRenderer.ts               … escapeHtml()・renderHtmlLayout()
│  └─ textRenderer.ts               … renderTextLayout()(段落配列を空行区切りで連結)
├─ templates/
│  ├─ purchaseComplete.ts
│  ├─ cartAbandoned.ts              … 指示書の例示にはないが、既存のカート放棄リマインドメール用に追加
│  ├─ bankTransfer.ts
│  ├─ passwordSetup.ts              … ゲスト/代理店/管理者のアカウント設定・代理店アクセス許可の4通を集約
│  ├─ passwordReset.ts
│  └─ walletReminder.ts
├─ application/
│  └─ sendNotification.usecase.ts   … 送信の唯一の入口(Adapterを直接呼ばせない)
└─ infrastructure/
   └─ resend.adapter.ts             … 旧services/mail.tsを移設(Resend未設定時・送信失敗時も例外を投げない契約を維持)
```

各テンプレートは`buildXxxEmail(...)`という**副作用のない純粋関数**として実装し、`EmailMessage`(`{to, subject, html, text}`)を返す。実際の送信(`sendNotification`)とは分離したことで、テンプレート単体でのsnapshot testが可能になった(指示書12.3)。

## 12.2 必須対応の実装状況

- **HTMLエスケープ**: `escapeHtml()`を新設し、顧客名・商品名・バリエーション名・銀行情報・管理者名等、テンプレートへ差し込むすべての動的な文字列に適用した。
- **共通レイアウト**: `renderHtmlLayout()`を新設したが、現行メールの見た目(装飾のないp/ul構成)を変えないという指示書12.3の方針を優先し、今回は素通しの実装にとどめた(将来ブランド共通のヘッダー・フッターを追加する際の変更箇所として用意)。
- **subject生成分離**: 各`buildXxxEmail()`が返す`EmailMessage.subject`として、本文の組み立てと同じ関数内で完結させた(送信処理からは完全に分離済み)。
- **text/plain生成**: 全9通すべてに`text`版を追加した(HTMLからの自動変換ではなく、各テンプレートがhtml/textを対で明示的に組み立てる方式)。
- **ブランド名・APP_URLのConfig化**: `shared/config/appConfig.ts`に`brandName`を追加し、`appUrl`と合わせて全テンプレートがConfig経由で参照するようにした(以前は各ファイルにcopy-pasteされた`appUrl()`ヘルパー関数が重複していた)。
- **Notification Outbox対応**: 見送った(下記「対象外」参照)。

## 互換性の維持

`server/src/services/mailTemplates.ts`は削除せず、元と同じ9つの関数名(`sendPurchaseCompleteEmail`等)を持つ薄いラッパーとして残した(指示書18.1「新モジュールを互換Facade経由で呼び出す」)。この関数群は8つの呼び出し元ファイル・4つの`vi.mock('.../mailTemplates', ...)`によるテスト差し替えから参照されており、Phase1の`adminApi.ts`・Phase4の`checkout.ts`と同じ理由で、全面的なre-exportではなく「テンプレート組み立て→送信」の実処理を残す形にした。`services/mail.ts`(旧Resendラッパー)は直接の呼び出し元が`mailTemplates.ts`自身のみだったため削除し、`modules/notifications/infrastructure/resend.adapter.ts`へ実装を移設、テストファイルも移動した。

## 対象外(意図的に見送った箇所)

- **Notification Outbox対応**(指示書12.2): Phase3で見送った`notification_outbox_events`と同様、新規テーブル・マイグレーションを伴う。既存のメール送信は「例外を投げない・業務トランザクションを巻き戻さない」という安全性が既に確保されているため、永続化によるリトライ機構の追加は独立した機能追加として扱い、必要になった時点で別途対応する。
- **共通レイアウトへの実際の装飾追加**(ヘッダー・フッター・ブランドロゴ等): 「現行メール内容を大きく変更しない」を優先し、今回はレイアウト関数の骨組みのみ用意した。

## 動作確認

- `npx tsc --noEmit`(server)クリーン。
- `npx vitest run`: 483件全成功(既存462件 + 通知モジュールの新規テスト21件)。8つの呼び出し元ファイル・4つの`vi.mock`利用テスト(`agencyIntegration.routes.test.ts`・`admin/adminUsers.test.ts`・`routes/auth.mail.test.ts`・`routes/stripeWebhook.mail.test.ts`)、および`checkout.test.ts`・`stripeWebhook.test.ts`・`stripeWebhook.coupon.test.ts`・`admin/walletMissing.test.ts`・`routes/auth.test.ts`はいずれも**無変更のまま**成功しており、メール送信を伴う全業務フローに影響がないことを確認した。
- 各テンプレートに、悪意ある入力値(`<script>alert(1)</script>`等)を顧客名・商品名・銀行情報に与えてhtml出力がエスケープされることを検証するテストと、snapshot testを追加した。
- `npx prisma migrate deploy`: 変更なし(今回はスキーマ変更なし)。
- `npx tsc -b --noEmit`(client)・`npm run build --workspace=client`成功。

## ファイル行数の変化

| ファイル | Phase 0時点 | Phase 7後 |
|---|---:|---:|
| `server/src/services/mailTemplates.ts` | 155 | 52(互換ラッパーのみ)。実装は`modules/notifications/`へ分割、最大ファイルは`templates/passwordSetup.ts`の78行 |

## 結論(Phase 7)

指示書12.3の受入条件のうち、現行メール内容を大きく変更しない・顧客名商品名銀行情報のエスケープ・リンクURLの正しさ・送信失敗で業務トランザクションを巻き戻さない・テンプレートsnapshot test追加をすべて満たした。特にHTMLエスケープの欠如は実際のセキュリティ上の欠陥であり、本Phaseで修正した。Notification Outbox対応は新規テーブルを伴うため見送り、理由を明記した。Phase 8(性能改善)以降は、着手のご指示があり次第対応する。
