import { useMemo, useState } from 'react';
import { roleCan } from '../../lib/permissions';
import { useAuth } from '../../store/auth';
import { AnimatePresence } from 'framer-motion';
import Icon from '../../Icon';
import { useT } from '../../lib/i18n';
import { absFileUrl, useFileToken } from '../../lib/fileUrl';
import { tjFormatDate, tjFormatTime } from '../../lib/tjTime';
import ClassSessionModal from '../ClassSessionModal';
import ScheduleTemplateModal from './ScheduleTemplateModal';
import HomeworkDiaryModal from './HomeworkDiaryModal';
import { fileSize, materialIcon, shortDate, tjWeekdayOf, weekdayKey } from './academyUi';
import type { ClassSession, StudyGroupDetail } from '../../api/studyGroups';

const STATUS_CLASS: Record<string, string> = {
  SCHEDULED: 'badge badge-info',
  DONE: 'badge badge-success',
  CANCELLED: 'badge badge-gray',
};

const PAGE = 8;

/**
 * Уроки группы: ближайшие и прошедшие занятия с темой, ДЗ и материалами.
 * Учитель и руководство добавляют занятия по шаблону или по одному и
 * открывают урок, чтобы задать тему, ДЗ, срок и прикрепить файлы. У урока
 * с ДЗ — «Дневник ДЗ»: что ученики писали по дням до срока.
 */
