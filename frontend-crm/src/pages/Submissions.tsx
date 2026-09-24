import { useCallback, type ReactNode } from 'react';
import CrmSelect from '../components/CrmSelect';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useRealtime } from '../realtime';
import { useT } from '../lib/i18n';
import { adminListPartners, fmtCommissionRate, fmtMoneyCents } from '../api/partners';
import {
  listMySubmissions,
  listAllSubmissions,
  listPendingPayments,
  type SaleSubmission,
  type PendingPayment,
  type SubmissionStatus,
  SUBMISSION_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
} from '../api/submissions';
import Icon from '../Icon';
import PeriodFilter from '../components/PeriodFilter';
import ActiveFilterChips, { fmtDay } from '../components/ActiveFilterChips';
import SearchField, { useUrlSearch } from '../components/SearchField';
import ListTotal, { type ListNoun } from '../components/ListTotal';
import { dateParam, enumParam, ignoredParam, stringParam, useUrlListState } from '../lib/useUrlListState';
import { absFileUrl as absUrl, useFileToken } from '../lib/fileUrl';

const STATUS_COLOR: Record<SubmissionStatus, string> = {
  ACTIVE: '#0ea5e9',
  COMPLETED: '#10b981',
  CANCELLED: '#94a3b8',
};

const PAYMENT_STATUS_COLOR: Record<string, string> = {
  PENDING: '#fbbf24',
  APPROVED: '#10b981',
  REJECTED: '#ef4444',
};

type Tab = 'mine' | 'pending' | 'all' | 'approved';

/** Фильтры экрана — одни на все вкладки. */
type DealFilters = { partner: string; from: string; to: string; search: string };

