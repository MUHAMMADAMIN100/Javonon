import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Transaction,
  TransactionType,
  TransactionCategory,
  TRANSACTION_CATEGORY_LABEL,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  CreateTransactionDto,
  PRODUCT_CATEGORIES,
  listTransactions,
  createTransaction,
  deleteTransaction,
  financeSummary,
  pendingPayments,
  financeIncomeSources,
  financeIncomeByProduct,
  financeBreakdown,
  FinanceBreakdown,
  FinanceSummary,
  IncomeSource,
  NonTjsTotals,
  ProductCategoryEnum,
  PaymentPhaseStatus,
} from '../api/finance';
import { listStudents } from '../api/students';
import { listUsers } from '../api/users';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { aiAddTransaction } from '../api/ai';
import { financeTimeseries, type TimeseriesPoint } from '../api/finance';
import { listPayments, confirmPayment, rejectPayment, type Payment, PAYMENT_METHOD_LABEL } from '../api/payments';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import CrmDatePicker from '../components/CrmDatePicker';
import { tjToday } from '../lib/tjTime';
import { useT } from '../lib/i18n';
import { useRealtime } from '../realtime';
import { useAuth } from '../store/auth';
import { hasRole, isElevated } from '../lib/roles';
import { hasPermission } from '../lib/permissions';

function fmtMoney(n: number, currency = 'TJS'): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Компактная строка вида «В ПЕРИОДЕ ТАКЖЕ · USD +5 000 / −200 · EUR +200».
 * Показываем под KPI/над пирогами когда backend вернул `nonTjsTotals` с
 * ненулевыми суммами. Мотивация: backend считает все агрегаты только в
 * TJS, но фиксирует валютные транзакции периода отдельно — бухгалтер
 * должен видеть, что USD/EUR активность была, иначе дашборд молча
 * «прячет» реальную выручку (см. commit-audit по currency mixing).
 *
 * `kind` фильтрует, что показывать: для income-пирогов не нужно тащить
 * валютные расходы, для expense-пирога — наоборот. Без `kind` (например
 * под netProfit-KPI) показываем и то и другое, чтобы дать полную картину.
 */
function NonTjsStrip({
  totals,
  color = 'var(--text-soft)',
  kind,
}: {
  totals?: NonTjsTotals | null;
  color?: string;
  kind?: 'income' | 'expense';
}) {
  if (!totals) return null;
  const entries = Object.entries(totals);
  if (entries.length === 0) return null;

  const parts: string[] = [];
  for (const [cur, bucket] of entries) {
    const bits: string[] = [];
    if ((!kind || kind === 'income') && bucket.income > 0) {
      bits.push(`+${fmtMoney(bucket.income, cur)}`);
    }
    if ((!kind || kind === 'expense') && bucket.expense > 0) {
      bits.push(`−${fmtMoney(bucket.expense, cur)}`);
    }
    if (bits.length > 0) parts.push(`${cur} ${bits.join(' / ')}`);
  }
  if (parts.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 8,
        marginBottom: 8,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.08em',
        color,
        textTransform: 'uppercase',
      }}
      title="Валютные транзакции в периоде — обрабатываются бухгалтером вручную, не входят в TJS-агрегаты выше"
    >
      В периоде также · {parts.join(' · ')}
    </div>
  );
}

/**
 * Маленький бэйдж «BASE · TJS» рядом с eyebrow пирога/ранжирования.
 *
 * Мотивация: агрегаты дашборда считаются только в одной валюте
 * (`REPORTING_CURRENCY` на backend), но раньше UI никак не сообщал, в чём
 * именно считает — и пользователь смотрел на пустой пирог или неполный
 * «ТОП» без понимания, что USD/EUR-транзакции просто отфильтрованы (см.
 * audit HIGH — «pie charts silently hide currency-based bias»). Бэйдж
 * ставим справа от eyebrow, tooltip раскрывает причину.
 */
function CurrencyBadge({ currency }: { currency: string }) {
  return (
    <span
      title={`Все суммы посчитаны в ${currency}. Транзакции в других валютах не входят в этот разрез — см. подсказку «В ПЕРИОДЕ ТАКЖЕ» если такие суммы есть.`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        border: '1px solid var(--border)',
        borderRadius: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.1em',
        color: 'var(--text-soft)',
        textTransform: 'uppercase',
        lineHeight: 1.2,
      }}
    >
      BASE · {currency}
    </span>
  );
}

