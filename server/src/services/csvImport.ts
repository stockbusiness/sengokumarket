import { parse } from 'csv-parse/sync';
import { prisma } from '../lib/prisma';
import { ITEM_TYPES, PRODUCT_STATUSES as STATUSES } from '@sengoku/contracts';

const HEADER_MAP: Record<string, string> = {
  商品名: 'name',
  slug: 'slug',
  商品説明: 'description',
  カテゴリ: 'category',
  商品タイプ: 'itemType',
  バリエーション名: 'variantName',
  SKU: 'sku',
  価格: 'price',
  在庫数: 'stock',
  公開ステータス: 'status',
};

interface ParsedRow {
  name: string;
  slug: string;
  description: string;
  category: string;
  itemType: string;
  variantName: string;
  sku: string;
  price: string;
  stock: string;
  status: string;
}

export interface RowResult {
  line: number;
  slug: string | null;
  sku: string | null;
  action: 'create_product_and_variant' | 'create_variant' | 'update_variant' | 'error';
  errors: string[];
}

export interface ImportResult {
  results: RowResult[];
  errorCount: number;
  successCount: number;
}

function mapHeaders(raw: Record<string, string>): Partial<ParsedRow> {
  const mapped: Record<string, string> = {};
  for (const [header, value] of Object.entries(raw)) {
    const key = HEADER_MAP[header.trim()];
    if (key) mapped[key] = typeof value === 'string' ? value.trim() : value;
  }
  return mapped as Partial<ParsedRow>;
}

function validateRow(row: Partial<ParsedRow>, line: number): { data: ParsedRow | null; errors: string[] } {
  const errors: string[] = [];

  if (!row.name) errors.push('商品名は必須です');
  if (!row.slug || !/^[a-z0-9-]+$/.test(row.slug)) errors.push('slugは半角英数とハイフンのみで入力してください');
  if (!row.category) errors.push('カテゴリは必須です');
  // 商品タイプは誤ってnft_issuesが作られる事故を防ぐため必須(仕様書v1.5 5.6)
  if (!row.itemType) errors.push('商品タイプは必須です');
  else if (!(ITEM_TYPES as readonly string[]).includes(row.itemType)) errors.push(`商品タイプが不正です(${row.itemType})`);
  if (!row.variantName) errors.push('バリエーション名は必須です');
  if (!row.sku) errors.push('SKUは必須です(重複時の更新キーとして使用するため)');
  if (!row.price || !/^\d+$/.test(row.price)) errors.push('価格は0以上の整数で入力してください');
  if (!row.stock || !/^\d+$/.test(row.stock)) errors.push('在庫数は0以上の整数で入力してください');
  if (row.status && !(STATUSES as readonly string[]).includes(row.status)) errors.push(`公開ステータスが不正です(${row.status})`);

  if (errors.length > 0) return { data: null, errors };

  return {
    data: {
      name: row.name!,
      slug: row.slug!,
      description: row.description ?? '',
      category: row.category!,
      itemType: row.itemType!,
      variantName: row.variantName!,
      sku: row.sku!,
      price: row.price!,
      stock: row.stock!,
      status: row.status || 'draft',
    },
    errors: [],
  };
}

export function parseAndValidateCsv(content: string): { line: number; data: ParsedRow | null; errors: string[] }[] {
  const records: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  return records.map((raw, index) => {
    const mapped = mapHeaders(raw);
    const { data, errors } = validateRow(mapped, index + 2); // +2: header行の次から1行目
    return { line: index + 2, data, errors };
  });
}

export async function importProductsFromCsv(content: string, dryRun: boolean): Promise<ImportResult> {
  const parsedRows = parseAndValidateCsv(content);
  const results: RowResult[] = [];

  for (const { line, data, errors } of parsedRows) {
    if (!data) {
      results.push({ line, slug: null, sku: null, action: 'error', errors });
      continue;
    }

    const price = Number(data.price);
    const stock = Number(data.stock);

    try {
      const action = await prisma.$transaction(async (tx) => {
        let product = await tx.product.findUnique({ where: { slug: data.slug } });
        let productCreated = false;

        if (!product) {
          if (!dryRun) {
            product = await tx.product.create({
              data: {
                name: data.name,
                slug: data.slug,
                description: data.description || null,
                category: data.category,
                itemType: data.itemType,
                basePrice: price,
                status: data.status,
              },
            });
          }
          productCreated = true;
        } else if (!dryRun) {
          product = await tx.product.update({
            where: { id: product.id },
            data: {
              name: data.name,
              description: data.description || null,
              category: data.category,
              itemType: data.itemType,
              status: data.status,
            },
          });
        }

        const existingVariant = await tx.productVariant.findUnique({ where: { sku: data.sku } });

        if (existingVariant) {
          if (!dryRun) {
            await tx.productVariant.update({
              where: { id: existingVariant.id },
              data: { name: data.variantName, price, stock },
            });
          }
          return 'update_variant' as const;
        }

        if (!dryRun) {
          const productId = product?.id ?? (await tx.product.findUniqueOrThrow({ where: { slug: data.slug } })).id;
          await tx.productVariant.create({
            data: { productId, name: data.variantName, sku: data.sku, price, stock },
          });
        }
        return productCreated ? ('create_product_and_variant' as const) : ('create_variant' as const);
      });

      results.push({ line, slug: data.slug, sku: data.sku, action, errors: [] });
    } catch (e) {
      results.push({
        line,
        slug: data.slug,
        sku: data.sku,
        action: 'error',
        errors: [e instanceof Error ? e.message : '不明なエラーが発生しました'],
      });
    }
  }

  const errorCount = results.filter((r) => r.action === 'error').length;
  return { results, errorCount, successCount: results.length - errorCount };
}
