import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchExternalAgencyHierarchy } from './externalAgencySystem';

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
