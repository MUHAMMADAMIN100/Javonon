import type { PresenceState } from '../api/presence';
import { useT } from '../lib/i18n';

/**
 * Кружок присутствия рядом с именем: зелёный — в сети, жёлтый — отошёл,
 * серый — не в сети. Видит только основатель (данные приходят только ему).
 */
export default function PresenceDot({ state, title, size = 10 }: { state: PresenceState | undefined; title?: string; size?: number }) {
  const { t } = useT();
  if (!state) return null;
  const label = title ?? t(state === 'ONLINE' ? 'presence.online' : state === 'AWAY' ? 'presence.away' : 'presence.offline');
  return (
    <span
      className={`presence-dot is-${state.toLowerCase()}`}
      style={{ width: size, height: size }}
      title={label}
      aria-label={label}
      role="img"
      data-testid="presence-dot"
      data-state={state}
    />
  );
}
