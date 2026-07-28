import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { submitApplication, type Country, COUNTRY_ORDER, COUNTRY_LABEL } from '../api';
import { birthdayBounds, birthdayRule } from '../validators';
import { getReferral } from '../referral';
import Icon from '../Icon';
import PhoneInput, { COUNTRIES } from './PhoneInput';

const MAX_NAME = 100;
const MAX_COMMENT = 500;

type Errors = Partial<
  Record<'fullName' | 'phone' | 'whatsappPhone' | 'birthday' | 'country' | 'comment', string>
>;

const PERKS = [
  'Машварати ройгон 30 дақиқа',
  'Менеҷер дар 30 дақиқа ҷавоб медиҳад',
  'Кафолат аз рӯи шартнома',
  'Ҷомеаи хатмкунандагон барои солҳо',
];

export default function ApplicationForm() {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  // WhatsApp по умолчанию = основной номер: у подавляющего большинства клиентов
  // это один и тот же номер, лишнее поле только удлиняет форму. Пока галочка
  // стоит — второй PhoneInput не рендерим, а в payload уходит копия phone.
  const [sameWhatsapp, setSameWhatsapp] = useState(true);
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [birthday, setBirthday] = useState('');
  const [country, setCountry] = useState<Country | ''>('');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // min/max для нативного date-picker: браузер сам не даст выбрать возраст
  // вне 14..60, т.е. до сабмита. Считается один раз при монтировании —
  // за время жизни страницы календарные сутки не сдвинутся настолько,
  // чтобы это было заметно, а Intl на каждый рендер дёргать незачем.
  const dobBounds = useMemo(() => birthdayBounds(), []);

  // Общая проверка номера для основного номера и WhatsApp.
  // Пустое значение здесь НЕ считается ошибкой — обязательность решает вызывающий.
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
    if (field === 'whatsappPhone') {
      // Галочка «ҳамон рақам» — поле скрыто и уходит копией phone,
      // отдельная валидация не нужна (phone уже проверен выше).
      if (sameWhatsapp) return;
      const v = (value || '').trim();
      if (!v) return 'Рақами WhatsApp-ро нависед';
      return validatePhoneValue(v);
    }
    if (field === 'birthday') {
      // Та же проверка 14..60 (в поясе Asia/Dushanbe), что и на бэке.
      return birthdayRule()(value);
    }
    if (field === 'country') {
      if (!value) return 'Кишварро интихоб кунед';
      return;
    }
    if (field === 'comment') {
      if (value.length > MAX_COMMENT) return `Ҳадди аксар ${MAX_COMMENT} аломат`;
      return;
    }
    return;
  };

  const fieldValue = (field: keyof Errors): string => {
    switch (field) {
      case 'fullName': return fullName;
      case 'phone': return phone;
      case 'whatsappPhone': return whatsappPhone;
      case 'birthday': return birthday;
      case 'country': return country;
      case 'comment': return comment;
      default: return '';
    }
  };

  const checkAll = (): Errors => ({
    fullName: validateField('fullName', fullName),
    phone: validateField('phone', phone),
    whatsappPhone: validateField('whatsappPhone', whatsappPhone),
    birthday: validateField('birthday', birthday),
    country: validateField('country', country),
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
    const err = validateField(field, fieldValue(field));
    setErrors((prev) => ({ ...prev, [field]: err }));
  };

  const handleFieldChange = (field: keyof Errors, value: string) => {
    if (field === 'fullName') setFullName(value);
    // PhoneInput не даёт onBlur, поэтому оба номера валидируем «вживую»:
    // после первого submit / первой ошибки.
    else if (field === 'phone') {
      setPhone(value);
      if (touched.phone || errors.phone) {
        const err = validateField('phone', value);
        setErrors((prev) => ({ ...prev, phone: err }));
      }
      return;
    }
    else if (field === 'whatsappPhone') {
      setWhatsappPhone(value);
      if (touched.whatsappPhone || errors.whatsappPhone) {
        const err = validateField('whatsappPhone', value);
        setErrors((prev) => ({ ...prev, whatsappPhone: err }));
      }
      return;
    }
    else if (field === 'birthday') setBirthday(value);
    else if (field === 'country') setCountry(value as Country | '');
    else if (field === 'comment') setComment(value);
    if (touched[field] || errors[field]) {
      const err = validateField(field, value);
      setErrors((prev) => ({ ...prev, [field]: err }));
    }
  };

  const toggleSameWhatsapp = (checked: boolean) => {
    setSameWhatsapp(checked);
    if (checked) {
      // Поле скрывается — снимаем и ошибку, иначе она осталась бы
      // невидимым блокером сабмита.
      setWhatsappPhone('');
      setErrors((prev) => ({ ...prev, whatsappPhone: undefined }));
    }
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setServerError(null);
    const all = cleanErrors(checkAll());
    setErrors(all);
    setTouched({
      fullName: true,
      phone: true,
      whatsappPhone: true,
      birthday: true,
      country: true,
      comment: true,
    });
    if (Object.keys(all).length > 0) return;

    setSubmitting(true);
    try {
      await submitApplication({
        fullName: fullName.trim(),
        phone: phone.trim(),
        // Галочка «ҳамон рақам» → WhatsApp = основной номер.
        whatsappPhone: (sameWhatsapp ? phone : whatsappPhone).trim() || undefined,
        birthday: birthday || undefined,
        country: country || undefined,
        comment: comment.trim() || undefined,
        // `direction` лендинг больше НЕ шлёт: клиента про него не спрашивают.
        // Бэк подставит Direction.BACHELOR-заглушку, менеджер правит её в CRM.
        //
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
        (window as any).gtag?.('event', 'submit_application', { country });
        (window as any).ym?.((window as any).__YM_ID__, 'reachGoal', 'APPLICATION_SUBMIT');
      } catch {}
      setFullName(''); setPhone(''); setComment('');
      setWhatsappPhone(''); setSameWhatsapp(true);
      setBirthday(''); setCountry('');
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
                    Менеҷери Javonon дар давоми 1-12 соат бо шумо тамос мегирад.
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
                {/* id — цель автоскролла по реферальной ссылке (?ref=...#apply).
                    Целимся именно в первое поле, а не в секцию #apply: секция
                    состоит из двух колонок, и на мобильном они встают друг под
                    друга — прокрутка к её верху упирается в текстовую колонку,
                    а форма остаётся ниже экрана. См. referral.ts. */}
                <div className="form-row" id="apply-first-field">
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
                  <label htmlFor="wa-same">WhatsApp</label>
                  <div className="form-check">
                    <input
                      id="wa-same"
                      type="checkbox"
                      checked={sameWhatsapp}
                      onChange={(e) => toggleSameWhatsapp(e.target.checked)}
                    />
                    <label htmlFor="wa-same">Ҳамон рақами телефон</label>
                  </div>
                  {!sameWhatsapp && (
                    <>
                      <PhoneInput
                        value={whatsappPhone}
                        onChange={(v) => handleFieldChange('whatsappPhone', v)}
                        error={invalid('whatsappPhone')}
                      />
                      {invalid('whatsappPhone') && (
                        <div className="form-error">{errors.whatsappPhone}</div>
                      )}
                    </>
                  )}
                </div>

                <div className="form-row">
                  <label>Санаи таваллуд</label>
                  <input
                    type="date"
                    value={birthday}
                    onChange={(e) => handleFieldChange('birthday', e.target.value)}
                    onBlur={() => handleBlur('birthday')}
                    min={dobBounds.min}
                    max={dobBounds.max}
                    className={invalid('birthday') ? 'error' : ''}
                    autoComplete="bday"
                  />
                  {invalid('birthday') && <div className="form-error">{errors.birthday}</div>}
                </div>

                <div className="form-row">
                  <label>Кишвар</label>
                  <select
                    value={country}
                    onChange={(e) => handleFieldChange('country', e.target.value)}
                    onBlur={() => handleBlur('country')}
                    className={invalid('country') ? 'error' : ''}
                  >
                    <option value="">Кишварро интихоб кунед</option>
                    {COUNTRY_ORDER.map((c) => (
                      <option key={c} value={c}>{COUNTRY_LABEL[c]}</option>
                    ))}
                  </select>
                  {invalid('country') && <div className="form-error">{errors.country}</div>}
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
                    placeholder="Донишгоҳ, мӯҳлат, буҷа — ҳар чизе ки ба мо кӯмак мекунад, то ба шумо кӯмак расонем."
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
