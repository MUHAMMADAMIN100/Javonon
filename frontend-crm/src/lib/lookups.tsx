import { useMemo, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchLookups, MACHINE_SOURCES, type LookupItem, type LookupKind } from '../api/lookups';
import { STATUS_LABEL } from '../api/types';
import { currentLang, tr, useT, type Lang } from './i18n';
import { queryClient } from './queryClient';
import { useAuth } from '../store/auth';

/**
 * Справочники CRM («Лиды → Настройки», 13.11.2026) — один источник подписей,
 * порядка и цветов статусов, направлений, стран и источников.
 *
 * Список приходит с сервера один раз и живёт в кеше react-query; когда
 * кто-то меняет настройки, сервер шлёт lookups:changed и Layout сбрасывает
 * кеш — у всех открытых CRM подписи обновляются сами.
 *
 * Пока список не загрузился, подписи берутся из словаря i18n (там есть все
 * прежние значения), а списки — из FALLBACK: экран не мигает ключами вида
 * «ONLINE_CONSULTATION».
 */
export const LOOKUPS_KEY = ['lookups'] as const;

const FALLBACK: Record<LookupKind, string[]> = {
  LEAD_STATUS: [
    'NEW_LEAD', 'IN_PROCESSING', 'ONLINE_CONSULTATION', 'OFFLINE_CONSULTATION', 'THINKING',
    'OUT_OF_TOWN', 'UNDER_17', 'POTENTIAL_LEAD', 'LOW_QUALITY_LEAD', 'SUCCESSFUL_LEAD',
  ],
  DIRECTION: ['BACHELOR', 'MASTER', 'LANGUAGE', 'LANGUAGE_COLLEGE', 'LANGUAGE_BACHELOR', 'COLLEGE'],
  COUNTRY: ['USA', 'KOREA', 'CHINA', 'LATVIA', 'MALAYSIA', 'ITALY', 'GERMANY'],
  LEAD_SOURCE: [
    'LANDING_FORM', 'SELF_REGISTRATION', 'REFERRAL', 'INSTAGRAM', 'TELEGRAM',
    'GOOGLE_ADS', 'TIKTOK', 'WORD_OF_MOUTH', 'EVENT', 'OTHER',
  ],
  STUDENT_STATUS: ['ACTIVE', 'PAUSED', 'GRADUATED', 'ARCHIVED'],
  ONBOARDING_STAGE: ['WELCOME', 'DOCS_COLLECTED', 'CABINET_OPENED', 'ACADEMY_INTRO', 'ACTIVE'],
  TASK_STATUS: ['TODO', 'IN_PROGRESS', 'DONE'],
  CONTACT_CHANNEL: ['WHATSAPP', 'PHONE', 'INSTAGRAM', 'TELEGRAM', 'EMAIL'],
  INTERACTION_TYPE: ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'SMS', 'TELEGRAM', 'WHATSAPP'],
  CALL_OUTCOME: ['ANSWERED', 'NO_ANSWER', 'BUSY', 'CALLBACK', 'CONVERTED'],
  DEAL_PAYMENT_METHOD: ['TRANSFER', 'CASH', 'OTHER'],
};

/** Цвета по умолчанию — те же, что в справочнике сервера (lookup-defaults.ts). */
const FALLBACK_COLOR: Record<string, string> = {
  'LEAD_STATUS:NEW_LEAD': '#1E5BB8',
  'LEAD_STATUS:IN_PROCESSING': '#B45309',
  'LEAD_STATUS:ONLINE_CONSULTATION': '#B45309',
  'LEAD_STATUS:OFFLINE_CONSULTATION': '#B45309',
  'LEAD_STATUS:THINKING': '#B45309',
  'LEAD_STATUS:OUT_OF_TOWN': '#64748B',
  'LEAD_STATUS:UNDER_17': '#64748B',
  'LEAD_STATUS:POTENTIAL_LEAD': '#1E5BB8',
  'LEAD_STATUS:LOW_QUALITY_LEAD': '#DC2626',
  'LEAD_STATUS:SUCCESSFUL_LEAD': '#15803D',
  'LEAD_SOURCE:LANDING_FORM': '#2563EB',
  'LEAD_SOURCE:SELF_REGISTRATION': '#15803D',
  'LEAD_SOURCE:REFERRAL': '#B45309',
  'LEAD_SOURCE:INSTAGRAM': '#C1358A',
  'LEAD_SOURCE:TELEGRAM': '#1E6FA6',
  'LEAD_SOURCE:GOOGLE_ADS': '#C2410C',
  'LEAD_SOURCE:TIKTOK': '#111827',
  'LEAD_SOURCE:WORD_OF_MOUTH': '#64748B',
  'LEAD_SOURCE:EVENT': '#7C3AED',
  'LEAD_SOURCE:OTHER': '#64748B',
};

