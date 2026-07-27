import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPublicProgram, type Program } from '../programs';
import { toTajik } from '../programLabels';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
const API_ROOT = API_URL.replace(/\/api$/, '');

const DIRECTION_LABEL: Record<string, string> = {
  BACHELOR: 'Бакалавр',
  MASTER: 'Магистр',
  LANGUAGE: 'Курсҳои забонӣ',
  LANGUAGE_COLLEGE: 'Забонӣ + коллеҷ',
  LANGUAGE_BACHELOR: 'Забонӣ + бакалавр',
  COLLEGE: 'Коллеҷ',
};

interface Scholarship {
  id: string;
  name: string;
  coverage: string | null;
  amount: string | null;
  includes: string | null;
  requirements: string | null;
  deadline: string | null;
  link: string | null;
}

function imgUrl(u: string): string {
  return u.startsWith('http') ? u : `${API_ROOT}${u}`;
}

/**
 * Публичная детальная страница программы для лендинга (ТЗ-доработка п.7).
 * Открывается по клику на карточку в PublicProgramsSection.
 * URL: /program/:id
 */
export default function PublicProgramDetail() {
  const { id } = useParams<{ id: string }>();
  const [program, setProgram] = useState<Program | null>(null);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [activePhoto, setActivePhoto] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getPublicProgram(id)
      .then((p) => setProgram(p))
      .catch((e) => setError(e?.message || 'Хатогӣ'))
      .finally(() => setLoading(false));

    // Стипендии — публичный endpoint
    fetch(`${API_URL}/programs/public/${id}/scholarships`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setScholarships)
      .catch(() => setScholarships([]));
  }, [id]);

  if (!id) return null;
  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center' }}>Боркунӣ...</div>;
  }
  if (error || !program) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Link to="/">← Ба саҳифаи асосӣ</Link>
        <h2 style={{ marginTop: 16 }}>Барнома ёфт нашуд</h2>
      </div>
    );
  }

  const p = program as any;
  const allPhotos = [p.imageUrl, ...(p.imageUrls || [])].filter(Boolean) as string[];

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', paddingBottom: 60 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
        <Link to="/" style={{ color: '#475569', fontSize: 14, textDecoration: 'none' }}>
          ← Ба саҳифаи асосӣ
        </Link>

        <div style={{
          background: 'white', borderRadius: 16, padding: 28, marginTop: 16,
          boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'flex-start', gap: 16, flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <h1 style={{ fontSize: 'clamp(24px, 4vw, 38px)', margin: 0, marginBottom: 8 }}>
                {p.name}
              </h1>
              <div style={{ fontSize: 18, color: '#475569' }}>{p.university}</div>
              <div style={{ fontSize: 14, color: '#64748b', marginTop: 8 }}>
                {[toTajik(p.country), toTajik(p.city)].filter(Boolean).join(', ')}
              </div>
            </div>
            {p.universityWebsiteUrl && (
              <a
                href={p.universityWebsiteUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: '10px 18px',
                  background: '#1e40af',
                  color: 'white',
                  borderRadius: 10,
                  textDecoration: 'none',
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                🌐 Сомонаи расмии донишгоҳ
              </a>
            )}
          </div>
        </div>

        {/* Галерея */}
        {allPhotos.length > 0 && (
          <div style={{ background: 'white', borderRadius: 16, padding: 16, marginTop: 16 }}>
            <img
              src={imgUrl(allPhotos[activePhoto])}
              alt=""
              style={{ width: '100%', maxHeight: 460, objectFit: 'cover', borderRadius: 12 }}
            />
            {allPhotos.length > 1 && (
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 10 }}>
                {allPhotos.map((u, idx) => (
                  <img
                    key={u}
                    src={imgUrl(u)}
                    alt=""
                    onClick={() => setActivePhoto(idx)}
                    style={{
                      width: 110, height: 70, objectFit: 'cover',
                      borderRadius: 8, cursor: 'pointer',
                      outline: idx === activePhoto ? '2px solid #1e40af' : 'none',
                      opacity: idx === activePhoto ? 1 : 0.7,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Основная информация */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16, marginTop: 16,
        }}>
          <div style={{ background: 'white', borderRadius: 16, padding: 22 }}>
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>Маълумоти асосӣ</h3>
            {/* Аудит-фикс: майдонҳои озод аз БД метавонанд русӣ бошанд —
                toTajik() онҳоро тарҷума мекунад, то нимҷумлаи русӣ дар назди
                нишонаи тоҷикӣ набошад. */}
            <Row label="Самт" value={p.direction ? DIRECTION_LABEL[p.direction] : null} />
            <Row label="Ихтисос" value={toTajik(p.major)} />
            <Row
              label="Арзиш / сол"
              value={p.cost ? `${p.cost.toLocaleString('ru-RU')} ${p.currency}` : 'Ройгон / аниқ карда мешавад'}
            />
            <Row label="Давомнокӣ" value={toTajik(p.duration)} />
            <Row label="Забони таҳсил" value={toTajik(p.language)} />
            <Row label="Сатҳи забони англисӣ" value={toTajik(p.englishLevel)} />
            <Row label="Холи миёнаи қабул" value={toTajik(p.avgAdmissionScore)} />
            <Row label="Мӯҳлати супоридан" value={toTajik(p.applicationDeadline)} />
            <Row label="Қабул дар як сол" value={typeof p.intakesPerYear === 'number' ? String(p.intakesPerYear) : null} />
          </div>

          {p.disciplines && p.disciplines.length > 0 && (
            <div style={{ background: 'white', borderRadius: 16, padding: 22 }}>
              <h3 style={{ marginTop: 0, marginBottom: 12 }}>Самтҳо / ихтисосҳо</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {p.disciplines.map((d: string) => (
                  <span key={d} style={{
                    padding: '5px 12px', borderRadius: 999,
                    background: '#f1f5f9', fontSize: 13,
                  }}>{toTajik(d)}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Стипендии */}
        {scholarships.length > 0 && (
          <div style={{ background: 'white', borderRadius: 16, padding: 22, marginTop: 16 }}>
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>
              🎓 Стипендияҳо ва грантҳо ({scholarships.length})
            </h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <th style={th}>Ном</th>
                    <th style={th}>Фарогирӣ</th>
                    <th style={th}>Маблағ</th>
                    <th style={th}>Дар бар мегирад</th>
                    <th style={th}>Талабот</th>
                    <th style={th}>Мӯҳлат</th>
                    <th style={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {scholarships.map((s) => (
                    <tr key={s.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{s.name}</td>
                      <td style={td}>{toTajik(s.coverage) || '—'}</td>
                      <td style={td}>{toTajik(s.amount) || '—'}</td>
                      <td style={td}>{toTajik(s.includes) || '—'}</td>
                      <td style={td}>{toTajik(s.requirements) || '—'}</td>
                      <td style={td}>{toTajik(s.deadline) || '—'}</td>
                      <td style={td}>
                        {s.link && (
                          <a href={s.link} target="_blank" rel="noreferrer" style={{ color: '#1e40af' }}>🔗</a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {p.description && (
          <div style={{ background: 'white', borderRadius: 16, padding: 22, marginTop: 16 }}>
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>Тавсифи барнома</h3>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 15 }}>
              {p.description}
            </div>
          </div>
        )}

        {/* CTA */}
        <div style={{
          background: 'linear-gradient(135deg, #1e40af, #6366f1)',
          color: 'white', borderRadius: 16, padding: 28, marginTop: 24, textAlign: 'center',
        }}>
          <h3 style={{ marginTop: 0 }}>Ин барнома ба шумо маъқул шуд?</h3>
          <p style={{ opacity: 0.9, marginBottom: 16 }}>
            Ариза фиристед — мо бо шумо тамос мегирем ва дар қабул кӯмак мекунем
          </p>
          <Link
            to="/#contact"
            style={{
              padding: '12px 28px', background: 'white', color: '#1e40af',
              borderRadius: 10, textDecoration: 'none', fontWeight: 600,
            }}
          >
            Ариза фиристодан
          </Link>
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#64748b', textTransform: 'uppercase' };
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 14 };

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}>
      <span style={{ color: '#64748b', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
