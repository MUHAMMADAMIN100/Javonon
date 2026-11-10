import { useMemo, useState } from 'react';
import { useT } from '../../lib/i18n';
import DismissedMark from '../DismissedMark';
import { CurrencyBadge, NonTjsStrip } from './financeShared';

// ============================================================
// Revenue chart — pure SVG, dual line (income / expense) + profit area
// ============================================================
/**
 * Карточка распределения выручки по активной FOUNDER-редактируемой схеме.
 *
 * Backend GET /finance/distribution возвращает `scheme.buckets` с
 * рассчитанным `allocated` на каждый фонд (PERCENTAGE: `incomeTotal *
 * percent / 100`; FIXED_SUM: `sum(items.amount)`). UI:
 *   • строка на фонд: цвет-акцент (bucket.color), заголовок (%N · Name для
 *     PERCENTAGE, «Name» для FIXED_SUM), сумма и прогресс-бар в долях от
 *     `incomeTotal` (даёт визуальную интуицию, сколько «съел» фонд);
 *   • для FIXED_SUM бакетов доступен раскрывающийся список статей (клик по
 *     заголовку) — показывает name + amount, чтобы FOUNDER видел «на кого
 *     ушёл ФОТ» без похода в Настройки;
 *   • внизу — «Прибыль после распределения» (`netAfterDistribution`),
 *     зелёная при > 0, красная при < 0. Отрицательный net = фонды
 *     перерасходовали выручку → сигнал пересобрать схему.
 */
export default function RevenueDistributionCard({ breakdown }: { breakdown: import('../../api/finance').FinanceDistribution }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Backend возвращает `scheme: null`, если активная FOUNDER-редактируемая
  // схема ещё не сконфигурирована (или RevenueSchemeService не инжектирован
  // на этом деплое). В этом случае buckets/name читать неоткуда — рендерим
  // «пустой» плейсхолдер той же формы, чтобы FOUNDER увидел место карточки
  // и понял, куда идти настраивать. Раньше это падало в TypeError и клало
  // всю страницу Finance.
  const scheme = breakdown.scheme;
  const buckets = useMemo(
    () => (scheme ? [...scheme.buckets].sort((a, b) => a.order - b.order) : []),
    [scheme],
  );
  if (!scheme) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
          color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span>{t('eyebrow.distributionScheme')}</span>
          <CurrencyBadge currency={breakdown.currency ?? 'TJS'} />
        </div>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 8 }}>
          {t('finance.dist.title')}
        </h3>
        <div style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12 }}>
          {t('finance.dist.notConfigured')}
        </div>
        <NonTjsStrip totals={breakdown.nonTjsTotals} />
      </div>
    );
  }

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const denom = Math.max(1, breakdown.incomeTotal); // защита от /0

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
        color: 'var(--primary-dark)', textTransform: 'uppercase', marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <span>{t('eyebrow.distributionScheme')}</span>
        <CurrencyBadge currency={breakdown.currency ?? 'TJS'} />
      </div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, marginBottom: 8 }}>
        {scheme.name || t('finance.dist.title')}
      </h3>
      <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 16 }}>
        {t('finance.dist.title')} · {breakdown.incomeTotal.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} {breakdown.currency}
      </div>

      {/* Валютная активность за тот же период (не входит в распределение —
          backend распределяет только TJS-выручку). */}
      <NonTjsStrip totals={breakdown.nonTjsTotals} />

      {buckets.map((b) => {
        const months = breakdown.fixedMonths ?? 1;
        const color = b.color && b.color !== '#ffffff' ? b.color : '#94a3b8';
        const pctOfIncome = Math.min(100, (b.allocated / denom) * 100);
        const kindLabel =
          b.kind === 'PERCENTAGE'
            ? t('finance.distribution.fund.percentage')
            : t('finance.distribution.fund.fixed');
        const headline =
          b.kind === 'PERCENTAGE'
            ? `${b.percent ?? 0}% · ${b.name}`
            : b.name;
        const isFixed = b.kind === 'FIXED_SUM';
        const isOpen = expanded.has(b.id);

        return (
          <div key={b.id} style={{ marginBottom: 14 }}>
            {/* Раскладка строки — в CSS (.dist-row-*): сумма справа не рвётся, переносится подпись. */}
            <div
              className="dist-row-head"
              style={{ cursor: isFixed && b.items.length > 0 ? 'pointer' : 'default' }}
              onClick={() => {
                if (isFixed && b.items.length > 0) toggleExpand(b.id);
              }}
            >
              <span className="dist-row-label">
                <b style={{ color }}>{headline}</b>
                <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                  · {kindLabel}
                  {/* Сумма месячная: за период длиннее месяца — умножена (QA №47). */}
                  {isFixed && months !== 1 && (
                    <span data-testid="dist-months"> {t('finance.distribution.months').replace('{n}', months.toLocaleString('ru-RU', { maximumFractionDigits: 2 }))}</span>
                  )}
                </span>
                {isFixed && b.items.length > 0 && (
                  <span style={{ color: 'var(--text-soft)', marginLeft: 6, fontSize: 11 }}>
                    · {b.items.length} {isOpen ? '▾' : '▸'}
                  </span>
                )}
              </span>
              <span className="dist-row-sum" data-testid="dist-sum">
                {b.allocated.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--bg-soft)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pctOfIncome}%`, background: color }} />
            </div>
            {isFixed && isOpen && b.items.length > 0 && (
              <div style={{
                marginTop: 6, paddingLeft: 12,
                borderLeft: `2px solid ${color}`,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}>
                {b.items.map((it) => (
                  <div key={it.id} className="dist-item">
                    <span className="dist-item-name">
                      {it.name}
                      {it.user && <> · {it.user.fullName}<DismissedMark person={it.user} /></>}
                    </span>
                    <span className="dist-item-sum" data-testid="dist-sum">{it.amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Net after distribution */}
      <div className="dist-net">
        <span className="dist-net-label">
          {t('finance.distribution.netAfter')}
        </span>
        <span
          className="dist-net-sum"
          data-testid="dist-net-sum"
          style={{ color: breakdown.netAfterDistribution >= 0 ? '#15803d' : '#b91c1c' }}
        >
          {breakdown.netAfterDistribution.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} {breakdown.currency}
        </span>
      </div>
    </div>
  );
}

// ============================================================
// Drill-down панели: клик по сектору пирога / точке revenue-графика
// открывает панель со списком транзакций, попадающих в этот срез.
// Логика фильтрации на клиенте: backend GET /finance/transactions
// принимает только type/category/managerId/from/to (не incomeSource),
// поэтому мы фильтруем по incomeSource на фронте. Роллап-сектор
// «Прочее» — массив ключей, объединяем предикатом-any.
// ============================================================