const I18N_PREFIX: Record<LookupKind, string> = {
  LEAD_STATUS: 'app.status',
  DIRECTION: 'direction',
  COUNTRY: 'country',
  LEAD_SOURCE: 'source',
  STUDENT_STATUS: 'student.status',
  ONBOARDING_STAGE: 'onboarding',
  TASK_STATUS: 'task.status',
  CONTACT_CHANNEL: 'channel',
  INTERACTION_TYPE: 'interactions.type',
  CALL_OUTCOME: 'calls.out',
  DEAL_PAYMENT_METHOD: 'deal.method',
};

export interface Lookups {
  /** Справочник уже пришёл с сервера. */
  ready: boolean;
  /** Ключи вида в порядке справочника. */
  keys: (kind: LookupKind) => string[];
  items: (kind: LookupKind) => LookupItem[];
  item: (kind: LookupKind, key: string | null | undefined) => LookupItem | undefined;
  /** Подпись на текущем языке; '—' для пустого значения. */
  label: (kind: LookupKind, key: string | null | undefined) => string;
  color: (kind: LookupKind, key: string | null | undefined) => string | null;
  /** Источники, которые сотрудник ставит руками (без машинных). */
  staffSources: string[];
}

function build(data: LookupItem[] | undefined, lang: Lang): Lookups {
  const byKind = new Map<LookupKind, LookupItem[]>();
  for (const it of data ?? []) {
    const arr = byKind.get(it.kind) ?? [];
    arr.push(it);
    byKind.set(it.kind, arr);
  }
  for (const arr of byKind.values()) arr.sort((a, b) => a.order - b.order);
  const ready = !!data;
  const items = (kind: LookupKind) => byKind.get(kind) ?? [];
  const keys = (kind: LookupKind) => (ready ? items(kind).map((i) => i.key) : FALLBACK[kind]);
  const item = (kind: LookupKind, key: string | null | undefined) =>
    key ? items(kind).find((i) => i.key === key) : undefined;
  const label = (kind: LookupKind, key: string | null | undefined) => {
    if (!key) return '—';
    const it = item(kind, key);
    if (it) return (lang === 'tg' ? it.labelTg : it.labelRu) || it.labelRu;
    const viaDict = tr(`${I18N_PREFIX[kind]}.${key}`, '');
    if (viaDict) return viaDict;
    if (kind === 'LEAD_STATUS') return (STATUS_LABEL as Record<string, string>)[key] ?? key;
    return key;
  };
  const color = (kind: LookupKind, key: string | null | undefined) => {
    if (!key) return null;
    const it = item(kind, key);
    if (it) return it.color;
    return FALLBACK_COLOR[`${kind}:${key}`] ?? null;
  };
  return {
    ready,
    keys,
    items,
    item,
    label,
    color,
    staffSources: keys('LEAD_SOURCE').filter((k) => !MACHINE_SOURCES.includes(k)),
  };
}

/** Загрузить справочник (кеш на 5 минут; сброс — событием lookups:changed). */
export function useLookupItems(): LookupItem[] | undefined {
  const authed = useAuth((s) => !!s.user);
  const q = useQuery({ queryKey: LOOKUPS_KEY, queryFn: fetchLookups, staleTime: 5 * 60_000, enabled: authed });
  return q.data;
}

export function useLookups(): Lookups {
  const data = useLookupItems();
  const { lang } = useT();
  return useMemo(() => build(data, lang), [data, lang]);
}

/** Для кода вне компонентов (отчёты, выгрузки): то, что уже лежит в кеше. */
export function lookupsSnapshot(): Lookups {
  return build(queryClient.getQueryData<LookupItem[]>(LOOKUPS_KEY), currentLang());
}

/** Плашка цвета значения: текст цветом, фон — тот же цвет, бледный. */
export function badgeStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return { color, background: `${color}1A`, borderColor: `${color}40` };
}

/** Таблетка карточки клиента (.client-pill) в цвете значения. */
export function pillStyle(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    ['--pill-bg' as any]: `${color}1A`,
    ['--pill-border' as any]: `${color}59`,
    ['--pill-fg' as any]: color,
  } as CSSProperties;
}

/** Плашка значения справочника (статус, источник…) с его цветом. */
export function LookupBadge({
  kind,
  value,
  testId,
  className,
  title,
}: {
  kind: LookupKind;
  value: string | null | undefined;
  testId?: string;
  className?: string;
  title?: string;
}) {
  const L = useLookups();
  const color = L.color(kind, value);
  return (
    <span
      className={`badge${color ? '' : ' badge-gray'}${className ? ` ${className}` : ''}`}
      style={badgeStyle(color)}
      data-testid={testId}
      data-value={value ?? ''}
      title={title}
    >
      {L.label(kind, value)}
    </span>
  );
}
