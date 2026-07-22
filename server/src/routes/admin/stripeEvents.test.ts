import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { hashPayload } from '../../services/stripeEventInbox';

const retrieveMock = vi.fn();
vi.mock('../../lib/stripeClient', () => ({
  getStripeClient: async () => ({ events: { retrieve: retrieveMock } }),
}));

const app = createApp();

// 仕様書外の拡張(千ノ国全体統合契約2026-07-21 受入条件9 / 2026-07-22指示書Stage1): Stripe Inboxの
// 手動再試行APIが、processing_tokenによる所有権保護のもとで正しく動作することを確認する。
describe('管理API: Stripe Webhookイベント一覧・手動再試行(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { contains: 'admin-stripe-events-test-' } } });
    await prisma.$disconnect();
  });

  it('存在しないイベントIDへの再試行は404になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/stripe-events/00000000-0000-0000-0000-000000000000/retry')
      .set('Origin', TEST_ORIGIN)
      .send({});
    expect(res.status).toBe(404);
  });

  it('processing状態のイベントへの再試行は400になる(再試行可能な状態ではない)', async () => {
    const stripeEventId = `admin-stripe-events-test-processing-${Date.now()}`;
    const event = await prisma.stripeEvent.create({
      data: { stripeEventId, eventType: 'checkout.session.completed', payloadHash: hashPayload('{}'), status: 'processing' },
    });

    const { agent } = await createAdminAgent(app);
    const res = await agent.post(`/api/admin/stripe-events/${event.id}/retry`).set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('failed_retryableのイベントを再試行すると、Stripeから取得し直して再処理しsucceededになる', async () => {
    const stripeEventId = `admin-stripe-events-test-retry-ok-${Date.now()}`;
    const event = await prisma.stripeEvent.create({
      data: {
        stripeEventId,
        eventType: 'customer.updated',
        payloadHash: hashPayload('{}'),
        status: 'failed_retryable',
        attemptCount: 2,
        lastError: '一時的なエラー',
      },
    });
    // customer.updatedはprocessStripeEventのswitchで扱われないためno-opで成功する(業務処理の
    // 中身自体は他のテストで別途検証済みのため、ここでは再試行の配線・所有権制御に絞る)。
    retrieveMock.mockResolvedValueOnce({ id: stripeEventId, type: 'customer.updated', data: { object: {} } });

    const { agent } = await createAdminAgent(app);
    const res = await agent.post(`/api/admin/stripe-events/${event.id}/retry`).set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(200);
    expect(res.body.stripeEvent.status).toBe('succeeded');

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('succeeded');
    expect(row.attemptCount).toBe(3);
  });

  it('同一イベントへ再試行が同時に到達しても、処理に成功するのは一方だけになる', async () => {
    const stripeEventId = `admin-stripe-events-test-concurrent-${Date.now()}`;
    const event = await prisma.stripeEvent.create({
      data: { stripeEventId, eventType: 'customer.updated', payloadHash: hashPayload('{}'), status: 'failed_retryable', attemptCount: 1 },
    });
    retrieveMock.mockResolvedValue({ id: stripeEventId, type: 'customer.updated', data: { object: {} } });

    const { agent: agentA } = await createAdminAgent(app);
    const { agent: agentB } = await createAdminAgent(app);

    const [resA, resB] = await Promise.all([
      agentA.post(`/api/admin/stripe-events/${event.id}/retry`).set('Origin', TEST_ORIGIN).send({}),
      agentB.post(`/api/admin/stripe-events/${event.id}/retry`).set('Origin', TEST_ORIGIN).send({}),
    ]);

    // 先頭の状態チェック(400)とアトミックなclaim(409)は別ステップのため、負けた側が
    // どちらの応答になるかはタイミング依存。重要なのは「処理(200)に到達するのは1件だけ」
    // という安全性であり、レース時の具体的な拒否コードではない。
    const statuses = [resA.status, resB.status];
    const successCount = statuses.filter((s) => s === 200).length;
    const rejectedCount = statuses.filter((s) => s === 400 || s === 409).length;
    expect(successCount).toBe(1);
    expect(rejectedCount).toBe(1);

    const row = await prisma.stripeEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('succeeded');
    expect(row.attemptCount).toBe(2); // 二重処理されていれば3になるはず
  });

  it('一覧はstatusで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/stripe-events?status=failed_retryable');
    expect(res.status).toBe(200);
    expect(res.body.stripeEvents.every((e: { status: string }) => e.status === 'failed_retryable')).toBe(true);
  });

  it('不正なstatusは400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/stripe-events?status=not_a_status');
    expect(res.status).toBe(400);
  });
});
