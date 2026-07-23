import { HttpError } from '../../lib/httpError';
import { fetchWithTimeout } from '../../shared/http/httpClient';
import { integrationConfig } from '../../shared/config/integrationConfig';
import { getSetting } from '../settings';
import type { MintProvider, MintRequestInput, MintStatusResult } from '../nftMint';

const API_VERSION = '2022-06-09';

// 仕様書外の拡張: Crossmint Minting APIとの連携。
//
// 冪等Mint(PUT .../collections/:collectionId/nfts/:id)を使い、こちらが発行する
// idempotencyKey(nft_issues.idをそのまま使う)をURLのidとして送信する。この方式であれば
// こちら側のリトライ(ネットワーク断・タイムアウト等)が二重発行を引き起こさない上、
// レスポンスからMint用の識別子を解析する必要がない(自分で決めたIDをそのままpollingにも使える)。
//
// APIキー(nft_mint_api_key、暗号化DB設定)はstaging/production用が別々に発行され、
// プレフィックス(sk_staging_ / sk_production_)で判別できるため、接続先ベースURLは
// 別途「環境」設定を持たずキー自体から自動判定する。
//
// 【要検証】このファイルは公開ドキュメントの調査に基づく実装であり、実際のCrossmint APIキーで
// 動作確認できていない。ステージング環境で少なくとも1件、実際にMintが成功しissuedまで到達する
// ことを確認してから本番プロバイダーとして有効化すること。

function getCollectionId(): string {
  const collectionId = integrationConfig.crossmintCollectionId;
  if (!collectionId) {
    throw new HttpError(503, 'CROSSMINT_NOT_CONFIGURED', 'CROSSMINT_COLLECTION_IDが未設定です');
  }
  return collectionId;
}

function getBaseUrl(apiKey: string): string {
  return apiKey.startsWith('sk_staging_') ? 'https://staging.crossmint.com' : 'https://www.crossmint.com';
}

async function getApiKey(): Promise<string> {
  const apiKey = await getSetting('nft_mint_api_key');
  if (!apiKey) {
    throw new HttpError(503, 'CROSSMINT_NOT_CONFIGURED', 'NFT Mint APIキーが未設定です');
  }
  return apiKey;
}

interface CrossmintNftResponse {
  onChain?: {
    status?: string;
    tokenId?: string;
    txId?: string;
  };
}

async function readErrorBody(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return body.slice(0, 500);
}

export const crossmintMintProvider: MintProvider = {
  async submitMint(input: MintRequestInput) {
    const apiKey = await getApiKey();
    const collectionId = getCollectionId();
    const baseUrl = getBaseUrl(apiKey);

    const res = await fetchWithTimeout(`${baseUrl}/api/${API_VERSION}/collections/${collectionId}/nfts/${input.idempotencyKey}`, {
      method: 'PUT',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: `${input.chain}:${input.toAddress}`,
        // 既存のVercel BlobのURLをそのまま使い、Crossmint側での再ホスト(IPFS化等)は行わせない。
        metadata: input.metadataUri,
        reuploadLinkedFiles: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Crossmint mint request failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
    }

    return { providerRequestId: input.idempotencyKey };
  },

  async getMintStatus(providerRequestId: string): Promise<MintStatusResult> {
    const apiKey = await getApiKey();
    const collectionId = getCollectionId();
    const baseUrl = getBaseUrl(apiKey);

    const res = await fetchWithTimeout(`${baseUrl}/api/${API_VERSION}/collections/${collectionId}/nfts/${providerRequestId}`, {
      headers: { 'X-API-KEY': apiKey },
    });

    if (!res.ok) {
      throw new Error(`Crossmint mint status request failed (HTTP ${res.status}): ${await readErrorBody(res)}`);
    }

    const data = (await res.json()) as CrossmintNftResponse;
    const status = data.onChain?.status;

    if (status === 'success') {
      return { status: 'success', tokenId: data.onChain?.tokenId, transactionHash: data.onChain?.txId };
    }
    if (status === 'failed' || status === 'failure') {
      return { status: 'failure', error: `Crossmintでの発行に失敗しました(onChain.status=${status})` };
    }
    // pending/minting等、成功・失敗と確認できない値はすべて「未確定」として扱い、次回ポーリングに委ねる。
    return { status: 'pending' };
  },
};
