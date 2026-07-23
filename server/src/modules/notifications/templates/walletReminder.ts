import { appConfig } from '../../../shared/config/appConfig';
import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

// 仕様書外の拡張: admin/wallet-missing一覧からの、受取用ウォレット登録案内の再送メール。
// 購入直後のpurchaseComplete.tsと同じ案内文言・リンク先(要ログインのマイページ)を使う。
export function buildWalletReminderEmail(email: string, name: string, orderNumber: string): EmailMessage {
  const walletUrl = `${appConfig.appUrl ?? ''}/mypage/wallet`;

  const html = renderHtmlLayout(`
    <p>${escapeHtml(name)} 様</p>
    <p>ご注文番号 ${escapeHtml(orderNumber)} のデジタル会員証の受け取りには、受取用ウォレットの登録が必要です。<br />
    <a href="${walletUrl}">こちらから登録手続き</a>を行ってください。</p>
  `);

  const text = renderTextLayout([
    `${name} 様`,
    `ご注文番号 ${orderNumber} のデジタル会員証の受け取りには、受取用ウォレットの登録が必要です。\n${walletUrl}`,
  ]);

  return { to: email, subject: '【ご案内】受取用ウォレットのご登録について', html, text };
}
