import { useState } from 'react';
import { canSeeData, hasActiveRole, roleCan } from '../lib/permissions';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import Icon from '../Icon';
import { listTasks } from '../api/tasks';
import { listPendingPayments } from '../api/submissions';
import { listApplicationsPage } from '../api/applications';
import { buildNavCtx } from '../components/navGroups';
import { tjFormatTime, tjFormatDate, tjToday } from '../lib/tjTime';
import { prevRangeOf, type Delta } from '../lib/periodCompare';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { applicationStats } from '../api/applications';
import type { Task } from '../api/types';
import { studentStats } from '../api/students';
import { financeSummary, pendingPayments, type FinanceSummary } from '../api/finance';
import { leaderboard, type KpiRow } from '../api/kpi';
import { isFinishedApplicationStatus, isNewLeadApplicationStatus } from '../api/types';
import { useAuth } from '../store/auth';
import { keys } from '../lib/queryKeys';
import { isElevated, hasRole, isFounder } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useApplicationStatusLabel, useCountryLabel, useDirectionLabel } from '../lib/labels';
import PeriodSwitcher, { useDashboardPeriod } from '../components/PeriodSwitcher';
import FitNumber from '../components/FitNumber';
import DashboardDetails, { type DashboardDetailKind } from '../components/DashboardDetails';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}


