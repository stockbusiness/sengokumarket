import { useState } from 'react';
import { importProductsCsv, type ImportResult } from '../../lib/adminApi';

const ACTION_LABEL: Record<string, string> = {
  create_product_and_variant: '新規作成(商品+バリエーション)',
  create_variant: 'バリエーション追加',
  update_variant: '更新',
  error: 'エラー',
};

// 仕様書外の拡張: 列名・入力形式が分かるサンプルCSVをダウンロードできるようにする。
// 同じslugの行を2つ入れて「1商品に複数バリエーション」の書き方も示す。
const SAMPLE_CSV_ROWS = [
  ['商品名', 'slug', '商品説明', 'カテゴリ', '商品タイプ', 'バリエーション名', 'SKU', '価格', '在庫数', '公開ステータス'],
  [
    '戦国評議員デジタル会員証(見本)',
    'sample-council-nft',
    '評議員デジタル会員証の見本商品です',
    'NFT',
    'nft',
    'RED',
    'sample-council-nft-red',
    '25000',
    '50',
    'draft',
  ],
  [
    '戦国評議員デジタル会員証(見本)',
    'sample-council-nft',
    '評議員デジタル会員証の見本商品です',
    'NFT',
    'nft',
    'Black',
    'sample-council-nft-black',
    '25000',
    '50',
    'draft',
  ],
];

function escapeCsvField(field: string): string {
  return /[",\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function downloadSampleCsv() {
  const csv = SAMPLE_CSV_ROWS.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  // ExcelでもUTF-8として正しく開けるよう先頭にBOMを付ける(取り込み側もbom:trueで対応済み)。
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample_products.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminImportProductsPage() {
  const [csvContent, setCsvContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setPreviewed(false);
    const reader = new FileReader();
    reader.onload = () => setCsvContent(String(reader.result));
    reader.readAsText(file, 'utf-8');
  }

  async function handlePreview() {
    if (!csvContent) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importProductsCsv(csvContent, true);
      setResult(res);
      setPreviewed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'プレビューに失敗しました');
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!csvContent) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importProductsCsv(csvContent, false);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'インポートに失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>CSV商品インポート</h1>
      <p>
        必須列: 商品名, slug, カテゴリ, 商品タイプ(nft/physical/service/membership/fee),
        バリエーション名, SKU, 価格, 在庫数。任意列: 商品説明, 公開ステータス。
      </p>
      <p>
        <button type="button" className="btn-secondary btn-small" onClick={downloadSampleCsv}>
          サンプルCSVをダウンロード
        </button>
      </p>

      <div className="admin-form-card">
        <input type="file" accept=".csv,text/csv" onChange={handleFileChange} />
        {fileName && <p>選択中: {fileName}</p>}

        {error && <p className="checkout-error">{error}</p>}

        <div>
          <button type="button" className="btn-secondary btn-small" onClick={handlePreview} disabled={!csvContent || busy}>
            プレビュー
          </button>{' '}
          <button type="button" className="btn-primary btn-small" onClick={handleImport} disabled={!csvContent || !previewed || busy}>
            インポート実行
          </button>
        </div>
      </div>

      {result && (
        <>
          <p>
            成功: {result.successCount}件 / エラー: {result.errorCount}件
          </p>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>行番号</th>
                  <th>slug</th>
                  <th>SKU</th>
                  <th>結果</th>
                  <th>エラー内容</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{r.slug ?? '-'}</td>
                    <td>{r.sku ?? '-'}</td>
                    <td>
                      <span className={`status-badge status-badge--${r.action === 'error' ? 'warning' : 'success'}`}>
                        {ACTION_LABEL[r.action]}
                      </span>
                    </td>
                    <td>{r.errors.join(' / ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
