import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import Icon from '../Icon';
import Loading from '../components/Loading';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { keys } from '../lib/queryKeys';
import { academyCan } from '../lib/permissions';
import {
  createLevel,
  deleteLevel,
  listLevels,
  renameLevel,
  reorderLevels,
  seedDefaultLevels,
  type AcademyLevel,
} from '../api/academy';

/**
 * «Академия → Уровни»: список уровней учеников (Beginner, Elementary…),
 * который ведёт руководство — добавить, переименовать, удалить, поменять
 * порядок. Порядок задаёт «следующий уровень» в окне «Завершить курс».
 * Уровень, который стоит у учеников, удалить нельзя — сервер скажет, у
 * скольких он стоит.
 */
export default function AcademyLevels() {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  // Справочник уровней: руководство академии; роль — «Уровни академии».
  const manager = academyCan(me as any, 'academy:levels');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const query = useQuery({ queryKey: keys.academy.levels(), queryFn: listLevels, enabled: manager });
  const levels = query.data ?? [];

  const done = (list: AcademyLevel[], msg = t('toast.saved')) => {
    qc.setQueryData(keys.academy.levels(), list);
    qc.invalidateQueries({ queryKey: keys.academy.all });
    toast(msg, 'success');
  };
  const fail = (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error');

  const createMut = useMutation({
    mutationFn: () => createLevel(name.trim()),
    onSuccess: (list) => {
      setName('');
      done(list, t('toast.created'));
    },
    onError: fail,
  });
  const renameMut = useMutation({
    mutationFn: (v: { id: string; name: string }) => renameLevel(v.id, v.name.trim()),
    onSuccess: (list) => {
      setEditing(null);
      done(list);
    },
    onError: fail,
  });
  const deleteMut = useMutation({ mutationFn: deleteLevel, onSuccess: (list) => done(list, t('toast.deleted')), onError: fail });
  const reorderMut = useMutation({ mutationFn: reorderLevels, onSuccess: (list) => done(list), onError: fail });
  const seedMut = useMutation({ mutationFn: seedDefaultLevels, onSuccess: (list) => done(list, t('toast.created')), onError: fail });

  if (!manager) {
    return (
      <div className="card" style={{ padding: 28 }}>
        <div className="acad-hint">{t('academy.levels.noAccess')}</div>
      </div>
    );
  }

  const move = (idx: number, delta: number) => {
    const ids = levels.map((l) => l.id);
    const [moved] = ids.splice(idx, 1);
    ids.splice(idx + delta, 0, moved);
    reorderMut.mutate(ids);
  };

  const onDelete = async (l: AcademyLevel) => {
    const ok = await confirm({
      title: t('academy.levels.deleteConfirm'),
      message: l.name,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) deleteMut.mutate(l.id);
  };

  const busy = createMut.isPending || renameMut.isPending || deleteMut.isPending || reorderMut.isPending || seedMut.isPending;

  return (
    <motion.div className="card acad-levels" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} data-testid="academy-levels">
      <div className="acad-levels-head">
        <p className="acad-hint">{t('academy.levels.hint')}</p>
        <form
          className="acad-levels-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMut.mutate();
          }}
        >
          <input
            className="crm-input"
            value={name}
            maxLength={60}
            placeholder={t('academy.levels.namePh')}
            onChange={(e) => setName(e.target.value)}
            data-testid="level-name"
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy} data-testid="level-add">
            <Icon name="add" size={16} /> {t('academy.levels.add')}
          </button>
        </form>
      </div>

      {query.isLoading ? (
        <Loading />
      ) : levels.length === 0 ? (
        <div className="acad-empty" data-testid="levels-empty">
          <Icon name="stairs" size={40} />
          <div>{t('academy.levels.empty')}</div>
          <div className="acad-hint" style={{ maxWidth: 520 }}>{t('academy.levels.seedHint')}</div>
          <button className="btn btn-secondary" onClick={() => seedMut.mutate()} disabled={busy} data-testid="levels-seed">
            <Icon name="auto_fix_high" size={16} /> {t('academy.levels.seed')}
          </button>
        </div>
      ) : (
        <ol className="acad-levels-list" data-testid="levels-list">
          {levels.map((l, i) => (
            <li key={l.id} className="acad-level-row" data-testid={`level-row-${i}`}>
              <span className="acad-level-pos">{i + 1}</span>
              {editing?.id === l.id ? (
                <form
                  className="acad-level-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editing.name.trim()) renameMut.mutate(editing);
                  }}
                >
                  <input
                    className="crm-input"
                    value={editing.name}
                    maxLength={60}
                    autoFocus
                    onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                    onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
                    data-testid="level-edit-input"
                  />
                  <button type="submit" className="btn btn-sm btn-primary" disabled={!editing.name.trim() || busy} data-testid="level-edit-save">
                    {t('common.save')}
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(null)}>
                    {t('common.cancel')}
                  </button>
                </form>
              ) : (
                <>
                  <span className="acad-level-name" data-testid={`level-name-${i}`}>{l.name}</span>
                  <span className="acad-level-count">{t('academy.levels.students').replace('{n}', String(l.students))}</span>
                  <span className="acad-level-actions">
                    <button
                      type="button"
                      className="acad-icon-btn"
                      title={t('academy.levels.up')}
                      aria-label={t('academy.levels.up')}
                      disabled={i === 0 || busy}
                      onClick={() => move(i, -1)}
                      data-testid={`level-up-${i}`}
                    >
                      <Icon name="arrow_upward" size={18} />
                    </button>
                    <button
                      type="button"
                      className="acad-icon-btn"
                      title={t('academy.levels.down')}
                      aria-label={t('academy.levels.down')}
                      disabled={i === levels.length - 1 || busy}
                      onClick={() => move(i, 1)}
                      data-testid={`level-down-${i}`}
                    >
                      <Icon name="arrow_downward" size={18} />
                    </button>
                    <button
                      type="button"
                      className="acad-icon-btn"
                      title={t('academy.levels.rename')}
                      aria-label={t('academy.levels.rename')}
                      disabled={busy}
                      onClick={() => setEditing({ id: l.id, name: l.name })}
                      data-testid={`level-rename-${i}`}
                    >
                      <Icon name="edit" size={18} />
                    </button>
                    <button
                      type="button"
                      className="acad-icon-btn is-danger"
                      title={l.students > 0 ? t('academy.levels.inUse').replace('{n}', String(l.students)) : t('common.delete')}
                      aria-label={t('common.delete')}
                      disabled={busy}
                      onClick={() => onDelete(l)}
                      data-testid={`level-delete-${i}`}
                    >
                      <Icon name="delete" size={18} />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </motion.div>
  );
}
