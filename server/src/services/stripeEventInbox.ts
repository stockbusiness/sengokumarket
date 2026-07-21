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

// 2026-07-15時点の移行(既存stripe_eventsのInbox化)でバックフィルしたプレースホルダ値。
// 実ペイロードのハッシュと一致することはない。
const LEGACY_UNKNOWN_HASH = 'legacy-unknown';

export type StripeEventClaim =
  | { outcome: 'process'; processingToken: string }
  | { outcome: 'already_succeeded' }
  | { outcome: 'in_progress' }
  | { outcome: 'failed_terminal' }
  | { outcome: 'payload_mismatch' };

export function hashPayload(rawBody: Buffer | string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function generateProcessingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// 冪等性の核心: 同一stripeEventIdの初回はINSERTでprocessingをクレームする。
// 既存行がある場合はpayloadHashの一致を確認したうえで、状態に応じてreclaim/no-opを判定する。
//
// 仕様書外の拡張(2026-07-22指示書Stage1): 処理権にランダムなprocessing_tokenを発行し、
// このクレームで得たtoken以外からのmarkSucceeded/Failedでは状態を上書きできないようにする。
// staleなprocessing行の再クレームは、読み込んだ時点のprocessing_started_at/processing_tokenを
// WHERE条件に含めたCompare-And-Swapで行うことで、複数リクエストが同時に同じstale行を
// 再クレームしようとしても1件しか成功しないようにする(値が変化しないUPDATEはPostgresの
// 行ロックだけでは排他できないため、CASの鍵として使う値自体を毎回更新する必要がある)。
export async function claimStripeEventForProcessing(
  stripeEventId: string,
  eventType: string,
  payloadHash: string,
): Promise<StripeEventClaim> {
  const initialToken = generateProcessingToken();
  try {
    await prisma.stripeEvent.create({
      data: {
        stripeEventId,
        eventType,
        payloadHash,
        status: 'processing',
        attemptCount: 1,
        processingStartedAt: new Date(),
        processingToken: initialToken,
      },
    });
    return { outcome: 'process', processingToken: initialToken };
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
  }

  const existing = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId } });

  // 仕様書外の拡張(2026-07-22指示書Stage2): 2026-07-15のInbox化移行より前に成功していたイベントは
  // payload_hashが実ハッシュ未記録のプレースホルダ('legacy-unknown')のまま保存されている。
  // Stripeがこれらを再送してきた場合、実ハッシュとは一致しなくても「処理済みの重複」として
  // 扱い、業務処理を再実行しない(payload_mismatch判定より優先する)。
  if (existing.status === 'succeeded' && existing.payloadHash === LEGACY_UNKNOWN_HASH) {
    return { outcome: 'already_succeeded' };
  }

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

    const newToken = generateProcessingToken();
    const claimed = await prisma.stripeEvent.updateMany({
      where: {
        stripeEventId,
        status: 'processing',
        processingStartedAt: existing.processingStartedAt,
        processingToken: existing.processingToken,
      },
      data: { status: 'processing', attemptCount: { increment: 1 }, processingStartedAt: new Date(), processingToken: newToken },
    });
    if (claimed.count === 0) {
      // 別のリクエストが先にこのstale行を再クレームした(CAS失敗)。
      return { outcome: 'in_progress' };
    }
    return { outcome: 'process', processingToken: newToken };
  }

  // ここに到達するのはfailed_retryableのみ。status自体がprocessingへ変わる(値が変化する)ため、
  // 同時に複数リクエストが到達してもUPDATE ... WHERE status='failed_retryable'は1件しか成功しない。
  const newToken = generateProcessingToken();
  const claimed = await prisma.stripeEvent.updateMany({
    where: { stripeEventId, status: existing.status },
    data: { status: 'processing', attemptCount: { increment: 1 }, processingStartedAt: new Date(), processingToken: newToken },
  });
  if (claimed.count === 0) {
    return { outcome: 'in_progress' };
  }
  return { outcome: 'process', processingToken: newToken };
}

// 管理画面からの手動再試行用。failed_retryable/failed_terminalのいずれからでも、
// 明示的な管理者操作としてprocessingへ遷移させる(Webhook経由のクレームとは別の入口)。
// status自体がprocessingへ変わる遷移のため、Webhook側の自動再送と同時に発生しても
// どちらか一方しかクレームできない。
export async function claimStripeEventForManualRetry(stripeEventId: string): Promise<{ processingToken: string } | null> {
  const newToken = generateProcessingToken();
  const claimed = await prisma.stripeEvent.updateMany({
    where: { stripeEventId, status: { in: ['failed_retryable', 'failed_terminal'] } },
    data: { status: 'processing', attemptCount: { increment: 1 }, processingStartedAt: new Date(), processingToken: newToken },
  });
  if (claimed.count === 0) return null;
  return { processingToken: newToken };
}

// processingTokenが一致する場合のみ状態を更新する。既に別の処理(stale reclaim等)に所有権が
// 移っている場合は0件更新となり、古い処理の結果で新しい処理の状態を上書きしない。
export async function markStripeEventSucceeded(stripeEventId: string, processingToken: string): Promise<void> {
  await prisma.stripeEvent.updateMany({
    where: { stripeEventId, status: 'processing', processingToken },
    data: { status: 'succeeded', processedAt: new Date(), lastError: null },
  });
}

export async function markStripeEventFailed(stripeEventId: string, processingToken: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const current = await prisma.stripeEvent.findUnique({ where: { stripeEventId } });
  if (!current || current.status !== 'processing' || current.processingToken !== processingToken) {
    // 所有権を既に失っている(別処理がstale reclaimした等)。自分の結果で状態を上書きしない。
    return;
  }
  const status = current.attemptCount >= MAX_ATTEMPTS_BEFORE_TERMINAL ? 'failed_terminal' : 'failed_retryable';
  await prisma.stripeEvent.updateMany({
    where: { stripeEventId, status: 'processing', processingToken },
    data: { status, lastError: message },
  });
}
