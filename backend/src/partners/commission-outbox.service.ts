import { Injectable, Logger } from '@nestjs/common';
import { CommissionOutboxStatus, SubmissionPaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreditOnceResult,
  isNonPaymentReason,
  NON_PAYMENT_REASON_RU,
  ReferralsService,
} from './referrals.service';

/**
 * Фора немедленному начислению: cron не трогает свежую строку столько
 * времени, сколько approvePayment имеет на то, чтобы отработать её самому.
 *
 * Без форы cron и approvePayment соревновались бы за одну и ту же комиссию.
 * Двойного начисления это не дало бы (CAS-штамп commissionedAt), но в
 * resultReason попадал бы бессмысленный race-lost вместо credited, а в логе —
 * ложная строка «комиссия восстановлена из outbox'а» на каждом втором
 * одобрении. Две минуты с запасом перекрывают одну короткую транзакцию.
 */
export const COMMISSION_OUTBOX_INLINE_GRACE_MS = 2 * 60 * 1000;

/** Строка, по которой доставка провалена окончательно — нужен человек. */
export type CommissionOutboxFailure = {
  id: string;
  submissionId: string;
  paymentId: string;
  studentId: string;
  attempts: number;
  lastError: string;
};

/** Итог одного прохода дренажа. */
export type CommissionOutboxDrainResult = {
  /** Сколько строк реально взято в работу ЭТИМ процессом. */
  claimed: number;
  /** Из них закончились начислением — то есть спасённые комиссии. */
  credited: number;
  /** Штатно пропущено: нет партнёра, уже начислено, платёж отменён и т.п. */
  skipped: number;
  /** Отложено до следующей попытки (сбой, но лимит попыток не исчерпан). */
  retried: number;
  /** Исчерпали лимит попыток — вызывающий обязан уведомить руководство. */
  failed: CommissionOutboxFailure[];
};

/**
 * ДОСТАВКА ПАРТНЁРСКОЙ КОМИССИИ ПО СДЕЛКАМ (transactional outbox).
 *
 * ПРОБЛЕМА, КОТОРУЮ ЭТО РЕШАЕТ. approvePayment коммитит одобрение платежа
 * (Transaction INCOME + Student + Application) одной транзакцией, а
 * начисление партнёру делает ОТДЕЛЬНОЙ транзакцией уже после COMMIT'а —
 * иначе сбой партнёрской части откатывал бы работу бухгалтера. Пока эти две
 * транзакции ничем не связаны, смерть процесса МЕЖДУ ними (деплой, рестарт
 * контейнера, eviction пода, обрыв соединения с БД) означала: платёж одобрен,
 * доход в отчётах, партнёр не получил ничего и уже никогда не получит.
 * commissionedAt оставался null, но по одноплатёжной сделке — а это обычный
 * случай — второго одобрения, которое «догнало» бы начисление, не будет.
 * Ни ретрая, ни сверки, ни следа в БД: пропадала только строка в логе,
 * которую никто не написал.
 *
 * КАК ЭТО РАБОТАЕТ.
 *   1) approvePayment пишет строку CommissionOutbox(status=PENDING) ВНУТРИ
 *      своей транзакции — она коммитится атомарно вместе с платежом либо не
 *      появляется вовсе (роллбэк уносит и её);
 *   2) сразу после COMMIT'а approvePayment сам начисляет комиссию (быстрый
 *      путь, тайминги прежние) и закрывает строку через settle/defer;
 *   3) всё, что быстрый путь не закрыл, добирает drain() из cron'а.
 *
 * ПОЧЕМУ AT-LEAST-ONCE ЗДЕСЬ БЕЗОПАСЕН. Повторная доставка идёт в
 * ReferralsService.creditCommissionForAttributionOnce, который идемпотентен
 * через CAS-штамп ReferralAttribution.commissionedAt: второй проход получит
 * already-credited и ничего не создаст. Поэтому «доставить дважды» физически
 * не может заплатить дважды, а «не доставить» — теперь может только вместе с
 * потерей самой строки outbox'а, то есть вместе с потерей одобрения платежа.
 *
 * ЗАДНИМ ЧИСЛОМ НИЧЕГО НЕ ВОССТАНАВЛИВАЕТСЯ. Строки создаются только новыми
 * одобрениями; сделки, одобренные до появления outbox'а, остаются как есть.
 */
@Injectable()
export class CommissionOutboxService {
  private readonly log = new Logger(CommissionOutboxService.name);

  /** После стольких неудачных попыток строка уходит в FAILED (≈ сутки с бэкоффом). */
  private readonly MAX_ATTEMPTS = 8;
  /** На сколько строка «арендуется» обработчиком, чтобы её не взяла вторая реплика. */
  private readonly LEASE_MS = 5 * 60 * 1000;
  private readonly BACKOFF_BASE_MS = 60 * 1000;
  private readonly BACKOFF_CAP_MS = 6 * 3600 * 1000;

