import type { Order, OrderItem } from '@prisma/client';
import { appConfig } from '../../../shared/config/appConfig';
import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

// 仕様書外の拡張: カート放棄リマインド。決済セッションが未完了のまま期限切れ(expired)になった
// 直後に送る。既に在庫の仮引当は解放済みのため、元のStripeセッションへの復帰リンクは案内せず、
// 商品ページへ戻って改めて購入手続きをやり直せるように案内する。
export function buildCartAbandonedEmail(order: Order, items: OrderItem[], productSlug: string | null): EmailMessage {
  const resumeUrl = productSlug ? `${appConfig.appUrl ?? ''}/products/${productSlug}` : `${appConfig.appUrl ?? ''}/products`;

  const itemLines = items.map((item) => {
    const name = `${item.productName} ${item.variantName ?? ''}`.trim();
    return { html: `<li>${escapeHtml(name)} × ${item.quantity}</li>`, text: `・${name} × ${item.quantity}` };
  });

  const html = renderHtmlLayout(`
    <p>${escapeHtml(order.customerName)} 様</p>
    <p>以下の内容でお手続き中でしたが、決済が完了していないため注文が保留となりました。</p>
    <ul>${itemLines.map((l) => l.html).join('')}</ul>
    <p>引き続きご希望の場合は、お手数ですが商品ページから改めてお手続きください。</p>
    <p><a href="${resumeUrl}">商品ページを見る</a></p>
  `);

  const text = renderTextLayout([
    `${order.customerName} 様`,
    '以下の内容でお手続き中でしたが、決済が完了していないため注文が保留となりました。',
    itemLines.map((l) => l.text).join('\n'),
    `引き続きご希望の場合は、お手数ですが商品ページから改めてお手続きください。\n${resumeUrl}`,
  ]);

  return { to: order.customerEmail, subject: `お手続きが完了していません(${appConfig.brandName})`, html, text };
}
