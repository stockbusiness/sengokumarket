import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { setSennokuniIntegrationStageSetting } from './sennokuniIntegrationConfig';
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
    await prisma.jobSchedulerHeartbeat.deleteMany({ where: { jobName: 'process-integration-outbox' } });
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
    await setSetting('wallet_claim_inbound_hmac_secret', 'inbound-secret-value');

    const report = await buildWalletClaimPreflightReport();
    expect(report.walletClaimReady).toBe(true);
  });

  it('ENABLE_DIGITAL_COLLECTIBLE_DELIVERY=trueかつ必須設定・CRON_SECRETが揃うとcollectibleDeliveryReady=trueになる', async () => {
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    process.env.CRON_SECRET = 'cron-secret-abc';
    await setSetting('ove_wallet_events_key_id', 'events-key');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret-value');
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

  it('requireCommonUserId=falseの有効なdigital_collectibleルールはrule_require_common_user_id_falseのissueを含み、overallReadyもfalseになる(最終安定化指示書Phase3)', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    process.env.CRON_SECRET = 'cron-secret-abc';
    await setSetting('wallet_claim_web_base_url', 'https://claim.example.com');
    await setSetting('wallet_claim_inbound_key_id', 'inbound-key');
    await setSetting('wallet_claim_inbound_hmac_secret', 'inbound-secret-value');
    await setSetting('ove_wallet_events_key_id', 'events-key');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret-value');
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');

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
    // requireCommonUserId=falseのルールが1件でもあればoverallReadyはfalse
    // (production/staging切替ゲートがこのフラグを直接参照するため)。
    expect(report.overallReady).toBe(false);
  });

  it('dead/blocked件数が1件以上ある間はoverallReady=falseになる', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    process.env.CRON_SECRET = 'cron-secret-abc';
    await setSetting('wallet_claim_web_base_url', 'https://claim.example.com');
    await setSetting('wallet_claim_inbound_key_id', 'inbound-key');
    await setSetting('wallet_claim_inbound_hmac_secret', 'inbound-secret-value');
    await setSetting('ove_wallet_events_key_id', 'events-key');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret-value');
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');
    // 最終安定化指示書Phase7「Scheduler主系/予備系整理」: overallReady=trueには
    // 主系(vercel)による直近10分以内のprocess-integration-outbox成功実績も必要。
    await prisma.jobSchedulerHeartbeat.create({
      data: {
        jobName: 'process-integration-outbox',
        schedulerSource: 'vercel',
        startedAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    });

    const readyReport = await buildWalletClaimPreflightReport();
    expect(readyReport.walletClaimReady).toBe(true);
    expect(readyReport.collectibleDeliveryReady).toBe(true);
    expect(readyReport.schedulerHeartbeatOk).toBe(true);
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

  // 最終安定化指示書Phase5「ProductIntegrationRule制約完成」
  it('rarity未設定の有効なdigital_collectibleルールはrule_missing_rarityのissueを含み、overallReadyもfalseになる', async () => {
    const product = await createProduct('no-rarity');
    createdProductIds.push(product.id);
    await prisma.productIntegrationRule.create({
      data: {
        productId: product.id,
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        enabled: true,
        assetCode: 'SGK-CARD-001',
        requireCommonUserId: true,
        collectibleRarity: null,
      },
    });

    const report = await buildWalletClaimPreflightReport();
    expect(report.rulesMissingRarity).toBeGreaterThanOrEqual(1);
    expect(report.issues.map((i) => i.code)).toContain('rule_missing_rarity');
    expect(report.overallReady).toBe(false);
  });

  it('destinationがove-wallet以外のdigital_collectibleルール(既存不正データ)はrule_invalid_destinationのissueを含み、overallReadyもfalseになる', async () => {
    const product = await createProduct('invalid-destination');
    createdProductIds.push(product.id);
    // 管理API(productIntegrationRules.ts)は書き込み時にこの組合せを拒否するため、
    // 既存不正データを再現するためにPrismaで直接作成する。
    await prisma.productIntegrationRule.create({
      data: {
        productId: product.id,
        entitlementTargetSystemKey: 'sengoku-passport',
        entitlementType: 'digital_collectible',
        enabled: false,
      },
    });

    const report = await buildWalletClaimPreflightReport();
    expect(report.rulesWithInvalidDestination).toBeGreaterThanOrEqual(1);
    expect(report.issues.map((i) => i.code)).toContain('rule_invalid_destination');
    expect(report.overallReady).toBe(false);
  });

  // 最終安定化指示書Phase6「Wallet Claim Preflight高度化」。
  describe('Phase6: URL形式・鍵/秘密の妥当性・HMAC自己診断・global flag整合', () => {
    it('wallet_claim_web_base_urlが絶対URLでない場合、url_not_absoluteのissueを含みoverallReadyもfalseになる', async () => {
      process.env.ENABLE_WALLET_CLAIM = 'true';
      await setSetting('wallet_claim_web_base_url', 'not-a-url');
      await setSetting('wallet_claim_inbound_key_id', 'inbound-key');
      await setSetting('wallet_claim_inbound_hmac_secret', 'inbound-secret-value');

      const report = await buildWalletClaimPreflightReport();
      expect(report.issues.map((i) => i.code)).toContain('url_not_absolute');
      expect(report.overallReady).toBe(false);
    });

    it('production環境でove_wallet_base_urlがHTTPSでない場合、url_not_https_in_productionのissueを含む', async () => {
      const originalStage = process.env.SENNOKUNI_INTEGRATION_ENABLED;
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSennokuniIntegrationStageSetting('production');
      await setSetting('ove_wallet_base_url', 'http://ove-wallet.example.com');

      try {
        const report = await buildWalletClaimPreflightReport();
        expect(report.issues.map((i) => i.code)).toContain('url_not_https_in_production');
        expect(report.overallReady).toBe(false);
      } finally {
        process.env.SENNOKUNI_INTEGRATION_ENABLED = originalStage;
        await prisma.setting.deleteMany({ where: { key: 'sennokuni_integration_stage' } });
      }
    });

    it('鍵/秘密が既知の仮値の場合、placeholder_value_detectedのissueを含む', async () => {
      await setSetting('ove_wallet_events_key_id', 'changeme');

      const report = await buildWalletClaimPreflightReport();
      expect(report.issues.map((i) => i.code)).toContain('placeholder_value_detected');
      expect(report.overallReady).toBe(false);
    });

    it('key_idが短すぎる場合、key_id_too_shortのissueを含む', async () => {
      await setSetting('wallet_claim_inbound_key_id', 'short');

      const report = await buildWalletClaimPreflightReport();
      expect(report.issues.map((i) => i.code)).toContain('key_id_too_short');
      expect(report.overallReady).toBe(false);
    });

    it('secretが短すぎる場合、secret_too_shortのissueを含む', async () => {
      await setSetting('ove_wallet_events_hmac_secret', 'short-secret');

      const report = await buildWalletClaimPreflightReport();
      expect(report.issues.map((i) => i.code)).toContain('secret_too_short');
      expect(report.overallReady).toBe(false);
    });

    it('ove_wallet_events_*が正しく設定されていればHMAC自己診断は失敗issueを含まない', async () => {
      await setSetting('ove_wallet_events_key_id', 'valid-events-key-id');
      await setSetting('ove_wallet_events_hmac_secret', 'valid-events-hmac-secret-value');

      const report = await buildWalletClaimPreflightReport();
      expect(report.issues.map((i) => i.code)).not.toContain('wallet_events_hmac_self_test_failed');
    });

    it('有効なdigital_collectibleルールがあるのにSENNOKUNI_INTEGRATION_ENABLEDが無効な場合、global_flag_stage_inconsistentのissueを含みoverallReadyもfalseになる', async () => {
      delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
      const product = await createProduct('global-flag-inconsistent');
      createdProductIds.push(product.id);
      await prisma.productIntegrationRule.create({
        data: {
          productId: product.id,
          entitlementTargetSystemKey: 'ove-wallet',
          entitlementType: 'digital_collectible',
          enabled: true,
          assetCode: 'SGK-CARD-001',
          requireCommonUserId: true,
          collectibleRarity: 'common',
        },
      });

      const report = await buildWalletClaimPreflightReport();
      expect(report.issues.map((i) => i.code)).toContain('global_flag_stage_inconsistent');
      expect(report.overallReady).toBe(false);
    });
  });

  // 最終安定化指示書Phase7「Scheduler主系/予備系整理」。
  describe('Phase7: Scheduler heartbeat(主系の直近10分以内の成功実績)', () => {
    afterEach(async () => {
      await prisma.jobSchedulerHeartbeat.deleteMany({ where: { jobName: 'process-integration-outbox' } });
    });

    it('process-integration-outboxのheartbeatが一度も記録されていない場合、scheduler_heartbeat_staleのissueを含みschedulerHeartbeatOkはfalse', async () => {
      const report = await buildWalletClaimPreflightReport();
      expect(report.schedulerHeartbeatOk).toBe(false);
      expect(report.issues.map((i) => i.code)).toContain('scheduler_heartbeat_stale');
    });

    it('主系(vercel)による直近10分以内の成功があればschedulerHeartbeatOk=trueになる', async () => {
      await prisma.jobSchedulerHeartbeat.create({
        data: {
          jobName: 'process-integration-outbox',
          schedulerSource: 'vercel',
          startedAt: new Date(),
          finishedAt: new Date(),
          status: 'success',
        },
      });

      const report = await buildWalletClaimPreflightReport();
      expect(report.schedulerHeartbeatOk).toBe(true);
      expect(report.issues.map((i) => i.code)).not.toContain('scheduler_heartbeat_stale');
    });

    it('10分より前の成功しかない場合はschedulerHeartbeatOk=falseになる', async () => {
      await prisma.jobSchedulerHeartbeat.create({
        data: {
          jobName: 'process-integration-outbox',
          schedulerSource: 'vercel',
          startedAt: new Date(Date.now() - 20 * 60 * 1000),
          finishedAt: new Date(Date.now() - 15 * 60 * 1000),
          status: 'success',
        },
      });

      const report = await buildWalletClaimPreflightReport();
      expect(report.schedulerHeartbeatOk).toBe(false);
      expect(report.issues.map((i) => i.code)).toContain('scheduler_heartbeat_stale');
    });

    it('予備(github-actions)の成功のみでは主系不在としてschedulerHeartbeatOk=falseになる', async () => {
      await prisma.jobSchedulerHeartbeat.create({
        data: {
          jobName: 'process-integration-outbox',
          schedulerSource: 'github-actions',
          startedAt: new Date(),
          finishedAt: new Date(),
          status: 'success',
        },
      });

      const report = await buildWalletClaimPreflightReport();
      expect(report.schedulerHeartbeatOk).toBe(false);
      expect(report.issues.map((i) => i.code)).toContain('scheduler_heartbeat_stale');
    });
  });
});
