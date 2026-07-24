# 残課題修正指示書 対応report

`POST_MODULARIZATION_FIX_INSTRUCTIONS_sengokumarket.md`(残課題修正指示書)への対応記録。
保守性改善Phase 0〜8(`docs/refactoring-baseline.md`)完了後に見つかった、本番運用上の残課題を解消する。

基準コミット: `193b819`(Phase 8完了時点)。
`SENNOKUNI_INTEGRATION_ENABLED`は本対応の全期間を通じて`false`のまま(指示書の明示的な方針)。

---

# Stage 1: Vercel起動時Config検証(完了報告)

## 問題

`api/index.ts`(Vercel Serverlessの実エントリポイント)が`assertRequiredEnv()`を呼んでおらず、
必須環境変数が未設定・不正でもアプリが起動してしまう状態だった。加えて既存の`assertRequiredEnv()`
自体も「値が設定されているか」しか見ておらず、形式や強度は検証していなかった。

## 対応

- `api/index.ts`で`createApp()`前に`assertRequiredEnv()`を呼ぶよう変更。
- `server/src/shared/config/env.ts`を実際の形式検証へ強化:
  - `APP_URL`: URLとしてパース可能・`http:`/`https:`のみ・本番(`NODE_ENV=production`)は`https:`必須
  - `JWT_SECRET`: 32文字以上・既知のデフォルト値(`secret`/`changeme`/`test`等、大文字小文字を無視)禁止
  - `SETTINGS_ENCRYPTION_KEY`: `^[0-9a-fA-F]{64}$`
  - `DATABASE_URL`: `postgres://`または`postgresql://`で開始
  - `TERMS_VERSION`: 空・空白のみを禁止
- 検証エラーは全件まとめて1つの例外にし、**秘密値そのものはエラーメッセージに含めない**(変数名+理由のみ)。
- CIの`JWT_SECRET`が新しい32文字要件を満たしていなかったため合わせて修正。
- `api/index.ts`は`server/tsconfig.json`の`rootDir`制約の対象外のため、ルートの`tsconfig.json`
  (`api/**`・`server/src/**`を横断)を使う`typecheck:api`をCIに追加。

## 動作確認

- `env.test.ts`に形式検証・秘密値非露出の11ケースを追加。

---

# Stage 2: packages/contractsのbuild可能化(完了報告)

## 問題

`@sengoku/contracts`は`main: "src/index.ts"`のまま(未コンパイルTypeScript)で、`server/package.json`
の`"start": "node dist/index.js"`起動経路ではrequireできず、実際に試すとエラーになることを確認した。

## 対応

- `packages/contracts`にCommonJSビルド(`tsc`、`module: commonjs`、`outDir: dist`)を追加し、
  `main`/`types`/`exports`を`dist/`側へ向けた。
- `postinstall`スクリプトで`npm install`時に自動ビルドされるようにした(`server`の
  `prisma generate`と同じ方式)。
- serverとclientで`typescript`のバージョンが異なる(`^5.5.3` / `~6.0.2`)ため、`packages/contracts`
  自身にも明示的に`typescript: ^5.5.3`を追加し、どちらの`tsc`が使われるかを曖昧にしないようにした。
- ルートに`build:contracts`を追加し、`build:server`/`build:client`が先にこれを実行するようにした。
- CIに`build:contracts`→`build --workspace=server`→`node dist/index.js`起動smoke test(
  `/api/health`をポーリング)を追加。

## 動作確認

- ローカルで`build:contracts`→`build:server`→`node dist/index.js`→`curl /api/health`が成功することを確認。
- ビルド成果物(`dist/*.test.js`)をvitestが誤って拾って失敗する問題が判明したため、
  `vitest.config.ts`に`exclude: ['**/node_modules/**', '**/dist/**']`を追加。

---

# Stage 3: 代理店通知Outbox・設定メール再送(完了報告)

## 問題

代理店・ログインユーザー作成をcommitした**後**に、パスワード設定トークン発行・メール送信を行っていた。
トークン発行失敗・Resend未設定・送信失敗時に、代理店アカウントだけが作成済みのまま通知が失われ、
かつ同じupsertを再送してもログインユーザーが既に存在するため通知が再生成されない状態だった。

## 対応

### 新規テーブル `notification_outbox_events`

