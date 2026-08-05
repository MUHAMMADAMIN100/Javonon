import { Logger } from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import { NON_PAYMENT_REASON_RU, NonPaymentReason } from './referrals.service';

/**
 * Фиксирует ОТКАЗ В ДЕНЬГАХ партнёру, который реально привёл платящего
 * клиента (истёк TTL атрибуции / партнёр неактивен / сработал БД-гард дедупа).
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ МЕТОД В СЕРВИСЕ. Начисление запускается из
 * двух мест — одобрение SubmissionPayment (FOUNDER, «Сделки») и подтверждение
 * студенческого Payment (бухгалтер, /payments). Оба обязаны оставлять
 * ОДИНАКОВЫЙ след: разъехавшиеся форматы строк превращают поиск по журналу в
 * угадывание, а именно по нему потом отвечают партнёру на вопрос «почему мне
 * не заплатили за этого клиента».
 *
 * Два носителя намеренно:
 *   1) logger.warn — попадает в stdout контейнера и в алертинг, переживает
 *      сбой БД и виден даже если ActivityLog не записался;
 *   2) ActivityLog(PARTNER_COMMISSION_SKIPPED) — то, что FOUNDER реально
 *      откроет в CRM через месяц. Строка помечена как партнёрская
 *      (PARTNER_SENSITIVE_ACTIONS) и не отдаётся неэлевейтед-ролям.
 *
 * Функция НИКОГДА не бросает: вызывается уже ПОСЛЕ коммита платежа, откатить
 * который отсюда нельзя, а исключение заставило бы бухгалтера/основателя жать
 * «Одобрить» второй раз по уже одобренному платежу.
 */
export async function recordCommissionNonPayment(
  deps: {
    logger: Logger;
    /** undefined ⇒ пишем только в лог (модуль собран без ActivityModule). */
    activity?: ActivityService;
  },
  opts: {
    reason: NonPaymentReason;
    /** Может отсутствовать только если атрибуция исчезла между чтениями. */
    partnerId?: string;
    partnerName?: string;
    studentId?: string | null;
    actorId: string | null;
    actorRole: string;
    /** Короткий контекст для человека: «Сделка #ab12ef34, платёж #cd56». */
    context: string;
    /** Машинночитаемые id для расследования (submissionId/paymentId/...). */
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const why = NON_PAYMENT_REASON_RU[opts.reason];
  const { logger, activity } = deps;

  logger.warn(
    `Партнёрская комиссия НЕ начислена [${opts.reason}]: ${why}. ` +
      `partner=${opts.partnerId ?? 'unknown'}, student=${opts.studentId ?? 'null'}, ` +
      `${opts.context}`,
  );

  if (!activity) return;
  try {
    await activity.log({
      actorId: opts.actorId,
      actorRole: opts.actorRole,
      action: 'PARTNER_COMMISSION_SKIPPED',
      studentId: opts.studentId ?? null,
      details:
        `Комиссия не начислена партнёру` +
        `${opts.partnerName ? ` «${opts.partnerName}»` : ''}: ${why}. ${opts.context}`,
      payload: {
        reason: opts.reason,
        partnerId: opts.partnerId ?? null,
        ...(opts.payload ?? {}),
      },
    });
  } catch (e) {
    // Журнал — вторичный носитель: warn выше уже ушёл. Провал INSERT'а
    // логируем как ошибку, но наверх не поднимаем (см. комментарий к функции).
    logger.error(
      `Не удалось записать PARTNER_COMMISSION_SKIPPED в ActivityLog ` +
        `(${opts.context}): ${(e as Error).message}`,
      (e as Error).stack,
    );
  }
}
