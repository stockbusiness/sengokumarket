// NFT自動発行まわりの、外部連携に関する設定値(いずれも秘密情報ではない)。
// 接続先URL・APIキー等の秘密情報はDB(services/settings.ts)で管理する。
// 千ノ国全体連携(SENNOKUNI_INTEGRATION_ENABLED)は、DB接続情報の取得と一体の
// services/sennokuniIntegrationConfig.tsが既に専用の設定モジュールとして存在するため、
// ここでは重複させない。
export const integrationConfig = {
  get nftMintProvider(): string {
    return process.env.NFT_MINT_PROVIDER ?? 'fake';
  },
  get nftChain(): string {
    return process.env.NFT_CHAIN ?? 'bsc';
  },
  get crossmintCollectionId(): string | undefined {
    return process.env.CROSSMINT_COLLECTION_ID;
  },
  get blobReadWriteToken(): string | undefined {
    return process.env.BLOB_READ_WRITE_TOKEN;
  },
};
