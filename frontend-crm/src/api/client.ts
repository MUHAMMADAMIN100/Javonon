import axios from 'axios';

const baseURL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';

// timeout=60s: uploads до 50MB на нестабильной сети менеджера — раньше без
// timeout при подвисшем nginx запрос висел бесконечно, кнопка «Отправляем…»
// не отпускалась и менеджер думал «не работает».
export const api = axios.create({ baseURL, timeout: 60_000 });

api.interceptors.request.use((config) => {
  // «Запомнить меня»: если чекбокс был снят, токен лежит в sessionStorage
  // и умрёт вместе с вкладкой. localStorage — приоритет (постоянная сессия).
  const token = localStorage.getItem('javonon_token') || sessionStorage.getItem('javonon_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      // Чистим оба хранилища — не знаем, откуда пришёл невалидный токен.
      localStorage.removeItem('javonon_token');
      sessionStorage.removeItem('javonon_token');
      // Учитываем basename CRM (/admin) — после basename идёт /login
      const loginPath = '/admin/login';
      if (!location.pathname.endsWith('/login')) {
        location.href = loginPath;
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
