import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, viewportOnce } from '../motion';
import Icon from '../Icon';

const contacts = [
  {
    icon: 'call',
    title: 'Телефон',
    content: <a href="tel:+992900000000">+992 900 000 000</a>,
    sub: 'Пн–Сб с 9:00 до 19:00',
  },
  {
    icon: 'mail',
    title: 'Email',
    content: <a href="mailto:hello@javonon.com">hello@javonon.com</a>,
    sub: 'Ответим в течение часа',
  },
  {
    icon: 'send',
    title: 'Telegram',
    content: <a href="https://t.me/javonon" target="_blank" rel="noopener">@javonon</a>,
    sub: 'Пиши в любое время',
  },
  {
    icon: 'location_on',
    title: 'Офис',
    content: <span>г. Душанбе · ул. Рудаки, 55</span>,
    sub: 'Запись на встречу',
  },
];

export default function Contacts() {
  return (
    <section id="contacts">
      <div className="container">
        <motion.div
          className="section-head"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          <motion.div className="section-eyebrow" variants={fadeUp}>Контакты</motion.div>
          <motion.h2 variants={fadeUp}>Связаться с командой Javonon</motion.h2>
          <motion.p variants={fadeUp}>
            Ответим на вопросы о грантах, странах, документах и сроках.
          </motion.p>
        </motion.div>

        <motion.div
          className="contacts-grid"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          {contacts.map((c) => (
            <motion.div
              key={c.title}
              className="contact-card"
              variants={fadeUp}
              whileHover={{ y: -6 }}
            >
              <div className="contact-icon">
                <Icon name={c.icon} size={32} />
              </div>
              <h3>{c.title}</h3>
              {c.content}
              <p style={{ marginTop: 6, fontSize: 13, color: 'var(--text-mute)' }}>{c.sub}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
