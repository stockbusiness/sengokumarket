import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { cleanupWalletClaimApiNonces } from './walletClaimHmac';

// Wallet Claim本番前安定化指示書(2026-07-25)Phase2(4.5「nonce cleanup」)。
describe('cleanupWalletClaimApiNonces', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('24時間より古いnonceのみ削除し、新しいnonceは残す', async () => {
    const oldNonce = await prisma.walletClaimApiNonce.create({
      data: { nonce: `old-nonce-${Date.now()}`, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const recentNonce = await prisma.walletClaimApiNonce.create({ data: { nonce: `recent-nonce-${Date.now()}` } });

    const result = await cleanupWalletClaimApiNonces();
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    const oldStillExists = await prisma.walletClaimApiNonce.findUnique({ where: { id: oldNonce.id } });
    expect(oldStillExists).toBeNull();

    const recentStillExists = await prisma.walletClaimApiNonce.findUnique({ where: { id: recentNonce.id } });
    expect(recentStillExists).not.toBeNull();

    await prisma.walletClaimApiNonce.deleteMany({ where: { id: recentNonce.id } });
  });
});
