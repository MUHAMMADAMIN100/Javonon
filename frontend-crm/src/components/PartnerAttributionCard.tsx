import { Link } from 'react-router-dom';
import type { PartnerAttributionView } from '../api/types';
import { fmtCommissionRate, fmtMoneyCents } from '../api/partners';
import { useT } from '../lib/i18n';
import { tjFormatDate } from '../lib/tjTime';
import Icon from '../Icon';

/**
 * Блок «Партнёр» на карточках сделки / студента / заявки.
 *
 * ОДИН компонент на все три страницы — блок обязан выглядеть и читаться
 * одинаково везде, а «начислено / ещё не начислено» это деньги: разъехавшиеся
 * копии рано или поздно начнут показывать разное про одну и ту же комиссию.
 *
 * ПРИВАТНОСТЬ. Здесь НЕТ проверки роли и её нельзя сюда добавлять. Гейт живёт
 * на бэкенде: `partnerAttribution` физически отсутствует в JSON для всех, кроме
 * FOUNDER/ADMIN/ACCOUNTANT (см. isElevated в students/applications/submissions
 * .service.ts). Клиентский `isElevated(me)` не добавил бы ни грамма
 * безопасности — сетевой ответ открывается в devtools — зато создал бы
 * впечатление, что приватность держится на UI, и однажды кто-то ослабил бы
 * бэкенд «раз фронт всё равно прячет». `if (!attribution) return null` ниже —
 * это защита от пустого рендера, а не контроль доступа.
 *
 * Нет атрибуции — нет блока. Ни пустой рамки, ни строки «партнёра нет»:
 * подавляющее большинство клиентов органические, и лишний пустой блок на
 * каждой карточке — это шум, а не информация.
 */
type Props = {
  /**
   * `undefined` — поле не пришло (не руководство либо старый бэк).
   * `null` — руководство смотрит органического клиента.
   * Оба случая рисуют одно и то же: ничего.
   */
  attribution?: PartnerAttributionView | null;
};

export default function PartnerAttributionCard({ attribution }: Props) {
  const { t } = useT();

  if (!attribution) return null;

  const credited = !!attribution.commissionedAt;
  const accent = credited ? 'var(--success)' : 'var(--warning)';

  // Два разных числа под одной подписью, и путать их нельзя.
  //
  // Пришла валюта → бэкенд достал НАСТОЯЩУЮ Commission: сколько партнёру
  // записали в баланс. Рисуем как деньги в её валюте — тем же форматтером и
  // тем же видом, что «Партнёры → Комиссии» (PartnerDetail.tsx), чтобы одно
  // начисление не читалось двумя разными строками в одном клике друг от друга.
  //
  // Валюты нет → это прогноз по текущей фикс-ставке (комиссия ещё не
  // начислена либо запись начисления не нашлась). Ставка всегда целые TJS —
  // её и рисуем ставочным форматтером, без копеек.
  const commissionLabel = attribution.commissionCurrency
    ? fmtMoneyCents(attribution.commissionAmountCents, attribution.commissionCurrency)
    : fmtCommissionRate(attribution.commissionAmountCents);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        padding: '12px 14px',
        marginBottom: 18,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
        <Icon name="handshake" size={20} style={{ color: 'var(--text-soft)', flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--text-soft)',
              fontWeight: 600,
            }}
          >
            {t('partners.attribution.title')}
          </div>

          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text)',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            }}
          >
            {attribution.fullName}
          </div>

          <div
            style={{
              marginTop: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              fontSize: 12,
              color: 'var(--text-soft)',
            }}
          >
            <span>
              {t('partners.attribution.code')}:{' '}
              {/* title — готовая ссылка с бэка (referralUrl). Именно она, а не
                  собранная из кода на клиенте: формат '#apply'-якоря живёт в
                  backend/src/common/landing-url.ts и меняется только там. */}
              <code title={attribution.referralUrl}>{attribution.referralCode}</code>
            </span>
            <span>
              {t('partners.attribution.commission')}:{' '}
              {/* Форматтеры общие на всю CRM (api/partners.ts). Руками не
                  пересчитываем и число не выбираем — какую сумму показать
                  (прогноз по ставке или замороженную), решает бэкенд, иначе
                  карточка клиента и раздел «Партнёры» разъедутся. */}
              <strong style={{ color: 'var(--text)' }}>{commissionLabel}</strong>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: accent, fontWeight: 600 }}>
              <Icon name={credited ? 'check_circle' : 'schedule'} size={14} />
              {credited
                ? `${t('partners.attribution.credited')} ${tjFormatDate(attribution.commissionedAt)}`
                : t('partners.attribution.notCredited')}
            </span>
          </div>
        </div>
      </div>

      <Link className="btn btn-sm btn-secondary" to={`/partners/${attribution.partnerId}`}>
        <Icon name="open_in_new" size={14} /> {t('partners.attribution.open')}
      </Link>
    </div>
  );
}
