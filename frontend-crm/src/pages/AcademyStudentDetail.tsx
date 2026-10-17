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
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { isTeacherOnly } from '../lib/roles';
import { tjDateInput, tjFormatDate, tjToday } from '../lib/tjTime';
import { STUDENT_LOGIN_URL } from '../lib/landingUrl';
import {
  FLAGS_FOR_DECISION,
  getAcademyStudent,
  reinstate,
  removeFlag,
  resetAcademyPassword,
  updateAcademyStudent,
  type AcademyFlag,
  type AcademyStudentCard,
} from '../api/academy';
import { listGroups } from '../api/studyGroups';
import ScoreChart from '../components/academy/ScoreChart';
import FlagModal from '../components/academy/FlagModal';
import DecisionModal from '../components/academy/DecisionModal';
import { AcademyStatusBadge, Avatar, FlagDots, TotalBadge, shortDate, weekRange } from '../components/academy/academyUi';

/**
 * Карточка ученика академии: контакты, статус, группы с итогами недель и
 * графиком, красные флаги, комментарии учителей. Руководство здесь же
 * решает «отчислить / оставить», возвращает отчисленного, правит данные и
 * выдаёт новый пароль ученику академии. Паспорт, документы, оплаты и сделки
 * сюда не выводятся — это карточка учёбы, а не клиента.
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
              {s.age !== null && <span>{s.age} {t('academy.years')}</span>}
              {s.phones.map((p) => (
                <a key={p} href={`tel:${p.replace(/[^+\d]/g, '')}`}><Icon name="call" size={14} /> {p}</a>
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
          {s.canManage && s.academyOnly && (
            <>
              <button className="btn btn-secondary" onClick={() => setEditing(true)} data-testid="astudent-edit">
                <Icon name="edit" size={16} /> {t('common.edit')}
              </button>
              <button className="btn btn-secondary" onClick={onPassword} disabled={passwordMut.isPending} data-testid="astudent-password">
                <Icon name="key" size={16} /> {t('academy.student.newPassword')}
              </button>
            </>
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
          <b>{s.summary.attendancePct !== null ? `${s.summary.attendancePct}%` : '—'}</b>
          <small>{s.summary.attended} / {s.summary.held}</small>
        </div>
        <div className="card acad-tile">
          <span>{t('academy.flags.title')}</span>
          <FlagDots count={s.flagsActive} testId="astudent-flags" />
          <small>{s.flagsActive} / {FLAGS_FOR_DECISION}</small>
        </div>
        <div className="card acad-tile">
          <span>{t('academy.stats.finalWeeks')}</span>
          <b>{s.summary.finalWeeks}</b>
        </div>
      </div>

      {s.groups.length === 0 ? (
        <div className="card acad-card-pad acad-hint">{t('academy.student.noGroups')}</div>
      ) : (
        s.groups.map((m) => (
          <div key={m.membershipId} className="card acad-card-pad acad-student-group" data-testid={`astudent-group-${m.group.id}`}>
            <div className="acad-student-group-head">
              <div>
                {teacherOnly && m.group.teacherId !== me?.id ? (
                  <b>{m.group.name}</b>
                ) : (
                  <Link to={`/groups/${m.group.id}`} className="acad-link"><b>{m.group.name}</b></Link>
                )}
                <div className="acad-hint">
                  {m.group.teacher?.fullName || t('groups.noTeacher')} · {t('groups.joinedAt')} {tjFormatDate(m.joinedAt)}
                  {m.leftAt && ` · ${t(m.leftReason === 'EXPELLED' ? 'academy.left.expelled' : 'academy.left.removed')} ${tjFormatDate(m.leftAt)}`}
                </div>
              </div>
              <div className="acad-student-group-sum">
                <span>{t('academy.col.avg')}: <TotalBadge total={m.summary.avg} /></span>
                <span>{t('academy.col.attendance')}: <b>{m.summary.attendancePct !== null ? `${m.summary.attendancePct}%` : '—'}</b></span>
              </div>
            </div>
            {m.weeks.some((w) => w.final) && (
              <ScoreChart
                series={[{
                  id: m.membershipId,
                  name: s.fullName,
                  points: m.weeks.filter((w) => w.final).map((w) => ({ x: w.index, y: w.total })),
                  avg: m.summary.avg,
                }]}
                weeks={m.weeks.filter((w) => w.held > 0 || w.final).map((w) => ({ x: w.index, label: `${t('academy.week')} ${w.index}` }))}
                height={220}
              />
            )}
            {m.weeks.length === 0 ? (
              <div className="acad-hint">{t('academy.student.noWeeks')}</div>
            ) : (
              <div className="table-wrap">
                <table className="table acad-weeks-table">
                  <thead>
                    <tr>
                      <th>{t('academy.col.week')}</th>
                      <th>{t('academy.col.dates')}</th>
                      <th>{t('academy.col.attended')}</th>
                      <th>{t('academy.col.lessonPoints')}</th>
                      <th>{t('academy.journal.bonus')}</th>
                      <th>{t('academy.journal.exam')}</th>
                      <th>{t('academy.journal.total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...m.weeks].reverse().map((w) => (
                      <tr key={w.key}>
                        <td><b>{w.index}</b></td>
                        <td data-label={t('academy.col.dates')}>{weekRange(w.from, w.to)}</td>
                        <td data-label={t('academy.col.attended')}>{w.held ? `${w.attended} / ${w.held}` : '—'}</td>
                        <td data-label={t('academy.col.lessonPoints')}>{w.held ? w.lessonPoints : '—'}</td>
                        <td data-label={t('academy.journal.bonus')}>{w.bonus ?? '—'}</td>
                        <td data-label={t('academy.journal.exam')}>{w.exam ?? '—'}</td>
                        <td data-label={t('academy.journal.total')}><TotalBadge total={w.held || w.final ? w.total : null} final={w.final} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
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
                  {c.score ? <span className="acad-comment-score">{c.score}</span> : null}
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
  const [email, setEmail] = useState(card.email || '');
  const [birthday, setBirthday] = useState(card.birthday ? tjDateInput(card.birthday) : '');
  const [comment, setComment] = useState(card.comment || '');

  const mut = useMutation({
    mutationFn: () =>
      updateAcademyStudent(card.id, {
        fullName: fullName.trim(),
        phone,
        email: email.trim(),
        birthday: birthday || '',
        comment,
      }),
    onSuccess: (res) => {
      toast(t('toast.saved'), 'success');
      onSaved(res);
      onClose();
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  return (
    <FormModal open title={`${t('common.edit')} — ${card.fullName}`} onClose={onClose} busy={mut.isPending} width={600} testId="astudent-edit-modal">
      <div className="form-group">
        <label>{t('common.fullName')} *</label>
        <input className="crm-input" value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)} />
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
      <div className="form-group">
        <label>{t('app.field.birthday')}</label>
        <CrmDatePicker value={birthday} onChange={setBirthday} max={tjToday()} />
      </div>
      <div className="form-group">
        <label>{t('common.comment')}</label>
        <textarea className="crm-textarea" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={mut.isPending}>{t('common.cancel')}</button>
        <button className="btn btn-primary" onClick={() => mut.mutate()} disabled={mut.isPending || fullName.trim().length < 2 || !email.trim()}>
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
