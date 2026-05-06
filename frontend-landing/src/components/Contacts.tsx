import { motion } from 'framer-motion';
import Icon from '../Icon';

const CONTACTS = [
  {
    icon: 'mail',
    label: 'Email',
    value: 'hello@javonon.com',
    href: 'mailto:hello@javonon.com',
    sub: 'Replies within 30 minutes',
  },
  {
    icon: 'send',
    label: 'Telegram',
    value: '@javonon',
    href: 'https://t.me/javonon',
    sub: 'Fastest channel',
  },
  {
    icon: 'call',
    label: 'Phone',
    value: '+992 900 000 000',
    href: 'tel:+992900000000',
    sub: 'Mon–Sat, 9am–7pm',
  },
  {
    icon: 'location_on',
    label: 'Office',
    value: 'Dushanbe, TJ',
    sub: 'Rudaki avenue 55',
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
            <span className="eyebrow">Get in touch</span>
            <h2 className="display">
              Talk to a human.<br />
              <em>Today, if you want.</em>
            </h2>
          </div>
          <p>
            Pick the channel that suits you. We answer the same way on all of them —
            quickly, in your language, with a real person on the other side.
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
