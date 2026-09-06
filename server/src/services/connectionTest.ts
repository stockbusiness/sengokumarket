import crypto from 'crypto';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { getSetting } from './settings';
import { fetchExternalAgencyHierarchy } from './externalAgencySystem';
import { HttpError } from '../lib/httpError';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';

// 仕様書外の拡張: 管理画面の「決済・メール設定」から、保存前(入力中)の値、または
// 保存済みの値で外部サービスへの接続を試せるようにする。
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export async function testStripeConnection(secretKeyOverride?: string): Promise<ConnectionTestResult> {
  const key = secretKeyOverride?.trim() || (await getSetting('stripe_secret_key'));
  if (!key) return { ok: false, message: 'シークレットキーが未入力です' };

  try {
    const stripe = new Stripe(key);
    const balance = await stripe.balance.retrieve();
    const mode = key.startsWith('sk_live_') ? '本番(ライブ)モード' : 'テストモード';
    const available = balance.available.map((b) => `${b.amount.toLocaleString()}${b.currency.toUpperCase()}`).join(', ');
    return { ok: true, message: `接続に成功しました(${mode})。利用可能残高: ${available || '0'}` };
  } catch (e) {
    return { ok: false, message: `接続に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}` };
  }
}

export async function testResendConnection(
  apiKeyOverride: string | undefined,
  mailFromOverride: string | undefined,
  to: string,
): Promise<ConnectionTestResult> {
  const apiKey = apiKeyOverride?.trim() || (await getSetting('resend_api_key'));
  const mailFrom = mailFromOverride?.trim() || (await getSetting('mail_from'));
  if (!apiKey) return { ok: false, message: 'Resend APIキーが未入力です' };
  if (!mailFrom) return { ok: false, message: '送信元メールアドレスが未入力です' };

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: mailFrom,
      to,
      subject: '【テスト送信】千ノ国 メール設定確認',
      html: '<p>このメールは管理画面の接続テストから送信されたテストメールです。このメールが届いていれば設定は正常です。</p>',
    });
    if (result.error) {
      return { ok: false, message: `送信に失敗しました: ${result.error.message}` };
    }
    return { ok: true, message: `${to} 宛にテストメールを送信しました` };
  } catch (e) {
    return { ok: false, message: `送信に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}` };
  }
}

// 実際の階層同期(agencyHierarchySync)と全く同じ取得・解析ロジックを通すことで、
// 「テストは通ったのに本番の同期は失敗する」という食い違いが起きないようにする。
export async function testExternalAgencyConnection(baseUrlOverride?: string, apiKeyOverride?: string): Promise<ConnectionTestResult> {
  const rawBaseUrl = baseUrlOverride?.trim() || (await getSetting('external_agency_system_base_url'));
  const apiKey = apiKeyOverride?.trim() || (await getSetting('external_agency_system_api_key'));
  if (!rawBaseUrl) return { ok: false, message: '外部代理店システムのURLが未入力です' };
  if (!apiKey) return { ok: false, message: '外部代理店システムAPIキーが未入力です' };

  try {
    const agencies = await fetchExternalAgencyHierarchy(rawBaseUrl, apiKey);
    return { ok: true, message: `接続に成功しました(取得件数: ${agencies.length}件)` };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, message: e.message };
    return { ok: false, message: `接続に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}` };
  }
}

// 仕様書外の拡張(NFT自動発行): 外部Mint APIプロバイダーの疎通確認。crossmint等の実プロバイダーは
// まだ未実装(nftMintProviders/crossmint.ts参照)のため、その場合は「未実装」であることを明示し、
// 誤って接続成功と誤認させないようにする。
export async function testNftMintConnection(apiKeyOverride?: string): Promise<ConnectionTestResult> {
  const provider = process.env.NFT_MINT_PROVIDER ?? 'fake';

  if (provider === 'fake') {
    return { ok: true, message: 'ローカル開発・テスト用の擬似プロバイダー(fake)が有効です。実際の外部送信は行われません' };
  }

  const apiKey = apiKeyOverride?.trim() || (await getSetting('nft_mint_api_key'));
  if (!apiKey) return { ok: false, message: 'NFT Mint APIキーが未入力です' };

  if (provider === 'crossmint') {
    return { ok: false, message: 'このMintプロバイダー(crossmint)は実装がまだ完了していません' };
  }

  return { ok: false, message: `未対応のNFT_MINT_PROVIDERです: ${provider}` };
}

// 代理店連携APIキー(自システムの受信用)の自己テスト。サーバー内部から直接ハンドラを呼ぶのではなく、
// 実際に公開URL経由でリクエストし、認証ミドルウェアを含めた実際の疎通を確認する。
export async function testAgencyKeyConnection(apiKeyOverride?: string): Promise<ConnectionTestResult> {
  const apiKey = apiKeyOverride?.trim() || (await getSetting('agency_api_key'));
  if (!apiKey) return { ok: false, message: 'APIキーが未入力です' };

  const appUrl = process.env.APP_URL;
  if (!appUrl) return { ok: false, message: 'APP_URLが設定されていないため自己テストできません' };

  try {
    const res = await fetch(`${appUrl}/api/integrations/agencies`, { headers: { 'x-api-key': apiKey } });
    if (res.ok) return { ok: true, message: 'このキーで正しく認証できました' };
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return { ok: false, message: body?.message ?? `認証に失敗しました(HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, message: `接続に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}` };
  }
}

// 仕様書外の拡張: OVEウォレット(評議員デジタル会員証送信用)の接続テスト。
// このAPI(POST /api/integrations/events)には読み取り専用の疎通確認手段が無く、
// 唯一のエンドポイントは呼ぶたびに実際の会員証付与・取消として処理される(先方の
// SENNOKUNI_COMMERCE_REQUEST.md参照)。誤って本番の会員証付与を発生させないよう、
// このテストでは実際のentitlement.granted/revokedは送信せず、(1)保存済み設定での
// HMAC署名生成が例外なく行えること、(2)接続先ホストへネットワーク到達できること、
// の2点のみを確認する。
export async function testOveWalletEventsConnection(
  baseUrlOverride?: string,
  keyIdOverride?: string,
  secretOverride?: string,
): Promise<ConnectionTestResult> {
  const baseUrl = (baseUrlOverride?.trim() || (await getSetting('ove_wallet_base_url')))?.replace(/\/+$/, '');
  const keyId = keyIdOverride?.trim() || (await getSetting('ove_wallet_events_key_id'));
  const secret = secretOverride?.trim() || (await getSetting('ove_wallet_events_hmac_secret'));
  if (!baseUrl) return { ok: false, message: '接続先URLが未入力です' };
  if (!keyId) return { ok: false, message: 'Key IDが未入力です' };
  if (!secret) return { ok: false, message: 'HMAC Secretが未入力です' };

  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    buildSennokuniHeaders({ keyId, secret, timestamp, nonce, method: 'POST', path: '/api/integrations/events', rawBody: '{}' });
  } catch (e) {
    return { ok: false, message: `署名の生成に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}` };
  }

  try {
    const res = await fetch(baseUrl, { method: 'GET', signal: AbortSignal.timeout(8000) });
    return {
      ok: true,
      message: `接続先(${baseUrl})へ到達できました(HTTPステータス: ${res.status})。署名生成も成功しています。実際の会員証イベント(entitlement.granted等)はこのテストでは送信していません。`,
    };
  } catch (e) {
    return { ok: false, message: `接続先へ到達できませんでした: ${e instanceof Error ? e.message : '不明なエラー'}` };
  }
}
