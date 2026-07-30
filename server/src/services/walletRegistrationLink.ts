import crypto from 'crypto';
import { prisma } from '../lib/prisma';

// 仕様書外の拡張: 既に決済済みだがウォレット未登録の購入者へ、管理者が「本人専用の登録用URL」を
// 発行できるようにする。ウォレットアドレス自体の直接入力・登録は署名検証(personal_sign)を
// 迂回することになるため行わず、あくまで本人が実際にウォレット接続・署名を行うための入り口
// (トークン付きURL)だけを管理者が発行・再発行・失効できるようにする
// (passwordReset.tsと同じ「トークンはハッシュ化して保存し、平文はURLにのみ含める」方式)。
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WalletRegistrationLinkStatus = 'none' | 'active' | 'used' | 'expired' | 'revoked';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function statusOf(link: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }): WalletRegistrationLinkStatus {
  if (link.usedAt) return 'used';
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt < new Date()) return 'expired';
  return 'active';
}

// 1ユーザーにつき同時にactiveなリンクは1本のみとする運用のため、発行・再発行を同じ関数でカバーする
// (既存のactiveリンクがあれば、新規発行前に失効させる)。
export async function createWalletRegistrationLink(userId: string, createdBy: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');

  await prisma.$transaction(async (tx) => {
    await tx.walletRegistrationLink.updateMany({
      where: { userId, usedAt: null, revokedAt: null, expiresAt: { gte: new Date() } },
      data: { revokedAt: new Date(), revokedBy: createdBy },
    });
    await tx.walletRegistrationLink.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        createdBy,
      },
    });
  });

  return token;
}

// 新規発行は行わず、現在activeなリンクのみを失効させる(「削除」操作)。activeなリンクが
// 無ければ何もしない。
export async function revokeWalletRegistrationLink(userId: string, revokedBy: string): Promise<void> {
  await prisma.walletRegistrationLink.updateMany({
    where: { userId, usedAt: null, revokedAt: null, expiresAt: { gte: new Date() } },
    data: { revokedAt: new Date(), revokedBy },
  });
}

export async function getWalletRegistrationLinkStatus(
  userId: string,
): Promise<{ status: WalletRegistrationLinkStatus; expiresAt: Date | null }> {
  const link = await prisma.walletRegistrationLink.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  if (!link) return { status: 'none', expiresAt: null };
  const status = statusOf(link);
  return { status, expiresAt: status === 'active' ? link.expiresAt : null };
}

export interface ValidatedWalletRegistrationLink {
  status: WalletRegistrationLinkStatus;
  userId: string | null;
}

// 既に使用済み(usedAt設定済み)のトークンは、読み取り専用の「登録済み」表示にとどめ、
// 再度の署名検証は受け付けない(古いリンクが後から使い回されてウォレットが差し替わることを防ぐ)。
export async function validateWalletRegistrationLink(token: string): Promise<ValidatedWalletRegistrationLink> {
  const link = await prisma.walletRegistrationLink.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!link) return { status: 'none', userId: null };
  return { status: statusOf(link), userId: link.userId };
}

// walletRegistration.tsのPOST /confirmから、verifyAndRegisterWalletの成功後に呼ばれる。
export async function consumeWalletRegistrationLink(token: string): Promise<void> {
  await prisma.walletRegistrationLink.updateMany({ where: { tokenHash: hashToken(token), usedAt: null }, data: { usedAt: new Date() } });
}
