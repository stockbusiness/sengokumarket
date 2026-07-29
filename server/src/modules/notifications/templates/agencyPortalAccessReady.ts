import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

// 購入後代理店システム連携実装指示書 6.12章「購入完了メール」: アカウント発行が完了した
// 対象商品・ログイン先・有効期限・初回設定手順・問い合わせ先を案内する。
export function buildAgencyPortalAccessReadyEmail(
  email: string,
  name: string,
  orderNumber: string,
  loginUrl: string,
  loginUrlExpiresAt: Date | null,
): EmailMessage {
  const expiresText = loginUrlExpiresAt
    ? `${loginUrlExpiresAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}まで有効です。`
    : '';

  const html = renderHtmlLayout(`
    <p>${escapeHtml(name)} 様</p>
    <p>ご注文番号 ${escapeHtml(orderNumber)} のお申し込み内容にもとづき、代理店システムのログイン準備が整いました。</p>
    <p><a href="${loginUrl}">こちらからログイン</a>${expiresText ? `(${escapeHtml(expiresText)})` : ''}</p>
    <p>初めてログインする場合は、案内画面の指示に沿って初期設定を行ってください。<br />
    リンクの有効期限が切れている場合は、マイページから再発行できます。</p>
    <p>ご不明な点がございましたら、ご案内窓口までお問い合わせください。</p>
  `);

  const text = renderTextLayout([
    `${name} 様`,
    `ご注文番号 ${orderNumber} のお申し込み内容にもとづき、代理店システムのログイン準備が整いました。`,
    `ログインはこちら:\n${loginUrl}${expiresText ? `\n(${expiresText})` : ''}`,
    '初めてログインする場合は、案内画面の指示に沿って初期設定を行ってください。リンクの有効期限が切れている場合は、マイページから再発行できます。',
    'ご不明な点がございましたら、ご案内窓口までお問い合わせください。',
  ]);

  return { to: email, subject: '【ご案内】代理店システムへのログイン準備が整いました', html, text };
}
