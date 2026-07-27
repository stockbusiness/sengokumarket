import crypto from 'crypto';
import type { IntegrationOutboxEvent, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  isSennokuniIntegrationEnabled,
  getSennokuniHubCredentials,
  getIntegrationEndpointBaseUrl,
  getIntegrationEndpointPath,
  getSennokuniIntegrationStage,
  type SennokuniIntegrationStage,
} from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';
import { grantReward, reverseReward } from './oveWalletRewardClient';
import { hashOutboxPayload, enqueueDigitalCollectibleEvent } from './integrationOutbox';
import { getOveWalletEventsCredentials, isDigitalCollectibleDeliveryEnabled } from './walletClaimConfig';
import { DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE } from './digitalCollectible';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT 9章・2026-07-22指示書対応):
// integration_outbox_eventsの実送信ディスパッチャ。NFT自動発行の既存cron(nftMintProcessing.ts)と
// 同じ「条件付きUPDATEによるアトミックなclaim + 指数バックオフ + 最大試行超過でdead」設計を踏襲する。
// SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出してもpending件数を数えるだけで
// 実送信は一切発生しない("Feature Flagでdormantなコード"という方針)。
//
// 残課題指示書Stage7: 1バッチあたりの件数・送信先ごとの上限・claim所有権(processing_token)・
// Function実行時間の監視・試行履歴の記録を強化した。

const BATCH_LIMIT = 10;
// 外部APIごとの同時実行上限(1回のdispatch呼び出しで同一destination_system_keyから
// claimする最大件数)。Dispatcher自体は逐次処理だが、cronと即時実行が重なった場合でも
// 1つの送信先へ集中しすぎないようにする。
const PER_DESTINATION_BATCH_LIMIT = 5;
const MAX_ATTEMPTS = 5;
// 5→10→20→40→60分(以降は60分キャップ)。NFT自動発行(nftMintProcessing.ts)と同じ指数バックオフ。
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

// Functionの残り時間に余裕がない場合は新規claimを打ち切る(9.2「実行時間」)。Vercelのプラン
// (Function timeout)によって安全な値が変わるため環境変数で調整可能にし、既定値は保守的に
// 短め(Hobbyプランの制限時間を意識した値)にしておく。呼び出しごとに読み直すことで、
// デプロイし直さずに調整できるようにする(isSennokuniIntegrationEnabledと同じ方針)。
function getTimeBudgetMs(): number {
  const raw = process.env.INTEGRATION_OUTBOX_TIME_BUDGET_MS;
  if (raw === undefined) return 8000;
  const parsed = Number(raw);
  // "0"(即座に打ち切り、テスト用途)も有効な設定値として扱うため、`||`ではなくisFiniteで判定する。
  return Number.isFinite(parsed) ? parsed : 8000;
}

export interface DispatchOutboxResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  skipped: number;
  blocked: number;
}

function generateProcessingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function dispatchPendingOutboxEvents(): Promise<DispatchOutboxResult> {
  const result: DispatchOutboxResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 };

  if (!isSennokuniIntegrationEnabled()) return result;

  // 本番安定化指示書Stage8(11.4「段階化」): dry_runでは実送信を一切行わず、署名・payload・
  // URLの生成とvalidationのみ行う(sendOutboxEvent内で分岐する)。
  const stage = await getSennokuniIntegrationStage();

  const dispatchStartedAt = Date.now();

  // 1) staleなprocessing行(クラッシュ等で放置)を先にpending・token解除の状態へ戻す。
  // processing_started_atを基準にすることで、Stage3/4/notification_outbox_events・
  // order_linking_jobsと同じ検知方法に揃える。
  await prisma.integrationOutboxEvent.updateMany({
    where: { status: 'processing', processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    data: { status: 'pending', processingToken: null, processingStartedAt: null },
  });

  // 2) 送信対象をclaimして送信する。残課題指示書Stage6: blocked行も毎回再評価対象に含めることで、
  // 必須ID解決後に自動的に送信を再開できるようにする(8.4「ID解決後に自動再開」)。
  const candidates = await prisma.integrationOutboxEvent.findMany({
    where: { status: { in: ['pending', 'blocked'] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT * 10, // 送信先ごとの上限を後段でJS側から適用するため、やや広めに候補を取得する。
  });

  const perDestinationCount = new Map<string, number>();
  const rowsToProcess: IntegrationOutboxEvent[] = [];
  for (const row of candidates) {
    if (rowsToProcess.length >= BATCH_LIMIT) break;
    const count = perDestinationCount.get(row.destinationSystemKey) ?? 0;
    if (count >= PER_DESTINATION_BATCH_LIMIT) continue;
    perDestinationCount.set(row.destinationSystemKey, count + 1);
    rowsToProcess.push(row);
  }

  for (const row of rowsToProcess) {
    if (Date.now() - dispatchStartedAt >= getTimeBudgetMs()) {
      // 9.2「実行時間」: Functionの残り時間に余裕がないため、これ以上は新規claimしない
      // (claim済みでない行はpending/blockedのまま残り、次回のdispatchで再評価される)。
      break;
    }

    const processingToken = generateProcessingToken();
    const claim = await prisma.integrationOutboxEvent.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'processing', processingToken, processingStartedAt: new Date() },
    });
    if (claim.count === 0) {
      result.skipped++;
      continue;
    }
    result.claimed++;
    await sendAndRecordResult({ ...row, status: 'processing', processingToken }, result, stage);
  }

  return result;
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「再試行」): cronは日次実行のため、backoffの初期値
// (5分)との乖離が大きい。決済確定・返金等でentitlement Outboxへenqueueした直後にも
// ベストエフォートで即時ディスパッチを試みることで、多くの送信はcronを待たずに完了させ、
// cronは主に「取りこぼし・失敗時の再試行」のセーフティネットとして機能させる
// (NFT自動発行のtriggerImmediateNftMintProcessingと同じ考え方)。
export async function triggerImmediateOutboxDispatch(): Promise<void> {
  try {
    await dispatchPendingOutboxEvents();
  } catch (e) {
    console.error('immediate integration outbox dispatch failed', { error: e });
  }
}

