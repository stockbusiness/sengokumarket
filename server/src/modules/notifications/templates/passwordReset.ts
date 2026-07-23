import { appConfig } from '../../../shared/config/appConfig';
import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

export function buildPasswordResetEmail(email: string, name: string, token: string): EmailMessage {
  const resetUrl = `${appConfig.appUrl ?? ''}/password-reset/confirm?token=${token}`;

  const html = renderHtmlLayout(`
    <p>${escapeHtml(name)} 様</p>
    <p>パスワード再設定のリクエストを受け付けました。以下のリンクから新しいパスワードを設定してください。</p>
    <p><a href="${resetUrl}">パスワードを再設定する</a></p>
    <p>このリンクの有効期限は72時間です。心当たりがない場合は、本メールを破棄してください。</p>
  `);

  const text = renderTextLayout([
    `${name} 様`,
    'パスワード再設定のリクエストを受け付けました。以下のリンクから新しいパスワードを設定してください。',
    `パスワードを再設定する: ${resetUrl}`,
    'このリンクの有効期限は72時間です。心当たりがない場合は、本メールを破棄してください。',
  ]);

  return { to: email, subject: 'パスワード再設定のご案内', html, text };
}