指示書5.3の推奨カラムに加え、Stripe Event Inbox・integration_outbox_eventsと同じ
`processing_token`/`processing_started_at`による所有権クレームを**最初のマイグレーションから**含めた
(Stage 7で指摘されている「integration_outbox_eventsに後から追加が必要」という同種の手戻りを未然に防ぐ)。
再試行時のトークン増殖を防ぐため、`password_reset_token_id`(直前に発行したトークンのIDを保持し、
次回発行前に無効化する)も追加した。

### 同一トランザクション化

`upsertAgency.usecase.ts`→`provisionAgencyAccount.usecase.ts`が、代理店作成・ログインユーザー作成・
昇格と**同一トランザクション**で`notification_outbox_events`に通知予定を記録するようにした。
実際のメール送信・トークン発行はcommit後のDispatcherが行う。

旧`agencyNotification.adapter.ts`(commit直後にメール送信を試みる旧方式)は削除し、
`upsertAgency`実行直後に`triggerImmediateNotificationDispatch()`をベストエフォートで呼ぶ形に置き換えた
(NFT自動発行の`triggerImmediateNftMintProcessing()`と同じ「即時実行+cronセーフティネット」方式)。

### トークン発行(指示書5.5)

3案のうち「notification eventごとにtoken IDを保持」を採用した。生の未使用トークンをどこにも保存
しないため「未使用トークンの再利用」は選択できず、「全トークン無効化」はユーザーの他の正当な
パスワード再設定リクエストまで巻き込むため広すぎると判断した。Dispatcherは同一イベントの再試行時、
前回発行したトークン(`passwordResetTokenId`)があれば無効化してから新規発行し、発行したトークンの
IDを同じイベント行へ記録し直す。

### Dispatcher

`dispatchPendingNotifications()`: stale(10分以上放置)なprocessing行をpendingへ戻した上で、
条件付きUPDATE(`WHERE status='pending'`)によるアトミックなclaimでバッチ処理する。送信失敗時は
指数バックオフ(5→10→20→40→60分)、最大5回で`dead`。`retryNotification(id)`で
`pending`/`failed`/`dead`いずれからも手動再送できる。

### 管理API(指示書5.6)

- `GET /api/admin/notification-outbox`(status絞り込み・ページネーション)
- `POST /api/admin/notification-outbox/:id/retry`
- `POST /api/admin/agencies/:id/resend-setup-email`(既にログインユーザーが存在する代理店へ、
  設定案内メールを手動で再送する。外部システムからの同一upsert再送では通知が再生成されない
  問題への直接の対処)

### cron配線

`GET /api/internal/cron/process-notification-outbox`(既存の`internalCron.ts`・`CRON_SECRET`
保護に相乗り)を追加し、`vercel.json`の`crons`に日次実行を追加した。

## 開発中に見つけた実バグ

- `claimBatch`が、DB側でアトミックに`attempt_count`をincrementした**後**の値ではなく、
  claim前に読んだ古い値をそのままメモリ上の返り値に積んでいた。これにより`markFailed`の
  バックオフ計算(`BACKOFF_MINUTES[attemptCount - 1]`)が`attemptCount=0`のまま渡され、
  `BACKOFF_MINUTES[-1]`(`undefined`)を使った不正な`Date`をPrismaへ渡してエラーになっていた。
  `claimed.push`時に`attemptCount: candidate.attemptCount + 1`を明示的に反映するよう修正した。

## 対象外(意図的に見送った箇所)

- 発行したパスワード設定トークンのURLをログへ出力する運用(指示書5.7「秘密トークンをログに
  平文保存しない」を厳守するため、トークンはメール本文にのみ含め、ログには一切出力しない)。
- 管理画面(client)側の一覧・再送UIの追加: 指示書5.6はAPIのみを要求しており、UI実装は
  スコープ外と判断した。必要であれば別途対応する。

## 動作確認

- `npx tsc --noEmit`(server)・`npx tsc -b --noEmit`(client)クリーン。
- `npx vitest run`: 526件全成功(既存505件 + Notification Outbox関連の新規テスト21件:
  Dispatcher/Repositoryの単体テスト8件、管理API一覧・再送テスト7件、代理店設定メール再送API
  テスト3件、cron配線テスト3件)。
  - 「DB commit後メール失敗でpendingへ戻りbackoffが設定される(dead化しない)」
  - 「最大試行回数超過でdeadになる」
  - 「トークン作成失敗時も再試行される」
  - 「failed状態のイベントを手動再送できる」
  - 「二重送信防止: 同時に複数回claimしても1回しか処理されない」
  - 「Vercel Serverlessでの処理中断を想定したstale processingの回収」
  をそれぞれ個別のテストで確認した。
