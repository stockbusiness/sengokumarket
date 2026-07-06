import { Router } from 'express';
import { getAllSettingsMasked, setSetting, SETTING_KEYS, type SettingKey } from '../../services/settings';

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

export default router;
