import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../store/auth';
import { compose, email as emailRule, hasErrors, minLen, required, validateAll } from '../utils/validators';
import PasswordInput from '../components/PasswordInput';

export default function Login() {
  const navigate = useNavigate();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});

  const errors = validateAll(
    { email, password },
    {
      email: compose(required('Введите email'), emailRule()),
      password: compose(required('Введите пароль'), minLen(4, 'Минимум 4 символа')),
    },
  );
  const showErr = (k: 'email' | 'password') => touched[k] && errors[k];

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (hasErrors(errors)) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password.trim());
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Не удалось войти');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <motion.form
        className="login-card"
        onSubmit={onSubmit}
        initial={{ opacity: 0, y: 30, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="login-logo"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.4 }}
        >
          <span className="logo-mark" style={{ width: 48, height: 48, fontSize: 24 }}>J</span>
          <span className="login-brand-name">Javonon</span>
          <span className="login-logo-label">CRM</span>
        </motion.div>
        <AnimatePresence>
          {error && (
            <motion.div
              className="error-banner"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto', x: [0, -6, 6, -4, 4, 0] }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35 }}
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          className="form-group"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.3 }}
        >
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            className={showErr('email') ? 'input-error' : ''}
            required
            autoComplete="email"
          />
          {showErr('email') && <div className="form-error-text">{errors.email}</div>}
        </motion.div>
        <motion.div
          className="form-group"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.3 }}
        >
          <label>Пароль</label>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            className={showErr('password') ? 'input-error' : ''}
            required
            autoComplete="current-password"
          />
          {showErr('password') && <div className="form-error-text">{errors.password}</div>}
        </motion.div>
        <motion.button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={submitting}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.3 }}
          whileHover={!submitting ? { scale: 1.02, y: -2 } : {}}
          whileTap={!submitting ? { scale: 0.98 } : {}}
        >
          {submitting ? 'Вход...' : 'Войти'}
        </motion.button>
      </motion.form>
    </div>
  );
}
