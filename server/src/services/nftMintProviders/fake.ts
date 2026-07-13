import crypto from 'crypto';
import type { MintProvider, MintRequestInput, MintStatusResult } from '../nftMint';

// 仕様書外の拡張: ローカル開発・テスト用の擬似Mintプロバイダー。実際の外部API呼び出しを行わず、
// 送信されたリクエストをメモリ上に記録して結果を返す。テストから挙動を差し替えられるよう
// setFakeMintBehaviorでオーバーライドできるようにする。

const submittedRequests = new Map<string, MintRequestInput>();

let behaviorOverride: ((input: MintRequestInput) => MintStatusResult) | null = null;

export function setFakeMintBehavior(fn: ((input: MintRequestInput) => MintStatusResult) | null) {
  behaviorOverride = fn;
}

export function resetFakeMintProvider() {
  submittedRequests.clear();
  behaviorOverride = null;
}

export const fakeMintProvider: MintProvider = {
  async submitMint(input) {
    const providerRequestId = `fake-${input.idempotencyKey}`;
    submittedRequests.set(providerRequestId, input);
    return { providerRequestId };
  },

  async getMintStatus(providerRequestId) {
    const input = submittedRequests.get(providerRequestId);
    if (!input) {
      return { status: 'failure', error: 'unknown providerRequestId' };
    }
    if (behaviorOverride) {
      return behaviorOverride(input);
    }
    return {
      status: 'success',
      tokenId: String(Math.floor(Math.random() * 1_000_000)),
      transactionHash: `0x${crypto.randomBytes(32).toString('hex')}`,
    };
  },
};
