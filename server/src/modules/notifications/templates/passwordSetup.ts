import { appConfig } from '../../../shared/config/appConfig';
import { escapeHtml, renderHtmlLayout } from '../renderers/htmlRenderer';
import { renderTextLayout } from '../renderers/textRenderer';
import type { EmailMessage } from '../domain/notification.types';
import type { AdminRole } from '@sengoku/contracts';

// 仕様書外の拡張: 管理者アカウント種別の日本語表示名。adminUsers.ts(作成・再送API)と
// dispatchNotificationOutbox.usecase.ts(通知Outbox実行時)の両方から参照する唯一の定義。
export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = { admin: '管理者', admin_viewer: '閲覧専用管理者', staff: 'スタッフ' };

function buildSetupUrl(token: string): string {
  return `${appConfig.appUrl ?? ''}/password-reset/confirm?token=${token}`;
}

function buildAccountSetupEmail(input: { to: string; name: string; intro: string; token: string; subject: string }): EmailMessage {
  const setupUrl = buildSetupUrl(input.token);

  const html = renderHtmlLayout(`
    <p>${escapeHtml(input.name)} 様</p>
    <p>${input.intro}</p>
    <p><a href="${setupUrl}">パスワードを設定する</a></p>
    <p>このリンクの有効期限は72時間です。</p>
  `);

  const text = renderTextLayout([
    `${input.name} 様`,
    input.intro,
    `パスワードを設定する: ${setupUrl}`,
    'このリンクの有効期限は72時間です。',
  ]);

  return { to: input.to, subject: input.subject, html, text };
}

export function buildGuestPasswordSetupEmail(email: string, name: string, token: string): EmailMessage {
  return buildAccountSetupEmail({
    to: email,
    name,
    token,
    intro: 'ご購入ありがとうございます。マイページをご利用いただくためのパスワードを設定してください。',
    subject: 'パスワード設定のご案内',
  });
}

export function buildAgencyAccountSetupEmail(email: string, name: string, token: string): EmailMessage {
  return buildAccountSetupEmail({
    to: email,
    name,
    token,
    intro: '代理店ポータルのアカウントが作成されました。ご利用にはパスワードの設定が必要です。',
    subject: '代理店ポータル アカウント設定のご案内',
  });
}

export function buildAdminAccountSetupEmail(email: string, name: string, token: string, roleLabel: string): EmailMessage {
  return buildAccountSetupEmail({
    to: email,
    name,
    token,
    intro: `管理画面の${escapeHtml(roleLabel)}アカウントが作成されました。ご利用にはパスワードの設定が必要です。`,
    subject: '管理画面 アカウント設定のご案内',
  });
}

// 既存の会員アカウントが代理店ポータルの権限を付与された場合の通知(仕様書外の拡張)。
// 既にログイン用パスワードを持っているため、新しい仮パスワードの発行・設定リンクは不要。
export function buildAgencyAccessGrantedEmail(email: string, name: string): EmailMessage {
  const loginUrl = `${appConfig.appUrl ?? ''}/login`;

  const html = renderHtmlLayout(`
    <p>${escapeHtml(name)} 様</p>
    <p>会員アカウントに代理店ポータルのご利用権限が付与されました。いつものパスワードでログインいただけます。</p>
    <p><a href="${loginUrl}">代理店ポータルにログインする</a></p>
  `);

  const text = renderTextLayout([
    `${name} 様`,
    '会員アカウントに代理店ポータルのご利用権限が付与されました。いつものパスワードでログインいただけます。',
    `代理店ポータルにログインする: ${loginUrl}`,
  ]);

  return { to: email, subject: '代理店ポータル ご利用開始のお知らせ', html, text };
}
