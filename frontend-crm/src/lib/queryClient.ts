import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime через Socket.IO будет инвалидировать кеш — поэтому
      // staleTime поднимаем, чтобы лишний раз не дёргать сервер.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error: any) => {
        // Не ретраим 4xx — клиентские ошибки бесполезно перезапрашивать.
        const status = error?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
