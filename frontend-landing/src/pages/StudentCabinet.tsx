import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
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

const DIRECTION_LABEL: Record<string, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Активный',
  PAUSED: 'На паузе',
  GRADUATED: 'Выпустился',
  ARCHIVED: 'В архиве',
};

const REQUIRED_DOCS = [
  { type: 'PHOTO', label: 'Фото 3/4', hint: 'В электронном формате' },
  { type: 'PASSPORT', label: 'Загран паспорт' },
  { type: 'BANK', label: 'Справка с банка' },
  { type: 'MEDICAL', label: 'Мед.справка (для Китая)' },
  { type: 'NO_CRIMINAL', label: 'Справка о несудимости' },
  { type: 'STUDY_PLAN', label: 'Study Plan (Мотивационное письмо)' },
  { type: 'CERTIFICATE', label: 'Certificate', hint: 'IELTS, TOEFL, DUOLINGO, HSK, CSCA (если есть)' },
  { type: 'PARENTS_PASSPORT', label: 'Паспорт родителей' },
  { type: 'DIPLOMA', label: 'Аттестат', hint: 'Или табель оценок + справка со школы' },
  { type: 'RECOMMENDATION', label: 'Рекомендательное письмо' },
];

const fmtBytes = (b: number) => {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  return `${(b / 1024 / 1024).toFixed(2)} МБ`;
};

export default function StudentCabinet() {
  const navigate = useNavigate();
  const [me, setMe] = useState<StudentMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tab, setTab] = useState<'home' | 'programs' | 'payments' | 'courses' | 'interactions'>('home');
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
    load(true); // первый заход — показать спиннер
  }, []);

  useStudentRealtime({
    'student:updated': () => load(),
    'document:uploaded': () => load(),
    'document:deleted': () => load(),
    'application:updated': () => load(),
  });

  const load = async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const data = await studentMe();
      setMe(data);
    } catch {
      clearToken();
      navigate('/login', { replace: true });
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const logout = () => {
    clearToken();
    navigate('/login');
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: string) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(type);
    try {
      for (const file of files) {
        await studentUploadDocument(file, type);
      }
      showToast('ok', files.length > 1 ? `Загружено: ${files.length}` : 'Документ загружен');
      await load();
    } catch (err: any) {
      showToast('err', err?.response?.data?.message || 'Ошибка загрузки');
    } finally {
      setUploading(null);
      e.target.value = '';
    }
  };

  const onDelete = async (docId: string) => {
    if (!confirm('Удалить документ?')) return;
    try {
      await studentDeleteDocument(docId);
      showToast('ok', 'Документ удалён');
      await load();
    } catch (err: any) {
      showToast('err', err?.response?.data?.message || 'Ошибка');
    }
  };

  if (loading || !me) {
    return <div className="stu-loading">Загрузка...</div>;
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
              Sign out
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
            Главная
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'programs' ? ' active' : ''}`}
            onClick={() => setTab('programs')}
          >
            <Icon name="menu_book" size={18} />
            Программы
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'payments' ? ' active' : ''}`}
            onClick={() => setTab('payments')}
          >
            <Icon name="payments" size={18} />
            Оплаты
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'courses' ? ' active' : ''}`}
            onClick={() => setTab('courses')}
          >
            <Icon name="school" size={18} />
            Курсы
          </button>
          <button
            type="button"
            className={`stu-tab${tab === 'interactions' ? ' active' : ''}`}
            onClick={() => setTab('interactions')}
          >
            <Icon name="forum" size={18} />
            Общение
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
            {/* Поздравление при зачислении */}
            {me.applications?.[0]?.status === 'ENROLLED' && (
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
                    Поздравляем с зачислением! 🎓
                  </motion.div>
                  <motion.div
                    className="stu-celebrate-sub"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4 }}
                  >
                    Вы официально зачислены в университет. Это огромный шаг — ваша мечта стала реальностью!
                    Менеджер свяжется с вами лично, чтобы обсудить следующие шаги.
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
                <span className="stu-badge">Кабинет №{me.cabinet}</span>
                <span className={`stu-badge stu-status-${me.status.toLowerCase()}`}>
                  {STATUS_LABEL[me.status]}
                </span>
              </div>
              <div className="stu-profile-grid">
                <div><span>Email:</span> <b>{me.email}</b></div>
                <div><span>Телефоны:</span> <b>{me.phones.join(', ') || '—'}</b></div>
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
          <h2 className="stu-section-title">Ваши менеджеры</h2>
          <div className="stu-managers">
            <div className={`stu-manager-slot${!me.manager ? ' empty' : ''}`}>
              <div className="stu-manager-flag">🇹🇯 Таджикистан</div>
              <div className="stu-manager-name">
                {me.manager?.fullName || 'Ещё не назначен'}
              </div>
              {me.manager?.email && (
                <a href={`mailto:${me.manager.email}`} className="stu-manager-email">
                  <Icon name="mail" size={14} /> {me.manager.email}
                </a>
              )}
            </div>
            <div className={`stu-manager-slot${!me.chinaManager ? ' empty' : ''}`}>
              <div className="stu-manager-flag">🇨🇳 Китай</div>
              <div className="stu-manager-name">
                {me.chinaManager?.fullName || 'Ещё не назначен'}
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
          <h2 className="stu-section-title">Документы</h2>

          <div className="stu-note">
            <Icon name="info" size={18} />
            <div>
              Все документы нужно <b>перевести на английский</b> и <b>нотариально заверить</b>.
              Загружайте в любом формате — менеджер проверит.
            </div>
          </div>

          <div className="stu-progress">
            <div className="stu-progress-text">
              <span>Загружено <b>{uploaded}</b> из {REQUIRED_DOCS.length}</span>
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
                        {loading ? 'Загрузка...' : 'Добавить ещё'}
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-primary btn-small stu-doc-upload"
                      onClick={() => inputs.current[req.type]?.click()}
                      disabled={loading}
                    >
                      <Icon name={loading ? 'progress_activity' : 'upload'} size={16} />
                      {loading ? 'Загрузка...' : 'Загрузить'}
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
            <h3>Другие файлы</h3>
            {other.length === 0 ? (
              <div className="stu-empty">Пока нет других документов</div>
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
              <Icon name="attach_file" size={14} /> Загрузить другой файл
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
    </div>
  );
}
