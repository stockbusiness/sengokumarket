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

// 本番安定化指示書Stage5(8.1): 同一user/orderに対する重複enqueueを防ぐため、createではなく
// upsert(deduplication_keyが既存なら何もしない=no-op)を使う。呼び出し元が同じジョブを
// 複数回enqueueしようとしても(例: リトライ・二重送信されたWebhook)、重複行は作られない。
export function enqueueCommonUserResolveJob(tx: Tx, input: { userId: string; orderId?: string }): Promise<OrderLinkingJob> {
  const deduplicationKey = `common-user-resolve:${input.userId}`;
  return tx.orderLinkingJob.upsert({
    where: { deduplicationKey },
    create: { jobType: 'common_user_resolve', userId: input.userId, orderId: input.orderId ?? null, deduplicationKey },
    update: {},
  });
}

export function enqueueReferralCaptureJob(tx: Tx, orderId: string): Promise<OrderLinkingJob> {
  const deduplicationKey = `referral-capture:${orderId}`;
  return tx.orderLinkingJob.upsert({
    where: { deduplicationKey },
    create: { jobType: 'referral_capture', orderId, deduplicationKey },
    update: {},
  });
}

// 残課題指示書Stage5: 決済確定(Stripe Webhook・銀行振込入金確認)と同一トランザクションで
// enqueueする。呼び出し元(applyPaidOrderSideEffects)はpaymentStatus='paid'への更新後にのみ
// 呼ばれるため、未決済注文でconfirmされることはなく、二重処理防止も既存の決済確定処理に委ねる。
export function enqueueReferralConfirmPurchaseJob(tx: Tx, orderId: string): Promise<OrderLinkingJob> {
  const deduplicationKey = `referral-confirm-purchase:${orderId}`;
  return tx.orderLinkingJob.upsert({
    where: { deduplicationKey },
    create: { jobType: 'referral_confirm_purchase', orderId, deduplicationKey },
    update: {},
  });
}
