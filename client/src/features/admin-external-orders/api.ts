import { adminSend } from '../../shared/api/adminClient';

export interface ExternalOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  sku: string;
  quantity: number;
  purchasedAt?: string;
  externalReference?: string;
  adminNote?: string;
}

export function createExternalOrder(input: ExternalOrderInput) {
  return adminSend<{ order: { id: string; orderNumber: string } }>('POST', '/external-orders', input);
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

export function importExternalOrdersCsv(csvContent: string, dryRun: boolean) {
  return adminSend<ExternalOrderImportResult>('POST', '/external-orders/import-csv', { csvContent, dryRun });
}
