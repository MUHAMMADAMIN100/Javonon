import type { ReactNode } from 'react';
import { useT } from '../lib/i18n';

/**
 * Подпись кнопки на время сохранения (макет: «кнопка не меняет ширину, внутри
 * крутилка»). Раньше подпись менялась на «Сохраняем…» — кнопка прыгала по
 * ширине, соседние кнопки сдвигались под курсором. Теперь текст остаётся на
 * месте (невидимым — он и держит ширину), поверх — крутилка; для экранного
 * чтения — «Сохраняем…». «Сохранено» показывает уведомление после ответа.
 */
export default function BusyLabel({ busy, children, busyText }: { busy: boolean; children: ReactNode; busyText?: string }) {
  const { t } = useT();
  return (
    <span className={`busy-label${busy ? ' is-busy' : ''}`} aria-busy={busy || undefined}>
      <span className="busy-label-text">{children}</span>
      {busy && (
        <>
          <span className="busy-label-spin" aria-hidden="true" />
          <span className="sr-only">{busyText ?? t('common.saving')}</span>
        </>
      )}
    </span>
  );
}
