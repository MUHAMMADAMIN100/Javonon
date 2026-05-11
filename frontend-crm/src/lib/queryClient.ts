import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime через Socket.IO будет инвалидировать кеш — поэтому
      // staleTime поднимаем, чтобы лишний раз не дёргать сервер.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // ПРИМЕЧАНИЕ: глобальный keepPreviousData убран — он ломал чат
      // (старые messages из предыдущей room показывались в новой room
      // с неправильным isMine, title тоже брался из stale members).
      // Если конкретный экран хочет keepPreviousData — пусть включит
      // на своём useQuery вручную.
      retry: (failureCount, error: any) => {
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
