import { useEffect, useState } from 'react';
import {
  fetchAdminIntegrationPreflight,
  fetchAdminWalletClaimPreflight,
  updateAdminIntegrationStage,
  type IntegrationPreflightReport,
  type WalletClaimPreflightReport,
} from '../../features/admin-integration-preflight/api';

const STAGE_OPTIONS = ['dry_run', 'staging', 'production'] as const;

function boolLabel(value: boolean | null): string {
  if (value === null) return '判定不能';
  return value ? 'OK' : 'NG';
}

// 本番安定化指示書Stage8(11章)・Stage11(14.1「Integration Preflight」画面): 千ノ国全体連携を
// 有効化する前に、必須設定・HMAC自己診断・送信先への疎通・backlog状況を1画面で確認できるようにする。
export default function AdminIntegrationPreflightPage() {
  const [report, setReport] = useState<IntegrationPreflightReport | null>(null);
  const [walletClaimReport, setWalletClaimReport] = useState<WalletClaimPreflightReport | null>(null);
  const [selectedStage, setSelectedStage] = useState<(typeof STAGE_OPTIONS)[number]>('dry_run');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminIntegrationPreflight().then((d) => {
      setReport(d.report);
      if (d.report.stage !== 'disabled') setSelectedStage(d.report.stage);
    });
    fetchAdminWalletClaimPreflight().then((d) => setWalletClaimReport(d.report));
  }
  useEffect(load, []);

  async function applyStage() {
    setError(null);
    setMessage(null);
    try {
      const res = await updateAdminIntegrationStage(selectedStage);
      setMessage(`段階を${res.stage}へ変更しました`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '段階の変更に失敗しました');
    }
  }

  if (!report) return <p>読み込み中...</p>;

  return (
    <div>
      <h1>外部連携 Preflight・段階設定</h1>
      <p>
        千ノ国全体連携(共通ID・紹介連携・OVEウォレット等)を有効化する前に確認すべき項目です。
        マスタースイッチ(環境変数)がOFFの間は、ここで段階を変更しても実際の送信は一切発生しません。
      </p>

      <div className="admin-table-card">
        <table>
          <tbody>
            <tr>
              <th>マスタースイッチ(環境変数)</th>
              <td>{report.featureFlagEnabled ? '有効' : '無効'}</td>
            </tr>
            <tr>
              <th>現在の段階</th>
              <td>{report.stage}</td>
            </tr>
            <tr>
              <th>使用中の送信先</th>
              <td>{report.usedDestinations.length > 0 ? report.usedDestinations.join(', ') : 'なし'}</td>
            </tr>
            <tr>
              <th>有効化準備</th>
              <td>{report.readyForActivation ? '準備完了' : '未完了'}</td>
            </tr>
            <tr>
              <th>未送信件数(backlog)</th>
              <td>{report.backlogCount}</td>
            </tr>
            <tr>
              <th>dead件数</th>
              <td>{report.deadCount}</td>
            </tr>
            <tr>
              <th>blocked件数</th>
              <td>{report.blockedCount}</td>
            </tr>
            <tr>
              <th>有効な連携ルール数</th>
              <td>{report.productRuleCount}</td>
            </tr>
            <tr>
              <th>Wallet Claim Feature Flag不整合</th>
              <td>
                {report.walletClaimFlagInconsistentRuleCount > 0
                  ? `⚠ ${report.walletClaimFlagInconsistentRuleCount}件(デジタル会員証ルールが有効なのにENABLE_WALLET_CLAIMが無効です)`
                  : 'なし'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="admin-table-card">
        <h2>必須設定</h2>
        <table>
          <thead>
            <tr>
              <th>設定キー</th>
              <th>設定済み</th>
              <th>形式</th>
            </tr>
          </thead>
          <tbody>
            {report.settingChecks.map((c) => (
              <tr key={c.key}>
                <td>{c.key}</td>
                <td>{c.configured ? '設定済み' : '未設定'}</td>
                <td>{boolLabel(c.formatValid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-table-card">
        <h2>HMAC自己診断</h2>
        <table>
          <thead>
            <tr>
              <th>対象</th>
              <th>設定済み</th>
              <th>結果</th>
            </tr>
          </thead>
          <tbody>
            {report.hmacSelfTests.map((t) => (
              <tr key={t.target}>
                <td>{t.target}</td>
                <td>{t.configured ? '設定済み' : '未設定'}</td>
                <td>{boolLabel(t.passed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-table-card">
        <h2>疎通確認</h2>
        <table>
          <thead>
            <tr>
              <th>対象</th>
              <th>URL</th>
              <th>結果</th>
            </tr>
          </thead>
          <tbody>
            {report.connectionTests.map((t) => (
              <tr key={t.target}>
                <td>{t.target}</td>
                <td>{t.baseUrl ?? '未設定'}</td>
                <td>
                  {boolLabel(t.ok)}
                  {t.error && <span className="admin-muted"> ({t.error})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-table-card">
        <h2>段階変更</h2>
        {error && <p className="checkout-error">{error}</p>}
        {message && <p>{message}</p>}
        <label>
          変更後の段階
          <select value={selectedStage} onChange={(e) => setSelectedStage(e.target.value as (typeof STAGE_OPTIONS)[number])}>
            {STAGE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-primary btn-small" onClick={applyStage}>
          変更する
        </button>
        <p className="admin-muted">staging/productionへの変更は、有効化準備が完了していないと拒否されます。</p>
      </div>

      {walletClaimReport && (
        <div className="admin-table-card">
          <h2>Wallet Claim / デジタル会員証送付 Preflight</h2>
          <table>
            <tbody>
              <tr>
                <th>Wallet Claim(ENABLE_WALLET_CLAIM)</th>
                <td>{walletClaimReport.walletClaimEnabled ? '有効' : '無効'}</td>
              </tr>
              <tr>
                <th>Delivery送信(ENABLE_DIGITAL_COLLECTIBLE_DELIVERY)</th>
                <td>{walletClaimReport.digitalCollectibleDeliveryEnabled ? '有効' : '無効'}</td>
              </tr>
              <tr>
                <th>Wallet Claim有効化可否(walletClaimReady)</th>
                <td>{walletClaimReport.walletClaimReady ? '準備完了' : '未完了'}</td>
              </tr>
              <tr>
                <th>Delivery有効化可否(collectibleDeliveryReady)</th>
                <td>{walletClaimReport.collectibleDeliveryReady ? '準備完了' : '未完了'}</td>
              </tr>
              <tr>
                <th>総合(overallReady)</th>
                <td>{walletClaimReport.overallReady ? '準備完了' : '未完了'}</td>
              </tr>
              <tr>
                <th>有効なdigital_collectibleルール数</th>
                <td>{walletClaimReport.enabledDigitalCollectibleRuleCount}</td>
              </tr>
              <tr>
                <th>asset_code未設定ルール数</th>
                <td>{walletClaimReport.rulesMissingAssetCode}</td>
              </tr>
              <tr>
                <th>requireCommonUserId=falseのルール数</th>
                <td>{walletClaimReport.rulesWithoutRequireCommonUserId}</td>
              </tr>
              <tr>
                <th>itemType≠nft商品への設定数</th>
                <td>{walletClaimReport.rulesOnNonNftProduct}</td>
              </tr>
              <tr>
                <th>rarity未設定ルール数</th>
                <td>{walletClaimReport.rulesMissingRarity}</td>
              </tr>
              <tr>
                <th>送信先不整合ルール数(digital_collectibleなのにove-wallet以外)</th>
                <td>{walletClaimReport.rulesWithInvalidDestination}</td>
              </tr>
              <tr>
                <th>必須migration</th>
                <td>{walletClaimReport.migrationsOk ? '適用済み' : `不足: ${walletClaimReport.missingMigrations.join(', ')}`}</td>
              </tr>
              <tr>
                <th>CRON_SECRET</th>
                <td>{walletClaimReport.cronSecretConfigured ? '設定済み' : '未設定'}</td>
              </tr>
              <tr>
                <th>Scheduler heartbeat(主系・直近10分以内)</th>
                <td>
                  {walletClaimReport.schedulerHeartbeatOk ? 'OK' : 'NG'}
                  {walletClaimReport.schedulerHeartbeatLastSuccessAt && (
                    <span className="admin-muted"> (最終成功: {new Date(walletClaimReport.schedulerHeartbeatLastSuccessAt).toLocaleString('ja-JP')})</span>
                  )}
                </td>
              </tr>
              <tr>
                <th>未送信/dead/blocked件数</th>
                <td>
                  {walletClaimReport.pendingCount} / {walletClaimReport.deadCount} / {walletClaimReport.blockedCount}
                </td>
              </tr>
            </tbody>
          </table>

          <h3>設定状況</h3>
          <table>
            <thead>
              <tr>
                <th>設定キー</th>
                <th>設定済み</th>
              </tr>
            </thead>
            <tbody>
              {walletClaimReport.settingChecks.map((c) => (
                <tr key={c.key}>
                  <td>{c.key}</td>
                  <td>{c.configured ? '設定済み' : '未設定'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {walletClaimReport.issues.length > 0 && (
            <>
              <h3>指摘事項</h3>
              <ul>
                {walletClaimReport.issues.map((issue) => (
                  <li key={issue.code}>⚠ {issue.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
