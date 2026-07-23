import type { AgencyDetail, AgencyRecord } from '../domain/agency.types';

// レスポンス形式は外部開発者向け連携ガイド(v3.6.78-draft)のsnake_caseフィールドに合わせる。
export function presentAgency(agency: AgencyRecord) {
  return {
    id: agency.id,
    external_id: agency.externalId,
    name: agency.name,
    code: agency.code,
    status: agency.status,
    default_commission_rate: agency.defaultCommissionRate,
    contact_name: agency.contactName,
    contact_email: agency.contactEmail,
    parent_external_id: agency.parentExternalId,
  };
}

export function presentAgencyDetail(detail: AgencyDetail) {
  return {
    ...presentAgency(detail),
    child_external_ids: detail.childExternalIds,
  };
}
