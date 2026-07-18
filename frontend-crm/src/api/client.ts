import axios from 'axios';
import { readToken, clearToken, useAuth } from '../store/auth';

const baseURL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';

// timeout=60s: uploads до 50MB на нестабильной сети менеджера — раньше без
// timeout при подвисшем nginx запрос висел бесконечно, кнопка «Отправляем…»
// не отпускалась и менеджер думал «не работает».
export const api = axios.create({ baseURL, timeout: 60_000 });

api.interceptors.request.use((config) => {
  // readToken() = localStorage → sessionStorage (migration path — see
  // store/auth.ts). Single source of truth so we can't drift between
  // interceptor and bootstrap() on which storage wins.
  const token = readToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      // Login endpoint itself returns 401 on wrong password — that's the form's
      // job to display, not a global "wipe session, redirect" trigger. Without
      // this guard a failed login attempt logs the user out of… nothing, and
      // full-page-navs to /login (loop-adjacent).
      const url: string = err.config?.url || '';
      const isLoginRequest = url.includes('/auth/login');
      if (!isLoginRequest) {
        // Nuke token from both storages + wipe in-memory auth store.
        clearToken();
        try { useAuth.setState({ user: null }); } catch { /* store not ready */ }
        // Учитываем basename CRM (/admin) — после basename идёт /login.
        // Full-page nav is deliberate: it also nukes React-Query cache and
        // any stale in-memory state. Guard against redirect loops when we're
        // already on the login screen.
        const loginPath = '/admin/login';
        if (!location.pathname.endsWith('/login')) {
          location.href = loginPath;
        }
      }
    } else if (!err.response) {
      // Network / timeout / CORS / offline — response отсутствует. Мутации
      // (useMutation.onError) без такого сообщения покажут только generic
      // «Ошибка», менеджер не поймёт что делать. Прокидываем userMessage,
      // формы читают его в onError после response.data.message.
      err.userMessage =
        err.code === 'ECONNABORTED'
          ? 'Превышено время ожидания. Проверьте интернет и попробуйте ещё раз.'
          : 'Нет связи с сервером. Проверьте интернет.';
    }
    return Promise.reject(err);
  },
);
