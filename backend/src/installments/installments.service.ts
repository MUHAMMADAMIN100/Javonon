import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentStageStatus,
  Prisma,
  SubmissionPaymentStatus,
  SubmissionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { hasRole, isElevated, isFounder, UserWithRoles } from '../auth/role-utils';
import { tjParseLocalDate, tjStartOfDay, tjStartOfDayPlusDays } from '../common/tj-time';
import {
  InstallmentTemplateStageDto,
  UpdatePaymentStageDto,
} from './dto/installments.dto';

/**
 * РАССРОЧКА ПО СДЕЛКЕ.
 *
 * Шаблон живёт на программе (ProgramInstallmentStage: доля в процентах +
 * сдвиг в днях). При создании сделки шаблон МАТЕРИАЛИЗУЕТСЯ в строки
 * PaymentStage; дальше менеджер правит суммы и даты руками, а шаблон на уже
 * созданные этапы не влияет — иначе правка каталога переписывала бы
 * подписанные контракты задним числом.
 *
 * ДЕНЬГИ. Те же единицы, что у SaleSubmission.totalAmount и
 * SubmissionPayment.amount: Float в ЦЕЛЫХ единицах валюты, не центы (в центы
 * переводится только партнёрская комиссия, на своей границе —
 * `Math.round(amount * 100)` в submissions.service.ts). Своей валюты у этапа
 * нет, она наследуется из submission.currency.
 *
 * ЕДИНСТВЕННЫЙ ПУТЬ В PAID — сумма одобренных SubmissionPayment
 * (settleStagesTx, вызывается из SubmissionsService — approvePayment,
 * updatePayment, deletePayment — внутри ТОЙ ЖЕ транзакции, что меняет
 * деньги). Второго места, где этап становится PAID, нет и заводить нельзя.
 *
 * ДОЛГ — уже существующий Application.paymentPending. Второго источника
 * правды про задолженность не заводим: карточка «Студентов с задолженностью»
 * на дашборде и раздел «Задолженность студентов» в финансах читают именно
 * его (FinanceService.pendingPayments).
 *
 * СВЕДЕНИЕ С КОНТРАКТОМ. sum(PaymentStage.amount) ==
 * SaleSubmission.totalAmount ТОЧНО — и это держится не только в момент
 * материализации (allocateStageAmounts), а на КАЖДОМ пути, который двигает
 * любую из двух сторон равенства:
 *   - правка суммы этапа (updateStage) — перераспределение внутри
 *     фиксированного контракта, разница уходит на последний неоплаченный
 *     этап (rebalancePlanForStageEditTx);
 *   - правка суммы контракта (SubmissionsService.updateSubmission) —
 *     пересборка неоплаченных этапов под новую цену
 *     (reallocateOnTotalChangeTx).
 * Оплаченные этапы не двигает ни один из них: они сведены с одобренными
 * платежами. Карточка сделки получает сумму этапов и признак расхождения
 * отдельными полями (listForSubmission) — чтобы план, разъехавшийся в обход
 * API, было видно, а не только по вечной просрочке.
 */

/**
 * Допуск при сравнении денег. То же значение и та же причина, что у
 * PAYMENT_PHASE_EPSILON в submissions.service.ts: amount/totalAmount хранятся
 * как Float, и 3000 + 1999.999999 не должно считаться «не покрыл этап».
 * Один цент — предел, ниже которого разница неразличима для кассы.
 */
export const PAYMENT_STAGE_EPSILON = 0.01;

/** Допуск при проверке «проценты шаблона дают ровно 100». */
const PERCENT_SUM_EPSILON = 0.01;

/** Потолок на число этапов — тот же, что в ArrayMaxSize у DTO шаблона. */
const MAX_TEMPLATE_STAGES = 24;

type StageAmountInput = { percent: number };

/**
 * Разложить сумму контракта по долям этапов так, чтобы сумма частей СОВПАЛА
 * с контрактом до копейки.
 *
 * Считаем в целых центах, а не в Float-процентах: наивное
 * `round2(total * percent / 100)` по каждому этапу теряет (или добавляет)
 * копейки — рассрочка 3×33.33% от 100 дала бы 99.99, и сделка навсегда
 * оставалась бы недоплаченной на цент, то есть вечно висела бы в должниках.
 *
 * Остаток от округления кладём на ПОСЛЕДНИЙ этап (`totalCents - allocated`),
 * а не размазываем: последний взнос — тот, которым контракт закрывают, и
 * именно он обязан «добить» сумму. Отсюда же следует, что последний этап
 * может отличаться от своей номинальной доли на несколько копеек — это
 * ожидаемо и видно менеджеру в списке этапов.
 *
 * Экспортируется отдельно от сервиса, потому что это чистая функция без БД:
 * её можно проверить в отрыве от Prisma.
 */
export function allocateStageAmounts(
  totalAmount: number,
  stages: StageAmountInput[],
): number[] {
  if (stages.length === 0) return [];
  const totalCents = Math.round(totalAmount * 100);
  const out: number[] = [];
  let allocated = 0;
  for (let i = 0; i < stages.length - 1; i++) {
    const cents = Math.round((totalCents * stages[i].percent) / 100);
    allocated += cents;
    out.push(cents / 100);
  }
  // Последний этап — остаток, а не своя доля. Сумма частей == totalCents
  // ровно по построению, независимо от того, как легли округления выше.
  out.push((totalCents - allocated) / 100);
  return out;
}

/** Агрегаты по списку этапов для карточки сделки и кабинета студента. */
export function summariseStages(
  stages: Array<{ amount: number; status: PaymentStageStatus; dueDate: Date }>,
) {
  let paid = 0;
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueCount = 0;
  let nextDueDate: Date | null = null;
  for (const s of stages) {
    if (s.status === PaymentStageStatus.PAID) {
      paid += s.amount;
      continue;
    }
    outstanding += s.amount;
    if (s.status === PaymentStageStatus.OVERDUE) {
      overdueAmount += s.amount;
      overdueCount++;
    }
    // Ближайший несписанный срок — то, что кабинет студента показывает
    // строкой «следующий платёж».
    if (!nextDueDate || s.dueDate < nextDueDate) nextDueDate = s.dueDate;
  }
  return {
    stageCount: stages.length,
    paid: round2(paid),
    outstanding: round2(outstanding),
    overdueAmount: round2(overdueAmount),
    overdueCount,
    nextDueDate,
  };
}

/** Копеечное округление для отображаемых агрегатов (не для хранения). */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Деньги в ЦЕЛЫХ ЦЕНТАХ и обратно. Та же причина, что у
 * allocateStageAmounts: инвариант «сумма этапов == сумма контракта» обязан
 * держаться ТОЧНО, а Float-арифметика оставляет копеечный хвост — и хвост в
 * этом инварианте равнозначен вечному долгу на цент (последний этап никогда
 * не покрывается, сделка навсегда в должниках).
 */
function toCents(v: number): number {
  return Math.round(v * 100);
}
function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Разложить `totalCents` по `weights` так, чтобы сумма частей совпала с
 * `totalCents` ДО ЦЕНТА и ни одна часть не оказалась пустой.
 *
 * Основной ход — пропорционально текущим долям (менеджер уже согласовал с
 * клиентом «первый взнос больше остальных», и правка суммы контракта не
 * должна это ломать), остаток от округления кладём на ПОСЛЕДНЮЮ часть: тот
 * же принцип, что у allocateStageAmounts — «добивает» сумму последний взнос.
 *
 * Запасной ровный дележ нужен для двух вырожденных случаев: доли нулевые
 * (делить не по чему) и пропорция дала часть в ноль/минус (новая сумма
 * контракта много меньше старой). Он тоже сходится ровно, и при
 * `totalCents >= weights.length` — что обязан проверить вызывающий — каждая
 * часть выходит >= 1 цента.
 */
