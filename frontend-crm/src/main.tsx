import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { UIProvider } from './ui/Dialogs';
import ErrorBoundary from './components/ErrorBoundary';
import { queryClient } from './lib/queryClient';
import { installTjLocalePatch } from './lib/tjLocalePatch';
import { watchIconFont } from './lib/iconFont';
import { I18nProvider } from './lib/i18n';
import './index.css';
// Дизайн 2026 (редизайн): слой поверх index.css — подключается последним.
import './styles/theme.css';

// Глобально форсируем Asia/Dushanbe для всех toLocaleString* без явной
// timeZone. По ТЗ — все времена в системе показываются в TJ-зоне.
installTjLocalePatch();
// Пока шрифт значков грузится — пустое место вместо слов «notifications» и т. п.
watchIconFont();

// QA-2: «AbortError: play() … interrupted by pause()» на дашборде — не наш код
// (в CRM нет вызовов play()), но засоряет консоль. Глушим только её.
window.addEventListener('unhandledrejection', (e) => {
  const r: any = e.reason;
  if (r?.name === 'AbortError' && /play\(\)/.test(String(r?.message))) e.preventDefault();
});

// CRM живёт под /admin. Адрес без него (например /login) раньше давал пустую
// серую страницу — роутер с basename его не видел (QA-2). Переводим в /admin.
if (!/^\/admin(\/|$)/.test(window.location.pathname)) {
  window.location.replace(`/admin${window.location.pathname === '/' ? '' : window.location.pathname}${window.location.search}${window.location.hash}`);
}

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
