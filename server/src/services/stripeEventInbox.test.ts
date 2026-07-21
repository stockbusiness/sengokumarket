import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  claimStripeEventForManualRetry,
  claimStripeEventForProcessing,
  hashPayload,
  markStripeEventFailed,
  markStripeEventSucceeded,
  type StripeEventClaim,
} from './stripeEventInbox';

// 仕様書外の拡張(千ノ国全体統合契約2026-07-21 5.4章 / 2026-07-22指示書Stage1・Stage2): Stripe Webhookの
// 冪等性をInbox方式にした際の状態遷移(processing→succeeded/failed_retryable/failed_terminal)と、
// 処理所有権(processing_token)・legacyイベント互換性の回帰テスト。
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

  function processToken(claim: StripeEventClaim): string {
    if (claim.outcome !== 'process') throw new Error(`expected process outcome, got ${claim.outcome}`);
    return claim.processingToken;
  }

  it('新規イベントは即座にprocessingとしてクレームされ、processingTokenを得る', async () => {
    const eventId = newEventId('new');
    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"a":1}'));
    expect(claim.outcome).toBe('process');
    const token = processToken(claim);
    expect(token).toBeTruthy();

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('processing');
    expect(row.attemptCount).toBe(1);
    expect(row.processedAt).toBeNull();
    expect(row.processingToken).toBe(token);
  });

  it('succeededにした後の再クレームはalready_succeededを返し、二重処理されない', async () => {
    const eventId = newEventId('succeeded');
    const hash = hashPayload('{"b":2}');
    const firstClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    await markStripeEventSucceeded(eventId, processToken(firstClaim));

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

    await markStripeEventFailed(eventId, processToken(firstClaim), new Error('業務処理中に発生した一時的なエラー'));

    const afterFailure = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterFailure.status).toBe('failed_retryable');
    expect(afterFailure.lastError).toContain('一時的なエラー');

    // Stripeが同じevent_idで再送してきた場合
    const retryClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(retryClaim.outcome).toBe('process');

    const afterRetryClaim = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterRetryClaim.status).toBe('processing');
    expect(afterRetryClaim.attemptCount).toBe(2);

    await markStripeEventSucceeded(eventId, processToken(retryClaim));
    const afterSuccess = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterSuccess.status).toBe('succeeded');
  });

  it('最大試行回数を超えて失敗し続けるとfailed_terminalになり、自動再送では再処理されない', async () => {
    const eventId = newEventId('terminal');
    const hash = hashPayload('{"d":4}');

    let claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    for (let i = 0; i < 10; i++) {
      await markStripeEventFailed(eventId, processToken(claim), new Error(`失敗${i}`));
      if (i < 9) claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    }

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('failed_terminal');

    const finalClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(finalClaim.outcome).toBe('failed_terminal');
  });

  it('failed_terminalは管理者による手動再試行クレームでのみprocessingに戻せる', async () => {
    const eventId = newEventId('manual-retry');
    const hash = hashPayload('{"e":5}');
    await prisma.stripeEvent.create({
      data: { stripeEventId: eventId, eventType: 'checkout.session.completed', payloadHash: hash, status: 'failed_terminal', attemptCount: 10 },
    });

    const claimed = await claimStripeEventForManualRetry(eventId);
    expect(claimed).not.toBeNull();
    expect(claimed!.processingToken).toBeTruthy();

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('processing');
    expect(row.attemptCount).toBe(11);
    expect(row.processingToken).toBe(claimed!.processingToken);
  });

  it('手動再試行とStripe自動再送が同じfailed_retryableイベントに同時到達しても一方のみクレームできる', async () => {
    const eventId = newEventId('manual-vs-auto');
    const hash = hashPayload('{"manualvsauto":true}');
    await prisma.stripeEvent.create({
      data: { stripeEventId: eventId, eventType: 'checkout.session.completed', payloadHash: hash, status: 'failed_retryable', attemptCount: 3 },
    });

    const [autoClaim, manualClaim] = await Promise.all([
      claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash),
      claimStripeEventForManualRetry(eventId),
    ]);

    const successCount = (autoClaim.outcome === 'process' ? 1 : 0) + (manualClaim !== null ? 1 : 0);
    expect(successCount).toBe(1);

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.attemptCount).toBe(4);
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

  // 2026-07-22指示書 Stage1 受入条件: 「新規eventを同時に受信しても業務処理は1回だけ」
  it('新規イベントへ同時に複数リクエストが到達しても、processをクレームできるのは1件だけ', async () => {
    const eventId = newEventId('concurrent-new');
    const hash = hashPayload('{"h":8}');

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash)),
    );

    const processCount = claims.filter((c) => c.outcome === 'process').length;
    const inProgressCount = claims.filter((c) => c.outcome === 'in_progress').length;
    expect(processCount).toBe(1);
    expect(inProgressCount).toBe(4);

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.attemptCount).toBe(1);
  });

  // 2026-07-22指示書 Stage1 受入条件: 「stale eventへ同時に2件claimしても processは1件だけ・もう1件はin_progress」
  it('staleなprocessing行へ同時に複数リクエストが再クレームを試みても、processは1件だけになる', async () => {
    const eventId = newEventId('concurrent-stale');
    const hash = hashPayload('{"i":9}');
    await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    await prisma.stripeEvent.update({
      where: { stripeEventId: eventId },
      data: { processingStartedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash)),
    );

    const processCount = claims.filter((c) => c.outcome === 'process').length;
    const inProgressCount = claims.filter((c) => c.outcome === 'in_progress').length;
    expect(processCount).toBe(1);
    expect(inProgressCount).toBe(4);

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.attemptCount).toBe(2); // 初回(1) + 再クレーム成功1件のみ(1)
  });

  // 2026-07-22指示書 Stage1 受入条件: 「古い処理が後から終了しても、新しい処理状態を上書きしない」
  it('古いprocessingTokenでの成功・失敗更新は、既に別処理が再クレームした行の状態を上書きしない', async () => {
    const eventId = newEventId('stale-owner-succeed');
    const hash = hashPayload('{"j":10}');
    const firstClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    const oldToken = processToken(firstClaim);

    await prisma.stripeEvent.update({
      where: { stripeEventId: eventId },
      data: { processingStartedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    const secondClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hash);
    expect(secondClaim.outcome).toBe('process');
    const newToken = processToken(secondClaim);
    expect(newToken).not.toBe(oldToken);

    // 遅延していた古い処理が今頃success/failedを報告してきても、所有権(token)が一致しないため無視される
    await markStripeEventSucceeded(eventId, oldToken);
    const afterOldSuccess = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterOldSuccess.status).toBe('processing');

    await markStripeEventFailed(eventId, oldToken, new Error('古い処理からの遅延失敗報告'));
    const afterOldFailure = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(afterOldFailure.status).toBe('processing');

    // 新しい処理からの結果報告は正しく反映される
    await markStripeEventSucceeded(eventId, newToken);
    const finalRow = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(finalRow.status).toBe('succeeded');
  });

  // 2026-07-22指示書 Stage2 受入条件: legacy(移行前)成功済みイベントの再送は業務処理を再実行せず200相当。
  it('legacy成功済みイベント(payload_hash=legacy-unknown)の再送は、実ペイロードが異なってもalready_succeededを返す', async () => {
    const eventId = newEventId('legacy-resend');
    await prisma.stripeEvent.create({
      data: {
        stripeEventId: eventId,
        eventType: 'checkout.session.completed',
        payloadHash: 'legacy-unknown',
        status: 'succeeded',
        processedAt: new Date(),
      },
    });

    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"real":"payload"}'));
    expect(claim.outcome).toBe('already_succeeded');

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { stripeEventId: eventId } });
    expect(row.status).toBe('succeeded'); // 業務処理は再実行されず状態も変化しない
  });

  it('legacy以外(新方式)でのpayload不一致は従来どおりpayload_mismatchのまま', async () => {
    const eventId = newEventId('non-legacy-mismatch');
    const firstClaim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"k":11}'));
    await markStripeEventSucceeded(eventId, processToken(firstClaim));

    const claim = await claimStripeEventForProcessing(eventId, 'checkout.session.completed', hashPayload('{"different":true}'));
    expect(claim.outcome).toBe('payload_mismatch');
  });
});
