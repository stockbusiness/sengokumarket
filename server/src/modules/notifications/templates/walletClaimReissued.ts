import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「Claim再発行」。
// 管理画面からの再発行は生Tokenを画面へ返さない(22章禁止事項)ため、新しい受取URLは
// このメールで直接お客様へ送付する。
export function buildWalletClaimReissuedEmail(email: string, name: string, claimUrl: string): EmailMessage {
  const html = renderHtmlLayout(`
    <p>${escapeHtml(name)} 様</p>
    <p>NFTカードの受取URLを再発行しました。以下のリンクから受け取り手続きを行ってください。</p>
    <p><a href="${claimUrl}">購入したNFTカードを受け取る</a></p>
  `);

  const text = renderTextLayout([
    `${name} 様`,
    'NFTカードの受取URLを再発行しました。以下のリンクから受け取り手続きを行ってください。',
    `購入したNFTカードを受け取る: ${claimUrl}`,
  ]);

  return { to: email, subject: '【再発行】NFTカードの受取URLについて', html, text };
}
