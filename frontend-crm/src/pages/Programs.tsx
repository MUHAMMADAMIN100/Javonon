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

// Helpers для markdown-кнопок описания. Вставляют по позиции курсора:
// если есть выделение — оборачивают его, иначе — placeholder между
// маркерами; курсор после вставки оказывается внутри маркеров.
function wrapAtCursor(
  ta: HTMLTextAreaElement | null,
  editing: any,
  setEditing: (v: any) => void,
  open: string,
  close: string,
  placeholder = 'текст',
) {
  const cur = editing?.description || '';
  if (!ta) {
    setEditing({ ...editing, description: `${cur}${open}${placeholder}${close}` });
    return;
  }
  const start = ta.selectionStart ?? cur.length;
  const end = ta.selectionEnd ?? cur.length;
  const selected = cur.slice(start, end) || placeholder;
  const next = cur.slice(0, start) + open + selected + close + cur.slice(end);
  setEditing({ ...editing, description: next });
  // Возвращаем фокус и ставим курсор внутри маркеров.
  requestAnimationFrame(() => {
    ta.focus();
    const caretStart = start + open.length;
    const caretEnd = caretStart + selected.length;
    ta.setSelectionRange(caretStart, caretEnd);
  });
}
function insertAtCursor(
  ta: HTMLTextAreaElement | null,
  editing: any,
  setEditing: (v: any) => void,
  snippet: string,
) {
  const cur = editing?.description || '';
  if (!ta) {
    setEditing({ ...editing, description: `${cur}${snippet}` });
    return;
  }
  const start = ta.selectionStart ?? cur.length;
  const end = ta.selectionEnd ?? cur.length;
  const next = cur.slice(0, start) + snippet + cur.slice(end);
  setEditing({ ...editing, description: next });
  requestAnimationFrame(() => {
    ta.focus();
    const caret = start + snippet.length;
    ta.setSelectionRange(caret, caret);
  });
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
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  // Локальные «отложенные» галерея и стипендии для НОВОЙ программы
  // (нет id для upload, пока не сохранили). См. ТЗ-доработка п.4 + п.10.
  const [pendingGalleryFiles, setPendingGalleryFiles] = useState<File[]>([]);
  const [pendingGalleryPreviews, setPendingGalleryPreviews] = useState<string[]>([]);
  const [pendingScholarships, setPendingScholarships] = useState<Array<Partial<ProgramScholarship>>>([]);

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
    // Освобождаем object URLs предпросмотра галереи (избегаем утечки памяти).
    pendingGalleryPreviews.forEach((u) => URL.revokeObjectURL(u));
    setPendingGalleryFiles([]);
    setPendingGalleryPreviews([]);
    setPendingScholarships([]);
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
    mutationFn: async (vars: {
      editing: Partial<Program>;
      pendingImage: File | null;
      pendingGalleryFiles: File[];
      pendingScholarships: Array<Partial<ProgramScholarship>>;
    }) => {
      const payload = {
        ...vars.editing,
        cost: typeof vars.editing.cost === 'string' ? parseFloat(vars.editing.cost) : vars.editing.cost,
      };
      // UPDATE — обычный путь.
      if (vars.editing.id) {
        return updateProgram(vars.editing.id, payload);
      }
      // CREATE — после создания программы flush отложенных галереи и стипендий.
      // ТЗ-доработка п.4 + п.10: возможность приложить фото и стипендии при
      // создании, до того как программа имеет id.
      const created = await createProgram(payload, vars.pendingImage);
      for (const f of vars.pendingGalleryFiles) {
        try { await uploadProgramGalleryImage(created.id, f); }
        catch (e) { console.error('gallery upload failed', e); }
      }
      for (const sch of vars.pendingScholarships) {
        if (!sch.name?.trim()) continue;
        try { await addProgramScholarship(created.id, sch); }
        catch (e) { console.error('scholarship add failed', e); }
      }
      return created;
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
    saveMut.mutate({ editing, pendingImage, pendingGalleryFiles, pendingScholarships });
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
      title: t('common.delete') + ' ' + t('programs.title').toLowerCase(),
      message: `«${p.name}» будет удалена. Студенты, привязанные к ней, останутся без программы.`,
      confirmText: t('common.delete'),
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
          <input className="crm-input" placeholder={t('programs.filter.city')} value={city} onChange={(e) => setCity(e.target.value)} />
          <input className="crm-input" placeholder={t('programs.filter.major')} value={major} onChange={(e) => setMajor(e.target.value)} />
          <select className="crm-select" value={direction} onChange={(e) => setDirection(e.target.value as any)}>
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
                      maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word',
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
                  className={`crm-input${formErrors.name ? ' input-error' : ''}`}
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
                    className={`crm-input${formErrors.university ? ' input-error' : ''}`}
                    maxLength={200}
                    placeholder="Tsinghua University / МГУ"
                    required
                  />
                  {formErrors.university && <div className="form-error-text">{formErrors.university}</div>}
                </div>
                <div className="form-group">
                  <label>{t('programs.field.country')}</label>
                  <input
                    className="crm-input"
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
                    className={`crm-input${formErrors.city ? ' input-error' : ''}`}
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
                    className={`crm-input${formErrors.major ? ' input-error' : ''}`}
                    maxLength={200}
                    placeholder="Информатика / Computer Science"
                  />
                  {formErrors.major && <div className="form-error-text">{formErrors.major}</div>}
                </div>
                <div className="form-group">
                  <label>{t('programs.field.direction')}</label>
                  <select className="crm-select" value={editing.direction} onChange={(e) => setEditing({ ...editing, direction: e.target.value as Direction })}>
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
                    className={`crm-input${formErrors.cost ? ' input-error' : ''}`}
                    placeholder={t('programs.field.costHint')}
                  />
                  {formErrors.cost && <div className="form-error-text">{formErrors.cost}</div>}
                </div>
                <div className="form-group">
                  <label>{t('programs.field.currency')}</label>
                  <select className="crm-select" value={editing.currency || 'CNY'} onChange={(e) => setEditing({ ...editing, currency: e.target.value })}>
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
                  <input className="crm-input" value={editing.duration || ''} placeholder="4 года" onChange={(e) => setEditing({ ...editing, duration: e.target.value })} />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>{t('programs.field.language')}</label>
                  <select
                    className="crm-select"
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
              <div className="form-grid-2">
                <div className="form-group">
                  <label>{t('programs.field.englishLevel')}</label>
                  <input
                    className="crm-input"
                    value={editing.englishLevel || ''}
                    placeholder="IELTS 6.0 / HSK 4 / —"
                    onChange={(e) => setEditing({ ...editing, englishLevel: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.avgScore')}</label>
                  <input
                    className="crm-input"
                    value={editing.avgAdmissionScore || ''}
                    placeholder="GPA 3.0 / 80%"
                    onChange={(e) => setEditing({ ...editing, avgAdmissionScore: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.deadline')}</label>
                  <input
                    className="crm-input"
                    value={editing.applicationDeadline || ''}
                    placeholder="1 марта / круглый год"
                    onChange={(e) => setEditing({ ...editing, applicationDeadline: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>{t('programs.field.intakes')}</label>
                  <input
                    className="crm-input"
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
                <label className="crm-checkbox-label" style={{ gridColumn: '1 / -1' }}>
                  <input
                    type="checkbox"
                    className="crm-checkbox"
                    checked={!!editing.hasGrant}
                    onChange={(e) => setEditing({ ...editing, hasGrant: e.target.checked })}
                  />
                  Есть грант / стипендия
                </label>
              </div>
              {editing.hasGrant && (
                <div className="form-grid-2">
                  <div className="form-group">
                    <label>Что покрывает грант</label>
                    <input
                      className="crm-input"
                      value={editing.grantDetails || ''}
                      placeholder="Обучение + проживание + стипендия"
                      onChange={(e) => setEditing({ ...editing, grantDetails: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Уровень англ. для гранта</label>
                    <input
                      className="crm-input"
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
                  className="crm-input"
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
                    onClick={() => wrapAtCursor(descRef.current, editing, setEditing, '**', '**')}>
                    <b>Ж</b>
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" title="Курсив"
                    onClick={() => wrapAtCursor(descRef.current, editing, setEditing, '*', '*')}>
                    <i>К</i>
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" title="Маркированный список"
                    onClick={() => insertAtCursor(descRef.current, editing, setEditing, '\n- ')}>
                    • Список
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" title="Ссылка"
                    onClick={() => wrapAtCursor(descRef.current, editing, setEditing, '[', '](https://)', 'текст')}>
                    🔗 Ссылка
                  </button>
                </div>
                <textarea
                  ref={descRef}
                  className="crm-textarea"
                  rows={10}
                  style={{ minHeight: 250, fontFamily: 'inherit' }}
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
                      ? t('common.uploading')
                      : pendingPreview || editing.imageUrl
                        ? t('common.replace')
                        : t('common.upload')}
                  </button>
                  {!editing.id && pendingImage && (
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>
                      Картинка отправится вместе с программой при сохранении.
                    </div>
                  )}
                </div>
              </div>

              {/* Галерея фото — до 7 шт. (ТЗ-доработка п.4).
                  Существующая программа → upload на сервер сразу.
                  Новая программа → копим File[] локально, flush после save. */}
              {editing.id ? (
                <ProgramGallery
                  programId={editing.id}
                  imageUrls={editing.imageUrls || []}
                  onChange={(next) => setEditing({ ...editing, imageUrls: next })}
                />
              ) : (
                <ProgramGalleryPending
                  files={pendingGalleryFiles}
                  previews={pendingGalleryPreviews}
                  onChange={(files, previews) => {
                    setPendingGalleryFiles(files);
                    setPendingGalleryPreviews(previews);
                  }}
                />
              )}

              {/* Стипендии — таблица (ТЗ-доработка п.10).
                  Существующая программа → CRUD на сервер.
                  Новая программа → копим локально, flush после save. */}
              {editing.id ? (
                <ScholarshipsEditor programId={editing.id} />
              ) : (
                <ScholarshipsPending
                  items={pendingScholarships}
                  onChange={setPendingScholarships}
                />
              )}

              <div className="form-group">
                <label className="crm-checkbox-label">
                  <input className="crm-checkbox" type="checkbox" checked={editing.published !== false} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} />
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
          className="crm-input"
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
  const { t } = useT();
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
      <label>{t('programs.field.gallery')} ({imageUrls.length}/7)</label>
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
        {uploading ? t('common.uploading') : imageUrls.length >= 7 ? t('programs.gallery.max') : t('programs.gallery.add')}
      </button>
    </div>
  );
}

function ScholarshipsEditor({ programId }: { programId: string }) {
  const { toast, confirm } = useUI();
  const { t } = useT();
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
    const ok = await confirm({ title: t('common.delete') + '?', message: s.name, danger: true });
    if (!ok) return;
    await deleteProgramScholarship(s.id);
    qc.invalidateQueries({ queryKey: ['program-scholarships', programId] });
  };

  return (
    <div className="form-group">
      <label>{t('programs.section.scholarships')} ({items.length})</label>
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
                s.coverage && `${t('programs.scholarship.coverage')}: ${s.coverage}`,
                s.amount && `${t('programs.scholarship.amount')}: ${s.amount}`,
                s.includes && `${t('programs.scholarship.includes')}: ${s.includes}`,
                s.requirements && `${t('programs.scholarship.requirements')}: ${s.requirements}`,
                s.deadline && `${t('programs.scholarship.deadline')}: ${s.deadline}`,
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
          <div className="form-grid-2" style={{ gap: 8 }}>
            <input className="crm-input" placeholder="Название (CSC Scholarship)" value={draft.name || ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="crm-input" placeholder="Покрытие (Полное / Частичное)" value={draft.coverage || ''}
              onChange={(e) => setDraft({ ...draft, coverage: e.target.value })} />
            <input className="crm-input" placeholder="Сумма (5000 USD/год)" value={draft.amount || ''}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            <input className="crm-input" placeholder="Что включено" value={draft.includes || ''}
              onChange={(e) => setDraft({ ...draft, includes: e.target.value })} />
            <input className="crm-input" placeholder="Требования (GPA 3.5, IELTS 6.0)" value={draft.requirements || ''}
              onChange={(e) => setDraft({ ...draft, requirements: e.target.value })} />
            <input className="crm-input" placeholder="Дедлайн (1 марта)" value={draft.deadline || ''}
              onChange={(e) => setDraft({ ...draft, deadline: e.target.value })} />
            <input className="crm-input" style={{ gridColumn: '1 / -1' }} placeholder="Ссылка (https://...)" value={draft.link || ''}
              onChange={(e) => setDraft({ ...draft, link: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setCreating(false); setDraft({}); }}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={onAdd}>{t('common.add')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
          {t('programs.scholarship.add')}
        </button>
      )}
    </div>
  );
}

/**
 * ProgramGalleryPending — версия галереи для НОВОЙ программы.
 * Не имеет programId, поэтому upload откладывается до сохранения:
 * держит File[] в памяти + локальные blob: URL для preview.
 * При закрытии формы родитель должен освободить blob URLs.
 */
function ProgramGalleryPending({
  files, previews, onChange,
}: {
  files: File[];
  previews: string[];
  onChange: (files: File[], previews: string[]) => void;
}) {
  const { t } = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const max = 7;

  const onPick = (file: File) => {
    if (files.length >= max) return;
    const url = URL.createObjectURL(file);
    onChange([...files, file], [...previews, url]);
  };
  const onRemove = (idx: number) => {
    const u = previews[idx];
    if (u) URL.revokeObjectURL(u);
    onChange(files.filter((_, i) => i !== idx), previews.filter((_, i) => i !== idx));
  };

  return (
    <div className="form-group">
      <label>{t('programs.field.gallery')} ({files.length}/{max})</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {previews.map((u, i) => (
          <div key={u} style={{ position: 'relative', width: 120, height: 90 }}>
            <img
              src={u}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 }}
            />
            <button
              type="button"
              onClick={() => onRemove(i)}
              title={t('common.delete')}
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
        disabled={files.length >= max}
      >
        {files.length >= max ? t('programs.gallery.max') : t('programs.gallery.add')}
      </button>
      {files.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 6 }}>
          Фото загрузятся после сохранения программы.
        </div>
      )}
    </div>
  );
}

/**
 * ScholarshipsPending — версия таблицы стипендий для НОВОЙ программы.
 * Аналогично галерее: копит черновики локально, родитель сохранит их
 * через addProgramScholarship после createProgram.
 */
function ScholarshipsPending({
  items, onChange,
}: {
  items: Array<Partial<ProgramScholarship>>;
  onChange: (items: Array<Partial<ProgramScholarship>>) => void;
}) {
  const { t } = useT();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Partial<ProgramScholarship>>({});

  const add = () => {
    if (!draft.name?.trim()) return;
    onChange([...items, draft]);
    setDraft({});
    setCreating(false);
  };
  const remove = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  return (
    <div className="form-group">
      <label>{t('programs.section.scholarships')} ({items.length})</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((s, i) => (
          <div key={i} style={{
            padding: 10, border: '1px solid var(--border)', borderRadius: 8,
            background: 'var(--bg-soft)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(i)}>×</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
              {[
                s.coverage && `${t('programs.scholarship.coverage')}: ${s.coverage}`,
                s.amount && `${t('programs.scholarship.amount')}: ${s.amount}`,
                s.requirements && `${t('programs.scholarship.requirements')}: ${s.requirements}`,
                s.deadline && `${t('programs.scholarship.deadline')}: ${s.deadline}`,
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
        ))}
      </div>
      {creating ? (
        <div style={{
          padding: 12, marginTop: 8,
          border: '1px solid var(--primary)', borderRadius: 8, background: 'var(--bg-soft)',
        }}>
          <div className="form-grid-2" style={{ gap: 8 }}>
            <input className="crm-input" placeholder="CSC Scholarship" value={draft.name || ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="crm-input" placeholder={t('programs.scholarship.coverage')} value={draft.coverage || ''}
              onChange={(e) => setDraft({ ...draft, coverage: e.target.value })} />
            <input className="crm-input" placeholder={t('programs.scholarship.amount')} value={draft.amount || ''}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
            <input className="crm-input" placeholder={t('programs.scholarship.includes')} value={draft.includes || ''}
              onChange={(e) => setDraft({ ...draft, includes: e.target.value })} />
            <input className="crm-input" placeholder={t('programs.scholarship.requirements')} value={draft.requirements || ''}
              onChange={(e) => setDraft({ ...draft, requirements: e.target.value })} />
            <input className="crm-input" placeholder={t('programs.scholarship.deadline')} value={draft.deadline || ''}
              onChange={(e) => setDraft({ ...draft, deadline: e.target.value })} />
            <input className="crm-input" style={{ gridColumn: '1 / -1' }} placeholder="https://..." value={draft.link || ''}
              onChange={(e) => setDraft({ ...draft, link: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setCreating(false); setDraft({}); }}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={add}>{t('common.add')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
          {t('programs.scholarship.add')}
        </button>
      )}
      {items.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 6 }}>
          Стипендии создадутся после сохранения программы.
        </div>
      )}
    </div>
  );
}
