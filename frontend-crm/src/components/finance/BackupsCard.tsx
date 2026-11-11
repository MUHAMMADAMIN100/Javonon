import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Icon from '../../Icon';
import CrmSelect from '../CrmSelect';
import { useUI } from '../../ui/Dialogs';
import { useT } from '../../lib/i18n';
import { keys } from '../../lib/queryKeys';
import { fmtDateText } from '../../lib/tjTime';
import { createBackup, downloadBackup, downloadReport, listBackups } from '../../api/finance';
import { currentYm, monthLabel, shiftYm } from './financeShared';

/**
 * «Резервные копии и отчёт» (часть 3, 11.11.2026): ночные снимки и снимок по
 * кнопке (скачать файл), отчёт Excel за месяц. Очистки и импорта с заменой нет.
 */
export default function BackupsCard({ canManage }: { canManage: boolean }) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.finance.expense('backups', 0), queryFn: listBackups });
  const [busy, setBusy] = useState(false);
  const [ym, setYm] = useState(shiftYm(currentYm(), -1));
  const months = Array.from({ length: 12 }, (_, i) => shiftYm(currentYm(), -i));
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const rows = q.data?.rows ?? [];
  return (
    <section className="fin-card fin-block" data-testid="bk-card">
      <div className="fin-card-head">
        <div>
          <h2 className="fin-card-title">{t('finance.bk.title')}</h2>
          <p className="fin-muted-line">{t('finance.bk.hint')}</p>
        </div>
        {canManage && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} data-testid="bk-create"
            onClick={() => run(async () => { await createBackup(); qc.invalidateQueries({ queryKey: keys.finance.all }); }, t('finance.bk.created'))}>
            <Icon name="backup" size={16} /> {t('finance.bk.create')}
          </button>
        )}
      </div>
      <div className="bk-report">
        <span>{t('finance.bk.report')}</span>
        <CrmSelect className="crm-select" value={ym} onChange={(e) => setYm(e.target.value)} data-testid="bk-month">
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </CrmSelect>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(() => downloadReport(ym))} data-testid="bk-excel">
          <Icon name="table_view" size={16} /> {t('finance.bk.excel')}
        </button>
      </div>
      {q.isLoading ? <p className="fin-empty-line">{t('common.loading')}</p> : rows.length === 0 ? (
        <p className="fin-empty-line" data-testid="bk-empty">{t('finance.bk.empty')}</p>
      ) : (
        <ul className="bk-list" data-testid="bk-list">
          {rows.slice(0, 12).map((b) => (
            <li key={b.id} data-testid={`bk-row-${b.id}`}>
              <Icon name={b.kind === 'AUTO' ? 'schedule' : 'person'} size={18} />
              <span className="bk-when">{fmtDateText(b.createdAt, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dushanbe' })}</span>
              <span className="fin-muted-line">{b.kind === 'AUTO' ? t('finance.bk.auto') : (b.createdByName ?? t('finance.bk.manual'))} · {t('finance.bk.ops').replace('{n}', String(b.counts?.transactions ?? 0))} · {Math.max(1, Math.round(b.sizeBytes / 1024))} {t('finance.bk.kb')}</span>
              {canManage && (
                <button type="button" className="fin-link" disabled={busy} onClick={() => run(() => downloadBackup(b.id))} data-testid="bk-download">{t('finance.bk.download')}</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
