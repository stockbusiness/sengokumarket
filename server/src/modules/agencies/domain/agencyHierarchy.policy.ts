export type ParentIdLookup = (agencyId: string) => Promise<string | null>;

// proposedParentIdをtargetAgencyIdの親にすると、targetAgencyId自身がその祖先チェーンに
// 含まれてしまう(循環)かどうかを判定する。DB・Expressに依存しない純粋なPolicyとし、
// 親IDの解決自体は呼び出し側から注入されたgetParentIdに委ねる。
export async function wouldCreateCycle(
  targetAgencyId: string,
  proposedParentId: string,
  getParentId: ParentIdLookup,
): Promise<boolean> {
  let currentId: string | null = proposedParentId;
  while (currentId) {
    if (currentId === targetAgencyId) return true;
    currentId = await getParentId(currentId);
  }
  return false;
}
