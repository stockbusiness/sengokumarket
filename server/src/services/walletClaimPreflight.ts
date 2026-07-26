import { prisma } from '../lib/prisma';
import { getSetting } from './settings';
import { isWalletClaimEnabled, isDigitalCollectibleDeliveryEnabled } from './walletClaimConfig';
import { DIGITAL_COLLECTIBLE_DESTINATION, DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE } from './digitalCollectible';
import { checkMigrationsHealth } from './readinessCheck';

// Wallet Claim本番前安定化指示書(2026-07-25)Phase8(10章「Wallet Claim Preflight拡張」):
// 既存のintegrationPreflight.ts(千ノ国全体連携)とは別に、Wallet Claim/digital_collectible
// 送付固有の必須設定・整合性をまとめて確認できるようにする。10.3の分類(walletClaimReady=
// Claim確認APIが機能する条件・collectibleDeliveryReady=カード送付が機能する条件・
// overallReady=両方+警告なし)に対応する。

export interface WalletClaimPreflightIssue {
  code: string;
  message: string;
}

export interface WalletClaimPreflightSettingCheck {
  key: string;
  configured: boolean;
}

export interface WalletClaimPreflightReport {
  walletClaimEnabled: boolean;
  digitalCollectibleDeliveryEnabled: boolean;
  settingChecks: WalletClaimPreflightSettingCheck[];
  enabledDigitalCollectibleRuleCount: number;
  rulesMissingAssetCode: number;
  rulesWithoutRequireCommonUserId: number;
  rulesOnNonNftProduct: number;
  migrationsOk: boolean;
  missingMigrations: string[];
  pendingCount: number;
  deadCount: number;
  blockedCount: number;
  cronSecretConfigured: boolean;
  issues: WalletClaimPreflightIssue[];
  walletClaimReady: boolean;
  collectibleDeliveryReady: boolean;
  overallReady: boolean;
}

const WALLET_CLAIM_SETTING_KEYS = ['wallet_claim_web_base_url', 'wallet_claim_inbound_key_id', 'wallet_claim_inbound_hmac_secret'] as const;
const DELIVERY_SETTING_KEYS = ['ove_wallet_events_key_id', 'ove_wallet_events_hmac_secret', 'ove_wallet_base_url'] as const;

