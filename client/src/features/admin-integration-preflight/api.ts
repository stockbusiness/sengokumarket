import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 本番安定化指示書Stage8(11章)・Stage11(14.1「Integration Preflight」画面)。
export interface SettingCheckResult {
  key: string;
  configured: boolean;
  formatValid: boolean | null;
}

export interface HmacSelfTestResult {
  target: string;
  configured: boolean;
  passed: boolean | null;
}

export interface ConnectionTestResult {
  target: string;
  baseUrl: string | null;
  ok: boolean | null;
  error?: string;
}

export type SennokuniIntegrationStage = 'disabled' | 'dry_run' | 'staging' | 'production';

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
  missingSettings: string[];
  invalidFormatSettings: string[];
  walletClaimFlagInconsistentRuleCount: number;
  readyForActivation: boolean;
}

export function fetchAdminIntegrationPreflight() {
  return adminFetch<{ report: IntegrationPreflightReport }>('/integration-preflight');
}

// Wallet Claim本番前安定化指示書(2026-07-25)Phase8(10章「Wallet Claim Preflight拡張」)。
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

export function fetchAdminWalletClaimPreflight() {
  return adminFetch<{ report: WalletClaimPreflightReport }>('/wallet-claim-preflight');
}

export function fetchAdminIntegrationStage() {
  return adminFetch<{ stage: SennokuniIntegrationStage }>('/integration-stage');
}

export function updateAdminIntegrationStage(stage: 'dry_run' | 'staging' | 'production') {
  return adminSend<{ stage: SennokuniIntegrationStage }>('PUT', '/integration-stage', { stage });
}
