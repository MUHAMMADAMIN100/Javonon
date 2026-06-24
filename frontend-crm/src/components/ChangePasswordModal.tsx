import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { changePassword } from '../api/auth';
import { updateUser } from '../api/users';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import PasswordInput from './PasswordInput';
import { useT } from '../lib/i18n';

type Mode =
  | { kind: 'self' }
  | { kind: 'admin'; userId: string; userName: string };

type Props = {
  open: boolean;
  mode: Mode;
  onClose: () => void;
};

export default function ChangePasswordModal({ open, mode, onClose }: Props) {
  const { toast } = useUI();
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setErr(null);
    setBusy(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    // Триммим перед валидацией и отправкой — если юзер случайно зацепит
    // пробел (часто при copy-paste), backend всё равно сохранит хэш по
    // тримленному паролю, иначе login потом провалится.
    const cur = current.trim();
    const nxt = next.trim();
    const cnf = confirm.trim();

    if (nxt.length < 8) {
      setErr(t('auth.passwordHint'));
      return;
    }
    if (nxt !== cnf) {
      setErr(t('changePwd.mismatch'));
      return;
    }
    setBusy(true);
    try {
      if (mode.kind === 'self') {
        await changePassword(cur, nxt);
      } else {
        await updateUser(mode.userId, { password: nxt });
      }
      toast(t('changePwd.success'), 'success');
      reset();
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.message?.toString() || 'Не удалось сменить пароль');
    } finally {
      setBusy(false);
    }
  };

  return (
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
            className="dialog-card"
            style={{ maxWidth: 420 }}
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={submit}
          >
            <div className="dialog-icon">
              <Icon name="lock_reset" size={28} />
            </div>
            <div className="dialog-title">
              {mode.kind === 'self' ? t('changePwd.title') : `${t('changePwd.titleAdmin')}: ${mode.userName}`}
            </div>

            {err && (
              <div className="error-banner" style={{ marginBottom: 12, textAlign: 'left' }}>
                {err}
              </div>
            )}

            {mode.kind === 'self' && (
              <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
                <label>{t('changePwd.current')}</label>
                <PasswordInput
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                  autoFocus
                  autoComplete="current-password"
                />
              </div>
            )}
            <div className="form-group" style={{ textAlign: 'left', marginBottom: 12 }}>
              <label>{t('changePwd.new')}</label>
              <PasswordInput
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={8}
                autoFocus={mode.kind === 'admin'}
                autoComplete="new-password"
              />
            </div>
            <div className="form-group" style={{ textAlign: 'left', marginBottom: 16 }}>
              <label>{t('changePwd.repeat')}</label>
              <PasswordInput
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </div>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
