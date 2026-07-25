import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  getSennokuniIntegrationStage,
  setSennokuniIntegrationStageSetting,
  getIntegrationEndpointPath,
} from './sennokuniIntegrationConfig';
import { setSetting } from './settings';

// 本番安定化指示書Stage8(11.4「単純booleanではなく段階化」・11.1「暫定pathへの
// 自動フォールバックなし」)。
describe('sennokuniIntegrationConfig(本番安定化指示書Stage8)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  afterEach(async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_integration_stage', 'integration_endpoint_path_sengoku_passport'] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('getSennokuniIntegrationStage', () => {
    it('SENNOKUNI_INTEGRATION_ENABLEDがfalseの場合は、DB設定の値に関わらず常にdisabled', async () => {
      delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
      await setSennokuniIntegrationStageSetting('production');

      expect(await getSennokuniIntegrationStage()).toBe('disabled');
    });

    it('マスタースイッチが有効でDB設定が未設定の場合は、最も安全側のdry_runになる', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      expect(await getSennokuniIntegrationStage()).toBe('dry_run');
    });

    it('マスタースイッチが有効な場合、DB設定した段階(staging/production)を返す', async () => {
      process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
      await setSennokuniIntegrationStageSetting('staging');
      expect(await getSennokuniIntegrationStage()).toBe('staging');

      await setSennokuniIntegrationStageSetting('production');
      expect(await getSennokuniIntegrationStage()).toBe('production');
    });
  });

  describe('getIntegrationEndpointPath(11.1・11.5「暫定pathへの自動フォールバックなし」)', () => {
    it('未設定の場合はnullを返す(暫定path/shopping/webhookへ自動フォールバックしない)', async () => {
      const path = await getIntegrationEndpointPath('sengoku-passport');
      expect(path).toBeNull();
    });

    it('設定済みの場合はその値をそのまま返す', async () => {
      await setSetting('integration_endpoint_path_sengoku_passport', '/v2/webhook/entitlements');
      const path = await getIntegrationEndpointPath('sengoku-passport');
      expect(path).toBe('/v2/webhook/entitlements');
    });

    it('未対応の送信先キーはnullを返す', async () => {
      const path = await getIntegrationEndpointPath('ove-wallet');
      expect(path).toBeNull();
    });
  });
});
