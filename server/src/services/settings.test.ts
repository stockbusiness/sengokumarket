import { afterAll, describe, expect, it } from 'vitest';
import { decryptSetting, encryptSetting } from '../lib/settingsCrypto';
import { getAllSettingsMasked, getSetting, setSetting } from './settings';
import { prisma } from '../lib/prisma';

describe('settingsCrypto', () => {
  it('暗号化した値を復号すると元の文字列に戻る', () => {
    const plaintext = 'sk_test_abcdefg1234567890';
    const encrypted = encryptSetting(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decryptSetting(encrypted)).toBe(plaintext);
  });

  it('同じ平文でも暗号化のたびに異なる暗号文になる(ivがランダムなため)', () => {
    const a = encryptSetting('same-value');
    const b = encryptSetting('same-value');
    expect(a).not.toBe(b);
  });
});

describe('settings service', () => {
  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: 'stripe_secret_key' } });
    await prisma.$disconnect();
  });

  it('setSetting/getSettingで平文が保存・復元できる。DB上は暗号化されている', async () => {
    await setSetting('stripe_secret_key', 'sk_test_xxxxxxxxxxxx1234');
    const value = await getSetting('stripe_secret_key');
    expect(value).toBe('sk_test_xxxxxxxxxxxx1234');

    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'stripe_secret_key' } });
    expect(row.value).not.toContain('sk_test_xxxxxxxxxxxx1234');
  });

  it('未設定のキーはnullを返す', async () => {
    const value = await getSetting('resend_api_key');
    expect(value).toBeNull();
  });

  it('マスク済み一覧は末尾4文字だけ見える', async () => {
    await setSetting('stripe_secret_key', 'sk_test_xxxxxxxxxxxx1234');
    const all = await getAllSettingsMasked();
    expect(all.stripe_secret_key.configured).toBe(true);
    expect(all.stripe_secret_key.masked).toMatch(/\*+1234$/);
    expect(all.resend_api_key.configured).toBe(false);
  });
});
