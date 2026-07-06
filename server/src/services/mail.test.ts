import { describe, expect, it } from 'vitest';
import { sendMail } from './mail';

describe('sendMail', () => {
  it('Resend未設定時は例外を投げずに(no-opで)完了する', async () => {
    await expect(sendMail({ to: 'test@example.com', subject: '件名', html: '<p>本文</p>' })).resolves.toBeUndefined();
  });
});
