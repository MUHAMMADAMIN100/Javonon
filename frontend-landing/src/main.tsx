import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import StudentLogin from './pages/StudentLogin';
import StudentRegister from './pages/StudentRegister';
import StudentCabinet from './pages/StudentCabinet';
import Knowledge from './pages/Knowledge';
import PublicProgramDetail from './pages/PublicProgramDetail';
import ErrorBoundary from './components/ErrorBoundary';
import { initAnalytics, trackPageView } from './analytics';
import { queryClient } from './queryClient';
import { captureReferralFromUrl } from './referral';
import PartnerRegister from './pages/PartnerRegister';
import PartnerLogin from './pages/PartnerLogin';
import PartnerCabinet from './pages/PartnerCabinet';
import './index.css';

initAnalytics();
// Захватываем ?ref= из URL до того как React его потеряет.
captureReferralFromUrl();

function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <RouteTracker />
          <Routes>
            <Route path="/" element={<App />} />
            <Route path="/login" element={<StudentLogin />} />
            <Route path="/register" element={<StudentRegister />} />
            <Route path="/cabinet" element={<StudentCabinet />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/program/:id" element={<PublicProgramDetail />} />
            <Route path="/partner/register" element={<PartnerRegister />} />
            <Route path="/partner/login" element={<PartnerLogin />} />
            <Route path="/partner/cabinet" element={<PartnerCabinet />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
