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
      .send({ entitlementTargetSystemKey: 'sengoku-passport', entitlementType: 'castle_lord_contract' });
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

// Wallet Claim本番前安定化指示書(2026-07-25)Phase5(7.2〜7.4「Feature Flag整合」): ENABLE_WALLET_CLAIM
// =falseの間はdigital_collectible向けルールを有効化できない(既存Mintにも流れず滞留するため)。
describe('管理API: 商品連携ルール(Wallet Claim Feature Flag整合・本番安定化指示書Phase5)', () => {
  const createdProductIds: string[] = [];
  const originalFlag = process.env.ENABLE_WALLET_CLAIM;

  afterAll(async () => {
    process.env.ENABLE_WALLET_CLAIM = originalFlag;
    await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.$disconnect();
  });

  it('ENABLE_WALLET_CLAIM=falseの間は有効なdigital_collectibleルールを新規作成できない', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('flag-off-create');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', assetCode: 'SGK-CARD-001', collectibleRarity: 'common', requireCommonUserId: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WALLET_CLAIM_DISABLED');
  });

  it('ENABLE_WALLET_CLAIM=falseでもenabled=falseでのdigital_collectibleルール作成は許可される', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('flag-off-create-disabled');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: false });
    expect(res.status).toBe(201);
  });

  it('ENABLE_WALLET_CLAIM=trueなら有効なdigital_collectibleルールを作成できる', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('flag-on-create');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', assetCode: 'SGK-CARD-001', collectibleRarity: 'common', requireCommonUserId: true });
    expect(res.status).toBe(201);
  });

  it('ENABLE_WALLET_CLAIM=falseの間は既存の無効ルールをenabled=trueへ更新できない', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('flag-off-update');
    createdProductIds.push(product.id);
    const created = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        assetCode: 'SGK-CARD-001',
        collectibleRarity: 'common',
        requireCommonUserId: true,
        enabled: false,
      });
    const ruleId = created.body.rule.id;

    delete process.env.ENABLE_WALLET_CLAIM;
    const res = await agent
      .patch(`/api/admin/products/${product.id}/integration-rules/${ruleId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WALLET_CLAIM_DISABLED');
  });

  it('digital_collectible以外のルールはENABLE_WALLET_CLAIM=falseでも有効化できる(対象外の組合せ)', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('flag-off-other-type');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'reward_point' });
    expect(res.status).toBe(201);
  });
});

// 本番安定化指示書Stage11(14.1「Product Integration Rules」監視画面): 全商品横断の一覧。
describe('管理API: 商品連携ルール全件一覧(本番安定化指示書Stage11)', () => {
  const createdProductIds: string[] = [];

  afterAll(async () => {
    await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.$disconnect();
  });

  it('管理者は全商品分の連携ルールを商品名付きで取得できる', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('global-list');
    createdProductIds.push(product.id);
    const rule = await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet' },
    });

    const res = await agent.get('/api/admin/product-integration-rules');
    expect(res.status).toBe(200);
    const found = res.body.rules.find((r: { id: string }) => r.id === rule.id);
    expect(found).toBeTruthy();
    expect(found.product.name).toBe(product.name);
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/product-integration-rules');
    expect(res.status).toBe(401);
  });
});

// Wallet Claim本番前安定化指示書(2026-07-25)Phase10(12章「ProductIntegrationRule入力制約」)。
describe('管理API: 商品連携ルール(ProductIntegrationRule入力制約・本番安定化指示書Phase10)', () => {
  const createdProductIds: string[] = [];
  const originalFlag = process.env.ENABLE_WALLET_CLAIM;

  afterAll(async () => {
    process.env.ENABLE_WALLET_CLAIM = originalFlag;
    await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: createdProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.$disconnect();
  });

  it('enabled=trueで送信先(entitlementTargetSystemKey)未指定は400', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('no-target-key');
    createdProductIds.push(product.id);

    const res = await agent.post(`/api/admin/products/${product.id}/integration-rules`).set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('enabled=trueでentitlement_type未指定は400', async () => {
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('no-entitlement-type');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'sengoku-passport' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('digital_collectibleでasset_code未指定は400', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('no-asset-code');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', requireCommonUserId: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('digital_collectibleでrequireCommonUserId=falseは400', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('require-common-false');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', assetCode: 'SGK-CARD-001' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('nft以外の商品へdigital_collectibleは設定できない(enabledに関わらず)', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await prisma.product.create({
      data: {
        name: `連携ルールAPIテスト商品-non-nft-${Date.now()}`,
        slug: `integration-rule-route-test-non-nft-${Date.now()}`,
        category: 'テスト',
        itemType: 'physical',
        basePrice: 10000,
        status: 'published',
      },
    });
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        assetCode: 'SGK-CARD-001',
        requireCommonUserId: true,
        enabled: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('必須項目がすべて揃ったdigital_collectibleルールは作成できる', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('valid-digital-collectible');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        assetCode: 'SGK-CARD-001',
        collectibleRarity: 'rare',
        requireCommonUserId: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.rule.assetCode).toBe('SGK-CARD-001');
    expect(res.body.rule.collectibleRarity).toBe('rare');
  });

  it('既存ルールの更新でasset_codeを外すと400になる(更新時も同じvalidation)', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('update-remove-asset-code');
    createdProductIds.push(product.id);
    const created = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        assetCode: 'SGK-CARD-001',
        collectibleRarity: 'common',
        requireCommonUserId: true,
      });
    const ruleId = created.body.rule.id;

    const res = await agent
      .patch(`/api/admin/products/${product.id}/integration-rules/${ruleId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ assetCode: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // 最終安定化指示書Phase5「ProductIntegrationRule制約完成」
  it('digital_collectibleでcollectibleRarity未設定は400', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('no-rarity');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({ entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', assetCode: 'SGK-CARD-001', requireCommonUserId: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('entitlementType=digital_collectibleで送信先がove-wallet以外は拒否される(enabledに関わらず)', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('wrong-destination');
    createdProductIds.push(product.id);

    const res = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'sengoku-passport',
        entitlementType: 'digital_collectible',
        assetCode: 'SGK-CARD-001',
        collectibleRarity: 'common',
        requireCommonUserId: true,
        enabled: false,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('既存ルールの更新でcollectibleRarityを外すと400になる(更新時も同じvalidation)', async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    const { agent } = await createAdminAgent(app);
    const product = await createProduct('update-remove-rarity');
    createdProductIds.push(product.id);
    const created = await agent
      .post(`/api/admin/products/${product.id}/integration-rules`)
      .set('Origin', TEST_ORIGIN)
      .send({
        entitlementTargetSystemKey: 'ove-wallet',
        entitlementType: 'digital_collectible',
        assetCode: 'SGK-CARD-001',
        collectibleRarity: 'common',
        requireCommonUserId: true,
      });
    const ruleId = created.body.rule.id;

    const res = await agent
      .patch(`/api/admin/products/${product.id}/integration-rules/${ruleId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ collectibleRarity: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