// 仕様書外の拡張(残課題指示書Stage6・8.2推奨順位1〜3): 送信直前に注文の最新状態を再取得し、
// enqueue時点でスナップショットしたcommon_user_id等が古いままpayloadに焼き付いていないか
// 補正する。product_integration_rulesの必須ID設定(8.3)のうち未解決のものがあれば、送信せず
// blocked(理由付き)として返す。order_idを持たない(=entitlement系ではない)イベントは対象外。
async function reconcileEntitlementFields(
  event: IntegrationOutboxEvent,
): Promise<{ blockedReason: string | null; effectivePayload: Record<string, unknown> }> {
  // 本番安定化指示書Stage7(10.2): 再取得のたびにoriginal_payload(enqueue時点、以後不変)を
  // 基準にする。delivery_payloadを基準にすると、以前の再取得結果(古いcommon_user_id等)が
  // 積み重なって残ってしまう可能性があるため。
  const payload = event.originalPayload as Record<string, unknown>;
  const orderId = typeof payload.order_id === 'string' ? payload.order_id : null;
  if (!orderId) return { blockedReason: null, effectivePayload: payload };

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return { blockedReason: null, effectivePayload: payload };

  const effectivePayload: Record<string, unknown> = {
    ...payload,
    common_user_id: order.commonUserId,
    sales_agent_id: order.salesAgentCode,
    closing_agent_id: order.closingAgentCode,
    referral_session_key: order.referralSessionKey,
    registration_referrer_agency_id: order.registrationReferrerAgentCode,
    assigned_agency_id: order.assignedAgentCode,
  };

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)18章: ENABLE_DIGITAL_COLLECTIBLE_DELIVERY
  // (既定false)はSENNOKUNI_INTEGRATION_ENABLEDとは独立したキルスイッチ。後者が有効でも、こちらが
  // 無効の間はdigital_collectibleイベントを送信せずblockedのまま保留する(WalletClaim・
  // CollectibleDeliveryの作成自体はこのFlagと無関係に行われる)。
  if (payload.entitlement_type === DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE && !isDigitalCollectibleDeliveryEnabled()) {
    return { blockedReason: 'digital_collectible_delivery_disabled', effectivePayload };
  }

  // 本番安定化指示書Stage6(9.2): 1商品に複数ルールを持てるようになったため、product_idではなく
  // enqueue時点でスナップショットしたルールidで再取得する(product_idだけではどのルールに
  // 基づくイベントか一意に特定できない)。
  const ruleId = typeof payload.product_integration_rule_id === 'string' ? payload.product_integration_rule_id : null;
  const rule = ruleId ? await prisma.productIntegrationRule.findUnique({ where: { id: ruleId } }) : null;
  if (!rule) return { blockedReason: null, effectivePayload };
  if (!rule.enabled) return { blockedReason: 'integration_rule_disabled', effectivePayload };

  if (rule.requireCommonUserId && !order.commonUserId) return { blockedReason: 'common_user_unresolved', effectivePayload };
  if (rule.requireSalesAgentId && !order.salesAgentCode) return { blockedReason: 'sales_agent_unresolved', effectivePayload };
  if (rule.requireClosingAgentId && !order.closingAgentCode) return { blockedReason: 'closing_agent_unresolved', effectivePayload };
  if (rule.requireReferralSessionKey && !order.referralSessionKey) {
    return { blockedReason: 'referral_session_unresolved', effectivePayload };
  }

  return { blockedReason: null, effectivePayload };
}

// 仕様書外の拡張(残課題指示書Stage7): 送信先からの非2xx応答等、HTTPステータスを持つ失敗を
// 試行履歴(integration_event_attempts.http_status)へ記録できるようにする。
// 本番安定化指示書Stage7(10.3): 送信先URL・応答本文の抜粋(秘密情報は含めない)も持たせる。
class OutboxSendError extends Error {
  httpStatus?: number;
  destinationUrl?: string | null;
  responseBodyExcerpt?: string | null;
  constructor(message: string, opts?: { httpStatus?: number; destinationUrl?: string | null; responseBodyExcerpt?: string | null }) {
    super(message);
    this.name = 'OutboxSendError';
    this.httpStatus = opts?.httpStatus;
    this.destinationUrl = opts?.destinationUrl ?? null;
    this.responseBodyExcerpt = opts?.responseBodyExcerpt ?? null;
  }
}

