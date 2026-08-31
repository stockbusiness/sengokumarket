import { Resend } from 'resend';
import { getSetting } from '../../../services/settings';
import type { EmailMessage } from '../domain/notification.types';

// 実際の送信本体。Resend未設定・送信APIエラーは例外として投げる(呼び出し元が成否を
// 判定できるようにするため)。
//
// idempotencyKeyを渡すと、Resend API側で同一キーの重複送信を1回分にまとめてくれる。
// Notification Outbox Dispatcherは「Resend送信自体は成功したが、その直後の
// markSucceeded書き込みに失敗した」場合に同じイベントをリトライするため(結果整合性上、
// 再送すること自体は正しい動作)、idempotencyKeyが無いと購入者に同じメールが複数回届く。
// キーはevent.id(リトライ間で不変)を使うことで、この再送を1通に抑える。
async function sendViaResendOrThrow(message: EmailMessage, idempotencyKey?: string): Promise<void> {
  const apiKey = await getSetting('resend_api_key');
  const mailFrom = await getSetting('mail_from');

  if (!apiKey || !mailFrom) {
    throw new Error('Resend未設定です(resend_api_key/mail_fromが未登録)');
  }

  const resend = new Resend(apiKey);
  const result = await resend.emails.send(
    {
      from: mailFrom,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );

  if (result.error) {
    throw new Error(`Resend送信エラー: ${result.error.message ?? JSON.stringify(result.error)}`);
  }
}

// メール送信失敗は呼び出し元の処理(注文処理・パスワードリセット等)を失敗させない
// (指示書12.3「送信失敗で業務トランザクションを巻き戻さない」)。エラーはログに記録するのみで、
// 例外は投げない(仕様書v1.5 7.6)。既存の同期的な通知送信(購入完了メール等)はすべてこちらを使う。
export async function sendViaResend(message: EmailMessage, idempotencyKey?: string): Promise<void> {
  try {
    await sendViaResendOrThrow(message, idempotencyKey);
  } catch (e) {
    console.error('mail send failed', { to: message.to, subject: message.subject, error: e });
  }
}

// 残課題指示書Stage3: NotificationOutboxのDispatcherは送信失敗を検知して再試行(backoff)・
// 最大試行回数超過でdead化する必要があるため、例外を投げる版を使う。
export { sendViaResendOrThrow };
