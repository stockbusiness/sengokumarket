import crypto from 'crypto';

export interface FetchWithTimeoutOptions {
  timeoutMs?: number;
  correlationId?: string;
}

const DEFAULT_TIMEOUT_MS = 10000;

// 秘密情報(APIキー・署名等)をログへ出さないため、ログ出力前にマスクするヘッダ名
// (指示書10.3「秘密情報をログへ出さない」)。
const SENSITIVE_HEADER_NAMES = new Set(['x-api-key', 'authorization', 'x-ove-signature', 'x-ove-key-id', 'x-signature']);

function maskHeadersForLog(headers: RequestInit['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers as Record<string, string>);
  for (const [key, value] of entries) {
    result[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '***' : value;
  }
  return result;
}

// 外部連携共通のエラー(指示書10.3「エラー形式を統一」)。ネットワーク断・タイムアウト等の
// 通信レベルの失敗のみをここで正規化する。HTTPステータスに基づく成否判定(res.ok)と、
// そのレスポンス本文の解釈は既存どおり各Adapterの呼び出し元に委ねる(挙動を変えないため)。
export class IntegrationTransportError extends Error {
  readonly retryable: boolean;
  readonly correlationId: string;

  constructor(message: string, options: { retryable: boolean; correlationId: string; cause?: unknown }) {
    super(message);
    this.name = 'IntegrationTransportError';
    this.retryable = options.retryable;
    this.correlationId = options.correlationId;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// 外部API呼び出し共通の薄いAdapter(指示書10.2)。timeout・correlation ID・構造化ログ・
// 秘密情報マスキングをここに集約する。レスポンス自体(res.ok・本文)はそのまま呼び出し元へ
// 返すため、各Adapter固有のエラーメッセージ組み立てロジックは変更せずに済む。
export async function fetchWithTimeout(url: string, init: RequestInit = {}, options: FetchWithTimeoutOptions = {}): Promise<Response> {
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const method = init.method ?? 'GET';
  const startedAt = Date.now();

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    console.log(
      JSON.stringify({
        scope: 'integration_http',
        correlationId,
        method,
        url,
        status: res.status,
        durationMs: Date.now() - startedAt,
        requestHeaders: maskHeadersForLog(init.headers),
      }),
    );
    return res;
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    console.error(
      JSON.stringify({
        scope: 'integration_http',
        correlationId,
        method,
        url,
        error: aborted ? 'timeout' : 'network_error',
        durationMs: Date.now() - startedAt,
        requestHeaders: maskHeadersForLog(init.headers),
      }),
    );
    throw new IntegrationTransportError(
      aborted ? `リクエストがタイムアウトしました(${timeoutMs}ms)` : '外部APIへの接続に失敗しました',
      { retryable: true, correlationId, cause: e },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
