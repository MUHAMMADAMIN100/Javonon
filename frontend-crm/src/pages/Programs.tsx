import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createProgram, deleteProgram, listPrograms, programImageUrl, updateProgram, uploadProgramImage, type Program } from '../api/programs';
import type { Direction } from '../api/types';
import { DIRECTION_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import DirectionOptions from '../components/DirectionOptions';
import { compose, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';
import { keys } from '../lib/queryKeys';
import { optimistic, useInvalidatingMutation, useOptimisticMutation } from '../lib/optimistic';
import Loading from '../components/Loading';
import { isElevated } from '../lib/roles';

// Допускаем кириллицу и латиницу в названиях программ/университетов
// (по запросу основателя — пишут на русском тоже). Защита только от
// HTML-тегов и фигурных скобок (XSS / template-injection в audit логи).
const safeText = (s: string) => s.replace(/[<>{}[\]\\]/g, '');

// Helpers для markdown-кнопок описания. Оборачивают / вставляют
// маркеры в конце текущего value (без работы с курсором — простой UX).
function wrapDescription(
  editing: any,
  setEditing: (v: any) => void,
  open: string,
  close: string,
) {
  const cur = editing?.description || '';
  setEditing({ ...editing, description: `${cur}${open}текст${close}` });
}
function insertDescription(
  editing: any,
  setEditing: (v: any) => void,
  snippet: string,
) {
  const cur = editing?.description || '';
  setEditing({ ...editing, description: `${cur}${snippet}` });
}

const LANGUAGES = [
  'English',
  'Chinese',
  'Russian',
  'Tajik',
  'Japanese',
  'Korean',
  'German',
  'French',
  'Spanish',
  'Italian',
  'Turkish',
  'Arabic',
  'Multiple',
];

const emptyForm: Partial<Program> = {
  name: '',
  university: '',
  city: '',
  major: '',
  direction: 'BACHELOR',
  cost: 0,
  currency: 'CNY',
  duration: '',
  language: '',
  description: '',
  published: true,
  englishLevel: '',
  hasGrant: false,
  grantDetails: '',
  grantEnglishLevel: '',
  avgAdmissionScore: '',
  applicationDeadline: '',
  intakesPerYear: undefined,
};

export default function Programs() {
  const me = useAuth((s) => s.user);
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const isAdmin = isElevated(me);
  const [city, setCity] = useState('');
  const [major, setMajor] = useState('');
  const [direction, setDirection] = useState<Direction | ''>('');
  const [debounced, setDebounced] = useState({ city: '', major: '', direction: '' as Direction | '' });
  const [editing, setEditing] = useState<Partial<Program> | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    };
  }, [pendingPreview]);

  // Debounce фильтров (300ms): не дёргать сервер на каждое нажатие.
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ city, major, direction }), 300);
    return () => clearTimeout(t);
  }, [city, major, direction]);

  const openCreate = () => {
    setPendingImage(null);
    setPendingPreview(null);
    setEditing({ ...emptyForm });
  };

  const closeEditor = () => {
    setEditing(null);
    setPendingImage(null);
    if (pendingPreview) {
      URL.revokeObjectURL(pendingPreview);
      setPendingPreview(null);
    }
  };

  const filters = {
    city: debounced.city || undefined,
    major: debounced.major || undefined,
    direction: debounced.direction || undefined,
  };
  const listKey = keys.programs.list();
  const filteredKey = ['programs', 'list', filters] as const;
  const programsQuery = useQuery({
    queryKey: filteredKey,
    queryFn: () => listPrograms(filters),
  });
  const items = programsQuery.data ?? [];
  const loading = programsQuery.isLoading;

  useRealtime({
    'program:new': () => qc.invalidateQueries({ queryKey: keys.programs.all }),
    'program:updated': () => qc.invalidateQueries({ queryKey: keys.programs.all }),
    'program:deleted': () => qc.invalidateQueries({ queryKey: keys.programs.all }),
  });

  const saveMut = useInvalidatingMutation({
    mutationFn: async (vars: { editing: Partial<Program>; pendingImage: File | null }) => {
      const payload = {
        ...vars.editing,
        cost: typeof vars.editing.cost === 'string' ? parseFloat(vars.editing.cost) : vars.editing.cost,
      };
      if (vars.editing.id) {
        return updateProgram(vars.editing.id, payload);
      }
      return createProgram(payload, vars.pendingImage);
    },
    invalidate: [keys.programs.all],
    onSuccess: (_data, vars) => {
      toast(vars.editing.id ? 'Программа обновлена' : 'Программа создана', 'success');
      closeEditor();
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка сохранения', 'error'),
  });
  const saving = saveMut.isPending;

  const deleteMut = useOptimisticMutation<unknown, string, Program[]>({
    mutationFn: deleteProgram,
    queryKey: filteredKey,
    applyOptimistic: (cur, id) => optimistic.removeById(cur, id),
    invalidateAlso: [keys.programs.all],
    onSuccess: () => toast('Программа удалена', 'success'),
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const uploadImageMut = useInvalidatingMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => uploadProgramImage(id, file),
    invalidate: [keys.programs.all],
    onSuccess: (data) => {
      setEditing((cur) => (cur ? { ...cur, imageUrl: data.imageUrl } : cur));
      toast('Картинка загружена', 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка загрузки', 'error'),
    onSettled: () => {
      setUploadingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = '';
    },
  });

  // ТЗ-доработка: обязательные ТОЛЬКО name + university. Город/специальность/
  // стоимость могут быть пустыми (бесплатная программа, несколько кампусов,
  // ещё не определено). Cost может быть 0 — не блокируем.
  const formErrors = editing
    ? validateAll(
        {
          name: editing.name || '',
          university: editing.university || '',
          city: editing.city || '',
          major: editing.major || '',
          cost: editing.cost ?? '',
        },
        {
          name: compose(required('Введите название'), minLen(2), maxLen(200)),
          university: compose(required('Введите университет'), minLen(2), maxLen(200)),
          city: maxLen(100),
          major: maxLen(200),
          cost: numberRule({ min: 0, max: 10_000_000 }),
        },
      )
    : {};
  const formInvalid = hasErrors(formErrors);

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || formInvalid) return;
    saveMut.mutate({ editing, pendingImage });
  };

  const onPickImage = (file: File) => {
    if (editing?.id) {
      // существующая программа — грузим сразу через отдельный endpoint
      setUploadingImage(true);
      uploadImageMut.mutate({ id: editing.id, file });
    } else {
      // новая — держим в памяти, отправим вместе с создания
      setPendingImage(file);
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingPreview(URL.createObjectURL(file));
    }
  };

  const onDelete = async (p: Program) => {
    const ok = await confirm({
      title: 'Удалить программу',
      message: `«${p.name}» будет удалена. Студенты, привязанные к ней, останутся без программы.`,
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    deleteMut.mutate(p.id);
  };

  return (
    <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="card-header">
        <h2 className="card-title">Программы обучения</h2>
        {isAdmin && (
          <motion.button
            className="btn btn-primary"
            onClick={openCreate}
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.95 }}
          >
            <Icon name="add" size={16} style={{ marginRight: 4 }} /> Новая программа
          </motion.button>
        )}
      </div>
      <div className="card-body">
        <div className="filters">
          <input placeholder="Город" value={city} onChange={(e) => setCity(e.target.value)} />
          <input placeholder="Специальность" value={major} onChange={(e) => setMajor(e.target.value)} />
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="">Все направления</option>
            <DirectionOptions />
          </select>
        </div>

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <motion.div key="e" className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="school" size={48} /></div>
              Программ пока нет
            </motion.div>
          ) : (
            <motion.div key="g" className="programs-grid" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}>
              {items.map((p) => (
                <motion.div
                  key={p.id}
                  className={`program-card${!p.published ? ' unpublished' : ''}`}
                  variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
                  whileHover={{ y: -4 }}
                >
                  {p.imageUrl ? (
                    <div className="program-card-img">
                      <img
                        src={programImageUrl(p.imageUrl)!}
                        alt={p.name}
                        onError={(e) => {
                          // QA-fix #4: при сломанной картинке не показывать
                          // "broken image" — спрятать <img>, родитель сам
                          // нарисует градиент-fallback с буквой.
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                          (e.currentTarget.parentElement as HTMLElement).classList.add('fallback');
                        }}
                      />
                      <span className="program-card-img-fallback">
                        {(p.name || '?').charAt(0).toUpperCase()}
                      </span>
                    </div>
                  ) : (
                    <div className="program-card-img fallback">
                      <span className="program-card-img-fallback">
                        {(p.name || '?').charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div className="program-card-head">
                    <div>
                      <div className="program-card-name">{p.name}</div>
                      <div className="program-card-uni">{p.university}</div>
                    </div>
                    {isAdmin && (
                      <div className="program-card-actions">
                        <button className="btn btn-sm btn-secondary" onClick={() => setEditing({ ...p })}>
                          <Icon name="edit" size={14} />
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => onDelete(p)}>
                          <Icon name="delete" size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="program-card-meta">
                    <span><Icon name="location_on" size={14} /> {p.city}</span>
                    <span><Icon name="menu_book" size={14} /> {DIRECTION_LABEL[p.direction]}</span>
                    <span><Icon name="school" size={14} /> {p.major}</span>
                    {p.duration && <span><Icon name="schedule" size={14} /> {p.duration}</span>}
                    {p.language && <span><Icon name="translate" size={14} /> {p.language}</span>}
                    {p.englishLevel && <span><Icon name="record_voice_over" size={14} /> {p.englishLevel}</span>}
                    {p.avgAdmissionScore && <span><Icon name="grade" size={14} /> {p.avgAdmissionScore}</span>}
                    {p.applicationDeadline && <span><Icon name="event" size={14} /> {p.applicationDeadline}</span>}
                    {typeof p.intakesPerYear === 'number' && <span><Icon name="repeat" size={14} /> {p.intakesPerYear}× в год</span>}
                  </div>
                  {p.hasGrant && (
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: '#dcfce7', color: '#15803d', borderRadius: 999,
                      padding: '3px 10px', fontSize: 12, fontWeight: 600, marginTop: 6,
                    }}>
                      🎓 Грант{p.grantDetails ? ` · ${p.grantDetails}` : ''}
                    </div>
                  )}
                  <div className="program-card-cost">
                    {p.cost ? `${p.cost.toLocaleString('ru-RU')} ${p.currency}` : 'Бесплатно / уточняется'}
                    {p.cost ? <span> / год</span> : null}
                  </div>
                  {p.universityWebsiteUrl && (
                    <a
                      href={p.universityWebsiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="btn btn-sm btn-secondary"
                      style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      🌐 Официальный сайт
                    </a>
                  )}
                  {!p.published && <div className="program-card-draft">Скрыто на лендинге</div>}
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Модалка редактирования */}
      <AnimatePresence>
        {editing && (
          <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !saving && closeEditor()}>
            <motion.form
              className="dialog-card"
              style={{ maxWidth: 640, textAlign: 'left' }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              onClick={(e) => e.stopPropagation()}
              onSubmit={onSave}
            >
              <div className="dialog-title" style={{ textAlign: 'left', marginBottom: 14 }}>
                {editing.id ? 'Редактировать программу' : 'Новая программа'}
              </div>
              <div className="form-group">
                <label>Название программы *</label>
                <input
                  value={editing.name || ''}
                  onChange={(e) => setEditing({ ...editing, name: safeText(e.target.value) })}
                  className={formErrors.name ? 'input-error' : ''}
                  maxLength={200}
                  placeholder="Erasmus Mundus Joint Masters / Совместная магистратура"
                  required
                />
                {formErrors.name && <div className="form-error-text">{formErrors.name}</div>}
              </div>
              <div className="form-grid-2">
                <div className="form-group">
                  <label>Университет *</label>
                  <input
                    value={editing.university || ''}
                    onChange={(e) => setEditing({ ...editing, university: safeText(e.target.value) })}
                    className={formErrors.university ? 'input-error' : ''}
                    maxLength={200}
                    placeholder="Tsinghua University / МГУ"
                    required
                  />
                  {formErrors.university && <div className="form-error-text">{formErrors.university}</div>}
                </div>
                <div className="form-group">
                  <label>Город</label>
                  <input
                    value={editing.city || ''}
                    onChange={(e) => setEditing({ ...editing, city: safeText(e.target.value) })}
                    className={formErrors.city ? 'input-error' : ''}
                    maxLength={100}
                    placeholder="Пекин / Beijing / 北京"
                  />
                  {formErrors.city && <div className="form-error-text">{formErrors.city}</div>}
                </div>
                <div className="form-group">
                  <label>Специальность</label>
                  <input
                    value={editing.major || ''}
                    onChange={(e) => setEditing({ ...editing, major: safeText(e.target.value) })}
                    className={formErrors.major ? 'input-error' : ''}
                    maxLength={200}
                    placeholder="Информатика / Computer Science"
                  />
                  {formErrors.major && <div className="form-error-text">{formErrors.major}</div>}
                </div>
                <div className="form-group">
                  <label>Направление *</label>
                  <select value={editing.direction} onChange={(e) => setEditing({ ...editing, direction: e.target.value as Direction })}>
                    <DirectionOptions />
                  </select>
                </div>
                <div className="form-group">
                  <label>Стоимость / год</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={editing.cost as any ?? ''}
                    onChange={(e) => setEditing({ ...editing, cost: e.target.value === '' ? undefined : Number(e.target.value) })}
                    className={formErrors.cost ? 'input-error' : ''}
                    placeholder="0 = бесплатная / уточняется"
                  />
                  {formErrors.cost && <div className="form-error-text">{formErrors.cost}</div>}
                </div>
                <div className="form-group">
                  <label>Валюта</label>
                  <select value={editing.currency || 'CNY'} onChange={(e) => setEditing({ ...editing, currency: e.target.value })}>
                    <option value="CNY">CNY (юань)</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR (евро)</option>
                    <option value="KRW">KRW (вона)</option>
                    <option value="JPY">JPY (йена)</option>
                    <option value="GBP">GBP (фунт)</option>
                    <option value="CAD">CAD (канадский $)</option>
                    <option value="MYR">MYR (ринггит)</option>
                    <option value="RUB">RUB</option>
                    <option value="TJS">TJS</option>
                    <option value="KZT">KZT</option>
                    <option value="UZS">UZS</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Длительность</label>
                  <input value={editing.duration || ''} placeholder="4 года" onChange={(e) => setEditing({ ...editing, duration: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Язык обучения</label>
                  <select
                    value={editing.language || ''}
                    onChange={(e) => setEditing({ ...editing, language: e.target.value })}
                  >
                    <option value="">— Выберите язык —</option>
                    {LANGUAGES.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Расширенные поля каталога */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <div className="form-group">
                  <label>Уровень английского</label>
                  <input
                    value={editing.englishLevel || ''}
                    placeholder="IELTS 6.0 / HSK 4 / —"
                    onChange={(e) => setEditing({ ...editing, englishLevel: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Средний проходной балл</label>
                  <input
                    value={editing.avgAdmissionScore || ''}
                    placeholder="GPA 3.0 / 80%"
                    onChange={(e) => setEditing({ ...editing, avgAdmissionScore: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Дедлайн подачи</label>
                  <input
                    value={editing.applicationDeadline || ''}
                    placeholder="1 марта / круглый год"
                    onChange={(e) => setEditing({ ...editing, applicationDeadline: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Наборов в год</label>
                  <input
                    type="number"
                    min={0}
                    max={12}
                    value={editing.intakesPerYear ?? ''}
                    placeholder="2"
                    onChange={(e) => setEditing({ ...editing, intakesPerYear: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </div>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
                  <input
                    type="checkbox"
                    checked={!!editing.hasGrant}
                    onChange={(e) => setEditing({ ...editing, hasGrant: e.target.checked })}
                  />
                  Есть грант / стипендия
                </label>
              </div>
              {editing.hasGrant && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                  <div className="form-group">
                    <label>Что покрывает грант</label>
                    <input
                      value={editing.grantDetails || ''}
                      placeholder="Обучение + проживание + стипендия"
                      onChange={(e) => setEditing({ ...editing, grantDetails: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Уровень англ. для гранта</label>
                    <input
                      value={editing.grantEnglishLevel || ''}
                      placeholder="IELTS 6.5"
                      onChange={(e) => setEditing({ ...editing, grantEnglishLevel: e.target.value })}
                    />
                  </div>
                </div>
              )}

              <div className="form-group">
                <label>Официальный сайт университета</label>
                <input
                  type="url"
                  value={editing.universityWebsiteUrl || ''}
                  placeholder="https://www.tsinghua.edu.cn"
                  onChange={(e) => setEditing({ ...editing, universityWebsiteUrl: e.target.value.trim() })}
                />
                <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                  Просто вставь URL — на карточке кнопка «🌐 Официальный сайт» появится сама.
                </div>
              </div>
              <div className="form-group">
                <label>Описание</label>
                <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                  <button type="button" className="btn btn-sm btn-secondary" title="Жирный"
                    onClick={() => wrapDescription(editing, setEditing, '**', '**')}>
                    <b>Ж</b>
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" title="Курсив"
                    onClick={() => wrapDescription(editing, setEditing, '*', '*')}>
                    <i>К</i>
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" title="Маркированный список"
                    onClick={() => insertDescription(editing, setEditing, '\n- ')}>
                    • Список
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" title="Ссылка"
                    onClick={() => insertDescription(editing, setEditing, '[текст](https://)')}>
                    🔗 Ссылка
                  </button>
                </div>
                <textarea
                  rows={10}
                  style={{ minHeight: 250, fontFamily: 'inherit', resize: 'vertical' }}
                  value={editing.description || ''}
                  placeholder={`Подробное описание программы.\n\nПоддерживается markdown: **жирный**, *курсив*, - список, [ссылка](https://...)`}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>Картинка программы</label>
                <div className="program-image-uploader">
                  {(pendingPreview || editing.imageUrl) && (
                    <div className="program-image-preview">
                      <img
                        src={pendingPreview || programImageUrl(editing.imageUrl)!}
                        alt=""
                      />
                    </div>
                  )}
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onPickImage(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={uploadingImage}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <Icon name="image" size={16} style={{ marginRight: 6 }} />
                    {uploadingImage
                      ? 'Загружаем...'
                      : pendingPreview || editing.imageUrl
                        ? 'Заменить'
                        : 'Загрузить'}
                  </button>
                  {!editing.id && pendingImage && (
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>
                      Картинка отправится вместе с программой при сохранении.
                    </div>
                  )}
                </div>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
                  <input type="checkbox" checked={editing.published !== false} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} />
                  Показывать на лендинге
                </label>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={closeEditor} disabled={saving}>Отмена</button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || formInvalid}
                  title={formInvalid ? 'Исправьте ошибки в форме' : ''}
                >
                  {saving ? 'Сохраняем...' : 'Сохранить'}
                </button>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
