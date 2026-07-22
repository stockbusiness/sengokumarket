import crypto from 'crypto';
import type { IntegrationOutboxEvent } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isSennokuniIntegrationEnabled, getSennokuniHubCredentials, getIntegrationEndpointBaseUrl } from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';
import { grantReward, reverseReward } from './oveWalletRewardClient';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT 9章・2026-07-22指示書対応):
// integration_outbox_eventsの実送信ディスパッチャ。NFT自動発行の既存cron(nftMintProcessing.ts)と
// 同じ「条件付きUPDATEによるアトミックなclaim + 指数バックオフ + 最大試行超過でdead」設計を踏襲する。
// SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出してもpending件数を数えるだけで
// 実送信は一切発生しない("Feature Flagでdormantなコード"という方針)。

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 5;
// 5→10→20→40→60分(以降は60分キャップ)。NFT自動発行(nftMintProcessing.ts)と同じ指数バックオフ。
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export interface DispatchOutboxResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  skipped: number;
}

export async function dispatchPendingOutboxEvents(): Promise<DispatchOutboxResult> {
  const result: DispatchOutboxResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0 };

  if (!isSennokuniIntegrationEnabled()) return result;

  // 1) staleなprocessing行(クラッシュ等で放置)を先にpendingへ戻す。
  const staleRows = await prisma.integrationOutboxEvent.findMany({
    where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    take: BATCH_LIMIT,
  });
  for (const row of staleRows) {
    await prisma.integrationOutboxEvent.updateMany({ where: { id: row.id, status: 'processing' }, data: { status: 'pending' } });
  }

  // 2) 送信対象(pending・next_attempt_at未到来でない)をclaimして送信する。
  const pendingRows = await prisma.integrationOutboxEvent.findMany({
    where: { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    take: BATCH_LIMIT,
  });

  for (const row of pendingRows) {
    const claimed = await prisma.integrationOutboxEvent.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'processing' } });
    if (claimed.count === 0) {
      result.skipped++;
      continue;
    }
    result.claimed++;
    await sendAndRecordResult(row, result);
  }

  return result;
}

async function sendAndRecordResult(event: IntegrationOutboxEvent, result: DispatchOutboxResult): Promise<void> {
  try {
    await sendOutboxEvent(event);
    await prisma.integrationOutboxEvent.update({ where: { id: event.id }, data: { status: 'succeeded', processedAt: new Date(), lastError: null } });
    result.succeeded++;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    const attemptCount = event.attemptCount + 1;
    if (attemptCount >= MAX_ATTEMPTS) {
      await prisma.integrationOutboxEvent.update({
        where: { id: event.id },
        data: { status: 'dead', attemptCount, lastError: message },
      });
      result.dead++;
    } else {
      const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.integrationOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'pending',
          attemptCount,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000),
        },
      });
      result.retrying++;
    }
  }
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
    await prisma.integrationOutboxEvent.update({
      where: { id: event.id },
      data: { payload: { ...(event.payload as Record<string, unknown>), ove_transaction_id: grantResult.transactionId } },
    });
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

// 仕様書外の拡張: パスポート・AIアート教室向けは共通契約(X-SenNoKuni-*)のイベントEnvelopeで送信する。
// 受信側の正式エンドポイントパスは契約確定待ちのため、AIアート教室側分析で確認できた
// `/shopping/webhook`を暫定的に両送信先で使う(確定次第、この1箇所を直せばよい設計にしている)。
const PROVISIONAL_EVENT_PATH = '/shopping/webhook';

async function sendViaCommonContract(event: IntegrationOutboxEvent): Promise<void> {
  const baseUrl = await getIntegrationEndpointBaseUrl(event.destinationSystemKey);
  if (!baseUrl) throw new Error(`no endpoint configured for destination: ${event.destinationSystemKey}`);

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) throw new Error('sennokuni HMAC credentials are not configured');

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
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: PROVISIONAL_EVENT_PATH,
    rawBody,
    eventVersion: event.eventVersion,
    idempotencyKey: event.eventId,
    correlationId: event.correlationId ?? undefined,
  });

  const res = await fetch(`${baseUrl}${PROVISIONAL_EVENT_PATH}`, {
    method,
    headers,
    body: rawBody,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`destination returned non-2xx: ${res.status}`);
  }
}
