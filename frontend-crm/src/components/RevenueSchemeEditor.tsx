import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUI } from '../ui/Dialogs';
import { useT } from '../lib/i18n';
import { keys } from '../lib/queryKeys';
import {
  type RevenueScheme,
  type RevenueBucket,
  type RevenueBucketItem,
  type BucketKind,
  type CreateBucketDto,
  type CreateItemDto,
  createBucket,
  updateBucket,
  deleteBucket,
  createItem,
  updateItem,
  deleteItem,
  resetRevenueScheme,
} from '../api/revenue-scheme';

/**
 * FOUNDER-редактор схемы распределения дохода.
 *
 * Модель UI:
 *   • левый список: карточки-фонды (buckets), каждая — с inline-редактированием
 *     name/percent/color и списком статей;
 *   • при клике «+ Добавить фонд» / «+ Добавить статью» открывается
 *     inline-форма;
 *   • «Сбросить к дефолту» пересобирает схему на бэкенде из hardcoded seed
 *     (иногда FOUNDER хочет откатить эксперименты — быстрее чем удалять
 *     по одному).
 *
 * Мутации: делаем прямые api-вызовы + `qc.invalidateQueries` вместо
 * useMutation, потому что PATCH здесь одиночные (percent, name, color),
 * а списочный ре-фетч всё равно нужен для синхронизации порядка/удалений
 * — оптимистика делается через локальный state (setName перед await), а
 * при ошибке — toast + принудительный refetch, который прокидывает
 * серверную правду обратно в input'ы.
 */

const COLOR_PALETTE = [
  '#ffffff', // белый (blank / нейтральный)
  '#ef4444', // красный — Налоги, ФОТ
  '#f59e0b', // оранжевый — Отдел продаж, себестоимость
  '#3b82f6', // синий — Маркетинг
  '#10b981', // зелёный — резерв
  '#8b5cf6', // фиолетовый — новый фонд
  '#ec4899', // розовый
  '#6b7280', // серый
];

