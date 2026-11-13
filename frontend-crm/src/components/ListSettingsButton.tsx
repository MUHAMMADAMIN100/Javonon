import { Link } from 'react-router-dom';
import Icon from '../Icon';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { canManageLookups } from '../pages/LeadSettings';

/** Кнопка «Настройки» на странице раздела — открывает его вкладку в «Настройки списков». */
export default function ListSettingsButton({ section }: { section: 'leads' | 'students' | 'comms' | 'deals' | 'tasks' }) {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  if (!canManageLookups(me)) return null;
  return (
    <Link to={`/settings/lists?section=${section}`} className="btn btn-secondary leads-settings-btn" data-testid={`settings-btn-${section}`} title={t('ls.title')}>
      <Icon name="tune" size={18} />
      <span className="leads-settings-label">{t('lk.button')}</span>
    </Link>
  );
}
