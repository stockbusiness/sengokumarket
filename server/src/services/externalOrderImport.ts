import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { parse } from 'csv-parse/sync';
import type { Order, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { appConfig } from '../shared/config/appConfig';
import { emailFilterInsensitive, isValidEmail, normalizeEmail } from '../lib/validation';
import { generateOrderNumber } from './orderNumber';
import { createNftIssuesForOrder, createCommissionForOrder } from './orderFulfillment';
import { enqueueNotification } from '../modules/notifications/infrastructure/notificationOutbox.repository';
import { triggerImmediateNotificationDispatch } from '../modules/notifications/application/dispatchNotificationOutbox.usecase';

type Tx = Prisma.TransactionClient;

// 仕様書外の拡張: 戦国パスポート等、このシステム以外の販路で既に決済が完了している購入者を
// 事後的に取り込み、NFT発行対象にするための機能。ウォレットの登録・確認は既存の署名検証必須の
// 仕組み(mypage/wallet)をそのまま使う。ここでは注文record一式(paid状態)と、必要なら
// ログイン用アカウントを作るだけで、ウォレットアドレスは一切扱わない。

export interface ExternalOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  sku: string;
  quantity: number;
  purchasedAt?: Date | null;
  externalReference?: string | null;
  adminNote?: string | null;
}

interface VariantRow {
  variant_id: string;
  variant_name: string;
  price: number;
  stock: number;
  reserved_stock: number;
  product_id: string;
  product_name: string;
  item_type: string;
}

function buildAdminNote(input: ExternalOrderInput): string {
  const parts = ['外部購入分の取り込み(管理者による代行登録)'];
  if (input.externalReference) parts.push(`外部参照番号: ${input.externalReference}`);
  if (input.adminNote) parts.push(input.adminNote);
  return parts.join(' / ');
}

// dryRun=trueの場合はSKU存在・在庫のみ検証し、一切書き込みを行わない(CSVプレビュー用)。
async function importOne(tx: Tx, input: ExternalOrderInput, dryRun: boolean): Promise<{ order: Order | null; guestAccountCreated: boolean }> {
  const termsVersion = appConfig.termsVersion;
  if (!termsVersion) throw new HttpError(500, 'CONFIG_ERROR', 'TERMS_VERSIONが設定されていません');

  const rows = await tx.$queryRaw<VariantRow[]>`
    SELECT
      pv.id AS variant_id,
      pv.name AS variant_name,
      pv.price AS price,
      pv.stock AS stock,
      pv.reserved_stock AS reserved_stock,
      p.id AS product_id,
      p.name AS product_name,
      p.item_type AS item_type
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.sku = ${input.sku}
    FOR UPDATE OF pv
  `;
  const row = rows[0];
  if (!row) throw new HttpError(404, 'VARIANT_NOT_FOUND', `SKU「${input.sku}」の商品が見つかりません`);
  if (row.item_type !== 'nft') {
    throw new HttpError(400, 'VALIDATION_ERROR', `SKU「${input.sku}」はNFT商品ではありません(先に商品管理でNFT商品として登録してください)`);
  }

  const availableStock = row.stock - row.reserved_stock;
  if (availableStock < input.quantity) {
    throw new HttpError(409, 'STOCK_INSUFFICIENT', `「${row.product_name} ${row.variant_name}」の在庫が不足しています`);
  }

  if (dryRun) return { order: null, guestAccountCreated: false };

  await tx.productVariant.update({ where: { id: row.variant_id }, data: { stock: { decrement: input.quantity } } });

  // 仕様書外の拡張: users.emailは大文字小文字を区別しない(注文自体のcustomerEmailは
  // 入力された表記のまま保存するため、ここではログインアカウント検索/作成のみ正規化する)。
  let user = await tx.user.findFirst({ where: { email: emailFilterInsensitive(input.customerEmail) } });
  let guestAccountCreated = false;
  if (!user) {
    const randomPassword = crypto.randomBytes(32).toString('hex');
    user = await tx.user.create({
      data: {
        name: input.customerName,
        email: normalizeEmail(input.customerEmail),
        phone: input.customerPhone ?? null,
        passwordHash: await bcrypt.hash(randomPassword, 10),
        role: 'user',
      },
    });
    guestAccountCreated = true;
  }

  const orderNumber = await generateOrderNumber(tx);
  const purchasedAt = input.purchasedAt ?? new Date();
  const totalAmount = row.price * input.quantity;

  const order = await tx.order.create({
    data: {
      orderNumber,
      userId: user.id,
      totalAmount,
      originalAmount: totalAmount,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      paymentMethod: 'external_import',
      paidAt: purchasedAt,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone ?? null,
      termsAgreedAt: purchasedAt,
      termsVersion,
      guestAccountCreated,
      adminNote: buildAdminNote(input),
    },
  });

  await tx.orderItem.create({
    data: {
      orderId: order.id,
      productId: row.product_id,
      variantId: row.variant_id,
      productName: row.product_name,
      variantName: row.variant_name,
      itemType: row.item_type,
      quantity: input.quantity,
      unitPrice: row.price,
      subtotal: totalAmount,
    },
  });

  await createNftIssuesForOrder(tx, order.id, user.id);
  await createCommissionForOrder(tx, order);

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase11: ゲストパスワード設定メールは、
  // 注文取り込みと同一トランザクションで通知予定(Outbox)だけを作成する。
  if (guestAccountCreated) {
    await enqueueNotification(tx, {
      eventType: 'guest_password_setup',
      recipient: order.customerEmail,
      payload: { name: order.customerName, userId: user.id },
    });
  }

  return { order, guestAccountCreated };
}

