import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, IntegrationTransportError } from './httpClient';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功時はレスポンスをそのまま返す(res.ok・本文の解釈は呼び出し元のまま)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ hello: 'world' }) });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithTimeout('https://example.com/api');
    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toEqual({ hello: 'world' });
  });

  it('4xx/5xxはIntegrationTransportErrorに変換せず、そのままResponseとして返す(res.ok判定は既存どおり呼び出し元に委ねる)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithTimeout('https://example.com/api');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it('ネットワークエラーはIntegrationTransportError(retryable=true)に正規化される', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')),
    );

    await expect(fetchWithTimeout('https://example.com/api')).rejects.toBeInstanceOf(IntegrationTransportError);
    await expect(fetchWithTimeout('https://example.com/api')).rejects.toMatchObject({ retryable: true });
  });

  it('タイムアウト時はAbortされ、IntegrationTransportErrorとして扱われる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );

    await expect(fetchWithTimeout('https://example.com/api', {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(IntegrationTransportError);
  });
});
