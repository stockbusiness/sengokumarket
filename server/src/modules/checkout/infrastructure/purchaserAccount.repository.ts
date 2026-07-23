import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, User } from '@prisma/client';
import { emailFilterInsensitive, normalizeEmail } from '../../../lib/validation';

type Tx = Prisma.TransactionClient;

export interface PurchaserResolution {
  user: User;
  guestAccountCreated: boolean;
}

// 仕様書外の拡張: users.emailは大文字小文字を区別しない(注文自体のcustomerEmailは
// 購入者が入力した表記のまま保存するため、ここではログインアカウント検索/作成のみ正規化する)。
// 既存アカウントが無ければゲストアカウントを作成する(仮パスワードはランダム値をハッシュ化するのみ)。
export async function resolveOrCreatePurchaser(
  tx: Tx,
  input: { customerName: string; customerEmail: string; customerPhone: string },
): Promise<PurchaserResolution> {
  const existing = await tx.user.findFirst({ where: { email: emailFilterInsensitive(input.customerEmail) } });
  if (existing) return { user: existing, guestAccountCreated: false };

  const randomPassword = crypto.randomBytes(32).toString('hex');
  const user = await tx.user.create({
    data: {
      name: input.customerName,
      email: normalizeEmail(input.customerEmail),
      phone: input.customerPhone,
      passwordHash: await bcrypt.hash(randomPassword, 10),
      role: 'user',
    },
  });
  return { user, guestAccountCreated: true };
}

export interface ReferralAttributionToPersist {
  agencyId: string | null;
  influencerId: string | null;
  referralLinkId: string | null;
  referralCode: string | null;
}

// 仕様書外の拡張: 代理店への帰属は初回購入時点で永久固定する(指示書3.3「初回紹介者への永久帰属」)。
export function attachReferralAttribution(tx: Tx, userId: string, attribution: ReferralAttributionToPersist): Promise<User> {
  return tx.user.update({
    where: { id: userId },
    data: {
      referredByAgencyId: attribution.agencyId,
      referredByInfluencerId: attribution.influencerId,
      referredByReferralLinkId: attribution.referralLinkId,
      referredByCode: attribution.referralCode,
      referredAt: new Date(),
    },
  });
}
