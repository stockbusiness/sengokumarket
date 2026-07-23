import { describe, expect, it } from 'vitest';
import { assertRequiredEnv } from './env';

const COMPLETE_ENV = {
  DATABASE_URL: 'postgres://localhost/test',
  JWT_SECRET: 'secret',
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
});
