import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

// 仕様書外の拡張(千ノ国全体統合 共通実装契約 2026-07-21 5.4章): Stripe Webhookの冪等性をInbox方式にする。
// 旧実装は「event_idをINSERTした時点でprocessedAtを確定」していたため、その直後の業務処理(注文確定等)が
// 失敗しても、Stripeの再送時にはINSERTの一意制約に引っかかって即200(重複)扱いになり、二度と処理されない
// 欠陥があった。status(processing→succeeded/failed_retryable/failed_terminal)で実際の完了を追跡し、
// 失敗時は同じevent_idでの再送で再処理できるようにする。

// 5分以上processingのまま止まっている行は、プロセスクラッシュ等で「処理中のまま放置された」可能性が高いと
// みなし、再クレーム(reclaim)の対象にする。
const STALE_PROCESSING_MS = 5 * 60 * 1000;
// これを超えて失敗し続けた場合はfailed_terminalとし、Stripeの自動再送に任せず管理者による
// 手動再試行(admin/stripe-events)を必須にする。
const MAX_ATTEMPTS_BEFORE_TERMINAL = 10;

export type StripeEventClaim =
  | { outcome: 'process' }
  | { outcome: 'already_succeeded' }
  | { outcome: 'in_progress' }
  | { outcome: 'failed_terminal' }
  | { outcome: 'payload_mismatch' };

export function hashPayload(rawBody: Buffer | string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

// 冪等性の核心: 同一stripeEventIdの初回はINSERTでprocessingをクレームする。
// 既存行がある場合はpayloadHashの一致を確認したうえで、状態に応じてreclaim/no-opを判定する。
export async function claimStripeEventForProcessing(
  stripeEventId: string,
  eventType: string,
  payloadHash: string,
): Promise<StripeEventClaim> {
  try {
    await prisma.stripeEvent.create({
      data: { stripeEventId, eventType, payloadHash, status: 'processing', attemptCount: 1, processingStartedAt: new Date() },
    });
    return { outcome: 'process' };
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }

  const existing = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId } });

  // 同一event_idで本文が異なる場合は処理しない(契約書6.4章)。Stripeが同じevent_idを
  // 使い回すことは本来ないはずだが、なりすまし・データ破損の検知として扱う。
  if (existing.payloadHash !== payloadHash) {
    return { outcome: 'payload_mismatch' };
  }
  if (existing.status === 'succeeded') {
    return { outcome: 'already_succeeded' };
  }
  if (existing.status === 'failed_terminal') {
    return { outcome: 'failed_terminal' };
  }
  if (existing.status === 'processing') {
    const isStale = existing.processingStartedAt !== null && Date.now() - existing.processingStartedAt.getTime() > STALE_PROCESSING_MS;
    if (!isStale) {
      return { outcome: 'in_progress' };
    }
    // stale: 下のreclaimへフォールスルー
  }

  // failed_retryable、またはstaleなprocessingを再クレームする。同時に複数リクエストが
  // 到達した場合に二重処理しないよう、条件付きUPDATE(該当行のcountが0なら誰かが先に取った)で判定する。
  const claimed = await prisma.stripeEvent.updateMany({
    where: { stripeEventId, status: existing.status },
    data: { status: 'processing', attemptCount: { increment: 1 }, processingStartedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { outcome: 'in_progress' };
  }
  return { outcome: 'process' };
}

// 管理画面からの手動再試行用。failed_retryable/failed_terminalのいずれからでも、
// 明示的な管理者操作としてprocessingへ遷移させる(Webhook経由のクレームとは別の入口)。
export async function claimStripeEventForManualRetry(stripeEventId: string): Promise<boolean> {
  const claimed = await prisma.stripeEvent.updateMany({
    where: { stripeEventId, status: { in: ['failed_retryable', 'failed_terminal'] } },
    data: { status: 'processing', attemptCount: { increment: 1 }, processingStartedAt: new Date() },
  });
  return claimed.count > 0;
}

export async function markStripeEventSucceeded(stripeEventId: string): Promise<void> {
  await prisma.stripeEvent.update({
    where: { stripeEventId },
    data: { status: 'succeeded', processedAt: new Date(), lastError: null },
  });
}

export async function markStripeEventFailed(stripeEventId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const current = await prisma.stripeEvent.findUnique({ where: { stripeEventId } });
  const attemptCount = current?.attemptCount ?? 1;
  const status = attemptCount >= MAX_ATTEMPTS_BEFORE_TERMINAL ? 'failed_terminal' : 'failed_retryable';
  await prisma.stripeEvent.update({ where: { stripeEventId }, data: { status, lastError: message } });
}
