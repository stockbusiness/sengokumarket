import { prisma } from '../lib/prisma';
import { signSennokuniRequest } from '../lib/sennokuniHmac';
import { signOveWalletRequest } from '../lib/oveWalletHmac';
import { getSetting, type SettingKey } from './settings';
import {
  getSennokuniIntegrationStage,
  isSennokuniIntegrationEnabled,
  type SennokuniIntegrationStage,
} from './sennokuniIntegrationConfig';

// 本番安定化指示書Stage8(11.3「Preflight」・11.2「有効化時必須設定」): production/staging
// への切り替え前に確認すべき項目を1箇所にまとめる。管理API(GET /api/admin/integration-preflight)
// と、stage変更時のfail-closeなガード(11.5「正式設定不足でproduction有効化不可」)の両方から
// この同じロジックを使う(判定基準を1つに保つため)。

const CONNECTION_TEST_TIMEOUT_MS = 5000;

export interface SettingCheckResult {
  key: SettingKey;
  configured: boolean;
  // URL/pathとして期待される値のみ形式チェックする(秘密鍵等は対象外)。
  formatValid: boolean | null;
}

export interface HmacSelfTestResult {
  target: 'sennokuni' | 'ove-wallet';
  configured: boolean;
  passed: boolean | null; // configured=falseの場合はnull(判定不能)
}

export interface ConnectionTestResult {
  target: string;
  baseUrl: string | null;
  ok: boolean | null; // baseUrl未設定はnull(判定不能)
  error?: string;
}

export interface IntegrationPreflightReport {
  featureFlagEnabled: boolean;
  stage: SennokuniIntegrationStage;
  usedDestinations: string[];
  settingChecks: SettingCheckResult[];
  hmacSelfTests: HmacSelfTestResult[];
  connectionTests: ConnectionTestResult[];
  backlogCount: number;
  deadCount: number;
  blockedCount: number;
  productRuleCount: number;
  missingSettings: SettingKey[];
  invalidFormatSettings: SettingKey[];
  readyForActivation: boolean;
}

