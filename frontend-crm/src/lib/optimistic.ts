import { QueryKey, useMutation, useQueryClient, UseMutationOptions } from '@tanstack/react-query';

/**
 * Базовая обёртка для оптимистичной мутации.
 *
 * Поток:
 * 1. cancelQueries — чтобы pending refetch не перезаписал наш optimistic
 * 2. snapshot текущего значения
 * 3. setQueryData(applyOptimistic(...)) — UI обновляется мгновенно
 * 4. mutationFn → если упадёт, откатываем к snapshot
 * 5. invalidateQueries — синкаемся с реальным сервером
 *
 * Используй когда есть один queryKey с массивом или объектом, который
 * можно «предсказать» по входным переменным (TVars) до ответа сервера.
 */
export function useOptimisticMutation<TData, TVars, TQueryData>(opts: {
  mutationFn: (vars: TVars) => Promise<TData>;
  queryKey: QueryKey | ((vars: TVars) => QueryKey);
  /** Как должен выглядеть кеш ПОСЛЕ оптимистичного применения. */
  applyOptimistic: (current: TQueryData | undefined, vars: TVars) => TQueryData | undefined;
  /** Дополнительные queryKeys, которые надо инвалидировать после успеха. */
  invalidateAlso?: QueryKey[];
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (error: unknown, vars: TVars) => void;
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

/** Утилиты apply-оптимистики для типичных коллекций. */
export const optimistic = {
  /** Заменить элемент по id в массиве. */
  updateById<T extends { id: string }>(arr: T[] | undefined, id: string, patch: Partial<T>): T[] {
    if (!arr) return [];
    return arr.map((x) => (x.id === id ? { ...x, ...patch } : x));
  },
  /** Удалить по id. */
  removeById<T extends { id: string }>(arr: T[] | undefined, id: string): T[] {
    if (!arr) return [];
    return arr.filter((x) => x.id !== id);
  },
  /** Добавить в начало (для optimistic create — id пока временный). */
  prepend<T>(arr: T[] | undefined, item: T): T[] {
    return [item, ...(arr ?? [])];
  },
  /** Добавить в конец. */
  append<T>(arr: T[] | undefined, item: T): T[] {
    return [...(arr ?? []), item];
  },
  /** Patch у объекта (если queryData — единичный объект, не массив). */
  patch<T extends object>(obj: T | undefined, patch: Partial<T>): T | undefined {
    return obj ? { ...obj, ...patch } : obj;
  },
};

/** Сгенерировать временный id для optimistic-create. Заменится при invalidate. */
export function tempId(): string {
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Краткий хелпер: useMutation с авто-инвалидацией списка (без оптимистики). */
export function useInvalidatingMutation<TData, TVars>(
  opts: {
    mutationFn: (vars: TVars) => Promise<TData>;
    invalidate: QueryKey[];
  } & Omit<UseMutationOptions<TData, unknown, TVars, unknown>, 'mutationFn'>,
) {
  const qc = useQueryClient();
  const { mutationFn, invalidate, onSettled, ...rest } = opts;
  return useMutation<TData, unknown, TVars, unknown>({
    ...rest,
    mutationFn,
    onSettled: (data, err, vars, ctx, mctx) => {
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      onSettled?.(data, err, vars, ctx, mctx);
    },
  });
}
