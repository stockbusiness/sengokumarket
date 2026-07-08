import { useEffect, useState } from 'react';
import {
  fetchAdminSettings,
  fetchBankTransferSettings,
  updateAdminSettings,
  updateBankTransferSettings,
  type AdminSettings,
} from '../../lib/adminApi';

const FIELDS: { key: keyof AdminSettings; label: string }[] = [
  { key: 'stripe_secret_key', label: 'Stripeシークレットキー' },
  { key: 'stripe_webhook_secret', label: 'Stripe Webhookシークレット' },
  { key: 'stripe_public_key', label: 'Stripe公開可能キー' },
  { key: 'resend_api_key', label: 'Resend APIキー' },
  { key: 'mail_from', label: '送信元メールアドレス(MAIL_FROM)' },
  { key: 'agency_api_key', label: '代理店連携APIキー(外部の代理店システムからの受信用)' },
  { key: 'external_agency_system_base_url', label: '外部代理店システムのURL(例: https://sengoku-ai.com)' },
  { key: 'external_agency_system_api_key', label: '外部代理店システムAPIキー(こちらから送信する際に使用)' },
];

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [inputs, setInputs] = useState<Partial<Record<keyof AdminSettings, string>>>({});
  const [message, setMessage] = useState<string | null>(null);

  const [bankTransferEnabled, setBankTransferEnabled] = useState(false);
  const [bankTransferInfo, setBankTransferInfo] = useState('');
  const [bankTransferMessage, setBankTransferMessage] = useState<string | null>(null);

  function load() {
    fetchAdminSettings().then((d) => setSettings(d.settings));
  }
  useEffect(load, []);

  function loadBankTransfer() {
    fetchBankTransferSettings().then((d) => {
      setBankTransferEnabled(d.enabled);
      setBankTransferInfo(d.info);
    });
  }
  useEffect(loadBankTransfer, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await updateAdminSettings(inputs);
    setInputs({});
    setMessage('保存しました');
    load();
  }

  async function handleBankTransferSubmit(e: React.FormEvent) {
    e.preventDefault();
    await updateBankTransferSettings({ enabled: bankTransferEnabled, info: bankTransferInfo });
    setBankTransferMessage('保存しました');
    loadBankTransfer();
  }

  return (
    <div>
      <h1>決済・メール設定</h1>
      <p>Stripe/Resendの連携情報です。空欄のまま保存すると既存の値は変更されません。</p>

      {settings && (
        <form onSubmit={handleSubmit} className="admin-form-card">
          {FIELDS.map((field) => (
            <label key={field.key}>
              {field.label}
              {settings[field.key].configured && <span> (設定済み: {settings[field.key].masked})</span>}
              <input
                type="text"
                value={inputs[field.key] ?? ''}
                onChange={(e) => setInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={settings[field.key].configured ? '変更する場合のみ入力' : '未設定'}
              />
            </label>
          ))}
          {message && <p>{message}</p>}
          <button type="submit" className="btn-primary">
            保存する
          </button>
        </form>
      )}

      <h2>銀行振込設定</h2>
      <p>会員が注文時に銀行振込を選べるようにするかどうかと、案内文を設定します。入金確認は注文管理画面から手動で行います。</p>
      <form onSubmit={handleBankTransferSubmit} className="admin-form-card">
        <label>
          <input type="checkbox" checked={bankTransferEnabled} onChange={(e) => setBankTransferEnabled(e.target.checked)} />
          銀行振込を有効にする
        </label>
        <label>
          振込先案内文(お客様への案内メール・画面にそのまま表示されます)
          <textarea
            value={bankTransferInfo}
            onChange={(e) => setBankTransferInfo(e.target.value)}
            rows={5}
            placeholder={'銀行名: ○○銀行\n支店名: ○○支店\n口座種別: 普通\n口座番号: 1234567\n口座名義: カ)センゴクラクイチラクザ'}
          />
        </label>
        {bankTransferMessage && <p>{bankTransferMessage}</p>}
        <button type="submit" className="btn-primary">
          保存する
        </button>
      </form>
    </div>
  );
}
