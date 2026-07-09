import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { setSetting } from '../services/settings';
import { verifyAndConsumeAgencySsoToken } from './agencySso';

const AUDIENCE = 'sengoku-rr';

function generateRsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

// jwks-rsaはURL単位でJWKSをキャッシュし、未知のkidでもcooldownの間は再取得しない。
// テストごとに異なる発行者URLを使うことで、前のテストの鍵ペアが誤って再利用されるのを防ぐ。
async function buildSignedToken(overrides: Partial<Record<string, unknown>> = {}) {
  const issuer = `https://sso-test-${crypto.randomUUID()}.example.com`;
  await setSetting('external_agency_system_base_url', issuer);

  const kid = crypto.randomUUID();
  const { publicKey, privateKey } = generateRsaKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'agency-sso-test-code',
    aud: AUDIENCE,
    iat: now,
    exp: now + 30,
    jti: crypto.randomUUID(),
    iss: issuer,
    ...overrides,
  };
  const token = jwt.sign(payload, privateKey, { algorithm: 'RS256', keyid: kid, noTimestamp: true });
  return { token, publicKey, kid };
}

describe('verifyAndConsumeAgencySsoToken(仕様書外の拡張・先方仕様書v3.6.45)', () => {
  let agencyId: string;

  beforeAll(async () => {
    const agency = await prisma.agency.create({
      data: {
        name: 'SSOテスト代理店',
        code: 'agency-sso-test-code',
        externalId: 'agency-sso-test-code',
        status: 'active',
        defaultCommissionRate: 0,
      },
    });
    agencyId = agency.id;

    await prisma.user.create({
      data: {
        name: 'SSOテスト担当者',
        email: 'agency-sso-test-user@example.com',
        passwordHash: 'unused',
        role: 'agency',
        agencyId: agency.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.ssoUsedJti.deleteMany({ where: { sub: { contains: 'agency-sso-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'agency-sso-test' } } });
    await prisma.agency.deleteMany({ where: { externalId: { contains: 'agency-sso-test' } } });
    await prisma.$disconnect();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubJwks(publicKey: string, kid: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  }

  it('正しい署名・claimのトークンでログイン先ユーザーを特定する', async () => {
    const { token, publicKey, kid } = await buildSignedToken();
    stubJwks(publicKey, kid);

    const result = await verifyAndConsumeAgencySsoToken(token);
    expect(result.userId).toBeDefined();

    const user = await prisma.user.findUnique({ where: { id: result.userId } });
    expect(user?.email).toBe('agency-sso-test-user@example.com');
    expect(user?.agencyId).toBe(agencyId);
  });

  it('同じjtiのトークンを再利用するとsso_replayedになる', async () => {
    const { token, publicKey, kid } = await buildSignedToken();

    stubJwks(publicKey, kid);
    await verifyAndConsumeAgencySsoToken(token);

    stubJwks(publicKey, kid);
    await expect(verifyAndConsumeAgencySsoToken(token)).rejects.toMatchObject({ code: 'sso_replayed' });
  });

  it('期限切れトークンはsso_expiredになる', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, publicKey, kid } = await buildSignedToken({ iat: now - 120, exp: now - 60 });

    stubJwks(publicKey, kid);
    await expect(verifyAndConsumeAgencySsoToken(token)).rejects.toMatchObject({ code: 'sso_expired' });
  });

  it('audが異なるトークンはsso_invalidになる', async () => {
    const { token, publicKey, kid } = await buildSignedToken({ aud: 'other-service' });

    stubJwks(publicKey, kid);
    await expect(verifyAndConsumeAgencySsoToken(token)).rejects.toMatchObject({ code: 'sso_invalid' });
  });

  it('RR側に対応する代理店が存在しない場合はトークンのclaimから代理店・ログインアカウントを自動作成する(Google方式のJITプロビジョニング)', async () => {
    const { token, publicKey, kid } = await buildSignedToken({
      sub: 'agency-sso-test-jit-new-code',
      agency_name: 'JIT新規代理店',
      actor_email: 'agency-sso-test-jit-new@example.com',
      actor_name: 'JIT新規担当者',
    });

    stubJwks(publicKey, kid);
    const result = await verifyAndConsumeAgencySsoToken(token);

    const user = await prisma.user.findUnique({ where: { id: result.userId } });
    expect(user?.email).toBe('agency-sso-test-jit-new@example.com');
    expect(user?.role).toBe('agency');

    const agency = await prisma.agency.findUnique({ where: { externalId: 'agency-sso-test-jit-new-code' } });
    expect(agency?.name).toBe('JIT新規代理店');
    expect(agency?.id).toBe(user?.agencyId);
  });

  it('新規代理店だがトークンにメールクレームが無い場合はagency_not_linkedになる', async () => {
    const { token, publicKey, kid } = await buildSignedToken({ sub: 'agency-sso-test-jit-no-email' });

    stubJwks(publicKey, kid);
    await expect(verifyAndConsumeAgencySsoToken(token)).rejects.toMatchObject({ code: 'agency_not_linked' });
  });

  it('メールクレームが既存アカウント(役割問わず)と重複する場合は自動昇格させずagency_not_linkedになる', async () => {
    await prisma.user.create({
      data: {
        name: 'agency-sso-test 既存一般会員',
        email: 'agency-sso-test-existing-member@example.com',
        passwordHash: 'unused',
        role: 'user',
      },
    });

    const { token, publicKey, kid } = await buildSignedToken({
      sub: 'agency-sso-test-jit-collision-code',
      agency_name: 'JIT衝突代理店',
      actor_email: 'agency-sso-test-existing-member@example.com',
    });

    stubJwks(publicKey, kid);
    await expect(verifyAndConsumeAgencySsoToken(token)).rejects.toMatchObject({ code: 'agency_not_linked' });

    const user = await prisma.user.findUnique({ where: { email: 'agency-sso-test-existing-member@example.com' } });
    expect(user?.role).toBe('user');
    expect(user?.agencyId).toBeNull();
  });

  it('同一subの新規SSOトークンが同時に処理されても代理店・アカウントは1件だけ作成され、両方ログイン成功する(競合状態)', async () => {
    const issuer = `https://sso-test-${crypto.randomUUID()}.example.com`;
    await setSetting('external_agency_system_base_url', issuer);
    const kid = crypto.randomUUID();
    const { publicKey, privateKey } = generateRsaKeyPair();
    const now = Math.floor(Date.now() / 1000);
    const sub = 'agency-sso-test-jit-race-code';
    const email = 'agency-sso-test-jit-race@example.com';

    function makeToken() {
      return jwt.sign(
        {
          sub,
          aud: AUDIENCE,
          iat: now,
          exp: now + 30,
          jti: crypto.randomUUID(),
          iss: issuer,
          agency_name: 'JIT競合代理店',
          actor_email: email,
        },
        privateKey,
        { algorithm: 'RS256', keyid: kid, noTimestamp: true },
      );
    }

    stubJwks(publicKey, kid);
    const [resultA, resultB] = await Promise.all([
      verifyAndConsumeAgencySsoToken(makeToken()),
      verifyAndConsumeAgencySsoToken(makeToken()),
    ]);

    expect(resultA.userId).toBe(resultB.userId);

    const agencies = await prisma.agency.findMany({ where: { externalId: sub } });
    expect(agencies).toHaveLength(1);

    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
  });

  it('代理店が停止中の場合はagency_inactiveになる', async () => {
    const inactiveAgency = await prisma.agency.create({
      data: {
        name: 'SSOテスト停止代理店',
        code: 'agency-sso-test-inactive',
        externalId: 'agency-sso-test-inactive',
        status: 'inactive',
        defaultCommissionRate: 0,
      },
    });

    const { token, publicKey, kid } = await buildSignedToken({ sub: 'agency-sso-test-inactive' });
    stubJwks(publicKey, kid);
    await expect(verifyAndConsumeAgencySsoToken(token)).rejects.toMatchObject({ code: 'agency_inactive' });

    await prisma.agency.delete({ where: { id: inactiveAgency.id } });
  });
});
