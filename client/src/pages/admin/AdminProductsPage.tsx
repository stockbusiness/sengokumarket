import { useEffect, useState } from 'react';
import {
  createAdminProduct,
  deleteAdminProduct,
  fetchAdminProducts,
  updateAdminProduct,
  type AdminProduct,
} from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

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
  const [imagesText, setImagesText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function parseImagesText(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function load() {
    fetchAdminProducts().then((d) => setProducts(d.products));
  }

  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createAdminProduct({ name, slug, category, itemType, basePrice, status: 'draft', images: parseImagesText(imagesText) });
      setName('');
      setSlug('');
      setCategory('');
      setBasePrice(0);
      setImagesText('');
      setShowForm(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '作成に失敗しました');
    }
  }

  async function updateStatus(product: AdminProduct, status: string) {
    await updateAdminProduct(product.id, { status });
    load();
  }

  async function updateField(product: AdminProduct, field: 'name' | 'category' | 'itemType' | 'basePrice', value: string | number) {
    await updateAdminProduct(product.id, { [field]: value });
    load();
  }

  async function handleDelete(product: AdminProduct) {
    if (!window.confirm(`「${product.name}」を削除します。よろしいですか？(元に戻せません)`)) return;
    setError(null);
    try {
      await deleteAdminProduct(product.id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました');
    }
  }

  async function updateStock(product: AdminProduct, variantId: string, stock: number) {
    await updateAdminProduct(product.id, {
      variants: [{ id: variantId, stock }],
    });
    load();
  }

  async function updateImages(product: AdminProduct, text: string) {
    await updateAdminProduct(product.id, { images: parseImagesText(text) });
    load();
  }

  return (
    <div>
      <h1>商品管理</h1>
      <button
        type="button"
        className={showForm ? 'btn-secondary btn-small' : 'btn-primary btn-small'}
        onClick={() => setShowForm((v) => !v)}
      >
        {showForm ? 'キャンセル' : '新規作成'}
      </button>

      {showForm && (
        <form onSubmit={handleCreate} className="admin-form-card">
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
          <label>
            商品画像(画像URLを1行に1つずつ入力。先頭が一覧・共有時のサムネイルになります)
            <textarea
              value={imagesText}
              onChange={(e) => setImagesText(e.target.value)}
              rows={3}
              placeholder={'https://example.com/image1.jpg\nhttps://example.com/image2.jpg'}
            />
          </label>
          {error && <p className="checkout-error">{error}</p>}
          <button type="submit" className="btn-primary">
            作成する
          </button>
        </form>
      )}

      {error && !showForm && <p className="checkout-error">{error}</p>}

      {products.length === 0 ? (
        <div className="admin-table-card">
          <EmptyState message="まだ商品がありません" actionLabel="新規作成" onAction={() => setShowForm(true)} />
        </div>
      ) : (
        <div className="admin-table-card">
          <table>
            <thead>
              <tr>
                <th>商品名</th>
                <th>slug</th>
                <th>タイプ</th>
                <th>価格</th>
                <th>ステータス</th>
                <th>バリエーション/在庫</th>
                <th>商品画像</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="text"
                      className="admin-inline-input--text"
                      defaultValue={p.name}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && updateField(p, 'name', e.target.value.trim())}
                    />
                  </td>
                  <td>{p.slug}</td>
                  <td>
                    <select value={p.itemType} onChange={(e) => updateField(p, 'itemType', e.target.value)}>
                      {ITEM_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      className="admin-inline-input"
                      defaultValue={p.basePrice}
                      onBlur={(e) => Number(e.target.value) !== p.basePrice && updateField(p, 'basePrice', Number(e.target.value))}
                    />
                    円
                  </td>
                  <td>
                    <StatusBadge status={p.status} />{' '}
                    <select value={p.status} onChange={(e) => updateStatus(p, e.target.value)}>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {p.variants.map((v) => (
                      <div key={v.id}>
                        {v.name}:
                        <input
                          type="number"
                          className="admin-inline-input"
                          defaultValue={v.stock}
                          onBlur={(e) => updateStock(p, v.id, Number(e.target.value))}
                        />
                      </div>
                    ))}
                  </td>
                  <td>
                    <textarea
                      className="admin-inline-textarea"
                      defaultValue={p.images.join('\n')}
                      rows={2}
                      onBlur={(e) => updateImages(p, e.target.value)}
                      placeholder="画像URL(1行に1つ)"
                    />
                  </td>
                  <td>
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