- 既存の`agencyIntegration.routes.test.ts`(代理店連携API)は、通知送信の検証先を
  旧`mailTemplates`モックから新しい`resend.adapter`の`sendViaResendOrThrow`モック+
  `notification_outbox_events`のDB確認へ更新した上で、全件成功を維持した。
- `npx prisma migrate status`: マイグレーション適用済み(追加のみ、既存データへの影響なし)。
- `build:contracts`→`build:server`→`node dist/index.js`の起動smoke testが引き続き成功することを
  再確認した(Stage 2のbuild chainがStage 3のスキーマ追加後も壊れていないことの確認)。
- `npm run build:client`成功(本Stageはサーバー専用のためclientへの影響なし)。

---

# Stage 4: 共通ID・紹介連携の永続ジョブ化(完了報告)

## 問題

Checkout・会員登録の直後に、以下のfire-and-forget呼び出しを行っていた。

```ts
void runBestEffortSennokuniOrderLinking(order.id);   // checkout.ts
void bestEffortResolveAndLinkCommonUserId(user.id, user.email); // auth.ts(会員登録)
```

Vercel Serverlessではレスポンス完了後にプロセスが凍結・終了する可能性があり、この処理が
最後まで実行される保証がない。外部API停止時の再試行手段もなかった。

## 対応

### 新規テーブル `order_linking_jobs`

指示書6.3の推奨カラム(`order_id`/`job_type`/`status`/`attempt_count`/`processing_token`/
`processing_started_at`/`next_attempt_at`/`last_error`)に加え、会員登録時点では注文がまだ
存在しないケースを扱えるよう`user_id`も持たせた(nullable、`job_type`によって
`user_id`のみ/`user_id`+`order_id`両方/`order_id`のみを使い分ける)。

### job_type分割(指示書6.4の明示的な指定に従う)

Checkout時点でトランザクション内に記録するのは以下の2種類のみ:

```text
common_user_resolve  … common_user.resolve.requested 相当
referral_capture     … referral.capture.requested 相当
```

**referral confirm(event=purchase)はここでは一切enqueueしない。** 指示書7章(Stage 5)が
指摘する「決済確定前にconfirmを送ってしまう」問題は、Stage 5で正式にconfirm用のjob_type
(`referral_confirm_registration`/`referral_confirm_purchase`)と、その正しいトリガー地点
(会員登録完了・`applyPaidOrderSideEffects()`)を追加することで対応する。Stage 4の時点で
confirmの送信経路自体を無くしたことで、Stage 5の着手前から「決済前confirm」の実害は既に
発生しない状態になっている。

これに伴い、旧`sennokuniOrderLinking.ts`(resolve→capture→confirm-purchaseを1つの
fire-and-forget関数にまとめていたオーケストレーター)は全体を削除し、`services/orderLinkingJobs.ts`
(enqueue)・`services/orderLinkingJobDispatcher.ts`(claim・実行・backoff)の2ファイルへ置き換えた。
`externalCommonUserClient.ts`の`bestEffortResolveAndLinkCommonUserId`も同様に削除した
(いずれも呼び出し元がジョブ経由に置き換わり、fire-and-forget版は完全に不要になったため)。

### Dispatcher

`integrationOutboxDispatcher.ts`と同じ設計を踏襲: `SENNOKUNI_INTEGRATION_ENABLED`(既定OFF)が
有効になるまでジョブをclaimせず`pending`のまま保持し(受入条件「Feature Flag無効時は送信しない」
「再度有効化するとpendingを処理可能」を満たす)、条件付きUPDATE(`WHERE status='pending'`)による
アトミックなclaim、指数バックオフ(5→10→20→40→60分、最大5回で`dead`)、10分以上放置された
`processing`行の回収を行う。

- `common_user_resolve`job: 対象ユーザーの`commonUserId`が既に解決済みならAPIを呼ばずorderへの
  反映のみで即成功、未解決ならresolve APIを呼び、成功時は`User.commonUserId`と(`order_id`が
  あれば)`Order.commonUserId`/`commonUserResolutionStatus`を更新する。
- `referral_capture`job: `Order.referralCode`が無ければ何もせず成功、あればcapture APIを呼び
  `Order.referralSessionKey`のみを更新する(代理店4役の確定はStage 5のconfirm jobが行う)。
