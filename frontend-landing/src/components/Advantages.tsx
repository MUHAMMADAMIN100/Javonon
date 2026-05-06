import { motion } from 'framer-motion';

const STEPS = [
  {
    n: '01',
    title: 'Discovery call',
    text: 'A free 30-minute conversation to map your goals, profile and timeline. We tell you honestly what\'s possible.',
  },
  {
    n: '02',
    title: 'Grant shortlist',
    text: 'Within 5 days you get a personalised shortlist of 3–5 scholarships where your odds are real.',
  },
  {
    n: '03',
    title: 'Apply with us',
    text: 'Documents, essays, recommendations, translations — engineered with you, week by week, until submission.',
  },
  {
    n: '04',
    title: 'Pack your bags',
    text: 'Visa, housing, relocation, first-week support. Your only job is to show up and study.',
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
            <span className="eyebrow">How it works</span>
            <h2 className="display">
              Four steps.<br />
              <em>One acceptance letter.</em>
            </h2>
          </div>
          <p>
            We're not a bureaucracy and we're not a magic wand. We're a small team
            of people who have done this for 1,200 students before you — and we're
            allergic to wasting your time.
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
