import type { NftIssue } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { getMintProvider, type MintProvider, type MintStatusResult } from './nftMint';
import { buildNftMetadata, uploadNftMetadata } from './nftMetadata';

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 5;
// 5→10→20→40→60分(以降は60分キャップ)の指数バックオフ。
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];

// 本番安定化指示書Stage2(5.4「1回の処理時間上限」): Functionの残り時間に余裕がない場合は
// 新規処理を打ち切る。integration_outbox_eventsのgetTimeBudgetMsと同じ方針
// (環境変数で調整可能・"0"も有効な設定値として扱うためisFiniteで判定・既定値は保守的に8000ms)。
function getTimeBudgetMs(): number {
  const raw = process.env.NFT_MINT_TIME_BUDGET_MS;
  if (raw === undefined) return 8000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 8000;
}

export interface ProcessNftMintsResult {
  claimed: number;
  issued: number;
  stillProcessing: number;
  retrying: number;
  failed: number;
  skipped: number;
}

// 仕様書外の拡張: NFT発行の確定処理。運営の意向により、ready_to_issueの行を新規に
// 外部Mint APIへ送信する部分は運営の手動操作(server/src/routes/admin/nftIssues.tsの
// POST /:id/mint、submitAndMaybeConfirmを直接呼ぶ)のみとし、cronでは自動送信しない
// (決済手段がカード・銀行振込の2経路あることと、シリアル番号を運営が目視確認してから
// 刻みたいという要望による)。cronはあくまで「送信済み(processing)の行の成否確認」という
// 判断を伴わない後始末のみを担う。
export async function processNftMints(): Promise<ProcessNftMintsResult> {
  const provider = getMintProvider();
  const result: ProcessNftMintsResult = { claimed: 0, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
  const startedAt = Date.now();
  const timeBudgetMs = getTimeBudgetMs();

  // 前回までにprocessingへ送信済みで未確定の行の成否確認のみ行う。
  const processingRows = await prisma.nftIssue.findMany({ where: { status: 'processing' }, take: BATCH_LIMIT });
  for (const issue of processingRows) {
    if (Date.now() - startedAt >= timeBudgetMs) return result;
    await pollAndMaybeConfirm(issue, provider, result);
  }

  return result;
}

// 仕様書外の拡張(運営手動Mint): 管理画面のPOST /nft-issues/:id/mintから呼ばれる。
// 呼び出し元で対象行をready_to_issue→processingへアトミックにclaim済みであることが前提。
export async function submitAndMaybeConfirm(
  issueId: string,
  provider: MintProvider,
  result: ProcessNftMintsResult,
  serialNumber: number,
) {
  const issue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issueId }, include: { product: true } });

  if (!issue.walletAddress) {
    // ready_to_issueはウォレット確定時にしか付与されないため理論上到達しないが、防御的に戻す。
    await prisma.nftIssue.update({ where: { id: issueId }, data: { status: 'wallet_required' } });
    result.skipped++;
    return;
  }

  try {
    const metadata = buildNftMetadata({
      productName: issue.product.name,
      serialNumber,
      imageUrl: issue.product.images[0] ?? null,
    });
    const metadataUri = await uploadNftMetadata(issue.id, metadata);

    const { providerRequestId } = await provider.submitMint({
      toAddress: issue.walletAddress,
      metadataUri,
      chain: issue.chain,
      idempotencyKey: issue.id,
    });

    await prisma.nftIssue.update({
      where: { id: issueId },
      data: { providerRequestId, metadataUri, submittedAt: new Date(), serialNumber },
    });

    const status = await provider.getMintStatus(providerRequestId);
    await applyMintStatus(issueId, status, result);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      // serialNumberの重複(@@unique([productId, serialNumber]))。processingへclaim済みの行を
      // ready_to_issueへ戻し、運営が別のシリアル番号で再試行できるようにする(バックオフはかけない)。
      await prisma.nftIssue.update({ where: { id: issueId }, data: { status: 'ready_to_issue' } });
      throw new HttpError(400, 'SERIAL_NUMBER_DUPLICATE', 'このシリアル番号は既に使用されています');
    }
    await handleFailure(issueId, e instanceof Error ? e.message : String(e), result);
  }
}

// claim直後、まだsubmitMintの送信が完了していない行(providerRequestId未設定)は、
// 同時に動いている別の呼び出しが処理している最中の可能性があるため、すぐには失敗にしない。
// この滞留時間を超えても未送信のままなら、送信処理自体がクラッシュ等で中断したとみなし失敗にする。
const STUCK_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;

async function pollAndMaybeConfirm(issue: NftIssue, provider: MintProvider, result: ProcessNftMintsResult) {
  if (!issue.providerRequestId) {
    if (Date.now() - issue.updatedAt.getTime() > STUCK_PROCESSING_THRESHOLD_MS) {
      await handleFailure(issue.id, 'providerRequestIdが記録されないままprocessingで停滞しています', result);
    } else {
      result.skipped++;
    }
    return;
  }
  try {
    const status = await provider.getMintStatus(issue.providerRequestId);
    await applyMintStatus(issue.id, status, result);
  } catch (e) {
    await handleFailure(issue.id, e instanceof Error ? e.message : String(e), result);
  }
}

async function applyMintStatus(issueId: string, status: MintStatusResult, result: ProcessNftMintsResult) {
  if (status.status === 'success') {
    await prisma.nftIssue.update({
      where: { id: issueId },
      data: { status: 'issued', tokenId: status.tokenId, transactionHash: status.transactionHash, issuedAt: new Date() },
    });
    result.issued++;
  } else if (status.status === 'pending') {
    result.stillProcessing++;
  } else {
    await handleFailure(issueId, status.error ?? 'Mintに失敗しました', result);
  }
}

// 決済確定直後にベストエフォートで即時実行するためのラッパー(仕様書外の拡張)。
// Vercelのcronは日次のみを前提とするため、これを併用することで購入者を長時間待たせない。
// triggerImmediateNotificationDispatchと同様、例外は握りつぶし決済確定処理自体には影響させない。
export async function triggerImmediateNftMintProcessing(): Promise<void> {
  try {
    await processNftMints();
  } catch (e) {
    console.error('immediate nft mint processing failed', { error: e });
  }
}

async function handleFailure(issueId: string, error: string, result: ProcessNftMintsResult) {
  const issue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issueId } });
  const attemptCount = issue.attemptCount + 1;

  if (attemptCount >= MAX_ATTEMPTS) {
    await prisma.nftIssue.update({ where: { id: issueId }, data: { status: 'failed', attemptCount, lastError: error } });
    result.failed++;
    return;
  }

  const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1)];
  await prisma.nftIssue.update({
    where: { id: issueId },
    data: { status: 'ready_to_issue', attemptCount, lastError: error, nextAttemptAt: new Date(Date.now() + backoffMinutes * 60_000) },
  });
  result.retrying++;
}
