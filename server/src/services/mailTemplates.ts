import type { Order, OrderItem } from '@prisma/client';
import { sendMail } from './mail';

function appUrl(): string {
  return process.env.APP_URL ?? '';
}

export async function sendPurchaseCompleteEmail(order: Order, items: OrderItem[]): Promise<void> {
  const mypageUrl = `${appUrl()}/mypage`;
  const walletUrl = `${appUrl()}/mypage/wallet`;

  const itemsHtml = items
    .map((item) => `<li>${item.productName} ${item.variantName ?? ''} × ${item.quantity} — ${item.subtotal.toLocaleString()}円(税込)</li>`)
    .join('');

  const html = `
    <p>${order.customerName} 様</p>
    <p>ご購入ありがとうございます。以下の内容で注文を承りました。</p>
    <p>注文番号: ${order.orderNumber}</p>
    <ul>${itemsHtml}</ul>
    <p>合計金額: ${order.totalAmount.toLocaleString()}円(税込)</p>
    <p>デジタル会員証の受け取りには、受取用ウォレットの登録が必要です。<br />
    <a href="${walletUrl}">こちらから登録手続き</a>を行ってください。</p>
    <p>購入履歴・発行状況は<a href="${mypageUrl}">マイページ</a>からご確認いただけます。</p>
  `;

  await sendMail({ to: order.customerEmail, subject: `【ご購入ありがとうございます】注文番号 ${order.orderNumber}`, html });
}

export async function sendGuestPasswordSetupEmail(email: string, name: string, token: string): Promise<void> {
  const setupUrl = `${appUrl()}/password-reset/confirm?token=${token}`;

  const html = `
    <p>${name} 様</p>
    <p>ご購入ありがとうございます。マイページをご利用いただくためのパスワードを設定してください。</p>
    <p><a href="${setupUrl}">パスワードを設定する</a></p>
    <p>このリンクの有効期限は72時間です。</p>
  `;

  await sendMail({ to: email, subject: 'パスワード設定のご案内', html });
}

export async function sendAgencyAccountSetupEmail(email: string, name: string, token: string): Promise<void> {
  const setupUrl = `${appUrl()}/password-reset/confirm?token=${token}`;

  const html = `
    <p>${name} 様</p>
    <p>代理店ポータルのアカウントが作成されました。ご利用にはパスワードの設定が必要です。</p>
    <p><a href="${setupUrl}">パスワードを設定する</a></p>
    <p>このリンクの有効期限は72時間です。</p>
  `;

  await sendMail({ to: email, subject: '代理店ポータル アカウント設定のご案内', html });
}

// 既存の会員アカウントが代理店ポータルの権限を付与された場合の通知(仕様書外の拡張)。
// 既にログイン用パスワードを持っているため、新しい仮パスワードの発行・設定リンクは不要。
export async function sendAgencyAccessGrantedEmail(email: string, name: string): Promise<void> {
  const loginUrl = `${appUrl()}/login`;

  const html = `
    <p>${name} 様</p>
    <p>会員アカウントに代理店ポータルのご利用権限が付与されました。いつものパスワードでログインいただけます。</p>
    <p><a href="${loginUrl}">代理店ポータルにログインする</a></p>
  `;

  await sendMail({ to: email, subject: '代理店ポータル ご利用開始のお知らせ', html });
}

export async function sendAdminAccountSetupEmail(email: string, name: string, token: string, roleLabel: string): Promise<void> {
  const setupUrl = `${appUrl()}/password-reset/confirm?token=${token}`;

  const html = `
    <p>${name} 様</p>
    <p>管理画面の${roleLabel}アカウントが作成されました。ご利用にはパスワードの設定が必要です。</p>
    <p><a href="${setupUrl}">パスワードを設定する</a></p>
    <p>このリンクの有効期限は72時間です。</p>
  `;

  await sendMail({ to: email, subject: '管理画面 アカウント設定のご案内', html });
}

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<void> {
  const resetUrl = `${appUrl()}/password-reset/confirm?token=${token}`;

  const html = `
    <p>${name} 様</p>
    <p>パスワード再設定のリクエストを受け付けました。以下のリンクから新しいパスワードを設定してください。</p>
    <p><a href="${resetUrl}">パスワードを再設定する</a></p>
    <p>このリンクの有効期限は72時間です。心当たりがない場合は、本メールを破棄してください。</p>
  `;

  await sendMail({ to: email, subject: 'パスワード再設定のご案内', html });
}
