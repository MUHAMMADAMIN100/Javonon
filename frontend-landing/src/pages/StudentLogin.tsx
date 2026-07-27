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
    email: compose(required('Почтаи электрониро ворид кунед'), emailRule())(email),
    password: compose(required('Паролро ворид кунед'), passwordRule())(password),
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
      setError(err?.response?.data?.message || 'Почтаи электронӣ ё парол нодуруст аст');
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
            Хуш омадед,<br />
            <em>донишҷӯ.</em>
          </h1>
          <p>
            Кабинети шахсии шумо — ҳолати аризаҳо, ҳуҷҷатҳо, барномаҳо ва алоқаи
            мустақим бо менеҷер.
          </p>
        </div>

        <motion.div
          className="stu-login-quote"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          <div className="stu-login-quote-text">
            "Ҳар рӯз ба кабинет медаромадам, то аризаамро ба Chevening пайгирӣ
            кунам. Даста ҳар шарҳи маро дар вақти воқеӣ медид."
          </div>
          <div className="stu-login-quote-author">— Мадина С. · Manchester '25</div>
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

          <h2 className="display">Ворид шудан.</h2>
          <p className="stu-login-sub">
            Почтаи электронӣ ва пароле, ки менеҷери Javonon ба шумо додааст, истифода баред.
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
              <label>Парол</label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                className={showErr('password') ? 'input-error' : ''}
                placeholder="Пароли шумо"
                required
                autoComplete="current-password"
              />
              {showErr('password') && <div className="form-error">{errors.password}</div>}
            </div>
            <motion.button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={loading || isInvalid}
              whileHover={!loading && !isInvalid ? { scale: 1.02 } : {}}
              whileTap={!loading && !isInvalid ? { scale: 0.98 } : {}}
            >
              {loading ? 'Ворид мешавем...' : 'Ворид шудан'}
            </motion.button>
          </form>

          <p className="stu-login-hint">
            Ҳанӯз ҳисоб надоред? <Link to="/register">Бақайдгирӣ</Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
