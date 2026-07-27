import crypto from 'crypto';
import type { Prisma, ProductIntegrationRule } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export const DIGITAL_COLLECTIBLE_DESTINATION = 'ove-wallet';
export const DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE = 'digital_collectible';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)4章「対象」: itemType=nftの商品に
// digital_collectible向けの有効なProductIntegrationRuleが設定されている場合のみ、その商品は
// WalletClaim/CollectibleDelivery(Claim・カード送付)の対象になる。
export async function getDigitalCollectibleRule(tx: Tx, productId: string): Promise<ProductIntegrationRule | null> {
  return tx.productIntegrationRule.findFirst({
    where: {
      productId,
      enabled: true,
      entitlementTargetSystemKey: DIGITAL_COLLECTIBLE_DESTINATION,
      entitlementType: DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE,
    },
  });
}

// 最終安定化指示書Phase10「Checkout性能改善」: 複数商品分をorder item単位で1件ずつ
// 取得するとN+1になるため、対象productId一括分を1クエリでまとめて取得する。
// 1商品に有効なdigital_collectibleルールは高々1件の前提(重複時は先着のものを使う)。
export async function getDigitalCollectibleRulesByProductIds(
  tx: Tx,
  productIds: string[],
): Promise<Map<string, ProductIntegrationRule>> {
  if (productIds.length === 0) return new Map();
  const rules = await tx.productIntegrationRule.findMany({
    where: {
      productId: { in: [...new Set(productIds)] },
      enabled: true,
      entitlementTargetSystemKey: DIGITAL_COLLECTIBLE_DESTINATION,
      entitlementType: DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE,
    },
  });
  const map = new Map<string, ProductIntegrationRule>();
  for (const rule of rules) {
    if (!map.has(rule.productId)) map.set(rule.productId, rule);
  }
  return map;
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)12章: 商品単位で不変のシリアル番号を
// 発番する。UPDATE...RETURNING(行ロック)で採番することで、同一商品への並行購入でも
// 同じシリアル番号が二重に払い出されないようにする(SELECT→INSERTの間に別トランザクションが
// 割り込むレースを防ぐため、単純なcount+1は使わない)。
export async function incrementProductSerialCounter(tx: Tx, productId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ nft_serial_counter: number }[]>`
    UPDATE products SET nft_serial_counter = nft_serial_counter + 1
    WHERE id = ${productId}::uuid
    RETURNING nft_serial_counter
  `;
  if (rows.length === 0) throw new Error(`product not found for serial counter: ${productId}`);
  return rows[0].nft_serial_counter;
}

// 最終安定化指示書Phase10「Checkout性能改善」: NFT quantity分だけincrementProductSerialCounterを
// 個別に呼ぶとquantity回のUPDATE...RETURNINGが発生する(quantity=10で10回)。1回のUPDATEで
// count分まとめて加算し、払い出し済みの連番範囲を折り返すことで、同時実行下でも重複しない
// 連番をまとめて確保する(原子性は単一UPDATEのまま維持)。
export async function reserveProductSerialNumbers(tx: Tx, productId: string, count: number): Promise<number[]> {
  if (count <= 0) return [];
  const rows = await tx.$queryRaw<{ nft_serial_counter: number }[]>`
    UPDATE products SET nft_serial_counter = nft_serial_counter + ${count}
    WHERE id = ${productId}::uuid
    RETURNING nft_serial_counter
  `;
  if (rows.length === 0) throw new Error(`product not found for serial counter: ${productId}`);
  const last = rows[0].nft_serial_counter;
  const first = last - count + 1;
  return Array.from({ length: count }, (_, i) => first + i);
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)13章「画像スナップショット」:
// イベント作成時点の値を固定する。image_hashは画像バイト自体の取得(checkout/決済確定経路で
// 外部URLへ同期fetchすると失敗点が増える)ではなく、URL文字列のfingerprintとして扱う
// (商品画像の差し替え検知が目的であり、バイト単位の改ざん検知までは要求されていないため)。
export interface CollectibleSnapshot {
  assetCode: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  imageHash: string | null;
  rarity: string | null;
}

export function buildCollectibleSnapshot(
  rule: Pick<ProductIntegrationRule, 'assetCode' | 'collectibleRarity'>,
  product: { name: string; description: string | null; images: string[] },
): CollectibleSnapshot {
  const imageUrl = product.images[0] ?? null;
  return {
    assetCode: rule.assetCode,
    name: product.name,
    description: product.description,
    imageUrl,
    thumbnailUrl: imageUrl,
    imageHash: imageUrl ? hashString(imageUrl) : null,
    rarity: rule.collectibleRarity,
  };
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
