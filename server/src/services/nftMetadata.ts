import { put } from '@vercel/blob';
import { HttpError } from '../lib/httpError';

export interface NftMetadataParams {
  productName: string;
  serialNumber: number;
  imageUrl: string | null;
}

// 指示書の禁止事項どおり、氏名・メール・電話・住所・LINEユーザーID・内部ID・購入金額・
// Stripe関連情報等の個人情報・機密情報は一切含めない(仕様書外の拡張)。
// 画像は既存の商品画像(Vercel Blob)をそのまま参照し、IPFS等は導入しない。
export function buildNftMetadata(params: NftMetadataParams): Record<string, unknown> {
  const serial = String(params.serialNumber).padStart(6, '0');
  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '');

  return {
    name: `${params.productName} #${serial}`,
    description: '千ノ国 評議員デジタル会員証です。',
    image: params.imageUrl ?? undefined,
    external_url: `${appUrl}/mypage/nfts`,
    attributes: [
      { trait_type: 'NFT Type', value: params.productName },
      { trait_type: 'Issue Year', value: String(new Date().getFullYear()) },
      { trait_type: 'Serial Number', value: serial },
    ],
  };
}

// メタデータJSONを既存の商品画像アップロードと同じVercel Blobストレージへ保存する
// (IPFS等の新規導入は行わない。ステークホルダー確認済み)。
export async function uploadNftMetadata(nftIssueId: string, metadata: Record<string, unknown>): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new HttpError(503, 'BLOB_NOT_CONFIGURED', 'メタデータ保存機能が未設定です');
  }
  const blob = await put(`nft-metadata/${nftIssueId}.json`, JSON.stringify(metadata), {
    access: 'public',
    contentType: 'application/json',
  });
  return blob.url;
}
