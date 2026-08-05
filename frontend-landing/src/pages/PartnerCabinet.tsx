import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  PartnerDashboard,
  clearPartnerToken,
  fmtMoney,
  getPartnerToken,
  partnerDashboard,
  partnerRequestPayout,
  partnerShortLink,
} from '../partnerApi';

export default function PartnerCabinet() {
  const nav = useNavigate();
  const [data, setData] = useState<PartnerDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('CARD');
  const [payoutDetails, setPayoutDetails] = useState('');
  const [payoutErr, setPayoutErr] = useState<string | null>(null);

  useEffect(() => {
    if (!getPartnerToken()) {
      nav('/partner/login', { replace: true });
      return;
    }
    refresh();
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const d = await partnerDashboard();
      setData(d);
    } catch (e: any) {
      if (e?.response?.status === 401) {
        clearPartnerToken();
        nav('/partner/login', { replace: true });
      }
    } finally {
      setLoading(false);
    }
  };

  const link = data
    ? `${window.location.origin}/?ref=${data.partner.referralCode}`
    : '';

  // Короткая ссылка живёт на origin'е API, а не лендинга: `/r/:code` — это
  // роут NestJS, который пишет клик и отдаёт 302. См. partnerShortLink().
  const shortLink = data ? partnerShortLink(data.partner.referralCode) : '';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const submitPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    setPayoutErr(null);
    const amount = parseFloat(payoutAmount.replace(',', '.'));
    if (!amount || amount <= 0) {
      setPayoutErr('Маблағ бояд аз 0 зиёд бошад');
      return;
    }
    try {
      await partnerRequestPayout({
        amountCents: Math.round(amount * 100),
        method: payoutMethod,
        details: payoutDetails,
      });
      setPayoutAmount('');
      setPayoutDetails('');
      await refresh();
      alert('Аризаи пардохт сохта шуд');
    } catch (e: any) {
      setPayoutErr(e?.response?.data?.message || 'Пардохтро сохтан нашуд');
    }
  };

  if (loading || !data) {
    return (
      <div className="stu-page" style={{ padding: 40, textAlign: 'center' }}>
        Боркунӣ…
      </div>
    );
  }

  const { partner, stats, recentCommissions } = data;

  // Доступно к выводу = подтверждённая часть баланса. Показываем ОТДЕЛЬНО от
  // balanceCents: начисление попадает в баланс сразу при оплате клиента, а
  // запросить его можно только после подтверждения в CRM. Без этой строки
  // партнёр видел бы «Тавозун 500» и получал бы отказ на выплату — читалось
  // бы как поломка, а не как «ещё не подтвердили».
  //
  // ?? balanceCents — окно рассинхрона деплоев: лендинг на Vercel может выйти
  // раньше бэкенда на Railway, и в старом ответе поля нет.
  const availableCents = data.availableCents ?? partner.balanceCents;
  const pendingCents = Math.max(0, partner.balanceCents - availableCents);

  return (
    <div className="stu-page" style={{ padding: 'max(16px, 4vw)' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <Link to="/" style={{ fontSize: 12, color: 'var(--ink-mute)', textDecoration: 'none' }}>← Ба саҳифаи асосӣ</Link>
            <h1 style={{ fontFamily: 'var(--display)', fontSize: 28, fontWeight: 600, margin: '8px 0 4px' }}>
              {partner.fullName}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--ink-mute)' }}>{partner.email} · комиссия {partner.commissionPct}%</div>
          </div>
          <button
            onClick={() => { clearPartnerToken(); nav('/'); }}
            className="btn-pill ghost"
            style={{ padding: '8px 16px' }}
          >
            Баромадан
          </button>
        </header>

        {/* Реферальная ссылка */}
        <section style={{ background: 'white', borderRadius: 20, padding: 24, marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--ink-mute)', textTransform: 'uppercase', marginBottom: 8 }}>
            Пайванди рефералӣ
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              readOnly
              value={link}
              style={{ flex: '1 1 280px', minWidth: 0, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontFamily: 'var(--mono)', fontSize: 13 }}
            />
            <button onClick={copyLink} className="btn btn-primary" style={{ padding: '12px 20px', borderRadius: 10 }}>
              {copied ? '✓ Нусха бардошта шуд' : 'Нусха бардоштан'}
            </button>
          </div>
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--ink-mute)' }}>
            Рамз: <b style={{ color: 'var(--ink)' }}>{partner.referralCode}</b>
            {' · '}
            Кӯтоҳ: <code>{shortLink}</code>
          </div>
        </section>

        {/* Статистика */}
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
          <StatCard label="Гузаришҳо" value={stats.clicks} />
          <StatCard label="Лидҳо" value={stats.leads} />
          <StatCard label="Фурӯшҳо" value={stats.sales} />
          <StatCard label="Пардохтшуда" value={stats.paidSales} />
        </section>

        {/* Баланс */}
        <section style={{ background: 'var(--night)', color: 'white', borderRadius: 20, padding: 28, marginBottom: 16 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', marginBottom: 8 }}>
            Тавозун барои пардохт
          </div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 48, fontWeight: 500, letterSpacing: '-0.03em' }}>
            {fmtMoney(availableCents)}
          </div>
          {pendingCents > 0 && (
            <div style={{ marginTop: 6, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
              Дар интизори тасдиқ: {fmtMoney(pendingCents)} — пас аз тасдиқ барои
              баровардан дастрас мешавад
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
            Тавозуни умумӣ: {fmtMoney(partner.balanceCents)} · Ҳамагӣ ба даст оварда шуд: {fmtMoney(partner.totalEarnedCents)} · Пардохт шуд: {fmtMoney(partner.totalPaidCents)}
          </div>
        </section>

        {/* Выплата */}
        <section style={{ background: 'white', borderRadius: 20, padding: 24, marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
          <h3 style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Дархости пардохт</h3>
          <form onSubmit={submitPayout} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <input
              type="number"
              step="0.01"
              placeholder="Маблағ (USD)"
              value={payoutAmount}
              onChange={(e) => setPayoutAmount(e.target.value)}
              required
              style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
            />
            <select
              value={payoutMethod}
              onChange={(e) => setPayoutMethod(e.target.value)}
              style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16 }}
            >
              <option value="CARD">Корт</option>
              <option value="CRYPTO">Crypto (USDT)</option>
              <option value="CASH">Нақд</option>
              <option value="OTHER">Дигар</option>
            </select>
            <input
              type="text"
              placeholder="Реквизитҳо (рақами корт / суроғаи ҳамён)"
              value={payoutDetails}
              onChange={(e) => setPayoutDetails(e.target.value)}
              style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, fontSize: 16, gridColumn: 'span 2' }}
            />
            {payoutErr && <div style={{ color: 'var(--danger)', fontSize: 13, gridColumn: 'span 2' }}>{payoutErr}</div>}
            <button type="submit" className="btn btn-primary" style={{ padding: '12px 20px', borderRadius: 10, gridColumn: 'span 2' }}>
              Дархости пардохт
            </button>
          </form>
        </section>

        {/* История начислений */}
        <section style={{ background: 'white', borderRadius: 20, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
          <h3 style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Таърихи ҳисобкуниҳо</h3>
          {recentCommissions.length === 0 ? (
            <div style={{ color: 'var(--ink-mute)', textAlign: 'center', padding: 32 }}>
              Ҳоло ҳисобкунӣ нест. Пайвандро мубодила кунед ва даромад ба даст оред ✨
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recentCommissions.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '12px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 15 }}>
                      {fmtMoney(c.amountCents, c.currency)} <span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>
                        ({c.percent}% аз {fmtMoney(c.baseAmountCents, c.baseCurrency ?? c.currency)})
                      </span>
                    </div>
                    {c.note && <div style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{c.note}</div>}
                    <div style={{ fontSize: 11, color: 'var(--ink-mute)' }}>
                      {new Date(c.createdAt).toLocaleString('ru-RU')}
                    </div>
                  </div>
                  <span style={{
                    padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                    background: c.status === 'PAID' ? '#dcfce7' : c.status === 'REVERSED' ? '#fee2e2' : '#fef3c7',
                    color: c.status === 'PAID' ? '#15803d' : c.status === 'REVERSED' ? '#b91c1c' : '#b45309',
                  }}>
                    {c.status === 'PAID' ? 'ПАРДОХТ ШУД' : c.status === 'REVERSED' ? 'БЕКОР ШУД' : 'ДАР ИНТИЗОР'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: 'white', borderRadius: 16, padding: 18, boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', color: 'var(--ink-mute)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}
