import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPresence, type PresenceRow, type PresenceState } from '../api/presence';
import { useRealtimeEvent } from '../realtime';
import { tjFormatDateTime } from './tjTime';

const PRESENCE_KEY = ['users', 'presence'] as const;

/**
 * «Кто в сети» — только для основателя: сервер отдаёт /users/presence и
 * шлёт presence:update лишь ему. Остальным хук ничего не запрашивает.
 *
 * Список обновляется без перезагрузки: изменения приходят по сокету, а раз
 * в минуту — страховочный перезапрос (если сокет рвался). Своё тиканье —
 * чтобы «5 мин назад» не застывало на экране.
 */
export function usePresence(enabled: boolean) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: PRESENCE_KEY,
    queryFn: getPresence,
    enabled,
    refetchInterval: 60_000,
    retry: false,
  });

  useRealtimeEvent('presence:update', (p: { userId: string; state: PresenceState; lastSeenAt: string }) => {
    if (!enabled) return;
    qc.setQueryData<PresenceRow[]>(PRESENCE_KEY, (cur) => {
      if (!cur) return cur;
      const next = { userId: p.userId, state: p.state, lastSeenAt: p.lastSeenAt };
      return cur.some((r) => r.userId === p.userId)
        ? cur.map((r) => (r.userId === p.userId ? { ...r, ...next } : r))
        : [...cur, { ...next, lastLoginAt: null }];
    });
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [enabled]);

  const byId = new Map<string, PresenceRow>();
  if (enabled) for (const r of query.data ?? []) byId.set(r.userId, r);
  return { byId, now, ready: enabled && !!query.data };
}

/** Порядок в колонке «В сети»: сначала в сети, потом отошедшие, потом по свежести. */
export function presenceSortValue(r: PresenceRow | undefined): number | null {
  if (!r) return null;
  const rank = r.state === 'ONLINE' ? 0 : r.state === 'AWAY' ? 1 : 2;
  return rank * 1e13 - (r.lastSeenAt ? Date.parse(r.lastSeenAt) : 0);
}

/** «только что» / «5 мин назад» / «2 ч назад» / «3 д назад», старше недели — дата. */
export function agoText(iso: string | null | undefined, now: number, t: (k: string) => string): string {
  if (!iso) return '';
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('time.justNow');
  if (min < 60) return t('time.minAgo').replace('{n}', String(min));
  const h = Math.floor(min / 60);
  if (h < 24) return t('time.hAgo').replace('{n}', String(h));
  const d = Math.floor(h / 24);
  if (d < 7) return t('time.dAgo').replace('{n}', String(d));
  return tjFormatDateTime(iso);
}

/** Подпись статуса: «В сети» / «Отошёл · 12 мин назад» / «Был(а) в сети 2 ч назад». */
export function presenceText(r: PresenceRow | undefined, now: number, t: (k: string) => string): string {
  if (!r) return '';
  if (r.state === 'ONLINE') return t('presence.online');
  if (r.state === 'AWAY') return `${t('presence.away')} · ${agoText(r.lastSeenAt, now, t)}`;
  return r.lastSeenAt ? `${t('presence.seen')} ${agoText(r.lastSeenAt, now, t)}` : t('presence.never');
}
