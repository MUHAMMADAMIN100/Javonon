import { useEffect, useState } from 'react';
import { api } from '../api/client';

/**
 * Ссылки на файлы из /uploads/* (они лежат на бэкенде, а не на фронте).
 *
 * <a href> и <img src> не умеют слать заголовок авторизации, поэтому в адрес
 * добавляется ?ft=<файловый токен>. Файловый токен (GET /auth/file-token)
 * живёт 10 минут, подписан отдельным ключом и годится только для файлов;
 * сервер при каждой выдаче проверяет, что сессия жива и сотрудник не уволен.
 * Раньше в адрес клали основной токен входа (30 дней) — он оседал в логах,
 * истории браузера и Referer.
 *
 * Токен берётся после входа и обновляется каждые 8 минут; каркас страниц
 * (Layout) подписан на него через useFileToken(), поэтому ссылки на открытой
 * странице перестраиваются со свежим токеном.
 */
let fileToken = '';
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const REFRESH_MS = 8 * 60 * 1000;

async function refreshFileToken() {
  try {
    const { data } = await api.get<{ token: string; expiresIn: number }>('/auth/file-token');
    fileToken = data.token;
    listeners.forEach((f) => f());
  } catch {
    // 401 разрулит общий перехватчик входа; сеть — повторим по таймеру.
  }
}

/** Запустить (или перезапустить) получение файлового токена — после входа. */
export function startFileTokenRefresh() {
  if (timer) clearInterval(timer);
  void refreshFileToken();
  timer = setInterval(() => void refreshFileToken(), REFRESH_MS);
}

/** Выход: токен и таймер сбрасываются. */
export function stopFileTokenRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
  fileToken = '';
  listeners.forEach((f) => f());
}

/** Подписка на обновление токена — компонент перерисуется со свежими ссылками. */
export function useFileToken(): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return fileToken;
}

export function absFileUrl(u: string | null | undefined): string {
  if (!u) return '';
  if (u.startsWith('http') || u.startsWith('blob:') || u.startsWith('data:')) return u;
  const apiBase = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api').replace(/\/api$/, '');
  const base = `${apiBase}${u}`;
  if (u.startsWith('/uploads/') && fileToken) {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}ft=${encodeURIComponent(fileToken)}`;
  }
  return base;
}
