import { Router } from 'express';
import { sendError } from '../../lib/apiError';
import { getAllSettingsMasked, setSetting, SETTING_KEYS, type SettingKey } from '../../services/settings';
import { testExternalAgencyConnection, testResendConnection, testStripeConnection } from '../../services/connectionTest';

const router = Router();

router.get('/settings', async (_req, res) => {
  const settings = await getAllSettingsMasked();
  res.json({ settings });
});

// 空欄で送られた項目は「変更しない」として扱う(マスク済み値しか画面に出せないため)。
router.put('/settings', async (req, res) => {
  const body = (req.body ?? {}) as Partial<Record<SettingKey, unknown>>;

  for (const key of SETTING_KEYS) {
    const value = body[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      await setSetting(key, value.trim());
    }
  }

  const settings = await getAllSettingsMasked();
  res.json({ settings });
});

// 仕様書外の拡張: 保存前(入力中)の値、または保存済みの値でAPIキー等の接続テストを行う。
// 未入力の場合は保存済みの値でテストする。
router.post('/settings/test/stripe', async (req, res) => {
  const result = await testStripeConnection(readString(req.body, 'stripe_secret_key'));
  res.json(result);
});

router.post('/settings/test/resend', async (req, res) => {
  const to = readString(req.body, 'to');
  if (!to) return sendError(res, 400, 'VALIDATION_ERROR', 'テスト送信先のメールアドレスを指定してください');

  const result = await testResendConnection(readString(req.body, 'resend_api_key'), readString(req.body, 'mail_from'), to);
  res.json(result);
});

router.post('/settings/test/external-agency', async (req, res) => {
  const result = await testExternalAgencyConnection(
    readString(req.body, 'external_agency_system_base_url'),
    readString(req.body, 'external_agency_system_api_key'),
  );
  res.json(result);
});

function readString(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
}

export default router;
