import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { getStripeClient } from '../../lib/stripeClient';
import { processStripeEvent } from '../stripeWebhook';
import { claimStripeEventForManualRetry, markStripeEventFailed, markStripeEventSucceeded } from '../../services/stripeEventInbox';
import { STRIPE_EVENT_STATUSES as STATUSES } from '@sengoku/contracts';

const router = Router();

// 仕様書外の拡張(千ノ国全体統合契約2026-07-21・受入条件9「部分失敗後に管理画面またはジョブで
// 再実行できる」): Stripe Webhookの処理状況を一覧・監視するための管理画面API。
router.get('/stripe-events', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  const events = await prisma.stripeEvent.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  res.json({ stripeEvents: events });
});

// failed_retryable/failed_terminalのイベントを、Stripeから最新のイベント内容を取得し直して
// 再処理する。Webhook経由の自動再送とは別に、管理者が明示的に再実行できるようにする。
router.post('/stripe-events/:id/retry', async (req, res) => {
  const existing = await prisma.stripeEvent.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'STRIPE_EVENT_NOT_FOUND', 'イベントが見つかりません');
  if (existing.status !== 'failed_retryable' && existing.status !== 'failed_terminal') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'この状態のイベントは再試行できません');
  }

  const stripe = await getStripeClient();
  let event;
  try {
    event = await stripe.events.retrieve(existing.stripeEventId);
  } catch (e) {
    console.error('failed to fetch stripe event for retry', { stripeEventId: existing.stripeEventId, error: e });
    return sendError(res, 502, 'STRIPE_FETCH_FAILED', 'Stripeからのイベント取得に失敗しました');
  }

  const claimed = await claimStripeEventForManualRetry(existing.stripeEventId);
  if (!claimed) {
    return sendError(res, 409, 'ALREADY_PROCESSING', 'このイベントは現在別の処理中です');
  }

  try {
    await processStripeEvent(event);
    await markStripeEventSucceeded(existing.stripeEventId, claimed.processingToken);
    const updated = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: existing.id } });
    res.json({ stripeEvent: updated });
  } catch (e) {
    await markStripeEventFailed(existing.stripeEventId, claimed.processingToken, e);
    console.error('manual stripe event retry failed', { stripeEventId: existing.stripeEventId, error: e });
    return sendError(res, 500, 'RETRY_FAILED', '再試行に失敗しました');
  }
});

export default router;
