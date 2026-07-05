import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { captureReferralFromSearch } from './lib/referral';
import ProductListPage from './pages/ProductListPage';
import ProductDetailPage from './pages/ProductDetailPage';
import CartPage from './pages/CartPage';
import './App.css';

function App() {
  const location = useLocation();

  useEffect(() => {
    captureReferralFromSearch(location.search);
  }, [location.search]);

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/products" replace />} />
      <Route path="/products" element={<ProductListPage />} />
      <Route path="/products/:idOrSlug" element={<ProductDetailPage />} />
      <Route path="/cart" element={<CartPage />} />
    </Routes>
  );
}

export default App;
