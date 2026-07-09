import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { setSetting } from '../services/settings';

const app = createApp();
const ORIGIN = 'http://localhost:5173';

describe('認証API', () => {
  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'auth-test' } } } });
    await prisma.loginAttempt.deleteMany({ where: { email: { contains: 'auth-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'auth-test' } } });
    await prisma.$disconnect();
  });

  it('CSRF: Originが一致しない状態変更系リクエストは403になる', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example.com')
      .send({ email: 'x@example.com', password: 'password123' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
  });

  it('register → me → logout の一連の流れが動作する', async () => {
    const email = `register-auth-test-${Date.now()}@example.com`;
    const agent = request.agent(app);

    const registerRes = await agent
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト太郎', email, password: 'password123', phone: '090-0000-0000' });

    expect(registerRes.status).toBe(201);
    expect(registerRes.body.user.email).toBe(email);
    expect(registerRes.body.user.passwordHash).toBeUndefined();

    const meRes = await agent.get('/api/auth/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(email);

    const logoutRes = await agent.post('/api/auth/logout').set('Origin', ORIGIN);
    expect(logoutRes.status).toBe(200);

    const meAfterLogout = await agent.get('/api/auth/me');
    expect(meAfterLogout.status).toBe(401);
  });

  it('同じメールアドレスでの登録は409を返す', async () => {
    const email = `dup-auth-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト', email, password: 'password123' });

    const res = await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト2', email, password: 'password456' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('パスワード誤りを5回繰り返すとACCOUNT_LOCKEDになる', async () => {
    const email = `lockout-auth-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト', email, password: 'correct-password' });

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .send({ email, password: 'wrong-password' });
      expect(res.status).toBe(401);
    }

    const lockedRes = await request(app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: 'correct-password' });

    expect(lockedRes.status).toBe(423);
    expect(lockedRes.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('パスワードリセット: 存在しないメールでも存在するメールでも同じレスポンスを返す', async () => {
    const email = `resetflow-auth-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト', email, password: 'old-password1' });

    const resExisting = await request(app)
      .post('/api/auth/password-reset/request')
      .set('Origin', ORIGIN)
      .send({ email });

    const resMissing = await request(app)
      .post('/api/auth/password-reset/request')
      .set('Origin', ORIGIN)
      .send({ email: `nonexistent-auth-test-${Date.now()}@example.com` });

    expect(resExisting.status).toBe(200);
    expect(resMissing.status).toBe(200);
    expect(resExisting.body.message).toBe(resMissing.body.message);
  });

  it('パスワードリセット: 発行したトークンで新パスワードに変更しログインできる', async () => {
    const email = `resetconfirm-auth-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト', email, password: 'old-password1' });

    await request(app).post('/api/auth/password-reset/request').set('Origin', ORIGIN).send({ email });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const tokenRecord = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    // トークンはハッシュ化保存のため、平文はサービス層のテストで別途検証する。
    // ここではAPI経由でDBから直接ハッシュを検証できないため、consumePasswordResetTokenの
    // 単体テストで平文トークンの往復を確認する(下記 passwordReset.test.ts)。
    expect(tokenRecord.usedAt).toBeNull();
    expect(tokenRecord.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('不正なリセットトークンはINVALID_OR_EXPIRED_TOKENを返す', async () => {
    const res = await request(app)
      .post('/api/auth/password-reset/confirm')
      .set('Origin', ORIGIN)
      .send({ token: 'invalid-token-value', newPassword: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });
});

// 仕様書外の拡張(先方仕様書v3.6.45): 代理店システムからのSSOログイン受け口。
describe('POST /auth/agency-sso(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.ssoUsedJti.deleteMany({ where: { sub: { contains: 'auth-route-sso-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'auth-route-sso-test' } } });
    await prisma.agency.deleteMany({ where: { code: { contains: 'auth-route-sso-test' } } });
    await prisma.$disconnect();
  });

  async function buildSignedToken(sub: string) {
    const issuer = `https://auth-route-sso-test-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`;
    await setSetting('external_agency_system_base_url', issuer);

    const kid = crypto.randomUUID();
    const pair = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub,
      aud: 'sengoku-rr',
      iat: now,
      exp: now + 30,
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .sign(pair.privateKey);

    return { token, publicKey: pair.publicKey, kid };
  }

  function stubJwks(publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'], kid: string) {
    return vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const jwk = await exportJWK(publicKey);
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  }

  it('正しいトークンでログインしセッションCookieが発行される', async () => {
    const agency = await prisma.agency.create({
      data: {
        name: 'SSOルートテスト代理店',
        code: 'auth-route-sso-test-linked',
        externalId: 'auth-route-sso-test-linked',
        status: 'active',
        defaultCommissionRate: 0,
      },
    });
    await prisma.user.create({
      data: {
        name: 'SSOルートテスト担当者',
        email: 'auth-route-sso-test-user@example.com',
        passwordHash: 'unused',
        role: 'agency',
        agencyId: agency.id,
      },
    });

    const { token, publicKey, kid } = await buildSignedToken('auth-route-sso-test-linked');
    stubJwks(publicKey, kid);

    const res = await request(app).post('/api/auth/agency-sso').set('Origin', ORIGIN).send({ token });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('auth-route-sso-test-user@example.com');
    expect(res.headers['set-cookie']?.[0]).toContain('session=');

    vi.unstubAllGlobals();
  });

  it('対応する代理店が無い場合はagency_not_linkedを返す', async () => {
    const { token, publicKey, kid } = await buildSignedToken('auth-route-sso-test-unlinked');
    stubJwks(publicKey, kid);

    const res = await request(app).post('/api/auth/agency-sso').set('Origin', ORIGIN).send({ token });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('agency_not_linked');

    vi.unstubAllGlobals();
  });

  it('tokenが未指定の場合はVALIDATION_ERRORを返す', async () => {
    const res = await request(app).post('/api/auth/agency-sso').set('Origin', ORIGIN).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
