import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { sendIntegrationError } from '../../../lib/apiError';
import { isKnownAgencyLifecycleEvent } from '../domain/agencyEvent.policy';
import { AgencyLoginConflictError, AgencyValidationError } from '../domain/agency.types';
import { findAgencyDetail, listAgencies } from '../infrastructure/prismaAgency.repository';
import { upsertAgency } from '../application/upsertAgency.usecase';
import { parseUpsertRequestBody } from './agencyIntegration.schema';
import { presentAgency, presentAgencyDetail } from './agencyIntegration.presenter';

const router = Router();

router.get('/', async (req, res) => {
  // サーバー設定によりパス形式(/:externalId)が使えない呼び出し元向けに、クエリ形式でも詳細取得できるようにする。
  const queryExternalId = req.query.external_id;
  if (typeof queryExternalId === 'string' && queryExternalId.length > 0) {
    const detail = await findAgencyDetail(prisma, queryExternalId);
    if (!detail) return sendIntegrationError(res, 404, 'AGENCY_NOT_FOUND', 'Agency not found.');
    return res.json({ agency: presentAgencyDetail(detail) });
  }

  const agencies = await listAgencies(prisma);
  res.json({ agencies: agencies.map(presentAgency) });
});

router.get('/:externalId', async (req, res) => {
  const detail = await findAgencyDetail(prisma, req.params.externalId);
  if (!detail) return sendIntegrationError(res, 404, 'AGENCY_NOT_FOUND', 'Agency not found.');
  res.json({ agency: presentAgencyDetail(detail) });
});

router.post('/', async (req, res) => {
  const parsed = parseUpsertRequestBody(req.body, isKnownAgencyLifecycleEvent);

  if (parsed.kind === 'connection_test') {
    return res.status(200).json({ ok: true, external_id: parsed.externalId, status: 'ok', synced: false });
  }
  if (parsed.kind === 'unhandled_event') {
    return res.status(200).json({ ok: true, received: true, processed: false, event: parsed.event });
  }
  if (parsed.kind === 'validation_error') {
    return sendIntegrationError(res, 422, 'VALIDATION_ERROR', parsed.message);
  }

  try {
    const result = await upsertAgency(parsed.input);
    // 本番安定化指示書Stage1: 通知(パスワード設定案内・アクセス許可通知)は既に
    // notification_outbox_eventsへ記録済み(残課題指示書Stage3)。以前はここでベストエフォートの
    // 即時ディスパッチを試みていたが、Resend側の遅延・障害が外部システムからのこのAPI呼び出し
    // (サーバー間連携)自体を待たせてしまうため廃止した。処理はCron(またはFeature Flag有効時の
    // 管理者による明示的な再送)に委ねる。

    res.status(result.created ? 201 : 200).json({
      ok: true,
      ...presentAgency(result.agency),
      login_provisioned: result.loginProvisioned,
      synced: true,
    });
  } catch (e) {
    if (e instanceof AgencyValidationError) {
      return sendIntegrationError(res, 422, 'VALIDATION_ERROR', e.message);
    }
    if (e instanceof AgencyLoginConflictError) {
      return sendIntegrationError(res, 409, 'VALIDATION_ERROR', e.message);
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return sendIntegrationError(res, 409, 'VALIDATION_ERROR', 'login_email is already in use.');
    }
    throw e;
  }
});

export default router;
