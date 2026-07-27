import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { setSetting } from '../services/settings';
import { hashClaimToken } from '../services/walletClaim';

const pushAgencyCandidateToExternalSystem = vi.fn(async (..._args: unknown[]) => ({
  external_id: 'x',
  code: 'AG999999',
  status: 'active',
}));

vi.mock('../services/externalAgencySystem', () => ({
  pushAgencyCandidateToExternalSystem: (...args: unknown[]) => pushAgencyCandidateToExternalSystem(...args),
}));

const app = createApp();
const ORIGIN = 'http://localhost:5173';
const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

// ウォレット署名検証テスト用: 実際に署名できるテスト用アカウント。
const walletAccount = privateKeyToAccount(generatePrivateKey());
const otherWalletAccount = privateKeyToAccount(generatePrivateKey());

async function requestNonceAndSign(
  agent: ReturnType<typeof request.agent>,
  walletAddress: string,
  signer: typeof walletAccount = walletAccount,
) {
  const nonceRes = await agent.post('/api/mypage/wallet/nonce').set('Origin', ORIGIN).send({ walletAddress });
  const signature = await signer.signMessage({ message: nonceRes.body.message });
  return signature;
}

describe('マイページAPI', () => {
  let userId: string;
  let otherUserId: string;
  let productId: string;
  let variantId: string;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const email = `mypage-test-${Date.now()}@example.com`;
    agent = request.agent(app);
    const registerRes = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'マイページ太郎', email, password: 'password123' });
    userId = registerRes.body.user.id;

    const otherEmail = `mypage-other-test-${Date.now()}@example.com`;
    const otherRes = await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: '他人', email: otherEmail, password: 'password123' });
    otherUserId = otherRes.body.user.id;

    const product = await prisma.product.create({
      data: {
        name: 'マイページテスト商品',
        slug: `mypage-test-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 15000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'Black', price: 15000, stock: 10 },
    });
    variantId = variant.id;

    await prisma.notice.create({
      data: { title: '公開済みお知らせ', body: '本文', status: 'published', publishedAt: new Date() },
    });
    await prisma.notice.create({
      data: { title: '下書きお知らせ', body: '本文', status: 'draft' },
    });
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.notice.deleteMany({ where: { title: { in: ['公開済みお知らせ', '下書きお知らせ'] } } });
    await prisma.walletChangeLog.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.walletVerificationNonce.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  async function createOrderWithNft(ownerId: string, nftStatus: string) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-TEST-${Math.random().toString(36).slice(2)}`,
        userId: ownerId,
        totalAmount: 15000,
        originalAmount: 15000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        variantId,
        productName: 'マイページテスト商品',
        variantName: 'Black',
        itemType: 'nft',
        quantity: 1,
        unitPrice: 15000,
        subtotal: 15000,
      },
    });
    const nftIssue = await prisma.nftIssue.create({
      data: {
        orderId: order.id,
        orderItemId: orderItem.id,
        userId: ownerId,
        productId,
        variantId,
        status: nftStatus,
      },
    });
    return { order, nftIssue };
  }

  it('未認証では401を返す', async () => {
    const res = await request(app).get('/api/mypage/orders');
    expect(res.status).toBe(401);
  });

  it('自分の注文のみ取得できる(他人の注文は含まれない)', async () => {
    await createOrderWithNft(userId, 'wallet_required');
    await createOrderWithNft(otherUserId, 'wallet_required');

    const res = await agent.get('/api/mypage/orders');
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBeGreaterThan(0);
    expect(res.body.orders.every((o: { totalAmount: number }) => o.totalAmount === 15000)).toBe(true);
    expect(res.body.orders[0].items[0].productName).toBe('マイページテスト商品');
  });

  it('自分の注文は1件詳細取得でき、他人の注文はNOT_FOUNDになる(領収書表示用)', async () => {
    const { order: myOrder } = await createOrderWithNft(userId, 'wallet_required');
    const { order: otherOrder } = await createOrderWithNft(otherUserId, 'wallet_required');

    const okRes = await agent.get(`/api/mypage/orders/${myOrder.id}`);
    expect(okRes.status).toBe(200);
    expect(okRes.body.order.customerName).toBe('テスト');
    expect(okRes.body.order.items[0].productName).toBe('マイページテスト商品');

    const forbiddenRes = await agent.get(`/api/mypage/orders/${otherOrder.id}`);
    expect(forbiddenRes.status).toBe(404);
  });

  it('自分のNFT発行状況のみ取得できる', async () => {
    const res = await agent.get('/api/mypage/nfts');
    expect(res.status).toBe(200);
    expect(res.body.nftIssues.length).toBeGreaterThan(0);
    expect(res.body.nftIssues.every((n: { status: string }) => n.status === 'wallet_required')).toBe(true);
  });

  it('公開済みのお知らせのみ取得できる', async () => {
    const res = await agent.get('/api/mypage/notices');
    expect(res.status).toBe(200);
    const titles = res.body.notices.map((n: { title: string }) => n.title);
    expect(titles).toContain('公開済みお知らせ');
    expect(titles).not.toContain('下書きお知らせ');
  });

  it('お知らせは既定で未読、既読にするとread=trueになり他人には影響しない', async () => {
    const before = await agent.get('/api/mypage/notices');
    const notice = before.body.notices.find((n: { title: string }) => n.title === '公開済みお知らせ');
    expect(notice.read).toBe(false);

    const markRes = await agent.post(`/api/mypage/notices/${notice.id}/read`).set('Origin', ORIGIN);
    expect(markRes.status).toBe(200);

    const after = await agent.get('/api/mypage/notices');
    expect(after.body.notices.find((n: { id: string }) => n.id === notice.id).read).toBe(true);

    const otherAgent = request.agent(app);
    const otherEmail = `mypage-otherread-test-${Date.now()}@example.com`;
    await otherAgent.post('/api/auth/register').set('Origin', ORIGIN).send({ name: '他人2', email: otherEmail, password: 'password123' });
    const otherView = await otherAgent.get('/api/mypage/notices');
    expect(otherView.body.notices.find((n: { id: string }) => n.id === notice.id).read).toBe(false);

    await prisma.user.deleteMany({ where: { email: otherEmail } });
  });

  it('氏名・電話番号を編集できる', async () => {
    const res = await agent.put('/api/mypage/profile').set('Origin', ORIGIN).send({ name: '改名太郎', phone: '080-9999-8888' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('改名太郎');
    expect(res.body.user.phone).toBe('080-9999-8888');

    const meRes = await agent.get('/api/auth/me');
    expect(meRes.body.user.name).toBe('改名太郎');
  });

  it('氏名を空にすると400を返す', async () => {
    const res = await agent.put('/api/mypage/profile').set('Origin', ORIGIN).send({ name: '  ', phone: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('不正な形式のウォレットアドレスは400を返す', async () => {
    const res = await agent.post('/api/mypage/wallet').set('Origin', ORIGIN).send({ walletAddress: '0xshort', signature: '0xdead' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('署名を伴わないウォレット登録は400を返す', async () => {
    const res = await agent.post('/api/mypage/wallet').set('Origin', ORIGIN).send({ walletAddress: VALID_ADDRESS });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  describe('ウォレット署名検証(仕様書外の拡張)', () => {
    it('署名検証に成功すると verified=true で登録され、wallet_requiredのnft_issuesがready_to_issueに一括更新される(issued/failedは変更しない)', async () => {
      const { nftIssue: issuedNft } = await createOrderWithNft(userId, 'issued');
      const { nftIssue: failedNft } = await createOrderWithNft(userId, 'failed');

      const signature = await requestNonceAndSign(agent, walletAccount.address);
      const res = await agent
        .post('/api/mypage/wallet')
        .set('Origin', ORIGIN)
        .send({ walletAddress: walletAccount.address, signature });

      expect(res.status).toBe(200);
      expect(res.body.wallet.walletAddress).toBe(walletAccount.address);
      expect(res.body.wallet.verified).toBe(true);

      const walletRes = await agent.get('/api/mypage/wallet');
      expect(walletRes.body.wallet.walletAddress).toBe(walletAccount.address);
      expect(walletRes.body.wallet.verified).toBe(true);

      const updatedIssues = await prisma.nftIssue.findMany({ where: { userId } });
      const previouslyWalletRequired = updatedIssues.filter((n) => n.id !== issuedNft.id && n.id !== failedNft.id);
      expect(
        previouslyWalletRequired.every((n) => n.status === 'ready_to_issue' && n.walletAddress === walletAccount.address),
      ).toBe(true);

      const issuedAfter = updatedIssues.find((n) => n.id === issuedNft.id)!;
      const failedAfter = updatedIssues.find((n) => n.id === failedNft.id)!;
      expect(issuedAfter.status).toBe('issued');
      expect(issuedAfter.walletAddress).toBeNull();
      expect(failedAfter.status).toBe('failed');
      expect(failedAfter.walletAddress).toBeNull();

      const changeLog = await prisma.walletChangeLog.findFirst({
        where: { userId, newAddress: walletAccount.address },
        orderBy: { createdAt: 'desc' },
      });
      expect(changeLog?.changedBy).toBe('self');
      expect(changeLog?.verificationMethod).toBe('personal_sign');
    });

    it('digital_collectible対象商品のnft_issuesは、ウォレット確認が完了してもready_to_issueへ自動遷移しない(戦国マーケットNFTカード受取・送付17章)', async () => {
      const email = `mypage-test-dc-${Date.now()}@example.com`;
      const dcAgent = request.agent(app);
      const registerRes = await dcAgent.post('/api/auth/register').set('Origin', ORIGIN).send({ name: 'DC太郎', email, password: 'password123' });
      const dcUserId = registerRes.body.user.id;

      const dcProduct = await prisma.product.create({
        data: {
          name: `mypage-test-dc-product-${Date.now()}`,
          slug: `mypage-test-dc-product-${Date.now()}`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 15000,
          status: 'published',
        },
      });
      await prisma.productIntegrationRule.create({
        data: { productId: dcProduct.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });
      const dcOrder = await prisma.order.create({
        data: {
          orderNumber: `SG-TEST-DC-${Math.random().toString(36).slice(2)}`,
          userId: dcUserId,
          totalAmount: 15000,
          originalAmount: 15000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: email,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const dcOrderItem = await prisma.orderItem.create({
        data: {
          orderId: dcOrder.id,
          productId: dcProduct.id,
          productName: dcProduct.name,
          itemType: 'nft',
          quantity: 1,
          unitPrice: 15000,
          subtotal: 15000,
        },
      });
      const dcNftIssue = await prisma.nftIssue.create({
        data: { orderId: dcOrder.id, orderItemId: dcOrderItem.id, userId: dcUserId, productId: dcProduct.id, status: 'wallet_required' },
      });
      // 通常のNFT商品の行(digital_collectible対象外)も同時に持たせ、こちらは従来通り
      // ready_to_issueへ遷移することを確認する(既存の他NFT商品の挙動を変えないことの確認)。
      const normalOrder = await prisma.order.create({
        data: {
          orderNumber: `SG-TEST-DC-NORMAL-${Math.random().toString(36).slice(2)}`,
          userId: dcUserId,
          totalAmount: 15000,
          originalAmount: 15000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: email,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const normalOrderItem = await prisma.orderItem.create({
        data: {
          orderId: normalOrder.id,
          productId,
          variantId,
          productName: 'マイページテスト商品',
          variantName: 'Black',
          itemType: 'nft',
          quantity: 1,
          unitPrice: 15000,
          subtotal: 15000,
        },
      });
      const normalNftIssue = await prisma.nftIssue.create({
        data: { orderId: normalOrder.id, orderItemId: normalOrderItem.id, userId: dcUserId, productId, variantId, status: 'wallet_required' },
      });

      const dcWalletAccount = privateKeyToAccount(generatePrivateKey());
      const signature = await requestNonceAndSign(dcAgent, dcWalletAccount.address, dcWalletAccount);
      const res = await dcAgent.post('/api/mypage/wallet').set('Origin', ORIGIN).send({ walletAddress: dcWalletAccount.address, signature });
      expect(res.status).toBe(200);

      const updatedDcIssue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: dcNftIssue.id } });
      expect(updatedDcIssue.status).toBe('wallet_required');
      expect(updatedDcIssue.walletAddress).toBeNull();

      const updatedNormalIssue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: normalNftIssue.id } });
      expect(updatedNormalIssue.status).toBe('ready_to_issue');
      expect(updatedNormalIssue.walletAddress).toBe(dcWalletAccount.address);

      await prisma.nftIssue.deleteMany({ where: { userId: dcUserId } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: [dcOrder.id, normalOrder.id] } } });
      await prisma.order.deleteMany({ where: { id: { in: [dcOrder.id, normalOrder.id] } } });
      await prisma.productIntegrationRule.deleteMany({ where: { productId: dcProduct.id } });
      await prisma.product.delete({ where: { id: dcProduct.id } });
      await prisma.walletChangeLog.deleteMany({ where: { userId: dcUserId } });
      await prisma.walletVerificationNonce.deleteMany({ where: { userId: dcUserId } });
      await prisma.wallet.deleteMany({ where: { userId: dcUserId } });
      await prisma.user.delete({ where: { id: dcUserId } });
    });

    it('確認コードを発行していないアドレスへの登録はNONCE_NOT_FOUNDで400を返す', async () => {
      const bogusSignature = await otherWalletAccount.signMessage({ message: '無関係なメッセージ' });
      const res = await agent
        .post('/api/mypage/wallet')
        .set('Origin', ORIGIN)
        .send({ walletAddress: otherWalletAccount.address, signature: bogusSignature });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NONCE_NOT_FOUND');
    });

    it('別アカウントの秘密鍵で署名した場合はINVALID_SIGNATUREで400を返し、登録されない', async () => {
      const nonceRes = await agent.post('/api/mypage/wallet/nonce').set('Origin', ORIGIN).send({ walletAddress: walletAccount.address });
      const wrongSignature = await otherWalletAccount.signMessage({ message: nonceRes.body.message });

      const res = await agent
        .post('/api/mypage/wallet')
        .set('Origin', ORIGIN)
        .send({ walletAddress: walletAccount.address, signature: wrongSignature });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    });

    it('期限切れの確認コードでの登録はNONCE_EXPIREDで400を返す', async () => {
      const nonceRes = await agent.post('/api/mypage/wallet/nonce').set('Origin', ORIGIN).send({ walletAddress: walletAccount.address });
      await prisma.walletVerificationNonce.updateMany({
        where: { userId, walletAddress: walletAccount.address, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const signature = await walletAccount.signMessage({ message: nonceRes.body.message });

      const res = await agent
        .post('/api/mypage/wallet')
        .set('Origin', ORIGIN)
        .send({ walletAddress: walletAccount.address, signature });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NONCE_EXPIRED');
    });

    it('一度使用した確認コード(署名)を再送信してもNONCE_NOT_FOUNDで拒否される(リプレイ防止)', async () => {
      const signature = await requestNonceAndSign(agent, walletAccount.address);
      const first = await agent
        .post('/api/mypage/wallet')
        .set('Origin', ORIGIN)
        .send({ walletAddress: walletAccount.address, signature });
      expect(first.status).toBe(200);

      const replay = await agent
        .post('/api/mypage/wallet')
        .set('Origin', ORIGIN)
        .send({ walletAddress: walletAccount.address, signature });
      expect(replay.status).toBe(400);
      expect(replay.body.error.code).toBe('NONCE_ALREADY_USED');
    });
  });

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase1「必須修正」: URL設定・メール送信の失敗で
  // 旧URL(旧Token)だけが無効になることを防ぐため、Token発行より前に前提条件を確認する順序になっているか。
  describe('マイページ: Wallet Claim受取URL再発行', () => {
    afterEach(async () => {
      await prisma.setting.deleteMany({ where: { key: 'wallet_claim_web_base_url' } });
    });

    async function createOwnOrderWithClaim(suffix: string, status = 'PENDING') {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-MYPAGE-WCTEST-${suffix}`,
          userId,
          totalAmount: 15000,
          originalAmount: 15000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'マイページ太郎',
          customerEmail: `mypage-wc-test-${suffix}@example.com`,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const claim = await prisma.walletClaim.create({
        data: { orderId: order.id, tokenHash: hashClaimToken(`old-token-${suffix}`), status, expiresAt: new Date(Date.now() + 1000 * 60 * 60) },
      });
      return { order, claim };
    }

    it('wallet_claim_web_base_url未設定の場合、503を返しTokenを書き換えない', async () => {
      const suffix = `nourl-${Date.now()}`;
      const { order, claim } = await createOwnOrderWithClaim(suffix);

      const res = await agent.post(`/api/mypage/orders/${order.id}/wallet-claim/reissue`).set('Origin', ORIGIN);
      expect(res.status).toBe(503);

      const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
      expect(updated.tokenHash).toBe(hashClaimToken(`old-token-${suffix}`));
      expect(updated.reissueCount).toBe(0);

      await prisma.walletClaim.deleteMany({ where: { orderId: order.id } });
      await prisma.order.deleteMany({ where: { id: order.id } });
    });

    it('URL設定済みでPENDINGの場合、再発行できTokenが書き換わる', async () => {
      await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
      const { order, claim } = await createOwnOrderWithClaim(`ok-${Date.now()}`);

      const res = await agent.post(`/api/mypage/orders/${order.id}/wallet-claim/reissue`).set('Origin', ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('https://wallet.example.com/claim/');

      const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
      expect(updated.reissueCount).toBe(1);

      await prisma.walletClaim.deleteMany({ where: { orderId: order.id } });
      await prisma.order.deleteMany({ where: { id: order.id } });
    });

    it('DELIVERY_PENDING状態のClaimは再発行できない(400)', async () => {
      await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
      const { order } = await createOwnOrderWithClaim(`inprogress-${Date.now()}`, 'DELIVERY_PENDING');

      const res = await agent.post(`/api/mypage/orders/${order.id}/wallet-claim/reissue`).set('Origin', ORIGIN);
      expect(res.status).toBe(400);

      await prisma.walletClaim.deleteMany({ where: { orderId: order.id } });
      await prisma.order.deleteMany({ where: { id: order.id } });
    });

    it('他人の注文には404を返す', async () => {
      await setSetting('wallet_claim_web_base_url', 'https://wallet.example.com');
      const otherOrder = await prisma.order.create({
        data: {
          orderNumber: `SG-MYPAGE-WCTEST-other-${Date.now()}`,
          userId: otherUserId,
          totalAmount: 15000,
          originalAmount: 15000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: '他人',
          customerEmail: 'other@example.com',
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });

      const res = await agent.post(`/api/mypage/orders/${otherOrder.id}/wallet-claim/reissue`).set('Origin', ORIGIN);
      expect(res.status).toBe(404);

      await prisma.order.deleteMany({ where: { id: otherOrder.id } });
    });
  });

  describe('代理店(インフルエンサー)申請(仕様書外の拡張)', () => {
    it('申請すると外部代理店システムへ送信され、申請日時が記録される', async () => {
      pushAgencyCandidateToExternalSystem.mockClear();
      const res = await agent.post('/api/mypage/agency-application').set('Origin', ORIGIN);
      expect(res.status).toBe(201);
      expect(pushAgencyCandidateToExternalSystem).toHaveBeenCalledTimes(1);

      const updated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(updated.agencyApplicationSubmittedAt).not.toBeNull();
    });

    it('既に申請済みの場合は400を返し、再送信しない', async () => {
      pushAgencyCandidateToExternalSystem.mockClear();
      const res = await agent.post('/api/mypage/agency-application').set('Origin', ORIGIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('APPLICATION_ALREADY_SUBMITTED');
      expect(pushAgencyCandidateToExternalSystem).not.toHaveBeenCalled();
    });

    it('永久帰属している代理店がある場合、その代理店のexternal_idをparent_external_idとして送信する', async () => {
      const referrerAgency = await prisma.agency.create({
        data: { name: '申請テスト用紹介元代理店', code: `AGAPPTEST${Date.now()}`, externalId: `apptest-parent-${Date.now()}` },
      });

      const email = `mypage-apptest-referred-${Date.now()}@example.com`;
      const referredAgent = request.agent(app);
      const registerRes = await referredAgent
        .post('/api/auth/register')
        .set('Origin', ORIGIN)
        .send({ name: '被紹介太郎', email, password: 'password123' });

      await prisma.user.update({
        where: { id: registerRes.body.user.id },
        data: { referredByAgencyId: referrerAgency.id },
      });

      pushAgencyCandidateToExternalSystem.mockClear();
      const res = await referredAgent.post('/api/mypage/agency-application').set('Origin', ORIGIN);
      expect(res.status).toBe(201);
      expect(pushAgencyCandidateToExternalSystem).toHaveBeenCalledWith(
        expect.objectContaining({ parentExternalId: referrerAgency.externalId }),
      );

      await prisma.user.deleteMany({ where: { id: registerRes.body.user.id } });
      await prisma.agency.delete({ where: { id: referrerAgency.id } });
    });

    it('既に代理店・管理者ロールのユーザーは400を返す', async () => {
      const email = `mypage-apptest-agency-${Date.now()}@example.com`;
      const agencyRoleAgent = request.agent(app);
      const registerRes = await agencyRoleAgent
        .post('/api/auth/register')
        .set('Origin', ORIGIN)
        .send({ name: '既に代理店太郎', email, password: 'password123' });
      // 残課題指示書Stage11: role変更後は旧Cookieが即座に無効化されるため、この直接更新
      // (実運用の権限変更相当)の後は再ログインして最新roleを反映したCookieを取り直す。
      await prisma.user.update({
        where: { id: registerRes.body.user.id },
        data: { role: 'agency', sessionVersion: { increment: 1 } },
      });
      await agencyRoleAgent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password: 'password123' });

      const res = await agencyRoleAgent.post('/api/mypage/agency-application').set('Origin', ORIGIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ALREADY_AGENCY_OR_ADMIN');

      await prisma.user.deleteMany({ where: { id: registerRes.body.user.id } });
    });
  });
});
