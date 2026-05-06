import { motion } from 'framer-motion';

const VOICES = [
  {
    initials: 'AK',
    name: 'Aigerim K.',
    where: 'Tsinghua · MS AI · CSC fully-funded',
    flag: '🇨🇳',
    quote:
      'I had been rejected twice on my own. Javonon rewrote my story without rewriting me — and I walked into Tsinghua with the full grant.',
  },
  {
    initials: 'AS',
    name: 'Ahmad S.',
    where: 'TU Munich · BSc CS · DAAD',
    flag: '🇩🇪',
    quote:
      'They told me Germany without German was possible. Eighteen months later I\'m in Munich, paying nothing, working at a research lab.',
  },
  {
    initials: 'JL',
    name: 'Jamshed L.',
    where: 'Yonsei · BA · Global Korea Scholarship',
    flag: '🇰🇷',
    quote:
      'Three rounds, language test, interview in Seoul. They prepped me for every single one. The acceptance email still feels unreal.',
  },
  {
    initials: 'MS',
    name: 'Madina S.',
    where: 'University of Manchester · MA · Chevening',
    flag: '🇬🇧',
    quote:
      'Chevening is brutal. The Javonon team treated my essays like they were applying themselves. I got the call in May.',
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
            <span className="eyebrow on-dark">Voices</span>
            <h2 className="display">
              Twelve hundred names.<br />
              <em>Four of them, here.</em>
            </h2>
          </div>
          <p>
            We could put statistics here. We'd rather put humans. These four
            scholars came to us with the same fear as you — and walked out with
            an acceptance letter.
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
