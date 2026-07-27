import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { studentRegister, getToken } from '../studentApi';
import { getReferral } from '../referral';
import Icon from '../Icon';
import PasswordInput from '../components/PasswordInput';
import PhoneInput, { COUNTRIES } from '../components/PhoneInput';

const DIRECTIONS = [
  { value: 'BACHELOR', label: 'Бакалавр' },
  { value: 'MASTER', label: 'Магистр' },
  { value: 'LANGUAGE', label: 'Курсҳои забонӣ' },
  { value: 'LANGUAGE_BACHELOR', label: 'Забонӣ + бакалавр' },
  { value: 'LANGUAGE_COLLEGE', label: 'Забонӣ + коллеҷ' },
  { value: 'COLLEGE', label: 'Коллеҷ' },
];

export default function StudentRegister() {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [direction, setDirection] = useState('BACHELOR');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (getToken()) navigate('/cabinet', { replace: true });
  }, [navigate]);

  // Минимальная валидация
  const errors: Record<string, string | undefined> = {};
  if (!fullName.trim() || fullName.trim().length < 2) errors.fullName = 'Ному насабро ворид кунед';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Почтаи электронӣ нодуруст аст';
  if (phone) {
    const matched = COUNTRIES.find((c) => phone.startsWith(c.code));
    if (!matched) errors.phone = 'Рамзи кишварро интихоб кунед';
    else {
      const digits = phone.slice(matched.code.length).replace(/\D/g, '');
      if (digits.length < matched.minDigits) errors.phone = `${matched.minDigits} рақам лозим аст`;
      else if (digits.length > matched.maxDigits) errors.phone = 'Хеле дароз';
    }
  } else errors.phone = 'Телефонро нишон диҳед';
  if (password.length < 6) errors.password = 'Ҳадди ақал 6 аломат';

  const showErr = (k: string) => touched[k] && errors[k];
  const isInvalid = Object.keys(errors).some((k) => errors[k]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ fullName: true, email: true, phone: true, password: true });
    if (isInvalid) return;
    setError(null);
    setLoading(true);
    try {
      await studentRegister({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        password,
        direction,
        // Реферальный код партнёра (TTL-aware). Без него бэк не запустит
        // ReferralsService.attribute() и партнёр не получит комиссию.
        // clearReferral() не вызываем — TTL сам обработает истечение.
        ref: getReferral() || undefined,
      });
      navigate('/cabinet');
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Бақайдгирӣ муяссар нашуд');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stu-login-page">
      <aside className="stu-login-aside">
        <div className="stu-login-aside-content">
          <Link to="/" className="brand brand-img brand-img-light" aria-label="Javonon" style={{ marginBottom: 64, display: 'inline-flex' }}>
            <img src="/javonon-logo.svg" alt="Javonon" />
          </Link>
          <h1 className="display">
            Соҳиби <em>стипендияи</em><br />
            ҷаҳонӣ шав.
          </h1>
          <p>
            Ба қайд гиред ва ба кабинети шахсӣ дастрасӣ пайдо кунед —
            интихоби грантҳо, ҳуҷҷатҳо, ҳолати аризаҳо ва алоқа бо менеҷер.
          </p>
        </div>

        <motion.div
          className="stu-login-quote"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          <div className="stu-login-quote-text">
            "Саҳарӣ ариза фиристодам, бегоҳӣ менеҷер бо ман тамос гирифт. Пас аз 4 моҳ — Tsinghua бо гранти CSC."
          </div>
          <div className="stu-login-quote-author">— Айгерим К. · Tsinghua '25</div>
        </motion.div>
      </aside>

      <div className="stu-login-main">
        <motion.div
          className="stu-login-card"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <Link to="/" className="stu-login-back">
            <Icon name="arrow_back" size={14} />
            Ба саҳифаи асосӣ
          </Link>

          <h2 className="display">Бақайдгирӣ.</h2>
          <p className="stu-login-sub">
            Дар 30 сония ҳисоб созед — мо дар давоми як соат бо шумо тамос мегирем.
          </p>

          {error && (
            <motion.div
              className="stu-login-error"
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: [0, -6, 6, -4, 4, 0] }}
              transition={{ duration: 0.4 }}
            >
              <Icon name="error" size={18} /> {error}
            </motion.div>
          )}

          <form onSubmit={onSubmit}>
            <div className="form-row">
              <label>Ному насаб</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, fullName: true }))}
                className={showErr('fullName') ? 'input-error' : ''}
                placeholder="Раҳимов Раҳим Раҳимович"
                required
                autoComplete="name"
              />
              {showErr('fullName') && <div className="form-error">{errors.fullName}</div>}
            </div>

            <div className="form-row">
              <label>Почтаи электронӣ</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                className={showErr('email') ? 'input-error' : ''}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
              {showErr('email') && <div className="form-error">{errors.email}</div>}
            </div>

            <div className="form-row">
              <label>Телефон</label>
              <PhoneInput
                value={phone}
                onChange={setPhone}
                error={!!showErr('phone')}
              />
              {showErr('phone') && <div className="form-error">{errors.phone}</div>}
            </div>

            <div className="form-row">
              <label>Самт</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                {DIRECTIONS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <label>Парол</label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                className={showErr('password') ? 'input-error' : ''}
                placeholder="Ҳадди ақал 6 аломат"
                required
                autoComplete="new-password"
              />
              {showErr('password') && <div className="form-error">{errors.password}</div>}
            </div>

            <motion.button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={loading}
              whileHover={!loading ? { scale: 1.02 } : {}}
              whileTap={!loading ? { scale: 0.98 } : {}}
            >
              {loading ? 'Ба қайд мегирем...' : 'Ҳисоб сохтан'}
            </motion.button>
          </form>

          <p className="stu-login-hint">
            Аллакай ҳисоб доред? <Link to="/login">Ворид шудан</Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
