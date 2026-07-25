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
