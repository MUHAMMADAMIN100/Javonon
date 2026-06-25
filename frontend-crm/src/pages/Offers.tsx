import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import {
  OfferTemplate,
  OfferSignature,
  offerList,
  offerCreate,
  offerPatch,
  offerDelete,
  offerSignatures,
} from '../api/offers';
import { type Role } from '../api/types';
import { useRoleLabel } from '../lib/labels';

// Все 5 ТЗ-ролей + «общая» (для legacy fallback). Каждая роль может
// иметь свою активную оферту с уникальными принципами работы.
const ROLE_TAB_KEYS: { key: Role | null }[] = [
  { key: null },
  { key: 'FOUNDER' },
  { key: 'ADMIN' },
  { key: 'ACCOUNTANT' },
  { key: 'SALES_MANAGER' },
  { key: 'CLIENT_MANAGER' },
];

/**
 * Управление офертами (FOUNDER/ADMIN/ACCOUNTANT). Закрывает «полный
 * CRUD» в ТЗ §1: создать новую версию, читать историю, редактировать
 * текущую (если ещё никто не подписал), смотреть список подписавших.
 */
export default function Offers() {
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [signaturesOf, setSignaturesOf] = useState<OfferTemplate | null>(null);
  const [tab, setTab] = useState<Role | null>(null);

  if (!isElevated(me)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.accessDenied')}</div>;
  }

  const query = useQuery({
    queryKey: ['offers', 'all'],
    queryFn: offerList,
  });
  const allOffers = query.data ?? [];
  const offers = allOffers.filter((o) => (o.role ?? null) === tab);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['offers'] });

  // Количество активных по ролям — для бейджа на табе.
  const activeByRole = new Map<Role | 'null', number>();
  for (const o of allOffers) {
    if (!o.isActive) continue;
    const k = (o.role ?? 'null') as Role | 'null';
    activeByRole.set(k, (activeByRole.get(k) || 0) + 1);
  }

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">{t('eyebrow.legal')}</span>
        <h2 className="crm-section-title">{t('offers.title')}</h2>
      </div>

      {/* Табы по ролям (по ТЗ §1 — у каждой роли своя оферта). */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {ROLE_TAB_KEYS.map((rt) => {
          const isActive = tab === rt.key;
          const cnt = activeByRole.get((rt.key ?? 'null') as any) || 0;
          const label = rt.key === null ? t('offers.role.all') : roleLabel(rt.key);
          return (
            <button
              key={rt.key ?? 'null'}
              className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setTab(rt.key); setCreating(false); }}
            >
              {label}
              {cnt > 0 && (
                <span style={{
                  marginLeft: 6,
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: 10,
                  background: isActive ? 'rgba(255,255,255,0.25)' : '#10b981',
                  color: isActive ? '#fff' : '#fff',
                  fontWeight: 700,
                }}>
                  ●
                </span>
              )}
            </button>
          );
        })}
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 22, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: 0, maxWidth: 640 }}>
            {tab === null ? t('offers.role.all') : roleLabel(tab)}
          </p>
          {!creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="add" size={16} /> {t('offers.new')}
            </button>
          )}
        </div>
        {creating && <CreateForm role={tab} onClose={() => { setCreating(false); invalidate(); }} />}
      </motion.div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {offers.map((o) => (
          <OfferCard
            key={o.id}
            offer={o}
            onChanged={invalidate}
            onShowSignatures={() => setSignaturesOf(o)}
          />
        ))}
        {offers.length === 0 && (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
            {t('offers.empty')}
          </div>
        )}
      </div>

      {signaturesOf && (
        <SignaturesModal
          offer={signaturesOf}
          onClose={() => setSignaturesOf(null)}
        />
      )}
    </>
  );
}

function CreateForm({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const defaultTitle = role
    ? `${t('sidebar.offers')} · ${roleLabel(role)}`
    : t('sidebar.offers');
  const [title, setTitle] = useState(defaultTitle);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!content.trim()) {
      toast(t('toast.error'), 'error');
      return;
    }
    setBusy(true);
    try {
      await offerCreate({ title: title.trim() || undefined, content: content.trim(), role });
      toast(t('toast.created'), 'success');
      onClose();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      marginTop: 16,
      padding: 16,
      background: 'var(--bg-soft)',
      border: '1px solid var(--border-soft)',
      borderRadius: 12,
    }}>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label>{t('common.title')}</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label>{t('offers.editor.title')}</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          placeholder={t('offers.editor.placeholder')}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-sm btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={busy}>
          {busy ? t('common.saving') : t('common.create')}
        </button>
      </div>
    </div>
  );
}

