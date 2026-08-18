import { motion } from 'framer-motion';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { applicationStats } from '../api/applications';
import { studentStats } from '../api/students';
import { financeSummary, pendingPayments, type FinanceSummary } from '../api/finance';
import { leaderboard, type KpiRow } from '../api/kpi';
import { DIRECTION_LABEL, isFinishedApplicationStatus, isNewLeadApplicationStatus } from '../api/types';
import { useAuth } from '../store/auth';
import { keys } from '../lib/queryKeys';
import { isElevated, hasRole } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useApplicationStatusLabel, useCountryLabel } from '../lib/labels';
import PeriodSwitcher, { useDashboardPeriod } from '../components/PeriodSwitcher';

function fmtMoney(n: number, c = 'TJS') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
}

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Dashboard() {
  const { t } = useT();
  const countryLabel = useCountryLabel();
  const appStatusLabel = useApplicationStatusLabel();
  const me = useAuth((s) => s.user);
  const isAdmin = isElevated(me);
  // hasRole учитывает мульти-роли (ТЗ §2). Раньше было `me?.role === 'ACCOUNTANT'`
  // — ловило только primary, юзер с roles=[ACCOUNTANT] проваливался.
  const isAccountant = hasRole(me, 'ACCOUNTANT');
  const showFinance = isAdmin || isAccountant;

  // Период дашборда (URL-состояние + границы). Одни и те же from/to уходят
  // во ВСЕ запросы этого экрана и лежат в каждом queryKey: без этого
  // react-query отдал бы из кеша цифры предыдущего периода — тот же ключ,
  // другой смысл. Границы — календарные дни Asia/Dushanbe, бэкенд
  // разворачивает их в моменты (backend/src/common/query-date.ts).
  const period = useDashboardPeriod();
  const { range, invalid } = period;

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
    enabled: isAdmin && !invalid,
    placeholderData: keepPrev,
  });
  const topPerformers = (leaderQuery.data ?? []).slice(0, 3);

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
        <div className="crm-section-head">
          <span className="crm-section-eyebrow">{t('eyebrow.kpi')}</span>
          <div className="crm-section-titleline">
            <h2 className="crm-section-title">{t('dashboard.title')}</h2>
          </div>
        </div>

        <PeriodSwitcher state={period} busy={busy} />

        <div className="card" style={{ padding: 24, color: 'var(--text-soft)', fontSize: 14 }}>
          {t('dashboard.period.invalidBody')}
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

  // Bento KPI cards
  const kpis: Array<{
    eyebrow: string; label: string; value: any; em?: string;
    accent?: 'feature' | 'accent' | undefined;
    span: string; row?: string;
  }> = [
    { eyebrow: `${t('eyebrow.total')} · 01`, label: t('dashboard.kpi.total'), value: appStats?.total ?? '—', accent: 'feature', span: 'span-4', row: 'row-2' },
    // `?? '—'` не ловит 0: настоящий ноль периода остаётся нулём, «—» видно
    // только пока данных нет.
    { eyebrow: `${t('eyebrow.new')} · 02`, label: t('dashboard.kpi.new'), value: newCount ?? '—', span: 'span-2' },
    { eyebrow: `${t('eyebrow.pipeline')} · 03`, label: t('dashboard.kpi.pipeline'), value: inProgress ?? '—', accent: 'accent', span: 'span-2' },
    { eyebrow: `${t('eyebrow.active')} · 04`, label: t('dashboard.kpi.active'), value: activeStudents ?? '—', span: 'span-3' },
    { eyebrow: `${t('eyebrow.win')} · 05`, label: t('dashboard.kpi.enrolled'), value: enrolled ?? '—', span: 'span-3' },
  ];

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.kpi')}</span>
        <div className="crm-section-titleline">
          <h2 className="crm-section-title">{t('dashboard.title')}</h2>
          <PeriodChip suffix={period.suffix} />
        </div>
      </div>

      <PeriodSwitcher state={period} busy={busy} />

      <div className="bento" style={{ marginBottom: 32, ...staleStyle }}>
        {kpis.map((k, i) => (
          <motion.div
            key={k.label}
            className={`bento-card${k.accent ? ' ' + k.accent : ''} ${k.span}${k.row ? ' ' + k.row : ''}`}
            variants={fadeUp}
            custom={i}
            initial="hidden"
            animate="show"
            whileHover={{ y: -3 }}
          >
            <span className="bento-num">{k.eyebrow}</span>
            <div style={{ marginTop: 'auto' }}>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: k.accent === 'feature' ? 'clamp(80px, 9vw, 128px)' : 'clamp(48px, 6vw, 80px)',
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 0.9,
                  marginBottom: 12,
                }}
              >
                {k.value}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: k.accent === 'feature' ? 'rgba(255,255,255,0.55)'
                  : k.accent === 'accent' ? 'rgba(5,7,6,0.65)'
                  : 'var(--text-soft)',
              }}>
                {k.label}
                {k.em && (
                  <span style={{
                    fontFamily: 'Times New Roman, Georgia, serif',
                    fontStyle: 'italic',
                    fontSize: 18,
                    letterSpacing: '-0.01em',
                    textTransform: 'none',
                    marginLeft: 8,
                    color: k.accent === 'feature' ? 'var(--primary-light)' : 'var(--primary-dark)',
                  }}>{k.em}</span>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Financial bento — visible only for ADMIN / ACCOUNTANT */}
      {showFinance && finance && (
        <>
          <div className="crm-section-head" style={{ marginTop: 8 }}>
            <span className="crm-section-eyebrow">{t('eyebrow.financeMoney')}</span>
            <div className="crm-section-titleline">
              <h2 className="crm-section-title">{t('dashboard.section.finance')}</h2>
              <PeriodChip suffix={period.suffix} />
            </div>
          </div>
          <div className="bento" style={{ marginBottom: 32, ...staleStyle }}>
            <motion.div
              className="bento-card feature span-3 row-2"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <span className="bento-num">PROFIT · 06</span>
              <div style={{ marginTop: 'auto' }}>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(56px, 7vw, 96px)',
                  fontWeight: 500,
                  letterSpacing: '-0.04em',
                  lineHeight: 0.9,
                  marginBottom: 12,
                }}>{fmtMoney(finance.netProfit)}</div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  color: 'rgba(255,255,255,0.55)',
                  textTransform: 'uppercase',
                }}>{`${t('dashboard.finance.netProfit')} ${period.suffix}`}</div>
              </div>
            </motion.div>

            <SmallBento
              eyebrow={`${t('eyebrow.income')} · 07`}
              label={t('dashboard.finance.income')}
              value={fmtMoney(finance.totalIncome)}
              accent
            />
            <SmallBento
              eyebrow={`${t('eyebrow.expense')} · 08`}
              label={t('dashboard.finance.expense')}
              value={fmtMoney(finance.totalExpense)}
            />
            <SmallBento
              eyebrow={`${t('dashboard.finance.debt')} · 09`}
              label={t('dashboard.finance.debtNow')}
              value={String(pending.length)}
              span="span-3"
            />
          </div>
        </>
      )}

      {/* Top 3 performers — only ADMIN */}
      {isAdmin && topPerformers.length > 0 && (
        <>
          <div className="crm-section-head" style={{ marginTop: 8 }}>
            <span className="crm-section-eyebrow">{t('eyebrow.topTeamLeader')}</span>
            <div className="crm-section-titleline">
              <h2 className="crm-section-title">{t('dashboard.section.top')}</h2>
              <PeriodChip suffix={period.suffix} />
            </div>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 14,
            marginBottom: 32,
            ...staleStyle,
          }}>
            {topPerformers.map((p, i) => (
              <motion.div
                key={p.id}
                className="card"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                style={{ padding: 24, position: 'relative' }}
              >
                <div style={{
                  position: 'absolute', top: 16, right: 20,
                  fontFamily: 'var(--font-display)',
                  fontSize: 28,
                  letterSpacing: '-0.02em',
                  color: i === 0 ? 'var(--primary-dark)' : 'var(--text-light)',
                }}>
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  color: 'var(--text-light)',
                  marginBottom: 8,
                  textTransform: 'uppercase',
                }}>RANK #{i + 1}</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                  marginBottom: 16,
                }}>{p.fullName}</div>
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 36,
                  fontWeight: 500,
                  letterSpacing: '-0.03em',
                  color: 'var(--primary-dark)',
                  marginBottom: 6,
                }}>{fmtMoney(p.salesAmount)}</div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.10em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                }}>{p.applicationsEnrolled} ENROLLED · {p.conversionRate}% CONV</div>
              </motion.div>
            ))}
          </div>
        </>
      )}

      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.details')}</span>
        <div className="crm-section-titleline">
          <h2 className="crm-section-title">{t('dashboard.section.breakdown')}</h2>
          <PeriodChip suffix={period.suffix} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, ...staleStyle }}>
        {/* Страны идут первыми: это единственный вопрос о цели обучения,
            на который клиент реально отвечает в форме лендинга. Раньше
            первым стоял срез «по направлениям», где 100% лидов с сайта
            показывались «Бакалавриатом» — направление формой не
            спрашивается, бэкенд подставлял плейсхолдер. */}
        <BreakdownCard
          eyebrow={`01 · ${t('eyebrow.countries')}`}
          title={t('dashboard.breakdown.countries')}
          rows={(appStats?.byCountry || []).map((c: any) => ({
            label: countryLabel(c.country),
            value: c._count,
          }))}
        />
        <BreakdownCard
          eyebrow={`02 · ${t('eyebrow.directions')}`}
          title={t('dashboard.breakdown.directions')}
          // Считаем только подтверждённые направления (бэкенд фильтрует по
          // directionConfirmed). Сноска объясняет, почему сумма меньше total:
          // без неё пустой/куцый срез выглядел бы как поломка дашборда.
          note={
            unconfirmedDirections > 0
              ? `${t('dashboard.breakdown.directionsPending')}: ${unconfirmedDirections}`
              : undefined
          }
          rows={(appStats?.byDirection || []).map((d: any) => ({
            label: DIRECTION_LABEL[d.direction as keyof typeof DIRECTION_LABEL] || d.direction,
            value: d._count,
          }))}
        />
        <BreakdownCard
          eyebrow={`03 · ${t('eyebrow.cabinets')}`}
          title={t('dashboard.breakdown.cabinets')}
          rows={(stuStats?.byCabinet || []).map((c: any) => ({
            label: `${t('app.field.cabinet')} ${c.cabinet}`,
            value: c._count,
          }))}
        />
        <BreakdownCard
          eyebrow={`04 · ${t('eyebrow.funnel')}`}
          title={t('dashboard.breakdown.funnel')}
          rows={byStatus.map((s) => ({
            // Через хук, а не через STATUS_LABEL: разрез по статусам обязан
            // переключаться на таджикский вместе с остальным дашбордом.
            label: appStatusLabel(s.status),
            value: s._count,
          }))}
        />
      </div>
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