export default function Submissions() {
  const me = useAuth((s) => s.user);
  const { t } = useT();
  useFileToken(); // ссылки на файлы — с файловым токеном, перерисовка когда он придёт
  const navigate = useNavigate();
  const qc = useQueryClient();
  const founder = isFounder(me);

  // Вкладка и фильтры — в ссылке: из карточки сделки возвращаются кнопкой
  // «назад», и открыться должна та же вкладка с той же выборкой. Фильтры
  // ОБЩИЕ на все вкладки: переключая «На рассмотрении» → «Все», человек
  // ждёт, что партнёр, период и поиск останутся.
  const { values, setValue, reset } = useUrlListState({
    tab: founder
      ? enumParam<Tab, Tab>(['pending', 'approved', 'all'], 'pending')
      : enumParam<Tab, Tab>(['mine'], 'mine'),
    // id партнёра белым списком не проверить (список грузится асинхронно) —
    // ограничиваем длину, как в остальных списках.
    partner: founder ? stringParam('', 64) : ignoredParam(''),
    from: dateParam(),
    to: dateParam(),
    search: stringParam('', 200),
  });
  const { tab } = values;
  const f: DealFilters = { partner: values.partner, from: values.from, to: values.to, search: values.search };
  const narrowed = !!(f.partner || f.from || f.to || f.search);

  const setUrlSearch = useCallback((v: string) => setValue('search', v), [setValue]);
  const { input: searchInput, setInput: setSearchInput, clear: clearSearch } = useUrlSearch(values.search, setUrlSearch);

  // Партнёры — для фильтра и для подписи плашки. Эндпоинт админский, поэтому
  // только основателю (ему же видны и вкладки со всеми сделками).
  const partnersQuery = useQuery({
    queryKey: ['admin', 'partners'],
    queryFn: () => adminListPartners(),
    enabled: founder,
  });
  const partners = partnersQuery.data ?? [];

  // Realtime: бэкенд эмитит submission:new (staff), submission:payment-new (staff),
  // submission:reviewed (staff), submission:approved/rejected (юзеру-менеджеру).
  // Инвалидируем весь префикс ['submissions'] — он покрывает все вкладки.
  useRealtime({
    'submission:new': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:payment-new': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:reviewed': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:approved': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:rejected': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
  });

  const tabBtn = (key: Tab, label: string) => (
    <button
      className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-secondary'}`}
      data-testid={`deals-tab-${key}`}
      onClick={() => setValue('tab', key)}
    >
      {label}
    </button>
  );

  return (
    <>
      {/* На телефоне вкладки — одним переключателем во всю ширину, кнопка —
          строкой ниже (index.css, .deals-head). У менеджера вкладка одна —
          там она на телефоне не показывается. */}
      <div className="deals-head">
        <div className={`deals-tabs${founder ? '' : ' is-single'}`}>
          {!founder && tabBtn('mine', t('deals.tab.mine'))}
          {founder && (
            <>
              {tabBtn('pending', t('deals.tab.pending'))}
              {tabBtn('approved', t('deals.tab.approved'))}
              {tabBtn('all', t('deals.tab.all'))}
            </>
          )}
        </div>
        <button className="btn btn-primary deals-new" onClick={() => navigate('/submissions/new')} data-testid="deals-new">
          <Icon name="add" size={16} /> {t('dealForm.title')}
        </button>
      </div>

      {/* Одна строка фильтров на все вкладки. На «На рассмотрении» период —
          по дате оплаты (в карточке платежа видна именно она), на остальных —
          по дате создания сделки. По умолчанию период пуст, и очередь на
          одобрение видна целиком. */}
      <div className="filters deals-filters">
        {founder && partners.length > 0 && (
          <CrmSelect
            className="crm-select"
            value={f.partner}
            onChange={(e) => setValue('partner', e.target.value)}
            style={{ ['--filter-w' as string]: '220px' }}
            title={t('deals.partner.all')}
            data-testid="deals-filter-partner"
          >
            <option value="">{t('deals.partner.all')}</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} · {p.referralCode}
              </option>
            ))}
          </CrmSelect>
        )}
        <PeriodFilter
          from={f.from}
          to={f.to}
          onFrom={(v) => setValue('from', v)}
          onTo={(v) => setValue('to', v)}
        />
        <SearchField
          value={searchInput}
          onChange={setSearchInput}
          onClear={clearSearch}
          placeholder={t('deals.search.placeholder')}
          testId="deals-search"
        />
        {(narrowed || searchInput) && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              // Поле гасим сразу: недобежавший дебаунс иначе вернул бы
              // текст обратно в ссылку.
              setSearchInput('');
              reset(['partner', 'from', 'to', 'search']);
            }}
          >
            <Icon name="close" size={14} /> {t('common.reset')}
          </button>
        )}
      </div>
      <ActiveFilterChips
        chips={[
          ...(f.search
            ? [{ key: 'search', label: `${t('list.chip.search')}: «${f.search}»`, onClear: clearSearch }]
            : []),
          ...(f.partner
            ? [{
                key: 'partner',
                label: `${t('list.chip.partner')}: ${partners.find((p) => p.id === f.partner)?.fullName ?? '…'}`,
                onClear: () => reset(['partner']),
              }]
            : []),
          ...(f.from || f.to
            ? [{
                key: 'period',
                label: f.from && f.to
                  ? `${t('list.chip.period')}: ${fmtDay(f.from)} — ${fmtDay(f.to)}`
                  : f.from
                    ? `${t('list.chip.periodFrom')} ${fmtDay(f.from)}`
                    : `${t('list.chip.periodTo')} ${fmtDay(f.to)}`,
                onClear: () => reset(['from', 'to']),
              }]
            : []),
        ]}
      />

      {tab === 'mine' && <MySubmissions f={f} narrowed={narrowed} />}
      {tab === 'pending' && <PendingPayments f={f} narrowed={narrowed} />}
      {tab === 'approved' && <ApprovedSubmissions f={f} narrowed={narrowed} />}
      {tab === 'all' && <AllSubmissions f={f} narrowed={narrowed} />}
    </>
  );
}

/** Параметры запроса из фильтров экрана; пустые поля не шлём. */
function params(f: DealFilters) {
  return {
    partnerId: f.partner || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    search: f.search || undefined,
  };
}

