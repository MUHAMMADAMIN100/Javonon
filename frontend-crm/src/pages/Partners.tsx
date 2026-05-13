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

type Tab = 'partners' | 'commissions' | 'payouts';

export default function Partners() {
  const [tab, setTab] = useState<Tab>('partners');

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">PARTNERS · 14</span>
        <h2 className="crm-section-title">
          Партнёрская <em>программа.</em>
        </h2>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'partners'} onClick={() => setTab('partners')}>Партнёры</TabBtn>
        <TabBtn active={tab === 'commissions'} onClick={() => setTab('commissions')}>Начисления</TabBtn>
        <TabBtn active={tab === 'payouts'} onClick={() => setTab('payouts')}>Выплаты</TabBtn>
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
  const { data: partners = [], isLoading } = useQuery({
    queryKey: ['admin', 'partners'],
    queryFn: () => adminListPartners(),
  });

  const updateStatus = async (id: string, status: 'ACTIVE' | 'SUSPENDED' | 'BANNED') => {
    const ok = await confirm({
      title: `Сменить статус на ${status}?`,
      message: 'Партнёр узнает об изменении при следующем входе.',
      confirmText: 'Применить',
    });
    if (!ok) return;
    try {
      await adminUpdatePartner(id, { status });
      qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
      toast('Статус обновлён', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const updatePct = async (id: string, current: number) => {
    const raw = window.prompt('Новый % комиссии (0-100):', String(current));
    if (raw == null) return;
    const pct = parseInt(raw, 10);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      toast('Некорректное значение', 'error');
      return;
    }
    try {
      await adminUpdatePartner(id, { commissionPct: pct });
      qc.invalidateQueries({ queryKey: ['admin', 'partners'] });
      toast('Комиссия обновлена', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  if (isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  if (partners.length === 0) return <div className="card" style={{ padding: 24 }}>Партнёров пока нет</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Email</th>
              <th>Код</th>
              <th>%</th>
              <th>Клики/Лиды/Продажи</th>
              <th>Баланс</th>
              <th>Заработано</th>
              <th>Статус</th>
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
                <td data-label="Статус">
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                    background: p.status === 'ACTIVE' ? '#dcfce7' : p.status === 'SUSPENDED' ? '#fef3c7' : '#fee2e2',
                    color: p.status === 'ACTIVE' ? '#15803d' : p.status === 'SUSPENDED' ? '#b45309' : '#b91c1c',
                  }}>{p.status}</span>
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
  const [statusFilter, setStatusFilter] = useState<'' | 'PENDING' | 'APPROVED' | 'PAID' | 'REVERSED'>('');

  const { data: commissions = [], isLoading } = useQuery({
    queryKey: ['admin', 'commissions', statusFilter],
    queryFn: () => adminListCommissions(statusFilter ? { status: statusFilter as any } : undefined),
  });

  const markPaid = async (id: string) => {
    const ok = await confirm({
      title: 'Отметить выплачено?',
      message: 'Сумма спишется с баланса партнёра.',
      confirmText: 'Выплачено',
    });
    if (!ok) return;
    try {
      await adminMarkCommissionPaid(id);
      qc.invalidateQueries({ queryKey: ['admin', 'commissions'] });
      toast('Отмечено как выплачено', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
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
          <option value="">Все статусы</option>
          <option value="PENDING">Ожидают</option>
          <option value="APPROVED">Одобрены</option>
          <option value="PAID">Выплачены</option>
          <option value="REVERSED">Отменены</option>
        </select>
      </div>
      {isLoading ? (
        <div style={{ padding: 24 }}>Загружаем…</div>
      ) : commissions.length === 0 ? (
        <div style={{ padding: 24 }}>Начислений нет</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Партнёр</th>
                <th>База</th>
                <th>%</th>
                <th>Начислено</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {commissions.map((c) => (
                <tr key={c.id}>
                  <td data-label="Дата">{new Date(c.createdAt).toLocaleString('ru-RU')}</td>
                  <td data-label="Партнёр">{c.partner?.fullName} <span style={{ color: 'var(--text-soft)', fontSize: 12 }}>({c.partner?.email})</span></td>
                  <td data-label="База">{fmtMoneyCents(c.baseAmountCents, c.currency)}</td>
                  <td data-label="%">{c.percent}%</td>
                  <td data-label="Начислено"><b>{fmtMoneyCents(c.amountCents, c.currency)}</b></td>
                  <td data-label="Статус">{c.status}</td>
                  <td data-label="Действия">
                    {c.status !== 'PAID' && (
                      <button className="btn btn-sm btn-primary" onClick={() => markPaid(c.id)}>
                        Выплачено
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
  const { data: payouts = [], isLoading } = useQuery({
    queryKey: ['admin', 'payouts'],
    queryFn: () => adminListPayouts(),
  });

  const pay = async (id: string) => {
    const ok = await confirm({
      title: 'Подтвердить выплату?',
      message: 'Партнёр получит средства в указанных реквизитах.',
      confirmText: 'Выплачено',
    });
    if (!ok) return;
    try {
      await adminPayoutPay(id);
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      toast('Выплата подтверждена', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const reject = async (id: string) => {
    const ok = await confirm({
      title: 'Отклонить выплату?',
      message: 'Сумма вернётся на баланс партнёра.',
      confirmText: 'Отклонить',
      danger: true,
    });
    if (!ok) return;
    try {
      await adminPayoutReject(id);
      qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
      toast('Выплата отклонена', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  if (isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  if (payouts.length === 0) return <div className="card" style={{ padding: 24 }}>Выплат пока нет</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Партнёр</th>
              <th>Сумма</th>
              <th>Метод</th>
              <th>Реквизиты</th>
              <th>Статус</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id}>
                <td data-label="Дата">{new Date(p.requestedAt).toLocaleString('ru-RU')}</td>
                <td data-label="Партнёр">{p.partner?.fullName}</td>
                <td data-label="Сумма">{fmtMoneyCents(p.amountCents, p.currency)}</td>
                <td data-label="Метод">{p.method || '—'}</td>
                <td data-label="Реквизиты" style={{ wordBreak: 'break-all' }}>{p.details || '—'}</td>
                <td data-label="Статус">{p.status}</td>
                <td data-label="Действия">
                  {p.status === 'REQUESTED' && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => pay(p.id)}>Выплатить</button>
                      <button className="btn btn-sm btn-danger" onClick={() => reject(p.id)}>Отказать</button>
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
