import { useEffect, useState } from 'react';
import {
  createAdminProduct,
  fetchAdminProducts,
  updateAdminProduct,
  type AdminProduct,
} from '../../lib/adminApi';

const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'];
const STATUSES = ['draft', 'published', 'archived'];

export default function AdminProductsPage() {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [category, setCategory] = useState('');
  const [itemType, setItemType] = useState('nft');
  const [basePrice, setBasePrice] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchAdminProducts().then((d) => setProducts(d.products));
  }

  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createAdminProduct({ name, slug, category, itemType, basePrice, status: 'draft' });
      setName('');
      setSlug('');
      setCategory('');
      setBasePrice(0);
      setShowForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '作成に失敗しました');
    }
  }

  async function toggleStatus(product: AdminProduct) {
    const next = product.status === 'published' ? 'draft' : 'published';
    await updateAdminProduct(product.id, { status: next });
    load();
  }

  async function updateStock(product: AdminProduct, variantId: string, stock: number) {
    await updateAdminProduct(product.id, {
      variants: [{ id: variantId, stock }],
    });
    load();
  }

  return (
    <div>
      <h1>商品管理</h1>
      <button type="button" onClick={() => setShowForm((v) => !v)}>
        {showForm ? 'キャンセル' : '新規作成'}
      </button>

      {showForm && (
        <form onSubmit={handleCreate}>
          <label>
            商品名
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            slug
            <input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} required />
          </label>
          <label>
            カテゴリ
            <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} required />
          </label>
          <label>
            商品タイプ
            <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            価格
            <input type="number" value={basePrice} onChange={(e) => setBasePrice(Number(e.target.value))} required />
          </label>
          {error && <p className="checkout-error">{error}</p>}
          <button type="submit">作成する</button>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>商品名</th>
            <th>slug</th>
            <th>タイプ</th>
            <th>価格</th>
            <th>ステータス</th>
            <th>バリエーション/在庫</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.slug}</td>
              <td>{p.itemType}</td>
              <td>{p.basePrice.toLocaleString()}円</td>
              <td>
                <button type="button" onClick={() => toggleStatus(p)}>
                  {STATUSES.includes(p.status) ? p.status : p.status}(切替)
                </button>
              </td>
              <td>
                {p.variants.map((v) => (
                  <div key={v.id}>
                    {v.name}:
                    <input
                      type="number"
                      defaultValue={v.stock}
                      style={{ width: '4em' }}
                      onBlur={(e) => updateStock(p, v.id, Number(e.target.value))}
                    />
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
