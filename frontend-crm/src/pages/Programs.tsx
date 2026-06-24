import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProgram, deleteProgram, listPrograms, programImageUrl,
  updateProgram, uploadProgramImage, uploadProgramGalleryImage,
  removeProgramGalleryImage,
  listProgramScholarships, addProgramScholarship, updateProgramScholarship,
  deleteProgramScholarship,
  type Program, type ProgramScholarship,
} from '../api/programs';
import type { Direction } from '../api/types';
import { DIRECTION_LABEL } from '../api/types';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import { useRealtime } from '../realtime';
import Icon from '../Icon';
import DirectionOptions from '../components/DirectionOptions';
import { compose, hasErrors, maxLen, minLen, numberRule, required, validateAll } from '../utils/validators';
import { useT } from '../lib/i18n';
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
  const { t } = useT();
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
  const allItems = programsQuery.data ?? [];
  // ТЗ-доработка п.9: фильтр по странам (таб-бар сверху).
  const [countryFilter, setCountryFilter] = useState<string>('');
  const countries = useMemo(() => {
    const set = new Set<string>();
    for (const p of allItems) {
      if (p.country) set.add(p.country);
    }
    return Array.from(set).sort();
  }, [allItems]);
  const items = countryFilter
    ? allItems.filter((p) => p.country === countryFilter)
    : allItems;
  const navigate = useNavigate();
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
        <h2 className="card-title">{t('programs.title')}</h2>
        {isAdmin && (
          <motion.button
            className="btn btn-primary"
            onClick={openCreate}
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.95 }}
          >
            <Icon name="add" size={16} style={{ marginRight: 4 }} /> {t('programs.new')}
          </motion.button>
        )}
      </div>
      <div className="card-body">
        <div className="filters">
          <input placeholder={t('programs.filter.city')} value={city} onChange={(e) => setCity(e.target.value)} />
          <input placeholder={t('programs.filter.major')} value={major} onChange={(e) => setMajor(e.target.value)} />
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="">{t('programs.filter.direction')}</option>
            <DirectionOptions />
          </select>
        </div>

        {/* Таб-бар по странам (ТЗ-доработка п.9). Показываем только если
            у программ заданы страны — иначе бесполезно. */}
        {countries.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            <button
              className={`btn btn-sm ${countryFilter === '' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setCountryFilter('')}
            >
              {t('programs.all')} ({allItems.length})
            </button>
            {countries.map((c) => {
              const count = allItems.filter((p) => p.country === c).length;
              return (
                <button
                  key={c}
                  className={`btn btn-sm ${countryFilter === c ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setCountryFilter(c)}
                >
                  {c} ({count})
                </button>
              );
            })}
          </div>
        )}

        <AnimatePresence mode="wait">
          {loading ? (
            <Loading />
          ) : items.length === 0 ? (
            <motion.div key="e" className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="empty-icon"><Icon name="school" size={48} /></div>
              {t('programs.empty')}
            </motion.div>
          ) : (
            <motion.div key="g" className="programs-grid" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}>
              {items.map((p) => (
                <motion.div
                  key={p.id}
                  className={`program-card${!p.published ? ' unpublished' : ''}`}
                  variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
                  whileHover={{ y: -4 }}
                  onClick={() => navigate(`/programs/${p.id}`)}
                  style={{ cursor: 'pointer' }}
                >
                  {(p.imageUrl || (p.imageUrls && p.imageUrls[0])) ? (
                    <div className="program-card-img">
                      <img
                        src={programImageUrl(p.imageUrl || p.imageUrls![0])!}
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
                      <div className="program-card-actions" onClick={(e) => e.stopPropagation()}>
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
                {editing.id ? t('programs.edit') : t('programs.new')}
              </div>
              <div className="form-group">
                <label>{t('programs.field.name')} *</label>
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
                  <label>{t('programs.field.university')} *</label>
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
                  <label>{t('programs.field.country')}</label>
                  <input
                    value={editing.country || ''}
                    onChange={(e) => setEditing({ ...editing, country: safeText(e.target.value) })}
                    maxLength={100}
                    placeholder="США / Китай / Корея / Канада / ..."
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.city')}</label>
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
                  <label>{t('programs.field.major')}</label>
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
                  <label>{t('programs.field.direction')}</label>
                  <select value={editing.direction} onChange={(e) => setEditing({ ...editing, direction: e.target.value as Direction })}>
                    <DirectionOptions />
                  </select>
                </div>
                <div className="form-group">
                  <label>{t('programs.field.cost')}</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={editing.cost as any ?? ''}
                    onChange={(e) => setEditing({ ...editing, cost: e.target.value === '' ? undefined : Number(e.target.value) })}
                    className={formErrors.cost ? 'input-error' : ''}
                    placeholder={t('programs.field.costHint')}
                  />
                  {formErrors.cost && <div className="form-error-text">{formErrors.cost}</div>}
                </div>
                <div className="form-group">
                  <label>{t('programs.field.currency')}</label>
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
                  <label>{t('programs.field.duration')}</label>
                  <input value={editing.duration || ''} placeholder="4 года" onChange={(e) => setEditing({ ...editing, duration: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.language')}</label>
                  <select
                    value={editing.language || ''}
                    onChange={(e) => setEditing({ ...editing, language: e.target.value })}
                  >
                    <option value="">{t('programs.field.languageEmpty')}</option>
                    {LANGUAGES.map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Расширенные поля каталога */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <div className="form-group">
                  <label>{t('programs.field.englishLevel')}</label>
                  <input
                    value={editing.englishLevel || ''}
                    placeholder="IELTS 6.0 / HSK 4 / —"
                    onChange={(e) => setEditing({ ...editing, englishLevel: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.avgScore')}</label>
                  <input
                    value={editing.avgAdmissionScore || ''}
                    placeholder="GPA 3.0 / 80%"
                    onChange={(e) => setEditing({ ...editing, avgAdmissionScore: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.deadline')}</label>
                  <input
                    value={editing.applicationDeadline || ''}
                    placeholder="1 марта / круглый год"
                    onChange={(e) => setEditing({ ...editing, applicationDeadline: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.intakes')}</label>
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

              {/* Академические направления — теги (ТЗ-доработка п.6). */}
              <div className="form-group">
                <label>{t('programs.field.disciplines')}</label>
                <TagsInput
                  value={editing.disciplines || []}
                  onChange={(next) => setEditing({ ...editing, disciplines: next })}
                  placeholder="Machine Learning, Robotics, ..."
                />
                <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                  {t('programs.field.disciplinesHint')}
                </div>
              </div>

              <div className="form-group">
                <label>{t('programs.field.website')}</label>
                <input
                  type="url"
                  value={editing.universityWebsiteUrl || ''}
                  placeholder="https://www.tsinghua.edu.cn"
                  onChange={(e) => setEditing({ ...editing, universityWebsiteUrl: e.target.value.trim() })}
                />
                <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                  {t('programs.field.websiteHint')}
                </div>
              </div>
              <div className="form-group">
                <label>{t('programs.field.description')}</label>
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
                <label>{t('programs.field.image')}</label>
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

              {/* Галерея фото — до 7 шт. (ТЗ-доработка п.4). Доступна только после
                  сохранения программы (нужен programId для upload). */}
              {editing.id && (
                <ProgramGallery
                  programId={editing.id}
                  imageUrls={editing.imageUrls || []}
                  onChange={(next) => setEditing({ ...editing, imageUrls: next })}
                />
              )}

              {/* Стипендии — после сохранения (нужен programId). */}
              {editing.id && (
                <ScholarshipsEditor programId={editing.id} />
              )}

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
                  <input type="checkbox" checked={editing.published !== false} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} />
                  {t('programs.field.published')}
                </label>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={closeEditor} disabled={saving}>{t('common.cancel')}</button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || formInvalid}
                  title={formInvalid ? 'Исправьте ошибки в форме' : ''}
                >
                  {saving ? t('common.loading') : t('common.save')}
                </button>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ===== Sub-компоненты =====

function TagsInput({
  value, onChange, placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    if (value.includes(t)) { setDraft(''); return; }
    onChange([...value, t]);
    setDraft('');
  };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {value.map((t) => (
          <span
            key={t}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 999,
              background: 'var(--bg-soft, #f1f5f9)', border: '1px solid var(--border)',
              fontSize: 13,
            }}
          >
            {t}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== t))}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#64748b' }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder || 'Введите и Enter'}
          maxLength={100}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-sm btn-secondary" onClick={add} disabled={!draft.trim()}>
          + Добавить
        </button>
      </div>
    </div>
  );
}

function ProgramGallery({
  programId, imageUrls, onChange,
}: {
  programId: string;
  imageUrls: string[];
  onChange: (next: string[]) => void;
}) {
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onPick = async (file: File) => {
    setUploading(true);
    try {
      const updated = await uploadProgramGalleryImage(programId, file);
      onChange(updated.imageUrls || []);
      toast('Фото добавлено', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка загрузки', 'error');
    } finally {
      setUploading(false);
    }
  };
  const onRemove = async (url: string) => {
    try {
      const updated = await removeProgramGalleryImage(programId, url);
      onChange(updated.imageUrls || []);
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };
  return (
    <div className="form-group">
      <label>Галерея фото ({imageUrls.length}/7)</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {imageUrls.map((u) => (
          <div key={u} style={{ position: 'relative', width: 120, height: 90 }}>
            <img
              src={programImageUrl(u)!}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }}
            />
            <button
              type="button"
              onClick={() => onRemove(u)}
              title="Удалить"
              style={{
                position: 'absolute', top: 4, right: 4,
                width: 24, height: 24, borderRadius: '50%',
                border: 'none', cursor: 'pointer',
                background: 'rgba(0,0,0,0.6)', color: 'white',
              }}
            >×</button>
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={() => inputRef.current?.click()}
        disabled={uploading || imageUrls.length >= 7}
      >
        {uploading ? 'Загружаем…' : imageUrls.length >= 7 ? 'Достигнут максимум (7)' : '+ Добавить фото'}
      </button>
    </div>
  );
}

function ScholarshipsEditor({ programId }: { programId: string }) {
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['program-scholarships', programId],
    queryFn: () => listProgramScholarships(programId),
  });
  const items = query.data ?? [];

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Partial<ProgramScholarship>>({});

  const onAdd = async () => {
    if (!draft.name?.trim()) return toast('Укажите название стипендии', 'error');
    try {
      await addProgramScholarship(programId, draft);
      setDraft({});
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['program-scholarships', programId] });
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };
  const onRemove = async (s: ProgramScholarship) => {
    const ok = await confirm({ title: 'Удалить стипендию?', message: s.name, danger: true });
    if (!ok) return;
    await deleteProgramScholarship(s.id);
    qc.invalidateQueries({ queryKey: ['program-scholarships', programId] });
  };

  return (
    <div className="form-group">
      <label>Стипендии / гранты ({items.length})</label>
      <div style={{ fontSize: 11, color: 'var(--text-soft)', marginBottom: 8 }}>
        Каждая стипендия отдельной строкой с деталями (название, покрытие, требования, дедлайн, ссылка).
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((s) => (
          <div key={s.id} style={{
            padding: 10, border: '1px solid var(--border)', borderRadius: 8,
            background: 'var(--bg-soft)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => onRemove(s)}>×</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
              {[
                s.coverage && `Покрытие: ${s.coverage}`,
                s.amount && `Сумма: ${s.amount}`,
                s.includes && `Включено: ${s.includes}`,
                s.requirements && `Требования: ${s.requirements}`,
                s.deadline && `Дедлайн: ${s.deadline}`,
              ].filter(Boolean).join(' · ')}
            </div>
            {s.link && (
              <a href={s.link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                🔗 {s.link}
              </a>
            )}
          </div>
        ))}
      </div>
      {creating ? (
        <div style={{
          padding: 12, marginTop: 8,
          border: '1px solid var(--primary)', borderRadius: 8, background: 'var(--bg-soft)',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
            <input placeholder="Название (CSC Scholarship)" value={draft.name || ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input placeholder="Покрытие (Полное / Частичное)" value={draft.coverage || ''}
              onChange={(e) => setDraft({ ...draft, coverage: e.target.value })} />
            <input placeholder="Сумма (5000 USD/год)" value={draft.amount || ''}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            <input placeholder="Что включено" value={draft.includes || ''}
              onChange={(e) => setDraft({ ...draft, includes: e.target.value })} />
            <input placeholder="Требования (GPA 3.5, IELTS 6.0)" value={draft.requirements || ''}
              onChange={(e) => setDraft({ ...draft, requirements: e.target.value })} />
            <input placeholder="Дедлайн (1 марта)" value={draft.deadline || ''}
              onChange={(e) => setDraft({ ...draft, deadline: e.target.value })} />
            <input placeholder="Ссылка (https://...)" value={draft.link || ''}
              onChange={(e) => setDraft({ ...draft, link: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setCreating(false); setDraft({}); }}>Отмена</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={onAdd}>Добавить</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
          + Добавить стипендию
        </button>
      )}
    </div>
  );
}
