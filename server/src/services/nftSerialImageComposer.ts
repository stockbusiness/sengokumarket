import { put } from '@vercel/blob';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { HttpError } from '../lib/httpError';
import { CINZEL_BOLD_TTF_BASE64 } from '../assets/cinzelBoldFont';
import { formatSerialOverlayText, type NftSerialOverlayConfig } from './nftSerialOverlay';

const SERIAL_OVERLAY_FONT_FAMILY = 'SengokuNftSerialOverlay';
// ベース画像側の実測値(1400〜1500px前後)に合わせて決めた、フォントサイズに対する
// 目安の比率(仕様書外の拡張)。box高さの何割を文字の実際の高さに使うか。
const FONT_SIZE_TO_BOX_HEIGHT_RATIO = 0.6;
const LETTER_SPACING_TO_FONT_SIZE_RATIO = 0.08;
// 文字がboxWidthPctをはみ出す場合、この割合までフォントサイズを縮めて収める。
const MAX_TEXT_WIDTH_TO_BOX_WIDTH_RATIO = 0.94;
const FETCH_TIMEOUT_MS = 15000;

let fontRegistered = false;
function ensureFontRegistered(): void {
  if (fontRegistered) return;
  // システムにインストールされたフォントに依存すると、Vercelのサーバーレス実行環境で
  // フォントが見つからず文字化け・表示崩れが起きうるため、ビルド成果物に埋め込んだ
  // フォントデータ(base64)を実行時に登録して使う(仕様書外の拡張)。
  GlobalFonts.register(Buffer.from(CINZEL_BOLD_TTF_BASE64, 'base64'), SERIAL_OVERLAY_FONT_FAMILY);
  fontRegistered = true;
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ベース画像の取得に失敗しました(HTTPステータス: ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ベース画像(番号欄を空欄にしたもの)へシリアル番号を合成したPNG画像を生成する。
// 発行(Mint)のたびにNftIssue固有の1枚を作るため、この関数の呼び出し元がBlob等へ
// アップロードしてNFTのimage URLとして使う。
export async function composeNftSerialImage(
  baseImageUrl: string,
  serialNumber: number,
  config: NftSerialOverlayConfig,
): Promise<Buffer> {
  ensureFontRegistered();

  const baseBuffer = await fetchImageBuffer(baseImageUrl);
  const image = await loadImage(baseBuffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, image.width, image.height);

  const boxX = (config.boxXPct / 100) * image.width;
  const boxY = (config.boxYPct / 100) * image.height;
  const boxWidth = (config.boxWidthPct / 100) * image.width;
  const boxHeight = (config.boxHeightPct / 100) * image.height;

  const text = formatSerialOverlayText(config, serialNumber);

  let fontSize = boxHeight * FONT_SIZE_TO_BOX_HEIGHT_RATIO;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = config.textColor;

  // 桁数・テンプレート文言によっては横幅がboxWidthPctに収まらないことがあるため、
  // 収まるまでフォントサイズを段階的に縮める(縦横比を保ったまま)。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ctx.font = `bold ${fontSize}px ${SERIAL_OVERLAY_FONT_FAMILY}`;
    ctx.letterSpacing = `${fontSize * LETTER_SPACING_TO_FONT_SIZE_RATIO}px`;
    const measuredWidth = ctx.measureText(text).width;
    if (measuredWidth <= boxWidth * MAX_TEXT_WIDTH_TO_BOX_WIDTH_RATIO || fontSize < 4) break;
    fontSize *= 0.92;
  }

  ctx.fillText(text, boxX + boxWidth / 2, boxY + boxHeight / 2);

  return canvas.toBuffer('image/png');
}

// 合成済み画像を既存の商品画像アップロードと同じVercel Blobストレージへ保存する
// (nftMetadata.tsのuploadNftMetadataと同じ方針。IPFS等の新規導入は行わない)。
export async function uploadComposedNftSerialImage(nftIssueId: string, imageBuffer: Buffer): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new HttpError(503, 'BLOB_NOT_CONFIGURED', '画像保存機能が未設定です');
  }
  const blob = await put(`nft-images/${nftIssueId}.png`, imageBuffer, {
    access: 'public',
    contentType: 'image/png',
  });
  return blob.url;
}
