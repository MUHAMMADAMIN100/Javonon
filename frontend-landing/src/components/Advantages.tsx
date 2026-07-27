import { motion } from 'framer-motion';

const STEPS = [
  {
    n: '01',
    title: 'Машварати ройгон',
    text: 'Сӯҳбати 30-дақиқаӣ, то ҳадафҳо, профил ва мӯҳлатҳои туро фаҳмем. Мо ростқавлона мегӯем, ки чӣ воқеӣ асту чӣ не.',
  },
  {
    n: '02',
    title: 'Шортлисти грантҳо',
    text: 'Дар 5 рӯз ту рӯйхати шахсии 3–5 стипендияро мегирӣ, ки дар онҳо имкони воқеии гузаштан дорӣ.',
  },
  {
    n: '03',
    title: 'Якҷоя ариза медиҳем',
    text: 'Ҳуҷҷатҳо, эссе, тавсияномаҳо, тарҷумаҳо — ҳафта аз паси ҳафта то лаҳзаи супоридан омода мекунем.',
  },
  {
    n: '04',
    title: 'Ҷомадонро бипеч',
    text: 'Виза, манзил, кӯчидан, дастгирӣ дар ҳафтаи аввал. Вазифаи ту — омадану хондан.',
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
            <span className="eyebrow">Чӣ тавр кор мекунад</span>
            <h2 className="display">
              Чор қадам.<br />
              <em>Як номаи қабул.</em>
            </h2>
          </div>
          <p>
            Мо на мошини бюрократӣ ҳастем ва на асои ҷодугарӣ. Мо гурӯҳи
            хурде ҳастем, ки ин роҳро бо 1200 донишҷӯи пеш аз ту тай кардаем —
            ва вақти туро беҳуда сарф кардан намехоҳем.
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
