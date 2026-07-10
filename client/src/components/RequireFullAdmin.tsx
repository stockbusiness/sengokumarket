import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// 仕様書外の拡張: スタッフ(staff)アカウントが利用できない管理画面(RequireAdminの内側で使う)。
// URLを直接叩かれた場合に備え、ナビゲーションの非表示と合わせてサーバー側の制限を画面側でも再現する。
export default function RequireFullAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  if (user?.role === 'staff') return <Navigate to="/admin" replace />;

  return <>{children}</>;
}
