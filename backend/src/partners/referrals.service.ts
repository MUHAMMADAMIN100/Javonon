import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { buildReferralUrl } from '../common/landing-url';

/** Идентификаторы клиента, по которым ищется атрибуция. */
export type ReferralClientRef = {
  studentId?: string | null;
  applicationId?: string | null;
  /**
   * Дополнительные заявки того же клиента — ищутся наравне с applicationId.
   *
   * Нужны сделкам: у SaleSubmission заявок ДВЕ и означают они разное.
   * `applicationId` — это SUCCESSFUL_LEAD, созданная одобрением первого
   * платежа; `sourceApplicationId` — лид, из которого сделку завели, и именно
   * на нём висит атрибуция с лендинга. Отдельное поле, а не «перебей
   * applicationId нужным»: искать надо по ОБЕИМ, иначе выбор между ними
   * пришлось бы делать вызывающему — то есть в четырёх местах по-разному.
   *
   * null/undefined внутри массива игнорируются: вызывающий передаёт сырые
   * nullable-колонки, не фильтруя их руками.
   */
  applicationIds?: (string | null | undefined)[] | null;
  telegramUserId?: string | null;
};

/**
 * Блок «Партнёр» в карточке сделки/студента/заявки.
 * ВИДЕН ТОЛЬКО РУКОВОДСТВУ (FOUNDER/ADMIN/ACCOUNTANT) — гейт стоит в
 * вызывающих сервисах, поле физически отсутствует в ответе остальным.
 */
export type PartnerAttributionView = {
  partnerId: string;
  fullName: string;
  referralCode: string;
  referralUrl: string;
  /**
   * Сумма комиссии за этого клиента (копейки).
   *  - комиссия НЕ начислена → прогноз: текущая фикс-ставка партнёра;
   *  - комиссия начислена → замороженная Commission.amountCents, то есть
   *    сколько партнёру реально записали в баланс.
   * Смешивать эти два источника нельзя: ставка редактируется в «Партнёрах» в
   * любой момент, и подстановка текущей ставки в уже начисленную комиссию
   * переписывала бы историю задним числом.
   */
  commissionAmountCents: number;
  /**
   * Валюта `commissionAmountCents` — заполнена ТОЛЬКО когда сумма взята из
   * реальной Commission. null = это прогноз по ставке (всегда TJS, flat-rate).
   * Одновременно служит фронту признаком «число настоящее, а не прогноз».
   */
  commissionCurrency: string | null;
  /** null = комиссия за этого клиента ещё не начислена. */
  commissionedAt: string | null;
  commissionId: string | null;
};

/**
 * Исходы «не начислили», которые означают ОТКАЗ В ДЕНЬГАХ партнёру, реально
 * приведшему платящего клиента. В отличие от no-attribution («клиент пришёл
 * сам»), already-credited / race-lost («за клиента уже заплатили»), здесь
 * партнёр есть, клиент оплатил, а комиссии не будет. Такой исход обязан
 * оставлять след: партнёр рано или поздно спросит «почему мне не заплатили»,
 * и без записи ответить нечем.
 *
 * zero-rate сюда НЕ входит намеренно: штамп commissionedAt при нём не
 * ставится, клиент для партнёра не сгорает, и следующий одобренный платёж
 * начислит комиссию по восстановленной ставке.
 */
export const NON_PAYMENT_REASONS = [
  'attribution-expired',
  'partner-inactive',
  'duplicate-commission',
] as const;

export type NonPaymentReason = (typeof NON_PAYMENT_REASONS)[number];

/** Является ли исход отказом в деньгах живому партнёру (см. NON_PAYMENT_REASONS). */
export function isNonPaymentReason(reason: string): reason is NonPaymentReason {
  return (NON_PAYMENT_REASONS as readonly string[]).includes(reason);
}

/**
 * Человекочитаемая причина отказа — идёт и в лог, и в details ActivityLog,
 * чтобы FOUNDER читал строку аудита без сверки с кодом, когда партнёр
 * приходит с вопросом «почему мне не заплатили за этого клиента».
 */
export const NON_PAYMENT_REASON_RU: Record<NonPaymentReason, string> = {
  'attribution-expired':
    'истёк 90-дневный срок партнёрской атрибуции — клиент оплатил позже окна',
  'partner-inactive':
    'партнёр не в статусе ACTIVE на момент оплаты (заблокирован/на паузе)',
  'duplicate-commission':
    'комиссия по этой оплате/транзакции уже существует (сработал БД-гард дедупа)',
};

/**
 * Что именно откатил reverseCommissionsForTransactionsTx по одной комиссии.
 *
 * ВНИМАНИЕ: это ВНУТРЕННИЙ тип для логов/аудита вызывающего сервиса. Он
 * содержит partnerId и сумму начисления, поэтому НИКОГДА не попадает в HTTP-
 * ответ сделки: changeStatus/deletePayment доступны SALES_MANAGER'у, а
 * партнёрские данные ему видеть нельзя (см. canSeePartnerAttribution).
 */
export type CommissionReversal = {
  commissionId: string;
  partnerId: string;
  /** Финансовая Transaction, отмена которой потянула реверс. */
  transactionId: string | null;
  amountCents: number;
  currency: string;
  /** Статус комиссии ДО реверса (PENDING/APPROVED/PAID). */
  previousStatus: string;
  /**
   * Баланс партнёра ПОСЛЕ списания. Отрицательное значение — НЕ ошибка, а
   * долг: деньги за отменённую сделку партнёр уже вывел. См. комментарий
   * к методу — мы намеренно не зажимаем баланс в ноль.
   */
  balanceAfterCents: number;
  /** Сколько атрибуций расштамповали (обычно 0 или 1). */
  attributionsCleared: number;
};

