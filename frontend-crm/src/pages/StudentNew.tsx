import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { createStudent } from '../api/students';
import type { Direction } from '../api/types';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { compose, email as emailRule, hasErrors, maxLen, minLen, phoneRule, required, validateAll } from '../utils/validators';
import PhoneInput from '../components/PhoneInput';
import BackButton from '../components/BackButton';
import { keys } from '../lib/queryKeys';
import { useInvalidatingMutation } from '../lib/optimistic';
import { useT } from '../lib/i18n';
import { useDirectionLabel, useChannelLabel } from '../lib/labels';

// Строка-копируемое поле для модалки выдачи доступа.
function CredRow({ label, value, small }: { label: string; value: string; small?: boolean }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="creds-row">
      <span className="creds-label">{label}:</span>
      <code className="creds-value" style={small ? { fontSize: 12 } : undefined}>{value}</code>
      <button
        type="button"
        onClick={onCopy}
        className="creds-copy-btn"
        title={copied ? t('toast.copied') : t('common.copy')}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={15} />
      </button>
    </div>
  );
}

export default function StudentNew() {
  const navigate = useNavigate();
  const { toast } = useUI();
  const { t } = useT();
  const directionLabel = useDirectionLabel();
  const channelLabel = useChannelLabel();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneLabel, setPhoneLabel] = useState('сам');
  const [secondaryPhone, setSecondaryPhone] = useState('');
  const [secondaryLabel, setSecondaryLabel] = useState('');
  const [preferredChannel, setPreferredChannel] = useState('');
  const [birthday, setBirthday] = useState('');
  const [email, setEmail] = useState('');
  const [direction, setDirection] = useState<Direction>('BACHELOR');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<
    | { id: string; email: string; password: string; fullName: string }
    | null
  >(null);

  const errors = validateAll(
    { fullName, phone, email, comment },
    {
      fullName: compose(required('Введите ФИО'), minLen(2), maxLen(100)),
      phone: phoneRule(),
      email: compose(required('Введите email'), emailRule()),
      comment: maxLen(1000),
    },
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const showErr = (k: keyof typeof errors) => touched[k] && errors[k];
  const isInvalid = hasErrors(errors);

  const createMut = useInvalidatingMutation({
    mutationFn: createStudent,
    invalidate: [keys.students.all, keys.applications.all],
    onSuccess: (res: any) => {
      setCredentials({
        id: res.id,
        email: res.email,
        password: res.plainPassword,
        fullName: res.fullName,
      });
    },
    onError: (e: any) => setError(e.response?.data?.message?.toString() || t('toast.error')),
  });
  const submitting = createMut.isPending;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched({ fullName: true, phone: true, email: true, comment: true });
    if (isInvalid) return;
    setError(null);
    // Собираем телефоны и подписи синхронно по индексу — backend ожидает
    // одинаковую длину массивов.
    const phones: string[] = [];
    const phoneLabels: string[] = [];
    if (phone) {
      phones.push(phone);
      phoneLabels.push(phoneLabel.trim() || 'сам');
    }
    if (secondaryPhone) {
      phones.push(secondaryPhone);
      phoneLabels.push(secondaryLabel.trim());
    }

    createMut.mutate({
      fullName,
      phones,
      phoneLabels,
      preferredChannel: (preferredChannel || undefined) as any,
      birthday: birthday || undefined,
      email,
      direction,
      comment: comment || undefined,
    } as any);
  };

  const copyBoth = async () => {
    if (!credentials) return;
    const text = `${t('userDetail.field.email')}: ${credentials.email}\n${t('login.password')}: ${credentials.password}\n${t('login.title')}: https://javonon.vercel.app/login`;
    try {
      await navigator.clipboard.writeText(text);
      toast(t('toast.copied'), 'success');
    } catch {
      toast(t('toast.error'), 'error');
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <BackButton fallback="/students" />
      <div className="card">
      <div className="card-header"><h2 className="card-title">{t('studentNew.title')}</h2></div>
      <div className="card-body">
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label>{t('app.field.fullName')} *</label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onBlur={() => setTouched((tt) => ({ ...tt, fullName: true }))}
              className={`crm-input${showErr('fullName') ? ' input-error' : ''}`}
              maxLength={100}
              required
            />
            {showErr('fullName') && <div className="form-error-text">{errors.fullName}</div>}
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>{t('app.field.phone')}</label>
              <PhoneInput
                value={phone}
                onChange={(v) => setPhone(v)}
                error={!!showErr('phone')}
              />
              {showErr('phone') && <div className="form-error-text">{errors.phone}</div>}
            </div>
            <div className="form-group">
              <label>{t('studentNew.field.phoneLabel')}</label>
              <input
                className="crm-input"
                value={phoneLabel}
                onChange={(e) => setPhoneLabel(e.target.value)}
                maxLength={40}
              />
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>{t('app.field.secondaryPhone')}</label>
              <PhoneInput
                value={secondaryPhone}
                onChange={(v) => setSecondaryPhone(v)}
              />
            </div>
            <div className="form-group">
              <label>{t('studentNew.field.secondaryLabel')}</label>
              <input
                className="crm-input"
                value={secondaryLabel}
                onChange={(e) => setSecondaryLabel(e.target.value)}
                maxLength={40}
              />
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>{t('app.field.preferredChannel')}</label>
              <select className="crm-select" value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value)}>
                <option value="">—</option>
                <option value="WHATSAPP">{channelLabel('WHATSAPP' as any)}</option>
                <option value="PHONE">{channelLabel('PHONE' as any)}</option>
                <option value="INSTAGRAM">{channelLabel('INSTAGRAM' as any)}</option>
                <option value="TELEGRAM">{channelLabel('TELEGRAM' as any)}</option>
                <option value="EMAIL">{channelLabel('EMAIL' as any)}</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('app.field.birthday')}</label>
              <input
                className="crm-input"
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label>{t('userDetail.field.email')} *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((tt) => ({ ...tt, email: true }))}
              className={`crm-input${showErr('email') ? ' input-error' : ''}`}
              required
            />
            {showErr('email') && <div className="form-error-text">{errors.email}</div>}
          </div>
          <div className="form-group">
            <label>{t('app.field.direction')} *</label>
            <select className="crm-select" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              <option value="BACHELOR">{directionLabel('BACHELOR')}</option>
              <option value="MASTER">{directionLabel('MASTER')}</option>
              <option value="LANGUAGE">{directionLabel('LANGUAGE')}</option>
              <option value="LANGUAGE_COLLEGE">{directionLabel('LANGUAGE_COLLEGE')}</option>
              <option value="LANGUAGE_BACHELOR">{directionLabel('LANGUAGE_BACHELOR')}</option>
              <option value="COLLEGE">{directionLabel('COLLEGE')}</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('app.field.comment')}</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={1000}
              className={`crm-textarea${showErr('comment') ? ' input-error' : ''}`}
            />
            {showErr('comment') && <div className="form-error-text">{errors.comment}</div>}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/students')}>{t('common.cancel')}</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || isInvalid}
            >
              {submitting ? t('common.saving') : t('common.create')}
            </button>
          </div>
        </form>
      </div>

      <AnimatePresence>
        {credentials && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="dialog-card"
              style={{ maxWidth: 480 }}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.22 }}
            >
              <div className="dialog-icon" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}>
                <Icon name="check_circle" size={28} />
              </div>
              <div className="dialog-title">{t('toast.created')}</div>
              <div className="dialog-message">
                <b>{credentials.fullName}</b> — {t('studentDetail.password.oneTime')}
              </div>

              <div className="creds-box">
                <CredRow label={t('userDetail.field.email')} value={credentials.email} />
                <CredRow label={t('login.password')} value={credentials.password} />
                <CredRow label={t('login.title')} value="javonon.vercel.app/login" small />
              </div>

              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={copyBoth}>
                  <Icon name="content_copy" size={16} style={{ marginRight: 4 }} />
                  {t('common.copy')}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => navigate(`/students/${credentials.id}`)}
                >
                  {t('common.open')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
