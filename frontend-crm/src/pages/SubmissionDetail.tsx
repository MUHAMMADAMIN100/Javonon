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
import { absFileUrl as absUrl, useFileToken } from '../lib/fileUrl';
import { keys } from '../lib/queryKeys';
import { useT } from '../lib/i18n';
import { isTouchDevice } from '../lib/touch';
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
  const { t } = useT();
  useFileToken(); // ссылки на файлы — с файловым токеном, перерисовка когда он придёт
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
      toast(t('deal.toast.approved'), 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) => rejectPayment(paymentId, reason),
    onSuccess: () => {
      toast(t('deal.toast.rejected'), 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const statusMut = useMutation({
    mutationFn: (status: 'COMPLETED' | 'CANCELLED') => changeSubmissionStatus(id!, status),
    onSuccess: () => {
      toast(t('deal.toast.statusUpdated'), 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
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
      toast(t('deal.toast.deleted'), 'success');
      qc.invalidateQueries({ queryKey: ['submissions'] });
      navigate('/submissions');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deletePaymentMut = useMutation({
    mutationFn: (paymentId: string) => deletePayment(paymentId),
    onSuccess: (res) => {
      toast(res?.reversed ? t('deal.toast.paymentDeletedReversed') : t('deal.toast.paymentDeleted'), 'success');
      qc.invalidateQueries({ queryKey: ['submission', id] });
      qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
      qc.invalidateQueries({ queryKey: ['submissions'] });
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const paySort = useTableSort(
    s?.payments ?? [],
    [
      { key: 'amount', label: t('common.amount'), type: 'number', value: (p) => p.amount },
      { key: 'paidAt', label: t('deal.col.paidAt'), type: 'date', value: (p) => p.paidAt },
      { key: 'method', label: t('deal.col.method'), value: (p) => PAYMENT_METHOD_LABEL[p.paymentMethod] },
      { key: 'files', label: t('deal.col.files'), type: 'number', value: (p) => (p.receiptUrls?.length ?? 0) + (p.depositProofUrls?.length ?? 0) },
      { key: 'next', label: t('deal.col.next'), type: 'date', value: (p) => p.nextDueDate },
      { key: 'comment', label: t('common.comment'), value: (p) => p.rejectReason || p.notes },
      { key: 'status', label: t('common.status'), value: (p) => PAYMENT_STATUS_LABEL[p.status] },
    ],
    { param: 'sortPayments' },
  );

  if (query.isLoading) return <div className="card" style={{ padding: 24 }}>{t('common.loading')}</div>;
  if (!s) {
    return (
      <>
        <BackButton fallback="/submissions" />
        <div className="card" style={{ padding: 24 }}>{t('deal.notFound')}</div>
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
    if (await confirm({ title: t('deal.close.title'), message: t('deal.close.message') })) {
      statusMut.mutate('COMPLETED');
    }
  };
  const onCancel = async () => {
    if (await confirm({ title: t('deal.cancel.title'), message: t('deal.cancel.message') })) {
      statusMut.mutate('CANCELLED');
    }
  };

  const onDeleteSubmission = () => {
    // window.confirm намеренно — по ТЗ, чтобы не «переоформлять» родной
    // диалог подтверждения (deleteSubmission — destructive, важен native modal).
    if (window.confirm(t('deal.delete.confirm'))) {
      deleteSubmissionMut.mutate();
    }
  };

  // Окно подтверждения — своё, как во всей CRM, а не серое браузерное.
  const onDeletePayment = async (p: SubmissionPayment) => {
    const ok = await confirm({
      title: t('deal.payDelete.title'),
      message: p.status === 'APPROVED'
        ? t('deal.payDelete.approved').replace('{amount}', `${p.amount.toLocaleString('ru-RU')} ${s?.currency ?? ''}`)
        : t('deal.payDelete.pending').replace('{amount}', `${p.amount.toLocaleString('ru-RU')} ${s?.currency ?? ''}`).replace('{date}', new Date(p.paidAt).toLocaleDateString('ru-RU')),
      confirmText: t('common.delete'),
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
            <div style={{ fontSize: 11, color: 'var(--text-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('deal.eyebrow')}</div>
            <h2 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{studentName}</h2>
            <div style={{ fontSize: 14, color: 'var(--text-soft)' }}>
              {s.program?.name} · {s.program?.university}
            </div>
            {s.manager && (
              <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 4 }}>
                {t('deal.manager')}: {s.manager.fullName}
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
          <Stat label={t('deal.contract')} value={`${s.totalAmount.toLocaleString('ru-RU')} ${s.currency}`} />
          <Stat label={t('deal.stat.paid')} value={`${totalPaid.toLocaleString('ru-RU')} ${s.currency}`} highlight />
          <Stat label={t('deal.stat.remaining')} value={`${remaining.toLocaleString('ru-RU')} ${s.currency}`} />
          <Stat label={t('deal.stat.payments')} value={String(s.payments.length)} />
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
              <Icon name="description" size={14} /> {t('deal.contract')}{s.contractUrls.length > 1 ? ` ${i + 1}` : ''}
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
              <Icon name="badge" size={14} /> {t('deal.passport')}{s.newStudentPassportUrls.length > 1 ? ` ${i + 1}` : ''}
            </a>
          ))}
        </div>

        {s.notes && (
          <div style={{ padding: 12, background: 'var(--bg-soft)', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
            <strong>{t('common.comment')}:</strong> {s.notes}
          </div>
        )}

        {/* Кнопки менеджера */}
        {isOwnSubmission && s.status === 'ACTIVE' && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
            <button className="btn btn-sm btn-primary" onClick={() => setShowAddPayment(true)}>
              <Icon name="add" size={14} /> {t('deal.addPayment')}
            </button>
            <button className="btn btn-sm btn-secondary" onClick={onComplete}>
              <Icon name="check" size={14} /> {t('deal.closeDeal')}
            </button>
            <button className="btn btn-sm btn-danger" onClick={onCancel}>
              <Icon name="close" size={14} /> {t('deal.cancelDeal')}
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
              <Icon name="edit" size={14} /> {t('deal.edit')}
            </button>
            {founder && (
              <button
                className="btn btn-sm btn-danger"
                onClick={onDeleteSubmission}
                disabled={deleteSubmissionMut.isPending}
              >
                <Icon name="delete" size={14} /> {deleteSubmissionMut.isPending ? t('deal.deleting') : t('deal.delete')}
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
      <h3 style={{ fontSize: 16, marginTop: 24, marginBottom: 12 }}>{t('deal.payments')} ({s.payments.length})</h3>
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
            toast(t('deal.toast.paymentAdded'), 'success');
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
            toast(t('deal.toast.updated'), 'success');
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
              toast(t('deal.toast.paymentUpdated'), 'success');
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
  const { t } = useT();
  const muted = { color: 'var(--text-light)' };
  return (
    <tr data-testid={`payment-row-${p.id}`}>
      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {p.amount.toLocaleString('ru-RU')} {currency}
      </td>
      <td data-label={t('deal.col.paidAt')} style={{ whiteSpace: 'nowrap' }}>{new Date(p.paidAt).toLocaleDateString('ru-RU')}</td>
      <td data-label={t('deal.col.method')}>{PAYMENT_METHOD_LABEL[p.paymentMethod]}</td>
      <td data-label={t('deal.col.files')}>
        {(p.receiptUrls?.length ?? 0) + (p.depositProofUrls?.length ?? 0) === 0 ? (
          <span style={muted}>—</span>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {p.receiptUrls?.map((u, i) => (
              <a key={`receipt-${i}`} href={absUrl(u)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
                <Icon name="image" size={14} /> {t('deal.receipt')}{p.receiptUrls.length > 1 ? ` ${i + 1}` : ''}
              </a>
            ))}
            {p.depositProofUrls?.map((u, i) => (
              <a key={`deposit-${i}`} href={absUrl(u)} target="_blank" rel="noreferrer" className="btn btn-sm btn-secondary">
                <Icon name="image" size={14} /> {t('deal.deposit')}{p.depositProofUrls.length > 1 ? ` ${i + 1}` : ''}
              </a>
            ))}
          </div>
        )}
      </td>
      <td data-label={t('deal.col.next')} style={{ whiteSpace: 'nowrap' }}>
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
      <td data-label={t('common.comment')} style={{ fontSize: 13, maxWidth: 260 }}>
        {p.rejectReason && (
          <div style={{ color: '#b91c1c' }}>
            <strong>{t('deal.rejectedPrefix')}</strong> {p.rejectReason}
          </div>
        )}
        {p.notes && <div style={{ color: 'var(--text-soft)' }}>{p.notes}</div>}
        {!p.rejectReason && !p.notes && <span style={muted}>—</span>}
      </td>
      <td data-label={t('common.status')}>
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
                  <Icon name="close" size={14} /> {t('deal.reject')}
                </button>
                <button className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy} data-testid="payment-approve">
                  <Icon name="check" size={14} /> {t('deal.approve')}
                </button>
              </>
            )}
            {canManage && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={onEdit}
                disabled={manageBusy || p.status === 'REJECTED'}
                title={p.status === 'REJECTED' ? t('deal.rejectedNoEdit') : t('common.edit')}
                aria-label={t('common.edit')}
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
                title={t('common.delete')}
                aria-label={t('common.delete')}
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
  const { t } = useT();
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
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onSubmit = () => {
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0) return toast(t('deal.err.amount'), 'error');
    if (method === 'TRANSFER' && receiptUrls.length === 0) return toast(t('deal.err.receipt'), 'error');
    if (method === 'CASH' && depositProofUrls.length === 0) return toast(t('deal.err.deposit'), 'error');
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
      title: t('deal.discard.title'),
      message: t('deal.discard.payment'),
      confirmText: t('common.close'),
      cancelText: t('deal.continueInput'),
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
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>{t('deal.addPayment')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <Field label={`${t('common.amount')} (${currency}) *`}>
            <input className="crm-input" type="number" min={0} step={50} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t('deal.field.method')}>
            <CrmSelect className="crm-select" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="TRANSFER">{t('deal.method.TRANSFER')}</option>
              <option value="CASH">{t('deal.method.CASH')}</option>
              <option value="OTHER">{t('deal.method.OTHER')}</option>
            </CrmSelect>
          </Field>
          <Field label={t('deal.col.paidAt')}>
            <CrmDatePicker value={paidAt} onChange={setPaidAt} />
          </Field>
          {method === 'TRANSFER' && (
            <Field label={`${t('deal.receipt')} *`}>
              <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
            </Field>
          )}
          {method === 'CASH' && (
            <Field label={`${t('deal.depositShot')} *`}>
              <UploadInlineMulti values={depositProofUrls} onChange={setDepositProofUrls} />
            </Field>
          )}
          {method === 'OTHER' && (
            <Field label={t('deal.field.proof')}>
              <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
            </Field>
          )}
          <Field label={t('deal.field.nextDate')}>
            <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} />
          </Field>
          <Field label={t('deal.field.nextAmount')}>
            <input className="crm-input" type="number" min={0} step={50} value={nextDueAmount} onChange={(e) => setNextDueAmount(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label={t('common.comment')}>
            <textarea className="crm-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: 'none' }} />
          </Field>
        </div>
        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={mut.isPending}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={mut.isPending}>
            {mut.isPending ? t('common.sending') : t('common.add')}
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
  const { t } = useT();
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
      title: t('deal.rejectDiscard.title'),
      message: t('deal.rejectDiscard.message'),
      confirmText: t('common.close'),
      cancelText: t('deal.continueInput'),
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
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>{t('deal.rejectTitle')}</h3>
        <Field label={`${t('deal.rejectReason')} *`}>
          <textarea
            className="crm-textarea"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REJECT_REASON_MAX))}
            maxLength={REJECT_REASON_MAX}
            placeholder={t('deal.rejectPlaceholder')}
            autoFocus={!isTouchDevice()}
            disabled={busy}
            style={{ resize: 'none', width: '100%' }}
          />
        </Field>
        <div style={{ fontSize: 11, color: 'var(--text-soft)', textAlign: 'right', marginTop: 4 }}>
          {reason.length} / {REJECT_REASON_MAX}
        </div>
        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={busy}>{t('common.cancel')}</button>
          <button className="btn btn-danger" onClick={handleSubmit} disabled={!isValid || busy}>
            {busy ? t('deal.rejecting') : t('deal.reject')}
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
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onSubmit = () => {
    // Валидация суммы — только там, где её реально шлём (FOUNDER).
    if (founder) {
      const a = parseFloat(totalAmount);
      if (!isFinite(a) || a <= 0) return toast(t('deal.err.contractAmount'), 'error');
    }
    if (contractUrls.length === 0) return toast(t('deal.err.contractFile'), 'error');
    mut.mutate();
  };

  const attemptClose = async () => {
    if (mut.isPending) return;
    const ok = await confirm({
      title: t('deal.discard.title'),
      message: t('deal.discard.changes'),
      confirmText: t('common.close'),
      cancelText: t('deal.continue'),
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
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>{t('deal.edit')}</h3>

        {frozen && (
          <div style={{
            padding: 10,
            background: '#fef3c7',
            borderRadius: 8,
            fontSize: 12,
            color: '#78350f',
            marginBottom: 12,
          }}>
            {t('deal.frozenNote')}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {founder ? (
            <>
              <Field label={`${t('deal.contractAmount')} *`}>
                <input
                  className="crm-input"
                  type="number"
                  min={0}
                  step={50}
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                />
              </Field>
              <Field label={t('common.currency')}>
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
              <Field label={t('deal.contractAmount')}>
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
                  {t('deal.founderOnly')}
                </div>
              </Field>
              <Field label={t('common.currency')}>
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
                  {t('deal.founderOnly')}
                </div>
              </Field>
            </>
          )}
        </div>

        <div style={{ marginTop: 10 }}>
          <Field label={`${t('deal.contractFiles')} *`}>
            <UploadInlineMulti values={contractUrls} onChange={setContractUrls} />
          </Field>
        </div>

        <div style={{ marginTop: 10 }}>
          <Field label={t('common.comment')}>
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
            {t('deal.studentProgram')} {frozen && `(${t('deal.frozen')})`}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <Field label={t('deal.studentName')}>
              <input
                className="crm-input"
                value={newStudentName}
                onChange={(e) => setNewStudentName(e.target.value)}
                disabled={frozen}
                title={frozen ? t('deal.frozenTitle') : undefined}
              />
            </Field>
            <Field label={t('common.phone')}>
              <input
                className="crm-input"
                value={newStudentPhone}
                onChange={(e) => setNewStudentPhone(e.target.value)}
                disabled={frozen}
                title={frozen ? t('deal.frozenTitle') : undefined}
              />
            </Field>
            <Field label="Email">
              <input
                className="crm-input"
                value={newStudentEmail}
                onChange={(e) => setNewStudentEmail(e.target.value)}
                disabled={frozen}
                title={frozen ? t('deal.frozenTitle') : undefined}
              />
            </Field>
            <Field label={t('deal.program')}>
              <CrmSelect
                className="crm-select"
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
                disabled={frozen || !founder}
                title={
                  frozen
                    ? t('deal.frozenTitle')
                    : !founder
                      ? t('deal.founderOnly')
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
            <Field label={t('deal.passportFiles')}>
              {frozen ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }} title={t('deal.frozenTitle')}>
                  {t('deal.passportFrozen')}
                </div>
              ) : (
                <UploadInlineMulti values={newStudentPassportUrls} onChange={setNewStudentPassportUrls} />
              )}
            </Field>
          </div>
        </div>

        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={attemptClose} disabled={mut.isPending}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={onSubmit} disabled={mut.isPending}>
            {mut.isPending ? t('common.saving') : t('common.save')}
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
  const { t } = useT();
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
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const onSubmit = () => {
    if (readOnly) return;
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0) return toast(t('deal.err.amount'), 'error');
    if (method === 'TRANSFER' && receiptUrls.length === 0) return toast(t('deal.err.receipt'), 'error');
    if (method === 'CASH' && depositProofUrls.length === 0) return toast(t('deal.err.deposit'), 'error');
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
      title: t('deal.discard.title'),
      message: t('deal.discard.changes'),
      confirmText: t('common.close'),
      cancelText: t('deal.continue'),
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
        <h3 style={{ fontSize: 18, marginBottom: 12, textAlign: 'center' }}>{t('deal.editPayment')}</h3>

        {payment.status === 'APPROVED' && (
          <div style={{
            padding: 10,
            background: '#dcfce7',
            borderRadius: 8,
            fontSize: 12,
            color: '#166534',
            marginBottom: 12,
          }}>
            {t('deal.syncNote')}
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
            {t('deal.rejectedNoEdit')}.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <Field label={`${t('common.amount')} (${currency}) *`}>
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
          <Field label={t('deal.field.method')}>
            <CrmSelect
              className="crm-select"
              value={method}
              onChange={(e) => setMethod(e.target.value as SubmissionPaymentMethod)}
              disabled={readOnly}
            >
              <option value="TRANSFER">{t('deal.method.TRANSFER')}</option>
              <option value="CASH">{t('deal.method.CASH')}</option>
              <option value="OTHER">{t('deal.method.OTHER')}</option>
            </CrmSelect>
          </Field>
          <Field label={t('deal.col.paidAt')}>
            <CrmDatePicker value={paidAt} onChange={setPaidAt} disabled={readOnly} />
          </Field>
          {method === 'TRANSFER' && (
            <Field label={`${t('deal.receipt')} *`}>
              {readOnly ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('deal.filesNoEdit')}</div>
              ) : (
                <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
              )}
            </Field>
          )}
          {method === 'CASH' && (
            <Field label={`${t('deal.depositShot')} *`}>
              {readOnly ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('deal.filesNoEdit')}</div>
              ) : (
                <UploadInlineMulti values={depositProofUrls} onChange={setDepositProofUrls} />
              )}
            </Field>
          )}
          {method === 'OTHER' && (
            <Field label={t('deal.field.proof')}>
              {readOnly ? (
                <div style={{ fontSize: 12, color: 'var(--text-soft)' }}>{t('deal.filesNoEdit')}</div>
              ) : (
                <UploadInlineMulti values={receiptUrls} onChange={setReceiptUrls} />
              )}
            </Field>
          )}
          <Field label={t('deal.field.nextDate')}>
            <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} disabled={readOnly} />
          </Field>
          <Field label={t('deal.field.nextAmount')}>
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
          <Field label={t('common.comment')}>
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
          <button className="btn btn-secondary" onClick={attemptClose} disabled={mut.isPending}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            onClick={onSubmit}
            disabled={mut.isPending || readOnly}
            title={readOnly ? t('deal.rejectedNoEdit') : undefined}
          >
            {mut.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function UploadInlineMulti({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const { t } = useT();
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
      toast(e?.response?.data?.message || t('toast.error'), 'error');
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
              ✓ {t('deal.file')} {i + 1}
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
                aria-label={t('common.delete')}
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
