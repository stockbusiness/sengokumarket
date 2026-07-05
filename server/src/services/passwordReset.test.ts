import { afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { consumePasswordResetToken, createPasswordResetToken } from './passwordReset';

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
});