// 11.2「使用する送信先だけ必須とする」: sennokuni hub(common_user resolve・referral
// capture/confirm)は送信先の設定に関わらず常に使われるため常時必須。宛先ごとの設定は
// 実際にenabled=trueのProductIntegrationRuleで使われている場合のみ必須にする。
async function getUsedDestinations(): Promise<string[]> {
  const rules = await prisma.productIntegrationRule.findMany({
    where: { enabled: true, entitlementTargetSystemKey: { not: null } },
    select: { entitlementTargetSystemKey: true },
    distinct: ['entitlementTargetSystemKey'],
  });
  return rules.map((r) => r.entitlementTargetSystemKey!).filter((v): v is string => Boolean(v));
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidPath(value: string): boolean {
  return value.startsWith('/');
}

async function checkSetting(key: SettingKey, kind: 'url' | 'path' | 'secret'): Promise<SettingCheckResult> {
  const value = await getSetting(key);
  if (!value) return { key, configured: false, formatValid: null };
  if (kind === 'url') return { key, configured: true, formatValid: isValidUrl(value) };
  if (kind === 'path') return { key, configured: true, formatValid: isValidPath(value) };
  return { key, configured: true, formatValid: null };
}

async function testConnection(target: string, baseUrl: string | null): Promise<ConnectionTestResult> {
  if (!baseUrl) return { target, baseUrl: null, ok: null };
  try {
    const res = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS) });
    // 宛先が何を返しても(404等でも)、到達できたこと自体を「接続テストOK」とみなす。
    // ここでは認証・pathの正しさまでは検証しない(実際の送信はHMAC付きの別pathへ行うため)。
    return { target, baseUrl, ok: res.status < 500 };
  } catch (e) {
    return { target, baseUrl, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function buildIntegrationPreflightReport(): Promise<IntegrationPreflightReport> {
  const featureFlagEnabled = isSennokuniIntegrationEnabled();
  const stage = await getSennokuniIntegrationStage();
  const usedDestinations = await getUsedDestinations();

  const settingChecks: SettingCheckResult[] = [
    // sennokuni hub: 送信先設定に関わらず常に必須(common_user resolve・referral capture/confirm)。
    await checkSetting('sennokuni_hmac_key_id', 'secret'),
    await checkSetting('sennokuni_hmac_secret', 'secret'),
    await checkSetting('sennokuni_agency_hub_base_url', 'url'),
  ];
  if (usedDestinations.includes('sengoku-passport')) {
    settingChecks.push(
      await checkSetting('integration_endpoint_sengoku_passport', 'url'),
      await checkSetting('integration_endpoint_path_sengoku_passport', 'path'),
    );
  }
  if (usedDestinations.includes('ai-art-school')) {
    settingChecks.push(
      await checkSetting('integration_endpoint_ai_art_school', 'url'),
      await checkSetting('integration_endpoint_path_ai_art_school', 'path'),
    );
  }
  if (usedDestinations.includes('ove-wallet')) {
    settingChecks.push(
      await checkSetting('ove_wallet_base_url', 'url'),
      await checkSetting('ove_wallet_api_key_id', 'secret'),
      await checkSetting('ove_wallet_hmac_secret', 'secret'),
    );
  }

  // 11.2「HMAC test vector」: 正式な相互テストベクトルは統合責任者確定前のため(sennokuniHmac.ts
  // 冒頭コメント参照)、ここでは「設定された鍵で決定論的に正しい形式(64桁16進)の署名を
  // 生成できるか」という自己診断にとどめる(secret未設定ならnull=判定不能)。
  const sennokuniSecret = await getSetting('sennokuni_hmac_secret');
  const sennokuniKeyId = await getSetting('sennokuni_hmac_key_id');
  const hmacSelfTests: HmacSelfTestResult[] = [
    {
      target: 'sennokuni',
      configured: Boolean(sennokuniSecret && sennokuniKeyId),
      passed:
        sennokuniSecret && sennokuniKeyId
          ? selfTestSennokuniHmac(sennokuniKeyId, sennokuniSecret)
          : null,
    },
  ];
  if (usedDestinations.includes('ove-wallet')) {
    const oveSecret = await getSetting('ove_wallet_hmac_secret');
    hmacSelfTests.push({
      target: 'ove-wallet',
      configured: Boolean(oveSecret),
      passed: oveSecret ? selfTestOveWalletHmac(oveSecret) : null,
    });
  }

  const hubBaseUrl = await getSetting('sennokuni_agency_hub_base_url');
  const connectionTests: ConnectionTestResult[] = [await testConnection('sennokuni-hub', hubBaseUrl)];
  if (usedDestinations.includes('sengoku-passport')) {
    connectionTests.push(await testConnection('sengoku-passport', await getSetting('integration_endpoint_sengoku_passport')));
  }
  if (usedDestinations.includes('ai-art-school')) {
    connectionTests.push(await testConnection('ai-art-school', await getSetting('integration_endpoint_ai_art_school')));
  }
  if (usedDestinations.includes('ove-wallet')) {
    connectionTests.push(await testConnection('ove-wallet', await getSetting('ove_wallet_base_url')));
  }

  const [backlogCount, deadCount, blockedCount, productRuleCount] = await Promise.all([
    prisma.integrationOutboxEvent.count({ where: { status: 'pending' } }),
    prisma.integrationOutboxEvent.count({ where: { status: 'dead' } }),
    prisma.integrationOutboxEvent.count({ where: { status: 'blocked' } }),
    prisma.productIntegrationRule.count({ where: { enabled: true } }),
  ]);

  const missingSettings = settingChecks.filter((c) => !c.configured).map((c) => c.key);
  const invalidFormatSettings = settingChecks.filter((c) => c.formatValid === false).map((c) => c.key);
  const hmacFailed = hmacSelfTests.some((t) => t.passed === false);

  const readyForActivation = missingSettings.length === 0 && invalidFormatSettings.length === 0 && !hmacFailed;

  return {
    featureFlagEnabled,
    stage,
    usedDestinations,
    settingChecks,
    hmacSelfTests,
    connectionTests,
    backlogCount,
    deadCount,
    blockedCount,
    productRuleCount,
    missingSettings,
    invalidFormatSettings,
    readyForActivation,
  };
}

function selfTestSennokuniHmac(keyId: string, secret: string): boolean {
  const input = { keyId, timestamp: '1700000000', nonce: 'preflight-self-test-nonce', method: 'POST', path: '/preflight-self-test', rawBody: '{}' };
  const a = signSennokuniRequest({ ...input, secret });
  const b = signSennokuniRequest({ ...input, secret });
  return a === b && /^[0-9a-f]{64}$/.test(a);
}

function selfTestOveWalletHmac(secret: string): boolean {
  const input = { timestamp: '1700000000', nonce: 'preflight-self-test-nonce', method: 'POST', path: '/preflight-self-test', rawBody: '{}' };
  const a = signOveWalletRequest({ ...input, secret });
  const b = signOveWalletRequest({ ...input, secret });
  return a === b && /^[0-9a-f]{64}$/.test(a);
}
