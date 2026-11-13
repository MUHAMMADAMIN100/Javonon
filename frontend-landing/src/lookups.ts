import { useQuery } from '@tanstack/react-query';
import { API_URL, COUNTRY_LABEL, COUNTRY_ORDER, DIRECTION_LABEL } from './api';

/**
 * Справочники CRM для сайта («Лиды → Настройки», 13.11.2026): страны и
 * направления основатель правит сам — новая страна сразу появляется в форме
 * заявки, новое направление — в каталоге и регистрации.
 *
 * Пока ответ не пришёл (или сервер недоступен), работают прежние списки из
 * api.ts — форма не остаётся без вариантов.
 */
export interface PublicLookup {
  key: string;
  labelTg: string;
  labelRu: string;
  showOnSite: boolean;
}

export interface PublicLookups {
  directions: PublicLookup[];
  countries: PublicLookup[];
  statuses: Array<{ key: string; labelTg: string; clientLabel: string | null; isClosed: boolean }>;
}

const FALLBACK: PublicLookups = {
  directions: Object.entries(DIRECTION_LABEL).map(([key, labelTg]) => ({ key, labelTg, labelRu: labelTg, showOnSite: true })),
  countries: COUNTRY_ORDER.map((key) => ({ key, labelTg: COUNTRY_LABEL[key], labelRu: COUNTRY_LABEL[key], showOnSite: true })),
  statuses: [],
};

async function fetchPublicLookups(): Promise<PublicLookups> {
  const res = await fetch(`${API_URL}/lookups/public`);
  if (!res.ok) throw new Error(`lookups ${res.status}`);
  return res.json();
}

export function usePublicLookups(): PublicLookups {
  const q = useQuery({ queryKey: ['public-lookups'], queryFn: fetchPublicLookups, staleTime: 5 * 60_000 });
  return q.data ?? FALLBACK;
}

/** Подпись направления по-таджикски (для бейджей программ и кабинета). */
export function useDirectionLabel(): (key: string | null | undefined) => string {
  const L = usePublicLookups();
  return (key) => {
    if (!key) return '';
    return L.directions.find((d) => d.key === key)?.labelTg ?? DIRECTION_LABEL[key as keyof typeof DIRECTION_LABEL] ?? key;
  };
}
