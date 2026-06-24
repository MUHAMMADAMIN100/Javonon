import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

type Props = {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

/**
 * Стилизованная модалка подтверждения "уйти со страницы с несохранёнными
 * изменениями". Заменяет нативный window.confirm() в useUnsavedChangesGuard.
 *
 * Поведение:
 *  - Esc → cancel
 *  - Клик по backdrop → cancel
 *  - Кнопка "Уйти без сохранения" подсвечена красным (опасное действие)
 */
export default function UnsavedChangesDialog({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel,
  cancelLabel,
}: Props) {
  const { t } = useT();
  const _title = title ?? t('unsaved.title');
  const _message = message ?? t('unsaved.message');
  const _confirmLabel = confirmLabel ?? t('unsaved.confirm');
  const _cancelLabel = cancelLabel ?? t('unsaved.cancel');
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onCancel}
        >
          <motion.div
            className="dialog-card"
            style={{ maxWidth: 440 }}
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-icon danger">
              <Icon name="warning" size={28} />
            </div>
            <div className="dialog-title">{_title}</div>
            <div className="dialog-message">{_message}</div>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onCancel} autoFocus>
                {_cancelLabel}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={onConfirm}
              >
                {_confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