/** Результат попытки разового начисления. */
export type CreditOnceResult =
  | { credited: true; commissionId: string; amountCents: number; partnerId: string }
  | {
      credited: false;
      reason:
        | 'no-attribution'
        | 'already-credited'
        | 'attribution-expired'
        | 'partner-inactive'
        | 'zero-rate'
        | 'race-lost'
        | 'duplicate-commission';
      /**
       * Партнёр, которому НЕ начислили. Заполняется только когда атрибуция
       * найдена (то есть для всех reason'ов кроме no-attribution) — вызывающий
       * использует его, чтобы отказ можно было связать с конкретным партнёром
       * в логе и аудите. Опционально, чтобы no-attribution оставался
       * «пустым» исходом без лишних полей.
       */
      partnerId?: string;
      /** Имя партнёра для человекочитаемой строки аудита. */
      partnerName?: string;
    };

/**
 * Реферальный трекинг и атрибуция.
 *  - registerClick: при заходе по /r/:code или с ?ref=
 *  - attribute: при значимом событии (регистрация студента, /start в боте,
 *    создание заявки) связываем клиента с партнёром.
 *  - resolvePartner / getPartnerAttributionView: кто привёл клиента (чтение).
 *  - creditCommissionForAttributionOnce: ЕДИНСТВЕННЫЙ способ начислить
 *    комиссию. ОДНА комиссия за КЛИЕНТА (а не за платёж). Дедуп — штамп
 *    ReferralAttribution.commissionedAt, который ставится сразу по ВСЕМ
 *    строкам клиента (их бывает несколько, см. attribute()), плюс
 *    БД-ограничение Commission.@@unique([partnerId, studentId]).
 *
 * ПОЧЕМУ ТОЧКА ВХОДА РОВНО ОДНА. Рядом жил второй метод creditCommission() —
 * «за КАЖДЫЙ платёж», дедуп по (partnerId, paymentId)/(partnerId,
 * transactionId), штамп commissionedAt он не ставил вовсе. Пока по нему ходил
 * старый flow /payments, а по новому — «Сделки», один и тот же клиент
 * оплачивался партнёру дважды: подтверждение студенческого Payment создавало
 * Commission, оставляя commissionedAt = NULL, после чего одобрение
 * SubmissionPayment того же клиента видело NULL, ставило штамп и создавало
 * вторую Commission (обратный порядок ломался так же).
 * @@unique([partnerId, transactionId]) при этом не срабатывал — финансовые
 * Transaction у этих путей разные строки. Метод удалён; оба пути ходят сюда,
 * поэтому правило основателя «один раз за клиента» физически одно на всю
 * кодовую базу. Новый источник начисления добавляем ТОЛЬКО как ещё один
 * вызов creditCommissionForAttributionOnce.
 */
@Injectable()
export class ReferralsService {
  private readonly log = new Logger(ReferralsService.name);
  // TTL атрибуции — 90 дней.
  private readonly ATTRIBUTION_TTL_MS = 90 * 24 * 3600 * 1000;

  constructor(private prisma: PrismaService) {}

