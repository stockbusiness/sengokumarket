import { describe, expect, it } from 'vitest';
import { buildWalletReminderEmail } from './walletReminder';

describe('buildWalletReminderEmail', () => {
  it('件名・本文のスナップショット', () => {
    expect(buildWalletReminderEmail('test@example.com', 'テスト太郎', 'SG-20260101-0001')).toMatchSnapshot();
  });

  it('名前にHTML特殊文字が含まれる場合、htmlではエスケープされる', () => {
    const message = buildWalletReminderEmail('test@example.com', '<b>x</b>', 'SG-20260101-0001');
    expect(message.html).not.toContain('<b>x</b>');
  });
});
