import { useCallback, useState, type ReactNode } from 'react';
import CrmSelect from '../components/CrmSelect';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminApproveCommission,
  adminCreatePartner,
  adminDeletePartner,
  adminListPartners,
  adminListCommissions,
  adminListPayouts,
  adminMarkCommissionPaid,
  adminPayoutPay,
  adminPayoutReject,
  adminUpdatePartner,
  fmtCommissionRate,
  fmtMoneyCents,
  commissionRateSortKey,
  type AdminCreatePartnerResponse,
  type Partner,
} from '../api/partners';
import { useUI } from '../ui/Dialogs';
import { buildReferralUrl } from '../lib/landingUrl';
import { useT } from '../lib/i18n';
import { hasRole } from '../lib/roles';
import { useAuth } from '../store/auth';
import Icon from '../Icon';
import QrCode from '../components/QrCode';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import SearchField, { useUrlSearch } from '../components/SearchField';
import ListTotal, { type ListNoun } from '../components/ListTotal';
import ActiveFilterChips from '../components/ActiveFilterChips';
import { enumParam, stringParam, useUrlListState } from '../lib/useUrlListState';
import { matchesSearch } from '../lib/listSearch';

type Tab = 'partners' | 'commissions' | 'payouts';
const COMMISSION_STATUSES = ['PENDING', 'APPROVED', 'PAID', 'REVERSED'] as const;

/** Поиск вкладки: текст в поле, значение из ссылки и «очистить сейчас». */
type SearchCtl = {
  value: string;
  input: string;
  setInput: (v: string) => void;
  clear: () => void;
};

export default function Partners() {
  const { t } = useT();
  // Вкладка, поиск и статус комиссий — в ссылке: из карточки партнёра
  // возвращаются кнопкой «назад», и открыться должна та же выборка. Поиск
  // общий на три вкладки: нашли «Faiziddin» в партнёрах — на «Комиссиях»
  // сразу видны его комиссии.
  const { values, setValue, reset } = useUrlListState({
    tab: enumParam<Tab, Tab>(['partners', 'commissions', 'payouts'], 'partners'),
    search: stringParam('', 200),
    status: enumParam(COMMISSION_STATUSES),
  });
  const { tab } = values;
  const setUrlSearch = useCallback((v: string) => setValue('search', v), [setValue]);
  const { input, setInput, clear } = useUrlSearch(values.search, setUrlSearch);
  const search: SearchCtl = { value: values.search, input, setInput, clear };

  return (
    <>
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'partners'} onClick={() => setValue('tab', 'partners')} testId="partners-tab-partners">{t('partners.tab.list')}</TabBtn>
        <TabBtn active={tab === 'commissions'} onClick={() => setValue('tab', 'commissions')} testId="partners-tab-commissions">{t('partners.tab.commissions')}</TabBtn>
        <TabBtn active={tab === 'payouts'} onClick={() => setValue('tab', 'payouts')} testId="partners-tab-payouts">{t('partners.tab.payouts')}</TabBtn>
      </div>

      {tab === 'partners' && <PartnersList search={search} />}
      {tab === 'commissions' && (
        <CommissionsList
          search={search}
          status={values.status}
          onStatus={(v) => setValue('status', v)}
          onResetStatus={() => reset(['status'])}
        />
      )}
      {tab === 'payouts' && <PayoutsList search={search} />}
    </>
  );
}

/**
 * Каркас списка вкладки — один на «Партнёров», «Комиссии» и «Выплаты», чтобы
 * они выглядели одинаково: в шапке счётчик слева и кнопка справа, под ней
 * строка фильтров с поиском, «Сбросить» и плашки, дальше таблица.
 */
