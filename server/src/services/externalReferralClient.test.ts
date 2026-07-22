import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { captureReferralToken, confirmReferral } from './externalReferralClient';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT・2026-07-22指示書対応):
// referral capture/confirmクライアントはFeature Flag(既定OFF)・接続情報が揃うまで
// 外部へ送信しない。
describe('externalReferralClient(仕様書外の拡張・2026-07-22指示書対応)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_hmac_key_id', 'sennokuni_hmac_secret', 'sennokuni_agency_hub_base_url'] } },
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

    it('Feature Flag有効・接続情報設定済みならcapture APIを呼び、正しく解析する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: 'captured',
            canonical_referral_token: 'rt_test_001',
            referral_session_key: 'rs_test_001',
            agency_id: 'AGENT-CODE-001',
            expires_at: '2026-07-22T12:00:00Z',
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await captureReferralToken('SGI0001');

      expect(result).toEqual({
        canonicalReferralToken: 'rt_test_001',
        referralSessionKey: 'rs_test_001',
        agencyId: 'AGENT-CODE-001',
        expiresAt: '2026-07-22T12:00:00Z',
      });
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://agency-hub.example.com/api/referrals/capture');
      expect(JSON.parse(options.body)).toMatchObject({ system_key: 'sengoku-market', token: 'SGI0001' });
    });

    it('status !== capturedの応答はnullを返す', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'expired' }) }));

      const result = await captureReferralToken('SGI0001');
      expect(result).toBeNull();
    });
  });

  describe('confirmReferral', () => {
    it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await confirmReferral({ referralSessionKey: 'rs_test_001', commonUserId: 'cu_test_001', event: 'purchase' });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Feature Flag有効時はconfirm APIを呼び、代理店4役を解析する', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('sennokuni_hmac_key_id', 'key-123');
      await setSetting('sennokuni_hmac_secret', 'secret-abc');
      await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: 'confirmed',
            common_user_id: 'cu_test_001',
            registration_referrer_agency_id: 'AGENT-CODE-001',
            assigned_agency_id: 'AGENT-CODE-002',
            sales_agent_id: 'AGENT-CODE-003',
            closing_agent_id: 'AGENT-CODE-004',
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await confirmReferral({ referralSessionKey: 'rs_test_001', commonUserId: 'cu_test_001', event: 'purchase' });

      expect(result).toEqual({
        commonUserId: 'cu_test_001',
        registrationReferrerAgencyId: 'AGENT-CODE-001',
        assignedAgencyId: 'AGENT-CODE-002',
        salesAgentId: 'AGENT-CODE-003',
        closingAgentId: 'AGENT-CODE-004',
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://agency-hub.example.com/api/referrals/confirm');
    });
  });
});
