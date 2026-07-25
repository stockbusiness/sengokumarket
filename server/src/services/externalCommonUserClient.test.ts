import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { resolveCommonUserId } from './externalCommonUserClient';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT・2026-07-22指示書対応):
// common_user_id解決クライアントは、SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化され、
// かつ接続情報が揃うまで一切外部へ送信しない("Feature Flagでdormantなコード"という方針)。
describe('externalCommonUserClient(仕様書外の拡張・2026-07-22指示書対応)', () => {
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

  it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCommonUserId({ externalUserId: 'user-1', verifiedEmail: 'a@example.com' });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Feature Flag有効でも接続情報が未設定ならfetchを呼ばずnullを返す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCommonUserId({ externalUserId: 'user-1' });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Feature Flag有効・接続情報設定済みならHMAC署名ヘッダー付きでresolve APIを呼び、common_user_idを返す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com/');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ common_user_id: 'cu_test_00000001' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCommonUserId({ externalUserId: 'user-1', verifiedEmail: 'a@example.com' });

    expect(result).toEqual({ commonUserId: 'cu_test_00000001' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://agency-hub.example.com/api/common-users/resolve');
    expect(options.method).toBe('POST');
    expect(options.headers['X-SenNoKuni-Key-Id']).toBe('key-123');
    expect(options.headers['X-SenNoKuni-Signature']).toBeTruthy();
    expect(options.headers['X-SenNoKuni-Nonce']).toBeTruthy();
    expect(options.headers['X-SenNoKuni-Timestamp']).toBeTruthy();
    // 本番安定化指示書Stage5(8.2): 同じuser_idの再試行が外部側で重複解決にならないよう、
    // 固定のIdempotency-Keyを送る。
    expect(options.headers['Idempotency-Key']).toBe('common-user-resolve:user-1');
    expect(JSON.parse(options.body)).toMatchObject({
      system_key: 'sengoku-market',
      external_user_id: 'user-1',
      verified_email: 'a@example.com',
    });
  });

  it('resolve APIが非2xxを返した場合はnullを返す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));

    const result = await resolveCommonUserId({ externalUserId: 'user-1' });
    expect(result).toBeNull();
  });
});
