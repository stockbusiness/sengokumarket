import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchProducts, type ProductSummary } from '../lib/api';

type SortKey = 'name' | 'price_asc' | 'price_desc';

export default function ProductListPage() {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<SortKey>('name');

  useEffect(() => {
    fetchProducts()
      .then((data) => setProducts(data.products))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category))).sort(), [products]);

  const visibleProducts = useMemo(() => {
    const keywordLower = keyword.trim().toLowerCase();
    const filtered = products.filter((p) => {
      const matchesKeyword = !keywordLower || p.name.toLowerCase().includes(keywordLower);
      const matchesCategory = !category || p.category === category;
      return matchesKeyword && matchesCategory;
    });

    const sorted = [...filtered];
    if (sort === 'price_asc') sorted.sort((a, b) => a.basePrice - b.basePrice);
    else if (sort === 'price_desc') sorted.sort((a, b) => b.basePrice - a.basePrice);
    else sorted.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return sorted;
  }, [products, keyword, category, sort]);

  if (loading) return <p>読み込み中です...</p>;
  if (error) return <p>読み込みに失敗しました: {error}</p>;

  return (
    <div className="product-list">
      <h1>商品一覧</h1>

      {products.length > 0 && (
        <div className="product-list__filters">
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="商品名で検索"
            aria-label="商品名で検索"
          />
          {categories.length > 1 && (
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="カテゴリで絞り込み">
              <option value="">すべてのカテゴリ</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="並び替え">
            <option value="name">名前順</option>
            <option value="price_asc">価格が安い順</option>
            <option value="price_desc">価格が高い順</option>
          </select>
        </div>
      )}

      {products.length > 0 && visibleProducts.length === 0 ? (
        <p>条件に一致する商品が見つかりませんでした。</p>
      ) : (
        <div className="product-grid">
          {visibleProducts.map((product) => {
            const totalAvailable = product.variants.reduce((sum, v) => sum + v.availableStock, 0);
            return (
              <Link key={product.id} to={`/products/${product.slug}`} className="product-card">
                {product.images[0] && <img src={product.images[0]} alt={product.name} />}
                <h2>{product.name}</h2>
                <p>{product.basePrice.toLocaleString()}円(税込)</p>
                <p>{totalAvailable > 0 ? '在庫あり' : '売り切れ'}</p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
