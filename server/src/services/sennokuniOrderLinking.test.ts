import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { runBestEffortSennokuniOrderLinking } from './sennokuniOrderLinking';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT・2026-07-22指示書対応):
// common_user_id解決→referral capture/confirmを順番に実行し、注文へ代理店4役をスナップショットする
// オーケストレーターの回帰テスト。Feature Flag無効時(既定)は既存注文へ一切影響しないことを
// 重点的に確認する(既存決済フローを壊さない、という最重要要件)。
describe('sennokuniOrderLinking(仕様書外の拡張・2026-07-22指示書対応)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  async function createTestOrder(opts: { userId?: string | null; referralCode?: string | null }) {
    return prisma.order.create({
      data: {
        orderNumber: `SG-LINKING-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        userId: opts.userId ?? undefined,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'Linkingテスト太郎',
        customerEmail: 'sennokuni-linking-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
        referralCode: opts.referralCode ?? undefined,
      },
    });
  }

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
    await prisma.order.deleteMany({ where: { customerEmail: 'sennokuni-linking-test@example.com' } });
    await prisma.user.deleteMany({ where: { email: { contains: 'sennokuni-linking-test' } } });
    await prisma.$disconnect();
  });

  it('Feature Flag無効時は注文を一切更新しない(既存決済フローへの影響なし)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const order = await createTestOrder({ referralCode: 'SGI0001' });

    await runBestEffortSennokuniOrderLinking(order.id);

    expect(fetchMock).not.toHaveBeenCalled();
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.commonUserId).toBeNull();
    expect(after.commonUserResolutionStatus).toBe('unresolved');
    expect(after.registrationReferrerAgentCode).toBeNull();
  });

  it('Feature Flag有効時: common_user_id解決→referral confirmが成功し、代理店4役が注文へ保存される', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const user = await prisma.user.create({
      data: {
        name: 'Linkingユーザー',
        email: `sennokuni-linking-test-user-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('password123', 10),
      },
    });
    const order = await createTestOrder({ userId: user.id, referralCode: 'SGI0001' });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/common-users/resolve')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ common_user_id: 'cu_test_linking' }) });
      }
      if (url.endsWith('/api/referrals/capture')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'captured',
              canonical_referral_token: 'rt_test_linking',
              referral_session_key: 'rs_test_linking',
              agency_id: 'AGENT-CODE-001',
              expires_at: null,
            }),
        });
      }
      if (url.endsWith('/api/referrals/confirm')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'confirmed',
              common_user_id: 'cu_test_linking',
              registration_referrer_agency_id: 'AGENT-CODE-001',
              assigned_agency_id: 'AGENT-CODE-002',
              sales_agent_id: 'AGENT-CODE-003',
              closing_agent_id: 'AGENT-CODE-004',
            }),
        });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await runBestEffortSennokuniOrderLinking(order.id);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.commonUserId).toBe('cu_test_linking');
    expect(after.commonUserResolutionStatus).toBe('resolved');
    expect(after.referralSessionKey).toBe('rs_test_linking');
    expect(after.registrationReferrerAgentCode).toBe('AGENT-CODE-001');
    expect(after.assignedAgentCode).toBe('AGENT-CODE-002');
    expect(after.salesAgentCode).toBe('AGENT-CODE-003');
    expect(after.closingAgentCode).toBe('AGENT-CODE-004');

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updatedUser.commonUserId).toBe('cu_test_linking');

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('common_user_idが解決できない場合はreferral_session_keyのみ保存し、担当者4役は確定しない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    // userIdなし(ゲストのcommon_user_id解決対象が無い)注文。
    const order = await createTestOrder({ referralCode: 'SGI0002' });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/referrals/capture')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: 'captured',
              canonical_referral_token: 'rt_test_linking2',
              referral_session_key: 'rs_test_linking2',
              agency_id: 'AGENT-CODE-005',
              expires_at: null,
            }),
        });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await runBestEffortSennokuniOrderLinking(order.id);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.referralSessionKey).toBe('rs_test_linking2');
    expect(after.registrationReferrerAgentCode).toBeNull();
    expect(after.commonUserResolutionStatus).toBe('unresolved');
    // confirmは呼ばれていない(common_user_id未解決のため)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('referralCodeが無い注文はcapture/confirmを呼ばない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const order = await createTestOrder({ referralCode: null });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await runBestEffortSennokuniOrderLinking(order.id);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
