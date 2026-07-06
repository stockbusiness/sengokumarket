import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getStoredReferralCode } from '../lib/referral';

// このカートは一般公開せず、代理店が配布する紹介URL経由でのみ利用する運用のため、
// 紹介URLを踏んでいない・ログインもしていないブラウザは案内ページへ誘導する(仕様書外の拡張)。
export default function RequireReferralAccess({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <p>読み込み中です...</p>;
  if (user) return <>{children}</>;

  // captureReferralFromSearchのuseEffectが未実行の初回描画でも、URL上のref自体で即時判定する。
  const hasQueryRef = new URLSearchParams(location.search).get('ref');
  if (hasQueryRef || getStoredReferralCode()) return <>{children}</>;

  return <Navigate to="/invite-only" replace />;
}
