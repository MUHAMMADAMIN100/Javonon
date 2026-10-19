import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '../../lib/i18n';
import { useUI } from '../../ui/Dialogs';
import { keys } from '../../lib/queryKeys';
import { deleteGroup, getGroupRemoval, updateGroup, type GroupRemoval } from '../../api/studyGroups';

/**
 * «Удалить группу» — из списка групп и из вкладки «Настройки». Сначала
 * сервер говорит, что будет с группой (GET /study-groups/:id/removal), и
 * окно называет это цифрами:
 *   • удалить можно — сколько занятий и файлов уйдёт, сколько учеников
 *     останется без группы → «Удалить»;
 *   • есть оценки или дневник ДЗ — удалить нельзя, журнал пропал бы
 *     вместе с группой → «В архив»;
 *   • такая группа уже в архиве — только объяснение.
 * busyId — группа, по которой идёт запрос (кнопка ждёт).
 */
export function useGroupRemoval({
  onDeleted,
  onArchived,
}: { onDeleted?: (groupId: string) => void; onArchived?: (groupId: string) => void } = {}) {
  const { t } = useT();
  const { confirm, toast } = useUI();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const fail = (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.groups.all });
    qc.invalidateQueries({ queryKey: keys.academy.all });
  };

  const remove = async (groupId: string) => {
    if (busyId) return;
    setBusyId(groupId);
    let r: GroupRemoval;
    try {
      r = await getGroupRemoval(groupId);
    } catch (e) {
      fail(e);
      return;
    } finally {
      setBusyId(null);
    }

    if (r.canDelete) {
      const ok = await confirm({
        title: t('groups.remove.title').replace('{name}', r.name),
        message: deleteMessage(r, t),
        danger: true,
        confirmText: t('common.delete'),
      });
      if (!ok) return;
      setBusyId(groupId);
      try {
        await deleteGroup(groupId);
        toast(t('groups.remove.deleted').replace('{name}', r.name), 'success');
        // Карточка группы уходит со страницы раньше, чем список перечитается:
        // иначе она успела бы показать «Группа не найдена».
        onDeleted?.(groupId);
        qc.removeQueries({ queryKey: keys.groups.one(groupId) });
        refresh();
      } catch (e) {
        fail(e);
      } finally {
        setBusyId(null);
      }
      return;
    }

    const archived = r.status === 'ARCHIVED';
    const reasons: string[] = [];
    if (r.marks > 0) reasons.push(t('groups.remove.marks').replace('{n}', String(r.marks)));
    if (r.diary > 0) reasons.push(t('groups.remove.diary').replace('{n}', String(r.diary)));
    reasons.push(t(archived ? 'groups.remove.alreadyArchived' : 'groups.remove.archiveHint'));
    const ok = await confirm({
      title: t('groups.remove.blockedTitle').replace('{name}', r.name),
      message: reasons.join(' '),
      confirmText: t(archived ? 'groups.remove.gotIt' : 'groups.remove.toArchive'),
      hideCancel: archived,
      icon: archived ? 'info' : 'inventory_2',
    });
    if (!ok || archived) return;
    setBusyId(groupId);
    try {
      await updateGroup(groupId, { status: 'ARCHIVED' });
      toast(t('groups.remove.archived').replace('{name}', r.name), 'success');
      onArchived?.(groupId);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusyId(null);
    }
  };

  return { remove, busyId };
}

function deleteMessage(r: GroupRemoval, t: (key: string) => string) {
  const parts = [
    r.sessions === 0
      ? t('groups.remove.noSessions')
      : r.materials > 0
        ? t('groups.remove.sessionsFiles').replace('{n}', String(r.sessions)).replace('{m}', String(r.materials))
        : t('groups.remove.sessions').replace('{n}', String(r.sessions)),
  ];
  if (r.members > 0) parts.push(t('groups.remove.members').replace('{n}', String(r.members)));
  parts.push(t('groups.remove.final'));
  return parts.join(' ');
}
