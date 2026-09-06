import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const testStripeConnection = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'stripe ok' }));
const testResendConnection = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'resend ok' }));
const testExternalAgencyConnection = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'external ok' }));
const testAgencyKeyConnection = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'agency key ok' }));
const testNftMintConnection = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'nft mint ok' }));
const testOveWalletEventsConnection = vi.fn(async (..._args: unknown[]) => ({ ok: true, message: 'ove wallet events ok' }));

vi.mock('../../services/connectionTest', () => ({
  testStripeConnection: (...args: unknown[]) => testStripeConnection(...args),
  testResendConnection: (...args: unknown[]) => testResendConnection(...args),
  testExternalAgencyConnection: (...args: unknown[]) => testExternalAgencyConnection(...args),
  testAgencyKeyConnection: (...args: unknown[]) => testAgencyKeyConnection(...args),
  testNftMintConnection: (...args: unknown[]) => testNftMintConnection(...args),
  testOveWalletEventsConnection: (...args: unknown[]) => testOveWalletEventsConnection(...args),
}));

const app = createApp();

describe('管理API: Stripe/Resend設定(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: 'mail_from' } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('一般ユーザーは403', async () => {
    const email = `admin-settings-test-user-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });
    const res = await agent.get('/api/admin/settings');
    expect(res.status).toBe(403);
  });

  it('未設定はconfigured=falseを返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.mail_from.configured).toBe(false);
  });

  it('設定するとマスクされた値が返る(生の値は含まれない)', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put('/api/admin/settings')
      .set('Origin', TEST_ORIGIN)
      .send({ mail_from: 'noreply@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.settings.mail_from.configured).toBe(true);
    expect(res.body.settings.mail_from.masked).not.toBe('noreply@example.com');
    expect(res.body.settings.mail_from.masked).toMatch(/\.com$/);
  });

  it('空文字を送った項目は変更されない', async () => {
    const { agent } = await createAdminAgent(app);
    const before = await agent.get('/api/admin/settings');
    const beforeMasked = before.body.settings.mail_from.masked;

    const res = await agent.put('/api/admin/settings').set('Origin', TEST_ORIGIN).send({ mail_from: '' });
    expect(res.body.settings.mail_from.masked).toBe(beforeMasked);
  });
});

describe('管理API: 接続テスト(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('一般ユーザーは403', async () => {
    const email = `admin-connectiontest-test-user-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });
    const res = await agent.post('/api/admin/settings/test/stripe').set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(403);
  });

  it('POST /settings/test/stripeは入力値でtestStripeConnectionを呼び、結果を返す', async () => {
    const { agent } = await createAdminAgent(app);
    testStripeConnection.mockClear();
    const res = await agent.post('/api/admin/settings/test/stripe').set('Origin', TEST_ORIGIN).send({ stripe_secret_key: 'sk_test_x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'stripe ok' });
    expect(testStripeConnection).toHaveBeenCalledWith('sk_test_x');
  });

  it('POST /settings/test/resendはtoが未指定だと400', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/settings/test/resend').set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(400);
  });

  it('POST /settings/test/resendはtoを指定するとtestResendConnectionを呼ぶ', async () => {
    const { agent } = await createAdminAgent(app);
    testResendConnection.mockClear();
    const res = await agent.post('/api/admin/settings/test/resend').set('Origin', TEST_ORIGIN).send({ to: 'me@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'resend ok' });
    expect(testResendConnection).toHaveBeenCalledWith(undefined, undefined, 'me@example.com');
  });

  it('POST /settings/test/external-agencyはtestExternalAgencyConnectionの結果を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/settings/test/external-agency')
      .set('Origin', TEST_ORIGIN)
      .send({ external_agency_system_base_url: 'https://example.com', external_agency_system_api_key: 'key' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'external ok' });
    expect(testExternalAgencyConnection).toHaveBeenCalledWith('https://example.com', 'key');
  });

  it('POST /settings/test/agency-keyはtestAgencyKeyConnectionの結果を返す', async () => {
    const { agent } = await createAdminAgent(app);
    testAgencyKeyConnection.mockClear();
    const res = await agent.post('/api/admin/settings/test/agency-key').set('Origin', TEST_ORIGIN).send({ agency_api_key: 'mykey' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'agency key ok' });
    expect(testAgencyKeyConnection).toHaveBeenCalledWith('mykey');
  });

  it('POST /settings/test/nft-mintはtestNftMintConnectionの結果を返す(仕様書外の拡張)', async () => {
    const { agent } = await createAdminAgent(app);
    testNftMintConnection.mockClear();
    const res = await agent.post('/api/admin/settings/test/nft-mint').set('Origin', TEST_ORIGIN).send({ nft_mint_api_key: 'mintkey' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'nft mint ok' });
    expect(testNftMintConnection).toHaveBeenCalledWith('mintkey');
  });

  it('POST /settings/test/ove-wallet-eventsはtestOveWalletEventsConnectionの結果を返す(仕様書外の拡張)', async () => {
    const { agent } = await createAdminAgent(app);
    testOveWalletEventsConnection.mockClear();
    const res = await agent
      .post('/api/admin/settings/test/ove-wallet-events')
      .set('Origin', TEST_ORIGIN)
      .send({ ove_wallet_base_url: 'https://ove-wallet.example.com', ove_wallet_events_key_id: 'key-1', ove_wallet_events_hmac_secret: 'secret-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'ove wallet events ok' });
    expect(testOveWalletEventsConnection).toHaveBeenCalledWith('https://ove-wallet.example.com', 'key-1', 'secret-1');
  });
});
