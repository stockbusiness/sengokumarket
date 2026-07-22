import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { grantReward, reverseReward } from './oveWalletRewardClient';

// 仕様書外の拡張(SYSTEM_ANALYSIS_千ノ国ウォレット・2026-07-22指示書対応): OVE Walletは共通契約
// (X-SenNoKuni-*)とは別のHMAC方式・認証情報を使うため、専用クライアントとして分離実装している。
// Feature Flag(既定OFF)・接続情報が揃うまで外部へ送信しない。
describe('oveWalletRewardClient(仕様書外の拡張・2026-07-22指示書対応)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({ where: { key: { in: ['ove_wallet_api_key_id', 'ove_wallet_hmac_secret', 'ove_wallet_base_url'] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('grantReward', () => {
    it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await grantReward({
        externalUserId: 'user-1',
        commonUserId: 'cu_test_001',
        amount: 100,
        rewardRuleId: null,
        idempotencyKey: 'idem-1',
        correlationId: 'corr-1',
      });

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Feature Flag有効・接続情報設定済みならOVE独自HMACヘッダー付きでgrant APIを呼ぶ', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('ove_wallet_api_key_id', 'ove-key-1');
      await setSetting('ove_wallet_hmac_secret', 'ove-secret-1');
      await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ transaction_id: 'tx_test_001' }) });
      vi.stubGlobal('fetch', fetchMock);

      const result = await grantReward({
        externalUserId: 'user-1',
        commonUserId: 'cu_test_001',
        amount: 100,
        rewardRuleId: 'rule-1',
        idempotencyKey: 'idem-1',
        correlationId: 'corr-1',
      });

      expect(result).toEqual({ transactionId: 'tx_test_001' });
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://ove-wallet.example.com/api/v1/rewards/grant');
      expect(options.headers['X-OVE-Api-Key']).toBe('ove-key-1');
      expect(options.headers['X-OVE-Signature']).toBeTruthy();
      expect(options.headers['X-OVE-Nonce']).toBeTruthy();
      expect(options.headers['X-SenNoKuni-Key-Id']).toBeUndefined();
      expect(JSON.parse(options.body)).toMatchObject({ idempotency_key: 'idem-1', amount: 100 });
    });
  });

  describe('reverseReward', () => {
    it('Feature Flag無効時はfetchを呼ばずfalseを返す', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await reverseReward('tx_test_001', '全額返金');

      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Feature Flag有効時はtransaction idを含むreverse APIを呼ぶ', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSetting('ove_wallet_api_key_id', 'ove-key-1');
      await setSetting('ove_wallet_hmac_secret', 'ove-secret-1');
      await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      vi.stubGlobal('fetch', fetchMock);

      const result = await reverseReward('tx_test_001', '全額返金');

      expect(result).toBe(true);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://ove-wallet.example.com/api/v1/transactions/tx_test_001/reverse');
    });
  });
});
