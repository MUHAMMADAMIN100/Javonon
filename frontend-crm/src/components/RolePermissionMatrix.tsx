import { useMemo, useState } from 'react';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import type { PermissionDef, PermissionKind } from '../api/customRoles';

/**
 * Права роли таблицей (Настройки → Роли и доступы): строка — раздел CRM,
 * столбцы «Просмотр / Создание / Изменение / Удаление», особые действия
 * раздела — плашками в той же строке. Сверху поиск, у группы — «всё в
 * группе», у раздела — «всё». Видимость данных — отдельным блоком: там не
 * действия, а что сервер покажет или скроет. На телефоне строка — карточка.
 *
 * Любое действие раздела само отмечает его «Просмотр» (без него раздел не
 * открыть), снятый «Просмотр» снимает весь раздел.
 *
 * Каталог и русские подписи — с сервера (backend/src/auth/permissions.ts),
 * переводы — perm.group.* / perm.section.* / perm.short.* в lib/i18n.
 */

/** Порядок групп — как в каталоге; неизвестная группа (новая на сервере) — в конец. */
const GROUP_ORDER = ['CRM', 'Связь', 'Продажи', 'Партнёры', 'Финансы', 'Аналитика', 'HR', 'Обучение', 'Система', 'Данные'];
const DATA_GROUP = 'Данные';
const COLUMNS: Exclude<PermissionKind, 'extra'>[] = ['read', 'create', 'update', 'delete'];
/**
 * Разделы без своего «Просмотра», которые открываются из чужого раздела:
 * учеников академии и их флаги видно только из групп академии.
 */
const SECTION_NEEDS: Record<string, string> = {
  academyStudents: 'groups:read',
  academyFlags: 'groups:read',
};

interface Section {
  key: string;
  group: string;
  label: string;
  items: PermissionDef[];
}

const groupRank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;
};

