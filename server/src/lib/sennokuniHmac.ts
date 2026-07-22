import crypto from 'crypto';

// 千ノ国全体連携 共通インターフェース契約 v1.1 DRAFT 7章準拠(2026-07-22)。
// 契約書7.1で「区切り文字、改行、pathのquery含有、bodyの文字コード、末尾改行、hex/base64形式は
// 全システム共通テストベクトルで確定する」と明記されている未確定事項であり、この実装は統合責任者が
// 確定させる正式テストベクトルに合格するまでの暫定案にすぎない。SENNOKUNI_INTEGRATION_ENABLED
// (既定OFF)が有効化されない限り実送信されないため、契約確定前でも安全に着手できる。
// 署名対象の組み立てをこのファイル1箇所に閉じ込めているのは、正式テストベクトル確定後の
// 修正範囲を最小化するため。

export interface SennokuniSigningInput {
  keyId: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  rawBody: string;
}

export function buildSennokuniSigningString(input: SennokuniSigningInput): string {
  return [input.keyId, input.timestamp, input.nonce, input.method.toUpperCase(), input.path, input.rawBody].join('\n');
}

export function signSennokuniRequest(input: SennokuniSigningInput & { secret: string }): string {
  return crypto.createHmac('sha256', input.secret).update(buildSennokuniSigningString(input)).digest('hex');
}

export interface SennokuniHeadersInput extends SennokuniSigningInput {
  secret: string;
  eventVersion?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

export function buildSennokuniHeaders(input: SennokuniHeadersInput): Record<string, string> {
  const signature = signSennokuniRequest(input);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-SenNoKuni-Key-Id': input.keyId,
    'X-SenNoKuni-Timestamp': input.timestamp,
    'X-SenNoKuni-Nonce': input.nonce,
    'X-SenNoKuni-Signature': signature,
  };
  if (input.eventVersion) headers['X-Event-Version'] = input.eventVersion;
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  if (input.correlationId) headers['X-Correlation-Id'] = input.correlationId;
  return headers;
}
