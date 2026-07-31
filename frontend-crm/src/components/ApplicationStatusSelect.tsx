import { useState } from 'react';
import {
  APPLICATION_STATUSES,
  STATUS_BADGE,
  isClientNotifiedApplicationStatus,
  isLegacyApplicationStatus,
  type Application,
  type ApplicationStatus,
} from '../api/types';
import { updateApplication } from '../api/applications';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { useApplicationStatusLabel } from '../lib/labels';

/**
 * Редактор статуса заявки.
 *
 * Раньше здесь был степпер с кнопками «назад/вперёд» по упорядоченной воронке
 * (компонент назывался ApplicationStatusStepper). Новые статусы — это исходы
 * квалификации лида, а не этапы: «Вне города» и «До 17 лет» не следуют за
 * «Онлайн консультацией» и не предшествуют ей. Линейная навигация по ним
 * бессмысленна, поэтому UI — обычный выпадающий список.
 *
 * Legacy-статус (заявка ещё не мигрирована) показываем выбранным, но
 * disabled: менеджер видит настоящее текущее состояние заявки и может
 * перевести её только в новую схему, вернуться к старому значению — нет.
 *
 * Под селектом — строка «уйдёт клиенту SMS или нет». Раньше подсказки не было,
 * потому что и вопроса не было: бэкенд писал клиенту на ЛЮБУЮ смену статуса.
 * Теперь половина набора — внутренняя квалификация лида («Думает»,
 * «Некачественные лиды»), и по ней бэкенд молчит. Менеджер обязан видеть эту
 * разницу: иначе он либо решит, что клиент уже предупреждён, либо побоится
 * ставить честный статус, думая, что человеку прилетит «Некачественный лид».
 */

type Props = {
  application: Application;
  canEdit: boolean;
  onChanged?: () => void;
};

export default function ApplicationStatusSelect({ application, canEdit, onChanged }: Props) {
  const { toast } = useUI();
  const { t } = useT();
  const statusLabel = useApplicationStatusLabel();
  const [saving, setSaving] = useState(false);

  const current = application.status;
  const isLegacy = isLegacyApplicationStatus(current);

  const change = async (next: ApplicationStatus) => {
    if (!canEdit || saving || next === current) return;
    setSaving(true);
    try {
      // SMS клиенту шлёт бэкенд в updateApplication — и только по клиентским
      // статусам (isClientNotifiedApplicationStatus). Здесь ничего
      // дублировать не нужно и отменить отправку отсюда нельзя.
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
    <div className="app-stepper">
      <div className="app-stepper-head">
        <div>
          <div className="app-stepper-title">{t('app.field.status')}</div>
          <div className="app-stepper-current">
            <span className={`badge ${STATUS_BADGE[current] || 'badge-gray'}`}>
              {statusLabel(current)}
            </span>
          </div>
        </div>
        {canEdit && (
          <select
            className="app-stepper-select"
            value={current}
            disabled={saving}
            onChange={(e) => change(e.target.value as ApplicationStatus)}
            title={t('app.field.status')}
          >
            {/* Заявка до миграции: её статуса нет в списке предлагаемых,
                но выбранным значением он обязан отображаться. */}
            {isLegacy && (
              <option value={current} disabled>
                {statusLabel(current)}
              </option>
            )}
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 6 }}>
        {isClientNotifiedApplicationStatus(current)
          ? t('app.status.smsSent')
          : t('app.status.smsSilent')}
      </div>
      {saving && (
        <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('common.saving')}</div>
      )}
    </div>
  );
}
