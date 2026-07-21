import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  claimStripeEventForManualRetry,
  claimStripeEventForProcessing,
  hashPayload,
  markStripeEventFailed,
  markStripeEventSucceeded,
} from './stripeEventInbox';

// 仕様書外の拡張(千ノ国全体統合契約2026-07-21 5.4章): Stripe Webhookの冪等性をInbox方式にした際の
// 状態遷移(processing→succeeded/failed_retryable/failed_terminal)の回帰テスト。
// 旧実装は「event_id先行INSERT→後続失敗も重複扱い」で再送しても復旧できなかった欠陥があったため、
// 失敗後に同一event_idで再クレームでき、実際に再処理されることを重点的に確認する。
describe('stripeEventInbox(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { contains: 'inbox-test-' } } });
    await prisma.$disconnect();
  });

  function newEventId(suffix: string) {
    return `inbox-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  it('新規イベントは即座にprocessingとしてクレームされる', async () => {
    const eventId = newEventId('new');
    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"a":1}'));
    expect(claim.outcome).toBe('process');

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('processing');
    expect(row.attemptCount).toBe(1);
    expect(row.processedAt).toBeNull();
  });

  it('succeededにした後の再クレームはalready_succeededを返し、二重処理されない', async () => {
    const eventId = newEventId('succeeded');
    const hash = hashPayload('{"b":2}');
    await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    await markStripeEventSucceeded(eventId);

    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(claim.outcome).toBe('already_succeeded');

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('succeeded');
    expect(row.processedAt).not.toBeNull();
  });

  // これが今回修正した核心のバグの回帰テスト: 業務処理が失敗してもevent_idは既にINSERT済みのため、
  // 旧実装ではここで「重複」として二度と処理されなかった。新実装ではfailed_retryableとなり、
  // 同一event_idでの再送(同じpayload)で正しく再クレームされ、再処理できる。
  it('業務処理が失敗した場合、同一event_id・同一payloadの再送で再クレームされ再処理できる', async () => {
    const eventId = newEventId('retry');
    const hash = hashPayload('{"c":3}');

    const firstClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(firstClaim.outcome).toBe('process');

    await markStripeEventFailed(eventId, new Error('業務処理中に発生した一時的なエラー'));

    const afterFailure = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterFailure.status).toBe('failed_retryable');
    expect(afterFailure.lastError).toContain('一時的なエラー');

    // Stripeが同じevent_idで再送してきた場合
    const retryClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(retryClaim.outcome).toBe('process');

    const afterRetryClaim = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterRetryClaim.status).toBe('processing');
    expect(afterRetryClaim.attemptCount).toBe(2);

    await markStripeEventSucceeded(eventId);
    const afterSuccess = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterSuccess.status).toBe('succeeded');
  });

  it('最大試行回数を超えて失敗し続けるとfailed_terminalになり、自動再送では再処理されない', async () => {
    const eventId = newEventId('terminal');
    const hash = hashPayload('{"d":4}');

    await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    for (let i = 0; i < 10; i++) {
      await markStripeEventFailed(eventId, new Error(`失敗${i}`));
      if (i < 9) await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    }

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('failed_terminal');

    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(claim.outcome).toBe('failed_terminal');
  });

  it('failed_terminalは管理者による手動再試行クレームでのみprocessingに戻せる', async () => {
    const eventId = newEventId('manual-retry');
    const hash = hashPayload('{"e":5}');
    await prisma.stripeEvent.create({
      data: { stripeEventId: eventId, eventType: 'checkout.session.completed', payloadHash: hash, status: 'failed_terminal', attemptCount: 10 },
    });

    const claimed = await claimStripeEventForManualRetry(eventId);
    expect(claimed).toBe(true);

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('processing');
    expect(row.attemptCount).toBe(11);
  });

  it('同一event_idでpayloadが異なる場合はpayload_mismatchを返し処理しない', async () => {
    const eventId = newEventId('mismatch');
    await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"original":true}'));

    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"tampered":true}'));
    expect(claim.outcome).toBe('payload_mismatch');
  });

  it('処理中(processing)の別リクエストはin_progressを返し、二重に処理を進めない', async () => {
    const eventId = newEventId('inprogress');
    const hash = hashPayload('{"f":6}');
    await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);

    const concurrentClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(concurrentClaim.outcome).toBe('in_progress');

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.attemptCount).toBe(1); // 二重クレームされていない
  });

  it('processingのまま長時間放置された行(プロセスクラッシュ想定)は再クレームできる', async () => {
    const eventId = newEventId('stale');
    const hash = hashPayload('{"g":7}');
    await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);

    // 5分以上前にprocessingへ入ったことにする(スタック放置のシミュレーション)
    await prisma.stripeEvent.update({
      where: { stripeEventId: eventId },
      data: { processingStartedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(claim.outcome).toBe('process');

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.attemptCount).toBe(2);
  });
});
