import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

function todayPrefix(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `SG-${y}${m}${d}-`;
}

// 同日内の注文番号発番を直列化するため、日付単位のアドバイザリロックを取得してからカウントする。
export async function generateOrderNumber(tx: Tx): Promise<string> {
  const prefix = todayPrefix();

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;

  const count = await tx.order.count({
    where: { orderNumber: { startsWith: prefix } },
  });

  const seq = String(count + 1).padStart(4, '0');
  return `${prefix}${seq}`;
}