/**
 * Список вкладки: счётчик, загрузка, пусто/ничего не найдено, карточки. Один
 * на все вкладки, чтобы они выглядели и вели себя одинаково.
 */
function DealsList<T>({
  noun,
  query,
  totalQuery,
  narrowed,
  emptyText,
  render,
}: {
  noun: ListNoun;
  query: { data?: T[]; isLoading: boolean; isPlaceholderData: boolean };
  totalQuery: { data?: T[] };
  narrowed: boolean;
  emptyText: string;
  render: (item: T) => ReactNode;
}) {
  const { t } = useT();
  const items = query.data ?? [];
  if (query.isLoading) return <Loading />;
  return (
    <>
      <div className="list-total-row">
        <ListTotal
          noun={noun}
          found={items.length}
          total={totalQuery.data?.length}
          filtered={narrowed}
          testId="deals-total"
        />
      </div>
      {items.length === 0 ? (
        // Под фильтром «пока нет» было бы неправдой: сделки есть, не нашлись эти.
        <Empty>{narrowed ? t('common.empty') : emptyText}</Empty>
      ) : (
        <div
          className={query.isPlaceholderData ? 'list-stale' : undefined}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          data-testid="deals-list"
        >
          {items.map(render)}
        </div>
      )}
    </>
  );
}

function MySubmissions({ f, narrowed }: { f: DealFilters; narrowed: boolean }) {
  const { t } = useT();
  const p = params(f);
  const query = useQuery({
    queryKey: ['submissions', 'mine', p],
    queryFn: () => listMySubmissions({ from: p.from, to: p.to, search: p.search }),
    placeholderData: keepPreviousData,
  });
  const totalQuery = useQuery({
    queryKey: ['submissions', 'mine', {}],
    queryFn: () => listMySubmissions(),
    enabled: narrowed,
  });
  return (
    <DealsList
      noun="deals"
      query={query}
      totalQuery={narrowed ? totalQuery : query}
      narrowed={narrowed}
      emptyText={t('deals.empty.mine')}
      render={(s: SaleSubmission) => <SubmissionCard key={s.id} s={s} />}
    />
  );
}

function AllSubmissions({ f, narrowed }: { f: DealFilters; narrowed: boolean }) {
  const { t } = useT();
  const p = params(f);
  const query = useQuery({
    queryKey: ['submissions', 'all', p],
    queryFn: () => listAllSubmissions({ take: 200, ...p }),
    placeholderData: keepPreviousData,
  });
  const totalQuery = useQuery({
    queryKey: ['submissions', 'all', {}],
    queryFn: () => listAllSubmissions({ take: 200 }),
    enabled: narrowed,
  });
  return (
    <DealsList
      noun="deals"
      query={query}
      totalQuery={narrowed ? totalQuery : query}
      narrowed={narrowed}
      emptyText={t('deals.empty.all')}
      render={(s: SaleSubmission) => <SubmissionCard key={s.id} s={s} showManager />}
    />
  );
}

function ApprovedSubmissions({ f, narrowed }: { f: DealFilters; narrowed: boolean }) {
  const { t } = useT();
  const p = params(f);
  const query = useQuery({
    queryKey: ['submissions', 'approved', p],
    queryFn: () => listAllSubmissions({ firstApproved: true, take: 200, ...p }),
    placeholderData: keepPreviousData,
  });
  const totalQuery = useQuery({
    queryKey: ['submissions', 'approved', {}],
    queryFn: () => listAllSubmissions({ firstApproved: true, take: 200 }),
    enabled: narrowed,
  });
  return (
    <DealsList
      noun="deals"
      query={query}
      totalQuery={narrowed ? totalQuery : query}
      narrowed={narrowed}
      emptyText={t('deals.empty.approved')}
      render={(s: SaleSubmission) => <SubmissionCard key={s.id} s={s} showManager />}
    />
  );
}

