import { motion } from 'framer-motion';
import { useT } from '../lib/i18n';

/**
 * Универсальный лоадер с пульсирующим логотипом Javonon.
 * Используется везде где раньше был "Загрузка..." plain-text.
 */
export default function Loading({ label, fullscreen = false }: {
  label?: string;
  fullscreen?: boolean;
}) {
  const { t } = useT();
  const text = label ?? t('common.loading');
  const wrap: React.CSSProperties = fullscreen
    ? {
        position: 'fixed', inset: 0, background: 'var(--bg, #f8fafc)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 18, zIndex: 1000,
      }
    : {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: '40px 20px',
      };

  return (
    <div style={wrap}>
      <motion.img
        src="/javonon-logo.svg"
        alt="Javonon"
        width={56}
        height={56}
        animate={{
          scale: [1, 1.08, 1],
          opacity: [0.7, 1, 0.7],
        }}
        transition={{
          duration: 1.4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        style={{ display: 'block' }}
      />
      {text && (
        <motion.div
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--text-soft, #64748b)',
            textTransform: 'uppercase',
          }}
        >
          {text}
        </motion.div>
      )}
    </div>
  );
}
