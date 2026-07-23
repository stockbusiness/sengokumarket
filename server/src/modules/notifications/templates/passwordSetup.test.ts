import { describe, expect, it } from 'vitest';
import {
  buildAdminAccountSetupEmail,
  buildAgencyAccessGrantedEmail,
  buildAgencyAccountSetupEmail,
  buildGuestPasswordSetupEmail,
} from './passwordSetup';

describe('passwordSetup templates', () => {
  it('buildGuestPasswordSetupEmailのスナップショット', () => {
    expect(buildGuestPasswordSetupEmail('test@example.com', 'テスト太郎', 'token123')).toMatchSnapshot();
  });

  it('buildAgencyAccountSetupEmailのスナップショット', () => {
    expect(buildAgencyAccountSetupEmail('test@example.com', 'テスト代理店', 'token123')).toMatchSnapshot();
  });

  it('buildAdminAccountSetupEmailのスナップショット', () => {
    expect(buildAdminAccountSetupEmail('test@example.com', 'テスト管理者', 'token123', '管理者')).toMatchSnapshot();
  });

  it('buildAgencyAccessGrantedEmailのスナップショット', () => {
    expect(buildAgencyAccessGrantedEmail('test@example.com', 'テスト太郎')).toMatchSnapshot();
  });

  it('名前にHTML特殊文字が含まれる場合、htmlではエスケープされる', () => {
    const message = buildGuestPasswordSetupEmail('test@example.com', '<script>alert(1)</script>', 'token123');
    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
