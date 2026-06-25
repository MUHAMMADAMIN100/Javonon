import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminListPartners,
  adminListCommissions,
  adminListPayouts,
  adminMarkCommissionPaid,
  adminPayoutPay,
  adminPayoutReject,
  adminUpdatePartner,
  fmtMoneyCents,
} from '../api/partners';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';

type Tab = 'partners' | 'commissions' | 'payouts';

export default function Partners() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('partners');

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.partners15')}</span>
        <h2 className="crm-section-title">{t('partners.title')}</h2>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'partners'} onClick={() => setTab('partners')}>{t('partners.tab.list')}</TabBtn>
        <TabBtn active={tab === 'commissions'} onClick={() => setTab('commissions')}>{t('partners.tab.commissions')}</TabBtn>
        <TabBtn active={tab === 'payouts'} onClick={() => setTab('payouts')}>{t('partners.tab.payouts')}</TabBtn>
      </div>

      {tab === 'partners' && <PartnersList />}
      {tab === 'commissions' && <CommissionsList />}
      {tab === 'payouts' && <PayoutsList />}
    </>
  );
}

function TabBtn({ active, onClick, children }: any) {
  return (
    <button
      onClick={onClick}
      className={active ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
      style={{ minWidth: 120 }}
    >
      {children}
    </button>
  );
}

function PartnersList() {
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const { t } = useT();
  const { data: partners = [], isLoading } = useQuery({
    queryKey: ['admin', 'partners'],
    queryFn: () => adminListPartners(),
  });

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

  const updatePct = async (id: string, current: number) => {
    const raw = window.prompt(t('partners.col.commissionPct') + ' (0-100):', String(current));
    if (raw == null) return;
    const pct = parseInt(raw, 10);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      toast(t('toast.error'), 'error');
      return;
    }
    try {
      await adminUpdatePartner(id, { commissionPct: pct });
      qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  if (isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  if (partners.length === 0) return <div className="card" style={{ padding: 24 }}>{t('partners.empty')}</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('partners.col.email')}</th>
              <th>{t('partners.col.code')}</th>
              <th>{t('partners.col.commissionPct')}</th>
              <th>{t('partners.col.referrals')}</th>
              <th>{t('partners.col.balance')}</th>
              <th>{t('partners.col.earned')}</th>
              <th>{t('partners.col.status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id}>
                <td data-label="Имя">{p.fullName}</td>
                <td data-label="Email">{p.email}</td>
                <td data-label="Код"><code>{p.referralCode}</code></td>
                <td data-label="%">{p.commissionPct}%</td>
                <td data-label="Воронка">
                  {p._count?.clicks ?? 0} / {p._count?.attributions ?? 0} / {p._count?.commissions ?? 0}
                </td>
                <td data-label="Баланс">{fmtMoneyCents(p.balanceCents)}</td>
                <td data-label="Заработано">{fmtMoneyCents(p.totalEarnedCents)}</td>
                <td>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                    background: p.status === 'ACTIVE' ? '#dcfce7' : p.status === 'SUSPENDED' ? '#fef3c7' : '#fee2e2',
                    color: p.status === 'ACTIVE' ? '#15803d' : p.status === 'SUSPENDED' ? '#b45309' : '#b91c1c',
                  }}>{t(`partners.status.${p.status}`)}</span>
                </td>
                <td data-label="Действия">
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => updatePct(p.id, p.commissionPct)}>%</button>
                    {p.status === 'ACTIVE' ? (
                      <button className="btn btn-sm btn-secondary" onClick={() => updateStatus(p.id, 'SUSPENDED')}>⏸</button>
                    ) : (
                      <button className="btn btn-sm btn-secondary" onClick={() => updateStatus(p.id, 'ACTIVE')}>▶</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CommissionsList() {
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const { t } = useT();
  const [statusFilter, setStatusFilter] = useState<'' | 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED'>('');

  const { data: commissions = [], isLoading } = useQuery({
    queryKey: ['admin', 'commissions', statusFilter],
    queryFn: () => adminListCommissions(statusFilter ? { status: statusFilter as any } : undefined),
  });

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
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: 14, borderBottom: '1px solid var(--border-soft)' }}>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}
        >
          <option value="">{t('common.all')}</option>
          <option value="PENDING">{t('partners.commission.status.PENDING')}</option>
          <option value="APPROVED">{t('partners.commission.status.APPROVED')}</option>
          <option value="PAID">{t('partners.commission.status.PAID')}</option>
          <option value="REVERSED">{t('partners.commission.status.REVERSED')}</option>
        </select>
      </div>
      {isLoading ? (
        <div style={{ padding: 24 }}>{t('common.loading')}</div>
      ) : commissions.length === 0 ? (
        <div style={{ padding: 24 }}>{t('common.empty')}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('partners.commission.col.createdAt')}</th>
                <th>{t('partners.tab.list')}</th>
                <th>{t('partners.commission.col.base')}</th>
                <th>{t('partners.commission.col.percent')}</th>
                <th>{t('partners.commission.col.amount')}</th>
                <th>{t('partners.commission.col.status')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {commissions.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.createdAt).toLocaleString('ru-RU')}</td>
                  <td>{c.partner?.fullName} <span style={{ color: 'var(--text-soft)', fontSize: 12 }}>({c.partner?.email})</span></td>
                  <td>{fmtMoneyCents(c.baseAmountCents, c.currency)}</td>
                  <td>{c.percent}%</td>
                  <td><b>{fmtMoneyCents(c.amountCents, c.currency)}</b></td>
                  <td>{t(`partners.commission.status.${c.status}`)}</td>
                  <td>
                    {c.status !== 'PAID' && (
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
      )}
    </div>
  );
}

function PayoutsList() {
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const { t } = useT();
  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['admin', 'payouts'],
    queryFn: () => adminListPayouts(),
  });

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

  if (isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  if (payouts.length === 0) return <div className="card" style={{ padding: 24 }}>{t('common.empty')}</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('partners.payout.col.requestedAt')}</th>
              <th>{t('partners.tab.list')}</th>
              <th>{t('partners.payout.col.amount')}</th>
              <th>{t('partners.payout.col.method')}</th>
              <th>{t('partners.payout.col.details')}</th>
              <th>{t('partners.payout.col.status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.requestedAt).toLocaleString('ru-RU')}</td>
                <td>{p.partner?.fullName}</td>
                <td>{fmtMoneyCents(p.amountCents, p.currency)}</td>
                <td>{p.method || '—'}</td>
                <td style={{ wordBreak: 'break-all' }}>{p.details || '—'}</td>
                <td>{t(`partners.payout.status.${p.status}`)}</td>
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
    </div>
  );
}
