import { prisma } from '../lib/prisma';
import { getSetting } from './settings';
import { isWalletClaimEnabled, isDigitalCollectibleDeliveryEnabled } from './walletClaimConfig';
import { DIGITAL_COLLECTIBLE_DESTINATION, DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE } from './digitalCollectible';
import { checkMigrationsHealth } from './readinessCheck';
import { signSennokuniRequest } from '../lib/sennokuniHmac';
import { getSennokuniIntegrationStage, isSennokuniIntegrationEnabled } from './sennokuniIntegrationConfig';

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
  rulesMissingRarity: number;
  rulesWithInvalidDestination: number;
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

// 最終安定化指示書Phase6「Wallet Claim Preflight高度化」。
const MIN_KEY_ID_LENGTH = 8;
const MIN_SECRET_LENGTH = 16;
// よく使われがちな仮値・初期値のまま本番運用してしまうことを防ぐ(大文字小文字を区別しない)。
const KNOWN_PLACEHOLDER_VALUES = new Set([
  'changeme',
  'change-me',
  'change_me',
  'test',
  'testsecret',
  'test-secret',
  'secret',
  'password',
  'placeholder',
  'your-secret-here',
  'dummy',
  'example',
  '00000000',
  '12345678',
]);

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isKnownPlaceholder(value: string): boolean {
  return KNOWN_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

// カード送付(entitlement.granted/revoked)はintegrationOutboxDispatcher.tsのbuildSennokuniHeaders/
// signSennokuniRequest(共通契約のX-SenNoKuni-*方式)をove_wallet_events_*の鍵で使うため、
// integrationPreflight.tsのselfTestSennokuniHmacと同じ検証方法(決定論的・64桁16進)を用いる。
function selfTestOveWalletEventsHmac(keyId: string, secret: string): boolean {
  const input = { keyId, timestamp: '1700000000', nonce: 'wallet-claim-preflight-self-test-nonce', method: 'POST', path: '/preflight-self-test', rawBody: '{}' };
  const a = signSennokuniRequest({ ...input, secret });
  const b = signSennokuniRequest({ ...input, secret });
  return a === b && /^[0-9a-f]{64}$/.test(a);
}

// 最終安定化指示書Phase6で追加した項目のうち、1件でも該当があれば本番/staging切替を
// ブロックすべきもの(overallReadyへ折り込む対象)。
const PHASE6_BLOCKING_ISSUE_CODES = new Set([
  'url_not_absolute',
  'url_not_https_in_production',
  'placeholder_value_detected',
  'key_id_too_short',
  'secret_too_short',
  'wallet_events_hmac_self_test_failed',
  'global_flag_stage_inconsistent',
]);

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
  // 最終安定化指示書Phase5「ProductIntegrationRule制約完成」。
  const rulesMissingRarity = enabledRules.filter((r) => !r.collectibleRarity).length;
  // enabledRulesはdestination=ove-walletで絞り込み済みのため、destination不一致(パスポート等へ
  // digital_collectibleが設定された)を検知するには別途、entitlement_typeのみで数える
  // (enabledに関わらず既存データの不整合を検知する)。
  const rulesWithInvalidDestination = await prisma.productIntegrationRule.count({
    where: { entitlementType: DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE, entitlementTargetSystemKey: { not: DIGITAL_COLLECTIBLE_DESTINATION } },
  });

  const migrationsHealth = await checkMigrationsHealth();
  const [pendingCount, deadCount, blockedCount] = await Promise.all([
    prisma.integrationOutboxEvent.count({ where: { status: 'pending' } }),
    prisma.integrationOutboxEvent.count({ where: { status: 'dead' } }),
    prisma.integrationOutboxEvent.count({ where: { status: 'blocked' } }),
  ]);
  const cronSecretConfigured = Boolean(process.env.CRON_SECRET);
  const stage = await getSennokuniIntegrationStage();

  const issues: WalletClaimPreflightIssue[] = [];

  // 最終安定化指示書Phase6: URL形式(絶対URL・productionはHTTPS)。
  const webBaseUrl = await getSetting('wallet_claim_web_base_url');
  const oveWalletBaseUrl = await getSetting('ove_wallet_base_url');
  for (const [label, url] of [
    ['wallet_claim_web_base_url', webBaseUrl],
    ['ove_wallet_base_url', oveWalletBaseUrl],
  ] as const) {
    if (!url) continue;
    if (!isAbsoluteUrl(url)) {
      issues.push({ code: 'url_not_absolute', message: `${label}が絶対URLではありません: ${url}` });
    } else if (stage === 'production' && !url.startsWith('https://')) {
      issues.push({ code: 'url_not_https_in_production', message: `${label}はproduction環境ではHTTPSである必要があります: ${url}` });
    }
  }

  // 最終安定化指示書Phase6: key ID・secretの最低長・既知の仮値禁止。
  const keyIdChecks: [string, string | null][] = [
    ['wallet_claim_inbound_key_id', await getSetting('wallet_claim_inbound_key_id')],
    ['ove_wallet_events_key_id', await getSetting('ove_wallet_events_key_id')],
  ];
  const secretChecks: [string, string | null][] = [
    ['wallet_claim_inbound_hmac_secret', await getSetting('wallet_claim_inbound_hmac_secret')],
    ['ove_wallet_events_hmac_secret', await getSetting('ove_wallet_events_hmac_secret')],
  ];
  for (const [label, value] of keyIdChecks) {
    if (!value) continue;
    if (isKnownPlaceholder(value)) {
      issues.push({ code: 'placeholder_value_detected', message: `${label}が既知の仮値のままです。実際の値に置き換えてください。` });
    } else if (value.length < MIN_KEY_ID_LENGTH) {
      issues.push({ code: 'key_id_too_short', message: `${label}が短すぎます(${MIN_KEY_ID_LENGTH}文字以上を推奨)。` });
    }
  }
  for (const [label, value] of secretChecks) {
    if (!value) continue;
    if (isKnownPlaceholder(value)) {
      issues.push({ code: 'placeholder_value_detected', message: `${label}が既知の仮値のままです。実際の値に置き換えてください。` });
    } else if (value.length < MIN_SECRET_LENGTH) {
      issues.push({ code: 'secret_too_short', message: `${label}が短すぎます(${MIN_SECRET_LENGTH}文字以上を推奨)。` });
    }
  }

  // 最終安定化指示書Phase6「HMAC付きconnection-test成功」: 正式な相互テストベクトルは
  // 統合責任者確定前のため(integrationPreflight.tsの自己診断と同じ方針)、ここでは
  // 「設定された鍵で決定論的に正しい形式(64桁16進)の署名を生成できるか」の自己診断にとどめる。
  const oveWalletEventsSecret = await getSetting('ove_wallet_events_hmac_secret');
  const oveWalletEventsKeyId = await getSetting('ove_wallet_events_key_id');
  const walletEventsHmacSelfTestPassed =
    oveWalletEventsSecret && oveWalletEventsKeyId ? selfTestOveWalletEventsHmac(oveWalletEventsKeyId, oveWalletEventsSecret) : null;
  if (walletEventsHmacSelfTestPassed === false) {
    issues.push({ code: 'wallet_events_hmac_self_test_failed', message: 'カード送付(entitlement.granted/revoked)のHMAC自己診断に失敗しました。' });
  }

  // 最終安定化指示書Phase6「global flagとstage整合」: SENNOKUNI_INTEGRATION_ENABLED(全体)が
  // 無効の間はstageに関わらずカード送付は実送信されない(dispatcher側のisSennokuniIntegrationEnabled
  // ガード)。有効なdigital_collectibleルールがあるのにこのFlagが無効なままだと気づきにくいため
  // Preflightで明示する。
  if (enabledRules.length > 0 && !isSennokuniIntegrationEnabled()) {
    issues.push({
      code: 'global_flag_stage_inconsistent',
      message: `有効なdigital_collectibleルールが${enabledRules.length}件ありますが、SENNOKUNI_INTEGRATION_ENABLEDが無効なためカード送付は実行されません。`,
    });
  }

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
  if (rulesMissingRarity > 0) {
    issues.push({
      code: 'rule_missing_rarity',
      message: `rarity(collectibleRarity)未設定の有効なdigital_collectibleルールが${rulesMissingRarity}件あります。`,
    });
  }
  if (rulesWithInvalidDestination > 0) {
    issues.push({
      code: 'rule_invalid_destination',
      message: `entitlement_type=digital_collectibleなのに送信先が${DIGITAL_COLLECTIBLE_DESTINATION}以外のルールが${rulesWithInvalidDestination}件あります。`,
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
  // (Feature Flag不整合・asset_code欠落・itemType不整合・common_user_id必須化漏れ・
  // dead/blocked滞留)も無い状態。最終安定化指示書Phase3「production切替ゲート」がこの値を
  // 直接参照するため、本番へ切り替えてはならない条件はすべてここへ集約する。
  const hasPhase6BlockingIssue = issues.some((issue) => PHASE6_BLOCKING_ISSUE_CODES.has(issue.code));

  const overallReady =
    walletClaimReady &&
    collectibleDeliveryReady &&
    rulesMissingAssetCode === 0 &&
    rulesOnNonNftProduct === 0 &&
    rulesWithoutRequireCommonUserId === 0 &&
    rulesMissingRarity === 0 &&
    rulesWithInvalidDestination === 0 &&
    deadCount === 0 &&
    blockedCount === 0 &&
    !hasPhase6BlockingIssue;

  return {
    walletClaimEnabled,
    digitalCollectibleDeliveryEnabled,
    settingChecks,
    enabledDigitalCollectibleRuleCount: enabledRules.length,
    rulesMissingAssetCode,
    rulesWithoutRequireCommonUserId,
    rulesOnNonNftProduct,
    rulesMissingRarity,
    rulesWithInvalidDestination,
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
