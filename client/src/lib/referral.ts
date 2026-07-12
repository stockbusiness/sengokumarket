const STORAGE_KEY = 'sengoku_referral';
const TTL_DAYS = 30;

export function captureReferralFromSearch(search: string) {
  const ref = new URLSearchParams(search).get('ref');
  if (!ref) return;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);
  const payload = {
    referral_code: ref,
    source: 'url',
    saved_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  document.cookie = `${STORAGE_KEY}=${encodeURIComponent(JSON.stringify(payload))}; expires=${expiresAt.toUTCString()}; path=/`;
}

export function getStoredReferralCode(): string | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { referral_code: string; expires_at: string };
    if (new Date(parsed.expires_at).getTime() < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.referral_code;
  } catch {
    return null;
  }
}

// Reactは子コンポーネントのエフェクトを親(App)より先に実行するため、App側の
// captureReferralFromSearchがCookie/localStorageへ書き込む前に、子ページの初回データ取得が
// 先に走ることがある。そのため、まだ何も保存されていない初回描画でもURLのref自体を
// 直接見て判定できるようにする(仕様書外の拡張)。
export function getEffectiveReferralCode(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('ref');
  return fromQuery || getStoredReferralCode();
}
