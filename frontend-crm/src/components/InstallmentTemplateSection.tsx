import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '../lib/i18n';
import { useUI } from '../ui/Dialogs';
import { useAuth } from '../store/auth';
import { isElevated } from '../lib/roles';
import { keys } from '../lib/queryKeys';
import Icon from '../Icon';
import {
  getInstallmentTemplate,
  saveInstallmentTemplate,
  previewStageAmounts,
  type InstallmentTemplateStageInput,
} from '../api/installments';

/**
 * Шаблон рассрочки программы.
 *
 * Шаблон описывает ПОРЯДОК взносов: доля в процентах + сдвиг срока в днях от
 * заключения сделки. При создании сделки он материализуется в PaymentStage;
 * правка шаблона НЕ трогает уже подписанные контракты — их этапы менеджер
 * правит в карточке сделки.
 *
 * Сумма долей обязана быть ровно 100% — бэк отклоняет иное. Остаток от
 * округления при материализации падает на ПОСЛЕДНИЙ этап, поэтому сумма
 * этапов всегда совпадает с суммой контракта до копейки (см. предпросмотр).
 */

const MAX_STAGES = 24;
const PERCENT_EPSILON = 0.01;

type Row = { title: string; percent: string; offsetDays: string };

export default function InstallmentTemplateSection({
  programId,
  programCost,
  currency,
}: {
  programId: string;
  programCost?: number;
  currency?: string;
}) {
  const { t } = useT();
  const { toast } = useUI();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const canEdit = isElevated(me);

  const query = useQuery({
    queryKey: keys.installments.template(programId),
    queryFn: () => getInstallmentTemplate(programId),
  });

  const [rows, setRows] = useState<Row[] | null>(null);

  // Черновик поднимается из ответа один раз — иначе refetch затирал бы
  // недоредактированную таблицу под руками.
  useEffect(() => {
    if (query.data && rows === null) {
      setRows(
        query.data.map((s) => ({
          title: s.title || '',
          percent: String(s.percent),
          offsetDays: String(s.offsetDays),
        })),
      );
    }
  }, [query.data, rows]);

  const mut = useMutation({
    mutationFn: (stages: InstallmentTemplateStageInput[]) => saveInstallmentTemplate(programId, stages),
    onSuccess: (saved) => {
      toast(t('installments.saved'), 'success');
      qc.setQueryData(keys.installments.template(programId), saved);
      setRows(
        saved.map((s) => ({
          title: s.title || '',
          percent: String(s.percent),
          offsetDays: String(s.offsetDays),
        })),
      );
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const list = rows ?? [];
  const percents = useMemo(() => list.map((r) => parseFloat(r.percent)), [list]);
  const sum = useMemo(
    () => percents.reduce((acc, p) => acc + (isFinite(p) ? p : 0), 0),
    [percents],
  );
  const amounts = useMemo(
    () =>
      programCost && percents.every((p) => isFinite(p))
        ? previewStageAmounts(percents, programCost)
        : [],
    [percents, programCost],
  );

  const sumOk = list.length === 0 || Math.abs(sum - 100) <= PERCENT_EPSILON;
  const rowsValid = list.every(
    (r) => isFinite(parseFloat(r.percent)) && parseFloat(r.percent) > 0 && parseFloat(r.percent) <= 100,
  );

  const patch = (i: number, p: Partial<Row>) =>
    setRows((prev) => (prev ?? []).map((r, idx) => (idx === i ? { ...r, ...p } : r)));

  const move = (i: number, dir: -1 | 1) =>
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const target = next[i + dir];
      if (!target) return prev;
      next[i + dir] = next[i];
      next[i] = target;
      return next;
    });

  const onSave = () =>
    mut.mutate(
      list.map((r) => ({
        title: r.title.trim() || undefined,
        percent: parseFloat(r.percent),
        offsetDays: parseInt(r.offsetDays, 10) || 0,
      })),
    );

  if (query.isLoading) return null;

  return (
    <div className="card" style={{ padding: 20, marginTop: 16 }}>
      <h3 style={{ marginBottom: 8 }}>{t('installments.title')}</h3>
      <p style={{ color: 'var(--text-soft)', fontSize: 13, marginTop: 0, marginBottom: 14 }}>
        {t('installments.hint')}
      </p>

      {list.length === 0 ? (
        <div style={{ color: 'var(--text-soft)', fontSize: 13, marginBottom: 12 }}>
          {t('installments.empty')}
        </div>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>{t('installments.col.title')}</th>
                <th style={{ width: 110 }}>{t('installments.col.percent')}</th>
                <th style={{ width: 150 }}>{t('installments.col.offset')}</th>
                {amounts.length > 0 && <th style={{ textAlign: 'right' }}>{t('installments.col.preview')}</th>}
                {canEdit && <th style={{ width: 110 }} />}
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-soft)' }}>{i + 1}</td>
                  <td>
                    <input
                      className="crm-input"
                      value={r.title}
                      maxLength={120}
                      disabled={!canEdit}
                      placeholder={`${t('installments.col.title')} ${i + 1}`}
                      onChange={(e) => patch(i, { title: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="crm-input"
                      type="number"
                      min={0.01}
                      max={100}
                      step={0.01}
                      value={r.percent}
                      disabled={!canEdit}
                      onChange={(e) => patch(i, { percent: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="crm-input"
                      type="number"
                      min={0}
                      step={1}
                      value={r.offsetDays}
                      disabled={!canEdit}
                      onChange={(e) => patch(i, { offsetDays: e.target.value })}
                    />
                  </td>
                  {amounts.length > 0 && (
                    <td style={{ textAlign: 'right', color: 'var(--text-soft)', fontVariantNumeric: 'tabular-nums' }}>
                      {amounts[i]?.toLocaleString('ru-RU')} {currency || ''}
                    </td>
                  )}
                  {canEdit && (
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-secondary" disabled={i === 0} onClick={() => move(i, -1)}>
                          <Icon name="arrow_upward" size={13} />
                        </button>
                        <button
                          className="btn btn-sm btn-secondary"
                          disabled={i === list.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <Icon name="arrow_downward" size={13} />
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setRows((prev) => (prev ?? []).filter((_, idx) => idx !== i))}
                        >
                          <Icon name="delete" size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-secondary"
              disabled={list.length >= MAX_STAGES}
              onClick={() =>
                setRows((prev) => [...(prev ?? []), { title: '', percent: '', offsetDays: '0' }])
              }
            >
              <Icon name="add" size={14} /> {t('installments.addStage')}
            </button>
            {list.length > 0 && (
              <span style={{ fontSize: 13, color: sumOk ? 'var(--text-soft)' : 'var(--danger)' }}>
                {t('installments.sum')}: {Math.round(sum * 100) / 100}%
                {!sumOk && ` — ${t('installments.sumInvalid')}`}
              </span>
            )}
          </div>
          <button
            className="btn btn-sm btn-primary"
            disabled={!sumOk || !rowsValid || mut.isPending}
            onClick={onSave}
          >
            {mut.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}
