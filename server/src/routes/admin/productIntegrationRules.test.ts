import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

async function createProduct(suffix: string) {
  return prisma.product.create({
    data: {
      name: `連携ルールAPIテスト商品-${suffix}`,
      slug: `integration-rule-route-test-${suffix}-${Date.now()}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
}

async function createStaffAgent() {
  const email = `integration-rule-route-staff-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name: 'スタッフ', email, passwordHash: await bcrypt.hash('staffpassword1', 10), role: 'staff' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'staffpassword1' });
  return agent;
}

async function createViewerAgent() {
  const email = `integration-rule-route-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return agent;
}

// 本番安定化指示書Stage6(9.5「管理API・画面」・9.1〜9.2「1:N化」)。
describe('管理API: 商品連携ルール(product_integration_rules)(本番安定化指示書Stage6)', () => {
  const createdProductIds: string[] = [];

  afterAll(async () => {
    await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'integration-rule-route-' } } });
    await prisma.$disconnect();
  });

  it('一覧は空配列から始まり、作成すると反映される', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('list');
    createdProductIds.push(product.id);

    const empty = await agent.get(`/api/admin/products/${product.id}/integration-rules`);
    expect(empty.status).toBe(200);
    expect(empty.body.rules).toEqual([]);

    const created = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'sengoku-passport', entitlementType: 'castle_lord_contract', productCode: 'PASSPORT-GOLD' });
    expect(created.status).toBe(201);
    expect(created.body.rule.entitlementTargetSystemKey).toBe('sengoku-passport');
    expect(created.body.rule.enabled).toBe(true);
    expect(created.body.rule.revokeOnRefund).toBe(true);

    const list = await agent.get(`/api/admin/products/${product.id}/integration-rules`);
    expect(list.status).toBe(200);
    expect(list.body.rules).toHaveLength(1);
  });

  it('1商品に複数の送信先ルールを作成できる(1:N化・9.1〜9.2)', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('multi');
    createdProductIds.push(product.id);

    const first = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ai-art-school', entitlementType: 'course_access' });
    expect(first.status).toBe(201);

    const second = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'reward_point',
        rewardAmountPerUnit: 100,
        rewardCalculationMode: 'per_quantity',
      });
    expect(second.status).toBe(201);

    const list = await agent.get(`/api/admin/products/${product.id}/integration-rules`);
    expect(list.body.rules).toHaveLength(2);
  });

  it('不正なentitlementTargetSystemKeyは400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('invalid-target');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'not-a-real-system' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('不正なrewardCalculationModeは400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('invalid-mode');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', rewardCalculationMode: 'not-a-real-mode' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('存在しない商品IDへの一覧・作成は404', async () => {
    const { agent } = await createAdminAgent(app);
    const missingId = '00000000-0000-0000-0000-000000000000';
    const list = await agent.get(`/api/admin/products/${missingId}/integration-rules`);
    expect(list.status).toBe(404);

    const created = await agent.post(`/api/admin/products/${missingId}/integration-rules`).set('Origin', TEST_ORIGIN).send({});
    expect(created.status).toBe(404);
  });

  it('enabledをfalseに更新でき(有効/無効切り替え)、値の変更は反映される', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('update');
    createdProductIds.push(product.id);
    const created = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'reward_point', rewardAmountPerUnit: 50 });
    const ruleId = created.body.rule.id;

    const updated = await agent
      .patch(`/api/admin/products/${product.id}/integration-rules/${ruleId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ enabled: false, rewardAmountPerUnit: 200 });
    expect(updated.status).toBe(200);
    expect(updated.body.rule.enabled).toBe(false);
    expect(updated.body.rule.rewardAmountPerUnit).toBe(200);
  });

  it('存在しないルールIDの更新は404', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('update-missing');
    createdProductIds.push(product.id);
    const missingId = '00000000-0000-0000-0000-000000000000';

    const res = await agent
      .patch(`/api/admin/products/${product.id}/integration-rules/${missingId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('他の商品に属するルールIDを指定すると404になる(productId不一致)', async () => {
    const { agent } = await createAdminAgent(app);
    const productA = await createProduct('cross-a');
    const productB = await createProduct('cross-b');
    createdProductIds.push(productA.id, productB.id);
    const created = await agent
      .post(`/api/admin/products/${productA.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'sengoku-passport' });
    const ruleId = created.body.rule.id;

    const res = await agent
      .patch(`/api/admin/products/${productB.id}/integration-rules/${ruleId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('未認証は401になる', async () => {
    const product = await createProduct('unauth');
    createdProductIds.push(product.id);
    const res = await request(app).get(`/api/admin/products/${product.id}/integration-rules`);
    expect(res.status).toBe(401);
  });

  it('スタッフ(staff)は403でアクセスできない(日次業務系ではないため)', async () => {
    const agent = await createStaffAgent();
    const product = await createProduct('staff-forbidden');
    createdProductIds.push(product.id);

    const res = await agent.get(`/api/admin/products/${product.id}/integration-rules`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('閲覧専用管理者(admin_viewer)はGETは可能だがPOSTは403(READONLY_ADMIN)', async () => {
    const agent = await createViewerAgent();
    const product = await createProduct('viewer');
    createdProductIds.push(product.id);

    const listRes = await agent.get(`/api/admin/products/${product.id}/integration-rules`);
    expect(listRes.status).toBe(200);

    const createRes = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'sengoku-passport' });
    expect(createRes.status).toBe(403);
    expect(createRes.body.error.code).toBe('READONLY_ADMIN');
  });
});
