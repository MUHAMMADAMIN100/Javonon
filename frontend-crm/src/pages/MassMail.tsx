import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel } from '../lib/labels';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import {
  MassMailCampaign,
  MassMailChannel,
  MASS_MAIL_CHANNEL_LABEL,
  MASS_MAIL_STATUS_LABEL,
  listCampaigns,
  createCampaign,
  sendCampaignNow,
  cancelCampaign,
} from '../api/massmail';

const STATUS_COLOR: Record<string, string> = {
  DRAFT: '#94a3b8',
  SCHEDULED: '#3b82f6',
  SENDING: '#f59e0b',
  SENT: '#10b981',
  CANCELED: '#6b7280',
  FAILED: '#dc2626',
};

export default function MassMail() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ['massmail', 'list'],
    queryFn: listCampaigns,
  });
  const campaigns = query.data ?? [];

  if (!isElevated(me)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.accessDenied')}</div>;
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['massmail'] });

  const onSendNow = async (c: MassMailCampaign) => {
    const ok = await confirm({
      title: t('massmail.confirm.send'),
      message: `«${c.name}» (${MASS_MAIL_CHANNEL_LABEL[c.channel]})`,
      confirmText: t('massmail.action.send'),
      danger: false,
    });
    if (!ok) return;
    try {
      await sendCampaignNow(c.id);
      toast(t('toast.sent'), 'success');
      invalidate();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const onCancel = async (c: MassMailCampaign) => {
    const ok = await confirm({
      title: t('massmail.confirm.cancel'),
      message: `«${c.name}»`,
      danger: true,
      confirmText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await cancelCampaign(c.id);
      toast(t('toast.updated'), 'info');
      invalidate();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">CAMPAIGNS</span>
        <h2 className="crm-section-title">{t('massmail.title')}</h2>
      </div>

      <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: 0, maxWidth: 640 }}>
            {t('massmail.subtitle')}
          </p>
          {!creating && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Icon name="add" size={16} /> {t('massmail.new')}
            </button>
          )}
        </div>
        {creating && <CreateForm onClose={() => { setCreating(false); invalidate(); }} />}
      </motion.div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {campaigns.map((c) => (
          <motion.div
            key={c.id}
            className="card"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ padding: 18 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 10px',
                    borderRadius: 999,
                    fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
                    background: `${STATUS_COLOR[c.status]}20`,
                    color: STATUS_COLOR[c.status],
                    textTransform: 'uppercase',
                  }}>
                    {t(`massmail.status.${c.status}`)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                    {MASS_MAIL_CHANNEL_LABEL[c.channel]}
                  </span>
                  {c.status === 'SENT' && (
                    <span style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                      · ✓ {c.sentCount} · ✗ {c.failedCount}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 500 }}>
                  {c.name}
                </div>
                {c.subject && <div style={{ fontSize: 13, color: 'var(--text-soft)', marginTop: 2 }}>{c.subject}</div>}
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap', maxHeight: 96, overflow: 'hidden' }}>
                  {c.body}
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-soft)', fontFamily: 'var(--font-mono)' }}>
                  audience: {JSON.stringify(c.audience)}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 110 }}>
                {(c.status === 'DRAFT' || c.status === 'SCHEDULED') && (
                  <button className="btn btn-sm btn-primary" onClick={() => onSendNow(c)}>
                    <Icon name="send" size={14} /> {t('massmail.action.send')}
                  </button>
                )}
                {(c.status === 'DRAFT' || c.status === 'SCHEDULED' || c.status === 'SENDING') && (
                  <button className="btn btn-sm btn-danger" onClick={() => onCancel(c)}>
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        ))}
        {campaigns.length === 0 && !creating && (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
            {t('common.empty')}
          </div>
        )}
      </div>
    </>
  );
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const { toast } = useUI();
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<MassMailChannel>('WHATSAPP');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [audienceType, setAudienceType] = useState<'all-leads' | 'paid-students' | 'by-direction'>('all-leads');
  const [audienceValue, setAudienceValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !body.trim()) {
      toast(t('toast.error'), 'error');
      return;
    }
    setBusy(true);
    try {
      await createCampaign({
        name: name.trim(),
        channel,
        subject: subject.trim() || undefined,
        body: body.trim(),
        audience: { type: audienceType, ...(audienceType === 'by-direction' && audienceValue ? { value: audienceValue } : {}) },
      });
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
      <div className="form-grid-2" style={{ gap: 12, marginBottom: 12 }}>
        <div className="form-group">
          <label>{t('massmail.field.name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label>{t('massmail.field.channel')}</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value as MassMailChannel)}>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="TELEGRAM">Telegram</option>
            <option value="SMS">SMS</option>
            <option value="INSTAGRAM">Instagram</option>
          </select>
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label>{t('massmail.field.subject')}</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label>{t('massmail.field.body')}</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
        />
      </div>
      <div className="form-grid-2" style={{ gap: 12, marginBottom: 12 }}>
        <div className="form-group">
          <label>{t('massmail.field.audience')}</label>
          <select value={audienceType} onChange={(e) => setAudienceType(e.target.value as any)}>
            <option value="all-leads">{t('massmail.audience.all-leads')}</option>
            <option value="paid-students">{t('massmail.audience.paid-students')}</option>
            <option value="by-direction">{t('app.field.direction')}</option>
          </select>
        </div>
        {audienceType === 'by-direction' && (
          <div className="form-group">
            <label>{t('app.field.direction')}</label>
            <select value={audienceValue} onChange={(e) => setAudienceValue(e.target.value)}>
              <option value="">—</option>
              <option value="BACHELOR">{directionLabel('BACHELOR')}</option>
              <option value="MASTER">{directionLabel('MASTER')}</option>
              <option value="LANGUAGE">{directionLabel('LANGUAGE')}</option>
              <option value="LANGUAGE_COLLEGE">{directionLabel('LANGUAGE_COLLEGE')}</option>
              <option value="LANGUAGE_BACHELOR">{directionLabel('LANGUAGE_BACHELOR')}</option>
              <option value="COLLEGE">{directionLabel('COLLEGE')}</option>
            </select>
          </div>
        )}
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