- 外部クライアント(`resolveCommonUserId`/`captureReferralToken`)がnullを返した場合
  (Feature Flag確認済みの状態でのnullは、認証情報未設定・ネットワーク障害・非2xx応答のいずれか)、
  Dispatcher側で明示的に例外化し、backoff・再試行の対象にする(指示書6.5「外部API停止時に
  再試行可能」)。低レベルクライアント自体の戻り値契約(null許容)は、他の呼び出し文脈との
  互換性を保つため変更していない。

### Checkout・会員登録

`createPendingOrder.usecase.ts`の注文作成トランザクション内で、`order.userId`に対して
`common_user_resolve`ジョブを、`order.referralCode`があれば`referral_capture`ジョブを
enqueueする(外部HTTP呼び出しは一切行わない)。`checkout.ts`はcommit後に
`triggerImmediateOrderLinkingDispatch()`をベストエフォートで呼ぶのみ(NFT自動発行・
Stage 3通知Outboxと同じ「即時実行+cronセーフティネット」方式)。

`auth.ts`の会員登録も、ユーザー作成を`prisma.$transaction`で包み、同一トランザクション内で
`common_user_resolve`ジョブ(`order_id`なし)をenqueueするよう変更した。

### cron配線

`GET /api/internal/cron/process-order-linking-jobs`(既存の`internalCron.ts`・`CRON_SECRET`
保護に相乗り)を追加し、`vercel.json`の`crons`に日次実行を追加した。

## 開発中に見つけた実バグ・注意点

- **テスト用に固定のダミー`common_user_id`文字列を使うと、共有の開発用DBで`User.commonUserId`
  の一意制約に本当に抵触することを確認した。** `npx vitest run`をフルスイートで実行した際、
  無関係な既存テスト(実際のcheckout/会員登録フローを経由するもの)が本Stageの変更により
  副次的に`order_linking_jobs`のpending行を大量に残すようになっており、これらがテスト内で
  Feature Flagを有効化した瞬間に一括でclaim・処理されてしまい、固定文字列の`common_user_id`を
  複数の無関係なテストユーザーへ重複して割り当てようとして一意制約違反が発生した。対応として、
  (1) 自テストファイルの`beforeAll`で他ファイル由来のpending行を一括削除(`fileParallelism: false`
  のため以降の汚染は入らない)、(2) モックで使う`common_user_id`値をテスト実行ごとに一意な
  接尾辞付きにする、の2点を行った。過去の失敗した実行で実際に無関係なテストユーザー1件へ
  `commonUserId`が誤って書き込まれたまま残っていたため、この調査の過程で該当行を修正した
  (本番データには影響なし。ローカル開発用DBのみの話)。

## 対象外(意図的に見送った箇所)

- `referral_confirm_registration`/`referral_confirm_purchase`job_typeの追加とそのトリガー配線
  (Stage 5でこの2つのjob_typeと、会員登録完了・決済確定という正しいトリガー地点を追加する)。
- 全額返金時のconfirm取消契約(指示書7.3「全額返金時の取消契約がある場合は別イベントとして
  enqueue」): 現時点で千ノ国側の取消契約の詳細が確定していないため、Stage 5着手時に契約内容を
  確認しながら対応する。

## 動作確認

- `npx tsc --noEmit`(server)・`npx tsc -b --noEmit`(client)クリーン。
- `npx vitest run`: 529件全成功(既存526件 + `orderLinkingJobDispatcher.test.ts`の新規テスト
  10件)。
  - 「Feature Flag無効時はジョブをclaimせずpendingのまま残す」
  - 「Feature Flag再度有効化後は溜まったpendingジョブを処理できる」
  - 「未解決ユーザーはresolve APIを呼びcommonUserIdを更新する(orderIdがあれば注文へも反映)」
  - 「既に解決済みのユーザーはAPIを呼ばない」
  - 「外部API停止時(非2xx)は再試行可能」「最大試行回数超過でdead」
  - 「referral captureの成功・失敗時再試行」
  - 「二重処理防止」「即時ディスパッチが例外を投げない」
  をそれぞれ確認した。
- `externalCommonUserClient.test.ts`・`checkout.test.ts`・`checkout.stripeNotConfigured.test.ts`・
  `modules/checkout`配下・`routes/auth.test.ts`はいずれも無変更のまま成功しており、既存の
  決済・会員登録フローに影響がないことを確認した。
