import { useEffect, useState } from 'react';
import {
  activateAdminCoupon,
  createAdminCoupon,
  deactivateAdminCoupon,
  deleteAdminCoupon,
  fetchAdminCoupons,
  type AdminCoupon,
} from '../../lib/adminApi';
import EmptyState from '../../components/EmptyState';

function formatDiscount(coupon: AdminCoupon): string {
  return coupon.discountType === 'fixed' ? `${coupon.discountAmount?.toLocaleString()}円引き` : `${coupon.discountPercentage}%引き`;
}

// 仕様書外の拡張: クーポン機能の管理画面(一覧・新規作成・有効化/無効化・削除)。
// 対象商品・対象代理店・対象顧客の詳細設定はこの画面では扱わず、まずは全体対象のクーポンを
// シンプルに作成できることを優先する(未対応事項として実装報告に記載)。
export default function AdminCouponsPage() {
  const [coupons, setCoupons] = useState<AdminCoupon[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [discountType, setDiscountType] = useState<'fixed' | 'percentage'>('fixed');
  const [discountAmount, setDiscountAmount] = useState('');
  const [discountPercentage, setDiscountPercentage] = useState('');
  const [maximumDiscountAmount, setMaximumDiscountAmount] = useState('');
  const [minimumOrderAmount, setMinimumOrderAmount] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [totalUsageLimit, setTotalUsageLimit] = useState('');
  const [perCustomerUsageLimit, setPerCustomerUsageLimit] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    fetchAdminCoupons().then((d) => setCoupons(d.coupons));
  }
  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAdminCoupon({
        name,
        code: code || null,
        discountType,
        discountAmount: discountType === 'fixed' ? Number(discountAmount) : null,
        discountPercentage: discountType === 'percentage' ? Number(discountPercentage) : null,
        maximumDiscountAmount: maximumDiscountAmount ? Number(maximumDiscountAmount) : null,
        minimumOrderAmount: minimumOrderAmount ? Number(minimumOrderAmount) : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        totalUsageLimit: totalUsageLimit ? Number(totalUsageLimit) : null,
        perCustomerUsageLimit: Number(perCustomerUsageLimit) || 1,
      });
      setName('');
      setCode('');
      setDiscountAmount('');
      setDiscountPercentage('');
      setMaximumDiscountAmount('');
      setMinimumOrderAmount('');
      setExpiresAt('');
      setTotalUsageLimit('');
      setPerCustomerUsageLimit('1');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'クーポンの作成に失敗しました');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(coupon: AdminCoupon) {
    if (coupon.isActive) {
      await deactivateAdminCoupon(coupon.id);
    } else {
      await activateAdminCoupon(coupon.id);
    }
    load();
  }

  async function remove(coupon: AdminCoupon) {
    await deleteAdminCoupon(coupon.id);
    load();
  }

  if (coupons === null) return <p>読み込み中です...</p>;

  return (
    <div>
      <h1>クーポン管理</h1>

      <form onSubmit={handleCreate} className="admin-form-card">
        <label>
          クーポン名
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>

        <label>
          クーポンコード(空欄なら自動生成)
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="例: AIART-5000" />
        </label>

        <label>
          割引種別
          <select value={discountType} onChange={(e) => setDiscountType(e.target.value as 'fixed' | 'percentage')}>
            <option value="fixed">固定額</option>
            <option value="percentage">割引率</option>
          </select>
        </label>

        {discountType === 'fixed' ? (
          <label>
            割引額(円)
            <input type="number" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} min={1} required />
          </label>
        ) : (
          <label>
            割引率(%)
            <input type="number" value={discountPercentage} onChange={(e) => setDiscountPercentage(e.target.value)} min={1} max={100} required />
          </label>
        )}

        <label>
          最大割引額(任意・円)
          <input type="number" value={maximumDiscountAmount} onChange={(e) => setMaximumDiscountAmount(e.target.value)} min={0} />
        </label>

        <label>
          最低購入金額(任意・円)
          <input type="number" value={minimumOrderAmount} onChange={(e) => setMinimumOrderAmount(e.target.value)} min={0} />
        </label>

        <label>
          有効期限(任意)
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>

        <label>
          総利用回数(任意・空欄なら無制限)
          <input type="number" value={totalUsageLimit} onChange={(e) => setTotalUsageLimit(e.target.value)} min={1} />
        </label>

        <label>
          顧客ごとの利用回数
          <input type="number" value={perCustomerUsageLimit} onChange={(e) => setPerCustomerUsageLimit(e.target.value)} min={1} />
        </label>

        {error && <p className="checkout-error">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          クーポンを作成する
        </button>
      </form>

      {coupons.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだクーポンがありません" />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>クーポン名</th>
                <th>コード</th>
                <th>割引内容</th>
                <th>利用数</th>
                <th>有効期限</th>
                <th>状態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.code}</td>
                  <td>{formatDiscount(c)}</td>
                  <td>
                    {c.usedCount}
                    {c.totalUsageLimit ? ` / ${c.totalUsageLimit}` : ''}
                  </td>
                  <td>{c.expiresAt ? new Date(c.expiresAt).toLocaleString('ja-JP') : '無期限'}</td>
                  <td>{c.isActive ? '有効' : '無効'}</td>
                  <td>
                    <button type="button" className="btn-secondary btn-small" onClick={() => toggleActive(c)}>
                      {c.isActive ? '無効化' : '有効化'}
                    </button>{' '}
                    <button type="button" className="btn-secondary btn-small" onClick={() => remove(c)}>
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
