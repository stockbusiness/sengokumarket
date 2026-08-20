import { afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import {
  consumeWalletRegistrationLink,
  createWalletRegistrationLink,
  getWalletRegistrationLinkStatus,
  revokeWalletRegistrationLink,
  validateWalletRegistrationLink,
} from './walletRegistrationLink';

describe('walletRegistrationLink service(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.walletRegistrationLink.deleteMany({ where: { user: { email: { contains: 'wallet-reg-link-svc-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'wallet-reg-link-svc-test' } } });
    await prisma.$disconnect();
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: {
        name: 'テスト',
        email: `wallet-reg-link-svc-test-${suffix}-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('x', 10),
      },
    });
  }

  it('発行したトークンはactiveとして検証でき、userIdが取得できる', async () => {
    const user = await createUser('active');
    const admin = await createUser('admin1');

    const token = await createWalletRegistrationLink(user.id, admin.id);

    const validated = await validateWalletRegistrationLink(token);
    expect(validated.status).toBe('active');
    expect(validated.userId).toBe(user.id);

    const status = await getWalletRegistrationLinkStatus(user.id);
    expect(status.status).toBe('active');
    expect(status.expiresAt).not.toBeNull();
  });

  it('存在しないトークンはnoneを返す', async () => {
    const validated = await validateWalletRegistrationLink('nonexistent-token');
    expect(validated.status).toBe('none');
    expect(validated.userId).toBeNull();
  });

  it('期限切れトークンはexpiredを返す', async () => {
    const user = await createUser('expired');
    const admin = await createUser('admin2');
    const token = await createWalletRegistrationLink(user.id, admin.id);
    await prisma.walletRegistrationLink.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const validated = await validateWalletRegistrationLink(token);
    expect(validated.status).toBe('expired');
  });

  it('使用済みトークンはusedを返し、consumeWalletRegistrationLink後は再利用できない', async () => {
    const user = await createUser('used');
    const admin = await createUser('admin3');
    const token = await createWalletRegistrationLink(user.id, admin.id);

    await consumeWalletRegistrationLink(token);

    const validated = await validateWalletRegistrationLink(token);
    expect(validated.status).toBe('used');
  });

  it('再発行すると旧トークンが自動失効し、新トークンのみactiveになる', async () => {
    const user = await createUser('reissue');
    const admin = await createUser('admin4');

    const firstToken = await createWalletRegistrationLink(user.id, admin.id);
    const secondToken = await createWalletRegistrationLink(user.id, admin.id);

    expect(firstToken).not.toBe(secondToken);
    const firstValidated = await validateWalletRegistrationLink(firstToken);
    expect(firstValidated.status).toBe('revoked');
    const secondValidated = await validateWalletRegistrationLink(secondToken);
    expect(secondValidated.status).toBe('active');

    const status = await getWalletRegistrationLinkStatus(user.id);
    expect(status.status).toBe('active');
  });

  it('失効させると新規発行なしでrevokedになる', async () => {
    const user = await createUser('revoke');
    const admin = await createUser('admin5');
    const token = await createWalletRegistrationLink(user.id, admin.id);

    await revokeWalletRegistrationLink(user.id, admin.id);

    const validated = await validateWalletRegistrationLink(token);
    expect(validated.status).toBe('revoked');
    const status = await getWalletRegistrationLinkStatus(user.id);
    expect(status.status).toBe('revoked');
  });

  it('activeなリンクが無い状態での失効は何もしない(エラーにならない)', async () => {
    const user = await createUser('revoke-noop');
    const admin = await createUser('admin6');

    await expect(revokeWalletRegistrationLink(user.id, admin.id)).resolves.toBeUndefined();
  });

  it('未発行の場合はステータスnoneを返す', async () => {
    const user = await createUser('none');
    const status = await getWalletRegistrationLinkStatus(user.id);
    expect(status.status).toBe('none');
    expect(status.expiresAt).toBeNull();
  });
});
