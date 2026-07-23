import { describe, expect, it } from 'vitest';
import { sendViaResend } from './resend.adapter';

describe('sendViaResend', () => {
  it('Resend未設定時は例外を投げずに(no-opで)完了する', async () => {
    await expect(sendViaResend({ to: 'test@example.com', subject: '件名', html: '<p>本文</p>', text: '本文' })).resolves.toBeUndefined();
  });
});
