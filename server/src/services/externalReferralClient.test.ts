import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { captureReferralToken, confirmReferral } from './externalReferralClient';

// 代理店HUB(sengoku-ai.com)向けreferral capture/confirmクライアント。2026-10に先方の開発者向け
// ガイド・個別確認で判明した実際の契約(x-api-key認証、system_key='sengoku-rr'・
// project_key='sengoku-market'・代理店4役はtransaction配下)に合わせたテスト。
// Feature Flag(既定OFF)・接続情報が揃うまで外部へ送信しない。
describe('externalReferralClient(代理店HUB referral capture/confirm)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_agency_hub_api_key', 'sennokuni_agency_hub_base_url'] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('captureReferralToken', () => {
    it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await captureReferralToken('SGI0001');

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Feature Flag有効・接続情報設定済みならx-api-keyヘッダー付きでcapture APIを呼び、正しく解析する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com');

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            referral_token: 'SGI0001',
            canonical_referral_token: 'SGI0001',
            referral_session_key: 'rs_test_001',
            agent_id: 7,
            agent_code: 'agent_7_8573',
            project_key: 'sengoku-market',
            status: 'captured',
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await captureReferralToken('SGI0001');

      expect(result).toEqual({
        canonicalReferralToken: 'SGI0001',
        referralSessionKey: 'rs_test_001',
        agentId: '7',
        expiresAt: null,
      });
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sengoku-ai.com/api/referrals/capture');
      expect(options.headers['x-api-key']).toBe('api-key-abc');
      expect(JSON.parse(options.body)).toMatchObject({ system_key: 'sengoku-rr', referral_token: 'SGI0001' });
    });

    it('ok!==trueの応答はnullを返す', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: false, status: 'expired' }) }));

      const result = await captureReferralToken('SGI0001');
      expect(result).toBeNull();
    });
  });

  describe('confirmReferral', () => {
    it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await confirmReferral({
        orderId: 'order-test-1',
        referralSessionKey: 'rs_test_001',
        commonUserId: 'cu_test_001',
        amountJpy: 30000,
      });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Feature Flag有効時はproject_key付きでconfirm APIを呼び、transaction配下の代理店4役を解析する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com');

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            common_user_id: 'cu_test_001',
            agency_id: 'agent_7_8573',
            relation: { agent_id: 7, relation_type: 'referral' },
            transaction: {
              registration_referrer_agency_id: 'AGENT-CODE-001',
              assigned_agency_id: 'AGENT-CODE-002',
              sales_agent_id: 'AGENT-CODE-003',
              closing_agent_id: 'AGENT-CODE-004',
              order_id: 'order-test-1',
              product_code: 'council-digital-membership-card',
            },
            agency_relations: [{ agent_id: 7, agent_code: 'agent_7_8573', relation_type: 'referral' }],
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await confirmReferral({
        orderId: 'order-test-1',
        referralSessionKey: 'rs_test_001',
        commonUserId: 'cu_test_001',
        externalUserId: 'user-1',
        productCode: 'council-digital-membership-card',
        amountJpy: 30000,
      });

      expect(result).toEqual({
        commonUserId: 'cu_test_001',
        registrationReferrerAgencyId: 'AGENT-CODE-001',
        assignedAgencyId: 'AGENT-CODE-002',
        salesAgentId: 'AGENT-CODE-003',
        closingAgentId: 'AGENT-CODE-004',
      });
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://sengoku-ai.com/api/referrals/confirm');
      expect(options.headers['x-api-key']).toBe('api-key-abc');
      expect(JSON.parse(options.body)).toMatchObject({
        system_key: 'sengoku-rr',
        session_key: 'rs_test_001',
        external_user_id: 'user-1',
        project_key: 'sengoku-market',
        common_user_id: 'cu_test_001',
        order_id: 'order-test-1',
        product_code: 'council-digital-membership-card',
        payment_status: 'paid',
        amount: 30000,
        currency: 'JPY',
      });
    });

    // 先方の2026-10回答: order_id(transaction_id)が無い場合、紹介関係の確定のみでtransactionが
    // 空になりうる。その場合は代理店4役すべてnullとして扱う(誤った値を補完しない)。
    it('transactionが無い応答は代理店4役すべてnullになる', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              common_user_id: 'cu_test_001',
              agency_id: 'agent_7_8573',
              relation: { agent_id: 7, relation_type: 'referral' },
              agency_relations: [],
            }),
        }),
      );

      const result = await confirmReferral({
        orderId: 'order-test-1',
        referralSessionKey: 'rs_test_001',
        commonUserId: 'cu_test_001',
        amountJpy: 30000,
      });

      expect(result).toEqual({
        commonUserId: 'cu_test_001',
        registrationReferrerAgencyId: null,
        assignedAgencyId: null,
        salesAgentId: null,
        closingAgentId: null,
      });
    });

    it('ok!==trueの応答はnullを返す', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: false }) }));

      const result = await confirmReferral({
        orderId: 'order-test-1',
        referralSessionKey: 'rs_test_001',
        commonUserId: 'cu_test_001',
        amountJpy: 30000,
      });
      expect(result).toBeNull();
    });
  });
});
