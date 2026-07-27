import { motion } from 'framer-motion';
import Icon from '../Icon';

const STAGES: { key: string; label: string; short: string }[] = [
  { key: 'NEW', label: 'Аризаи нав', short: 'Ариза' },
  { key: 'DOCS_REVIEW', label: 'Ҳуҷҷатҳо дар санҷиш', short: 'Санҷиш' },
  { key: 'DOCS_SUBMITTED', label: 'Супоридани ҳуҷҷатҳо', short: 'Супоридан' },
  { key: 'PRE_ADMISSION', label: 'Қабули пешакӣ', short: 'Қабули пешакӣ' },
  { key: 'AWAITING_PAYMENT', label: 'Интизори пардохт', short: 'Пардохт' },
  { key: 'ENROLLED', label: 'Қабул шуд', short: 'Қабул шуд' },
];

// Маппинг старых значений на новые
const LEGACY: Record<string, string> = {
  IN_PROGRESS: 'DOCS_REVIEW',
  COMPLETED: 'ENROLLED',
};

type Props = {
  currentStatus?: string | null;
};

export default function EnrollmentProgress({ currentStatus }: Props) {
  const normalized = currentStatus ? LEGACY[currentStatus] || currentStatus : 'NEW';
  const currentIdx = Math.max(0, STAGES.findIndex((s) => s.key === normalized));
  const percent = Math.round((currentIdx / (STAGES.length - 1)) * 100);

  return (
    <div className="ep-card">
      <div className="ep-head">
        <div>
          <div className="ep-title">Марҳилаи қабул</div>
          <div className="ep-current">{STAGES[currentIdx].label}</div>
        </div>
        <div className="ep-percent">{percent}%</div>
      </div>

      <div className="ep-track">
        {STAGES.map((s, i) => {
          const done = i < currentIdx;
          const current = i === currentIdx;
          return (
            <div key={s.key} className={`ep-step${done ? ' done' : ''}${current ? ' current' : ''}`}>
              <motion.div
                className="ep-dot"
                initial={{ scale: 0.8 }}
                animate={{ scale: current ? 1.1 : 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              >
                {done ? <Icon name="check" size={14} /> : <span>{i + 1}</span>}
              </motion.div>
              <div className="ep-label">{s.short}</div>
              {i < STAGES.length - 1 && (
                <div className="ep-connector">
                  <motion.div
                    className="ep-connector-fill"
                    initial={{ width: 0 }}
                    animate={{ width: done ? '100%' : '0%' }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
