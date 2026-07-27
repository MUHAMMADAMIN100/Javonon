import { motion } from 'framer-motion';

const VOICES = [
  {
    initials: 'АК',
    name: 'Айгерим К.',
    where: 'Tsinghua · Магистратураи AI · CSC, гранти пурра',
    flag: '🇨🇳',
    quote:
      'Ман ду маротиба мустақилона ариза додам — ҳар ду бор рад. Javonon ҳикояи маро аз нав навишт, вале худи маро тағйир надод. Ва ман бо гранти пурра ба Tsinghua ворид шудам.',
  },
  {
    initials: 'АС',
    name: 'Ахмад С.',
    where: 'TU Munich · Бакалавриати CS · DAAD',
    flag: '🇩🇪',
    quote:
      'Ба ман гуфтанд, ки Олмон бидуни забони олмонӣ имконпазир аст. Пас аз 18 моҳ ман дар Мюнхен ҳастам, барои таҳсил пул намедиҳам ва дар лабораторияи тадқиқотӣ кор мекунам.',
  },
  {
    initials: 'ДЛ',
    name: 'Джамшед Л.',
    where: 'Yonsei · Бакалавриат · Global Korea Scholarship',
    flag: '🇰🇷',
    quote:
      'Се даври интихоб, тести забон, мусоҳиба дар Сеул. Гурӯҳ маро ба ҳар қадам омода кард. Номаи қабул то ҳол ба хоб монанд аст.',
  },
  {
    initials: 'МС',
    name: 'Мадина С.',
    where: 'University of Manchester · Магистратура · Chevening',
    flag: '🇬🇧',
    quote:
      'Chevening озмуни ҷиддӣ аст. Гурӯҳи Javonon ба эссеҳои ман чунон муносибат кард, гӯё худаш ариза медиҳад. Ман дар моҳи май занг гирифтам.',
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.1, duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Testimonials() {
  return (
    <section id="voices" className="dark">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="eyebrow on-dark">Ҳикояҳо</span>
            <h2 className="display">
              Ҳазору дусад ном.<br />
              <em>Чортои онҳо — ин ҷо.</em>
            </h2>
          </div>
          <p>
            Мо метавонистем ин ҷо омор гузорем. Беҳтараш одамонро мегузорем.
            Ин чор донишҷӯ бо ҳамон тарсҳое омаданд, ки ту дорӣ — ва бо
            номаи қабул рафтанд.
          </p>
        </div>

        <div className="testimonials-grid">
          {VOICES.map((v, i) => (
            <motion.div
              key={v.name}
              className="testi"
              variants={fadeUp}
              custom={i}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, amount: 0.15 }}
            >
              <div className="testi-quote">{v.quote}</div>
              <div className="testi-author">
                <div className="testi-avatar">{v.initials}</div>
                <div className="testi-meta">
                  <div className="testi-name">{v.name}</div>
                  <div className="testi-where">{v.where}</div>
                </div>
                <div className="testi-flag">{v.flag}</div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
