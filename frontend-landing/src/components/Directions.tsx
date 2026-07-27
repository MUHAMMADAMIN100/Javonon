import { motion } from 'framer-motion';
import Icon from '../Icon';

const COUNTRIES = [
  { flag: '🇺🇸', name: 'ИМА', tags: ['Fulbright', 'Hubert Humphrey', 'Schwarzman'] },
  { flag: '🇬🇧', name: 'Британияи Кабир', tags: ['Chevening', 'Commonwealth', 'GREAT'] },
  { flag: '🇩🇪', name: 'Олмон', tags: ['DAAD', 'Bayerische', 'Heinrich Böll'] },
  { flag: '🇰🇷', name: 'Кореяи Ҷанубӣ', tags: ['GKS', 'POSCO', 'Yonsei'] },
  { flag: '🇨🇳', name: 'Хитой', tags: ['CSC', 'Confucius', 'Tsinghua'] },
  { flag: '🇯🇵', name: 'Ҷопон', tags: ['MEXT', 'JASSO', 'Honjo'] },
  { flag: '🇪🇺', name: 'Иттиҳоди Аврупо', tags: ['Erasmus Mundus', 'Marie Curie'] },
  { flag: '🇹🇷', name: 'Туркия', tags: ['Türkiye Bursları', 'YÖS'] },
  { flag: '🇨🇦', name: 'Канада', tags: ['Vanier', 'Trudeau', 'OGS'] },
  { flag: '🇦🇺', name: 'Австралия', tags: ['Australia Awards', 'RTP'] },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Directions() {
  return (
    <section id="countries" className="dark">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="eyebrow on-dark">Ту ба куҷо меравӣ</span>
            <h2 className="display">
              Чил кишвар.<br />
              <em>Як ариза.</em>
            </h2>
          </div>
          <p>
            Мо бевосита бо барномаҳои давлатии грантӣ, стипендияҳои
            донишгоҳӣ ва фондҳои хусусӣ дар шаш қитъа кор мекунем.
            Ту як маротиба ариза медиҳӣ — мо онро ба самтҳои
            мувофиқ тақсим мекунем.
          </p>
        </div>

        <div className="countries-list">
          {COUNTRIES.map((c, i) => (
            <motion.a
              key={c.name}
              href="#apply"
              className="country-row"
              variants={fadeUp}
              custom={i}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, amount: 0.1 }}
            >
              <span className="country-flag">{c.flag}</span>
              <span className="country-name">{c.name}</span>
              <span className="country-tags">
                {c.tags.map((t) => (
                  <span key={t} className="country-tag">{t}</span>
                ))}
              </span>
              <span className="country-arrow">
                <Icon name="arrow_outward" size={28} />
              </span>
            </motion.a>
          ))}
        </div>
      </div>
    </section>
  );
}
