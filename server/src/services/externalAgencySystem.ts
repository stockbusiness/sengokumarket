import { HttpError } from '../lib/httpError';
import { getSetting } from './settings';

// 仕様書外の拡張: 外部代理店システム(sengoku-ai.com)との連携(先方仕様書v3.6.40準拠)。
// 本システムが呼び出し元(クライアント)側になる。
// - 階層取得API(GET): 先方が管理する代理店階層を本システムへ反映するために取得する
// - 代理店同期API(POST): 本システム側で生まれた代理店候補(会員の代理店申請等)を先方へ送る

interface ExternalAgencyTreeNode {
  agent_code: string;
  name: string;
  level?: number;
  role_label?: string;
  status?: string;
  contact?: { email: string | null; phone: string | null; line_url: string | null } | null;
  children?: ExternalAgencyTreeNode[];
}

interface HierarchyResponse {
  success: boolean;
  format: string;
  data?: ExternalAgencyTreeNode[];
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

interface SyncResponse {
  success: boolean;
  data?: PushAgencyCandidateResult;
  message?: string;
}

async function getConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const [baseUrl, apiKey] = await Promise.all([
    getSetting('external_agency_system_base_url'),
    getSetting('external_agency_system_api_key'),
  ]);
  if (!baseUrl || !apiKey) {
    throw new HttpError(503, 'EXTERNAL_AGENCY_SYSTEM_NOT_CONFIGURED', '外部代理店システムの連携設定が未登録です');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

// ツリー構造(children)をたどり、parentCodeを付与しながらフラットな配列にする。
function flattenTree(nodes: ExternalAgencyTreeNode[], parentCode: string | null, out: ExternalAgencyNode[]): void {
  for (const node of nodes) {
    out.push({
      code: node.agent_code,
      name: node.name,
      status: node.status ?? 'active',
      parentCode,
      contactEmail: node.contact?.email ?? null,
    });
    if (node.children?.length) flattenTree(node.children, node.agent_code, out);
  }
}

export async function fetchExternalAgencyHierarchy(): Promise<ExternalAgencyNode[]> {
  const { baseUrl, apiKey } = await getConfig();

  const res = await fetch(`${baseUrl}/api/hierarchy.php?format=tree&include_contact=1`, {
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', `階層取得APIの呼び出しに失敗しました(${res.status})`);
  }

  const body = (await res.json()) as HierarchyResponse;
  if (!body.success) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', '階層取得APIがエラーを返しました');
  }

  const flat: ExternalAgencyNode[] = [];
  flattenTree(body.data ?? [], null, flat);
  return flat;
}

export async function pushAgencyCandidateToExternalSystem(input: PushAgencyCandidateInput): Promise<PushAgencyCandidateResult> {
  const { baseUrl, apiKey } = await getConfig();

  const res = await fetch(`${baseUrl}/api/integrations/agencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
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
  if (!body.success || !body.data) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', body.message ?? '代理店同期APIがエラーを返しました');
  }

  return body.data;
}
