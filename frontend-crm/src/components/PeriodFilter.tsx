import CrmDatePicker from './CrmDatePicker';
import { useT } from '../lib/i18n';

/**
 * Пара «дата с — дата по» для тулбара списка.
 *
 * Вынесена отдельно, чтобы во всех списках CRM период выбирался ОДИНАКОВО:
 * те же поля, те же подписи, тот же порядок. Раньше период можно было
 * передать только ссылкой с дашборда, а руками задать его было негде.
 *
 * Значения — календарные дни `YYYY-MM-DD` (Asia/Dushanbe): бэкенд
 * разворачивает их в моменты сам, см. backend/src/common/query-date.ts.
 */
export default function PeriodFilter({
  from,
  to,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const { t } = useT();
  return (
    <>
      <CrmDatePicker
        value={from}
        onChange={onFrom}
        placeholder={t('list.filter.dateFrom')}
        // Верхняя граница: «с» не может быть позже «по». Пикер сам не даст
        // выбрать такую дату, поэтому «период наоборот» в ссылку не уедет.
        max={to || undefined}
      />
      <CrmDatePicker
        value={to}
        onChange={onTo}
        placeholder={t('list.filter.dateTo')}
        min={from || undefined}
      />
    </>
  );
}
