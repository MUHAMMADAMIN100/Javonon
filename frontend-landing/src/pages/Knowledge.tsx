import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  listKnowledge,
  getKnowledgeCategory,
  type KnowledgeCategory,
  type KnowledgeCategoryDetail,
  type KnowledgeArticle,
} from '../studentApi';
import Loading from '../components/Loading';
import Header from '../components/Header';
import Footer from '../components/Footer';
import Icon from '../Icon';

export default function Knowledge() {
  const [categories, setCategories] = useState<KnowledgeCategory[]>([]);
  const [selected, setSelected] = useState<KnowledgeCategoryDetail | null>(null);
  const [openArticle, setOpenArticle] = useState<KnowledgeArticle | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listKnowledge()
      .then(setCategories)
      .catch(() => setCategories([]))
      .finally(() => setLoading(false));
  }, []);

  const openCategory = async (slug: string) => {
    const det = await getKnowledgeCategory(slug);
    setSelected(det);
    setOpenArticle(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      <Header />
      <main>
        <section className="dark" style={{ paddingTop: 140 }}>
          <div className="container">
            <div className="section-head">
              <div>
                <span className="eyebrow on-dark">Пойгоҳи дониш</span>
                <h2 className="display">
                  Ҳама чиз дар бораи<br />
                  <em>қабул ба донишгоҳ.</em>
                </h2>
              </div>
              <p>
                Раванд, ҳуҷҷатҳо, мӯҳлат ва арзиш — барои муштариён
                ва кормандони Javonon. Ҳамроҳи қоидаҳо навсозӣ мешавад.
              </p>
            </div>

            {loading && <Loading />}

            {!selected ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: 12,
              }}>
                {categories.map((c) => (
                  <motion.button
                    key={c.slug}
                    onClick={() => openCategory(c.slug)}
                    whileHover={{ y: -4 }}
                    style={{
                      padding: 28,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      borderRadius: 18,
                      textAlign: 'left',
                      color: 'white',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 40, marginBottom: 16 }}>{c.icon}</div>
                    <div style={{
                      fontFamily: 'var(--display)',
                      fontSize: 24,
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      marginBottom: 8,
                    }}>{c.title}</div>
                    <div style={{ color: 'rgba(255,255,255,0.62)', fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
                      {c.summary}
                    </div>
                    <div style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      letterSpacing: '0.10em',
                      color: 'var(--emerald-2)',
                      textTransform: 'uppercase',
                    }}>
                      {c.articleCount} мақола <Icon name="arrow_outward" size={14} />
                    </div>
                  </motion.button>
                ))}
              </div>
            ) : (
              <div>
                <button
                  className="btn-pill ghost"
                  onClick={() => { setSelected(null); setOpenArticle(null); }}
                  style={{ marginBottom: 32 }}
                >
                  <Icon name="arrow_back" size={14} /> Ҳамаи категорияҳо
                </button>
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontSize: 56, marginBottom: 12 }}>{selected.icon}</div>
                  <h2 className="display" style={{
                    fontSize: 'clamp(36px, 5vw, 56px)',
                    fontWeight: 500,
                    letterSpacing: '-0.03em',
                    color: 'white',
                    marginBottom: 12,
                  }}>{selected.title}</h2>
                  <p style={{ color: 'rgba(255,255,255,0.62)', fontSize: 17 }}>{selected.summary}</p>
                </div>

                <AnimatePresence mode="wait">
                  {openArticle ? (
                    <motion.div
                      key="article"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -20 }}
                      style={{
                        background: 'white',
                        color: 'var(--ink)',
                        padding: '40px 48px',
                        borderRadius: 24,
                      }}
                    >
                      <button
                        className="btn-pill"
                        onClick={() => setOpenArticle(null)}
                        style={{
                          background: 'var(--bg-soft)',
                          border: '1px solid var(--border)',
                          color: 'var(--ink-soft)',
                          marginBottom: 24,
                        }}
                      >
                        <Icon name="arrow_back" size={14} /> Ба мақолаҳо
                      </button>
                      <h3 style={{
                        fontFamily: 'var(--display)',
                        fontSize: 36,
                        fontWeight: 500,
                        letterSpacing: '-0.02em',
                        marginBottom: 32,
                      }}>{openArticle.title}</h3>

                      <ArticleSection title="РАВАНД" iconName="format_list_numbered">
                        <ol style={{ paddingLeft: 24, lineHeight: 1.8 }}>
                          {openArticle.processSteps.map((s, i) => (
                            <li key={i} style={{ marginBottom: 6 }}>{s}</li>
                          ))}
                        </ol>
                      </ArticleSection>

                      {openArticle.documents.length > 0 && (
                        <ArticleSection title="ҲУҶҶАТҲО" iconName="description">
                          <ul style={{ paddingLeft: 24, lineHeight: 1.8 }}>
                            {openArticle.documents.map((d, i) => (
                              <li key={i} style={{ marginBottom: 4 }}>{d}</li>
                            ))}
                          </ul>
                        </ArticleSection>
                      )}

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginTop: 24 }}>
                        {openArticle.duration && (
                          <Stat label="МӮҲЛАТ" value={openArticle.duration} />
                        )}
                        {openArticle.cost && (
                          <Stat label="АРЗИШ" value={openArticle.cost} />
                        )}
                      </div>

                      {openArticle.tips && (
                        <div style={{
                          marginTop: 32,
                          padding: 24,
                          background: 'rgba(1, 54, 139,0.06)',
                          borderLeft: '3px solid var(--emerald)',
                          borderRadius: 12,
                        }}>
                          <div style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 11,
                            letterSpacing: '0.16em',
                            color: 'var(--emerald-deep)',
                            marginBottom: 8,
                            textTransform: 'uppercase',
                          }}>МАСЛИҲАТ</div>
                          <div style={{ fontSize: 15, lineHeight: 1.6 }}>{openArticle.tips}</div>
                        </div>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="list"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                    >
                      {selected.articles.map((a) => (
                        <motion.button
                          key={a.id}
                          onClick={() => setOpenArticle(a)}
                          whileHover={{ x: 4 }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 16,
                            padding: '20px 24px',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.10)',
                            borderRadius: 14,
                            color: 'white',
                            textAlign: 'left',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontFamily: 'var(--display)',
                              fontSize: 22,
                              fontWeight: 500,
                              letterSpacing: '-0.01em',
                              marginBottom: 4,
                            }}>{a.title}</div>
                            <div style={{
                              fontFamily: 'var(--mono)',
                              fontSize: 11,
                              letterSpacing: '0.10em',
                              color: 'var(--emerald-2)',
                              textTransform: 'uppercase',
                            }}>{a.duration} · {a.cost}</div>
                          </div>
                          <Icon name="arrow_outward" size={20} style={{ color: 'rgba(255,255,255,0.5)' }} />
                        </motion.button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            <div style={{ textAlign: 'center', marginTop: 64 }}>
              <Link to="/" className="btn btn-ghost-dark">
                <Icon name="arrow_back" size={16} /> Саҳифаи асосӣ
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function ArticleSection({ title, iconName, children }: {
  title: string;
  iconName: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '0.16em',
        color: 'var(--emerald-deep)',
        marginBottom: 12,
        textTransform: 'uppercase',
      }}>
        <Icon name={iconName} size={14} /> {title}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 16, background: 'var(--bg-soft)', borderRadius: 10 }}>
      <div style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.14em',
        color: 'var(--ink-soft)',
        marginBottom: 6,
      }}>{label}</div>
      <div style={{
        fontFamily: 'var(--display)',
        fontSize: 18,
        fontWeight: 500,
        letterSpacing: '-0.01em',
      }}>{value}</div>
    </div>
  );
}
