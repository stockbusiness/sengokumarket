import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 法務ページ編集', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('一覧を取得できる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/legal');
    expect(res.status).toBe(200);
    const slugs = res.body.documents.map((d: { slug: string }) => d.slug).sort();
    expect(slugs).toEqual(['privacy', 'refund', 'terms', 'tokushoho']);
  });

  it('本文を更新でき、公開APIにも反映される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put('/api/admin/legal/terms')
      .set('Origin', TEST_ORIGIN)
      .send({ title: '利用規約', body: '## 第1条\nadmin-legal-test 更新後の本文' });

    expect(res.status).toBe(200);
    expect(res.body.document.body).toContain('admin-legal-test');

    const publicRes = await agent.get('/api/legal/terms');
    expect(publicRes.body.document.body).toContain('admin-legal-test');

    // 元の内容に戻しておく(他テストへの影響防止)
    await agent
      .put('/api/admin/legal/terms')
      .set('Origin', TEST_ORIGIN)
      .send({ title: '利用規約', body: '## 第1条\n本規約は、当サービスの利用に関する条件を定めるものです。' });
  });

  it('未定義のslugは404', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put('/api/admin/legal/unknown')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'x', body: 'y' });
    expect(res.status).toBe(404);
  });

  it('本文が空の場合は400', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put('/api/admin/legal/terms').set('Origin', TEST_ORIGIN).send({ title: '利用規約', body: '' });
    expect(res.status).toBe(400);
  });
});
