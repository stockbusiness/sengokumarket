import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

async function createViewerAgent() {
  const email = `external-orders-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent };
}

describe('管理API: 外部購入者の取り込み(仕様書外の拡張)', () => {
  let nftProductId: string;
  let nftSku: string;
  let physicalProductId: string;
  let physicalSku: string;

  beforeAll(async () => {
    const nftProduct = await prisma.product.create({
      data: {
        name: 'external-import-test商品',
        slug: `external-import-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    nftProductId = nftProduct.id;
    nftSku = `external-import-test-sku-${Date.now()}`;
    await prisma.productVariant.create({
      data: { productId: nftProductId, name: 'A', sku: nftSku, price: 10000, stock: 10 },
    });

    const physicalProduct = await prisma.product.create({
      data: {
        name: 'external-import-physical-test商品',
        slug: `external-import-physical-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'physical',
        basePrice: 3000,
        status: 'published',
      },
    });
    physicalProductId = physicalProduct.id;
    physicalSku = `external-import-physical-test-sku-${Date.now()}`;
    await prisma.productVariant.create({
      data: { productId: physicalProductId, name: 'A', sku: physicalSku, price: 3000, stock: 10 },
    });
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId: nftProductId } });
    await prisma.orderItem.deleteMany({ where: { productId: { in: [nftProductId, physicalProductId] } } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: 'external-import-test' } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: [nftProductId, physicalProductId] } } });
    await prisma.product.deleteMany({ where: { id: { in: [nftProductId, physicalProductId] } } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'external-import-test' } } } });
    await prisma.wallet.deleteMany({ where: { user: { email: { contains: 'external-import-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'external-import-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'external-orders-viewer-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('新規顧客を手動登録すると注文・NFT発行データ(wallet_required)が作成され在庫が減る', async () => {
    const { agent } = await createAdminAgent(app);
    const email = `external-import-test-1-${Date.now()}@example.com`;
    const variantBefore = await prisma.productVariant.findUniqueOrThrow({ where: { sku: nftSku } });

    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: '外部購入太郎',
      customerEmail: email,
      sku: nftSku,
      quantity: 1,
      externalReference: 'PASSPORT-0001',
    });

    expect(res.status).toBe(201);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id }, include: { orderItems: true, nftIssues: true } });
    expect(order.paymentStatus).toBe('paid');
    expect(order.paymentMethod).toBe('external_import');
    expect(order.guestAccountCreated).toBe(true);
    expect(order.orderItems[0].itemType).toBe('nft');
    expect(order.nftIssues).toHaveLength(1);
    expect(order.nftIssues[0].status).toBe('wallet_required');

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku: nftSku } });
    expect(variant.stock).toBe(variantBefore.stock - 1);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe('user');
  });

  it('既に会員アカウントがある場合は新規作成せず、guestAccountCreatedがfalseになる', async () => {
    const email = `external-import-test-existing-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { name: '既存太郎', email, passwordHash: await bcrypt.hash('existingpassword1', 10), role: 'user' },
    });
    const { agent } = await createAdminAgent(app);

    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: '既存太郎',
      customerEmail: email,
      sku: nftSku,
      quantity: 1,
    });

    expect(res.status).toBe(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id } });
    expect(order.guestAccountCreated).toBe(false);
  });

  it('既に署名検証済みウォレットを持つ会員の場合、nft_issuesは直接ready_to_issueになる', async () => {
    const email = `external-import-test-verified-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: { name: '検証済太郎', email, passwordHash: await bcrypt.hash('verifiedpassword1', 10), role: 'user' },
    });
    await prisma.wallet.create({
      data: { userId: user.id, walletAddress: `0x${'1'.repeat(40)}`, verified: true, verificationMethod: 'personal_sign', verifiedAt: new Date() },
    });
    const { agent } = await createAdminAgent(app);

    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: '検証済太郎',
      customerEmail: email,
      sku: nftSku,
      quantity: 1,
    });

    expect(res.status).toBe(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.order.id }, include: { nftIssues: true } });
    expect(order.nftIssues[0].status).toBe('ready_to_issue');
    expect(order.nftIssues[0].walletAddress).toBe(`0x${'1'.repeat(40)}`);
  });

  it('在庫不足の場合は409を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: '在庫不足太郎',
      customerEmail: `external-import-test-outofstock-${Date.now()}@example.com`,
      sku: nftSku,
      quantity: 999,
    });
    expect(res.status).toBe(409);
  });

  it('存在しないSKUは404を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: 'テスト',
      customerEmail: `external-import-test-nosku-${Date.now()}@example.com`,
      sku: 'no-such-sku',
      quantity: 1,
    });
    expect(res.status).toBe(404);
  });

  it('NFT商品ではないSKUは400を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: 'テスト',
      customerEmail: `external-import-test-notnft-${Date.now()}@example.com`,
      sku: physicalSku,
      quantity: 1,
    });
    expect(res.status).toBe(400);
  });

  it('必須項目が欠けている場合は400を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({ customerEmail: 'a@example.com' });
    expect(res.status).toBe(400);
  });

  it('閲覧専用管理者(admin_viewer)は登録できず403を返す', async () => {
    const { agent } = await createViewerAgent();
    const res = await agent.post('/api/admin/external-orders').set('Origin', TEST_ORIGIN).send({
      customerName: 'テスト',
      customerEmail: `external-import-test-viewer-${Date.now()}@example.com`,
      sku: nftSku,
      quantity: 1,
    });
    expect(res.status).toBe(403);
  });

  describe('CSV一括取り込み', () => {
    it('プレビュー(dryRun)では登録も在庫変動も行われない', async () => {
      const { agent } = await createAdminAgent(app);
      const email = `external-import-test-csv-preview-${Date.now()}@example.com`;
      const variantBefore = await prisma.productVariant.findUniqueOrThrow({ where: { sku: nftSku } });

      const csv = ['購入者名,メールアドレス,SKU,数量', `CSV太郎,${email},${nftSku},1`].join('\n');
      const res = await agent.post('/api/admin/external-orders/import-csv').set('Origin', TEST_ORIGIN).send({ csvContent: csv, dryRun: true });

      expect(res.status).toBe(200);
      expect(res.body.successCount).toBe(1);
      expect(res.body.errorCount).toBe(0);

      const userExists = await prisma.user.findUnique({ where: { email } });
      expect(userExists).toBeNull();
      const variantAfter = await prisma.productVariant.findUniqueOrThrow({ where: { sku: nftSku } });
      expect(variantAfter.stock).toBe(variantBefore.stock);
    });

    it('不正な行はエラー行番号付きで報告され、正しい行のみ処理される', async () => {
      const { agent } = await createAdminAgent(app);
      const validEmail = `external-import-test-csv-mixed-${Date.now()}@example.com`;

      const csv = [
        '購入者名,メールアドレス,SKU,数量',
        `CSV太郎,${validEmail},${nftSku},1`,
        ',bad-email,${nftSku},0',
      ].join('\n');

      const res = await agent.post('/api/admin/external-orders/import-csv').set('Origin', TEST_ORIGIN).send({ csvContent: csv, dryRun: false });

      expect(res.status).toBe(200);
      expect(res.body.successCount).toBe(1);
      expect(res.body.errorCount).toBe(1);
      expect(res.body.results[1].line).toBe(3);
      expect(res.body.results[1].errors.length).toBeGreaterThan(0);

      const created = await prisma.order.findFirst({ where: { customerEmail: validEmail } });
      expect(created).not.toBeNull();
    });

    it('複数行で同じSKUを指定すると在庫が順に減っていく', async () => {
      const sku = `external-import-test-csv-multi-${Date.now()}`;
      await prisma.productVariant.create({ data: { productId: nftProductId, name: 'B', sku, price: 10000, stock: 2 } });

      const email1 = `external-import-test-csv-multi-1-${Date.now()}@example.com`;
      const email2 = `external-import-test-csv-multi-2-${Date.now()}@example.com`;
      const email3 = `external-import-test-csv-multi-3-${Date.now()}@example.com`;
      const csv = ['購入者名,メールアドレス,SKU,数量', `A,${email1},${sku},1`, `B,${email2},${sku},1`, `C,${email3},${sku},1`].join('\n');

      const { agent } = await createAdminAgent(app);
      const res = await agent.post('/api/admin/external-orders/import-csv').set('Origin', TEST_ORIGIN).send({ csvContent: csv, dryRun: false });

      expect(res.status).toBe(200);
      expect(res.body.successCount).toBe(2);
      expect(res.body.errorCount).toBe(1);

      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku } });
      expect(variant.stock).toBe(0);
    });
  });
});