  constructor(
    private prisma: PrismaService,
    private referrals: ReferralsService,
  ) {}

  /**
   * Закрыть строку по результату НЕМЕДЛЕННОГО начисления (быстрый путь).
   * attempts намеренно не трогаем: 0 в этой колонке читается как
   * «доставлено с первого раза, ретраев не было».
   */
  async settle(id: string, result: CreditOnceResult): Promise<void> {
    await this.finish(
      id,
      CommissionOutboxStatus.DONE,
      result.credited ? 'credited' : result.reason,
    );
  }

  /**
   * Быстрый путь упал: считаем попытку и откладываем повтор (экспоненциальный
   * бэкофф). Строка остаётся PENDING — дальше её ведёт cron. Сам метод не
   * бросает: ответ бухгалтеру не должен падать из-за бухгалтерии outbox'а.
   */
  async defer(id: string, error: unknown): Promise<{ exhausted: boolean; attempts: number }> {
    const message = this.errorText(error);
    try {
      const row = await this.prisma.commissionOutbox.update({
        where: { id },
        data: { attempts: { increment: 1 }, lastError: message },
      });
      const exhausted = row.attempts >= this.MAX_ATTEMPTS;
      await this.prisma.commissionOutbox.update({
        where: { id },
        data: exhausted
          ? {
              status: CommissionOutboxStatus.FAILED,
              resultReason: 'delivery-failed',
              processedAt: new Date(),
            }
          : { nextAttemptAt: new Date(Date.now() + this.backoffMs(row.attempts)) },
      });
      return { exhausted, attempts: row.attempts };
    } catch (e) {
      // Не смогли записать даже факт сбоя. Строка осталась PENDING со старым
      // nextAttemptAt — cron заберёт её на ближайшем проходе.
      this.log.error(
        `outbox ${id}: не удалось отложить повтор (${this.errorText(e)}). ` +
          `Строка остаётся PENDING, доставку добьёт cron.`,
      );
      return { exhausted: false, attempts: 0 };
    }
  }

