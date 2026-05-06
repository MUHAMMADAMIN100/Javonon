import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../store/auth';
import { compose, email as emailRule, hasErrors, minLen, required, validateAll } from '../utils/validators';
import PasswordInput from '../components/PasswordInput';
import Icon from '../Icon';

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
      <motion.aside
        className="login-aside"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="login-aside-brand">
          <span className="logo-mark">J</span>
          <span>Javonon</span>
        </div>

        <div>
          <h1>
            Operate the<br />
            <em>scholar pipeline.</em>
          </h1>
          <p>
            Internal control room for managers and admins. Track applications,
            students, programmes, and grant outcomes — in real time.
          </p>
        </div>

        <div className="login-aside-stats">
          <div>
            <div className="login-aside-stat-num">40+</div>
            <div className="login-aside-stat-label">Countries</div>
          </div>
          <div>
            <div className="login-aside-stat-num">1.2K</div>
            <div className="login-aside-stat-label">Scholars</div>
          </div>
          <div>
            <div className="login-aside-stat-num">94%</div>
            <div className="login-aside-stat-label">Success</div>
          </div>
        </div>
      </motion.aside>

      <motion.form
        className="login-card"
        onSubmit={onSubmit}
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
      >
        <motion.div
          className="login-logo"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.4 }}
        >
          <span className="logo-mark">J</span>
          <span className="login-brand-name">Javonon</span>
          <span className="login-logo-label">CRM</span>
        </motion.div>

        <h2>Sign in.</h2>
        <p className="login-sub">Use your manager credentials to access the control room.</p>

        <AnimatePresence>
          {error && (
            <motion.div
              className="error-banner"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto', x: [0, -6, 6, -4, 4, 0] }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35 }}
            >
              <Icon name="error" size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="form-group">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            className={showErr('email') ? 'input-error' : ''}
            placeholder="you@javonon.com"
            required
            autoComplete="email"
          />
          {showErr('email') && <div className="form-error-text">{errors.email}</div>}
        </div>
        <div className="form-group">
          <label>Password</label>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, password: true }))}
            className={showErr('password') ? 'input-error' : ''}
            placeholder="••••••••"
            required
            autoComplete="current-password"
          />
          {showErr('password') && <div className="form-error-text">{errors.password}</div>}
        </div>
        <motion.button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={submitting}
          whileHover={!submitting ? { scale: 1.01 } : {}}
          whileTap={!submitting ? { scale: 0.99 } : {}}
        >
          {submitting ? 'Signing in...' : (
            <>Sign in <Icon name="arrow_outward" size={16} /></>
          )}
        </motion.button>
      </motion.form>
    </div>
  );
}
