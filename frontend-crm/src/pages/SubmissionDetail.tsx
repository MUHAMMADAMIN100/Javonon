import { useState, useEffect } from 'react';
import CrmSelect from '../components/CrmSelect';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '../store/auth';
import { isElevated, isFounder } from '../lib/roles';
import { listAccounts, type FinanceAccount } from '../api/finance';
import { hasActiveRole, hiddenAmount, roleCan } from '../lib/permissions';
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
import { listSubmissionStages } from '../api/installments';
import { ruPlural } from '../lib/plural';
import { coverStages, daysPastDue } from '../lib/stageCoverage';
import { nextDueError, nextDueMin, tjDateInput, tjFormatDate, tjToday } from '../lib/tjTime';
import { useT } from '../lib/i18n';
import { isTouchDevice } from '../lib/touch';
import { SortSelect, SortTh, useTableSort } from '../components/TableSort';
import DismissedMark from '../components/DismissedMark';
import { useEscClose } from '../lib/useEscClose';
import BusyLabel from '../components/BusyLabel';
import { DetailSkeleton } from '../components/Skeleton';
import LookupOptions from '../components/LookupOptions';

/** Отказ бэкенда закрыть сделку с неодобренными платежами (changeStatus) — его текст узнаём, чтобы показать перевод. */
const CLOSE_WITH_PENDING_MESSAGE = 'Нельзя закрыть сделку: есть неодобренные платежи. Сначала их нужно одобрить или отклонить.';

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
    mutationFn: ({ paymentId, amountTjs, accountId }: { paymentId: string; amountTjs?: number; accountId?: string }) =>
      approvePayment(paymentId, amountTjs, accountId),
    onSuccess: async () => {
      // QA-2: сначала перечитываем список, потом «готово» — без 3–5 с старых данных.
      await Promise.all([qc.invalidateQueries({ queryKey: ['submission', id] }), qc.invalidateQueries({ queryKey: keys.installments.stages(id!) }), qc.invalidateQueries({ queryKey: ['submissions'] }), qc.invalidateQueries({ queryKey: keys.finance.all })]).catch(() => undefined);
      toast(t('deal.toast.approved'), 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const rejectMut = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) => rejectPayment(paymentId, reason),
    onSuccess: async () => {
      // QA-2: сначала перечитываем список, потом «готово» — без 3–5 с старых данных.
      await Promise.all([qc.invalidateQueries({ queryKey: ['submission', id] }), qc.invalidateQueries({ queryKey: keys.installments.stages(id!) }), qc.invalidateQueries({ queryKey: ['submissions'] })]).catch(() => undefined);
      toast(t('deal.toast.rejected'), 'success');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const statusMut = useMutation({
    mutationFn: (status: 'COMPLETED' | 'CANCELLED' | 'ACTIVE') => changeSubmissionStatus(id!, status),
    onSuccess: async () => {
      // QA-2: сначала перечитываем список, потом «готово» — без 3–5 с старых данных.
      await Promise.all([qc.invalidateQueries({ queryKey: ['submission', id] }), qc.invalidateQueries({ queryKey: keys.installments.stages(id!) }), qc.invalidateQueries({ queryKey: ['submissions'] })]).catch(() => undefined);
      toast(t('deal.toast.statusUpdated'), 'success');
    },
    // Отказ бэкенда «есть неодобренные платежи» приходит по-русски — показываем
    // свой перевод, чтобы таджикский интерфейс не получил русскую строку.
    onError: (e: any) => {
      const msg = e?.response?.data?.message;
      toast(msg === CLOSE_WITH_PENDING_MESSAGE ? t('deal.close.pendingBlocked') : msg || t('toast.error'), 'error');
    },
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
  // «Принять оплату по этапу» открывает то же окно с остатком этапа.
  const [payAmount, setPayAmount] = useState<number | null>(null);
  const [rejectPaymentId, setRejectPaymentId] = useState<string | null>(null);
  // Одобрение платежа по сделке не в сомони — сначала спрашиваем сумму в сомони.
  const [approveTarget, setApproveTarget] = useState<SubmissionPayment | null>(null);
  // Счёт, на который пришли деньги, выбирается при одобрении (Финансы, 10.11.2026).
  // Подходят счета в валюте сделки, для сделки не в сомони — и в сомони.
  const canSeeAccounts = roleCan(me, 'finance:read', isElevated(me));
  const accountsQ = useQuery({ queryKey: keys.finance.accounts(), queryFn: listAccounts, enabled: canSeeAccounts && !!s });
  // Этапы — для плитки «Просрочено» (тот же ключ, что у шкалы этапов: один запрос).
  const stagesQ = useQuery({ queryKey: keys.installments.stages(id ?? ''), queryFn: () => listSubmissionStages(id!), enabled: !!id && !!s });
  const dealCur = (s?.currency || 'TJS').toUpperCase();
  const approveAccounts = (accountsQ.data?.accounts ?? []).filter(
    (a) => !a.archived && (a.currency === dealCur || (dealCur !== 'TJS' && a.currency === 'TJS')),
  );
  const [showEditSubmission, setShowEditSubmission] = useState(false);
  const [editPaymentId, setEditPaymentId] = useState<string | null>(null);

  const deleteSubmissionMut = useMutation({
    mutationFn: () => deleteSubmission(id!),
    onSuccess: async () => {
      // QA-2: сначала перечитываем список, потом «готово» — без 3–5 с старых данных.
      await Promise.all([qc.invalidateQueries({ queryKey: ['submissions'] })]).catch(() => undefined);
      toast(t('deal.toast.deleted'), 'success');
      navigate('/submissions');
    },
    onError: (e: any) => toast(e?.response?.data?.message || t('toast.error'), 'error'),
  });

  const deletePaymentMut = useMutation({
    mutationFn: (paymentId: string) => deletePayment(paymentId),
    onSuccess: async (res) => {
      // QA-2: сначала перечитываем список, потом «готово» — без 3–5 с старых данных.
      await Promise.all([qc.invalidateQueries({ queryKey: ['submission', id] }), qc.invalidateQueries({ queryKey: keys.installments.stages(id!) }), qc.invalidateQueries({ queryKey: ['submissions'] })]).catch(() => undefined);
      toast(res?.reversed ? t('deal.toast.paymentDeletedReversed') : t('deal.toast.paymentDeleted'), 'success');
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

  if (query.isLoading) return <DetailSkeleton fields={6} testId="deal-skeleton" />;
  if (!s) {
    return (
      <>
        <BackButton fallback="/submissions" />
        <div className="card" style={{ padding: 24 }}>{t('deal.notFound')}</div>
      </>
    );
  }

  const studentName = s.student?.fullName || s.newStudentName || '—';
  const totalPaid = s.payments.filter((p) => p.status === 'APPROVED').reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const remaining = Math.max(0, (s.totalAmount ?? 0) - totalPaid);
  const pendingSum = s.payments.filter((p) => p.status === 'PENDING').reduce((sum, p) => sum + (p.amount ?? 0), 0);
  // Просрочка — по этапам (тот же запрос, что у шкалы этапов ниже, общий кеш):
  // неоплаченный остаток просроченных этапов, а не их полная сумма — деньги,
  // уже внесённые по этапу или ждущие одобрения, долгом не считаем.
  const lateCover = coverStages(stagesQ.data?.stages ?? [], totalPaid, pendingSum)
    .filter((v) => v.st.status === 'OVERDUE' && (s.moneyHidden || v.rest > 0));
  const firstLate = lateCover[0]?.st;
  const lateSum = lateCover.reduce((sum, v) => sum + v.rest, 0);
  const lateDays = firstLate ? daysPastDue(firstLate.dueDate) : 0;
  // Сколько ещё можно внести: контракт минус все неотклонённые платежи (как
  // проверяет сервер). Суммы скрыты от роли — проверяет только сервер.
  const payLimit = s.moneyHidden
    ? null
    : Math.round(((s.totalAmount ?? 0) - s.payments.filter((p) => p.status !== 'REJECTED').reduce((sum, p) => sum + (p.amount ?? 0), 0)) * 100) / 100;
  const isOwnSubmission = s.managerId === me?.id;
  // Сумма без «Деньги клиентов» не приходит — «•••• TJS».
  const money = (n: number) => (s.moneyHidden ? hiddenAmount(s.currency) : `${n.toLocaleString('ru-RU')} ${s.currency}`);
  // Права роли «Сделки — …» (Настройки → Роли). Сделка в зоне роли — своя или
  // «все сделки»; основатель и должности — как раньше.
  const custom = hasActiveRole(me) && !founder;
  const inScope = !custom || isOwnSubmission || roleCan(me, 'submissions:all');
  const may = (key: string) => inScope && roleCan(me, key);
  const canAddPayment = s.status === 'ACTIVE' && (custom ? may('submissions:payment-add') : isOwnSubmission);
  // Основатель закрывает и отменяет любую сделку (сервер разрешал это и раньше,
  // кнопок не было). QA-3 (BUG-42): закрытую сделку он может вернуть в работу
  // или отменить — из любого состояния есть выход.
  const canChangeStatus = s.status === 'ACTIVE' && (custom ? may('submissions:status') : founder || isOwnSubmission);
  const canReopen = s.status === 'COMPLETED' && founder;
  const canCancelNow = canChangeStatus || canReopen;
  const canEditDeal = custom ? may('submissions:update') : founder || isOwnSubmission;
  const canDeleteDeal = custom ? may('submissions:delete') : founder;
  const canEditStages = custom ? may('submissions:stages') : founder || isOwnSubmission;
  const canApprove = custom ? roleCan(me, 'submissions:approve') : founder;
  const canEditPayment = custom ? may('submissions:payment-edit') : founder;
  const canDeletePayment = custom ? may('submissions:payment-delete') : founder;

  const onReject = (paymentId: string) => {
    setRejectPaymentId(paymentId);
  };

  const onComplete = async () => {
    // Сначала разбор неодобренных платежей, потом закрытие: у завершённой сделки
    // их потом было бы некому разобрать. Сервер проверяет то же самое.
    if (s.payments?.some((p) => p.status === 'PENDING')) {
      toast(t('deal.close.pendingBlocked'), 'error');
      return;
    }
    // QA-3 (BUG-11): окно пишет реальные цифры. «Оплачен полностью» — только
    // при остатке 0; при долге — сколько осталось и красная кнопка.
    const hasDebt = !s.moneyHidden && remaining > 0;
    const ok = await confirm(
      hasDebt
        ? {
            title: t('deal.close.debtTitle'),
            message: t('deal.close.debtMessage')
              .replace('{left}', money(remaining))
              .replace('{paid}', money(totalPaid))
              .replace('{total}', money(s.totalAmount ?? 0)),
            confirmText: t('deal.close.debtOk'),
            danger: true,
          }
        : { title: t('deal.close.title'), message: t(s.moneyHidden ? 'deal.close.messageHidden' : 'deal.close.message') },
    );
    if (ok) statusMut.mutate('COMPLETED');
  };
  const onCancel = async () => {
    const ok = await confirm({
      title: t('deal.cancel.title'),
      message: t(totalPaid > 0 && !s.moneyHidden ? 'deal.cancel.messagePaid' : 'deal.cancel.message').replace('{paid}', money(totalPaid)),
      confirmText: t('deal.cancel.ok'),
      danger: true,
    });
    if (ok) statusMut.mutate('CANCELLED');
  };
  const onReopen = async () => {
    if (await confirm({ title: t('deal.reopen.title'), message: t('deal.reopen.message'), confirmText: t('deal.reopen.ok') })) {
      statusMut.mutate('ACTIVE');
    }
  };

  // Своё красное окно подтверждения, как во всей CRM (QA №33, решение
  // заказчика 07.11.2026; раньше — серое окно браузера).
  const onDeleteSubmission = async () => {
    // QA-2 №17: сделку с одобренными платежами удалить нельзя — раньше сначала
    // спрашивали «это нельзя отменить», а потом сервер отвечал отказом.
    // Объясняем сразу и предлагаем то, что можно: отмену сделки.
    if (s.status !== 'CANCELLED' && s.payments.some((p) => p.status === 'APPROVED')) {
      const goCancel = await confirm({
        title: t('deal.delete.blockedTitle'),
        message: t(canCancelNow ? 'deal.delete.blocked' : 'deal.delete.blockedAsk'),
        confirmText: canCancelNow ? t('deal.cancelDeal') : t('common.ok'),
        hideCancel: !canCancelNow,
        icon: 'info',
      });
      if (goCancel && canCancelNow) onCancel();
      return;
    }
    const ok = await confirm({
      title: t('deal.delete.title'),
      message: t('deal.delete.confirm'),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (ok) deleteSubmissionMut.mutate();
  };

  // Окно подтверждения — своё, как во всей CRM, а не серое браузерное.
  const onDeletePayment = async (p: SubmissionPayment) => {
    const ok = await confirm({
      title: t('deal.payDelete.title'),
      message: p.status === 'APPROVED'
        ? t('deal.payDelete.approved').replace('{amount}', money(p.amount ?? 0))
        : t('deal.payDelete.pending').replace('{amount}', money(p.amount ?? 0)).replace('{date}', new Date(p.paidAt).toLocaleDateString('ru-RU')),
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
                <DismissedMark person={s.manager} />
              </div>
            )}
            {/* QA-3 (BUG-13): сделка из лида записана на менеджера лида — видно, кто её оформил. */}
            {s.createdBy && s.createdBy.id !== s.managerId && (
              <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2 }} data-testid="deal-created-by">
                {t('deal.createdBy')}: {s.createdBy.fullName}
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

        {/* Макет (часть D): плитки сумм — контракт, оплачено (доля и что ждёт
            одобрения), осталось и просрочка по этапам. */}
        <div className="deal-kpis" data-testid="deal-kpis">
          <div className="deal-kpi" data-testid="deal-kpi-contract">
            <span className="deal-kpi-label">{t('deal.contract')}</span>
            <span className="deal-kpi-value">{money(s.totalAmount ?? 0)}</span>
          </div>
          <div className="deal-kpi" data-testid="deal-kpi-paid">
            <span className="deal-kpi-label">{t('deal.stat.paid')}</span>
            <span className="deal-kpi-value is-good">{money(totalPaid)}</span>
            {!s.moneyHidden && (s.totalAmount ?? 0) > 0 && (
              <span className="deal-kpi-sub">
                {Math.round((totalPaid / (s.totalAmount ?? 1)) * 100)} %
                {pendingSum > 0 && ` · ${t('deal.kpi.pending').replace('{sum}', money(pendingSum))}`}
              </span>
            )}
          </div>
          <div className="deal-kpi" data-testid="deal-kpi-left">
            <span className="deal-kpi-label">{t('deal.stat.remaining')}</span>
            <span className="deal-kpi-value">{money(remaining)}</span>
          </div>
          {firstLate && (
            <div className="deal-kpi is-late" data-testid="deal-kpi-late">
              <span className="deal-kpi-label">{t('stages.total.overdue')}</span>
              <span className="deal-kpi-value">{money(lateSum)}</span>
              <span className="deal-kpi-sub">
                {t('deal.kpi.lateStage').replace('{n}', String(firstLate.order))} · {lateDays} {t(ruPlural(lateDays, 'stages.day1', 'stages.day2', 'stages.day5'))}
              </span>
            </div>
          )}
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
        {(canAddPayment || canChangeStatus || canReopen) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
            {canAddPayment && (
              <button className="btn btn-sm btn-primary" onClick={() => setShowAddPayment(true)} data-testid="deal-add-payment">
                <Icon name="add" size={14} /> {t('deal.addPayment')}
              </button>
            )}
            {canChangeStatus && (
              <>
                <button className="btn btn-sm btn-secondary" onClick={onComplete} data-testid="deal-complete">
                  <Icon name="check" size={14} /> {t('deal.closeDeal')}
                </button>
                <button className="btn btn-sm btn-danger" onClick={onCancel} data-testid="deal-cancel">
                  <Icon name="close" size={14} /> {t('deal.cancelDeal')}
                </button>
              </>
            )}
            {canReopen && (
              <>
                <button className="btn btn-sm btn-secondary" onClick={onReopen} disabled={statusMut.isPending} data-testid="deal-reopen">
                  <Icon name="undo" size={14} /> {t('deal.reopen')}
                </button>
                <button className="btn btn-sm btn-danger" onClick={onCancel} disabled={statusMut.isPending} data-testid="deal-cancel">
                  <Icon name="close" size={14} /> {t('deal.cancelDeal')}
                </button>
              </>
            )}
          </div>
        )}

        {/* Кнопки редактирования/удаления:
            - «Редактировать сделку»: FOUNDER всегда; менеджер-владелец только
              для своей сделки (в service заморожены studentId/newStudent/programId
              после первого APPROVE)
            - «Удалить сделку»: только FOUNDER (destructive; менеджер идёт к нему) */}
        {(canEditDeal || canDeleteDeal) && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              borderTop: '1px solid var(--border-soft)',
              paddingTop: 12,
              marginTop: canAddPayment || canChangeStatus || canReopen ? 12 : 0,
            }}
          >
            {canEditDeal && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => setShowEditSubmission(true)}
                disabled={deleteSubmissionMut.isPending}
                data-testid="deal-edit"
              >
                <Icon name="edit" size={14} /> {t('deal.edit')}
              </button>
            )}
            {canDeleteDeal && (
              <button
                className="btn btn-sm btn-danger"
                onClick={onDeleteSubmission}
                disabled={deleteSubmissionMut.isPending}
                data-testid="deal-delete"
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
      <PaymentStagesSection
        submissionId={s.id}
        canEdit={canEditStages}
        approved={s.moneyHidden ? null : totalPaid}
        pending={s.moneyHidden ? null : pendingSum}
        onPay={canAddPayment ? (amount) => { setPayAmount(amount); setShowAddPayment(true); } : undefined}
      />

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
            // Завершённая сделка — тоже: зависшие с прошлого неодобренные платежи
            // основатель разбирает как обычно (закрыть с такими теперь нельзя).
            canReview={canApprove && p.status === 'PENDING' && (s.status === 'ACTIVE' || s.status === 'COMPLETED') && (founder || !isOwnSubmission)}
            onApprove={() =>
              // Окно — когда есть что выбрать (счёт) или что ввести (сумма в сомони);
              // единственный подходящий счёт ставится сам, без окна.
              s.currency !== 'TJS' || approveAccounts.length > 1
                ? setApproveTarget(p)
                : approveMut.mutate({ paymentId: p.id, accountId: approveAccounts[0]?.id })
            }
            onReject={() => onReject(p.id)}
            busy={approveMut.isPending || rejectMut.isPending}
            /* Управление платежом — только FOUNDER.
               Менеджер добавляет платежи, но менять/удалять уже отправленные
               (даже свои PENDING) не может: одобрение/отклонение — прерогатива
               FOUNDER, а APPROVED затрагивают доход. */
            canManage={canEditPayment}
            /* Удаление только FOUNDER — реверс Transaction для APPROVED —
               бухгалтерская операция; роли — «Платёж: удаление». */
            canDelete={canDeletePayment}
            moneyHidden={!!s.moneyHidden}
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
          limit={payLimit}
          initialAmount={payAmount != null && payLimit != null ? Math.min(payAmount, payLimit) : payAmount}
          onClose={() => { setShowAddPayment(false); setPayAmount(null); }}
          onSuccess={() => {
            setShowAddPayment(false);
            setPayAmount(null);
            qc.invalidateQueries({ queryKey: ['submission', id] });
            qc.invalidateQueries({ queryKey: keys.installments.stages(id!) });
            toast(t('deal.toast.paymentAdded'), 'success');
          }}
        />
      )}

      {approveTarget && (
        <ApproveTjsModal
          payment={approveTarget}
          currency={s.currency}
          accounts={approveAccounts}
          busy={approveMut.isPending}
          onClose={() => {
            if (!approveMut.isPending) setApproveTarget(null);
          }}
          onSubmit={({ amountTjs, accountId }) => {
            approveMut.mutate(
              { paymentId: approveTarget.id, amountTjs, accountId },
              { onSuccess: () => setApproveTarget(null) },
            );
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

function PaymentRow({
  p, currency, canReview, onApprove, onReject, busy,
  canManage, canDelete, onEdit, onDelete, manageBusy, moneyHidden,
}: {
  p: SubmissionPayment;
  currency: string;
  canReview: boolean;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
  canManage: boolean;
  canDelete: boolean;
  /** Роль без «Деньги клиентов»: сумма и чеки скрыты. */
  moneyHidden?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  manageBusy: boolean;
}) {
  const { t } = useT();
  const muted = { color: 'var(--text-light)' };
  return (
    <tr data-testid={`payment-row-${p.id}`} className="pay-row">
      <td className="pay-amount" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {moneyHidden ? hiddenAmount(currency) : `${p.amount.toLocaleString('ru-RU')} ${currency}`}
        {!moneyHidden && currency !== 'TJS' && p.amountTjs != null && (
          <div className="pay-amount-tjs" data-testid="pay-amount-tjs">
            {t('deal.inBonus')}: {p.amountTjs.toLocaleString('ru-RU')} TJS
          </div>
        )}
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
            {tjFormatDate(p.nextDueDate)}
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
      <td data-label={t('common.status')} className="pay-status">
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
      <td className="pay-actions">
        {/* Все действия — в одну строку в конце: одобрить/отклонить
            (руководство, пока платёж на рассмотрении), править и удалить.
            На телефоне (строка — карточка) — сеткой 2×2 с подписями. */}
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
                <span className="pay-btn-label">{t('common.edit')}</span>
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
                <span className="pay-btn-label">{t('common.delete')}</span>
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function AddPaymentModal({
  submissionId, currency, limit, initialAmount, onClose, onSuccess,
}: {
  submissionId: string;
  currency: string;
  /** Сумма по умолчанию — остаток этапа («Принять оплату по этапу»). */
  initialAmount?: number | null;
  /** Остаток по контракту; null — суммы скрыты от роли. */
  limit: number | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useT();
  const { toast, confirm } = useUI();
  const [amount, setAmount] = useState(initialAmount ? String(initialAmount) : '');
  const [method, setMethod] = useState<SubmissionPaymentMethod>('TRANSFER');
  const [paidAt, setPaidAt] = useState(tjToday());
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
    if (limit !== null && a > limit + 0.005) {
      return toast(t('deal.err.overpay').replace('{sum}', `${Math.max(0, limit).toLocaleString('ru-RU')} ${currency}`), 'error');
    }
    if (method === 'TRANSFER' && receiptUrls.length === 0) return toast(t('deal.err.receipt'), 'error');
    if (method === 'CASH' && depositProofUrls.length === 0) return toast(t('deal.err.deposit'), 'error');
    const nextErr = nextDueError(nextDueDate, paidAt);
    if (nextErr) return toast(t(nextErr), 'error');
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

  useEscClose(true, () => { void attemptClose(); });

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
            <input
              className={`crm-input${limit !== null && parseFloat(amount) > limit + 0.005 ? ' input-error' : ''}`}
              type="number"
              min={0}
              max={limit ?? undefined}
              step={50}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="pay-amount"
            />
            {limit !== null && (
              <div className="profile-field-hint" data-testid="pay-limit">
                {t('deal.payLimit').replace('{sum}', `${Math.max(0, limit).toLocaleString('ru-RU')} ${currency}`)}
              </div>
            )}
          </Field>
          <Field label={t('deal.field.method')}>
            <CrmSelect className="crm-select" value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <LookupOptions kind="DEAL_PAYMENT_METHOD" />
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
            <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} min={nextDueMin(paidAt)} />
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

/**
 * Одобрение платежа по сделке НЕ в сомони. Курса валют в системе нет, а бонус
 * менеджера и KPI считаются в сомони, поэтому основатель указывает, сколько
 * этот платёж в сомони. Для TJS-сделки окно не открывается — одобрение в
 * одно нажатие, как раньше.
 */
/**
 * Одобрение платежа: на какой счёт пришли деньги (если счета заведены) и, для
 * сделки не в сомони, сумма в сомони — по ней считается бонус менеджера, а на
 * счёт в сомони ложится именно она.
 */
function ApproveTjsModal({
  payment,
  currency,
  accounts,
  busy,
  onClose,
  onSubmit,
}: {
  payment: SubmissionPayment;
  currency: string;
  accounts: FinanceAccount[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (v: { amountTjs?: number; accountId?: string }) => void;
}) {
  const { t } = useT();
  const cur = (currency || 'TJS').toUpperCase();
  const needTjs = cur !== 'TJS';
  const [value, setValue] = useState('');
  const [accountId, setAccountId] = useState(
    () => (accounts.find((a) => a.id === payment.accountId) ?? accounts.find((a) => a.currency === cur) ?? accounts[0])?.id ?? '',
  );
  const acc = accounts.find((a) => a.id === accountId) || null;
  const amount = parseFloat(value.replace(',', '.'));
  const isValid = (!needTjs || (isFinite(amount) && amount > 0)) && (accounts.length === 0 || !!acc);

  useEscClose(true, () => { void onClose(); });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || busy) return;
    onSubmit({
      ...(needTjs && { amountTjs: Math.round(amount * 100) / 100 }),
      ...(acc && { accountId: acc.id }),
    });
  };

  return (
    <motion.div
      className="dialog-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !busy && onClose()}
    >
      <motion.form
        className="dialog-card"
        data-testid="approve-tjs-modal"
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{ maxWidth: 440, textAlign: 'left' }}
      >
        <h3 style={{ fontSize: 18, marginBottom: 8, textAlign: 'center' }}>
          {needTjs ? t('deal.approveTjs.title') : t('deal.approveAcc.title')}
        </h3>
        {needTjs && (
          <p style={{ fontSize: 13, color: 'var(--text-soft)', marginBottom: 12, lineHeight: 1.45 }}>
            {t('deal.approveTjs.text').replace('{currency}', cur)}
          </p>
        )}
        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, marginBottom: 12 }}>
          {payment.amount.toLocaleString('ru-RU')} {cur}
        </div>
        {accounts.length > 0 && (
          <Field label={t('deal.approveAcc.field')}>
            <CrmSelect className="crm-select" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={busy} data-testid="approve-account">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}{needTjs && a.currency === 'TJS' ? ` (${t('finance.inc.byRate')})` : ''}
                </option>
              ))}
            </CrmSelect>
          </Field>
        )}
        {needTjs && (
          <Field label={`${acc?.currency === 'TJS' ? t('finance.inc.tjsArrived') : t('deal.approveTjs.field')} *`}>
            <input
              className="crm-input"
              type="number"
              min={0}
              step={1}
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus={!isTouchDevice()}
              disabled={busy}
              data-testid="approve-tjs-input"
              placeholder="0"
            />
          </Field>
        )}
        <div className="dialog-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!isValid || busy} data-testid="approve-tjs-submit">
            {t('deal.approve')}
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
}

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

  useEscClose(true, () => { void attemptClose(); });

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

  useEscClose(true, () => { void attemptClose(); });

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
            <BusyLabel busy={mut.isPending}>{t('common.save')}</BusyLabel>
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
    payment.paidAt ? tjDateInput(payment.paidAt) : tjToday(),
  );
  const [receiptUrls, setReceiptUrls] = useState<string[]>(payment.receiptUrls || []);
  const [depositProofUrls, setDepositProofUrls] = useState<string[]>(payment.depositProofUrls || []);
  const [nextDueDate, setNextDueDate] = useState<string>(
    payment.nextDueDate ? tjDateInput(payment.nextDueDate) : '',
  );
  const [nextDueAmount, setNextDueAmount] = useState<string>(
    payment.nextDueAmount != null ? String(payment.nextDueAmount) : '',
  );
  const [notes, setNotes] = useState<string>(payment.notes || '');
  // Сумма в сомони — у одобренного платежа по сделке не в TJS. Отправляем,
  // только если её поменяли: иначе сервер сам пересчитает её пропорционально
  // новой сумме в валюте (курс засчёта сохраняется).
  const showTjs = currency !== 'TJS' && payment.status === 'APPROVED';
  const initialTjs = payment.amountTjs != null ? String(payment.amountTjs) : '';
  const [amountTjs, setAmountTjs] = useState<string>(initialTjs);

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
        ...(showTjs && amountTjs !== initialTjs && amountTjs.trim() ? { amountTjs: parseFloat(amountTjs.replace(',', '.')) } : {}),
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
    if (showTjs && amountTjs !== initialTjs) {
      const tj = parseFloat(amountTjs.replace(',', '.'));
      if (!isFinite(tj) || tj <= 0) return toast(t('deal.approveTjs.required'), 'error');
    }
    if (method === 'TRANSFER' && receiptUrls.length === 0) return toast(t('deal.err.receipt'), 'error');
    if (method === 'CASH' && depositProofUrls.length === 0) return toast(t('deal.err.deposit'), 'error');
    // Дату следующего платежа проверяем, только если её поменяли (как сервер).
    if (nextDueDate !== (payment.nextDueDate ? tjDateInput(payment.nextDueDate) : '')) {
      const nextErr = nextDueError(nextDueDate, paidAt);
      if (nextErr) return toast(t(nextErr), 'error');
    }
    mut.mutate();
  };

  // Изменено ли хоть что-то. Раньше «Закрыть без сохранения? Изменения
  // будут потеряны» спрашивали всегда — даже если окно просто открыли
  // посмотреть и нажали «Отмена».
  const dirty =
    amount !== String(payment.amount ?? '') ||
    method !== payment.paymentMethod ||
    paidAt !== (payment.paidAt ? tjDateInput(payment.paidAt) : paidAt) ||
    receiptUrls.join('|') !== (payment.receiptUrls || []).join('|') ||
    depositProofUrls.join('|') !== (payment.depositProofUrls || []).join('|') ||
    nextDueDate !== (payment.nextDueDate ? tjDateInput(payment.nextDueDate) : '') ||
    nextDueAmount !== (payment.nextDueAmount != null ? String(payment.nextDueAmount) : '') ||
    notes !== (payment.notes || '') ||
    amountTjs !== initialTjs;

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

  useEscClose(true, () => { void attemptClose(); });

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
          {showTjs && (
            <Field label={t('deal.approveTjs.field')}>
              <input
                className="crm-input"
                type="number"
                min={0}
                step={1}
                inputMode="decimal"
                value={amountTjs}
                onChange={(e) => setAmountTjs(e.target.value)}
                data-testid="edit-pay-amount-tjs"
              />
            </Field>
          )}
          <Field label={t('deal.field.method')}>
            <CrmSelect
              className="crm-select"
              value={method}
              onChange={(e) => setMethod(e.target.value as SubmissionPaymentMethod)}
              disabled={readOnly}
            >
              <LookupOptions kind="DEAL_PAYMENT_METHOD" />
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
            <CrmDatePicker value={nextDueDate} onChange={setNextDueDate} disabled={readOnly} min={nextDueMin(paidAt)} />
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
            <BusyLabel busy={mut.isPending}>{t('common.save')}</BusyLabel>
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
