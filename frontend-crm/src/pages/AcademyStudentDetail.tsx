import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import Icon from '../Icon';
import Loading from '../components/Loading';
import BackButton from '../components/BackButton';
import FormModal from '../components/FormModal';
import CrmSelect from '../components/CrmSelect';
import CrmDatePicker from '../components/CrmDatePicker';
import PhoneInput from '../components/PhoneInput';
import CredRow from '../components/CredRow';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { isTeacherOnly } from '../lib/roles';
import { tjDateInput, tjFormatDate, tjFormatDateTime, tjToday } from '../lib/tjTime';
import { STUDENT_LOGIN_URL } from '../lib/landingUrl';
import { phoneRule } from '../utils/validators';
import {
  FLAGS_FOR_DECISION,
  getAcademyStudent,
  listLevels,
  reinstate,
  removeFlag,
  resetAcademyPassword,
  updateAcademyStudent,
  type AcademyFlag,
  type AcademyStudentCard,
  type StudentDiary,
} from '../api/academy';
import { listGroups } from '../api/studyGroups';
import ScoreChart from '../components/academy/ScoreChart';
import FlagModal from '../components/academy/FlagModal';
import DecisionModal from '../components/academy/DecisionModal';
import {
  AcademyStatusBadge,
  Avatar,
  FlagDots,
  LevelBadge,
  TotalBadge,
  leftKey,
  pct,
  shortDate,
  shortKey,
  tjWeekdayOf,
  weekdayKey,
} from '../components/academy/academyUi';

/**
 * Карточка ученика академии: контакты (и телефоны родителей), уровень с
 * историей, статус, группы с листами уроков и графиком, дневник ДЗ, красные
 * флаги, комментарии учителей. Руководство здесь же решает «отчислить /
 * оставить» и возвращает отчисленного. Данные ученика академии правят
 * руководство и его учитель; у студента агентства учитель меняет только
 * уровень. Паспорт, документы, оплаты и сделки сюда не выводятся — это
 * карточка учёбы, а не клиента.
 */
