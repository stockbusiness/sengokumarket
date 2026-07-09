import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  agencyId: string | null;
  agencyApplicationSubmittedAt: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, phone?: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  loginWithAgencySso: (token: string) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function parseJsonOrThrow(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

// 仕様書外の拡張(先方仕様書v3.6.45): 代理店システムからのSSOログイン失敗時、
// /login?error=<code> のリダイレクトに使うエラーコードをそのまま保持する。
export class AgencySsoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (!res.ok) {
        setUser(null);
        return;
      }
      const body = await res.json();
      setUser(body.user);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await parseJsonOrThrow(res);
    setUser(body.user);
  }, []);

  const register = useCallback(async (name: string, email: string, password: string, phone?: string) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone }),
    });
    const body = await parseJsonOrThrow(res);
    setUser(body.user);
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const loginWithAgencySso = useCallback(async (token: string) => {
    const res = await fetch('/api/auth/agency-sso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new AgencySsoError(body?.error?.code ?? 'sso_invalid', body?.error?.message ?? 'ログインに失敗しました');
    }
    setUser(body.user);
    return (body.returnTo as string | null) ?? null;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refresh, loginWithAgencySso }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