export default function RolePermissionMatrix({
  catalog,
  value,
  onChange,
}: {
  catalog: PermissionDef[];
  value: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Перевод с запасной русской подписью сервера.
  const tx = (key: string, fallback: string) => (t(key) !== key ? t(key) : fallback);
  const groupLabel = (g: string) => tx(`perm.group.${g}`, g);
  const sectionLabel = (s: Section) => tx(`perm.section.${s.key}`, s.label);
  const shortLabel = (p: PermissionDef) => (p.short ? tx(`perm.short.${p.key}`, p.short) : '');
  const columnLabel = (c: string) => t(`perm.col.${c}`);

  // Разделы по ключу (в порядке каталога) и группы из них.
  const sectionByKey = useMemo(() => {
    const sections = new Map<string, Section>();
    for (const p of catalog) {
      let s = sections.get(p.section);
      if (!s) {
        s = { key: p.section, group: p.group, label: p.sectionLabel, items: [] };
        sections.set(p.section, s);
      }
      s.items.push(p);
    }
    return sections;
  }, [catalog]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, Section[]>();
    for (const s of sectionByKey.values()) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group)!.push(s);
    }
    return [...byGroup.entries()].sort(([a], [b]) => groupRank(a) - groupRank(b));
  }, [sectionByKey]);

  // Поиск — по разделу и подписям его пунктов (на языке интерфейса и по-русски).
  const needle = query.trim().toLowerCase();
  const matches = (s: Section) =>
    !needle ||
    [sectionLabel(s), s.label, ...s.items.flatMap((p) => [shortLabel(p), p.label])]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  const visible = groups
    .map(([g, sections]) => [g, needle && groupLabel(g).toLowerCase().includes(needle) ? sections : sections.filter(matches)] as const)
    .filter(([, sections]) => sections.length > 0);

  const total = catalog.length;
  const checked = catalog.filter((p) => value.has(p.key)).length;

  /** «Просмотр», без которого пункты раздела не открыть: свой или нужного раздела. */
  const readKeyOf = (s: Section) => s.items.find((p) => p.kind === 'read')?.key ?? SECTION_NEEDS[s.key];

  /** Отметить пункты вместе с «Просмотром», без которого их не открыть. */
  const addWithRead = (next: Set<string>, items: PermissionDef[]) => {
    for (const p of items) {
      next.add(p.key);
      const s = sectionByKey.get(p.section);
      const read = p.kind === 'read' || !s ? undefined : readKeyOf(s);
      if (read) next.add(read);
    }
  };
  /** Снять пункты; снятый «Просмотр» снимает свой раздел и разделы, что без него не открыть. */
  const removeWithDependents = (next: Set<string>, keys: string[]) => {
    for (const key of keys) {
      next.delete(key);
      for (const s of sectionByKey.values()) {
        const ownRead = s.items.find((p) => p.kind === 'read')?.key;
        if (key === ownRead || SECTION_NEEDS[s.key] === key) {
          for (const p of s.items) next.delete(p.key);
        }
      }
    }
  };

  const toggleKey = (_s: Section, key: string) => {
    const next = new Set(value);
    if (next.has(key)) removeWithDependents(next, [key]);
    else {
      const p = catalog.find((x) => x.key === key);
      if (p) addWithRead(next, [p]);
    }
    onChange(next);
  };

  const setMany = (items: PermissionDef[], on: boolean) => {
    const next = new Set(value);
    if (on) addWithRead(next, items);
    else removeWithDependents(next, items.map((p) => p.key));
    onChange(next);
  };

  const toggleCollapsed = (g: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div className="perm-matrix" data-testid="perm-matrix">
      <div className="perm-toolbar">
        <div className="perm-search">
          <Icon name="search" size={18} />
          <input
            className="crm-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.roles.search')}
            aria-label={t('settings.roles.search')}
            data-testid="perm-search"
          />
          {query && (
            <button type="button" className="perm-search-clear" onClick={() => setQuery('')} aria-label={t('common.reset')}>
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
        <span className="perm-total" data-testid="perm-total">
          {t('settings.roles.selected').replace('{n}', String(checked)).replace('{m}', String(total))}
        </span>
      </div>
      <p className="perm-hint">{t('settings.roles.autoRead')}</p>
      <p className="perm-hint">{t('settings.roles.founderNote')}</p>

      {visible.length === 0 && (
        <div className="perm-empty" data-testid="perm-empty">
          <Icon name="search_off" size={28} /> {t('settings.roles.notFound')}
        </div>
      )}

      {visible.map(([g, sections]) => {
        const items = sections.flatMap((s) => s.items);
        const on = items.filter((p) => value.has(p.key)).length;
        const all = on === items.length;
        // При поиске группы не сворачиваются — иначе найденное не видно.
        const isCollapsed = !needle && collapsed.has(g);
        const note = t(`perm.groupNote.${g}`);
        return (
          <section key={g} className={`perm-group${g === DATA_GROUP ? ' is-data' : ''}`} data-testid={`perm-group-${g}`}>
            <header className="perm-group-head">
              <button
                type="button"
                className="perm-group-toggle"
                onClick={() => toggleCollapsed(g)}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? t('settings.roles.expand') : t('settings.roles.collapse')}
              >
                <Icon name={isCollapsed ? 'chevron_right' : 'expand_more'} size={20} />
                <span className="perm-group-title">{groupLabel(g)}</span>
                <span className={`perm-group-count${on > 0 ? ' is-on' : ''}`}>{on} / {items.length}</span>
              </button>
              <button
                type="button"
                className={`btn btn-sm ${all ? 'btn-secondary' : 'btn-primary'} perm-group-all`}
                onClick={() => setMany(items, !all)}
                data-testid={`perm-group-all-${g}`}
              >
                <Icon name={all ? 'remove_done' : 'done_all'} size={16} />
                {all ? t('settings.roles.clearGroup') : t('settings.roles.allInGroup')}
              </button>
            </header>
            {!isCollapsed && note !== `perm.groupNote.${g}` && <p className="perm-group-note">{note}</p>}

            {!isCollapsed && g === DATA_GROUP && (
              <div className="perm-data-list">
                {sections.map((s) => {
                  const p = s.items[0];
                  const isOn = value.has(p.key);
                  return (
                    <label key={s.key} className={`perm-data-row${isOn ? ' is-on' : ''}`} data-testid={`perm-row-${s.key}`}>
                      <input type="checkbox" className="crm-checkbox" checked={isOn} onChange={() => toggleKey(s, p.key)} data-testid={`perm-${p.key}`} />
                      <span className="perm-data-text">
                        <b>{sectionLabel(s)}</b>
                        {p.short && <span className="perm-data-note">{shortLabel(p)}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {!isCollapsed && g !== DATA_GROUP && (
              <div className="perm-grid" role="table" aria-label={groupLabel(g)}>
                <div className="perm-row perm-row-head" role="row">
                  <span role="columnheader">{columnLabel('section')}</span>
                  {COLUMNS.map((c) => (
                    <span key={c} role="columnheader" className="perm-col-head">{columnLabel(c)}</span>
                  ))}
                  <span role="columnheader">{columnLabel('extra')}</span>
                </div>
                {sections.map((s) => {
                  const extras = s.items.filter((p) => p.kind === 'extra');
                  const sOn = s.items.filter((p) => value.has(p.key)).length;
                  return (
                    <div key={s.key} className={`perm-row${sOn > 0 ? ' has-on' : ''}`} role="row" data-testid={`perm-row-${s.key}`}>
                      <div className="perm-section" role="rowheader">
                        <span className="perm-section-name">{sectionLabel(s)}</span>
                        {s.items.length > 1 && (
                          <button
                            type="button"
                            className={`perm-section-all${sOn === s.items.length ? ' is-on' : ''}`}
                            title={t('settings.roles.allInSectionTitle')}
                            aria-pressed={sOn === s.items.length}
                            onClick={() => setMany(s.items, sOn !== s.items.length)}
                            data-testid={`perm-all-${s.key}`}
                          >
                            {t('settings.roles.allInSection')}
                          </button>
                        )}
                      </div>
                      {COLUMNS.map((c) => {
                        const p = s.items.find((x) => x.kind === c);
                        if (!p) {
                          return (
                            <div key={c} className="perm-cell is-empty" role="cell">
                              <span aria-hidden="true">—</span>
                            </div>
                          );
                        }
                        const isOn = value.has(p.key);
                        return (
                          <div key={c} className="perm-cell" role="cell">
                            <label className={`perm-check${isOn ? ' is-on' : ''}`} title={p.label}>
                              <input type="checkbox" className="crm-checkbox" checked={isOn} onChange={() => toggleKey(s, p.key)} data-testid={`perm-${p.key}`} />
                              <span className="perm-check-text">
                                <span className="perm-cell-label">{columnLabel(c)}</span>
                                {p.short && <span className="perm-cell-note">{shortLabel(p)}</span>}
                              </span>
                            </label>
                          </div>
                        );
                      })}
                      <div className={`perm-extras${extras.length ? '' : ' is-empty'}`} role="cell">
                        {extras.map((p) => {
                          const isOn = value.has(p.key);
                          return (
                            <label key={p.key} className={`perm-chip${isOn ? ' is-on' : ''}`} title={p.label}>
                              <input type="checkbox" className="crm-checkbox" checked={isOn} onChange={() => toggleKey(s, p.key)} data-testid={`perm-${p.key}`} />
                              <span>{shortLabel(p)}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
