import axios from 'axios';

const baseURL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';

export const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('javonon_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('javonon_token');
      // Учитываем basename CRM (/admin) — после basename идёт /login
      const loginPath = '/admin/login';
      if (!location.pathname.endsWith('/login')) {
        location.href = loginPath;
      }
    }
    return Promise.reject(err);
  },
);
