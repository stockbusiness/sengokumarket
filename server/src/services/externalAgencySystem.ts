import { HttpError } from '../lib/httpError';
import { getSetting } from './settings';

// 仕様書外の拡張: 外部代理店システム(sengoku-ai.com)との連携。
// 本システムが呼び出し元(クライアント)側になる(先方の仕様書に準拠)。
// - 階層取得API(GET): 先方が管理する代理店階層を本システムへ反映するために取得する
// - 代理店同期API(POST): 本システム側で生まれた代理店候補(会員の代理店申請等)を先方へ送る

export interface ExternalAgencyContact {
  email: string | null;
  phone: string | null;
  line_url: string | null;
}

export interface ExternalAgencyNode {
  id: number;
  code: string;
  name: string;
  person_name: string | null;
  level: number;
  status: string;
  parent_id: number | null;
  parent_code: string | null;
  contact?: ExternalAgencyContact | null;
}

interface HierarchyFlatResponse {
  ok: boolean;
  format: string;
  agents?: ExternalAgencyNode[];
  tree?: ExternalAgencyNode[];
}

export interface PushAgencyCandidateInput {
  externalId: string;
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  loginEmail?: string | null;
  parentExternalId?: string | null;
}

export interface PushAgencyCandidateResult {
  external_id: string;
  code: string;
  status: string;
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

// 先方は階層取得APIをAuthorization: Bearer、代理店同期APIをx-api-keyで例示しているが、
// どちらのヘッダーでも認証可能とのことなので、本システムは一貫してx-api-keyを送る。
export async function fetchExternalAgencyHierarchy(): Promise<ExternalAgencyNode[]> {
  const { baseUrl, apiKey } = await getConfig();

  const res = await fetch(`${baseUrl}/api/hierarchy.php?format=flat&include_contact=1&include_inactive=1`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', `階層取得APIの呼び出しに失敗しました(${res.status})`);
  }

  const body = (await res.json()) as HierarchyFlatResponse;
  if (!body.ok) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', '階層取得APIがエラーを返しました');
  }

  return body.agents ?? body.tree ?? [];
}

export async function pushAgencyCandidateToExternalSystem(input: PushAgencyCandidateInput): Promise<PushAgencyCandidateResult> {
  const { baseUrl, apiKey } = await getConfig();

  const res = await fetch(`${baseUrl}/api/integrations/agencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      external_id: input.externalId,
      name: input.name,
      contact_name: input.contactName ?? undefined,
      contact_email: input.contactEmail ?? undefined,
      login_email: input.loginEmail ?? undefined,
      parent_external_id: input.parentExternalId ?? undefined,
    }),
  });

  if (!res.ok) {
    throw new HttpError(502, 'EXTERNAL_AGENCY_SYSTEM_ERROR', `代理店同期APIの呼び出しに失敗しました(${res.status})`);
  }

  const body = (await res.json()) as { agency: PushAgencyCandidateResult };
  return body.agency;
}
