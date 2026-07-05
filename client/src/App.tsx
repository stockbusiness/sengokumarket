import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { captureReferralFromSearch } from './lib/referral';
import ProductListPage from './pages/ProductListPage';
import ProductDetailPage from './pages/ProductDetailPage';
import CartPage from './pages/CartPage';
import CheckoutPage from './pages/CheckoutPage';
import CheckoutSuccessPage from './pages/CheckoutSuccessPage';
import CheckoutCancelPage from './pages/CheckoutCancelPage';
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
      <Route path="/checkout" element={<CheckoutPage />} />
      <Route path="/checkout/success" element={<CheckoutSuccessPage />} />
      <Route path="/checkout/cancel" element={<CheckoutCancelPage />} />
    </Routes>
  );
}

export default App;