export async function buildWalletClaimPreflightReport(): Promise<WalletClaimPreflightReport> {
  const walletClaimEnabled = isWalletClaimEnabled();
  const digitalCollectibleDeliveryEnabled = isDigitalCollectibleDeliveryEnabled();

  const allKeys = [...WALLET_CLAIM_SETTING_KEYS, ...DELIVERY_SETTING_KEYS];
  const settingChecks = await Promise.all(allKeys.map(async (key) => ({ key, configured: Boolean(await getSetting(key)) })));
  const configuredMap = new Map(settingChecks.map((c) => [c.key, c.configured]));

  const enabledRules = await prisma.productIntegrationRule.findMany({
    where: { enabled: true, entitlementTargetSystemKey: DIGITAL_COLLECTIBLE_DESTINATION, entitlementType: DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE },
    include: { product: { select: { itemType: true } } },
  });
  const rulesMissingAssetCode = enabledRules.filter((r) => !r.assetCode).length;
  const rulesWithoutRequireCommonUserId = enabledRules.filter((r) => !r.requireCommonUserId).length;
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase10(12.3「Preflightでも再確認」): 管理API側
  // (productIntegrationRules.ts)で新規作成・更新時は既にitemType=nft以外を拒否しているが、
  // 商品自体のitemTypeが後から変更された等の既存データも念のためここで検知する。
  const rulesOnNonNftProduct = enabledRules.filter((r) => r.product.itemType !== 'nft').length;

  const migrationsHealth = await checkMigrationsHealth();
  const [pendingCount, deadCount, blockedCount] = await Promise.all([
    prisma.integrationOutboxEvent.count({ where: { status: 'pending' } }),
    prisma.integrationOutboxEvent.count({ where: { status: 'dead' } }),
    prisma.integrationOutboxEvent.count({ where: { status: 'blocked' } }),
  ]);
  const cronSecretConfigured = Boolean(process.env.CRON_SECRET);

  const issues: WalletClaimPreflightIssue[] = [];

  if (walletClaimEnabled && !digitalCollectibleDeliveryEnabled) {
    issues.push({
      code: 'claim_enabled_delivery_disabled',
      message: 'ENABLE_WALLET_CLAIMは有効ですがENABLE_DIGITAL_COLLECTIBLE_DELIVERYが無効です。Claim確認は進みますが、カードの実送信は行われずpendingのまま蓄積します。',
    });
  }
  if (!walletClaimEnabled && enabledRules.length > 0) {
    issues.push({
      code: 'claim_disabled_rule_enabled',
      message: `ENABLE_WALLET_CLAIMが無効なのに、有効なdigital_collectibleルールが${enabledRules.length}件あります。対象のNftIssueがClaimも既存自動Mintも通らず滞留します。`,
    });
  }
  if (!configuredMap.get('wallet_claim_web_base_url')) {
    issues.push({ code: 'web_url_missing', message: 'wallet_claim_web_base_url(受取ページURL)が未設定です。' });
  }
  if (!configuredMap.get('wallet_claim_inbound_key_id') || !configuredMap.get('wallet_claim_inbound_hmac_secret')) {
    issues.push({ code: 'inbound_hmac_missing', message: '千ノ国ウォレットからのClaim確認APIを認証するinbound HMAC鍵が未設定です。' });
  }
  if (!configuredMap.get('ove_wallet_events_key_id') || !configuredMap.get('ove_wallet_events_hmac_secret') || !configuredMap.get('ove_wallet_base_url')) {
    issues.push({ code: 'outbound_hmac_missing', message: 'カード送付(entitlement.granted/revoked)の送信先・認証情報が未設定です。' });
  }
  if (rulesMissingAssetCode > 0) {
    issues.push({ code: 'rule_missing_asset_code', message: `asset_code未設定の有効なdigital_collectibleルールが${rulesMissingAssetCode}件あります。` });
  }
  if (rulesOnNonNftProduct > 0) {
    issues.push({
      code: 'rule_on_non_nft_product',
      message: `itemType=nft以外の商品に設定された有効なdigital_collectibleルールが${rulesOnNonNftProduct}件あります。`,
    });
  }
  if (rulesWithoutRequireCommonUserId > 0) {
    issues.push({
      code: 'rule_require_common_user_id_false',
      message: `requireCommonUserId=falseの有効なdigital_collectibleルールが${rulesWithoutRequireCommonUserId}件あります。common_user_id未解決のまま送付対象になりえます。`,
    });
  }
  if (!migrationsHealth.ok) {
    issues.push({
      code: 'migration_missing',
      message: `必須migrationが未適用です: ${(migrationsHealth.missing ?? []).join(', ') || migrationsHealth.error}`,
    });
  }
  if (deadCount > 0) {
    issues.push({ code: 'dead_events_present', message: `dead状態のOutboxイベントが${deadCount}件あります。管理画面から手動再送が必要です。` });
  }
  if (blockedCount > 0) {
    issues.push({ code: 'blocked_events_present', message: `blocked状態のOutboxイベントが${blockedCount}件あります。` });
  }
  if (!cronSecretConfigured) {
    issues.push({
      code: 'cron_secret_missing',
      message: 'CRON_SECRETが未設定です。5分Cron(process-integration-outbox)等の内部cronが認証エラーになります。',
    });
  }

  const walletClaimReady =
    walletClaimEnabled &&
    Boolean(configuredMap.get('wallet_claim_web_base_url')) &&
    Boolean(configuredMap.get('wallet_claim_inbound_key_id')) &&
    Boolean(configuredMap.get('wallet_claim_inbound_hmac_secret')) &&
    migrationsHealth.ok;

  const collectibleDeliveryReady =
    digitalCollectibleDeliveryEnabled &&
    Boolean(configuredMap.get('ove_wallet_events_key_id')) &&
    Boolean(configuredMap.get('ove_wallet_events_hmac_secret')) &&
    Boolean(configuredMap.get('ove_wallet_base_url')) &&
    cronSecretConfigured &&
    migrationsHealth.ok;

  // 10.3「overallReady」: Wallet Claim・Delivery双方の必須設定が揃い、かつ機能横断の警告
  // (Feature Flag不整合・asset_code欠落・itemType不整合・dead/blocked滞留)も無い状態。
  const overallReady =
    walletClaimReady &&
    collectibleDeliveryReady &&
    rulesMissingAssetCode === 0 &&
    rulesOnNonNftProduct === 0 &&
    deadCount === 0 &&
    blockedCount === 0;

  return {
    walletClaimEnabled,
    digitalCollectibleDeliveryEnabled,
    settingChecks,
    enabledDigitalCollectibleRuleCount: enabledRules.length,
    rulesMissingAssetCode,
    rulesWithoutRequireCommonUserId,
    rulesOnNonNftProduct,
    migrationsOk: migrationsHealth.ok,
    missingMigrations: migrationsHealth.missing ?? [],
    pendingCount,
    deadCount,
    blockedCount,
    cronSecretConfigured,
    issues,
    walletClaimReady,
    collectibleDeliveryReady,
    overallReady,
  };
}
