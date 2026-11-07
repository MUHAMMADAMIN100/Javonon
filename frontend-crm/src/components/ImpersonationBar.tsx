import { useEffect, useState } from 'react';
import { useAuth, restoreImpersonator } from '../store/auth';
import { stopImpersonation } from '../api/auth';
import { useNow } from '../lib/useNow';
import { useT } from '../lib/i18n';
import Icon from '../Icon';

/**
 * Плашка режима «Войти как»: основатель видит CRM глазами сотрудника. Видна
 * на всех экранах, пока режим открыт; «Вернуться» и конец часа возвращают
 * основателя в свой аккаунт.
 */
export default function ImpersonationBar() {
  const { t } = useT();
  const me = useAuth((s) => s.user);
  const imp = me?.impersonation ?? null;
  const now = useNow(15_000);
  const [leaving, setLeaving] = useState(false);

  const until = imp ? new Date(imp.until).getTime() : 0;
  const minutesLeft = imp ? Math.max(0, Math.ceil((until - now) / 60_000)) : 0;

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    stopImpersonation().catch(() => undefined).finally(() => restoreImpersonator());
  };

  // Час вышел — сервер уже не примет токен; возвращаемся сами, не дожидаясь 401.
  useEffect(() => {
    if (imp && until && now >= until) leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imp, until, now]);

  if (!imp) return null;
  return (
    <div className="impersonation-bar" role="status" data-testid="impersonation-bar">
      <Icon name="switch_account" size={18} />
      <span className="impersonation-bar-text">
        {t('impersonate.bar').replace('{name}', me?.fullName || '')}
        <span className="impersonation-bar-time">{t('impersonate.left').replace('{min}', String(minutesLeft))}</span>
      </span>
      <button type="button" className="btn btn-sm impersonation-bar-back" onClick={leave} disabled={leaving} data-testid="impersonation-back">
        {t('impersonate.back')}
      </button>
    </div>
  );
}