// 手動での単発登録。作成直後にゲストアカウントならパスワード設定メールを送り、
// 既に検証済みウォレットを持つ会員ならその場でNFT自動発行まで即時実行を試みる。
export async function createExternalOrder(input: ExternalOrderInput): Promise<Order> {
  const result = await prisma.$transaction((tx) => importOne(tx, input, false));
  const order = result.order!;

  if (result.guestAccountCreated) {
    await triggerImmediateNotificationDispatch();
  }

  // 本番安定化指示書Stage1: NFT発行行(nft_issues)はimportOne内で既に作成済み。以前は
  // ここでベストエフォートの即時Mint実行を試みていたが、管理者のこの登録操作自体が
  // 外部Mint API待ちで遅延してしまうため廃止した。処理はCronに委ねる。

  return order;
}

// --- CSV一括取り込み ---

const HEADER_MAP: Record<string, string> = {
  購入者名: 'customerName',
  メールアドレス: 'customerEmail',
  電話番号: 'customerPhone',
  SKU: 'sku',
  数量: 'quantity',
  購入日: 'purchasedAt',
  外部注文番号: 'externalReference',
  備考: 'adminNote',
};

interface ParsedCsvRow {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  sku: string;
  quantity: string;
  purchasedAt: string;
  externalReference: string;
  adminNote: string;
}

function mapHeaders(raw: Record<string, string>): Partial<ParsedCsvRow> {
  const mapped: Record<string, string> = {};
  for (const [header, value] of Object.entries(raw)) {
    const key = HEADER_MAP[header.trim()];
    if (key) mapped[key] = typeof value === 'string' ? value.trim() : value;
  }
  return mapped as Partial<ParsedCsvRow>;
}

function validateCsvRow(row: Partial<ParsedCsvRow>): { data: ExternalOrderInput | null; errors: string[] } {
  const errors: string[] = [];

  if (!row.customerName) errors.push('購入者名は必須です');
  if (!row.customerEmail || !isValidEmail(row.customerEmail)) errors.push('メールアドレスを正しく入力してください');
  if (!row.sku) errors.push('SKUは必須です');
  if (!row.quantity || !/^\d+$/.test(row.quantity) || Number(row.quantity) < 1) errors.push('数量は1以上の整数で入力してください');

  let purchasedAt: Date | null = null;
  if (row.purchasedAt) {
    const d = new Date(row.purchasedAt);
    if (Number.isNaN(d.getTime())) errors.push('購入日の形式が正しくありません(例: 2026-07-01)');
    else purchasedAt = d;
  }

  if (errors.length > 0) return { data: null, errors };

  return {
    data: {
      customerName: row.customerName!,
      customerEmail: row.customerEmail!,
      customerPhone: row.customerPhone || null,
      sku: row.sku!,
      quantity: Number(row.quantity),
      purchasedAt,
      externalReference: row.externalReference || null,
      adminNote: row.adminNote || null,
    },
    errors: [],
  };
}

export function parseAndValidateExternalOrdersCsv(content: string): { line: number; data: ExternalOrderInput | null; errors: string[] }[] {
  const records: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  return records.map((raw, index) => {
    const mapped = mapHeaders(raw);
    const { data, errors } = validateCsvRow(mapped);
    return { line: index + 2, data, errors }; // +2: header行の次から1行目
  });
}

export interface ExternalOrderImportRowResult {
  line: number;
  customerEmail: string | null;
  sku: string | null;
  action: 'imported' | 'error';
  orderNumber: string | null;
  errors: string[];
}

export interface ExternalOrderImportResult {
  results: ExternalOrderImportRowResult[];
  errorCount: number;
  successCount: number;
}

export async function importExternalOrdersFromCsv(content: string, dryRun: boolean): Promise<ExternalOrderImportResult> {
  const parsedRows = parseAndValidateExternalOrdersCsv(content);
  const results: ExternalOrderImportRowResult[] = [];
  const createdOrders: Order[] = [];

  for (const { line, data, errors } of parsedRows) {
    if (!data) {
      results.push({ line, customerEmail: null, sku: null, action: 'error', orderNumber: null, errors });
      continue;
    }

    try {
      const { order } = await prisma.$transaction((tx) => importOne(tx, data, dryRun));
      if (order) createdOrders.push(order);
      results.push({
        line,
        customerEmail: data.customerEmail,
        sku: data.sku,
        action: 'imported',
        orderNumber: order?.orderNumber ?? null,
        errors: [],
      });
    } catch (e) {
      results.push({
        line,
        customerEmail: data.customerEmail,
        sku: data.sku,
        action: 'error',
        orderNumber: null,
        errors: [e instanceof Error ? e.message : '不明なエラーが発生しました'],
      });
    }
  }

  if (!dryRun && createdOrders.length > 0) {
    // Wallet Claim本番前安定化指示書(2026-07-25)Phase11: ゲストパスワード設定メールの通知予定は
    // importOne内(各行のトランザクション)で既に作成済み。ここではベストエフォートの即時実行を
    // 1回だけ試みる(取りこぼしはCronが拾う)。
    if (createdOrders.some((order) => order.guestAccountCreated)) {
      await triggerImmediateNotificationDispatch();
    }
    // 本番安定化指示書Stage1: NFT発行行は各注文の取り込み処理内で既に作成済み。以前は
    // ここでベストエフォートの即時Mint実行を試みていたが、CSV一括取り込みという1回の
    // 管理者操作が外部Mint API待ちで遅延してしまうため廃止した。処理はCronに委ねる。
  }

  const errorCount = results.filter((r) => r.action === 'error').length;
  return { results, errorCount, successCount: results.length - errorCount };
}
