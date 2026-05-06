import { motion } from 'framer-motion';
import { fadeUp, staggerContainer, viewportOnce } from '../motion';

const testimonials = [
  {
    initials: 'AK',
    name: 'Айгерим Каримова',
    role: 'Tsinghua University · Master AI',
    flag: '🇨🇳',
    text:
      'Я подавала на CSC грант сама два года подряд — и оба раза получала отказ. Через Javonon прошла с первого раза. Команда буквально за руку провела через каждый этап: эссе, рекомендации, интервью. Сейчас я в Tsinghua и не верю, что это реальность.',
  },
  {
    initials: 'AS',
    name: 'Ahmad Saidov',
    role: 'TU Munich · Bachelor IT',
    flag: '🇩🇪',
    text:
      'Думал, Германия — это нереально без знания немецкого. Javonon показали, что есть программы на английском, помогли с DAAD, перевели документы и подготовили мотивационное письмо. Сейчас учусь в TU Munich на полной стипендии.',
  },
  {
    initials: 'JL',
    name: 'Jamshed Latifi',
    role: 'Yonsei University · Bachelor',
    flag: '🇰🇷',
    text:
      'GKS — самый крупный корейский грант, и я был уверен, что туда невозможно попасть. Менеджер Javonon помог пройти три этапа отбора: документы, тест, интервью. Год корейского + 4 года бакалавриата за счёт правительства Кореи — это не сон.',
  },
  {
    initials: 'MS',
    name: 'Madina Shavqi',
    role: 'University of Manchester · Master',
    flag: '🇬🇧',
    text:
      'Chevening — это очень серьёзный конкурс. Javonon помогли мне подготовить эссе, которые действительно отражают мою историю. После года работы вместе я получила полный грант + стипендию на проживание в UK. Если рассматриваете Англию — однозначно сюда.',
  },
  {
    initials: 'RT',
    name: 'Rustam Toirov',
    role: 'Boğaziçi University · Bachelor',
    flag: '🇹🇷',
    text:
      'Türkiye Bursları закрывает всё — обучение, проживание, авиабилет. Javonon помогли собрать все документы за 2 недели, объяснили нюансы интервью. Сейчас я в Стамбуле и каждый день благодарен тем, кто поверил в меня.',
  },
  {
    initials: 'NS',
    name: 'Nilufar Sodiqova',
    role: 'Sapienza University · PhD',
    flag: '🇮🇹',
    text:
      'Я искала PhD-программы в Европе и долго путалась в дедлайнах разных стран. Javonon собрали для меня единый план с 6 разными грантами. В итоге попала на Erasmus Mundus — учусь сразу в Италии и Испании. Это уровень совсем другой.',
  },
];

export default function Testimonials() {
  return (
    <section id="testimonials" className="alt">
      <div className="container">
        <motion.div
          className="section-head"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          <motion.div className="section-eyebrow" variants={fadeUp}>Истории успеха</motion.div>
          <motion.h2 variants={fadeUp}>Студенты Javonon уже учатся по всему миру</motion.h2>
          <motion.p variants={fadeUp}>
            Реальные истории ребят, которые получили грант и улетели на учёбу мечты.
          </motion.p>
        </motion.div>

        <motion.div
          className="testimonials-grid"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          {testimonials.map((t) => (
            <motion.div
              key={t.name}
              className="testimonial"
              variants={fadeUp}
              whileHover={{ y: -4 }}
            >
              <span className="testimonial-quote">"</span>
              <p className="text">{t.text}</p>
              <div className="testimonial-author">
                <div className="testimonial-avatar">{t.initials}</div>
                <div>
                  <div className="testimonial-name">{t.name}</div>
                  <div className="testimonial-role">{t.role}</div>
                </div>
                <div className="testimonial-flag">{t.flag}</div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
