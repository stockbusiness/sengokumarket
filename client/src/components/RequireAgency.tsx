import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { canAccessAgencyPortal } from '../app/permissions';

export default function RequireAgency({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <p>読み込み中です...</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (!canAccessAgencyPortal(user.role)) return <Navigate to="/products" replace />;

  return <>{children}</>;
}
