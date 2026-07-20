import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchExternalAgencyHierarchy, pushAgencyCandidateToExternalSystem } from './externalAgencySystem';
import { setSetting } from './settings';

// 先方(sengoku-ai.com)から実際に共有されたサンプルレスポンス(2026-07-09回答)。
// projects配列(LPプロジェクト一覧、代理店データではない)とtree配列(代理店階層)が
// 両方トップレベルに存在する点、代理店の一意キーがagent_codeではなくcodeである点が
// この修正で対応した実際の食い違い。
const SAMPLE_RESPONSE = {
  ok: true,
  generated_at: '2026-07-09T10:00:00+09:00',
  format: 'tree',
  filters: { root_code: null, include_inactive: false, include_contact: true },
  labels: { level1: 'アドバイザー', level2: 'ディレクター', level3: 'エージェント' },
  projects: [
    { id: 1, slug: 'sengoku-influencer', name: '戦国インフルエンサー', status: 'active', sort_order: 1 },
    { id: 2, slug: 'ai-art-school', name: 'AIアート教室', status: 'active', sort_order: 20 },
  ],
  count: 2,
  tree: [
    {
      id: 1,
      code: 'agent_7_8573',
      name: 'ストックビジネス合同会社',
      level: 3,
      role_label: 'エージェント',
      parent_id: null,
      parent_code: null,
      status: 'active',
      contact: { email: 'agent@example.com', phone: '09011112222', line_url: 'https://lin.ee/agent' },
      children: [
        {
          id: 2,
          code: 'dir260b6d6e',
          name: 'yamayama',
          level: 2,
          role_label: 'ディレクター',
          parent_id: 1,
          parent_code: 'agent_7_8573',
          status: 'active',
          contact: { email: 'director@example.com', phone: '08012345678', line_url: 'https://lin.ee/director' },
          children: [],
        },
      ],
    },
  ],
};

describe('fetchExternalAgencyHierarchy(仕様書外の拡張)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('先方の実レスポンス形式(ok/tree/code)を正しく解析し、親子関係を反映する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(SAMPLE_RESPONSE)),
      }),
    );

    const nodes = await fetchExternalAgencyHierarchy('https://sengoku-ai.com', 'test-key');

    expect(nodes).toHaveLength(2);
    const parent = nodes.find((n) => n.code === 'agent_7_8573');
    const child = nodes.find((n) => n.code === 'dir260b6d6e');
    expect(parent).toMatchObject({ name: 'ストックビジネス合同会社', parentCode: null, contactEmail: 'agent@example.com' });
    expect(child).toMatchObject({ name: 'yamayama', parentCode: 'agent_7_8573', contactEmail: 'director@example.com' });
  });

  it('projects配列ではなくtree配列を代理店データとして使う', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(SAMPLE_RESPONSE)),
      }),
    );

    const nodes = await fetchExternalAgencyHierarchy('https://sengoku-ai.com', 'test-key');
    const codes = nodes.map((n) => n.code).sort();
    expect(codes).toEqual(['agent_7_8573', 'dir260b6d6e']);
    expect(codes).not.toContain('sengoku-influencer');
    expect(codes).not.toContain('ai-art-school');
  });
});

// 仕様書外の拡張(外部開発者向け連携ガイドv3.6.78-draft): 代理店同期APIのレスポンスが
// 新形式{ok, ...}・旧形式{success, data}のどちらでも解釈できること、送信時にIdempotency-Keyを
// 付与することを確認する。
describe('pushAgencyCandidateToExternalSystem(仕様書外の拡張)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const input = { externalId: 'ext-1', name: 'テスト代理店' };

  it('新形式{ok, external_id, status, synced}のレスポンスを解釈できる', async () => {
    await setSetting('external_agency_system_base_url', 'https://sengoku-ai.com');
    await setSetting('external_agency_system_api_key', 'test-key');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, external_id: 'ext-1', status: 'active', synced: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await pushAgencyCandidateToExternalSystem(input);
    expect(result).toMatchObject({ external_id: 'ext-1', status: 'active', synced: true });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers['Idempotency-Key']).toBeTypeOf('string');
    expect(requestInit.headers['Idempotency-Key'].length).toBeGreaterThan(0);
  });

  it('旧形式{success, data}のレスポンスも解釈できる', async () => {
    await setSetting('external_agency_system_base_url', 'https://sengoku-ai.com');
    await setSetting('external_agency_system_api_key', 'test-key');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { external_id: 'ext-1', status: 'active', synced: true } }),
      }),
    );

    const result = await pushAgencyCandidateToExternalSystem(input);
    expect(result).toMatchObject({ external_id: 'ext-1', status: 'active', synced: true });
  });

  it('新形式のエラー{ok:false, error:{message}}を検知して例外を投げる', async () => {
    await setSetting('external_agency_system_base_url', 'https://sengoku-ai.com');
    await setSetting('external_agency_system_api_key', 'test-key');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: '不正なリクエストです' } }),
      }),
    );

    await expect(pushAgencyCandidateToExternalSystem(input)).rejects.toThrow('不正なリクエストです');
  });
});