- `npx prisma migrate status`: 適用済み、pending migrationなし。
- `build:contracts`→`build:server`→`node dist/index.js`起動→`/api/health`応答: 成功
  (Stage 2のbuild chainがStage 4のスキーマ追加後も壊れていないことの確認)。
- `npm run build:client`成功。

---

# Stage 5: referral confirmのタイミング修正(purchase側完了・registration側は判断待ち)

## 問題

Stage 4までの実装では、referral captureは注文作成時点(=決済前)にジョブ化していたが、
`confirm(event=purchase)`を送る経路自体がまだ存在しなかった(旧`sennokuniOrderLinking.ts`は
Stage 4で削除済み)。指示書の正式フローどおり、`confirm(event=purchase)`は決済確定
(Stripe Webhook `paid` または銀行振込入金確認)のタイミングでのみ送るよう実装した。

## registration側について(ユーザーへ確認済み・今回は見送り)

指示書は「会員登録確定時にconfirm(event=registration)をenqueueする」ことも求めているが、
調査の結果、**このシステムには現在「会員登録時点での紹介コード帰属」という概念自体が
存在しない**ことが判明した(`/auth/register`は氏名・メール・電話・パスワードのみを受け取り、
紹介コードを一切認識しない。紹介コードの永久帰属は`attachReferralAttribution`により
**常に初回注文時点**に確定する仕様になっている)。

これをそのまま実装するには、`/auth/register`への新規ref код受付・登録時点でのcapture・
Order非依存のsession key保存という、既存の「初回購入時点で紹介元を固定する」という
確立済みの仕様(CLAUDE.md・変更禁止範囲)とは別の、新しいユーザー向け機能を追加する必要が
あり、開発者判断で進めるべき範囲を超えると判断してユーザーに確認した。**「今回は見送る」
方針が選ばれたため、`referral_confirm_registration`のjob_type・そのenqueue経路は実装せず、
purchase側のみを今回のStage 5の対象とした。**

## 実装(purchase側)

- `services/orderLinkingJobs.ts`に`enqueueReferralConfirmPurchaseJob(tx, orderId)`を追加。
- `services/orderFulfillment.ts`の`applyPaidOrderSideEffects()`(Stripe Webhook・銀行振込
  入金確認の両方から、決済確定の同一トランザクション内で呼ばれる唯一の共通処理)内で、
  `order.referralCode`があればこのジョブをenqueueする。この関数は呼び出し側で
  `paymentStatus`が既に`paid`でないことを確認した上でのみ呼ばれるため、以下の受入条件は
  この関数に相乗りするだけで自動的に満たされる:
  - 未決済注文でpurchase confirmされない(paid遷移時のみ呼ばれるため)
  - Stripe paid時・銀行振込入金確認時それぞれ1回だけconfirm(paymentStatus='paid'の
    事前チェックで二重処理防止)
  - Webhook再送で二重confirmしない(Stripe Event Inboxの冪等性 + 同じpaymentStatusチェック)
  - confirm失敗で決済確定を巻き戻さない(enqueueはDB INSERTのみで即座に成功し、実際の
    confirm送信はcommit後のDispatcherが行うため)
- `services/orderLinkingJobDispatcher.ts`に`referral_confirm_purchase`job_typeを追加。
  `referral_capture`・`common_user_resolve`ジョブとの処理順序保証はないため、処理時点で
  `order.referralSessionKey`または`order.commonUserId`がまだ解決されていない場合は例外を
  投げて既存のbackoff/再試行に委ねる(他の2ジョブの解決を待ってから自動的に再試行される)。
- Stripe Webhook・銀行振込確認の両方の決済確定処理から`triggerImmediateOrderLinkingDispatch()`
  を呼び、ベストエフォートで即時ディスパッチする(cronによるセーフティネットも既存のまま)。

## 対象外(意図的に見送った箇所)

- **`referral_confirm_registration`(会員登録確定時のconfirm)**: 上記の通り、ユーザーへの
  確認の結果、新規機能追加が必要と判明したため今回は見送り。次のご指示があれば
  (a)`/auth/register`への紹介コード受付機能を新設する、または(b)初回注文時点の
  帰属確定を「登録」の代替イベントとみなす、のいずれかの方針で対応する。
