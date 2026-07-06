// requireReferralOrAuthミドルウェアを満たすための、テスト用の紹介Cookie値を組み立てる。
// 実際のクライアント(client/src/lib/referral.ts)が保存する形式と揃えること。
export function referralCookieHeader(code = 'TEST-REF'): string {
  const payload = {
    referral_code: code,
    source: 'url',
    saved_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  return `sengoku_referral=${encodeURIComponent(JSON.stringify(payload))}`;
}
