import type { NftIssue } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getMintProvider, type MintProvider, type MintStatusResult } from './nftMint';
import { buildNftMetadata, uploadNftMetadata } from './nftMetadata';

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 5;
// 5→10→20→40→60分(以降は60分キャップ)の指数バックオフ。
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];

export interface ProcessNftMintsResult {
  claimed: number;
  issued: number;
  stillProcessing: number;
  retrying: number;
  failed: number;
  skipped: number;
}

// 仕様書外の拡張: NFT自動発行のメイン処理。Vercelには永続ワーカーが無いため、
// cron(internalCron.ts)からの定期実行と、決済完了直後のベストエフォート即時実行の
// 両方から呼ばれる(全件を1回の呼び出し内でループ処理する既存cronジョブと同じ設計)。
export async function processNftMints(): Promise<ProcessNftMintsResult> {
  const provider = getMintProvider();
  const result: ProcessNftMintsResult = { claimed: 0, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };

  // 1) 前回までにprocessingへ送信済みで未確定の行から先に確定を試みる。
  const processingRows = await prisma.nftIssue.findMany({ where: { status: 'processing' }, take: BATCH_LIMIT });
  for (const issue of processingRows) {
    await pollAndMaybeConfirm(issue, provider, result);
  }

  // 2) 新規claim対象(nextAttemptAtが過去/未設定のready_to_issue行)。
  const readyRows = await prisma.nftIssue.findMany({
    where: { status: 'ready_to_issue', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    take: BATCH_LIMIT,
  });

  for (const issue of readyRows) {
    // checkout.tsの行ロック(FOR UPDATE)に相当する、条件付きUPDATEによるアトミックなclaim。
    // 他プロセス(同時実行のcron・管理者操作)に先を越されていた場合はclaimedCount=0になる。
    const claimedCount = await prisma.$executeRaw`
      UPDATE nft_issues SET status = 'processing', updated_at = now()
      WHERE id = ${issue.id}::uuid AND status = 'ready_to_issue'
    `;
    if (claimedCount === 0) {
      result.skipped++;
      continue;
    }
    result.claimed++;
    await submitAndMaybeConfirm(issue.id, provider, result);
  }

  return result;
}

async function submitAndMaybeConfirm(issueId: string, provider: MintProvider, result: ProcessNftMintsResult) {
  const issue = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issueId }, include: { product: true } });

  if (!issue.walletAddress) {
    // ready_to_issueはウォレット確定時にしか付与されないため理論上到達しないが、防御的に戻す。
    await prisma.nftIssue.update({ where: { id: issueId }, data: { status: 'wallet_required' } });
    result.skipped++;
    return;
  }

  try {
    // シリアル番号は商品ごとのissued済み件数+1のベストエフォート採番(cron実行が重複しない前提)。
    // 同時実行下での完全な一意性はこの範囲では保証しない(Phase 1時点では実利用者数が少ないため許容)。
    const serialNumber = (await prisma.nftIssue.count({ where: { productId: issue.productId, status: 'issued' } })) + 1;
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
      data: { providerRequestId, metadataUri, submittedAt: new Date() },
    });

    const status = await provider.getMintStatus(providerRequestId);
    await applyMintStatus(issueId, status, result);
  } catch (e) {
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
// sendPostPaymentEmailsと同様、例外は握りつぶし決済確定処理自体には影響させない。
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
