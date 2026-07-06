import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { isLocked, recordLoginFailure, recordLoginSuccess } from './loginAttempts';

const IP = '203.0.113.10';

describe('loginAttempts service (DBベース)', () => {
  afterAll(async () => {
    await prisma.loginAttempt.deleteMany({ where: { email: { contains: 'loginattempts-svc-test' } } });
    await prisma.$disconnect();
  });

  it('5回失敗するとロックされ、それ未満ではロックされない', async () => {
    const email = `loginattempts-svc-test-${Date.now()}@example.com`;

    for (let i = 0; i < 4; i++) {
      await recordLoginFailure(email, IP);
      expect(await isLocked(email, IP)).toBe(false);
    }

    await recordLoginFailure(email, IP);
    expect(await isLocked(email, IP)).toBe(true);

    const record = await prisma.loginAttempt.findUniqueOrThrow({ where: { email_ip: { email, ip: IP } } });
    expect(record.failedCount).toBe(5);
    expect(record.lockedUntil).not.toBeNull();
  });

  it('ロック期限切れ後は自動的に解除され、カウントもリセットされる', async () => {
    const email = `loginattempts-svc-test-expired-${Date.now()}@example.com`;

    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(email, IP);
    }
    expect(await isLocked(email, IP)).toBe(true);

    await prisma.loginAttempt.updateMany({
      where: { email, ip: IP },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });

    expect(await isLocked(email, IP)).toBe(false);

    const record = await prisma.loginAttempt.findUniqueOrThrow({ where: { email_ip: { email, ip: IP } } });
    expect(record.failedCount).toBe(0);
    expect(record.lockedUntil).toBeNull();
  });

  it('ログイン成功で失敗記録が削除される', async () => {
    const email = `loginattempts-svc-test-success-${Date.now()}@example.com`;
    await recordLoginFailure(email, IP);
    await recordLoginFailure(email, IP);

    await recordLoginSuccess(email, IP);

    const record = await prisma.loginAttempt.findUnique({ where: { email_ip: { email, ip: IP } } });
    expect(record).toBeNull();
  });

  it('メールアドレスは大文字小文字を区別せず同一キーとして扱う', async () => {
    const email = `LoginAttempts-Svc-Test-Case-${Date.now()}@Example.com`;
    await recordLoginFailure(email, IP);
    await recordLoginFailure(email.toLowerCase(), IP);

    const record = await prisma.loginAttempt.findUniqueOrThrow({
      where: { email_ip: { email: email.toLowerCase(), ip: IP } },
    });
    expect(record.failedCount).toBe(2);
  });
});
