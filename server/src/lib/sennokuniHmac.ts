import crypto from 'crypto';

// 千ノ国 共通仕様確定パッケージv1.1(SEN_NO_KUNI_STEP1_COMMON_SPEC_PACKAGE_V1_1、
// 01_COMMON_INTERFACE_CONTRACT_V1_1_FINAL.md 9章)で正式に確定した、全システム共通の
// canonical string・固定HMACテストベクトル(02_HMAC_SIGNATURE_TEST_VECTOR_V1.md)に準拠する。
//
// canonical string(6行、末尾改行なし):
//   key_id + "\n" + timestamp + "\n" + nonce + "\n" + uppercase(method) + "\n" +
//   path_without_query + "\n" + raw_body
//
// Idempotency-KeyはHTTPヘッダーとしては送信するが、署名対象(canonical string)には含めない
// (旧実装は署名対象の7行目にidempotencyKeyを含めていたため、固定テストベクトルの期待値と
// 一致しなかった。千ノ国 Step1共通仕様採用確認で判明し修正した)。
export interface SennokuniSigningInput {
  keyId: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  rawBody: string;
  // 署名対象には含めない(Idempotency-Keyヘッダーの値としてのみ使う)。
  idempotencyKey?: string;
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
