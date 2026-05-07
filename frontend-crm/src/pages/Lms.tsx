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
} from '../api/lms';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';

export default function Lms() {
  const me = useAuth((s) => s.user);
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const isAdmin = me?.role === 'ADMIN';

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
      toast('Курс создан', 'success');
      setShowNew(false);
      setSelectedId(c.id);
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  // Toggle publish — оптимистично переключаем флаг.
  const togglePublishMut = useOptimisticMutation<Course, Course, Course[]>({
    mutationFn: (c) => updateCourse(c.id, { published: !c.published }),
    queryKey: coursesKey,
    applyOptimistic: (cur, c) => optimistic.updateById(cur, c.id, { published: !c.published } as Partial<Course>),
    invalidateAlso: [keys.lms.all],
    onSuccess: (_d, c) => toast(c.published ? 'Снято с публикации' : 'Опубликовано', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deleteCourseMut = useOptimisticMutation<unknown, string, Course[]>({
    mutationFn: deleteCourse,
    queryKey: coursesKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.lms.all],
    onSuccess: () => {
      toast('Курс удалён', 'success');
      setSelectedId(null);
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onCreateCourse = (data: { title: string; description?: string }) => {
    createMut.mutate(data);
  };

  const togglePublish = (c: Course) => togglePublishMut.mutate(c);

  const onDeleteCourse = async (c: Course) => {
    const ok = await confirm({
      title: 'Удалить курс?',
      message: `«${c.title}» — все уроки и прогресс будут удалены`,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    deleteCourseMut.mutate(c.id);
  };

  // Просто helper, чтобы CourseEditor мог триггерить рефреш.
  const refresh = () => qc.invalidateQueries({ queryKey: keys.lms.all });

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">LMS · 13</span>
        <h2 className="crm-section-title">
          Курсы <em>и обучение.</em>
        </h2>
      </div>

      <div style={{
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
            }}>Курсы</div>
            {isAdmin && (
              <button className="btn btn-sm btn-secondary" onClick={() => setShowNew((v) => !v)}>
                <Icon name="add" size={14} />
              </button>
            )}
          </div>
          <AnimatePresence>
            {showNew && isAdmin && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ padding: 16, borderBottom: '1px solid var(--border-soft)', overflow: 'hidden' }}
              >
                <NewCourseForm onSubmit={onCreateCourse} onCancel={() => setShowNew(false)} />
              </motion.div>
            )}
          </AnimatePresence>
          <div>
            {courses.length === 0 && <div className="empty" style={{ padding: 32 }}>Нет курсов</div>}
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
                  <span>{c._count?.lessons ?? 0} уроков</span>
                  <span>·</span>
                  <span>{c._count?.enrollments ?? 0} студентов</span>
                  {c.published && <span style={{ color: 'var(--primary-dark)' }}>· опубликовано</span>}
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
              }}>NO COURSE SELECTED</div>
              <h3 style={{
                fontFamily: 'var(--font-display)',
                fontSize: 28,
                fontWeight: 500,
                letterSpacing: '-0.02em',
              }}>Выбери курс <em style={{
                fontFamily: 'Times New Roman, Georgia, serif',
                fontWeight: 400,
                color: 'var(--primary-dark)',
              }}>слева.</em></h3>
            </div>
          ) : (
            <CourseEditor
              course={selected}
              isAdmin={isAdmin}
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
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ title, description: desc || undefined }); }}>
      <div className="form-group">
        <label>Название</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="form-group">
        <label>Описание</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>Отмена</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim()}>Создать</button>
      </div>
    </form>
  );
}

