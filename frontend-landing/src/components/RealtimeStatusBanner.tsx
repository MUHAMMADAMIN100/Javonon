import { AnimatePresence, motion } from 'framer-motion';
import { useShouldShowOfflineBanner } from '../realtime';

export default function RealtimeStatusBanner() {
  const { show, state } = useShouldShowOfflineBanner();
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className={`rt-status ${state}`}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
        >
          <span className="dot" />
          {state === 'reconnecting'
            ? 'Соединение потеряно, переподключаемся…'
            : 'Нет соединения с сервером'}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
