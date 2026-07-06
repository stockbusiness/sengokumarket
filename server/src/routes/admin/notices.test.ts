import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: お知らせ管理', () => {
  let noticeId: string;

  afterAll(async () => {
    await prisma.notice.deleteMany({ where: { title: { contains: 'admin-notice-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('新規作成するとdraftになる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/notices')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'admin-notice-test 1', body: '本文' });

    expect(res.status).toBe(201);
    expect(res.body.notice.status).toBe('draft');
    expect(res.body.notice.publishedAt).toBeNull();
    noticeId = res.body.notice.id;
  });

  it('publishedに変更するとpublished_atが記録される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put(`/api/admin/notices/${noticeId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'published' });

    expect(res.status).toBe(200);
    expect(res.body.notice.status).toBe('published');
    expect(res.body.notice.publishedAt).not.toBeNull();
  });

  it('削除できる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.delete(`/api/admin/notices/${noticeId}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(204);

    const deleted = await prisma.notice.findUnique({ where: { id: noticeId } });
    expect(deleted).toBeNull();
  });
});
