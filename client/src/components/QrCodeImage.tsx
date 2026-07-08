import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// 仕様書外の拡張: 紹介URLをスマホカメラで直接読み取れるよう、QRコード画像を生成して表示する。
export default function QrCodeImage({ value, size = 160 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) return null;
  return <img src={dataUrl} alt="紹介URLのQRコード" width={size} height={size} className="qr-code-image" />;
}
