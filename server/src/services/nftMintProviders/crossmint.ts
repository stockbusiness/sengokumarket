import { HttpError } from '../../lib/httpError';
import type { MintProvider } from '../nftMint';

// 仕様書外の拡張: 実際のCrossmint等の管理型Mint APIとの連携は、プロバイダー確定後に実装する。
// インターフェース(nftMint.ts)を先に確定させ、fakeプロバイダーでcron・admin UI・テストまで
// 完結させた上でこのファイルを後付けする(計画のステップ3参照。APIキーはsettings.tsの
// nft_mint_api_key、コントラクト/チェーン情報はNFT_CONTRACT_ADDRESS等の環境変数から取得する想定)。
export const crossmintMintProvider: MintProvider = {
  async submitMint() {
    throw new HttpError(501, 'MINT_PROVIDER_NOT_IMPLEMENTED', 'このMintプロバイダーは未実装です');
  },

  async getMintStatus() {
    throw new HttpError(501, 'MINT_PROVIDER_NOT_IMPLEMENTED', 'このMintプロバイダーは未実装です');
  },
};
