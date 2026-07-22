import crypto from 'crypto';

// OVE Wallet独自のHMAC認証方式(千ノ国全体連携 SYSTEM_ANALYSIS_千ノ国ウォレット準拠)。
// 共通契約(X-SenNoKuni-*)とは異なる別方式であり、混同しないよう専用ファイルに分離する。
// 署名対象: `${timestamp}.${nonce}.${method}:${path}:${body}`(HMAC-SHA256、16進数)。
// idempotency_keyはヘッダーではなくボディのフィールドとして送る。

export interface OveWalletSigningInput {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  rawBody: string;
}

export function buildOveWalletSigningString(input: OveWalletSigningInput): string {
  return `${input.timestamp}.${input.nonce}.${input.method.toUpperCase()}:${input.path}:${input.rawBody}`;
}

export function signOveWalletRequest(input: OveWalletSigningInput & { secret: string }): string {
  return crypto.createHmac('sha256', input.secret).update(buildOveWalletSigningString(input)).digest('hex');
}

export function buildOveWalletHeaders(input: OveWalletSigningInput & { secret: string; apiKeyId: string }): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-OVE-Api-Key': input.apiKeyId,
    'X-OVE-Timestamp': input.timestamp,
    'X-OVE-Nonce': input.nonce,
    'X-OVE-Signature': signOveWalletRequest(input),
  };
}
