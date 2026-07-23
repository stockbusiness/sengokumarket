import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { canAccessAdmin } from '../app/permissions';

export default function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <p>読み込み中です...</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (!canAccessAdmin(user.role)) return <Navigate to="/products" replace />;

  return <>{children}</>;
}
