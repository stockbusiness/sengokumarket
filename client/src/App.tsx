import { Suspense, useEffect } from 'react';
import { Routes, useLocation } from 'react-router-dom';
import { captureReferralFromSearch } from './lib/referral';
import NavBar from './app/NavBar';
import { publicRoutes } from './app/routes/publicRoutes';
import { memberRoutes } from './app/routes/memberRoutes';
import { adminRoutes } from './app/routes/adminRoutes';
import { agencyRoutes } from './app/routes/agencyRoutes';
import Footer from './components/Footer';
import ErrorBoundary from './components/ErrorBoundary';
import './App.css';

function App() {
  const location = useLocation();

  useEffect(() => {
    captureReferralFromSearch(location.search);
  }, [location.search]);

  return (
    <>
      <NavBar />
      <main className="app-main">
        <ErrorBoundary>
          <Suspense fallback={<p className="page-loading">読み込み中です...</p>}>
            <Routes>
              {publicRoutes()}
              {memberRoutes()}
              {adminRoutes()}
              {agencyRoutes()}
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <Footer />
    </>
  );
}

export default App;
