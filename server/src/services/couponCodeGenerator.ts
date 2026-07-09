import crypto from 'crypto';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// 紛らわしい文字(0/O/1/I)を除いた英数字(仕様書6章の自動生成例に準拠)。
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSuffix(length: number): string {
  return Array.from({ length }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
}

// 管理者がクーポンコードを任意入力しなかった場合の自動生成(仕様書6.4章)。
// 連番のAG/INF/SGIコードとは異なり、重複時は再試行するランダム生成方式とする。
export async function generateCouponCode(tx: Tx, prefix = 'COUPON'): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `${prefix}-${randomSuffix(6)}`;
    const existing = await tx.coupon.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new Error('クーポンコードの生成に失敗しました(再試行上限に達しました)');
}
