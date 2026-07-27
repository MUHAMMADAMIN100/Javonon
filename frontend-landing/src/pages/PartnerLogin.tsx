import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { partnerLogin, setPartnerToken } from '../partnerApi';

export default function PartnerLogin() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const { token } = await partnerLogin(email, password);
      setPartnerToken(token);
      nav('/partner/cabinet', { replace: true });
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Почтаи электронӣ ё парол нодуруст аст');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stu-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 400, width: '100%', background: 'white', borderRadius: 20, padding: 32, boxShadow: '0 24px 48px -12px rgba(0,0,0,0.10)' }}>
        <Link to="/" style={{ fontSize: 12, color: 'var(--ink-mute)', textDecoration: 'none' }}>← Ба саҳифаи асосӣ</Link>
        <h1 style={{ fontFamily: 'var(--display)', fontSize: 26, fontWeight: 600, margin: '12px 0 24px' }}>
          Ворид шудани ҳамкор
        </h1>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="email"
            placeholder="Почтаи электронӣ"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
          />
          <input
            type="password"
            placeholder="Парол"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
          />
          {err && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ padding: '14px 20px', borderRadius: 10, marginTop: 4 }}
          >
            {loading ? 'Ворид мешавем…' : 'Ворид шудан'}
          </button>
        </form>
        <p style={{ marginTop: 16, fontSize: 13, color: 'var(--ink-mute)', textAlign: 'center' }}>
          Ҳисоб надоред? <Link to="/partner/register" style={{ color: 'var(--emerald-deep)' }}>Бақайдгирӣ</Link>
        </p>
      </div>
    </div>
  );
}
