import { motion } from 'framer-motion';

const STEPS = [
  {
    n: '01',
    title: 'Бесплатная консультация',
    text: '30-минутный разговор, чтобы понять твои цели, профиль и сроки. Мы честно говорим, что реально, а что нет.',
  },
  {
    n: '02',
    title: 'Шортлист грантов',
    text: 'За 5 дней ты получаешь персональный список из 3–5 стипендий, где у тебя реальные шансы пройти.',
  },
  {
    n: '03',
    title: 'Подаём вместе',
    text: 'Документы, эссе, рекомендации, переводы — оформляем неделя за неделей до момента подачи.',
  },
  {
    n: '04',
    title: 'Собирай чемодан',
    text: 'Виза, жильё, переезд, поддержка в первую неделю. Твоя задача — приехать и учиться.',
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Advantages() {
  return (
    <section id="how">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="eyebrow">Как это работает</span>
            <h2 className="display">
              Четыре шага.<br />
              <em>Одно письмо о зачислении.</em>
            </h2>
          </div>
          <p>
            Мы не бюрократическая машина и не волшебная палочка. Мы — небольшая
            команда, которая прошла этот путь с 1200 студентами до тебя — и мы
            не любим тратить твоё время впустую.
          </p>
        </div>

        <div className="process-grid">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              className="process-step"
              variants={fadeUp}
              custom={i}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, amount: 0.2 }}
            >
              <div className="process-num">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
