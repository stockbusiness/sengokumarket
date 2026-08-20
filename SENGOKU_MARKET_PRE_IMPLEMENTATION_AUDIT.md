# 戦国マーケット 作業前確認(ドラフト)

作成日: 2026-08-20
対象指示書: `05_SENGOKU_MARKET_IMPLEMENTATION_INSTRUCTIONS_20260820.md`
ステータス: **ドラフト。統合責任者の承認前。コード変更・migration適用・フラグ変更・マージ・デプロイは未実施かつ行っていない。**

> 本ドキュメントはこのセッション(リポジトリのコード・git履歴・CI/デプロイのGitHub上のステータス)から読み取り専用で確認できた範囲のみをまとめたものです。本番Vercel環境変数の実値、Supabase本番DBの適用済み/未適用migration・drift、`integration_outbox_events`等の本番件数、実際の商品カタログは、このセッションから直接参照できないため「要提供」として明記しています。

## 1. HEAD・ブランチ・未コミット差分・デプロイ先

- 指示書の調査基準commit: `7b6be54e7909f33841b335ca96434d960fb9a89d`(PR #4マージ直後の状態)
- **現在の`main`のHEAD: `297b569c491712b2a5ca15e49a0f74b3a01b3665`**(PR #6マージ済み)
  - `7b6be54` → `297b569` の間に、本セッションで実施した以下2件が追加でmainへマージされている。指示書の前提と現状で**差分がある**ため、指示書の作業内容を進める場合はこの差分を踏まえて再調査する必要がある。
    1. NFT発行を運営手動Mintへ移行(Crossmintクライアントのパスエンコード修正、既購入者向けウォレット登録用リンク発行機能`walletRegistrationLink.ts`の追加。migration `20260730105053_wallet_registration_links`)
    2. サイトブランド「戦国楽市楽座」→「千ノ国」へのリブランディング(表示文言・配色のみ。DBスキーマ・API契約への変更なし)
  - 追加された `walletRegistrationLink.ts` は本指示書のPR-SM5(Wallet内デジタルコレクションへの移行)と関連領域のため、着手時に既存実装として確認が必要。
- 未コミット差分: なし(作業ツリークリーン、`git status --short`で確認済み)
- 作業用ブランチ: `claude/confirmation-needed-3wicju`(直近2件のPRのマージ元。現在は`main`と同じ内容)
- デプロイ先: Vercelプロジェクト `stockbusinessjp-gmailcoms-projects/sengokumarket`、本番ドメイン `www.sengoku-rr.com`(GitHub Checks上のVercelデプロイ結果から確認)

## 2. 本番相当環境のフラグ(要提供)

このセッションはVercel本番環境変数への直接アクセスを持たないため、**実際に本番で設定されている値は確認できていません**。コード上の既定値(未設定時の挙動)のみ以下に示します。

| フラグ | コード上の既定(未設定時) | 参照箇所 |
|---|---|---|
| `PURCHASE_PROVISIONING_ENABLED` | `false`(`=== 'true'`判定) | `server/src/services/purchaseProvisioningConfig.ts` |
| `AGENCY_PORTAL_LOGIN_ENABLED` | `false`(同上) | 同上 |
| `SENNOKUNI_INTEGRATION_ENABLED` | `false` | `server/.env.example` |
| `ENABLE_WALLET_CLAIM` | `false` | `server/.env.example` |
| `ENABLE_DIGITAL_COLLECTIBLE_DELIVERY` | `false` | `server/.env.example` |
| `NFT_MINT_PROVIDER` | `fake`(擬似プロバイダー) | `server/.env.example` |

**要提供**: Vercel本番環境(Production)の上記6項目の実際の設定値。前セッションのCrossmint設定作業では管理画面(`/admin/settings`)経由で`NFT_MINT_PROVIDER=crossmint`が設定された記録があるため、少なくともこの項目は`.env.example`の既定値`fake`から本番で変更されている可能性が高い。実値の確認が必要。

## 3. Supabase migration適用状況(要提供)

このセッションは本番Supabaseへの接続情報を持たないため、実際の適用済み/未適用/driftは確認できていません。リポジトリにコミット済みのmigrationは43件、最新は以下の2件(いずれも本セッションで追加、PR #4以降):

- `20260728225435_purchase_agency_provisioning`(PR #4、`purchase_provisioning_jobs`等)
- `20260730105053_wallet_registration_links`(PR #6系列、ウォレット登録リンク)

過去のPR #4本文には「マイグレーション `20260728225435_purchase_agency_provisioning` は本番Supabaseへ未適用のため、マージ後に手動SQL適用が必要」との記載があり、**この時点で本番への手動適用が完了していたかどうかは未確認**。`20260730105053_wallet_registration_links`についても同様に本番適用状況は未確認。

**要提供**: `npx prisma migrate status`相当の本番実行結果、またはSupabase管理画面のmigration履歴。

## 4. Outbox/Job系テーブルの状態別件数(要提供)

`integration_outbox_events`・`order_linking_jobs`・`purchase_provisioning_jobs`の状態別件数・最古作成日時は本番DBへの接続がなければ取得できません。

参考情報として、これらを処理するバックグラウンドジョブ(cron)はGitHub Actions経由で稼働中であることをCI/Actions履歴から確認済み:
- `Dispatch background jobs (primary)`(`dispatch-cron.yml`): 定期実行、直近実行はすべて成功
- `Dispatch background jobs (fallback)`(`dispatch-cron-fallback.yml`): 同上

これは「配送パイプライン自体は動作可能な状態にある」ことの傍証であり、実際に滞留・dead件数があるかどうかは別途本番DBクエリが必要。

**要提供**: 本番DBでの以下相当のクエリ結果。
```sql
select status, count(*), min(created_at) from integration_outbox_events group by status;
select status, count(*), min(created_at) from order_linking_jobs group by status;
select status, count(*), min(created_at) from purchase_provisioning_jobs group by status;
```

## 5. 実URL・署名方式・送信箇所(コードから確認済み)

| 連携 | 実装ファイル | パス | 署名方式 |
|---|---|---|---|
| common_user解決 | `server/src/services/externalCommonUserClient.ts` | `POST /api/common-users/resolve` | HMAC(`sennokuniHmac.ts`、canonical string 6行) |
| referral capture | `server/src/services/externalReferralClient.ts` | `POST /api/referrals/capture` | 同上 |
| referral confirm | 同上 | `POST /api/referrals/confirm` | 同上 |
| Agency購入者アカウント発行 | `server/src/services/externalPurchaseProvisioningClient.ts` | `POST /api/purchase-provisioning` | 同上(`SYSTEM_KEY='sengoku-market'`) |
| Agency権利取消(全額返金時) | 同上 | `POST /api/purchase-provisioning/revoke` | 同上 |
| OVEW Wallet向けentitlementイベント(granted/revoked) | `server/src/services/integrationOutboxDispatcher.ts` | `getIntegrationEndpointPath()`で宛先ごとに設定(DB設定値、既定未設定) | 同HMAC方式。未設定時は本番安定化指示書Stage8の暫定path `/shopping/webhook`にフォールバック |
| OVE Wallet報酬イベント(ove-wallet専用) | 同上(`OVE_WALLET_EVENTS_PATH`) | `POST /api/integrations/events` | 同HMAC方式(専用の認証情報`ove_wallet_events_*`) |
| 旧: 代理店階層取得(読み取り専用、廃止方向) | `server/src/services/externalAgencySystem.ts` | `GET {baseUrl}/api/hierarchy.php` | `x-api-key`ヘッダー(HMACではない、旧方式) |

共通事項:
- HMAC署名対象のcanonical stringは `key_id\ntimestamp\nnonce\nMETHOD\npath\nraw_body` の6行(Idempotency-Keyは署名対象に含めず、HTTPヘッダーとしてのみ送信)。
- いずれの送信も、DBコミット後のDispatcher(Outbox/Jobテーブル経由)からのみ行われ、Stripe Webhook処理へ同期的に追加されてはいない(`server/src/routes/stripeWebhook*.ts`にHTTP送信呼び出しなし)。
- `externalAgencySystem.ts`の`x-api-key`方式は、指示書が前提とするAgency側のHMAC契約と異なる旧実装であり、PR-SM3(既存Agency連携の契約監査・補正)で扱う対象と考えられる。

## 6. `agencies`/`referral_links`/`commissions`への書込み経路(コードから確認済み)

| テーブル | 書込み箇所 | 契機 |
|---|---|---|
| `agencies`(create) | `server/src/modules/agencies/infrastructure/prismaAgency.repository.ts` | 管理画面からの代理店新規登録(`upsertAgency` usecase経由) |
| `agencies`(create/update, 階層同期) | `server/src/services/agencyHierarchySync.ts` | 外部代理店管理システム(`externalAgencySystem.ts`)との階層同期処理 |
| `agencies`(create) | `server/src/services/agencySso.ts` | 代理店SSOログイン時の自動プロビジョニング |
| `agencies`(create, インライン) | `server/src/routes/admin/referralLinks.ts` | 「紹介リンク発行」画面での代理店その場新規作成 |
| `referral_links`(create) | `server/src/services/referralLinkService.ts` | 「紹介リンク発行」画面からの発行操作 |
| `referral_links`(update, statusのみ) | `server/src/routes/admin/referralLinks.ts` | inactive化(編集・削除は不可、CLAUDE.md記載の絶対禁止事項どおり) |
| `influencers`(create, インライン) | `server/src/services/referralLinkService.ts` | 同上、紹介リンク発行画面でのインフルエンサーその場新規作成 |
| `commissions`(create) | `server/src/services/orderFulfillment.ts` | 注文の決済確定(Webhook経由)時、報酬率3段階フォールバック解決後にスナップショット作成 |

現在の運用利用有無(実際にこれらの画面・APIが本番で使われているか)は本番アクセスログ等がなければ断定できないため**要確認**。ただしコード上、これらはいずれも通常運用の管理画面機能として実装されており、Feature Flagによる無効化はされていない(指示書PR-SM2が新設しようとしている「Market内代理店・報酬の新規利用停止」フラグは、現時点のコードには**まだ存在しない**)。

## 7. 商品一覧(商品コード・種別・owner system・報酬対象・Agencyアクセス種別)

**`owner_system_key`相当のフィールドは現在の`Product`スキーマに存在しません**(`server/prisma/schema.prisma`確認済み)。指示書PR-SM1で新設が必要な項目そのものであり、現状ではコード上「戦国マーケットの商品」と「NFT作品マーケット(`sennokunnft`)所有の商品」を機械的に区別する手段がありません。

現行`Product`モデルで確認できる関連フィールド:

| フィールド | 内容 |
|---|---|
| `itemType` | `nft \| physical \| service \| membership \| fee` |
| `salesModel` | `direct_allowed \| agent_required \| hybrid`(既存商品はすべて`hybrid`で初期化) |
| `agencyAccessMode` | `none \| customer_portal \| agent_portal`(既定`none`。PR-SM関連ではなくPR #4の購入後代理店連携指示書由来) |
| `agencyRole` / `agencyProductCode` | `agencyAccessMode='agent_portal'`のときのみ必須(DB CHECK制約あり) |

実際の商品カタログ(商品コード・件数・現在の`agencyAccessMode`分布)は本番DBのデータであり、このセッションからは取得できません。

**要提供**: 本番DBでの商品一覧クエリ結果、または管理画面(`/admin/products`)からのエクスポート。

## 8. 最新mainのCI・Vercelデプロイ状態(GitHub上で確認済み)

- 最新コミット `297b569`(PR #6マージ)時点のCI(`ci.yml`): **success**
- 同コミットのVercel Deploymentチェック: **success**(Ready、Preview URL経由で確認)
- バックグラウンドジョブcron(`dispatch-cron.yml`/`dispatch-cron-fallback.yml`): 直近の全実行が**success**(定期的に稼働中)
- staging専用のE2Eワークフローは、確認した範囲では見つからず(CIワークフロー名は`CI`のみ)。**要確認**: staging環境自体の有無、E2Eの実施有無・実施主体。

## まとめ・次のアクション

- コードレベルで確認可能な5項目(1・5・6・7の一部・8)は本ドラフトに記載済み。
- 本番環境の実値・実データが必要な項目(2の実値、3、4、7の実データ)は、統合責任者または運用担当者からの提供が必要。
- 特に**指示書の調査基準commitと現在の`main`に差分がある**(項目1)ことは、着手前に統合責任者へ共有・確認すべき重要事項。
- 上記がすべて揃い、統合責任者の承認が得られるまで、コード変更・migration作成/適用・フラグ変更・マージ・デプロイは行わない。
