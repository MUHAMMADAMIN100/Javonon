import { useState, useEffect } from 'react';
import CrmSelect from '../components/CrmSelect';
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
  SUBMISSION_CURRENCIES,
  SUBMISSION_CURRENCY_LABEL,
} from '../api/submissions';
import { listPrograms } from '../api/programs';
import Icon from '../Icon';
import CrmDatePicker from '../components/CrmDatePicker';
import PartnerAttributionCard from '../components/PartnerAttributionCard';
import PaymentStagesSection from '../components/PaymentStagesSection';
import BackButton from '../components/BackButton';
import { absFileUrl as absUrl } from '../lib/fileUrl';
import { keys } from '../lib/queryKeys';
import { useT } from '../lib/i18n';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';

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
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) => rejectPayment(paymentId, reason),
    onSuccess: () => {
      toast('Платёж отклонён', 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const statusMut = useMutation({
    mutationFn: (status: 'COMPLETED' | 'CANCELLED') => changeSubmissionStatus(id!, status),
    onSuccess: () => {
      toast('Статус обновлён', 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
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
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    'submission:reviewed': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    'submission:approved': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    'submission:rejected': () => {
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
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
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const paySort = useTableSort(
    s?.payments ?? [],
    [
      { key: 'amount', label: 'Сумма', type: 'number', value: (p) => p.amount },
      { key: 'paidAt', label: 'Дата оплаты', type: 'date', value: (p) => p.paidAt },
      { key: 'method', label: 'Способ', value: (p) => PAYMENT_METHOD_LABEL[p.paymentMethod] },
      { key: 'files', label: 'Файлы', type: 'number', value: (p) => (p.receiptUrls?.length ?? 0) + (p.depositProofUrls?.length ?? 0) },
      { key: 'next', label: 'Следующий платёж', type: 'date', value: (p) => p.nextDueDate },
      { key: 'comment', label: 'Комментарий', value: (p) => p.rejectReason || p.notes },
      { key: 'status', label: 'Статус', value: (p) => PAYMENT_STATUS_LABEL[p.status] },
    ],
    { param: 'sortPayments' },
  );

  if (query.isLoading) return <div className="card" style={{ padding: 24 }}>Загружаем…</div>;
  if (!s) {
    return (
      <>
        <BackButton fallback="/submissions" />
        <div className="card" style={{ padding: 24 }}>Сделка не найдена</div>
      </>
    );
  }

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

  // Окно подтверждения — своё, как во всей CRM, а не серое браузерное.
  const onDeletePayment = async (p: SubmissionPayment) => {
    const ok = await confirm({
      title: 'Удалить платёж?',
      message: p.status === 'APPROVED'
        ? `Платёж уже одобрен: доход по нему будет отменён обратной записью на ${p.amount.toLocaleString('ru-RU')} ${s?.currency ?? ''}.`
        : `${p.amount.toLocaleString('ru-RU')} ${s?.currency ?? ''} от ${new Date(p.paidAt).toLocaleDateString('ru-RU')}`,
      confirmText: 'Удалить',
      danger: true,
    });
    if (ok) deletePaymentMut.mutate(p.id);
  };

  return (
    <>
      <BackButton fallback="/submissions" />

      <motion.div
        className="card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: 24, marginBottom: 16 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Сделка</div>
            <h2 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{studentName}</h2>
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

        {/* Блок «Партнёр» — сразу под строкой менеджера. Рисуется, только если
            бэкенд положил partnerAttribution в ответ: поле приходит ТОЛЬКО
            руководству (FOUNDER/ADMIN/ACCOUNTANT) и только у партнёрских
            клиентов. У менеджера-владельца сделки ключа в JSON нет вовсе,
            поэтому компонент возвращает null и блока не существует. */}
        <PartnerAttributionCard attribution={s.partnerAttribution} />

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

        {/* Кнопки редактирования/удаления:
            - «Редактировать сделку»: FOUNDER всегда; менеджер-владелец только
              для своей сделки (в service заморожены studentId/newStudent/programId
              после первого APPROVE)
            - «Удалить сделку»: только FOUNDER (destructive; менеджер идёт к нему) */}
        {(founder || isOwnSubmission) && (
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
            {founder && (
              <button
                className="btn btn-sm btn-danger"
                onClick={onDeleteSubmission}
                disabled={deleteSubmissionMut.isPending}
              >
                <Icon name="delete" size={14} /> {deleteSubmissionMut.isPending ? 'Удаляем…' : 'Удалить сделку'}
              </button>
            )}
          </div>
        )}
      </motion.div>

      {/* Рассрочка — этапы оплаты сделки.
          Секция сама себя прячет, если у сделки нет этапов (у программы
          пустой шаблон = платят разом). Правит этапы тот же, кто правит
          сделку: FOUNDER/ADMIN либо менеджер-владелец. Пометить этап
          оплаченным отсюда НЕЛЬЗЯ — это делает только одобрение платежа. */}
      <PaymentStagesSection submissionId={s.id} canEdit={founder || isOwnSubmission} />

      {/* Платежи */}
      <h3 style={{ fontSize: 16, marginTop: 24, marginBottom: 12 }}>Платежи ({s.payments.length})</h3>
      {/* Таблицей, а не карточкой на платёж: у карточки половина места
          уходила на пустые поля и отдельные полосы под кнопки. */}
      {s.payments.length > 0 && (
      <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
      <SortSelect sort={paySort} />
      <table className="table payments-table" data-testid="payments-table">
        <thead>
          <tr>
            {paySort.columns.map((c) => <SortTh key={c.key} sort={paySort} col={c.key} />)}
            <th />
          </tr>
        </thead>
        <tbody>
        {paySort.sorted.map((p) => (
          <PaymentRow
            key={p.id}
            p={p}
            currency={s.currency}
            canReview={founder && p.status === 'PENDING' && s.status === 'ACTIVE' && !isOwnSubmission}
            onApprove={() => approveMut.mutate(p.id)}
            onReject={() => onReject(p.id)}
            busy={approveMut.isPending || rejectMut.isPending}
            /* Управление платежом — только FOUNDER.
               Менеджер добавляет платежи, но менять/удалять уже отправленные
               (даже свои PENDING) не может: одобрение/отклонение — прерогатива
               FOUNDER, а APPROVED затрагивают доход. */
            canManage={founder}
            /* Удаление только FOUNDER — реверс Transaction для APPROVED —
               бухгалтерская операция */
            canDelete={founder}
            onEdit={() => setEditPaymentId(p.id)}
            onDelete={() => onDeletePayment(p)}
            manageBusy={deletePaymentMut.isPending}
          />
        ))}
        </tbody>
      </table>
      </div>
      </div>
      )}

      {showAddPayment && (
        <AddPaymentModal
          submissionId={s.id}
          currency={s.currency}
          onClose={() => setShowAddPayment(false)}
          onSuccess={() => {
            setShowAddPayment(false);
            qc.invalidateQueries({ queryKey: ['submission', id] });
            qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
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
          founder={founder}
          onClose={() => setShowEditSubmission(false)}
          onSuccess={() => {
            setShowEditSubmission(false);
            qc.invalidateQueries({ queryKey: ['submission', id] });
            qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
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
              qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
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
  canManage, canDelete, onEdit, onDelete, manageBusy,
}: {
  p: SubmissionPayment;
  currency: string;
  canReview: boolean;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
  canManage: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  manageBusy: boolean;
}) {
  const muted = { color: 'var(--text-light)' };
  return (
    <tr data-testid={`payment-row-${p.id}`}>
      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {p.amount.toLocaleString('ru-RU')} {currency}
      </td>
      <td data-label="Дата оплаты" style={{ whiteSpace: 'nowrap' }}>{new Date(p.paidAt).toLocaleDateString('ru-RU')}</td>
      <td data-label="Способ">{PAYMENT_METHOD_LABEL[p.paymentMethod]}</td>
      <td data-label="Файлы">
        {(p.receiptUrls?.length ?? 0) + (p.depositProofUrls?.length ?? 0) === 0 ? (
          <span style={muted}>—</span>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {p.receiptUrls?.map((u, i) => (
              <a key={`receipt-${i}`} href={absUrl(u)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
                <Icon name="image" size={14} /> Чек{p.receiptUrls.length > 1 ? ` ${i + 1}` : ''}
              </a>
            ))}
            {p.depositProofUrls?.map((u, i) => (
              <a key={`deposit-${i}`} href={absUrl(u)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
                <Icon name="image" size={14} /> Депозит{p.depositProofUrls.length > 1 ? ` ${i + 1}` : ''}
              </a>
            ))}
          </div>
        )}
      </td>
      <td data-label="Следующий платёж" style={{ whiteSpace: 'nowrap' }}>
        {p.nextDueDate ? (
          <>
            {new Date(p.nextDueDate).toLocaleDateString('ru-RU')}
            {p.nextDueAmount ? (
              <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>
                {p.nextDueAmount.toLocaleString('ru-RU')} {currency}
              </div>
            ) : null}
          </>
        ) : (
          <span style={muted}>—</span>
        )}
      </td>
      <td data-label="Комментарий" style={{ fontSize: 13, maxWidth: 260 }}>
        {p.rejectReason && (
          <div style={{ color: '#b91c1c' }}>
            <strong>Отклонено:</strong> {p.rejectReason}
          </div>
        )}
        {p.notes && <div style={{ color: 'var(--text-soft)' }}>{p.notes}</div>}
        {!p.rejectReason && !p.notes && <span style={muted}>—</span>}
      </td>
      <td data-label="Статус">
        <span
          style={{
            padding: '3px 10px',
            borderRadius: 999,
            background: STATUS_COLOR[p.status] + '22',
            color: STATUS_COLOR[p.status],
            fontSize: 12,
            fontWeight: 600,
            border: `1.5px solid ${STATUS_COLOR[p.status]}`,
            whiteSpace: 'nowrap',
          }}
        >
          {PAYMENT_STATUS_LABEL[p.status]}
        </span>
      </td>
      <td>
        {/* Все действия — в одну строку в конце: одобрить/отклонить
            (руководство, пока платёж на рассмотрении), править и удалить. */}
        {(canReview || canManage || canDelete) && (
          <div className="payment-actions">
            {canReview && (
              <>
                <button className="btn btn-sm btn-danger" onClick={onReject} disabled={busy} data-testid="payment-reject">
                  <Icon name="close" size={14} /> Отклонить
                </button>
                <button className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy} data-testid="payment-approve">
                  <Icon name="check" size={14} /> Одобрить
                </button>
              </>
            )}
            {canManage && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={onEdit}
                disabled={manageBusy || p.status === 'REJECTED'}
                title={p.status === 'REJECTED' ? 'Отклонённый платёж редактировать нельзя' : 'Редактировать'}
                aria-label="Редактировать"
                data-testid="payment-edit"
              >
                <Icon name="edit" size={14} />
              </button>
            )}
            {canDelete && (
              <button
                className="btn btn-sm btn-danger"
                onClick={onDelete}
                disabled={manageBusy}
                title="Удалить"
                aria-label="Удалить"
                data-testid="payment-delete"
              >
                <Icon name="delete" size={14} />
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
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
            <CrmSelect className="crm-select" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="TRANSFER">Перевод</option>
              <option value="CASH">Наличные</option>
              <option value="OTHER">Прочее</option>
            </CrmSelect>
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
 * Модалка редактирования сделки.
 * Доступна и FOUNDER, и менеджеру-владельцу (см. блок кнопок выше), но
 * денежные поля (сумма контракта / валюта) может менять только FOUNDER —
 * бэк реджектит их у менеджера, фронт заранее прячет инпуты и не шлёт
 * значения в payload.
 * После firstApprovedAt поля студента/программы «заморожены» — бэк молча
 * игнорит их (см. submissions.service.ts:updateSubmission), но UX явно
 * дизейблит инпуты с подсказкой, чтобы FOUNDER понимал почему.
 */
function EditSubmissionModal({
  submission, founder, onClose, onSuccess,
}: {
  submission: SaleSubmission;
  founder: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast, confirm } = useUI();
  const { t } = useT();
  const frozen = !!submission.firstApprovedAt;

  const [contractUrls, setContractUrls] = useState<string[]>(submission.contractUrls || []);
  const [totalAmount, setTotalAmount] = useState<string>(String(submission.totalAmount ?? ''));
  const [currency, setCurrency] = useState<string>(submission.currency || 'TJS');
  const [notes, setNotes] = useState<string>(submission.notes || '');
  const [newStudentName, setNewStudentName] = useState<string>(submission.newStudentName || '');
  const [newStudentPhone, setNewStudentPhone] = useState<string>(submission.newStudentPhone || '');
  const [newStudentEmail, setNewStudentEmail] = useState<string>(submission.newStudentEmail || '');
  const [newStudentPassportUrls, setNewStudentPassportUrls] = useState<string[]>(submission.newStudentPassportUrls || []);
  const [programId, setProgramId] = useState<string>(submission.programId || '');

  const programsQ = useQuery({
    queryKey: ['programs', 'edit-submission'],
    queryFn: () => listPrograms(),
    // programs подтягиваем только если поле реально редактируемо —
    // экономим запрос на «замороженных» сделках и у не-FOUNDER
    // (у которого select теперь read-only, «Меняет только основатель»).
    enabled: !frozen && founder,
  });

  const mut = useMutation({
    mutationFn: () => {
      const dto: UpdateSubmissionDto = {
        contractUrls,
        notes: notes.trim() || null,
      };
      // Деньги может менять только FOUNDER — даже если state как-то заполнен,
      // не шлём их в payload (бэк реджектит, но чистим уже здесь).
      if (founder) {
        dto.totalAmount = parseFloat(totalAmount);
        // Валюта уходит на бэк ТОЛЬКО пока сделка не заморожена. После
        // первого одобрения она зафиксирована (бэк отвечает 400 на смену):
        // по ней зарплатный модуль отбирает одобренные платежи в бонусную
        // базу месяца, и правка задним числом переписала бы уже закрытые
        // периоды. Слать её в payload'е «как было» тоже незачем.
        if (!frozen) dto.currency = currency;
      }
      if (!frozen) {
        dto.newStudentName = newStudentName.trim() || null;
        dto.newStudentPhone = newStudentPhone.trim() || null;
        dto.newStudentEmail = newStudentEmail.trim() || null;
        dto.newStudentPassportUrls = newStudentPassportUrls;
        // programId — только FOUNDER (как и totalAmount/currency).
        // Раньше слали безусловно, из-за чего у менеджера notes-only
        // правка ловила 403 на бэке. Бэкенд теперь silent-ignore'ит эти
        // поля, но шлём только когда реально может измениться — экономим
        // байты и делаем payload честнее.
        if (founder && programId) dto.programId = programId;
      }
      return updateSubmission(submission.id, dto);
    },
    onSuccess,
    onError: (e: any) => toast(e?.response?.data?.message || 'Ошибка', 'error'),
  });

  const onSubmit = () => {
    // Валидация суммы — только там, где её реально шлём (FOUNDER).
    if (founder) {
      const a = parseFloat(totalAmount);
      if (!isFinite(a) || a <= 0) return toast('Сумма контракта должна быть > 0', 'error');
    }
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
            Часть полей заморожена: студент/заявка/программа уже созданы после первого одобрения,
            а валюта сделки участвует в расчёте бонуса за закрытые месяцы.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {founder ? (
            <>
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
                {frozen ? (
                  <>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                        fontSize: 14,
                        padding: '8px 10px',
                        background: 'var(--bg-soft)',
                        borderRadius: 6,
                        color: 'var(--text)',
                      }}
                    >
                      {submission.currency}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                      {t('submissionForm.currency.frozen.hint')}
                    </div>
                  </>
                ) : (
                  <CrmSelect className="crm-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {/* Легаси-значение, которого нет в списке, показываем как есть —
                        иначе select молча «переключил» бы сделку на первый пункт
                        и отправил чужую валюту в payload. */}
                    {!(SUBMISSION_CURRENCIES as readonly string[]).includes(currency) && (
                      <option value={currency}>{currency}</option>
                    )}
                    {SUBMISSION_CURRENCIES.map((c) => (
                      <option key={c} value={c}>{SUBMISSION_CURRENCY_LABEL[c] || c}</option>
                    ))}
                  </CrmSelect>
                )}
              </Field>
            </>
          ) : (
            <>
              <Field label="Сумма контракта">
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    fontSize: 14,
                    padding: '8px 10px',
                    background: 'var(--bg-soft)',
                    borderRadius: 6,
                    color: 'var(--text)',
                  }}
                >
                  {submission.totalAmount.toLocaleString('ru-RU')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                  Меняет только основатель
                </div>
              </Field>
              <Field label="Валюта">
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    fontSize: 14,
                    padding: '8px 10px',
                    background: 'var(--bg-soft)',
                    borderRadius: 6,
                    color: 'var(--text)',
                  }}
                >
                  {submission.currency}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-soft)', marginTop: 4 }}>
                  Меняет только основатель
                </div>
              </Field>
            </>
          )}
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
              <CrmSelect
                className="crm-select"
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
                disabled={frozen || !founder}
                title={
                  frozen
                    ? 'Заморожено (студент/заявка уже созданы)'
                    : !founder
                      ? 'Меняет только основатель'
                      : undefined
                }
              >
                {(frozen || !founder) && submission.program && (
                  <option value={submission.programId}>{submission.program.name} · {submission.program.university}</option>
                )}
                {!frozen && founder && programsQ.data?.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {p.university}</option>
                ))}
              </CrmSelect>
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

  // Изменено ли хоть что-то. Раньше «Закрыть без сохранения? Изменения
  // будут потеряны» спрашивали всегда — даже если окно просто открыли
  // посмотреть и нажали «Отмена».
  const dirty =
    amount !== String(payment.amount ?? '') ||
    method !== payment.paymentMethod ||
    paidAt !== (payment.paidAt ? new Date(payment.paidAt).toISOString().slice(0, 10) : paidAt) ||
    receiptUrls.join('|') !== (payment.receiptUrls || []).join('|') ||
    depositProofUrls.join('|') !== (payment.depositProofUrls || []).join('|') ||
    nextDueDate !== (payment.nextDueDate ? new Date(payment.nextDueDate).toISOString().slice(0, 10) : '') ||
    nextDueAmount !== (payment.nextDueAmount != null ? String(payment.nextDueAmount) : '') ||
    notes !== (payment.notes || '');

  const attemptClose = async () => {
    if (mut.isPending) return;
    if (readOnly || !dirty) {
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
  }, [mut.isPending, readOnly, dirty]);

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
            <CrmSelect
              className="crm-select"
              value={method}
              onChange={(e) => setMethod(e.target.value as SubmissionPaymentMethod)}
              disabled={readOnly}
            >
              <option value="TRANSFER">Перевод</option>
              <option value="CASH">Наличные</option>
              <option value="OTHER">Прочее</option>
            </CrmSelect>
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
