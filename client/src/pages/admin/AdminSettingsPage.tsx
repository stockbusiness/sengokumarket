import { useEffect, useState } from 'react';
import { fetchAdminSettings, updateAdminSettings, type AdminSettings } from '../../lib/adminApi';

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

  function load() {
    fetchAdminSettings().then((d) => setSettings(d.settings));
  }
  useEffect(load, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await updateAdminSettings(inputs);
    setInputs({});
    setMessage('保存しました');
    load();
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
    </div>
  );
}
