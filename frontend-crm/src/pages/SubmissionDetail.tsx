import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isFounder } from '../lib/roles';
import { useRealtime } from '../realtime';
import { useUI } from '../ui/Dialogs';
import {
  getSubmission,
  approvePayment,
  rejectPayment,
  addPayment,
  changeSubmissionStatus,
  uploadSubmissionFile,
  type SubmissionPayment,
  type SubmissionPaymentMethod,
  PAYMENT_STATUS_LABEL,
  SUBMISSION_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
} from '../api/submissions';
import Icon from '../Icon';
import CrmDatePicker from '../components/CrmDatePicker';
import { absFileUrl as absUrl } from '../lib/fileUrl';

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: '#0ea5e9',
  COMPLETED: '#10b981',
  CANCELLED: '#94a3b8',
  PENDING: '#fbbf24',
  APPROVED: '#10b981',
  REJECTED: '#ef4444',
};

export default function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { toast, confirm } = useUI();
  const qc = useQueryClient();
  const founder = isFounder(me);

  const query = useQuery({
    queryKey: ['submission', id],
    queryFn: () => getSubmission(id!),
    enabled: !!id,
  });
  const s = query.data;

  const approveMut = useMutation({
    mutationFn: (paymentId: string) => approvePayment(paymentId),
    onSuccess: () => {
      toast('Платёж одобрен — доход и бонус начислены', 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) => rejectPayment(paymentId, reason),
    onSuccess: () => {
      toast('Платёж отклонён', 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const statusMut = useMutation({
    mutationFn: (status: 'COMPLETED' | 'CANCELLED') => changeSubmissionStatus(id!, status),
    onSuccess: () => {
      toast('Статус обновлён', 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  // Realtime: обновляем детальный экран при любых событиях по сделке/платежу.
  // Инвалидируем и единичный ['submission', id], и список ['submissions'].
  useRealtime({
    'submission:new': () => qc.invalidateQueries({ queryKey: ['submissions'] }),
    'submission:payment-new': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    'submission:reviewed': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    'submission:approved': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    'submission:rejected': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
  });

  const [showAddPayment, setShowAddPayment] = useState(false);
  const [rejectPaymentId, setRejectPaymentId] = useState<string | null>(null);

  if (query.isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  if (!s) return <div className="card" style={{ padding: 24 }}>Сделка не найдена</div>;

  const studentName = s.student?.fullName || s.newStudentName || '—';
  const totalPaid = s.payments.filter((p) => p.status === 'APPROVED').reduce((sum, p) => sum + p.amount, 0);
  const remaining = Math.max(0, s.totalAmount - totalPaid);
  const isOwnSubmission = s.managerId === me?.id;

  const onReject = (paymentId: string) => {
    setRejectPaymentId(paymentId);
  };

  const onComplete = async () => {
    if (await confirm({ title: 'Закрыть сделку?', message: 'Контракт оплачен полностью.' })) {
      statusMut.mutate('COMPLETED');
    }
  };
  const onCancel = async () => {
    if (await confirm({ title: 'Отменить сделку?', message: 'Студент отказался или возврат.' })) {
      statusMut.mutate('CANCELLED');
    }
  };

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-secondary" onClick={() => navigate('/submissions')}>
          <Icon name="arrow_back" size={16} /> Назад к списку
        </button>
      </div>

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 24, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Сделка</div>
            <h2 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0' }}>{studentName}</h2>
            <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>
              {s.program?.name} · {s.program?.university}
            </div>
            {s.manager && (
              <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
                Менеджер: {s.manager.fullName}
              </div>
            )}
          </div>
          <span
            style={{
              padding: '6px 14px',
              borderRadius: 999,
              background: STATUS_COLOR[s.status] + '22',
              color: STATUS_COLOR[s.status],
              fontSize: 13,
              fontWeight: 600,
              border: `1.5px solid ${STATUS_COLOR[s.status]}`,
            }}
          >
            {SUBMISSION_STATUS_LABEL[s.status]}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 16 }}>
          <Stat label="Контракт" value={`${s.totalAmount.toLocaleString('ru-RU')} ${s.currency}`} />
          <Stat label="Оплачено" value={`${totalPaid.toLocaleString('ru-RU')} ${s.currency}`} highlight />
          <Stat label="Остаток" value={`${remaining.toLocaleString('ru-RU')} ${s.currency}`} />
          <Stat label="Платежей" value={String(s.payments.length)} />
        </div>

        {/* Файлы — паспорт + контракт */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {s.contractUrl && (
            <a href={absUrl(s.contractUrl)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
              <Icon name="description" size={14} /> Контракт
            </a>
          )}
          {s.newStudentPassportUrl && (
            <a href={absUrl(s.newStudentPassportUrl)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
              <Icon name="badge" size={14} /> Паспорт
            </a>
          )}
        </div>

        {s.notes && (
          <div style={{ padding: 12, background: 'var(--bg-soft)', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
            <strong>Комментарий:</strong> {s.notes}
          </div>
        )}

        {/* Кнопки менеджера */}
        {isOwnSubmission && s.status === 'ACTIVE' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
            <button className="btn btn-sm btn-primary" onClick={() => setShowAddPayment(true)}>
              <Icon name="add" size={14} /> Добавить платёж
            </button>
            <button className="btn btn-sm btn-secondary" onClick={onComplete}>
              <Icon name="check" size={14} /> Закрыть сделку
            </button>
            <button className="btn btn-sm btn-danger" onClick={onCancel}>
              <Icon name="close" size={14} /> Отменить
            </button>
          </div>
        )}
      </motion.div>

      {/* Платежи */}
      <h3 style={{ fontSize: 16, marginBottom: 12 }}>Платежи ({s.payments.length})</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {s.payments.map((p) => (
          <PaymentRow
            key={p.id}
            p={p}
            currency={s.currency}
            canReview={founder && p.status === 'PENDING' && s.status === 'ACTIVE' && !isOwnSubmission}
            onApprove={() => approveMut.mutate(p.id)}
            onReject={() => onReject(p.id)}
            busy={approveMut.isPending || rejectMut.isPending}
          />
        ))}
      </div>

      {showAddPayment && (
        <AddPaymentModal
          submissionId={s.id}
          currency={s.currency}
          onClose={() => setShowAddPayment(false)}
          onSuccess={() => {
            setShowAddPayment(false);
            qc.invalidateQueries({ queryKey: ['submission', id] });
            toast('Платёж добавлен', 'success');
          }}
        />
      )}

      {rejectPaymentId && (
        <RejectReasonModal
          busy={rejectMut.isPending}
          onClose={() => {
            if (!rejectMut.isPending) setRejectPaymentId(null);
          }}
          onSubmit={(reason) => {
            rejectMut.mutate(
              { paymentId: rejectPaymentId, reason },
              { onSuccess: () => setRejectPaymentId(null) },
            );
          }}
        />
      )}
    </>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        fontSize: 20,
        color: highlight ? 'var(--primary-dark)' : 'var(--text)',
      }}>{value}</div>
    </div>
  );
}

function PaymentRow({
  p, currency, canReview, onApprove, onReject, busy,
}: {
  p: SubmissionPayment;
  currency: string;
  canReview: boolean;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      style={{ padding: 16 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 18 }}>
            {p.amount.toLocaleString('ru-RU')} {currency}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2 }}>
            {new Date(p.paidAt).toLocaleDateString('ru-RU')} · {PAYMENT_METHOD_LABEL[p.paymentMethod]}
          </div>
        </div>
        <span
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            background: STATUS_COLOR[p.status] + '22',
            color: STATUS_COLOR[p.status],
            fontSize: 12,
            fontWeight: 600,
            border: `1.5px solid ${STATUS_COLOR[p.status]}`,
          }}
        >
          {PAYMENT_STATUS_LABEL[p.status]}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {p.receiptUrl && (
          <a href={absUrl(p.receiptUrl)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
            <Icon name="image" size={14} /> Чек
          </a>
        )}
        {p.depositProofUrl && (
          <a href={absUrl(p.depositProofUrl)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
            <Icon name="image" size={14} /> Депозит
          </a>
        )}
      </div>

      {p.nextDueDate && (
        <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 8 }}>
          Следующий платёж: {new Date(p.nextDueDate).toLocaleDateString('ru-RU')}
          {p.nextDueAmount ? ` · ${p.nextDueAmount.toLocaleString('ru-RU')} ${currency}` : ''}
        </div>
      )}

      {p.rejectReason && (
        <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 8, padding: 8, background: '#fef2f2', borderRadius: 6 }}>
          <strong>Отклонено:</strong> {p.rejectReason}
        </div>
      )}

      {p.notes && (
        <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 8 }}>
          {p.notes}
        </div>
      )}

      {canReview && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 10 }}>
          <button className="btn btn-sm btn-danger" onClick={onReject} disabled={busy}>
            <Icon name="close" size={14} /> Отклонить
          </button>
          <button className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy}>
            <Icon name="check" size={14} /> Одобрить
          </button>
        </div>
      )}
    </motion.div>
  );
}

