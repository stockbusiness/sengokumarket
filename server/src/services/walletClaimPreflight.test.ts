import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { buildWalletClaimPreflightReport } from './walletClaimPreflight';

const ALL_SETTING_KEYS = [
  'wallet_claim_web_base_url',
  'wallet_claim_inbound_key_id',
  'wallet_claim_inbound_hmac_secret',
  'ove_wallet_events_key_id',
  'ove_wallet_events_hmac_secret',
  'ove_wallet_base_url',
] as const;

async function createProduct(suffix: string) {
  return prisma.product.create({
    data: {
      name: `wallet-claim-preflight-test-${suffix}`,
      slug: `wallet-claim-preflight-test-${suffix}-${Date.now()}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
}

// Wallet Claim本番前安定化指示書(2026-07-25)Phase8(10章「Wallet Claim Preflight拡張」)。
describe('walletClaimPreflight: buildWalletClaimPreflightReport', () => {
  const originalWalletClaimFlag = process.env.ENABLE_WALLET_CLAIM;
  const originalDeliveryFlag = process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;
  const originalCronSecret = process.env.CRON_SECRET;
  const createdProductIds: string[] = [];

  afterEach(async () => {
    process.env.ENABLE_WALLET_CLAIM = originalWalletClaimFlag;
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = originalDeliveryFlag;
    process.env.CRON_SECRET = originalCronSecret;
    await prisma.setting.deleteMany({ where: { key: { in: [...ALL_SETTING_KEYS] } } });
    await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    createdProductIds.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('すべて未設定・未有効の場合、walletClaimReady/collectibleDeliveryReady/overallReadyはすべてfalse', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    delete process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;
    delete process.env.CRON_SECRET;

    const report = await buildWalletClaimPreflightReport();
    expect(report.walletClaimReady).toBe(false);
    expect(report.collectibleDeliveryReady).toBe(false);
    expect(report.overallReady).toBe(false);
  });

  it('ENABLE_WALLET_CLAIM=trueかつ必須設定が揃うとwalletClaimReady=trueになる', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    await setSetting('wallet_claim_web_base_url', 'https://claim.example.com');
    await setSetting('wallet_claim_inbound_key_id', 'inbound-key');
    await setSetting('wallet_claim_inbound_hmac_secret', 'inbound-secret');

    const report = await buildWalletClaimPreflightReport();
    expect(report.walletClaimReady).toBe(true);
  });

  it('ENABLE_DIGITAL_COLLECTIBLE_DELIVERY=trueかつ必須設定・CRON_SECRETが揃うとcollectibleDeliveryReady=trueになる', async () => {
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    process.env.CRON_SECRET = 'cron-secret-abc';
    await setSetting('ove_wallet_events_key_id', 'events-key');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret');
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');

    const report = await buildWalletClaimPreflightReport();
    expect(report.collectibleDeliveryReady).toBe(true);
  });

  it('ENABLE_WALLET_CLAIM=trueかつENABLE_DIGITAL_COLLECTIBLE_DELIVERY=falseはclaim_enabled_delivery_disabledのissueを含む', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    delete process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;

    const report = await buildWalletClaimPreflightReport();
    expect(report.issues.map((i) => i.code)).toContain('claim_enabled_delivery_disabled');
  });

  it('ENABLE_WALLET_CLAIM=falseかつ有効なdigital_collectibleルールがあればclaim_disabled_rule_enabledのissueを含む', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    const product = await createProduct('rule-enabled');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
    });

    const report = await buildWalletClaimPreflightReport();
    expect(report.enabledDigitalCollectibleRuleCount).toBeGreaterThanOrEqual(1);
    expect(report.issues.map((i) => i.code)).toContain('claim_disabled_rule_enabled');
  });

  it('asset_code未設定の有効なdigital_collectibleルールはrule_missing_asset_codeのissueを含む', async () => {
    const product = await createProduct('no-asset-code');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true, assetCode: null },
    });

    const report = await buildWalletClaimPreflightReport();
    expect(report.rulesMissingAssetCode).toBeGreaterThanOrEqual(1);
    expect(report.issues.map((i) => i.code)).toContain('rule_missing_asset_code');
  });

  it('requireCommonUserId=falseの有効なdigital_collectibleルールはrule_require_common_user_id_falseのissueを含む', async () => {
    const product = await createProduct('require-common-false');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: {
        productId: product.id,
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        enabled: true,
        assetCode: 'SGK-CARD-001',
        requireCommonUserId: false,
      },
    });

    const report = await buildWalletClaimPreflightReport();
    expect(report.rulesWithoutRequireCommonUserId).toBeGreaterThanOrEqual(1);
    expect(report.issues.map((i) => i.code)).toContain('rule_require_common_user_id_false');
  });

  it('dead/blocked件数が1件以上ある間はoverallReady=falseになる', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    process.env.CRON_SECRET = 'cron-secret-abc';
    await setSetting('wallet_claim_web_base_url', 'https://claim.example.com');
    await setSetting('wallet_claim_inbound_key_id', 'inbound-key');
    await setSetting('wallet_claim_inbound_hmac_secret', 'inbound-secret');
    await setSetting('ove_wallet_events_key_id', 'events-key');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret');
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');

    const readyReport = await buildWalletClaimPreflightReport();
    expect(readyReport.walletClaimReady).toBe(true);
    expect(readyReport.collectibleDeliveryReady).toBe(true);
    expect(readyReport.overallReady).toBe(true);

    const event = await prisma.integrationOutboxEvent.create({
      data: {
        eventId: `evt_preflight_dead_test_${Date.now()}`,
        eventType: 'entitlement.granted',
        destinationSystemKey: 'ove-wallet',
        originalPayload: {},
        originalPayloadHash: `preflight-dead-test-original-${Date.now()}`,
        deliveryPayload: {},
        deliveryPayloadHash: `preflight-dead-test-${Date.now()}`,
        status: 'dead',
      },
    });

    const report = await buildWalletClaimPreflightReport();
    expect(report.deadCount).toBeGreaterThanOrEqual(1);
    expect(report.overallReady).toBe(false);

    await prisma.integrationOutboxEvent.deleteMany({ where: { id: event.id } });
  });
});
