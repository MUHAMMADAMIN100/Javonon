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
  updateSubmission,
  updatePayment,
  deletePayment,
  deleteSubmission,
  type SubmissionPayment,
  type SubmissionPaymentMethod,
  type SaleSubmission,
  type UpdateSubmissionDto,
  type UpdatePaymentDto,
  PAYMENT_STATUS_LABEL,
  SUBMISSION_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
} from '../api/submissions';
import { listPrograms } from '../api/programs';
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
  const [showEditSubmission, setShowEditSubmission] = useState(false);
  const [editPaymentId, setEditPaymentId] = useState<string | null>(null);

  const deleteSubmissionMut = useMutation({
    mutationFn: () => deleteSubmission(id!),
    onSuccess: () => {
      toast('Сделка удалена', 'success');
      qc.invalidateQueries({ queryKey: ['submissions'] });
      navigate('/submissions');
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const deletePaymentMut = useMutation({
    mutationFn: (paymentId: string) => deletePayment(paymentId),
    onSuccess: (res) => {
      toast(res?.reversed ? 'Платёж удалён — Transaction реверсирован' : 'Платёж удалён', 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

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

  const onDeleteSubmission = () => {
    // window.confirm намеренно — по ТЗ, чтобы не «переоформлять» родной
    // диалог подтверждения (deleteSubmission — destructive, важен native modal).
    if (window.confirm('Удалить сделку и все её платежи? Уже одобренные Transaction останутся в финансах.')) {
      deleteSubmissionMut.mutate();
    }
  };

  const onDeletePayment = (p: SubmissionPayment) => {
    const msg = p.status === 'APPROVED'
      ? `Одобренный платёж будет откачен: EXPENSE-транзакция на ${p.amount.toLocaleString('ru-RU')} создастся. Продолжить?`
      : 'Удалить платёж?';
    if (window.confirm(msg)) {
      deletePaymentMut.mutate(p.id);
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
          {s.contractUrls?.map((u, i) => (
            <a
              key={`contract-${i}`}
              href={absUrl(u)}
              target="_blank"
              rel="noreferrer"
              className="btn btn-sm btn-secondary"
            >
              <Icon name="description" size={14} /> Контракт{s.contractUrls.length > 1 ? ` ${i + 1}` : ''}
            </a>
          ))}
          {s.newStudentPassportUrls?.map((u, i) => (
            <a
              key={`passport-${i}`}
              href={absUrl(u)}
              target="_blank"
              rel="noreferrer"
              className="btn btn-sm btn-secondary"
            >
              <Icon name="badge" size={14} /> Паспорт{s.newStudentPassportUrls.length > 1 ? ` ${i + 1}` : ''}
            </a>
          ))}
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

        {/* FOUNDER: редактирование и удаление сделки (доступно на любом статусе). */}
        {founder && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              borderTop: '1px solid var(--border-soft)',
              paddingTop: 12,
              marginTop: isOwnSubmission && s.status === 'ACTIVE' ? 12 : 0,
            }}
          >
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setShowEditSubmission(true)}
              disabled={deleteSubmissionMut.isPending}
            >
              <Icon name="edit" size={14} /> Редактировать сделку
            </button>
            <button
              className="btn btn-sm btn-danger"
              onClick={onDeleteSubmission}
              disabled={deleteSubmissionMut.isPending}
            >
              <Icon name="delete" size={14} /> {deleteSubmissionMut.isPending ? 'Удаляем…' : 'Удалить сделку'}
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
            canManage={founder}
            onEdit={() => setEditPaymentId(p.id)}
            onDelete={() => onDeletePayment(p)}
            manageBusy={deletePaymentMut.isPending}
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

      {showEditSubmission && (
        <EditSubmissionModal
          submission={s}
          onClose={() => setShowEditSubmission(false)}
          onSuccess={() => {
            setShowEditSubmission(false);
            qc.invalidateQueries({ queryKey: ['submission', id] });
            qc.invalidateQueries({ queryKey: ['submissions'] });
            toast('Сделка обновлена', 'success');
          }}
        />
      )}

      {editPaymentId && (() => {
        const payment = s.payments.find((p) => p.id === editPaymentId);
        if (!payment) return null;
        return (
          <EditPaymentModal
            payment={payment}
            currency={s.currency}
            onClose={() => setEditPaymentId(null)}
            onSuccess={() => {
              setEditPaymentId(null);
              qc.invalidateQueries({ queryKey: ['submission', id] });
              qc.invalidateQueries({ queryKey: ['submissions'] });
              toast('Платёж обновлён', 'success');
            }}
          />
        );
      })()}
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
  canManage, onEdit, onDelete, manageBusy,
}: {
  p: SubmissionPayment;
  currency: string;
  canReview: boolean;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  manageBusy: boolean;
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
        {p.receiptUrls?.map((u, i) => (
          <a
            key={`receipt-${i}`}
            href={absUrl(u)}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-secondary"
          >
            <Icon name="image" size={14} /> Чек{p.receiptUrls.length > 1 ? ` ${i + 1}` : ''}
          </a>
        ))}
        {p.depositProofUrls?.map((u, i) => (
          <a
            key={`deposit-${i}`}
            href={absUrl(u)}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-secondary"
          >
            <Icon name="image" size={14} /> Депозит{p.depositProofUrls.length > 1 ? ` ${i + 1}` : ''}
          </a>
        ))}
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

      {canManage && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 10 }}>
          <button
            className="btn btn-sm btn-secondary"
            onClick={onEdit}
            disabled={manageBusy || p.status === 'REJECTED'}
            title={p.status === 'REJECTED' ? 'Отклонённый платёж редактировать нельзя' : undefined}
          >
            <Icon name="edit" size={14} /> Редактировать
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={onDelete}
            disabled={manageBusy}
          >
            <Icon name="delete" size={14} /> Удалить
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
  const [receiptUrls, setReceiptUrls] = useState<string[]>([]);
  const [depositProofUrls, setDepositProofUrls] = useState<string[]>([]);
  const [nextDueDate, setNextDueDate] = useState('');
  const [nextDueAmount, setNextDueAmount] = useState('');
  const [notes, setNotes] = useState('');

  const mut = useMutation({
    mutationFn: () => addPayment(submissionId, {
      amount: parseFloat(amount),
      paymentMethod: method,
      paidAt,
      receiptUrls: receiptUrls.length ? receiptUrls : undefined,
      depositProofUrls: depositProofUrls.length ? depositProofUrls : undefined,
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
    if (method === 'TRANSFER' && receiptUrls.length === 0) return toast('Прикрепите чек', 'error');
    if (method === 'CASH' && depositProofUrls.length === 0) return toast('Прикрепите скрин пополнения', 'error');
    mut.mutate();
  };

  const isDirty = Boolean(
    amount || receiptUrls.length || depositProofUrls.length || notes.trim() || nextDueDate || nextDueAmount,
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
              <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
            </Field>
          )}
          {method === 'CASH' && (
            <Field label="Скрин пополнения *">
              <UploadInlineMulti values={depositProofUrls} onChange={setDepositProofUrls} />
            </Field>
          )}
          {method === 'OTHER' && (
            <Field label="Подтверждение">
              <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
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

/**
 * FOUNDER-only модалка редактирования сделки.
 * После firstApprovedAt поля студента/программы «заморожены» — бэк молча
 * игнорит их (см. submissions.service.ts:updateSubmission), но UX явно
 * дизейблит инпуты с подсказкой, чтобы FOUNDER понимал почему.
 */
function EditSubmissionModal({
  submission, onClose, onSuccess,
}: {
  submission: SaleSubmission;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast, confirm } = useUI();
  const frozen = !!submission.firstApprovedAt;

  const [contractUrls, setContractUrls] = useState<string[]>(submission.contractUrls || []);
  const [totalAmount, setTotalAmount] = useState<string>(String(submission.totalAmount ?? ''));
  const [currency, setCurrency] = useState<string>(submission.currency || 'USD');
  const [notes, setNotes] = useState<string>(submission.notes || '');
  const [newStudentName, setNewStudentName] = useState<string>(submission.newStudentName || '');
  const [newStudentPhone, setNewStudentPhone] = useState<string>(submission.newStudentPhone || '');
  const [newStudentEmail, setNewStudentEmail] = useState<string>(submission.newStudentEmail || '');
  const [newStudentPassportUrls, setNewStudentPassportUrls] = useState<string[]>(submission.newStudentPassportUrls || []);
  const [programId, setProgramId] = useState<string>(submission.programId || '');

  const programsQ = useQuery({
    queryKey: ['programs', 'edit-submission'],
    queryFn: () => listPrograms(),
    // programs подтягиваем только если поле доступно — экономим запрос
    // на «замороженных» сделках.
    enabled: !frozen,
  });

  const mut = useMutation({
    mutationFn: () => {
      const dto: UpdateSubmissionDto = {
        contractUrls,
        totalAmount: parseFloat(totalAmount),
        currency,
        notes: notes.trim() || null,
      };
      if (!frozen) {
        dto.newStudentName = newStudentName.trim() || null;
        dto.newStudentPhone = newStudentPhone.trim() || null;
        dto.newStudentEmail = newStudentEmail.trim() || null;
        dto.newStudentPassportUrls = newStudentPassportUrls;
        if (programId) dto.programId = programId;
      }
      return updateSubmission(submission.id, dto);
    },
    onSuccess,
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onSubmit = () => {
    const a = parseFloat(totalAmount);
    if (!isFinite(a) || a <= 0) return toast('Сумма контракта должна быть > 0', 'error');
    if (contractUrls.length === 0) return toast('Загрузите минимум 1 файл контракта', 'error');
    mut.mutate();
  };

  const attemptClose = async () => {
    if (mut.isPending) return;
    const ok = await confirm({
      title: 'Закрыть без сохранения?',
      message: 'Изменения будут потеряны.',
      confirmText: 'Закрыть',
      cancelText: 'Продолжить',
      danger: true,
    });
    if (ok) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void attemptClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mut.isPending]);

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
        style={{ maxWidth: 640, textAlign: 'left', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>Редактировать сделку</h3>

        {frozen && (
          <div style={{
            padding: 10,
            background: '#fef3c7',
            borderRadius: 8,
            fontSize: 12,
            color: '#78350f',
            marginBottom: 12,
          }}>
            Часть полей заморожена: студент/заявка/программа уже созданы после первого одобрения.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <Field label="Сумма контракта *">
            <input
              className="crm-input"
              type="number"
              min={0}
              step={50}
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
            />
          </Field>
          <Field label="Валюта">
            <select className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="UZS">UZS</option>
              <option value="CNY">CNY</option>
              <option value="EUR">EUR</option>
              <option value="RUB">RUB</option>
            </select>
          </Field>
        </div>

        <div style={{ marginTop: 10 }}>
          <Field label="Контракт (файлы) *">
            <UploadInlineMulti values={contractUrls} onChange={setContractUrls} />
          </Field>
        </div>

        <div style={{ marginTop: 10 }}>
          <Field label="Комментарий">
            <textarea
              className="crm-textarea"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ resize: 'none' }}
            />
          </Field>
        </div>

        <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 14, paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-soft)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Студент / Программа {frozen && '(заморожено)'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <Field label="ФИО студента">
              <input
                className="crm-input"
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                disabled={frozen}
                title={frozen ? 'Заморожено (студент/заявка уже созданы)' : undefined}
              />
            </Field>
            <Field label="Телефон">
              <input
                className="crm-input"
                value={newStudentPhone}
                onChange={(e) => setNewStudentPhone(e.target.value)}
                disabled={frozen}
                title={frozen ? 'Заморожено (студент/заявка уже созданы)' : undefined}
              />
            </Field>
            <Field label="Email">
              <input
                className="crm-input"
                value={newStudentEmail}
                onChange={(e) => setNewStudentEmail(e.target.value)}
                disabled={frozen}
                title={frozen ? 'Заморожено (студент/заявка уже созданы)' : undefined}
              />
            </Field>
            <Field label="Программа">
              <select
                className="crm-select"
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
                disabled={frozen}
                title={frozen ? 'Заморожено (студент/заявка уже созданы)' : undefined}
              >
                {frozen && submission.program && (
                  <option value={submission.programId}>{submission.program.name} · {submission.program.university}</option>
                )}
                {!frozen && programsQ.data?.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.university}</option>
                ))}
              </select>
            </Field>
          </div>

          <div style={{ marginTop: 10 }}>
            <Field label="Паспорт студента (файлы)">
              {frozen ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }} title="Заморожено (студент/заявка уже созданы)">
                  Заморожено — файлы паспорта уже сохранены в Student/Document.
                </div>
              ) : (
                <UploadInlineMulti values={newStudentPassportUrls} onChange={setNewStudentPassportUrls} />
              )}
            </Field>
          </div>
        </div>

        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={mut.isPending}>Отмена</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={mut.isPending}>
            {mut.isPending ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * FOUNDER-only модалка редактирования платежа.
 * REJECTED — форма показана disabled с подсказкой, submit заблокирован.
 * APPROVED — сверху плашка «синхронизация с Transaction».
 */
function EditPaymentModal({
  payment, currency, onClose, onSuccess,
}: {
  payment: SubmissionPayment;
  currency: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast, confirm } = useUI();
  const readOnly = payment.status === 'REJECTED';

  const [amount, setAmount] = useState<string>(String(payment.amount ?? ''));
  const [method, setMethod] = useState<SubmissionPaymentMethod>(payment.paymentMethod);
  const [paidAt, setPaidAt] = useState<string>(
    payment.paidAt ? new Date(payment.paidAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
  );
  const [receiptUrls, setReceiptUrls] = useState<string[]>(payment.receiptUrls || []);
  const [depositProofUrls, setDepositProofUrls] = useState<string[]>(payment.depositProofUrls || []);
  const [nextDueDate, setNextDueDate] = useState<string>(
    payment.nextDueDate ? new Date(payment.nextDueDate).toISOString().slice(0, 10) : '',
  );
  const [nextDueAmount, setNextDueAmount] = useState<string>(
    payment.nextDueAmount != null ? String(payment.nextDueAmount) : '',
  );
  const [notes, setNotes] = useState<string>(payment.notes || '');

  const mut = useMutation({
    mutationFn: () => {
      const dto: UpdatePaymentDto = {
        amount: parseFloat(amount),
        paymentMethod: method,
        paidAt,
        receiptUrls,
        depositProofUrls,
        nextDueDate: nextDueDate || null,
        nextDueAmount: nextDueAmount ? parseFloat(nextDueAmount) : null,
        notes: notes.trim() || null,
      };
      return updatePayment(payment.id, dto);
    },
    onSuccess,
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onSubmit = () => {
    if (readOnly) return;
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0) return toast('Сумма должна быть > 0', 'error');
    if (method === 'TRANSFER' && receiptUrls.length === 0) return toast('Прикрепите чек', 'error');
    if (method === 'CASH' && depositProofUrls.length === 0) return toast('Прикрепите скрин пополнения', 'error');
    mut.mutate();
  };

  const attemptClose = async () => {
    if (mut.isPending) return;
    if (readOnly) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: 'Закрыть без сохранения?',
      message: 'Изменения будут потеряны.',
      confirmText: 'Закрыть',
      cancelText: 'Продолжить',
      danger: true,
    });
    if (ok) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void attemptClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mut.isPending, readOnly]);

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
        style={{ maxWidth: 560, textAlign: 'left', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>Редактировать платёж</h3>

        {payment.status === 'APPROVED' && (
          <div style={{
            padding: 10,
            background: '#dcfce7',
            borderRadius: 8,
            fontSize: 12,
            color: '#166534',
            marginBottom: 12,
          }}>
            Изменения синхронизируются с финансовой транзакцией.
          </div>
        )}
        {readOnly && (
          <div style={{
            padding: 10,
            background: '#fef2f2',
            borderRadius: 8,
            fontSize: 12,
            color: '#b91c1c',
            marginBottom: 12,
          }}>
            Отклонённый платёж редактировать нельзя.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <Field label={`Сумма (${currency}) *`}>
            <input
              className="crm-input"
              type="number"
              min={0}
              step={50}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={readOnly}
            />
          </Field>
          <Field label="Метод">
            <select
              className="crm-select"
              value={method}
              onChange={(e) => setMethod(e.target.value as SubmissionPaymentMethod)}
              disabled={readOnly}
            >
              <option value="TRANSFER">Перевод</option>
              <option value="CASH">Наличные</option>
              <option value="OTHER">Прочее</option>
            </select>
          </Field>
          <Field label="Дата оплаты">
            <CrmDatePicker value={paidAt} onChange={setPaidAt} disabled={readOnly} />
          </Field>
          {method === 'TRANSFER' && (
            <Field label="Чек *">
              {readOnly ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>Файлы редактировать нельзя.</div>
              ) : (
                <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
              )}
            </Field>
          )}
          {method === 'CASH' && (
            <Field label="Скрин пополнения *">
              {readOnly ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>Файлы редактировать нельзя.</div>
              ) : (
                <UploadInlineMulti values={depositProofUrls} onChange={setDepositProofUrls} />
              )}
            </Field>
          )}
          {method === 'OTHER' && (
            <Field label="Подтверждение">
              {readOnly ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>Файлы редактировать нельзя.</div>
              ) : (
                <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
              )}
            </Field>
          )}
          <Field label="Следующий платёж: дата">
            <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} disabled={readOnly} />
          </Field>
          <Field label="Следующий платёж: сумма">
            <input
              className="crm-input"
              type="number"
              min={0}
              step={50}
              value={nextDueAmount}
              onChange={(e) => setNextDueAmount(e.target.value)}
              disabled={readOnly}
            />
          </Field>
        </div>

        <div style={{ marginTop: 10 }}>
          <Field label="Комментарий">
            <textarea
              className="crm-textarea"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ resize: 'none' }}
              disabled={readOnly}
            />
          </Field>
        </div>

        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={mut.isPending}>Отмена</button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={mut.isPending || readOnly}
            title={readOnly ? 'Отклонённый платёж редактировать нельзя' : undefined}
          >
            {mut.isPending ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function UploadInlineMulti({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const { toast } = useUI();
  const [uploading, setUploading] = useState(false);
  const handle = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const f of Array.from(files)) {
        const r = await uploadSubmissionFile(f);
        uploaded.push(r.url);
      }
      onChange([...values, ...uploaded]);
    } catch (e: any) {
      toast(e?.response?.data?.message || 'Ошибка', 'error');
    } finally {
      setUploading(false);
    }
  };
  const removeAt = (i: number) => {
    onChange(values.filter((_, idx) => idx !== i));
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        type="file"
        accept="image/*,application/pdf"
        multiple
        disabled={uploading}
        onChange={(e) => {
          void handle(e.target.files);
          e.target.value = '';
        }}
        style={{ fontSize: 12 }}
      />
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((_, i) => (
            <span
              key={i}
              style={{
                fontSize: 11,
                color: 'var(--primary-dark)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              ✓ файл {i + 1}
              <button
                type="button"
                onClick={() => removeAt(i)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-soft)',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: 12,
                  lineHeight: 1,
                }}
                aria-label="Удалить"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
