import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from './agencyHierarchy.policy';

// DBに依存しないDomain Unit Test(指示書15.1)。親IDの解決はスタブの親子マップで注入する。
describe('wouldCreateCycle', () => {
  function lookupFromChain(chain: Record<string, string | null>) {
    return async (agencyId: string) => chain[agencyId] ?? null;
  }

  it('提案された親が対象自身の祖先チェーンに含まれる場合はtrue(循環)', async () => {
    // gp <- parent <- child、childをgpの親にしようとするケース
    const getParentId = lookupFromChain({ parent: 'gp' });
    const cyclic = await wouldCreateCycle('gp', 'parent', getParentId);
    expect(cyclic).toBe(true);
  });

  it('提案された親が祖先チェーンに含まれない場合はfalse', async () => {
    const getParentId = lookupFromChain({ parentA: 'gpA' });
    const cyclic = await wouldCreateCycle('target', 'parentA', getParentId);
    expect(cyclic).toBe(false);
  });

  it('提案された親が本部直下(親なし)の場合はfalse', async () => {
    const getParentId = lookupFromChain({});
    const cyclic = await wouldCreateCycle('target', 'root', getParentId);
    expect(cyclic).toBe(false);
  });

  it('提案された親が対象自身と同一の場合はtrue', async () => {
    const getParentId = lookupFromChain({});
    const cyclic = await wouldCreateCycle('self', 'self', getParentId);
    expect(cyclic).toBe(true);
  });
});
