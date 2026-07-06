import { prisma } from '../lib/prisma';

// アカウント+IP単位のログイン失敗回数制限(仕様書v1.5 4.8: 5回失敗で15分ロック)。
// サーバーレス環境ではインスタンスが使い捨てのためインメモリ管理は機能しない。
// DB(login_attemptsテーブル)で永続化する。

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function normalize(email: string): string {
  return email.toLowerCase();
}

export async function isLocked(email: string, ip: string): Promise<boolean> {
  const record = await prisma.loginAttempt.findUnique({
    where: { email_ip: { email: normalize(email), ip } },
  });

  if (!record?.lockedUntil) return false;

  if (record.lockedUntil <= new Date()) {
    // ロック期限切れ。次回の失敗から数え直せるようリセットする。
    await prisma.loginAttempt.update({
      where: { id: record.id },
      data: { failedCount: 0, lockedUntil: null },
    });
    return false;
  }

  return true;
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const key = normalize(email);

  const record = await prisma.loginAttempt.upsert({
    where: { email_ip: { email: key, ip } },
    update: { failedCount: { increment: 1 } },
    create: { email: key, ip, failedCount: 1 },
  });

  if (record.failedCount >= MAX_ATTEMPTS && !record.lockedUntil) {
    await prisma.loginAttempt.update({
      where: { id: record.id },
      data: { lockedUntil: new Date(Date.now() + LOCK_MS) },
    });
  }
}

export async function recordLoginSuccess(email: string, ip: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { email: normalize(email), ip } });
}
