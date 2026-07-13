import crypto from 'crypto';
import { recoverMessageAddress } from 'viem';
import type { Prisma } from '@prisma/client';
import { HttpError } from '../lib/httpError';
import { getNftChain } from './nftMint';

type Tx = Prisma.TransactionClient;

const NONCE_TTL_MS = 10 * 60 * 1000;

// 署名対象メッセージはnonce発行時と検証時で必ず同じ内容を再構築できるよう、
// 保存済みのnonce/expiresAtのみから決定的に組み立てる(Web3用語を避けた日本語文言)。
export function buildVerificationMessage(params: { walletAddress: string; nonce: string; expiresAt: Date }): string {
  return [
    '戦国楽市楽座 受取用ウォレットの確認',
    `アドレス: ${params.walletAddress}`,
    `確認コード: ${params.nonce}`,
    `このコードは ${params.expiresAt.toISOString()} まで有効です。第三者に教えないでください。`,
  ].join('\n');
}

export async function createWalletVerificationChallenge(tx: Tx, userId: string, walletAddress: string) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  await tx.walletVerificationNonce.create({ data: { userId, walletAddress, nonce, expiresAt } });
  return { message: buildVerificationMessage({ walletAddress, nonce, expiresAt }), expiresAt };
}

// 署名を検証し、成功すればWallet確認情報一式(verified更新・変更履歴・nft_issuesの
// wallet_required→ready_to_issue一括更新)を同一トランザクション内で確定する。
// 呼び出し元(mypage.tsのPOST /wallet)からtxを受け取り、このサービス自身はtxを開始しない。
export async function verifyAndRegisterWallet(
  tx: Tx,
  params: { userId: string; walletAddress: string; signature: string },
) {
  // その(ユーザー, アドレス)組み合わせで直近に発行されたnonceのみを有効とする(古いnonceは
  // 使用済みかどうかに関わらず無効。リプレイ・使い回しの余地を残さないため)。
  const nonceRow = await tx.walletVerificationNonce.findFirst({
    where: { userId: params.userId, walletAddress: params.walletAddress },
    orderBy: { createdAt: 'desc' },
  });
  if (!nonceRow) {
    throw new HttpError(400, 'NONCE_NOT_FOUND', '先に確認コードを発行してください');
  }
  if (nonceRow.usedAt) {
    throw new HttpError(400, 'NONCE_ALREADY_USED', 'この確認コードは既に使用済みです。もう一度確認コードを発行してください');
  }
  if (nonceRow.expiresAt < new Date()) {
    throw new HttpError(400, 'NONCE_EXPIRED', '確認コードの有効期限が切れています。もう一度お試しください');
  }

  const message = buildVerificationMessage({
    walletAddress: params.walletAddress,
    nonce: nonceRow.nonce,
    expiresAt: nonceRow.expiresAt,
  });

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: params.signature as `0x${string}` });
  } catch {
    throw new HttpError(400, 'INVALID_SIGNATURE', '署名の検証に失敗しました');
  }

  if (recovered.toLowerCase() !== params.walletAddress.toLowerCase()) {
    throw new HttpError(400, 'INVALID_SIGNATURE', '署名の検証に失敗しました');
  }

  // 使い捨てnonceを消費済みにする(リプレイ防止)。
  await tx.walletVerificationNonce.update({ where: { id: nonceRow.id }, data: { usedAt: new Date() } });

  const existing = await tx.wallet.findUnique({ where: { userId: params.userId } });

  const wallet = await tx.wallet.upsert({
    where: { userId: params.userId },
    update: {
      walletAddress: params.walletAddress,
      chain: getNftChain(),
      verified: true,
      verificationMethod: 'personal_sign',
      verifiedAt: new Date(),
    },
    create: {
      userId: params.userId,
      walletAddress: params.walletAddress,
      chain: getNftChain(),
      verified: true,
      verificationMethod: 'personal_sign',
      verifiedAt: new Date(),
    },
  });

  await tx.walletChangeLog.create({
    data: {
      userId: params.userId,
      previousAddress: existing?.walletAddress ?? null,
      newAddress: params.walletAddress,
      verificationMethod: 'personal_sign',
      changedBy: 'self',
    },
  });

  await tx.nftIssue.updateMany({
    where: { userId: params.userId, status: 'wallet_required' },
    data: { status: 'ready_to_issue', walletAddress: params.walletAddress },
  });

  return wallet;
}
