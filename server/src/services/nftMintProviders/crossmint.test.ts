import { afterEach, describe, expect, it, vi } from 'vitest';
import { crossmintMintProvider } from './crossmint';

const getSetting = vi.fn(async (..._args: unknown[]): Promise<string | null> => 'sk_staging_test_key');

vi.mock('../settings', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
}));

const BASE_INPUT = {
  toAddress: '0x1111111111111111111111111111111111111111',
  metadataUri: 'https://blob.example.com/nft-metadata/issue-1.json',
  chain: 'bsc',
  idempotencyKey: 'issue-1',
};

describe('crossmintMintProvider(仕様書外の拡張)', () => {
  const originalCollectionId = process.env.CROSSMINT_COLLECTION_ID;

  afterEach(() => {
    process.env.CROSSMINT_COLLECTION_ID = originalCollectionId;
    vi.unstubAllGlobals();
    getSetting.mockReset();
    getSetting.mockResolvedValue('sk_staging_test_key');
  });

  it('CROSSMINT_COLLECTION_ID未設定の場合はCROSSMINT_NOT_CONFIGUREDで失敗する', async () => {
    delete process.env.CROSSMINT_COLLECTION_ID;
    await expect(crossmintMintProvider.submitMint(BASE_INPUT)).rejects.toMatchObject({ code: 'CROSSMINT_NOT_CONFIGURED' });
  });

  it('nft_mint_api_key未設定の場合はCROSSMINT_NOT_CONFIGUREDで失敗する', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    getSetting.mockResolvedValueOnce(null);
    await expect(crossmintMintProvider.submitMint(BASE_INPUT)).rejects.toMatchObject({ code: 'CROSSMINT_NOT_CONFIGURED' });
  });

  it('submitMintは冪等Mint(PUT .../nfts/:idempotencyKey)を正しいbody・ヘッダーで呼び出す', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await crossmintMintProvider.submitMint(BASE_INPUT);

    expect(result).toEqual({ providerRequestId: 'issue-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://staging.crossmint.com/api/2022-06-09/collections/collection-1/nfts/issue-1');
    expect(options.method).toBe('PUT');
    expect(options.headers).toMatchObject({ 'X-API-KEY': 'sk_staging_test_key' });
    expect(JSON.parse(options.body)).toEqual({
      recipient: 'bsc:0x1111111111111111111111111111111111111111',
      metadata: BASE_INPUT.metadataUri,
      reuploadLinkedFiles: false,
    });
  });

  it('APIキーがsk_production_で始まる場合は本番ベースURLを使う', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    getSetting.mockResolvedValueOnce('sk_production_test_key');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    await crossmintMintProvider.submitMint(BASE_INPUT);

    expect(fetchMock.mock.calls[0][0]).toBe('https://www.crossmint.com/api/2022-06-09/collections/collection-1/nfts/issue-1');
  });

  it('submitMintがHTTPエラーを返すと例外を投げる', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('bad request') }));

    await expect(crossmintMintProvider.submitMint(BASE_INPUT)).rejects.toThrow(/HTTP 400/);
  });

  it('getMintStatusはonChain.status=successでtokenId/transactionHashを返す', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ onChain: { status: 'success', tokenId: '42', txId: '0xabc' } }),
      }),
    );

    const status = await crossmintMintProvider.getMintStatus('issue-1');
    expect(status).toEqual({ status: 'success', tokenId: '42', transactionHash: '0xabc' });
  });

  it('getMintStatusはonChain.status=failedでfailureを返す', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ onChain: { status: 'failed' } }) }));

    const status = await crossmintMintProvider.getMintStatus('issue-1');
    expect(status.status).toBe('failure');
  });

  it('getMintStatusはonChain.statusがpending等の未確定値の場合pendingを返す', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ onChain: { status: 'pending' } }) }));

    const status = await crossmintMintProvider.getMintStatus('issue-1');
    expect(status.status).toBe('pending');
  });

  it('getMintStatusがHTTPエラーを返すと例外を投げる', async () => {
    process.env.CROSSMINT_COLLECTION_ID = 'collection-1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') }));

    await expect(crossmintMintProvider.getMintStatus('issue-1')).rejects.toThrow(/HTTP 404/);
  });
});
