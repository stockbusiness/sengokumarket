import type { Order, OrderItem } from '@prisma/client';
import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

// 仕様書外の拡張: 銀行振込(手動確認型)の注文受付直後に送る振込案内メール。
// 決済確定(入金確認)は別途管理者が行うため、このメールでは注文内容と振込先・期限のみ案内する。
export function buildBankTransferInstructionsEmail(order: Order, items: OrderItem[], bankInfo: string, expiryDays: number): EmailMessage {
  const itemLines = items.map((item) => {
    const name = `${item.productName} ${item.variantName ?? ''}`.trim();
    return {
      html: `<li>${escapeHtml(name)} × ${item.quantity} — ${item.subtotal.toLocaleString()}円(税込)</li>`,
      text: `・${name} × ${item.quantity} — ${item.subtotal.toLocaleString()}円(税込)`,
    };
  });
  const bankInfoLines = bankInfo.split('\n');
  const bankInfoHtml = bankInfoLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');

  const html = renderHtmlLayout(`
    <p>${escapeHtml(order.customerName)} 様</p>
    <p>ご注文ありがとうございます。以下の内容でお申し込みを承りました。</p>
    <p>注文番号: ${escapeHtml(order.orderNumber)}</p>
    <ul>${itemLines.map((l) => l.html).join('')}</ul>
    <p>お振込み金額: ${order.totalAmount.toLocaleString()}円(税込)</p>
    <p>お振込みの際は、お振込人名の前に<strong>注文番号「${escapeHtml(order.orderNumber)}」</strong>をご入力ください。</p>
    ${bankInfoHtml}
    <p>ご注文から${expiryDays}日以内にお振込みください。期限を過ぎますと、ご注文は自動的にキャンセルとなります。</p>
    <p>入金確認後、担当者より順次デジタル会員証の発行手続きをご案内いたします。</p>
  `);

  const text = renderTextLayout([
    `${order.customerName} 様`,
    'ご注文ありがとうございます。以下の内容でお申し込みを承りました。',
    `注文番号: ${order.orderNumber}`,
    itemLines.map((l) => l.text).join('\n'),
    `お振込み金額: ${order.totalAmount.toLocaleString()}円(税込)`,
    `お振込みの際は、お振込人名の前に注文番号「${order.orderNumber}」をご入力ください。`,
    bankInfoLines.join('\n'),
    `ご注文から${expiryDays}日以内にお振込みください。期限を過ぎますと、ご注文は自動的にキャンセルとなります。`,
    '入金確認後、担当者より順次デジタル会員証の発行手続きをご案内いたします。',
  ]);

  return { to: order.customerEmail, subject: `【お振込みのご案内】注文番号 ${order.orderNumber}`, html, text };
}
