import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Icon from '../Icon';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { roleCan } from '../lib/permissions';
import { listApplicationsPage } from '../api/applications';
import { listStudents } from '../api/students';
import { buildNavCtx, visibleGroups } from './navGroups';

/**
 * Поиск по CRM — Ctrl K (⌘K) или кнопка в шапке (редизайн 2026).
 *
 * Ищет разделы меню (только доступные человеку), лидов и студентов — по
 * имени или телефону, теми же запросами, что и сами списки, поэтому права
 * режет сервер: чужих лидов менеджер здесь не увидит, как и в «Лидах».
 */
type Hit = { key: string; group: string; icon: string; title: string; sub?: string; to: string };

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

export default function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const canLeads = roleCan(user as any, ['leads:read', 'applications:read']);
  const canStudents = roleCan(user as any, 'students:read');
  const searchOn = open && debounced.length >= 2;

  const leadsQ = useQuery({
    queryKey: ['search', 'leads', debounced],
    queryFn: () => listApplicationsPage({ search: debounced, page: 1, pageSize: 6 } as any),
    enabled: searchOn && canLeads,
    staleTime: 30_000,
  });
  const studentsQ = useQuery({
    queryKey: ['search', 'students', debounced],
    queryFn: () => listStudents({ search: debounced, limit: 6 } as any),
    enabled: searchOn && canStudents,
    staleTime: 30_000,
  });

  const sections = useMemo(() => {
    const groups = visibleGroups(buildNavCtx(user));
    return groups.flatMap((g) => g.items.map((it) => ({
      key: `nav:${it.to}`,
      group: t('search.sections'),
      icon: it.icon,
      title: t(it.labelKey),
      sub: t(g.labelKey),
      to: it.to,
    })));
  }, [user, t]);

  const hits: Hit[] = useMemo(() => {
    const nq = norm(q);
    const nav = (nq ? sections.filter((s) => norm(s.title).includes(nq)) : sections).slice(0, nq ? 6 : 8);
    const leads: Hit[] = searchOn
      ? (leadsQ.data?.items ?? []).slice(0, 6).map((a: any) => ({
          key: `lead:${a.id}`,
          group: t('search.leads'),
          icon: 'person_add',
          title: a.fullName,
          sub: [a.phone, a.manager?.fullName].filter(Boolean).join(' · '),
          to: `/applications/${a.id}`,
        }))
      : [];
    const students: Hit[] = searchOn
      ? (studentsQ.data ?? []).slice(0, 6).map((s: any) => ({
          key: `student:${s.id}`,
          group: t('search.students'),
          icon: 'school',
          title: s.fullName,
          sub: [s.phones?.[0], s.email].filter(Boolean).join(' · '),
          to: `/students/${s.id}`,
        }))
      : [];
    return [...nav, ...leads, ...students];
  }, [q, sections, searchOn, leadsQ.data, studentsQ.data, t]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const go = (h: Hit) => {
    onClose();
    navigate(h.to);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[active]) go(hits[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const loading = searchOn && (leadsQ.isFetching || studentsQ.isFetching);
  let lastGroup = '';

  return createPortal(
    <div className="cmdk-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="search-palette">
      <div className="cmdk" role="dialog" aria-modal="true" aria-label={t('search.title')}>
        <div className="cmdk-input-row">
          <Icon name="search" size={22} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            aria-label={t('search.title')}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={hits[active] ? `cmdk-${active}` : undefined}
            data-testid="search-input"
          />
          {loading && <span className="cmdk-item-sub">{t('common.loading')}</span>}
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
          {hits.length === 0 ? (
            <div className="cmdk-empty" data-testid="search-empty">
              {debounced.length >= 2 && !loading ? t('search.nothing') : t('search.hint')}
            </div>
          ) : (
            hits.map((h, i) => {
              const title = h.group !== lastGroup ? h.group : null;
              lastGroup = h.group;
              return (
                <div key={h.key}>
                  {title && <div className="cmdk-group-title">{title}</div>}
                  <button
                    type="button"
                    id={`cmdk-${i}`}
                    role="option"
                    aria-selected={i === active}
                    data-idx={i}
                    className={`cmdk-item${i === active ? ' is-active' : ''}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => go(h)}
                    data-testid={`search-hit-${h.key.split(':')[0]}`}
                  >
                    <Icon name={h.icon} size={20} />
                    <span className="cmdk-item-text">
                      <span>{h.title}</span>
                      {h.sub && <span className="cmdk-item-sub">{h.sub}</span>}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd>↑</kbd> <kbd>↓</kbd> {t('search.navigate')}</span>
          <span><kbd>Enter</kbd> {t('search.open')}</span>
          <span><kbd>Esc</kbd> {t('common.close')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
