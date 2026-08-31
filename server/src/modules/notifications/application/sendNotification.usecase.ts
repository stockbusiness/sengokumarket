import { sendViaResend, sendViaResendOrThrow } from '../infrastructure/resend.adapter';
import type { EmailMessage } from '../domain/notification.types';

// 通知送信の唯一の入口。Adapter(現状Resend)を直接呼ばず、必ずこの関数を経由させることで、
// 将来Adapterを差し替える場合の変更箇所をここ1箇所にする。sendViaResend自体が例外を投げない
// 設計のため、この関数も例外を投げない(呼び出し元の業務トランザクションを巻き戻させない)。
// 既存のテンプレート送信(購入完了メール等)はすべてこちらを使う。
export function sendNotification(message: EmailMessage, idempotencyKey?: string): Promise<void> {
  return sendViaResend(message, idempotencyKey);
}

// NotificationOutboxのDispatcher専用。送信失敗を検知して再試行・dead化するため、
// 例外を投げる版を使う(呼び出し元がtry/catchで結果を判定する)。
export function sendNotificationOrThrow(message: EmailMessage, idempotencyKey?: string): Promise<void> {
  return sendViaResendOrThrow(message, idempotencyKey);
}
