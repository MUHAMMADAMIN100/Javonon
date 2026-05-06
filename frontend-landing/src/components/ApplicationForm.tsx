import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { submitApplication, type Direction, DIRECTION_LABEL } from '../api';
import { fadeUp, staggerContainer, viewportOnce } from '../motion';
import Icon from '../Icon';
import PhoneInput, { COUNTRIES } from './PhoneInput';

const MAX_NAME = 100;
const MAX_EMAIL = 120;
const MAX_COMMENT = 500;

type Errors = Partial<Record<'fullName' | 'phone' | 'email' | 'comment', string>>;

export default function ApplicationForm() {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState(''); // полный номер с кодом
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
      if (v.length === 0) return 'Введите ваше ФИО';
      if (v.length < 2) return 'Имя слишком короткое';
      if (v.length > MAX_NAME) return `Максимум ${MAX_NAME} символов`;
      if (!/[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ]/.test(v)) return 'ФИО должно содержать буквы';
      if (/[<>{}[\]\\\/]/.test(v)) return 'Недопустимые символы';
      return;
    }
    if (field === 'phone') {
      const v = (value || '').trim();
      if (!v) return 'Укажите номер телефона';
      const matched = COUNTRIES.find((c) => v.startsWith(c.code));
      if (!matched) return 'Выберите код страны';
      const digits = v.slice(matched.code.length).replace(/\D/g, '');
      if (digits.length < matched.minDigits) return `Слишком короткий номер (нужно ${matched.minDigits} цифр)`;
      if (digits.length > matched.maxDigits) return `Слишком длинный номер`;
      return;
    }
    if (field === 'email') {
      const v = value.trim();
      if (!v) return; // необязательное
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
      setTimeout(() => setSuccess(false), 6000);
    } catch (err: any) {
      setServerError(err?.message || 'Ошибка отправки. Попробуйте ещё раз.');
    } finally {
      setSubmitting(false);
    }
  };

  const invalid = (f: keyof Errors) => (touched[f] || !!errors[f]) && !!errors[f];

  return (
    <section id="apply" className="form-section">
      <div className="container">
        <motion.div
          className="section-head"
          variants={staggerContainer}
          initial="hidden"
          whileInView="show"
          viewport={viewportOnce}
        >
          <motion.div className="section-eyebrow" variants={fadeUp}>Подать заявку</motion.div>
          <motion.h2 variants={fadeUp}>Получи бесплатную консультацию</motion.h2>
          <motion.p variants={fadeUp}>
            Оставь заявку — менеджер свяжется в течение часа и подберёт грант под твой профиль.
          </motion.p>
        </motion.div>

        <motion.form
          className="form-card"
          onSubmit={handleSubmit}
          noValidate
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewportOnce}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <h3>Расскажи о себе</h3>
          <p className="form-sub">Поля, отмеченные *, обязательны для заполнения</p>

          <AnimatePresence>
            {success && (
              <motion.div
                className="form-success"
                initial={{ opacity: 0, scale: 0.9, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.3 }}
              >
                <div className="ok-icon"><Icon name="check_circle" size={32} /></div>
                <div>Заявка получена!</div>
                <div style={{ fontWeight: 400, fontSize: 14, marginTop: 6 }}>
                  Менеджер Javonon свяжется с тобой в течение часа.
                </div>
              </motion.div>
            )}
            {serverError && (
              <motion.div
                className="form-fail"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: [0, -8, 8, -6, 6, 0] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
              >
                <Icon name="warning" size={20} style={{ marginRight: 8 }} />
                {serverError}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="form-row">
            <label>ФИО *</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => handleFieldChange('fullName', e.target.value)}
              onBlur={() => handleBlur('fullName')}
              placeholder="Иванов Иван Иванович"
              maxLength={MAX_NAME}
              className={invalid('fullName') ? 'input-error' : ''}
              autoComplete="name"
            />
            <AnimatePresence>
              {invalid('fullName') && (
                <motion.div
                  className="form-error"
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  {errors.fullName}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="form-row">
            <label>Номер телефона *</label>
            <PhoneInput
              value={phone}
              onChange={(v) => handleFieldChange('phone', v)}
              error={invalid('phone')}
            />
            <AnimatePresence>
              {invalid('phone') && (
                <motion.div
                  className="form-error"
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  onBlur={() => handleBlur('phone')}
                >
                  {errors.phone}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="form-row">
            <label>Email (необязательно)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => handleFieldChange('email', e.target.value)}
              onBlur={() => handleBlur('email')}
              placeholder="you@example.com"
              maxLength={MAX_EMAIL}
              className={invalid('email') ? 'input-error' : ''}
              autoComplete="email"
            />
            <AnimatePresence>
              {invalid('email') && (
                <motion.div
                  className="form-error"
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  {errors.email}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="form-row">
            <label>Направление *</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              {(Object.keys(DIRECTION_LABEL) as Direction[]).map((d) => (
                <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label>
              Комментарий
              <span className="form-counter">{comment.length} / {MAX_COMMENT}</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => handleFieldChange('comment', e.target.value)}
              onBlur={() => handleBlur('comment')}
              placeholder="Расскажи о своих целях: страна мечты, направление, ожидаемый бюджет..."
              maxLength={MAX_COMMENT}
              className={invalid('comment') ? 'input-error' : ''}
            />
            <AnimatePresence>
              {invalid('comment') && (
                <motion.div
                  className="form-error"
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  {errors.comment}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <motion.button
            type="submit"
            className="btn btn-primary btn-large"
            disabled={submitting}
            whileHover={!submitting ? { scale: 1.02, y: -2 } : {}}
            whileTap={!submitting ? { scale: 0.98 } : {}}
          >
            {submitting ? 'Отправляем...' : 'Подать заявку на грант'}
          </motion.button>
          <p className="form-hint">
            Нажимая кнопку, ты соглашаешься на обработку персональных данных
          </p>
        </motion.form>
      </div>
    </section>
  );
}
