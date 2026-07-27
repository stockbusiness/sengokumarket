import { describe, expect, it } from 'vitest';
import { buildSennokuniHeaders, buildSennokuniSigningString, signSennokuniRequest } from './sennokuniHmac';

// 千ノ国 共通仕様確定パッケージv1.1(SEN_NO_KUNI_STEP1_COMMON_SPEC_PACKAGE_V1_1)
// 02_HMAC_SIGNATURE_TEST_VECTOR_V1.mdで確定した固定テストベクトル。
// このテストが不合格の場合、他システムとの接続は行えない(パッケージ 00_READ_ME_FIRST.md)。
const FIXTURE = {
  keyId: 'test-key-001',
  secret: 'sen-no-kuni-test-secret-v1',
  timestamp: '1784691600',
  nonce: 'nonce-20260722-0001',
  method: 'POST',
  path: '/api/integrations/events',
  rawBody:
    '{"event_id":"evt_test_0001","event_type":"entitlement.granted","event_version":"1.0","occurred_at":"2026-07-22T01:00:00Z","source_system_key":"sengoku-market","common_user_id":"cu_test_0001","correlation_id":"corr_test_0001","data":{"entitlement_id":"ent_test_0001","entitlement_type":"passport_membership","quantity":1}}',
};
const EXPECTED_SIGNATURE = 'e063066bc059f2c3c011cd29a4bf30cf3791e6a56920e9f5ddc5c358b87c229b';

describe('sennokuniHmac: 千ノ国共通仕様v1.1 固定HMACテストベクトル', () => {
  it('canonical stringは6行(key_id/timestamp/nonce/method/path/raw_body)で末尾改行を含まない', () => {
    const canonical = buildSennokuniSigningString(FIXTURE);
    expect(canonical).toBe(
      [FIXTURE.keyId, FIXTURE.timestamp, FIXTURE.nonce, FIXTURE.method, FIXTURE.path, FIXTURE.rawBody].join('\n'),
    );
    expect(canonical.endsWith('\n')).toBe(false);
  });

  it('固定テストベクトルの署名結果が期待値と一致する', () => {
    expect(signSennokuniRequest(FIXTURE)).toBe(EXPECTED_SIGNATURE);
  });

  it('methodは小文字で渡しても大文字化されて同じ署名になる', () => {
    expect(signSennokuniRequest({ ...FIXTURE, method: 'post' })).toBe(EXPECTED_SIGNATURE);
  });

  it('idempotencyKeyを渡しても署名対象(canonical string)には影響しない(ヘッダーにのみ使う)', () => {
    expect(signSennokuniRequest({ ...FIXTURE, idempotencyKey: 'evt_test_0001' })).toBe(EXPECTED_SIGNATURE);
  });

  it('bodyが1バイトでも改変されると署名は一致しない(body改ざん検知)', () => {
    const tampered = { ...FIXTURE, rawBody: FIXTURE.rawBody.replace('"quantity":1', '"quantity":2') };
    expect(signSennokuniRequest(tampered)).not.toBe(EXPECTED_SIGNATURE);
  });

  it('methodが改変されると署名は一致しない(method改ざん検知)', () => {
    expect(signSennokuniRequest({ ...FIXTURE, method: 'GET' })).not.toBe(EXPECTED_SIGNATURE);
  });

  it('pathが改変されると署名は一致しない(path改ざん検知)', () => {
    expect(signSennokuniRequest({ ...FIXTURE, path: '/api/integrations/events/' })).not.toBe(EXPECTED_SIGNATURE);
  });

  it('nonceが改変されると署名は一致しない', () => {
    expect(signSennokuniRequest({ ...FIXTURE, nonce: 'nonce-20260722-0002' })).not.toBe(EXPECTED_SIGNATURE);
  });

  it('buildSennokuniHeadersはIdempotency-Keyをヘッダーへ設定するが、署名自体には影響しない', () => {
    const headers = buildSennokuniHeaders({ ...FIXTURE, idempotencyKey: 'evt_test_0001' });
    expect(headers['Idempotency-Key']).toBe('evt_test_0001');
    expect(headers['X-SenNoKuni-Signature']).toBe(EXPECTED_SIGNATURE);
  });
});
