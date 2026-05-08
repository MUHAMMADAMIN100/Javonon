import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  listStudentCourses,
  listAvailableCourses,
  getStudentCourse,
  enrollInCourse,
  completeLesson,
  type StudentCourse,
} from '../studentApi';
import Loading from './Loading';
import Icon from '../Icon';

export default function CoursesSection() {
  const [my, setMy] = useState<StudentCourse[]>([]);
  const [available, setAvailable] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCourse, setOpenCourse] = useState<any | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [m, a] = await Promise.all([listStudentCourses(), listAvailableCourses()]);
      setMy(m);
      setAvailable(a);
    } catch {} finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const onEnroll = async (id: string) => {
    await enrollInCourse(id);
    await refresh();
  };

  const onOpen = async (id: string) => {
    const det = await getStudentCourse(id);
    setOpenCourse(det);
  };

  const onComplete = async (lessonId: string) => {
    await completeLesson(lessonId);
    if (openCourse) {
      const det = await getStudentCourse(openCourse.id);
      setOpenCourse(det);
    }
    refresh();
  };

  if (openCourse) {
    return (
      <div className="stu-card">
        <button
          className="btn btn-outline btn-small"
          style={{ marginBottom: 16 }}
          onClick={() => setOpenCourse(null)}
        >
          <Icon name="arrow_back" size={14} /> Все курсы
        </button>
        <h2>{openCourse.title}</h2>
        {openCourse.description && (
          <p style={{ color: 'var(--text-soft)', marginBottom: 24 }}>{openCourse.description}</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {openCourse.lessons.map((l: any, i: number) => (
            <div
              key={l.id}
              style={{
                border: '1px solid var(--border-soft, #e5e5e5)',
                borderRadius: 12,
                padding: 16,
                background: 'white',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: l.completed ? 'rgb(1, 54, 139)' : 'var(--bg-soft, #f5f5f5)',
                  color: l.completed ? 'white' : 'var(--text)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 600,
                  flexShrink: 0,
                }}>
                  {l.completed ? <Icon name="check" size={18} /> : String(i + 1).padStart(2, '0')}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 4 }}>{l.title}</div>
                  {l.content && (
                    <div style={{
                      fontSize: 14,
                      color: 'var(--text-soft)',
                      whiteSpace: 'pre-wrap',
                      marginBottom: 10,
                    }}>{l.content}</div>
                  )}
                  {l.videoUrl && (
                    <a
                      href={l.videoUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        color: 'rgb(1, 36, 87)',
                        fontWeight: 500,
                        fontSize: 13,
                      }}
                    >
                      <Icon name="play_circle" size={16} /> Смотреть видео
                    </a>
                  )}
                </div>
                {!l.completed && (
                  <button
                    className="btn btn-primary btn-small"
                    onClick={() => onComplete(l.id)}
                  >
                    Отметить
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {loading && <Loading />}

      {/* Мои курсы */}
      {my.length > 0 && (
        <div className="stu-card" style={{ marginBottom: 16 }}>
          <h2>Мои курсы</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            {my.map((c) => (
              <motion.button
                key={c.enrollmentId}
                onClick={() => onOpen(c.course.id)}
                whileHover={{ y: -2 }}
                style={{
                  textAlign: 'left',
                  padding: 20,
                  background: 'white',
                  border: '1px solid var(--border-soft, #e5e5e5)',
                  borderRadius: 14,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 8 }}>{c.course.title}</div>
                {c.course.description && (
                  <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 14 }}>
                    {c.course.description.slice(0, 100)}{c.course.description.length > 100 ? '...' : ''}
                  </div>
                )}
                <div style={{
                  height: 4,
                  background: 'var(--bg-soft, #eee)',
                  borderRadius: 2,
                  overflow: 'hidden',
                  marginBottom: 8,
                }}>
                  <div style={{
                    height: '100%',
                    width: `${c.progress}%`,
                    background: 'rgb(1, 54, 139)',
                    transition: 'width 0.6s',
                  }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-soft)', display: 'flex', justifyContent: 'space-between' }}>
                  <span>{c.completedLessons} / {c.totalLessons} уроков</span>
                  <span style={{ fontWeight: 600, color: 'rgb(1, 36, 87)' }}>{c.progress}%</span>
                </div>
              </motion.button>
            ))}
          </div>
        </div>
      )}

      {/* Доступные курсы */}
      {available.length > 0 && (
        <div className="stu-card">
          <h2>Доступные курсы</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            {available.map((c) => (
              <motion.div
                key={c.id}
                whileHover={{ y: -2 }}
                style={{
                  padding: 20,
                  background: 'white',
                  border: '1px solid var(--border-soft, #e5e5e5)',
                  borderRadius: 14,
                }}
              >
                <div style={{ fontWeight: 500, fontSize: 16, marginBottom: 8 }}>{c.title}</div>
                {c.description && (
                  <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 14 }}>
                    {c.description.slice(0, 100)}{c.description.length > 100 ? '...' : ''}
                  </div>
                )}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 12, color: 'var(--text-soft)', marginBottom: 12,
                }}>
                  <span>{c._count?.lessons || 0} уроков</span>
                </div>
                <button className="btn btn-primary btn-small" style={{ width: '100%' }} onClick={() => onEnroll(c.id)}>
                  Записаться
                </button>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {!loading && my.length === 0 && available.length === 0 && (
        <div className="stu-card" style={{ textAlign: 'center', padding: 48 }}>
          <Icon name="school" size={48} style={{ opacity: 0.25, marginBottom: 12 }} />
          <div style={{ fontSize: 16, color: 'var(--text-soft)' }}>
            Курсы появятся здесь, когда менеджер добавит их в систему
          </div>
        </div>
      )}
    </div>
  );
}
