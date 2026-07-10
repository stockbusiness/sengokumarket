import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { deleteAdminProduct, fetchAdminProducts, type AdminProduct } from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

type StatusMessage = { type: 'success' | 'error'; text: string };

export default function AdminProductsPage() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  function load() {
    fetchAdminProducts().then((d) => setProducts(d.products));
  }

  useEffect(load, []);

  // 新規作成・編集ページからの遷移時に、そちら側での保存結果をここで表示する。
  useEffect(() => {
    const state = location.state as { message?: string } | null;
    if (state?.message) {
      setStatusMessage({ type: 'success', text: state.message });
      navigate(location.pathname, { replace: true, state: null });
      const timer = setTimeout(() => setStatusMessage(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [location, navigate]);

  async function handleDelete(product: AdminProduct) {
    if (!window.confirm(`「${product.name}」を削除します。よろしいですか？(元に戻せません)`)) return;
    try {
      await deleteAdminProduct(product.id);
      setStatusMessage({ type: 'success', text: `「${product.name}」を削除しました` });
      load();
    } catch (e) {
      setStatusMessage({ type: 'error', text: e instanceof Error ? e.message : '削除に失敗しました' });
    }
  }

  function stockSummary(product: AdminProduct): string {
    if (product.variants.length === 0) return 'バリエーション無し';
    return product.variants.map((v) => `${v.name}:${v.stock}`).join(' / ');
  }

  return (
    <div>
      <h1>商品管理</h1>
      <Link to="/admin/products/new" className="btn-primary btn-small">
        新規登録
      </Link>

      {statusMessage && (
        <p className={statusMessage.type === 'error' ? 'checkout-error' : 'admin-status-success'}>{statusMessage.text}</p>
      )}

      {products.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだ商品がありません" actionLabel="新規登録" onAction={() => navigate('/admin/products/new')} />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>商品画像</th>
                <th>商品名</th>
                <th>slug</th>
                <th>タイプ</th>
                <th>価格</th>
                <th>ステータス</th>
                <th>バリエーション/在庫</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.images[0] ? (
                      <img src={p.images[0]} alt={p.name} className="admin-product-thumbnail" />
                    ) : (
                      <span className="admin-product-thumbnail admin-product-thumbnail--empty" />
                    )}
                  </td>
                  <td>{p.name}</td>
                  <td>{p.slug}</td>
                  <td>{p.itemType}</td>
                  <td>{p.basePrice.toLocaleString()}円</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>
                    {p.variants.length === 0 ? (
                      <span className="checkout-error">バリエーションが無く購入できません</span>
                    ) : (
                      stockSummary(p)
                    )}
                  </td>
                  <td>
                    <Link to={`/admin/products/${p.id}/edit`} className="btn-secondary btn-small">
                      編集
                    </Link>{' '}
                    <button type="button" className="btn-secondary btn-small" onClick={() => handleDelete(p)}>
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