  private fingerprint(ip?: string, ua?: string) {
    return createHash('sha256')
      .update(`${ip || ''}|${ua || ''}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** Находит партнёра по ref-коду. Возвращает null если не найден / не активен. */
  async findPartnerByCode(code: string) {
    if (!code) return null;
    const partner = await this.prisma.partner.findUnique({
      where: { referralCode: code.trim().toUpperCase() },
    });
    if (!partner || partner.status !== 'ACTIVE') return null;
    return partner;
  }

  /** Залогировать клик. Не падает, если код невалиден — просто silent skip. */
  async registerClick(opts: {
    code: string;
    source?: 'SITE' | 'BOT';
    ip?: string;
    userAgent?: string;
    referer?: string;
  }) {
    const partner = await this.findPartnerByCode(opts.code);
    if (!partner) return null;
    try {
      return await this.prisma.referralClick.create({
        data: {
          partnerId: partner.id,
          source: opts.source || 'SITE',
          ip: opts.ip,
          userAgent: opts.userAgent,
          referer: opts.referer,
          fingerprint: this.fingerprint(opts.ip, opts.userAgent),
        },
      });
    } catch (e) {
      this.log.warn(`registerClick failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Привязать клиента (студента / заявку / telegram-пользователя) к
   * партнёру по реферальному коду.
   *
   * IDEMPOTENT НА УРОВНЕ КЛИЕНТА, а не переданного набора полей. Раньше фильтр
   * склеивал все переданные идентификаторы через AND (spread в один where),
   * поэтому вызов с НОВЫМ applicationId не совпадал с уже существующей строкой
   * того же клиента и заводил ВТОРУЮ — с commissionedAt = NULL. Теперь ищем по
   * OR (совпал любой идентификатор ⇒ тот же клиент того же партнёра) и
   * ДОПИСЫВАЕМ недостающие идентификаторы в найденную строку вместо дубля.
   *
   * ЧЕГО ЭТОТ МЕТОД НЕ УМЕЕТ — И ПОЧЕМУ ЭТОГО МАЛО. Повторная отправка формы с
   * лендинга по той же ?ref= приходит сюда БЕЗ единого опознавательного знака
   * клиента: студента и telegram-пользователя ещё не существует, а
   * applicationId — новый. Опознать в ней того же человека нечем, и вторая
   * строка всё равно создастся. Поэтому правило основателя «один раз за
   * клиента» держится НЕ здесь, а в creditCommissionForAttributionOnce (штамп
   * ставится сразу по ВСЕМ строкам клиента) и в БД
   * (Commission.@@unique([partnerId, studentId])). Дедупликация здесь — гигиена
   * данных, а не guard денег.
   *
   * emailHint в поиск НЕ входит намеренно: это слабая подсказка, по которой
   * деньги не считаются нигде, а склейка двух разных клиентов с одинаковым
   * email отняла бы у партнёра честную комиссию за второго.
   */
  async attribute(opts: {
    code: string;
    source?: 'SITE' | 'BOT';
    studentId?: string;
    applicationId?: string;
    telegramUserId?: string;
    emailHint?: string;
  }) {
    const partner = await this.findPartnerByCode(opts.code);
    if (!partner) return null;

    const identity: Prisma.ReferralAttributionWhereInput[] = [];
    if (opts.studentId) identity.push({ studentId: opts.studentId });
    if (opts.applicationId) identity.push({ applicationId: opts.applicationId });
    if (opts.telegramUserId) identity.push({ telegramUserId: opts.telegramUserId });
    // Ни одного идентификатора — привязывать не к кому. Пустая строка
    // атрибуции нашлась бы потом по любому запросу и приписала бы партнёру
    // чужого клиента.
    if (identity.length === 0) return null;

    // Дедупликация: если у этого партнёра уже есть строка на этого клиента —
    // работаем с ней.
    const existing = await this.prisma.referralAttribution.findFirst({
      where: { partnerId: partner.id, OR: identity },
      // Каноническая строка — САМАЯ РАННЯЯ: атрибуция принадлежит первому
      // касанию клиента, от него же отсчитан TTL.
      orderBy: { createdAt: 'asc' },
    });

    if (existing) {
      // Дописываем ТОЛЬКО пустые поля. Перебивать заполненный
      // studentId/applicationId нельзя — это переклеило бы атрибуцию на
      // другого клиента.
      const patch: Prisma.ReferralAttributionUpdateInput = {};
      if (opts.studentId && !existing.studentId) patch.studentId = opts.studentId;
      if (opts.applicationId && !existing.applicationId) {
        patch.applicationId = opts.applicationId;
      }
      if (opts.telegramUserId && !existing.telegramUserId) {
        patch.telegramUserId = opts.telegramUserId;
      }
      if (opts.emailHint && !existing.emailHint) patch.emailHint = opts.emailHint;
      if (Object.keys(patch).length === 0) return existing;
      return this.prisma.referralAttribution.update({
        where: { id: existing.id },
        data: patch,
      });
    }

    return this.prisma.referralAttribution.create({
      data: {
        partnerId: partner.id,
        source: opts.source || 'SITE',
        studentId: opts.studentId,
        applicationId: opts.applicationId,
        telegramUserId: opts.telegramUserId,
        emailHint: opts.emailHint,
        expiresAt: new Date(Date.now() + this.ATTRIBUTION_TTL_MS),
      },
    });
  }

  /**
   * Дописать studentId в строку атрибуции, заведённую на ЗАЯВКУ.
   *
   * Атрибуция с лендинга создаётся, когда Student ещё не существует, — в
   * строке заполнен только applicationId. Обычно её достаёт конвертация лида
   * (applications.service, NEW_LEAD → IN_PROCESSING), но этот шаг можно
   * пропустить: сделку заводят из карточки заявки вкладкой «Новый», и Student
   * рождается только на одобрении первого платежа.
   *
   * Начисление и без back-fill'а найдёт партнёра — findAttribution ищет по OR
   * и получает заявку-источник в applicationIds. Но по studentId ходят другие
   * места (карточка студента, повторные оплаты в /payments), и «партнёр виден
   * в сделке, но не виден в карточке студента» — расхождение в деньгах,
   * которое рано или поздно прочитают как ошибку начисления.
   *
   * Idempotent и безопасен к гонкам: `studentId: null` в фильтре не даёт
   * перебить уже проставленную привязку (в том числе на другого студента).
   * Ошибку глотаем — партнёрская таблица не имеет права ронять одобрение
   * платежа, которое уже закоммичено.
   */
  private async backfillAttributionStudent(
    identity: Prisma.ReferralAttributionWhereInput[],
    studentId: string,
  ): Promise<void> {
    if (identity.length === 0) return;
    try {
      await this.prisma.referralAttribution.updateMany({
        // Тот же набор строк клиента, по которому штампуется commissionedAt:
        // «этот клиент» должен означать одно и то же в обеих операциях.
        where: { AND: [{ OR: identity }, { studentId: null }] },
        data: { studentId },
      });
    } catch (e) {
      this.log.warn(
        `backfillAttributionStudent(student=${studentId}) failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * ЕДИНСТВЕННЫЙ поиск атрибуции клиента в кодовой базе. Все пути —
   * начисление (одобрение сделки и подтверждение студенческой оплаты идут в
   * один creditCommissionForAttributionOnce), resolvePartner и блок «Партнёр»
   * в CRM — ходят сюда, чтобы «кому начислили» и «кого показали» никогда не
   * разъезжались.
   *
   * Раньше здесь была строгая if/else-if цепочка: при переданном studentId
   * искали ТОЛЬКО по studentId. Атрибуция с лендинга создаётся в момент
   * отправки формы, когда Student ещё не существует — в строке заполнен
   * лишь applicationId. Из-за этого при подтверждении оплаты партнёр
   * никогда не находился и комиссия не начислялась. Поэтому ищем по ЛЮБОМУ
   * из переданных идентификаторов (OR), а не по первому непустому.
   */
  private async findAttribution(
    ref: ReferralClientRef,
    opts: { includeStudentApplications?: boolean } = {},
  ) {
    const identity = await this.buildClientIdentityFilter(ref, opts);
    if (identity.length === 0) return null;
    return this.findAttributionByIdentity(identity);
  }

  /**
   * OR-набор «это тот же клиент» — ЕДИНСТВЕННОЕ место, где решается, какие
   * строки ReferralAttribution относятся к одному человеку.
   *
   * Вынесен из findAttribution, потому что начисление обязано применять ЭТОТ ЖЕ
   * набор к штампу commissionedAt. Строк на одного клиента бывает несколько
   * (см. attribute()), и guard, поставленный на ОДНУ найденную строку, оставлял
   * остальные неотштампованными: повторная отправка формы с лендинга по той же
   * ?ref= рождала свежую строку с commissionedAt = NULL, и следующая сделка
   * того же клиента платила партнёру ВТОРОЙ раз. Никакой гонки для этого не
   * требовалось — хватало порядка чтения (findFirst брал самую новую строку).
   */
  private async buildClientIdentityFilter(
    ref: ReferralClientRef,
    opts: { includeStudentApplications?: boolean } = {},
  ): Promise<Prisma.ReferralAttributionWhereInput[]> {
    const or: Prisma.ReferralAttributionWhereInput[] = [];
    if (ref.studentId) or.push({ studentId: ref.studentId });
    if (ref.telegramUserId) or.push({ telegramUserId: ref.telegramUserId });

    // Все заявки клиента — в одно множество, чтобы уйти одним `IN` вместо
    // трёх почти одинаковых веток OR.
    const applicationIds = new Set<string>();
    if (ref.applicationId) applicationIds.add(ref.applicationId);
    for (const id of ref.applicationIds ?? []) {
      if (id) applicationIds.add(id);
    }

    // SaleSubmission.applicationId — это НЕ лид с лендинга: он создаётся
    // заново (status=SUCCESSFUL_LEAD) в момент одобрения первого платежа,
    // а ReferralAttribution.applicationId указывает на старую заявку с
    // формы. Поэтому для сделок добираем ВСЕ заявки студента: атрибуция
    // лежит на самой первой из них. Без этого партнёр находился только у
    // тех клиентов, кому applications.service успел проставить studentId
    // при конвертации лида.
    //
    // Один этот добор проблему не закрывает: у сделки, заведённой вкладкой
    // «Новый» в обход конвертации лида, студент создаётся ТОЛЬКО на
    // одобрении, и его единственная заявка — та самая новая SUCCESSFUL_LEAD.
    // Лендинговый лид к нему не привязан ничем. Мост на такой случай —
    // SaleSubmission.sourceApplicationId, он приходит сюда в applicationIds.
    if (opts.includeStudentApplications && ref.studentId) {
      const apps = await this.prisma.application.findMany({
        where: { studentId: ref.studentId },
        select: { id: true },
      });
      for (const a of apps) applicationIds.add(a.id);
    }

    if (applicationIds.size > 0) {
      or.push({ applicationId: { in: [...applicationIds] } });
    }

    return or;
  }

  /**
   * Строка атрибуции клиента по готовому набору идентичности.
   *
   * ПОРЯДОК ВАЖЕН ДЛЯ ДЕНЕГ И ДЛЯ КАРТОЧКИ. Строк на клиента может быть
   * несколько, и раньше бралась просто самая новая — то есть та самая свежая
   * строка от повторной отправки формы, у которой commissionedAt = NULL, даже
   * когда по клиенту уже начислено. Отсюда и «за клиента ещё не платили» в
   * карточке, и второе начисление. Сначала берём строку СО ШТАМПОМ (nulls
   * last), и только если начисления не было вовсе — самую свежую.
   */
  private findAttributionByIdentity(identity: Prisma.ReferralAttributionWhereInput[]) {
    return this.prisma.referralAttribution.findFirst({
      where: { OR: identity },
      orderBy: [
        { commissionedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      include: { partner: true },
    });
  }

  /**
   * Годна ли атрибуция для НАЧИСЛЕНИЯ: не истёк TTL и партнёр всё ещё
   * активен. Для ОТОБРАЖЕНИЯ в CRM эти проверки намеренно не применяются —
   * руководство должно видеть, кто привёл клиента, даже когда 90-дневное
   * окно закрылось или партнёра заблокировали.
   */
  private attributionCreditIneligibility(
    attr: { expiresAt: Date | null; partner: { status: string } | null },
  ): 'attribution-expired' | 'partner-inactive' | null {
    if (attr.expiresAt && attr.expiresAt < new Date()) return 'attribution-expired';
    if (!attr.partner || attr.partner.status !== 'ACTIVE') return 'partner-inactive';
    return null;
  }

  /** Найти партнёра по любому из идентификаторов клиента. */
  async resolvePartner(opts: {
    studentId?: string;
    applicationId?: string;
    telegramUserId?: string;
  }) {
    const attr = await this.findAttribution(opts);
    if (!attr) return null;
    if (this.attributionCreditIneligibility(attr)) return null;
    return attr.partner;
  }

  /**
   * Блок «Партнёр» для карточек сделки / студента / заявки.
   *
   * ВЫЗЫВАТЬ ТОЛЬКО ПОСЛЕ ПРОВЕРКИ canSeePartnerAttribution() из
   * auth/role-utils — НЕ isElevated(): менеджеры по продажам не должны
   * знать ни имя партнёра, ни сумму, ни сам факт, что клиент партнёрский.
   * isElevated() здесь недостаточен, потому что он читает только базовую
   * роль и пропускает носителя активной кастомной роли, чья база — лишь
   * техническая «подложка» (см. RolesGuard.skipBaseRole). Гейт стоит в
   * вызывающем сервисе, и поле там не проставляется вовсе (не null, а
   * отсутствует) — иначе менеджер прочитает его прямо в сетевом ответе.
   *
   * Возвращает null, если клиент пришёл сам (это большинство).
   */
  async getPartnerAttributionView(
    ref: ReferralClientRef,
  ): Promise<PartnerAttributionView | null> {
    const attr = await this.findAttribution(ref, { includeStudentApplications: true });
    if (!attr || !attr.partner) return null;

    // ДО начисления показываем прогноз — текущую ставку партнёра: комиссии
    // ещё нет, и «сколько он получит» считается по сегодняшней ставке.
    let commissionAmountCents = attr.partner.commissionAmountCents;
    let commissionCurrency: string | null = null;

    // ПОСЛЕ начисления ставка неверна как источник. Она живая: FOUNDER правит
    // её в «Партнёрах» (partners.service.adminUpdate) когда угодно, а
    // creditCommissionForAttributionOnce замораживает ставку в
    // Commission.amountCents в момент начисления. Подставляя сюда текущую
    // ставку, карточка клиента переписывала бы историю — «Начислено ... 700
    // TJS» там, где партнёру записали 500, — и то же начисление читалось бы
    // двумя разными числами в карточке и в «Партнёры → Комиссии». Берём
    // замороженную сумму.
    if (attr.commissionedAt && attr.commissionId) {
      // Отдельный запрос, а не include: связь намеренно без FK
      // (schema.prisma, ReferralAttribution.commissionId), поэтому
      // relation-поля у Prisma здесь нет. Лишний SELECT уходит только по уже
      // начисленным клиентам — это меньшинство карточек.
      const commission = await this.prisma.commission.findUnique({
        where: { id: attr.commissionId },
        select: { amountCents: true, currency: true },
      });
      // Строки нет (ручная чистка БД) — остаёмся на прогнозе и не выдаём его
      // за факт: currency остаётся null, фронт отрисует это как ставку.
      // Ронять карточку клиента из-за пропавшей записи начисления нельзя.
      if (commission) {
        commissionAmountCents = commission.amountCents;
        commissionCurrency = commission.currency;
      }
    }

    return {
      partnerId: attr.partner.id,
      fullName: attr.partner.fullName,
      referralCode: attr.partner.referralCode,
      referralUrl: buildReferralUrl(attr.partner.referralCode),
      commissionAmountCents,
      commissionCurrency,
      commissionedAt: attr.commissionedAt ? attr.commissionedAt.toISOString() : null,
      commissionId: attr.commissionId ?? null,
    };
  }

  /**
   * ЕДИНСТВЕННОЕ начисление комиссии в системе: партнёру платят ОДИН раз за
   * КЛИЕНТА, а не за платёж.
   *
   * Решение основателя дословно: «один раз за клиента». Сделка, закрытая в 4
   * рассрочки, платит партнёру ровно один раз — на первом одобренном
   * платеже. Реализовано как «один раз на строку ReferralAttribution»:
   * строка означает «партнёр X привёл клиента Y», поэтому и вторая,
   * отдельная сделка того же клиента комиссию больше не породит.
   *
   * Сюда же ходит и старый flow /payments (бухгалтер подтверждает
   * студенческий Payment) — у него было собственное правило «за каждый
   * платёж», не знавшее про commissionedAt, и клиент, прошедший оба модуля,
   * оплачивался партнёру дважды. Точка входа теперь одна, см. комментарий к
   * классу.
   *
   * ДЕДУП ПРИВЯЗАН К КЛИЕНТУ, А НЕ К СТРОКЕ АТРИБУЦИИ. Это главное. Строк на
   * одного клиента бывает несколько: повторная отправка формы с лендинга по
   * той же ?ref= заводит новую строку с новым applicationId и commissionedAt =
   * NULL (опознать клиента в момент отправки формы нечем — см. attribute()).
   * Пока штамп ставился на ОДНУ найденную строку, партнёру хватало попросить
   * клиента отправить форму ещё раз по своей ссылке, чтобы получить за него
   * вторую комиссию: findFirst брал самую свежую, неотштампованную строку и
   * начислял заново. Никакой гонки для этого не требовалось.
   *
   * Поэтому и проверка, и штамп идут по ВСЕМУ набору строк клиента
   * (buildClientIdentityFilter), а не по attr.id.
   *
   * ТРИ СЛОЯ ЗАЩИТЫ (два основателя жмут «Одобрить» одновременно / ретрай
   * outbox'а / вторая сделка того же клиента):
   *   1) быстрый pre-check по commissionedAt — отсекает 99% повторов без
   *      открытия транзакции (findAttributionByIdentity отдаёт строку со
   *      штампом первой, поэтому pre-check видит начисление даже когда у
   *      клиента есть более свежая строка без штампа);
   *   2) внутри транзакции: count строк клиента с commissionedAt IS NOT NULL —
   *      если хоть одна есть, за клиента уже платили, выходим; затем условный
   *      updateMany `WHERE <идентичность клиента> AND commissionedAt IS NULL`.
   *      count === 0 ⇒ штамп уже поставил кто-то другой ⇒ выходим, ничего не
   *      создав. Штамп и создание Commission в ОДНОЙ транзакции: падение между
   *      ними либо заплатило бы дважды на ретрае, либо потеряло бы запись о
   *      начислении;
   *   3) БД: Commission.@@unique([partnerId, studentId]). Единственный guard,
   *      не зависящий ни от порядка чтения строк, ни от того, все ли строки
   *      клиента попали в набор. Дубль падает с P2002, транзакция целиком
   *      откатывается, balanceCents не трогается.
   */
  async creditCommissionForAttributionOnce(opts: {
    studentId?: string | null;
    applicationId?: string | null;
    /** См. {@link ReferralClientRef.applicationIds} — заявка-источник сделки. */
    applicationIds?: (string | null | undefined)[] | null;
    telegramUserId?: string | null;
    /** Сумма платежа-триггера в копейках — идёт в baseAmountCents (аудит). */
    baseAmountCents?: number;
    /** Валюта платежа-триггера (baseAmountCents), не валюта начисления. */
    baseCurrency?: string;
    /** Финансовая Transaction, породившая начисление. */
    transactionId?: string;
    /**
     * Студенческий Payment, породивший начисление (flow /payments). Пишется в
     * Commission.paymentId: это и аудит-трейл «с какой оплаты снят flat-rate»,
     * и второй БД-backstop — @@unique([partnerId, paymentId]) не даст создать
     * две комиссии по одному Payment даже при ретрае.
     */
    paymentId?: string;
    /** Человекочитаемая пометка в Commission.note. */
    sourceLabel?: string;
  }): Promise<CreditOnceResult> {
    // Набор строк клиента считаем ОДИН раз и переиспользуем в транзакции:
    // проверка «уже платили» и штамп обязаны смотреть ровно на те же строки,
    // что и поиск партнёра.
    const identity = await this.buildClientIdentityFilter(opts, {
      includeStudentApplications: true,
    });
    const attr =
      identity.length === 0 ? null : await this.findAttributionByIdentity(identity);
    // Партнёра нет — клиент пришёл сам. Это норма, а не ошибка: молча выходим.
    if (!attr || !attr.partner) return { credited: false, reason: 'no-attribution' };

    // Атрибуция нашлась по ЗАЯВКЕ, а студент в ней не проставлен: конвертацию
    // лида пропустили, сделку завели вкладкой «Новый», и Student появился
    // только сейчас — на одобрении. Дописываем его ДО всех ранних выходов,
    // чтобы связка «партнёр ↔ клиент» существовала и когда начисления не
    // будет (already-credited, expired, zero-rate): иначе партнёр виден в
    // карточке сделки, но не в карточке студента и не в /payments.
    // Здесь, а не в вызывающем сервисе, — потому что путей начисления
    // несколько (одобрение сделки, повтор из outbox'а, подтверждение
    // студенческой оплаты), и back-fill обязан быть на всех.
    if (!attr.studentId && opts.studentId) {
      await this.backfillAttributionStudent(identity, opts.studentId);
    }

    // Быстрый выход: за этого клиента уже платили (строку со штампом
    // findAttributionByIdentity отдаёт первой — см. её комментарий).
    if (attr.commissionedAt) return { credited: false, reason: 'already-credited' };

    const ineligible = this.attributionCreditIneligibility(attr);
    if (ineligible) {
      // Отказ в деньгах партнёру, который реально привёл платящего клиента.
      // Возвращаем его идентификаторы наверх: вызывающий пишет warn + строку
      // аудита с submissionId/paymentId, которых здесь нет. Сам здесь не
      // логируем, чтобы одно решение не превращалось в две несвязанные
      // строки в разных местах лога.
      return {
        credited: false,
        reason: ineligible,
        partnerId: attr.partner.id,
        partnerName: attr.partner.fullName,
      };
    }

    const partner = attr.partner;
    // Flat-rate Variant A: фиксированная сумма в TJS, ставка берётся на
    // момент начисления и замораживается в Commission.amountCents.
    const commissionCents = partner.commissionAmountCents;
    // 0 — валидное значение (партнёр временно ничего не получает, но остаётся
    // ACTIVE). Строку с amountCents=0 не создаём и штамп НЕ ставим: иначе
    // клиент навсегда сгорел бы для партнёра из-за временно обнулённой ставки.
    if (commissionCents <= 0) return { credited: false, reason: 'zero-rate' };

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Авторитетная проверка «за этого КЛИЕНТА уже платили»: хоть одна
        // проштампованная строка среди ВСЕХ строк клиента закрывает вопрос.
        // Проверка намеренно НЕ сужена до partner.id: правило основателя —
        // «один раз за клиента», поэтому второй партнёр, приведший того же
        // человека позже, второй комиссии за него тоже не порождает.
        const creditedRows = await tx.referralAttribution.count({
          where: { OR: identity, commissionedAt: { not: null } },
        });
        if (creditedRows > 0) return { credited: false, reason: 'already-credited' as const };

        // CAS-штамп сразу по ВСЕМ строкам клиента, а не по attr.id: строка,
        // оставшаяся без штампа, — это готовое второе начисление за того же
        // человека (повторная заявка с лендинга по той же ?ref=).
        const stampedAt = new Date();
        const stamped = await tx.referralAttribution.updateMany({
          where: { OR: identity, commissionedAt: null },
          data: { commissionedAt: stampedAt },
        });
        if (stamped.count === 0) {
          // Параллельный запрос уже застолбил начисление и создаёт
          // Commission в своей транзакции. Выходим — ничего не создаём,
          // ничего не откатываем.
          return { credited: false, reason: 'race-lost' as const };
        }

        // Commission создаётся ЗДЕСЬ, внутри той же транзакции, что и штамп:
        // вынести её в отдельный метод со своей $transaction нельзя — падение
        // между штампом и созданием строки либо заплатило бы дважды на ретрае,
        // либо потеряло бы запись о начислении. Форма строки одна для всех
        // источников (percent=0 sentinel «flat-rate», currency=TJS,
        // baseCurrency = валюта платежа клиента), чтобы отчёты партнёров не
        // различали, пришло начисление со «Сделки» или с /payments.
        const commission = await tx.commission.create({
          data: {
            partnerId: partner.id,
            transactionId: opts.transactionId,
            paymentId: opts.paymentId,
            // Ключ правила «один раз за КЛИЕНТА» на уровне БД
            // (@@unique([partnerId, studentId])). Берём студента из аргументов,
            // а если начисление пришло по заявке/боту — из самой атрибуции.
            // null (клиента ещё нет как Student) не конфликтует: в Postgres
            // NULL'ы в unique-индексе различны.
            studentId: opts.studentId ?? attr.studentId ?? null,
            amountCents: commissionCents,
            baseAmountCents: opts.baseAmountCents ?? 0,
            // Sentinel 0 = flat-rate начисление (не процент от базы).
            percent: 0,
            currency: 'TJS',
            baseCurrency: (opts.baseCurrency || 'TJS').toUpperCase(),
            note: opts.sourceLabel,
            status: 'PENDING',
          },
        });

        await tx.partner.update({
          where: { id: partner.id },
          data: {
            balanceCents: { increment: commissionCents },
            totalEarnedCents: { increment: commissionCents },
          },
        });

        // Обратная ссылка: из карточки клиента видно конкретное начисление.
        // По ВСЕМ строкам, которые проштамповали этой транзакцией (фильтр по
        // stampedAt), чтобы карточка показывала одно и то же начисление, какую
        // бы из строк клиента ни отдал findAttributionByIdentity. Этот же
        // commissionId разштампует реверс отменённой сделки —
        // reverseCommissionsForTransactionsTx чистит строки по нему.
        await tx.referralAttribution.updateMany({
          where: { OR: identity, commissionedAt: stampedAt, commissionId: null },
          data: { commissionId: commission.id },
        });

        return {
          credited: true as const,
          commissionId: commission.id,
          amountCents: commissionCents,
          partnerId: partner.id,
        };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Какое из трёх ограничений Commission сработало. meta.target у
        // Postgres приходит то массивом полей, то именем констрейнта
        // (Commission_partnerId_studentId_key) — в обоих видах имя поля внутри,
        // поэтому сверяем по подстроке.
        const target = Array.isArray(e.meta?.target)
          ? (e.meta?.target as string[]).join(',')
          : String(e.meta?.target ?? '');

        // @@unique([partnerId, studentId]) — «за этого КЛИЕНТА партнёру уже
        // платили». Штатный, ожидаемый исход дедупа, а НЕ отказ в деньгах:
        // сюда попадаем, когда строки атрибуции разъехались (например, у
        // клиента появилась новая строка после начисления), а БД-guard поймал
        // дубль. Отвечаем already-credited, иначе вызывающий поднимет шум в
        // аудите «партнёру не заплатили» по уже оплаченному клиенту.
        if (target.includes('studentId')) {
          this.log.warn(
            `creditCommissionForAttributionOnce: за клиента student=${
              opts.studentId ?? attr.studentId ?? '—'
            } партнёру ${partner.id} уже начислено (сработал @@unique([partnerId, studentId]))`,
          );
          return { credited: false, reason: 'already-credited' };
        }

        // @@unique([partnerId, transactionId]) либо @@unique([partnerId,
        // paymentId]): по этой финансовой транзакции или по этой оплате
        // партнёру уже начислено. Вся транзакция откатилась, включая штамп, —
        // баланс не тронут.
        this.log.warn(
          `creditCommissionForAttributionOnce: комиссия по transactionId=${opts.transactionId}` +
            ` / paymentId=${opts.paymentId} уже существует (partner=${partner.id})`,
        );
        return {
          credited: false,
          reason: 'duplicate-commission',
          partnerId: partner.id,
          partnerName: partner.fullName,
        };
      }
      throw e;
    }
  }

  /**
   * ЕДИНСТВЕННЫЙ откат партнёрской комиссии в системе — зеркало
   * creditCommissionForAttributionOnce.
   *
   * ЗАЧЕМ. Отмена сделки (submissions.changeStatus CANCEL) и удаление
   * одобренного платежа (submissions.deletePayment) откатывали ВСЁ на стороне
   * компании — INCOME помечался reversedAt, писалась зеркальная EXPENSE,
   * платёж переводился в REJECTED, — но комиссию не трогали вообще. Строка
   * Commission оставалась PENDING, partner.balanceCents и totalEarnedCents —
   * поднятыми, ReferralAttribution.commissionedAt — проштампованной. Деньги за
   * возвращённую клиенту продажу оставались у партнёра и, до гейта в
   * requestPayout (см. partners.service.ts), выводились немедленно.
   *
   * ПОЧЕМУ ПРИНИМАЕМ ГОТОВЫЙ `tx`, А НЕ ОТКРЫВАЕМ СВОЮ ТРАНЗАКЦИЮ. Реверс
   * обязан быть атомарен с самой отменой: своя $transaction внутри чужой
   * невозможна, а «после коммита, best-effort» (как сделано у НАЧИСЛЕНИЯ в
   * approvePayment) здесь недопустимо и асимметрия тут намеренная —
   *   • сбой НАЧИСЛЕНИЯ не имеет права ронять уже одобренный платёж: деньги
   *     компании получены, а партнёру можно доначислить руками;
   *   • сбой РЕВЕРСА обязан ронять отмену целиком: иначе сделка отменена, а
   *     комиссия по ней живая и выводимая — ровно та дыра, которую чиним.
   * Поэтому метод исключений не глотает: любая ошибка поднимается наверх и
   * откатывает всю транзакцию отмены.
   *
   * ЧТО ДЕЛАЕТ ПО КАЖДОЙ НАЙДЕННОЙ КОМИССИИ:
   *   1) Commission → status=REVERSED + reversedAt (CAS `WHERE reversedAt IS
   *      NULL` — повторная отмена той же сделки ничего не спишет второй раз);
   *   2) partner.balanceCents И totalEarnedCents уменьшаются на amountCents;
   *   3) ReferralAttribution расштамповывается (commissionedAt=null,
   *      commissionId=null) — клиент перестаёт считаться «уже оплаченным», и
   *      следующая НАСТОЯЩАЯ сделка того же клиента снова начислит партнёру.
   *      Без этого шага guard «один раз за клиента» навсегда сжигал бы клиента
   *      из-за отменённой сделки.
   *
   * ОТРИЦАТЕЛЬНЫЙ БАЛАНС — ОСОЗНАННОЕ РЕШЕНИЕ, А НЕ НЕДОСМОТР. Если партнёр
   * уже вывел эти деньги (Commission PAID / оплаченный PartnerPayout),
   * balanceCents уходит в минус ровно на сумму долга. Мы НЕ зажимаем его в
   * ноль: `Math.max(0, ...)` спрятал бы убыток компании, и партнёр начал бы
   * следующее начисление с чистого листа. Минус — это и есть clawback-запись:
   *   • requestPayout берёт `balanceCents >= amount`, поэтому вывод закрыт,
   *     пока долг не погашен;
   *   • следующие честные начисления гасят его автоматически;
   *   • сам долг виден в «Партнёры» (баланс со знаком) и объясняется строкой
   *     Commission со статусом REVERSED и причиной в note.
   * Отдельная таблица долгов ради этого не заводится — новая сущность в
   * schema без единого потребителя хуже, чем знак у числа, который уже
   * читают и UI, и гард выплаты.
   *
   * Поиск идёт по Commission.transactionId: у комиссий со «Сделок» это
   * финансовая Transaction того платежа, который её и породил (одна и та же
   * строка, что реверсится в changeStatus). Комиссии старого flow /payments
   * приходят сюда тем же путём — им transactionId проставляется из
   * Payment.transactionId.
   */
  async reverseCommissionsForTransactionsTx(
    tx: Prisma.TransactionClient,
    transactionIds: (string | null | undefined)[],
    opts: { reversedAt: Date; reason: string },
  ): Promise<CommissionReversal[]> {
    const ids = [
      ...new Set(
        transactionIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (ids.length === 0) return [];

    const candidates = await tx.commission.findMany({
      where: { transactionId: { in: ids }, reversedAt: null },
      select: {
        id: true,
        partnerId: true,
        transactionId: true,
        amountCents: true,
        currency: true,
        status: true,
        note: true,
      },
    });
    if (candidates.length === 0) return [];

    const out: CommissionReversal[] = [];
    for (const c of candidates) {
      // CAS вместо update: параллельная отмена той же сделки (двойной клик,
      // ретрай) не должна списать баланс дважды. reversedAt — единственный
      // авторитетный маркер «уже откатили».
      const claimed = await tx.commission.updateMany({
        where: { id: c.id, reversedAt: null },
        data: {
          status: 'REVERSED',
          reversedAt: opts.reversedAt,
          // Освобождаем ключ «один раз за клиента»
          // (@@unique([partnerId, studentId])). Иначе откат сделки чинил бы
          // баланс, но навсегда закрывал партнёру НАСТОЯЩУЮ следующую сделку
          // того же клиента: новая Commission падала бы в P2002 об отменённую
          // строку — ровно то расштамповывание атрибуции ниже и предотвращает.
          // Аудит от этого не страдает: клиент по отменённой комиссии
          // восстанавливается через её paymentId/transactionId.
          studentId: null,
          // Причина дописывается к исходной пометке, а не затирает её:
          // «за какую сделку начислили» нужно ровно тогда же, когда
          // разбираются «почему отменили».
          note: `${c.note ? `${c.note} · ` : ''}${opts.reason}`.slice(0, 500),
        },
      });
      if (claimed.count === 0) continue;

      const partner = await tx.partner.update({
        where: { id: c.partnerId },
        data: {
          balanceCents: { decrement: c.amountCents },
          totalEarnedCents: { decrement: c.amountCents },
        },
        select: { balanceCents: true },
      });

      const unstamped = await tx.referralAttribution.updateMany({
        where: { commissionId: c.id },
        data: { commissionedAt: null, commissionId: null },
      });

      out.push({
        commissionId: c.id,
        partnerId: c.partnerId,
        transactionId: c.transactionId,
        amountCents: c.amountCents,
        currency: c.currency,
        previousStatus: c.status,
        balanceAfterCents: partner.balanceCents,
        attributionsCleared: unstamped.count,
      });
    }
    return out;
  }
}