- **全額返金時の取消契約(指示書7.3)**: `externalReferralClient.ts`の`ConfirmReferralInput`
  は現時点で`event: 'registration' | 'purchase'`のみをサポートしており、返金・取消用の
  event種別は千ノ国側の契約がまだ確定していない。存在しない外部契約を推測して実装すると
  後で破壊的変更になるリスクが高いため、契約確定後に対応する。

## 動作確認

- `npx tsc --noEmit`(server)・`npx tsc -b --noEmit`(client)クリーン。
- `npx vitest run`: 539件全成功(既存529件 + `orderLinkingJobDispatcher.test.ts`への
  `referral_confirm_purchase`job関連テスト5件 + `stripeWebhook.test.ts`・
  `admin/orders.test.ts`への決済確定時のジョブ記録確認テスト各1件)。
  - 「referralSessionKey・commonUserIdが揃っていればconfirm APIを呼び代理店4役を保存する」
  - 「referralSessionKeyが未解決の間は再試行する」「commonUserIdが未解決の間は再試行する」
  - 「referralCodeが無い注文はconfirm APIを呼ばず即成功する」
  - 「confirmが失敗した場合は再試行できる」
  - 「紹介コードありの決済確定でジョブが記録される(未決済時は記録しない)」(Stripe Webhook・
    銀行振込入金確認の両方)
  をそれぞれ確認した。
- スキーマ変更なし(job_typeは既存の`order_linking_jobs`テーブルの文字列カラムへ新しい値を
  追加しただけのため、新規マイグレーション不要)。`npx prisma migrate status`は適用済みのまま。
- `build:contracts`→`build:server`→`node dist/index.js`起動→`/api/health`応答: 成功。
- `npm run build:client`成功。

---

# Stage 6: 共通ID未解決イベントの送信保留(完了報告)

## 問題

権利付与Outbox(`integration_outbox_events`のentitlement.granted/revoked)は、enqueue時点の
注文状態(`common_user_id`・`sales_agent_id`・`closing_agent_id`・`referral_session_key`)を
payloadへスナップショットしていた。これらはStage 4のジョブ(`common_user_resolve`・
`referral_capture`)によって決済確定「後」に非同期で解決されることがあるため、決済確定と
ほぼ同時にentitlement Outboxがenqueueされると、これらの値が未解決(null)のまま送信されて
しまう可能性があった。

## 対応(指示書8.2の推奨順位1〜3をすべて実装)

### 8.3 必須判定: product_integration_rulesへの追加

`ProductIntegrationRule`に`requireCommonUserId`/`requireSalesAgentId`/`requireClosingAgentId`/
`requireReferralSessionKey`(すべて既定`false`)を追加した。既定値がfalseのため、
**既存の(現状すべて未設定の)商品の挙動は一切変わらない**(指示書8.4「不要なシステムでは
common_user_idなしでも送信可能」)。

### 8.2 推奨順位1: Dispatcher送信時に最新情報を再構築

`enqueueEntitlementEvents`のpayloadに`product_id`を追加(必須判定の再取得に使う)。
`integrationOutboxDispatcher.ts`に`reconcileEntitlementFields()`を新設し、送信直前に
`payload.order_id`から注文を再取得し、`common_user_id`等4フィールドを**そのenqueue時点の
値ではなく最新の注文の値で上書きしたpayload**を組み立てる。`order_id`を持たないイベント
(entitlement系以外の将来のイベント種別)は素通しにする。

### 8.2 推奨順位2: 必須IDが未解決ならblocked

再構築後、`product_id`から対応する`product_integration_rule`を再取得し、必須設定されている
フィールドが依然として未解決なら、送信を試みずに`status='blocked'`・
`blocked_reason`(`common_user_unresolved`等、指示書8.2の例示にならった命名)を設定して
そのターンは終了する(attempt_countは増加させない。ネットワーク障害等の「失敗」とは異なり、
「まだ解決を待っている」状態のため)。

### 8.2 推奨順位3: ID解決完了時にpendingへ戻す

Dispatcherのclaim対象を`status IN ('pending', 'blocked')`へ拡張した。これにより`blocked`行も
毎回のdispatch(cron・各種決済確定直後のベストエフォート即時実行)で再評価され、Stage 4の
ジョブが解決を終えていれば次のサイクルで自動的に送信される(指示書8.4「ID解決後に自動再開」)。

### 開発中に見つけた実バグ(修正済み)

