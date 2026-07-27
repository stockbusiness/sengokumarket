import { afterAll, afterEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { consumePasswordResetToken, createPasswordResetToken, getOrCreateDeterministicPasswordResetToken } from './passwordReset';

describe('passwordReset service', () => {
  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'pwreset-svc-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'pwreset-svc-test' } } });
    await prisma.$disconnect();
  });

  it('発行した平文トークンでパスワードを変更でき、トークンは1回限りで使用済みになる', async () => {
    const email = `pwreset-svc-test-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'テスト', email, passwordHash: await bcrypt.hash('old-password', 10) },
    });

    const plainToken = await createPasswordResetToken(user.id);

    const record = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(record.tokenHash).not.toBe(plainToken);

    const ok = await consumePasswordResetToken(plainToken, 'new-password-123');
    expect(ok).toBe(true);

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare('new-password-123', updatedUser.passwordHash)).toBe(true);

    const usedRecord = await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: record.id } });
    expect(usedRecord.usedAt).not.toBeNull();

    // 同じトークンを再利用できない
    const secondAttempt = await consumePasswordResetToken(plainToken, 'another-password');
    expect(secondAttempt).toBe(false);
  });

  it('期限切れトークンは使用できない', async () => {
    const email = `pwreset-svc-test-expired-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'テスト', email, passwordHash: await bcrypt.hash('old-password', 10) },
    });

    const plainToken = await createPasswordResetToken(user.id);
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const ok = await consumePasswordResetToken(plainToken, 'new-password-123');
    expect(ok).toBe(false);
  });

  // 最終安定化指示書Phase2「Notification Tokenの安定化」
  describe('getOrCreateDeterministicPasswordResetToken', () => {
    const originalSecret = process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;

    afterEach(() => {
      if (originalSecret === undefined) delete process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;
      else process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = originalSecret;
    });

    it('NOTIFICATION_TOKEN_DERIVATION_SECRET未設定の間はnullを返す(呼び出し元は既存の発行方式にフォールバックする)', async () => {
      delete process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;
      const email = `pwreset-svc-test-nosecret-${Date.now()}@example.com`;
      const user = await prisma.user.create({ data: { name: 'テスト', email, passwordHash: await bcrypt.hash('x', 10) } });

      const result = await getOrCreateDeterministicPasswordResetToken(user.id, {
        eventId: 'evt-1',
        subjectId: user.id,
        tokenVersion: 0,
        purpose: 'password_reset',
      });
      expect(result).toBeNull();
    });

    it('同一event_idでの再試行は同じToken・同じレコードを返す(新規行を作らない)', async () => {
      process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'a'.repeat(32);
      const email = `pwreset-svc-test-deterministic-${Date.now()}@example.com`;
      const user = await prisma.user.create({ data: { name: 'テスト', email, passwordHash: await bcrypt.hash('x', 10) } });

      const first = await getOrCreateDeterministicPasswordResetToken(user.id, {
        eventId: 'evt-retry-test',
        subjectId: user.id,
        tokenVersion: 0,
        purpose: 'password_reset',
      });
      const second = await getOrCreateDeterministicPasswordResetToken(user.id, {
        eventId: 'evt-retry-test',
        subjectId: user.id,
        tokenVersion: 0,
        purpose: 'password_reset',
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second!.token).toBe(first!.token);
      expect(second!.tokenId).toBe(first!.tokenId);

      const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(1);
    });

    it('event_idが異なれば別のTokenになる(用途間・要求間で値が分離される)', async () => {
      process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'a'.repeat(32);
      const email = `pwreset-svc-test-diffevent-${Date.now()}@example.com`;
      const user = await prisma.user.create({ data: { name: 'テスト', email, passwordHash: await bcrypt.hash('x', 10) } });

      const a = await getOrCreateDeterministicPasswordResetToken(user.id, {
        eventId: 'evt-a',
        subjectId: user.id,
        tokenVersion: 0,
        purpose: 'password_reset',
      });
      const b = await getOrCreateDeterministicPasswordResetToken(user.id, {
        eventId: 'evt-b',
        subjectId: user.id,
        tokenVersion: 0,
        purpose: 'password_reset',
      });

      expect(a!.token).not.toBe(b!.token);
    });
  });
});
