import { motion } from 'framer-motion';
import Icon from '../Icon';

const UNIVERSITIES = [
  'Harvard',
  'Tsinghua',
  'Oxford',
  'TU Munich',
  'Sapienza',
  'KAIST',
  'Sorbonne',
  'University of Tokyo',
  'Cambridge',
  'ETH Zürich',
  'Boğaziçi',
  'NTU Singapore',
];

const fade = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.06, duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Hero() {
  // Дублируем для бесшовного marquee
  const marqueeItems = [...UNIVERSITIES, ...UNIVERSITIES];

  return (
    <section className="hero">
      <div className="container hero-content">
        <motion.span
          className="hero-tag"
          variants={fade}
          custom={0}
          initial="hidden"
          animate="show"
        >
          <span className="hero-tag-pill">Live</span>
          Қабул кушода · Ҷараёни баҳори 2026 · То хотима 38 рӯз
        </motion.span>

        <motion.h1
          className="display"
          variants={fade}
          custom={1}
          initial="hidden"
          animate="show"
        >
          Ҷаҳон — <em>кампуси ту.</em><br />
          Стипендияро <span className="underline">мо</span> мепардозем.
        </motion.h1>

        <div className="hero-grid">
          <div>
            <motion.p
              className="hero-lead"
              variants={fade}
              custom={2}
              initial="hidden"
              animate="show"
            >
              Javonon ба донишҷӯёни ҷасур кӯмак мекунад, ки ба беҳтарин донишгоҳҳои ҷаҳон
              тавассути <strong>грантҳои байналмилалии пурра пардохтшаванда</strong> — Fulbright,
              DAAD, Chevening, GKS, MEXT, CSC, Erasmus ва дигарон дохил шаванд.
            </motion.p>

            <motion.div
              className="hero-actions"
              variants={fade}
              custom={3}
              initial="hidden"
              animate="show"
            >
              <a href="#apply" className="btn btn-primary btn-large">
                Ариза фиристодан
                <Icon name="arrow_outward" size={18} />
              </a>
              <a href="#countries" className="btn btn-ghost-dark btn-large">
                Ҳамаи кишварҳо
              </a>
            </motion.div>
          </div>

          <div className="hero-stats">
            <motion.div
              className="hero-stat"
              variants={fade}
              custom={4}
              initial="hidden"
              animate="show"
            >
              <div className="hero-stat-num">
                40<span className="plus">+</span>
              </div>
              <div className="hero-stat-label">Кишвар · Грантҳои фаъол</div>
            </motion.div>
            <motion.div
              className="hero-stat"
              variants={fade}
              custom={5}
              initial="hidden"
              animate="show"
            >
              <div className="hero-stat-num">
                1.2<span style={{ fontSize: 32 }}>K</span>
              </div>
              <div className="hero-stat-label">Донишҷӯ бо грант · аз 2020</div>
            </motion.div>
            <motion.div
              className="hero-stat"
              variants={fade}
              custom={6}
              initial="hidden"
              animate="show"
            >
              <div className="hero-stat-num">94<span className="plus">%</span></div>
              <div className="hero-stat-label">Аризаҳои муваффақ</div>
            </motion.div>
          </div>
        </div>
      </div>

      <motion.div
        className="marquee"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.8 }}
      >
        <div className="marquee-track">
          {marqueeItems.map((u, i) => (
            <span key={i} className="marquee-item">{u}</span>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
