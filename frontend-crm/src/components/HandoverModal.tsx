import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dismissUser, getHandoverInfo, handoverUser, type HandoverCounts } from '../api/users';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { useRoleLabel } from '../lib/labels';
import CrmSelect from './CrmSelect';
import Icon from '../Icon';

/**
 * Окно «Уволить» / «Передать дела».
 *
 * Показывает, что числится за сотрудником (заявки в работе, студенты,
 * сделки, задачи, группы, места в схеме выручки), и даёт один выбор —
 * «Кому передать всё»: конкретному сотруднику или «Распределить
 * автоматически» (правила — backend/src/users/handover.ts).
 *
 * kind='dismiss' — увольнение вместе с передачей (одна транзакция на сервере);
 * kind='handover' — только передача, для уже уволенного сотрудника.
 */
type Props = {
  target: { id: string; fullName: string } | null;
  kind: 'dismiss' | 'handover';
  onClose: () => void;
  /** После успеха — чтобы страница обновила свой список. */
  onDone?: () => void;
};

const COUNT_KEYS: Array<keyof HandoverCounts> = [
  'applications', 'students', 'deals', 'tasks', 'groups', 'sessions', 'revenueShares',
];

export default function HandoverModal({ target, kind, onClose, onDone }: Props) {
  const { t } = useT();
  const roleLabel = useRoleLabel();
  const { toast } = useUI();
  const qc = useQueryClient();
  const open = !!target;
  const [to, setTo] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const info = useQuery({
    queryKey: ['users', 'handover', target?.id],
    queryFn: () => getHandoverInfo(target!.id),
    enabled: open,
    staleTime: 0,
  });

  useEffect(() => {
    if (open) {
      setTo('');
      setErr(null);
    }
  }, [open, target?.id]);

  const close = () => {
    if (busy) return;
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const d = info.data;
  const counts = d?.counts;
  const auto = to === '';
  const nonZero = counts ? COUNT_KEYS.filter((k) => counts[k] > 0) : [];

  // Предупреждения для «автоматически»: чего система сама решить не может.
  const notes: string[] = [];
  if (d && counts && auto) {
    if ((counts.applications > 0 || counts.deals > 0) && d.autoTargets.salesManagers === 0) notes.push(t('handover.autoNoSales'));
    if (counts.students > 0 && d.autoTargets.clientManagers === 0 && d.autoTargets.salesManagers > 0) notes.push(t('handover.autoNoClient'));
    if (counts.groups > 0 || counts.sessions > 0) notes.push(t('handover.autoNoTeacher'));
    if (counts.revenueShares > 0) notes.push(t('handover.autoFreeShares'));
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setErr(null);
    setBusy(true);
    const body = auto ? { mode: 'AUTO' as const } : { mode: 'USER' as const, toUserId: to };
    try {
      if (kind === 'dismiss') await dismissUser(target.id, body);
      else await handoverUser(target.id, body);
      toast(kind === 'dismiss' ? t('users.dismiss.done') : t('handover.done'), 'success');
      // Дела разъехались по заявкам, студентам, сделкам, задачам и группам —
      // обновляем всё, где их видно, а не только список сотрудников.
      for (const key of ['users', 'user', 'profile', 'applications', 'students', 'submissions', 'submission', 'tasks', 'kpi', 'chat', 'groups', 'calls', 'revenue-scheme', 'finance', 'salary', 'salary-settings']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      onDone?.();
      onClose();
    } catch (ex: any) {
      setErr(ex?.response?.data?.message?.toString() || t('toast.error'));
    } finally {
      setBusy(false);
    }
  };

  const title = target
    ? (kind === 'dismiss' ? t('handover.title.dismiss') : t('handover.title.transfer')).replace('{name}', target.fullName)
    : '';

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.form
            className="dialog-card handover-modal"
            data-testid="handover-modal"
            style={{ maxWidth: 480 }}
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
          >
            <div className={`dialog-icon${kind === 'dismiss' ? ' danger' : ''}`}>
              <Icon name={kind === 'dismiss' ? 'person_remove' : 'swap_horiz'} size={28} />
            </div>
            <div className="dialog-title">{title}</div>

            {info.isLoading && <div className="handover-muted">{t('handover.loading')}</div>}
            {info.isError && <div className="error-banner">{t('toast.error')}</div>}

            {counts && (
              <>
                {nonZero.length === 0 ? (
                  <div className="handover-muted" data-testid="handover-nothing">{t('handover.nothing')}</div>
                ) : (
                  <>
                    <div className="handover-label">{t('handover.has')}</div>
                    <ul className="handover-counts" data-testid="handover-counts">
                      {nonZero.map((k) => (
                        <li key={k} data-testid={`handover-count-${k}`}>
                          <span>{t(`handover.count.${k}`)}</span>
                          <b>{counts[k]}</b>
                        </li>
                      ))}
                    </ul>
                    <div className="form-group handover-to">
                      <label htmlFor="handover-to">{t('handover.to')}</label>
                      <CrmSelect
                        id="handover-to"
                        className="crm-select"
                        data-testid="handover-to"
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                        disabled={busy}
                      >
                        <option value="">{t('handover.auto')}</option>
                        {d!.candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.fullName} — {roleLabel(c.role)}
                          </option>
                        ))}
                      </CrmSelect>
                      <div className="handover-hint" data-testid="handover-hint">
                        {auto ? t('handover.autoHint') : t('handover.userHint')}
                      </div>
                    </div>
                    {notes.length > 0 && (
                      <ul className="handover-notes" data-testid="handover-notes">
                        {notes.map((n) => <li key={n}>{n}</li>)}
                      </ul>
                    )}
                  </>
                )}
                {kind === 'dismiss' && <div className="handover-muted">{t('handover.dismissNote')}</div>}
              </>
            )}

            {err && <div className="error-banner" style={{ marginTop: 12, textAlign: 'left' }}>{err}</div>}

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className={`btn ${kind === 'dismiss' ? 'btn-danger' : 'btn-primary'}`}
                data-testid="handover-submit"
                disabled={busy || !counts || (kind === 'handover' && nonZero.length === 0)}
              >
                {busy ? t('common.saving') : kind === 'dismiss' ? t('handover.confirmDismiss') : t('handover.confirmTransfer')}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
