import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { roleCan } from '../lib/permissions';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { tr, useT } from '../lib/i18n';
import { ruPlural } from '../lib/plural';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import FormModal from '../components/FormModal';
import {
  Pipeline,
  PipelineStage,
  listPipelines,
  createPipeline,
  updatePipeline,
  deletePipeline,
  addStage,
  updateStage,
  deleteStage,
  reorderStages,
} from '../api/sales';

const DEFAULT_STAGE_COLOR = '#94a3b8';
/** Палитра этапов: готовые цвета вместо системного выбора цвета (21.11.2026). */
const STAGE_COLORS = ['#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#94a3b8'];

const errText = (e: any) => {
  const m = e?.response?.data?.message;
  return (Array.isArray(m) ? m.join(', ') : m) || tr('toast.error');
};

export default function Pipelines() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['sales', 'pipelines'], queryFn: listPipelines });
  const pipelines = query.data ?? [];
  const [creatingNew, setCreatingNew] = useState(false);

  // Права роли «Воронки — …»; должность — руководство, как раньше.
  const base = isElevated(me);
  const perms: PipelinePerms = {
    create: roleCan(me, 'pipelines:create', base),
    update: roleCan(me, 'pipelines:update', base),
    remove: roleCan(me, 'pipelines:delete', base),
  };
  if (!roleCan(me, 'pipelines:read', base)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.accessDenied')}</div>;
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['sales', 'pipelines'] });

  const onCreatePipeline = async (data: { name: string; description?: string; isDefault?: boolean }) => {
    try {
      await createPipeline({
        ...data,
        stages: [
          { name: tr('pipelines.default.new'), color: '#3b82f6' },
          { name: tr('pipelines.default.inWork'), color: '#f59e0b' },
          { name: tr('pipelines.default.closed'), color: '#10b981', isClosingStage: true },
        ],
      });
      await invalidate();
      toast(t('toast.created'), 'success');
      setCreatingNew(false);
    } catch (e: any) {
      toast(errText(e), 'error');
    }
  };

  // Действия воронки: ошибка сервера — тостом (раньше «по умолчанию» и
  // «отключить» молчали при отказе).
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await invalidate();
      if (ok) toast(ok, 'success');
    } catch (e: any) {
      toast(errText(e), 'error');
    }
  };

  const onDeletePipeline = async (p: Pipeline) => {
    const ok = await confirm({
      title: t('pipelines.confirm.delete'),
      message: `«${p.name}»`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    await run(() => deletePipeline(p.id), t('toast.deleted'));
  };

  return (
    <>
      <motion.div
        className="card pl-intro"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <p className="pl-intro-text">{t('pipelines.intro')}</p>
        {perms.create && (
          <button className="btn btn-primary" data-testid="pipeline-new" onClick={() => setCreatingNew(true)}>
            <Icon name="add" size={16} /> {t('pipelines.new')}
          </button>
        )}
      </motion.div>

      {creatingNew && (
        <FormModal open title={t('pipelines.new')} onClose={() => setCreatingNew(false)} testId="pipeline-form">
          <CreateForm onCancel={() => setCreatingNew(false)} onCreate={onCreatePipeline} />
        </FormModal>
      )}

      <div className="pl-list">
        {pipelines.map((p) => (
          <PipelineCard
            key={p.id}
            pipeline={p}
            perms={perms}
            onToggleDefault={() => run(() => updatePipeline(p.id, { isDefault: !p.isDefault }))}
            onToggleActive={() => run(() => updatePipeline(p.id, { isActive: !p.isActive }))}
            onDelete={() => onDeletePipeline(p)}
            onChanged={invalidate}
          />
        ))}
        {query.isLoading && <div className="card pl-empty">{t('common.loading')}</div>}
        {!query.isLoading && pipelines.length === 0 && (
          <div className="card pl-empty">{t('pipelines.empty')}</div>
        )}
      </div>
    </>
  );
}

function CreateForm({
  onCreate,
  onCancel,
}: {
  onCreate: (d: { name: string; description?: string; isDefault?: boolean }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  return (
    <div>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label>{t('pipelines.field.name')}</label>
        <input className="crm-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="pipeline-name" />
      </div>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label>{t('pipelines.field.description')}</label>
        <input className="crm-input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <label className="crm-checkbox-label" style={{ marginBottom: 14 }}>
        <input type="checkbox" className="crm-checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        {t('pipelines.makeDefaultHint')}
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={() => onCreate({ name: name.trim(), description: description.trim() || undefined, isDefault })}
          disabled={!name.trim()}
          data-testid="pipeline-create"
        >
          {t('pipelines.createWithStages')}
        </button>
      </div>
    </div>
  );
}

type PipelinePerms = { create: boolean; update: boolean; remove: boolean };

/**
 * Выпадающее меню «⋯»: рисуется поверх страницы (портал), прижимается к
 * краям экрана и открывается вверх, если внизу нет места, — у плитки в левой
 * колонке на телефоне оно не уезжает за край. Закрывается кликом мимо, Esc,
 * прокруткой и сменой размера окна.
 */
function MenuButton({ label, testId, children, align = 'right' }: {
  label: string;
  testId: string;
  /** close — закрыть меню после выбора пункта. */
  children: (close: () => void) => ReactNode;
  align?: 'right' | 'left';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = () => { setOpen(false); setPos(null); };
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const w = menuRef.current?.offsetWidth ?? 220;
    const h = menuRef.current?.offsetHeight ?? 200;
    let left = align === 'right' ? b.right - w : b.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = b.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, b.top - h - 4);
    setPos({ top, left });
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onMove = () => close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);
  return (
    <div className="pl-menu-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`pl-icon-btn${open ? ' is-open' : ''}`}
        onClick={(e) => { e.stopPropagation(); if (open) close(); else setOpen(true); }}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        draggable={false}
      >
        <Icon name="more_horiz" size={20} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="pl-menu"
          role="menu"
          data-testid={`${testId}-list`}
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          {children(close)}
        </div>,
        document.body,
      )}
    </div>
  );
}

