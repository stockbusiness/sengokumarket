import { isValidEmail } from '../../../lib/validation';
import type { UpsertAgencyRequest } from '../domain/agency.types';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export type ParsedUpsertBody =
  | { kind: 'connection_test'; externalId: string | null }
  | { kind: 'unhandled_event'; event: string }
  | { kind: 'validation_error'; message: string }
  | { kind: 'upsert'; input: UpsertAgencyRequest };

// HTTP層が担うのは形式的な入力検証のみ。親代理店の解決(既存確認・循環チェック・
// 永久帰属継承)はDBアクセスを伴うためapplication層(upsertAgency.usecase)の責務とする。
export function parseUpsertRequestBody(body: unknown, isKnownLifecycleEvent: (event: string) => boolean): ParsedUpsertBody {
  const b = (body ?? {}) as Record<string, unknown>;

  // 接続テストボタン(event=connection_test またはdry_run=true)は
  // 認証・受信可否の確認のみを行い、代理店データとしては一切保存しない。
  if (b.event === 'connection_test' || b.dry_run === true) {
    return { kind: 'connection_test', externalId: typeof b.external_id === 'string' ? b.external_id : null };
  }

  // 共通顧客HUB関連イベント等、このシステムがまだ対応していないイベント種別は
  // 200で受理するだけに留め、代理店upsertとして誤処理しない。
  if (typeof b.event === 'string' && !isKnownLifecycleEvent(b.event)) {
    return { kind: 'unhandled_event', event: b.event };
  }

  const externalId = b.external_id;
  const name = b.name;
  const parentExternalId = b.parent_external_id;
  const defaultCommissionRate = b.default_commission_rate;
  const contactName = b.contact_name;
  const contactEmail = b.contact_email;
  const status = b.status;
  const loginEmail = b.login_email;

  if (!isNonEmptyString(externalId)) {
    return { kind: 'validation_error', message: 'external_id is required.' };
  }
  if (!isNonEmptyString(name)) {
    return { kind: 'validation_error', message: 'name is required.' };
  }
  if (
    defaultCommissionRate !== undefined &&
    defaultCommissionRate !== null &&
    (typeof defaultCommissionRate !== 'number' || defaultCommissionRate < 0 || defaultCommissionRate > 100)
  ) {
    return { kind: 'validation_error', message: 'default_commission_rate must be a number between 0 and 100.' };
  }
  if (status !== undefined && status !== 'active' && status !== 'inactive') {
    return { kind: 'validation_error', message: 'status must be "active" or "inactive".' };
  }
  if (loginEmail !== undefined && loginEmail !== null && !isValidEmail(loginEmail as string)) {
    return { kind: 'validation_error', message: 'login_email is invalid.' };
  }
  if (
    parentExternalId !== undefined &&
    parentExternalId !== null &&
    parentExternalId !== '' &&
    !isNonEmptyString(parentExternalId)
  ) {
    return { kind: 'validation_error', message: 'parent_external_id is invalid.' };
  }

  return {
    kind: 'upsert',
    input: {
      externalId,
      name,
      parentExternalId: parentExternalId as string | null | undefined,
      defaultCommissionRate: defaultCommissionRate as number | null | undefined,
      contactName: contactName as string | null | undefined,
      contactEmail: contactEmail as string | null | undefined,
      status: status as 'active' | 'inactive' | undefined,
      loginEmail: loginEmail as string | null | undefined,
    },
  };
}