function CourseEditor({ course, isAdmin, onChange, onTogglePublish, onDelete }: {
  course: CourseDetail;
  isAdmin: boolean;
  onChange: () => void;
  onTogglePublish: () => void;
  onDelete: () => void;
}) {
  const { toast, confirm } = useUI();
  const [editingMeta, setEditingMeta] = useState(false);
  const [title, setTitle] = useState(course.title);
  const [description, setDescription] = useState(course.description || '');
  const [showLessonForm, setShowLessonForm] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);

  useEffect(() => {
    setTitle(course.title);
    setDescription(course.description || '');
  }, [course.id, course.title, course.description]);

  const saveMeta = async () => {
    await updateCourse(course.id, { title, description });
    toast('Сохранено', 'success');
    setEditingMeta(false);
    onChange();
  };

  const onAddLesson = async (data: { title: string; content?: string; videoUrl?: string }) => {
    await addLesson(course.id, data);
    toast('Урок добавлен', 'success');
    setShowLessonForm(false);
    onChange();
  };

  const onDeleteLesson = async (l: Lesson) => {
    const ok = await confirm({
      title: 'Удалить урок?',
      message: `«${l.title}»`,
      danger: true,
      confirmText: 'Удалить',
    });
    if (!ok) return;
    await deleteLesson(l.id);
    toast('Урок удалён', 'success');
    onChange();
  };

  const onSaveLesson = async (l: Lesson) => {
    await updateLesson(l.id, { title: l.title, content: l.content || '', videoUrl: l.videoUrl || '' });
    toast('Сохранено', 'success');
    setEditingLesson(null);
    onChange();
  };

  return (
    <div className="card" style={{ padding: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <div style={{ flex: 1 }}>
          {editingMeta ? (
            <>
              <div className="form-group">
                <label>Название</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="form-group">
                <label>Описание</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-secondary" onClick={() => { setEditingMeta(false); setTitle(course.title); setDescription(course.description || ''); }}>Отмена</button>
                <button className="btn btn-sm btn-primary" onClick={saveMeta}>Сохранить</button>
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
              }}>COURSE · {course.published ? 'PUBLISHED' : 'DRAFT'}</div>
              <h2 style={{
                fontFamily: 'var(--font-display)',
                fontSize: 36,
                fontWeight: 500,
                letterSpacing: '-0.02em',
                marginBottom: 8,
              }}>{course.title}</h2>
              {course.description && <p style={{ color: 'var(--text-soft)', fontSize: 15 }}>{course.description}</p>}
            </>
          )}
        </div>
        {isAdmin && !editingMeta && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button className="btn btn-sm btn-secondary" onClick={() => setEditingMeta(true)}>
              <Icon name="edit" size={14} /> Изменить
            </button>
            <button className="btn btn-sm btn-secondary" onClick={onTogglePublish}>
              {course.published ? 'Снять' : 'Опубликовать'}
            </button>
            <button className="btn btn-sm btn-danger" onClick={onDelete}>
              <Icon name="delete" size={14} />
            </button>
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
        }}>Уроки · {course.lessons.length}</div>
        {isAdmin && (
          <button className="btn btn-sm btn-primary" onClick={() => setShowLessonForm((v) => !v)}>
            <Icon name="add" size={14} /> Добавить урок
          </button>
        )}
      </div>

      <AnimatePresence>
        {showLessonForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ marginBottom: 16, overflow: 'hidden' }}
          >
            <NewLessonForm onSubmit={onAddLesson} onCancel={() => setShowLessonForm(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {course.lessons.length === 0 && <div className="empty" style={{ padding: 32 }}>Уроков пока нет</div>}
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
                  {l.content && <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{l.content.slice(0, 200)}{l.content.length > 200 ? '...' : ''}</div>}
                  {l.videoUrl && (
                    <a href={l.videoUrl} target="_blank" rel="noreferrer" style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      letterSpacing: '0.08em',
                      color: 'var(--primary-dark)',
                      marginTop: 6,
                      display: 'inline-block',
                    }}>
                      <Icon name="play_circle" size={12} style={{ verticalAlign: 'middle' }} /> Видео
                    </a>
                  )}
                </>
              )}
            </div>
            {isAdmin && editingLesson?.id !== l.id && (
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
    </div>
  );
}

function NewLessonForm({ onSubmit, onCancel }: {
  onSubmit: (data: { title: string; content?: string; videoUrl?: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit({ title, content: content || undefined, videoUrl: videoUrl || undefined }); }}
      style={{ background: 'var(--bg-soft)', padding: 18, borderRadius: 14, border: '1px solid var(--border-soft)' }}
    >
      <div className="form-group">
        <label>Название урока</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="form-group">
        <label>Текст урока (Markdown)</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} />
      </div>
      <div className="form-group">
        <label>Ссылка на видео</label>
        <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://youtube.com/..." />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onCancel}>Отмена</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!title.trim()}>Добавить</button>
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
  return (
    <div>
      <div className="form-group">
        <label>Название</label>
        <input value={lesson.title} onChange={(e) => onChange({ ...lesson, title: e.target.value })} />
      </div>
      <div className="form-group">
        <label>Текст</label>
        <textarea value={lesson.content || ''} onChange={(e) => onChange({ ...lesson, content: e.target.value })} rows={4} />
      </div>
      <div className="form-group">
        <label>Видео</label>
        <input value={lesson.videoUrl || ''} onChange={(e) => onChange({ ...lesson, videoUrl: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>Отмена</button>
        <button className="btn btn-sm btn-primary" onClick={onSave}>Сохранить</button>
      </div>
    </div>
  );
}
