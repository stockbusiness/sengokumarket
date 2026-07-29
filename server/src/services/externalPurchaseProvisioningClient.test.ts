import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { requestPurchaseProvisioning, revokePurchaseProvisioning } from './externalPurchaseProvisioningClient';

// 購入後代理店システム連携実装指示書 5章「共通API契約」。PURCHASE_PROVISIONING_ENABLED
// (既定OFF)・接続情報が揃うまで一切外部へ送信しないことを最重要要件として確認する。
describe('externalPurchaseProvisioningClient(購入後代理店システム連携実装指示書)', () => {
  const originalFlag = process.env.PURCHASE_PROVISIONING_ENABLED;

  const baseInput = {
    eventId: 'evt_test_1',
    correlationId: 'corr_test_1',
    commonUserId: 'cu_test_001',
    externalUserId: 'user-1',
    user: { name: '山田花子', email: 'hanako@example.com', emailVerified: true, phone: '09012345678' },
    order: { orderId: 'order-1', orderNumber: 'SNK-20260729-0001', paymentStatus: 'paid', totalAmount: 30000, paidAt: '2026-07-29T09:00:00Z' },
    items: [
      {
        orderItemId: 'item-1',
        productId: 'product-1',
        productCode: 'agency_entry_plan',
        productName: '代理店参加プラン',
        quantity: 1,
        unitPrice: 30000,
        subtotal: 30000,
        entitlementStatus: 'granted',
        agencyAccessMode: 'agent_portal',
        agencyRole: 'participant',
      },
    ],
    agencyAssignment: {
      registrationReferrerAgencyId: 'AG001',
      assignedAgencyId: 'AG002',
      salesAgentId: 'AG003',
      closingAgentId: 'AG004',
      referralSessionKey: 'ref_session_xxx',
    },
    loginProvisioning: { requested: true, mode: 'sso' as const, returnUrl: 'https://market.example.com/mypage' },
  };

  beforeEach(() => {
    delete process.env.PURCHASE_PROVISIONING_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.PURCHASE_PROVISIONING_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['purchase_provisioning_hmac_key_id', 'purchase_provisioning_hmac_secret', 'purchase_provisioning_base_url'] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('requestPurchaseProvisioning', () => {
    it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await requestPurchaseProvisioning(baseInput);

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Feature Flag有効でも接続情報未設定ならfetchを呼ばずnullを返す', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await requestPurchaseProvisioning(baseInput);

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('接続情報設定済みならHMAC署名ヘッダー付きで呼び、レスポンスを解析する', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com/');

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            common_user_id: 'cu_test_001',
            transaction: { transaction_id: 'txn_xxx' },
            account: { account_type: 'agent', account_id: 'agent_xxx', login_email: 'hanako@example.com', status: 'active' },
            access: { mode: 'sso', login_url: 'https://sengoku-ai.com/sso/consume?token=abc', expires_at: '2026-07-29T09:10:00Z' },
          }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await requestPurchaseProvisioning(baseInput);

      expect(result).toEqual({
        commonUserId: 'cu_test_001',
        transactionId: 'txn_xxx',
        accountType: 'agent',
        accountId: 'agent_xxx',
        loginEmail: 'hanako@example.com',
        accountStatus: 'active',
        accessMode: 'sso',
        loginUrl: 'https://sengoku-ai.com/sso/consume?token=abc',
        loginUrlExpiresAt: '2026-07-29T09:10:00Z',
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://agency-system.example.com/api/purchase-provisioning');
      expect(options.method).toBe('POST');
      expect(options.headers['X-SenNoKuni-Key-Id']).toBe('key-123');
      expect(options.headers['X-SenNoKuni-Signature']).toBeTruthy();
      expect(options.headers['Idempotency-Key']).toBe('purchase-provisioning:order-1');
      const body = JSON.parse(options.body);
      expect(body.source_system_key).toBe('sengoku-market');
      expect(body.common_user_id).toBe('cu_test_001');
      expect(body.user.email_verified).toBe(true);
      expect(body.items[0].agency_access_mode).toBe('agent_portal');
      expect(body.agency_assignment.assigned_agency_id).toBe('AG002');
    });

    it('ok=falseの応答はnullを返す', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: false }) }));

      const result = await requestPurchaseProvisioning(baseInput);
      expect(result).toBeNull();
    });

    it('非2xxレスポンスはnullを返す', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));

      const result = await requestPurchaseProvisioning(baseInput);
      expect(result).toBeNull();
    });
  });

  describe('revokePurchaseProvisioning', () => {
    it('Feature Flag無効時はfetchを呼ばずfalseを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await revokePurchaseProvisioning({ eventId: 'evt_revoke_1', orderId: 'order-1', commonUserId: 'cu_test_001', reason: 'full_refund' });

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('接続情報設定済みならHMAC署名ヘッダー付きでrevoke APIを呼ぶ', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
      vi.stubGlobal('fetch', fetchMock);

      const result = await revokePurchaseProvisioning({ eventId: 'evt_revoke_1', orderId: 'order-1', commonUserId: 'cu_test_001', reason: 'full_refund' });

      expect(result).toBe(true);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://agency-system.example.com/api/purchase-provisioning/revoke');
      expect(options.headers['Idempotency-Key']).toBe('purchase-provisioning-revoke:order-1');
      const body = JSON.parse(options.body);
      expect(body.reason).toBe('full_refund');
      expect(body.order_id).toBe('order-1');
    });

    it('ok=falseの応答はfalseを返す', async () => {
      process.env.PURCHASE_PROVISIONING_ENABLED = 'true';
      await setSetting('purchase_provisioning_hmac_key_id', 'key-123');
      await setSetting('purchase_provisioning_hmac_secret', 'secret-abc');
      await setSetting('purchase_provisioning_base_url', 'https://agency-system.example.com');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: false }) }));

      const result = await revokePurchaseProvisioning({ eventId: 'evt_revoke_1', orderId: 'order-1', commonUserId: 'cu_test_001', reason: 'full_refund' });
      expect(result).toBe(false);
    });
  });
});
