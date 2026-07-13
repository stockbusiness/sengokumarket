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

// 仕様書外の拡張: 銀行振込(手動確認型)の注文受付直後に送る振込案内メール。
// 決済確定(入金確認)は別途管理者が行うため、このメールでは注文内容と振込先・期限のみ案内する。
export async function sendBankTransferInstructionsEmail(order: Order, items: OrderItem[], bankInfo: string, expiryDays: number): Promise<void> {
  const itemsHtml = items
    .map((item) => `<li>${item.productName} ${item.variantName ?? ''} × ${item.quantity} — ${item.subtotal.toLocaleString()}円(税込)</li>`)
    .join('');
  const bankInfoHtml = bankInfo
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');

  const html = `
    <p>${order.customerName} 様</p>
    <p>ご注文ありがとうございます。以下の内容でお申し込みを承りました。</p>
    <p>注文番号: ${order.orderNumber}</p>
    <ul>${itemsHtml}</ul>
    <p>お振込み金額: ${order.totalAmount.toLocaleString()}円(税込)</p>
    <p>お振込みの際は、お振込人名の前に<strong>注文番号「${order.orderNumber}」</strong>をご入力ください。</p>
    ${bankInfoHtml}
    <p>ご注文から${expiryDays}日以内にお振込みください。期限を過ぎますと、ご注文は自動的にキャンセルとなります。</p>
    <p>入金確認後、担当者より順次デジタル会員証の発行手続きをご案内いたします。</p>
  `;

  await sendMail({ to: order.customerEmail, subject: `【お振込みのご案内】注文番号 ${order.orderNumber}`, html });
}

// 仕様書外の拡張: カート放棄リマインド。決済セッションが未完了のまま期限切れ(expired)になった
// 直後に送る。既に在庫の仮引当は解放済みのため、元のStripeセッションへの復帰リンクは案内せず、
// 商品ページへ戻って改めて購入手続きをやり直せるように案内する。
export async function sendCartAbandonedEmail(order: Order, items: OrderItem[], productSlug: string | null): Promise<void> {
  const resumeUrl = productSlug ? `${appUrl()}/products/${productSlug}` : `${appUrl()}/products`;

  const itemsHtml = items
    .map((item) => `<li>${item.productName} ${item.variantName ?? ''} × ${item.quantity}</li>`)
    .join('');

  const html = `
    <p>${order.customerName} 様</p>
    <p>以下の内容でお手続き中でしたが、決済が完了していないため注文が保留となりました。</p>
    <ul>${itemsHtml}</ul>
    <p>引き続きご希望の場合は、お手数ですが商品ページから改めてお手続きください。</p>
    <p><a href="${resumeUrl}">商品ページを見る</a></p>
  `;

  await sendMail({ to: order.customerEmail, subject: 'お手続きが完了していません(戦国楽市楽座)', html });
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

// 仕様書外の拡張: admin/wallet-missing一覧からの、受取用ウォレット登録案内の再送メール。
// 購入直後のsendPurchaseCompleteEmailと同じ案内文言・リンク先(要ログインのマイページ)を使う。
export async function sendWalletReminderEmail(email: string, name: string, orderNumber: string): Promise<void> {
  const walletUrl = `${appUrl()}/mypage/wallet`;

  const html = `
    <p>${name} 様</p>
    <p>ご注文番号 ${orderNumber} のデジタル会員証の受け取りには、受取用ウォレットの登録が必要です。<br />
    <a href="${walletUrl}">こちらから登録手続き</a>を行ってください。</p>
  `;

  await sendMail({ to: email, subject: '【ご案内】受取用ウォレットのご登録について', html });
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
