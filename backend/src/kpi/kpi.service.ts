import { managerSales } from '../common/manager-sales';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isElevated, UserWithRoles } from '../auth/role-utils';
import { PAID_STUDENT_WHERE } from '../common/paid-student';
import { PrismaService } from '../prisma/prisma.service';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';
import { dateRangeFilter } from '../common/query-date';
import {
  NonReportingCurrencyBreakdown,
  REPORTING_CURRENCY,
} from '../common/reporting-currency';

/** Диапазон дат из dateRangeFilter(): undefined — «за всё время». */
type DateRange = ReturnType<typeof dateRangeFilter>;

/**
 * Потолок строк в каждом списке окна подробностей. У активного менеджера за
 * «всё время» тысячи заявок — тащить их все в окно бессмысленно. Итоги при
 * этом считаются по ВСЕМ записям, обрезается только показ.
 */
const DETAILS_LIST_LIMIT = 300;

@Injectable()
export class KpiService {
  constructor(private prisma: PrismaService) {}

  /**
   * Сводный KPI по сотрудникам:
   *  - applicationsAssigned — сколько заявок назначено
   *  - applicationsEnrolled — сколько дошло до SUCCESSFUL_LEAD (успешный лид;
   *    легаси ENROLLED/COMPLETED считаются тем же, см. common/application-status)
   *  - conversionRate — % конверсии
   *  - studentsCount — сколько из заведённых студентов сейчас ACTIVE
   *  - salesAmount — сумма продаж клиентов этого менеджера
   *  - tasksOpen / tasksDone
   *
   * ПЕРИОД — ОДНО ПРАВИЛО НА ВСЕ МЕТРИКИ: «СОЗДАНО В ПЕРИОДЕ».
   *
   * Границы накладываются на дату появления самой записи (createdAt; у
   * транзакции — её собственная `date`, см. ниже), и ни на какое поле
   * «когда последний раз тронули». Это то же правило, что у
   * /applications/stats, /students/stats и /finance/summary, то есть у
   * карточек 01–07 дашборда, и оно же описано в PeriodSwitcher.tsx:
   * «сколько ИЗ СОЗДАННЫХ в этом месяце заявок сейчас в таком-то
   * состоянии», а не «сколько заявок за месяц перешло в это состояние».
   *
   * Почему не updatedAt (так считались enrolled и tasksDone):
   *  1. Числитель и знаменатель конверсии брались из РАЗНЫХ популяций —
   *     enrolled по updatedAt, assigned по createdAt. Заявка, созданная в
   *     прошлом году и закрытая в этом месяце, попадала в числитель и не
   *     попадала в знаменатель: 3 созданных заявки против 8 закрытых
   *     старых давали «267% CONV» на главном экране руководителя.
   *  2. `updatedAt` двигает ЛЮБАЯ правка строки (смена менеджера, коммент,
   *     телефон), поэтому «зачислено за период» на самом деле означало
   *     «закрытую заявку в этот период кто-то потрогал».
   *  3. Карточка 05 «Зачислено» на дашборде считает те же статусы по
   *     createdAt — цифры на одном экране обязаны сходиться.
   *
   * Транзакции фильтруем по `Transaction.date`: у платежа это и есть его
   * собственная дата события (в схеме `@default(now())`), по ней же режет
   * период /finance/summary. Взять здесь createdAt значило бы разойтись с
   * финансовой карточкой того же дашборда на задним числом проведённых
   * платежах.
   *
   * ВАЛЮТА — ТОЛЬКО ОТЧЁТНАЯ (TJS), см. common/reporting-currency.ts.
   * `Transaction.currency` — свободная строка с `@default("TJS")`, а ручная
   * проводка в /finance принимает пять валют (TJS/USD/EUR/CNY/RUB). До этого
   * фикса `salesAmount` считался `_sum: { amount: true }` БЕЗ фильтра по
   * валюте: USD 5 000 складывались с TJS 5 000 как безразмерные числа, а фронт
   * рисовал итог сомонями (Kpi.tsx — `fmtMoney(row.salesAmount)` с
   * currency='TJS'). Этим же числом сортируется лидерборд, то есть менеджер с
   * одной валютной сделкой поднимался наверх на курсовой разнице, а не на
   * продажах. Ровно этот баг уже чинили в finance.service.ts
   * (REPORTING_CURRENCY во всех агрегатах) и в salary.service.ts
   * (SALARY_REPORTING_CURRENCY в бонусной базе) — KPI оставался последним
   * несинхронизированным модулем.
   *
   * Не-TJS приходы НЕ конвертируются (FX на write-time в системе нет) и НЕ
   * пропадают молча: они уходят отдельным полем `nonTjsSales` — по коду
   * валюты, в исходной валюте, — по той же схеме, что `nonTjsTotals` в
   * finance и `nonTjsSales` в salary.preview(). Ни в `salesAmount`, ни в
   * сортировку они не входят.
   *
   * Без границ (`{}` — /kpi/me, /kpi/:userId и режим «за всё время»)
   * dateRangeFilter отдаёт undefined, ни один фильтр не подмешивается и
   * запросы остаются ровно теми же, что были до появления периода.
   *
   * Сами границы разворачивает в моменты общий парсер (common/query-date →
   * common/tj-time): календарный день Asia/Dushanbe, `to` включительно до
   * 23:59:59.999 TJT. Арифметики над Date здесь нет и быть не должно.
   */
  async leaderboard(filters: { from?: Date; to?: Date }) {
    const dateFilter = dateRangeFilter(filters);

    // KPI leaderboard включает всех, кто работает с заявками: ADMIN
    // (исторически вёл свои), и оба типа менеджеров. Мульти-роли (ТЗ §2)
    // учитываются через OR на roles[].
    const KPI_ROLES = ['ADMIN', 'SALES_MANAGER', 'CLIENT_MANAGER'] as const;
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { role: { in: KPI_ROLES as any } },
          { roles: { hasSome: KPI_ROLES as any } },
        ],
      },
      select: { id: true, fullName: true, role: true, email: true, bonusPercent: true },
    });

    // «Продажи» — по правилу зарплаты (common/manager-sales.ts): одобренные
    // платежи по сделкам в TJS; ручные приходы — отдельно «Прочие приходы»;
    // прочие валюты — nonTjsSales. Сразу по всем сотрудникам.
    const ids = users.map((u) => u.id);
    // Всё сразу по всем сотрудникам — 4 группировки вместо 5 запросов на
    // каждого (при 30 сотрудниках было 150 запросов на одно открытие).
    const [sales, appGroups, studentGroups, taskGroups] = await Promise.all([
      managerSales(this.prisma, ids, filters),
      this.prisma.application.groupBy({
        by: ['managerId', 'chinaManagerId', 'status'],
        where: this.applicationsWhere(ids, dateFilter),
        _count: { _all: true },
      }),
      this.prisma.student.groupBy({
        by: ['managerId', 'chinaManagerId'],
        where: this.studentsWhere(ids, dateFilter),
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['assignedToId', 'status'],
        where: {
          assignedToId: { in: ids },
          // Обе задачные метрики — по createdAt, иначе колонка
          // «tasksDone / (tasksDone + tasksOpen)» на /kpi складывала бы
          // закрытые-в-периоде с открытыми-за-всё-время.
          ...(dateFilter && { createdAt: dateFilter }),
        },
        _count: { _all: true },
      }),
    ]);
    // Заявка или студент засчитывается каждому из двух слотов менеджера —
    // но один раз, если в обоих один и тот же человек (как OR в where).
    const add = (map: Map<string, number>, who: (string | null)[], n: number) => {
      for (const id of new Set(who.filter((x): x is string => !!x))) map.set(id, (map.get(id) ?? 0) + n);
    };
    const assigned = new Map<string, number>();
    const enrolled = new Map<string, number>();
    for (const g of appGroups) {
      add(assigned, [g.managerId, g.chinaManagerId], g._count._all);
      if (FINISHED_APPLICATION_STATUSES.includes(g.status)) add(enrolled, [g.managerId, g.chinaManagerId], g._count._all);
    }
    const students = new Map<string, number>();
    for (const g of studentGroups) add(students, [g.managerId, g.chinaManagerId], g._count._all);
    const open = new Map<string, number>();
    const done = new Map<string, number>();
    for (const g of taskGroups) add(g.status === 'DONE' ? done : open, [g.assignedToId], g._count._all);

    const result = users.map((u) => {
        const applicationsAssigned = assigned.get(u.id) ?? 0;
        const applicationsEnrolled = enrolled.get(u.id) ?? 0;
        const studentsCount = students.get(u.id) ?? 0;
        const tasksOpen = open.get(u.id) ?? 0;
        const tasksDone = done.get(u.id) ?? 0;

        // Math.min(100, …) — не расчёт, а предохранитель. После перевода
        // enrolled на createdAt он строго подмножество assigned, и выйти
        // за 100% арифметически нельзя. Клампа стоит на случай, если базы
        // дат снова разведут: «конверсия 267%» — цифра, из-за которой
        // перестают верить всему экрану, лучше упереться в 100%.
        const conversionRate =
          applicationsAssigned > 0
            ? Math.min(100, Math.round((applicationsEnrolled / applicationsAssigned) * 100))
            : 0;

        return {
          ...u,
          applicationsAssigned,
          applicationsEnrolled,
          conversionRate,
          studentsCount,
          salesAmount: sales.get(u.id)?.deals ?? 0,
          salesCount: sales.get(u.id)?.dealsCount ?? 0,
          // Ручные приходы по менеджеру — в продажи не входят.
          otherIncome: sales.get(u.id)?.other ?? 0,
          // Валюта, в которой посчитан salesAmount. Отдаём явно, чтобы фронт
          // не хардкодил 'TJS' в fmtMoney — та же форма ответа, что у
          // finance summary/breakdown.
          currency: REPORTING_CURRENCY,
          // Пустой объект = период был чисто в сомони, фронту нечего
          // дорисовывать. Непустой — подсказка «была ещё выручка в USD/…,
          // в рейтинг она не входит».
          nonTjsSales: sales.get(u.id)?.nonTjs ?? {},
          tasksOpen,
          tasksDone,
        };
      });

    // Сортируем по продажам — топ-менеджеры наверху. Ключ сортировки
    // одновалютный (TJS), поэтому сравнение осмысленно: до фикса валюты
    // порядок мест зависел от того, в какой валюте оформлена сделка.
    return result.sort((a, b) => b.salesAmount - a.salesAmount);
  }

  /** KPI одного сотрудника + история по месяцам. */
  /* ======================================================================
   *  УСЛОВИЯ ВЫБОРКИ — ОДНИ НА РЕЙТИНГ И НА ОКНО ПОДРОБНОСТЕЙ
   *
   *  Окно по клику на строку обязано показывать РОВНО те записи, из которых
   *  сложились числа строки: «Студентов: 1» — один студент в списке,
   *  «Продажи 6 000» — платежи в сумме 6 000. Две копии условия разошлись
   *  бы при первой же правке, и человек увидел бы «в рейтинге 5, в списке
   *  4». Поэтому и leaderboard(), и details() берут where отсюда.
   * ==================================================================== */

  /** Заявки сотрудника (любой из двух слотов менеджера), по дате создания. Список id — для рейтинга. */
  private applicationsWhere(userId: string | string[], dateFilter: DateRange): Prisma.ApplicationWhereInput {
    const who = Array.isArray(userId) ? { in: userId } : userId;
    return {
      OR: [{ managerId: who }, { chinaManagerId: who }],
      ...(dateFilter && { createdAt: dateFilter }),
    };
  }

  /** Активные ОПЛАТИВШИЕ студенты сотрудника, по дате заведения карточки. */
  private studentsWhere(userId: string | string[], dateFilter: DateRange): Prisma.StudentWhereInput {
    const who = Array.isArray(userId) ? { in: userId } : userId;
    return {
      OR: [{ managerId: who }, { chinaManagerId: who }],
      status: 'ACTIVE',
      // Студент = оплативший (common/paid-student.ts) — как в списке
      // «Студенты» и на карточке дашборда.
      ...PAID_STUDENT_WHERE,
      // Режем по дате заведения студента — ровно так считает карточка 04
      // «Активные клиенты» (students/stats), поэтому суммы сходятся.
      ...(dateFilter && { createdAt: dateFilter }),
    };
  }

  /** Действующие приходы сотрудника в отчётной валюте, по дате платежа. */

  /**
   * Подробности по строке рейтинга: что именно стоит за числами сотрудника
   * за тот же период — его студенты, платежи и заявки.
   *
   * ДОСТУП. Руководство (FOUNDER/ADMIN/ACCOUNTANT) открывает любого,
   * сотрудник — только себя. Сам рейтинг видят все, но в нём лишь итоги;
   * здесь же фамилии чужих клиентов и суммы по каждому платежу — то, что
   * менеджеру о коллеге знать не положено. Проверка стоит на сервере:
   * некликабельная строка в интерфейсе защитой не является.
   */
  async details(userId: string, filters: { from?: Date; to?: Date }, viewer: UserWithRoles & { id: string }) {
    if (!isElevated(viewer) && viewer.id !== userId) {
      throw new ForbiddenException('Подробности по другому сотруднику доступны только руководству');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, role: true },
    });
    if (!user) throw new NotFoundException('Сотрудник не найден');

    const dateFilter = dateRangeFilter(filters);
    const appsWhere = this.applicationsWhere(userId, dateFilter);
    const salesMap = await managerSales(this.prisma, [userId], filters);
    const sm = salesMap.get(userId)!;

    const [students, applications, applicationsTotal, applicationsEnrolled, byStatus] =
      await Promise.all([
        this.prisma.student.findMany({
          where: this.studentsWhere(userId, dateFilter),
          select: {
            id: true, fullName: true, direction: true, status: true, cabinet: true, createdAt: true,
            // Сколько студент оплатил ВСЕГО (действующие платежи за обучение) —
            // справочно; в «Продажи» периода это число не входит.
            transactions: {
              where: { type: 'INCOME', category: 'TUITION_PAYMENT', reversedAt: null, currency: REPORTING_CURRENCY },
              select: { amount: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: DETAILS_LIST_LIMIT,
        }),
        this.prisma.application.findMany({
          where: appsWhere,
          select: { id: true, fullName: true, phone: true, status: true, country: true, createdAt: true, studentId: true },
          orderBy: { createdAt: 'desc' },
          take: DETAILS_LIST_LIMIT,
        }),
        this.prisma.application.count({ where: appsWhere }),
        this.prisma.application.count({ where: { ...appsWhere, status: { in: FINISHED_APPLICATION_STATUSES } } }),
        this.prisma.application.groupBy({ by: ['status'], where: appsWhere, _count: true }),
      ]);

    const studentsTotal =
      students.length < DETAILS_LIST_LIMIT
        ? students.length
        : await this.prisma.student.count({ where: this.studentsWhere(userId, dateFilter) });

    return {
      user,
      currency: REPORTING_CURRENCY,
      /** Списки обрезаются до этого числа строк; итоги считаются по всем. */
      listLimit: DETAILS_LIST_LIMIT,
      totals: {
        applicationsAssigned: applicationsTotal,
        applicationsEnrolled,
        studentsCount: studentsTotal,
        salesAmount: sm.deals,
        salesCount: sm.dealsCount,
        otherIncome: sm.other,
        otherIncomeCount: sm.otherCount,
      },
      students: students.map(({ transactions, ...st }) => ({
        ...st,
        paidTotal: Math.round(transactions.reduce((sum, t) => sum + (t.amount || 0), 0) * 100) / 100,
      })),
      // Строки «Продаж» (DEAL) и «Прочих приходов» (OTHER) в TJS; прочие
      // валюты — отдельно. Те же записи, из которых сложились итоги.
      sales: sm.rows.filter((r) => r.currency === REPORTING_CURRENCY).slice(0, DETAILS_LIST_LIMIT),
      otherCurrencySales: sm.rows.filter((r) => r.currency !== REPORTING_CURRENCY).slice(0, DETAILS_LIST_LIMIT),
      applications: applications.map((a) => ({
        ...a,
        enrolled: (FINISHED_APPLICATION_STATUSES as readonly string[]).includes(a.status),
      })),
      applicationsByStatus: byStatus
        .map((g) => ({ status: g.status, count: g._count }))
        .sort((x, y) => y.count - x.count),
    };
  }

  async forUser(userId: string) {
    const board = await this.leaderboard({});
    return board.find((u) => u.id === userId) || null;
  }
}
