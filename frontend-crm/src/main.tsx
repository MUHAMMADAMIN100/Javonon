import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { UIProvider } from './ui/Dialogs';
import ErrorBoundary from './components/ErrorBoundary';
import { queryClient } from './lib/queryClient';
import { installTjLocalePatch } from './lib/tjLocalePatch';
import { I18nProvider } from './lib/i18n';
import './index.css';

// Глобально форсируем Asia/Dushanbe для всех toLocaleString* без явной
// timeZone. По ТЗ — все времена в системе показываются в TJ-зоне.
installTjLocalePatch();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename="/admin">
          <I18nProvider>
            <UIProvider>
              <App />
            </UIProvider>
          </I18nProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
