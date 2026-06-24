import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
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
} from '../api/sales';

const DEFAULT_STAGE_COLOR = '#94a3b8';

export default function Pipelines() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['sales', 'pipelines'], queryFn: listPipelines });
  const pipelines = query.data ?? [];
  const [creatingNew, setCreatingNew] = useState(false);

  if (!isElevated(me)) {
    return <div className="card" style={{ padding: 28 }}>{t('common.accessDenied')}</div>;
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['sales', 'pipelines'] });

  const onCreatePipeline = async (data: { name: string; description?: string; isDefault?: boolean }) => {
    try {
      await createPipeline({
        ...data,
        stages: [
          { name: 'Новый лид', color: '#3b82f6' },
          { name: 'В работе', color: '#f59e0b' },
          { name: 'Закрыт', color: '#10b981', isClosingStage: true },
        ],
      });
      invalidate();
      toast(t('toast.created'), 'success');
      setCreatingNew(false);
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
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
    await deletePipeline(p.id);
    invalidate();
  };

  const onTogglePipelineDefault = async (p: Pipeline) => {
    await updatePipeline(p.id, { isDefault: !p.isDefault });
    invalidate();
  };

  const onTogglePipelineActive = async (p: Pipeline) => {
    await updatePipeline(p.id, { isActive: !p.isActive });
    invalidate();
  };

  return (
    <>
      <div className="crm-section-head">
        <span className="crm-section-eyebrow">SALES · PIPELINES</span>
        <h2 className="crm-section-title">{t('pipelines.title')}</h2>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 22, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: 'var(--text-soft)', fontSize: 13, margin: 0, maxWidth: 600 }}>
            Кастомизируемые воронки продаж. Дефолтная (одна) — куда попадают новые лиды
            без явного выбора. Каждая воронка содержит этапы со своим порядком и цветом.
          </p>
          {!creatingNew && (
            <button className="btn btn-primary" onClick={() => setCreatingNew(true)}>
              <Icon name="add" size={16} /> {t('pipelines.new')}
            </button>
          )}
        </div>

        {creatingNew && (
          <CreateForm
            onCancel={() => setCreatingNew(false)}
            onCreate={onCreatePipeline}
          />
        )}
      </motion.div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {pipelines.map((p) => (
          <PipelineCard
            key={p.id}
            pipeline={p}
            onToggleDefault={() => onTogglePipelineDefault(p)}
            onToggleActive={() => onTogglePipelineActive(p)}
            onDelete={() => onDeletePipeline(p)}
            onChanged={invalidate}
          />
        ))}
        {pipelines.length === 0 && !creatingNew && (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-soft)' }}>
            {t('pipelines.empty')}
          </div>
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
    <div style={{
      marginTop: 16,
      padding: 16,
      background: 'var(--bg-soft)',
      border: '1px solid var(--border-soft)',
      borderRadius: 12,
    }}>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label>{t('pipelines.field.name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label>{t('pipelines.field.description')}</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Сделать воронкой по умолчанию (в неё попадают новые лиды)
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>Отмена</button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => onCreate({ name: name.trim(), description: description.trim() || undefined, isDefault })}
          disabled={!name.trim()}
        >
          Создать (с 3 базовыми этапами)
        </button>
      </div>
    </div>
  );
}

