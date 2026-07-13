import { fakeMintProvider } from './nftMintProviders/fake';
import { crossmintMintProvider } from './nftMintProviders/crossmint';

// 仕様書外の拡張: NFT自動発行(外部Mint API連携)。自前コントラクト+秘密鍵管理は行わず、
// 外部の管理型Mint APIサービス(Crossmint/thirdweb Engine等)を利用する方針(ステークホルダー確認済み)。
// 具体的なプロバイダーはNFT_MINT_PROVIDER環境変数で切り替え可能にし、実装をこのインターフェースの
// 背後に隠す。

export interface MintRequestInput {
  toAddress: string;
  metadataUri: string;
  chain: string;
  // 外部APIへの二重送信を防ぐための冪等キー(nftIssue.idを渡す想定)。
  idempotencyKey: string;
}

export type MintStatus = 'pending' | 'success' | 'failure';

export interface MintStatusResult {
  status: MintStatus;
  tokenId?: string;
  transactionHash?: string;
  error?: string;
}

export interface MintProvider {
  submitMint(input: MintRequestInput): Promise<{ providerRequestId: string }>;
  getMintStatus(providerRequestId: string): Promise<MintStatusResult>;
}

export function getMintProvider(): MintProvider {
  const providerName = process.env.NFT_MINT_PROVIDER ?? 'fake';
  switch (providerName) {
    case 'fake':
      return fakeMintProvider;
    case 'crossmint':
      return crossmintMintProvider;
    default:
      throw new Error(`未対応のNFT_MINT_PROVIDERです: ${providerName}`);
  }
}

// 発行対象チェーン。コードへ固定せずNFT_CHAIN環境変数で切り替える
// (wallets.chain / nft_issues.chainへ書き込む値も含め、ここを唯一の参照元にする)。
export function getNftChain(): string {
  return process.env.NFT_CHAIN ?? 'bsc';
}
