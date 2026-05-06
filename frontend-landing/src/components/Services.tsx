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
            <span className="eyebrow">Что мы делаем</span>
            <h2 className="display">
              Один партнёр — от <em>сомнений</em><br />до письма о зачислении.
            </h2>
          </div>
          <p>
            Мы не просто оформляем бумаги. Мы выстраиваем твою кандидатуру —
            подбираем подходящие гранты, прокачиваем твою историю и доводим
            до результата.
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
              <h3>Подбор грантов с хирургической точностью.</h3>
            </div>
            <p>
              Мы сопоставляем твой профиль с 60+ активными стипендиями и оставляем
              те, где ты не просто проходишь по критериям — ты конкурентоспособен.
              Никаких "выстрелов в воздух". Только работающие варианты.
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
            <h3>Документы с характером</h3>
            <p>Мотивационные письма, study plan, рекомендации — пишем вместе с тобой, а не за тебя.</p>
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
            <h3>Mock-интервью</h3>
            <p>Тренировочные собеседования с выпускниками, прошедшими твою комиссию.</p>
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
            <h3>Подготовка к экзаменам</h3>
            <p>IELTS, TOEFL, GRE, GMAT, HSK, TOPIK — целевая подготовка под университет.</p>
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
            <h3>Виза и переезд</h3>
            <p>Документы в посольство, поиск жилья, встреча в аэропорту, первая неделя на месте.</p>
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
            <h3>Сообщество выпускников</h3>
            <p>Ты не просто бывший клиент — ты часть семьи Javonon. Менторство, рекомендации, новые возможности на годы вперёд.</p>
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
            <h3>Ответ за 30 минут</h3>
            <p>Твой персональный менеджер на связи в рабочее время. Никаких очередей и тикет-систем.</p>
            <span className="bento-num">07</span>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
