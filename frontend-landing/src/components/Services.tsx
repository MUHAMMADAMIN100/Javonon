import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, viewportOnce } from '../motion';
import Icon from '../Icon';

const services = [
  {
    icon: 'travel_explore',
    title: 'Подбор грантов',
    text: 'Анализируем твой профиль и подбираем стипендии, на которые ты реально пройдёшь — от полностью покрываемых до частичных.',
  },
  {
    icon: 'description',
    title: 'Документы под ключ',
    text: 'Мотивационное письмо, рекомендации, перевод и нотариальное заверение — всё готовим вместе с экспертами.',
  },
  {
    icon: 'language',
    title: 'Языковая подготовка',
    text: 'Курсы IELTS, TOEFL, TOPIK, HSK, TestDaF — целевая подготовка к экзамену, который требует университет.',
  },
  {
    icon: 'flight_takeoff',
    title: 'Виза и переезд',
    text: 'Полное сопровождение визового процесса, помощь с поиском жилья, страховкой и встречей в аэропорту.',
  },
  {
    icon: 'forum',
    title: 'Подготовка к интервью',
    text: 'Mock-собеседования с консультантами, разбор типичных вопросов комиссии, работа над презентацией.',
  },
  {
    icon: 'support_agent',
    title: 'Поддержка 24/7',
    text: 'Личный менеджер на связи весь путь — от первой консультации до момента, когда ты стоишь на пороге университета.',
  },
];

export default function Services() {
  return (
    <section id="services">
      <div className="container">
        <motion.div
          className="section-head"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          <motion.div className="section-eyebrow" variants={fadeUp}>
            Что мы делаем
          </motion.div>
          <motion.h2 variants={fadeUp}>
            Полный цикл сопровождения — от заявки до зачисления
          </motion.h2>
          <motion.p variants={fadeUp}>
            Не оставляем тебя один на один с бумажками и сроками. Каждый шаг — с экспертом.
          </motion.p>
        </motion.div>

        <motion.div
          className="services-grid"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          {services.map((s) => (
            <motion.div
              key={s.title}
              className="service-card"
              variants={fadeUp}
              whileHover={{ y: -6 }}
            >
              <div className="service-icon">
                <Icon name={s.icon} size={28} />
              </div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
