import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ROLE_LABEL, type ManagerInfo, type User } from '../api/types';
import { listUsers } from '../api/users';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { isElevated } from '../lib/roles';

type Slot = 'local' | 'china';

type Props = {
  manager: ManagerInfo | null | undefined;
  chinaManager: ManagerInfo | null | undefined;
  onReassign: (patch: { managerId?: string | null; chinaManagerId?: string | null }) => Promise<void>;
};

function Slot({
  kind,
  label,
  icon,
  manager,
  isAdmin,
  meId,
  users,
  onPick,
  saving,
}: {
  kind: Slot;
  label: string;
  icon: string;
  manager: ManagerInfo | null | undefined;
  isAdmin: boolean;
  meId?: string;
  users: User[];
  onPick: (kind: Slot, userId: string | null) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isMine = manager?.id === meId;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div className={`manager-slot${isMine ? ' mine' : ''}${!manager ? ' empty' : ''}`}>
      <div className="manager-slot-head">
        <Icon name={icon} size={20} />
        <div>
          <div className="manager-slot-label">{label}</div>
          <div className="manager-slot-name">
            {manager ? manager.fullName : 'Не назначен'}
            {isMine && <span className="manager-bar-you">(вы)</span>}
          </div>
        </div>
      </div>
      {isAdmin && (
        <div style={{ position: 'relative' }}>
          <motion.button
            className="btn btn-sm btn-secondary"
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            disabled={saving}
            whileTap={{ scale: 0.95 }}
          >
            <Icon name="edit" size={14} />
          </motion.button>
          <AnimatePresence>
            {open && (
              <motion.div
                className="manager-dropdown"
                initial={{ opacity: 0, y: -5, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -5, scale: 0.97 }}
                transition={{ duration: 0.18 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="manager-dropdown-list">
                  {users.map((u) => (
                    <button
                      key={u.id}
                      className={`manager-dropdown-item${u.id === manager?.id ? ' active' : ''}`}
                      onClick={() => { onPick(kind, u.id); setOpen(false); }}
                      disabled={saving}
                    >
                      <Icon name={u.id === manager?.id ? 'radio_button_checked' : 'radio_button_unchecked'} size={18} />
                      <div>
                        <div className="manager-dropdown-name">{u.fullName}</div>
                        <div className="manager-dropdown-role">
                          {ROLE_LABEL[u.role] || '—'}
                        </div>
                      </div>
                    </button>
                  ))}
                  {manager && (
                    <button
                      className="manager-dropdown-item manager-dropdown-clear"
                      onClick={() => { onPick(kind, null); setOpen(false); }}
                      disabled={saving}
                    >
                      <Icon name="person_off" size={18} />
                      Снять менеджера
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export default function ManagerBar({ manager, chinaManager, onReassign }: Props) {
  const me = useAuth((s) => s.user);
  const { toast } = useUI();
  const [users, setUsers] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);

  const isAdmin = isElevated(me);

  useEffect(() => {
    if (isAdmin) listUsers().then(setUsers).catch(() => {});
  }, [isAdmin]);

  const pick = async (kind: Slot, userId: string | null) => {
    setSaving(true);
    try {
      await onReassign(kind === 'local' ? { managerId: userId } : { chinaManagerId: userId });
      toast(kind === 'local' ? 'Локальный менеджер обновлён' : 'Китайский менеджер обновлён', 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка переназначения', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="manager-bar-two">
      <Slot
        kind="local"
        label="Менеджер (Таджикистан)"
        icon="apartment"
        manager={manager}
        isAdmin={isAdmin}
        meId={me?.id}
        users={users}
        onPick={pick}
        saving={saving}
      />
      <Slot
        kind="china"
        label="Менеджер (Китай)"
        icon="flag"
        manager={chinaManager}
        isAdmin={isAdmin}
        meId={me?.id}
        users={users}
        onPick={pick}
        saving={saving}
      />
    </div>
  );
}
