import { motion } from 'framer-motion';
import Icon from '../Icon';

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Services() {
  return (
    <section id="services">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="eyebrow">Мо чӣ кор мекунем</span>
            <h2 className="display">
              Як ҳамкор — аз <em>шубҳа</em><br />то номаи қабул.
            </h2>
          </div>
          <p>
            Мо танҳо ҳуҷҷат намерасонем. Мо номзадии туро месозем —
            грантҳои мувофиқро интихоб мекунем, ҳикояи туро қавӣ мегардонем
            ва то натиҷа мебарем.
          </p>
        </div>

        <div className="bento">
          <motion.div
            className="bento-card feature span-4 row-2"
            variants={fadeUp}
            custom={0}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div>
              <div className="bento-icon">
                <Icon name="travel_explore" size={24} />
              </div>
              <h3>Интихоби грантҳо бо дақиқии ҷарроҳӣ.</h3>
            </div>
            <p>
              Мо профили туро бо 60+ стипендияи фаъол муқоиса мекунем ва танҳо
              онҳоеро мемонем, ки дар онҳо ту на танҳо ба меъёрҳо мувофиқӣ — балки
              рақобатпазир ҳастӣ. Ҳеҷ «тир ба ҳаво». Танҳо вариантҳои коргар.
            </p>
            <span className="bento-num">01</span>
          </motion.div>

          <motion.div
            className="bento-card span-2"
            variants={fadeUp}
            custom={1}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="edit_document" size={22} />
            </div>
            <h3>Ҳуҷҷатҳо бо характер</h3>
            <p>Номаҳои ҳавасмандӣ, study plan, тавсияномаҳо — мо ҳамроҳи ту менависем, на ба ҷои ту.</p>
            <span className="bento-num">02</span>
          </motion.div>

          <motion.div
            className="bento-card accent span-2"
            variants={fadeUp}
            custom={2}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="forum" size={22} />
            </div>
            <h3>Mock-мусоҳиба</h3>
            <p>Мусоҳибаҳои омӯзишӣ бо хатмкунандагоне, ки аз ҳамон комиссия гузаштаанд.</p>
            <span className="bento-num">03</span>
          </motion.div>

          <motion.div
            className="bento-card span-2"
            variants={fadeUp}
            custom={3}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="language" size={22} />
            </div>
            <h3>Омодагӣ ба имтиҳонҳо</h3>
            <p>IELTS, TOEFL, GRE, GMAT, HSK, TOPIK — омодагии мақсаднок барои донишгоҳи интихобшуда.</p>
            <span className="bento-num">04</span>
          </motion.div>

          <motion.div
            className="bento-card span-2"
            variants={fadeUp}
            custom={4}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="flight_takeoff" size={22} />
            </div>
            <h3>Виза ва кӯчидан</h3>
            <p>Ҳуҷҷатҳо ба сафорат, ҷустуҷӯи манзил, пешвоз дар фурудгоҳ, ҳафтаи аввал дар ҷои нав.</p>
            <span className="bento-num">05</span>
          </motion.div>

          <motion.div
            className="bento-card span-3"
            variants={fadeUp}
            custom={5}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="favorite" size={22} />
            </div>
            <h3>Ҷомеаи хатмкунандагон</h3>
            <p>Ту танҳо мизоҷи собиқ нестӣ — ту узви оилаи Javonon ҳастӣ. Менторӣ, тавсияҳо, имкониятҳои нав барои солҳои оянда.</p>
            <span className="bento-num">06</span>
          </motion.div>

          <motion.div
            className="bento-card span-3"
            variants={fadeUp}
            custom={6}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, amount: 0.2 }}
          >
            <div className="bento-icon">
              <Icon name="bolt" size={22} />
            </div>
            <h3>Ҷавоб дар 30 дақиқа</h3>
            <p>Менеҷери шахсии ту дар вақти корӣ ҳамеша дар тамос. Ҳеҷ навбат ва системаи тикет.</p>
            <span className="bento-num">07</span>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
