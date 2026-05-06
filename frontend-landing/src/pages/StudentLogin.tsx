import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { studentLogin, getToken } from '../studentApi';
import Icon from '../Icon';
import PasswordInput from '../components/PasswordInput';
import { compose, email as emailRule, hasErrors, passwordRule, required } from '../validators';

export default function StudentLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const errors = {
    email: compose(required('Введите email'), emailRule())(email),
    password: compose(required('Введите пароль'), passwordRule())(password),
  };
  const showErr = (k: 'email' | 'password') => touched[k] && errors[k];
  const isInvalid = hasErrors(errors);

  useEffect(() => {
    if (getToken()) navigate('/cabinet', { replace: true });
  }, [navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (isInvalid) return;
    setError(null);
    setLoading(true);
    try {
      await studentLogin(email.trim(), password);
      navigate('/cabinet');
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Неверный email или пароль');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stu-login-page">
      <motion.div
        className="stu-login-card"
        initial={{ opacity: 0, y: 30, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <Link to="/" className="stu-login-home">
          <Icon name="arrow_back" size={18} />
          На главную
        </Link>

        <div className="stu-login-brand">
          <a href="/" className="logo" style={{ fontSize: 28, justifyContent: 'center' }}>
            <span className="logo-mark">J</span>
            <span className="logo-text">Javonon</span>
          </a>
        </div>

        <h2 className="stu-login-title">Личный кабинет студента</h2>
        <p className="stu-login-sub">
          Войди, используя email и пароль, которые выдал твой менеджер Javonon.
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
            <label>Email *</label>
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
            <label>Пароль *</label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              className={showErr('password') ? 'input-error' : ''}
              placeholder="Пароль, выданный менеджером"
              required
              autoComplete="current-password"
            />
            {showErr('password') && <div className="form-error">{errors.password}</div>}
          </div>
          <motion.button
            type="submit"
            className="btn btn-primary btn-large"
            style={{ width: '100%' }}
            disabled={loading || isInvalid}
            whileHover={!loading && !isInvalid ? { scale: 1.02, y: -2 } : {}}
            whileTap={!loading && !isInvalid ? { scale: 0.98 } : {}}
          >
            {loading ? 'Вход...' : 'Войти'}
          </motion.button>
        </form>

        <p className="stu-login-hint">
          Нет аккаунта? Оставьте заявку на <Link to="/#apply">главной</Link> — мы создадим вам личный кабинет после первого контакта.
        </p>
      </motion.div>
    </div>
  );
}
