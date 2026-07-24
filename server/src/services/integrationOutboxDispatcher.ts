import crypto from 'crypto';
import type { IntegrationOutboxEvent, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  isSennokuniIntegrationEnabled,
  getSennokuniHubCredentials,
  getIntegrationEndpointBaseUrl,
  getIntegrationEndpointPath,
} from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';
import { grantReward, reverseReward } from './oveWalletRewardClient';

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
    await sendAndRecordResult({ ...row, status: 'processing', processingToken }, result);
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
  const payload = event.payload as Record<string, unknown>;
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

  const productId = typeof payload.product_id === 'string' ? payload.product_id : null;
  const rule = productId ? await prisma.productIntegrationRule.findUnique({ where: { productId } }) : null;
  if (!rule) return { blockedReason: null, effectivePayload };

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
class OutboxSendError extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'OutboxSendError';
    this.httpStatus = httpStatus;
  }
}

async function sendAndRecordResult(event: IntegrationOutboxEvent, result: DispatchOutboxResult): Promise<void> {
  const processingToken = event.processingToken!;
  const { blockedReason, effectivePayload } = await reconcileEntitlementFields(event);
  if (blockedReason) {
    // blockedは「送信を試みていない」状態のため、試行履歴(integration_event_attempts)には残さない。
    await prisma.integrationOutboxEvent.updateMany({
      where: { id: event.id, status: 'processing', processingToken },
      data: { status: 'blocked', blockedReason, payload: effectivePayload as Prisma.InputJsonValue },
    });
    result.blocked++;
    return;
  }

  const effectiveEvent: IntegrationOutboxEvent = { ...event, payload: effectivePayload as Prisma.JsonValue };
  const attemptNumber = event.attemptCount + 1;
  const startedAt = new Date();

  try {
    await sendOutboxEvent(effectiveEvent);
    await recordAttempt({ event, attemptNumber, startedAt, processingToken, result: 'succeeded', httpStatus: null, error: null });
    // 古いclaim(stale再クレーム後に別プロセスが先に処理した等)が、後から届いた新しい結果を
    // 上書きしないよう、processing・同一tokenであることを条件にする(9.3「古い処理が新しい
    // 結果を上書きしない」)。
    await prisma.integrationOutboxEvent.updateMany({
      where: { id: event.id, status: 'processing', processingToken },
      data: {
        status: 'succeeded',
        processedAt: new Date(),
        lastError: null,
        blockedReason: null,
        payload: effectivePayload as Prisma.InputJsonValue,
        processingToken: null,
        processingStartedAt: null,
      },
    });
    result.succeeded++;
  } catch (e) {
    const httpStatus = e instanceof OutboxSendError ? (e.httpStatus ?? null) : null;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    await recordAttempt({ event, attemptNumber, startedAt, processingToken, result: 'failed', httpStatus, error: message });

    if (attemptNumber >= MAX_ATTEMPTS) {
      await prisma.integrationOutboxEvent.updateMany({
        where: { id: event.id, status: 'processing', processingToken },
        data: { status: 'dead', attemptCount: attemptNumber, lastError: message, blockedReason: null, processingToken: null, processingStartedAt: null },
      });
      result.dead++;
    } else {
      const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptNumber - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.integrationOutboxEvent.updateMany({
        where: { id: event.id, status: 'processing', processingToken },
        data: {
          status: 'pending',
          attemptCount: attemptNumber,
          lastError: message,
          blockedReason: null,
          processingToken: null,
          processingStartedAt: null,
          nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000),
        },
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
    },
  });
}

async function sendOutboxEvent(event: IntegrationOutboxEvent): Promise<void> {
  if (event.destinationSystemKey === 'ove-wallet') {
    return sendToOveWallet(event);
  }
  return sendViaCommonContract(event);
}