export default function RevenueSchemeEditor({ scheme }: { scheme: RevenueScheme }) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);

  const buckets = useMemo(
    () => [...scheme.buckets].sort((a, b) => a.order - b.order),
    [scheme.buckets],
  );

  const totalPercent = useMemo(
    () =>
      buckets
        .filter((b) => b.kind === 'PERCENTAGE')
        .reduce((sum, b) => sum + (b.percent ?? 0), 0),
    [buckets],
  );

  // ВАЖНО: помимо самой схемы обязательно инвалидируем и `finance`.
  // Финансовый дашборд (Finance.tsx) кэширует distribution / netAfterDistribution
  // по ключу `keys.finance.*` со staleTime=30s (queryClient.ts) и без
  // refetchOnWindowFocus — если FOUNDER поменял процент/фиксу в Настройках
  // и в течение 30с открыл Финансы, без этой инвалидации он увидит СТАРУЮ
  // разбивку и старый netAfterDistribution. Mind-map на Настройках жил на
  // ['revenue-scheme'] и обновлялся, а Финансы молча врали. Не удалять.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['revenue-scheme'] });
    qc.invalidateQueries({ queryKey: keys.finance.all });
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: t('common.reset'),
      message: t('settings.revenueScheme.reset.confirm'),
      danger: true,
      confirmText: t('common.reset'),
    });
    if (!ok) return;
    try {
      await resetRevenueScheme();
      toast(t('toast.updated'), 'success');
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const handleAddBucket = async (dto: CreateBucketDto) => {
    try {
      await createBucket({ ...dto, order: buckets.length });
      toast(t('toast.created'), 'success');
      setCreating(false);
      refresh();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Заголовок + процент + reset */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PercentSumBadge totalPercent={totalPercent} />
        </div>
        <button className="btn btn-sm btn-secondary" onClick={handleReset}>
          {t('settings.revenueScheme.reset')}
        </button>
      </div>

      {/* Список фондов */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {buckets.map((b) => (
          <BucketCard key={b.id} bucket={b} onChanged={refresh} />
        ))}
      </div>

      {/* Добавить фонд */}
      {creating ? (
        <NewBucketForm onCancel={() => setCreating(false)} onCreate={handleAddBucket} />
      ) : (
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setCreating(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          {t('settings.revenueScheme.addBucket')}
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Sum badge
// ============================================================================

function PercentSumBadge({ totalPercent }: { totalPercent: number }) {
  const { t } = useT();
  const isOver = totalPercent > 100;
  const isExact = totalPercent === 100;
  const color = isOver ? '#ef4444' : isExact ? '#10b981' : '#f59e0b';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        border: `1.5px solid ${color}`,
        borderRadius: 8,
        background: `${color}15`,
      }}
      title={isOver ? t('settings.revenueScheme.sumWarning.over100') : ''}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 12,
          fontWeight: 600,
          color,
        }}
      >
        Σ {totalPercent}%
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-soft)' }}>
        {t('settings.revenueScheme.sumBadge.percent')}
      </span>
    </div>
  );
}

// ============================================================================
// Bucket card
// ============================================================================

function BucketCard({ bucket, onChanged }: { bucket: RevenueBucket; onChanged: () => void }) {
  const { toast, confirm } = useUI();
  const { t, lang } = useT();
  const moneyLocale = lang === 'tg' ? 'tg-TJ' : 'ru-RU';

  const [name, setName] = useState(bucket.name);
  const [percent, setPercent] = useState<string>(
    bucket.percent != null ? String(bucket.percent) : '',
  );
  const [color, setColor] = useState<string>(bucket.color ?? '#ffffff');
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [addingItem, setAddingItem] = useState(false);

  // Refs used to guard the re-sync effects: если пользователь СЕЙЧАС печатает в
  // input, серверный refetch не должен затирать его буквы. Если фокуса нет —
  // безопасно принять свежее значение с сервера (кейс: другой FOUNDER
  // отредактировал тот же фонд, WS/refetch притащил новую правду).
  const nameInputRef = useRef<HTMLInputElement>(null);
  const percentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== nameInputRef.current) {
      setName(bucket.name);
    }
  }, [bucket.name]);

  useEffect(() => {
    if (document.activeElement !== percentInputRef.current) {
      setPercent(bucket.percent != null ? String(bucket.percent) : '');
    }
  }, [bucket.percent]);

  useEffect(() => {
    // color: у нас нет свободного текстового ввода — только клики по палитре,
    // поэтому «фокусной» защиты не требуется, синхронизируем безусловно.
    setColor(bucket.color ?? '#ffffff');
  }, [bucket.color]);

  const items = useMemo(
    () => [...bucket.items].sort((a, b) => a.order - b.order),
    [bucket.items],
  );

  const fixedTotalCents = useMemo(
    () =>
      bucket.kind === 'FIXED_SUM'
        ? items.reduce((s, it) => s + (it.amountCents ?? 0), 0)
        : 0,
    [bucket.kind, items],
  );

  const commitName = async () => {
    const next = name.trim();
    if (!next || next === bucket.name) {
      setName(bucket.name);
      return;
    }
    try {
      await updateBucket(bucket.id, { name: next });
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      setName(bucket.name);
    }
  };

  const commitPercent = async () => {
    if (bucket.kind !== 'PERCENTAGE') return;
    const raw = percent.trim();
    const n = raw === '' ? 0 : Number(raw);
    // Contract: >100 allowed (with warning shown by PercentSumBadge when Σ>100).
    // Only reject non-numeric / negative values here.
    if (Number.isNaN(n) || n < 0) {
      toast(t('toast.error'), 'error');
      setPercent(bucket.percent != null ? String(bucket.percent) : '');
      return;
    }
    if (n === (bucket.percent ?? 0)) return;
    try {
      await updateBucket(bucket.id, { percent: n });
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      setPercent(bucket.percent != null ? String(bucket.percent) : '');
    }
  };

  const commitColor = async (c: string) => {
    setColor(c);
    setColorPickerOpen(false);
    if (c === bucket.color) return;
    try {
      await updateBucket(bucket.id, { color: c });
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      setColor(bucket.color ?? '#ffffff');
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: t('settings.revenueScheme.delete.bucket.confirm') + ` «${bucket.name}»`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteBucket(bucket.id);
      toast(t('toast.deleted'), 'success');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const handleAddItem = async (dto: CreateItemDto) => {
    try {
      await createItem(bucket.id, { ...dto, order: items.length });
      toast(t('toast.created'), 'success');
      setAddingItem(false);
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  const borderColor = color === '#ffffff' ? 'var(--border)' : color;

  return (
    <div
      style={{
        border: `1.5px solid ${borderColor}`,
        borderLeft: `6px solid ${color === '#ffffff' ? 'var(--border)' : color}`,
        borderRadius: 10,
        padding: 14,
        background: 'var(--bg)',
      }}
    >
      {/* Header: name + kind + color + percent + delete */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 10,
        }}
      >
        <input
          ref={nameInputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          style={{
            flex: '1 1 200px',
            fontFamily: 'var(--font-display, sans-serif)',
            fontSize: 15,
            fontWeight: 600,
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'transparent',
          }}
        />

        <KindBadge kind={bucket.kind} />

        {/* Color swatch */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setColorPickerOpen((v) => !v)}
            aria-label={t('settings.revenueScheme.card.colorAria')}
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              border: '1.5px solid var(--border)',
              background: color,
              cursor: 'pointer',
              padding: 0,
            }}
          />
          {colorPickerOpen && (
            <div
              style={{
                position: 'absolute',
                top: 32,
                left: 0,
                zIndex: 20,
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 8,
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 26px)',
                gap: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              }}
            >
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => commitColor(c)}
                  aria-label={c}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 5,
                    border:
                      c === color
                        ? '2px solid var(--text)'
                        : '1px solid var(--border)',
                    background: c,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {bucket.kind === 'PERCENTAGE' ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              ref={percentInputRef}
              type="number"
              min={0}
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              onBlur={commitPercent}
              style={{
                width: 70,
                padding: '4px 8px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontFamily: 'var(--font-mono, monospace)',
                textAlign: 'right',
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 12,
                color: 'var(--text-soft)',
              }}
            >
              %
            </span>
          </div>
        ) : (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 4,
              padding: '4px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--bg-soft)',
            }}
            title={t('settings.revenueScheme.card.fixedTotalTitle')}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {(fixedTotalCents / 100).toLocaleString(moneyLocale, {
                maximumFractionDigits: 0,
              })}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 10,
                color: 'var(--text-soft)',
                textTransform: 'uppercase',
              }}
            >
              TJS
            </span>
          </div>
        )}

        <button
          className="btn btn-sm btn-danger"
          onClick={handleDelete}
          style={{ marginLeft: 'auto' }}
        >
          {t('common.delete')}
        </button>
      </div>

      {/* Items list */}
      {items.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            marginBottom: addingItem ? 8 : 0,
          }}
        >
          {items.map((it) => (
            <BucketItemRow
              key={it.id}
              item={it}
              parentKind={bucket.kind}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {/* Add item */}
      {addingItem ? (
        <NewItemForm
          parentKind={bucket.kind}
          onCancel={() => setAddingItem(false)}
          onCreate={handleAddItem}
        />
      ) : (
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => setAddingItem(true)}
          style={{ marginTop: 8 }}
        >
          {t('settings.revenueScheme.addItem')}
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Item row
// ============================================================================

function BucketItemRow({
  item,
  parentKind,
  onChanged,
}: {
  item: RevenueBucketItem;
  parentKind: BucketKind;
  onChanged: () => void;
}) {
  const { toast, confirm } = useUI();
  const { t } = useT();

  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState<string>(
    item.amountCents != null ? String(item.amountCents / 100) : '',
  );

  // См. комментарий в BucketCard: не воруем буквы пользователя, но принимаем
  // серверную правду, когда фокуса на поле нет (правки другого FOUNDER'а).
  const nameInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== nameInputRef.current) {
      setName(item.name);
    }
  }, [item.name]);

  useEffect(() => {
    if (document.activeElement !== amountInputRef.current) {
      setAmount(item.amountCents != null ? String(item.amountCents / 100) : '');
    }
  }, [item.amountCents]);

  const commitName = async () => {
    const next = name.trim();
    if (!next || next === item.name) {
      setName(item.name);
      return;
    }
    try {
      await updateItem(item.id, { name: next });
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      setName(item.name);
    }
  };

  const commitAmount = async () => {
    if (parentKind !== 'FIXED_SUM') return;
    const raw = amount.trim();
    const n = Number(raw);
    if (raw === '' || Number.isNaN(n) || n <= 0) {
      toast(t('toast.error'), 'error');
      setAmount(item.amountCents != null ? String(item.amountCents / 100) : '');
      return;
    }
    const cents = Math.round(n * 100);
    if (cents === item.amountCents) return;
    try {
      await updateItem(item.id, { amountCents: cents });
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
      setAmount(item.amountCents != null ? String(item.amountCents / 100) : '');
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t('common.delete') + '?',
      message: t('settings.revenueScheme.delete.item.confirm') + ` «${item.name}»`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteItem(item.id);
      toast(t('toast.deleted'), 'success');
      onChanged();
    } catch (e: any) {
      toast(e?.response?.data?.message || t('toast.error'), 'error');
    }
  };

  return (
    <div
      className="revenue-item-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        background: 'var(--bg-soft)',
        borderRadius: 6,
        flexWrap: 'wrap',
      }}
    >
      <input
        ref={nameInputRef}
        className="revenue-item-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        style={{
          flex: '1 1 140px',
          minWidth: 0,
          padding: '4px 8px',
          border: '1px solid transparent',
          borderRadius: 4,
          background: 'transparent',
          fontSize: 13,
        }}
      />
      <div className="revenue-item-controls" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        {parentKind === 'FIXED_SUM' && (
          <>
            <input
              ref={amountInputRef}
              className="revenue-item-amount"
              type="number"
              min={0}
              step={100}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={commitAmount}
              style={{
                width: 90,
                minWidth: 60,
                padding: '4px 6px',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontFamily: 'var(--font-mono, monospace)',
                textAlign: 'right',
                fontSize: 12,
              }}
            />
            <span
              className="revenue-item-currency"
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 10,
                color: 'var(--text-soft)',
                textTransform: 'uppercase',
              }}
            >
              TJS
            </span>
          </>
        )}
        <button
          className="btn btn-sm btn-danger revenue-item-delete"
          onClick={handleDelete}
          aria-label={t('common.delete')}
          title={t('common.delete')}
          style={{ padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
        >
          <span className="revenue-item-delete-text">{t('common.delete')}</span>
          <span className="revenue-item-delete-icon" aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// KindBadge
// ============================================================================

function KindBadge({ kind }: { kind: BucketKind }) {
  const { t } = useT();
  const label =
    kind === 'PERCENTAGE'
      ? t('settings.revenueScheme.percent')
      : t('settings.revenueScheme.fixed');
  const color = kind === 'PERCENTAGE' ? '#3b82f6' : '#f59e0b';
  return (
    <span
      style={{
        padding: '2px 8px',
        border: `1px solid ${color}`,
        borderRadius: 4,
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 10,
        letterSpacing: '0.08em',
        color,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// ============================================================================
// New bucket form
// ============================================================================

function NewBucketForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (dto: CreateBucketDto) => void | Promise<void>;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [kind, setKind] = useState<BucketKind>('PERCENTAGE');
  const [name, setName] = useState('');
  const [percent, setPercent] = useState<string>('0');
  const [color, setColor] = useState<string>('#8b5cf6');

  const submit = () => {
    const nm = name.trim();
    if (!nm) return toast(t('toast.error'), 'error');
    if (kind === 'PERCENTAGE') {
      const p = Number(percent);
      // Contract: >100 allowed (sum badge warns when Σ>100). Reject only NaN / negatives here.
      if (Number.isNaN(p) || p < 0) return toast(t('toast.error'), 'error');
      onCreate({ kind, name: nm, percent: p, color });
    } else {
      onCreate({ kind, name: nm, percent: null, color });
    }
  };

  return (
    <div
      style={{
        border: '1px dashed var(--border)',
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--bg-soft)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as BucketKind)}
          style={{
            padding: '6px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <option value="PERCENTAGE">{t('settings.revenueScheme.percent')}</option>
          <option value="FIXED_SUM">{t('settings.revenueScheme.fixed')}</option>
        </select>
        <input
          placeholder={t('common.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            flex: '1 1 180px',
            padding: '6px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        />
        {kind === 'PERCENTAGE' && (
          <input
            type="number"
            min={0}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            style={{
              width: 80,
              padding: '6px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontFamily: 'var(--font-mono, monospace)',
              textAlign: 'right',
            }}
          />
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={c}
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                border: c === color ? '2px solid var(--text)' : '1px solid var(--border)',
                background: c,
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={!name.trim()}>
          {t('common.create')}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// New item form
// ============================================================================

function NewItemForm({
  parentKind,
  onCancel,
  onCreate,
}: {
  parentKind: BucketKind;
  onCancel: () => void;
  onCreate: (dto: CreateItemDto) => void | Promise<void>;
}) {
  const { toast } = useUI();
  const { t } = useT();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState<string>('');

  const submit = () => {
    const nm = name.trim();
    if (!nm) return toast(t('toast.error'), 'error');
    if (parentKind === 'FIXED_SUM') {
      const n = Number(amount);
      if (Number.isNaN(n) || n <= 0) return toast(t('toast.error'), 'error');
      onCreate({ name: nm, amountCents: Math.round(n * 100) });
    } else {
      onCreate({ name: nm, amountCents: null });
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 8px',
        background: 'var(--bg-soft)',
        borderRadius: 6,
        border: '1px dashed var(--border)',
      }}
    >
      <input
        placeholder={t('common.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{
          flex: '1 1 160px',
          padding: '4px 8px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
        }}
      />
      {parentKind === 'FIXED_SUM' && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            min={0}
            step={100}
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{
              width: 110,
              padding: '4px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontFamily: 'var(--font-mono, monospace)',
              textAlign: 'right',
              fontSize: 13,
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 10,
              color: 'var(--text-soft)',
              textTransform: 'uppercase',
            }}
          >
            TJS
          </span>
        </div>
      )}
      <button className="btn btn-sm btn-secondary" onClick={onCancel} style={{ padding: '2px 8px', fontSize: 11 }}>
        {t('common.cancel')}
      </button>
      <button className="btn btn-sm btn-primary" onClick={submit} style={{ padding: '2px 8px', fontSize: 11 }} disabled={!name.trim()}>
        {t('common.add')}
      </button>
    </div>
  );
}
