import crypto from 'crypto';
import type { Order, OrderItem, Prisma, PrismaClient, WalletClaim } from '@prisma/client';
import { isWalletClaimEnabled } from './walletClaimConfig';
import { deriveDeterministicToken } from './notificationTokenDerivation';
import {
  getDigitalCollectibleRulesByProductIds,
  buildCollectibleSnapshot,
  DIGITAL_COLLECTIBLE_DESTINATION,
  DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE,
} from './digitalCollectible';

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
//
// Wallet Claim本番前安定化指示書(2026-07-25)Phase4「決済時スナップショットの固定」: 対象NftIssue
// ごとにWalletClaimItem(購入時点のルール・商品スナップショット)を同一トランザクションで作成する。
// この関数の呼び出し元(applyPaidOrderSideEffects)はcreateNftIssuesForOrderの後にこの関数を
// 呼ぶため、対象NftIssue行は既に作成済みである前提。
export async function createWalletClaimIfEligible(
  tx: Tx,
  order: Order,
  orderItems: OrderItem[],
): Promise<string | null> {
  if (!isWalletClaimEnabled()) return null;

  const nftItems = orderItems.filter((item) => item.itemType === 'nft');
  if (nftItems.length === 0) return null;

  // 最終安定化指示書Phase10「Checkout性能改善」: order item単位でProductIntegrationRule・
  // Product・NftIssueを1件ずつ取得するとN+1になるため、対象分をまとめて1クエリずつ取得する。
  const productIds = nftItems.map((item) => item.productId);
  const rulesByProductId = await getDigitalCollectibleRulesByProductIds(tx, productIds);
  const products = await tx.product.findMany({ where: { id: { in: [...new Set(productIds)] } } });
  const productById = new Map(products.map((p) => [p.id, p]));
  const nftIssues = await tx.nftIssue.findMany({
    where: { orderItemId: { in: nftItems.map((item) => item.id) } },
  });
  const nftIssuesByOrderItemId = new Map<string, typeof nftIssues>();
  for (const nftIssue of nftIssues) {
    const list = nftIssuesByOrderItemId.get(nftIssue.orderItemId) ?? [];
    list.push(nftIssue);
    nftIssuesByOrderItemId.set(nftIssue.orderItemId, list);
  }

  const itemRows: Prisma.WalletClaimItemCreateManyInput[] = [];
  for (const item of nftItems) {
    const rule = rulesByProductId.get(item.productId);
    if (!rule) continue;
    const product = productById.get(item.productId);
    if (!product) continue;

    const snapshot = buildCollectibleSnapshot(rule, product);
    for (const nftIssue of nftIssuesByOrderItemId.get(item.id) ?? []) {
      itemRows.push({
        walletClaimId: '', // 後でWalletClaim作成後に埋める
        nftIssueId: nftIssue.id,
        orderItemId: item.id,
        productId: item.productId,
        productIntegrationRuleId: rule.id,
        // getDigitalCollectibleRuleは常にこの2値で絞り込んでいるため、rule自体の値ではなく
        // 定数を使う(ruleの型上はnullable)。
        destinationSystemKey: DIGITAL_COLLECTIBLE_DESTINATION,
        entitlementType: DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE,
        productCode: rule.productCode,
        assetCode: snapshot.assetCode,
        serialNumber: nftIssue.serialNumber,
        name: snapshot.name,
        description: snapshot.description,
        imageUrl: snapshot.imageUrl,
        thumbnailUrl: snapshot.thumbnailUrl,
        imageHash: snapshot.imageHash,
        rarity: snapshot.rarity,
      });
    }
  }
  if (itemRows.length === 0) return null;

  // order_idはUNIQUE。同一注文に対して複数回この関数が呼ばれても(呼び出し元は決済確定処理の
  // 一部のため通常は1回のみだが、防御的に)二重作成しない。
  const existing = await tx.walletClaim.findUnique({ where: { orderId: order.id } });
  if (existing) return null;

  const token = generateClaimToken();
  const claim = await tx.walletClaim.create({
    data: {
      orderId: order.id,
      tokenHash: hashClaimToken(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
    },
  });
  await tx.walletClaimItem.createMany({
    data: itemRows.map((row) => ({ ...row, walletClaimId: claim.id })),
  });
  return token;
}

export async function getWalletClaimForOrder(orderId: string, db: Db): Promise<WalletClaim | null> {
  return db.walletClaim.findUnique({ where: { orderId } });
}

function isReissuableStatus(status: string): boolean {
  return status === 'PENDING' || status === 'EXPIRED' || status === 'ERROR';
}

// Wallet Claim本番前安定化指示書(2026-07-25)Phase1「必須修正」: 呼び出し元(mypage.ts等)が
// Token発行前の事前確認(状態・URL設定)を行うための、DBを変更しない軽量チェック。
export async function isWalletClaimReissuable(orderId: string, db: Db): Promise<boolean> {
  const claim = await db.walletClaim.findUnique({ where: { orderId } });
  return Boolean(claim && isReissuableStatus(claim.status));
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)6・7章: 期限切れ時、マイページから
// 再発行する。生トークンは注文確定時にしか返さない(DBにはハッシュのみ保存)ため、マイページの
// 「NFTカードを受け取る」操作自体もこの関数を使って都度新しいトークンを発行する
// (未使用の旧トークンを無効化するだけなので安全に何度でも呼べる)。対象はPENDING/EXPIRED/ERROR
// のみ(CLAIMED以降は既にウォレット側での確認が進行中のため、URLを再発行しても意味がない。
// REVOKEDは返金・取消済みのため対象外)。
//
// Wallet Claim本番前安定化指示書(2026-07-25)Phase1「推奨追加項目」: 同時再発行時に古い処理が
// 新Tokenを上書きしないよう、読み取り時点のtoken_hashを条件付きUPDATEのWHERE句に含める
// (楽観ロック/CAS)。他の処理が先に更新していればcount=0になり、このプロセスはnullを返す
// (呼び出し元は「再発行できなかった」として扱う。他プロセスが発行した新しい方のTokenが有効)。
// 最終安定化指示書Phase2: notificationEventIdを渡すと、同じNotification Outbox Event
// (event_idはretryをまたいで不変)の再試行では同一Tokenを返す(先に送信済みメールのURLが
// 後続retryで無効化されるのを防ぐ)。NOTIFICATION_TOKEN_DERIVATION_SECRET未設定・
// notificationEventId未指定の間は従来通り都度ランダムなTokenを発行する。
export async function reissueWalletClaimToken(tx: Tx, orderId: string, notificationEventId?: string): Promise<string | null> {
  const claim = await tx.walletClaim.findUnique({ where: { orderId } });
  if (!claim) return null;
  if (!isReissuableStatus(claim.status)) return null;

  const deterministicToken = notificationEventId
    ? deriveDeterministicToken({ eventId: notificationEventId, subjectId: orderId, tokenVersion: 0, purpose: 'wallet_claim_reissue' })
    : null;

  if (deterministicToken) {
    const deterministicHash = hashClaimToken(deterministicToken);
    if (claim.tokenHash === deterministicHash) {
      // 同一Notification Eventの再試行(前回既にこのEventで発行済み)。rotateせず同じTokenを返す。
      return deterministicToken;
    }
    const updated = await tx.walletClaim.updateMany({
      where: { id: claim.id, tokenHash: claim.tokenHash, status: claim.status },
      data: {
        tokenHash: deterministicHash,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
        lastError: null,
        tokenVersion: { increment: 1 },
        lastReissuedAt: new Date(),
        reissueCount: { increment: 1 },
      },
    });
    if (updated.count === 0) return null;
    return deterministicToken;
  }

  const token = generateClaimToken();
  const updated = await tx.walletClaim.updateMany({
    where: { id: claim.id, tokenHash: claim.tokenHash, status: claim.status },
    data: {
      tokenHash: hashClaimToken(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS),
      lastError: null,
      tokenVersion: { increment: 1 },
      lastReissuedAt: new Date(),
      reissueCount: { increment: 1 },
    },
  });
  if (updated.count === 0) return null;
  return token;
}
