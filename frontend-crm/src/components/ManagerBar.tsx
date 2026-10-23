import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { type ManagerInfo, type User } from '../api/types';
import { displayRoleLabel, isTeacherOnly } from '../lib/roles';
import { listUsers } from '../api/users';
import { useAuth } from '../store/auth';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';

type Slot = 'local' | 'china';

type Props = {
  manager: ManagerInfo | null | undefined;
  chinaManager: ManagerInfo | null | undefined;
  onReassign: (patch: { managerId?: string | null; chinaManagerId?: string | null }) => Promise<void>;
  /** Право менять менеджера (роль — своя галочка); по умолчанию — должность. */
  canAssign?: boolean;
  /**
   * Право отдать клиента, у которого уже есть ДРУГОЙ менеджер («… — передача
   * чужих», lib/permissions canTransferOthers). Без него слот, занятый
   * коллегой, не меняется: свободный и свой — как прежде, по canAssign.
   */
  canTransfer?: boolean;
};

function Slot({
  kind,
  label,
  icon,
  manager,
  isAdmin,
  canTransfer,
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
  canTransfer: boolean;
  meId?: string;
  users: User[];
  onPick: (kind: Slot, userId: string | null) => void;
  saving: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const isMine = manager?.id === meId;
  // Слот, занятый коллегой, без «Передачи чужих» не трогаем (сервер — так же).
  const locked = !!manager && !isMine && !canTransfer;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div className={`client-person${isMine ? ' is-mine' : ''}${!manager ? ' is-empty' : ''}`} data-testid={`manager-${kind}`}>
      <span className="client-person-icon"><Icon name={icon} size={18} /></span>
      <div className="profile-field client-person-main">
        <div className="profile-field-label">{label}</div>
        <div className="profile-field-value">
          {manager ? manager.fullName : t('managerBar.notAssigned')}
          {isMine && <span className="manager-bar-you">{t('common.youLower')}</span>}
        </div>
      </div>
      {isAdmin && locked && (
        <span
          className="client-person-lock"
          title={t('managerBar.locked')}
          aria-label={t('managerBar.locked')}
          data-testid={`manager-${kind}-locked`}
        >
          <Icon name="lock" size={15} />
        </span>
      )}
      {isAdmin && !locked && (
        <div className="client-person-actions">
          <motion.button
            type="button"
            className={`profile-edit-btn is-icon${open ? ' is-active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            disabled={saving}
            whileTap={{ scale: 0.95 }}
            title={`${t('profile.edit')}: ${label}`}
            aria-label={`${t('profile.edit')}: ${label}`}
            aria-expanded={open}
            data-testid={`manager-${kind}-edit`}
          >
            <Icon name="edit" size={15} />
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
                          {displayRoleLabel(u as any)}
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
                      {t('managerBar.remove')}
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

export default function ManagerBar({ manager, chinaManager, onReassign, canAssign, canTransfer }: Props) {
  const me = useAuth((s) => s.user);
  const { toast } = useUI();
  const { t } = useT();
  const [users, setUsers] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);

  // Менять менеджера: страница знает своё право роли (назначение менеджера
  // заявке, лиду или студенту); по умолчанию — руководство по должности.
  const isAdmin = canAssign ?? isElevated(me);
  const transfer = canTransfer ?? isElevated(me);

  useEffect(() => {
    // Учитель академии не ведёт клиентов — в выборе менеджера его нет.
    if (isAdmin) listUsers().then((list) => setUsers(list.filter((u) => !isTeacherOnly(u as any)))).catch(() => {});
  }, [isAdmin]);

  const pick = async (kind: Slot, userId: string | null) => {
    setSaving(true);
    try {
      await onReassign(kind === 'local' ? { managerId: userId } : { chinaManagerId: userId });
      toast(kind === 'local' ? t('managerBar.localUpdated') : t('managerBar.chinaUpdated'), 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('managerBar.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Строки в панели «Менеджеры» карточки клиента (заявка, студент).
  return (
    <div className="client-people">
      <Slot
        kind="local"
        label={t('app.field.manager')}
        icon="apartment"
        manager={manager}
        isAdmin={isAdmin}
        canTransfer={transfer}
        meId={me?.id}
        users={users}
        onPick={pick}
        saving={saving}
      />
      <Slot
        kind="china"
        label={t('app.field.chinaManager')}
        icon="flag"
        manager={chinaManager}
        isAdmin={isAdmin}
        canTransfer={transfer}
        meId={me?.id}
        users={users}
        onPick={pick}
        saving={saving}
      />
    </div>
  );
}