// 本番安定化指示書Stage10(13.2〜13.4): OVE Walletのgrant/reversal成功時、order_wallet_transactions
// へ1行追記するための情報。sendToOveWallet(DB書き込みを持たない)から呼び出し元
// (sendAndRecordResult)へ橋渡しし、outbox eventの成功更新と同一トランザクションで書き込む。
interface WalletTransactionOutcome {
  orderId: string;
  orderItemId: string;
  productIntegrationRuleId: string | null;
  commonUserId: string | null;
  transactionType: 'grant' | 'reversal';
  amount: number;
  rewardRuleId: string | null;
  walletTransactionId: string | null;
  originalWalletTransactionId: string | null;
}

interface SendOutcome {
  destinationUrl: string | null;
  responseBodyExcerpt: string | null;
  walletTransaction?: WalletTransactionOutcome;
}

async function sendAndRecordResult(
  event: IntegrationOutboxEvent,
  result: DispatchOutboxResult,
  stage: SennokuniIntegrationStage,
): Promise<void> {
  const processingToken = event.processingToken!;
  const { blockedReason, effectivePayload } = await reconcileEntitlementFields(event);
  // 本番安定化指示書Stage7(10.1・10.2): delivery_payloadを更新する際は必ずhashも
  // 再計算する(保存payloadとhashが一致しない不整合を防ぐ)。
  const deliveryPayloadHash = hashOutboxPayload(effectivePayload);

  if (blockedReason) {
    // blockedは「送信を試みていない」状態のため、試行履歴(integration_event_attempts)には残さない。
    await prisma.integrationOutboxEvent.updateMany({
      where: { id: event.id, status: 'processing', processingToken },
      data: { status: 'blocked', blockedReason, deliveryPayload: effectivePayload as Prisma.InputJsonValue, deliveryPayloadHash },
    });
    result.blocked++;
    return;
  }

  // 最終安定化指示書Phase1(返金とカード送付の競合防止): digital_collectibleのgrant送信直前に
  // 返金・取消が既に決まっていないか再確認する。ここで検知できれば、外部Wallet APIへの送信自体を
  // 避けられる(以降の「2xx受信後」チェックは、この確認をすり抜けて送信中に返金された場合の保険)。
  const isDigitalCollectibleGrant =
    effectivePayload.entitlement_type === DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE && event.eventType === 'entitlement.granted';
  const collectibleDelivery = isDigitalCollectibleGrant
    ? await prisma.collectibleDelivery.findFirst({ where: { outboxEventId: event.id } })
    : null;

  if (isDigitalCollectibleGrant && collectibleDelivery) {
    const orderId = typeof effectivePayload.order_id === 'string' ? effectivePayload.order_id : null;
    const guard = orderId ? await checkDigitalCollectibleRefundGuard(prisma, orderId) : { blocked: false };
    if (guard.blocked) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.integrationOutboxEvent.updateMany({
          where: { id: event.id, status: 'processing', processingToken },
          data: {
            status: 'blocked',
            blockedReason: 'wallet_claim_refunded_before_send',
            deliveryPayload: effectivePayload as Prisma.InputJsonValue,
            deliveryPayloadHash,
            processingToken: null,
            processingStartedAt: null,
          },
        });
        if (updated.count > 0) {
          await tx.collectibleDelivery.updateMany({
            where: { id: collectibleDelivery.id, status: { not: 'REVOKED' } },
            data: { status: 'REVOKED', revokedAt: new Date(), lastError: 'wallet_claim_refunded_before_send' },
          });
        }
      });
      result.blocked++;
      return;
    }

    // 送信直前にPROCESSINGへ進める。返金処理側(applyWalletClaimRefundEffects)はこの状態を見て、
    // 送信中の可能性がある行を強制変更せず注記のみ残す(処理中の外部呼び出しと競合させないため)。
    await prisma.collectibleDelivery.updateMany({
      where: { id: collectibleDelivery.id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
  }

  const effectiveEvent: IntegrationOutboxEvent = { ...event, deliveryPayload: effectivePayload as Prisma.JsonValue };
  const attemptNumber = event.attemptCount + 1;
  const startedAt = new Date();

  try {
    const outcome = await sendOutboxEvent(effectiveEvent, stage);
    await recordAttempt({
      event,
      attemptNumber,
      startedAt,
      processingToken,
      result: 'succeeded',
      httpStatus: null,
      error: null,
      requestPayloadHash: deliveryPayloadHash,
      destinationUrl: outcome.destinationUrl,
      responseBodyExcerpt: outcome.responseBodyExcerpt,
    });
    // 古いclaim(stale再クレーム後に別プロセスが先に処理した等)が、後から届いた新しい結果を
    // 上書きしないよう、processing・同一tokenであることを条件にする(9.3「古い処理が新しい
    // 結果を上書きしない」)。
    const finalPayload = effectiveEvent.deliveryPayload as Record<string, unknown>;
    // 本番安定化指示書Stage10(13.3): OVE Walletのgrant/reversal成功時はorder_wallet_transactions
    // への追記をoutbox eventの成功更新と同一トランザクションで行う(片方だけ反映される状態を防ぐ)。
    await prisma.$transaction(async (tx) => {
      const updated = await tx.integrationOutboxEvent.updateMany({
        where: { id: event.id, status: 'processing', processingToken },
        data: {
          status: 'succeeded',
          processedAt: new Date(),
          lastError: null,
          blockedReason: null,
          deliveryPayload: finalPayload as Prisma.InputJsonValue,
          deliveryPayloadHash: hashOutboxPayload(finalPayload),
          processingToken: null,
          processingStartedAt: null,
        },
      });
      if (updated.count > 0 && outcome.walletTransaction) {
        const wt = outcome.walletTransaction;
        await tx.orderWalletTransaction.create({
          data: {
            orderId: wt.orderId,
            orderItemId: wt.orderItemId,
            outboxEventId: event.id,
            productIntegrationRuleId: wt.productIntegrationRuleId,
            commonUserId: wt.commonUserId,
            transactionType: wt.transactionType,
            amount: wt.amount,
            rewardRuleId: wt.rewardRuleId,
            walletTransactionId: wt.walletTransactionId,
            originalWalletTransactionId: wt.originalWalletTransactionId,
            idempotencyKey: event.eventId,
            status: 'succeeded',
          },
        });
      }
      if (updated.count > 0 && finalPayload.entitlement_type === DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE && event.eventType === 'entitlement.granted') {
        // 最終安定化指示書Phase1: 2xx受信後、DELIVERED反映の直前にもう一度返金・取消状態を
        // 確認する(送信中に返金されたが外部側ではgrantが成功してしまった場合の検知)。
        const orderId = typeof finalPayload.order_id === 'string' ? finalPayload.order_id : null;
        const guard = orderId ? await checkDigitalCollectibleRefundGuard(tx, orderId) : { blocked: false };
        if (guard.blocked) {
          await enqueueCompensatingRevoke(tx, event.id, finalPayload);
        } else {
          await syncCollectibleDeliveryOnSend(tx, event.id, event.eventType, 'succeeded', null);
        }
      } else if (updated.count > 0 && finalPayload.entitlement_type === DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE) {
        await syncCollectibleDeliveryOnSend(tx, event.id, event.eventType, 'succeeded', null);
      }
    });
    result.succeeded++;
  } catch (e) {
    const httpStatus = e instanceof OutboxSendError ? (e.httpStatus ?? null) : null;
    const destinationUrl = e instanceof OutboxSendError ? (e.destinationUrl ?? null) : null;
    const responseBodyExcerpt = e instanceof OutboxSendError ? (e.responseBodyExcerpt ?? null) : null;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    await recordAttempt({
      event,
      attemptNumber,
      startedAt,
      processingToken,
      result: 'failed',
      httpStatus,
      error: message,
      requestPayloadHash: deliveryPayloadHash,
      destinationUrl,
      responseBodyExcerpt,
    });

    const isCollectible = effectivePayload.entitlement_type === DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE;

    if (attemptNumber >= MAX_ATTEMPTS) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.integrationOutboxEvent.updateMany({
          where: { id: event.id, status: 'processing', processingToken },
          data: {
            status: 'dead',
            attemptCount: attemptNumber,
            lastError: message,
            blockedReason: null,
            deliveryPayload: effectivePayload as Prisma.InputJsonValue,
            deliveryPayloadHash,
            processingToken: null,
            processingStartedAt: null,
          },
        });
        // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)15章「最大試行超過」:
        // CollectibleDelivery=DEAD(管理者手動再送が必要)。
        if (updated.count > 0 && isCollectible) {
          await syncCollectibleDeliveryOnSend(tx, event.id, event.eventType, 'dead', message);
        }
      });
      result.dead++;
    } else {
      const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptNumber - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.$transaction(async (tx) => {
        const updated = await tx.integrationOutboxEvent.updateMany({
          where: { id: event.id, status: 'processing', processingToken },
          data: {
            status: 'pending',
            attemptCount: attemptNumber,
            lastError: message,
            blockedReason: null,
            deliveryPayload: effectivePayload as Prisma.InputJsonValue,
            deliveryPayloadHash,
            processingToken: null,
            processingStartedAt: null,
            nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000),
          },
        });
        // 15章「送信失敗」: Outboxはretryを続けつつ、CollectibleDelivery=FAILED・last_error保存。
        if (updated.count > 0 && isCollectible) {
          await syncCollectibleDeliveryOnSend(tx, event.id, event.eventType, 'failed', message);
        }
      });
      result.retrying++;
    }
  }
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「試行履歴」): 実際に送信を試みた回(成功・失敗いずれも)
// を1行記録する。管理画面での障害調査・監査用。
async function recordAttempt(input: {
  event: IntegrationOutboxEvent;
  attemptNumber: number;
  startedAt: Date;
  processingToken: string;
  result: 'succeeded' | 'failed';
  httpStatus: number | null;
  error: string | null;
  // 本番安定化指示書Stage7(10.3): この試行で実際に送信を試みたdelivery_payloadのhash・
  // 送信先URL・応答本文の抜粋(取得できない経路ではnull)。
  requestPayloadHash: string;
  destinationUrl: string | null;
  responseBodyExcerpt: string | null;
}): Promise<void> {
  await prisma.integrationEventAttempt.create({
    data: {
      outboxEventId: input.event.id,
      attemptNumber: input.attemptNumber,
      startedAt: input.startedAt,
      finishedAt: new Date(),
      httpStatus: input.httpStatus,
      result: input.result,
      error: input.error,
      processingToken: input.processingToken,
      requestPayloadHash: input.requestPayloadHash,
      destinationUrl: input.destinationUrl,
      responseBodyExcerpt: input.responseBodyExcerpt,
    },
  });
}

