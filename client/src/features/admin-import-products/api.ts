import { adminSend } from '../../shared/api/adminClient';

export interface ImportRowResult {
  line: number;
  slug: string | null;
  sku: string | null;
  action: 'create_product_and_variant' | 'create_variant' | 'update_variant' | 'error';
  errors: string[];
}
export interface ImportResult {
  results: ImportRowResult[];
  errorCount: number;
  successCount: number;
}

export function importProductsCsv(csvContent: string, dryRun: boolean) {
  return adminSend<ImportResult>('POST', '/import-products', { csvContent, dryRun });
}
