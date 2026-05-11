import { QueryClient, keepPreviousData } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime через Socket.IO будет инвалидировать кеш — поэтому
      // staleTime поднимаем, чтобы лишний раз не дёргать сервер.
      // 60s даёт ощущение "мгновенно" при возврате на страницу — данные
      // уже свежие, нет лишнего refetch'а.
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      // keepPreviousData — при смене queryKey старые данные остаются
      // видимыми пока не загрузятся новые. Не моргает пустой экран.
      placeholderData: keepPreviousData,
      retry: (failureCount, error: any) => {
        // Не ретраим 4xx — клиентские ошибки бесполезно перезапрашивать.
        const status = error?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
      refetchOnMount: false, // используем кеш если есть; sockets обновят
    },
    mutations: {
      retry: false,
    },
  },
});
