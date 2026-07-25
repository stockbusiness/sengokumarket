import { useEffect, useState } from 'react';
import {
  fetchAdminIntegrationPreflight,
  updateAdminIntegrationStage,
  type IntegrationPreflightReport,
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
  const [selectedStage, setSelectedStage] = useState<(typeof STAGE_OPTIONS)[number]>('dry_run');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetchAdminIntegrationPreflight().then((d) => {
      setReport(d.report);
      if (d.report.stage !== 'disabled') setSelectedStage(d.report.stage);
    });
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
    </div>
  );
}