// 仕様書外の拡張: OVE Walletはentitlement.granted/revokedという概念を持たず、reward付与・取消
// (grant/REVERSAL)というAPIを持つため、Outbox上のイベント種別をウォレットAPI呼び出しへ変換する。
async function sendToOveWallet(event: IntegrationOutboxEvent): Promise<void> {
  const payload = event.payload as {
    common_user_id?: string | null;
    source_user_id?: string | null;
    order_item_id?: string;
    quantity?: number;
    correlation_id?: string;
  };

  if (event.eventType === 'entitlement.granted') {
    const grantResult = await grantReward({
      externalUserId: payload.source_user_id ?? '',
      commonUserId: payload.common_user_id ?? null,
      amount: payload.quantity ?? 1,
      rewardRuleId: null,
      idempotencyKey: event.eventId,
      correlationId: payload.correlation_id ?? event.correlationId ?? event.eventId,
    });
    if (!grantResult) throw new Error('OVE wallet reward grant failed or not configured');

    // 返金時のREVERSAL対象を追跡できるよう、成功した付与のtransaction_idをpayloadへ記録する。
    // 仕様書外の拡張として簡易に実装しているが、本来は専用のorder_wallet_transactionsテーブルで
    // 管理すべき情報であり(実装報告書の既知の未対応事項)、現時点での暫定対応にとどまる。
    // DBへは直接書かず、呼び出し元(sendAndRecordResult)が送信成功時にまとめて1回で永続化する
    // (残課題指示書Stage6でDispatcherがpayloadを再構築するようになったため、途中で個別に書き込むと
    // 後続の永続化で上書き・消失してしまうのを避けるため、メモリ上のオブジェクトを直接更新する)。
    (event.payload as Record<string, unknown>).ove_transaction_id = grantResult.transactionId;
    return;
  }

  if (event.eventType === 'entitlement.revoked') {
    const priorGrant = await prisma.integrationOutboxEvent.findFirst({
      where: {
        destinationSystemKey: 'ove-wallet',
        eventType: 'entitlement.granted',
        status: 'succeeded',
        payload: { path: ['order_item_id'], equals: payload.order_item_id },
      },
    });
    const priorPayload = priorGrant?.payload as { ove_transaction_id?: string } | undefined;
    if (!priorPayload?.ove_transaction_id) {
      throw new Error('cannot reverse OVE wallet reward: no matching prior grant transaction found');
    }
    const reversed = await reverseReward(priorPayload.ove_transaction_id, 'entitlement revoked (refund)');
    if (!reversed) throw new Error('OVE wallet reward reversal failed');
    return;
  }

  throw new Error(`unsupported event type for ove-wallet: ${event.eventType}`);
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「正式URL」): パスポート・AIアート教室向けは共通契約
// (X-SenNoKuni-*)のイベントEnvelopeで送信する。受信pathは送信先ごとの設定値
// (getIntegrationEndpointPath)から取得し、コード固定しない。未設定時のみ暫定値
// (/shopping/webhook)にフォールバックする。
async function sendViaCommonContract(event: IntegrationOutboxEvent): Promise<void> {
  const baseUrl = await getIntegrationEndpointBaseUrl(event.destinationSystemKey);
  if (!baseUrl) throw new Error(`no endpoint configured for destination: ${event.destinationSystemKey}`);

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) throw new Error('sennokuni HMAC credentials are not configured');

  const path = await getIntegrationEndpointPath(event.destinationSystemKey);
  const method = 'POST';
  const payload = event.payload as { common_user_id?: string | null };
  const envelope = {
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    occurred_at: event.createdAt.toISOString(),
    source_system_key: 'sengoku-market',
    common_user_id: payload.common_user_id ?? null,
    correlation_id: event.correlationId,
    data: event.payload,
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

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OutboxSendError(e instanceof Error ? e.message : String(e));
  }

  if (!res.ok) {
    throw new OutboxSendError(`destination returned non-2xx: ${res.status}`, res.status);
  }
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
  await sendAndRecordResult({ ...existing, status: 'processing', processingToken }, result);

  const refreshed = await prisma.integrationOutboxEvent.findUnique({ where: { id } });
  return { ok: true, status: refreshed?.status };
}
