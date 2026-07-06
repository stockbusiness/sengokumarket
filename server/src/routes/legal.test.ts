import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

const app = createApp();

describe('公開API: 法務ページ', () => {
  it('シード済みのslugを取得できる', async () => {
    const res = await request(app).get('/api/legal/terms');
    expect(res.status).toBe(200);
    expect(res.body.document.slug).toBe('terms');
    expect(typeof res.body.document.title).toBe('string');
    expect(typeof res.body.document.body).toBe('string');
  });

  it('未定義のslugは404', async () => {
    const res = await request(app).get('/api/legal/unknown');
    expect(res.status).toBe(404);
  });
});
