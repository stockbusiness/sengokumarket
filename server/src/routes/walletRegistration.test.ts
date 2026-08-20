import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { createWalletRegistrationLink } from '../services/walletRegistrationLink';

const app = createApp();
const ORIGIN = 'http://localhost:5173';
const walletAccount = privateKeyToAccount(generatePrivateKey());

describe('公開API: ウォレット登録用リンク(仕様書外の拡張)', () => {
  let userId: string;
  let adminUserId: string;

  afterAll(async () => {
    await prisma.walletChangeLog.deleteMany({ where: { userId } });
    await prisma.walletVerificationNonce.deleteMany({ where: { userId } });
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.walletRegistrationLink.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'wallet-registration-route-test' } } });
    await prisma.$disconnect();
  });

  async function createUser(suffix: string) {
    const user = await prisma.user.create({
      data: {
        name: 'テスト',
        email: `wallet-registration-route-test-${suffix}-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('x', 10),
      },
    });
    return user.id;
  }

  it('statusは存在しないトークンでnoneを返す', async () => {
    const res = await request(app).get('/api/wallet-registration/status').query({ token: 'nonexistent' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('none');
  });

  it('statusはトークン未指定で400を返す', async () => {
    const res = await request(app).get('/api/wallet-registration/status');
    expect(res.status).toBe(400);
  });

  it('有効なトークンでnonce発行→署名→confirmまで成功し、リンクが使用済みになる', async () => {
    userId = await createUser('happy');
    adminUserId = await createUser('admin');
    const token = await createWalletRegistrationLink(userId, adminUserId);

    const statusRes = await request(app).get('/api/wallet-registration/status').query({ token });
    expect(statusRes.body.status).toBe('active');

    const nonceRes = await request(app)
      .post('/api/wallet-registration/nonce')
      .set('Origin', ORIGIN)
      .send({ token, walletAddress: walletAccount.address });
    expect(nonceRes.status).toBe(200);

    const signature = await walletAccount.signMessage({ message: nonceRes.body.message });
    const confirmRes = await request(app)
      .post('/api/wallet-registration/confirm')
      .set('Origin', ORIGIN)
      .send({ token, walletAddress: walletAccount.address, signature });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.wallet.walletAddress.toLowerCase()).toBe(walletAccount.address.toLowerCase());
    expect(confirmRes.body.wallet.verified).toBe(true);

    const afterStatusRes = await request(app).get('/api/wallet-registration/status').query({ token });
    expect(afterStatusRes.body.status).toBe('used');
  });

  it('使用済みトークンでの再度のnonce発行は拒否される', async () => {
    const usedUserId = await createUser('used');
    const admin = await createUser('admin-used');
    const token = await createWalletRegistrationLink(usedUserId, admin);

    const nonceRes = await request(app).post('/api/wallet-registration/nonce')
      .set('Origin', ORIGIN).send({ token, walletAddress: walletAccount.address });
    const signature = await walletAccount.signMessage({ message: nonceRes.body.message });
    await request(app).post('/api/wallet-registration/confirm')
      .set('Origin', ORIGIN).send({ token, walletAddress: walletAccount.address, signature });

    const secondNonceRes = await request(app)
      .post('/api/wallet-registration/nonce')
      .set('Origin', ORIGIN)
      .send({ token, walletAddress: walletAccount.address });
    expect(secondNonceRes.status).toBe(400);
    expect(secondNonceRes.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');

    await prisma.walletChangeLog.deleteMany({ where: { userId: usedUserId } });
    await prisma.walletVerificationNonce.deleteMany({ where: { userId: usedUserId } });
    await prisma.wallet.deleteMany({ where: { userId: usedUserId } });
    await prisma.walletRegistrationLink.deleteMany({ where: { userId: usedUserId } });
  });

  it('失効済みトークンでのnonce発行は拒否される', async () => {
    const revokedUserId = await createUser('revoked');
    const admin = await createUser('admin-revoked');
    const token = await createWalletRegistrationLink(revokedUserId, admin);
    await prisma.walletRegistrationLink.updateMany({ where: { userId: revokedUserId }, data: { revokedAt: new Date() } });

    const nonceRes = await request(app).post('/api/wallet-registration/nonce')
      .set('Origin', ORIGIN).send({ token, walletAddress: walletAccount.address });
    expect(nonceRes.status).toBe(400);

    await prisma.walletRegistrationLink.deleteMany({ where: { userId: revokedUserId } });
  });

  it('不正な形式のウォレットアドレスは400を返す', async () => {
    const u = await createUser('badaddr');
    const admin = await createUser('admin-badaddr');
    const token = await createWalletRegistrationLink(u, admin);

    const res = await request(app).post('/api/wallet-registration/nonce')
      .set('Origin', ORIGIN).send({ token, walletAddress: 'not-an-address' });
    expect(res.status).toBe(400);

    await prisma.walletRegistrationLink.deleteMany({ where: { userId: u } });
  });

  it('confirmで署名が不正な場合はINVALID_SIGNATUREを返す', async () => {
    const u = await createUser('badsig');
    const admin = await createUser('admin-badsig');
    const token = await createWalletRegistrationLink(u, admin);

    const nonceRes = await request(app).post('/api/wallet-registration/nonce')
      .set('Origin', ORIGIN).send({ token, walletAddress: walletAccount.address });
    const otherAccount = privateKeyToAccount(generatePrivateKey());
    const wrongSignature = await otherAccount.signMessage({ message: nonceRes.body.message });

    const confirmRes = await request(app)
      .post('/api/wallet-registration/confirm')
      .set('Origin', ORIGIN)
      .send({ token, walletAddress: walletAccount.address, signature: wrongSignature });
    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.code).toBe('INVALID_SIGNATURE');

    await prisma.walletVerificationNonce.deleteMany({ where: { userId: u } });
    await prisma.walletRegistrationLink.deleteMany({ where: { userId: u } });
  });
});