export function distributeCents(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const positive = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = positive.reduce((acc, w) => acc + w, 0);
  if (weightSum > 0) {
    const out: number[] = [];
    let allocated = 0;
    for (let i = 0; i < n - 1; i++) {
      const cents = Math.round((totalCents * positive[i]) / weightSum);
      allocated += cents;
      out.push(cents);
    }
    out.push(totalCents - allocated);
    if (out.every((c) => c >= 1)) return out;
  }
  const base = Math.floor(totalCents / n);
  const even: number[] = [];
  let allocated = 0;
  for (let i = 0; i < n - 1; i++) {
    even.push(base);
    allocated += base;
  }
  even.push(totalCents - allocated);
  return even;
}

@Injectable()
export class InstallmentsService {
  private readonly logger = new Logger(InstallmentsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  // ───────────────────────────── ШАБЛОН ПРОГРАММЫ ─────────────────────────

  /** Этапы шаблона программы, по порядку. Пусто = рассрочки нет. */
  async getTemplate(programId: string) {
    return this.prisma.programInstallmentStage.findMany({
      where: { programId },
      orderBy: { order: 'asc' },
    });
  }

  /**
   * Полная перезапись шаблона (PUT-семантика): что прислали — то и лежит.
   *
   * Правка шаблона НЕ трогает уже созданные PaymentStage: сделка держит свои
   * этапы с момента подписания, иначе изменение каталога переписывало бы
   * условия действующих контрактов.
   */
  async saveTemplate(
    user: UserWithRoles | null | undefined,
    programId: string,
    stages: InstallmentTemplateStageDto[],
  ) {
    // Шаблон — часть карточки программы, поэтому гейт тот же, что у стипендий
    // и документов программы (ProgramsService.addScholarship): руководство.
    if (!isElevated(user)) {
      throw new ForbiddenException('Только администратор может менять рассрочку программы');
    }
    const program = await this.prisma.program.findUnique({
      where: { id: programId },
      select: { id: true },
    });
    if (!program) throw new NotFoundException('Программа не найдена');

    if (stages.length > MAX_TEMPLATE_STAGES) {
      throw new BadRequestException(`Слишком много этапов (макс. ${MAX_TEMPLATE_STAGES})`);
    }
    if (stages.length > 0) {
      const sum = stages.reduce((acc, s) => acc + s.percent, 0);
      if (Math.abs(sum - 100) > PERCENT_SUM_EPSILON) {
        throw new BadRequestException(
          `Сумма долей этапов должна быть 100% (сейчас ${round2(sum)}%)`,
        );
      }
    }

    // Транзакция: между удалением старых и вставкой новых шаблон не должен
    // быть виден наполовину — в этот момент могут создавать сделку, и она
    // материализовала бы огрызок плана.
    await this.prisma.$transaction(async (tx) => {
      await tx.programInstallmentStage.deleteMany({ where: { programId } });
      if (stages.length === 0) return;
      await tx.programInstallmentStage.createMany({
        data: stages.map((s, i) => ({
          programId,
          // order нормализуем по позиции в присланном массиве — клиент не
          // обязан считать номера сам, а @@unique([programId, order]) требует
          // отсутствия дыр и повторов.
          order: i + 1,
          title: s.title?.trim().slice(0, 120) || null,
          percent: s.percent,
          offsetDays: s.offsetDays ?? 0,
        })),
      });
    });
    return this.getTemplate(programId);
  }

  // ───────────────────────── МАТЕРИАЛИЗАЦИЯ ШАБЛОНА ───────────────────────

  /**
   * Построить этапы для НОВОЙ сделки. Возвращает данные для вложенного
   * `create` внутри `saleSubmission.create` — так этапы коммитятся одной
   * транзакцией со сделкой, и «сделка есть, а плана нет» не бывает.
   *
   * ШАБЛОНА НЕТ — ЭТАПОВ НЕТ. Пустой ответ означает «у программы рассрочки не
   * заведено»; выдумывать план из одного этапа на всю сумму нельзя — это
   * молча объявило бы клиента должником на весь контракт в день подписания.
   *
   * `dealStart` — момент создания сделки (SaleSubmission.createdAt на
   * практике совпадает с ним с точностью до миллисекунд, а нам нужна лишь
   * календарная дата в Душанбе). firstApprovedAt на этот момент ещё null,
   * поэтому стартом плана служит именно заключение сделки.
   */
  async buildStagesForNewSubmission(opts: {
    programId: string | null | undefined;
    totalAmount: number;
    dealStart: Date;
  }): Promise<Prisma.PaymentStageCreateWithoutSubmissionInput[]> {
    const { programId, totalAmount, dealStart } = opts;
    if (!programId) return [];
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return [];

    const template = await this.prisma.programInstallmentStage.findMany({
      where: { programId },
      orderBy: { order: 'asc' },
    });
    if (template.length === 0) return [];

    // Защита от дрейфа: шаблон пишется только через saveTemplate, который
    // требует ровно 100%, но если строки поправили в обход (SQL, импорт,
    // ручная миграция) — молча растягивать доли до 100% нельзя: это тихо
    // изменило бы суммы взносов. Не материализуем ничего и громко логируем;
    // менеджер увидит сделку без плана и починит шаблон.
    const percentSum = template.reduce((acc, s) => acc + s.percent, 0);
    if (Math.abs(percentSum - 100) > PERCENT_SUM_EPSILON) {
      this.logger.error(
        `Шаблон рассрочки программы ${programId} даёт ${percentSum}% вместо 100% — ` +
          `этапы для сделки НЕ созданы. Почините шаблон в карточке программы.`,
      );
      return [];
    }

    const amounts = allocateStageAmounts(totalAmount, template);
    return template.map((s, i) => ({
      order: i + 1,
      title: s.title,
      amount: amounts[i],
      // Срок = душанбинская полночь дня «старт сделки + offsetDays».
      // Просроченным этап считается только когда этот день ПОЛНОСТЬЮ прошёл
      // (см. sweepOverdueStages), т.е. срок фактически inclusive.
      dueDate: tjStartOfDayPlusDays(dealStart, s.offsetDays),
    }));
  }

  // ───────────────────────────── ПОГАШЕНИЕ ────────────────────────────────

  /**
   * Погасить этапы одобренным платежом. Вызывается ТОЛЬКО из
   * SubmissionsService (approvePayment / updatePayment / deletePayment) и
   * ТОЛЬКО внутри их транзакции — это единственный путь этапа в PAID.
   *
   * ПРАВИЛО ЧАСТИЧНОЙ ОПЛАТЫ (осознанное решение, не побочный эффект):
   * этап закрывается ЦЕЛИКОМ или не закрывается вовсе. Считаем не «сколько
   * принёс этот платёж», а КУМУЛЯТИВНУЮ сумму всех APPROVED-платежей сделки
   * и идём по этапам по порядку, пока накопленного хватает на очередной этап
   * полностью. Первый непокрытый этап останавливает проход: более поздний
   * этап не может быть оплачен раньше более раннего.
   *
   * Следствия, ради которых правило и выбрано:
   *   - недоплата НЕ дробит этап и никуда не записывает «остаток» — этап
   *     остаётся PENDING/OVERDUE со своей полной суммой, а недостающее видно
   *     как разница между суммой этапов и суммой одобренных платежей;
   *   - излишек НЕ теряется: он лежит в той же кумулятивной сумме и
   *     автоматически идёт в зачёт следующего этапа при следующем одобрении;
   *   - функция ИДЕМПОТЕНТНА и самовосстанавливающаяся: повторный прогон по
   *     той же сделке даёт тот же набор PAID. Отдельного состояния «сколько
   *     этот платёж уже израсходовал» нет, а значит и рассинхронизироваться
   *     нечему.
   *
   * ФУНКЦИЯ ОТ СОСТОЯНИЯ, А НЕ ОТ СОБЫТИЯ. Она приводит статусы этапов в
   * соответствие с кумулятивной суммой в ОБЕ стороны, поэтому её же зовут
   * SubmissionsService.deletePayment (основатель удалил одобренный платёж —
   * сумма упала, закрытый им этап вернулся в долг) и
   * SubmissionsService.updatePayment (основатель поправил сумму — этапы
   * гасятся или расгашаются под новую цифру). Второго ПРАВИЛА при этом не
   * появляется — правило по-прежнему одно: «этап оплачен тогда и только
   * тогда, когда сумма одобренных платежей его покрывает».
   *
   * Второй ответственностью функция синхронизирует Application.paymentPending
   * (см. syncPaymentPending) — иначе погашенная просрочка осталась бы висеть
   * в должниках дашборда.
   */
  async settleStagesTx(
    tx: Prisma.TransactionClient,
    opts: {
      submissionId: string;
      applicationId: string | null;
      /**
       * Платёж-триггер: тот, чьё одобрение и запустило проход. `null`, когда
       * триггера нет — удаление платежа (deletePayment) и пересчёт после
       * ручной правки суммы этапа (updateStage). Пустую строку сюда
       * передавать НЕЛЬЗЯ: колонка — внешний ключ, и '' уронил бы всю
       * транзакцию по P2003.
       *
       * `null` НЕ означает «записать в PaymentStage.paymentId NULL»: если на
       * таком проходе непокрытый этап окажется покрытым, погасивший его
       * платёж вычисляется по состоянию (см. resolveSettlingPayment ниже).
       */
      paymentId: string | null;
      paidAt: Date;
    },
  ): Promise<{
    hasStages: boolean;
    settled: number;
    reverted: number;
    overdueLeft: number;
  }> {
    const stages = await tx.paymentStage.findMany({
      where: { submissionId: opts.submissionId },
      orderBy: { order: 'asc' },
      select: { id: true, amount: true, status: true, dueDate: true },
    });
    if (stages.length === 0) {
      return { hasStages: false, settled: 0, reverted: 0, overdueLeft: 0 };
    }

    // Читаем ТУ ЖЕ транзакцию, куда CAS-апдейт approvePayment уже перевёл
    // текущий платёж в APPROVED, — его сумма здесь уже учтена. Тот же приём
    // и тот же источник, что у расчёта PaymentPhaseStatus рядом.
    const agg = await tx.submissionPayment.aggregate({
      where: {
        submissionId: opts.submissionId,
        status: SubmissionPaymentStatus.APPROVED,
      },
      _sum: { amount: true },
    });
    const approvedSoFar = agg._sum.amount ?? 0;

    /**
     * Какой платёж закрыл этап с порогом `threshold` (кумулятивная сумма
     * этапов включительно по него).
     *
     * Нужна только когда платежа-триггера нет (`opts.paymentId === null`), а
     * этап всё равно оказался покрыт: так бывает после удаления платежа и
     * после ручного УМЕНЬШЕНИЯ суммы этапа, когда его накрывают деньги,
     * одобренные раньше. Писать в таком случае `paymentId: null` нельзя —
     * этап стал бы PAID без ссылки на деньги и с датой пересчёта вместо даты
     * прихода, то есть аудит-след («каким платежом закрыт») исчезал бы
     * ровно там, где он нужнее всего.
     *
     * Порядок — тот же, в котором деньги фактически приходили (`paidAt`, при
     * равенстве — `id` для детерминированности): накопительный итог
     * APPROVED-платежей, и «добил» этап тот, на котором итог впервые
     * перекрыл порог. Тот же критерий покрытия и тот же эпсилон, что у
     * основного прохода, — иначе резолвер мог бы не найти платёж там, где
     * проход считает этап покрытым.
     *
     * Список читается лениво и один раз на весь проход: на прямом ходе
     * (одобрение) он не нужен вовсе.
     */
    let approvedRows: Promise<
      Array<{ id: string; amount: number; paidAt: Date }>
    > | null = null;
    const resolveSettlingPayment = async (threshold: number) => {
      const loading =
        approvedRows ??
        tx.submissionPayment.findMany({
          where: {
            submissionId: opts.submissionId,
            status: SubmissionPaymentStatus.APPROVED,
          },
          orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
          select: { id: true, amount: true, paidAt: true },
        });
      approvedRows = loading;
      let running = 0;
      for (const p of await loading) {
        running += p.amount;
        if (running >= threshold - PAYMENT_STAGE_EPSILON) return p;
      }
      return null;
    };

    // Покрытие считаем по КАЖДОМУ этапу, а не только до первого непокрытого:
    // проход обязан уметь и снимать PAID (см. reverse-ветку ниже), а для
    // этого нужно знать статус-по-состоянию для всех строк. Сам критерий
    // «самые ранние, которые покрыты» от этого не меняется: суммы этапов
    // неотрицательны, поэтому cumulative монотонно растёт и покрытые всегда
    // образуют префикс списка.
    let cumulative = 0;
    let settled = 0;
    let reverted = 0;
    let overdueLeft = 0;
    const today = tjStartOfDay(new Date());
    for (const stage of stages) {
      cumulative += stage.amount;
      const covered = approvedSoFar >= cumulative - PAYMENT_STAGE_EPSILON;

      if (covered) {
        if (stage.status !== PaymentStageStatus.PAID) {
          // Платёж, которым этап оказался закрыт. На прямом ходе это
          // платёж-триггер: при нескольких платежах — последний из них, тот,
          // что «добил» сумму этапа.
          let settledById = opts.paymentId;
          let settledAt = opts.paidAt;
          if (settledById === null) {
            // Триггера нет (удаление платежа, пересчёт после правки суммы
            // этапа), а этап покрыт — значит его накрыли деньги, одобренные
            // РАНЬШЕ. Вычисляем какие именно, вместо записи NULL.
            const settledBy = await resolveSettlingPayment(cumulative);
            if (!settledBy) {
              // Кумулятивная сумма говорит «покрыт», а строк платежей под
              // это нет — состояние противоречиво (оба числа читаются из
              // одной и той же таблицы в одной транзакции). В PAID НЕ
              // переводим: видимый долг чинится менеджером, а оплаченный
              // этап без денег за ним не чинится вообще.
              this.logger.error(
                `Рассрочка: этап ${stage.id} сделки ${opts.submissionId} покрыт ` +
                  `кумулятивной суммой ${approvedSoFar} (порог ${cumulative}), но ` +
                  `одобренного платежа под это не нашлось — в PAID не переводим.`,
              );
              if (stage.status === PaymentStageStatus.OVERDUE) overdueLeft++;
              continue;
            }
            settledById = settledBy.id;
            // Дата прихода тех самых денег, а не момент пересчёта: иначе у
            // этапа стояла бы дата удаления чужого платежа или дата правки.
            settledAt = settledBy.paidAt;
          }
          await tx.paymentStage.update({
            where: { id: stage.id },
            data: {
              status: PaymentStageStatus.PAID,
              paidAt: settledAt,
              paymentId: settledById,
            },
          });
          settled++;
        }
        continue;
      }

      // Этап НЕ покрыт. В обычном сценарии одобрения он и так не PAID —
      // здесь ничего не происходит. Ветка нужна для обратного хода: когда
      // основатель удаляет одобренный платёж, кумулятивная сумма падает, и
      // этап, который этим платежом закрывался, обязан вернуться в долг.
      // Оставить его PAID значило бы «деньги вернули, а этап оплачен» —
      // ровно то расхождение, из-за которого потом не сходится касса.
      //
      // Это НЕ второй путь в PAID: правило одно и то же в обе стороны —
      // «этап оплачен тогда и только тогда, когда кумулятивная сумма
      // одобренных платежей его покрывает».
      if (stage.status === PaymentStageStatus.PAID) {
        // Куда возвращать — решает срок, а не история: OVERDUE проставляет
        // суточный cron, но ждать до завтра, чтобы показать уже наступивший
        // долг, незачем.
        const back =
          stage.dueDate < today ? PaymentStageStatus.OVERDUE : PaymentStageStatus.PENDING;
        await tx.paymentStage.update({
          where: { id: stage.id },
          data: { status: back, paidAt: null, paymentId: null },
        });
        reverted++;
        if (back === PaymentStageStatus.OVERDUE) overdueLeft++;
        continue;
      }
      if (stage.status === PaymentStageStatus.OVERDUE) overdueLeft++;
    }

    await this.syncPaymentPendingTx(tx, opts.applicationId, overdueLeft > 0);
    return { hasStages: true, settled, reverted, overdueLeft };
  }

  /**
   * Привести Application.paymentPending в соответствие с планом рассрочки.
   *
   * ВЫЗЫВАЕТСЯ ТОЛЬКО ДЛЯ СДЕЛОК, У КОТОРЫХ ЕСТЬ ЭТАПЫ. Флаг общий: менеджер
   * ставит и снимает его руками в карточке заявки для долгов, к рассрочке
   * отношения не имеющих. Трогать его у заявки без плана значило бы стирать
   * ручную пометку — поэтому у сделок без этапов флаг остаётся целиком за
   * менеджером, а у сделок с планом источником правды становится план.
   */
  private async syncPaymentPendingTx(
    tx: Prisma.TransactionClient,
    applicationId: string | null,
    pending: boolean,
  ) {
    if (!applicationId) return;
    // updateMany, а не update: заявку могли удалить между чтением сделки и
    // этим шагом, и P2025 уронил бы одобрение платежа целиком.
    await tx.application.updateMany({
      where: { id: applicationId, paymentPending: { not: pending } },
      data: { paymentPending: pending },
    });
  }

  /**
   * Пересчитать Application.paymentPending по ТЕКУЩЕМУ состоянию плана
   * рассрочки сделки — на путях, где деньги не двигаются.
   *
   * ЗАЧЕМ ОТДЕЛЬНО ОТ settleStagesTx. Тот считает покрытие этапов от суммы
   * APPROVED-платежей и потому зовётся только там, где эта сумма меняется
   * (approvePayment / updatePayment / deletePayment). Но у сделки есть ещё
   * выходы, где сумма прежняя, а долг обязан пересчитаться: закрытие
   * (COMPLETED) и hard delete. Раньше по ним флаг не трогал никто — этапы
   * оставались OVERDUE, а заявка висела в FinanceService.pendingPayments
   * («Студентов с задолженностью» на дашборде и «Задолженность студентов» в
   * финансах) НАВСЕГДА: снять её мог только ручной PATCH /applications/:id.
   * Суточный cron не спасает — sweepOverdueStages джойнит `s.status = ACTIVE`
   * (по отменённой/закрытой сделке уведомлять уже незачем) и умеет только
   * ПОДНИМАТЬ флаг, никогда не опускать.
   *
   * ПРАВИЛО ОДНО И ТО ЖЕ ВЕЗДЕ: должник — это заявка, у сделки которой есть
   * хотя бы один OVERDUE-этап. Тот же критерий у sweepOverdueStages,
   * settleStagesTx (overdueLeft) и updateStage. Второго флага-должника не
   * заводим: источник правды остаётся один — paymentPending.
   *
   * ТОТ ЖЕ ИНВАРИАНТ, ЧТО У syncPaymentPendingTx: заявку СДЕЛКИ БЕЗ ЭТАПОВ не
   * трогаем вовсе (hasStages = false). Флаг общий, менеджер ставит его руками
   * для долгов, к рассрочке отношения не имеющих, и стирать эту пометку
   * закрытием или удалением сделки нельзя.
   *
   * Скоуп безопасен: SaleSubmission.applicationId — @unique, то есть заявка
   * принадлежит ровно одной сделке, и снятый здесь флаг не может погасить
   * долг чужой (живой) сделки того же студента.
   *
   * `settled: true` — «эта сделка больше не может порождать долг» (удаление):
   * считаем просрочек ноль, не глядя на статусы этапов. Для удаления это
   * единственный способ вообще что-то посчитать: вызывать ПОСЛЕ delete нечего,
   * PaymentStage уходит каскадом вместе со сделкой.
   */
  async syncPaymentPendingForSubmissionTx(
    tx: Prisma.TransactionClient,
    opts: {
      submissionId: string;
      applicationId: string | null;
      settled?: boolean;
    },
  ): Promise<{ hasStages: boolean; overdue: number; pending: boolean }> {
    const stageCount = await tx.paymentStage.count({
      where: { submissionId: opts.submissionId },
    });
    if (stageCount === 0) return { hasStages: false, overdue: 0, pending: false };

    const overdue = opts.settled
      ? 0
      : await tx.paymentStage.count({
          where: {
            submissionId: opts.submissionId,
            status: PaymentStageStatus.OVERDUE,
          },
        });
    const pending = overdue > 0;
    await this.syncPaymentPendingTx(tx, opts.applicationId, pending);
    return { hasStages: true, overdue, pending };
  }

  // ──────────────────────────── ПРОСРОЧКА (CRON) ──────────────────────────

  /**
   * Суточный проход: PENDING-этапы, чей срок истёк, становятся OVERDUE,
   * заявка помечается должником, ответственный менеджер получает уведомление.
   * СТУДЕНТА НЕ УВЕДОМЛЯЕМ — по требованию: просрочка это внутренний сигнал
   * менеджеру, а не давление на клиента.
   *
   * ГРАНИЦА СУТОК — душанбинская (tjStartOfDay). Сравнение `dueDate < начало
   * сегодняшнего дня` означает «день срока полностью прошёл»: этап со сроком
   * «сегодня» просроченным не считается. С сырым `new Date()` на UTC-сервере
   * Railway этап падал бы в просрочку за 5 часов до полуночи в Душанбе.
   *
   * ИДЕМПОТЕНТНОСТЬ — на самом переводе статуса, а не на отдельном флаге
   * «уведомляли ли». Захват делается одним `UPDATE ... WHERE status='PENDING'
   * ... RETURNING id`, поэтому:
   *   - второй прогон в тот же день не находит ни одной PENDING-строки с
   *     истёкшим сроком (все уже OVERDUE) и не шлёт НИЧЕГО;
   *   - две реплики, стартовавшие одновременно, делят строки между собой
   *     атомарно — одна и та же строка не может вернуться обоим, значит и
   *     двух уведомлений по одному этапу не будет.
   * Именно поэтому уведомления строятся ПО РЕЗУЛЬТАТУ захвата, а не по
   * предварительной выборке: выборка «кого бы пометить» у двух реплик
   * совпала бы, и менеджер получил бы дубль.
   *
   * ПРИЗНАК ДОЛЖНИКА НА ЗАХВАТ НЕ ВЕШАЕТСЯ. Захват одноразовый ПО
   * ПОСТРОЕНИЮ: PENDING-строка возвращается ровно один раз за свою жизнь, и
   * назавтра она уже OVERDUE, то есть в выборку не попадёт. Пока это
   * идемпотентность уведомлений — это ровно то, что нужно; но если на тот же
   * одноразовый результат повесить ещё и Application.paymentPending, смерть
   * процесса (или обрыв соединения с БД) между COMMIT'ом захвата и апдейтом
   * заявок оставит этапы в OVERDUE, а заявки — с paymentPending = false, и
   * ПОЧИНИТЬ ЭТО БУДЕТ НЕЧЕМ: следующий проход этих строк уже не увидит.
   * Реальный должник молча исчез бы из «Задолженности студентов» навсегда.
   *
   * Поэтому флаг не «ставится событием», а ВЫВОДИТСЯ ИЗ СОСТОЯНИЯ: тем же
   * проходом, отдельным `UPDATE "Application" ... FROM (...)`, для каждой
   * ACTIVE-сделки С ПЛАНОМ считается «есть ли у неё хоть один OVERDUE-этап»,
   * и заявке проставляется именно это значение. Такой апдейт
   * самовосстанавливающийся: где бы предыдущий прогон ни умер, следующий
   * приводит флаг в соответствие с этапами — и в true, и в false. Оба
   * запроса при этом идут ОДНОЙ транзакцией ($transaction-массив), так что в
   * норме расхождения не возникает вовсе, а вывод из состояния страхует
   * ненормальный случай. Отдельная колонка-«уведомляли ли» и второй флаг
   * долга для этого не нужны — источник правды остаётся один.
   *
   * ЗАЯВКИ БЕЗ ПЛАНА пересчёт НЕ ТРОГАЕТ (в подзапросе — JOIN на
   * PaymentStage): там флаг целиком ручной. У сделки с планом источником
   * правды становится план — то же правило, что уже действует в
   * syncPaymentPendingTx, просто теперь оно применяется не только в момент
   * одобрения платежа.
   */
  async sweepOverdueStages(): Promise<{
    flipped: number;
    managersNotified: number;
    debtorsSynced: number;
  }> {
    const dayStart = tjStartOfDay(new Date());

    // Prisma не умеет RETURNING в updateMany — отсюда raw. Кавычки вокруг
    // идентификаторов обязательны: Postgres иначе схлопнет их в нижний
    // регистр. "updatedAt" проставляем руками — @updatedAt применяется
    // клиентом Prisma и в сыром SQL не срабатывает.
    //
    // Границу передаём ISO-СТРОКОЙ с явным CAST в `timestamp`, а не Date'ом.
    // Колонка у Prisma — `timestamp` БЕЗ таймзоны и хранит UTC-стенные часы;
    // если драйвер свяжет параметр как `timestamptz`, Postgres приведёт
    // колонку к timestamptz по TimeZone СЕССИИ, и на сервере с не-UTC
    // сессией граница суток уехала бы — ровно тот класс багов, ради которого
    // заведён common/tj-time.ts. `'...Z'::timestamp` отбрасывает
    // обозначение зоны и даёт те же стенные часы, что лежат в колонке,
    // поэтому сравнение timestamp↔timestamp детерминировано.
    //
    // JOIN на сделку и `s.status = ACTIVE` — обязателен. Без него отменённая
    // сделка вечно поставляла бы просрочку: её этапы остаются PENDING
    // навсегда, и каждый день менеджер получал бы уведомление о долге по
    // сделке, которой больше нет. COMPLETED отсекаем по той же причине —
    // закрытый контракт разбирали руками, доначислять по нему нечего.
    const dayStartSql = dayStart.toISOString();
    // Запрос СОБИРАЕТСЯ, но не выполняется: PrismaPromise ленив и уходит в
    // $transaction ниже вместе с пересчётом должников.
    const claimOverdue = this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "PaymentStage" ps
         SET status = 'OVERDUE'::"PaymentStageStatus", "updatedAt" = NOW()
        FROM "SaleSubmission" s
       WHERE ps."submissionId" = s.id
         AND s.status = 'ACTIVE'::"SubmissionStatus"
         AND ps.status = 'PENDING'::"PaymentStageStatus"
         AND ps."dueDate" < CAST(${dayStartSql} AS timestamp)
      RETURNING ps.id
    `;

    // Признак должника — ПО СОСТОЯНИЮ ЭТАПОВ, а не по результату захвата
    // (почему именно так — в док-комментарии выше). Одним запросом на весь
    // проход: bool_or по этапам каждой ACTIVE-сделки с планом даёт нужное
    // значение флага, а `IS DISTINCT FROM` оставляет в UPDATE только те
    // заявки, у которых он реально разъехался, — updatedAt у остальных не
    // дёргается, и в норме апдейт не задевает ни одной строки.
    //
    // Подзапрос группирует по "applicationId" (а не берёт строку сделки
    // напрямую) только ради устойчивости: колонка уникальная, так что группа
    // и сейчас ровно одна на заявку, но GROUP BY делает запрос верным и в
    // случае, если уникальность когда-нибудь снимут.
    //
    // "updatedAt" — руками, как и в захвате: @updatedAt живёт в клиенте
    // Prisma и в сыром SQL не срабатывает.
    const syncDebtors = this.prisma.$executeRaw`
      UPDATE "Application" a
         SET "paymentPending" = d."hasOverdue",
             "updatedAt" = NOW()
        FROM (
              SELECT s."applicationId" AS "appId",
                     bool_or(ps.status = 'OVERDUE'::"PaymentStageStatus") AS "hasOverdue"
                FROM "SaleSubmission" s
                JOIN "PaymentStage" ps ON ps."submissionId" = s.id
               WHERE s."applicationId" IS NOT NULL
                 AND s.status = 'ACTIVE'::"SubmissionStatus"
               GROUP BY s."applicationId"
             ) d
       WHERE a.id = d."appId"
         AND a."paymentPending" IS DISTINCT FROM d."hasOverdue"
    `;

    // Порядок в массиве значим: пересчёт обязан видеть уже переведённые
    // строки, иначе флаг отстал бы на сутки от собственной просрочки.
    const [claimed, debtorsSynced] = await this.prisma.$transaction([
      claimOverdue,
      syncDebtors,
    ]);
    if (claimed.length === 0) return { flipped: 0, managersNotified: 0, debtorsSynced };

    const claimedIds = claimed.map((r) => r.id);
    const stages = await this.prisma.paymentStage.findMany({
      where: { id: { in: claimedIds } },
      select: {
        id: true,
        order: true,
        title: true,
        amount: true,
        dueDate: true,
        submission: {
          select: {
            id: true,
            currency: true,
            managerId: true,
            applicationId: true,
            newStudentName: true,
            student: { select: { fullName: true } },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    // Заявок здесь уже не касаемся: их привёл в соответствие syncDebtors в
    // той же транзакции, что и захват.

    // Группируем по ответственному менеджеру: одно уведомление на человека
    // за проход, а не на этап. Иначе менеджер с десятком просрочек получал
    // бы десять почти одинаковых сообщений и перестал бы их читать.
    const byManager = new Map<string | null, typeof stages>();
    for (const s of stages) {
      const key = s.submission.managerId ?? null;
      const list = byManager.get(key);
      if (list) list.push(s);
      else byManager.set(key, [s]);
    }

    let managersNotified = 0;
    for (const [managerId, list] of byManager) {
      const total = round2(list.reduce((acc, s) => acc + s.amount, 0));
      const currency = list[0].submission.currency || '';
      const names = list
        .slice(0, 5)
        .map(
          (s) =>
            `${s.submission.student?.fullName || s.submission.newStudentName || 'клиент'}` +
            ` — этап ${s.order} (${s.amount} ${currency})`,
        );
      const tail = list.length > names.length ? ` и ещё ${list.length - names.length}` : '';
      const payload = {
        stageIds: list.map((s) => s.id),
        submissionIds: Array.from(new Set(list.map((s) => s.submission.id))),
        totalOverdue: total,
        currency,
      };

      if (managerId) {
        await this.notifications.notifyUser(managerId, {
          type: 'PAYMENT_STAGE_OVERDUE',
          title: '🔴 Просрочен этап рассрочки',
          message:
            `Просрочено этапов: ${list.length} на ${total} ${currency}. ` +
            `${names.join('; ')}${tail}.`,
          payload,
        });
      } else {
        // Менеджера уволили (SaleSubmission.managerId → SetNull) — долг
        // бесхозный. Уходит руководству, иначе просрочка не всплывёт нигде.
        await this.notifications.notifyAdmins({
          type: 'PAYMENT_STAGE_OVERDUE_ORPHAN',
          title: '🔴 Просрочка по сделке без менеджера',
          message:
            `Просрочено этапов: ${list.length} на ${total} ${currency}. ` +
            `У сделки нет ответственного — назначьте менеджера.`,
          payload,
        });
      }
      managersNotified++;
    }

    this.logger.log(
      `Cron: overduePaymentStages — просрочено ${stages.length} этап(ов), ` +
        `уведомлений: ${managersNotified}, заявок-должников обновлено: ${debtorsSynced}`,
    );
    return { flipped: stages.length, managersNotified, debtorsSynced };
  }

  // ─────────────────────────────── CRM API ────────────────────────────────

  /** Этапы сделки + итоги для карточки сделки. */
  async listForSubmission(
    user: (UserWithRoles & { id: string }) | null | undefined,
    submissionId: string,
  ) {
    const submission = await this.prisma.saleSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, managerId: true, totalAmount: true, currency: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');
    this.assertCanManageSubmission(user, submission.managerId);

    const stages = await this.prisma.paymentStage.findMany({
      where: { submissionId },
      orderBy: { order: 'asc' },
    });
    // СВЕДЕНИЕ ПЛАНА С КОНТРАКТОМ. Отдаём сумму этапов рядом с суммой
    // контракта и явный признак расхождения: карточка сделки обязана
    // показывать не только «оплачено/остаток», но и то, что план вообще
    // описывает не ту сумму, которую подписали. В норме расхождение
    // невозможно (см. rebalancePlanForStageEditTx и
    // reallocateOnTotalChangeTx), поэтому ненулевой drift — это след правки
    // в обход API: строки, залитые SQL'ом или импортом, либо сделка,
    // созданная до появления сведения. Скрывать такой план нельзя: одно
    // направление расхождения даёт вечную просрочку, другое — исчезнувший
    // долг.
    const stagesTotal = round2(stages.reduce((acc, s) => acc + s.amount, 0));
    const amountDrift = round2(stagesTotal - submission.totalAmount);
    return {
      submissionId,
      currency: submission.currency,
      totalAmount: submission.totalAmount,
      stagesTotal,
      amountDrift,
      reconciled: Math.abs(amountDrift) <= PAYMENT_STAGE_EPSILON,
      stages,
      totals: summariseStages(stages),
    };
  }

  /**
   * Ручная правка этапа менеджером: сумма, срок, название.
   *
   * PAID-этап суммой и сроком не правится: он уже погашен одобренным
   * платежом, и сдвиг его суммы разъехался бы с кумулятивным расчётом в
   * settleStagesTx (соседние этапы «поплыли» бы в оплаченность). Название
   * менять можно — оно ни на что не влияет.
   *
   * Правка сама по себе НЕ объявляет этап оплаченным — она лишь меняет
   * условие, а статусы после неё ПЕРЕСЧИТЫВАЮТСЯ тем же settleStagesTx по
   * тому же единственному правилу («этап оплачен тогда и только тогда, когда
   * кумулятивная сумма одобренных платежей его покрывает»). Второго пути в
   * PAID при этом не появляется: решает по-прежнему settleStagesTx, а не
   * менеджер.
   *
   * Пересчёт обязателен, потому что покрытие КУМУЛЯТИВНО: уменьшение суммы
   * непокрытого этапа может увести его (и следующие за ним) под уже
   * одобренные деньги. Контракт 1000, этапы 700/300, одобрен платёж 500 —
   * первый этап в долгу; менеджер пересогласовал его до 400, и он уже
   * покрыт. Без пересчёта он остался бы PENDING, суточный cron перевёл бы
   * его в OVERDUE, поднял бы Application.paymentPending и прислал менеджеру
   * уведомление о долге, которого нет. Плюс погасился бы он лишь при
   * СЛЕДУЮЩЕМ проходе — например при удалении платежа, то есть на реверсе.
   *
   * Перенос срока в будущее СНИМАЕТ просрочку: отсрочка, данная клиенту,
   * обязана убирать его из должников.
   */
  async updateStage(
    user: (UserWithRoles & { id: string }) | null | undefined,
    stageId: string,
    dto: UpdatePaymentStageDto,
  ) {
    const stage = await this.prisma.paymentStage.findUnique({
      where: { id: stageId },
      include: {
        submission: {
          select: { id: true, managerId: true, applicationId: true, status: true },
        },
      },
    });
    if (!stage) throw new NotFoundException('Этап рассрочки не найден');
    this.assertCanManageSubmission(user, stage.submission.managerId);
    if (stage.submission.status === SubmissionStatus.CANCELLED) {
      throw new BadRequestException('Сделка отменена — этапы не редактируются');
    }

    const data: Prisma.PaymentStageUpdateInput = {};
    if (dto.title !== undefined) {
      data.title = dto.title.trim().slice(0, 120) || null;
    }
    if (dto.amount !== undefined || dto.dueDate !== undefined) {
      if (stage.status === PaymentStageStatus.PAID) {
        throw new BadRequestException(
          'Этап уже оплачен — сумму и срок изменить нельзя. Отредактируйте сам платёж.',
        );
      }
    }
    let amountChanged = false;
    if (dto.amount !== undefined) {
      if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
        throw new BadRequestException('Сумма этапа должна быть > 0');
      }
      const amount = Math.round(dto.amount * 100) / 100;
      data.amount = amount;
      // Пересчёт запускаем только когда сумма реально сдвинулась: правка
      // одного названия не обязана трогать статусы и признак должника.
      amountChanged = Math.abs(amount - stage.amount) > Number.EPSILON;
    }
    let newStatus: PaymentStageStatus | null = null;
    if (dto.dueDate !== undefined) {
      const due = tjParseLocalDate(dto.dueDate);
      if (isNaN(due.getTime())) throw new BadRequestException('Некорректный срок этапа');
      data.dueDate = due;
      // Отсрочка снимает просрочку; перенос в прошлое её не ставит — это
      // работа суточного cron'а, чтобы у OVERDUE был ровно один источник.
      if (stage.status === PaymentStageStatus.OVERDUE && due >= tjStartOfDay(new Date())) {
        newStatus = PaymentStageStatus.PENDING;
      }
    }
    if (newStatus) data.status = newStatus;

    // ОДНА ТРАНЗАКЦИЯ: запись новой суммы и пересчёт покрытия — это одно
    // событие. Коммит правки без пересчёта оставил бы ровно то расхождение,
    // ради которого пересчёт и заведён (см. док-комментарий выше), а окно
    // между двумя коммитами способен поймать суточный cron.
    return this.prisma.$transaction(async (tx) => {
      // СВЕДЕНИЕ ПЛАНА С КОНТРАКТОМ — ПЕРВЫМ шагом транзакции: внутри
      // берётся тот же pessimistic lock на SaleSubmission, что и в
      // approvePayment. Без него две параллельные правки разных этапов одной
      // сделки прочитали бы одно и то же «до», каждая свела бы план по-своему,
      // и последняя записала бы сумму, не равную контракту.
      const rebalanced =
        dto.amount !== undefined
          ? await this.rebalancePlanForStageEditTx(tx, {
              submissionId: stage.submissionId,
              stageId,
              newAmount: Math.round(dto.amount * 100) / 100,
            })
          : null;

      // Ответ: строка этапа плюс — если разницу пришлось куда-то переносить —
      // этап, который поехал следом. UI обязан об этом сказать: менеджер
      // правил одну сумму, а изменились две. `undefined` JSON.stringify
      // выбрасывает, поэтому в обычном ответе поля просто нет.
      const respond = <R extends object>(row: R) => ({
        ...row,
        rebalancedStage: rebalanced ?? undefined,
      });

      const updated = await tx.paymentStage.update({
        where: { id: stageId },
        data,
      });

      // Пересчёт нужен и когда сумма правимого этапа не сдвинулась, а
      // сдвинулась сумма компенсатора: покрытие КУМУЛЯТИВНО, и чужая правка
      // ровно так же меняет, какие этапы накрыты уже одобренными деньгами.
      if (amountChanged || rebalanced) {
        // Платежа-триггера нет: деньги не двигались, поменялось условие.
        // settleStagesTx сам найдёт, каким из уже одобренных платежей этап
        // оказался закрыт (resolveSettlingPayment), и сам приведёт
        // Application.paymentPending в соответствие с планом — поэтому
        // отдельной возни с флагом ниже здесь не требуется.
        await this.settleStagesTx(tx, {
          submissionId: stage.submissionId,
          applicationId: stage.submission.applicationId,
          paymentId: null,
          paidAt: new Date(),
        });
        // Перечитываем: проход мог перевести этот этап в PAID и проставить
        // paidAt/paymentId, а карточка сделки обновляется ответом.
        const fresh = await tx.paymentStage.findUnique({ where: { id: stageId } });
        return respond(fresh ?? updated);
      }

      // Сняли последнюю просрочку по сделке — снимаем и признак должника.
      if (newStatus === PaymentStageStatus.PENDING) {
        const stillOverdue = await tx.paymentStage.count({
          where: {
            submissionId: stage.submissionId,
            status: PaymentStageStatus.OVERDUE,
          },
        });
        if (stillOverdue === 0 && stage.submission.applicationId) {
          await tx.application.updateMany({
            where: { id: stage.submission.applicationId, paymentPending: true },
            data: { paymentPending: false },
          });
        }
      }
      return respond(updated);
    });
  }

  /**
   * Свести план с контрактом при ручной правке суммы этапа.
   *
   * ИНВАРИАНТ (schema.prisma, раздел «INSTALLMENT PLANS», и шапка этого
   * файла): sum(PaymentStage.amount) == SaleSubmission.totalAmount ТОЧНО.
   * При материализации его держит allocateStageAmounts — и до появления этой
   * функции держал РОВНО ОДИН РАЗ, в момент создания сделки. Дальше правка
   * суммы этапа уводила план от контракта, и оба направления расхождения
   * денежно неверны:
   *   - сумма этапов БОЛЬШЕ контракта: клиент платит весь контракт, но
   *     кумулятивный порог последнего этапа не достигается никогда — этап
   *     вечно OVERDUE, менеджеру каждый день летит уведомление о долге,
   *     Application.paymentPending не снимается. При этом paymentPhase
   *     финансовой транзакции считается ОТ totalAmount и показывает FULL:
   *     финансы говорят «контракт закрыт», рассрочка — «должник».
   *   - сумма этапов МЕНЬШЕ контракта: все этапы гаснут, признак должника
   *     снимается, и недоплата (totalAmount - сумма этапов) исчезает с
   *     дашборда вместе с долгом, который никто не прощал.
   *
   * ПОЧЕМУ НЕ ПРОСТО ЗАПРЕТ. Отказ на «сумма этапов != контракт» убил бы
   * правку сумм как функцию: любая ОДИНОЧНАЯ правка по определению ломает
   * равенство — до неё план сходился. Поэтому правка одного этапа здесь это
   * ПЕРЕРАСПРЕДЕЛЕНИЕ внутри фиксированного контракта: сколько прибавили
   * тут, столько сняли с ПОСЛЕДНЕГО неоплаченного этапа, и наоборот. Общую
   * сумму меняют там, где она живёт, — в карточке сделки (updateSubmission),
   * и оттуда пересобирается весь план (reallocateOnTotalChangeTx).
   *
   * PAID-этапы НЕПРИКОСНОВЕННЫ: они сведены с одобренными платежами.
   * Компенсатор ищется только среди неоплаченных, поэтому PAID-префикс не
   * двигается и settleStagesTx после нас физически не может расгасить
   * оплаченное.
   *
   * СЧИТАЕМ ОТ ИНВАРИАНТА, А НЕ ОТ ДЕЛЬТЫ: сумма компенсатора выводится как
   * «контракт минус всё остальное», а не «его сумма минус сдвиг». Поэтому
   * проход ещё и ЧИНИТ план, разъехавшийся до появления этой проверки, —
   * менеджеру достаточно пересохранить любую сумму.
   */
  private async rebalancePlanForStageEditTx(
    tx: Prisma.TransactionClient,
    opts: { submissionId: string; stageId: string; newAmount: number },
  ): Promise<{ id: string; order: number; amount: number } | null> {
    // Тот же lock и по той же причине, что в approvePayment: сериализует нас
    // и с параллельной правкой соседнего этапа, и с одобрением платежа —
    // иначе settleStagesTx считал бы покрытие по суммам, которые прямо
    // сейчас переписывают.
    await tx.$queryRaw`SELECT id FROM "SaleSubmission" WHERE id = ${opts.submissionId} FOR UPDATE`;

    const submission = await tx.saleSubmission.findUnique({
      where: { id: opts.submissionId },
      select: { totalAmount: true, currency: true },
    });
    if (!submission) throw new NotFoundException('Сделка не найдена');

    const rows = await tx.paymentStage.findMany({
      where: { submissionId: opts.submissionId },
      orderBy: { order: 'asc' },
      select: { id: true, order: true, amount: true, status: true },
    });

    const cur = submission.currency || '';
    const totalCents = toCents(submission.totalAmount);
    const newCents = toCents(opts.newAmount);
    const paidCents = rows
      .filter((r) => r.status === PaymentStageStatus.PAID)
      .reduce((acc, r) => acc + toCents(r.amount), 0);
    // Неоплаченные, КРОМЕ правимого: между ними и раскладывается остаток
    // контракта.
    const others = rows.filter(
      (r) => r.status !== PaymentStageStatus.PAID && r.id !== opts.stageId,
    );
    const budgetCents = totalCents - paidCents - newCents;

    if (others.length === 0) {
      // Переносить разницу некуда: остальные этапы оплачены. Единственная
      // допустимая сумма — остаток контракта; всё прочее это 400 с цифрой.
      if (budgetCents !== 0) {
        throw new BadRequestException(
          `Сумма этапов обязана в точности равняться сумме контракта ` +
            `(${fromCents(totalCents)} ${cur}). Это единственный неоплаченный этап, ` +
            `поэтому его сумма может быть только ${fromCents(totalCents - paidCents)} ${cur} ` +
            `— сейчас расхождение ${fromCents(budgetCents)} ${cur}. Чтобы изменить общую ` +
            `сумму, правьте сумму контракта в карточке сделки.`,
        );
      }
      return null;
    }

    const comp = others[others.length - 1];
    const keptCents = others
      .slice(0, -1)
      .reduce((acc, r) => acc + toCents(r.amount), 0);
    const compCents = budgetCents - keptCents;
    if (compCents < 1) {
      const maxCents = totalCents - paidCents - keptCents - 1;
      throw new BadRequestException(
        `Слишком большая сумма этапа: разница переносится на этап №${comp.order}, ` +
          `а он ушёл бы в ${fromCents(compCents)} ${cur}. При сумме контракта ` +
          `${fromCents(totalCents)} ${cur} максимум для этого этапа — ` +
          `${fromCents(maxCents)} ${cur}. Чтобы увеличить общую сумму, правьте сумму ` +
          `контракта в карточке сделки.`,
      );
    }
    // Сумма после нас: paidCents + keptCents + compCents + newCents ==
    // totalCents ровно по построению compCents.
    if (compCents === toCents(comp.amount)) return null;
    await tx.paymentStage.update({
      where: { id: comp.id },
      data: { amount: fromCents(compCents) },
    });
    return { id: comp.id, order: comp.order, amount: fromCents(compCents) };
  }

  /**
   * Пересобрать план под НОВУЮ сумму контракта. Зовётся из
   * SubmissionsService.updateSubmission ВНУТРИ его транзакции — правка
   * totalAmount и пересборка плана обязаны коммититься вместе, иначе между
   * ними живёт сделка, чей план описывает уже не ту сумму.
   *
   * Без этого FOUNDER менял сумму живой сделки, а строки PaymentStage
   * оставались от прежней — то же расхождение и те же два денежно неверных
   * исхода, что описаны в rebalancePlanForStageEditTx.
   *
   * ПОЧЕМУ ПЕРЕСБОРКА, А НЕ ОТКАЗ. Отказать «сначала почините план» нельзя:
   * править суммы этапов в обход контракта тоже нельзя (там сведение), и
   * FOUNDER оказался бы в тупике — сумму контракта не изменить никогда.
   * Поэтому источник правды один и он же вход: totalAmount, а план идёт за
   * ним.
   *
   * PAID-этапы сохраняются как есть (они сведены с одобренными платежами),
   * новая сумма минус оплаченное раскладывается по неоплаченным
   * ПРОПОРЦИОНАЛЬНО их текущим долям — согласованный с клиентом график
   * («первый взнос больше») переживает изменение цены, — а остаток от
   * округления падает на последний этап (distributeCents).
   *
   * Отказ остаётся ровно для двух случаев, где пересобирать нечего: платить
   * уже нечем (все этапы оплачены) и новая сумма не покрывает оплаченное.
   */
  async reallocateOnTotalChangeTx(
    tx: Prisma.TransactionClient,
    opts: {
      submissionId: string;
      applicationId: string | null;
      newTotal: number;
      currency: string;
    },
  ): Promise<{ hasStages: boolean; changed: number }> {
    const rows = await tx.paymentStage.findMany({
      where: { submissionId: opts.submissionId },
      orderBy: { order: 'asc' },
      select: { id: true, order: true, amount: true, status: true },
    });
    // Рассрочки у сделки может не быть вовсе (у программы пустой шаблон) —
    // тогда сводить нечего и правка суммы ничем не ограничена.
    if (rows.length === 0) return { hasStages: false, changed: 0 };

    const cur = opts.currency || '';
    const totalCents = toCents(opts.newTotal);
    const unpaid = rows.filter((r) => r.status !== PaymentStageStatus.PAID);
    const paidCents = rows
      .filter((r) => r.status === PaymentStageStatus.PAID)
      .reduce((acc, r) => acc + toCents(r.amount), 0);
    const restCents = totalCents - paidCents;

    if (unpaid.length === 0) {
      if (restCents !== 0) {
        throw new BadRequestException(
          `План рассрочки закрыт целиком: все ${rows.length} этап(ов) оплачены на ` +
            `${fromCents(paidCents)} ${cur}. Новая сумма контракта ` +
            `${fromCents(totalCents)} ${cur} разошлась бы с планом на ` +
            `${fromCents(restCents)} ${cur}, а перенести разницу не на что — ` +
            `оплаченные этапы сведены с одобренными платежами. Проведите доплату ` +
            `или возврат отдельным платежом.`,
        );
      }
      return { hasStages: true, changed: 0 };
    }
    // Каждому неоплаченному этапу нужен хотя бы цент: этап на ноль означал бы
    // строку графика, которую нечем закрыть.
    if (restCents < unpaid.length) {
      throw new BadRequestException(
        `Новая сумма контракта ${fromCents(totalCents)} ${cur} не покрывает уже ` +
          `оплаченные этапы (${fromCents(paidCents)} ${cur}) и ${unpaid.length} ` +
          `неоплаченных. Минимально допустимая сумма — ` +
          `${fromCents(paidCents + unpaid.length)} ${cur}, либо сначала удалите лишние ` +
          `этапы плана.`,
      );
    }

    const target = distributeCents(
      restCents,
      unpaid.map((r) => toCents(r.amount)),
    );
    let changed = 0;
    for (let i = 0; i < unpaid.length; i++) {
      if (target[i] === toCents(unpaid[i].amount)) continue;
      await tx.paymentStage.update({
        where: { id: unpaid[i].id },
        data: { amount: fromCents(target[i]) },
      });
      changed++;
    }

    // Суммы этапов поменялись — покрытие пересчитываем тем же единственным
    // проходом, что и везде: уменьшение неоплаченного этапа может увести его
    // под уже одобренные деньги, и он обязан погаситься сразу, а не ждать
    // следующего платежа. settleStagesTx сам найдёт погасивший платёж и сам
    // приведёт Application.paymentPending в соответствие с планом.
    if (changed > 0) {
      await this.settleStagesTx(tx, {
        submissionId: opts.submissionId,
        applicationId: opts.applicationId,
        paymentId: null,
        paidAt: new Date(),
      });
    }
    return { hasStages: true, changed };
  }

  // ──────────────────────── КАБИНЕТ СТУДЕНТА (лендинг) ────────────────────

  /**
   * Собственные этапы студента и что по ним не закрыто.
   *
   * Скоуп жёсткий: только сделки, где `studentId` — это он сам. Сделка,
   * заведённая на снапшот нового клиента (studentId ещё null, до первого
   * одобрения), сюда не попадает — и не должна: аккаунта в кабинете у такого
   * клиента ещё нет. Отменённые сделки скрыты — по ним платить нечего.
   */
  async listForStudent(studentId: string) {
    const submissions = await this.prisma.saleSubmission.findMany({
      where: {
        studentId,
        status: { not: SubmissionStatus.CANCELLED },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        currency: true,
        totalAmount: true,
        createdAt: true,
        program: { select: { id: true, name: true } },
        paymentStages: {
          orderBy: { order: 'asc' },
          // Ровно то, что кабинет рисует. paymentId/submissionId наружу не
          // отдаём — студенту они не нужны, а лишние идентификаторы в ответе
          // это лишняя поверхность.
          select: {
            id: true,
            order: true,
            title: true,
            amount: true,
            dueDate: true,
            status: true,
            paidAt: true,
          },
        },
      },
    });

    const plans = submissions
      .filter((s) => s.paymentStages.length > 0)
      .map((s) => ({
        submissionId: s.id,
        currency: s.currency,
        totalAmount: s.totalAmount,
        program: s.program,
        stages: s.paymentStages,
        totals: summariseStages(s.paymentStages),
      }));

    // Общий итог по всем планам. Валюты сделок могут отличаться, поэтому
    // складываем ТОЛЬКО в пределах одной валюты — сумма USD и TJS одним
    // числом была бы враньём.
    const outstandingByCurrency: Record<string, number> = {};
    for (const p of plans) {
      const cur = p.currency || '—';
      outstandingByCurrency[cur] = round2(
        (outstandingByCurrency[cur] ?? 0) + p.totals.outstanding,
      );
    }
    return { plans, outstandingByCurrency };
  }

  // ─────────────────────────────── ДОСТУП ─────────────────────────────────

  /**
   * Кто правит этапы сделки. Зеркалит SubmissionsService.getOne: FOUNDER и
   * ADMIN — любую сделку, менеджер — только свою. ACCOUNTANT сюда НЕ входит
   * намеренно: у него нет доступа к сделкам вообще (см. комментарий там же).
   */
  private assertCanManageSubmission(
    user: (UserWithRoles & { id: string }) | null | undefined,
    managerId: string | null,
  ) {
    if (!user) throw new ForbiddenException('Недостаточно прав');
    if (isFounder(user) || hasRole(user, 'ADMIN')) return;
    if (managerId && managerId === user.id) return;
    throw new ForbiddenException('Это не ваша сделка');
  }
}
