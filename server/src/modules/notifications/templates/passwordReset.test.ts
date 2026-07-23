import { describe, expect, it } from 'vitest';
import { buildPasswordResetEmail } from './passwordReset';

describe('buildPasswordResetEmail', () => {
  it('件名・本文のスナップショット', () => {
    expect(buildPasswordResetEmail('test@example.com', 'テスト太郎', 'token123')).toMatchSnapshot();
  });

  it('名前にHTML特殊文字が含まれる場合、htmlではエスケープされる', () => {
    const message = buildPasswordResetEmail('test@example.com', '<b>x</b>', 'token123');
    expect(message.html).not.toContain('<b>x</b>');
  });
});