function OfferCard({
  offer,
  onChanged,
  onShowSignatures,
}: {
  offer: OfferTemplate;
  onChanged: () => void;
  onShowSignatures: () => void;
}) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(offer.title);
  const [content, setContent] = useState(offer.content);
  const [busy, setBusy] = useState(false);
  const signCount = offer._count?.signatures ?? 0;
  const canEdit = signCount === 0 && offer.isActive;
  const canDelete = signCount === 0;

  const save = async () => {
    setBusy(true);
    try {
      await offerPatch(offer.id, { title, content });
      toast('Оферта обновлена', 'success');
      setEditing(false);
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: 22, opacity: offer.isActive ? 1 : 0.6 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--primary-dark)',
            marginBottom: 4,
            textTransform: 'uppercase',
          }}>
            {t('offers.version')} {offer.version} · {offer.isActive ? t('offers.active') : t('offers.archived')} · {offer.role ? roleLabel(offer.role) : t('offers.role.all')}
          </div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, margin: 0 }}>
            {offer.title}
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
            {new Date(offer.createdAt).toLocaleDateString('ru-RU')}
            {' · '}
            <button
              onClick={onShowSignatures}
              style={{ background: 'transparent', border: 'none', color: 'var(--primary-dark)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
            >
              {t('offers.tab.signatures')}: {signCount}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {canEdit && !editing && (
            <button className="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>
              <Icon name="edit" size={14} /> {t('common.edit')}
            </button>
          )}
          {canDelete && !editing && (
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: t('offers.confirm.delete'),
                  message: `«${offer.title}» v${offer.version}`,
                  danger: true,
                  confirmText: t('common.delete'),
                });
                if (!ok) return;
                setBusy(true);
                try {
                  await offerDelete(offer.id);
                  toast(t('toast.deleted'), 'success');
                  onChanged();
                } catch (e: any) {
                  toast(e?.response?.data?.message || t('toast.error'), 'error');
                } finally {
                  setBusy(false);
                }
              }}
              title={t('common.delete')}
            >
              <Icon name="delete" size={14} />
            </button>
          )}
        </div>
      </div>

      {!editing ? (
        <div style={{
          maxHeight: 240, overflowY: 'auto',
          padding: 14,
          background: 'var(--bg-soft)',
          border: '1px solid var(--border-soft)',
          borderRadius: 10,
          whiteSpace: 'pre-wrap',
          fontSize: 13,
          lineHeight: 1.55,
        }}>
          {offer.content}
        </div>
      ) : (
        <>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label>{t('common.title')}</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label>{t('offers.editor.title')}</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={14}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)} disabled={busy}>{t('common.cancel')}</button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </>
      )}

      {!canEdit && offer.isActive && signCount > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-soft)' }}>
          ⚠️ Эту версию уже подписали ({signCount}). Чтобы изменить — создай новую версию.
        </div>
      )}
    </motion.div>
  );
}

function SignaturesModal({ offer, onClose }: { offer: OfferTemplate; onClose: () => void }) {
  const query = useQuery({
    queryKey: ['offers', offer.id, 'signatures'],
    queryFn: () => offerSignatures(offer.id),
  });
  const signatures = query.data ?? [];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        style={{
          background: 'white',
          borderRadius: 16,
          padding: 24,
          maxWidth: 540,
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18 }}>
            Подписи · «{offer.title}» v{offer.version}
          </h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {query.isLoading && <div>Загружаем…</div>}
        {signatures.length === 0 && !query.isLoading && (
          <div style={{ textAlign: 'center', color: 'var(--text-soft)', padding: 32 }}>
            Никто ещё не подписал эту версию.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {signatures.map((s) => (
            <div key={s.id} style={{
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 10,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              gap: 12,
            }}>
              <div>
                <div style={{ fontWeight: 500 }}>{s.user?.fullName || '—'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-soft)' }}>{s.user?.email || '—'}</div>
                {s.ip && <div style={{ fontSize: 11, color: 'var(--text-soft)', fontFamily: 'var(--font-mono)' }}>IP: {s.ip}</div>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-soft)', textAlign: 'right' }}>
                {new Date(s.signedAt).toLocaleString('ru-RU')}
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
