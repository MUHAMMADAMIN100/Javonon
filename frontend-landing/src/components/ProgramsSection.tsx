import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  API_BASE,
  getStudentProgramFilters,
  listStudentPrograms,
  type StudentProgram,
} from '../studentApi';
import { useStudentRealtime } from '../realtime';
import Icon from '../Icon';
import Loading from './Loading';

const DIRECTION_LABEL: Record<string, string> = {
  BACHELOR: 'Бакалавриат',
  MASTER: 'Магистратура',
  LANGUAGE: 'Языковые курсы',
  LANGUAGE_COLLEGE: 'Языковой + колледж',
  LANGUAGE_BACHELOR: 'Языковой + бакалавриат',
  COLLEGE: 'Колледж',
};

export default function ProgramsSection() {
  const [items, setItems] = useState<StudentProgram[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [majors, setMajors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<StudentProgram | null>(null);

  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [major, setMajor] = useState('');
  const [direction, setDirection] = useState('');
  const [minCost, setMinCost] = useState('');
  const [maxCost, setMaxCost] = useState('');

  const load = async () => {
    try {
      const data = await listStudentPrograms({
        search: search || undefined,
        city: city || undefined,
        major: major || undefined,
        direction: direction || undefined,
        minCost: minCost ? Number(minCost) : undefined,
        maxCost: maxCost ? Number(maxCost) : undefined,
      });
      setItems(data);
    } catch {
      // silently
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    getStudentProgramFilters()
      .then((f) => {
        setCities(f.cities);
        setMajors(f.majors);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [search, city, major, direction, minCost, maxCost]);

  useStudentRealtime({
    'program:new': () => {
      load();
      // Обновляем фильтры
      getStudentProgramFilters()
        .then((f) => {
          setCities(f.cities);
          setMajors(f.majors);
        })
        .catch(() => {});
    },
    'program:updated': () => load(),
    'program:deleted': () => load(),
  });

  const reset = () => {
    setSearch(''); setCity(''); setMajor(''); setDirection('');
    setMinCost(''); setMaxCost('');
  };

  const hasFilters = search || city || major || direction || minCost || maxCost;

  return (
    <section className="stu-card sp-card">
      <div className="sp-head">
        <div>
          <h2 className="stu-section-title" style={{ margin: 0 }}>Программы обучения</h2>
          <div className="sp-sub">
            Каталог программ в университетах Китая
          </div>
        </div>
        <button
          className="sp-toggle"
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'filter_alt_off' : 'filter_alt'} size={16} />
          Фильтры
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            className="sp-filters"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="sp-filter">
              <label>Поиск</label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Название, университет..."
              />
            </div>
            <div className="sp-filter">
              <label>Город</label>
              <select value={city} onChange={(e) => setCity(e.target.value)}>
                <option value="">Все города</option>
                {cities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="sp-filter">
              <label>Специальность</label>
              <select value={major} onChange={(e) => setMajor(e.target.value)}>
                <option value="">Все специальности</option>
                {majors.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="sp-filter">
              <label>Направление</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="">Все</option>
                {Object.entries(DIRECTION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div className="sp-filter">
              <label>Цена (от — до)</label>
              <div className="sp-range">
                <input type="number" placeholder="от" value={minCost} onChange={(e) => setMinCost(e.target.value)} />
                <input type="number" placeholder="до" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} />
              </div>
            </div>
            {hasFilters && (
              <button className="sp-reset" onClick={reset}>
                <Icon name="close" size={14} /> Сбросить
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="sp-empty">
          <Icon name="school" size={40} />
          <div>Программ пока нет</div>
        </div>
      ) : (
        <motion.div
          className="sp-grid"
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
        >
          {items.map((p) => (
            <motion.div
              key={p.id}
              className="sp-item"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              whileHover={{ y: -4 }}
              onClick={() => setSelected(p)}
            >
              {/* QA-fix #3: image-fallback. На сломанной картинке прячем
                  <img>, родитель .sp-item-img.fallback показывает gradient
                  + первую букву названия. */}
              <div className={`sp-item-img${!p.imageUrl ? ' fallback' : ''}`}>
                {p.imageUrl && (
                  <img
                    src={p.imageUrl.startsWith('http') ? p.imageUrl : `${API_BASE}${p.imageUrl}`}
                    alt={p.name}
                    onError={(e) => {
                      const img = e.currentTarget as HTMLImageElement;
                      img.style.display = 'none';
                      img.parentElement?.classList.add('fallback');
                    }}
                  />
                )}
                <span className="sp-item-img-fallback">
                  {(p.name || '?').charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="sp-item-body">
                <div className="sp-item-head">
                  <div className="sp-badge">{DIRECTION_LABEL[p.direction]}</div>
                  <div className="sp-cost">
                    {p.cost.toLocaleString('ru-RU')} <span>{p.currency}/год</span>
                  </div>
                </div>
                <div className="sp-item-name">{p.name}</div>
                <div className="sp-item-uni">
                  <Icon name="account_balance" size={14} /> {p.university}
                </div>
                <div className="sp-item-meta">
                  <span><Icon name="location_on" size={13} /> {p.city}</span>
                  <span><Icon name="school" size={13} /> {p.major}</span>
                  {p.duration && <span><Icon name="schedule" size={13} /> {p.duration}</span>}
                  {p.englishLevel && <span><Icon name="record_voice_over" size={13} /> {p.englishLevel}</span>}
                </div>
                {p.hasGrant && (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: '#dcfce7', color: '#15803d', borderRadius: 999,
                    padding: '3px 10px', fontSize: 12, fontWeight: 600, marginTop: 6,
                  }}>
                    🎓 Грант
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* Модалка с деталями */}
      <AnimatePresence>
        {selected && (
          <motion.div
            className="sp-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelected(null)}
          >
            <motion.div
              className="sp-modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="sp-modal-close" onClick={() => setSelected(null)}>
                <Icon name="close" size={20} />
              </button>
              {selected.imageUrl && (
                <div className="sp-modal-img">
                  <img
                    src={selected.imageUrl.startsWith('http') ? selected.imageUrl : `${API_BASE}${selected.imageUrl}`}
                    alt=""
                  />
                </div>
              )}
              <div className="sp-modal-body">
                <div className="sp-badge">{DIRECTION_LABEL[selected.direction]}</div>
                <h2 className="sp-modal-name">{selected.name}</h2>
                <div className="sp-modal-uni">{selected.university}</div>
                <div className="sp-modal-meta">
                  <div><Icon name="location_on" size={16} /> {selected.city}</div>
                  <div><Icon name="school" size={16} /> {selected.major}</div>
                  {selected.duration && <div><Icon name="schedule" size={16} /> {selected.duration}</div>}
                  {selected.language && <div><Icon name="translate" size={16} /> {selected.language}</div>}
                  {selected.englishLevel && <div><Icon name="record_voice_over" size={16} /> Английский: {selected.englishLevel}</div>}
                  {selected.avgAdmissionScore && <div><Icon name="grade" size={16} /> Проходной балл: {selected.avgAdmissionScore}</div>}
                  {selected.applicationDeadline && <div><Icon name="event" size={16} /> Дедлайн: {selected.applicationDeadline}</div>}
                  {typeof selected.intakesPerYear === 'number' && <div><Icon name="repeat" size={16} /> Наборов в год: {selected.intakesPerYear}</div>}
                </div>
                {selected.hasGrant && (
                  <div style={{
                    background: '#dcfce7', color: '#15803d', borderRadius: 12,
                    padding: '12px 16px', fontSize: 14, marginTop: 12,
                  }}>
                    <b>🎓 Доступен грант</b>
                    {selected.grantDetails && <div style={{ marginTop: 4 }}>{selected.grantDetails}</div>}
                    {selected.grantEnglishLevel && (
                      <div style={{ marginTop: 4, fontSize: 13 }}>
                        Уровень английского для гранта: <b>{selected.grantEnglishLevel}</b>
                      </div>
                    )}
                  </div>
                )}
                <div className="sp-modal-cost">
                  {selected.cost.toLocaleString('ru-RU')} {selected.currency} <span>/ год</span>
                </div>
                {selected.description && (
                  <div className="sp-modal-desc">{selected.description}</div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