function ListShell({
  noun,
  found,
  total,
  search,
  placeholder,
  filters,
  extraActive = false,
  onResetExtra,
  action,
  loading,
  emptyText,
  children,
}: {
  noun: ListNoun;
  found: number;
  /** Сколько всего без фильтров; нужен, только когда что-то отфильтровано. */
  total?: number;
  search: SearchCtl;
  placeholder: string;
  /** Свои фильтры вкладки — встают в строку перед поиском. */
  filters?: ReactNode;
  extraActive?: boolean;
  onResetExtra?: () => void;
  action?: ReactNode;
  loading: boolean;
  emptyText: string;
  children: ReactNode;
}) {
  const { t } = useT();
  const narrowed = !!search.value || extraActive;
  return (
    <div className="card">
      <div className="card-header is-titleless">
        <ListTotal noun={noun} found={found} total={total} filtered={narrowed} testId="partners-total" />
        {action}
      </div>
      <div className="card-body">
        <div className="filters">
          {filters}
          <SearchField
            value={search.input}
            onChange={search.setInput}
            onClear={search.clear}
            placeholder={placeholder}
            testId="partners-search"
          />
          {(narrowed || search.input) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                search.clear();
                onResetExtra?.();
              }}
            >
              <Icon name="close" size={14} /> {t('common.reset')}
            </button>
          )}
        </div>
        <ActiveFilterChips
          chips={
            search.value
              ? [{ key: 'search', label: `${t('list.chip.search')}: «${search.value}»`, onClear: search.clear }]
              : []
          }
        />
        {loading ? (
          <div style={{ padding: 24 }}>{t('common.loading')}</div>
        ) : found === 0 ? (
          <div className="empty" data-testid="partners-empty">
            <div className="empty-icon"><Icon name={narrowed ? 'search_off' : 'inbox'} size={48} /></div>
            {/* Под фильтром «пусто» было бы неправдой: есть, но не нашлись эти. */}
            {narrowed ? t('common.empty') : emptyText}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children, testId }: any) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={active ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
      style={{ minWidth: 120 }}
    >
      {children}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Copy-to-clipboard helper. Same behaviour as Offers.tsx: prefer the async
// Clipboard API in secure contexts, fall back to the hidden <textarea> +
// document.execCommand('copy') trick for older browsers / plain HTTP dev boxes.
// -----------------------------------------------------------------------------
async function copyToClipboard(text: string): Promise<boolean> {
  // Prefer the async Clipboard API in secure contexts, but if it rejects
  // (e.g. permission denied inside a sandboxed iframe) fall through to the
  // legacy textarea + execCommand path instead of failing the whole call.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy fallback below
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    // execCommand('copy') can silently return false (cross-origin iframes
    // without clipboard-write, some Safari contexts, blocked selection);
    // honour its result instead of unconditionally reporting success.
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Referral link for a row of the partners list.
 *
 * The backend is the single source of truth: `GET /admin/partners` returns a
 * ready `referralUrl` per partner (partners.service.adminList →
 * buildReferralUrl), identical to what adminCreate and adminGetOne return. So
 * the list, the partner card and the share modal can no longer disagree.
 *
 * lib/landingUrl.buildReferralUrl is the emergency path only — for the window
 * where the CRM (Vercel) is deployed ahead of the backend (Railway) and the
 * field is missing from the response. Never inline an env chain here: the
 * live domain and the mandatory '#apply' anchor live in that one helper.
 */
function referralUrlOf(p: Partner): string {
  return p.referralUrl || buildReferralUrl(p.referralCode);
}

function PartnersList({ search }: { search: SearchCtl }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast, confirm } = useUI();
  const { t } = useT();
  const { data: partners = [], isLoading } = useQuery({
    queryKey: ['admin', 'partners'],
    queryFn: () => adminListPartners(),
  });
  // Список партнёров приходит целиком — ищем в браузере.
  const shown = partners.filter((p) =>
    matchesSearch(search.value, [p.fullName, p.email, p.referralCode], [p.phone]),
  );
  const sort = useTableSort(
    shown,
    [
      { key: 'name', label: t('common.name'), value: (p) => p.fullName },
      { key: 'email', label: t('partners.col.email'), value: (p) => p.email },
      { key: 'code', label: t('partners.col.code'), value: (p) => p.referralCode },
      { key: 'commission', label: t('partners.col.commission'), type: 'number', value: (p) => p.commissionAmountCents },
      // Колонка «клики / привлечённые / комиссии» — сортируем по привлечённым.
      { key: 'referrals', label: t('partners.col.referrals'), type: 'number', value: (p) => p._count?.attributions ?? 0 },
      { key: 'balance', label: t('partners.col.balance'), type: 'number', value: (p) => p.balanceCents },
      { key: 'earned', label: t('partners.col.earned'), type: 'number', value: (p) => p.totalEarnedCents },
      { key: 'status', label: t('partners.col.status'), value: (p) => t(`partners.status.${p.status}`) },
    ],
    { param: 'sortPartners' },
  );

  const [addOpen, setAddOpen] = useState(false);
  const [shareData, setShareData] = useState<{
    referralUrl: string;
    partner: Partner;
    plainPassword?: string;
  } | null>(null);

  const updateStatus = async (id: string, status: 'ACTIVE' | 'SUSPENDED' | 'BANNED') => {
    const ok = await confirm({
      title: `${t('partners.col.status')}: ${t(`partners.status.${status}`)}`,
      message: '',
      confirmText: t('common.apply'),
    });
    if (!ok) return;
    try {
      await adminUpdatePartner(id, { status });
      qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const updateAmount = async (id: string, currentCents: number) => {
    const currentTjs = Math.round((currentCents ?? 0) / 100);
    const raw = window.prompt(
      t('partners.col.commission.prompt') + ' (0–100000):',
      String(currentTjs),
    );
    if (raw == null) return;
    const amountTjs = parseInt(raw, 10);
    if (isNaN(amountTjs) || amountTjs < 0 || amountTjs > 100000) {
      toast(t('toast.error'), 'error');
      return;
    }
    try {
      await adminUpdatePartner(id, { commissionAmountTjs: amountTjs });
      qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const copyRow = async (p: Partner) => {
    const ok = await copyToClipboard(referralUrlOf(p));
    toast(ok ? t('common.copied') : t('toast.error'), ok ? 'success' : 'error');
  };

  const openShareFor = (p: Partner) => {
    setShareData({ referralUrl: referralUrlOf(p), partner: p });
  };

  const removePartner = async (p: Partner) => {
    const ok = await confirm({
      title: t('partners.delete.confirm'),
      message: `${p.fullName} · ${p.email}`,
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await adminDeletePartner(p.id);
      qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
      if (res.softDeleted) {
        toast(t('partners.delete.soft'), 'success');
      } else {
        toast(t('partners.delete.hard'), 'success');
      }
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const onCreated = (res: AdminCreatePartnerResponse) => {
    qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
    setAddOpen(false);
    setShareData({
      referralUrl: res.referralUrl,
      partner: res.partner,
      plainPassword: res.plainPassword,
    });
  };

  return (
    <>
    <ListShell
      noun="partners"
      found={shown.length}
      total={partners.length}
      search={search}
      placeholder={t('partners.search.placeholder')}
      action={
        <button className="btn btn-primary btn-sm" data-testid="partner-add" onClick={() => setAddOpen(true)}>
          <Icon name="add" size={14} /> {t('partners.add')}
        </button>
      }
      loading={isLoading}
      emptyText={t('partners.empty')}
    >
        <div className="table-wrap">
          <SortSelect sort={sort} />
          <table className="table">
            <thead>
              <tr>
                {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((p) => {
                const stop = (fn: () => void) => (e: React.MouseEvent) => {
                  e.stopPropagation();
                  fn();
                };
                return (
                <tr
                  key={p.id}
                  onClick={() => navigate(`/partners/${p.id}`)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      navigate(`/partners/${p.id}`);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  style={{ cursor: 'pointer' }}
                  className="row-clickable"
                  aria-label={`${p.fullName} — ${p.email}`}
                >
                  <td data-label={t('common.name')}>{p.fullName}</td>
                  <td data-label={t('partners.col.email')}>{p.email}</td>
                  <td data-label={t('partners.col.code')}><code>{p.referralCode}</code></td>
                  <td data-label={t('partners.col.commission')}>{fmtCommissionRate(p.commissionAmountCents)}</td>
                  <td data-label={t('partners.col.referrals')}>
                    {p._count?.clicks ?? 0} / {p._count?.attributions ?? 0} / {p._count?.commissions ?? 0}
                  </td>
                  <td data-label={t('partners.col.balance')}>{fmtMoneyCents(p.balanceCents)}</td>
                  <td data-label={t('partners.col.earned')}>{fmtMoneyCents(p.totalEarnedCents)}</td>
                  <td data-label={t('common.status')}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                      background: p.status === 'ACTIVE' ? '#dcfce7' : p.status === 'SUSPENDED' ? '#fef3c7' : '#fee2e2',
                      color: p.status === 'ACTIVE' ? '#15803d' : p.status === 'SUSPENDED' ? '#b45309' : '#b91c1c',
                    }}>{t(`partners.status.${p.status}`)}</span>
                  </td>
                  <td data-label={t('common.actions')} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={stop(() => copyRow(p))}
                        title={t('partners.share.copy')}
                      >
                        <Icon name="content_copy" size={14} />
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={stop(() => openShareFor(p))}
                        title={t('partners.share.title')}
                      >
                        <Icon name="link" size={14} />
                      </button>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={stop(() => updateAmount(p.id, p.commissionAmountCents))}
                        title={t('partners.col.commission.prompt')}
                      >
                        TJS
                      </button>
                      {p.status === 'ACTIVE' ? (
                        <button className="btn btn-sm btn-secondary" onClick={stop(() => updateStatus(p.id, 'SUSPENDED'))}>⏸</button>
                      ) : (
                        <button className="btn btn-sm btn-secondary" onClick={stop(() => updateStatus(p.id, 'ACTIVE'))}>▶</button>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={stop(() => removePartner(p))}
                        title={t('common.delete')}
                      >
                        <Icon name="delete" size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
    </ListShell>

      <AddPartnerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={onCreated}
      />
      <ShareLinkModal
        data={shareData}
        onClose={() => setShareData(null)}
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// AddPartnerModal
// -----------------------------------------------------------------------------

type AddModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (res: AdminCreatePartnerResponse) => void;
};

function AddPartnerModal({ open, onClose, onCreated }: AddModalProps) {
  const { toast } = useUI();
  const { t } = useT();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [commissionAmountTjs, setCommissionAmountTjs] = useState(500);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setFullName('');
    setEmail('');
    setPhone('');
    setPassword('');
    setCommissionAmountTjs(500);
    setErr(null);
    setBusy(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const name = fullName.trim();
    const mail = email.trim();
    if (name.length < 2 || name.length > 100) {
      setErr(t('partners.add.err.fullName'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setErr(t('partners.add.err.email'));
      return;
    }
    const ph = phone.trim();
    if (ph && (ph.length < 5 || ph.length > 20)) {
      setErr(t('partners.add.err.phone'));
      return;
    }
    const pw = password.trim();
    if (pw && pw.length < 8) {
      setErr(t('partners.add.err.password'));
      return;
    }
    if (
      isNaN(commissionAmountTjs) ||
      commissionAmountTjs < 0 ||
      commissionAmountTjs > 100000
    ) {
      setErr(t('partners.add.err.commissionAmount'));
      return;
    }
    setBusy(true);
    try {
      const res = await adminCreatePartner({
        fullName: name,
        email: mail,
        phone: ph || undefined,
        password: pw || undefined,
        commissionAmountTjs,
      });
      toast(t('toast.created'), 'success');
      reset();
      onCreated(res);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 409) {
        setErr(t('partners.add.err.duplicate'));
      } else {
        setErr(e?.response?.data?.message?.toString() || t('toast.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.form
            className="dialog-card"
            style={{ maxWidth: 460 }}
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
          >
            <div className="dialog-icon">
              <Icon name="person_add" size={28} />
            </div>
            <div className="dialog-title">{t('partners.add')}</div>

            {err && (
              <div className="error-banner" style={{ marginBottom: 12, textAlign: 'left' }}>
                {err}
              </div>
            )}

            <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
              <label>{t('common.fullName')}</label>
              <input
                className="crm-input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                autoFocus
                minLength={2}
                maxLength={100}
              />
            </div>
            <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
              <label>{t('common.email')}</label>
              <input
                className="crm-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
              <label>
                {t('common.phone')} <span style={{ color: 'var(--text-soft)', fontSize: 12 }}>({t('common.optional')})</span>
              </label>
              <input
                className="crm-input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={20}
                inputMode="tel"
              />
            </div>
            <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
              <label>
                {t('partners.add.password')} <span style={{ color: 'var(--text-soft)', fontSize: 12 }}>({t('common.optional')})</span>
              </label>
              <input
                className="crm-input"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                placeholder={t('partners.add.password.placeholder')}
                autoComplete="off"
              />
            </div>
            <div className="form-group" style={{ textAlign: 'left', marginBottom: 16 }}>
              <label>{t('partners.add.commissionAmount.label')} (0–100000)</label>
              <input
                className="crm-input"
                type="number"
                min={0}
                max={100000}
                step={1}
                value={commissionAmountTjs}
                onChange={(e) => setCommissionAmountTjs(parseInt(e.target.value, 10))}
                required
              />
            </div>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t('common.saving') : t('common.create')}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// -----------------------------------------------------------------------------
// ShareLinkModal — big monospace URL, QR, copy button, one-time password.
// -----------------------------------------------------------------------------

type ShareModalProps = {
  data: { referralUrl: string; partner: Partner; plainPassword?: string } | null;
  onClose: () => void;
};

function ShareLinkModal({ data, onClose }: ShareModalProps) {
  const { toast } = useUI();
  const { t } = useT();

  const copyUrl = async () => {
    if (!data) return;
    const ok = await copyToClipboard(data.referralUrl);
    toast(ok ? t('common.copied') : t('toast.error'), ok ? 'success' : 'error');
  };

  const copyPw = async () => {
    if (!data?.plainPassword) return;
    const ok = await copyToClipboard(data.plainPassword);
    toast(ok ? t('common.copied') : t('toast.error'), ok ? 'success' : 'error');
  };

  return (
    <AnimatePresence>
      {data && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="dialog-card"
            style={{ maxWidth: 520 }}
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-icon">
              <Icon name="qr_code_2" size={28} />
            </div>
            <div className="dialog-title">{t('partners.share.title')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
              {data.partner.fullName} · <code>{data.partner.referralCode}</code>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 16px' }}>
              <div style={{ background: '#fff', padding: 8, borderRadius: 8, boxShadow: '0 0 0 1px var(--border-soft)' }}>
                <QrCode value={data.referralUrl} size={220} />
              </div>
            </div>

            <div
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 14,
                background: 'var(--surface-alt, #f4f4f5)',
                border: '1px solid var(--border-soft)',
                borderRadius: 6,
                padding: '10px 12px',
                wordBreak: 'break-all',
                textAlign: 'left',
                marginBottom: 8,
                userSelect: 'all',
              }}
            >
              {data.referralUrl}
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={copyUrl}
              style={{ marginBottom: 16 }}
              type="button"
            >
              <Icon name="content_copy" size={14} /> {t('partners.share.copy')}
            </button>

            {data.plainPassword && (
              <div
                style={{
                  border: '1px solid #f59e0b',
                  background: '#fef3c7',
                  color: '#78350f',
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 16,
                  textAlign: 'left',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="warning" size={16} /> {t('partners.share.password.warning')}
                </div>
                <div
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 16,
                    fontWeight: 600,
                    background: '#fff',
                    border: '1px solid #f59e0b',
                    borderRadius: 4,
                    padding: '8px 10px',
                    userSelect: 'all',
                    marginBottom: 8,
                  }}
                >
                  {data.plainPassword}
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={copyPw}
                  type="button"
                >
                  <Icon name="content_copy" size={14} /> {t('common.copy')}
                </button>
              </div>
            )}

            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CommissionsList({
  search,
  status: statusFilter,
  onStatus,
  onResetStatus,
}: {
  search: SearchCtl;
  status: '' | (typeof COMMISSION_STATUSES)[number];
  onStatus: (v: '' | (typeof COMMISSION_STATUSES)[number]) => void;
  onResetStatus: () => void;
}) {
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const { t } = useT();
  // POST commissions/:id/approve is @Roles('FOUNDER','ADMIN') — the accountant
  // executes payouts but does not authorise them. Mirror that here so the
  // button is not offered to someone who would only get a 403.
  const me = useAuth((s) => s.user);
  const canApprove = hasRole(me, 'FOUNDER', 'ADMIN');

  const { data: commissions = [], isLoading } = useQuery({
    queryKey: ['admin', 'commissions', statusFilter],
    queryFn: () => adminListCommissions(statusFilter ? { status: statusFilter as any } : undefined),
  });
  // Все комиссии без статуса — для «Найдено: X из N»; без фильтра это тот же
  // запрос, что выше.
  const { data: allCommissions } = useQuery({
    queryKey: ['admin', 'commissions', ''],
    queryFn: () => adminListCommissions(),
    enabled: !!statusFilter,
  });
  const shown = commissions.filter((c) => matchesSearch(search.value, [c.partner?.fullName, c.partner?.email]));
  const sort = useTableSort(
    shown,
    [
      { key: 'createdAt', label: t('partners.commission.col.createdAt'), type: 'date', value: (c) => c.createdAt },
      { key: 'partner', label: t('partners.tab.list'), value: (c) => c.partner?.fullName },
      { key: 'base', label: t('partners.commission.col.base'), type: 'number', value: (c) => c.baseAmountCents },
      { key: 'rate', label: t('partners.commission.col.rate'), type: 'number', value: commissionRateSortKey },
      { key: 'amount', label: t('partners.commission.col.amount'), type: 'number', value: (c) => c.amountCents },
      { key: 'status', label: t('partners.commission.col.status'), value: (c) => t(`partners.commission.status.${c.status}`) },
    ],
    { param: 'sortComm' },
  );

  const approve = async (id: string) => {
    const ok = await confirm({
      title: t('partners.commission.approve.confirm'),
      message: t('partners.commission.approve.hint'),
      confirmText: t('partners.commission.approve'),
    });
    if (!ok) return;
    try {
      await adminApproveCommission(id);
      qc.invalidateQueries({ queryKey: ['admin', 'commissions'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const markPaid = async (id: string) => {
    const ok = await confirm({
      title: t('partners.commission.markPaid'),
      message: '',
      confirmText: t('partners.commission.status.PAID'),
    });
    if (!ok) return;
    try {
      await adminMarkCommissionPaid(id);
      qc.invalidateQueries({ queryKey: ['admin', 'commissions'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <ListShell
      noun="commissions"
      found={shown.length}
      total={statusFilter ? allCommissions?.length : commissions.length}
      search={search}
      placeholder={t('partners.search.byPartner')}
      filters={
        <CrmSelect
          className="crm-select"
          value={statusFilter}
          onChange={(e) => onStatus(e.target.value as any)}
          data-testid="commissions-filter-status"
        >
          <option value="">{t('common.all')}</option>
          <option value="PENDING">{t('partners.commission.status.PENDING')}</option>
          <option value="APPROVED">{t('partners.commission.status.APPROVED')}</option>
          <option value="PAID">{t('partners.commission.status.PAID')}</option>
          <option value="REVERSED">{t('partners.commission.status.REVERSED')}</option>
        </CrmSelect>
      }
      extraActive={!!statusFilter}
      onResetExtra={onResetStatus}
      loading={isLoading}
      emptyText={t('common.empty')}
    >
        <div className="table-wrap">
          <SortSelect sort={sort} />
          <table className="table">
            <thead>
              <tr>
                {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.createdAt).toLocaleString('ru-RU')}</td>
                  <td data-label={sort.label('partner')}>{c.partner?.fullName} <span style={{ color: 'var(--text-soft)', fontSize: 12 }}>({c.partner?.email})</span></td>
                  <td data-label={sort.label('base')}>{fmtMoneyCents(c.baseAmountCents, c.baseCurrency ?? c.currency)}</td>
                  <td data-label={sort.label('rate')}>
                    {c.percent === 0
                      ? `${t('partners.commission.rate.flat')} ${fmtMoneyCents(c.amountCents, c.currency)}`
                      : `${c.percent}%`}
                  </td>
                  <td data-label={sort.label('amount')}><b>{fmtMoneyCents(c.amountCents, c.currency)}</b></td>
                  <td data-label={sort.label('status')}>
                    {t(`partners.commission.status.${c.status}`)}
                    {/* A reversed row is the audit record of a cancelled deal:
                        the money has already been taken back off the partner's
                        balance. Spell that out — "Отменено" alone reads as
                        "not paid yet". */}
                    {c.status === 'REVERSED' && (
                      <div style={{ color: 'var(--text-soft)', fontSize: 12, marginTop: 2 }}>
                        {t('partners.commission.reversed.hint')}
                      </div>
                    )}
                  </td>
                  <td>
                    {/* REVERSED is terminal — both endpoints reject it, so no
                        action buttons. PENDING must be approved before the
                        partner can withdraw it. */}
                    {c.status === 'PENDING' && canApprove && (
                      <button
                        className="btn btn-sm btn-secondary"
                        style={{ marginRight: 4 }}
                        onClick={() => approve(c.id)}
                      >
                        {t('partners.commission.approve')}
                      </button>
                    )}
                    {c.status !== 'PAID' && c.status !== 'REVERSED' && (
                      <button className="btn btn-sm btn-primary" onClick={() => markPaid(c.id)}>
                        {t('partners.commission.status.PAID')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
    </ListShell>
  );
}

function PayoutsList({ search }: { search: SearchCtl }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const { t } = useT();
  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['admin', 'payouts'],
    queryFn: () => adminListPayouts(),
  });
  const shown = payouts.filter((p) => matchesSearch(search.value, [p.partner?.fullName, p.partner?.email]));
  const sort = useTableSort(
    shown,
    [
      { key: 'requestedAt', label: t('partners.payout.col.requestedAt'), type: 'date', value: (p) => p.requestedAt },
      { key: 'partner', label: t('partners.tab.list'), value: (p) => p.partner?.fullName },
      { key: 'amount', label: t('partners.payout.col.amount'), type: 'number', value: (p) => p.amountCents },
      { key: 'method', label: t('partners.payout.col.method'), value: (p) => p.method },
      { key: 'details', label: t('partners.payout.col.details'), value: (p) => p.details },
      { key: 'status', label: t('partners.payout.col.status'), value: (p) => t(`partners.payout.status.${p.status}`) },
    ],
    { param: 'sortPay' },
  );

  const pay = async (id: string) => {
    const ok = await confirm({
      title: t('partners.payout.confirm'),
      message: '',
      confirmText: t('partners.payout.status.PAID'),
    });
    if (!ok) return;
    try {
      await adminPayoutPay(id);
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const reject = async (id: string) => {
    const ok = await confirm({
      title: t('partners.payout.reject'),
      message: '',
      confirmText: t('partners.payout.status.REJECTED'),
      danger: true,
    });
    if (!ok) return;
    try {
      await adminPayoutReject(id);
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <ListShell
      noun="payouts"
      found={shown.length}
      total={payouts.length}
      search={search}
      placeholder={t('partners.search.byPartner')}
      loading={isLoading}
      emptyText={t('common.empty')}
    >
      <div className="table-wrap">
        <SortSelect sort={sort} />
        <table className="table">
          <thead>
            <tr>
              {sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.requestedAt).toLocaleString('ru-RU')}</td>
                <td data-label={sort.label('partner')}>{p.partner?.fullName}</td>
                <td data-label={sort.label('amount')}>{fmtMoneyCents(p.amountCents, p.currency)}</td>
                <td data-label={sort.label('method')}>{p.method || '—'}</td>
                <td data-label={sort.label('details')} className="td-stack" style={{ wordBreak: 'break-all' }}>{p.details || '—'}</td>
                <td data-label={sort.label('status')}>{t(`partners.payout.status.${p.status}`)}</td>
                <td>
                  {p.status === 'REQUESTED' && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => pay(p.id)}>{t('partners.payout.status.PAID')}</button>
                      <button className="btn btn-sm btn-danger" onClick={() => reject(p.id)}>{t('partners.payout.status.REJECTED')}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ListShell>
  );
}
