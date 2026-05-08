import { AnimatePresence, motion } from 'framer-motion';
import { useShouldShowOfflineBanner } from '../realtime';

/**
 * Тостер-индикатор состояния realtime-соединения.
 * Показывается ТОЛЬКО при реальной потере связи (после 3-сек grace period
 * на самовосстановление). idle/connecting/connected — баннер скрыт.
 */
export default function RealtimeStatusBanner() {
  const { show, state } = useShouldShowOfflineBanner();

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="rt-status"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.25 }}
        >
          <span className="rt-status-dot" />
          {state === 'reconnecting'
            ? 'Соединение потеряно, переподключаемся…'
            : 'Нет соединения с сервером'}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
