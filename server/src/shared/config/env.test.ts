import { describe, expect, it } from 'vitest';
import { assertRequiredEnv } from './env';

const COMPLETE_ENV = {
  DATABASE_URL: 'postgres://localhost/test',
  JWT_SECRET: 'a-sufficiently-long-jwt-secret-value-for-tests',
  APP_URL: 'https://example.com',
  TERMS_VERSION: '2026-01-01',
  SETTINGS_ENCRYPTION_KEY: 'a'.repeat(64),
} as NodeJS.ProcessEnv;

describe('assertRequiredEnv', () => {
  it('必須環境変数がすべて揃っていれば何も投げない', () => {
    expect(() => assertRequiredEnv(COMPLETE_ENV)).not.toThrow();
  });

  it('1つでも欠けていればエラーを投げ、欠けている変数名を含む', () => {
    const { JWT_SECRET: _omit, ...incomplete } = COMPLETE_ENV;
    expect(() => assertRequiredEnv(incomplete as NodeJS.ProcessEnv)).toThrowError(/JWT_SECRET/);
  });

  it('複数欠けていればすべての変数名を含む', () => {
    expect(() => assertRequiredEnv({} as NodeJS.ProcessEnv)).toThrowError(
      /DATABASE_URL.*JWT_SECRET.*APP_URL.*TERMS_VERSION.*SETTINGS_ENCRYPTION_KEY/s,
    );
  });

  it('APP_URLが不正なURL文字列だとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, APP_URL: 'not-a-url' })).toThrowError(/APP_URL/);
  });

  it('APP_URLがhttp/https以外のプロトコルだとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, APP_URL: 'ftp://example.com' })).toThrowError(/APP_URL/);
  });

  it('本番環境(NODE_ENV=production)でAPP_URLがhttp:だとエラーになる', () => {
    expect(() =>
      assertRequiredEnv({ ...COMPLETE_ENV, APP_URL: 'http://example.com', NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrowError(/APP_URL/);
  });

  it('開発環境ではAPP_URLがhttp:でもエラーにならない', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, APP_URL: 'http://localhost:5173' })).not.toThrow();
  });

  it('JWT_SECRETが短すぎるとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, JWT_SECRET: 'short' })).toThrowError(/JWT_SECRET/);
  });

  it('JWT_SECRETが既知のデフォルト値だとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, JWT_SECRET: 'changeme' })).toThrowError(/JWT_SECRET/);
  });

  it('SETTINGS_ENCRYPTION_KEYの長さが不正だとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, SETTINGS_ENCRYPTION_KEY: 'a'.repeat(32) })).toThrowError(
      /SETTINGS_ENCRYPTION_KEY/,
    );
  });

  it('SETTINGS_ENCRYPTION_KEYが16進数でないとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, SETTINGS_ENCRYPTION_KEY: 'z'.repeat(64) })).toThrowError(
      /SETTINGS_ENCRYPTION_KEY/,
    );
  });

  it('DATABASE_URLがpostgres形式でないとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, DATABASE_URL: 'mysql://localhost/test' })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it('TERMS_VERSIONが空白のみだとエラーになる', () => {
    expect(() => assertRequiredEnv({ ...COMPLETE_ENV, TERMS_VERSION: '   ' })).toThrowError(/TERMS_VERSION/);
  });

  it('エラーメッセージに実際の秘密値そのものを含まない', () => {
    const secretValue = 'super-secret-value-that-must-not-leak-anywhere-12345';
    try {
      assertRequiredEnv({ ...COMPLETE_ENV, JWT_SECRET: secretValue.slice(0, 5) } as NodeJS.ProcessEnv);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(secretValue.slice(0, 5));
    }
  });
});
