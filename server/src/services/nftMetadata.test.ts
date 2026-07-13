import { afterEach, describe, expect, it } from 'vitest';
import { buildNftMetadata, uploadNftMetadata } from './nftMetadata';

describe('buildNftMetadata(仕様書外の拡張)', () => {
  const originalAppUrl = process.env.APP_URL;

  afterEach(() => {
    process.env.APP_URL = originalAppUrl;
  });

  it('氏名・メール・電話・住所等の個人情報を一切含まない', () => {
    process.env.APP_URL = 'https://sengoku-rr.com';
    const metadata = buildNftMetadata({ productName: 'インフルエンサー評議員NFT', serialNumber: 125, imageUrl: 'https://blob.example.com/a.png' });

    const serialized = JSON.stringify(metadata);
    for (const forbidden of ['氏名', 'メール', 'email', 'phone', '住所', 'line', 'LINE']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('連番を6桁ゼロ埋めした名称・画像URL・external_url・属性を含む', () => {
    process.env.APP_URL = 'https://sengoku-rr.com/';
    const metadata = buildNftMetadata({ productName: 'インフルエンサー評議員NFT', serialNumber: 125, imageUrl: 'https://blob.example.com/a.png' });

    expect(metadata.name).toBe('インフルエンサー評議員NFT #000125');
    expect(metadata.image).toBe('https://blob.example.com/a.png');
    expect(metadata.external_url).toBe('https://sengoku-rr.com/mypage/nfts');
    expect(metadata.attributes).toEqual([
      { trait_type: 'NFT Type', value: 'インフルエンサー評議員NFT' },
      { trait_type: 'Issue Year', value: String(new Date().getFullYear()) },
      { trait_type: 'Serial Number', value: '000125' },
    ]);
  });

  it('画像URLが無い場合はimageフィールドがundefinedになる', () => {
    const metadata = buildNftMetadata({ productName: 'テスト商品', serialNumber: 1, imageUrl: null });
    expect(metadata.image).toBeUndefined();
  });
});

describe('uploadNftMetadata(仕様書外の拡張)', () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

  afterEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  });

  it('BLOB_READ_WRITE_TOKEN未設定の場合はBLOB_NOT_CONFIGUREDで失敗する', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await expect(uploadNftMetadata('test-issue-id', { name: 'test' })).rejects.toMatchObject({ code: 'BLOB_NOT_CONFIGURED' });
  });
});
