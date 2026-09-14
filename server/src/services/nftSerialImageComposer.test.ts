import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { composeNftSerialImage } from './nftSerialImageComposer';
import type { NftSerialOverlayConfig } from './nftSerialOverlay';

const BASE_CONFIG: NftSerialOverlayConfig = {
  enabled: true,
  boxXPct: 20,
  boxYPct: 60,
  boxWidthPct: 60,
  boxHeightPct: 20,
  textColor: '#e7c27a',
  textTemplate: 'INF-{serial}',
  serialDigits: 6,
};

// テスト用のベース画像(単色の200x100 PNG)を生成する。
function buildTestBaseImagePng(width = 200, height = 100): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101010';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('composeNftSerialImage(仕様書外の拡張)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ベース画像を取得し、シリアル番号を焼き込んだPNGを返す', async () => {
    const basePng = buildTestBaseImagePng();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => basePng.buffer.slice(basePng.byteOffset, basePng.byteOffset + basePng.byteLength) }));

    const result = await composeNftSerialImage('https://example.com/base.png', 4821, BASE_CONFIG);

    expect(result.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    const canvas = createCanvas(1, 1);
    // 出力画像自体を再度読み込めることを確認する(壊れたPNGではないこと)。
    const { loadImage } = await import('@napi-rs/canvas');
    const reloaded = await loadImage(result);
    expect(reloaded.width).toBe(200);
    expect(reloaded.height).toBe(100);
    void canvas;
  });

  it('ベース画像の取得に失敗した場合はエラーを投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(composeNftSerialImage('https://example.com/missing.png', 1, BASE_CONFIG)).rejects.toThrow(/404/);
  });

  it('長いテンプレート・桁数でボックス幅をはみ出す場合でも例外を投げずに処理を完了する(自動縮小)', async () => {
    const basePng = buildTestBaseImagePng();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => basePng.buffer.slice(basePng.byteOffset, basePng.byteOffset + basePng.byteLength) }));

    const narrowConfig: NftSerialOverlayConfig = { ...BASE_CONFIG, boxWidthPct: 15, serialDigits: 12, textTemplate: 'MEMBER-NO-{serial}' };
    const result = await composeNftSerialImage('https://example.com/base.png', 999, narrowConfig);
    expect(result.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });
});
