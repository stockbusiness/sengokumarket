import crypto from 'crypto';
import { HttpError } from '../lib/httpError';
import { fetchWithTimeout } from '../shared/http/httpClient';
import { getSetting } from './settings';

// 仕様書外の拡張: 外部代理店システム(sengoku-ai.com)との連携(先方仕様書v3.6.40準拠)。
// 本システムが呼び出し元(クライアント)側になる。
// - 階層取得API(GET): 先方が管理する代理店階層を本システムへ反映するために取得する
// - 代理店同期API(POST): 本システム側で生まれた代理店候補(会員の代理店申請等)を先方へ送る

interface ExternalAgencyTreeNode {
  code: string;
  name: string;
  level?: number;
  role_label?: string;
  status?: string;
  contact?: { email: string | null; phone: string | null; line_url: string | null } | null;
  children?: ExternalAgencyTreeNode[];
}

export interface ExternalAgencyNode {
  code: string;
  name: string;
  status: string;
  parentCode: string | null;
  contactEmail: string | null;
}

export interface PushAgencyCandidateInput {
  externalId: string;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  loginEmail?: string | null;
  phone?: string | null;
  parentExternalId?: string | null;
}

export interface PushAgencyCandidateResult {
  external_id: string;
  status: string;
  synced: boolean;
}

// 仕様書外の拡張: 外部開発者向け連携ガイド(v3.6.78-draft)では{ok:true, ...}のフラット形式に
// 統一されているが、旧仕様(v3.6.40)の{success:true, data:{...}}形式で応答する可能性も
// 残っているため、両方を解釈できるようにする。
interface SyncResponse {
  ok?: boolean;
  success?: boolean;
  data?: Partial<PushAgencyCandidateResult>;
  error?: { code?: string; message?: string };
  message?: string;
  external_id?: string;
  status?: string;
  synced?: boolean;
}

async function getConfig(baseUrlOverride?: string, apiKeyOverride?: string): Promise<{ baseUrl: string; apiKey: string }> {
  const baseUrl = baseUrlOverride?.trim() || (await getSetting('external_agency_system_base_url'));
  const apiKey = apiKeyOverride?.trim() || (await getSetting('external_agency_system_api_key'));
  if (!baseUrl || !apiKey) {
    throw new HttpError(503, 'EXTERNAL_AGENCY_SYSTEM_NOT_CONFIGURED', '外部代理店システムの連携設定が未登録です');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

function truncateForDisplay(text: string, max = 200): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// レスポンスにはprojects(LPプロジェクト一覧)等、代理店データ以外の配列も含まれるため、
// キー名を決め打ちで探す(先方仕様書v3.6.40では tree)。将来の形式変更に備えて他の
// 一般的な名前もフォールバックとして試す。
function findAgencyTreeArray(body: Record<string, unknown>): unknown[] | null {
  for (const key of ['tree', 'data', 'agencies', 'nodes']) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

// ツリー構造(children)をたどり、parentCodeを付与しながらフラットな配列にする。
function flattenTree(nodes: ExternalAgencyTreeNode[], parentCode: string | null, out: ExternalAgencyNode[]): void {
  for (const node of nodes) {
    out.push({
      code: node.code,
      name: node.name,
      status: node.status ?? 'active',
      parentCode,
      contactEmail: node.contact?.email || null,
    });
    if (node.children?.length) flattenTree(node.children, node.code, out);
  }
}

export async function fetchExternalAgencyHierarchy(baseUrlOverride?: string, apiKeyOverride?: string): Promise<ExternalAgencyNode[]> {
  const { baseUrl, apiKey } = await getConfig(baseUrlOverride, apiKeyOverride);

  const res = await fetchWithTimeout(`${baseUrl}/api/hierarchy.php?format=tree&include_contact=1`, {
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
  });

  const rawText = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  const detail = () => (body?.message as string) || (body?.error as string) || truncateForDisplay(rawText) || '(メッセージなし)';

  if (!res.ok) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', `階層取得APIの呼び出しに失敗しました(HTTP ${res.status}): ${detail()}`);
  }

  // 先方の実装がsuccessキーではなくokキーを使う場合にも対応する。
  const succeeded = body?.success === true || body?.ok === true;
  if (!body || !succeeded) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', `階層取得APIがエラーを返しました: ${detail()}`);
  }

  const nodes = findAgencyTreeArray(body) as ExternalAgencyTreeNode[] | null;
  if (!nodes) {
    throw new HttpError(
      502,
      'EXTERNAL_AGENCY_SYSTEM_ERROR',
      `階層取得APIのレスポンスに代理店一覧(tree)が見つかりませんでした(受信したキー: ${Object.keys(body).join(', ')})`,
    );
  }

  // code/nameが無いと後続のDB反映処理が壊れた形で進んでしまうため、ここで検知して
  // 実際に受信したノードの形を提示する(Prismaの分かりにくいエラーで落ちるのを防ぐ)。
  if (nodes.length > 0 && (typeof nodes[0].code !== 'string' || typeof nodes[0].name !== 'string')) {
    throw new HttpError(
      502,
      'EXTERNAL_AGENCY_SYSTEM_ERROR',
      `代理店ノードの形式が想定(code/name)と異なります(受信したキー: ${Object.keys(nodes[0] as object).join(', ')})`,
    );
  }

  const flat: ExternalAgencyNode[] = [];
  flattenTree(nodes, null, flat);
  return flat;
}

export async function pushAgencyCandidateToExternalSystem(input: PushAgencyCandidateInput): Promise<PushAgencyCandidateResult> {
  const { baseUrl, apiKey } = await getConfig();

  const res = await fetchWithTimeout(`${baseUrl}/api/integrations/agencies`, {
    method: 'POST',
    // 仕様書外の拡張(外部開発者向け連携ガイドv3.6.78-draft 6.2): 二重送信防止のため
    // 冪等性キーを付与する(相手側は「可能であれば」対応の任意仕様)。
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      event: 'upsert',
      source: 'sengoku-rr',
      external_id: input.externalId,
      parent_external_id: input.parentExternalId ?? undefined,
      name: input.name,
      contact_name: input.contactName ?? undefined,
      contact_email: input.contactEmail ?? undefined,
      login_email: input.loginEmail ?? undefined,
      phone: input.phone ?? undefined,
      status: 'active',
      updated_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', `代理店同期APIの呼び出しに失敗しました(${res.status})`);
  }

  const body = (await res.json()) as SyncResponse;
  const succeeded = body.ok === true || body.success === true;
  const data: Partial<PushAgencyCandidateResult> | undefined =
    body.data ?? (body.external_id !== undefined ? { external_id: body.external_id, status: body.status, synced: body.synced } : undefined);

  if (!succeeded || !data?.external_id) {
    const message = body.error?.message ?? body.message ?? '代理店同期APIがエラーを返しました';
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', message);
  }

  return data as PushAgencyCandidateResult;
}
