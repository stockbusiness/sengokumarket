import { afterEach, describe, expect, it } from 'vitest';
import { deriveDeterministicToken } from './notificationTokenDerivation';

// 最終安定化指示書Phase2「Notification Tokenの安定化」
describe('deriveDeterministicToken', () => {
  const originalSecret = process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;
    else process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = originalSecret;
  });

  it('NOTIFICATION_TOKEN_DERIVATION_SECRET未設定の間はnullを返す', () => {
    delete process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;
    const token = deriveDeterministicToken({ eventId: 'e1', subjectId: 's1', tokenVersion: 0, purpose: 'password_reset' });
    expect(token).toBeNull();
  });

  it('32byte未満の鍵はnullを返す(短すぎる鍵での運用を拒否する)', () => {
    process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'too-short-secret';
    const token = deriveDeterministicToken({ eventId: 'e1', subjectId: 's1', tokenVersion: 0, purpose: 'password_reset' });
    expect(token).toBeNull();
  });

  it('同じ入力からは常に同じTokenを導出する', () => {
    process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'a'.repeat(32);
    const input = { eventId: 'e1', subjectId: 's1', tokenVersion: 0, purpose: 'password_reset' };
    expect(deriveDeterministicToken(input)).toBe(deriveDeterministicToken(input));
  });

  it('event_id・subject_id・token_version・purposeのいずれかが違えば異なるTokenになる(用途間で値が分離される)', () => {
    process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'a'.repeat(32);
    const base = { eventId: 'e1', subjectId: 's1', tokenVersion: 0, purpose: 'password_reset' };
    const t0 = deriveDeterministicToken(base);
    expect(deriveDeterministicToken({ ...base, eventId: 'e2' })).not.toBe(t0);
    expect(deriveDeterministicToken({ ...base, subjectId: 's2' })).not.toBe(t0);
    expect(deriveDeterministicToken({ ...base, tokenVersion: 1 })).not.toBe(t0);
    expect(deriveDeterministicToken({ ...base, purpose: 'guest_password_setup' })).not.toBe(t0);
  });
});