// 最終安定化指示書Phase1: digital_collectibleのgrant送信前後で、注文の返金・WalletClaimの
// 取消が既に決まっていないかを確認する。返金済み・REVOKED/REVOCATION_PENDING/
// MANUAL_REVIEW_REQUIREDのいずれかであれば送付を進めてはならない。
async function checkDigitalCollectibleRefundGuard(
  client: Prisma.TransactionClient,
  orderId: string,
): Promise<{ blocked: boolean }> {
  const order = await client.order.findUnique({ where: { id: orderId } });
  if (order && (order.paymentStatus === 'refunded' || order.orderStatus === 'refunded')) {
    return { blocked: true };
  }

  const claim = await client.walletClaim.findUnique({ where: { orderId } });
  if (claim && ['REVOKED', 'REVOCATION_PENDING', 'MANUAL_REVIEW_REQUIRED'].includes(claim.status)) {
    return { blocked: true };
  }

  return { blocked: false };
}

// 最終安定化指示書Phase1: entitlement.grantedが2xxで成功した直後に返金が判明した場合の
// 補償取消。DELIVERED反映は行わず、同じNftIssue宛のentitlement.revokedを1件だけenqueueする
// (deduplication_keyで多重送信中の重複作成を防ぐ)。WalletClaimはREVOCATION_PENDINGへ進める
// (既にREVOKED/MANUAL_REVIEW_REQUIREDならそのままにする)。
async function enqueueCompensatingRevoke(
  tx: Prisma.TransactionClient,
  grantedOutboxEventId: string,
  finalPayload: Record<string, unknown>,
): Promise<void> {
  const delivery = await tx.collectibleDelivery.findFirst({ where: { outboxEventId: grantedOutboxEventId } });
  if (!delivery) return;
  // 既に取消済み・取消送信中なら何もしない(このgranted成功反映自体が既に古い可能性がある)。
  if (delivery.status === 'REVOKED') return;

  const nftIssue = await tx.nftIssue.findUnique({ where: { id: delivery.nftIssueId } });
  if (!nftIssue) return;
  const orderItem = await tx.orderItem.findUnique({ where: { id: nftIssue.orderItemId } });
  const claimItem = await tx.walletClaimItem.findUnique({ where: { nftIssueId: nftIssue.id } });
  const orderId = typeof finalPayload.order_id === 'string' ? finalPayload.order_id : null;
  const order = orderId ? await tx.order.findUnique({ where: { id: orderId } }) : null;
  if (!orderItem || !claimItem || !order) return;

  const revokeOutboxEventId = await enqueueDigitalCollectibleEvent(tx, {
    order,
    orderItem,
    nftIssue,
    claimItem,
    commonUserId: delivery.commonUserId,
    eventType: 'entitlement.revoked',
    deduplicationKey: `digital-collectible-revoke:${nftIssue.id}`,
  });
  await tx.collectibleDelivery.update({ where: { id: delivery.id }, data: { outboxEventId: revokeOutboxEventId } });

  await tx.walletClaimAuditLog.create({
    data: {
      walletClaimId: delivery.walletClaimId,
      orderId: order.id,
      eventType: 'compensating_revoke_enqueued',
      detail: { nftIssueId: nftIssue.id, grantedOutboxEventId },
    },
  });

  await tx.walletClaim.updateMany({
    where: { id: delivery.walletClaimId, status: { notIn: ['REVOKED', 'MANUAL_REVIEW_REQUIRED'] } },
    data: { status: 'REVOCATION_PENDING' },
  });
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)15章「送付結果」: digital_collectible
// イベントの送信結果をCollectibleDelivery(NftIssue単位)へ反映する。entitlement.grantedの成功は
// DELIVERED、entitlement.revokedの成功はREVOKED、失敗はFAILED(Outboxはretryを継続)、
// 最大試行超過はDEAD(管理者手動再送が必要)。outbox eventのステータス更新と同一トランザクションで
// 呼ぶことで、片方だけ反映される状態を防ぐ。
async function syncCollectibleDeliveryOnSend(
  tx: Prisma.TransactionClient,
  outboxEventId: string,
  eventType: string,
  outcome: 'succeeded' | 'failed' | 'dead',
  errorMessage: string | null,
): Promise<void> {
  const delivery = await tx.collectibleDelivery.findFirst({ where: { outboxEventId } });
  if (!delivery) return;

  if (outcome === 'failed') {
    await tx.collectibleDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', lastError: errorMessage } });
    return;
  }
  if (outcome === 'dead') {
    await tx.collectibleDelivery.update({ where: { id: delivery.id }, data: { status: 'DEAD', lastError: errorMessage } });
    return;
  }

  if (eventType === 'entitlement.revoked') {
    await tx.collectibleDelivery.update({
      where: { id: delivery.id },
      data: { status: 'REVOKED', revokedAt: new Date(), lastError: null },
    });

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase6(8.3「親状態同期」): 同じWalletClaimに
    // 属する全CollectibleDeliveryがREVOKEDになったらWalletClaim=REVOKEDへ進める(revoked_at設定)。
    // Mint済みでmanual_review_required注記のみ残った行がある場合は全件REVOKEDに到達しないため、
    // WalletClaimはREVOCATION_PENDINGのまま残り、管理者の確認が必要であることを示し続ける。
    const remaining = await tx.collectibleDelivery.count({
      where: { walletClaimId: delivery.walletClaimId, status: { not: 'REVOKED' } },
    });
    if (remaining === 0) {
      await tx.walletClaim.updateMany({
        where: { id: delivery.walletClaimId, status: 'REVOCATION_PENDING' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
    }
    return;
  }

  await tx.collectibleDelivery.update({
    where: { id: delivery.id },
    data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
  });

  // 15章「全Delivery成功」: 同じWalletClaimに属する全CollectibleDeliveryがDELIVEREDになったら
  // WalletClaim=DELIVEREDへ進める。
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase7(9章「claimedAtを上書きしない」): claimedAt
  // はClaim確認完了時刻(walletClaimConfirm.ts)の固定値であり、ここではdeliveredAt(全Delivery
  // 完了日時)のみを設定する。
  const remaining = await tx.collectibleDelivery.count({
    where: { walletClaimId: delivery.walletClaimId, status: { not: 'DELIVERED' } },
  });
  if (remaining === 0) {
    await tx.walletClaim.updateMany({
      where: { id: delivery.walletClaimId, status: 'DELIVERY_PENDING' },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
  }
}

async function sendOutboxEvent(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  if (event.destinationSystemKey === 'ove-wallet') {
    const payload = event.deliveryPayload as { entitlement_type?: string };
    // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)14章: 送信先が同じove-walletでも、
    // entitlement_type=digital_collectibleはreward付与/取消(X-OVE-*方式)ではなく
    // Common Event API(共通契約 X-SenNoKuni-*方式)へ送る。既存のove_reward経路は変更しない。
    if (payload.entitlement_type === DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE) {
      return sendDigitalCollectibleToOveWallet(event, stage);
    }
    return sendToOveWallet(event, stage);
  }
  return sendViaCommonContract(event, stage);
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)14章: digital_collectible専用の
// Common Event API送信。sendViaCommonContract(パスポート・AIアート教室向け)と同じ共通契約
// (X-SenNoKuni-*)署名方式を使うが、宛先path・認証鍵はove_wallet_events_*専用のものを使う。
// 「業務項目はトップレベルに置き、data内だけに格納しない」(14章)ため、envelopeのdataに加えて
// 業務項目をトップレベルにも展開する。
const OVE_WALLET_EVENTS_PATH = '/api/integrations/events';

async function sendDigitalCollectibleToOveWallet(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  const credentials = await getOveWalletEventsCredentials();
  if (!credentials) throw new Error('ove-wallet events HMAC credentials are not configured');

  const payload = event.deliveryPayload as Record<string, unknown> & { common_user_id?: string | null };
  const method = 'POST';
  const envelope = {
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    occurred_at: event.createdAt.toISOString(),
    source_system_key: 'sengoku-market',
    common_user_id: payload.common_user_id ?? null,
    correlation_id: event.correlationId,
    ...payload,
    data: payload,
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: OVE_WALLET_EVENTS_PATH,
    rawBody,
    eventVersion: event.eventVersion,
    idempotencyKey: event.eventId,
    correlationId: event.correlationId ?? undefined,
  });

  const destinationUrl = `${credentials.baseUrl}${OVE_WALLET_EVENTS_PATH}`;

  if (stage === 'dry_run') {
    return { destinationUrl, responseBodyExcerpt: '[DRY_RUN] validated only, not sent (digital_collectible)' };
  }

  let res: Response;
  try {
    res = await fetch(destinationUrl, { method, headers, body: rawBody, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new OutboxSendError(e instanceof Error ? e.message : String(e), { destinationUrl });
  }

  const responseBodyExcerpt = await res
    .text()
    .then((t) => t.slice(0, 500))
    .catch(() => null);

  if (!res.ok) {
    throw new OutboxSendError(`destination returned non-2xx: ${res.status}`, { httpStatus: res.status, destinationUrl, responseBodyExcerpt });
  }

  return { destinationUrl, responseBodyExcerpt };
}

// 仕様書外の拡張: OVE Walletはentitlement.granted/revokedという概念を持たず、reward付与・取消
// (grant/REVERSAL)というAPIを持つため、Outbox上のイベント種別をウォレットAPI呼び出しへ変換する。
// 本番安定化指示書Stage7(10.3): oveWalletRewardClient.tsは送信先URL・生の応答本文を返さない
// 抽象化されたクライアントのため、この経路ではdestinationUrl/responseBodyExcerptは取得できず
// 常にnullとなる(既知の制約。変更する場合はoveWalletRewardClient.tsのインターフェース自体の
// 見直しが必要なため、今回は対象外とする)。
async function sendToOveWallet(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  const payload = event.deliveryPayload as {
    order_id?: string;
    common_user_id?: string | null;
    source_user_id?: string | null;
    order_item_id?: string;
    product_integration_rule_id?: string | null;
    quantity?: number;
    reward_amount?: number;
    reward_rule_id?: string | null;
    correlation_id?: string;
  };

  if (event.eventType === 'entitlement.granted') {
    // 本番安定化指示書Stage6(9.4): 商品数量をそのままポイント数にしない。enqueue時点で
    // product_integration_rulesの設定(reward_calculation_mode等)に基づき計算済みの
    // reward_amountを使う(enqueueEntitlementEvents参照)。
    if (typeof payload.reward_amount !== 'number') {
      throw new Error('reward_amount is missing on entitlement.granted payload for ove-wallet');
    }

    // 本番安定化指示書Stage8(11.4「dry_run」): 実際にはgrantReward(実送信・実際にポイントが
    // 付与される)を呼ばず、必須項目のvalidationのみ行う。order_wallet_transactionsへも書かない
    // (dry_runでは実際の付与が起きていないため、後続のentitlement.revokedが誤って
    // 「取消対象が見つかった」と誤認しないようにするため)。
    if (stage === 'dry_run') {
      if (!payload.source_user_id) throw new Error('source_user_id is missing on entitlement.granted payload for ove-wallet');
      return { destinationUrl: null, responseBodyExcerpt: '[DRY_RUN] validated only, not sent (ove-wallet grant)' };
    }

    // order_wallet_transactionsへ書き込む前に検証する(外部への実送信・実際のポイント付与の
    // あとで検証に失敗すると、外部では成功しているのにローカルで追跡できない状態になるため)。
    if (!payload.order_id || !payload.order_item_id) {
      throw new Error('order_id/order_item_id is missing on entitlement.granted payload for ove-wallet');
    }

    const grantResult = await grantReward({
      externalUserId: payload.source_user_id ?? '',
      commonUserId: payload.common_user_id ?? null,
      amount: payload.reward_amount,
      rewardRuleId: payload.reward_rule_id ?? null,
      idempotencyKey: event.eventId,
      correlationId: payload.correlation_id ?? event.correlationId ?? event.eventId,
    });
    if (!grantResult) throw new Error('OVE wallet reward grant failed or not configured');

    // 本番安定化指示書Stage10(13.2・13.3): 原付与transaction IDはOutbox payloadではなく
    // 専用テーブル(order_wallet_transactions)へ保存する。呼び出し元(sendAndRecordResult)が
    // outbox eventの成功更新と同一トランザクションでまとめて書き込む。
    return {
      destinationUrl: null,
      responseBodyExcerpt: null,
      walletTransaction: {
        orderId: payload.order_id,
        orderItemId: payload.order_item_id,
        productIntegrationRuleId: payload.product_integration_rule_id ?? null,
        commonUserId: payload.common_user_id ?? null,
        transactionType: 'grant',
        amount: payload.reward_amount,
        rewardRuleId: payload.reward_rule_id ?? null,
        walletTransactionId: grantResult.transactionId,
        originalWalletTransactionId: null,
      },
    };
  }

  if (event.eventType === 'entitlement.revoked') {
    if (!payload.order_id || !payload.order_item_id) {
      throw new Error('order_id/order_item_id is missing on entitlement.revoked payload for ove-wallet');
    }

    // 本番安定化指示書Stage10(13.4): order_item_idだけでなく、enqueue時点でスナップショットした
    // product_integration_rule_idも一致条件にすることで、1商品に複数のOVE向けルールがあっても
    // 原付与を取り違えない。
    const priorGrant = await prisma.orderWalletTransaction.findFirst({
      where: {
        orderItemId: payload.order_item_id,
        productIntegrationRuleId: payload.product_integration_rule_id ?? null,
        transactionType: 'grant',
        status: 'succeeded',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!priorGrant?.walletTransactionId) {
      throw new Error('cannot reverse OVE wallet reward: no matching prior grant transaction found');
    }

    // 二重reversal防止(13.5): 同一の原付与に対してすでにreversal行が存在する場合は処理しない。
    const existingReversal = await prisma.orderWalletTransaction.findFirst({
      where: { originalWalletTransactionId: priorGrant.walletTransactionId, transactionType: 'reversal' },
    });
    if (existingReversal) {
      throw new Error('OVE wallet reward already reversed for this grant transaction');
    }

    if (stage === 'dry_run') {
      return { destinationUrl: null, responseBodyExcerpt: '[DRY_RUN] validated only, not sent (ove-wallet reversal)' };
    }

    const reversed = await reverseReward(priorGrant.walletTransactionId, 'entitlement revoked (refund)');
    if (!reversed) throw new Error('OVE wallet reward reversal failed');

    return {
      destinationUrl: null,
      responseBodyExcerpt: null,
      walletTransaction: {
        orderId: payload.order_id,
        orderItemId: payload.order_item_id,
        productIntegrationRuleId: payload.product_integration_rule_id ?? null,
        commonUserId: priorGrant.commonUserId,
        transactionType: 'reversal',
        amount: priorGrant.amount,
        rewardRuleId: priorGrant.rewardRuleId,
        walletTransactionId: null,
        originalWalletTransactionId: priorGrant.walletTransactionId,
      },
    };
  }

  throw new Error(`unsupported event type for ove-wallet: ${event.eventType}`);
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「正式URL」): パスポート・AIアート教室向けは共通契約
// (X-SenNoKuni-*)のイベントEnvelopeで送信する。受信pathは送信先ごとの設定値
// (getIntegrationEndpointPath)から取得し、コード固定しない。
// 本番安定化指示書Stage8(11.1・11.5): 未設定時の暫定path('/shopping/webhook')への
// 自動フォールバックは廃止した。未設定はfail-close(送信せず失敗させる)。
async function sendViaCommonContract(event: IntegrationOutboxEvent, stage: SennokuniIntegrationStage): Promise<SendOutcome> {
  const baseUrl = await getIntegrationEndpointBaseUrl(event.destinationSystemKey);
  if (!baseUrl) throw new Error(`no endpoint configured for destination: ${event.destinationSystemKey}`);

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) throw new Error('sennokuni HMAC credentials are not configured');

  const path = await getIntegrationEndpointPath(event.destinationSystemKey);
  if (!path) throw new Error(`no endpoint path configured for destination: ${event.destinationSystemKey}`);
  const method = 'POST';
  const payload = event.deliveryPayload as { common_user_id?: string | null };
  const envelope = {
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    occurred_at: event.createdAt.toISOString(),
    source_system_key: 'sengoku-market',
    common_user_id: payload.common_user_id ?? null,
    correlation_id: event.correlationId,
    data: event.deliveryPayload,
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  // HMAC署名対象pathと実送信pathが必ず一致するよう、同じ`path`変数を両方に使う(9.3受入条件)。
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path,
    rawBody,
    eventVersion: event.eventVersion,
    idempotencyKey: event.eventId,
    correlationId: event.correlationId ?? undefined,
  });

  const destinationUrl = `${baseUrl}${path}`;

  // 本番安定化指示書Stage8(11.4「dry_run」): ここまででURL・HMAC署名・payloadは実際に
  // 生成済み(validationも通過している)。実際のfetch()は行わず、検証のみで完了とする。
  if (stage === 'dry_run') {
    return { destinationUrl, responseBodyExcerpt: '[DRY_RUN] validated only, not sent' };
  }

  let res: Response;
  try {
    res = await fetch(destinationUrl, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OutboxSendError(e instanceof Error ? e.message : String(e), { destinationUrl });
  }

  // 本番安定化指示書Stage7(10.3): 応答本文の抜粋を試行履歴へ残す(秘密情報が含まれないよう
  // 短く切り詰める。送信先が秘密情報を返すことは想定していないが、念のため長さを制限する)。
  const responseBodyExcerpt =
    typeof res.text === 'function'
      ? await res
          .text()
          .then((t) => t.slice(0, 500))
          .catch(() => null)
      : null;

  if (!res.ok) {
    throw new OutboxSendError(`destination returned non-2xx: ${res.status}`, { httpStatus: res.status, destinationUrl, responseBodyExcerpt });
  }

  return { destinationUrl, responseBodyExcerpt };
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「手動再送」): 管理画面からのdead/failed/blocked/pending
// イベントの手動再送。既存の状態から条件付きUPDATEでprocessingへclaimし、通常のdispatchと同じ
// 経路(reconcile→blocked判定→送信→試行履歴記録)で1件だけ処理する。
export async function retryOutboxEvent(id: string): Promise<{ ok: boolean; status?: string }> {
  // Feature Flag無効時は手動再送であっても実送信を行わない(dispatchPendingOutboxEventsと
  // 同じ「Flag無効=常にdormant」という原則を管理操作にも一貫させる)。
  if (!isSennokuniIntegrationEnabled()) return { ok: false };

  const existing = await prisma.integrationOutboxEvent.findUnique({ where: { id } });
  if (!existing || existing.status === 'processing' || existing.status === 'succeeded') {
    return { ok: false };
  }

  const processingToken = generateProcessingToken();
  const claim = await prisma.integrationOutboxEvent.updateMany({
    where: { id, status: existing.status },
    data: { status: 'processing', processingToken, processingStartedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  const result: DispatchOutboxResult = { claimed: 1, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 };
  const stage = await getSennokuniIntegrationStage();
  await sendAndRecordResult({ ...existing, status: 'processing', processingToken }, result, stage);

  const refreshed = await prisma.integrationOutboxEvent.findUnique({ where: { id } });
  return { ok: true, status: refreshed?.status };
}
