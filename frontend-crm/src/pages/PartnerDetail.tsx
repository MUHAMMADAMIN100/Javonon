import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  adminGetPartner,
  adminGetPartnerAttributions,
  adminListCommissions,
  adminListPayouts,
  fmtCommissionRate,
  fmtMoneyCents,
  type PartnerAttribution,
} from '../api/partners';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { useApplicationStatusLabel, useDirectionLabel } from '../lib/labels';
import Icon from '../Icon';
import Loading from '../components/Loading';
import BackButton from '../components/BackButton';
import QrCode from '../components/QrCode';

type Tab = 'clients' | 'commissions' | 'payouts' | 'clicks';

const PAGE_SIZE = 20;

/**
 * Copy-to-clipboard helper mirroring Partners.tsx — prefer async Clipboard API,
 * fall back to the hidden <textarea> + execCommand('copy') trick.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function attributionType(a: PartnerAttribution): 'application' | 'student' | 'telegram' | 'hint' {
  if (a.application) return 'application';
  if (a.student) return 'student';
  if (a.telegramUserId) return 'telegram';
  return 'hint';
}

export default function PartnerDetail() {
  const { id } = useParams();
  const { t } = useT();
  const { toast } = useUI();
  const [tab, setTab] = useState<Tab>('clients');
  const [qrOpen, setQrOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['admin', 'partners', id, 'detail'],
    queryFn: () => adminGetPartner(id!),
    enabled: !!id,
  });

  if (!id) return null;
  if (detailQuery.isLoading) return <Loading fullscreen />;
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div>
        <BackButton fallback="/partners" label={t('partners.detail.back')} />
        <div className="card" style={{ padding: 24 }}>
          {t('common.error')}
        </div>
      </div>
    );
  }

  const { partner, referralUrl, stats, recentClicks } = detailQuery.data;

  const copyRef = async () => {
    const ok = await copyToClipboard(referralUrl);
    toast(ok ? t('common.copied') : t('toast.error'), ok ? 'success' : 'error');
  };

  const statusBadgeStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 4,
    background:
      partner.status === 'ACTIVE'
        ? '#dcfce7'
        : partner.status === 'SUSPENDED'
        ? '#fef3c7'
        : '#fee2e2',
    color:
      partner.status === 'ACTIVE'
        ? '#15803d'
        : partner.status === 'SUSPENDED'
        ? '#b45309'
        : '#b91c1c',
  };

  return (
    <div>
      <BackButton fallback="/partners" label={t('partners.detail.back')} />

      {/* Header card: name + status + email + phone */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-body">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 24 }}>{partner.fullName}</h2>
                <span style={statusBadgeStyle}>{t(`partners.status.${partner.status}`)}</span>
              </div>
              <div style={{ marginTop: 8, color: 'var(--text-soft)', fontSize: 14, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span><Icon name="mail" size={14} /> {partner.email}</span>
                {partner.phone && <span><Icon name="phone" size={14} /> {partner.phone}</span>}
                {partner.telegramHandle && (
                  <span><Icon name="chat" size={14} /> @{partner.telegramHandle.replace(/^@/, '')}</span>
                )}
                <span>
                  <Icon name="key" size={14} /> <code>{partner.referralCode}</code> ·{' '}
                  {t('partners.detail.rate.label')}: {fmtCommissionRate(partner.commissionAmountCents)}{' '}
                  {t('partners.detail.rate.perClient')}
                </span>
              </div>
            </div>
          </div>

          {/* Sub-header row: reflink + copy + QR toggle */}
          <div
            style={{
              marginTop: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 13,
                background: 'var(--surface-alt, #f4f4f5)',
                border: '1px solid var(--border-soft)',
                borderRadius: 6,
                padding: '8px 12px',
                wordBreak: 'break-all',
                userSelect: 'all',
                flex: '1 1 260px',
                minWidth: 0,
              }}
            >
              {referralUrl}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={copyRef}>
              <Icon name="content_copy" size={14} /> {t('partners.share.copy')}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setQrOpen(true)}>
              <Icon name="qr_code_2" size={14} /> QR
            </button>
          </div>
        </div>
      </div>

      {/* KPI bento grid */}
      <div className="bento" style={{ marginTop: 24, marginBottom: 24 }}>
        <KpiBento
          eyebrow="01"
          label={t('partners.detail.stats.clicks')}
          value={String(stats.clicksCount)}
        />
        <KpiBento
          eyebrow="02"
          label={t('partners.detail.stats.attributions')}
          value={String(stats.attributionsCount)}
          accent
        />
        <KpiBento
          eyebrow="03"
          label={t('partners.detail.stats.commissions')}
          value={String(stats.commissionsCount)}
        />
        <KpiBento
          eyebrow="04"
          label={t('partners.detail.stats.payouts')}
          value={String(stats.payoutsCount)}
        />
        <KpiBento
          eyebrow="05"
          label={t('partners.detail.stats.balance')}
          value={fmtMoneyCents(partner.balanceCents)}
          span="span-3"
        />
        <KpiBento
          eyebrow="06"
          label={t('partners.detail.stats.earned')}
          value={fmtMoneyCents(partner.totalEarnedCents)}
          span="span-3"
        />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        <TabBtn active={tab === 'clients'} onClick={() => setTab('clients')}>
          {t('partners.detail.tabs.clients')}
        </TabBtn>
        <TabBtn active={tab === 'commissions'} onClick={() => setTab('commissions')}>
          {t('partners.detail.tabs.commissions')}
        </TabBtn>
        <TabBtn active={tab === 'payouts'} onClick={() => setTab('payouts')}>
          {t('partners.detail.tabs.payouts')}
        </TabBtn>
        <TabBtn active={tab === 'clicks'} onClick={() => setTab('clicks')}>
          {t('partners.detail.tabs.clicks')}
        </TabBtn>
      </div>

      {tab === 'clients' && <ClientsTab partnerId={id} />}
      {tab === 'commissions' && <CommissionsTab partnerId={id} />}
      {tab === 'payouts' && <PayoutsTab partnerId={id} />}
      {tab === 'clicks' && <ClicksTab clicks={recentClicks} />}

      {/* QR modal */}
      <AnimatePresence>
        {qrOpen && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setQrOpen(false)}
          >
            <motion.div
              className="dialog-card"
              style={{ maxWidth: 340 }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-title">{partner.fullName}</div>
              <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                <div style={{ background: '#fff', padding: 8, borderRadius: 8, boxShadow: '0 0 0 1px var(--border-soft)' }}>
                  <QrCode value={referralUrl} size={240} />
                </div>
              </div>
              <div className="dialog-actions">
                <button className="btn btn-primary" onClick={() => setQrOpen(false)}>
                  {t('common.close')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={active ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
      style={{ minWidth: 120 }}
    >
      {children}
    </button>
  );
}

function KpiBento({
  eyebrow,
  label,
  value,
  accent,
  span = 'span-3',
}: {
  eyebrow: string;
  label: string;
  value: string;
  accent?: boolean;
  span?: string;
}) {
  return (
    <motion.div
      className={`bento-card ${accent ? 'accent' : ''} ${span}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
    >
      <span className="bento-num">{eyebrow}</span>
      <div style={{ marginTop: 'auto' }}>
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 4vw, 52px)',
            fontWeight: 500,
            letterSpacing: '-0.04em',
            lineHeight: 0.9,
            marginBottom: 12,
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: accent ? 'rgba(5,7,6,0.65)' : 'var(--text-soft)',
          }}
        >
          {label}
        </div>
      </div>
    </motion.div>
  );
}

// ---------- Clients (attributions) tab with pagination ----------

function ClientsTab({ partnerId }: { partnerId: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const directionLabel = useDirectionLabel();
  const appStatusLabel = useApplicationStatusLabel();
  const [skip, setSkip] = useState(0);

  const q = useQuery({
    queryKey: ['admin', 'partners', partnerId, 'attributions', skip],
    queryFn: () => adminGetPartnerAttributions(partnerId, { take: PAGE_SIZE, skip }),
  });

  if (q.isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  if (q.isError || !q.data) return <div className="card" style={{ padding: 24 }}>{t('common.error')}</div>;

  const { items, total, hasMore } = q.data;

  if (items.length === 0) {
    return <div className="card" style={{ padding: 24 }}>{t('partners.detail.empty.attributions')}</div>;
  }

  const goToRow = (a: PartnerAttribution) => {
    if (a.application) navigate(`/applications/${a.application.id}`);
    else if (a.student) navigate(`/students/${a.student.id}`);
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('partners.commission.col.createdAt')}</th>
              <th>{t('common.fullName')}</th>
              <th>{t('partners.col.phone')}</th>
              <th>{t('app.field.direction')}</th>
              <th>{t('partners.commission.col.status')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const type = attributionType(a);
              const clickable = !!(a.application || a.student);
              return (
                <tr
                  key={a.id}
                  onClick={() => clickable && goToRow(a)}
                  style={{ cursor: clickable ? 'pointer' : 'default' }}
                >
                  <td>{new Date(a.createdAt).toLocaleString('ru-RU')}</td>
                  <td>
                    {a.application?.fullName ||
                      a.student?.fullName ||
                      (a.telegramUserId ? `tg:${a.telegramUserId}` : a.emailHint || '—')}
                  </td>
                  <td>{a.application?.phone || a.student?.phone || '—'}</td>
                  <td>{a.application ? directionLabel(a.application.direction) : '—'}</td>
                  <td>{a.application ? appStatusLabel(a.application.status) : '—'}</td>
                  <td>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: 'var(--surface-alt, #f4f4f5)',
                        color: 'var(--text-soft)',
                      }}
                    >
                      {t(`partners.detail.attribution.type.${type}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: 14,
          borderTop: '1px solid var(--border-soft)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
          {skip + 1}–{skip + items.length} / {total}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-secondary btn-sm"
            disabled={skip === 0}
            onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
          >
            <Icon name="chevron_left" size={14} />
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={!hasMore}
            onClick={() => setSkip((s) => s + PAGE_SIZE)}
          >
            <Icon name="chevron_right" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Commissions tab (filtered by partnerId) ----------

function CommissionsTab({ partnerId }: { partnerId: string }) {
  const { t } = useT();
  const q = useQuery({
    queryKey: ['admin', 'commissions', 'byPartner', partnerId],
    queryFn: () => adminListCommissions({ partnerId }),
  });

  if (q.isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  const items = q.data ?? [];
  if (items.length === 0) return <div className="card" style={{ padding: 24 }}>{t('common.empty')}</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('partners.commission.col.createdAt')}</th>
              <th>{t('partners.commission.col.base')}</th>
              <th>{t('partners.commission.col.rate')}</th>
              <th>{t('partners.commission.col.amount')}</th>
              <th>{t('partners.commission.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.createdAt).toLocaleString('ru-RU')}</td>
                <td>{fmtMoneyCents(c.baseAmountCents, c.baseCurrency ?? c.currency)}</td>
                <td>
                  {c.percent === 0
                    ? `${t('partners.commission.rate.flat')} ${fmtMoneyCents(c.amountCents, c.currency)}`
                    : `${c.percent}%`}
                </td>
                <td>
                  <b>{fmtMoneyCents(c.amountCents, c.currency)}</b>
                </td>
                <td>{t(`partners.commission.status.${c.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Payouts tab (filtered by partnerId) ----------

function PayoutsTab({ partnerId }: { partnerId: string }) {
  const { t } = useT();
  const q = useQuery({
    queryKey: ['admin', 'payouts', 'byPartner', partnerId],
    queryFn: () => adminListPayouts({ partnerId }),
  });

  if (q.isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  const items = q.data ?? [];
  if (items.length === 0) return <div className="card" style={{ padding: 24 }}>{t('common.empty')}</div>;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('partners.payout.col.requestedAt')}</th>
              <th>{t('partners.payout.col.amount')}</th>
              <th>{t('partners.payout.col.method')}</th>
              <th>{t('partners.payout.col.details')}</th>
              <th>{t('partners.payout.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.requestedAt).toLocaleString('ru-RU')}</td>
                <td>{fmtMoneyCents(p.amountCents, p.currency)}</td>
                <td>{p.method || '—'}</td>
                <td style={{ wordBreak: 'break-all' }}>{p.details || '—'}</td>
                <td>{t(`partners.payout.status.${p.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Clicks tab (from recentClicks in detail response) ----------

function ClicksTab({
  clicks,
}: {
  clicks: { id: string; createdAt: string; source?: string | null; ip?: string | null; userAgent?: string | null; referer?: string | null }[];
}) {
  const { t } = useT();
  if (clicks.length === 0) {
    return <div className="card" style={{ padding: 24 }}>{t('partners.detail.empty.clicks')}</div>;
  }
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('partners.commission.col.createdAt')}</th>
              <th>Source</th>
              <th>IP</th>
              <th>Referer</th>
              <th>User-Agent</th>
            </tr>
          </thead>
          <tbody>
            {clicks.map((c) => (
              <tr key={c.id}>
                <td>{new Date(c.createdAt).toLocaleString('ru-RU')}</td>
                <td>{c.source || '—'}</td>
                <td>{c.ip || '—'}</td>
                <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.referer || '—'}
                </td>
                <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-soft)' }}>
                  {c.userAgent || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
