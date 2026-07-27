import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { listStudentInteractions, type StudentInteraction } from '../studentApi';
import Icon from '../Icon';
import Loading from './Loading';

const TYPE_LABEL: Record<string, string> = {
  CALL: 'Занг',
  EMAIL: 'Почтаи электронӣ',
  MEETING: 'Вохӯрӣ',
  NOTE: 'Қайд',
  SMS: 'SMS',
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
};

const TYPE_ICON: Record<string, string> = {
  CALL: 'call',
  EMAIL: 'mail',
  MEETING: 'groups',
  NOTE: 'sticky_note_2',
  SMS: 'sms',
  TELEGRAM: 'send',
  WHATSAPP: 'chat',
};

function fmtRel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function InteractionsHistory() {
  const [items, setItems] = useState<StudentInteraction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listStudentInteractions()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="stu-card">
      <h2>Таърихи муошират бо менеҷер</h2>
      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
          <Icon name="forum" size={48} style={{ opacity: 0.25, marginBottom: 12 }} />
          <div>Ҳоло сабтҳо дар бораи муошират нест</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>
            Менеҷер дар ин ҷо ҳамаи зангҳо, вохӯриҳо ва мактубҳоро сабт мекунад
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it) => (
            <motion.div
              key={it.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              style={{
                display: 'flex',
                gap: 14,
                padding: 16,
                border: '1px solid var(--border-soft, #e5e5e5)',
                borderRadius: 12,
                background: 'white',
                borderLeft: '3px solid rgb(1, 36, 87)',
              }}
            >
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: 'rgba(1, 54, 139,0.10)',
                color: 'rgb(1, 36, 87)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Icon name={TYPE_ICON[it.type]} size={20} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 12, color: 'rgb(1, 36, 87)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {TYPE_LABEL[it.type]}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-soft)', marginLeft: 'auto' }}>
                    {fmtRel(it.occurredAt)}
                  </span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: it.details ? 4 : 0 }}>
                  {it.summary}
                </div>
                {it.details && (
                  <div style={{ fontSize: 13, color: 'var(--text-soft)', whiteSpace: 'pre-wrap', marginTop: 4 }}>
                    {it.details}
                  </div>
                )}
                {it.author && (
                  <div style={{ fontSize: 11, color: 'var(--text-light, #999)', marginTop: 8 }}>
                    {it.author.fullName}
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
