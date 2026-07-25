import { prisma } from '../lib/prisma';
import { decryptSetting, encryptSetting } from '../lib/settingsCrypto';
import { getSetting } from './settings';

// 仕様書外の拡張(千ノ国全体連携 2026-07-22指示書対応): common_user resolve・referral
// capture/confirm・Outbox実送信は、統合責任者が署名テストベクトル・event version・本番URL/鍵を
// 確定し、この環境変数を明示的にtrueへ設定するまで常に無効(既定OFF)とする
// ("Feature Flagでdormantなコードとして実装"という方針)。無効時は各クライアント関数が
// 即座にnullを返し、外部への実HTTP送信は一切発生しない(既存の決済・登録フローへの影響はゼロ)。
//
// 本番安定化指示書Stage8(11.4): この環境変数はデプロイ時にしか変更できない「マスターキル
// スイッチ」として維持する(管理画面から誤って本番送信を有効化できてしまわないようにする
// ため、あえてDB設定にしない)。この変数がfalseの間はSennokuniIntegrationStageの値に
// 関わらず常にdisabled扱いになる(getSennokuniIntegrationStage参照)。
export function isSennokuniIntegrationEnabled(): boolean {
  return process.env.SENNOKUNI_INTEGRATION_ENABLED === 'true';
}

// 本番安定化指示書Stage8(11.4「単純booleanではなく段階化」): SENNOKUNI_INTEGRATION_ENABLED
// (マスターキルスイッチ)がtrueになって初めて意味を持つ、より細かい段階。管理画面から
// 変更できるDB設定(sennokuni_integration_stage)として持たせることで、変更操作自体が
// 既存の管理APIの監査ログ(admin/index.tsのauditLogミドルウェア)へ自動的に記録される
// (11.5「production変更が監査ログへ残る」)。
export const SENNOKUNI_INTEGRATION_STAGES = ['dry_run', 'staging', 'production'] as const;
export type SennokuniIntegrationStage = 'disabled' | (typeof SENNOKUNI_INTEGRATION_STAGES)[number];

// sennokuni_integration_stageは意図的にsettings.tsのSETTING_KEYS(admin/settings.tsの
// 汎用PUT /settingsで無条件に上書きできる一覧)に含めない。production/stagingへの変更には
// 事前チェック(必須設定・URL/path形式・HMAC自己診断)が必要なため、専用のルート
// (admin/integrationPreflight.ts)経由でのみ更新させる。ストレージ自体は他の設定と同じ
// settingsテーブル・同じ暗号化方式を流用する。
const STAGE_SETTING_KEY = 'sennokuni_integration_stage';

async function getRawStageSetting(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: STAGE_SETTING_KEY } });
  if (!row) return null;
  return decryptSetting(row.value);
}

export async function setSennokuniIntegrationStageSetting(
  stage: (typeof SENNOKUNI_INTEGRATION_STAGES)[number],
): Promise<void> {
  const encrypted = encryptSetting(stage);
  await prisma.setting.upsert({
    where: { key: STAGE_SETTING_KEY },
    update: { value: encrypted },
    create: { key: STAGE_SETTING_KEY, value: encrypted },
  });
}

export async function getSennokuniIntegrationStage(): Promise<SennokuniIntegrationStage> {
  if (!isSennokuniIntegrationEnabled()) return 'disabled';
  const raw = await getRawStageSetting();
  if ((SENNOKUNI_INTEGRATION_STAGES as readonly string[]).includes(raw ?? '')) {
    return raw as (typeof SENNOKUNI_INTEGRATION_STAGES)[number];
  }
  // 未設定・不正値は最も安全側(実送信しないdry_run)にフォールバックする。
  return 'dry_run';
}

export interface SennokuniHubCredentials {
  keyId: string;
  secret: string;
  baseUrl: string;
}

// 代理店HUB(common-users/resolve・referrals/capture・referrals/confirm)向けの認証情報。
// いずれか未設定ならnull(呼び出し側は「環境未設定」として安全にスキップする)。
export async function getSennokuniHubCredentials(): Promise<SennokuniHubCredentials | null> {
  const [keyId, secret, baseUrl] = await Promise.all([
    getSetting('sennokuni_hmac_key_id'),
    getSetting('sennokuni_hmac_secret'),
    getSetting('sennokuni_agency_hub_base_url'),
  ]);
  if (!keyId || !secret || !baseUrl) return null;
  return { keyId, secret, baseUrl: baseUrl.replace(/\/+$/, '') };
}

export interface OveWalletCredentials {
  apiKeyId: string;
  secret: string;
  baseUrl: string;
}

// OVE Walletは共通契約(X-SenNoKuni-*)とは別のHMAC方式・認証情報を使うため分離する。
export async function getOveWalletCredentials(): Promise<OveWalletCredentials | null> {
  const [apiKeyId, secret, baseUrl] = await Promise.all([
    getSetting('ove_wallet_api_key_id'),
    getSetting('ove_wallet_hmac_secret'),
    getSetting('ove_wallet_base_url'),
  ]);
  if (!apiKeyId || !secret || !baseUrl) return null;
  return { apiKeyId, secret, baseUrl: baseUrl.replace(/\/+$/, '') };
}

// Outbox dispatcherが送信先システムキーごとに参照する接続先URL。未対応・未設定の送信先はnull。
export async function getIntegrationEndpointBaseUrl(destinationSystemKey: string): Promise<string | null> {
  const key = ({
    'sengoku-passport': 'integration_endpoint_sengoku_passport',
    'ai-art-school': 'integration_endpoint_ai_art_school',
  } as const)[destinationSystemKey as 'sengoku-passport' | 'ai-art-school'];
  if (!key) return null;
  const value = await getSetting(key);
  return value ? value.replace(/\/+$/, '') : null;
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「正式URL」): 送信先ごとのイベント受信path。
// 本番安定化指示書Stage8(11.1・11.5「暫定pathへの自動フォールバックなし」): 以前は未設定時に
// 暫定値'/shopping/webhook'へ自動フォールバックしていたが、正式pathが確定しないまま誤って
// 実送信してしまう事故を防ぐため廃止した。未設定はnullを返し、呼び出し側は送信せず失敗させる
// (fail-close)。
export async function getIntegrationEndpointPath(destinationSystemKey: string): Promise<string | null> {
  const key = ({
    'sengoku-passport': 'integration_endpoint_path_sengoku_passport',
    'ai-art-school': 'integration_endpoint_path_ai_art_school',
  } as const)[destinationSystemKey as 'sengoku-passport' | 'ai-art-school'];
  if (!key) return null;
  return getSetting(key);
}
