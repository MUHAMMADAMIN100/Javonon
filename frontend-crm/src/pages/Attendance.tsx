import { useEffect, useState } from 'react';
import Pagination from '../components/Pagination';
import CrmSelect from '../components/CrmSelect';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useRealtimeEvent } from '../realtime';
import { listAttendance } from '../api/attendance';
import { listUsers } from '../api/users';
import { tjFormatTime, tjFormatDate, tjToday } from '../lib/tjTime';
import { useT } from '../lib/i18n';
import CrmDatePicker from '../components/CrmDatePicker';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';

function fmtTime(iso: string | null): string {
  // По ТЗ — время в зоне Asia/Dushanbe, а не браузера. Если FOUNDER
  // открывает CRM из Москвы, без явной timeZone время clockIn съезжает
  // на час.
  return iso ? tjFormatTime(iso) : '—';
}

function fmtDate(iso: string): string {
  return tjFormatDate(iso);
}

/** Минуты от полуночи по Душанбе — колонки времени сортируем по часам, а не по дате. */
function minutesOfDay(iso: string | null): number | null {
  if (!iso) return null;
  const [h, m] = tjFormatTime(iso).split(':').map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

/** Строк на странице таблицы посещаемости. */
const ATTENDANCE_PAGE_SIZE = 10;

export default function Attendance() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  if (!isFounder(me)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.founderOnly')}</div>;
  }

  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /** Страница таблицы — по 10 строк. */
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [userId, from, to]);

  const qc = useQueryClient();
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: () => listUsers() });
  const users = usersQuery.data || [];

  const query = useQuery({
    queryKey: ['attendance', userId, from, to],
    queryFn: () => listAttendance({
      userId: userId || undefined,
      from: from || undefined,
      // input type=date даёт «YYYY-MM-DD» → new Date() парсит как 00:00 UTC.
      // Без +T23:59:59 «по: сегодня» отрезало бы все clockIn'ы после
      // полуночи UTC — пустая таблица.
      to: to ? `${to}T23:59:59` : undefined,
      take: 200,
    }),
  });
  const items = query.data || [];

  const sort = useTableSort(items, [
    { key: 'employee', label: t('attendance.col.employee'), value: (e) => e.user.fullName },
    { key: 'date', label: t('attendance.col.date'), type: 'date', value: (e) => e.clockIn },
    { key: 'in', label: t('attendance.col.in'), type: 'number', value: (e) => minutesOfDay(e.clockIn) },
    { key: 'lunchOut', label: t('attendance.col.lunchOut'), type: 'number', value: (e) => minutesOfDay(e.lunchOut) },
    { key: 'lunchIn', label: t('attendance.col.lunchIn'), type: 'number', value: (e) => minutesOfDay(e.lunchIn) },
    { key: 'out', label: t('attendance.col.out'), type: 'number', value: (e) => minutesOfDay(e.clockOut) },
    { key: 'late', label: t('attendance.col.late'), type: 'number', value: (e) => e.lateMinutes },
  ]);

  // По ТЗ — когда сотрудник начал работу/обед/закончил день — таблица
  // у основателя обновляется мгновенно без релоада.
  useRealtimeEvent('attendance:updated', () => {
    qc.invalidateQueries({ queryKey: ['attendance'] });
  });

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.hr')} · {t('workday.tab.attendance')}</span>
        <h2 className="crm-section-title">{t('attendance.title')}</h2>
      </div>

      <motion.div className="card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ minWidth: 200, margin: 0 }}>
            <label>{t('attendance.col.employee')}</label>
            <CrmSelect className="crm-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </CrmSelect>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>{t('common.from')}</label>
            <CrmDatePicker className="crm-input" value={from} onChange={(v) => setFrom(v)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>{t('common.to')}</label>
            <CrmDatePicker className="crm-input" value={to} onChange={(v) => setTo(v)} />
          </div>
          {(() => {
            // YYYY-MM-DD по Asia/Dushanbe — а не браузера/UTC. Без этого
            // у пользователя в РФ кнопка «Сегодня» в 23:30 МСК = 01:30
            // ТJT уже завтрашний день, но юзер видит свой московский день
            // → фильтр показывает «завтрашние» записи (пусто).
            const today = tjToday();
            const isToday = from === today && to === today;
            return (
              <button
                className={`btn ${isToday ? 'btn-primary' : 'btn-secondary'} filter-height-btn`}
                data-testid="attendance-today"
                onClick={() => {
                  setFrom(today);
                  setTo(today);
                }}
              >
                {t('common.today')}
              </button>
            );
          })()}
          {(userId || from || to) && (
            <button className="btn btn-secondary filter-height-btn" onClick={() => { setUserId(''); setFrom(''); setTo(''); }}>
              {t('filter.reset')}
            </button>
          )}
        </div>
      </motion.div>

      {query.isLoading ? (
        <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
          {t('attendance.empty')}
        </div>
      ) : (
        <>
        <SortSelect sort={sort} />
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 920 }}>
            <thead>
              <tr>
                <SortTh sort={sort} col="employee" />
                <SortTh sort={sort} col="date" />
                <SortTh sort={sort} col="in" />
                <SortTh sort={sort} col="lunchOut" />
                <SortTh sort={sort} col="lunchIn" />
                <SortTh sort={sort} col="out" />
                <SortTh sort={sort} col="late" style={{ textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.slice((page - 1) * ATTENDANCE_PAGE_SIZE, page * ATTENDANCE_PAGE_SIZE).map((e) => (
                <tr key={e.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{e.user.fullName}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>{e.user.email}</div>
                  </td>
                  <td>{fmtDate(e.clockIn)}</td>
                  <td>{fmtTime(e.clockIn)}</td>
                  <td>{fmtTime(e.lunchOut)}</td>
                  <td>{fmtTime(e.lunchIn)}</td>
                  <td>{fmtTime(e.clockOut)}</td>
                  <td style={{ textAlign: 'right', color: e.lateMinutes > 0 ? '#ef4444' : 'var(--text-soft)' }}>
                    {e.lateMinutes > 0 ? `+${e.lateMinutes} ${t('common.minutes')}` : '—'}
                    {e.lateExcuseStatus === 'APPROVED' && (
                      <span style={{ fontSize: 10, marginLeft: 4, color: '#10b981' }}>· {t('attendance.approved')}</span>
                    )}
                    {e.lateExcuseStatus === 'PENDING' && (
                      <span style={{ fontSize: 10, marginLeft: 4, color: '#fbbf24' }}>· {t('attendance.review')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          total={sort.sorted.length}
          pageSize={ATTENDANCE_PAGE_SIZE}
          onChange={setPage}
        />
        </>
      )}
    </>
  );
}