function SmallBento({ eyebrow, label, value, accent, span = 'span-3' }: {
  eyebrow: string; label: string; value: string; accent?: boolean; span?: string;
}) {
  return (
    <motion.div
      className={`bento-card ${accent ? 'accent' : ''} ${span}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
    >
      <span className="bento-num">{eyebrow}</span>
      <div style={{ marginTop: 'auto' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(40px, 5vw, 56px)',
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
          marginBottom: 12,
        }}>{value}</div>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: accent ? 'rgba(5,7,6,0.65)' : 'var(--text-soft)',
        }}>{label}</div>
      </div>
    </motion.div>
  );
}

function BreakdownCard({
  eyebrow,
  title,
  rows,
  note,
}: {
  eyebrow: string;
  title: string;
  rows: Array<{ label: string; value: any }>;
  /** Пояснение под заголовком: почему сумма строк меньше общего числа. */
  note?: string;
}) {
  const { t } = useT();
  const total = rows.reduce((s, r) => s + (Number(r.value) || 0), 0) || 1;

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      style={{ padding: 24 }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.16em',
        color: 'var(--text-light)',
        marginBottom: 6,
      }}>
        {eyebrow}
      </div>
      <h3 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        marginBottom: note ? 6 : 20,
      }}>
        {title}
      </h3>
      {note && (
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: 'var(--text-light)',
          marginBottom: 20,
        }}>
          {note}
        </div>
      )}
      {rows.length === 0 ? (
        <div style={{ color: 'var(--text-light)', fontSize: 14, padding: '12px 0' }}>{t('common.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map((r) => {
            const pct = Math.round(((Number(r.value) || 0) / total) * 100);
            return (
              <div key={r.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 14 }}>{r.label}</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 500,
                  }}>
                    {r.value}
                    <span style={{ color: 'var(--text-light)', marginLeft: 6 }}>· {pct}%</span>
                  </span>
                </div>
                <div style={{
                  height: 4,
                  background: 'var(--bg-mute)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                    style={{
                      height: '100%',
                      background: 'var(--primary)',
                      borderRadius: 2,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
