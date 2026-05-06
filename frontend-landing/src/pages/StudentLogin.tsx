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
    email: compose(required('Email is required'), emailRule())(email),
    password: compose(required('Password is required'), passwordRule())(password),
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
      setError(err?.response?.data?.message || 'Wrong email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stu-login-page">
      <aside className="stu-login-aside">
        <div className="stu-login-aside-content">
          <Link to="/" className="brand" style={{ marginBottom: 64 }}>
            <span className="brand-dot">J</span>
            <span>Javonon</span>
          </Link>
          <h1 className="display">
            Welcome back,<br />
            <em>scholar.</em>
          </h1>
          <p>
            Your personal cabinet — application status, documents, programmes,
            and direct line to your manager.
          </p>
        </div>

        <motion.div
          className="stu-login-quote"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          <div className="stu-login-quote-text">
            "I logged in every day to track my Chevening application. The team
            saw every comment in real time."
          </div>
          <div className="stu-login-quote-author">— Madina S. · Manchester '25</div>
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
            Back to home
          </Link>

          <h2 className="display">Sign in.</h2>
          <p className="stu-login-sub">
            Use the email and password your Javonon manager gave you.
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
              <label>Password</label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                className={showErr('password') ? 'input-error' : ''}
                placeholder="Your password"
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
              {loading ? 'Signing in...' : 'Sign in'}
            </motion.button>
          </form>

          <p className="stu-login-hint">
            No account yet? <Link to="/#apply">Apply for a grant</Link> — we'll set
            up your cabinet after the first call.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
