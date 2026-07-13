import { Fragment, useEffect, useState } from 'react';
import {
  fetchAdminSettings,
  fetchBankTransferSettings,
  testAgencyKeyConnection,
  testExternalAgencyConnection,
  testNftMintConnection,
  testResendConnection,
  testStripeConnection,
  updateAdminSettings,
  updateBankTransferSettings,
  type AdminSettings,
  type ConnectionTestResult,
} from '../../lib/adminApi';

const FIELDS: { key: keyof AdminSettings; label: string; helpText?: string; generatable?: boolean }[] = [
  { key: 'stripe_secret_key', label: 'Stripeシークレットキー' },
  {
    key: 'stripe_webhook_secret',
    label: 'Stripe Webhookシークレット',
    helpText: `Webhook URL: ${window.location.origin}/api/stripe/webhook (Stripeダッシュボードの「Webhookエンドポイントを追加」でこのURLを登録し、発行されたシークレットをこちらに入力してください)`,
  },
  { key: 'stripe_public_key', label: 'Stripe公開可能キー' },
  { key: 'resend_api_key', label: 'Resend APIキー' },
  { key: 'mail_from', label: '送信元メールアドレス(MAIL_FROM)' },
  {
    key: 'agency_api_key',
    label: '代理店連携APIキー(外部の代理店システムからの受信用)',
    helpText: 'このキーはこちらで発行し、外部の代理店システム側の管理画面に設定してもらう値です。下のボタンで生成できます。',
    generatable: true,
  },
  { key: 'external_agency_system_base_url', label: '外部代理店システムのURL(例: https://sengoku-ai.com)' },
  {
    key: 'external_agency_system_api_key',
    label: '外部代理店システムAPIキー(こちらから送信する際に使用)',
    helpText: 'このキーは外部の代理店システム側で発行される値です。先方から共有を受けて入力してください。',
  },
  {
    key: 'nft_mint_api_key',
    label: 'NFT Mint APIキー(仕様書外の拡張・NFT自動発行)',
    helpText: '外部のNFT発行サービス(NFT_MINT_PROVIDER環境変数で選択)の認証キーです。fakeプロバイダー(既定)ではこのキーは使用されません。',
  },
];

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

type TestState = 'testing' | ConnectionTestResult | null;

function TestResultText({ state }: { state: TestState }) {
  if (state === 'testing') return <span className="admin-settings-help">テスト中...</span>;
  if (!state) return null;
  return <p className={state.ok ? 'admin-settings-test-ok' : 'admin-settings-test-ng'}>{state.message}</p>;
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [inputs, setInputs] = useState<Partial<Record<keyof AdminSettings, string>>>({});
  const [message, setMessage] = useState<string | null>(null);

  const [bankTransferEnabled, setBankTransferEnabled] = useState(false);
  const [bankTransferInfo, setBankTransferInfo] = useState('');
  const [bankTransferMessage, setBankTransferMessage] = useState<string | null>(null);

  const [stripeTest, setStripeTest] = useState<TestState>(null);
  const [agencyKeyTest, setAgencyKeyTest] = useState<TestState>(null);
  const [externalAgencyTest, setExternalAgencyTest] = useState<TestState>(null);
  const [resendTestTo, setResendTestTo] = useState('');
  const [resendTest, setResendTest] = useState<TestState>(null);
  const [nftMintTest, setNftMintTest] = useState<TestState>(null);

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

  async function handleTestStripe() {
    setStripeTest('testing');
    setStripeTest(await testStripeConnection(inputs.stripe_secret_key ?? ''));
  }

  async function handleTestResend() {
    if (!resendTestTo) return;
    setResendTest('testing');
    setResendTest(await testResendConnection(inputs.resend_api_key ?? '', inputs.mail_from ?? '', resendTestTo));
  }

  async function handleTestExternalAgency() {
    setExternalAgencyTest('testing');
    setExternalAgencyTest(
      await testExternalAgencyConnection(inputs.external_agency_system_base_url ?? '', inputs.external_agency_system_api_key ?? ''),
    );
  }

  async function handleTestAgencyKey() {
    setAgencyKeyTest('testing');
    setAgencyKeyTest(await testAgencyKeyConnection(inputs.agency_api_key ?? ''));
  }

  async function handleTestNftMint() {
    setNftMintTest('testing');
    setNftMintTest(await testNftMintConnection(inputs.nft_mint_api_key ?? ''));
  }

  return (
    <div>
      <h1>決済・メール設定</h1>
      <p>Stripe/Resendの連携情報です。空欄のまま保存すると既存の値は変更されません。</p>

      {settings && (
        <form onSubmit={handleSubmit} className="admin-form-card">
          {FIELDS.map((field) => (
            <Fragment key={field.key}>
              <label>
                {field.label}
                {settings[field.key].configured && <span> (設定済み: {settings[field.key].masked})</span>}
                {field.helpText && <span className="admin-settings-help">{field.helpText}</span>}
                <input
                  type="text"
                  value={inputs[field.key] ?? ''}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={settings[field.key].configured ? '変更する場合のみ入力' : '未設定'}
                />
                {field.generatable && (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => setInputs((prev) => ({ ...prev, [field.key]: generateApiKey() }))}
                  >
                    ランダムなキーを生成
                  </button>
                )}
              </label>

              {field.key === 'stripe_secret_key' && (
                <div className="admin-settings-test">
                  <button type="button" className="btn-secondary btn-small" onClick={handleTestStripe}>
                    接続テスト
                  </button>
                  <TestResultText state={stripeTest} />
                </div>
              )}

              {field.key === 'mail_from' && (
                <div className="admin-settings-test">
                  <label>
                    テスト送信先メールアドレス
                    <input type="email" value={resendTestTo} onChange={(e) => setResendTestTo(e.target.value)} placeholder="test@example.com" />
                  </label>
                  <button type="button" className="btn-secondary btn-small" onClick={handleTestResend} disabled={!resendTestTo}>
                    テストメール送信
                  </button>
                  <TestResultText state={resendTest} />
                </div>
              )}

              {field.key === 'agency_api_key' && (
                <div className="admin-settings-test">
                  <button type="button" className="btn-secondary btn-small" onClick={handleTestAgencyKey}>
                    接続テスト
                  </button>
                  <TestResultText state={agencyKeyTest} />
                </div>
              )}

              {field.key === 'external_agency_system_api_key' && (
                <div className="admin-settings-test">
                  <button type="button" className="btn-secondary btn-small" onClick={handleTestExternalAgency}>
                    接続テスト
                  </button>
                  <TestResultText state={externalAgencyTest} />
                </div>
              )}

              {field.key === 'nft_mint_api_key' && (
                <div className="admin-settings-test">
                  <button type="button" className="btn-secondary btn-small" onClick={handleTestNftMint}>
                    接続テスト
                  </button>
                  <TestResultText state={nftMintTest} />
                </div>
              )}
            </Fragment>
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
