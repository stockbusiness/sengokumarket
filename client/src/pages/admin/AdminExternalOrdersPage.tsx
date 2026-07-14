import { useState } from 'react';
import {
  createExternalOrder,
  importExternalOrdersCsv,
  type ExternalOrderImportResult,
} from '../../lib/adminApi';

const ACTION_LABEL: Record<string, string> = {
  imported: '取り込み成功',
  error: 'エラー',
};

const SAMPLE_CSV_ROWS = [
  ['購入者名', 'メールアドレス', '電話番号', 'SKU', '数量', '購入日', '外部注文番号', '備考'],
  ['戦国花子', 'hanako@example.com', '', 'sample-council-nft-red', '1', '2026-07-01', 'PASSPORT-0001', '戦国パスポート経由'],
];

function escapeCsvField(field: string): string {
  return /[",\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function downloadSampleCsv() {
  const csv = SAMPLE_CSV_ROWS.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample_external_orders.csv';
  a.click();
  URL.revokeObjectURL(url);
}

const EMPTY_FORM = {
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  sku: '',
  quantity: '1',
  purchasedAt: '',
  externalReference: '',
  adminNote: '',
};

export default function AdminExternalOrdersPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  const [csvContent, setCsvContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvResult, setCsvResult] = useState<ExternalOrderImportResult | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormMessage(null);
    setFormBusy(true);
    try {
      const quantity = Number(form.quantity);
      const res = await createExternalOrder({
        customerName: form.customerName,
        customerEmail: form.customerEmail,
        customerPhone: form.customerPhone || undefined,
        sku: form.sku,
        quantity,
        purchasedAt: form.purchasedAt || undefined,
        externalReference: form.externalReference || undefined,
        adminNote: form.adminNote || undefined,
      });
      setFormMessage(`登録しました(注文番号: ${res.order.orderNumber})。ウォレット未登録一覧から案内メールを送信できます。`);
      setForm(EMPTY_FORM);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '登録に失敗しました');
    } finally {
      setFormBusy(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setCsvResult(null);
    setPreviewed(false);
    const reader = new FileReader();
    reader.onload = () => setCsvContent(String(reader.result));
    reader.readAsText(file, 'utf-8');
  }

  async function handlePreview() {
    if (!csvContent) return;
    setCsvBusy(true);
    setCsvError(null);
    try {
      const res = await importExternalOrdersCsv(csvContent, true);
      setCsvResult(res);
      setPreviewed(true);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : 'プレビューに失敗しました');
    } finally {
      setCsvBusy(false);
    }
  }

  async function handleImport() {
    if (!csvContent) return;
    setCsvBusy(true);
    setCsvError(null);
    try {
      const res = await importExternalOrdersCsv(csvContent, false);
      setCsvResult(res);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : 'インポートに失敗しました');
    } finally {
      setCsvBusy(false);
    }
  }

  return (
    <div>
      <h1>外部購入者の取り込み</h1>
      <p>
        戦国パスポート等、このシステム以外の販路で既に決済が完了している購入者を追加し、NFT発行の対象にします。
        あらかじめ商品管理でNFT商品・SKUを登録しておいてください。ウォレットの登録は署名検証が必須のため、
        登録後は本人にログインして受取用ウォレットを登録してもらう必要があります(未登録者への案内メールは
        「ウォレット未登録一覧」から送信できます)。
      </p>

      <h2>手動で1件登録</h2>
      <form className="admin-form-card" onSubmit={handleSubmit}>
        {formError && <p className="checkout-error">{formError}</p>}
        {formMessage && <p>{formMessage}</p>}

        <label>
          購入者名
          <input
            type="text"
            required
            value={form.customerName}
            onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
          />
        </label>
        <label>
          メールアドレス
          <input
            type="email"
            required
            value={form.customerEmail}
            onChange={(e) => setForm((f) => ({ ...f, customerEmail: e.target.value }))}
          />
        </label>
        <label>
          電話番号(任意)
          <input type="text" value={form.customerPhone} onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))} />
        </label>
        <label>
          SKU
          <input type="text" required value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} />
        </label>
        <label>
          数量
          <input
            type="number"
            min={1}
            required
            value={form.quantity}
            onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
          />
        </label>
        <label>
          購入日(任意・未入力なら今日の日付)
          <input type="date" value={form.purchasedAt} onChange={(e) => setForm((f) => ({ ...f, purchasedAt: e.target.value }))} />
        </label>
        <label>
          外部注文番号(任意)
          <input
            type="text"
            value={form.externalReference}
            onChange={(e) => setForm((f) => ({ ...f, externalReference: e.target.value }))}
          />
        </label>
        <label>
          備考(任意)
          <input type="text" value={form.adminNote} onChange={(e) => setForm((f) => ({ ...f, adminNote: e.target.value }))} />
        </label>

        <button type="submit" className="btn-primary btn-small" disabled={formBusy}>
          登録する
        </button>
      </form>

      <h2>CSVで一括登録</h2>
      <p>必須列: 購入者名, メールアドレス, SKU, 数量。任意列: 電話番号, 購入日, 外部注文番号, 備考。</p>
      <p>
        <button type="button" className="btn-secondary btn-small" onClick={downloadSampleCsv}>
          サンプルCSVをダウンロード
        </button>
      </p>

      <div className="admin-form-card">
        <input type="file" accept=".csv,text/csv" onChange={handleFileChange} />
        {fileName && <p>選択中: {fileName}</p>}

        {csvError && <p className="checkout-error">{csvError}</p>}

        <div>
          <button type="button" className="btn-secondary btn-small" onClick={handlePreview} disabled={!csvContent || csvBusy}>
            プレビュー
          </button>{' '}
          <button
            type="button"
            className="btn-primary btn-small"
            onClick={handleImport}
            disabled={!csvContent || !previewed || csvBusy}
          >
            インポート実行
          </button>
        </div>
      </div>

      {csvResult && (
        <>
          <p>
            成功: {csvResult.successCount}件 / エラー: {csvResult.errorCount}件
          </p>
          <div className="admin-table-card">
            <table>
              <thead>
                <tr>
                  <th>行番号</th>
                  <th>メールアドレス</th>
                  <th>SKU</th>
                  <th>結果</th>
                  <th>注文番号</th>
                  <th>エラー内容</th>
                </tr>
              </thead>
              <tbody>
                {csvResult.results.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{r.customerEmail ?? '-'}</td>
                    <td>{r.sku ?? '-'}</td>
                    <td>
                      <span className={`status-badge status-badge--${r.action === 'error' ? 'warning' : 'success'}`}>
                        {ACTION_LABEL[r.action]}
                      </span>
                    </td>
                    <td>{r.orderNumber ?? '-'}</td>
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
