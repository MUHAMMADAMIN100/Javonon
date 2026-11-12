import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Course,
  CourseDetail,
  Lesson,
  listCourses,
  getCourseAdmin,
  createCourse,
  updateCourse,
  deleteCourse,
  addLesson,
  updateLesson,
  deleteLesson,
  enrollStudent,
  listCourseStudents,
  unenrollStudent,
} from '../api/lms';
import { listStudents } from '../api/students';
import CrmSelect from '../components/CrmSelect';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import { isElevated } from '../lib/roles';
import { roleCan } from '../lib/permissions';
import { useT } from '../lib/i18n';
import { ruPlural } from '../lib/plural';
import { MarkdownLite, stripMarkdown } from '../lib/markdownLite';

export default function Lms() {
  const { t, lang } = useT();
  const me = useAuth((s) => s.user);
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  // Права роли «Курсы — …»; должность — руководство, как раньше. Уроки
  // курса добавляют, меняют и удаляют с «Курсы — изменение» (как сервер).
  const canCreate = roleCan(me, 'lms:create', isElevated(me));
  const canUpdate = roleCan(me, 'lms:update', isElevated(me));
  const canRemove = roleCan(me, 'lms:delete', isElevated(me));

  const coursesKey = keys.lms.courses();
  const coursesQuery = useQuery({
    queryKey: coursesKey,
    queryFn: () => listCourses(),
  });
  const courses = coursesQuery.data ?? [];

  const selectedQuery = useQuery({
    queryKey: selectedId ? keys.lms.course(selectedId) : ['lms', 'course', null],
    queryFn: () => getCourseAdmin(selectedId!),
    enabled: !!selectedId,
  });
  const selected = selectedQuery.data ?? null;

  const createMut = useInvalidatingMutation({
    mutationFn: createCourse,
    invalidate: [keys.lms.all],
    onSuccess: (c) => {
      toast(t('lms.toast.created'), 'success');
      setShowNew(false);
      setSelectedId(c.id);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  // Toggle publish — оптимистично переключаем флаг.
  const togglePublishMut = useOptimisticMutation<Course, Course, Course[]>({
    mutationFn: (c) => updateCourse(c.id, { published: !c.published }),
    queryKey: coursesKey,
    applyOptimistic: (cur, c) => optimistic.updateById(cur, c.id, { published: !c.published } as Partial<Course>),
    invalidateAlso: [keys.lms.all],
    onSuccess: (_d, c) => toast(c.published ? t('lms.toast.unpublished') : t('lms.toast.published'), 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deleteCourseMut = useOptimisticMutation<unknown, string, Course[]>({
    mutationFn: deleteCourse,
    queryKey: coursesKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.lms.all],
    onSuccess: () => {
      toast(t('lms.toast.deleted'), 'success');
      setSelectedId(null);
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onCreateCourse = (data: { title: string; description?: string }) => {
    createMut.mutate(data);
  };

  const togglePublish = (c: Course) => togglePublishMut.mutate(c);

  const onDeleteCourse = async (c: Course) => {
    const ok = await confirm({
      title: t('lms.confirm.deleteCourse'),
      message: t('lms.deleteCourse.message').replace('{name}', c.title),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    deleteCourseMut.mutate(c.id);
  };

  // Просто helper, чтобы CourseEditor мог триггерить рефреш.
  const refresh = () => qc.invalidateQueries({ queryKey: keys.lms.all });

  return (
    <>
      <div className="lms-grid" style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gap: 16,
      }}>
        {/* Courses list */}
        <div className="card" style={{ padding: 0, alignSelf: 'start' }}>
          <div style={{
            padding: '20px 22px',
            borderBottom: '1px solid var(--border-soft)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.12em',
              color: 'var(--text-soft)',
              textTransform: 'uppercase',
            }}>{t('lms.courses')}</div>
            {canCreate && (
              <button className="btn btn-sm btn-secondary" data-testid="lms-course-new" onClick={() => setShowNew((v) => !v)}>
                <Icon name="add" size={14} />
              </button>
            )}
          </div>
          <AnimatePresence>
            {showNew && canCreate && (
              <FormModal
                open
                title={t('lms.new')}
                onClose={() => setShowNew(false)}
                testId="lms-course-form"
              >
                <NewCourseForm onSubmit={onCreateCourse} onCancel={() => setShowNew(false)} />
              </FormModal>
            )}
          </AnimatePresence>
          <div>
            {courses.length === 0 && <div className="empty" style={{ padding: 32 }}>{t('lms.empty')}</div>}
            {courses.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '16px 22px',
                  background: selected?.id === c.id ? 'var(--primary-soft)' : 'transparent',
                  borderLeft: selected?.id === c.id ? '3px solid var(--primary)' : '3px solid transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border-soft)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 16,
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                  marginBottom: 4,
                }}>{c.title}</div>
                <div style={{
                  display: 'flex', gap: 8, alignItems: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.10em',
                  color: 'var(--text-soft)',
                  textTransform: 'uppercase',
                }}>
                  <span data-testid="lms-lessons-count">{c._count?.lessons ?? 0} {t(lang === 'ru' ? ruPlural(c._count?.lessons ?? 0, 'lms.lessons.one', 'lms.lessons.few', 'lms.lessons') : 'lms.lessons')}</span>
                  <span>·</span>
                  <span>{c._count?.enrollments ?? 0} {t('lms.students')}</span>
                  {c.published && <span style={{ color: 'var(--primary-dark)' }}>· {t('lms.course.published')}</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Course details */}
        <div>
          {!selected ? (
            <div className="card" style={{ padding: 64, textAlign: 'center' }}>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                color: 'var(--text-light)',
                textTransform: 'uppercase',
                marginBottom: 12,
              }}>{t('eyebrow.noCourseSelected')}</div>
              <h3 style={{
                fontFamily: 'var(--font-display)',
                fontSize: 28,
                fontWeight: 500,
                letterSpacing: '-0.02em',
              }}>{t('lms.selectLeft')}</h3>
            </div>
          ) : (
            <CourseEditor
              course={selected}
              canUpdate={canUpdate}
              canRemove={canRemove}
              onChange={refresh}
              onTogglePublish={() => togglePublish(selected)}
              onDelete={() => onDeleteCourse(selected)}
            />
          )}
        </div>
      </div>
    </>
  );
}

function NewCourseForm({ onSubmit, onCancel }: {
  onSubmit: (data: { title: string; description?: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ title, description: desc || undefined }); }}>
      <div className="form-group">
        <label>{t('lms.course.title')}</label>
        <input className="crm-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="form-group">
        <label>{t('lms.course.description')}</label>
        <textarea className="crm-textarea" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim()}>{t('common.create')}</button>
      </div>
    </form>
  );
}

function CourseEditor({ course, canUpdate, canRemove, onChange, onTogglePublish, onDelete }: {
  course: CourseDetail;
  canUpdate: boolean;
  canRemove: boolean;
  onChange: () => void;
  onTogglePublish: () => void;
  onDelete: () => void;
}) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const [editingMeta, setEditingMeta] = useState(false);
  const [title, setTitle] = useState(course.title);
  const [description, setDescription] = useState(course.description || '');
  const [showLessonForm, setShowLessonForm] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);

  useEffect(() => {
    setTitle(course.title);
    setDescription(course.description || '');
  }, [course.id, course.title, course.description]);

  // Ошибка сервера (400 на HTML/«javascript:» в уроке и т.п.) — сообщением,
  // окно остаётся открытым с введённым (QA №41: раньше ответ терялся, окно висело).
  const guarded = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const saveMeta = () => guarded(async () => {
    await updateCourse(course.id, { title, description });
    toast(t('toast.saved'), 'success');
    setEditingMeta(false);
    onChange();
  });

  const onAddLesson = (data: { title: string; content?: string; videoUrl?: string }) => guarded(async () => {
    await addLesson(course.id, data);
    toast(t('lms.toast.lessonAdded'), 'success');
    setShowLessonForm(false);
    onChange();
  });

  const onDeleteLesson = async (l: Lesson) => {
    const ok = await confirm({
      title: t('lms.confirm.deleteLesson'),
      message: `«${l.title}»`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    await guarded(async () => {
      await deleteLesson(l.id);
      toast(t('lms.toast.lessonDeleted'), 'success');
      onChange();
    });
  };

  const onSaveLesson = (l: Lesson) => guarded(async () => {
    await updateLesson(l.id, { title: l.title, content: l.content || '', videoUrl: l.videoUrl || '' });
    toast(t('toast.saved'), 'success');
    setEditingLesson(null);
    onChange();
  });

  return (
    <div className="card lms-course-card" style={{ padding: 32 }}>
      <div className="lms-course-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingMeta ? (
            <>
              <div className="form-group">
                <label>{t('common.name')}</label>
                <input className="crm-input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="form-group">
                <label>{t('common.description')}</label>
                <textarea className="crm-textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-secondary" onClick={() => { setEditingMeta(false); setTitle(course.title); setDescription(course.description || ''); }}>{t('common.cancel')}</button>
                <button className="btn btn-sm btn-primary" onClick={saveMeta}>{t('common.save')}</button>
              </div>
            </>
          ) : (
            <>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                color: 'var(--primary-dark)',
                marginBottom: 8,
                textTransform: 'uppercase',
              }}>{t('lms.badge.course')} · {course.published ? t('lms.badge.published') : t('lms.badge.draft')}</div>
              <h2 className="lms-course-title" style={{
                fontFamily: 'var(--font-display)',
                fontSize: 36,
                fontWeight: 500,
                letterSpacing: '-0.02em',
                marginBottom: 8,
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
              }}>{course.title}</h2>
              {course.description && <p style={{ color: 'var(--text-soft)', fontSize: 15 }}>{course.description}</p>}
            </>
          )}
        </div>
        {(canUpdate || canRemove) && !editingMeta && (
          <div className="lms-course-actions" style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
            {canUpdate && (
              <button className="btn btn-sm btn-secondary" data-testid="lms-course-edit" onClick={() => setEditingMeta(true)}>
                <Icon name="edit" size={14} /> {t('common.edit')}
              </button>
            )}
            {canUpdate && (
              <button className="btn btn-sm btn-secondary" data-testid="lms-course-publish" onClick={onTogglePublish}>
                {course.published ? t('lms.unpublish') : t('lms.publish')}
              </button>
            )}
            {canRemove && (
              <button className="btn btn-sm btn-danger" data-testid="lms-course-delete" onClick={onDelete}>
                <Icon name="delete" size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        margin: '32px 0 16px',
        borderTop: '1px solid var(--border-soft)',
        paddingTop: 24,
      }}>
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.12em',
          color: 'var(--text-soft)',
          textTransform: 'uppercase',
        }}>{t('lms.lessonsTitle')} · {course.lessons.length}</div>
        {canUpdate && (
          <button className="btn btn-sm btn-primary" data-testid="lms-lesson-new" onClick={() => setShowLessonForm((v) => !v)}>
            <Icon name="add" size={14} /> {t('lms.addLesson')}
          </button>
        )}
      </div>

      <AnimatePresence>
        {showLessonForm && (
          <FormModal
            open
            title={t('lms.lesson.new')}
            onClose={() => setShowLessonForm(false)}
            testId="lms-lesson-form"
          >
            <NewLessonForm onSubmit={onAddLesson} onCancel={() => setShowLessonForm(false)} />
          </FormModal>
        )}
      </AnimatePresence>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {course.lessons.length === 0 && <div className="empty" style={{ padding: 32 }}>{t('lms.lesson.empty')}</div>}
        {course.lessons.map((l, i) => (
          <div key={l.id} style={{
            border: '1px solid var(--border-soft)',
            borderRadius: 14,
            padding: 18,
            background: 'white',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 14,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'var(--bg-soft)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              fontWeight: 500,
              flexShrink: 0,
            }}>{String(i + 1).padStart(2, '0')}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editingLesson?.id === l.id ? (
                <LessonEditForm
                  lesson={editingLesson}
                  onChange={setEditingLesson}
                  onSave={() => onSaveLesson(editingLesson)}
                  onCancel={() => setEditingLesson(null)}
                />
              ) : (
                <>
                  <div style={{ fontWeight: 500, fontSize: 15 }}>{l.title}</div>
                  {/* QA-3 (BUG-18): короткий текст — оформленным; длинный — превью без знаков разметки. */}
                  {l.content && (l.content.length <= 400
                    ? <MarkdownLite text={l.content} className="md-lite-soft" />
                    : <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 4, whiteSpace: 'pre-wrap' }} data-testid="lms-lesson-preview">{stripMarkdown(l.content).slice(0, 400)}…</div>)}
                  {l.videoUrl && (
                    <a href={l.videoUrl} target="_blank" rel="noreferrer" style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.08em',
                      color: 'var(--primary-dark)',
                      marginTop: 6,
                      display: 'inline-block',
                    }}>
                      <Icon name="play_circle" size={12} style={{ verticalAlign: 'middle' }} /> {t('lms.video')}
                    </a>
                  )}
                </>
              )}
            </div>
            {canUpdate && editingLesson?.id !== l.id && (
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditingLesson(l)}>
                  <Icon name="edit" size={14} />
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => onDeleteLesson(l)}>
                  <Icon name="delete" size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <CourseStudents courseId={course.id} canUpdate={canUpdate} />
    </div>
  );
}