export default function Finance() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  // === Role/permission gating (audit HIGH — SALES_MANAGER на /finance) ===
  // До фикса каждая кнопка/форма рендерилась безусловно: SALES_MANAGER,
  // которому FOUNDER дал `finance:read` (кастомная роль «Наблюдатель за
  // выручкой»), или который просто набрал /finance в адресной строке,
  // видел UI как FOUNDER — DELETE-иконку, форму EXPENSE, подтверждение
  // клиентских платежей — и каждая мутация оборачивалась в 403 от backend.
  // Зеркалим backend-политику (finance.controller.ts, payments.controller.ts,
  // finance.service.ts::create/remove) прямо в UI, чтобы не давать
  // недоступные действия визуально.
  const me = useAuth((s) => s.user);
  // Собственный id — используется как self-attribute-fallback для
  // managerId non-elevated пользователей: backend всё равно перезапишет
  // managerId на caller.id (finance.service.ts), а UI явно показывает
  // «оформляю на себя», чтобы SALES_MANAGER не удивлялся, что строчка
  // ушла на его имя вместо чужого менеджера, привязанного к заявке.
  const mySelfId = me?.id ?? '';
  // FOUNDER / ADMIN / ACCOUNTANT — полный доступ к финмодулю.
  const elevated = isElevated(me);
  // Кастомная роль (Настройки → Роли) в backend RolesGuard ЗАМЕНЯЕТ базу
  // (см. roles.guard.ts skipBaseRole). Держим тот же флаг, чтобы
  // SALES_MANAGER с custom-role «Наблюдатель» (только finance:read) не
  // получал по base-role доступ к POST /finance/transactions.
  const hasCustomRole = !!(me?.customRoleId);
  const managerBaseRole = hasRole(me, 'SALES_MANAGER', 'CLIENT_MANAGER');
  // POST /finance/transactions: @Roles('ADMIN','ACCOUNTANT','SALES_MANAGER',
  // 'CLIENT_MANAGER'). custom-role пропускает по явному permission.
  const canCreateTx =
    elevated ||
    (!hasCustomRole && managerBaseRole) ||
    hasPermission(me, 'finance:create', 'finance:write');
  // DELETE /finance/transactions/:id — @Roles('ADMIN','ACCOUNTANT') на
  // контроллере (finance.controller.ts:223+374). custom-role может открыть
  // явным `finance:delete`/`finance:write`.
  const canDeleteTx =
    elevated || hasPermission(me, 'finance:delete', 'finance:write');
  // POST /payments/:id/confirm|reject — @Roles('ADMIN','ACCOUNTANT') на
  // контроллере (payments.controller.ts:13). Бухгалтерская мутация уровня
  // FOUNDER, custom-role сюда сознательно не пускаем без явного расширения
  // backend — иначе SALES_MANAGER с `finance:read` увидит клиентские
  // «поступления в кассу» и сможет подтвердить чужие деньги.
  const canReviewPayments = elevated;
  // AI-add — раньше был доступен всем ролям и мог создать EXPENSE (модель
  // сама решает тип по фразе). Non-elevated тогда молча ловил 403 после
  // распознавания. Раз EXPENSE запрещён, оставляем AI-quick-entry только
  // elevated: у них семантика «быстро набросать любой тип», у менеджера —
  // явная форма INCOME.
  const canUseAiAdd = elevated;
  // POST /finance/transactions на backend: type=EXPENSE разрешён только
  // FOUNDER / ADMIN / ACCOUNTANT (finance.controller.ts:291). Раньше форма
  // «Новая транзакция» показывала EXPENSE всем: SALES_MANAGER выбирал
  // «Расход», заполнял всё, uploadReceipt POST'ил файл на диск,
  // createTransaction возвращал 403 → orphan-файл в /uploads/ + непонятный
  // Russian toast. Гейтим по роли на клиенте: hide-option (a) — самый
  // чистый вариант, менеджер даже не видит EXPENSE, поэтому не может
  // случайно потянуть файл на диск. Backend-проверка остаётся источником
  // истины (см. finance.controller.ts).
  const canExpense = hasRole(me, 'FOUNDER', 'ADMIN', 'ACCOUNTANT');
  const [filterType, setFilterType] = useState<TransactionType | ''>('');
  const [filterIncomeSource, setFilterIncomeSource] = useState<IncomeSource | ''>('');
  const [filterProductEnum, setFilterProductEnum] = useState<ProductCategoryEnum | ''>('');
  const [filterPaymentPhase, setFilterPaymentPhase] = useState<PaymentPhaseStatus | ''>('');
  const [showForm, setShowForm] = useState(false);
  const [aiInput, setAiInput] = useState('');

  const txKey = keys.finance.transactions(filterType ? { type: filterType, take: 200 } : { take: 200 });
  const txQuery = useQuery({
    queryKey: txKey,
    queryFn: () => listTransactions(filterType ? { type: filterType, take: 200 } : { take: 200 }),
  });
  const allTransactions = txQuery.data ?? [];
  // Клиентская доп-фильтрация по новым Google-Sheet-parity полям
  // (backend их пока не принимает как ?query-параметры — фильтруем
  // локально). Активно только когда пользователь ставит хоть один
  // из фильтров источник/продукт/фаза.
  const transactions = useMemo(() => {
    if (!filterIncomeSource && !filterProductEnum && !filterPaymentPhase) {
      return allTransactions;
    }
    return allTransactions.filter((tx) => {
      if (filterIncomeSource && tx.incomeSource !== filterIncomeSource) return false;
      if (filterProductEnum && tx.productCategoryEnum !== filterProductEnum) return false;
      if (filterPaymentPhase && tx.paymentPhase !== filterPaymentPhase) return false;
      return true;
    });
  }, [allTransactions, filterIncomeSource, filterProductEnum, filterPaymentPhase]);

  const summaryQuery = useQuery({
    queryKey: keys.finance.summary(),
    queryFn: () => financeSummary(),
  });
  const summary = summaryQuery.data ?? null;

  const pendingQuery = useQuery({
    queryKey: keys.finance.pending(),
    queryFn: () => pendingPayments(),
  });
  const pending = pendingQuery.data ?? [];

  const seriesQuery = useQuery({
    queryKey: keys.finance.timeseries({ bucket: 'week' }),
    queryFn: () => financeTimeseries({ bucket: 'week' }),
  });
  const series = seriesQuery.data ?? [];

  // Распределение 70/20/10 за текущий месяц + топ менеджеров
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const distributionQuery = useQuery({
    queryKey: ['finance', 'distribution', monthStart],
    queryFn: async () => {
      const m = await import('../api/finance');
      return m.financeDistribution({ from: monthStart });
    },
  });
  const distribution = distributionQuery.data;

  const topManagersQuery = useQuery({
    queryKey: ['finance', 'top-managers', monthStart],
    queryFn: async () => {
      const m = await import('../api/finance');
      return m.financeTopManagers({ from: monthStart, limit: 10 });
    },
  });
  // Backend теперь отдаёт объект { managers, currency, nonTjsTotals } (вместо
  // плоского массива), чтобы UI мог показать бэйдж базовой валюты и
  // подсказку про «в периоде были ещё продажи в USD/EUR» — см. audit HIGH
  // «pie charts silently hide currency-based bias».
  const topManagers = topManagersQuery.data?.managers ?? [];
  const topManagersCurrency = topManagersQuery.data?.currency ?? 'TJS';
  const topManagersNonTjs = topManagersQuery.data?.nonTjsTotals;

  const incomeSourcesQuery = useQuery({
    queryKey: ['finance', 'income-sources', monthStart],
    queryFn: () => financeIncomeSources({ from: monthStart }),
  });
  const incomeSources = incomeSourcesQuery.data ?? [];

  const incomeByProductQuery = useQuery({
    queryKey: ['finance', 'income-by-product', monthStart],
    queryFn: () => financeIncomeByProduct({ from: monthStart }),
  });
  const incomeByProduct = incomeByProductQuery.data ?? [];

  // === Dashboard breakdown (3 pie charts): source / manager / expense category
  // за выбранный период (This month / Last month / Custom range). Диапазон
  // считаем на фронте и передаём явные from/to — так «This month» это
  // календарный месяц, а не «последние 30 дней» (что backend вернул бы для
  // period=month).
  type BreakdownPeriod = 'THIS_MONTH' | 'LAST_MONTH' | 'CUSTOM';
  const [bdPeriod, setBdPeriod] = useState<BreakdownPeriod>('THIS_MONTH');
  const [bdFrom, setBdFrom] = useState<string>('');
  const [bdTo, setBdTo] = useState<string>('');

  const bdRange = useMemo<{ from?: string; to?: string }>(() => {
    const now = new Date();
    if (bdPeriod === 'THIS_MONTH') {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: from.toISOString() };
    }
    if (bdPeriod === 'LAST_MONTH') {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    return {
      ...(bdFrom && { from: new Date(bdFrom).toISOString() }),
      ...(bdTo && { to: new Date(bdTo).toISOString() }),
    };
  }, [bdPeriod, bdFrom, bdTo]);

  const breakdownQuery = useQuery({
    queryKey: keys.finance.breakdown(bdRange),
    queryFn: () => financeBreakdown(bdRange),
  });
  const breakdown = breakdownQuery.data;

  const paymentsKey = keys.payments.list({ status: 'PENDING' });
  const paymentsQuery = useQuery({
    queryKey: paymentsKey,
    queryFn: () => listPayments('PENDING'),
  });
  const paymentRequests = paymentsQuery.data ?? [];

  const studentsQuery = useQuery({
    queryKey: keys.students.list(),
    queryFn: () => listStudents({}),
  });
  const students = studentsQuery.data ?? [];

  const usersQuery = useQuery({
    queryKey: keys.users.list(),
    queryFn: () => listUsers(),
  });
  const users = usersQuery.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.finance.all });
    qc.invalidateQueries({ queryKey: keys.payments.all });
  };

  // Realtime: подписываемся на WS-события из finance/payments/submissions
  // сервисов и invalidate'им соответствующие queryKeys. Backend эмитит эти
  // события в `staff`-комнату (см. finance.service.ts:566, 863, 1223 и
  // payments.service.ts:78, 158-159, submissions.service.ts:1065, 1308).
  //
  // Ранее Finance.tsx не подписывался ни на одно из них, из-за чего
  // FOUNDER + ACCOUNTANT, одновременно работающие с /finance, видели
  // stale summary/breakdown/topManagers до hard reload — именно тот
  // сценарий, ради которого backend WS-emit'ы были добавлены.
  //
  // Debounce: серия быстрых POST'ов (импорт, массовые операции) может
  // прилететь плотным потоком; каждый invalidate триггерит перезапрос
  // тяжёлых aggregate-эндпоинтов (summary/breakdown/topManagers/
  // distribution). Собираем инвалидации в 400ms-окно, чтобы не долбить
  // backend по 5+ раз в секунду. Ref-flags удерживают, какие бакеты
  // нужно инвалидировать по итогу окна.
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInvalidateRef = useRef<{ finance: boolean; payments: boolean }>({
    finance: false,
    payments: false,
  });
  const scheduleInvalidate = (buckets: { finance?: boolean; payments?: boolean }) => {
    if (buckets.finance) pendingInvalidateRef.current.finance = true;
    if (buckets.payments) pendingInvalidateRef.current.payments = true;
    if (invalidateTimerRef.current) return;
    invalidateTimerRef.current = setTimeout(() => {
      invalidateTimerRef.current = null;
      const flags = pendingInvalidateRef.current;
      pendingInvalidateRef.current = { finance: false, payments: false };
      if (flags.finance) qc.invalidateQueries({ queryKey: keys.finance.all });
      if (flags.payments) qc.invalidateQueries({ queryKey: keys.payments.all });
    }, 400);
  };
  useEffect(() => {
    return () => {
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  useRealtime({
    // Транзакции: любое изменение — списка, summary, breakdown, timeseries,
    // topManagers, distribution, income-sources, income-by-product зависят
    // от финансовых данных, поэтому инвалидируем всё дерево finance.
    'transaction:new': () => scheduleInvalidate({ finance: true }),
    'transaction:updated': () => scheduleInvalidate({ finance: true }),
    'transaction:deleted': () => scheduleInvalidate({ finance: true }),
    // Рефанд по TUITION_PAYMENT создаёт reverse-пару транзакций и
    // пересчитывает баланс студента — те же aggregate'ы уходят в stale.
    'transaction:reversed': () => scheduleInvalidate({ finance: true }),
    // Payments: приход новой заявки и её подтверждение должны обновить
    // и список PENDING (payments.list), и pending-виджет + summary
    // (payments confirmed => появляется новая транзакция в finance).
    'payment:pending': () => scheduleInvalidate({ payments: true, finance: true }),
    'payment:confirmed': () => scheduleInvalidate({ payments: true, finance: true }),
  });

  // Confirm payment — оптимистично убираем из PENDING-списка.
  const confirmPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => confirmPayment(p.id, {}),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.finance.all, keys.payments.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rejectPayMut = useOptimisticMutation<Payment, Payment, Payment[]>({
    mutationFn: (p) => rejectPayment(p.id),
    queryKey: paymentsKey,
    applyOptimistic: (cur, p) => optimistic.removeById(cur, p.id),
    invalidateAlso: [keys.payments.all],
    onSuccess: () => toast(t('toast.updated'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteTxMut = useOptimisticMutation<unknown, string, Transaction[]>({
    mutationFn: deleteTransaction,
    queryKey: txKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.finance.all],
    onSuccess: () => toast(t('toast.deleted'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const aiMut = useInvalidatingMutation({
    mutationFn: aiAddTransaction,
    invalidate: [keys.finance.all],
    onSuccess: (res: any) => {
      if (res.ok) {
        toast(`${res.transaction?.type === 'INCOME' ? '+' : '−'}${res.transaction?.amount}${res.transaction?.currency}`, 'success');
        setAiInput('');
      } else {
        toast(res.error || t('toast.error'), 'error');
      }
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  const aiBusy = aiMut.isPending;

  const onConfirmPayment = async (p: Payment) => {
    const ok = await confirm({
      title: t('finance.payment.confirm') + '?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      confirmText: t('finance.payment.confirm'),
    });
    if (!ok) return;
    confirmPayMut.mutate(p);
  };

  const onRejectPayment = async (p: Payment) => {
    const ok = await confirm({
      title: t('finance.payment.reject') + '?',
      message: `${p.student?.fullName}: ${fmtMoney(p.amount, p.currency)}`,
      danger: true,
      confirmText: t('finance.payment.reject'),
    });
    if (!ok) return;
    rejectPayMut.mutate(p);
  };

  const onAi = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiInput.trim() || aiBusy) return;
    aiMut.mutate(aiInput);
  };

  const onDelete = async (tx: Transaction) => {
    const ok = await confirm({
      title: t('finance.confirm.delete'),
      message: `${tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')} ${fmtMoney(tx.amount, tx.currency)}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    deleteTxMut.mutate(tx.id);
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.finance08')}</span>
        <h2 className="crm-section-title">{t('finance.title')}</h2>
      </div>

      {/* === Дашборд: 3 пироговые диаграммы (источник дохода / менеджеры /
          категория расходов) с переключателем периода. Данные — единый
          агрегат /finance/breakdown. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        flexWrap: 'wrap', marginBottom: 12,
      }}>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em',
          color: 'var(--primary-dark)', textTransform: 'uppercase',
        }}>
          BREAKDOWN · PERIOD
        </div>
        <div className="pagination-controls" style={{ padding: 4 }}>
          <button
            className={bdPeriod === 'THIS_MONTH' ? 'active' : ''}
            onClick={() => setBdPeriod('THIS_MONTH')}
          >
            This month
          </button>
          <button
            className={bdPeriod === 'LAST_MONTH' ? 'active' : ''}
            onClick={() => setBdPeriod('LAST_MONTH')}
          >
            Last month
          </button>
          <button
            className={bdPeriod === 'CUSTOM' ? 'active' : ''}
            onClick={() => setBdPeriod('CUSTOM')}
          >
            Custom range
          </button>
        </div>
        {bdPeriod === 'CUSTOM' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <CrmDatePicker className="crm-input" value={bdFrom} onChange={(v) => setBdFrom(v)} />
            <span style={{ color: 'var(--text-soft)' }}>—</span>
            <CrmDatePicker className="crm-input" value={bdTo} onChange={(v) => setBdTo(v)} />
          </div>
        )}
        {breakdownQuery.isFetching && (
          <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>...</span>
        )}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 16,
        marginBottom: 32,
      }}>
        <PieCard
          eyebrow="INCOME · BY SOURCE"
          title="Источник дохода"
          items={rollupPieSlices(
            breakdown?.byIncomeSource,
            (s) => ({ label: s.label, value: s.amount, count: s.count }),
            'Прочее',
          )}
          currency={breakdown?.currency ?? 'TJS'}
          nonTjsTotals={breakdown?.nonTjsTotals}
          nonTjsKind="income"
        />
        <PieCard
          eyebrow="INCOME · BY MANAGER"
          title="Клиенты (менеджеры)"
          items={rollupPieSlices(
            breakdown?.byManager,
            (m) => ({
              label: m.manager?.fullName || 'Без менеджера',
              value: m.amount,
              count: m.count,
            }),
            'Прочие менеджеры',
          )}
          currency={breakdown?.currency ?? 'TJS'}
          nonTjsTotals={breakdown?.nonTjsTotals}
          nonTjsKind="income"
        />
        <PieCard
          eyebrow="EXPENSE · BY CATEGORY"
          title="Категория расходов"
          items={rollupPieSlices(
            breakdown?.byExpenseCategory,
            (c) => ({
              label:
                TRANSACTION_CATEGORY_LABEL[c.category as TransactionCategory] ||
                String(c.category),
              value: c.amount,
              count: c.count,
            }),
            'Прочие категории',
          )}
          currency={breakdown?.currency ?? 'TJS'}
          nonTjsTotals={breakdown?.nonTjsTotals}
          nonTjsKind="expense"
        />
      </div>

      {/* Bento с финансовой сводкой */}
      {summary && (
        <div className="bento" style={{ marginBottom: 32 }}>
          <motion.div
            className="bento-card feature span-3 row-2"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <span className="bento-num">{t('eyebrow.revenue')} · 01</span>
            <div style={{ marginTop: 'auto' }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(64px, 8vw, 104px)',
                fontWeight: 500,
                letterSpacing: '-0.04em',
                lineHeight: 0.9,
                marginBottom: 16,
              }}>
                {fmtMoney(summary.netProfit)}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
              }}>
                {t('dashboard.finance.netProfit')}
              </div>
              {/* Бухгалтерский баннер: суммы в USD/EUR/CNY/RUB не входят в
                  KPI выше (backend считает всё в TJS), но были в периоде и
                  ждут ручной обработки. Пустой `nonTjsTotals` → баннер
                  не рисуется. */}
              <NonTjsStrip
                totals={summary.nonTjsTotals}
                color="rgba(255,255,255,0.72)"
              />
            </div>
          </motion.div>

          <KpiBento eyebrow={`${t('eyebrow.income')} · 02`} label={t('dashboard.finance.income')} value={fmtMoney(summary.totalIncome)} accent />
          <KpiBento eyebrow={`${t('eyebrow.expense')} · 03`} label={t('dashboard.finance.expense')} value={fmtMoney(summary.totalExpense)} />
          <KpiBento eyebrow={`${t('eyebrow.count')} · 04`} label={t('finance.transactions')} value={String(summary.incomeCount + summary.expenseCount)} span="span-3" />
        </div>
      )}

      {/* AI quick add — только elevated (FOUNDER/ADMIN/ACCOUNTANT).
          Модель распознавания сама решает, INCOME это или EXPENSE, а
          POST /finance/transactions блокирует EXPENSE для менеджеров
          (finance.controller.ts:291). Раньше SALES_MANAGER писал
          «купили бумагу 200» → форма отправляла EXPENSE → 403 + generic
          error toast без объяснения, что EXPENSE ему запрещён. */}
      {canUseAiAdd && (
      <motion.form
        onSubmit={onAi}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: 'var(--text)',
          color: 'white',
          padding: 18,
          borderRadius: 18,
          marginBottom: 24,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'var(--primary)',
          color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name="auto_awesome" size={18} />
        </div>
        <div style={{ flexShrink: 0 }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.16em',
            color: 'var(--primary-light)',
            marginBottom: 4,
            textTransform: 'uppercase',
          }}>AI · QUICK ENTRY</div>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 500,
          }}>{t('finance.ai.title')}</div>
        </div>
        <input
          value={aiInput}
          onChange={(e) => setAiInput(e.target.value)}
          placeholder={t('finance.ai.placeholder')}
          style={{
            flex: 1,
            minWidth: 240,
            padding: '12px 16px',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.16)',
            color: 'white',
            borderRadius: 100,
            fontSize: 14,
            fontFamily: 'inherit',
          }}
        />
        <button
          type="submit"
          className="btn"
          style={{
            background: 'var(--primary)',
            color: 'white',
            border: 'none',
          }}
          disabled={aiBusy || !aiInput.trim()}
        >
          {aiBusy ? t('common.saving') : t('common.add')} <Icon name="arrow_outward" size={14} />
        </button>
      </motion.form>
      )}

      {/* Revenue chart (timeseries) */}
      {series.length > 0 && (
        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--primary-dark)',
            marginBottom: 6,
          }}>REVENUE · WEEKLY</div>
          <h3 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: '-0.02em',
            marginBottom: 24,
          }}>{t('finance.chart.title')}</h3>
          <RevenueChart points={series} />
        </div>
      )}

      {/* Распределение 70/20/10 + Топ менеджеров */}
      {distribution && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 32 }}>
          <div className="card" style={{ padding: 24 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
              color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            }}>
              <span>DISTRIBUTION · 70/20/10</span>
              <CurrencyBadge currency={distribution.currency ?? 'TJS'} />
            </div>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
              {t('finance.dist.title')}
            </h3>
            <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
              <b style={{ color: distribution.net >= 0 ? '#15803d' : '#b91c1c' }}>
                {distribution.net.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
              </b>
            </div>
            {/* Валютная активность за тот же период (не входит в 70/20/10 —
                backend распределяет только TJS-net-profit). */}
            <NonTjsStrip totals={distribution.nonTjsTotals} />
            <DistRow label={t('finance.dist.business')} pct={70} amount={distribution.distribution.business} color="#3b82f6" />
            <DistRow label={t('finance.dist.debts')} pct={20} amount={distribution.distribution.debts} color="#f59e0b" />
            <DistRow label={t('finance.dist.reserve')} pct={10} amount={distribution.distribution.reserve} color="#10b981" />
          </div>

          <div className="card" style={{ padding: 24 }}>
            {/* Currency-бэйдж на eyebrow: раньше пользователь видел
                ранжирование в «безразмерных числах» и не понимал, что оно
                посчитано только по TJS-INCOME. Менеджер с USD-only-продажами
                молча выпадал из «ТОП» — бэйдж делает базу расчёта явной,
                а `NonTjsStrip` ниже показывает, что валютная активность
                была. */}
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
              color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            }}>
              <span>TOP MANAGERS · MONTH</span>
              <CurrencyBadge currency={topManagersCurrency} />
            </div>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
              {t('finance.topManagers.title')}
            </h3>
            {/* Ранжирование считается только по TJS-INCOME — валютные
                продажи «выпадают» из топ-листа. Показываем их отдельно,
                чтобы менеджеры с USD-only-выручкой не терялись молча. */}
            <NonTjsStrip totals={topManagersNonTjs} kind="income" />
            {topManagers.length === 0 ? (
              <div style={{ color: 'var(--text-soft)', textAlign: 'center', padding: 24 }}>
                {t('common.empty')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {topManagers.map((tm, i) => {
                  const total = topManagers.reduce((s, x) => s + x.amount, 0);
                  const pct = total > 0 ? (tm.amount / total) * 100 : 0;
                  return (
                    <div key={tm.manager.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 13 }}>
                          <b>#{i + 1}</b> {tm.manager.fullName} · {tm.count}
                        </span>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>
                          {tm.amount.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
                          <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                            ({pct.toFixed(0)}%)
                          </span>
                        </span>
                      </div>
                      <div style={{ height: 6, background: 'var(--bg-soft)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--primary)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Диаграммы: источники дохода + доход по продуктам */}
      {(incomeSources.length > 0 || incomeByProduct.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 32 }}>
          {incomeSources.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              {/* Backend отдаёт только TJS-агрегаты (см. incomeSources в
                  finance.service.ts). Бэйдж «BASE · TJS» напоминает
                  пользователю, что валютная активность в этот разрез не
                  попадает. */}
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
                color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                <span>INCOME SOURCES · MONTH</span>
                <CurrencyBadge currency="TJS" />
              </div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
                Источники <em style={{ fontFamily: 'Times New Roman, Georgia, serif' }}>дохода.</em>
              </h3>
              <BarList
                items={incomeSources.map((s) => ({ label: s.label, value: s.amount, sub: `${s.count} шт` }))}
                colors={['#3b82f6', '#06b6d4', '#f59e0b', '#10b981', '#94a3b8']}
              />
            </div>
          )}
          {incomeByProduct.length > 0 && (
            <div className="card" style={{ padding: 24 }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
                color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                <span>BY PRODUCT · MONTH</span>
                <CurrencyBadge currency="TJS" />
              </div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 16 }}>
                {t('finance.byProduct')}
              </h3>
              <BarList
                items={incomeByProduct.map((p) => ({ label: p.product, value: p.amount, sub: `${p.count} шт` }))}
                colors={['#7c3aed', '#db2777', '#0891b2', '#16a34a', '#ea580c', '#64748b']}
              />
            </div>
          )}
        </div>
      )}

      {/* Заявки на оплату от клиентов (от студентов) — ждут подтверждения
          бухгалтера. Backend: POST /payments/:id/confirm|reject доступны
          только ADMIN/ACCOUNTANT/FOUNDER (payments.controller.ts:13). До
          фикса блок рендерился всем ролям, у SALES_MANAGER с finance:read
          «висели» кнопки confirm/reject, которые упирались в 403 —
          вводило в заблуждение и открывало доступ к чужим клиентским
          суммам. Прячем блок целиком для не-elevated ролей. */}
      {canReviewPayments && paymentRequests.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="crm-section-head">
            <span className="crm-section-eyebrow" style={{ color: 'var(--primary-dark)' }}>{t('eyebrow.paymentRequests')}</span>
            <h2 className="crm-section-title">{t('finance.paymentRequests')}</h2>
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', tableLayout: 'fixed' }}>
              {/* QA-fix #5: фиксируем ширины и no-wrap для заголовков
                  (раньше «КОГДА / СТУДЕНТ» сжимались до 1 буквы), плюс
                  truncate для длинного комментария чтобы не ломал layout. */}
              <colgroup>
                <col style={{ width: '14%' }} />
                <col style={{ width: '20%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '26%' }} />
                <col style={{ width: '16%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.date')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('finance.col.student')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.amount')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.type')}</th>
                  <th style={{ whiteSpace: 'nowrap' }}>{t('common.comment')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paymentRequests.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(p.createdAt)}</td>
                    <td style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.student?.fullName}</td>
                    <td style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 500,
                      fontSize: 18,
                      color: 'var(--primary-dark)',
                      whiteSpace: 'nowrap',
                    }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{PAYMENT_METHOD_LABEL[p.method]}</td>
                    <td
                      style={{
                        color: 'var(--text-soft)', fontSize: 13,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        maxWidth: 0,
                      }}
                      title={p.comment || ''}
                    >
                      {p.comment || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-primary" onClick={() => onConfirmPayment(p)}>
                          <Icon name="check" size={14} /> {t('finance.payment.confirm')}
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => onRejectPayment(p)}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pending payments */}
      {pending.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div className="crm-section-head">
            <span className="crm-section-eyebrow" style={{ color: '#b45309' }}>{t('eyebrow.outstandingPayment')}</span>
            <h2 className="crm-section-title">{t('finance.outstanding')}</h2>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th>{t('finance.col.student')}</th><th>{t('sidebar.programs')}</th><th>{t('common.amount')}</th><th>{t('finance.col.manager')}</th><th></th></tr>
              </thead>
              <tbody>
                {pending.map((app) => (
                  <tr key={app.id}>
                    <td style={{ fontWeight: 500 }}>{app.fullName}</td>
                    <td>{app.program?.name || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 16 }}>
                      {app.program ? fmtMoney(app.program.cost, app.program.currency || 'TJS') : '—'}
                    </td>
                    <td>{app.manager?.fullName || <span style={{ color: 'var(--text-light)' }}>—</span>}</td>
                    <td>
                      {/* «Внести оплату» открывает ту же TransactionForm.
                          Гейтим по canCreateTx (кто в принципе имеет право
                          на POST). Для менеджера без finance:create кнопка
                          скрыта — иначе он попадал бы в форму, из которой
                          всё равно ничего не смог бы отправить.
                          Дополнительно: не-elevated менеджер может внести
                          оплату только по своему студенту (backend
                          ownership-check в finance.service.create). Если
                          заявка чужого менеджера — кнопка скрыта, чтобы
                          не порождать «случайный клик → 403 по чужому
                          студенту». */}
                      {canCreateTx && (elevated || !app.managerId || app.managerId === mySelfId) && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => {
                            setShowForm(true);
                            // Pre-select student in form via state below.
                            // Для non-elevated backend перепишет managerId
                            // на caller.id независимо от значения ниже,
                            // но передаём осмысленный default для elevated.
                            setPreselectedStudent({
                              studentId: app.studentId,
                              managerId: elevated ? app.managerId : mySelfId,
                              amount: app.program?.cost,
                              currency: app.program?.currency,
                            });
                          }}
                        >
                          {t('finance.recordPayment')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Управление транзакциями */}
      <div className="crm-section-head" style={{ marginTop: 32 }}>
        <span className="crm-section-eyebrow">{t('eyebrow.ledgerAll')}</span>
        <h2 className="crm-section-title">{t('finance.ledger')}</h2>
      </div>

      <div className="filters" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="pagination-controls" style={{ padding: 4 }}>
          <button
            className={!filterType ? 'active' : ''}
            onClick={() => setFilterType('')}
          >
            {t('common.all')}
          </button>
          <button
            className={filterType === 'INCOME' ? 'active' : ''}
            onClick={() => setFilterType('INCOME')}
          >
            {t('finance.income')}
          </button>
          <button
            className={filterType === 'EXPENSE' ? 'active' : ''}
            onClick={() => setFilterType('EXPENSE')}
          >
            {t('finance.expense')}
          </button>
        </div>
        {/* Доп-фильтры для INCOME (источник / продукт / фаза оплаты).
            Показываем всегда когда фильтр не EXPENSE — для «Все» они тоже
            имеют смысл (пустые значения = «не выбрано»). */}
        {filterType !== 'EXPENSE' && (
          <>
            <select
              className="crm-select"
              value={filterIncomeSource}
              onChange={(e) => setFilterIncomeSource(e.target.value as IncomeSource | '')}
              style={{ minWidth: 160 }}
              aria-label={t('finance.field.incomeSource')}
            >
              <option value="">{t('finance.field.incomeSource')}: {t('common.all')}</option>
              <option value="NEW_CLIENT">{t('finance.source.NEW_CLIENT')}</option>
              <option value="UP_SALE">{t('finance.source.UP_SALE')}</option>
              <option value="OTHER">{t('finance.source.OTHER')}</option>
            </select>
            <select
              className="crm-select"
              value={filterProductEnum}
              onChange={(e) => setFilterProductEnum(e.target.value as ProductCategoryEnum | '')}
              style={{ minWidth: 160 }}
              aria-label={t('finance.field.productEnum')}
            >
              <option value="">{t('finance.field.productEnum')}: {t('common.all')}</option>
              <option value="CONTRACT">{t('finance.productEnum.CONTRACT')}</option>
              <option value="MASTERCLASS">{t('finance.productEnum.MASTERCLASS')}</option>
              <option value="ACADEMY">{t('finance.productEnum.ACADEMY')}</option>
              <option value="OTHER">{t('finance.productEnum.OTHER')}</option>
            </select>
            <select
              className="crm-select"
              value={filterPaymentPhase}
              onChange={(e) => setFilterPaymentPhase(e.target.value as PaymentPhaseStatus | '')}
              style={{ minWidth: 160 }}
              aria-label={t('finance.field.paymentPhase')}
            >
              <option value="">{t('finance.field.paymentPhase')}: {t('common.all')}</option>
              <option value="PREPAID">{t('finance.phase.PREPAID')}</option>
              <option value="FULL">{t('finance.phase.FULL')}</option>
            </select>
            {(filterIncomeSource || filterProductEnum || filterPaymentPhase) && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  setFilterIncomeSource('');
                  setFilterProductEnum('');
                  setFilterPaymentPhase('');
                }}
              >
                <Icon name="close" size={14} /> {t('common.reset')}
              </button>
            )}
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* «Новая транзакция» — гейт по backend @Roles на POST
            /finance/transactions (ADMIN/ACCOUNTANT/SALES_MANAGER/CLIENT_MANAGER)
            + custom-role permission `finance:create`/`finance:write`. Раньше
            SALES_MANAGER с `finance:read` из custom-роли видел кнопку,
            открывал форму, заполнял и получал 403 на первом клике. */}
        {canCreateTx && (
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            <Icon name="add" size={18} /> {t('finance.newTransaction')}
          </button>
        )}
      </div>

      <AnimatePresence>
        {showForm && (
          <TransactionForm
            students={students}
            users={users}
            preselect={preselectedStudent}
            canExpense={canExpense}
            onClose={() => { setShowForm(false); setPreselectedStudent(null); }}
            onCreated={() => {
              setShowForm(false);
              setPreselectedStudent(null);
              refresh();
            }}
          />
        )}
      </AnimatePresence>

      <div className="card" style={{ padding: 0 }}>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>{t('finance.col.date')}</th>
              <th>{t('finance.col.type')}</th>
              <th>{t('finance.col.category')}</th>
              <th>{t('finance.col.amount')}</th>
              <th>{t('finance.col.student')}</th>
              <th>{t('finance.col.comment')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr><td colSpan={7} className="empty">{t('finance.empty')}</td></tr>
            )}
            {transactions.map((tx) => (
              <tr key={tx.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{fmtDate(tx.date)}</td>
                <td>
                  <span className={`badge ${tx.type === 'INCOME' ? 'badge-success' : 'badge-danger'}`}>
                    {tx.type === 'INCOME' ? t('finance.income') : t('finance.expense')}
                  </span>
                </td>
                <td>{t(`finance.cat.${tx.category}`) !== `finance.cat.${tx.category}` ? t(`finance.cat.${tx.category}`) : TRANSACTION_CATEGORY_LABEL[tx.category]}</td>
                <td style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 500,
                  fontSize: 17,
                  letterSpacing: '-0.01em',
                  color: tx.type === 'INCOME' ? 'var(--primary-dark)' : 'var(--danger)',
                }}>
                  {tx.type === 'INCOME' ? '+' : '−'} {fmtMoney(tx.amount, tx.currency)}
                </td>
                <td style={{ fontSize: 13 }}>
                  {tx.student && <div>👤 {tx.student.fullName}</div>}
                  {tx.manager && <div style={{ color: 'var(--text-soft)' }}>💼 {tx.manager.fullName}</div>}
                  {!tx.student && !tx.manager && <span style={{ color: 'var(--text-light)' }}>—</span>}
                </td>
                <td style={{ color: 'var(--text-soft)', fontSize: 13 }}>{tx.comment || '—'}</td>
                <td>
                  {canDeleteTx && (
                    <button className="btn btn-sm btn-danger" onClick={() => onDelete(tx)}>
                      <Icon name="delete" size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

let preselectedStudent: any = null;
function setPreselectedStudent(v: any) { preselectedStudent = v; }

function KpiBento({ eyebrow, label, value, accent, span = 'span-3' }: {
  eyebrow: string;
  label: string;
  value: string;
  accent?: boolean;
  span?: string;
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
          fontSize: 'clamp(40px, 5vw, 64px)',
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 0.9,
          marginBottom: 12,
        }}>
          {value}
        </div>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: accent ? 'rgba(5,7,6,0.65)' : 'var(--text-soft)',
        }}>
          {label}
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// Form for new transaction
// ============================================================
function TransactionForm({
  students,
  users,
  preselect,
  canExpense,
  onClose,
  onCreated,
}: {
  students: any[];
  users: any[];
  preselect: any;
  // Разрешено ли пользователю выбирать EXPENSE. Backend режет POST
  // /finance/transactions с type=EXPENSE для не-FOUNDER/ADMIN/ACCOUNTANT
  // (finance.controller.ts:291) — форма должна повторять этот контракт,
  // иначе SALES_MANAGER выбирает «Расход», грузит файл через uploadReceipt
  // и получает 403 при createTransaction. Файл остаётся orphan'ом в
  // /uploads/, пользователь видит непонятный error toast.
  canExpense: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  // Current actor: нужно, чтобы для не-elevated ролей (SALES_MANAGER /
  // CLIENT_MANAGER) заблокировать выбор чужого managerId. Backend всё равно
  // форсит `managerId = caller.id` для менеджеров (finance.service.ts,
  // ветка `else` в блоке ниже line ~479) — но раньше UI показывал полный
  // список пользователей в <select>, менеджер мог выбрать «Босса», форма
  // молча уходила с его выбором, а бекенд перезаписывал на self. С точки
  // зрения оператора это выглядело как data-loss: «я оформил продажу на
  // Ивана, а строчка в леджере на моём имени». Теперь блокируем выбор на
  // клиенте, чтобы UI совпадал с фактическим поведением backend'а.
  const me = useAuth((s) => s.user);
  const elevated = isElevated(me);
  const [type, setType] = useState<TransactionType>('INCOME');
  const [category, setCategory] = useState<TransactionCategory>('TUITION_PAYMENT');
  const [amount, setAmount] = useState<string>(preselect?.amount ? String(preselect.amount) : '');
  const [currency, setCurrency] = useState(preselect?.currency || 'TJS');
  const [studentId, setStudentId] = useState<string>(preselect?.studentId || '');
  const [managerId, setManagerId] = useState<string>(() => {
    // Для не-elevated: preselect?.managerId (напр., пришёл из карточки
    // студента с чужим владельцем) игнорируем и сразу форсим self —
    // тогда UI показывает то же, что запишет backend.
    if (!elevated && me?.id) return me.id;
    return preselect?.managerId || '';
  });
  const [comment, setComment] = useState('');
  // Сегодня — по Asia/Dushanbe (toISOString даёт UTC-день, что после 19:00
  // ТJT уже завтра по UTC и форма открывалась бы с завтрашним числом).
  const [date, setDate] = useState(tjToday());
  const [submitting, setSubmitting] = useState(false);
  // Синхронный guard от повторной отправки: `setSubmitting(true)` применяется
  // только на следующем React-render, поэтому двойной клик по «Сохранить»
  // (или Enter×2) в пределах одного тика видит `submitting=false` в обоих
  // обработчиках и оба уходят в `await createTransaction(dto)` → дубль-POST
  // и дубль-строка в ledger. `disabled` у кнопки срабатывает только после
  // flush render'а, между двумя синхронными click-обработчиками этого не
  // происходит. `useRef` меняется синхронно и закрывает окно гонки.
  const inFlight = useRef(false);

  // Расширенные поля для финансового модуля
  const [paymentChannel, setPaymentChannel] = useState<string>('CASH');
  const [paymentKind, setPaymentKind] = useState<string>('FULL');
  const [productCategory, setProductCategory] = useState<string>('');
  const [payerName, setPayerName] = useState('');
  const [receiptKind, setReceiptKind] = useState<string>('RECEIPT');
  const [noReceiptReason, setNoReceiptReason] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  // Google Sheet parity — новые enum-поля
  const [incomeSource, setIncomeSource] = useState<IncomeSource | ''>('');
  const [productCategoryEnum, setProductCategoryEnum] = useState<ProductCategoryEnum | ''>('');
  const [paymentPhase, setPaymentPhase] = useState<PaymentPhaseStatus | ''>('');
  const [paidViaId, setPaidViaId] = useState<string>('');

  const cats = type === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  // managerId имеет двойную семантику: (INCOME → менеджер-получатель клиента)
  // и (EXPENSE + SALARY → сотрудник-получатель зарплаты). Поле разделяет
  // одну state-переменную, поэтому нужен явный guard, чтобы id одной роли
  // не «протёк» в транзакцию другой роли при переключении type/category.
  const needsManager = (t: TransactionType, c: TransactionCategory): boolean =>
    t === 'INCOME' || (t === 'EXPENSE' && c === 'SALARY');

  // Реcинк managerId → me.id для не-elevated при каждом переключении
  // type/category, потому что handlers `setType`/`setCategory` в блоках
  // выше делают `setManagerId('')` при любом переключении (сброс двойной
  // семантики managerId между INCOME-manager и SALARY-employee). Без этого
  // effect'а после переключения на не-показывающую select категорию
  // и обратно value осталось бы пустым, а backend всё равно записал бы
  // self — UI снова расходился бы с фактом. Effect делает форс явным и
  // видимым в disabled-select (см. ниже).
  useEffect(() => {
    if (elevated || !me?.id) return;
    if (!needsManager(type, category)) return;
    setManagerId((prev) => (prev === me.id ? prev : me.id));
  }, [elevated, me?.id, type, category]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Синхронный re-entry guard. Проверяем в самом верху, чтобы второй
    // одновременный клик по «Сохранить» (или Enter×2 в одном тике) вышел
    // раньше, чем стартует второй `createTransaction`. Устанавливаем флаг
    // *после* синхронной валидации — иначе неуспешная валидация оставила бы
    // флаг взведённым навсегда, и форма стала бы неотправляемой. JS однопо-
    // точный: между валидацией и первым `await` другой обработчик не
    // вклинится, поэтому окно гонки закрывается до первого микро-таска.
    if (inFlight.current) return;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      toast(t('toast.error'), 'error');
      return;
    }
    // Role-guard: EXPENSE запрещён backend'ом для не-elevated ролей
    // (finance.controller.ts:291 → 403). Ловим ДО uploadReceipt, чтобы
    // не оставить orphan-файл в /uploads/ при последующем 403 на
    // createTransaction. В нормальном UI EXPENSE-опция уже спрятана
    // (см. type-select выше), но double-check страхует от гонки, когда
    // роль пользователя поменялась между открытием формы и submit'ом.
    if (type === 'EXPENSE' && !canExpense) {
      toast(t('toast.error'), 'error');
      return;
    }
    if (type === 'EXPENSE') {
      if (receiptKind === 'REASON_ONLY') {
        if (!noReceiptReason.trim() || noReceiptReason.trim().length < 5) {
          toast(t('toast.error'), 'error');
          return;
        }
      } else if (!receiptFile) {
        toast(t('toast.error'), 'error');
        return;
      }
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      // Сначала загружаем чек (если есть). Upload идёт ТОЛЬКО в EXPENSE-
      // ветке и только после role-guard выше — если пользователь без прав
      // на EXPENSE как-то дотащил форму до submit, мы уже вышли и файл
      // не полетит на диск. Оставшиеся failure-modes (network / backend
      // validation после успешного upload) редки и требуют отдельной
      // POST-then-PATCH архитектуры; сейчас PATCH тоже elevated-only, так
      // что до этого шага без прав на EXPENSE в норме не дойти.
      let receiptUrl: string | undefined;
      if (receiptFile && type === 'EXPENSE') {
        setUploadingReceipt(true);
        const m = await import('../api/finance');
        const uploaded = await m.uploadReceipt(receiptFile);
        receiptUrl = uploaded.url;
        setUploadingReceipt(false);
      }

      const dto: CreateTransactionDto = {
        type,
        category,
        amount: amt,
        currency,
        comment: comment.trim() || undefined,
        date,
        // Студент прикрепляется только к INCOME-транзакции. Селект «Студент»
        // рендерится лишь при type === 'INCOME', поэтому при переключении на
        // EXPENSE ранее выбранный studentId остался бы «висеть» в state и
        // ушёл бы на бэкенд как невидимая связка EXPENSE↔студент. Guard
        // страхует onChange-сброс на случай будущих регрессий.
        studentId: type === 'INCOME' ? (studentId || null) : null,
        // Строгий guard: managerId уходит только если для текущей пары
        // (type, category) в форме реально отрисован соответствующий
        // селект (менеджер / сотрудник). Иначе поле выкидывается из DTO,
        // чтобы «зависший» id из прежнего режима не попал на бэкенд.
        ...(needsManager(type, category) && managerId
          ? { managerId }
          : { managerId: null }),
        paymentChannel: paymentChannel as any,
        ...(type === 'INCOME' && { paymentKind: paymentKind as any }),
        ...(type === 'INCOME' && productCategory && { productCategory }),
        ...(type === 'INCOME' && payerName.trim() && { payerName: payerName.trim() }),
        // === Google Sheet parity — новые enum-поля ===
        ...(type === 'INCOME' && incomeSource && { incomeSource }),
        ...(type === 'INCOME' && productCategoryEnum && { productCategoryEnum }),
        ...(type === 'INCOME' && paymentPhase && { paymentPhase }),
        ...(type === 'EXPENSE' && paidViaId && { paidViaId }),
        ...(type === 'EXPENSE' && {
          receiptKind: receiptKind as any,
          receiptUrl,
          ...(receiptKind === 'REASON_ONLY' && { noReceiptReason: noReceiptReason.trim() }),
        }),
      };
      await createTransaction(dto);
      toast(t('toast.created'), 'success');
      onCreated();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      setUploadingReceipt(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      style={{ overflow: 'hidden', marginBottom: 24 }}
    >
      <form
        onSubmit={onSubmit}
        className="card"
        style={{ padding: 28 }}
      >
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          color: 'var(--primary-dark)',
          marginBottom: 6,
        }}>NEW · TRANSACTION</div>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginBottom: 24,
        }}>
          {t('finance.newTransaction')}
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="form-group">
            <label>{t('common.type')}</label>
            <select
              className="crm-select"
              value={type}
              onChange={(e) => {
              const raw = e.target.value as TransactionType;
              // Defensive: если EXPENSE-option как-то попал в select для
              // не-elevated (например, кастомная сборка / devtools), молча
              // игнорируем — форма остаётся на INCOME, чтобы вниз не пошёл
              // ни один EXPENSE-only stateful path (upload/поля чека).
              const tt: TransactionType = raw === 'EXPENSE' && !canExpense ? 'INCOME' : raw;
              const nextCategory: TransactionCategory = tt === 'INCOME' ? 'TUITION_PAYMENT' : 'SALARY';
              setType(tt);
              setCategory(nextCategory);
              // managerId держит одно значение для двух совершенно разных
              // ролей (менеджер клиента при INCOME / сотрудник-получатель
              // зарплаты при EXPENSE+SALARY). При смене type роль всегда
              // меняется, даже если новая пара тоже показывает какой-то
              // селект — INCOME-менеджер не должен «превратиться» в
              // получателя зарплаты (или наоборот) без явного выбора.
              // Поэтому сбрасываем безусловно на любое переключение type.
              setManagerId('');
              if (tt === 'EXPENSE') {
                // Сбрасываем поля, доступные только в INCOME-ветке. Иначе
                // состояние ранее заполненной формы (например, studentId,
                // выбранный до переключения) утечёт в EXPENSE-payload.
                setStudentId('');
                setPayerName('');
                setProductCategory('');
                setIncomeSource('');
                setProductCategoryEnum('');
                setPaymentPhase('');
              } else {
                // Симметрично чистим состояние EXPENSE-ветки при возврате.
                setPaidViaId('');
                setReceiptKind('RECEIPT');
                setNoReceiptReason('');
                setReceiptFile(null);
              }
            }}>
              <option value="INCOME">{t('finance.income')}</option>
              {/* EXPENSE скрываем для не-elevated ролей: backend всё равно
                  вернёт 403 (finance.controller.ts:291), а до 403 успевает
                  отработать uploadReceipt → orphan-файл в /uploads/.
                  Прячем option полностью, а не disable — с disabled
                  пользователь всё равно спрашивал бы «почему нельзя»,
                  а видимая-но-мёртвая опция читается как баг. */}
              {canExpense && (
                <option value="EXPENSE">{t('finance.expense')}</option>
              )}
            </select>
          </div>
          <div className="form-group">
            <label>{t('finance.col.category')}</label>
            <select className="crm-select" value={category} onChange={(e) => {
              const nextCategory = e.target.value as TransactionCategory;
              setCategory(nextCategory);
              // Внутри EXPENSE только SALARY показывает employee-селект
              // (managerId). При смене категории с SALARY на любую другую
              // (OFFICE_RENT, UTILITIES и т.д.) очищаем managerId, чтобы
              // выбранный ранее сотрудник не привязался к аренде/коммуналке.
              if (!needsManager(type, nextCategory)) setManagerId('');
            }}>
              {cats.map((c) => {
                // Пробуем i18n-ключ (RU/TJ), иначе — русский label из finance.ts.
                const trKey = `finance.cat.${c}`;
                const label = t(trKey) !== trKey ? t(trKey) : TRANSACTION_CATEGORY_LABEL[c];
                return <option key={c} value={c}>{label}</option>;
              })}
            </select>
          </div>
          <div className="form-group">
            <label>{t('common.amount')}</label>
            <input className="crm-input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
          </div>
          <div className="form-group">
            <label>{t('finance.col.currency')}</label>
            <select className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="CNY">CNY</option>
              <option value="RUB">RUB</option>
              <option value="TJS">TJS</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('common.date')}</label>
            <CrmDatePicker className="crm-input" value={date} onChange={(v) => setDate(v)} />
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.col.student')}</label>
              <select className="crm-select" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                <option value="">—</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>{s.fullName}</option>
                ))}
              </select>
            </div>
          )}
          {(type === 'EXPENSE' && category === 'SALARY') && (
            <div className="form-group">
              <label>{t('salary.field.employee')}</label>
              {elevated ? (
                <select className="crm-select" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.fullName}</option>
                  ))}
                </select>
              ) : (
                <>
                  {/* Non-elevated: backend всё равно форсит caller.id
                      (finance.service.ts, non-elevated ветка). Показываем
                      disabled-select с собой, чтобы UI не врал про свободу
                      выбора и оператор понимал, что запись пойдёт на него. */}
                  <select
                    className="crm-select"
                    value={me?.id ?? ''}
                    disabled
                    aria-disabled="true"
                    title="Зарплата автоматически привязывается к вам — переназначить может только ADMIN/ACCOUNTANT."
                  >
                    <option value={me?.id ?? ''}>{me?.fullName || me?.email || '—'}</option>
                  </select>
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4, letterSpacing: '0.02em' }}>
                    Автоматически привязывается к вам — переназначить может только ADMIN/ACCOUNTANT.
                  </div>
                </>
              )}
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.col.manager')}</label>
              {elevated ? (
                <select className="crm-select" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.fullName}</option>
                  ))}
                </select>
              ) : (
                <>
                  {/* Non-elevated: см. комментарий у employee-select выше.
                      Backend перезаписывает managerId на caller.id независимо
                      от переданного значения — раньше UI показывал полный
                      список, менеджер выбирал коллегу, форма молча уходила,
                      а строка ledger'а сохранялась на его имени. Data-loss с
                      точки зрения оператора. Теперь select только для чтения. */}
                  <select
                    className="crm-select"
                    value={me?.id ?? ''}
                    disabled
                    aria-disabled="true"
                    title="Продажа автоматически привязывается к вам — переназначить может только ADMIN/ACCOUNTANT."
                  >
                    <option value={me?.id ?? ''}>{me?.fullName || me?.email || '—'}</option>
                  </select>
                  <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4, letterSpacing: '0.02em' }}>
                    Продажа автоматически привязывается к вам — переназначить может только ADMIN/ACCOUNTANT.
                  </div>
                </>
              )}
            </div>
          )}
          <div className="form-group">
            <label>{t('finance.paymentChannel')}</label>
            <select className="crm-select" value={paymentChannel} onChange={(e) => setPaymentChannel(e.target.value)}>
              <option value="CASH">{t('finance.channel.CASH')}</option>
              <option value="ALIF_MOBILE">{t('finance.channel.ALIF_MOBILE')}</option>
              <option value="BANK_TRANSFER">{t('finance.channel.BANK_TRANSFER')}</option>
              <option value="CARD">{t('finance.channel.CARD')}</option>
              <option value="CRYPTO">Crypto</option>
              <option value="OTHER">{t('userDoc.OTHER')}</option>
            </select>
          </div>
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.paymentKind')}</label>
              <select className="crm-select" value={paymentKind} onChange={(e) => setPaymentKind(e.target.value)}>
                <option value="FULL">{t('finance.kind.FULL')}</option>
                <option value="PREPAYMENT">{t('finance.kind.PREPAYMENT')}</option>
                <option value="ADDITIONAL">{t('finance.kind.ADDITIONAL')}</option>
                <option value="OWNER_INVESTMENT">{t('finance.kind.OWNER_INVESTMENT')}</option>
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.product')}</label>
              <select className="crm-select" value={productCategory} onChange={(e) => setProductCategory(e.target.value)}>
                <option value="">—</option>
                {PRODUCT_CATEGORIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}
          {/* === Google Sheet parity — INCOME dropdowns === */}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.field.incomeSource')}</label>
              <select
                className="crm-select"
                value={incomeSource}
                onChange={(e) => setIncomeSource(e.target.value as IncomeSource | '')}
              >
                <option value="">—</option>
                <option value="NEW_CLIENT">{t('finance.source.NEW_CLIENT')}</option>
                <option value="UP_SALE">{t('finance.source.UP_SALE')}</option>
                <option value="OTHER">{t('finance.source.OTHER')}</option>
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.field.productEnum')}</label>
              <select
                className="crm-select"
                value={productCategoryEnum}
                onChange={(e) => setProductCategoryEnum(e.target.value as ProductCategoryEnum | '')}
              >
                <option value="">—</option>
                <option value="CONTRACT">{t('finance.productEnum.CONTRACT')}</option>
                <option value="MASTERCLASS">{t('finance.productEnum.MASTERCLASS')}</option>
                <option value="ACADEMY">{t('finance.productEnum.ACADEMY')}</option>
                <option value="OTHER">{t('finance.productEnum.OTHER')}</option>
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group">
              <label>{t('finance.field.paymentPhase')}</label>
              <select
                className="crm-select"
                value={paymentPhase}
                onChange={(e) => setPaymentPhase(e.target.value as PaymentPhaseStatus | '')}
              >
                <option value="">—</option>
                <option value="PREPAID">{t('finance.phase.PREPAID')}</option>
                <option value="FULL">{t('finance.phase.FULL')}</option>
              </select>
            </div>
          )}
          {/* === EXPENSE: через кого прошёл расход === */}
          {type === 'EXPENSE' && (
            <div className="form-group">
              <label>{t('finance.field.paidVia')}</label>
              <select
                className="crm-select"
                value={paidViaId}
                onChange={(e) => setPaidViaId(e.target.value)}
              >
                <option value="">—</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </select>
            </div>
          )}
          {type === 'INCOME' && (
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>{t('finance.payerName')}</label>
              <input className="crm-input" type="text" value={payerName} onChange={(e) => setPayerName(e.target.value)} />
            </div>
          )}
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>{t('app.field.comment')}</label>
            <input className="crm-input" type="text" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>

          {type === 'EXPENSE' && (
            <div className="form-group" style={{ gridColumn: '1 / -1', padding: 14, background: 'var(--bg-soft)', borderRadius: 12 }}>
              <label style={{ fontWeight: 600, marginBottom: 8 }}>
                Подтверждение расхода (обязательно)
              </label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <RadioBtn label="📄 Чек" active={receiptKind === 'RECEIPT'} onClick={() => setReceiptKind('RECEIPT')} />
                <RadioBtn label="💵 Фото наличных" active={receiptKind === 'CASH_PHOTO'} onClick={() => setReceiptKind('CASH_PHOTO')} />
                <RadioBtn label="📝 Только причина" active={receiptKind === 'REASON_ONLY'} onClick={() => setReceiptKind('REASON_ONLY')} />
              </div>
              {receiptKind === 'REASON_ONLY' ? (
                <input
                  className="crm-input"
                  type="text"
                  value={noReceiptReason}
                  onChange={(e) => setNoReceiptReason(e.target.value)}
                  placeholder="Почему нет чека (мин. 5 символов)"
                  required
                />
              ) : (
                <div>
                  <input
                    className="crm-input"
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                    required
                  />
                  {receiptFile && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-soft)' }}>
                      {receiptFile.name} · {(receiptFile.size / 1024).toFixed(0)} КБ
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || uploadingReceipt}>
            {uploadingReceipt ? 'Загружаем чек...' : submitting ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </div>
      </form>
    </motion.div>
  );
}

function RadioBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px',
        border: `1.5px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 999,
        background: active ? 'var(--primary-soft)' : 'white',
        color: active ? 'var(--primary-dark)' : 'var(--text)',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

// ============================================================
// Revenue chart — pure SVG, dual line (income / expense) + profit area
// ============================================================
function RevenueChart({ points }: { points: TimeseriesPoint[] }) {
  const width = 800;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 50 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const maxValue = Math.max(
    ...points.map((p) => Math.max(p.income, p.expense)),
    100,
  );

  const xStep = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const x = (i: number) => padding.left + i * xStep;
  const y = (v: number) => padding.top + innerH - (v / maxValue) * innerH;

  const incomePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.income)}`).join(' ');
  const expensePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.expense)}`).join(' ');
  const profitArea = `M ${x(0)} ${y(0)} ${points.map((p, i) => `L ${x(i)} ${y(Math.max(0, p.profit))}`).join(' ')} L ${x(points.length - 1)} ${y(0)} Z`;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ minWidth: 600, display: 'block' }}>
        {/* grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={padding.top + innerH * (1 - p)}
              y2={padding.top + innerH * (1 - p)}
              stroke="var(--border-soft)"
              strokeDasharray="2 4"
            />
            <text
              x={padding.left - 8}
              y={padding.top + innerH * (1 - p) + 4}
              fontFamily="var(--font-mono)"
              fontSize="10"
              fill="var(--text-light)"
              textAnchor="end"
            >
              {Math.round((maxValue * p) / 1000) || 0}K
            </text>
          </g>
        ))}

        {/* Profit area (emerald-soft) */}
        <path d={profitArea} fill="rgba(1, 54, 139,0.12)" />

        {/* Income line */}
        <path d={incomePath} stroke="var(--primary)" strokeWidth={2.5} fill="none" />
        {/* Expense line */}
        <path d={expensePath} stroke="var(--danger)" strokeWidth={2} fill="none" strokeDasharray="4 4" />

        {/* Points + x-axis labels */}
        {points.map((p, i) => (
          <g key={p.key}>
            <circle cx={x(i)} cy={y(p.income)} r={3} fill="var(--primary)" />
            <circle cx={x(i)} cy={y(p.expense)} r={2.5} fill="var(--danger)" />
            {(i % Math.max(1, Math.ceil(points.length / 8)) === 0 || i === points.length - 1) && (
              <text
                x={x(i)}
                y={padding.top + innerH + 16}
                fontFamily="var(--font-mono)"
                fontSize="9"
                fill="var(--text-light)"
                textAnchor="middle"
              >
                {p.key.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div style={{
        display: 'flex',
        gap: 24,
        marginTop: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.06em',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 2, background: 'var(--primary)' }} />
          ДОХОДЫ
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 2, background: 'var(--danger)' }} />
          РАСХОДЫ
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, background: 'rgba(1, 54, 139,0.3)' }} />
          ПРИБЫЛЬ
        </div>
      </div>
    </div>
  );
}

/** Универсальный список с прогресс-барами (для диаграмм). */
function BarList({ items, colors }: {
  items: Array<{ label: string; value: number; sub?: string }>;
  colors: string[];
}) {
  const total = items.reduce((s, x) => s + x.value, 0);
  if (total === 0) {
    return <div style={{ color: 'var(--text-soft)', textAlign: 'center', padding: 16 }}>Нет данных</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => {
        const pct = (it.value / total) * 100;
        const color = colors[i % colors.length];
        return (
          <div key={it.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>
                {it.label}{it.sub && <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>{it.sub}</span>}
              </span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                {it.value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
                <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>({pct.toFixed(0)}%)</span>
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--bg-soft)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Pie chart — pure inline SVG, никаких внешних либ (recharts не тянем ради
// одной страницы, бандл важнее). Формула стандартная: cx/cy = center,
// путь = M cx cy → L первая точка → A radius radius 0 largeArc 1 вторая
// точка → Z. largeArc = 1 если сектор > 180°. Если данные состоят из одного
// ненулевого сектора (100%) — рисуем full circle, иначе degenerate arc не
// закрашивается.
// ============================================================
interface PieSlice {
  label: string;
  value: number;
  count?: number;
  color: string;
}

// 9 визуально различных цветов для отдельных секторов пирога.
// Slate вынесен в `PIE_OTHER_COLOR` — им закрашивается агрегированный
// «Прочее»-бакет из `rollupPieSlices`, чтобы этот сектор читался как
// собирательный, а не как ещё одна категория.
const PIE_COLORS = [
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
];
const PIE_OTHER_COLOR = '#64748b'; // slate — агрегированный «Прочее»-бакет
const PIE_MAX_SLICES = PIE_COLORS.length; // сколько уникально-цветных секторов рисуем до roll-up

// Backend-ручки byIncomeSource / byManager / byExpenseCategory не ограничены
// сверху (в отличие от `financeTopManagers`, у которой явный `limit`).
// Прямое `PIE_COLORS[i % PIE_COLORS.length]` при >9 записях начинало красить
// соседние сектора одним и тем же цветом (например 10-й и 1-й — одинаково
// синие), из-за чего два сектора визуально сливались в один и легенда
// содержала два идентичных цветных чипа. Плюс >10 секторов в пироге
// нечитаемы даже с уникальными цветами. Поэтому сортируем по величине,
// оставляем топ-9 с уникальными цветами и сворачиваем остальное в один
// slate-сектор «Прочее» — эквивалент backend-cap-а, реализованный на
// клиенте, чтобы не менять контракт эндпоинта.
function rollupPieSlices<T>(
  rows: readonly T[] | undefined,
  toItem: (row: T) => { label: string; value: number; count?: number },
  otherLabel: string,
): PieSlice[] {
  const mapped = (rows ?? [])
    .map(toItem)
    .filter((it) => it.value > 0)
    .sort((a, b) => b.value - a.value);
  if (mapped.length <= PIE_MAX_SLICES) {
    return mapped.map((it, i) => ({ ...it, color: PIE_COLORS[i] }));
  }
  const top = mapped.slice(0, PIE_MAX_SLICES - 1);
  const rest = mapped.slice(PIE_MAX_SLICES - 1);
  const restCount = rest.reduce((s, it) => s + (it.count ?? 0), 0);
  const other: PieSlice = {
    label: otherLabel,
    value: rest.reduce((s, it) => s + it.value, 0),
    // `count` опционален у PieSlice: сохраняем его, только если исходные записи
    // имели counts (иначе получим бессмысленный «· 0» в легенде).
    ...(restCount > 0 ? { count: restCount } : {}),
    color: PIE_OTHER_COLOR,
  };
  return [
    ...top.map((it, i) => ({ ...it, color: PIE_COLORS[i] })),
    other,
  ];
}

function PieChart({ items, size = 200 }: { items: PieSlice[]; size?: number }) {
  const total = items.reduce((s, x) => s + x.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  if (total <= 0) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--border)',
          borderRadius: '50%',
          color: 'var(--text-soft)',
          fontSize: 12,
          margin: '0 auto',
        }}
      >
        Нет данных
      </div>
    );
  }

  const nonZero = items.filter((it) => it.value > 0);
  // Единственный сектор (100%): SVG arc с одинаковыми start/end рисует пустоту,
  // поэтому рисуем сплошной круг.
  if (nonZero.length === 1) {
    return (
      <svg width={size} height={size} style={{ display: 'block', margin: '0 auto' }}>
        <circle cx={cx} cy={cy} r={r} fill={nonZero[0].color} />
      </svg>
    );
  }

  let cumulative = 0;
  return (
    <svg width={size} height={size} style={{ display: 'block', margin: '0 auto' }}>
      {items.map((it, i) => {
        if (it.value <= 0) return null;
        const startAngle = (cumulative / total) * Math.PI * 2 - Math.PI / 2;
        cumulative += it.value;
        const endAngle = (cumulative / total) * Math.PI * 2 - Math.PI / 2;
        const largeArc = it.value / total > 0.5 ? 1 : 0;
        const x1 = cx + r * Math.cos(startAngle);
        const y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
        return (
          <path
            key={`${it.label}-${i}`}
            d={d}
            fill={it.color}
            stroke="var(--surface, #fff)"
            strokeWidth={1}
          />
        );
      })}
    </svg>
  );
}

function PieCard({
  eyebrow,
  title,
  items,
  currency = 'TJS',
  nonTjsTotals,
  nonTjsKind,
}: {
  eyebrow: string;
  title: string;
  items: PieSlice[];
  currency?: string;
  /** Валютные суммы за тот же период, не попавшие в пирог (TJS-only).
      Рендерим над диаграммой, чтобы бухгалтер видел, что USD/EUR активность
      была, и обработал её вручную. */
  nonTjsTotals?: NonTjsTotals | null;
  /** Тип пирога — фильтрует, какие суммы показать в баннере.
      `income` для доходных разрезов, `expense` для расходных; без значения
      показываем и то и другое. */
  nonTjsKind?: 'income' | 'expense';
}) {
  const total = items.reduce((s, x) => s + x.value, 0);
  return (
    <div className="card" style={{ padding: 24 }}>
      {/* Eyebrow с бэйджем базовой валюты. Раньше `currency` был только
          пропом и нигде не отображался — пользователь видел «нет данных» на
          пирогах и не понимал, что суммы отфильтрованы по TJS (валютные
          продажи молча выпадают, см. audit HIGH «pie charts hide currency
          bias»). Бэйдж делает базу расчёта явной, tooltip объясняет
          обработку прочих валют. */}
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
        color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <span>{eyebrow}</span>
        <CurrencyBadge currency={currency} />
      </div>
      <h3 style={{
        fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500,
        letterSpacing: '-0.02em', marginBottom: 16,
      }}>{title}</h3>
      <NonTjsStrip totals={nonTjsTotals} kind={nonTjsKind} />
      <PieChart items={items} size={200} />
      <div style={{
        marginTop: 16,
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.06em',
        color: 'var(--text-soft)', textAlign: 'center',
      }}>
        TOTAL · {fmtMoney(total, currency)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {items.length === 0 && (
          <div style={{ color: 'var(--text-soft)', fontSize: 12, textAlign: 'center' }}>
            Нет данных за период
          </div>
        )}
        {items.map((it, i) => {
          const pct = total > 0 ? (it.value / total) * 100 : 0;
          return (
            <div
              key={`${it.label}-${i}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13,
              }}
            >
              <span style={{
                width: 10, height: 10, borderRadius: 2,
                background: it.color, flexShrink: 0,
              }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.label}
                {typeof it.count === 'number' && (
                  <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                    · {it.count}
                  </span>
                )}
              </span>
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                {pct.toFixed(0)}%
                <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11, fontWeight: 400 }}>
                  {fmtMoney(it.value, currency)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DistRow({ label, pct, amount, color }: { label: string; pct: number; amount: number; color: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>
          <b style={{ color }}>{pct}%</b> · {label}
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
        </span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-soft)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