function AddPaymentModal({
  submissionId, currency, onClose, onSuccess,
}: {
  submissionId: string;
  currency: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast, confirm } = useUI();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SubmissionPaymentMethod>('TRANSFER');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [receiptUrl, setReceiptUrl] = useState('');
  const [depositProofUrl, setDepositProofUrl] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [nextDueAmount, setNextDueAmount] = useState('');
  const [notes, setNotes] = useState('');

  const mut = useMutation({
    mutationFn: () => addPayment(submissionId, {
      amount: parseFloat(amount),
      paymentMethod: method,
      paidAt,
      receiptUrl: receiptUrl || undefined,
      depositProofUrl: depositProofUrl || undefined,
      nextDueDate: nextDueDate || null,
      nextDueAmount: nextDueAmount ? parseFloat(nextDueAmount) : null,
      notes: notes.trim() || undefined,
    }),
    onSuccess,
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onSubmit = () => {
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0) return toast('Сумма должна быть > 0', 'error');
    if (method === 'TRANSFER' && !receiptUrl) return toast('Прикрепите чек', 'error');
    if (method === 'CASH' && !depositProofUrl) return toast('Прикрепите скрин пополнения', 'error');
    mut.mutate();
  };

  const isDirty = Boolean(
    amount || receiptUrl || depositProofUrl || notes.trim() || nextDueDate || nextDueAmount,
  );

  const attemptClose = async () => {
    if (mut.isPending) return;
    if (!isDirty) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: 'Закрыть без сохранения?',
      message: 'Введённые данные и прикреплённые файлы будут потеряны.',
      confirmText: 'Закрыть',
      cancelText: 'Продолжить ввод',
      danger: true,
    });
    if (ok) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        attemptClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, mut.isPending]);

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={attemptClose}
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520, textAlign: 'left' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>Добавить платёж</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <Field label={`Сумма (${currency}) *`}>
            <input className="crm-input" type="number" min={0} step={50} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Метод">
            <select className="crm-select" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="TRANSFER">Перевод</option>
              <option value="CASH">Наличные</option>
              <option value="OTHER">Прочее</option>
            </select>
          </Field>
          <Field label="Дата оплаты">
            <CrmDatePicker value={paidAt} onChange={setPaidAt} />
          </Field>
          {method === 'TRANSFER' && (
            <Field label="Чек *">
              <UploadInline value={receiptUrl} onChange={setReceiptUrl} />
            </Field>
          )}
          {method === 'CASH' && (
            <Field label="Скрин пополнения *">
              <UploadInline value={depositProofUrl} onChange={setDepositProofUrl} />
            </Field>
          )}
          {method === 'OTHER' && (
            <Field label="Подтверждение">
              <UploadInline value={receiptUrl} onChange={setReceiptUrl} />
            </Field>
          )}
          <Field label="Следующий платёж: дата">
            <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} />
          </Field>
          <Field label="Следующий платёж: сумма">
            <input className="crm-input" type="number" min={0} step={50} value={nextDueAmount} onChange={(e) => setNextDueAmount(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="Комментарий">
            <textarea className="crm-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: 'none' }} />
          </Field>
        </div>
        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={mut.isPending}>Отмена</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={mut.isPending}>
            {mut.isPending ? 'Отправляем…' : 'Добавить'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const REJECT_REASON_MAX = 500;

function RejectReasonModal({
  busy, onClose, onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const { confirm } = useUI();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const isValid = trimmed.length > 0 && reason.length <= REJECT_REASON_MAX;

  const handleSubmit = () => {
    if (!isValid || busy) return;
    onSubmit(trimmed);
  };

  const attemptClose = async () => {
    if (busy) return;
    if (!trimmed) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: 'Закрыть без отклонения?',
      message: 'Введённая причина будет потеряна.',
      confirmText: 'Закрыть',
      cancelText: 'Продолжить ввод',
      danger: true,
    });
    if (ok) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        attemptClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, trimmed]);

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={attemptClose}
    >
      <motion.div
        className="dialog-card"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 480, textAlign: 'left' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>Отклонить платёж</h3>
        <Field label="Причина отклонения *">
          <textarea
            className="crm-textarea"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REJECT_REASON_MAX))}
            maxLength={REJECT_REASON_MAX}
            placeholder="Опишите, почему платёж отклонён"
            autoFocus
            disabled={busy}
            style={{ resize: 'none', width: '100%' }}
          />
        </Field>
        <div style={{ fontSize: 11, color: 'var(--text-soft)', textAlign: 'right', marginTop: 4 }}>
          {reason.length} / {REJECT_REASON_MAX}
        </div>
        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={busy}>Отмена</button>
          <button className="btn btn-danger" onClick={handleSubmit} disabled={!isValid || busy}>
            {busy ? 'Отклоняем…' : 'Отклонить'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function UploadInline({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  const handle = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await uploadSubmissionFile(file);
      onChange(r.url);
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setUploading(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input type="file" accept="image/*,application/pdf" disabled={uploading} onChange={(e) => handle(e.target.files?.[0] || null)} style={{ fontSize: 12 }} />
      {value && <span style={{ fontSize: 11, color: 'var(--primary-dark)' }}>✓ загружено</span>}
    </div>
  );
}
