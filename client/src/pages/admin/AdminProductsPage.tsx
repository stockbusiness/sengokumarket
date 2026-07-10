import { useEffect, useRef, useState } from 'react';
import {
  createAdminProduct,
  deleteAdminProduct,
  fetchAdminProducts,
  updateAdminProduct,
  uploadAdminProductImage,
  type AdminProduct,
} from '../../lib/adminApi';
import StatusBadge from '../../components/StatusBadge';
import EmptyState from '../../components/EmptyState';

const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'];
const STATUSES = ['draft', 'published', 'archived'];

type StatusMessage = { type: 'success' | 'error'; text: string };

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
  const [uploadingNew, setUploadingNew] = useState(false);
  const [uploadingRowId, setUploadingRowId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const imagesTextareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

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

  // 保存の成否がその場で分かるよう、一定時間で自動的に消える通知を出す
  // (これまでインライン編集の保存はサイレントで、失敗しても何も表示されなかった)。
  function notify(type: StatusMessage['type'], text: string) {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage((cur) => (cur?.text === text ? null : cur)), 4000);
  }

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

  async function handleUploadForNewProduct(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadingNew(true);
    try {
      for (const file of Array.from(files)) {
        const { url } = await uploadAdminProductImage(file);
        setImagesText((prev) => (prev.trim() ? `${prev}\n${url}` : url));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '画像のアップロードに失敗しました');
    } finally {
      setUploadingNew(false);
    }
  }

  async function updateStatus(product: AdminProduct, status: string) {
    try {
      await updateAdminProduct(product.id, { status });
      notify('success', `「${product.name}」のステータスを更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'ステータスの更新に失敗しました');
    }
  }

  async function updateField(product: AdminProduct, field: 'name' | 'category' | 'itemType' | 'basePrice', value: string | number) {
    try {
      await updateAdminProduct(product.id, { [field]: value });
      notify('success', `「${product.name}」を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '更新に失敗しました');
    }
  }

  async function handleDelete(product: AdminProduct) {
    if (!window.confirm(`「${product.name}」を削除します。よろしいですか？(元に戻せません)`)) return;
    try {
      await deleteAdminProduct(product.id);
      notify('success', `「${product.name}」を削除しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '削除に失敗しました');
    }
  }

  async function updateStock(product: AdminProduct, variantId: string, variantName: string, stock: number) {
    try {
      await updateAdminProduct(product.id, { variants: [{ id: variantId, stock }] });
      notify('success', `「${product.name}」の${variantName}の在庫数を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '在庫数の更新に失敗しました');
    }
  }

  async function updateImages(product: AdminProduct, text: string) {
    try {
      await updateAdminProduct(product.id, { images: parseImagesText(text) });
      notify('success', `「${product.name}」の商品画像を更新しました`);
      load();
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '商品画像の更新に失敗しました');
    }
  }

  async function handleUploadForRow(product: AdminProduct, files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadingRowId(product.id);
    try {
      const textarea = imagesTextareaRefs.current[product.id];
      let current = textarea?.value ?? product.images.join('\n');
      for (const file of Array.from(files)) {
        const { url } = await uploadAdminProductImage(file);
        current = current.trim() ? `${current}\n${url}` : url;
      }
      if (textarea) textarea.value = current;
      await updateImages(product, current);
    } catch (e) {
      notify('error', e instanceof Error ? e.message : '画像のアップロードに失敗しました');
    } finally {
      setUploadingRowId(null);
    }
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
            商品画像を選択してアップロード(先頭が一覧・共有時のサムネイルになります)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={uploadingNew}
              onChange={(e) => handleUploadForNewProduct(e.target.files)}
            />
          </label>
          {uploadingNew && <p>アップロード中です...</p>}
          <label>
            商品画像URL(アップロード済みの画像が自動で入ります。外部URLを直接指定することもできます)
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
      {statusMessage && <p className={statusMessage.type === 'error' ? 'checkout-error' : 'admin-status-success'}>{statusMessage.text}</p>}

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
                          onBlur={(e) => updateStock(p, v.id, v.name, Number(e.target.value))}
                        />
                      </div>
                    ))}
                  </td>
                  <td>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      disabled={uploadingRowId === p.id}
                      onChange={(e) => handleUploadForRow(p, e.target.files)}
                    />
                    {uploadingRowId === p.id && <p>アップロード中...</p>}
                    <textarea
                      ref={(el) => {
                        imagesTextareaRefs.current[p.id] = el;
                      }}
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