export default function AcademyStudentDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const teacherOnly = isTeacherOnly(me as any);

  const query = useQuery({
    queryKey: keys.academy.student(id || ''),
    queryFn: () => getAcademyStudent(id!),
    enabled: !!id,
    retry: false,
  });
  const s = query.data;

  const [flagOpen, setFlagOpen] = useState(false);
  const [decision, setDecision] = useState<'EXPEL' | 'KEEP' | null>(null);
  const [editing, setEditing] = useState(false);
  const [levelOnly, setLevelOnly] = useState(false);
  const [reinstating, setReinstating] = useState(false);
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);

  const refresh = (card?: AcademyStudentCard) => {
    if (card) qc.setQueryData(keys.academy.student(card.id), card);
    qc.invalidateQueries({ queryKey: keys.academy.all });
    qc.invalidateQueries({ queryKey: keys.groups.all });
  };

  const passwordMut = useMutation({
    mutationFn: () => resetAcademyPassword(id!),
    onSuccess: (r) => setCreds({ email: r.email, password: r.password }),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const removeFlagMut = useMutation({
    mutationFn: (flagId: string) => removeFlag(flagId),
    onSuccess: () => {
      toast(t('academy.flags.removed'), 'success');
      refresh();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  if (!id) return null;
  if (query.isLoading) return <Loading />;
  if (query.isError || !s) {
    return (
      <>
        <BackButton fallback="/academy/students" />
        <div className="card" style={{ padding: 28 }}>
          <h2>{t('academy.student.notFound')}</h2>
        </div>
      </>
    );
  }

  const onPassword = async () => {
    const ok = await confirm({
      title: t('academy.student.newPassword'),
      message: t('academy.student.newPasswordHint'),
      confirmText: t('academy.student.newPassword'),
    });
    if (ok) passwordMut.mutate();
  };

  const onRemoveFlag = async (f: AcademyFlag) => {
    const ok = await confirm({
      title: t('academy.flags.removeConfirm'),
      message: f.reason,
      danger: true,
      confirmText: t('academy.flags.remove'),
    });
    if (ok) removeFlagMut.mutate(f.id);
  };

  const activeFlags = s.flags.filter((f) => !f.removedAt);
  const removedFlags = s.flags.filter((f) => !!f.removedAt);
  const levelHistory = s.levelHistory ?? [];
  const phoneLabels = s.phoneLabels ?? [];
  // Подпись номера: «Отец» / «Мать» — на языке интерфейса, прочие — как записаны.
  const labelOf = (i: number) => {
    if (i === 0) return null;
    const l = (phoneLabels[i] || '').trim();
    if (/^(отец|падар|father)$/i.test(l)) return t('academy.student.father');
    if (/^(мать|модар|mother)$/i.test(l)) return t('academy.student.mother');
    return l || null;
  };

  return (
    <>
      <BackButton fallback="/academy/students" />

      <motion.div className="card acad-student-head" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="acad-student-top">
          <Avatar name={s.fullName} photoUrl={s.photoUrl} size={56} />
          <div className="acad-student-main">
            <div className="acad-eyebrow">{s.academyOnly ? t('academy.tag.academyOnly') : t('academy.tag.agency')}</div>
            <h2 className="acad-student-name" data-testid="astudent-name">{s.fullName}</h2>
            <div className="acad-student-facts">
              <AcademyStatusBadge status={s.status} testId="astudent-status" />
              <LevelBadge level={s.level} testId="astudent-level" />
              {s.age !== null && <span>{s.age} {t('academy.years')}</span>}
              {s.phones.map((p, i) => (
                <a key={`${p}-${i}`} href={`tel:${p.replace(/[^+\d]/g, '')}`} data-testid={i === 0 ? 'astudent-phone' : undefined}>
                  <Icon name="call" size={14} /> {p}
                  {labelOf(i) && <span className="acad-phone-label"> · {labelOf(i)}</span>}
                </a>
              ))}
              {s.email && <a href={`mailto:${s.email}`}><Icon name="mail" size={14} /> {s.email}</a>}
            </div>
          </div>
        </div>
        <div className="acad-student-actions">
          {s.canFlag && (
            <button className="btn btn-secondary" onClick={() => setFlagOpen(true)} data-testid="astudent-flag">
              <Icon name="flag" size={16} /> {t('academy.flags.give')}
            </button>
          )}
          {s.canEdit && (
            <button className="btn btn-secondary" onClick={() => setEditing(true)} data-testid="astudent-edit">
              <Icon name="edit" size={16} /> {t('common.edit')}
            </button>
          )}
          {!s.canEdit && s.canEditLevel && (
            <button className="btn btn-secondary" onClick={() => setLevelOnly(true)} data-testid="astudent-level-edit">
              <Icon name="stairs" size={16} /> {t('academy.level.change')}
            </button>
          )}
          {s.canResetPassword && (
            <button className="btn btn-secondary" onClick={onPassword} disabled={passwordMut.isPending} data-testid="astudent-password">
              <Icon name="key" size={16} /> {t('academy.student.newPassword')}
            </button>
          )}
          {!s.academyOnly && !teacherOnly && (
            <Link className="btn btn-secondary" to={`/students/${s.id}`}>
              <Icon name="open_in_new" size={16} /> {t('academy.student.crmCard')}
            </Link>
          )}
          {s.canManage && s.status !== 'EXPELLED' && (
            <button className="btn btn-danger" onClick={() => setDecision('EXPEL')} data-testid="astudent-expel">
              <Icon name="person_remove" size={16} /> {t('academy.decision.expel')}
            </button>
          )}
        </div>
        {s.comment && <div className="acad-group-desc">{s.comment}</div>}
      </motion.div>

      {s.status === 'PENDING' && (
        <div className="card acad-decision-card" data-testid="astudent-pending">
          <Icon name="flag" size={24} />
          <div className="acad-decision-text">
            <b>{t('academy.pending.title').replace('{n}', String(s.flagsActive))}</b>
            <span>{s.canManage ? t('academy.pending.hintManager') : t('academy.pending.hintTeacher')}</span>
          </div>
          {s.canManage && (
            <div className="acad-decision-actions">
              <button className="btn btn-secondary" onClick={() => setDecision('KEEP')} data-testid="astudent-keep">
                <Icon name="verified_user" size={16} /> {t('academy.decision.keep')}
              </button>
              <button className="btn btn-danger" onClick={() => setDecision('EXPEL')} data-testid="astudent-expel-pending">
                <Icon name="person_remove" size={16} /> {t('academy.decision.expel')}
              </button>
            </div>
          )}
        </div>
      )}

      {s.expelled && (
        <div className="card acad-expelled-card" data-testid="astudent-expelled">
          <Icon name="block" size={24} />
          <div className="acad-decision-text">
            <b>{t('academy.expelled.title').replace('{date}', tjFormatDate(s.expelled.at))}</b>
            <span>
              {s.expelled.note ? `${t('academy.decision.reason')}: ${s.expelled.note}` : t('academy.expelled.noReason')}
              {s.expelled.by ? ` · ${s.expelled.by.fullName}` : ''}
            </span>
          </div>
          {s.canManage && (
            <button className="btn btn-primary" onClick={() => setReinstating(true)} data-testid="astudent-reinstate">
              <Icon name="undo" size={16} /> {t('academy.expelled.reinstate')}
            </button>
          )}
        </div>
      )}

      <div className="acad-tiles">
        <div className="card acad-tile">
          <span>{t('academy.col.avg')}</span>
          <TotalBadge total={s.summary.avg} testId="astudent-avg" />
        </div>
        <div className="card acad-tile">
          <span>{t('academy.col.attendance')}</span>
          <b>{pct(s.summary.attendancePct)}</b>
          <small>{s.summary.attended} / {s.summary.held}</small>
        </div>
        <div className="card acad-tile">
          <span>{t('academy.flags.title')}</span>
          <FlagDots count={s.flagsActive} testId="astudent-flags" />
          <small>{s.flagsActive} / {FLAGS_FOR_DECISION}</small>
        </div>
        <div className="card acad-tile">
          <span>{t('academy.col.level')}</span>
          <LevelBadge level={s.level} />
        </div>
      </div>

      {s.groups.length === 0 ? (
        <div className="card acad-card-pad acad-hint">{t('academy.student.noGroups')}</div>
      ) : (
        s.groups.map((m) => <GroupBlock key={m.membershipId} m={m} card={s} teacherOnly={teacherOnly} meId={me?.id} />)
      )}

      <DiaryBlock diary={s.diary ?? []} />

      {levelHistory.length > 0 && (
        <div className="card acad-card-pad" data-testid="astudent-level-history">
          <h3 className="acad-section-title">{t('academy.level.history')}</h3>
          <div className="acad-level-history">
            {levelHistory.map((h) => (
              <div key={h.id} className="acad-level-change">
                <span className="acad-level-change-names">
                  {h.fromName ? <span className="acad-level is-empty">{h.fromName}</span> : null}
                  {h.fromName && <Icon name="arrow_forward" size={15} />}
                  <span className="acad-level">{h.toName || t('academy.level.none')}</span>
                </span>
                <span className="acad-hint">
                  {tjFormatDate(h.createdAt)} · {t(`academy.level.reason.${h.reason}`)}
                  {h.group ? ` · ${h.group.name}` : ''}
                  {h.changedBy ? ` · ${h.changedBy.fullName}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card acad-card-pad">
        <h3 className="acad-section-title">
          {t('academy.flags.title')} <span>{activeFlags.length}</span>
        </h3>
        {s.flags.length === 0 ? (
          <div className="acad-hint">{t('academy.flags.none')}</div>
        ) : (
          <div className="acad-flag-list" data-testid="astudent-flag-list">
            {[...activeFlags, ...removedFlags].map((f) => (
              <div key={f.id} className={`acad-flag-item${f.removedAt ? ' is-removed' : ''}`}>
                <Icon name="flag" size={18} />
                <div className="acad-flag-body">
                  <div className="acad-flag-reason">{f.reason}</div>
                  <div className="acad-hint">
                    {tjFormatDate(f.createdAt)}
                    {f.group ? ` · ${f.group.name}` : ''}
                    {f.givenBy ? ` · ${f.givenBy.fullName}` : ''}
                    {f.removedAt &&
                      ` · ${t('academy.flags.removedAt').replace('{date}', tjFormatDate(f.removedAt))}${f.removedBy ? ` (${f.removedBy.fullName})` : ''}${f.removeReason ? `: ${f.removeReason}` : ''}`}
                  </div>
                </div>
                {s.canManage && !f.removedAt && (
                  <button className="btn btn-sm btn-secondary" onClick={() => onRemoveFlag(f)} disabled={removeFlagMut.isPending} data-testid={`flag-remove-${f.id}`}>
                    {t('academy.flags.remove')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card acad-card-pad">
        <h3 className="acad-section-title">{t('academy.student.comments')}</h3>
        {s.comments.length === 0 ? (
          <div className="acad-hint">{t('academy.student.noComments')}</div>
        ) : (
          <div className="acad-comment-list">
            {s.comments.map((c) => (
              <div key={c.sessionId} className="acad-comment-item">
                <div className="acad-comment-meta">
                  <b>{shortDate(c.date)}</b> · {c.group.name}
                  {c.topic ? ` · ${c.topic}` : ''}
                  {c.mark && c.mark.total !== null && <TotalBadge total={c.mark.total} />}
                </div>
                <div className="acad-comment-text">{c.comment}</div>
                {c.author && <div className="acad-hint">{c.author.fullName}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {flagOpen && (
          <FlagModal
            student={{ id: s.id, fullName: s.fullName, flags: s.flagsActive }}
            groups={s.flagGroups}
            onClose={() => setFlagOpen(false)}
            onDone={() => refresh()}
          />
        )}
        {decision && (
          <DecisionModal student={s} action={decision} onClose={() => setDecision(null)} onDone={(card) => refresh(card)} />
        )}
        {editing && <EditStudentModal card={s} onClose={() => setEditing(false)} onSaved={(card) => refresh(card)} />}
        {levelOnly && <LevelModal card={s} onClose={() => setLevelOnly(false)} onSaved={(card) => refresh(card)} />}
        {reinstating && <ReinstateModal card={s} onClose={() => setReinstating(false)} onDone={(card) => refresh(card)} />}
        {creds && (
          <FormModal open title={t('academy.student.newPassword')} onClose={() => setCreds(null)} dirty={false} width={500} testId="astudent-creds">
            <div className="acad-note" style={{ marginBottom: 12 }}>
              <Icon name="info" size={18} />
              <span>{t('studentDetail.password.oneTime')}</span>
            </div>
            <div className="creds-box">
              <CredRow label={t('userDetail.field.email')} value={creds.email} />
              <CredRow label={t('login.password')} value={creds.password} />
              <CredRow label={t('login.title')} value={STUDENT_LOGIN_URL.replace('https://', '')} small />
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" onClick={() => setCreds(null)}>{t('common.done')}</button>
            </div>
          </FormModal>
        )}
      </AnimatePresence>
    </>
  );
}

type GroupRow = AcademyStudentCard['groups'][number];

/** Группа ученика: сводка, график «Итого по неделям» и уроки листа (свежие сверху). */
function GroupBlock({ m, card, teacherOnly, meId }: { m: GroupRow; card: AcademyStudentCard; teacherOnly: boolean; meId?: string }) {
  const { t } = useT();
  const lessons = [...(m.lessons ?? [])].reverse();
  const weeks = (m.weeks ?? []).filter((w) => typeof w.value === 'number');
  const sort = useTableSort(
    lessons,
    [
      { key: 'number', label: t('academy.journal.no'), type: 'number', value: (l) => l.number },
      { key: 'date', label: t('academy.col.date'), type: 'date', value: (l) => l.startsAt },
      { key: 'topic', label: t('academy.col.topic'), value: (l) => l.topic },
      { key: 'att', label: t('academy.journal.col.attendance'), value: (l) => (l.mark?.attendance ? t(`academy.att.${l.mark.attendance}`) : null) },
      { key: 'hw', label: t('academy.journal.col.homework'), type: 'number', value: (l) => l.mark?.homeworkPct },
      { key: 'vocab', label: t('academy.journal.col.vocabulary'), type: 'number', value: (l) => l.mark?.vocabularyPct },
      { key: 'perf', label: t('academy.journal.col.performance'), type: 'number', value: (l) => l.mark?.performancePct },
      { key: 'total', label: t('academy.journal.col.total'), type: 'number', value: (l) => l.mark?.total },
    ],
    { persist: false },
  );
  return (
    <div className="card acad-card-pad acad-student-group" data-testid={`astudent-group-${m.group.id}`}>
      <div className="acad-student-group-head">
        <div>
          {teacherOnly && m.group.teacherId !== meId ? (
            <b>{m.group.name}</b>
          ) : (
            <Link to={`/groups/${m.group.id}`} className="acad-link"><b>{m.group.name}</b></Link>
          )}
          <div className="acad-hint">
            {m.group.teacher?.fullName || t('groups.noTeacher')} · {t('groups.joinedAt')} {tjFormatDate(m.joinedAt)}
            {m.leftAt && ` · ${t(leftKey(m.leftReason))} ${tjFormatDate(m.leftAt)}`}
          </div>
        </div>
        <div className="acad-student-group-sum">
          <span>{t('academy.col.avg')}: <TotalBadge total={m.summary.avg} /></span>
          <span>{t('academy.col.attendance')}: <b>{pct(m.summary.attendancePct)}</b></span>
        </div>
      </div>
      {weeks.length > 0 && (
        <ScoreChart
          series={[{ id: m.membershipId, name: card.fullName, points: weeks.map((w) => ({ x: w.index, y: w.value })), avg: m.summary.avg }]}
          weeks={weeks.map((w) => ({ x: w.index, label: `${t('academy.week')} ${w.index}` }))}
          height={220}
        />
      )}
      {lessons.length === 0 ? (
        <div className="acad-hint">{t('academy.student.noWeeks')}</div>
      ) : (
        <div className="table-wrap">
          <SortSelect sort={sort} />
          <table className="table acad-lessons-table">
            <thead>
              <tr>{sort.columns.map((c) => <SortTh key={c.key} sort={sort} col={c.key} />)}</tr>
            </thead>
            <tbody>
              {sort.sorted.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.number}</b></td>
                  <td data-label={t('academy.col.date')}>
                    {t(`weekday.short.${weekdayKey(tjWeekdayOf(l.startsAt))}`)} {shortDate(l.startsAt)}
                  </td>
                  <td data-label={t('academy.col.topic')}>{l.topic || '—'}</td>
                  <td data-label={t('academy.journal.col.attendance')}>
                    {l.mark?.attendance ? (
                      <span className={`acad-att-tag is-${l.mark.attendance.toLowerCase()}`}>{t(`academy.att.${l.mark.attendance}`)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label={t('academy.journal.col.homework')}>{pct(l.mark?.homeworkPct)}</td>
                  <td data-label={t('academy.journal.col.vocabulary')}>{pct(l.mark?.vocabularyPct)}</td>
                  <td data-label={t('academy.journal.col.performance')}>{pct(l.mark?.performancePct)}</td>
                  <td data-label={t('academy.journal.col.total')}><TotalBadge total={l.mark?.total ?? null} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Дневник ДЗ ученика: по каждому заданию — дни с урока по срок и что он писал. */
function DiaryBlock({ diary }: { diary: StudentDiary[] }) {
  const { t } = useT();
  const today = tjToday();
  return (
    <div className="card acad-card-pad" data-testid="astudent-diary">
      <h3 className="acad-section-title">
        {t('academy.diary.title')} <span>{diary.length}</span>
      </h3>
      {diary.length === 0 ? (
        <div className="acad-hint">{t('academy.diary.empty')}</div>
      ) : (
        <div className="acad-sdiary-list">
          {diary.map((d) => {
            const written = d.days.filter((day) => d.logs[day]);
            return (
              <div key={d.sessionId} className="acad-sdiary" data-testid={`astudent-diary-${d.sessionId}`}>
                <div className="acad-sdiary-head">
                  <b>{shortDate(d.startsAt)} · {d.topic || t('classes.noTopic')}</b>
                  <span className="acad-hint">
                    {d.group.name}
                    {d.homeworkDue ? ` · ${t('academy.diary.due').replace('{date}', tjFormatDate(d.homeworkDue))}` : ''}
                    {' · '}
                    {t('academy.diary.entries').replace('{n}', `${written.length}/${d.days.length}`)}
                  </span>
                </div>
                {d.homework && <div className="acad-sdiary-hw">{d.homework}</div>}
                <div className="acad-sdiary-days">
                  {d.days.map((day) => {
                    const state = d.logs[day] ? 'is-done' : day < today ? 'is-missed' : day === today ? 'is-today' : 'is-future';
                    return (
                      <span key={day} className={`acad-sdiary-day ${state}`} title={d.logs[day]?.text}>
                        {shortKey(day)}
                      </span>
                    );
                  })}
                </div>
                {written.length > 0 && (
                  <div className="acad-sdiary-entries">
                    {written.map((day) => (
                      <div key={day} className="acad-sdiary-entry">
                        <span className="acad-sdiary-entry-day">{shortKey(day)}</span>
                        <span className="acad-sdiary-entry-text">{d.logs[day].text}</span>
                        <span className="acad-hint">{tjFormatDateTime(d.logs[day].createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EditStudentModal({
  card,
  onClose,
  onSaved,
}: {
  card: AcademyStudentCard;
  onClose: () => void;
  onSaved: (card: AcademyStudentCard) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [fullName, setFullName] = useState(card.fullName);
  const [phone, setPhone] = useState(card.phones[0] || '');
  const [fatherPhone, setFatherPhone] = useState(card.fatherPhone || '');
  const [motherPhone, setMotherPhone] = useState(card.motherPhone || '');
  const [email, setEmail] = useState(card.email || '');
  const [birthday, setBirthday] = useState(card.birthday ? tjDateInput(card.birthday) : '');
  const [levelId, setLevelId] = useState(card.level?.id || '');
  const [comment, setComment] = useState(card.comment || '');
  const levels = useQuery({ queryKey: keys.academy.levels(), queryFn: listLevels });

  const fatherErr = phoneRule(t('academy.newStudent.errParentPhone'))(fatherPhone);
  const motherErr = phoneRule(t('academy.newStudent.errParentPhone'))(motherPhone);

  const mut = useMutation({
    mutationFn: () =>
      updateAcademyStudent(card.id, {
        fullName: fullName.trim(),
        phone,
        fatherPhone,
        motherPhone,
        email: email.trim(),
        birthday: birthday || '',
        comment,
        levelId,
      }),
    onSuccess: (res) => {
      toast(t('toast.saved'), 'success');
      onSaved(res);
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <FormModal open title={`${t('common.edit')} — ${card.fullName}`} onClose={onClose} busy={mut.isPending} width={640} testId="astudent-edit-modal">
      <div className="form-group">
        <label>{t('common.fullName')} *</label>
        <input className="crm-input" value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)} data-testid="ae-name" />
      </div>
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('common.phone')} *</label>
          <PhoneInput value={phone} onChange={setPhone} />
        </div>
        <div className="form-group">
          <label>{t('userDetail.field.email')} *</label>
          <input className="crm-input" type="email" value={email} maxLength={160} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>
            {t('academy.newStudent.fatherPhone')} <span className="acad-optional">· {t('academy.newStudent.optional')}</span>
          </label>
          <PhoneInput value={fatherPhone} onChange={setFatherPhone} error={!!fatherErr} />
          {fatherErr && <div className="form-error-text">{fatherErr}</div>}
        </div>
        <div className="form-group">
          <label>
            {t('academy.newStudent.motherPhone')} <span className="acad-optional">· {t('academy.newStudent.optional')}</span>
          </label>
          <PhoneInput value={motherPhone} onChange={setMotherPhone} error={!!motherErr} />
          {motherErr && <div className="form-error-text">{motherErr}</div>}
        </div>
      </div>
      <div className="form-grid-2 acad-form-grid">
        <div className="form-group">
          <label>{t('academy.col.level')}</label>
          <CrmSelect className="crm-select" value={levelId} onChange={(e) => setLevelId(e.target.value)} data-testid="ae-level">
            <option value="">{t('academy.level.none')}</option>
            {(levels.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </CrmSelect>
        </div>
        <div className="form-group">
          <label>{t('app.field.birthday')}</label>
          <CrmDatePicker value={birthday} onChange={setBirthday} max={tjToday()} />
        </div>
      </div>
      <div className="form-group">
        <label>{t('common.comment')}</label>
        <textarea className="crm-textarea" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>{t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={() => mut.mutate()}
          disabled={mut.isPending || fullName.trim().length < 2 || !email.trim() || !!fatherErr || !!motherErr}
          data-testid="ae-save"
        >
          {mut.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </FormModal>
  );
}

/** Только уровень — у студента агентства (его данные правят в карточке CRM). */
function LevelModal({
  card,
  onClose,
  onSaved,
}: {
  card: AcademyStudentCard;
  onClose: () => void;
  onSaved: (card: AcademyStudentCard) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const [levelId, setLevelId] = useState(card.level?.id || '');
  const levels = useQuery({ queryKey: keys.academy.levels(), queryFn: listLevels });
  const mut = useMutation({
    mutationFn: () => updateAcademyStudent(card.id, { levelId }),
    onSuccess: (res) => {
      toast(t('toast.saved'), 'success');
      onSaved(res);
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });
  return (
    <FormModal open title={`${t('academy.level.change')} — ${card.fullName}`} onClose={onClose} busy={mut.isPending} width={460} testId="astudent-level-modal">
      <div className="form-group">
        <label>{t('academy.col.level')}</label>
        <CrmSelect className="crm-select" value={levelId} onChange={(e) => setLevelId(e.target.value)} data-testid="al-level">
          <option value="">{t('academy.level.none')}</option>
          {(levels.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </CrmSelect>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="al-save">
          {mut.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </FormModal>
  );
}

function ReinstateModal({
  card,
  onClose,
  onDone,
}: {
  card: AcademyStudentCard;
  onClose: () => void;
  onDone: (card: AcademyStudentCard) => void;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const lastGroup = card.groups[card.groups.length - 1]?.group;
  const [groupId, setGroupId] = useState(lastGroup && lastGroup.status !== 'ARCHIVED' ? lastGroup.id : '');
  const groups = useQuery({ queryKey: keys.groups.list({ status: 'ACTIVE' }), queryFn: () => listGroups({ status: 'ACTIVE' }) });

  const mut = useMutation({
    mutationFn: () => reinstate(card.id, groupId || undefined),
    onSuccess: (res) => {
      toast(t('academy.expelled.reinstated'), 'success');
      onDone(res);
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <FormModal open title={`${t('academy.expelled.reinstate')} — ${card.fullName}`} onClose={onClose} busy={mut.isPending} width={520} testId="reinstate-modal">
      <div className="acad-note" style={{ marginBottom: 14 }}>
        <Icon name="info" size={18} />
        <span>{t('academy.expelled.reinstateHint')}</span>
      </div>
      <div className="form-group">
        <label>{t('classes.field.group')}</label>
        <CrmSelect className="crm-select" value={groupId} onChange={(e) => setGroupId(e.target.value)} data-testid="reinstate-group">
          <option value="">{t('academy.newStudent.noGroup')}</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </CrmSelect>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="reinstate-submit">
          {mut.isPending ? t('common.saving') : t('academy.expelled.reinstate')}
        </button>
      </div>
    </FormModal>
  );
}
