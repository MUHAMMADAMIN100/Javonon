import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  API_BASE,
  clearToken,
  getToken,
  studentDeleteDocument,
  studentMe,
  studentUploadDocument,
  type StudentMe,
} from '../studentApi';
import { connectStudentRealtime, useStudentRealtime, getSocket } from '../realtime';
import ApplicationFormSection from '../components/ApplicationFormSection';
import EnrollmentProgress from '../components/EnrollmentProgress';
import ProgramsSection from '../components/ProgramsSection';
import PaymentsSection from '../components/PaymentsSection';
import CoursesSection from '../components/CoursesSection';
import InteractionsHistory from '../components/InteractionsHistory';
import RealtimeStatusBanner from '../components/RealtimeStatusBanner';
import Icon from '../Icon';
import Loading from '../components/Loading';
import { lkeys, optimistic, useOptimisticMutation } from '../queryClient';
import { isFinishedApplicationStatus } from '../applicationStatus';

const DIRECTION_LABEL: Record<string, string> = {
  BACHELOR: 'Бакалавр',
  MASTER: 'Магистр',
  LANGUAGE: 'Курсҳои забонӣ',
  LANGUAGE_COLLEGE: 'Забонӣ + коллеҷ',
  LANGUAGE_BACHELOR: 'Забонӣ + бакалавр',
  COLLEGE: 'Коллеҷ',
};
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Фаъол',
  PAUSED: 'Дар таваққуф',
  GRADUATED: 'Хатм кард',
  ARCHIVED: 'Дар бойгонӣ',
};

const REQUIRED_DOCS = [
  { type: 'PHOTO', label: 'Сурат 3/4', hint: 'Дар шакли электронӣ' },
  { type: 'PASSPORT', label: 'Шиносномаи хориҷӣ' },
  { type: 'BANK', label: 'Маълумотнома аз бонк' },
  { type: 'MEDICAL', label: 'Маълумотномаи тиббӣ (барои Хитой)' },
  { type: 'NO_CRIMINAL', label: 'Маълумотнома дар бораи доғи судӣ надоштан' },
  { type: 'STUDY_PLAN', label: 'Study Plan (Мактуби ангезишӣ)' },
  { type: 'CERTIFICATE', label: 'Certificate', hint: 'IELTS, TOEFL, DUOLINGO, HSK, CSCA (агар бошад)' },
  { type: 'PARENTS_PASSPORT', label: 'Шиносномаи волидайн' },
  { type: 'DIPLOMA', label: 'Аттестат', hint: 'Ё варақаи баҳоҳо + маълумотнома аз мактаб' },
  { type: 'RECOMMENDATION', label: 'Мактуби тавсиявӣ' },
];

const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  return `${(b / 1024 / 1024).toFixed(2)} МБ`;
};

