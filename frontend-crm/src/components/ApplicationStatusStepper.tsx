import { useState } from 'react';
import {
  APPLICATION_STAGES,
  STAGE_INDEX,
  STATUS_LABEL,
  STATUS_SHORT,
  type Application,
  type ApplicationStatus,
} from '../api/types';
import { updateApplication } from '../api/applications';
import { useUI } from '../ui/Dialogs';
import Icon from '../Icon';
import { useT } from '../lib/i18n';
import { useApplicationStatusLabel } from '../lib/labels';

type Props = {
  application: Application;
  canEdit: boolean;
  onChanged?: () => void;
};

export default function ApplicationStatusStepper({ application, canEdit, onChanged }: Props) {
  const { toast } = useUI();
  const { t } = useT();
  const statusLabel = useApplicationStatusLabel();
  const [saving, setSaving] = useState(false);

  const currentIdx = STAGE_INDEX[application.status] ?? 0;
  const nextStage = APPLICATION_STAGES[currentIdx + 1];
  const prevStage = currentIdx > 0 ? APPLICATION_STAGES[currentIdx - 1] : null;

  const change = async (next: ApplicationStatus) => {
    if (!canEdit || saving || next === application.status) return;
    setSaving(true);
    try {
      await updateApplication(application.id, { status: next });
      toast(`${t('common.status')} → «${statusLabel(next)}»`, 'success');
      onChanged?.();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stage-bar">
      <div className="stage-bar-track">
        {APPLICATION_STAGES.map((stage, i) => {
          const done = i < currentIdx;
          const current = i === currentIdx;
          return (
            <div
              key={stage}
              className={`stage-step${done ? ' done' : ''}${current ? ' current' : ''}`}
              onClick={() => canEdit && !saving && change(stage)}
              style={canEdit ? { cursor: 'pointer' } : undefined}
              title={statusLabel(stage)}
            >
              <div className="stage-dot">
                {done ? <Icon name="check" size={16} /> : <span>{i + 1}</span>}
              </div>
              <div className="stage-label">{t(`app.short.${stage}`) !== `app.short.${stage}` ? t(`app.short.${stage}`) : STATUS_SHORT[stage]}</div>
              {i < APPLICATION_STAGES.length - 1 && <div className="stage-connector" />}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div className="stage-actions">
          {prevStage && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => change(prevStage)}
              disabled={saving}
              title={t('common.back')}
            >
              <Icon name="arrow_back" size={16} style={{ marginRight: 4 }} />
              {t('common.back')}
            </button>
          )}
          {nextStage && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => change(nextStage)}
              disabled={saving}
              title={statusLabel(nextStage)}
            >
              {statusLabel(nextStage)}
              <Icon name="arrow_forward" size={16} style={{ marginLeft: 4 }} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
