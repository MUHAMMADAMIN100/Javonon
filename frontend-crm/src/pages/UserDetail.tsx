import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FullProfile,
  deleteUserDocument,
  fmtMinutes,
  fmtMoney,
  getUserFullProfile,
  updateUserHR,
  uploadUserDocument,
} from '../api/userProfile';
import { useUI } from '../ui/Dialogs';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useAuth((s) => s.user);
  if (!id) return null;
  // isAdmin определяет показывать ли HR-редактор / загрузку документов /
  // выдачу доступа. Elevated (FOUNDER/ADMIN/ACCOUNTANT) видит всё.
  // Сотрудник с grant'ом видит профиль read-only.
  return <ProfileView userId={id} isAdmin={isElevated(me)} />;
}

export function MyProfile() {
  // Self-view — id из /me/full
  return <ProfileView userId="me" isAdmin={false} />;
}

function ProfileView({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const { toast, confirm } = useUI();
  const queryKey = isAdmin ? ['user', userId, 'full'] : ['me', 'full'];

  const { data, isLoading, error } = useQuery<FullProfile>({
    queryKey,
    queryFn: async () => {
      const mod = await import('../api/userProfile');
      return isAdmin ? mod.getUserFullProfile(userId) : mod.getMyFullProfile();
    },
  });

  if (isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  if (error || !data) {
    return <div className="card" style={{ padding: 24 }}>Не удалось загрузить профиль</div>;
  }

  const { user, salary, penalties, sales, attendance, kpi, documents, dailyReports } = data;
  const realId = user.id;

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">
          {isAdmin ? `ТА · ${user.role}` : 'МОЙ ПРОФИЛЬ'}
        </span>
        <h2 className="crm-section-title">
          {user.fullName} <em>{isAdmin ? 'досье' : ''}</em>
        </h2>
      </div>

      {/* HR блок */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Личные данные</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Field label="Email" value={user.email} />
          <Field label="Роль" value={user.role} />
          <Field label="Телефон" value={user.phone || '—'} />
          <Field label="Паспорт №" value={user.passportNo || '—'} />
          <Field label="Принят на работу" value={user.hiredAt ? new Date(user.hiredAt).toLocaleDateString('ru-RU') : '—'} />
          <Field label="Аккаунт создан" value={new Date(user.createdAt).toLocaleDateString('ru-RU')} />
        </div>
        {isAdmin && <HREditor user={user} userId={realId} onSaved={() => qc.invalidateQueries({ queryKey })} />}
      </section>

      {/* Зарплата — параметры расчёта */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Зарплата · параметры</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Field label="Фикс/мес" value={fmtMoney(salary.baseSalary)} />
          <Field label="Почасовая" value={fmtMoney(salary.hourlyRate)} />
          <Field label="Бонус %" value={`${salary.bonusPercent}%`} />
          <Field
            label="KPI цель"
            value={
              `${kpi.targetPct}% от лидов` +
              ((user.kpiAutoStepPct ?? 0) > 0
                ? ` · авто +${user.kpiAutoStepPct}%/мес до ${user.kpiMaxPct ?? 3}%`
                : '')
            }
          />
        </div>
        <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-soft)' }}>
          <b>Формула:</b> Зарплата = фикс + почасовая × часы + ({salary.bonusPercent}% × продажи) + KPI-бонус − штрафы
        </p>
      </section>

      {/* Текущий месяц — фактика */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Текущий месяц</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Stat label="Часы" value={fmtMinutes(attendance.workedMinutes)} sub={`${attendance.daysWorked} раб.дней`} />
          <Stat label="Опоздания" value={fmtMinutes(attendance.lateMinutes)} accent={attendance.lateMinutes > 0 ? 'red' : 'green'} />
          <Stat label="Переработка" value={fmtMinutes(attendance.overtimeMinutes)} accent="green" />
          <Stat label="Продажи" value={fmtMoney(sales.monthAmount)} sub={`${sales.monthCount} сделок`} />
          <Stat label="Заявок в этом месяце (всего)" value={String(kpi.totalLeadsMonth)} sub={`из них ${kpi.ownClientsMonth} моих`} />
          <Stat label="Зачислено" value={`${kpi.enrolledMonth} / ${kpi.requiredClosed}`} accent={kpi.onTrack ? 'green' : 'red'} sub={`нужно ≥${kpi.requiredClosed}`} />
          <Stat label="KPI %" value={`${kpi.achievedPct}%`} accent={kpi.onTrack ? 'green' : 'red'} sub={`цель ${kpi.targetPct}%`} />
          <Stat label="Штрафы (pending)" value={fmtMoney(penalties.pendingTotal)} accent="red" />
        </div>
      </section>

      {/* История зарплат */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>История начислений</h3>
        {salary.records.length === 0 ? (
          <div style={{ color: 'var(--text-soft)', padding: 16, textAlign: 'center' }}>Расчётов пока нет</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Период</th>
                  <th>Часы</th>
                  <th>База</th>
                  <th>Продажи</th>
                  <th>Бонус</th>
                  <th>KPI</th>
                  <th>Штрафы</th>
                  <th>К выплате</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {salary.records.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Период">{new Date(r.periodStart).toLocaleDateString('ru-RU')} – {new Date(r.periodEnd).toLocaleDateString('ru-RU')}</td>
                    <td data-label="Часы">{fmtMinutes(r.workedMinutes)}</td>
                    <td data-label="База">{fmtMoney(r.baseAmount, r.currency)}</td>
                    <td data-label="Продажи">{fmtMoney(r.salesAmount, r.currency)}</td>
                    <td data-label="Бонус">{fmtMoney(r.bonusAmount, r.currency)}</td>
                    <td data-label="KPI">{fmtMoney(r.kpiBonus, r.currency)}</td>
                    <td data-label="Штрафы" style={{ color: r.penalties > 0 ? 'var(--danger)' : undefined }}>
                      {fmtMoney(r.penalties, r.currency)}
                    </td>
                    <td data-label="К выплате"><b>{fmtMoney(r.netAmount, r.currency)}</b></td>
                    <td data-label="Статус">
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                        background: r.status === 'PAID' ? '#dcfce7' : '#fef3c7',
                        color: r.status === 'PAID' ? '#15803d' : '#b45309',
                      }}>{r.status === 'PAID' ? 'ВЫПЛАЧЕНО' : 'ЧЕРНОВИК'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Штрафы */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Штрафы</h3>
        {penalties.list.length === 0 ? (
          <div style={{ color: 'var(--text-soft)', padding: 16, textAlign: 'center' }}>Штрафов нет</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Причина</th>
                  <th>Сумма</th>
                  <th>Применён в ЗП</th>
                </tr>
              </thead>
              <tbody>
                {penalties.list.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Дата">{new Date(p.date).toLocaleDateString('ru-RU')}</td>
                    <td data-label="Причина">{p.reason}{p.comment ? ` · ${p.comment}` : ''}</td>
                    <td data-label="Сумма" style={{ color: 'var(--danger)' }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td data-label="Применён">{p.applied ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Документы */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Документы</h3>
        {isAdmin && <DocUploader userId={realId} onUploaded={() => qc.invalidateQueries({ queryKey })} />}
        {documents.length === 0 ? (
          <div style={{ color: 'var(--text-soft)', padding: 16, textAlign: 'center', marginTop: 8 }}>Документов нет</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {documents.map((d) => (
              <div key={d.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 10, gap: 12,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{LABEL[d.type]}{d.originalName ? ` · ${d.originalName}` : ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                    {new Date(d.createdAt).toLocaleDateString('ru-RU')}
                    {d.size ? ` · ${(d.size / 1024).toFixed(0)} КБ` : ''}
                    {d.comment ? ` · ${d.comment}` : ''}
                  </div>
                </div>
                <a href={d.url} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">Открыть</a>
                {isAdmin && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Удалить документ?',
                        message: `«${d.originalName || LABEL[d.type]}»`,
                        danger: true,
                        confirmText: 'Удалить',
                      });
                      if (!ok) return;
                      try {
                        await deleteUserDocument(realId, d.id);
                        qc.invalidateQueries({ queryKey });
                        toast('Документ удалён', 'success');
                      } catch (e: any) {
                        toast(e?.response?.data?.message || 'Ошибка', 'error');
                      }
                    }}
                  >Удалить</button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Доступ к данным — только для админа */}
      {isAdmin && <AccessSection userId={realId} userName={user.fullName} />}

      {/* Ежедневные отчёты текущего месяца */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Отчёты этого месяца</h3>
        {dailyReports.length === 0 ? (
          <div style={{ color: 'var(--text-soft)', padding: 16, textAlign: 'center' }}>Отчётов пока нет</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Звонки</th>
                  <th>Встречи</th>
                  <th>Сделки</th>
                  <th>Сумма</th>
                </tr>
              </thead>
              <tbody>
                {dailyReports.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Дата">{new Date(r.date).toLocaleDateString('ru-RU')}</td>
                    <td data-label="Звонки">{r.callsCount ?? 0}</td>
                    <td data-label="Встречи">{r.meetingsCount ?? 0}</td>
                    <td data-label="Сделки">{r.salesCount ?? 0}</td>
                    <td data-label="Сумма">{r.salesAmount ? fmtMoney(r.salesAmount) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

const LABEL: Record<string, string> = {
  PASSPORT: 'Паспорт',
  CONTRACT: 'Контракт',
  DIPLOMA: 'Диплом',
  OTHER: 'Другое',
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'green' | 'red' }) {
  const color = accent === 'green' ? '#15803d' : accent === 'red' ? '#b91c1c' : undefined;
  return (
    <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 500, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function HREditor({ user, userId, onSaved }: { user: FullProfile['user']; userId: string; onSaved: () => void }) {
  const { toast } = useUI();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(user.phone || '');
  const [passportNo, setPassportNo] = useState(user.passportNo || '');
  const [hiredAt, setHiredAt] = useState(user.hiredAt ? user.hiredAt.slice(0, 10) : '');
  const [baseSalary, setBaseSalary] = useState(String(user.baseSalary ?? 0));
  const [hourlyRate, setHourlyRate] = useState(String(user.hourlyRate ?? 0));
  const [bonusPercent, setBonusPercent] = useState(String(user.bonusPercent ?? 0));
  const [kpiTargetPct, setKpiTargetPct] = useState(String(user.kpiTargetPct ?? 1));
  const [kpiAutoStepPct, setKpiAutoStepPct] = useState(String(user.kpiAutoStepPct ?? 0));
  const [kpiMaxPct, setKpiMaxPct] = useState(String(user.kpiMaxPct ?? 3));

  const save = async () => {
    try {
      await updateUserHR(userId, {
        phone: phone || undefined,
        passportNo: passportNo || undefined,
        hiredAt: hiredAt ? new Date(hiredAt).toISOString() : undefined,
        baseSalary: Number(baseSalary) || 0,
        hourlyRate: Number(hourlyRate) || 0,
        bonusPercent: Number(bonusPercent) || 0,
        kpiTargetPct: Number(kpiTargetPct) || 0,
        kpiAutoStepPct: Number(kpiAutoStepPct) || 0,
        kpiMaxPct: Number(kpiMaxPct) || 0,
      });
      toast('Сохранено', 'success');
      setOpen(false);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  if (!open) {
    return (
      <button className="btn btn-sm btn-secondary" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        Изменить
      </button>
    );
  }

  return (
    <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <LabelInput label="Телефон" value={phone} onChange={setPhone} />
        <LabelInput label="Паспорт №" value={passportNo} onChange={setPassportNo} />
        <LabelInput label="Принят (дата)" value={hiredAt} onChange={setHiredAt} type="date" />
        <LabelInput label="Фикс / мес" value={baseSalary} onChange={setBaseSalary} type="number" />
        <LabelInput label="Почасовая" value={hourlyRate} onChange={setHourlyRate} type="number" />
        <LabelInput label="Бонус %" value={bonusPercent} onChange={setBonusPercent} type="number" />
        <LabelInput label="KPI цель %" value={kpiTargetPct} onChange={setKpiTargetPct} type="number" />
        <LabelInput label="Авто-рост KPI / мес (0 = выкл)" value={kpiAutoStepPct} onChange={setKpiAutoStepPct} type="number" />
        <LabelInput label="Потолок KPI %" value={kpiMaxPct} onChange={setKpiMaxPct} type="number" />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-soft)' }}>
        Авто-рост: 1-го числа каждого месяца KPI-цель повышается на указанный шаг, пока не достигнет потолка.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)}>Отмена</button>
        <button className="btn btn-sm btn-primary" onClick={save}>Сохранить</button>
      </div>
    </div>
  );
}

function LabelInput({ label, value, onChange, type = 'text' }: any) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14 }}
      />
    </div>
  );
}

function DocUploader({ userId, onUploaded }: { userId: string; onUploaded: () => void }) {
  const { toast } = useUI();
  const [type, setType] = useState('PASSPORT');
  const [uploading, setUploading] = useState(false);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadUserDocument(userId, file, type);
      toast('Документ загружен', 'success');
      onUploaded();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка загрузки', 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={type} onChange={(e) => setType(e.target.value)} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
        <option value="PASSPORT">Паспорт</option>
        <option value="CONTRACT">Контракт</option>
        <option value="DIPLOMA">Диплом</option>
        <option value="OTHER">Другое</option>
      </select>
      <label className="btn btn-sm btn-secondary" style={{ cursor: uploading ? 'wait' : 'pointer' }}>
        {uploading ? 'Загружаем…' : 'Загрузить'}
        <input type="file" hidden onChange={upload} disabled={uploading} />
      </label>
    </div>
  );
}

function AccessSection({ userId, userName }: { userId: string; userName: string }) {
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [pickUserId, setPickUserId] = useState('');

  const grantsQuery = useQuery({
    queryKey: ['user', userId, 'access'],
    queryFn: async () => {
      const m = await import('../api/userProfile');
      return m.listUserAccess(userId);
    },
  });
  const usersQuery = useQuery({
    queryKey: ['users', 'list'],
    queryFn: async () => {
      const m = await import('../api/users');
      return m.listUsers();
    },
  });
  const grants = grantsQuery.data ?? [];
  const users = (usersQuery.data ?? []).filter(
    (u: any) => u.id !== userId && !grants.some((g) => g.grantedTo.id === u.id),
  );

  const grant = async () => {
    if (!pickUserId) return;
    try {
      const m = await import('../api/userProfile');
      await m.grantUserAccess(userId, pickUserId);
      setPickUserId('');
      qc.invalidateQueries({ queryKey: ['user', userId, 'access'] });
      toast('Доступ выдан', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const revoke = async (granteeId: string) => {
    const ok = await confirm({
      title: 'Отозвать доступ?',
      message: 'Пользователь больше не сможет видеть данные этого сотрудника.',
      danger: true,
      confirmText: 'Отозвать',
    });
    if (!ok) return;
    try {
      const m = await import('../api/userProfile');
      await m.revokeUserAccess(userId, granteeId);
      qc.invalidateQueries({ queryKey: ['user', userId, 'access'] });
      toast('Доступ отозван', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  return (
    <section className="card" style={{ padding: 22, marginBottom: 14 }}>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 6 }}>
        Доступ к данным
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 14 }}>
        Кто (кроме администраторов) может видеть полное досье «{userName}».
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select
          value={pickUserId}
          onChange={(e) => setPickUserId(e.target.value)}
          style={{ flex: '1 1 220px', padding: 9, border: '1px solid var(--border)', borderRadius: 8 }}
        >
          <option value="">— выбери сотрудника —</option>
          {users.map((u: any) => (
            <option key={u.id} value={u.id}>{u.fullName} ({u.role})</option>
          ))}
        </select>
        <button className="btn btn-sm btn-primary" onClick={grant} disabled={!pickUserId}>
          Выдать доступ
        </button>
      </div>
      {grants.length === 0 ? (
        <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>
          Доступ выдан только администраторам
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {grants.map((g) => (
            <div key={g.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8,
            }}>
              <span style={{ fontSize: 14 }}>
                {g.grantedTo.fullName}
                <span style={{ color: 'var(--text-soft)', fontSize: 12, marginLeft: 6 }}>
                  ({g.grantedTo.role})
                </span>
              </span>
              <button className="btn btn-sm btn-danger" onClick={() => revoke(g.grantedTo.id)}>
                Отозвать
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
