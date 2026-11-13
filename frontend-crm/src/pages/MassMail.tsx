import { useState } from 'react';
import { roleCan } from '../lib/permissions';
import CrmSelect from '../components/CrmSelect';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useDirectionLabel } from '../lib/labels';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import {
  MassMailCampaign,
  MassMailChannel,
  MASS_MAIL_CHANNEL_LABEL,
  MASS_MAIL_STATUS_LABEL,
  listCampaigns,
  createCampaign,
  sendCampaignNow,
  cancelCampaign,
  deleteCampaign,
  audienceCount,
  campaignRecipients,
} from '../api/massmail';
import BusyLabel from '../components/BusyLabel';
import DirectionOptions from '../components/DirectionOptions';

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

  // Права роли «Рассылки — …»; должность — руководство, как раньше.
  const base = isElevated(me);
  const canCreate = roleCan(me, 'massmail:create', base);
  const canSend = roleCan(me, 'massmail:send', base);
  if (!roleCan(me, 'massmail:read', base)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.accessDenied')}</div>;
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['massmail'] });

  const onSendNow = async (c: MassMailCampaign) => {
    // QA-3 (набл. 20): сначала узнаём, скольким людям уйдёт сообщение, и
    // показываем это число в подтверждении — рассылку отозвать нельзя.
    let n: number;
    try {
      n = await campaignRecipients(c.id);
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      return;
    }
    if (n === 0) {
      toast(t('massmail.noRecipients'), 'error');
      return;
    }
    const ok = await confirm({
      title: t('massmail.confirm.send'),
      message: t('massmail.confirm.sendMessage')
        .replace('{name}', c.name)
        .replace('{channel}', MASS_MAIL_CHANNEL_LABEL[c.channel])
        .replace('{n}', n.toLocaleString('ru-RU')),
      confirmText: t('massmail.confirm.sendOk').replace('{n}', n.toLocaleString('ru-RU')),
      danger: true,
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

  const directionLabel = useDirectionLabel();
  const onDelete = async (c: MassMailCampaign) => {
    const ok = await confirm({ title: t('massmail.confirm.delete'), message: `«${c.name}»`, danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try {
      await deleteCampaign(c.id);
      toast(t('toast.deleted'), 'success');
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
      <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ padding: 22, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: 0, maxWidth: 640 }}>
            {t('massmail.subtitle')}
          </p>
          {!creating && canCreate && (
            <button className="btn btn-primary" data-testid="massmail-new" onClick={() => setCreating(true)}>
              <Icon name="add" size={16} /> {t('massmail.new')}
            </button>
          )}
        </div>
        {creating && (
          <FormModal
            open
            title={t('massmail.new')}
            onClose={() => setCreating(false)}
            testId="massmail-form"
          >
            <CreateForm onClose={() => { setCreating(false); invalidate(); }} />
          </FormModal>
        )}
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
                {/* Аудитория словами, а не сырой JSON (QA №45). */}
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-soft)' }} data-testid="massmail-audience">
                  {t('massmail.field.audience')}: {t(`massmail.audience.${(c.audience as any)?.type ?? 'all-leads'}`)}
                  {(c.audience as any)?.value ? ` · ${directionLabel((c.audience as any).value)}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 110 }}>
                {canSend && (c.status === 'DRAFT' || c.status === 'SCHEDULED') && (
                  <button className="btn btn-sm btn-primary" onClick={() => onSendNow(c)} data-testid="massmail-send">
                    <Icon name="send" size={14} /> {t('massmail.action.send')}
                  </button>
                )}
                {canSend && (c.status === 'SCHEDULED' || c.status === 'SENDING') && (
                  <button className="btn btn-sm btn-danger" onClick={() => onCancel(c)} data-testid="massmail-cancel">
                    {t('common.cancel')}
                  </button>
                )}
                {(c.status === 'DRAFT' || c.status === 'CANCELED') && (
                  <button className="btn btn-sm btn-danger" onClick={() => onDelete(c)} data-testid="massmail-delete">
                    <Icon name="delete" size={14} /> {t('common.delete')}
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
  // Аудиторию выбирают явно: «Все лиды» по умолчанию — это рассылка всем (QA №45).
  const [audienceType, setAudienceType] = useState<'' | 'all-leads' | 'paid-students' | 'by-direction'>('');
  const [showErr, setShowErr] = useState(false);
  const [audienceValue, setAudienceValue] = useState('');
  const audienceReady = !!audienceType && (audienceType !== 'by-direction' || !!audienceValue);
  const countQ = useQuery({
    queryKey: ['massmail', 'audience-count', audienceType, audienceValue],
    queryFn: () => audienceCount({ type: audienceType, ...(audienceType === 'by-direction' ? { value: audienceValue } : {}) }),
    enabled: audienceReady,
    staleTime: 30_000,
  });
  const [busy, setBusy] = useState(false);

  const errs = {
    name: !name.trim() ? t('massmail.err.name') : '',
    body: !body.trim() ? t('massmail.err.body') : '',
    audience: !audienceType ? t('massmail.err.audience') : audienceType === 'by-direction' && !audienceValue ? t('massmail.err.direction') : '',
  };
  const submit = async () => {
    // Ошибки — у полей, а не одно «Ошибка» (QA №45).
    if (errs.name || errs.body || errs.audience) {
      setShowErr(true);
      return;
    }
    setBusy(true);
    try {
      await createCampaign({
        name: name.trim(),
        channel,
        subject: subject.trim() || undefined,
        body: body.trim(),
        audience: { type: audienceType as Exclude<typeof audienceType, ''>, ...(audienceType === 'by-direction' && audienceValue ? { value: audienceValue } : {}) },
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
          <input className={`crm-input${showErr && errs.name ? ' input-error' : ''}`} value={name} onChange={(e) => setName(e.target.value)} />
          {showErr && errs.name && <div className="form-error-text">{errs.name}</div>}
        </div>
        <div className="form-group">
          <label>{t('massmail.field.channel')}</label>
          <CrmSelect className="crm-select" value={channel} onChange={(e) => setChannel(e.target.value as MassMailChannel)}>
            <option value="WHATSAPP">WhatsApp</option>
            <option value="TELEGRAM">Telegram</option>
            <option value="SMS">SMS</option>
            <option value="INSTAGRAM">Instagram</option>
          </CrmSelect>
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label>{t('massmail.field.subject')}</label>
        <input className="crm-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="form-grid-2" style={{ gap: 12, marginBottom: 12 }}>
        <div className="form-group">
          <label>{t('massmail.field.audience')}</label>
          <CrmSelect className={`crm-select${showErr && errs.audience ? ' input-error' : ''}`} value={audienceType} onChange={(e) => setAudienceType(e.target.value as any)} data-testid="massmail-audience-pick">
            <option value="">{t('massmail.audience.choose')}</option>
            <option value="all-leads">{t('massmail.audience.all-leads')}</option>
            <option value="paid-students">{t('massmail.audience.paid-students')}</option>
            <option value="by-direction">{t('app.field.direction')}</option>
          </CrmSelect>
          {showErr && errs.audience && <div className="form-error-text">{errs.audience}</div>}
          {/* QA-3 (набл. 20): сколько людей получит рассылку — видно до создания. */}
          {audienceReady && (
            <div className="form-hint-text" data-testid="massmail-recipients" title={t('massmail.recipients.hint')}>
              {countQ.isFetching && countQ.data === undefined
                ? t('massmail.recipients.loading')
                : countQ.data !== undefined
                  ? t('massmail.recipients').replace('{n}', countQ.data.toLocaleString('ru-RU'))
                  : ''}
            </div>
          )}
        </div>
        {audienceType === 'by-direction' && (
          <div className="form-group">
            <label>{t('app.field.direction')}</label>
            <CrmSelect className="crm-select" value={audienceValue} onChange={(e) => setAudienceValue(e.target.value)}>
              <option value="">—</option>
              <DirectionOptions current={audienceValue || null} />
            </CrmSelect>
          </div>
        )}
      </div>
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label>{t('massmail.field.body')}</label>
        <textarea
          className={`crm-textarea${showErr && errs.body ? ' input-error' : ''}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
        />
        {showErr && errs.body && <div className="form-error-text">{errs.body}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-sm btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={busy}>
          <BusyLabel busy={busy}>{t('common.create')}</BusyLabel>
        </button>
      </div>
    </div>
  );
}
