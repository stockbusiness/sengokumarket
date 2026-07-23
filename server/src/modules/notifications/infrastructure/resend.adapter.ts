import { Resend } from 'resend';
import { getSetting } from '../../../services/settings';
import type { EmailMessage } from '../domain/notification.types';

// メール送信失敗は呼び出し元の処理(注文処理・パスワードリセット等)を失敗させない
// (指示書12.3「送信失敗で業務トランザクションを巻き戻さない」)。エラーはログに記録するのみで、
// 例外は投げない(仕様書v1.5 7.6)。
export async function sendViaResend(message: EmailMessage): Promise<void> {
  try {
    const apiKey = await getSetting('resend_api_key');
    const mailFrom = await getSetting('mail_from');

    if (!apiKey || !mailFrom) {
      console.error('mail not sent: Resend未設定です', { to: message.to, subject: message.subject });
      return;
    }

    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: mailFrom,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (result.error) {
      console.error('mail send failed', { to: message.to, subject: message.subject, error: result.error });
    }
  } catch (e) {
    console.error('mail send failed', { to: message.to, subject: message.subject, error: e });
  }
}