export default function Dashboard() {
  const { t } = useT();
  const countryLabel = useCountryLabel();
  const appStatusLabel = useApplicationStatusLabel();
  const directionLabel = useDirectionLabel();
  const me = useAuth((s) => s.user);
  const isAdmin = isElevated(me);
  // hasRole учитывает мульти-роли (ТЗ §2). Раньше было `me?.role === 'ACCOUNTANT'`
  // — ловило только primary, юзер с roles=[ACCOUNTANT] проваливался.
  const isAccountant = hasRole(me, 'ACCOUNTANT');
  // Сотрудник с ролью: деньги компании — по пункту «Видимость данных →
  // Деньги компании», рейтинг — ещё и по «KPI — рейтинг сотрудников».
  const withRole = hasActiveRole(me);
  const showFinance = withRole ? canSeeData(me, 'visibility:company-money') : isAdmin || isAccountant;
  const showTop = withRole ? roleCan(me, 'kpi:read') && canSeeData(me, 'visibility:company-money') : isAdmin;
  // Окна «подробнее» и ссылки разрезов ведут туда, куда роль пускает; без
  // пункта карточка — просто цифра (должность — как раньше).
  const mayOpen = (kind: DashboardDetailKind) =>
    kind === 'active' ? roleCan(me, 'students:read')
      : kind === 'profit' || kind === 'income' || kind === 'expense' ? roleCan(me, 'finance:read')
        : kind === 'debt' ? true
          : roleCan(me, ['leads:read', 'applications:read']);
  // Список — «Лиды» (с 23.10.2026 там и бывшие «Заявки»): открыт с правом любого вида.
  const canOpenApps = roleCan(me, ['leads:read', 'applications:read']);
  const canOpenStudents = roleCan(me, 'students:read');

  // Период дашборда (URL-состояние + границы). Одни и те же from/to уходят
  // во ВСЕ запросы этого экрана и лежат в каждом queryKey: без этого
  // react-query отдал бы из кеша цифры предыдущего периода — тот же ключ,
  // другой смысл. Границы — календарные дни Asia/Dushanbe, бэкенд
  // разворачивает их в моменты (backend/src/common/query-date.ts).
  const period = useDashboardPeriod();
  const { range, invalid } = period;
  /** Какая карточка открыта в окне «подробнее». */
  const [detail, setDetail] = useState<DashboardDetailKind | null>(null);
  /** Карточка-кнопка: клик, Enter и пробел открывают окно подробностей. */
  const openable = (kind: DashboardDetailKind) => (!mayOpen(kind) ? undefined : {
    role: 'button' as const,
    tabIndex: 0,
    title: t('details.clickHint'),
    'data-testid': `card-${kind}`,
    onClick: () => setDetail(kind),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setDetail(kind);
      }
    },
  });

  // Период — часть каждого queryKey, значит ЛЮБОЕ переключение это промах
  // кеша, а глобальный keepPreviousData снят (lib/queryClient.ts, он ломал
  // чат). Без плейсхолдера на круг запроса экран обнуляется: «Всего заявок»
  // → «—», newCount/inProgress/enrolled/activeStudents → 0 из пустого
  // byStatus (неотличимо от честно пустого периода), все четыре разреза →
  // common.empty, а блоки «Финансы» и «Топ-3» размонтируются по своим
  // условиям и при возврате заново проигрывают анимацию входа — страница
  // прыгает. Держим прошлые цифры: тогда «...» у переключателя значит
  // именно «цифры за прошлый период, новые едут».
  //
  // При invalid плейсхолдера нет. Запросы туда и так не уходят (показывать
  // цифры за «период наоборот» нечестно — см. PeriodSwitcher), и оставить
  // на экране числа прошлого периода под красной ошибкой было бы тем же
  // самым враньём, только молчаливым.
  const keepPrev = invalid ? undefined : keepPreviousData;

  const appStatsQuery = useQuery({
    queryKey: keys.applications.stats(range),
    queryFn: () => applicationStats(range),
    enabled: !invalid,
    placeholderData: keepPrev,
  });
  const appStats = appStatsQuery.data ?? null;

  const stuStatsQuery = useQuery({
    queryKey: keys.students.stats(range),
    queryFn: () => studentStats(range),
    enabled: !invalid,
    placeholderData: keepPrev,
  });
  const stuStats = stuStatsQuery.data ?? null;

  const financeQuery = useQuery<FinanceSummary>({
    queryKey: keys.finance.summary(range),
    queryFn: () => financeSummary(range),
    enabled: showFinance && !invalid,
    placeholderData: keepPrev,
  });
  const finance = financeQuery.data ?? null;

  // Единственная карточка без периода: /finance/pending-payments отдаёт
  // не события за интервал, а текущих должников — «сколько студентов
  // должны прямо сейчас». Дату создания фильтровать тут не по чему.
  // Соседи по бенто (доход/расход/прибыль) фильтруются периодом, поэтому
  // карточка обязана сказать это сама: подпись — dashboard.finance.debtNow
  // («…сейчас»), ровно на месте period.suffix у остальных карточек.
  const pendingQuery = useQuery<any[]>({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
    enabled: showFinance,
  });
  const pending = pendingQuery.data ?? [];

  const leaderQuery = useQuery<KpiRow[]>({
    queryKey: ['kpi', 'leaderboard', 'top3', range],
    queryFn: () => leaderboard(range),
    enabled: showTop && !invalid,
    placeholderData: keepPrev,
  });
  // Места #1–3 — только тем, у кого есть результат (продажи или зачисления):
  // раньше места раздавались при 0 TJS и 0 зачислений (UX из QA-отчёта).
  const topPerformers = (leaderQuery.data ?? []).filter((p) => p.salesAmount > 0 || p.applicationsEnrolled > 0).slice(0, 3);

  // ── Сравнение с прошлым периодом той же длины (редизайн 2026) ──
  const prev = prevRangeOf(range, period.period, tjToday());
  const prevApp = useQuery({
    queryKey: keys.applications.stats(prev ?? { from: 'none' }),
    queryFn: () => applicationStats(prev!),
    enabled: !!prev && !invalid,
    staleTime: 60_000,
  });
  const prevStu = useQuery({
    queryKey: keys.students.stats(prev ?? { from: 'none' }),
    queryFn: () => studentStats(prev!),
    enabled: !!prev && !invalid,
    staleTime: 60_000,
  });
  const prevFin = useQuery<FinanceSummary>({
    queryKey: keys.finance.summary(prev ?? { from: 'none' }),
    queryFn: () => financeSummary(prev!),
    enabled: !!prev && showFinance && !invalid,
    staleTime: 60_000,
  });

  // ── Рабочие блоки: задачи на сегодня, платежи на одобрение, последние лиды ──
  const navCtx = buildNavCtx(me);
  const showTasks = navCtx.show('tasks:read', navCtx.isWorkforce);
  const tasksQuery = useQuery<Task[]>({
    queryKey: ['tasks', 'dashboard-today'],
    queryFn: () => listTasks(true),
    enabled: showTasks,
    staleTime: 30_000,
  });
  // Одобряет платежи основатель; сотрудник с ролью — по её галочке (как на странице сделки).
  const canApprove = roleCan(me, 'submissions:approve', isFounder(me as any));
  const approvalsQuery = useQuery({
    queryKey: ['submissions', 'pending-payments', 'dashboard'],
    queryFn: () => listPendingPayments(),
    enabled: canApprove,
    staleTime: 30_000,
  });
  const recentQuery = useQuery({
    queryKey: ['applications', 'dashboard-recent'],
    queryFn: () => listApplicationsPage({ page: 1, pageSize: 5, sort: '-createdAt' } as any),
    enabled: canOpenApps,
    staleTime: 30_000,
  });

  const busy =
    appStatsQuery.isFetching ||
    stuStatsQuery.isFetching ||
    financeQuery.isFetching ||
    leaderQuery.isFetching;

  // На экране лежат цифры ЧУЖОГО периода. isPlaceholderData тут точнее
  // busy: рефетч по тому же ключу (инвалидация из сокета) цифры не
  // подменяет — гасить нечего, а вот придержанные плейсхолдером обязаны
  // выглядеть неокончательными. Первая загрузка не stale: там честное
  // пустое состояние, а не чужие данные.
  const stale =
    appStatsQuery.isPlaceholderData ||
    stuStatsQuery.isPlaceholderData ||
    financeQuery.isPlaceholderData ||
    leaderQuery.isPlaceholderData;

  // Единственным индикатором загрузки был «...» в 12px у переключателя —
  // далеко от цифр, за которые он отвечает. Гасим сами сетки: видно, что
  // цифры ещё прошлого периода, и ровно там, куда смотрят.
  const staleStyle = { opacity: stale ? 0.55 : 1, transition: 'opacity .15s' };

  // «Период наоборот» — from позже to. Через UI недостижимо (пикеры связаны
  // min/max), но ссылку правят руками и пересылают:
  // ?period=custom&from=2026-08-01&to=2026-01-01. Запросы выше отключены и
  // плейсхолдера при invalid нет — значит данных нет вообще, и тело дашборда
  // рисовать нельзя. Пустой appStats даёт не «—», а честный ноль в карточках
  // 02–05 (sumWhere сворачивает пустой массив) и common.empty во всех четырёх
  // разрезах — ровно то, что человек увидел бы за реально пустой период.
  // Переключатель отказывается спрашивать сервер, а страница под ним тут же
  // ему противоречила, выдавая выдуманные нули за данные. Показываем только
  // переключатель с его красной ошибкой и объяснение, почему цифр нет.
  // Чип периода тоже убран: подписать пустоту «за выбранный период» нечем —
  // периода нет.
  //
  // Все хуки вызваны выше, поэтому ранний return здесь безопасен.
  if (invalid) {
    return (
      <>
        <PeriodSwitcher state={period} busy={busy} />

        <div className="card" style={{ padding: 24, color: 'var(--text-soft)', fontSize: 14 }}>
          {/* Пустая дата — «укажите обе», а не «наоборот» (QA №17). */}
          {period.invalidHint === t('dashboard.period.incomplete') ? t('dashboard.period.incompleteBody') : t('dashboard.period.invalidBody')}
        </div>
      </>
    );
  }

  // Срезы считаем предикатами, а не перечислением конкретных статусов:
  // статусов стало 10 и они ещё будут меняться, а пока миграция строк не
  // отработала, API отдаёт вперемешку новые и legacy-значения. Предикаты
  // (см. api/types.ts) знают про обе схемы, поэтому «Успешные» не покажут
  // ноль в окно между деплоем и миграцией.
  const byStatus: Array<{ status: string; _count: number }> = appStats?.byStatus || [];
  const sumWhere = (pred: (s: string) => boolean) =>
    byStatus.reduce((acc, row) => (pred(row.status) ? acc + (row._count || 0) : acc), 0);

  // null, пока ответа нет. keepPreviousData закрывает переключение периода,
  // но не первый заход на экран: там придерживать нечего, byStatus пуст и
  // sumWhere честно сворачивает его в 0 — неотличимо от результата «за период
  // ничего не создано». Карточка 01 так себя вела и раньше
  // (`appStats?.total ?? '—'`), 02–05 отставали.
  const newCount = appStats ? sumWhere(isNewLeadApplicationStatus) : null;
  const enrolled = appStats ? sumWhere(isFinishedApplicationStatus) : null;
  // «В работе» — всё, что уже не новый лид и ещё не закрытый исход.
  const inProgress = appStats
    ? sumWhere((s) => !isNewLeadApplicationStatus(s) && !isFinishedApplicationStatus(s))
    : null;

  // Заявки, у которых направление ещё не подтверждено человеком (в БД лежит
  // плейсхолдер). Они исключены из среза «по направлениям» — показываем их
  // числом рядом, чтобы срез не выглядел «потерявшим» половину заявок.
  const unconfirmedDirections = Number(appStats?.directionUnconfirmed ?? 0);
  // Сколько заявок пришло без страны: в byCountry такие строки не попадают
  // (бэкенд отсекает country IS NULL), а показать их надо — иначе сумма
  // строк карточки меньше «Всего заявок» без всякого объяснения.
  const countriesCounted = (appStats?.byCountry || [])
    .reduce((sum: number, c: any) => sum + (c._count || 0), 0);
  const countryUnset = Math.max(0, Number(appStats?.total ?? 0) - countriesCounted);

  /**
   * Ссылка из строки разреза в список, отфильтрованный ТЕМ ЖЕ условием и
   * ТЕМ ЖЕ периодом.
   *
   * Период обязателен. Без него клик по «Языковой + бакалавриат · 2»
   * открывал бы все такие заявки за всё время — человек видел бы семь строк
   * под цифрой «2» и считал, что дашборд врёт (он не врал: карточка
   * показывает выбранный период, а список показывал всё).
   */
  const listLink = (params: Record<string, string | undefined>, path = '/leads') => {
    if ((path === '/leads' && !canOpenApps) || (path === '/students' && !canOpenStudents)) return undefined;
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, v); });
    if (range.from) q.set('from', range.from);
    if (range.to) q.set('to', range.to);
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  };

  // ТЗ §4 «Активные клиенты» — берём ACTIVE студентов из stuStats.byStatus.
  // Фолбэка на stuStats.total тут быть не должно: Prisma groupBy не возвращает
  // строку для статуса, под который в периоде не попал ни один студент. Если
  // все заведённые за месяц студенты PAUSED/GRADUATED/ARCHIVED, ACTIVE-строки
  // просто нет — и total подставил бы ВСЕХ созданных за период под подписью
  // «Активные». Отсутствие строки означает ноль, так его и показываем.
  // Отсутствие строки — это ноль, а вот отсутствие самого ответа — ещё не число.
  const activeStudents = stuStats
    ? (stuStats.byStatus?.find((s: any) => s.status === 'ACTIVE')?._count ?? 0)
    : null;

  // Сравнение «к прошлому периоду»: доля роста и хорошо ли это.
  const prevByStatus: Array<{ status: string; _count: number }> = prevApp.data?.byStatus || [];
  const prevSum = (pred: (s: string) => boolean) =>
    prevByStatus.reduce((acc, row) => (pred(row.status) ? acc + (row._count || 0) : acc), 0);
  const prevActive = prevStu.data ? (prevStu.data.byStatus?.find((x: any) => x.status === 'ACTIVE')?._count ?? 0) : null;
  const cmp = (cur: number | null, before: number | null | undefined, upIsGood = true): Delta | undefined => {
    if (cur == null || before == null || !prev) return undefined;
    if (before === 0) return cur > 0 ? { text: `+${cur.toLocaleString('ru-RU')}`, tone: upIsGood ? 'good' : 'bad' } : { text: '0%', tone: 'flat' };
    const pct = Math.round(((cur - before) / Math.abs(before)) * 100);
    if (pct === 0) return { text: '0%', tone: 'flat' };
    const up = pct > 0;
    return { text: `${up ? '▲' : '▼'} ${Math.abs(pct)}%`, tone: up === upIsGood ? 'good' : 'bad' };
  };
  const vsPrev = prev ? t('dashboard.v2.vsPrev') : period.suffix;
  // Точные даты сравнения — подсказкой при наведении (чтобы «▲ 12%» было проверяемо).
  const prevTitle = prev ? `${t('dashboard.v2.comparedWith')} ${tjFormatDate(prev.from + 'T12:00:00Z')} — ${tjFormatDate(prev.to + 'T12:00:00Z')}` : undefined;

  const leadCards: KpiDef[] = [
    { kind: 'total', icon: 'groups', label: t('dashboard.kpi.total'), value: appStats?.total ?? null, delta: cmp(appStats?.total ?? null, prevApp.data?.total) },
    { kind: 'new', icon: 'person_add', label: t('dashboard.kpi.new'), value: newCount, delta: cmp(newCount, prevApp.data ? prevSum(isNewLeadApplicationStatus) : null) },
    { kind: 'pipeline', icon: 'pending_actions', label: t('dashboard.kpi.pipeline'), value: inProgress, delta: cmp(inProgress, prevApp.data ? prevSum((x) => !isNewLeadApplicationStatus(x) && !isFinishedApplicationStatus(x)) : null) },
    { kind: 'active', icon: 'school', label: t('dashboard.kpi.active'), value: activeStudents, delta: cmp(activeStudents, prevActive) },
    { kind: 'enrolled', icon: 'verified', label: t('dashboard.kpi.enrolled'), value: enrolled, delta: cmp(enrolled, prevApp.data ? prevSum(isFinishedApplicationStatus) : null) },
  ];

  // Задачи на сегодня: свои незакрытые со сроком до конца дня (и просроченные).
  const today = tjToday();
  const nowMs = Date.now();
  const todayTasks = (tasksQuery.data ?? [])
    .filter((x) => x.status !== 'DONE' && x.deadline && tjFormatDateKey(x.deadline) <= today)
    .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())
    .slice(0, 5);
  const overdueCount = todayTasks.filter((x) => new Date(x.deadline!).getTime() < nowMs).length;
  const approvals = (approvalsQuery.data ?? []).slice(0, 4);
  const recent = (recentQuery.data?.items ?? []).slice(0, 5);

  return (
    <>
      <PeriodSwitcher state={period} busy={busy} />
      <DashboardDetails kind={detail} range={range} periodLabel={period.suffix} onClose={() => setDetail(null)} />

      <section className="dash-kpis" aria-label={t('dashboard.v2.kpis')} style={staleStyle}>
        {leadCards.map((k, i) => (
          <KpiCard key={k.kind} def={k} index={i} note={vsPrev} noteTitle={prevTitle} open={openable(k.kind)} />
        ))}
      </section>

      {showFinance && finance && (
        <>
          <div className="crm-section-head dash-section-head">
            <div className="crm-section-titleline">
              <h2 className="crm-section-title">{t('dashboard.section.finance')}</h2>
              <PeriodChip suffix={period.suffix} />
            </div>
            {navCtx.show('finance:read', navCtx.elevated) && (
              <Link to="/finance?tab=analytics" className="dash-link" data-testid="dash-finance-analytics">
                {t('dashboard.v2.analytics')} <Icon name="arrow_forward" size={16} />
              </Link>
            )}
          </div>
          <section className="dash-kpis dash-kpis-money" style={staleStyle}>
            <KpiCard
              money
              def={{ kind: 'profit', icon: 'savings', label: t('dashboard.finance.netProfit'), value: finance.netProfit, delta: cmp(finance.netProfit, prevFin.data?.netProfit) }}
              note={vsPrev}
              noteTitle={prevTitle}
              open={openable('profit')}
              valueTestId="finance-profit-value"
              accent
            />
            <KpiCard
              money
              def={{ kind: 'income', icon: 'trending_up', label: t('dashboard.finance.income'), value: finance.totalIncome, delta: cmp(finance.totalIncome, prevFin.data?.totalIncome) }}
              note={vsPrev}
              noteTitle={prevTitle}
              open={openable('income')}
            />
            <KpiCard
              money
              def={{ kind: 'expense', icon: 'trending_down', label: t('dashboard.finance.expense'), value: finance.totalExpense, delta: cmp(finance.totalExpense, prevFin.data?.totalExpense, false) }}
              note={vsPrev}
              noteTitle={prevTitle}
              open={openable('expense')}
            />
            <KpiCard
              def={{ kind: 'debt', icon: 'hourglass_top', label: t('dashboard.finance.debtNow'), value: pending.length, delta: undefined }}
              note={t('dashboard.v2.now')}
              open={openable('debt')}
              warn={pending.length > 0}
            />
          </section>
        </>
      )}

      <section className="dash-grid-3">
        <BreakdownCard
          title={t('dashboard.breakdown.funnel')}
          subtitle={period.suffix}
          total={appStats?.total}
          action={canOpenApps ? { to: listLink({}) ?? '/leads', label: t('dashboard.v2.allLeads') } : undefined}
          rows={byStatus.map((s) => ({
            label: appStatusLabel(s.status),
            value: s._count,
            to: listLink({ status: s.status }),
          }))}
          style={staleStyle}
        />

        {showTasks && (
          <div className="card dash-card" data-testid="dash-tasks">
            <div className="dash-card-head">
              <h3 className="dash-card-title">{t('dashboard.v2.tasksToday')}</h3>
              {overdueCount > 0 && <span className="dash-pill is-warn">{t('dashboard.v2.overdue').replace('{n}', String(overdueCount))}</span>}
            </div>
            {tasksQuery.isLoading ? (
              <div className="dash-empty">{t('common.loading')}</div>
            ) : todayTasks.length === 0 ? (
              <div className="dash-empty">{t('dashboard.v2.noTasks')}</div>
            ) : (
              <ul className="dash-list">
                {todayTasks.map((task) => {
                  const late = new Date(task.deadline!).getTime() < nowMs;
                  return (
                    <li key={task.id}>
                      <Link to={`/tasks?task=${task.id}`} className="dash-row">
                        <Icon name={late ? 'error' : 'radio_button_unchecked'} size={18} className={late ? 'dash-ico-warn' : 'dash-ico-muted'} />
                        <span className="dash-row-main">
                          <span className="dash-row-title">{task.title}</span>
                          <span className={`dash-row-sub${late ? ' is-warn' : ''}`}>
                            {late ? `${t('dashboard.v2.overdueShort')} · ` : ''}
                            {tjFormatDateKey(task.deadline!) === today ? `${t('dashboard.v2.today')}, ${tjFormatTime(task.deadline)}` : tjFormatDate(task.deadline)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            <Link to="/tasks" className="dash-link">{t('dashboard.v2.allTasks')} <Icon name="arrow_forward" size={16} /></Link>
          </div>
        )}

        {showTop && (
          <div className="card dash-card" style={staleStyle} data-testid="dash-top">
            <div className="dash-card-head">
              <h3 className="dash-card-title">{t('dashboard.section.top')}</h3>
              <span className="dash-card-sub">{period.suffix}</span>
            </div>
            {topPerformers.length === 0 ? (
              <div className="dash-empty">{t('dashboard.v2.noTop')}</div>
            ) : (
              <ul className="dash-list">
                {topPerformers.map((p, i) => (
                  <li key={p.id} className="dash-person">
                    <span className={`dash-rank r${i + 1}`}>#{i + 1}</span>
                    <span className="dash-avatar">{initialsOf(p.fullName)}</span>
                    <span className="dash-row-main">
                      <span className="dash-row-title">{p.fullName}</span>
                      <span className="dash-row-sub">
                        {t('kpi.col.enrolled')}: {p.applicationsEnrolled} · {t('kpi.col.conversion')}: {p.conversionRate}%
                      </span>
                    </span>
                    <span className="dash-money">{fmtMoney(p.salesAmount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {navCtx.show('kpi:read', navCtx.isWorkforce) && <Link to="/kpi" className="dash-link">{t('dashboard.v2.allKpi')} <Icon name="arrow_forward" size={16} /></Link>}
          </div>
        )}
      </section>

      {(canApprove || canOpenApps) && (
        <section className="dash-grid-2">
          {canApprove && (
            <div className="card dash-card" data-testid="dash-approvals">
              <div className="dash-card-head">
                <h3 className="dash-card-title">
                  {t('dashboard.v2.approvals')}
                  {(approvalsQuery.data?.length ?? 0) > 0 && <span className="dash-count"> · {approvalsQuery.data!.length}</span>}
                </h3>
              </div>
              {approvalsQuery.isLoading ? (
                <div className="dash-empty">{t('common.loading')}</div>
              ) : approvals.length === 0 ? (
                <div className="dash-empty">{t('dashboard.v2.noApprovals')}</div>
              ) : (
                <ul className="dash-list">
                  {approvals.map((pay) => (
                    <li key={pay.id}>
                      <Link to={`/submissions/${pay.submissionId}`} className="dash-row">
                        <span className="dash-row-main">
                          <span className="dash-row-title">{pay.submission?.student?.fullName || (pay.submission as any)?.newStudentName || '—'}</span>
                          <span className="dash-row-sub">
                            {[pay.submission?.program?.name, pay.submission?.manager?.fullName].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <span className="dash-money">{fmtMoney(pay.amount, pay.submission?.currency || 'TJS')}</span>
                        <Icon name="chevron_right" size={18} className="dash-ico-muted" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/submissions?tab=pending" className="dash-link">{t('dashboard.v2.allApprovals')} <Icon name="arrow_forward" size={16} /></Link>
            </div>
          )}
          {canOpenApps && (
            <div className="card dash-card" data-testid="dash-recent">
              <div className="dash-card-head">
                <h3 className="dash-card-title">{t('dashboard.v2.recentLeads')}</h3>
              </div>
              {recentQuery.isLoading ? (
                <div className="dash-empty">{t('common.loading')}</div>
              ) : recent.length === 0 ? (
                <div className="dash-empty">{t('common.empty')}</div>
              ) : (
                <ul className="dash-list">
                  {recent.map((a: any) => (
                    <li key={a.id}>
                      <Link to={`/applications/${a.id}`} className="dash-row">
                        <span className="dash-avatar">{initialsOf(a.fullName)}</span>
                        <span className="dash-row-main">
                          <span className="dash-row-title">{a.fullName}</span>
                          <span className="dash-row-sub">{[a.phone, a.manager?.fullName || t('leads.manager.unassigned')].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="badge badge-gray">{appStatusLabel(a.status)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/leads" className="dash-link">{t('dashboard.v2.allLeads')} <Icon name="arrow_forward" size={16} /></Link>
            </div>
          )}
        </section>
      )}

      <div className="crm-section-head dash-section-head">
        <div className="crm-section-titleline">
          <h2 className="crm-section-title">{t('dashboard.section.breakdown')}</h2>
          <PeriodChip suffix={period.suffix} />
        </div>
      </div>
      <section className="dash-grid-3" style={staleStyle}>
        {/* Страны первыми: это единственный вопрос о цели обучения, на который
            клиент реально отвечает в форме сайта (направление там не спрашивают). */}
        <BreakdownCard
          title={t('dashboard.breakdown.countries')}
          total={appStats?.total}
          rows={[
            ...(appStats?.byCountry || []).map((c: any) => ({
              label: countryLabel(c.country),
              value: c._count,
              to: listLink({ country: c.country }),
            })),
            ...(countryUnset > 0
              ? [{ label: t('dashboard.breakdown.countryPending'), value: countryUnset, to: listLink({ countryPending: 'true' }), muted: true }]
              : []),
          ]}
        />
        <BreakdownCard
          title={t('dashboard.breakdown.directions')}
          total={appStats?.total}
          rows={[
            ...(appStats?.byDirection || []).map((d: any) => ({
              label: directionLabel(d.direction),
              value: d._count,
              to: listLink({ direction: d.direction }),
            })),
            ...(unconfirmedDirections > 0
              ? [{ label: t('dashboard.breakdown.directionsPending'), value: unconfirmedDirections, to: listLink({ directionPending: 'true' }), muted: true }]
              : []),
          ]}
        />
        <BreakdownCard
          title={t('dashboard.breakdown.cabinets')}
          total={stuStats?.total}
          rows={(stuStats?.byCabinet || []).map((c: any) => ({
            label: c.cabinet == null ? t('dashboard.breakdown.noCabinet') : `${t('app.field.cabinet')} ${c.cabinet}`,
            value: c._count,
            to: c.cabinet == null ? undefined : listLink({ cabinet: String(c.cabinet) }, '/students'),
          }))}
        />
      </section>
    </>
  );
}

/**
 * Подпись периода у заголовка секции: «за этот месяц».
 *
 * Одна на секцию, а не на каждую из тринадцати карточек: тринадцать
 * одинаковых подписей — шум, который перестают читать. Но и молчать
 * нельзя: дефолт дашборда — текущий месяц, а не «за всё время», и
 * человек, пролиставший переключатель или снявший скриншот карточки,
 * иначе никак не узнает, за что цифра. Чип едет вместе с заголовком,
 * поэтому попадает в кадр вместе с любой карточкой своей секции.
 *
 * Исключения из периода помечают себя сами в подписи карточки — так
 * сделана карточка должников (dashboard.finance.debtNow).
 */
function PeriodChip({ suffix }: { suffix: string }) {
  return <span className="crm-period-chip">{suffix}</span>;
}

type KpiDef = { kind: DashboardDetailKind; icon: string; label: string; value: number | null; delta?: Delta };

/** «2026-11-09» — календарный день срока по Душанбе. */
function tjFormatDateKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function initialsOf(name: string): string {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

/**
 * Карточка показателя: подпись, число, сравнение с прошлым периодом.
 * Порядок строк «подпись → число» держим: на него опираются автотесты окон
 * «подробнее» (вторая строка карточки — значение).
 */
function KpiCard({ def, note, noteTitle, open, index, money, accent, warn, valueTestId }: {
  def: KpiDef;
  note?: string;
  noteTitle?: string;
  open?: Record<string, unknown>;
  index?: number;
  money?: boolean;
  accent?: boolean;
  warn?: boolean;
  valueTestId?: string;
}) {
  const value = def.value == null ? '—' : money ? fmtMoney(def.value) : def.value.toLocaleString('ru-RU');
  return (
    <motion.div
      className={`dash-kpi${open ? ' is-clickable' : ''}${accent ? ' is-accent' : ''}${warn ? ' is-warn' : ''}`}
      {...(open ?? {})}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: (index ?? 0) * 0.03 }}
    >
      <div className="dash-kpi-label">
        <span>{def.label}</span>
      </div>
      <FitNumber
        testId={valueTestId ?? (index != null ? `kpi-value-${index}` : undefined)}
        style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </FitNumber>
      <div className="dash-kpi-foot" title={noteTitle}>
        {def.delta && <span className={`dash-delta is-${def.delta.tone}`}>{def.delta.text}</span>}
        {note && <span>{note}</span>}
      </div>
      {/* Значок — последним в разметке: строки карточки читаются «подпись → сумма». */}
      <span className="dash-kpi-icon is-corner" aria-hidden="true"><Icon name={def.icon} size={17} /></span>
    </motion.div>
  );
}

/** Разрез «строка → число → доля» со ссылкой в отфильтрованный список. */
function BreakdownCard({ title, subtitle, rows, total, action, style }: {
  title: string;
  subtitle?: string;
  rows: Array<{ label: string; value: any; to?: string; muted?: boolean }>;
  /** От чего считать доли — общее число за период, а не сумма строк. */
  total?: number;
  action?: { to: string; label: string };
  style?: React.CSSProperties;
}) {
  const { t } = useT();
  const rowsSum = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const base = total && total > 0 ? total : rowsSum || 1;
  return (
    <div className="card dash-card" style={style}>
      <div className="dash-card-head">
        <h3 className="dash-card-title">{title}</h3>
        {subtitle && <span className="dash-card-sub">{subtitle}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="dash-empty">{t('common.empty')}</div>
      ) : (
        <div className="dash-bars">
          {rows.map((r) => {
            const n = Number(r.value) || 0;
            const exact = (n / base) * 100;
            const pct = Math.round(exact);
            const pctLabel = n > 0 && pct === 0 ? '<1%' : `${pct}%`;
            const body = (
              <>
                <div className="dash-bar-top">
                  <span className={r.muted ? 'is-muted' : undefined}>{r.label}</span>
                  <span className="dash-bar-num">{r.value}<span> · {pctLabel}</span></span>
                </div>
                <div className="dash-bar-track">
                  <motion.div
                    className="dash-bar-fill"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.max(exact, n > 0 ? 1.5 : 0)}%` }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </>
            );
            return r.to ? (
              <Link key={r.label} to={r.to} className="breakdown-row is-link" title={t('dashboard.breakdown.openList')}>{body}</Link>
            ) : (
              <div key={r.label} className="breakdown-row">{body}</div>
            );
          })}
        </div>
      )}
      {action && <Link to={action.to} className="dash-link">{action.label} <Icon name="arrow_forward" size={16} /></Link>}
    </div>
  );
}
