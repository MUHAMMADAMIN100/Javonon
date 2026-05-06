import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { submitApplication, type Direction, DIRECTION_LABEL } from '../api';
import Icon from '../Icon';
import PhoneInput, { COUNTRIES } from './PhoneInput';

const MAX_NAME = 100;
const MAX_EMAIL = 120;
const MAX_COMMENT = 500;

type Errors = Partial<Record<'fullName' | 'phone' | 'email' | 'comment', string>>;

const PERKS = [
  'Бесплатная консультация 30 минут',
  'Менеджер отвечает за 30 минут',
  'Гарантия по договору',
  'Сообщество выпускников на годы',
];

export default function ApplicationForm() {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [direction, setDirection] = useState<Direction>('BACHELOR');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const validateField = (field: keyof Errors, value: string): string | undefined => {
    if (field === 'fullName') {
      const v = value.trim();
      if (!v) return 'Введи своё имя';
      if (v.length < 2) return 'Имя слишком короткое';
      if (v.length > MAX_NAME) return `Максимум ${MAX_NAME} символов`;
      if (!/[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ]/.test(v)) return 'Только буквы';
      return;
    }
    if (field === 'phone') {
      const v = (value || '').trim();
      if (!v) return 'Укажи телефон';
      const matched = COUNTRIES.find((c) => v.startsWith(c.code));
      if (!matched) return 'Выбери код страны';
      const digits = v.slice(matched.code.length).replace(/\D/g, '');
      if (digits.length < matched.minDigits) return `Нужно ${matched.minDigits} цифр`;
      if (digits.length > matched.maxDigits) return `Слишком длинный номер`;
      return;
    }
    if (field === 'email') {
      const v = value.trim();
      if (!v) return;
      if (v.length > MAX_EMAIL) return `Максимум ${MAX_EMAIL} символов`;
      if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)) return 'Некорректный email';
      return;
    }
    if (field === 'comment') {
      if (value.length > MAX_COMMENT) return `Максимум ${MAX_COMMENT} символов`;
      return;
    }
    return;
  };

  const checkAll = (): Errors => ({
    fullName: validateField('fullName', fullName),
    phone: validateField('phone', phone),
    email: validateField('email', email),
    comment: validateField('comment', comment),
  });

  const cleanErrors = (e: Errors): Errors => {
    const out: Errors = {};
    (Object.keys(e) as (keyof Errors)[]).forEach((k) => {
      if (e[k]) out[k] = e[k];
    });
    return out;
  };

  const handleBlur = (field: keyof Errors) => {
    setTouched((t) => ({ ...t, [field]: true }));
    const value = field === 'fullName' ? fullName : field === 'phone' ? phone : field === 'email' ? email : comment;
    const err = validateField(field, value);
    setErrors((prev) => ({ ...prev, [field]: err }));
  };

  const handleFieldChange = (field: keyof Errors, value: string) => {
    if (field === 'fullName') setFullName(value);
    else if (field === 'phone') {
      setPhone(value);
      if (touched.phone || errors.phone) {
        const err = validateField('phone', value);
        setErrors((prev) => ({ ...prev, phone: err }));
      }
      return;
    }
    else if (field === 'email') setEmail(value);
    else if (field === 'comment') setComment(value);
    if (touched[field] || errors[field]) {
      const err = validateField(field, value);
      setErrors((prev) => ({ ...prev, [field]: err }));
    }
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setServerError(null);
    const all = cleanErrors(checkAll());
    setErrors(all);
    setTouched({ fullName: true, phone: true, email: true, comment: true });
    if (Object.keys(all).length > 0) return;

    setSubmitting(true);
    try {
      await submitApplication({
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim() || undefined,
        direction,
        comment: comment.trim() || undefined,
      });
      setSuccess(true);
      try {
        (window as any).gtag?.('event', 'submit_application', { direction });
        (window as any).ym?.((window as any).__YM_ID__, 'reachGoal', 'APPLICATION_SUBMIT');
      } catch {}
      setFullName(''); setPhone(''); setEmail(''); setComment('');
      setDirection('BACHELOR');
      setErrors({});
      setTouched({});
      setTimeout(() => setSuccess(false), 8000);
    } catch (err: any) {
      setServerError(err?.message || 'Что-то пошло не так. Попробуй ещё раз.');
    } finally {
      setSubmitting(false);
    }
  };

  const invalid = (f: keyof Errors) => (touched[f] || !!errors[f]) && !!errors[f];

  return (
    <section id="apply" className="cta">
      <div className="container cta-grid">
        <div className="cta-left">
          <span className="eyebrow on-dark">Подать заявку</span>
          <h2>
            Расскажи о себе.<br />
            <em>Остальное — наша работа.</em>
          </h2>
          <p>
            Одна короткая форма. Реальный человек прочитает её в течение 30 минут
            в рабочее время. Никаких ботов, автоответчиков и "ваш звонок очень
            важен для нас".
          </p>
          <ul className="cta-list">
            {PERKS.map((p) => (
              <li key={p} className="cta-list-item">
                <span className="dot" /> {p}
              </li>
            ))}
          </ul>
        </div>

        <div className="cta-right">
          <motion.form
            className="form-card"
            onSubmit={handleSubmit}
            noValidate
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="form-eyebrow">Шаг 01 · О тебе</div>
            <h3>Начни путь к гранту</h3>

            <AnimatePresence>
              {success && (
                <motion.div
                  className="form-success"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                >
                  <div className="ok-icon"><Icon name="check" size={28} /></div>
                  <div style={{ fontSize: 18, fontWeight: 500 }}>Заявка получена</div>
                  <div style={{ fontWeight: 400, fontSize: 14, marginTop: 8, color: 'var(--night-text-soft)' }}>
                    Менеджер Javonon свяжется с тобой в течение 30 минут.
                  </div>
                </motion.div>
              )}
              {serverError && (
                <motion.div className="form-fail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Icon name="error" size={16} style={{ marginRight: 8, verticalAlign: 'middle' }} />
                  {serverError}
                </motion.div>
              )}
            </AnimatePresence>

            {!success && (
              <>
                <div className="form-row">
                  <label>ФИО</label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => handleFieldChange('fullName', e.target.value)}
                    onBlur={() => handleBlur('fullName')}
                    placeholder="Иванов Иван Иванович"
                    maxLength={MAX_NAME}
                    className={invalid('fullName') ? 'error' : ''}
                    autoComplete="name"
                  />
                  {invalid('fullName') && <div className="form-error">{errors.fullName}</div>}
                </div>

                <div className="form-row">
                  <label>Телефон</label>
                  <PhoneInput
                    value={phone}
                    onChange={(v) => handleFieldChange('phone', v)}
                    error={invalid('phone')}
                  />
                  {invalid('phone') && <div className="form-error">{errors.phone}</div>}
                </div>

                <div className="form-row">
                  <label>Email <span style={{ opacity: 0.5 }}>(не обязательно)</span></label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => handleFieldChange('email', e.target.value)}
                    onBlur={() => handleBlur('email')}
                    placeholder="you@example.com"
                    maxLength={MAX_EMAIL}
                    className={invalid('email') ? 'error' : ''}
                    autoComplete="email"
                  />
                  {invalid('email') && <div className="form-error">{errors.email}</div>}
                </div>

                <div className="form-row">
                  <label>Цель</label>
                  <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                    {(Object.keys(DIRECTION_LABEL) as Direction[]).map((d) => (
                      <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <label>
                    Что важно знать?
                    <span className="form-counter">{comment.length}/{MAX_COMMENT}</span>
                  </label>
                  <textarea
                    value={comment}
                    onChange={(e) => handleFieldChange('comment', e.target.value)}
                    onBlur={() => handleBlur('comment')}
                    placeholder="Страна, университет, дедлайн, бюджет — всё, что поможет нам помочь тебе."
                    maxLength={MAX_COMMENT}
                    className={invalid('comment') ? 'error' : ''}
                  />
                  {invalid('comment') && <div className="form-error">{errors.comment}</div>}
                </div>

                <motion.button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                  whileHover={!submitting ? { scale: 1.02 } : {}}
                  whileTap={!submitting ? { scale: 0.98 } : {}}
                >
                  {submitting ? 'Отправляем...' : (
                    <>Отправить заявку <Icon name="arrow_outward" size={18} /></>
                  )}
                </motion.button>
                <p className="form-hint">
                  Нажимая кнопку, ты соглашаешься с обработкой данных
                </p>
              </>
            )}
          </motion.form>
        </div>
      </div>
    </section>
  );
}