/**
 * Студенты курса и «Записать студента» (QA №43: у курсов было «0 студентов»
 * и записать было нечем — только самозапись в кабинете).
 */
function CourseStudents({ courseId, canUpdate }: { courseId: string; canUpdate: boolean }) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const key = ['lms', 'course-students', courseId];
  const enrolled = useQuery({ queryKey: key, queryFn: () => listCourseStudents(courseId) });
  const [pick, setPick] = useState('');
  const students = useQuery({ queryKey: ['students', 'lms-pick'], queryFn: () => listStudents({}), enabled: canUpdate, staleTime: 60_000 });
  const rows = enrolled.data ?? [];
  const taken = new Set(rows.map((r) => r.id));
  const add = async () => {
    if (!pick) return;
    try {
      await enrollStudent(courseId, pick);
      setPick('');
      await qc.invalidateQueries({ queryKey: key });
      toast(t('lms.students.added'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  const remove = async (id: string, name: string) => {
    const ok = await confirm({ title: t('lms.students.removeTitle'), message: name, danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try {
      await unenrollStudent(courseId, id);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };
  return (
    <div className="lms-students" data-testid="lms-course-students">
      <div className="crm-section-head" style={{ marginTop: 24 }}>
        <h3 className="crm-section-title" style={{ fontSize: 18 }}>{t('lms.students.title').replace('{n}', String(rows.length))}</h3>
      </div>
      {canUpdate && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ minWidth: 260, flex: '1 1 260px', maxWidth: 420 }}>
            <CrmSelect className="crm-select" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="lms-student-pick">
              <option value="">{t('lms.students.choose')}</option>
              {(students.data ?? []).filter((s) => !taken.has(s.id)).map((s) => (
                <option key={s.id} value={s.id}>{s.fullName}</option>
              ))}
            </CrmSelect>
          </div>
          <button className="btn btn-primary" onClick={add} disabled={!pick} data-testid="lms-student-add">
            <Icon name="person_add" size={16} /> {t('lms.students.add')}
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: 12 }}>{t('lms.students.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.id} className="lms-student-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-soft)', borderRadius: 10 }}>
              <span>{r.fullName}</span>
              {canUpdate && (
                <button className="btn btn-sm btn-secondary" onClick={() => remove(r.id, r.fullName)} title={t('common.delete')}>
                  <Icon name="person_remove" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewLessonForm({ onSubmit, onCancel }: {
  onSubmit: (data: { title: string; content?: string; videoUrl?: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ title, content: content || undefined, videoUrl: videoUrl || undefined }); }}
      style={{ background: 'var(--bg-soft)', padding: 18, borderRadius: 14, border: '1px solid var(--border-soft)' }}
    >
      <div className="form-group">
        <label>{t('lms.lessonTitle')}</label>
        <input className="crm-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="form-group">
        <label>{t('lms.lessonText')}</label>
        <textarea className="crm-textarea" value={content} onChange={(e) => setContent(e.target.value)} rows={4} />
      </div>
      <div className="form-group">
        <label>{t('lms.videoLink')}</label>
        <input className="crm-input" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://youtube.com/..." />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim()}>{t('common.add')}</button>
      </div>
    </form>
  );
}

function LessonEditForm({ lesson, onChange, onSave, onCancel }: {
  lesson: Lesson;
  onChange: (l: Lesson) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div>
      <div className="form-group">
        <label>{t('common.name')}</label>
        <input className="crm-input" value={lesson.title} onChange={(e) => onChange({ ...lesson, title: e.target.value })} />
      </div>
      <div className="form-group">
        <label>{t('lms.text')}</label>
        <textarea className="crm-textarea" value={lesson.content || ''} onChange={(e) => onChange({ ...lesson, content: e.target.value })} rows={4} />
      </div>
      <div className="form-group">
        <label>{t('lms.video')}</label>
        <input className="crm-input" value={lesson.videoUrl || ''} onChange={(e) => onChange({ ...lesson, videoUrl: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn btn-sm btn-primary" onClick={onSave}>{t('common.save')}</button>
      </div>
    </div>
  );
}
