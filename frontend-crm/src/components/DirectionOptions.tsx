import LookupOptions from './LookupOptions';

/** Направления из справочника «Лиды → Настройки» (порядок и подписи — оттуда). */
export default function DirectionOptions({ current }: { current?: string | null } = {}) {
  return <LookupOptions kind="DIRECTION" current={current} />;
}
