import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FullProfile,
  deleteUserDocument,
  deleteMyDocument,
  fmtMinutes,
  fmtMoney,
  getUserFullProfile,
  updateUserHR,
  uploadUserDocument,
  uploadMyDocument,
  updateMyDocument,
  updateUserDocument,
  setUserRoles,
  USER_DOCUMENT_LABEL,
  type UserDocumentType,
} from '../api/userProfile';
import { offerCurrent, offerSign, type CurrentOfferState } from '../api/offers';
import { listCustomRoles, setUserCustomRole, type CustomRole } from '../api/customRoles';
import { useT } from '../lib/i18n';
import { useRoleLabel } from '../lib/labels';
import ScheduleEditor from '../components/ScheduleEditor';
import { useUI } from '../ui/Dialogs';
import { useAuth } from '../store/auth';
import { isElevated, isFounder, displayRoleLabel } from '../lib/roles';

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
  const { t } = useT();
  const meStore = useAuth((s) => s.user);
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
  // Self-view: пользователь смотрит свой профиль (/me или /users/:id своего id).
  // Тогда даём ему те же возможности — загрузить/удалить свой документ,
  // подписать оферту.
  const isSelf = !isAdmin || meStore?.id === user.id;
  const canManageDocs = isAdmin || isSelf;

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">
          {isAdmin ? `ТА · ${displayRoleLabel(user as any).toUpperCase()}` : 'МОЙ ПРОФИЛЬ'}
        </span>
        <h2 className="crm-section-title">{user.fullName}</h2>
      </div>

      {/* HR блок */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>{t('userDetail.section.personal')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Field label={t('userDetail.field.email')} value={user.email} />
          <Field
            label={t('userDetail.field.role')}
            value={(() => {
              // Если есть активная кастомная — это «главная роль» юзера
              // в UI. Дальше отдельно показываем базовые как «доступы».
              const parts: string[] = [];
              const cr = (user as any).customRole;
              if (cr?.name && cr.isActive !== false) parts.push(cr.name);
              const base = [user.role, ...(user.roles || [])]
                .filter((r, i, a) => r && a.indexOf(r) === i)
                .join(', ');
              if (base) parts.push(parts.length ? `(база: ${base})` : base);
              return parts.join(' ') || '—';
            })()}
          />
          <Field label={t('userDetail.field.phone')} value={user.phone || '—'} />
          <Field label={t('userDetail.field.passport')} value={user.passportNo || '—'} />
          <Field label={t('userDetail.field.hiredAt')} value={user.hiredAt ? new Date(user.hiredAt).toLocaleDateString('ru-RU') : '—'} />
          <Field label={t('profile.field.createdAt')} value={new Date(user.createdAt).toLocaleDateString('ru-RU')} />
        </div>
        {isAdmin && <HREditor user={user} userId={realId} onSaved={() => qc.invalidateQueries({ queryKey })} />}
        {isFounder(meStore) && (
          <RolesEditor user={user} userId={realId} onSaved={() => qc.invalidateQueries({ queryKey })} />
        )}
        {isFounder(meStore) && (
          <CustomRoleEditor user={user} userId={realId} onSaved={() => qc.invalidateQueries({ queryKey })} />
        )}
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

      {/* Индивидуальный график работы — FOUNDER задаёт лично для этого сотрудника
          (по ТЗ §3 «изменять график работы менеджеров»). */}
      {isFounder(meStore) && (
        <section className="card" style={{ padding: 22, marginBottom: 14 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>
            Личный график работы
          </h3>
          <ScheduleEditor
            userId={realId}
            hint={`Этот график перекрывает дефолтный для «${user.fullName}». Если день не задан — используется компанийский дефолт из «Настройки → График работы».`}
          />
        </section>
      )}

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

      {/* Оферта — только в self-view (сотрудник подписывает свою). */}
      {!isAdmin && <OfferSection />}

      {/* Документы */}
      <section className="card" style={{ padding: 22, marginBottom: 14 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 12 }}>Документы</h3>
        {canManageDocs && (
          <DocUploader
            userId={realId}
            useSelfApi={!isAdmin}
            onUploaded={() => qc.invalidateQueries({ queryKey })}
          />
        )}
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
                {canManageDocs && (
                  <DocEditButton
                    doc={d}
                    useSelfApi={!isAdmin}
                    userId={realId}
                    onSaved={() => qc.invalidateQueries({ queryKey })}
                  />
                )}
                {canManageDocs && (
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
                        if (isAdmin) {
                          await deleteUserDocument(realId, d.id);
                        } else {
                          await deleteMyDocument(d.id);
                        }
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

// Используем общий словарь из api/userProfile.
const LABEL = USER_DOCUMENT_LABEL;

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
  const { t } = useT();
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
      toast(t('toast.updated'), 'success');
      setOpen(false);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  if (!open) {
    return (
      <button className="btn btn-sm btn-secondary" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
        {t('common.edit')}
      </button>
    );
  }

  return (
    <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <LabelInput label={t('userDetail.field.phone')} value={phone} onChange={setPhone} />
        <LabelInput label={t('userDetail.field.passport')} value={passportNo} onChange={setPassportNo} />
        <LabelInput label={t('userDetail.field.hiredAt')} value={hiredAt} onChange={setHiredAt} type="date" />
        <LabelInput label={t('userDetail.field.baseSalary')} value={baseSalary} onChange={setBaseSalary} type="number" />
        <LabelInput label={t('userDetail.field.hourlyRate')} value={hourlyRate} onChange={setHourlyRate} type="number" />
        <LabelInput label={t('userDetail.field.bonusPercent')} value={bonusPercent} onChange={setBonusPercent} type="number" />
        <LabelInput label={t('userDetail.field.kpiTarget')} value={kpiTargetPct} onChange={setKpiTargetPct} type="number" />
        <LabelInput label={t('userDetail.field.kpiAutoStep')} value={kpiAutoStepPct} onChange={setKpiAutoStepPct} type="number" />
        <LabelInput label={t('userDetail.field.kpiMax')} value={kpiMaxPct} onChange={setKpiMaxPct} type="number" />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        <button className="btn btn-sm btn-primary" onClick={save}>{t('common.save')}</button>
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

function DocUploader({
  userId,
  useSelfApi = false,
  onUploaded,
}: {
  userId: string;
  useSelfApi?: boolean;
  onUploaded: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [type, setType] = useState<UserDocumentType>('PASSPORT');
  const [uploading, setUploading] = useState(false);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      if (useSelfApi) {
        await uploadMyDocument(file, type);
      } else {
        await uploadUserDocument(userId, file, type);
      }
      toast(t('toast.uploaded'), 'success');
      onUploaded();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={type} onChange={(e) => setType(e.target.value as UserDocumentType)} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
        <option value="PASSPORT">{t('userDoc.PASSPORT')}</option>
        <option value="PHOTO">{t('userDoc.PHOTO')}</option>
        <option value="CONTRACT">{t('userDoc.CONTRACT')}</option>
        <option value="DIPLOMA">{t('userDoc.DIPLOMA')}</option>
        <option value="OTHER">{t('userDoc.OTHER')}</option>
      </select>
      <label className="btn btn-sm btn-secondary" style={{ cursor: uploading ? 'wait' : 'pointer' }}>
        {uploading ? t('common.uploading') : t('common.upload')}
        <input type="file" hidden onChange={upload} disabled={uploading} />
      </label>
    </div>
  );
}

function AccessSection({ userId, userName }: { userId: string; userName: string }) {
  const { toast, confirm } = useUI();
  const { t } = useT();
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
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const revoke = async (granteeId: string) => {
    const ok = await confirm({
      title: t('userDetail.access.revoke'),
      message: '',
      danger: true,
      confirmText: t('userDetail.access.revoke'),
    });
    if (!ok) return;
    try {
      const m = await import('../api/userProfile');
      await m.revokeUserAccess(userId, granteeId);
      qc.invalidateQueries({ queryKey: ['user', userId, 'access'] });
      toast(t('toast.updated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <section className="card" style={{ padding: 22, marginBottom: 14 }}>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 6 }}>
        {t('userDetail.access.title')}
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 14 }}>
        {userName}
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select
          value={pickUserId}
          onChange={(e) => setPickUserId(e.target.value)}
          style={{ flex: '1 1 220px', padding: 9, border: '1px solid var(--border)', borderRadius: 8 }}
        >
          <option value="">— {t('common.search')} —</option>
          {users.map((u: any) => (
            <option key={u.id} value={u.id}>{u.fullName} ({u.role})</option>
          ))}
        </select>
        <button className="btn btn-sm btn-primary" onClick={grant} disabled={!pickUserId}>
          {t('userDetail.access.grant')}
        </button>
      </div>
      {grants.length === 0 ? (
        <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>
          {t('common.empty')}
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
                {t('userDetail.access.revoke')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Секция «Оферта» в self-кабинете. Сотрудник видит текст оферты, ставит
 * галку «согласен» и нажимает «Подписать». После подписи — read-only с
 * датой и фразой о согласии. Состояние тянется одним запросом
 * `/offers/current` (там же и сам текст, и signed/signedAt).
 */
function OfferSection() {
  const qc = useQueryClient();
  const { toast } = useUI();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = useQuery<CurrentOfferState>({
    queryKey: ['offers', 'current'],
    queryFn: () => offerCurrent(),
  });
  const data = query.data;

  if (query.isLoading) {
    return <section className="card" style={{ padding: 22, marginBottom: 14 }}>Загружаем оферту…</section>;
  }
  if (!data) return null;

  const onSign = async () => {
    setBusy(true);
    try {
      await offerSign(data.offer.id);
      toast('Оферта подписана', 'success');
      qc.invalidateQueries({ queryKey: ['offers', 'current'] });
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Не удалось подписать', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ padding: 22, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, margin: 0 }}>
          Оферта · v{data.offer.version}
        </h3>
        {data.signed && (
          <span style={{
            fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999,
            background: '#dcfce7', color: '#15803d',
          }}>
            ПОДПИСАНА {data.signedAt ? new Date(data.signedAt).toLocaleDateString('ru-RU') : ''}
          </span>
        )}
      </div>
      <div style={{
        maxHeight: 280,
        overflowY: 'auto',
        padding: 14,
        background: 'var(--bg-soft)',
        border: '1px solid var(--border-soft)',
        borderRadius: 10,
        whiteSpace: 'pre-wrap',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--text)',
      }}>
        {data.offer.content}
      </div>
      {!data.signed && (
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            Я прочитал(а) оферту и согласен(на) с условиями.
          </label>
          <button
            className="btn btn-sm btn-primary"
            onClick={onSign}
            disabled={!agreed || busy}
            style={{ marginLeft: 'auto' }}
          >
            {busy ? 'Подписываем…' : 'Подписать'}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * RolesEditor — FOUNDER задаёт МНОЖЕСТВЕННЫЕ роли сотрудника.
 * Один человек может быть, например, и ADMIN, и ACCOUNTANT. Первая в
 * массиве становится primary (user.role) — она используется для display
 * и legacy-проверок. FOUNDER не редактируется через этот UI (его роль
 * меняется только в seed/CLI).
 */
const ASSIGNABLE_ROLE_VALUES: string[] = ['ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER'];

function RolesEditor({ user, userId, onSaved }: { user: FullProfile['user']; userId: string; onSaved: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const [open, setOpen] = useState(false);
  const initialRoles = (() => {
    const set = new Set<string>();
    if (user.role && user.role !== 'FOUNDER') set.add(user.role);
    for (const r of user.roles || []) if (r !== 'FOUNDER') set.add(r);
    return Array.from(set);
  })();
  const [primary, setPrimary] = useState(initialRoles[0] || 'SALES_MANAGER');
  const [extra, setExtra] = useState<Set<string>>(new Set(initialRoles.slice(1)));
  const [saving, setSaving] = useState(false);

  // Учёт мульти-ролей: если FOUNDER в primary ИЛИ в roles[] — target
  // считается FOUNDER'ом. Backend уже multi-role aware (isFounder()),
  // фронт раньше был primary-only — UI показывал «edit roles» для
  // secondary-FOUNDER, потом backend отбивал — несогласованно.
  const isFounderTarget = user.role === 'FOUNDER' || (user.roles || []).includes('FOUNDER' as any);

  const toggleExtra = (role: string) => {
    if (role === primary) return; // primary не может быть в extra
    setExtra((cur) => {
      const next = new Set(cur);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      // primary первая в массиве, потом extras
      const roles = [primary, ...Array.from(extra).filter((r) => r !== primary)];
      await setUserRoles(userId, roles);
      toast(t('toast.updated'), 'success');
      setOpen(false);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (isFounderTarget) {
    return (
      <div style={{
        marginTop: 12,
        padding: 10,
        background: '#fef3c7',
        border: '1px solid #fde68a',
        borderRadius: 8,
        fontSize: 12,
        color: '#92400e',
      }}>
        {t('userDetail.roles.founderLocked')}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        className="btn btn-sm btn-secondary"
        style={{ marginTop: 12, marginLeft: 8 }}
        onClick={() => setOpen(true)}
      >
        {t('userDetail.roles.edit')}
      </button>
    );
  }

  return (
    <div style={{
      marginTop: 16,
      padding: 14,
      border: '1px solid var(--primary)',
      borderRadius: 10,
      background: 'var(--bg-soft)',
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.12em',
        color: 'var(--primary-dark)',
        marginBottom: 8,
      }}>
        FOUNDER · ROLES
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 4 }}>
          {t('userDetail.field.role')}:
        </label>
        <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
          {ASSIGNABLE_ROLE_VALUES.map((v) => (
            <option key={v} value={v}>{roleLabel(v as any)}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 6 }}>
          {t('userDetail.field.roles')}:
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ASSIGNABLE_ROLE_VALUES
            .filter((v) => v !== primary)
            .map((v) => {
              const on = extra.has(v);
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleExtra(v)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 999,
                    border: '1.5px solid',
                    borderColor: on ? 'var(--primary)' : 'var(--border)',
                    background: on ? 'var(--primary-light)' : 'white',
                    color: on ? 'var(--primary-dark)' : 'var(--text-soft)',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {on ? '✓ ' : '+ '}{roleLabel(v as any)}
                </button>
              );
            })}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * CustomRoleEditor — FOUNDER привязывает кастомную роль (созданную в
 * /settings → Роли и доступы) к сотруднику. Это ОРТОГОНАЛЬНО базовым 5
 * ролям: если custom-роль задана, у юзера активируются её permissions
 * (см. lib/permissions.ts и Sidebar). Если убрать — сотрудник работает
 * только по своим базовым ролям.
 */
function CustomRoleEditor({
  user, userId, onSaved,
}: {
  user: FullProfile['user'];
  userId: string;
  onSaved: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>((user as any).customRoleId || '');
  const [saving, setSaving] = useState(false);
  const rolesQuery = useQuery({
    queryKey: ['custom-roles'],
    queryFn: listCustomRoles,
    enabled: open,
  });
  const roles = rolesQuery.data ?? [];

  const isFounderTarget = user.role === 'FOUNDER' || (user.roles || []).includes('FOUNDER' as any);
  if (isFounderTarget) return null;

  const currentName = (user as any).customRole?.name as string | undefined;

  const save = async () => {
    setSaving(true);
    try {
      await setUserCustomRole(userId, selected || null);
      toast(t('toast.updated'), 'success');
      setOpen(false);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div style={{ marginTop: 12 }}>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => setOpen(true)}
          style={{ marginLeft: 8 }}
        >
          {currentName ? `${t('userDetail.field.customRole')}: ${currentName}` : t('userDetail.field.customRole')}
        </button>
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 16,
      padding: 14,
      border: '1px solid var(--primary)',
      borderRadius: 10,
      background: 'var(--bg-soft)',
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.12em',
        color: 'var(--primary-dark)',
        marginBottom: 8,
      }}>
        FOUNDER · CUSTOM ROLE
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-soft)', marginBottom: 4 }}>
          {t('userDetail.field.customRole')}:
        </label>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={rolesQuery.isLoading}>
          <option value="">— {t('managerBar.notAssigned')} —</option>
          {roles.filter((r: CustomRole) => r.isActive).map((r: CustomRole) => (
            <option key={r.id} value={r.id}>{r.name} ({r.permissions.length})</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * Кнопка-карандашик у документа → разворачивает inline-редактор типа и
 * комментария. Закрывает «U» в CRUD по ТЗ §1.
 */
function DocEditButton({
  doc,
  userId,
  useSelfApi,
  onSaved,
}: {
  doc: { id: string; type: UserDocumentType; comment?: string | null };
  userId: string;
  useSelfApi: boolean;
  onSaved: () => void;
}) {
  const { toast } = useUI();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<UserDocumentType>(doc.type);
  const [comment, setComment] = useState(doc.comment || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      if (useSelfApi) {
        await updateMyDocument(doc.id, { type, comment });
      } else {
        await updateUserDocument(userId, doc.id, { type, comment });
      }
      toast('Документ обновлён', 'success');
      setOpen(false);
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)} title="Изменить тип / комментарий">
        Изменить
      </button>
    );
  }

  return (
    <div style={{
      position: 'absolute',
      right: 24,
      marginTop: 8,
      background: 'white',
      padding: 12,
      border: '1px solid var(--border)',
      borderRadius: 10,
      boxShadow: '0 8px 22px rgba(0,0,0,0.1)',
      zIndex: 100,
      minWidth: 280,
    }}>
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label>Тип</label>
        <select value={type} onChange={(e) => setType(e.target.value as UserDocumentType)}>
          <option value="PASSPORT">Паспорт</option>
          <option value="PHOTO">Фотография</option>
          <option value="CONTRACT">Контракт</option>
          <option value="DIPLOMA">Диплом</option>
          <option value="OFFER">Оферта</option>
          <option value="OTHER">Прочее</option>
        </select>
      </div>
      <div className="form-group" style={{ marginBottom: 8 }}>
        <label>Комментарий</label>
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="—" />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)} disabled={saving}>Отмена</button>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
