import { useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

/**
 * Понятный экран вместо вечной «Загрузки» (QA-2): нет доступа (403), нет
 * записи (404) или не удалось загрузить (сеть, 5xx) — с кнопкой, что делать.
 * kind='notFound' без ошибки — страница 404 для неизвестного адреса.
 */
export default function QueryErrorState({
  error,
  kind,
  backTo = '/dashboard',
  backLabelKey = 'errorState.toHome',
  onRetry,
}: {
  error?: unknown;
  kind?: 'denied' | 'notFound' | 'failed';
  backTo?: string;
  backLabelKey?: string;
  onRetry?: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const status = (error as any)?.response?.status as number | undefined;
  const k = kind ?? (status === 403 ? 'denied' : status === 404 ? 'notFound' : 'failed');
  const icon = k === 'denied' ? 'lock' : k === 'notFound' ? 'search_off' : 'wifi_off';
  return (
    <div className={`err-state is-${k}`} role="alert" data-testid={`err-state-${k}`}>
      <span className="err-state-icon" aria-hidden="true"><Icon name={icon} size={28} /></span>
      {k === 'notFound' && !error && <span className="err-state-code">404</span>}
      <h2 className="err-state-title">{t(`errorState.${k}.title`)}</h2>
      <p className="err-state-text">{t(`errorState.${k}.text`)}</p>
      <div className="err-state-actions">
        {k === 'failed' && onRetry && (
          <button type="button" className="btn btn-primary" onClick={onRetry} data-testid="err-state-retry">
            {t('errorState.retry')}
          </button>
        )}
        <button type="button" className={k === 'failed' && onRetry ? 'btn btn-secondary' : 'btn btn-primary'} onClick={() => navigate(backTo)}>
          {t(backLabelKey)}
        </button>
      </div>
    </div>
  );
}