export default function LessonsTab({
  group,
  meId,
  onChanged,
}: {
  group: StudyGroupDetail;
  meId?: string;
  onChanged: () => void;
}) {
  const { t } = useT();
  useFileToken();
  const me = useAuth((s) => s.user);
  const [modal, setModal] = useState<{ session?: ClassSession | null } | null>(null);
  const [template, setTemplate] = useState(false);
  const [diaryFor, setDiaryFor] = useState<string | null>(null);
  const [upcomingLimit, setUpcomingLimit] = useState(PAGE);
  const [pastLimit, setPastLimit] = useState(PAGE);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const list = group.sessions ?? [];
    return {
      upcoming: list.filter((s) => new Date(s.endsAt).getTime() >= now),
      past: list.filter((s) => new Date(s.endsAt).getTime() < now).reverse(),
    };
  }, [group.sessions]);

  const canRun = group.access.run;
  const active = group.status === 'ACTIVE';
  // Подменный учитель открывает свои уроки (тема, ДЗ, материалы).
  // (Сотруднику с ролью — с «Ведением».)
  const canOpen = (s: ClassSession) => canRun || (roleCan(me, 'groups:write') && !!meId && s.teacherId === meId);

  return (
    <div className="acad-lessons" data-testid="lessons">
      {canRun && active && (
        <div className="acad-lessons-toolbar">
          <button className="btn btn-primary btn-sm" onClick={() => setTemplate(true)} data-testid="lessons-template">
            <Icon name="event_repeat" size={16} /> {t('academy.lessons.addByTemplate')}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setModal({})} data-testid="lessons-new">
            <Icon name="add" size={16} /> {t('classes.newSession')}
          </button>
        </div>
      )}

      {group.sessions.length === 0 ? (
        <div className="acad-empty">
          <Icon name="event_note" size={40} />
          <div>{t('academy.lessons.empty')}</div>
        </div>
      ) : (
        <>
          <h3 className="acad-section-title">
            {t('academy.lessons.upcoming')} <span>{upcoming.length}</span>
          </h3>
          {upcoming.length === 0 ? (
            <div className="acad-hint">{t('academy.lessons.noUpcoming')}</div>
          ) : (
            <div className="acad-lesson-list">
              {upcoming.slice(0, upcomingLimit).map((s) => (
                <LessonCard
                  key={s.id}
                  s={s}
                  onOpen={canOpen(s) ? () => setModal({ session: s }) : undefined}
                  onDiary={canOpen(s) ? () => setDiaryFor(s.id) : undefined}
                />
              ))}
              {upcoming.length > upcomingLimit && (
                <button className="btn btn-secondary btn-sm acad-more" onClick={() => setUpcomingLimit((n) => n + PAGE * 2)}>
                  {t('academy.lessons.showMore')} ({upcoming.length - upcomingLimit})
                </button>
              )}
            </div>
          )}

          {past.length > 0 && (
            <>
              <h3 className="acad-section-title">
                {t('classes.pastSessions')} <span>{past.length}</span>
              </h3>
              <div className="acad-lesson-list">
                {past.slice(0, pastLimit).map((s) => (
                  <LessonCard
                    key={s.id}
                    s={s}
                    dim
                    onOpen={canOpen(s) ? () => setModal({ session: s }) : undefined}
                    onDiary={canOpen(s) ? () => setDiaryFor(s.id) : undefined}
                  />
                ))}
                {past.length > pastLimit && (
                  <button className="btn btn-secondary btn-sm acad-more" onClick={() => setPastLimit((n) => n + PAGE * 2)}>
                    {t('academy.lessons.showMore')} ({past.length - pastLimit})
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      <AnimatePresence>
        {modal && (
          <ClassSessionModal
            groupId={group.id}
            groupTeacherId={group.teacherId}
            session={modal.session ? { ...modal.session, group: { id: group.id, name: group.name, teacherId: group.teacherId } } : null}
            onClose={() => setModal(null)}
            onSaved={onChanged}
          />
        )}
        {template && <ScheduleTemplateModal groupId={group.id} onClose={() => setTemplate(false)} onDone={onChanged} />}
        {diaryFor && <HomeworkDiaryModal sessionId={diaryFor} onClose={() => setDiaryFor(null)} />}
      </AnimatePresence>
    </div>
  );
}

function LessonCard({
  s,
  onOpen,
  onDiary,
  dim,
}: {
  s: ClassSession;
  onOpen?: () => void;
  onDiary?: () => void;
  dim?: boolean;
}) {
  const { t } = useT();
  const wd = t(`weekday.short.${weekdayKey(tjWeekdayOf(s.startsAt))}`);
  const materials = s.materials ?? [];
  // Дневник ведут с начала урока; записи могли остаться, даже если урок сдвинули.
  const logs = s._count?.homeworkLogs ?? 0;
  const diary = !!onDiary && !!s.homework && (new Date(s.startsAt).getTime() <= Date.now() || logs > 0);
  return (
    <div
      className={`acad-lesson${dim ? ' is-past' : ''}${s.status === 'CANCELLED' ? ' is-cancelled' : ''}${onOpen ? ' is-clickable' : ''}`}
      data-testid={`lesson-${s.id}`}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={(e) => {
        if (onOpen && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="acad-lesson-date">
        <b>{shortDate(s.startsAt)}</b>
        <span>{wd}</span>
        <small>{tjFormatTime(s.startsAt)}–{tjFormatTime(s.endsAt)}</small>
      </div>
      <div className="acad-lesson-body">
        <div className="acad-lesson-top">
          <span className="acad-lesson-topic">{s.topic || t('classes.noTopic')}</span>
          <span className={STATUS_CLASS[s.status] || 'badge badge-gray'}>{t(`classes.status.${s.status}`)}</span>
        </div>
        {s.teacher && (
          <div className="acad-lesson-sub">
            <Icon name="swap_horiz" size={14} /> {s.teacher.fullName} ({t('classes.substitute')})
          </div>
        )}
        {s.homework && (
          <div className="acad-lesson-hw">
            <Icon name="menu_book" size={15} />
            <span>{s.homework}</span>
          </div>
        )}
        {(s.homeworkDue || diary) && (
          <div className="acad-lesson-due-row">
            {s.homeworkDue && (
              <span className="acad-lesson-due">
                {t('academy.lessons.due')}: {tjFormatDate(s.homeworkDue)}
              </span>
            )}
            {diary && (
              <button
                type="button"
                className="btn btn-sm btn-secondary acad-diary-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiary!();
                }}
                data-testid={`diary-${s.id}`}
              >
                <Icon name="edit_note" size={16} /> {t('academy.diary.title')}
                <span className="acad-tab-count">{logs}</span>
              </button>
            )}
          </div>
        )}
        {materials.length > 0 && (
          <div className="acad-chips" onClick={(e) => e.stopPropagation()}>
            {materials.map((m) => (
              <a
                key={m.id}
                className="acad-chip"
                href={m.kind === 'LINK' ? m.url : absFileUrl(m.url)}
                target="_blank"
                rel="noreferrer"
                title={m.title}
              >
                <Icon name={materialIcon(m.kind, m.mimeType, m.title)} size={14} />
                <span>{m.title}</span>
                {m.kind === 'FILE' && m.size ? <small>{fileSize(m.size)}</small> : null}
              </a>
            ))}
          </div>
        )}
      </div>
      {onOpen && <Icon name="chevron_right" size={20} className="acad-lesson-go" />}
    </div>
  );
}
