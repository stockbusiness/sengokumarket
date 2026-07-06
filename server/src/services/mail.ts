import { Resend } from 'resend';
import { getSetting } from './settings';

interface SendMailInput {
  to: string;
  subject: string;
  html: string;
}

// メール送信失敗は呼び出し元の処理(注文処理・パスワードリセット等)を失敗させない。
// エラーはログに記録するのみで、例外は投げない(仕様書v1.5 7.6)。
export async function sendMail(input: SendMailInput): Promise<void> {
  try {
    const apiKey = await getSetting('resend_api_key');
    const mailFrom = await getSetting('mail_from');

    if (!apiKey || !mailFrom) {
      console.error('mail not sent: Resend未設定です', { to: input.to, subject: input.subject });
      return;
    }

    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: mailFrom,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });

    if (result.error) {
      console.error('mail send failed', { to: input.to, subject: input.subject, error: result.error });
    }
  } catch (e) {
    console.error('mail send failed', { to: input.to, subject: input.subject, error: e });
  }
}
