import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchProducts, type ProductSummary } from '../lib/api';

export default function ProductListPage() {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProducts()
      .then((data) => setProducts(data.products))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>読み込み中です...</p>;
  if (error) return <p>読み込みに失敗しました: {error}</p>;

  return (
    <div className="product-list">
      <h1>商品一覧</h1>
      <div className="product-grid">
        {products.map((product) => {
          const totalAvailable = product.variants.reduce((sum, v) => sum + v.availableStock, 0);
          return (
            <Link key={product.id} to={`/products/${product.slug}`} className="product-card">
              {product.imageUrl && <img src={product.imageUrl} alt={product.name} />}
              <h2>{product.name}</h2>
              <p>{product.basePrice.toLocaleString()}円(税込)</p>
              <p>{totalAvailable > 0 ? '在庫あり' : '売り切れ'}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
