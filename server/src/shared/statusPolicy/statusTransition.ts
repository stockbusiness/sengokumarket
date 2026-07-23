import { DomainError } from '../errors/domainError';

// 7種類のステータス遷移Policy(指示書11.1)で共通する判定ロジック。
// 同一状態への再設定(from === to)は、二重送信・再保存等で頻繁に起こりうる無害な操作のため
// 常に許可する(不正遷移のみを拒否する)。Prisma・Expressに依存しない。
export function assertStatusTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
  errorCode: string,
  message: string,
): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) {
    throw new DomainError(errorCode, message);
  }
}
