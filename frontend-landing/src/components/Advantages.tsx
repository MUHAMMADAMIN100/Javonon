import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, viewportOnce } from '../motion';
import Icon from '../Icon';

const advantages = [
  {
    icon: 'handshake',
    title: 'Прямые партнёрства',
    text: 'Соглашения с 40+ университетами и государственными грантовыми фондами в Европе, Азии и Америке.',
  },
  {
    icon: 'savings',
    title: 'Бесплатная консультация',
    text: 'Первая встреча — без оплаты. Расскажем шансы, посчитаем бюджет и подберём вариант.',
  },
  {
    icon: 'checklist',
    title: 'Прозрачный процесс',
    text: 'Каждый этап в личном кабинете: загруженные документы, статусы заявок, дедлайны.',
  },
  {
    icon: 'bolt',
    title: 'Быстрый отклик',
    text: 'Менеджер отвечает в течение 30 минут в рабочее время. Никаких "перезвоним завтра".',
  },
  {
    icon: 'emoji_events',
    title: 'Опыт 6+ лет',
    text: '1200+ студентов получили грант через нашу платформу. 94% положительных решений по заявкам.',
  },
  {
    icon: 'verified_user',
    title: 'Гарантия по договору',
    text: 'Если по нашей вине грант не оформлен — возвращаем 100% оплаты. Без вопросов.',
  },
];

export default function Advantages() {
  return (
    <section id="advantages">
      <div className="container">
        <motion.div
          className="section-head"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          <motion.div className="section-eyebrow" variants={fadeUp}>Почему Javonon</motion.div>
          <motion.h2 variants={fadeUp}>Шесть причин начать с нами</motion.h2>
          <motion.p variants={fadeUp}>
            Мы не агентство-посредник. Мы — твоя команда поддержки на пути к стипендии.
          </motion.p>
        </motion.div>

        <motion.div
          className="advantages-grid"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          {advantages.map((a) => (
            <motion.div
              key={a.title}
              className="advantage-card"
              variants={fadeUp}
              whileHover={{ y: -4 }}
            >
              <div className="advantage-icon">
                <Icon name={a.icon} size={24} />
              </div>
              <div>
                <h3>{a.title}</h3>
                <p>{a.text}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
