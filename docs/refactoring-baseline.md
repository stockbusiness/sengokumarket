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
