import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import CrmSelect from '../components/CrmSelect';
import { createPortal } from 'react-dom';
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
import { updateUser } from '../api/users';
import { useT } from '../lib/i18n';
import { useRoleLabel } from '../lib/labels';
import CrmDatePicker from '../components/CrmDatePicker';
import { useUI } from '../ui/Dialogs';
import { useAuth } from '../store/auth';
import { isElevated, isFounder, displayRoleLabel } from '../lib/roles';
import { bandRangeLabel } from '../lib/bonusBands';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import BackButton from '../components/BackButton';
import Icon from '../Icon';
import PresenceDot from '../components/PresenceDot';
import { agoText, presenceText, usePresence } from '../lib/usePresence';
import { tjFormatDateTime } from '../lib/tjTime';
import ProfileMonthDetails, { type MonthTile } from '../components/ProfileMonthDetails';

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
  // Свой профиль — /me/full; чужой — /me/profile/:id (права проверяет
  // сервер). Раньше без прав руководства по адресу чужого сотрудника
  // молча открывался СВОЙ профиль.
  const own = userId === 'me' || userId === meStore?.id;
  const queryKey = own ? ['me', 'full'] : ['user', userId, 'full'];

  const { data, isLoading, error } = useQuery<FullProfile>({
    queryKey,
    queryFn: async () => {
      const mod = await import('../api/userProfile');
      return own ? mod.getMyFullProfile() : mod.getUserFullProfile(userId);
    },
    retry: false,
  });

  // «В сети» / «последний вход» — только основатель, на карточке сотрудника.
  const presence = usePresence(isAdmin && isFounder(meStore));

  /** Какая форма правки открыта под «Личными данными / Оплатой». */
  const [editing, setEditing] = useState<'personal' | 'pay' | 'roles' | 'custom' | null>(null);
  const toggleEdit = (k: 'personal' | 'pay' | 'roles' | 'custom') => setEditing((cur) => (cur === k ? null : k));
  const closeEdit = () => setEditing(null);
  const roleLabel = useRoleLabel();

  /** Какая плитка «Текущий месяц» открыта в окне «подробнее». */
  const [monthTile, setMonthTile] = useState<MonthTile | null>(null);
  const tileProps = (tile: MonthTile) => ({
    role: 'button' as const,
    tabIndex: 0,
    title: t('details.clickHint'),
    'data-testid': `tile-${tile}`,
    onClick: () => setMonthTile(tile),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setMonthTile(tile);
      }
    },
  });

  const penaltyReason = (reason: string) => {
    const key = `penalty.reason.${reason}`;
    return t(key) !== key ? t(key) : reason;
  };
  const salarySort = useTableSort(
    data?.salary?.records ?? [],
    [
      { key: 'period', label: t('common.period'), type: 'date', value: (r) => r.periodStart },
      { key: 'hours', label: t('profile.month.hours'), type: 'number', value: (r) => r.workedMinutes },
      { key: 'base', label: t('settings.salary.field.base'), type: 'number', value: (r) => r.baseAmount },
      { key: 'sales', label: t('profile.month.sales'), type: 'number', value: (r) => r.salesAmount },
      { key: 'bonus', label: t('partners.tab.commissions'), type: 'number', value: (r) => r.bonusAmount },
      { key: 'kpi', label: 'KPI', type: 'number', value: (r) => r.kpiBonus },
      { key: 'penalties', label: t('profile.month.penalties'), type: 'number', value: (r) => r.penalties },
      { key: 'net', label: t('finance.paymentForPay'), type: 'number', value: (r) => r.netAmount },
      {
        key: 'status',
        label: t('common.status'),
        value: (r) => (r.status === 'PAID' ? t('partners.payout.status.PAID') : t('massmail.status.DRAFT')),
      },
    ],
    { param: 'sortSalary' },
  );
  const penaltiesSort = useTableSort(
    data?.penalties.list ?? [],
    [
      { key: 'date', label: t('profile.penaltyCol.date'), type: 'date', value: (p) => p.date },
      { key: 'reason', label: t('profile.penaltyCol.reason'), value: (p) => penaltyReason(p.reason) },
      { key: 'amount', label: t('profile.penaltyCol.amount'), type: 'number', value: (p) => p.amount },
      // Применённые — первыми при «по убыванию».
      { key: 'applied', label: t('profile.penaltyCol.applied'), type: 'number', value: (p) => (p.applied ? 1 : 0) },
    ],
    { param: 'sortPenalties' },
  );
  const reportsSort = useTableSort(
    data?.dailyReports ?? [],
    [
      { key: 'date', label: t('common.date'), type: 'date', value: (r) => r.date },
      { key: 'calls', label: t('eyebrow.calls'), type: 'number', value: (r) => r.callsCount ?? 0 },
      { key: 'meetings', label: t('eyebrow.meetings'), type: 'number', value: (r) => r.meetingsCount ?? 0 },
      { key: 'deals', label: t('reports.up.dealsClosed'), type: 'number', value: (r) => r.salesCount ?? 0 },
      { key: 'amount', label: t('common.amount'), type: 'number', value: (r) => r.salesAmount || null },
    ],
    { param: 'sortReports' },
  );

  // «Назад» — на карточке сотрудника; «Мой профиль» открывают из меню,
  // возвращаться там некуда.
  const back = userId !== 'me' ? <BackButton fallback="/users" /> : null;

  if (isLoading) return <>{back}<div className="card" style={{ padding: 24 }}>Загружаем…</div></>;
  if (error || !data) {
    // 403 — нет прав на этого сотрудника: показываем причину с сервера.
    const msg = (error as any)?.response?.status === 403 ? (error as any)?.response?.data?.message : null;
    return <>{back}<div className="card" style={{ padding: 24 }} data-testid="profile-error">{msg || 'Не удалось загрузить профиль'}</div></>;
  }

  const { user, salary, penalties, sales, attendance, kpi, documents, dailyReports } = data;
  const realId = user.id;
  // Self-view: пользователь смотрит свой профиль (/me или /users/:id своего id).
  // Тогда даём ему те же возможности — загрузить/удалить свой документ,
  // подписать оферту.
  const isSelf = !isAdmin || meStore?.id === user.id;
  // Права — как раньше: ФИО/email и роли меняет основатель, кадры и оплату — админ.
  const canEditNameEmail = isFounder(meStore);
  const canEditRoles = isFounder(meStore);
  const isFounderTarget = user.role === 'FOUNDER' || (user.roles || []).includes('FOUNDER' as any);
  const onEditSaved = () => {
    setEditing(null);
    qc.invalidateQueries({ queryKey });
  };
  // Роль словами: своя (кастомная) роль, в скобках — базовые.
  const roleText = (() => {
    const cr = (user as any).customRole;
    const base = [user.role, ...(user.roles || [])]
      .filter((r, i, a) => r && a.indexOf(r) === i)
      .map((r) => roleLabel(r as any))
      .join(', ');
    if (cr?.name && cr.isActive !== false) return base ? `${cr.name} (${base})` : cr.name;
    return base || '—';
  })();
  const canManageDocs = isAdmin || isSelf;

  return (
    <>
      {back}
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">
          {isAdmin ? `${t('eyebrow.team')} · ${displayRoleLabel(user as any).toUpperCase()}` : t('eyebrow.profile')}
        </span>
        <h2 className="crm-section-title">
          {user.fullName}
          {presence.ready && (
            <PresenceDot
              state={presence.byId.get(realId)?.state ?? 'OFFLINE'}
              title={presenceText(presence.byId.get(realId), presence.now, t)}
              size={12}
            />
          )}
        </h2>
      </div>

      {/* Личные данные | Оплата — одна карточка в две колонки, ниже строка
          «Активность» (видит основатель). Кнопка «Изменить» — у заголовка
          своей группы; форма правки раскрывается под данными. */}
      <section className="card profile-section" data-testid="profile-main">
        <div className={`profile-cols${salary ? '' : ' is-single'}`}>
          <div className="profile-group" data-testid="group-personal">
            <div className="profile-group-head">
              <h3 className="profile-h">{t('userDetail.section.personal')}</h3>
              {(canEditNameEmail || isAdmin) && (
                <EditButton active={editing === 'personal'} testId="edit-personal" onClick={() => toggleEdit('personal')} />
              )}
            </div>
            <div className="profile-grid">
              <Field label={t('userDetail.field.email')} value={user.email} />
              <Field
                label={t('userDetail.field.role')}
                value={roleText}
                extra={canEditRoles && !isFounderTarget ? (
                  <div className="profile-role-actions">
                    <button type="button" className={`profile-link-btn${editing === 'roles' ? ' is-active' : ''}`} onClick={() => toggleEdit('roles')} data-testid="edit-roles">
                      {t('profile.roles')}
                    </button>
                    <button type="button" className={`profile-link-btn${editing === 'custom' ? ' is-active' : ''}`} onClick={() => toggleEdit('custom')} data-testid="edit-custom-role">
                      {t('userDetail.field.customRole')}
                    </button>
                  </div>
                ) : undefined}
              />
              <Field label={t('userDetail.field.phone')} value={user.phone || '—'} />
              <Field label={t('userDetail.field.passport')} value={user.passportNo || '—'} />
              <Field label={t('userDetail.field.hiredAt')} value={user.hiredAt ? new Date(user.hiredAt).toLocaleDateString('ru-RU') : '—'} />
              <Field label={t('profile.field.createdAt')} value={new Date(user.createdAt).toLocaleDateString('ru-RU')} />
            </div>
          </div>
          {/* Оплата — только основателю, админу, бухгалтеру (сервер не отдаёт её кастомной роли). */}
          {salary && (
          <div className="profile-group" data-testid="group-pay">
            <div className="profile-group-head">
              <h3 className="profile-h">{t('userDetail.section.salary')}</h3>
              {isAdmin && <EditButton active={editing === 'pay'} testId="edit-pay" onClick={() => toggleEdit('pay')} />}
            </div>
            <div className="profile-grid">
              <Field label={t('userDetail.field.baseSalary')} value={fmtMoney(salary.baseSalary)} />
              <Field label={t('userDetail.field.hourlyRate')} value={fmtMoney(salary.hourlyRate)} />
              {/*
                ДЕЙСТВУЮЩАЯ ставка, а не сырой User.bonusPercent. Последний —
                персональный override, и у всех, кто сидит на сетке, он равен 0:
                менеджер читал в своём досье «Бонус % с продаж: 0%», пока
                учредитель видел 6% на экране Зарплаты. Ниже ещё и откуда
                взялась цифра: полоса + объём за месяц (или «личный процент»).
                Старый бэк без bonusPercentEffective — падаем на прежнее поведение.
              */}
              <Field
                label={t('userDetail.field.bonusPercent')}
                value={`${salary.bonusPercentEffective ?? salary.bonusPercent}%`}
                hint={
                  salary.bonusSource === 'PERSONAL'
                    ? t('userDetail.bonus.personal')
                    : salary.bonusBand
                      ? `${t('userDetail.bonus.fromBand')} · ${bandRangeLabel(salary.bonusBand.minAmount, salary.bonusBand.maxAmount)} · ${t('salary.bonus.volume')} ${fmtMoney(salary.bonusVolume ?? 0)}`
                      : undefined
                }
              />
              <Field label={t('userDetail.field.kpiTarget')} value={`${kpi.targetPct}%`} />
            </div>
          </div>
          )}
        </div>

        {presence.ready && (() => {
          const r = presence.byId.get(realId);
          return (
            <div className="profile-activity" data-testid="group-activity">
              <span className="profile-activity-title">{t('profile.section.activity')}</span>
              <span className={`presence-cell is-${(r?.state ?? 'OFFLINE').toLowerCase()}`} data-testid="profile-presence">
                <PresenceDot state={r?.state ?? 'OFFLINE'} size={8} title="" />
                {presenceText(r, presence.now, t) || t('presence.never')}
                {r?.lastSeenAt && r.state !== 'ONLINE' && (
                  <span className="profile-activity-sub">({tjFormatDateTime(r.lastSeenAt)})</span>
                )}
              </span>
              <span className="profile-activity-item" data-testid="profile-last-login">
                {t('presence.lastLogin')}:{' '}
                <b>{r?.lastLoginAt ? tjFormatDateTime(r.lastLoginAt) : '—'}</b>
                {r?.lastLoginAt && <span className="profile-activity-sub"> · {agoText(r.lastLoginAt, presence.now, t)}</span>}
              </span>
            </div>
          );
        })()}

        {editing && (
          <div className="profile-edit" data-testid={`edit-form-${editing}`}>
            {editing === 'personal' && (
              <PersonalEditor user={user} userId={realId} canNameEmail={canEditNameEmail} canHR={isAdmin} onSaved={onEditSaved} onClose={closeEdit} />
            )}
            {editing === 'pay' && <PayEditor user={user} userId={realId} onSaved={onEditSaved} onClose={closeEdit} />}
            {editing === 'roles' && <RolesEditor user={user} userId={realId} onSaved={onEditSaved} onClose={closeEdit} />}
            {editing === 'custom' && <CustomRoleEditor user={user} userId={realId} onSaved={onEditSaved} onClose={closeEdit} />}
          </div>
        )}
      </section>

      {/* График работы теперь всегда общий для компании — редактируется
          в Настройки → График работы. Индивидуальный ScheduleEditor убран,
          чтобы FOUNDER не мог случайно рассинхронизировать сотрудников. */}

      {/* Текущий месяц — фактика */}
      <section className="card profile-section">
        <h3 className="profile-h">{t('profile.month.current')}</h3>
        <div className="profile-stats">
          <Stat {...tileProps('hours')} label={t('profile.month.hours')} value={fmtMinutes(attendance.workedMinutes)} sub={`${attendance.daysWorked} ${t('profile.month.workDays')}`} />
          <Stat {...tileProps('late')} label={t('profile.month.late')} value={fmtMinutes(attendance.lateMinutes)} accent={attendance.lateMinutes > 0 ? 'red' : 'green'} />
          <Stat {...tileProps('sales')} label={t('profile.month.sales')} value={fmtMoney(sales.monthAmount)} sub={`${sales.monthCount} ${t('profile.month.deals')}${(sales.monthOtherIncome ?? 0) > 0 ? ` · ${t('sales.otherIncome').toLowerCase()} ${fmtMoney(sales.monthOtherIncome!)}` : ''}${otherCurrencies(sales.monthOther)}`} />
          <Stat {...tileProps('leads')} label={t('profile.month.leadsTotal')} value={String(kpi.totalLeadsMonth)} sub={`${kpi.ownClientsMonth} ${t('profile.month.myOwn')}`} />
          <Stat {...tileProps('enrolled')} label={t('profile.month.enrolled')} value={`${kpi.enrolledMonth} / ${kpi.requiredClosed}`} accent={kpi.onTrack ? 'green' : 'red'} sub={`${t('profile.month.required')} ≥${kpi.requiredClosed}`} />
          <Stat {...tileProps('kpi')} label={t('profile.month.kpiPct')} value={`${kpi.achievedPct}%`} accent={kpi.onTrack ? 'green' : 'red'} sub={`${t('profile.month.target')} ${kpi.targetPct}%`} />
          <Stat {...tileProps('penalties')} label={t('profile.month.penalties')} value={fmtMoney(penalties.pendingTotal)} accent="red" />
        </div>
        <ProfileMonthDetails
          tile={monthTile}
          userId={userId}
          userName={user.fullName}
          kpi={kpi}
          onClose={() => setMonthTile(null)}
        />
      </section>

      {salary && (
      <>
      {/* История зарплат */}
      <section className={`card profile-section${salary.records.length === 0 ? ' is-empty' : ''}`}>
        <h3 className="profile-h">{t('profile.salaryHistory')}</h3>
        {salary.records.length === 0 ? (
          <div className="profile-empty">{t('profile.salaryEmpty')}</div>
        ) : (
          <div className="table-wrap">
            <SortSelect sort={salarySort} />
            <table className="table">
              <thead>
                <tr>
                  {salarySort.columns.map((c) => <SortTh key={c.key} sort={salarySort} col={c.key} />)}
                </tr>
              </thead>
              <tbody>
                {salarySort.sorted.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.periodStart).toLocaleDateString('ru-RU')} – {new Date(r.periodEnd).toLocaleDateString('ru-RU')}</td>
                    <td>{fmtMinutes(r.workedMinutes)}</td>
                    <td>{fmtMoney(r.baseAmount, r.currency)}</td>
                    <td>{fmtMoney(r.salesAmount, r.currency)}</td>
                    <td>{fmtMoney(r.bonusAmount, r.currency)}</td>
                    <td>{fmtMoney(r.kpiBonus, r.currency)}</td>
                    <td style={{ color: r.penalties > 0 ? 'var(--danger)' : undefined }}>
                      {fmtMoney(r.penalties, r.currency)}
                    </td>
                    <td><b>{fmtMoney(r.netAmount, r.currency)}</b></td>
                    <td>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                        background: r.status === 'PAID' ? '#dcfce7' : '#fef3c7',
                        color: r.status === 'PAID' ? '#15803d' : '#b45309',
                      }}>{r.status === 'PAID' ? t('partners.payout.status.PAID').toUpperCase() : t('massmail.status.DRAFT').toUpperCase()}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </>
      )}

      {/* Штрафы */}
      <section className={`card profile-section${penalties.list.length === 0 ? ' is-empty' : ''}`}>
        <h3 className="profile-h">{t('profile.month.penalties')}</h3>
        {penalties.list.length === 0 ? (
          <div className="profile-empty">{t('profile.penaltiesEmpty')}</div>
        ) : (
          <div className="table-wrap">
            <SortSelect sort={penaltiesSort} />
            <table className="table">
              <thead>
                <tr>
                  {penaltiesSort.columns.map((c) => <SortTh key={c.key} sort={penaltiesSort} col={c.key} />)}
                </tr>
              </thead>
              <tbody>
                {penaltiesSort.sorted.map((p) => {
                  const reasonLbl = penaltyReason(p.reason);
                  return (
                  <tr key={p.id}>
                    <td>{new Date(p.date).toLocaleDateString('ru-RU')}</td>
                    <td>{reasonLbl}{p.comment ? ` · ${p.comment}` : ''}</td>
                    <td style={{ color: 'var(--danger)' }}>{fmtMoney(p.amount, p.currency)}</td>
                    <td>{p.applied ? '✓' : '—'}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Оферта — только в self-view (сотрудник подписывает свою). */}
      {!isAdmin && <OfferSection />}

      {/* Документы */}
      {/* Документы: без права загрузки и без файлов — одной строкой. */}
      <section className={`card profile-section${documents.length === 0 && !canManageDocs ? ' is-empty' : ''}`}>
        <h3 className="profile-h">{t('userDetail.section.documents')}</h3>
        {canManageDocs && (
          <DocUploader
            userId={realId}
            useSelfApi={!isAdmin}
            onUploaded={() => qc.invalidateQueries({ queryKey })}
          />
        )}
        {documents.length === 0 ? (
          <div className="profile-empty" style={{ marginTop: canManageDocs ? 8 : 0 }}>{t('profile.documentsEmpty')}</div>
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
                <a href={d.url} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">{t('common.open')}</a>
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
                        title: t('common.delete') + '?',
                        message: `«${d.originalName || LABEL[d.type]}»`,
                        danger: true,
                        confirmText: t('common.delete'),
                      });
                      if (!ok) return;
                      try {
                        if (isAdmin) {
                          await deleteUserDocument(realId, d.id);
                        } else {
                          await deleteMyDocument(d.id);
                        }
                        qc.invalidateQueries({ queryKey });
                        toast(t('toast.deleted'), 'success');
                      } catch (e: any) {
                        toast(e?.response?.data?.message || t('toast.error'), 'error');
                      }
                    }}
                  >{t('common.delete')}</button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Доступ к данным — только для админа */}
      {isAdmin && <AccessSection userId={realId} userName={user.fullName} />}

      {/* Ежедневные отчёты текущего месяца */}
      <section className={`card profile-section${dailyReports.length === 0 ? ' is-empty' : ''}`}>
        <h3 className="profile-h">{t('profile.reportsMonth')}</h3>
        {dailyReports.length === 0 ? (
          <div className="profile-empty">{t('profile.reportsEmpty')}</div>
        ) : (
          <div className="table-wrap">
            <SortSelect sort={reportsSort} />
            <table className="table">
              <thead>
                <tr>
                  {reportsSort.columns.map((c) => <SortTh key={c.key} sort={reportsSort} col={c.key} />)}
                </tr>
              </thead>
              <tbody>
                {reportsSort.sorted.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.date).toLocaleDateString('ru-RU')}</td>
                    <td>{r.callsCount ?? 0}</td>
                    <td>{r.meetingsCount ?? 0}</td>
                    <td>{r.salesCount ?? 0}</td>
                    <td>{r.salesAmount ? fmtMoney(r.salesAmount) : '—'}</td>
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

function Field({ label, value, hint, extra }: { label: string; value: React.ReactNode; hint?: string; extra?: React.ReactNode }) {
  return (
    <div className="profile-field">
      <div className="profile-field-label">{label}</div>
      <div className="profile-field-value">{value}</div>
      {hint && <div className="profile-field-hint">{hint}</div>}
      {extra}
    </div>
  );
}

/** Суммы в других валютах подписью: « · + 300 USD». В TJS-сумму они не входят. */
function otherCurrencies(other?: Record<string, number>) {
  const parts = Object.entries(other ?? {})
    .filter(([, v]) => v)
    .map(([c, v]) => `+ ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v)} ${c}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/** «✎ Изменить» у заголовка группы; нажата — форма открыта. */
function EditButton({ active, onClick, testId }: { active: boolean; onClick: () => void; testId: string }) {
  const { t } = useT();
  return (
    <button type="button" className={`profile-edit-btn${active ? ' is-active' : ''}`} onClick={onClick} data-testid={testId} aria-expanded={active}>
      <Icon name={active ? 'close' : 'edit'} size={15} />
      {active ? t('common.cancel') : t('profile.edit')}
    </button>
  );
}

function Stat({ label, value, sub, accent, ...rest }: {
  label: string; value: string; sub?: string; accent?: 'green' | 'red';
} & React.HTMLAttributes<HTMLDivElement>) {
  const color = accent === 'green' ? '#15803d' : accent === 'red' ? '#b91c1c' : undefined;
  return (
    <div
      {...rest}
      className={rest.onClick ? 'profile-tile is-clickable' : undefined}
      style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, minWidth: 0 }}
    >
      <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, color, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/**
 * PersonalInfoEditor — FOUNDER редактирует базовые личные поля
 * сотрудника (ФИО + email). Отдельно от HR-блока, чтобы было видно,
 * что это «менять как FOUNDER переименовывает аккаунт».
 */
/** Форма «Личные данные»: ФИО и email (основатель), телефон, паспорт, дата приёма (админ). */
function PersonalEditor({
  user, userId, canNameEmail, canHR, onSaved, onClose,
}: {
  user: FullProfile['user']; userId: string; canNameEmail: boolean; canHR: boolean; onSaved: () => void; onClose: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [fullName, setFullName] = useState(user.fullName);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone || '');
  const [passportNo, setPassportNo] = useState(user.passportNo || '');
  const [hiredAt, setHiredAt] = useState(user.hiredAt ? user.hiredAt.slice(0, 10) : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (canNameEmail) {
      const trimmedName = fullName.trim();
      const trimmedEmail = email.trim();
      if (!trimmedName || trimmedName.length < 2) {
        toast(t('toast.error'), 'error');
        return;
      }
      if (!trimmedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
        toast(t('toast.error'), 'error');
        return;
      }
      patch.fullName = trimmedName;
      patch.email = trimmedEmail;
    }
    if (canHR) {
      patch.phone = phone || undefined;
      patch.passportNo = passportNo || undefined;
      patch.hiredAt = hiredAt ? new Date(hiredAt).toISOString() : undefined;
    }
    setSaving(true);
    try {
      await updateUserHR(userId, patch as any);
      toast(t('toast.updated'), 'success');
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditForm title={t('userDetail.section.personal')} saving={saving} onSave={save} onCancel={onClose}>
      {canNameEmail && <LabelInput label={t('app.field.fullName')} value={fullName} onChange={setFullName} />}
      {canNameEmail && <LabelInput label={t('userDetail.field.email')} value={email} onChange={setEmail} type="email" />}
      {canHR && <LabelInput label={t('userDetail.field.phone')} value={phone} onChange={setPhone} />}
      {canHR && <LabelInput label={t('userDetail.field.passport')} value={passportNo} onChange={setPassportNo} />}
      {canHR && <LabelInput label={t('userDetail.field.hiredAt')} value={hiredAt} onChange={setHiredAt} type="date" />}
    </EditForm>
  );
}

/** Форма «Оплата»: оклад, почасовая, личный бонус, настройки KPI. */
function PayEditor({ user, userId, onSaved, onClose }: { user: FullProfile['user']; userId: string; onSaved: () => void; onClose: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const [baseSalary, setBaseSalary] = useState(String(user.baseSalary ?? 0));
  const [hourlyRate, setHourlyRate] = useState(String(user.hourlyRate ?? 0));
  const [bonusPercent, setBonusPercent] = useState(String(user.bonusPercent ?? 0));
  const [kpiTargetPct, setKpiTargetPct] = useState(String(user.kpiTargetPct ?? 1));
  const [kpiAutoStepPct, setKpiAutoStepPct] = useState(String(user.kpiAutoStepPct ?? 0));
  const [kpiMaxPct, setKpiMaxPct] = useState(String(user.kpiMaxPct ?? 3));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateUserHR(userId, {
        baseSalary: Number(baseSalary) || 0,
        hourlyRate: Number(hourlyRate) || 0,
        bonusPercent: Number(bonusPercent) || 0,
        kpiTargetPct: Number(kpiTargetPct) || 0,
        kpiAutoStepPct: Number(kpiAutoStepPct) || 0,
        kpiMaxPct: Number(kpiMaxPct) || 0,
      });
      toast(t('toast.updated'), 'success');
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditForm title={t('userDetail.section.salary')} saving={saving} onSave={save} onCancel={onClose}>
      <LabelInput label={t('userDetail.field.baseSalary')} value={baseSalary} onChange={setBaseSalary} type="number" />
      <LabelInput label={t('userDetail.field.hourlyRate')} value={hourlyRate} onChange={setHourlyRate} type="number" />
      <LabelInput label={t('userDetail.field.bonusPercentPersonal')} value={bonusPercent} onChange={setBonusPercent} type="number" />
      <LabelInput label={t('userDetail.field.kpiTarget')} value={kpiTargetPct} onChange={setKpiTargetPct} type="number" />
      <LabelInput label={t('userDetail.field.kpiAutoStep')} value={kpiAutoStepPct} onChange={setKpiAutoStepPct} type="number" />
      <LabelInput label={t('userDetail.field.kpiMax')} value={kpiMaxPct} onChange={setKpiMaxPct} type="number" />
    </EditForm>
  );
}

/** Общая рамка формы правки: заголовок, поля сеткой, «Отмена / Сохранить». */
function EditForm({ title, saving, onSave, onCancel, children }: {
  title: string; saving: boolean; onSave: () => void; onCancel: () => void; children: React.ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="profile-edit-form">
      <div className="profile-edit-title">{title}</div>
      <div className="profile-edit-grid">{children}</div>
      <div className="profile-edit-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onSave} disabled={saving} data-testid="edit-save">
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

function LabelInput({ label, value, onChange, type = 'text' }: any) {
  return (
    <div className="profile-edit-field">
      <span className="profile-field-label">{label}</span>
      {type === 'date' ? (
        <CrmDatePicker
          className="crm-input"
          value={value}
          onChange={(v) => onChange(v)}
          style={{ width: '100%' }}
        />
      ) : (
        <input
          className="crm-input"
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: '100%' }}
        />
      )}
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
      {/* Ширина по содержимому: в строке с кнопкой «Загрузить» растянутый
          на весь экран список оставлял пустоту в тысячу пикселей. */}
      <CrmSelect className="crm-select field-compact" value={type} onChange={(e) => setType(e.target.value as UserDocumentType)}>
        <option value="PASSPORT">{t('userDoc.PASSPORT')}</option>
        <option value="PHOTO">{t('userDoc.PHOTO')}</option>
        <option value="CONTRACT">{t('userDoc.CONTRACT')}</option>
        <option value="DIPLOMA">{t('userDoc.DIPLOMA')}</option>
        <option value="OTHER">{t('userDoc.OTHER')}</option>
      </CrmSelect>
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
    <section className="card profile-section">
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, marginBottom: 6 }}>
        {t('userDetail.access.title')}
      </h3>
      <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 14 }}>
        {userName}
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <CrmSelect
          className="crm-select"
          value={pickUserId}
          onChange={(e) => setPickUserId(e.target.value)}
          style={{ flex: '1 1 220px' }}
        >
          <option value="">— {t('common.search')} —</option>
          {users.map((u: any) => (
            <option key={u.id} value={u.id}>{u.fullName} ({u.role})</option>
          ))}
        </CrmSelect>
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
  const { t } = useT();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = useQuery<CurrentOfferState>({
    queryKey: ['offers', 'current'],
    queryFn: () => offerCurrent(),
  });
  const data = query.data;

  if (query.isLoading) {
    return <section className="card profile-section">{t('common.loading')}</section>;
  }
  if (!data) return null;

  const onSign = async () => {
    setBusy(true);
    try {
      await offerSign(data.offer.id);
      toast(t('toast.updated'), 'success');
      qc.invalidateQueries({ queryKey: ['offers', 'current'] });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card profile-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, margin: 0 }}>
          {t('userDetail.section.offer')} · v{data.offer.version}
        </h3>
        {data.signed && (
          <span style={{
            fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 999,
            background: '#dcfce7', color: '#15803d',
          }}>
            {t('offer.signed').toUpperCase()} {data.signedAt ? new Date(data.signedAt).toLocaleDateString('ru-RU') : ''}
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
          <label className="crm-checkbox-label" style={{ fontSize: 13 }}>
            <input className="crm-checkbox" type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {t('offer.agreeCheckbox')}
          </label>
          <button
            className="btn btn-sm btn-primary"
            onClick={onSign}
            disabled={!agreed || busy}
            style={{ marginLeft: 'auto' }}
          >
            {busy ? t('common.saving') : t('offer.sign')}
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

function RolesEditor({ user, userId, onSaved, onClose }: { user: FullProfile['user']; userId: string; onSaved: () => void; onClose: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const roleLabel = useRoleLabel();
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
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Роли основателя не меняются (кнопки для него не показываются).
  if (isFounderTarget) return null;

  return (
    <div className="profile-edit-form">
      <div className="profile-edit-title">{t('profile.roles')}</div>
      <div style={{ marginBottom: 12, maxWidth: 360 }}>
        <label className="profile-field-label" style={{ display: 'block', marginBottom: 4 }}>
          {t('userDetail.field.role')}
        </label>
        <CrmSelect className="crm-select" value={primary} onChange={(e) => setPrimary(e.target.value)}>
          {ASSIGNABLE_ROLE_VALUES.map((v) => (
            <option key={v} value={v}>{roleLabel(v as any)}</option>
          ))}
        </CrmSelect>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="profile-field-label" style={{ display: 'block', marginBottom: 6 }}>
          {t('userDetail.field.roles')}
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
                    borderColor: on ? 'var(--primary)' : 'var(--input-border)',
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

      <div className="profile-edit-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving} data-testid="edit-save">
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
  user, userId, onSaved, onClose,
}: {
  user: FullProfile['user'];
  userId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [selected, setSelected] = useState<string>((user as any).customRoleId || '');
  const [saving, setSaving] = useState(false);
  const rolesQuery = useQuery({
    queryKey: ['custom-roles'],
    queryFn: listCustomRoles,
  });
  const roles = rolesQuery.data ?? [];

  const isFounderTarget = user.role === 'FOUNDER' || (user.roles || []).includes('FOUNDER' as any);
  if (isFounderTarget) return null;

  const save = async () => {
    setSaving(true);
    try {
      await setUserCustomRole(userId, selected || null);
      toast(t('toast.updated'), 'success');
      onSaved();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-edit-form">
      <div className="profile-edit-title">{t('userDetail.field.customRole')}</div>
      <div style={{ marginBottom: 12, maxWidth: 360 }}>
        <CrmSelect className="crm-select" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={rolesQuery.isLoading}>
          <option value="">— {t('managerBar.notAssigned')} —</option>
          {roles.filter((r: CustomRole) => r.isActive).map((r: CustomRole) => (
            <option key={r.id} value={r.id}>{r.name} ({r.permissions.length})</option>
          ))}
        </CrmSelect>
      </div>
      <div className="profile-edit-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving} data-testid="edit-save">
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

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const POPOVER_WIDTH = 280;
  const POPOVER_MAX_HEIGHT = 260;
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const close = useCallback(() => setOpen(false), []);

  const computeCoords = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Right-align the popover to the trigger, then clamp inside the viewport.
    const desiredLeft = rect.right - POPOVER_WIDTH;
    const left = Math.min(
      Math.max(8, desiredLeft),
      Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flipUp = spaceBelow < POPOVER_MAX_HEIGHT && spaceAbove > spaceBelow;
    const top = flipUp
      ? Math.max(8, rect.top - POPOVER_MAX_HEIGHT - 4)
      : rect.bottom + 4;
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computeCoords();
  }, [open, computeCoords]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => close();
    const onResize = () => close();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedTrigger = triggerRef.current && triggerRef.current.contains(target);
      const clickedPopover = popoverRef.current && popoverRef.current.contains(target);
      if (!clickedTrigger && !clickedPopover) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

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

  return (
    <>
      <button
        ref={triggerRef}
        className="btn btn-sm btn-secondary"
        onClick={() => setOpen((o) => !o)}
        title="Изменить тип / комментарий"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Изменить
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            width: POPOVER_WIDTH,
            background: 'white',
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 22px rgba(0,0,0,0.1)',
            zIndex: 5000,
          }}
        >
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label>Тип</label>
            <CrmSelect className="crm-select" value={type} onChange={(e) => setType(e.target.value as UserDocumentType)}>
              <option value="PASSPORT">Паспорт</option>
              <option value="PHOTO">Фотография</option>
              <option value="CONTRACT">Контракт</option>
              <option value="DIPLOMA">Диплом</option>
              <option value="OFFER">Оферта</option>
              <option value="OTHER">Прочее</option>
            </CrmSelect>
          </div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label>Комментарий</label>
            <input className="crm-input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="—" />
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)} disabled={saving}>Отмена</button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
