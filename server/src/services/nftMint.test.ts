import { afterEach, describe, expect, it } from 'vitest';
import { getMintProvider } from './nftMint';
import { fakeMintProvider, resetFakeMintProvider, setFakeMintBehavior } from './nftMintProviders/fake';

describe('getMintProvider(仕様書外の拡張)', () => {
  const originalProvider = process.env.NFT_MINT_PROVIDER;

  afterEach(() => {
    process.env.NFT_MINT_PROVIDER = originalProvider;
  });

  it('NFT_MINT_PROVIDER未設定の場合はfakeプロバイダーを返す', () => {
    delete process.env.NFT_MINT_PROVIDER;
    expect(getMintProvider()).toBe(fakeMintProvider);
  });

  it('NFT_MINT_PROVIDER=fakeでfakeプロバイダーを返す', () => {
    process.env.NFT_MINT_PROVIDER = 'fake';
    expect(getMintProvider()).toBe(fakeMintProvider);
  });

  it('NFT_MINT_PROVIDER=crossmintでcrossmintプロバイダーを返す(未実装だが呼び出すとエラーになる)', async () => {
    process.env.NFT_MINT_PROVIDER = 'crossmint';
    const provider = getMintProvider();
    await expect(
      provider.submitMint({ toAddress: '0xabc', metadataUri: 'https://example.com/a.json', chain: 'polygon', idempotencyKey: 'x' }),
    ).rejects.toMatchObject({ code: 'MINT_PROVIDER_NOT_IMPLEMENTED' });
  });

  it('未対応の値の場合は例外を投げる', () => {
    process.env.NFT_MINT_PROVIDER = 'unknown-provider';
    expect(() => getMintProvider()).toThrow(/未対応/);
  });
});

describe('fakeMintProvider(仕様書外の拡張)', () => {
  afterEach(() => {
    resetFakeMintProvider();
  });

  it('submitMint→getMintStatusで往復でき、既定では成功を返す', async () => {
    const { providerRequestId } = await fakeMintProvider.submitMint({
      toAddress: '0xabc',
      metadataUri: 'https://example.com/a.json',
      chain: 'polygon',
      idempotencyKey: 'issue-1',
    });
    expect(providerRequestId).toContain('issue-1');

    const status = await fakeMintProvider.getMintStatus(providerRequestId);
    expect(status.status).toBe('success');
    expect(status.tokenId).toBeTruthy();
    expect(status.transactionHash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('未知のproviderRequestIdはfailureを返す', async () => {
    const status = await fakeMintProvider.getMintStatus('nonexistent');
    expect(status.status).toBe('failure');
  });

  it('setFakeMintBehaviorでテストから任意の結果に差し替えられる', async () => {
    setFakeMintBehavior(() => ({ status: 'failure', error: 'テスト用の意図的な失敗' }));
    const { providerRequestId } = await fakeMintProvider.submitMint({
      toAddress: '0xabc',
      metadataUri: 'https://example.com/a.json',
      chain: 'polygon',
      idempotencyKey: 'issue-2',
    });
    const status = await fakeMintProvider.getMintStatus(providerRequestId);
    expect(status.status).toBe('failure');
    expect(status.error).toBe('テスト用の意図的な失敗');
  });
});