function PipelineCard({
  pipeline,
  perms,
  onToggleDefault,
  onToggleActive,
  onDelete,
  onChanged,
}: {
  pipeline: Pipeline;
  perms: PipelinePerms;
  onToggleDefault: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [newStageName, setNewStageName] = useState('');
  const [busy, setBusy] = useState(false);
  // Порядок на время перетаскивания и сохранения (до ответа сервера).
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  // Последний порядок во время перетаскивания — для dragend (без устаревшего замыкания).
  const orderRef = useRef<string[] | null>(null);

  const byId = useMemo(() => new Map(pipeline.stages.map((s) => [s.id, s])), [pipeline.stages]);
  const stages = localOrder
    ? localOrder.map((id) => byId.get(id)).filter((s): s is PipelineStage => !!s)
    : pipeline.stages;
  const serverIds = pipeline.stages.map((s) => s.id).join(',');

  // QA-3 (BUG-15): отказ сервера («…HTML-теги», дубль названия) показываем.
  const onAddStage = async () => {
    const name = newStageName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await addStage(pipeline.id, { name, color: DEFAULT_STAGE_COLOR });
      await onChanged();
      setNewStageName('');
      setAdding(false);
    } catch (e: any) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteStage = async (s: PipelineStage) => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: `«${s.name}»`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteStage(s.id);
      await onChanged();
    } catch (e: any) {
      toast(errText(e), 'error');
    }
  };
  /** Единственный финальный этап не удаляется и не «разфинальнивается» (так же отвечает сервер). */
  const finalCount = pipeline.stages.filter((x) => x.isClosingStage).length;
  const canDeleteStage = (s: PipelineStage) => pipeline.stages.length > 1 && !(s.isClosingStage && finalCount <= 1);

  const onPatchStage = async (s: PipelineStage, patch: Partial<PipelineStage>) => {
    try {
      await updateStage(s.id, patch);
      await onChanged();
      return true;
    } catch (e: any) {
      toast(errText(e), 'error');
      return false;
    }
  };

  const saveOrder = async (ids: string[]) => {
    if (ids.join(',') === serverIds) { setLocalOrder(null); return; }
    setLocalOrder(ids);
    try {
      await reorderStages(pipeline.id, ids);
      await onChanged();
    } catch (e: any) {
      toast(errText(e), 'error');
    } finally {
      setLocalOrder(null);
    }
  };

  const moveBy = (id: string, dir: -1 | 1) => {
    const ids = stages.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void saveOrder(ids);
  };

  // Перетаскивание (мышь): плитка едет на место той, над которой её держат.
  const onDragStart = (e: React.DragEvent, id: string) => {
    dragging.current = id;
    setDragId(id);
    orderRef.current = stages.map((s) => s.id);
    setLocalOrder(orderRef.current);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const onDragOver = (e: React.DragEvent, overId: string) => {
    const from = dragging.current;
    if (!from) return;
    e.preventDefault();
    if (from === overId) return;
    const ids = [...(orderRef.current ?? stages.map((s) => s.id))];
    const a = ids.indexOf(from);
    const b = ids.indexOf(overId);
    if (a < 0 || b < 0 || a === b) return;
    ids.splice(a, 1);
    ids.splice(b, 0, from);
    orderRef.current = ids;
    setLocalOrder(ids);
  };
  const onDragEnd = () => {
    const ids = orderRef.current;
    orderRef.current = null;
    dragging.current = null;
    setDragId(null);
    if (ids) void saveOrder(ids);
  };

  const badge = pipeline.isDefault ? `★ ${t('pipelines.badge.default')}` : t('pipelines.badge.pipeline');
  const mine = pipeline.leadScope === 'own';
  const leadsText = (n: number) => {
    const key = mine
      ? ruPlural(n, 'pipelines.stage.mine1', 'pipelines.stage.mine2', 'pipelines.stage.mine5')
      : ruPlural(n, 'pipelines.stage.leads1', 'pipelines.stage.leads2', 'pipelines.stage.leads5');
    return t(key).replace('{n}', String(n));
  };
  const hasPipelineMenu = perms.update || perms.remove;

  return (
    <motion.div
      className={`card pl-card${pipeline.isActive ? '' : ' is-off'}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      data-testid={`pipeline-${pipeline.id}`}
    >
      <div className="pl-head">
        <div className="pl-head-main">
          <div className="pl-badges">
            <span className={`pl-badge${pipeline.isDefault ? ' is-default' : ''}`}>{badge}</span>
            {!pipeline.isActive && <span className="pl-badge is-off">{t('pipelines.badge.inactive')}</span>}
          </div>
          <h3 className="pl-name">{pipeline.name}</h3>
          {pipeline.description && <div className="pl-desc">{pipeline.description}</div>}
        </div>
        {hasPipelineMenu && (
          <MenuButton label={t('pipelines.menu')} testId="pipeline-menu">
            {(close) => (
              <>
                {perms.update && (pipeline.isActive || pipeline.isDefault) && (
                  // Неактивную воронку основной не сделать (QA №36).
                  <button type="button" role="menuitem" onClick={() => { close(); onToggleDefault(); }} data-testid="pipeline-default">
                    <Icon name={pipeline.isDefault ? 'star_outline' : 'star'} size={17} />
                    {pipeline.isDefault ? t('pipelines.unsetDefault') : t('pipelines.setDefault')}
                  </button>
                )}
                {perms.update && (
                  <button type="button" role="menuitem" onClick={() => { close(); onToggleActive(); }} data-testid="pipeline-active">
                    <Icon name={pipeline.isActive ? 'pause_circle' : 'play_circle'} size={17} />
                    {pipeline.isActive ? t('settings.penalties.disable') : t('settings.penalties.enable')}
                  </button>
                )}
                {perms.remove && (
                  <button type="button" role="menuitem" className="is-danger" onClick={() => { close(); onDelete(); }} data-testid="pipeline-delete">
                    <Icon name="delete" size={17} /> {t('common.delete')}
                  </button>
                )}
              </>
            )}
          </MenuButton>
        )}
      </div>

      <div className="pl-stages" data-testid="pipeline-stages">
        {stages.map((s, i) => (
          <StageTile
            key={s.id}
            stage={s}
            perms={perms}
            leadsText={s.leadCount != null ? leadsText(s.leadCount) : null}
            dragging={dragId === s.id}
            canLeft={i > 0}
            canRight={i < stages.length - 1}
            onMoveLeft={() => moveBy(s.id, -1)}
            onMoveRight={() => moveBy(s.id, 1)}
            deletable={canDeleteStage(s)}
            canUnfinal={finalCount > 1}
            onDelete={() => onDeleteStage(s)}
            onPatch={(patch) => onPatchStage(s, patch)}
            onDragStart={(e) => onDragStart(e, s.id)}
            onDragOver={(e) => onDragOver(e, s.id)}
            onDragEnd={onDragEnd}
          />
        ))}
        {perms.create && (adding ? (
          <div className="pl-add-form" data-testid="stage-add-form">
            <input
              className="crm-input"
              value={newStageName}
              onChange={(e) => setNewStageName(e.target.value)}
              placeholder={t('pipelines.stage.name')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onAddStage();
                if (e.key === 'Escape') { setAdding(false); setNewStageName(''); }
              }}
              autoFocus
              data-testid="stage-add-input"
            />
            <div className="pl-add-actions">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setAdding(false); setNewStageName(''); }}>{t('common.cancel')}</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void onAddStage()} disabled={!newStageName.trim() || busy} data-testid="stage-add-save">
                {t('common.add')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="pl-add" onClick={() => setAdding(true)} data-testid="stage-add">
            <Icon name="add" size={18} /> {t('pipelines.stage.addTile')}
          </button>
        ))}
      </div>
      {perms.update && stages.length > 1 && <div className="pl-hint">{t('pipelines.stage.dragHint')}</div>}
    </motion.div>
  );
}

function StageTile({
  stage,
  perms,
  leadsText,
  dragging,
  canLeft,
  canRight,
  onMoveLeft,
  onMoveRight,
  deletable,
  canUnfinal,
  onDelete,
  onPatch,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  stage: PipelineStage;
  perms: PipelinePerms;
  leadsText: string | null;
  dragging: boolean;
  canLeft: boolean;
  canRight: boolean;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  /** false — удалить нельзя (единственный финальный этап или последний этап воронки). */
  deletable: boolean;
  /** Можно снять «финальный» (финальных этапов больше одного). */
  canUnfinal: boolean;
  onDelete: () => void;
  onPatch: (patch: Partial<PipelineStage>) => Promise<boolean>;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t } = useT();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(stage.name);
  const color = stage.color || DEFAULT_STAGE_COLOR;
  const canDrag = perms.update && !renaming;
  const hasMenu = perms.update || (perms.remove && deletable);

  const saveName = async () => {
    const v = name.trim();
    if (!v || v === stage.name) { setRenaming(false); setName(stage.name); return; }
    if (await onPatch({ name: v })) setRenaming(false);
  };

  return (
    <div
      className={`pl-stage${dragging ? ' is-dragging' : ''}${canDrag ? ' is-draggable' : ''}`}
      style={{ ['--stage-color' as any]: color }}
      draggable={canDrag}
      onDragStart={canDrag ? onDragStart : undefined}
      onDragOver={perms.update ? onDragOver : undefined}
      onDrop={perms.update ? (e) => e.preventDefault() : undefined}
      onDragEnd={canDrag ? onDragEnd : undefined}
      data-testid="stage-tile"
      data-stage-id={stage.id}
    >
      <div className="pl-stage-top">
        {canDrag && <span className="pl-stage-handle" aria-hidden="true"><Icon name="drag_indicator" size={18} /></span>}
        {renaming ? (
          <input
            className="crm-input pl-stage-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName();
              if (e.key === 'Escape') { setRenaming(false); setName(stage.name); }
            }}
            onBlur={() => void saveName()}
            autoFocus
            data-testid="stage-rename-input"
          />
        ) : (
          <span className="pl-stage-name" data-testid="stage-name">{stage.name}</span>
        )}
        {hasMenu && !renaming && (
          <MenuButton label={t('pipelines.stage.menu')} testId="stage-menu">
            {(close) => (
              <>
                {perms.update && (
                  <button type="button" role="menuitem" onClick={() => { close(); setName(stage.name); setRenaming(true); }} data-testid="stage-rename">
                    <Icon name="edit" size={17} /> {t('pipelines.stage.rename')}
                  </button>
                )}
                {perms.update && (
                  <div className="pl-menu-colors" role="group" aria-label={t('pipelines.stage.color')}>
                    <span className="pl-menu-label">{t('pipelines.stage.color')}</span>
                    <div className="pl-colors">
                      {STAGE_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`pl-color${c.toLowerCase() === color.toLowerCase() ? ' is-active' : ''}`}
                          style={{ background: c }}
                          onClick={() => { close(); if (c !== color) void onPatch({ color: c }); }}
                          aria-label={c}
                          data-testid={`stage-color-${c.slice(1)}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {perms.update && (canLeft || canRight) && (
                  <>
                    {canLeft && (
                      <button type="button" role="menuitem" onClick={() => { close(); onMoveLeft(); }} data-testid="stage-left">
                        <Icon name="arrow_back" size={17} /> {t('pipelines.stage.moveLeft')}
                      </button>
                    )}
                    {canRight && (
                      <button type="button" role="menuitem" onClick={() => { close(); onMoveRight(); }} data-testid="stage-right">
                        <Icon name="arrow_forward" size={17} /> {t('pipelines.stage.moveRight')}
                      </button>
                    )}
                  </>
                )}
                {perms.update && !stage.isClosingStage && (
                  <button type="button" role="menuitem" onClick={() => { close(); void onPatch({ isClosingStage: true }); }} data-testid="stage-final">
                    <Icon name="flag" size={17} /> {t('pipelines.stage.makeFinal')}
                  </button>
                )}
                {perms.update && stage.isClosingStage && canUnfinal && (
                  <button type="button" role="menuitem" onClick={() => { close(); void onPatch({ isClosingStage: false }); }} data-testid="stage-unfinal">
                    <Icon name="outlined_flag" size={17} /> {t('pipelines.stage.unmakeFinal')}
                  </button>
                )}
                {perms.remove && deletable && (
                  <button type="button" role="menuitem" className="is-danger" onClick={() => { close(); onDelete(); }} data-testid="stage-delete">
                    <Icon name="delete" size={17} /> {t('common.delete')}
                  </button>
                )}
              </>
            )}
          </MenuButton>
        )}
      </div>
      {leadsText && <div className="pl-stage-count" data-testid="stage-count">{leadsText}</div>}
      {stage.isClosingStage && (
        <span className="pl-final" title={tr('pipelines.finalStage')}><Icon name="check_circle" size={14} /> {t('pipelines.stage.final')}</span>
      )}
    </div>
  );
}
