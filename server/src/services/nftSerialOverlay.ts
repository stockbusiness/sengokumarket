// 仕様書外の拡張: NFTシリアル番号の画像焼き込み設定(Product.nftSerialOverlay)。
// 「番号欄を空欄にしたベース画像」の上に、発行するNftIssueごとのシリアル番号を
// 合成して1枚ずつの画像を作るための設定値。

export interface NftSerialOverlayConfig {
  enabled: boolean;
  // シリアル番号を配置する矩形。画像の幅・高さに対する割合(0〜100)で指定する
  // (ベース画像の解像度によらず同じ設定を使い回せるようにするため)。
  boxXPct: number;
  boxYPct: number;
  boxWidthPct: number;
  boxHeightPct: number;
  // 文字色(例: "#e7c27a")。
  textColor: string;
  // 表示文字列のテンプレート。"{serial}"の部分がゼロ埋めしたシリアル番号に置き換わる
  // (例: "INF-{serial}" + serialDigits=6 + serialNumber=4821 → "INF-004821")。
  textTemplate: string;
  // ゼロ埋めする桁数。
  serialDigits: number;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function formatSerialOverlayText(config: NftSerialOverlayConfig, serialNumber: number): string {
  const padded = String(serialNumber).padStart(config.serialDigits, '0');
  return config.textTemplate.replace('{serial}', padded);
}

// 管理API(保存時)・DBから読み出したJSON(発行時)の両方でこの関数を通し、
// 不正・破損した設定のまま画像合成処理に渡さないようにする。
export function validateNftSerialOverlayConfig(value: unknown): { ok: true; config: NftSerialOverlayConfig } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: false, error: '設定が空です' };
  }
  if (typeof value !== 'object') {
    return { ok: false, error: '設定の形式が不正です' };
  }
  const v = value as Record<string, unknown>;

  if (typeof v.enabled !== 'boolean') return { ok: false, error: 'enabledはtrue/falseで指定してください' };

  const pctFields: (keyof NftSerialOverlayConfig)[] = ['boxXPct', 'boxYPct', 'boxWidthPct', 'boxHeightPct'];
  for (const key of pctFields) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: `${key}は0〜100の数値で指定してください` };
    }
  }
  const boxXPct = v.boxXPct as number;
  const boxYPct = v.boxYPct as number;
  const boxWidthPct = v.boxWidthPct as number;
  const boxHeightPct = v.boxHeightPct as number;
  if (boxWidthPct <= 0 || boxHeightPct <= 0) {
    return { ok: false, error: 'boxWidthPct・boxHeightPctは0より大きい値を指定してください' };
  }
  if (boxXPct + boxWidthPct > 100 || boxYPct + boxHeightPct > 100) {
    return { ok: false, error: '矩形が画像の範囲を超えています' };
  }

  if (typeof v.textColor !== 'string' || !HEX_COLOR_PATTERN.test(v.textColor)) {
    return { ok: false, error: 'textColorは#rrggbb形式で指定してください' };
  }

  if (typeof v.textTemplate !== 'string' || !v.textTemplate.includes('{serial}')) {
    return { ok: false, error: 'textTemplateには{serial}を含めてください' };
  }

  if (typeof v.serialDigits !== 'number' || !Number.isInteger(v.serialDigits) || v.serialDigits < 1 || v.serialDigits > 12) {
    return { ok: false, error: 'serialDigitsは1〜12の整数で指定してください' };
  }

  return {
    ok: true,
    config: {
      enabled: v.enabled,
      boxXPct,
      boxYPct,
      boxWidthPct,
      boxHeightPct,
      textColor: v.textColor,
      textTemplate: v.textTemplate,
      serialDigits: v.serialDigits,
    },
  };
}