  /**
   * Дренаж из cron'а: добирает строки, которые быстрый путь не закрыл.
   *
   * ЛИЗИНГ ВМЕСТО БЛОКИРОВОК. Строку берёт в работу только тот процесс, чей
   * условный updateMany (`status=PENDING AND nextAttemptAt<=now`) вернул
   * count=1; он же двигает nextAttemptAt на LEASE_MS вперёд. Вторая реплика
   * просто не получит строку, а если обработчик умрёт посреди доставки —
   * лизинг истечёт и строку возьмут заново (повтор безопасен, см. класс).
   */
  async drain(opts: { limit?: number } = {}): Promise<CommissionOutboxDrainResult> {
    const out: CommissionOutboxDrainResult = {
      claimed: 0,
      credited: 0,
      skipped: 0,
      retried: 0,
      failed: [],
    };

    const rows = await this.prisma.commissionOutbox.findMany({
      where: {
        status: CommissionOutboxStatus.PENDING,
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      take: opts.limit ?? 100,
    });

    for (const row of rows) {
      const now = new Date();
      const claim = await this.prisma.commissionOutbox.updateMany({
        where: {
          id: row.id,
          status: CommissionOutboxStatus.PENDING,
          nextAttemptAt: { lte: now },
        },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + this.LEASE_MS),
        },
      });
      // count=0 — строку уже забрал другой процесс (или её только что закрыл
      // быстрый путь). Не наша, идём дальше.
      if (claim.count === 0) continue;
      out.claimed++;
      const attempts = row.attempts + 1;

      try {
        // Сделку могли отменить, пока строка ждала доставки: changeStatus
        // CANCELLED реверсирует INCOME и переводит платёж в REJECTED. Платить
        // партнёру за возвращённые деньги нельзя. Быстрому пути такая проверка
        // не нужна — там платёж одобрен миллисекунду назад.
        const payment = await this.prisma.submissionPayment.findUnique({
          where: { id: row.paymentId },
          select: { status: true },
        });
        if (!payment || payment.status !== SubmissionPaymentStatus.APPROVED) {
          this.log.warn(
            `outbox ${row.id}: платёж ${row.paymentId} больше не APPROVED ` +
              `(сделка ${row.submissionId} отменена?) — комиссия не начисляется.`,
          );
          await this.finish(row.id, CommissionOutboxStatus.DONE, 'payment-not-approved');
          out.skipped++;
          continue;
        }

        // Аргументы — ровно те, что заморожены при одобрении. Пересчитывать
        // базу по «сегодняшнему» состоянию сделки нельзя: сумма платежа и
        // валюта могли смениться, а начисление относится к тому платежу.
        const credit = await this.referrals.creditCommissionForAttributionOnce({
          studentId: row.studentId,
          applicationId: row.applicationId,
          applicationIds: [row.sourceApplicationId],
          baseAmountCents: row.baseAmountCents,
          baseCurrency: row.baseCurrency,
          transactionId: row.financeTransactionId,
          sourceLabel: row.sourceLabel ?? undefined,
        });

        if (credit.credited) {
          out.credited++;
          // warn, а не log: сюда попадают ТОЛЬКО те начисления, которые
          // быстрый путь потерял. Раньше такая комиссия исчезала бесследно.
          this.log.warn(
            `Партнёрская комиссия восстановлена из outbox'а: partner=${credit.partnerId}, ` +
              `commission=${credit.commissionId}, ${credit.amountCents} копеек TJS ` +
              `(submission=${row.submissionId}, payment=${row.paymentId}, попытка ${attempts}). ` +
              `Немедленное начисление при одобрении не отработало — ищите рестарт/деплой ` +
              `в момент одобрения платежа.`,
          );
        } else {
          out.skipped++;
          if (isNonPaymentReason(credit.reason)) {
            // Отказ в деньгах живому партнёру. Строку аудита здесь не пишем:
            // ActivityLog требует actorId, а у cron'а актора нет — этот исход
            // остаётся в логе как решение системы, а не человека.
            this.log.warn(
              `outbox ${row.id}: комиссия не начислена — ${NON_PAYMENT_REASON_RU[credit.reason]} ` +
                `(partner=${credit.partnerId ?? '—'}, submission=${row.submissionId}, ` +
                `payment=${row.paymentId}).`,
            );
          }
        }

        await this.finish(
          row.id,
          CommissionOutboxStatus.DONE,
          credit.credited ? 'credited' : credit.reason,
        );
      } catch (e) {
        const message = this.errorText(e);
        if (attempts >= this.MAX_ATTEMPTS) {
          await this.finish(row.id, CommissionOutboxStatus.FAILED, 'delivery-failed', message);
          out.failed.push({
            id: row.id,
            submissionId: row.submissionId,
            paymentId: row.paymentId,
            studentId: row.studentId,
            attempts,
            lastError: message,
          });
          this.log.error(
            `outbox ${row.id}: доставка комиссии провалена окончательно за ${attempts} попыток ` +
              `(submission=${row.submissionId}, payment=${row.paymentId}): ${message}`,
          );
        } else {
          out.retried++;
          this.log.error(
            `outbox ${row.id}: попытка ${attempts} не удалась, повтор позже ` +
              `(submission=${row.submissionId}): ${message}`,
          );
          await this.prisma.commissionOutbox
            .update({
              where: { id: row.id },
              data: {
                lastError: message,
                nextAttemptAt: new Date(Date.now() + this.backoffMs(attempts)),
              },
            })
            .catch((err) =>
              this.log.error(`outbox ${row.id}: не удалось записать бэкофф: ${this.errorText(err)}`),
            );
        }
      }
    }

    return out;
  }

  /** Закрыть строку итоговым статусом. Никогда не бросает. */
  private async finish(
    id: string,
    status: CommissionOutboxStatus,
    resultReason: string,
    lastError?: string,
  ): Promise<void> {
    try {
      await this.prisma.commissionOutbox.update({
        where: { id },
        data: {
          status,
          resultReason,
          processedAt: new Date(),
          ...(lastError === undefined ? {} : { lastError }),
        },
      });
    } catch (e) {
      // Комиссия к этому моменту УЖЕ начислена (либо осознанно пропущена), а
      // строка осталась PENDING. Худшее последствие — cron повторит доставку
      // и получит already-credited: ни двойного начисления, ни потери. Лог.
      this.log.error(
        `outbox ${id}: не удалось записать итог (${status}/${resultReason}): ` +
          `${this.errorText(e)}. Строка остаётся PENDING — повторная доставка идемпотентна.`,
      );
    }
  }

  /** Экспоненциальный бэкофф: 1м, 2м, 4м… с потолком BACKOFF_CAP_MS. */
  private backoffMs(attempts: number): number {
    const factor = 2 ** Math.min(Math.max(attempts - 1, 0), 16);
    return Math.min(this.BACKOFF_BASE_MS * factor, this.BACKOFF_CAP_MS);
  }

  /** Текст ошибки для колонки lastError — обрезаем, чтобы не раздувать строку. */
  private errorText(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    return raw.slice(0, 900);
  }
}
