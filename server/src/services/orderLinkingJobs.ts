import type { OrderLinkingJob, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// 仕様書外の拡張(残課題指示書Stage4): common_user_id解決・referral captureを、注文作成
// (・会員登録)と同一トランザクションでこのテーブルへ記録する。実際の外部HTTP送信はcommit後に
// Dispatcher(orderLinkingJobDispatcher.ts)が行うため、Serverlessのレスポンス完了後に処理が
// 打ち切られてもジョブは失われず、外部API停止時も再試行できる。
//
// referral confirm(event=registration/purchase)は残課題指示書Stage5で別途enqueueする
// (confirm event=purchaseを決済確定前の注文作成時点で送ってしまう問題を避けるため、
// Checkout時点ではcapture止まりとし、confirmは会員登録完了・決済確定のタイミングで
// 別途enqueueする設計にしている)。

export function enqueueCommonUserResolveJob(tx: Tx, input: { userId: string; orderId?: string }): Promise<OrderLinkingJob> {
  return tx.orderLinkingJob.create({
    data: { jobType: 'common_user_resolve', userId: input.userId, orderId: input.orderId ?? null },
  });
}

export function enqueueReferralCaptureJob(tx: Tx, orderId: string): Promise<OrderLinkingJob> {
  return tx.orderLinkingJob.create({
    data: { jobType: 'referral_capture', orderId },
  });
}