function PendingPayments({ f, narrowed }: { f: DealFilters; narrowed: boolean }) {
  const { t } = useT();
  // Партнёр здесь нужен по той же причине, что на «Всех» и «Одобренных»:
  // перед выплатой партнёру надо видеть и то, что вот-вот одобрят, — иначе
  // сумма к выплате считается по неполной картине.
  const p = params(f);
  const query = useQuery({
    queryKey: ['submissions', 'pending', p],
    queryFn: () => listPendingPayments(p),
    placeholderData: keepPreviousData,
  });
  const totalQuery = useQuery({
    queryKey: ['submissions', 'pending', {}],
    queryFn: () => listPendingPayments(),
    enabled: narrowed,
  });
  return (
    <DealsList
      noun="payments"
      query={query}
      totalQuery={narrowed ? totalQuery : query}
      narrowed={narrowed}
      emptyText={t('deals.empty.pending')}
      render={(pp: PendingPayment) => <PendingPaymentCard key={pp.id} p={pp} />}
    />
  );
}

function SubmissionCard({ s, showManager }: { s: SaleSubmission; showManager?: boolean }) {
  const { t } = useT();
  const studentName = s.student?.fullName || s.newStudentName || '—';
  const program = s.program?.name || '—';
  const totalPaid = s.payments.filter((p) => p.status === 'APPROVED').reduce((sum, p) => sum + p.amount, 0);
  const pendingSum = s.payments.filter((p) => p.status === 'PENDING').reduce((sum, p) => sum + p.amount, 0);
  return (
    <Link
      to={`/submissions/${s.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <motion.div
        className="card deal-card"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -2 }}
      >
        <div className="deal-card-head">
          <div className="deal-card-who">
            <div className="deal-card-name">{studentName}</div>
            <div className="deal-card-sub">{program}</div>
            {showManager && s.manager && (
              <div className="deal-card-mgr">
                {t('deal.manager')}: {s.manager.fullName}
              </div>
            )}
            {/* Партнёр, приведший клиента. Приходит только руководству —
                бэкенд не кладёт поле в ответ остальным ролям, поэтому здесь
                достаточно проверки на наличие. Сделки без партнёра (таких
                большинство — люди приходят сами) строку не показывают. */}
            {s.partnerAttribution && (
              <div className="deal-card-partner">
                {t('deals.partner')}: {s.partnerAttribution.fullName}
                <span className="deal-card-partner-note">· {s.partnerAttribution.referralCode}</span>
                {s.partnerAttribution.commissionedAt && (
                  <span className="deal-card-partner-note">· {t('deals.credited')}</span>
                )}
              </div>
            )}
          </div>
          <span
            className="deal-card-status"
            style={{ background: STATUS_COLOR[s.status] + '22', color: STATUS_COLOR[s.status], borderColor: STATUS_COLOR[s.status] }}
          >
            {SUBMISSION_STATUS_LABEL[s.status]}
          </span>
        </div>
        <div className="deal-card-stats">
          <div>
            <div className="deal-stat-label">{t('deal.contract')}</div>
            <div className="deal-stat-value">{s.totalAmount.toLocaleString('ru-RU')} {s.currency}</div>
          </div>
          <div>
            <div className="deal-stat-label">{t('deal.stat.paid')}</div>
            <div className="deal-stat-value" style={{ color: 'var(--primary-dark)' }}>
              {totalPaid.toLocaleString('ru-RU')} {s.currency}
            </div>
          </div>
          {pendingSum > 0 && (
            <div>
              <div className="deal-stat-label">{t('deals.awaiting')}</div>
              <div className="deal-stat-value" style={{ color: '#b45309' }}>
                {pendingSum.toLocaleString('ru-RU')} {s.currency}
              </div>
            </div>
          )}
          <div>
            <div className="deal-stat-label">{t('deal.stat.payments')}</div>
            <div className="deal-stat-value is-light">{s.payments.length}</div>
          </div>
        </div>
      </motion.div>
    </Link>
  );
}

function PendingPaymentCard({ p }: { p: PendingPayment }) {
  const { t } = useT();
  const studentName = p.submission.student?.fullName || p.submission.newStudentName || '—';
  const partner = p.submission.partnerAttribution;

  // Сколько уйдёт партнёру. Здесь нельзя писать «начислено», как в карточке
  // сделки: на вкладке «На рассмотрении» платёж ещё не одобрен, комиссии в
  // природе нет, и «начислено» было бы неправдой — деньги показались бы уже
  // потраченными.
  //
  // Исключение — рассрочка: если первый платёж сделки давно одобрен, комиссия
  // за этого клиента уже существует (она одна на клиента, не на платёж), и
  // очередной PENDING-платёж партнёру ничего не добавит. Тогда правда
  // противоположная — «начислено», и врать в другую сторону тоже нельзя.
  const credited = !!partner?.commissionedAt;
  const commissionLabel = partner
    ? partner.commissionCurrency
      ? fmtMoneyCents(partner.commissionAmountCents, partner.commissionCurrency)
      : fmtCommissionRate(partner.commissionAmountCents)
    : '';

  return (
    <Link
      to={`/submissions/${p.submission.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <motion.div
        className="card deal-card is-payment"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -2 }}
      >
        <div className="deal-card-head">
          <div className="deal-card-who">
            <div className="deal-card-name">{studentName}</div>
            {/* Программу и менеджера у сделки могли удалить (обе связи
                SetNull) — строка не должна ронять весь экран. */}
            <div className="deal-card-sub">{p.submission.program?.name || '—'}</div>
            {p.submission.manager && (
              <div className="deal-card-mgr">
                {t('deal.manager')}: {p.submission.manager.fullName}
              </div>
            )}
            {/* Партнёр приходит только руководству — бэкенд не кладёт поле в
                ответ остальным ролям, поэтому здесь достаточно проверки на
                наличие. Клиенты без партнёра (их большинство) строку не
                показывают. */}
            {partner && (
              <div className="deal-card-partner">
                {t('deals.partner')}: {partner.fullName}
                <span className="deal-card-partner-note">· {partner.referralCode}</span>
                <span className="deal-card-partner-note">
                  · {credited ? t('deals.credited') : t('deals.onApproval')} {commissionLabel}
                </span>
              </div>
            )}
          </div>
          <span
            className="deal-card-status"
            style={{
              background: PAYMENT_STATUS_COLOR.PENDING + '22',
              color: PAYMENT_STATUS_COLOR.PENDING,
              borderColor: PAYMENT_STATUS_COLOR.PENDING,
            }}
          >
            {PAYMENT_STATUS_LABEL.PENDING}
          </span>
        </div>
        <div className="deal-card-stats">
          <div>
            <div className="deal-stat-label">{t('deals.payAmount')}</div>
            <div className="deal-stat-value is-amount">
              {p.amount.toLocaleString('ru-RU')} {p.submission.currency}
            </div>
          </div>
          <div>
            <div className="deal-stat-label">{t('deal.col.paidAt')}</div>
            <div className="deal-stat-value is-light">
              {new Date(p.paidAt).toLocaleDateString('ru-RU')}
            </div>
          </div>
          {(p.receiptUrls.length > 0 || p.depositProofUrls.length > 0) && (
            <div className="deal-card-files">
              {p.receiptUrls.length > 0 && (
                <a
                  href={absUrl(p.receiptUrls[0])}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="btn btn-sm btn-secondary"
                  data-testid="deal-card-receipt"
                >
                  <Icon name="image" size={14} /> {t('deal.receipt')}{p.receiptUrls.length > 1 ? ` (${p.receiptUrls.length})` : ''}
                </a>
              )}
              {p.depositProofUrls.length > 0 && (
                <a
                  href={absUrl(p.depositProofUrls[0])}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="btn btn-sm btn-secondary"
                  data-testid="deal-card-deposit"
                >
                  <Icon name="image" size={14} /> {t('deal.deposit')}{p.depositProofUrls.length > 1 ? ` (${p.depositProofUrls.length})` : ''}
                </a>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </Link>
  );
}

function Loading() {
  const { t } = useT();
  return <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-soft)' }}>{t('common.loading')}</div>;
}
function Empty({ children }: { children: any }) {
  return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>{children}</div>;
}
