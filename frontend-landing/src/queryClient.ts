import { QueryClient, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error: any) => {
        const status = error?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

/**
 * Базовая обёртка для оптимистичной мутации в landing-кабинете студента.
 * Поток такой же как в CRM lib/optimistic.ts.
 */
export function useOptimisticMutation<TData, TVars, TQueryData>(opts: {
  mutationFn: (vars: TVars) => Promise<TData>;
  queryKey: QueryKey | ((vars: TVars) => QueryKey);
  applyOptimistic: (current: TQueryData | undefined, vars: TVars) => TQueryData | undefined;
  invalidateAlso?: QueryKey[];
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (err: unknown, vars: TVars) => void;
}) {
  const qc = useQueryClient();
  return useMutation<TData, unknown, TVars, { prev: TQueryData | undefined; key: QueryKey }>({
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      const key = typeof opts.queryKey === 'function' ? opts.queryKey(vars) : opts.queryKey;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TQueryData>(key);
      qc.setQueryData<TQueryData>(key, (cur) => opts.applyOptimistic(cur, vars));
      return { prev, key };
    },
    onError: (err, vars, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.prev);
      opts.onError?.(err, vars);
    },
    onSuccess: opts.onSuccess,
    onSettled: (_d, _e, _v, ctx) => {
      if (ctx) qc.invalidateQueries({ queryKey: ctx.key });
      opts.invalidateAlso?.forEach((k) => qc.invalidateQueries({ queryKey: k }));
    },
  });
}

export const optimistic = {
  updateById<T extends { id: string }>(arr: T[] | undefined, id: string, patch: Partial<T>): T[] {
    if (!arr) return [];
    return arr.map((x) => (x.id === id ? { ...x, ...patch } : x));
  },
  removeById<T extends { id: string }>(arr: T[] | undefined, id: string): T[] {
    if (!arr) return [];
    return arr.filter((x) => x.id !== id);
  },
  prepend<T>(arr: T[] | undefined, item: T): T[] {
    return [item, ...(arr ?? [])];
  },
  patch<T extends object>(obj: T | undefined, patch: Partial<T>): T | undefined {
    return obj ? { ...obj, ...patch } : obj;
  },
};

export const lkeys = {
  payments: { list: () => ['student-payments', 'list'] as const },
  cabinet: { me: () => ['student', 'me'] as const },
  documents: { list: () => ['student', 'documents'] as const },
  applicationForm: { mine: () => ['student', 'form'] as const },
  lms: {
    my: () => ['student-lms', 'my'] as const,
    available: () => ['student-lms', 'available'] as const,
    course: (id: string) => ['student-lms', 'course', id] as const,
  },
  programs: {
    list: (p: Record<string, unknown> = {}) => ['programs', 'list', p] as const,
    one: (id: string) => ['programs', 'one', id] as const,
    filters: () => ['programs', 'filters'] as const,
  },
  knowledge: { index: () => ['knowledge', 'index'] as const, category: (slug: string) => ['knowledge', slug] as const },
} as const;
