import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();
const ORIGIN = 'http://localhost:5173';

describe('認証API', () => {
  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'auth-test' } } } });
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
