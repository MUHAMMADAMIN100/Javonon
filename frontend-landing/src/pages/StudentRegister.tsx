import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { studentRegister, getToken } from '../studentApi';
import Icon from '../Icon';
import PasswordInput from '../components/PasswordInput';
import PhoneInput, { COUNTRIES } from '../components/PhoneInput';

const DIRECTIONS = [
  { value: 'BACHELOR', label: 'Бакалавриат' },
  { value: 'MASTER', label: 'Магистратура' },
  { value: 'LANGUAGE', label: 'Языковые курсы' },
  { value: 'LANGUAGE_BACHELOR', label: 'Языковой + бакалавриат' },
  { value: 'LANGUAGE_COLLEGE', label: 'Языковой + колледж' },
  { value: 'COLLEGE', label: 'Колледж' },
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
  if (!fullName.trim() || fullName.trim().length < 2) errors.fullName = 'Введите ФИО';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Некорректный email';
  if (phone) {
    const matched = COUNTRIES.find((c) => phone.startsWith(c.code));
    if (!matched) errors.phone = 'Выберите код страны';
    else {
      const digits = phone.slice(matched.code.length).replace(/\D/g, '');
      if (digits.length < matched.minDigits) errors.phone = `Нужно ${matched.minDigits} цифр`;
      else if (digits.length > matched.maxDigits) errors.phone = 'Слишком длинный';
    }
  } else errors.phone = 'Укажите телефон';
  if (password.length < 6) errors.password = 'Минимум 6 символов';

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
      });
      navigate('/cabinet');
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Не удалось зарегистрироваться');
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
            Стань <em>стипендиатом</em><br />
            мирового уровня.
          </h1>
          <p>
            Зарегистрируйся и получи доступ к личному кабинету —
            подбору грантов, документам, статусам заявок и связи с менеджером.
          </p>
        </div>

        <motion.div
          className="stu-login-quote"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          <div className="stu-login-quote-text">
            "Подал заявку утром, к вечеру со мной связался менеджер. Через 4 месяца — Tsinghua с CSC грантом."
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
            На главную
          </Link>

          <h2 className="display">Регистрация.</h2>
          <p className="stu-login-sub">
            Создай аккаунт за 30 секунд — мы свяжемся с тобой в течение часа.
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
              <label>ФИО</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, fullName: true }))}
                className={showErr('fullName') ? 'input-error' : ''}
                placeholder="Иванов Иван Иванович"
                required
                autoComplete="name"
              />
              {showErr('fullName') && <div className="form-error">{errors.fullName}</div>}
            </div>

            <div className="form-row">
              <label>Email</label>
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
              <label>Направление</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                {DIRECTIONS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <label>Пароль</label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                className={showErr('password') ? 'input-error' : ''}
                placeholder="Минимум 6 символов"
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
              {loading ? 'Регистрируем...' : 'Создать аккаунт'}
            </motion.button>
          </form>

          <p className="stu-login-hint">
            Уже есть аккаунт? <Link to="/login">Войти</Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
