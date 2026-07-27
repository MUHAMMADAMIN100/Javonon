import { motion } from 'framer-motion';
import Icon from '../Icon';

const CONTACTS = [
  {
    icon: 'mail',
    label: 'Почтаи электронӣ',
    value: 'hello@javonon.com',
    href: 'mailto:hello@javonon.com',
    sub: 'Ҷавоб дар 30 дақиқа',
  },
  {
    icon: 'send',
    label: 'Telegram',
    value: '@javonon',
    href: 'https://t.me/javonon',
    sub: 'Тезтарин канал',
  },
  {
    icon: 'call',
    label: 'Телефон',
    value: '+992 900 000 000',
    href: 'tel:+992900000000',
    sub: 'Дш–Шб, 9:00–19:00',
  },
  {
    icon: 'location_on',
    label: 'Офис',
    value: 'Душанбе',
    sub: 'хиёбони Рӯдакӣ, 55',
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
            <span className="eyebrow">Тамос</span>
            <h2 className="display">
              Бо одам сӯҳбат кун.<br />
              <em>Ҳамин имрӯз.</em>
            </h2>
          </div>
          <p>
            Канали қулайро интихоб кун. Мо дар ҳама якхела зуд ҷавоб медиҳем —
            одами воқеӣ дар тамос, бо забони ту, бидуни скрипт.
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
