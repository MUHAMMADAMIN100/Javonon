import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: number; kind: ToastKind; message: string };

type Ctx = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  toast: (message: string, kind?: ToastKind) => void;
};

const UIContext = createContext<Ctx | null>(null);

export function useUI() {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error('useUI must be used inside <UIProvider>');
  return ctx;
}

export function UIProvider({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setDialog({ ...opts, resolve });
    });
  }, []);

  const closeDialog = (result: boolean) => {
    if (!dialog) return;
    dialog.resolve(result);
    setDialog(null);
  };

  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <UIContext.Provider value={{ confirm, toast }}>
      {children}

      <AnimatePresence>
        {dialog && (
          <motion.div
            className="dialog-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => closeDialog(false)}
          >
            <motion.div
              className="dialog-card"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={`dialog-icon${dialog.danger ? ' danger' : ''}`}>
                <Icon name={dialog.danger ? 'warning' : 'help'} size={28} />
              </div>
              {dialog.title && <div className="dialog-title">{dialog.title}</div>}
              <div className="dialog-message">{dialog.message}</div>
              <div className="dialog-actions">
                <motion.button
                  className="btn btn-secondary"
                  onClick={() => closeDialog(false)}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                >
                  {dialog.cancelText || t('confirm.cancel')}
                </motion.button>
                <motion.button
                  className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => closeDialog(true)}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  autoFocus
                >
                  {dialog.confirmText || t('confirm.ok')}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="toast-stack">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className={`toast toast-${t.kind}`}
              initial={{ opacity: 0, y: -20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              layout
            >
              <Icon
                name={t.kind === 'success' ? 'check_circle' : t.kind === 'error' ? 'error' : 'info'}
                size={20}
              />
              <span>{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </UIContext.Provider>
  );
}