function PipelineCard({
  pipeline,
  onToggleDefault,
  onToggleActive,
  onDelete,
  onChanged,
}: {
  pipeline: Pipeline;
  onToggleDefault: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const [newStageName, setNewStageName] = useState('');

  const onAddStage = async () => {
    if (!newStageName.trim()) return;
    await addStage(pipeline.id, { name: newStageName.trim(), color: DEFAULT_STAGE_COLOR });
    setNewStageName('');
    onChanged();
  };

  const onDeleteStage = async (s: PipelineStage) => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: `«${s.name}»`,
      danger: true,
    });
    if (!ok) return;
    await deleteStage(s.id);
    onChanged();
  };

  const onPatchStage = async (s: PipelineStage, patch: Partial<PipelineStage>) => {
    try {
      await updateStage(s.id, patch);
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    }
  };

  const moveStage = (idx: number, dir: -1 | 1) => {
    const target = pipeline.stages[idx + dir];
    if (!target) return;
    const cur = pipeline.stages[idx];
    // Меняем местами order (через Promise.all, потом invalidate).
    Promise.all([
      updateStage(cur.id, { order: target.order }),
      updateStage(target.id, { order: cur.order }),
    ]).then(onChanged);
  };

  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: 22, opacity: pipeline.isActive ? 1 : 0.6 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            color: 'var(--primary-dark)',
            marginBottom: 4,
          }}>
            {pipeline.isDefault ? '★ DEFAULT' : 'PIPELINE'}
            {!pipeline.isActive && ' · INACTIVE'}
          </div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, margin: 0 }}>
            {pipeline.name}
          </h3>
          {pipeline.description && (
            <div style={{ color: 'var(--text-soft)', fontSize: 13, marginTop: 4 }}>{pipeline.description}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={onToggleDefault}>
            {pipeline.isDefault ? 'Снять default' : 'Сделать default'}
          </button>
          <button className="btn btn-sm btn-secondary" onClick={onToggleActive}>
            {pipeline.isActive ? t('settings.penalties.disable') : t('settings.penalties.enable')}
          </button>
          <button className="btn btn-sm btn-danger" onClick={onDelete}>{t('common.delete')}</button>
        </div>
      </div>

      {/* Этапы — горизонтальный flow */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {pipeline.stages.map((s, i) => (
          <StageChip
            key={s.id}
            stage={s}
            canMoveUp={i > 0}
            canMoveDown={i < pipeline.stages.length - 1}
            onMoveUp={() => moveStage(i, -1)}
            onMoveDown={() => moveStage(i, 1)}
            onDelete={() => onDeleteStage(s)}
            onChange={(patch) => onPatchStage(s, patch)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={newStageName}
          onChange={(e) => setNewStageName(e.target.value)}
          placeholder={t('pipelines.stage.name')}
          onKeyDown={(e) => e.key === 'Enter' && onAddStage()}
          style={{ flex: 1 }}
        />
        <button className="btn btn-sm btn-secondary" onClick={onAddStage} disabled={!newStageName.trim()}>
          {t('pipelines.stage.add')}
        </button>
      </div>
    </motion.div>
  );
}

function StageChip({
  stage,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
  onChange,
}: {
  stage: PipelineStage;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onChange: (patch: Partial<PipelineStage>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color || DEFAULT_STAGE_COLOR);

  const save = () => {
    onChange({ name: name.trim(), color });
    setEditing(false);
  };

  if (editing) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: 6,
        background: 'var(--bg-soft)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 32, height: 28, border: 'none', background: 'transparent' }} />
        <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 140, padding: '4px 8px' }} />
        <button className="btn btn-sm btn-primary" onClick={save}>OK</button>
        <button className="btn btn-sm btn-secondary" onClick={() => setEditing(false)}>X</button>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '6px 10px',
      borderRadius: 999,
      background: stage.color ? `${stage.color}20` : 'var(--bg-soft)',
      border: `1.5px solid ${stage.color || 'var(--border)'}`,
      color: 'var(--text)',
      fontSize: 13,
      fontWeight: 500,
    }}>
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: 4,
        background: stage.color || DEFAULT_STAGE_COLOR,
      }} />
      <span>{stage.name}</span>
      {stage.isClosingStage && <span title="Финальный этап (зачислен)">✓</span>}
      <button title="Вверх" onClick={onMoveUp} disabled={!canMoveUp} style={btnIcon}>‹</button>
      <button title="Вниз" onClick={onMoveDown} disabled={!canMoveDown} style={btnIcon}>›</button>
      <button title="Изменить" onClick={() => setEditing(true)} style={btnIcon}>✎</button>
      <button title="✕" onClick={onDelete} style={{ ...btnIcon, color: 'var(--danger)' }}>×</button>
    </div>
  );
}

const btnIcon: React.CSSProperties = {
  width: 20, height: 20,
  border: 'none', background: 'transparent', cursor: 'pointer',
  fontSize: 14, color: 'var(--text-soft)',
  padding: 0, lineHeight: 1,
};
