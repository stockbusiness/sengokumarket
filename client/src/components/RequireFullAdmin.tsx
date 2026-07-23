import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { canAccessFullAdmin } from '../app/permissions';

// 仕様書外の拡張: スタッフ(staff)アカウントが利用できない管理画面(RequireAdminの内側で使う)。
// URLを直接叩かれた場合に備え、ナビゲーションの非表示と合わせてサーバー側の制限を画面側でも再現する。
// RequireAdminの内側でのみ使う前提のため、到達する時点でroleは既にadmin/admin_viewer/staffの
// いずれかに絞られている(=!canAccessFullAdminはstaffと同義)。
export default function RequireFullAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  if (user && !canAccessFullAdmin(user.role)) return <Navigate to="/admin" replace />;

  return <>{children}</>;
}
