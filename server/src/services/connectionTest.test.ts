import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { testOveWalletEventsConnection } from './connectionTest';

// 仕様書外の拡張: OVEウォレットの会員証送信API(POST /api/integrations/events)には
// 読み取り専用の疎通確認手段が無く、呼ぶたびに実際の会員証付与・取消として処理されるため、
// このテストでは「実際のentitlement.granted/revokedを送信せず、署名生成とネットワーク
// 到達性のみを確認する」という設計どおりに動作することを検証する。
describe('testOveWalletEventsConnection(仕様書外の拡張)', () => {
  beforeEach(async () => {
    await prisma.setting.deleteMany({
      where: { key: { in: ['ove_wallet_base_url', 'ove_wallet_events_key_id', 'ove_wallet_events_hmac_secret'] } },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await prisma.setting.deleteMany({
      where: { key: { in: ['ove_wallet_base_url', 'ove_wallet_events_key_id', 'ove_wallet_events_hmac_secret'] } },
    });
  });

  it('URL未入力はエラーメッセージを返す', async () => {
    const result = await testOveWalletEventsConnection(undefined, 'key', 'secret');
    expect(result).toEqual({ ok: false, message: '接続先URLが未入力です' });
  });

  it('Key ID未入力はエラーメッセージを返す', async () => {
    const result = await testOveWalletEventsConnection('https://ove-wallet.example.com', undefined, 'secret');
    expect(result).toEqual({ ok: false, message: 'Key IDが未入力です' });
  });

  it('HMAC Secret未入力はエラーメッセージを返す', async () => {
    const result = await testOveWalletEventsConnection('https://ove-wallet.example.com', 'key', undefined);
    expect(result).toEqual({ ok: false, message: 'HMAC Secretが未入力です' });
  });

  it('保存済みの値をフォールバックとして使う', async () => {
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');
    await setSetting('ove_wallet_events_key_id', 'saved-key');
    await setSetting('ove_wallet_events_hmac_secret', 'saved-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));

    const result = await testOveWalletEventsConnection();
    expect(result.ok).toBe(true);
  });

  it('到達できた場合、実際のentitlement.granted等は送信していない旨を含めて成功を返す(HTTPステータスが2xx以外でも到達できていればok)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testOveWalletEventsConnection('https://ove-wallet.example.com', 'key', 'secret');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('404');
    expect(result.message).toContain('送信していません');

    // 実際のentitlementイベント送信(POST /api/integrations/events)は行わず、
    // ベースURLへの単純なGETのみで到達性を確認していることを確認する。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ove-wallet.example.com');
    expect(options.method).toBe('GET');
  });

  it('末尾スラッシュは取り除いてから接続する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await testOveWalletEventsConnection('https://ove-wallet.example.com/', 'key', 'secret');
    expect(fetchMock.mock.calls[0][0]).toBe('https://ove-wallet.example.com');
  });

  it('ネットワークエラー時は失敗を返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    const result = await testOveWalletEventsConnection('https://ove-wallet.example.com', 'key', 'secret');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('network down');
  });
});
