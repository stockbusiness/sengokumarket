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

# 動作確認(Stage 1〜3 共通)

- `npx vitest run`(server): 526件全成功。
- `npx tsc --noEmit`(server)・`npm run typecheck:api`・`npx tsc -b --noEmit`(client): すべてクリーン。
- `npm run build:client`: 成功。
- `build:contracts`→`build:server`→`node dist/index.js`起動→`/api/health`応答: 成功。
- `npx prisma migrate status`: 適用済み、pending migrationなし。

## 結論(Stage 1〜3)

指示書のP0のうちStage 1(Vercel Config検証)・Stage 2(packages/contracts build可能化)・
Stage 3(代理店通知Outbox)を完了した。決済・在庫・紹介・報酬・NFT/ウォレット・Outboxの
変更禁止範囲には手を入れていない。`SENNOKUNI_INTEGRATION_ENABLED`は`false`のまま。
Stage 4(共通ID・紹介連携の永続ジョブ化)以降は、着手のご指示があり次第対応する。
