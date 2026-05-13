import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { partnerRegister, setPartnerToken } from '../partnerApi';

export default function PartnerRegister() {
  const nav = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const { token } = await partnerRegister({ fullName, email, phone, password });
      setPartnerToken(token);
      nav('/partner/cabinet', { replace: true });
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stu-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 440, width: '100%', background: 'white', borderRadius: 20, padding: 32, boxShadow: '0 24px 48px -12px rgba(0,0,0,0.10)' }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--ink-mute)', textDecoration: 'none' }}>← На главную</Link>
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 600, margin: '12px 0 8px' }}>
          Партнёрская программа
        </h1>
        <p style={{ color: 'var(--ink-mute)', marginBottom: 24, fontSize: 14 }}>
          Регистрируйся и зарабатывай комиссию приводя клиентов.
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="text"
            placeholder="Имя"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            minLength={2}
            style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
          />
          <input
            type="tel"
            placeholder="Телефон (необязательно)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
          />
          <input
            type="password"
            placeholder="Пароль (мин. 6 символов)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
          />
          {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ padding: '14px 20px', borderRadius: 10, marginTop: 4 }}
          >
            {loading ? 'Создаём…' : 'Зарегистрироваться'}
          </button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--ink-mute)', textAlign: 'center' }}>
          Уже партнёр? <Link to="/partner/login" style={{ color: 'var(--emerald-deep)' }}>Войти</Link>
        </p>
      </div>
    </div>
  );
}
