import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, viewportOnce } from '../motion';

const countries = [
  {
    flag: '🇺🇸',
    title: 'США',
    text: 'Fulbright, Hubert Humphrey, Schwarzman — топовые гранты Айви-лиги.',
    tags: ['Fulbright', 'Magistracy', 'PhD'],
  },
  {
    flag: '🇬🇧',
    title: 'Великобритания',
    text: 'Chevening, Commonwealth, GREAT — обучение в Oxford, Cambridge, LSE.',
    tags: ['Chevening', 'Master', '1 год'],
  },
  {
    flag: '🇩🇪',
    title: 'Германия',
    text: 'DAAD, Erasmus+ — бесплатные госуниверситеты + ежемесячная стипендия.',
    tags: ['DAAD', 'Бакалавриат', 'Магистратура'],
  },
  {
    flag: '🇰🇷',
    title: 'Южная Корея',
    text: 'GKS — год корейского + полная оплата обучения и проживания.',
    tags: ['GKS', 'Bachelor', 'IT'],
  },
  {
    flag: '🇨🇳',
    title: 'Китай',
    text: 'CSC, Confucius — гранты в Tsinghua, Peking University, Fudan.',
    tags: ['CSC', 'HSK', 'Engineering'],
  },
  {
    flag: '🇯🇵',
    title: 'Япония',
    text: 'MEXT — стипендия от правительства Японии, лучшие исследовательские лаборатории.',
    tags: ['MEXT', 'Research', 'PhD'],
  },
  {
    flag: '🇹🇷',
    title: 'Турция',
    text: 'Türkiye Bursları — полное покрытие обучения и проживания + год турецкого.',
    tags: ['YÖS', 'Bachelor', 'Все направления'],
  },
  {
    flag: '🇪🇺',
    title: 'Евросоюз',
    text: 'Erasmus Mundus — совместные магистратуры в 2-4 странах ЕС с одной заявки.',
    tags: ['Erasmus', 'Joint Master', 'EU'],
  },
];

export default function Directions() {
  return (
    <section id="directions" className="alt">
      <div className="container">
        <motion.div
          className="section-head"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          <motion.div className="section-eyebrow" variants={fadeUp}>Страны и гранты</motion.div>
          <motion.h2 variants={fadeUp}>Учись там, где мечтаешь</motion.h2>
          <motion.p variants={fadeUp}>
            Работаем напрямую с университетами и государственными грантовыми программами.
            Открыто <strong>40+ направлений</strong> по всему миру.
          </motion.p>
        </motion.div>

        <motion.div
          className="directions-grid"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          {countries.map((d) => (
            <motion.div
              key={d.title}
              className="direction-card"
              variants={fadeUp}
              whileHover={{ y: -6 }}
            >
              <span className="direction-flag">{d.flag}</span>
              <h3>{d.title}</h3>
              <p>{d.text}</p>
              <div className="direction-tags">
                {d.tags.map((t) => (
                  <span key={t} className="direction-tag">{t}</span>
                ))}
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
