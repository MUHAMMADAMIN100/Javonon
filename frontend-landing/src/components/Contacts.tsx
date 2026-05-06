import { motion } from 'framer-motion';
import Icon from '../Icon';

const CONTACTS = [
  {
    icon: 'mail',
    label: 'Email',
    value: 'hello@javonon.com',
    href: 'mailto:hello@javonon.com',
    sub: 'Ответ за 30 минут',
  },
  {
    icon: 'send',
    label: 'Telegram',
    value: '@javonon',
    href: 'https://t.me/javonon',
    sub: 'Самый быстрый канал',
  },
  {
    icon: 'call',
    label: 'Телефон',
    value: '+992 900 000 000',
    href: 'tel:+992900000000',
    sub: 'Пн–Сб, 9:00–19:00',
  },
  {
    icon: 'location_on',
    label: 'Офис',
    value: 'Душанбе',
    sub: 'пр. Рудаки, 55',
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.05, duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Contacts() {
  return (
    <section id="contacts" className="alt">
      <div className="container">
        <div className="section-head">
          <div>
            <span className="eyebrow">Связаться</span>
            <h2 className="display">
              Поговори с человеком.<br />
              <em>Уже сегодня.</em>
            </h2>
          </div>
          <p>
            Выбери удобный канал. Мы отвечаем одинаково быстро во всех — реальный
            человек на связи, на твоём языке, без скриптов.
          </p>
        </div>

        <div className="contacts-strip">
          {CONTACTS.map((c, i) => (
            <motion.div
              key={c.label}
              className="contact-card"
              variants={fadeUp}
              custom={i}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, amount: 0.2 }}
            >
              <div className="contact-icon">
                <Icon name={c.icon} size={20} />
              </div>
              <h3>{c.label}</h3>
              {c.href ? (
                <a href={c.href} target={c.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                  {c.value}
                </a>
              ) : (
                <span>{c.value}</span>
              )}
              <div className="sub">{c.sub}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
