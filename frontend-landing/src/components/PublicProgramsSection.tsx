import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { listPublicPrograms, type Program } from '../programs';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001/api';
const API_ROOT = API_URL.replace(/\/api$/, '');

function imgUrl(u: string | null): string {
  if (!u) return '';
  return u.startsWith('http') ? u : `${API_ROOT}${u}`;
}

/**
 * Публичная секция программ на главной лендинга (ТЗ-доработка п.8).
 * Дёргает /programs/public — без авторизации, только published=true.
 * Группировка по стране (fallback на «Другие» для программ без country).
 */
export default function PublicProgramsSection() {
  const [items, setItems] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCountry, setActiveCountry] = useState<string>('');

  useEffect(() => {
    listPublicPrograms()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const countries = useMemo(() => {
    const set = new Set<string>();
    for (const p of items) {
      set.add((p as any).country || 'Другие');
    }
    return Array.from(set).sort();
  }, [items]);

  const filtered = activeCountry
    ? items.filter((p) => ((p as any).country || 'Другие') === activeCountry)
    : items;

  if (loading) return null;
  if (items.length === 0) return null;

  return (
    <section id="programs" style={{ padding: '80px 20px', background: '#f9fafb' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          style={{
            fontFamily: 'var(--font-display, Georgia, serif)',
            fontSize: 'clamp(28px, 4vw, 44px)',
            textAlign: 'center',
            marginBottom: 12,
          }}
        >
          Программы и гранты
        </motion.h2>
        <p style={{ textAlign: 'center', color: '#64748b', marginBottom: 32 }}>
          {items.length} актуальных программ от партнёрских университетов
        </p>

        {countries.length > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 32 }}>
            <button
              onClick={() => setActiveCountry('')}
              style={tabStyle(activeCountry === '')}
            >
              Все ({items.length})
            </button>
            {countries.map((c) => {
              const count = items.filter((p) => ((p as any).country || 'Другие') === c).length;
              return (
                <button key={c} onClick={() => setActiveCountry(c)} style={tabStyle(activeCountry === c)}>
                  {c} ({count})
                </button>
              );
            })}
          </div>
        )}

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 24,
        }}>
          {filtered.map((p) => {
            const photo = p.imageUrl || ((p as any).imageUrls?.[0]) || null;
            return (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                whileHover={{ y: -4 }}
                style={{
                  background: 'white',
                  borderRadius: 16,
                  overflow: 'hidden',
                  boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
                  border: '1px solid #e5e7eb',
                  display: 'flex', flexDirection: 'column',
                }}
              >
              <Link to={`/program/${p.id}`} style={{ display: 'contents', color: 'inherit', textDecoration: 'none' }}>
                <div style={{
                  height: 180,
                  background: photo
                    ? `url(${imgUrl(photo)}) center/cover`
                    : 'linear-gradient(135deg, #1e40af, #6366f1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'white', fontSize: 56, fontWeight: 700,
                }}>
                  {!photo && (p.name || '?').charAt(0).toUpperCase()}
                </div>
                <div style={{ padding: 20, flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>{p.name}</div>
                  <div style={{ color: '#475569', fontSize: 14, marginBottom: 12 }}>{p.university}</div>
                  <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                    {[(p as any).country, p.city].filter(Boolean).join(', ') || ''}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 18, color: '#1e40af', marginTop: 'auto' }}>
                    {p.cost
                      ? `${p.cost.toLocaleString('ru-RU')} ${p.currency} / год`
                      : 'Бесплатно / уточняется'}
                  </div>
                  {(p as any).universityWebsiteUrl && (
                    <a
                      href={(p as any).universityWebsiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        marginTop: 12,
                        textAlign: 'center',
                        padding: '8px 14px',
                        borderRadius: 10,
                        background: '#f1f5f9',
                        color: '#1e40af',
                        textDecoration: 'none',
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      🌐 Сайт университета
                    </a>
                  )}
                </div>
              </Link>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 999,
    border: '1.5px solid ' + (active ? '#1e40af' : '#e5e7eb'),
    background: active ? '#1e40af' : 'white',
    color: active ? 'white' : '#1e293b',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  };
}
