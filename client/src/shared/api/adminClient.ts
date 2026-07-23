import { ApiError } from '../../lib/api';

export async function adminFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/admin${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

export async function adminSend<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

// 画像アップロード等、multipart/form-dataで送る必要がある場合に使う(adminSendはJSON専用のため)。
export async function adminSendForm<T>(path: string, formData: FormData, errorMessage = 'アップロードに失敗しました'): Promise<T> {
  const res = await fetch(`/api/admin${path}`, { method: 'POST', body: formData });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `${errorMessage}(${res.status})`);
  }
  return body;
}
