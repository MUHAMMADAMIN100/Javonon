import { motion } from 'framer-motion';

/**
 * Универсальный лоадер с пульсирующим логотипом Javonon.
 * Заменяет "Загрузка..." plain-text везде.
 */
export default function Loading({ label = 'Боркунӣ', fullscreen = false }: {
  label?: string;
  fullscreen?: boolean;
}) {
  const wrap: React.CSSProperties = fullscreen
    ? {
        position: 'fixed', inset: 0, background: 'var(--bg, #f8fafc)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 18, zIndex: 1000,
      }
    : {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: '60px 20px',
      };

  return (
    <div style={wrap}>
      <motion.img
        src="/javonon-logo.svg"
        alt="Javonon"
        width={56}
        height={56}
        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        style={{ display: 'block' }}
      />
      {label && (
        <motion.div
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--text-soft, #64748b)',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </motion.div>
      )}
    </div>
  );
}