export default function StudentCabinet() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [uploading, setUploading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tab, setTab] = useState<'home' | 'programs' | 'payments' | 'courses' | 'interactions'>('home');
  // QA-fix: красивая модалка вместо нативного confirm('Удалить документ?')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const otherRef = useRef<HTMLInputElement>(null);

  const showToast = (kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    const token = getToken();
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }
    if (!getSocket()) connectStudentRealtime(token);
  }, []);

  const meKey = lkeys.cabinet.me();
  const meQuery = useQuery<StudentMe>({
    queryKey: meKey,
    queryFn: studentMe,
  });
  const me = meQuery.data ?? null;
  const loading = meQuery.isLoading;

  // QA-fix #4: при ЛЮБОЙ ошибке /me раньше делали logout → при cold-start
  // Railway пользователь без причины оказывался на /login. Теперь кикаем
  // ТОЛЬКО на 401 (реальный auth-fail). Network/5xx — показываем retry.
  useEffect(() => {
    if (meQuery.isError) {
      const status = (meQuery.error as any)?.response?.status;
      if (status === 401 || status === 403) {
        clearToken();
        navigate('/login', { replace: true });
      }
    }
  }, [meQuery.isError, meQuery.error, navigate]);

  useStudentRealtime({
    'student:updated': () => qc.invalidateQueries({ queryKey: meKey }),
    'document:uploaded': () => qc.invalidateQueries({ queryKey: meKey }),
    'document:deleted': () => qc.invalidateQueries({ queryKey: meKey }),
    'application:updated': () => qc.invalidateQueries({ queryKey: meKey }),
  });

  const logout = () => {
    clearToken();
    navigate('/login');
  };

  // DELETE document — оптимистично убираем из me.documents мгновенно.
  const deleteDocMut = useOptimisticMutation<unknown, string, StudentMe>({
    mutationFn: studentDeleteDocument,
    queryKey: meKey,
    applyOptimistic: (cur, id) => {
      if (!cur) return cur;
      return { ...cur, documents: (cur.documents || []).filter((d) => d.id !== id) };
    },
    onSuccess: () => showToast('ok', 'Ҳуҷҷат нест карда шуд'),
    onError: (err: any) => showToast('err', err?.response?.data?.message || 'Хатогӣ'),
  });

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: string) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(type);
    try {
      for (const file of files) {
        await studentUploadDocument(file, type);
      }
      showToast('ok', files.length > 1 ? `Бор карда шуд: ${files.length}` : 'Ҳуҷҷат бор карда шуд');
      qc.invalidateQueries({ queryKey: meKey });
    } catch (err: any) {
      showToast('err', err?.response?.data?.message || 'Хатогии боркунӣ');
    } finally {
      setUploading(null);
      e.target.value = '';
    }
  };

  const onDelete = (docId: string) => {
    setConfirmDelete(docId);
  };

  // QA-fix #4: понятный fallback для network errors (cold-start Railway).
  if (meQuery.isError && !me) {
    const status = (meQuery.error as any)?.response?.status;
    // 401/403 уже обработан useEffect выше — там идёт navigate('/login').
    // Здесь — неauth-ошибки: показываем кнопку Retry.
    if (status !== 401 && status !== 403) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20,
        }}>
          <div style={{ fontFamily: 'var(--display, Georgia, serif)', fontSize: 28, fontWeight: 500 }}>
            Маълумотро бор кардан нашуд
          </div>
          <div style={{ color: 'var(--ink-soft, #64748b)', fontSize: 14, textAlign: 'center', maxWidth: 420 }}>
            Сервер дар вақташ ҷавоб надод. Эҳтимол, ҳозир бедор шуд —
            пас аз як дақиқа саҳифаро нав кунед.
          </div>
          <button
            className="btn-pill solid"
            onClick={() => meQuery.refetch()}
            style={{ marginTop: 8 }}
          >
            Бори дигар кӯшиш кардан
          </button>
        </div>
      );
    }
  }
  if (loading || !me) {
    return <Loading fullscreen />;
  }

  const typed = (me.documents || []).filter((d) => d.type && d.type !== 'OTHER');
  const other = (me.documents || []).filter((d) => !d.type || d.type === 'OTHER');
  const uploaded = REQUIRED_DOCS.filter((r) => typed.some((d) => d.type === r.type)).length;
  const percent = Math.round((uploaded / REQUIRED_DOCS.length) * 100);

  return (
    <div className="stu-page">
      <RealtimeStatusBanner />
      <header className="stu-header">
        <div className="container stu-header-inner">
          <Link to="/" className="brand brand-img" aria-label="Javonon">
            <img src="/javonon-logo.svg" alt="Javonon" />
          </Link>
          <div className="stu-header-user">
            <div className="stu-header-name">{me.fullName}</div>
            <button className="btn-pill ghost" onClick={logout}>
              <Icon name="logout" size={16} />
              Баромадан
            </button>
          </div>
        </div>
      </header>

      <main className="container stu-main">
        <div className="stu-tabs">
          <button
            type="button"
            className={`stu-tab${tab === 'home' ? ' active' : ''}`}
            onClick={() => setTab('home')}
          >
            <Icon name="dashboard" size={18} />
            Асосӣ
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'programs' ? ' active' : ''}`}
            onClick={() => setTab('programs')}
          >
            <Icon name="menu_book" size={18} />
            Барномаҳо
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'payments' ? ' active' : ''}`}
            onClick={() => setTab('payments')}
          >
            <Icon name="payments" size={18} />
            Пардохтҳо
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'courses' ? ' active' : ''}`}
            onClick={() => setTab('courses')}
          >
            <Icon name="school" size={18} />
            Курсҳо
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'interactions' ? ' active' : ''}`}
            onClick={() => setTab('interactions')}
          >
            <Icon name="forum" size={18} />
            Муошират
          </button>
        </div>
        <AnimatePresence>
          {toast && (
            <motion.div
              className={`stu-toast stu-toast-${toast.kind}`}
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <Icon name={toast.kind === 'ok' ? 'check_circle' : 'error'} size={18} />
              {toast.text}
            </motion.div>
          )}
        </AnimatePresence>

        {tab === 'programs' && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <ProgramsSection />
          </motion.div>
        )}
        {tab === 'payments' && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <PaymentsSection />
          </motion.div>
        )}
        {tab === 'courses' && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <CoursesSection />
          </motion.div>
        )}
        {tab === 'interactions' && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <InteractionsHistory />
          </motion.div>
        )}
        {tab === 'home' && (
          <>
            {/* Поздравление при зачислении. Статус матчим списком, а не
                литералом: до миграции у зачисленного лежит ENROLLED, после —
                SUCCESSFUL_LEAD (см. applicationStatus.ts). */}
            {isFinishedApplicationStatus(me.applications?.[0]?.status) && (
              <motion.div
                className="stu-celebrate"
                initial={{ opacity: 0, scale: 0.9, y: -20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 200, damping: 18 }}
              >
                <div className="stu-confetti" aria-hidden="true">
                  {Array.from({ length: 24 }).map((_, i) => {
                    const colors = ['#f59e0b', '#ef4444', '#01368B', '#3b82f6', '#a855f7', '#ec4899'];
                    const left = Math.random() * 100;
                    const delay = Math.random() * 1.5;
                    const dur = 2 + Math.random() * 2;
                    const size = 6 + Math.random() * 8;
                    return (
                      <motion.span
                        key={i}
                        className="stu-confetti-piece"
                        style={{
                          left: `${left}%`,
                          width: size,
                          height: size,
                          background: colors[i % colors.length],
                        }}
                        initial={{ y: -20, opacity: 0, rotate: 0 }}
                        animate={{
                          y: 220,
                          opacity: [0, 1, 1, 0],
                          rotate: 360,
                        }}
                        transition={{
                          duration: dur,
                          delay,
                          repeat: Infinity,
                          ease: 'easeIn',
                        }}
                      />
                    );
                  })}
                </div>
                <motion.div
                  className="stu-celebrate-icon"
                  animate={{ rotate: [0, -10, 10, -10, 10, 0], scale: [1, 1.15, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity }}
                >
                  🎉
                </motion.div>
                <div>
                  <motion.div
                    className="stu-celebrate-title"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    Бо қабулшавӣ табрик мекунем! 🎓
                  </motion.div>
                  <motion.div
                    className="stu-celebrate-sub"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4 }}
                  >
                    Шумо расман ба донишгоҳ қабул шудед. Ин қадами бузург аст — орзуи шумо воқеӣ шуд!
                    Менеҷер шахсан бо шумо тамос мегирад, то қадамҳои навбатиро муҳокима кунад.
                  </motion.div>
                </div>
              </motion.div>
            )}

            {/* Прогресс поступления */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <EnrollmentProgress
                currentStatus={me.applications?.[0]?.status}
              />
            </motion.div>
          </>
        )}

        {tab === 'home' && (<>
        {/* Профиль */}
        <motion.section
          className="stu-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
        >
          <div className="stu-profile">
            <div className="stu-photo">
              {me.photoUrl ? (
                <img src={`${API_BASE}${me.photoUrl}`} alt="" />
              ) : (
                <Icon name="person" size={60} />
              )}
            </div>
            <div className="stu-profile-info">
              <h1 className="stu-profile-name">{me.fullName}</h1>
              <div className="stu-badges">
                <span className="stu-badge">{DIRECTION_LABEL[me.direction]}</span>
                <span className="stu-badge">Кабинети №{me.cabinet}</span>
                <span className={`stu-badge stu-status-${me.status.toLowerCase()}`}>
                  {STATUS_LABEL[me.status]}
                </span>
              </div>
              <div className="stu-profile-grid">
                <div><span>Почтаи электронӣ:</span> <b>{me.email}</b></div>
                <div><span>Телефонҳо:</span> <b>{me.phones.join(', ') || '—'}</b></div>
              </div>
            </div>
          </div>
        </motion.section>

        {/* Менеджеры */}
        <motion.section
          className="stu-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <h2 className="stu-section-title">Менеҷерони шумо</h2>
          <div className="stu-managers">
            <div className={`stu-manager-slot${!me.manager ? ' empty' : ''}`}>
              <div className="stu-manager-flag">🇹🇯 Тоҷикистон</div>
              <div className="stu-manager-name">
                {me.manager?.fullName || 'Ҳанӯз таъин нашудааст'}
              </div>
              {me.manager?.email && (
                <a href={`mailto:${me.manager.email}`} className="stu-manager-email">
                  <Icon name="mail" size={14} /> {me.manager.email}
                </a>
              )}
            </div>
            <div className={`stu-manager-slot${!me.chinaManager ? ' empty' : ''}`}>
              <div className="stu-manager-flag">🇨🇳 Хитой</div>
              <div className="stu-manager-name">
                {me.chinaManager?.fullName || 'Ҳанӯз таъин нашудааст'}
              </div>
              {me.chinaManager?.email && (
                <a href={`mailto:${me.chinaManager.email}`} className="stu-manager-email">
                  <Icon name="mail" size={14} /> {me.chinaManager.email}
                </a>
              )}
            </div>
          </div>
        </motion.section>

        {/* Документы */}
        <motion.section
          className="stu-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <h2 className="stu-section-title">Ҳуҷҷатҳо</h2>

          <div className="stu-note">
            <Icon name="info" size={18} />
            <div>
              Ҳамаи ҳуҷҷатҳоро бояд <b>ба забони англисӣ тарҷума</b> ва <b>нотариалӣ тасдиқ</b> кард.
              Дар ҳар шакл бор кунед — менеҷер месанҷад.
            </div>
          </div>

          <div className="stu-progress">
            <div className="stu-progress-text">
              <span>Бор карда шуд <b>{uploaded}</b> аз {REQUIRED_DOCS.length}</span>
              <span className="stu-progress-percent">{percent}%</span>
            </div>
            <div className="stu-progress-bar">
              <motion.div
                className="stu-progress-fill"
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
          </div>

          <div className="stu-docs-grid">
            {REQUIRED_DOCS.map((req) => {
              const docs = typed.filter((d) => d.type === req.type);
              const loading = uploading === req.type;
              const hasAny = docs.length > 0;
              return (
                <div key={req.type} className={`stu-doc${hasAny ? ' uploaded' : ''}`}>
                  <div className="stu-doc-head">
                    <Icon
                      name={hasAny ? 'check_circle' : 'radio_button_unchecked'}
                      size={20}
                      style={{ color: hasAny ? '#01368B' : '#9ca3af' }}
                    />
                    <div>
                      <div className="stu-doc-label">
                        {req.label}
                        {docs.length > 1 && <span style={{ color: '#9ca3af' }}> · {docs.length}</span>}
                      </div>
                      {req.hint && <div className="stu-doc-hint">{req.hint}</div>}
                    </div>
                  </div>
                  {hasAny ? (
                    <>
                      {docs.map((doc) => (
                        <div key={doc.id} className="stu-doc-file">
                          <a href={`${API_BASE}${doc.url}`} target="_blank" rel="noreferrer">
                            <Icon name="description" size={16} /> {doc.originalName}
                          </a>
                          <div className="stu-doc-meta">
                            {fmtBytes(doc.size)} · {new Date(doc.createdAt).toLocaleDateString('ru-RU')}
                          </div>
                          <div className="stu-doc-actions">
                            <button
                              className="btn btn-danger btn-small"
                              onClick={() => onDelete(doc.id)}
                            >
                              <Icon name="delete" size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        className="btn btn-outline btn-small"
                        style={{ marginTop: 8 }}
                        onClick={() => inputs.current[req.type]?.click()}
                        disabled={loading}
                      >
                        <Icon name={loading ? 'progress_activity' : 'add'} size={14} />
                        {loading ? 'Боркунӣ...' : 'Боз илова кардан'}
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-primary btn-small stu-doc-upload"
                      onClick={() => inputs.current[req.type]?.click()}
                      disabled={loading}
                    >
                      <Icon name={loading ? 'progress_activity' : 'upload'} size={16} />
                      {loading ? 'Боркунӣ...' : 'Бор кардан'}
                    </button>
                  )}
                  <input
                    ref={(el) => { inputs.current[req.type] = el; }}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => onUpload(e, req.type)}
                  />
                </div>
              );
            })}
          </div>

          <div className="stu-other">
            <h3>Файлҳои дигар</h3>
            {other.length === 0 ? (
              <div className="stu-empty">Ҳоло ҳуҷҷатҳои дигар нест</div>
            ) : (
              <div className="stu-other-list">
                {other.map((d) => (
                  <div key={d.id} className="stu-other-item">
                    <a href={`${API_BASE}${d.url}`} target="_blank" rel="noreferrer">
                      <Icon name="description" size={16} /> {d.originalName}
                    </a>
                    <button className="btn btn-danger btn-small" onClick={() => onDelete(d.id)}>
                      <Icon name="delete" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              className="btn btn-outline btn-small"
              style={{ marginTop: 10 }}
              onClick={() => otherRef.current?.click()}
              disabled={uploading === 'OTHER'}
            >
              <Icon name="attach_file" size={14} /> Файли дигар бор кардан
            </button>
            <input ref={otherRef} type="file" hidden onChange={(e) => onUpload(e, 'OTHER')} />
          </div>
        </motion.section>

        {/* Анкета */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
        >
          <ApplicationFormSection />
        </motion.div>
        </>)}
      </main>

      {/* Красивая модалка подтверждения удаления документа */}
      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setConfirmDelete(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(8, 11, 24, 0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 9999, backdropFilter: 'blur(4px)',
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 18, padding: 28, width: 'min(420px, 90vw)',
                boxShadow: '0 24px 60px rgba(0, 0, 0, 0.25)',
              }}
            >
              <div style={{
                width: 48, height: 48, borderRadius: '50%',
                background: 'rgba(220, 38, 38, 0.12)', color: '#dc2626',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16,
              }}>
                <Icon name="delete" size={24} />
              </div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 8 }}>
                Ҳуҷҷат нест карда шавад?
              </h3>
              <p style={{ color: 'var(--text-soft)', fontSize: 14, marginBottom: 22 }}>
                Файл бебозгашт нест карда мешавад. Ин амалро бекор кардан мумкин нест.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn-pill ghost"
                  onClick={() => setConfirmDelete(null)}
                >
                  Бекор кардан
                </button>
                <button
                  className="btn-pill"
                  style={{ background: '#dc2626', color: 'white' }}
                  onClick={() => {
                    deleteDocMut.mutate(confirmDelete);
                    setConfirmDelete(null);
                  }}
                >
                  Нест кардан
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
