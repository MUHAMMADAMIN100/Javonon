import type { BonusProgressData } from '../api/kpi';
import { useT } from '../lib/i18n';
import { tjYMD } from '../lib/tjTime';

/**
 * Прогресс менеджера к следующей ставке бонуса за текущий месяц.
 *
 * Числа приходят с сервера готовыми (common/manager-bonus-volume.ts →
 * managerBonusProgress) — тот же расчёт, по которому платят в «Зарплате»;
 * здесь только рисуем. Шкала — пять полос сетки одинаковой ширины: заполнены
 * пройденные полосы и доля текущей.
 *
 * variant='card'    — крупный блок (KPI менеджера, профиль);
 * variant='compact' — ячейка таблицы KPI у руководства.
 */
function fmtMoney(n: number) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'TJS', maximumFractionDigits: 0 }).format(n);
}

/** Доля пути внутри полосы (0…1). У верхней полосы потолка нет — она полная. */
function bandFill(p: BonusProgressData, idx: number): number {
  const cur = p.bands.findIndex((b) => b.key === p.band.key);
  if (idx < cur) return 1;
  if (idx > cur) return 0;
  const b = p.bands[idx];
  if (b.maxAmount === null) return 1;
  const span = b.maxAmount - b.minAmount;
  if (span <= 0) return 1;
  return Math.max(0.02, Math.min(1, (p.volume - b.minAmount) / span));
}

export default function BonusProgress({
  p,
  variant = 'card',
  testId,
}: {
  p: BonusProgressData;
  variant?: 'card' | 'compact';
  testId?: string;
}) {
  const { t } = useT();
  const monthNo = tjYMD(new Date(p.periodStart)).m;
  const month = t(`month.${monthNo}`);
  const next = p.nextBand && p.toNext !== null
    ? t('bonus.progress.toNext').replace('{percent}', String(p.nextBand.percent)).replace('{amount}', fmtMoney(p.toNext))
    : t('bonus.progress.max');

  const scale = (
    <div className="bonus-scale" role="img" aria-label={`${fmtMoney(p.volume)} · ${p.percent}%`}>
      {p.bands.map((b, i) => (
        <div key={b.key} className={`bonus-scale-seg${b.key === p.band.key ? ' is-current' : ''}`}>
          <div className="bonus-scale-track">
            <div className="bonus-scale-fill" style={{ width: `${bandFill(p, i) * 100}%` }} />
          </div>
          {variant === 'card' && <span className="bonus-scale-pct">{b.percent}%</span>}
        </div>
      ))}
    </div>
  );

  if (variant === 'compact') {
    return (
      <div className="bonus-progress is-compact" data-testid={testId}>
        <div className="bonus-compact-head">
          <span className="badge badge-success" data-testid="bonus-rate">{p.percent}%</span>
          <span className="bonus-compact-volume">{fmtMoney(p.volume)}</span>
        </div>
        {scale}
        <div className="bonus-compact-next" data-testid="bonus-next">{next}</div>
      </div>
    );
  }

  return (
    <div className="bonus-progress is-card" data-testid={testId}>
      <div className="bonus-card-head">
        <span className="bonus-card-title">{t('bonus.progress.title')}</span>
        <span className="bonus-card-month">{month}</span>
      </div>
      <div className="bonus-card-figures">
        <div>
          <span className="bonus-card-label">{t('bonus.progress.volume')}</span>
          <b data-testid="bonus-volume">{fmtMoney(p.volume)}</b>
        </div>
        <div>
          <span className="bonus-card-label">{t('bonus.progress.rate')}</span>
          <b data-testid="bonus-rate">{p.percent}%</b>
        </div>
        <div>
          <span className="bonus-card-label">{t('bonus.progress.bonus')}</span>
          <b data-testid="bonus-amount">{fmtMoney(p.bonus)}</b>
        </div>
      </div>
      {scale}
      <div className="bonus-card-next" data-testid="bonus-next">{next}</div>
      <div className="bonus-card-hint">{t('bonus.progress.hint')}</div>
    </div>
  );
}
