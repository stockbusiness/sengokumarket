export function toCsvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const BOM = '﻿';

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(toCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(toCsvField).join(','));
  }
  // Excelでの文字化け防止のためBOMを付与する
  return BOM + lines.join('\r\n');
}
