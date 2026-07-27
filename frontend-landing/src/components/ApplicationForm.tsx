import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { submitApplication, type Direction, DIRECTION_LABEL, type ContactChannel } from '../api';
import { getReferral } from '../referral';
import Icon from '../Icon';
import PhoneInput, { COUNTRIES } from './PhoneInput';

const MAX_NAME = 100;
const MAX_EMAIL = 120;
const MAX_COMMENT = 500;

type Errors = Partial<Record<'fullName' | 'phone' | 'email' | 'comment' | 'secondaryPhone', string>>;

const PERKS = [
  'Машварати ройгон 30 дақиқа',
  'Менеҷер дар 30 дақиқа ҷавоб медиҳад',
  'Кафолат аз рӯи шартнома',
  'Ҷомеаи хатмкунандагон барои солҳо',
];

export default function ApplicationForm() {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [direction, setDirection] = useState<Direction>('BACHELOR');
  const [comment, setComment] = useState('');
  // По ТЗ §8 — доп. контакт (родитель/опекун) + предпочтительный канал
  // связи. Свёрнуто по умолчанию, чтобы не перегружать форму.
  const [showExtra, setShowExtra] = useState(false);
  const [secondaryPhone, setSecondaryPhone] = useState('');
  const [secondaryLabel, setSecondaryLabel] = useState('');
  const [preferredChannel, setPreferredChannel] = useState<ContactChannel | ''>('');
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Общая проверка номера для основного и дополнительного телефона.
  // Пустое значение здесь НЕ считается ошибкой — обязательность решает вызывающий,
  // т.к. phone обязателен, а secondaryPhone (родитель/опекун) — нет.
  // Порог minDigits (7 цифр) специально не ниже, чем backend PHONE_RE
  // /^\+?[\d\s\-()]{7,20}$/ в create-application.dto.ts: там 7 символов считаются
  // ВМЕСТЕ с кодом страны, поэтому «+992» + 1..3 цифры прошло бы фронт, но упало
  // бы в 400 на бэке. Проверка ниже строже, значит недобитый номер до сети не дойдёт.
  const validatePhoneValue = (value: string): string | undefined => {
    const v = (value || '').trim();
    const matched = COUNTRIES.find((c) => v.startsWith(c.code));
    if (!matched) return 'Коди кишварро интихоб кунед';
    const digits = v.slice(matched.code.length).replace(/\D/g, '');
    if (digits.length < matched.minDigits) return `${matched.minDigits} рақам лозим аст`;
    if (digits.length > matched.maxDigits) return `Рақам хеле дароз аст`;
    return;
  };

  const validateField = (field: keyof Errors, value: string): string | undefined => {
    if (field === 'fullName') {
      const v = value.trim();
      if (!v) return 'Ному насаби худро нависед';
      if (v.length < 2) return 'Ном хеле кӯтоҳ аст';
      if (v.length > MAX_NAME) return `Ҳадди аксар ${MAX_NAME} аломат`;
      if (!/[A-Za-zА-Яа-яЁёҚқҒғҲҳҶҷӢӣӮӯ]/.test(v)) return 'Танҳо ҳарфҳо';
      return;
    }
    if (field === 'phone') {
      const v = (value || '').trim();
      if (!v) return 'Рақами телефонро нависед';
      return validatePhoneValue(v);
    }
    if (field === 'secondaryPhone') {
      const v = (value || '').trim();
      // Поле необязательное: пусто — валидно.
      if (!v) return;
      return validatePhoneValue(v);
    }
    if (field === 'email') {
      const v = value.trim();
      if (!v) return;
      if (v.length > MAX_EMAIL) return `Ҳадди аксар ${MAX_EMAIL} аломат`;
      if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v)) return 'Почтаи электронӣ нодуруст';
      return;
    }
    if (field === 'comment') {
      if (value.length > MAX_COMMENT) return `Ҳадди аксар ${MAX_COMMENT} аломат`;
      return;
    }
    return;
  };

  const fieldValue = (field: keyof Errors): string => {
    if (field === 'fullName') return fullName;
    if (field === 'phone') return phone;
    if (field === 'email') return email;
    if (field === 'secondaryPhone') return secondaryPhone;
    return comment;
  };

  const checkAll = (): Errors => ({
    fullName: validateField('fullName', fullName),
    phone: validateField('phone', phone),
    email: validateField('email', email),
    comment: validateField('comment', comment),
    // secondaryPhone уходит в тело запроса (см. handleSubmit), поэтому его
    // тоже надо проверить до отправки — иначе недобитый номер даёт 400
    // и вся заявка теряется.
    secondaryPhone: validateField('secondaryPhone', secondaryPhone),
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
    const err = validateField(field, fieldValue(field));
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
    // PhoneInput не даёт onBlur, поэтому доп. номер валидируем «вживую»,
    // как и основной: после первого submit / первой ошибки.
    else if (field === 'secondaryPhone') {
      setSecondaryPhone(value);
      if (touched.secondaryPhone || errors.secondaryPhone) {
        const err = validateField('secondaryPhone', value);
        setErrors((prev) => ({ ...prev, secondaryPhone: err }));
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
    setTouched({ fullName: true, phone: true, email: true, comment: true, secondaryPhone: true });
    // Ошибка в свёрнутом блоке была бы невидимым блокером сабмита — разворачиваем.
    if (all.secondaryPhone) setShowExtra(true);
    if (Object.keys(all).length > 0) return;

    setSubmitting(true);
    try {
      await submitApplication({
        fullName: fullName.trim(),
        phone: phone.trim(),
        secondaryPhone: secondaryPhone.trim() || undefined,
        secondaryContactLabel: secondaryLabel.trim() || undefined,
        preferredChannel: preferredChannel || undefined,
        email: email.trim() || undefined,
        direction,
        comment: comment.trim() || undefined,
        // Реферальный код партнёра (TTL-aware чтение из localStorage).
        // Без этого ReferralsService.attribute() на бэке не запускается
        // и комиссия партнёру не начисляется. clearReferral() НЕ вызываем:
        // TTL сам покроет истечение, а повторная заявка того же клиента
        // внутри TTL должна атрибутироваться тому же партнёру
        // (dedupe на уровне Attribution в backend).
        ref: getReferral() || undefined,
      });
      setSuccess(true);
      try {
        (window as any).gtag?.('event', 'submit_application', { direction });
        (window as any).ym?.((window as any).__YM_ID__, 'reachGoal', 'APPLICATION_SUBMIT');
      } catch {}
      setFullName(''); setPhone(''); setEmail(''); setComment('');
      setSecondaryPhone(''); setSecondaryLabel(''); setPreferredChannel('');
      setShowExtra(false);
      setDirection('BACHELOR');
      setErrors({});
      setTouched({});
      setTimeout(() => setSuccess(false), 8000);
    } catch (err: any) {
      setServerError(err?.message || 'Хатогӣ рух дод. Лутфан бори дигар кӯшиш кунед.');
    } finally {
      setSubmitting(false);
    }
  };

  const invalid = (f: keyof Errors) => (touched[f] || !!errors[f]) && !!errors[f];

  return (
    <section id="apply" className="cta">
      <div className="container cta-grid">
        <div className="cta-left">
          <span className="eyebrow on-dark">Ариза фиристодан</span>
          <h2>
            Дар бораи худ нависед.<br />
            <em>Боқиаш — кори мо.</em>
          </h2>
          <p>
            Як варақаи кӯтоҳ. Одами воқеӣ онро дар давоми 30 дақиқа дар вақти
            корӣ мехонад. Ҳеҷ бот, ҳеҷ ҷавобгӯи худкор ва ҳеҷ "занги шумо барои
            мо хеле муҳим аст".
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
            <div className="form-eyebrow">Қадами 01 · Дар бораи шумо</div>
            <h3>Роҳи худро сӯи грант оғоз кунед</h3>

            <AnimatePresence>
              {success && (
                <motion.div
                  className="form-success"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                >
                  <div className="ok-icon"><Icon name="check" size={28} /></div>
                  <div style={{ fontSize: 18, fontWeight: 500 }}>Ариза қабул шуд</div>
                  <div style={{ fontWeight: 400, fontSize: 14, marginTop: 8, color: 'var(--night-text-soft)' }}>
                    Менеҷери Javonon дар давоми 30 дақиқа бо шумо тамос мегирад.
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
                  <label>Ному насаб</label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => handleFieldChange('fullName', e.target.value)}
                    onBlur={() => handleBlur('fullName')}
                    placeholder="Раҳимов Далер Сафарович"
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
                  <label>Почтаи электронӣ <span style={{ opacity: 0.5 }}>(ихтиёрӣ)</span></label>
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
                  <label>Ҳадаф</label>
                  <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                    {(Object.keys(DIRECTION_LABEL) as Direction[]).map((d) => (
                      <option key={d} value={d}>{DIRECTION_LABEL[d]}</option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <label>
                    Чӣ донистан муҳим аст?
                    <span className="form-counter">{comment.length}/{MAX_COMMENT}</span>
                  </label>
                  <textarea
                    value={comment}
                    onChange={(e) => handleFieldChange('comment', e.target.value)}
                    onBlur={() => handleBlur('comment')}
                    placeholder="Кишвар, донишгоҳ, мӯҳлат, буҷа — ҳар чизе ки ба мо кӯмак мекунад, то ба шумо кӯмак расонем."
                    maxLength={MAX_COMMENT}
                    className={invalid('comment') ? 'error' : ''}
                  />
                  {invalid('comment') && <div className="form-error">{errors.comment}</div>}
                </div>

                {/* Доп. поля по ТЗ §8 — свёрнуты по умолчанию.
                    Кликабельная подсказка "Добавить ещё контакт" → разворачивает.
                    Не блокирует UX простой формы, но даёт возможность сразу указать
                    родителя/опекуна и канал связи. */}
                {!showExtra && (
                  <button
                    type="button"
                    onClick={() => setShowExtra(true)}
                    style={{
                      background: 'transparent',
                      border: '1px dashed rgba(255,255,255,0.3)',
                      color: 'rgba(255,255,255,0.7)',
                      padding: '10px 14px',
                      borderRadius: 10,
                      cursor: 'pointer',
                      fontSize: 13,
                      width: '100%',
                      textAlign: 'left',
                    }}
                  >
                    + Тамоси иловагӣ ё роҳи дилхоҳи алоқа илова кунед
                  </button>
                )}
                {showExtra && (
                  <>
                    <div className="form-row">
                      <label>Телефони иловагӣ (волидайн / васӣ) <span style={{ opacity: 0.5 }}>(ихтиёрӣ)</span></label>
                      <PhoneInput
                        value={secondaryPhone}
                        onChange={(v) => handleFieldChange('secondaryPhone', v)}
                        error={invalid('secondaryPhone')}
                      />
                      {invalid('secondaryPhone') && <div className="form-error">{errors.secondaryPhone}</div>}
                    </div>
                    <div className="form-row">
                      <label>Кӣ мешавад</label>
                      <input
                        type="text"
                        value={secondaryLabel}
                        onChange={(e) => setSecondaryLabel(e.target.value)}
                        placeholder="Масалан: падар, модар, бародар, васӣ"
                        maxLength={40}
                      />
                    </div>
                    <div className="form-row">
                      <label>Роҳи дилхоҳи алоқа</label>
                      <select
                        value={preferredChannel}
                        onChange={(e) => setPreferredChannel(e.target.value as ContactChannel | '')}
                      >
                        <option value="">— фарқ надорад —</option>
                        <option value="PHONE">Занг</option>
                        <option value="WHATSAPP">WhatsApp</option>
                        <option value="TELEGRAM">Telegram</option>
                        <option value="INSTAGRAM">Instagram</option>
                        <option value="EMAIL">Почтаи электронӣ</option>
                      </select>
                    </div>
                  </>
                )}

                <motion.button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting}
                  whileHover={!submitting ? { scale: 1.02 } : {}}
                  whileTap={!submitting ? { scale: 0.98 } : {}}
                >
                  {submitting ? 'Фиристода истодаем...' : (
                    <>Ариза фиристодан <Icon name="arrow_outward" size={18} /></>
                  )}
                </motion.button>
                <p className="form-hint">
                  Бо пахши тугма шумо ба коркарди маълумот розӣ мешавед
                </p>
              </>
            )}
          </motion.form>
        </div>
      </div>
    </section>
  );
}
