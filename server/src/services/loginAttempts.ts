// アカウント+IP単位のログイン失敗回数制限(仕様書v1.5 4.8: 5回失敗で15分ロック)。
// MVPではインスタンス内メモリで管理する(複数インスタンス運用時はStore差し替えが必要)。

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

interface AttemptRecord {
  count: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, AttemptRecord>();

function key(email: string, ip: string): string {
  return `${email.toLowerCase()}::${ip}`;
}

export function isLocked(email: string, ip: string): boolean {
  const record = attempts.get(key(email, ip));
  if (!record?.lockedUntil) return false;
  if (Date.now() > record.lockedUntil) {
    attempts.delete(key(email, ip));
    return false;
  }
  return true;
}

export function recordLoginFailure(email: string, ip: string): void {
  const k = key(email, ip);
  const record = attempts.get(k) ?? { count: 0, lockedUntil: null };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCK_MS;
  }
  attempts.set(k, record);
}

export function recordLoginSuccess(email: string, ip: string): void {
  attempts.delete(key(email, ip));
}
