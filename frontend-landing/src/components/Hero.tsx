import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, scaleIn } from '../motion';
import Icon from '../Icon';

export default function Hero() {
  return (
    <section className="hero">
      <div className="container">
        <motion.div
          className="hero-inner"
          variants={staggerContainer}
          initial="hidden"
          animate="show"
        >
          <div>
            <motion.span className="hero-eyebrow" variants={fadeUp}>
              <span className="dot" />
              Международная платформа грантов · 2026
            </motion.span>
            <motion.h1 variants={fadeUp}>
              Получи <span className="gradient">грант на обучение</span> в лучших университетах мира
            </motion.h1>
            <motion.p className="lead" variants={fadeUp}>
              Javonon — твой проводник к стипендиям США, Великобритании, Германии,
              Кореи, Китая, Японии и других стран. Подбор программы, документы, виза,
              сопровождение от первого письма до зачисления.
            </motion.p>
            <motion.div className="hero-actions" variants={fadeUp}>
              <motion.a
                href="#apply"
                className="btn btn-primary btn-large"
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.97 }}
              >
                <Icon name="rocket_launch" size={20} />
                Подать на грант
              </motion.a>
              <motion.a
                href="#directions"
                className="btn btn-outline btn-large"
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.97 }}
              >
                Все направления
              </motion.a>
            </motion.div>

            <motion.div className="hero-stats" variants={staggerContainer}>
              {[
                { num: '40+', label: 'стран-партнёров' },
                { num: '1200+', label: 'студентов получили грант' },
                { num: '94%', label: 'успешных заявок' },
              ].map((s) => (
                <motion.div key={s.label} variants={fadeUp}>
                  <div className="hero-stat-num">{s.num}</div>
                  <div className="hero-stat-label">{s.label}</div>
                </motion.div>
              ))}
            </motion.div>
          </div>

          <motion.div className="hero-visual" variants={scaleIn}>
            <div className="hero-card">
              <div className="hero-globe">🌍</div>
            </div>

            <motion.div
              className="hero-badge hero-badge-1"
              animate={{ y: [0, -8, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <div className="hero-badge-icon">
                <Icon name="verified" size={22} />
              </div>
              <div className="hero-badge-text">
                <strong>Fulbright</strong>
                <span>США · Магистратура</span>
              </div>
            </motion.div>

            <motion.div
              className="hero-badge hero-badge-2"
              animate={{ y: [0, -10, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 1.5 }}
            >
              <div className="hero-badge-icon">
                <Icon name="school" size={22} />
              </div>
              <div className="hero-badge-text">
                <strong>DAAD</strong>
                <span>Германия · Бакалавриат</span>
              </div>
            </motion.div>

            <motion.div
              className="hero-badge hero-badge-3"
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
            >
              <div className="hero-badge-icon">
                <Icon name="public" size={22} />
              </div>
              <div className="hero-badge-text">
                <strong>+38 стран</strong>
                <span>Открыты заявки</span>
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
