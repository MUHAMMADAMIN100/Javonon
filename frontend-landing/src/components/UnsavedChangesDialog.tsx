import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Icon from '../Icon';

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
  title = 'Тағйироти нигоҳ дошта нашуда',
  message = 'Дар варақа тағйироти нигоҳ дошта нашуда мавҷуданд. Агар ҳозир равед, онҳо гум мешаванд.',
  confirmLabel = 'Бе нигоҳдорӣ рафтан',
  cancelLabel = 'Мондан',
}: Props) {
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
          className="uc-dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onCancel}
        >
          <motion.div
            className="uc-dialog-card"
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="uc-dialog-icon">
              <Icon name="warning" size={28} />
            </div>
            <div className="uc-dialog-title">{title}</div>
            <div className="uc-dialog-message">{message}</div>

            <div className="uc-dialog-actions">
              <button type="button" className="btn btn-outline" onClick={onCancel} autoFocus>
                {cancelLabel}
              </button>
              <button type="button" className="btn btn-primary uc-dialog-danger" onClick={onConfirm}>
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