OVE Wallet宛の`entitlement.granted`送信成功時、`sendToOveWallet()`は送信成功のtransaction_id
(将来の返金時REVERSAL用)を`payload`へ直接DB書き込みしていたが、今回`sendAndRecordResult()`
の成功時にも(再構築後のpayloadを永続化するため)`payload`を上書きするよう変更したため、
**そのままでは後続の1回で先に書き込まれたtransaction_idが消えてしまう状態**になっていた。
`sendToOveWallet()`をメモリ上の`event.payload`オブジェクトを直接変更する方式に変更し、
呼び出し元が送信成功後にまとめて1回で永続化するよう修正した(実際にテストで再現・確認した
上で修正)。

### 管理画面

`GET /api/admin/integration-outbox?status=blocked`で一覧・絞り込み可能(既存の
`INTEGRATION_OUTBOX_STATUSES`契約定数へ`blocked`を追加しただけで、一覧表示自体はDBの生の行を
返すため`blockedReason`も追加のコード変更なしで表示される。指示書8.4「blocked理由を管理画面で
確認可能」)。状態遷移Policy(`integrationOutboxStatus.policy.ts`、Phase6で導入・現状は参照用)
にも`blocked`関連の遷移(`processing→blocked`・`blocked→processing`)を追加した。

### 対象外(意図的に見送った箇所)

- **product_integration_rulesの必須ID設定を管理画面から編集するUI**: このテーブル自体が
  現状、管理画面からの編集手段を一切持たない(直接DB/シードでの設定を前提とした設計。
  評議員NFTはこのシステム単独で完結する方針のため意図的に未整備)。今回追加した4つの
  真偽値カラムも同様の位置づけとし、UIの新設は見送った。将来、実際に外部連携を有効化する
  段階で、他のルール項目とまとめて管理画面を整備することを推奨する。

## 動作確認

- `npx tsc --noEmit`(server)・`npx tsc -b --noEmit`(client)クリーン。
- `npx vitest run`: 547件全成功(既存539件 + Stage6関連の新規テスト8件: dispatcherのblocking/
  再構築テスト4件、状態遷移Policyのblocked遷移テスト3件、管理API`status=blocked`絞り込み
  テスト1件)。
  - 「必須なのにcommon_user_idが未解決ならblockedになり送信しない」
  - 「blocked後にID解決されると次回dispatchで自動的に再開する」
  - 「必須設定がない商品は従来通りnullでも送信される(後方互換)」
  - 「送信payloadはenqueue時点でなく送信時点の最新値を使う」
  をそれぞれ確認した。既存の`integrationOutboxDispatcher.test.ts`・`integrationOutbox.test.ts`・
  `admin/integrationOutbox.test.ts`の既存ケースはすべて無変更のまま成功しており、
  現状(ルール未設定)の挙動に影響がないことを確認した。
- 新規マイグレーション(追加のみ、既存データへの影響なし): `product_integration_rules`へ
  4つの真偽値カラム(既定false)、`integration_outbox_events`へ`blocked_reason`。
- `npx prisma migrate status`: 適用済み、pending migrationなし。
- `build:contracts`→`build:server`→`node dist/index.js`起動→`/api/health`応答: 成功。
- `npm run build:client`成功。

---

# 動作確認(Stage 1〜6 共通)

- `npx vitest run`(server): 547件全成功。
- `npx tsc --noEmit`(server)・`npm run typecheck:api`・`npx tsc -b --noEmit`(client): すべてクリーン。
- `npm run build:client`: 成功。
- `build:contracts`→`build:server`→`node dist/index.js`起動→`/api/health`応答: 成功。
- `npx prisma migrate status`: 適用済み、pending migrationなし。

## 結論(Stage 1〜6)

指示書のP0のうちStage 1(Vercel Config検証)・Stage 2(packages/contracts build可能化)・
Stage 3(代理店通知Outbox)・Stage 4(共通ID・紹介連携の永続ジョブ化)・Stage 5(referral
confirmのタイミング修正・purchase側)・Stage 6(共通ID未解決イベントの送信保留)を完了した。
決済・在庫・紹介・報酬・NFT/ウォレット・Outboxの変更禁止範囲には手を入れていない。
`SENNOKUNI_INTEGRATION_ENABLED`は`false`のまま。Stage 5のregistration側(新規機能追加が
必要と判明)はユーザー確認の上で見送り、次のご指示があれば対応する。Stage 7(Integration
Outbox Dispatcher強化)以降は、着手のご指示があり次第対応する。
