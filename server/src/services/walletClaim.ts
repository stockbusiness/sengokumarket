import crypto from 'crypto';
import type { Order, OrderItem, Prisma, PrismaClient, WalletClaim } from '@prisma/client';
import { isWalletClaimEnabled } from './walletClaimConfig';
import { getDigitalCollectibleRule } from './digitalCollectible';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)6章: 有効期限30日。
export const CLAIM_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashClaimToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateClaimToken(): string {
  // 32バイト以上の暗号学的乱数(仕様書6章)。
  return crypto.randomBytes(32).toString('hex');
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)4章: `paymentStatus=paid`確定と
// 同一トランザクションで作成する。対象商品(itemType=nft かつ 有効なdigital_collectibleの
// ProductIntegrationRuleが存在)がなければ作成しない。ENABLE_WALLET_CLAIM=false(既定)の間は
// 常にno-op(この機能全体がdormant)。
export async function createWalletClaimIfEligible(
  tx: Tx,
  order: Order,
  orderItems: OrderItem[],
): Promise<string | null> {
  if (!isWalletClaimEnabled()) return null;

  const nftItems = orderItems.filter((item) => item.itemType === 'nft');
  if (nftItems.length === 0) return null;

  let eligible = false;
  for (const item of nftItems) {
    const rule = await getDigitalCollectibleRule(tx, item.productId);
    if (rule) {
      eligible = true;
      break;
    }
  }
  if (!eligible) return null;

  // order_idはUNIQUE。同一注文に対して複数回この関数が呼ばれても(呼び出し元は決済確定処理の
  // 一部のため通常は1回のみだが、防御的に)二重作成しない。
  const existing = await tx.walletClaim.findUnique({ where: { orderId: order.id } });
  if (existing) return null;

  const token = generateClaimToken();
  await tx.walletClaim.create({
    data: {
      orderId: order.id,
      tokenHash: hashClaimToken(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
    },
  });
  return token;
}

export async function getWalletClaimForOrder(orderId: string, db: Db): Promise<WalletClaim | null> {
  return db.walletClaim.findUnique({ where: { orderId } });
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)6・7章: 期限切れ時、マイページから
// 再発行する。生トークンは注文確定時にしか返さない(DBにはハッシュのみ保存)ため、マイページの
// 「NFTカードを受け取る」操作自体もこの関数を使って都度新しいトークンを発行する
// (未使用の旧トークンを無効化するだけなので安全に何度でも呼べる)。対象はPENDING/EXPIRED/ERROR
// のみ(CLAIMED以降は既にウォレット側での確認が進行中のため、URLを再発行しても意味がない。
// REVOKEDは返金・取消済みのため対象外)。
export async function reissueWalletClaimToken(tx: Tx, orderId: string): Promise<string | null> {
  const claim = await tx.walletClaim.findUnique({ where: { orderId } });
  if (!claim) return null;

  const reissuable = claim.status === 'PENDING' || claim.status === 'EXPIRED' || claim.status === 'ERROR';
  if (!reissuable) return null;

  const token = generateClaimToken();
  await tx.walletClaim.update({
    where: { id: claim.id },
    data: {
      tokenHash: hashClaimToken(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
      lastError: null,
    },
  });
  return token;
}
