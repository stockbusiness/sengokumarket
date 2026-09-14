import { describe, expect, it } from 'vitest';
import { formatSerialOverlayText, validateNftSerialOverlayConfig } from './nftSerialOverlay';

const VALID_CONFIG = {
  enabled: true,
  boxXPct: 30,
  boxYPct: 70,
  boxWidthPct: 40,
  boxHeightPct: 10,
  textColor: '#e7c27a',
  textTemplate: 'INF-{serial}',
  serialDigits: 6,
};

describe('validateNftSerialOverlayConfig(仕様書外の拡張)', () => {
  it('正しい設定は検証を通り、そのまま返る', () => {
    const result = validateNftSerialOverlayConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(VALID_CONFIG);
  });

  it('nullやundefinedはエラーになる', () => {
    expect(validateNftSerialOverlayConfig(null).ok).toBe(false);
    expect(validateNftSerialOverlayConfig(undefined).ok).toBe(false);
  });

  it('オブジェクトでない値はエラーになる', () => {
    expect(validateNftSerialOverlayConfig('文字列').ok).toBe(false);
    expect(validateNftSerialOverlayConfig(123).ok).toBe(false);
  });

  it('enabledがboolean以外はエラーになる', () => {
    const result = validateNftSerialOverlayConfig({ ...VALID_CONFIG, enabled: 'yes' });
    expect(result.ok).toBe(false);
  });

  it.each(['boxXPct', 'boxYPct', 'boxWidthPct', 'boxHeightPct'])('%sが範囲外(0未満)はエラーになる', (key) => {
    const result = validateNftSerialOverlayConfig({ ...VALID_CONFIG, [key]: -1 });
    expect(result.ok).toBe(false);
  });

  it.each(['boxXPct', 'boxYPct', 'boxWidthPct', 'boxHeightPct'])('%sが範囲外(100超)はエラーになる', (key) => {
    const result = validateNftSerialOverlayConfig({ ...VALID_CONFIG, [key]: 101 });
    expect(result.ok).toBe(false);
  });

  it('boxWidthPct・boxHeightPctが0以下はエラーになる', () => {
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, boxWidthPct: 0 }).ok).toBe(false);
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, boxHeightPct: 0 }).ok).toBe(false);
  });

  it('矩形が画像の範囲(0〜100%)を超える場合はエラーになる', () => {
    const result = validateNftSerialOverlayConfig({ ...VALID_CONFIG, boxXPct: 80, boxWidthPct: 40 });
    expect(result.ok).toBe(false);
  });

  it('textColorが#rrggbb形式でない場合はエラーになる', () => {
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, textColor: 'gold' }).ok).toBe(false);
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, textColor: '#fff' }).ok).toBe(false);
  });

  it('textTemplateに{serial}が含まれない場合はエラーになる', () => {
    const result = validateNftSerialOverlayConfig({ ...VALID_CONFIG, textTemplate: 'INF-000001' });
    expect(result.ok).toBe(false);
  });

  it('serialDigitsが1〜12の整数以外はエラーになる', () => {
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, serialDigits: 0 }).ok).toBe(false);
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, serialDigits: 13 }).ok).toBe(false);
    expect(validateNftSerialOverlayConfig({ ...VALID_CONFIG, serialDigits: 3.5 }).ok).toBe(false);
  });
});

describe('formatSerialOverlayText(仕様書外の拡張)', () => {
  it('テンプレートの{serial}をゼロ埋めしたシリアル番号に置き換える', () => {
    expect(formatSerialOverlayText(VALID_CONFIG, 4821)).toBe('INF-004821');
  });

  it('桁数を超える大きな番号はそのまま置き換わる(切り捨てない)', () => {
    expect(formatSerialOverlayText(VALID_CONFIG, 1234567)).toBe('INF-1234567');
  });

  it('serialDigitsが異なればゼロ埋め桁数も変わる', () => {
    expect(formatSerialOverlayText({ ...VALID_CONFIG, serialDigits: 3 }, 7)).toBe('INF-007');
  });
});
