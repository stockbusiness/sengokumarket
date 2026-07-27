import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { setSennokuniIntegrationStageSetting } from './sennokuniIntegrationConfig';
import { buildIntegrationPreflightReport } from './integrationPreflight';

const ALL_SETTING_KEYS = [
  'sennokuni_hmac_key_id',
  'sennokuni_hmac_secret',
  'sennokuni_agency_hub_base_url',
  'integration_endpoint_sengoku_passport',
  'integration_endpoint_path_sengoku_passport',
  'integration_endpoint_ai_art_school',
  'integration_endpoint_path_ai_art_school',
  'ove_wallet_base_url',
  'ove_wallet_api_key_id',
  'ove_wallet_hmac_secret',
] as const;

async function createProduct(suffix: string) {
  return prisma.product.create({
    data: {
      name: `preflightテスト商品-${suffix}`,
      slug: `preflight-test-${suffix}-${Date.now()}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
}

// 本番安定化指示書Stage8(11.2・11.3): 使用する送信先だけを必須とする・URL/path形式・
// HMAC自己診断・backlog/dead/blocked件数・product rule件数。
describe('integrationPreflight(本番安定化指示書Stage8)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const createdProductIds: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({ where: { key: { in: [...ALL_SETTING_KEYS, 'sennokuni_integration_stage'] } } });
    await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    createdProductIds.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('使用中の送信先が無い場合、sennokuni hub設定のみが必須になる', async () => {
    const report = await buildIntegrationPreflightReport();
    expect(report.usedDestinations).toEqual([]);
    const requiredKeys = report.settingChecks.map((c) => c.key);
    expect(requiredKeys).toEqual(['sennokuni_hmac_key_id', 'sennokuni_hmac_secret', 'sennokuni_agency_hub_base_url']);
    expect(report.missingSettings).toEqual(requiredKeys);
    expect(report.readyForActivation).toBe(false);
  });

  it('enabled=trueのProductIntegrationRuleで使われている送信先だけが追加で必須になる', async () => {
    const product = await createProduct('used-passport');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'sengoku-passport', enabled: true },
    });

    const report = await buildIntegrationPreflightReport();
    expect(report.usedDestinations).toEqual(['sengoku-passport']);
    expect(report.missingSettings).toContain('integration_endpoint_sengoku_passport');
    expect(report.missingSettings).toContain('integration_endpoint_path_sengoku_passport');
    // ai-art-school/ove-walletは使われていないため必須に含まれない。
    expect(report.missingSettings).not.toContain('integration_endpoint_ai_art_school');
    expect(report.missingSettings).not.toContain('ove_wallet_base_url');
  });

  it('enabled=falseのルールは使用中とみなさない', async () => {
    const product = await createProduct('disabled-rule');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ai-art-school', enabled: false },
    });

    const report = await buildIntegrationPreflightReport();
    expect(report.usedDestinations).toEqual([]);
  });

  it('URL形式が不正な設定はinvalidFormatSettingsに含まれる', async () => {
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'not-a-valid-url');

    const report = await buildIntegrationPreflightReport();
    expect(report.invalidFormatSettings).toContain('sennokuni_agency_hub_base_url');
    expect(report.readyForActivation).toBe(false);
  });

  it('path形式が不正な設定(先頭が/でない)はinvalidFormatSettingsに含まれる', async () => {
    const product = await createProduct('bad-path');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'sengoku-passport', enabled: true },
    });
    await setSetting('integration_endpoint_sengoku_passport', 'https://passport.example.com');
    await setSetting('integration_endpoint_path_sengoku_passport', 'shopping/webhook');

    const report = await buildIntegrationPreflightReport();
    expect(report.invalidFormatSettings).toContain('integration_endpoint_path_sengoku_passport');
  });

  it('HMAC自己診断: secretが設定されていれば決定論的な64桁16進の署名を生成できるかを確認する', async () => {
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const report = await buildIntegrationPreflightReport();
    const sennokuniTest = report.hmacSelfTests.find((t) => t.target === 'sennokuni')!;
    expect(sennokuniTest.configured).toBe(true);
    expect(sennokuniTest.passed).toBe(true);
  });

  it('HMAC自己診断: secret未設定の場合はnull(判定不能)になる', async () => {
    const report = await buildIntegrationPreflightReport();
    const sennokuniTest = report.hmacSelfTests.find((t) => t.target === 'sennokuni')!;
    expect(sennokuniTest.configured).toBe(false);
    expect(sennokuniTest.passed).toBeNull();
  });

  it('ove-walletが使用中の場合のみove-walletのHMAC自己診断を行う', async () => {
    const productA = await createProduct('ove-a');
    createdProductIds.push(productA.id);
    await prisma.productIntegrationRule.create({
      data: { productId: productA.id, entitlementTargetSystemKey: 'ove-wallet', enabled: true },
    });
    await setSetting('ove_wallet_hmac_secret', 'ove-secret-abc');

    const report = await buildIntegrationPreflightReport();
    const oveTest = report.hmacSelfTests.find((t) => t.target === 'ove-wallet');
    expect(oveTest).toBeTruthy();
    expect(oveTest!.passed).toBe(true);
  });

  it('接続テスト: 到達できれば ok:true、例外時はok:falseになる', async () => {
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));

    const report = await buildIntegrationPreflightReport();
    const hubTest = report.connectionTests.find((t) => t.target === 'sennokuni-hub')!;
    expect(hubTest.ok).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const report2 = await buildIntegrationPreflightReport();
    const hubTest2 = report2.connectionTests.find((t) => t.target === 'sennokuni-hub')!;
    expect(hubTest2.ok).toBe(false);
    expect(hubTest2.error).toBeTruthy();
  });

  it('接続テスト: baseUrl未設定の宛先はok:null(判定不能)になる', async () => {
    const report = await buildIntegrationPreflightReport();
    const hubTest = report.connectionTests.find((t) => t.target === 'sennokuni-hub')!;
    expect(hubTest.ok).toBeNull();
    expect(hubTest.baseUrl).toBeNull();
  });

  it('backlog(pending)・dead・blocked件数とproduct rule件数を返す', async () => {
    const product = await createProduct('counts');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'sengoku-passport', enabled: true },
    });
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ai-art-school', enabled: false },
    });

    const report = await buildIntegrationPreflightReport();
    expect(typeof report.backlogCount).toBe('number');
    expect(typeof report.deadCount).toBe('number');
    expect(typeof report.blockedCount).toBe('number');
    // enabled=trueの1件のみカウントされる。
    expect(report.productRuleCount).toBeGreaterThanOrEqual(1);
  });

  it('すべての必須設定・形式・HMAC自己診断が揃うとreadyForActivation=trueになる', async () => {
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const report = await buildIntegrationPreflightReport();
    expect(report.missingSettings).toEqual([]);
    expect(report.invalidFormatSettings).toEqual([]);
    expect(report.readyForActivation).toBe(true);
  });

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase5(7.4「Preflightで明確に表示」)。
  describe('walletClaimFlagInconsistentRuleCount', () => {
    const originalWalletClaimFlag = process.env.ENABLE_WALLET_CLAIM;

    afterEach(() => {
      process.env.ENABLE_WALLET_CLAIM = originalWalletClaimFlag;
    });

    it('ENABLE_WALLET_CLAIM=falseかつ有効なdigital_collectibleルールがあれば1件以上カウントしreadyForActivation=falseになる', async () => {
      delete process.env.ENABLE_WALLET_CLAIM;
      const product = await createProduct('flag-inconsistent');
      createdProductIds.push(product.id);
      await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });

      const report = await buildIntegrationPreflightReport();
      expect(report.walletClaimFlagInconsistentRuleCount).toBeGreaterThanOrEqual(1);
      expect(report.readyForActivation).toBe(false);
    });

    it('ENABLE_WALLET_CLAIM=trueなら同じルールでもカウントしない', async () => {
      process.env.ENABLE_WALLET_CLAIM = 'true';
      const product = await createProduct('flag-consistent');
      createdProductIds.push(product.id);
      await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });

      const report = await buildIntegrationPreflightReport();
      expect(report.walletClaimFlagInconsistentRuleCount).toBe(0);
    });
  });
});
