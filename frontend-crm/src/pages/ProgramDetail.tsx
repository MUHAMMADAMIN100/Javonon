import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { getProgram, programImageUrl } from '../api/programs';
import { DIRECTION_LABEL } from '../api/types';
import Icon from '../Icon';
import Loading from '../components/Loading';

/**
 * Детальная страница программы (ТЗ-доработка п.7). Открывается по клику
 * на карточку программы. Показывает всё: фото-галерею, описание (markdown),
 * требования, дедлайны, стипендии, ссылку на сайт университета.
 */
export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>();
  const query = useQuery({
    queryKey: ['program', id],
    queryFn: () => getProgram(id!),
    enabled: !!id,
  });
  const p = query.data;
  const [activePhoto, setActivePhoto] = useState(0);

  if (!id) return null;
  if (query.isLoading) return <Loading />;
  if (query.isError || !p) {
    return (
      <motion.div className="card" style={{ padding: 28 }}>
        <Link to="/programs">← Назад к программам</Link>
        <h2 style={{ marginTop: 16 }}>Программа не найдена</h2>
      </motion.div>
    );
  }

  const allPhotos = [p.imageUrl, ...(p.imageUrls || [])].filter(Boolean) as string[];
  const websiteUrl = (p as any).universityWebsiteUrl as string | undefined;
  const scholarships = (p as any).scholarships as any[] | undefined;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="card" style={{ padding: 24, marginBottom: 16 }}>
        <Link to="/programs" style={{ fontSize: 13, color: 'var(--text-soft)' }}>
          ← Назад к программам
        </Link>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, marginBottom: 6 }}>{p.name}</h1>
            <div style={{ fontSize: 18, color: 'var(--text-soft)' }}>{p.university}</div>
            <div style={{ fontSize: 14, color: 'var(--text-soft)', marginTop: 6 }}>
              {[p.country, p.city].filter(Boolean).join(', ')}
            </div>
          </div>
          {websiteUrl && (
            <a href={websiteUrl} target="_blank" rel="noreferrer" className="btn btn-primary">
              🌐 Официальный сайт университета
            </a>
          )}
        </div>
      </div>

      {/* Галерея */}
      {allPhotos.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <img
              src={programImageUrl(allPhotos[activePhoto])!}
              alt=""
              style={{ width: '100%', maxHeight: 420, objectFit: 'cover', borderRadius: 12 }}
            />
          </div>
          {allPhotos.length > 1 && (
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
              {allPhotos.map((u, idx) => (
                <img
                  key={u}
                  src={programImageUrl(u)!}
                  alt=""
                  onClick={() => setActivePhoto(idx)}
                  style={{
                    width: 96, height: 64, objectFit: 'cover', borderRadius: 8,
                    cursor: 'pointer',
                    outline: idx === activePhoto ? '2px solid var(--primary)' : 'none',
                    opacity: idx === activePhoto ? 1 : 0.7,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ marginBottom: 12 }}>Основное</h3>
          <Row label="Направление" value={p.direction ? DIRECTION_LABEL[p.direction] : '—'} />
          <Row label="Специальность" value={p.major || '—'} />
          <Row label="Стоимость / год" value={p.cost ? `${p.cost.toLocaleString('ru-RU')} ${p.currency}` : 'Бесплатно / уточняется'} />
          <Row label="Длительность" value={p.duration} />
          <Row label="Язык обучения" value={p.language} />
          <Row label="Уровень английского" value={p.englishLevel} />
          <Row label="Средний проходной балл" value={p.avgAdmissionScore} />
          <Row label="Дедлайн подачи" value={p.applicationDeadline} />
          <Row label="Наборов в год" value={typeof p.intakesPerYear === 'number' ? String(p.intakesPerYear) : null} />
        </div>

        {p.disciplines && p.disciplines.length > 0 && (
          <div className="card" style={{ padding: 20 }}>
            <h3 style={{ marginBottom: 12 }}>Направления</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {p.disciplines.map((d: string) => (
                <span key={d} style={{
                  padding: '4px 10px', borderRadius: 999,
                  background: 'var(--bg-soft)', border: '1px solid var(--border)',
                  fontSize: 13,
                }}>{d}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {scholarships && scholarships.length > 0 && (
        <div className="card" style={{ padding: 20, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>🎓 Стипендии и гранты ({scholarships.length})</h3>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Покрытие</th>
                <th>Сумма</th>
                <th>Что включено</th>
                <th>Требования</th>
                <th>Дедлайн</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scholarships.map((s: any) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td>{s.coverage || '—'}</td>
                  <td>{s.amount || '—'}</td>
                  <td>{s.includes || '—'}</td>
                  <td>{s.requirements || '—'}</td>
                  <td>{s.deadline || '—'}</td>
                  <td>
                    {s.link && (
                      <a href={s.link} target="_blank" rel="noreferrer">🔗</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p.description && (
        <div className="card" style={{ padding: 20, marginTop: 16 }}>
          <h3 style={{ marginBottom: 12 }}>Описание программы</h3>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {p.description}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ color: 'var(--text-soft)', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
