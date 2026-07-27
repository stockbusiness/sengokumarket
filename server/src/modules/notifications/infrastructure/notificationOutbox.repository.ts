import crypto from 'crypto';
import type { NotificationOutboxEvent, Prisma, PrismaClient } from '@prisma/client';
import type { EnqueueNotificationInput } from '../domain/notificationOutbox.types';

type Db = PrismaClient | Prisma.TransactionClient;

// 代理店作成・ログインユーザー作成と同一トランザクションで通知予定を記録する
// (残課題指示書5.4)。実際の送信はcommit後にDispatcherが行う。
export function enqueueNotification(tx: Db, input: EnqueueNotificationInput): Promise<NotificationOutboxEvent> {
  return tx.notificationOutboxEvent.create({
    data: {
      eventType: input.eventType,
      recipient: input.recipient,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      status: 'pending',
    },
  });
}

function generateProcessingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

// 最終安定化指示書Phase8「Notification Outbox claim改善」: 先行してbatch分すべてを
// processingへclaimすると、時間予算切れで打ち切った際に未処理分がstale reclaim(10分)を
// 待つまでprocessing残留してしまう。1件ずつclaim・処理・次の1件claimというループへ改め、
// 常に高々1件しかprocessing状態を持たないようにする(同時実行下の二重取得防止は従来通り
// 条件付きUPDATE(WHERE status='pending')で担保する)。
const CLAIM_LOOKAHEAD = 10;

export async function claimOne(db: PrismaClient): Promise<NotificationOutboxEvent | null> {
  const candidates = await db.notificationOutboxEvent.findMany({
    where: { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { createdAt: 'asc' },
    take: CLAIM_LOOKAHEAD,
  });

  for (const candidate of candidates) {
    const processingToken = generateProcessingToken();
    const result = await db.notificationOutboxEvent.updateMany({
      where: { id: candidate.id, status: 'pending' },
      data: { status: 'processing', processingToken, processingStartedAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (result.count === 1) {
      // DB側はattemptCountをincrementしたため、メモリ上のcandidateも合わせて反映する
      // (古い値のままだとmarkFailedのbackoff計算がずれる)。
      return { ...candidate, processingToken, status: 'processing', attemptCount: candidate.attemptCount + 1 };
    }
  }
  return null;
}

// stale(claimしたまま一定時間放置された)processing行をpendingへ戻す。
const STALE_PROCESSING_MS = 10 * 60 * 1000;

export async function reclaimStaleProcessing(db: PrismaClient): Promise<number> {
  const result = await db.notificationOutboxEvent.updateMany({
    where: { status: 'processing', processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    data: { status: 'pending', processingToken: null, processingStartedAt: null },
  });
  return result.count;
}

export async function markSucceeded(db: PrismaClient, id: string, processingToken: string): Promise<void> {
  await db.notificationOutboxEvent.updateMany({
    where: { id, status: 'processing', processingToken },
    data: { status: 'succeeded', processedAt: new Date(), lastError: null },
  });
}

const MAX_ATTEMPTS = 5;
// バックオフ間隔(分)。integration_outbox_eventsのdispatcherと同じ考え方。
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];

export async function markFailed(db: PrismaClient, event: NotificationOutboxEvent, processingToken: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  if (event.attemptCount >= MAX_ATTEMPTS) {
    await db.notificationOutboxEvent.updateMany({
      where: { id: event.id, status: 'processing', processingToken },
      data: { status: 'dead', lastError: message },
    });
    return;
  }
  const backoffMinutes = BACKOFF_MINUTES[Math.min(event.attemptCount - 1, BACKOFF_MINUTES.length - 1)];
  await db.notificationOutboxEvent.updateMany({
    where: { id: event.id, status: 'processing', processingToken },
    data: { status: 'pending', lastError: message, nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000) },
  });
}

export function recordPasswordResetTokenId(db: PrismaClient, id: string, tokenId: string): Promise<NotificationOutboxEvent> {
  return db.notificationOutboxEvent.update({ where: { id }, data: { passwordResetTokenId: tokenId } });
}

// 管理画面向け一覧・手動再送用。
export async function findById(db: PrismaClient, id: string): Promise<NotificationOutboxEvent | null> {
  return db.notificationOutboxEvent.findUnique({ where: { id } });
}

export async function claimForManualRetry(db: PrismaClient, id: string): Promise<{ event: NotificationOutboxEvent; processingToken: string } | null> {
  const existing = await db.notificationOutboxEvent.findUnique({ where: { id } });
  if (!existing || (existing.status !== 'failed' && existing.status !== 'dead' && existing.status !== 'pending')) {
    return null;
  }
  const processingToken = generateProcessingToken();
  const result = await db.notificationOutboxEvent.updateMany({
    where: { id, status: existing.status },
    data: { status: 'processing', processingToken, processingStartedAt: new Date(), attemptCount: { increment: 1 } },
  });
  if (result.count !== 1) return null;
  return { event: { ...existing, status: 'processing', processingToken }, processingToken };
}
