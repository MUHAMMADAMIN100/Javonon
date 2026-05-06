import { motion } from 'framer-motion';

const VOICES = [
  {
    initials: 'АК',
    name: 'Айгерим К.',
    where: 'Tsinghua · Магистратура AI · CSC, полный грант',
    flag: '🇨🇳',
    quote:
      'Я подавала самостоятельно дважды — оба раза отказ. Javonon переписали мою историю, не переписывая меня. И я зашла в Tsinghua с полным грантом.',
  },
  {
    initials: 'АС',
    name: 'Ахмад С.',
    where: 'TU Munich · Бакалавриат CS · DAAD',
    flag: '🇩🇪',
    quote:
      'Мне сказали, что Германия без немецкого реальна. Через 18 месяцев я в Мюнхене, не плачу за обучение и работаю в исследовательской лаборатории.',
  },
  {
    initials: 'ДЛ',
    name: 'Джамшед Л.',
    where: 'Yonsei · Бакалавриат · Global Korea Scholarship',
    flag: '🇰🇷',
    quote:
      'Три тура отбора, языковой тест, интервью в Сеуле. Команда подготовила меня к каждому шагу. Письмо о зачислении до сих пор кажется нереальным.',
  },
  {
    initials: 'МС',
    name: 'Мадина С.',
    where: 'University of Manchester · Магистратура · Chevening',
    flag: '🇬🇧',
    quote:
      'Chevening — это серьёзный конкурс. Команда Javonon отнеслась к моим эссе так, будто подаёт сама. Я получила звонок в мае.',
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
            <span className="eyebrow on-dark">Истории</span>
            <h2 className="display">
              Тысяча двести имён.<br />
              <em>Четыре из них — здесь.</em>
            </h2>
          </div>
          <p>
            Мы могли бы поставить тут статистику. Лучше поставим людей.
            Эти четыре студента пришли с теми же страхами, что у тебя — и
            ушли с письмом о зачислении.
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
