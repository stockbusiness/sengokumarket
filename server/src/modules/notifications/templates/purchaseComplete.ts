import type { Order, OrderItem } from '@prisma/client';
import { appConfig } from '../../../shared/config/appConfig';
import { getWalletClaimWebBaseUrl } from '../../../services/walletClaimConfig';
import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

function formatItemLine(item: Pick<OrderItem, 'productName' | 'variantName' | 'quantity' | 'subtotal'>): { html: string; text: string } {
  const name = `${item.productName} ${item.variantName ?? ''}`.trim();
  return {
    html: `<li>${escapeHtml(name)} × ${item.quantity} — ${item.subtotal.toLocaleString()}円(税込)</li>`,
    text: `・${name} × ${item.quantity} — ${item.subtotal.toLocaleString()}円(税込)`,
  };
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)7章: WalletClaimが作成された注文
// (digital_collectible対象商品を含み、ENABLE_WALLET_CLAIMが有効な場合のみ)は、購入完了メールに
// 「購入したNFTカードを受け取る」ボタン(千ノ国ウォレット側のURL)を追加する。
export async function buildPurchaseCompleteEmail(order: Order, items: OrderItem[], walletClaimToken: string | null = null): Promise<EmailMessage> {
  const mypageUrl = `${appConfig.appUrl ?? ''}/mypage`;
  const walletUrl = `${appConfig.appUrl ?? ''}/mypage/wallet`;
  const lines = items.map(formatItemLine);

  const claimUrl = walletClaimToken ? await buildClaimUrl(walletClaimToken) : null;

  const html = renderHtmlLayout(`
    <p>${escapeHtml(order.customerName)} 様</p>
    <p>ご購入ありがとうございます。以下の内容で注文を承りました。</p>
    <p>注文番号: ${escapeHtml(order.orderNumber)}</p>
    <ul>${lines.map((l) => l.html).join('')}</ul>
    <p>合計金額: ${order.totalAmount.toLocaleString()}円(税込)</p>
    ${claimUrl ? `<p><a href="${claimUrl}">購入したNFTカードを受け取る</a></p>` : ''}
    <p>デジタル会員証の受け取りには、受取用ウォレットの登録が必要です。<br />
    <a href="${walletUrl}">こちらから登録手続き</a>を行ってください。</p>
    <p>購入履歴・発行状況は<a href="${mypageUrl}">マイページ</a>からご確認いただけます。</p>
  `);

  const text = renderTextLayout([
    `${order.customerName} 様`,
    'ご購入ありがとうございます。以下の内容で注文を承りました。',
    `注文番号: ${order.orderNumber}`,
    lines.map((l) => l.text).join('\n'),
    `合計金額: ${order.totalAmount.toLocaleString()}円(税込)`,
    ...(claimUrl ? [`購入したNFTカードを受け取る:\n${claimUrl}`] : []),
    `デジタル会員証の受け取りには、受取用ウォレットの登録が必要です。\n${walletUrl}`,
    `購入履歴・発行状況はマイページからご確認いただけます。\n${mypageUrl}`,
  ]);

  return { to: order.customerEmail, subject: `【ご購入ありがとうございます】注文番号 ${order.orderNumber}`, html, text };
}

async function buildClaimUrl(token: string): Promise<string | null> {
  const base = await getWalletClaimWebBaseUrl();
  if (!base) return null;
  return `${base}/claim/${token}`;
}
