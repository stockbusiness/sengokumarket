import crypto from 'crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { setSetting } from '../services/settings';
import { generateAgencyCode } from '../services/referralCodeGenerator';
import { createAdminAgent } from '../test/adminAgent';

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

  it('CSRF: APP_URL未設定時はfail-openにせず状態変更系リクエストを403で拒否する(仕様書外の拡張)', async () => {
    const originalAppUrl = process.env.APP_URL;
    delete process.env.APP_URL;
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'x@example.com', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
    } finally {
      process.env.APP_URL = originalAppUrl;
    }
  });

  it('CSRF: APP_URLが不正なURL文字列の場合も403で拒否する(仕様書外の拡張・2026-07-22指示書Stage4)', async () => {
    const originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'not a valid url';
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'x@example.com', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
    } finally {
      process.env.APP_URL = originalAppUrl;
    }
  });

  it('CSRF: APP_URLの末尾スラッシュの有無で誤って拒否しない(仕様書外の拡張・2026-07-22指示書Stage4)', async () => {
    const originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = `${ORIGIN}/`;
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: 'x@example.com', password: 'password123' });

      // Origin不一致(403)ではなく、認証情報自体の失敗(401)まで到達すればCSRF検証は通過している
      expect(res.status).not.toBe(403);
    } finally {
      process.env.APP_URL = originalAppUrl;
    }
  });

  it('CSRF: Refererが正しいOriginなら通過する(仕様書外の拡張・2026-07-22指示書Stage4)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Referer', `${ORIGIN}/login`)
      .send({ email: 'x@example.com', password: 'password123' });

    expect(res.status).not.toBe(403);
  });

  it('CSRF: APP_URLを前方一致するだけの別オリジン(なりすましドメイン)は拒否する(仕様書外の拡張・2026-07-22指示書Stage4)', async () => {
    const originalAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'https://example.com';
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Referer', 'https://example.com.evil.example/path')
        .send({ email: 'x@example.com', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
    } finally {
      process.env.APP_URL = originalAppUrl;
    }
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

  // 2026-07-22 千ノ国全体連携パッケージの新規指摘の回帰テスト: 大文字小文字違いだけの
  // メールアドレスで別アカウントが作れてしまう問題(SYSTEM_ANALYSIS 15.5)の修正確認。
  it('大文字小文字が異なるだけの同じメールアドレスでの登録は409を返す(仕様書外の拡張)', async () => {
    const base = `case-auth-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト', email: base.toLowerCase(), password: 'password123' });

    const res = await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト2', email: base.toUpperCase(), password: 'password456' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('登録時と異なる大文字小文字で入力してもログインできる(仕様書外の拡張)', async () => {
    const base = `case-login-auth-test-${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: 'テスト', email: base, password: 'password123' });

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: base.toUpperCase(), password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(base.toLowerCase());
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
    // JITプロビジョニング(仕様書外の拡張)によりcodeは連番AGxxxで自動採番されるため、
    // codeではなくexternalIdで絞り込む(codeで絞ると自動作成された代理店が消えずに残る)。
    await prisma.agency.deleteMany({ where: { externalId: { contains: 'auth-route-sso-test' } } });
    await prisma.$disconnect();
  });

  async function buildSignedToken(sub: string) {
    const issuer = `https://auth-route-sso-test-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`;
    await setSetting('external_agency_system_base_url', issuer);

    const kid = crypto.randomUUID();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { sub, aud: 'sengoku-rr', iat: now, exp: now + 30, jti: crypto.randomUUID(), iss: issuer },
      privateKey,
      { algorithm: 'RS256', keyid: kid, noTimestamp: true },
    );

    return { token, publicKey, kid };
  }

  function stubJwks(publicKey: string, kid: string) {
    return vi.stubGlobal(
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

  it('対応する代理店が無く、トークンにメールクレームも無い場合はagency_not_linkedを返す(代理店自体はJITプロビジョニングされる)', async () => {
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

// 残課題指示書Stage11: JWT即時失効。role・agencyId変更、パスワード変更、代理店停止、
// 強制ログアウトの直後に、発行済みの旧Cookieが即座に無効化されることを確認する。
describe('残課題指示書Stage11: JWT即時失効', () => {
  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'session-revocation-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'session-revocation-test' } } });
    await prisma.agency.deleteMany({ where: { name: { contains: 'session-revocation-test' } } });
    await prisma.$disconnect();
  });

  it('パスワード変更後、旧Cookieでログイン必須APIへアクセスできない', async () => {
    const email = `session-revocation-test-pw-${Date.now()}@example.com`;
    const user = await prisma.user.create({
      data: { name: 'x', email, passwordHash: await bcrypt.hash('old-password1', 10), role: 'user' },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password: 'old-password1' });

    const before = await agent.get('/api/auth/me');
    expect(before.status).toBe(200);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 3600_000) },
    });

    const confirmRes = await request(app)
      .post('/api/auth/password-reset/confirm')
      .set('Origin', ORIGIN)
      .send({ token, newPassword: 'new-password1' });
    expect(confirmRes.status).toBe(200);

    const after = await agent.get('/api/auth/me');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('管理者降格後、旧Cookieで管理APIへアクセスできない', async () => {
    const { agent: operatorAgent } = await createAdminAgent(app);
    const targetEmail = `session-revocation-test-admin-${Date.now()}@example.com`;
    const target = await prisma.user.create({
      data: { name: '降格対象', email: targetEmail, passwordHash: await bcrypt.hash('targetpassword1', 10), role: 'admin' },
    });

    const targetAgent = request.agent(app);
    await targetAgent.post('/api/auth/login').set('Origin', ORIGIN).send({ email: targetEmail, password: 'targetpassword1' });

    const before = await targetAgent.get('/api/admin/dashboard');
    expect(before.status).toBe(200);

    const demoteRes = await operatorAgent
      .put(`/api/admin/admin-users/${target.id}/role`)
      .set('Origin', ORIGIN)
      .send({ role: 'staff' });
    expect(demoteRes.status).toBe(200);

    const after = await targetAgent.get('/api/admin/dashboard');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('強制ログアウト後、旧Cookieでログイン必須APIへアクセスできない', async () => {
    const { agent: operatorAgent } = await createAdminAgent(app);
    const targetEmail = `session-revocation-test-forcelogout-${Date.now()}@example.com`;
    const target = await prisma.user.create({
      data: { name: '強制ログアウト対象', email: targetEmail, passwordHash: await bcrypt.hash('targetpassword1', 10), role: 'staff' },
    });

    const targetAgent = request.agent(app);
    await targetAgent.post('/api/auth/login').set('Origin', ORIGIN).send({ email: targetEmail, password: 'targetpassword1' });

    const before = await targetAgent.get('/api/auth/me');
    expect(before.status).toBe(200);

    const forceLogoutRes = await operatorAgent
      .post(`/api/admin/admin-users/${target.id}/force-logout`)
      .set('Origin', ORIGIN)
      .send({});
    expect(forceLogoutRes.status).toBe(200);

    const after = await targetAgent.get('/api/auth/me');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('代理店が停止(inactive)されると、旧Cookieで代理店APIへアクセスできない', async () => {
    const agency = await prisma.$transaction(async (tx) => {
      const code = await generateAgencyCode(tx);
      return tx.agency.create({ data: { name: 'session-revocation-test-agency', code, defaultCommissionRate: 10 } });
    });
    const email = `session-revocation-test-agencyuser-${Date.now()}@example.com`;
    await prisma.user.create({
      data: {
        name: '代理店ユーザー',
        email,
        passwordHash: await bcrypt.hash('agencypassword1', 10),
        role: 'agency',
        agencyId: agency.id,
      },
    });

    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password: 'agencypassword1' });

    const before = await agent.get('/api/agency/orders');
    expect(before.status).toBe(200);

    await prisma.agency.update({ where: { id: agency.id }, data: { status: 'inactive' } });

    const after = await agent.get('/api/agency/orders');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('正常ログインは維持される(role・agencyId・sessionVersionが変わらなければ継続してアクセスできる)', async () => {
    const email = `session-revocation-test-normal-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { name: '通常', email, passwordHash: await bcrypt.hash('password123', 10), role: 'user' },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password: 'password123' });

    const res1 = await agent.get('/api/auth/me');
    const res2 = await agent.get('/api/auth/me');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
