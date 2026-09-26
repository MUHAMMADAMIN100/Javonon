import { managerSales } from '../common/manager-sales';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { REPORTING_CURRENCY } from '../common/reporting-currency';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PresenceService } from '../realtime/presence.service';
import { isElevated, isFounder } from '../auth/role-utils';
import { tjStartOfMonth, tjEndOfMonth, tjYMD } from '../common/tj-time';
import { SettingsService } from '../settings/settings.service';
import { FINISHED_APPLICATION_STATUSES } from '../common/application-status';
import {
  effectiveManagerBonus,
  managerBonusProgress,
  managerBonusVolume,
} from '../common/manager-bonus-volume';
import {
  autoTargets,
  handoverCounts,
  handoverTotal,
  parseHandover,
  performHandover,
  validateHandoverTarget,
} from './handover';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  /**
   * Кто правит сотрудников:
   *  - founder — основатель: всё;
   *  - staff   — ADMIN/ACCOUNTANT по БАЗОВОЙ роли (без активной кастомной):
   *              кадры и оплата, но не роли и не основатель;
   *  - custom  — сотрудник с кастомной ролью (права «Сотрудники — …»):
   *              только карточка (ФИО, телефон, паспорт, дата приёма) и
   *              создание менеджеров; ни ролей, ни окладов, ни паролей.
   * Кастомная роль ЗАМЕНЯЕТ базовую (см. RolesGuard.skipBaseRole), поэтому
   * «ADMIN + кастомная роль» — это custom.
   */
  static actorLevel(a?: { role?: string; roles?: string[]; hasCustomRole?: boolean } | null): 'founder' | 'staff' | 'custom' {
    if (a && isFounder(a as any)) return 'founder';
    if (a && !a.hasCustomRole && isElevated(a as any)) return 'staff';
    return 'custom';
  }

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private settings: SettingsService,
    private presence: PresenceService,
  ) {}

  /**
   * «Кто в сети» — только для основателя (проверка в контроллере).
   * Состояние сейчас — из памяти (открытые вкладки), «был(а) в сети» и
   * «последний вход» — из базы. Уволенных (isActive=false) не показываем
   * как «в сети», даже если старая вкладка ещё открыта.
   */
  async presenceList() {
    const users = await this.prisma.user.findMany({
      select: { id: true, isActive: true, lastSeenAt: true, lastLoginAt: true },
    });
    const live = this.presence.snapshot();
    return users.map((u) => {
      const now = u.isActive !== false ? live.get(u.id) : undefined;
      return {
        userId: u.id,
        state: now?.state ?? 'OFFLINE',
        // Пока человек в сети, «последняя активность» точнее из памяти.
        lastSeenAt: now ? now.lastActivityAt : u.lastSeenAt,
        lastLoginAt: u.lastLoginAt,
      };
    });
  }

  async findAll(filters: { search?: string; includeInactive?: boolean } = {}) {
    const search = (filters.search || '').trim();
    // Уволенные — только по явному запросу (экран «Сотрудники»): иначе они
    // попадали бы в выбор исполнителей задач, назначение заявок и т.п.
    const where: any = {
      ...(filters.includeInactive ? {} : { isActive: true }),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' as const } },
              { fullName: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, fullName: true, role: true, createdAt: true,
        isActive: true,
        customRoleId: true,
        customRole: { select: { id: true, name: true, isActive: true } },
      },
    });
    return users;
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, fullName: true, role: true, createdAt: true,
        isActive: true,
        customRoleId: true,
        customRole: { select: { id: true, name: true, isActive: true, permissions: true } },
      },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  /**
   * Полный профиль сотрудника: HR-данные, документы, история зарплат,
   * штрафов, KPI-цифры, посещаемость. Используется в админ-кабинете
   * сотрудника и в /me/full (self-view).
   *
   * Параметр `selfOnly` режет финансовую инфу для self-view? Нет, сотрудник
   * имеет право видеть свою зарплату и штрафы. Скрываем только ROLE-permissions.
   */
  /**
   * Записи за текущий месяц, из которых сложились плитки «Текущий месяц»
   * профиля (окна «подробнее»). Условия выборки — ТЕ ЖЕ, что в fullProfile()
   * ниже, поэтому число в окне сходится с плиткой по построению. Меняешь
   * условие там — меняй и здесь.
   *
   * «Заявок всего» — счёт по всей компании; список здесь только СВОИХ
   * заявок сотрудника («N моих»): чужих клиентов в профиле не показываем.
   */
  async monthDetails(id: string) {
    const now = new Date();
    const monthStart = tjStartOfMonth(now);
    const monthEnd = tjEndOfMonth(now);
    const appSelect = {
      id: true, fullName: true, phone: true, status: true, country: true,
      createdAt: true, updatedAt: true,
    } as const;
    const [time, sales, ownApplications, enrolled, pendingPenalties] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: { userId: id, date: { gte: monthStart, lte: monthEnd } },
        orderBy: { date: 'desc' },
        select: {
          id: true, date: true, clockIn: true, lunchOut: true, lunchIn: true, clockOut: true,
          status: true, totalMinutes: true, totalLunchMinutes: true, lateMinutes: true,
          lateExcuseReason: true, lateExcuseStatus: true,
        },
      }),
      // Продажи (DEAL) и прочие приходы (OTHER) — по правилу зарплаты,
      // ровно те записи, из которых сложилась плитка.
      managerSales(this.prisma, [id], { from: monthStart, to: monthEnd }).then((m) => m.get(id)!.rows),
      this.prisma.application.findMany({
        where: { managerId: id, createdAt: { gte: monthStart, lte: monthEnd } },
        orderBy: { createdAt: 'desc' },
        select: appSelect,
      }),
      this.prisma.application.findMany({
        where: {
          managerId: id,
          status: { in: FINISHED_APPLICATION_STATUSES },
          updatedAt: { gte: monthStart, lte: monthEnd },
        },
        orderBy: { updatedAt: 'desc' },
        select: appSelect,
      }),
      this.prisma.penalty.findMany({
        where: { userId: id, applied: false },
        orderBy: { date: 'desc' },
      }),
    ]);
    return { periodStart: monthStart, periodEnd: monthEnd, time, sales, ownApplications, enrolled, pendingPenalties };
  }

  /**
   * Полный профиль для руководства (GET /users/:id/full). Кастомной роли
   * блок «Оплата» не отдаём: оклады видят основатель, админ, бухгалтер
   * (и сам сотрудник — через /me/full).
   */
  async fullProfileFor(id: string, actor: { id: string; role?: string; roles?: string[]; hasCustomRole?: boolean; permissions?: string[] }) {
    const access = await this.profileAccess(actor, id);
    if (!access) throw new ForbiddenException('Нет доступа к данным этого сотрудника');
    const profile: any = await this.fullProfile(id);
    if (access === 'noPay') profile.salary = null;
    return profile;
  }

  /**
   * Кто и как видит чужой профиль (одно правило для /users/:id/full и
   * /me/profile/:id):
   *  - 'full'  — сам сотрудник, основатель, админ/бухгалтер по базовой роли,
   *              и тот, кому основатель выдал доступ (DataAccessGrant);
   *  - 'noPay' — кастомная роль с правами «Сотрудники — …»: карточка без
   *              блока «Оплата»;
   *  - null    — нет доступа.
   */
  async profileAccess(
    actor: { id: string; role?: string; roles?: string[]; hasCustomRole?: boolean; permissions?: string[] },
    targetId: string,
  ): Promise<'full' | 'noPay' | null> {
    if (actor.id === targetId) return 'full';
    const level = UsersService.actorLevel(actor);
    if (level !== 'custom') return 'full';
    const grant = await this.prisma.dataAccessGrant.findUnique({
      where: { grantedToId_targetUserId: { grantedToId: actor.id, targetUserId: targetId } },
    });
    if (grant) return 'full';
    if ((actor.permissions || []).some((p) => p.startsWith('users:'))) return 'noPay';
    return null;
  }

  async fullProfile(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        roles: true,
        phone: true,
        passportNo: true,
        hiredAt: true,
        baseSalary: true,
        hourlyRate: true,
        bonusPercent: true,
        kpiTargetPct: true,
        kpiAutoStepPct: true,
        kpiMaxPct: true,
        createdAt: true,
        customRoleId: true,
        customRole: { select: { id: true, name: true, isActive: true, permissions: true } },
      },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');

    const now = new Date();
    // Границы месяца/года — в Asia/Dushanbe, иначе у юзера, открывшего
    // профиль в 04:00 ТJT 1-го числа, KPI считается за прошлый месяц.
    const monthStart = tjStartOfMonth(now);
    const monthEnd = tjEndOfMonth(now);
    const { y } = tjYMD(now);
    const yearStart = new Date(`${y}-01-01T00:00:00+05:00`);

    const [
      documents,
      salaryRecords,
      penalties,
      pendingPenaltiesAmount,
      salesMonthMap,
      salesYearMap,
      timeMonth,
      enrolledMonth,
      dailyReportsThisMonth,
      totalLeadsMonth,
      ownClientsMonth,
      bonusVolume,
    ] = await Promise.all([
      this.prisma.userDocument.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.salaryRecord.findMany({
        where: { userId: id },
        orderBy: { periodStart: 'desc' },
        take: 12,
      }),
      this.prisma.penalty.findMany({
        where: { userId: id },
        orderBy: { date: 'desc' },
        take: 50,
      }),
      this.prisma.penalty.aggregate({
        where: { userId: id, applied: false },
        _sum: { amount: true },
      }),
      managerSales(this.prisma, [id], { from: monthStart, to: monthEnd }),
      managerSales(this.prisma, [id], { from: yearStart }),
      this.prisma.timeEntry.aggregate({
        where: {
          userId: id,
          date: { gte: monthStart, lte: monthEnd },
        },
        // overtimeMinutes не суммируем — переработка убрана из системы.
        _sum: { totalMinutes: true, lateMinutes: true },
        _count: true,
      }),
      this.prisma.application.count({
        where: {
          managerId: id,
          // Закрытые за месяц заявки. Группа, а не один SUCCESSFUL_LEAD: пока
          // перенос строк не прогнали (он опт-ин, см. MIGRATE_LEAD_STATUSES),
          // строки ещё носят ENROLLED/COMPLETED, и KPI-план сотрудника
          // показал бы ноль закрытых.
          status: { in: FINISHED_APPLICATION_STATUSES },
          updatedAt: { gte: monthStart, lte: monthEnd },
        },
      }),
      this.prisma.dailyReport.findMany({
        where: { userId: id, date: { gte: monthStart, lte: monthEnd } },
        orderBy: { date: 'desc' },
      }),
      this.prisma.application.count({
        where: { createdAt: { gte: monthStart, lte: monthEnd } },
      }),
      this.prisma.application.count({
        where: {
          managerId: id,
          createdAt: { gte: monthStart, lte: monthEnd },
        },
      }),
      // Бонусный объём текущего месяца — тот же расчёт, что у
      // бухгалтера на экране Зарплаты (common/manager-bonus-volume.ts).
      // Нужен, чтобы отдать ДЕЙСТВУЮЩУЮ ставку комиссии, а не сырой
      // персональный override (у всех, кто на сетке, он равен 0 —
      // и досье показывало «Бонус % с продаж: 0%» при 6% в зарплате).
      managerBonusVolume(this.prisma, id, now),
    ]);

    // Ставка — по сетке, одна для всех (персонального процента больше нет).
    const bonus = effectiveManagerBonus(bonusVolume.volume);

    const target = user.kpiTargetPct ?? 1;
    const requiredClosed = Math.ceil((totalLeadsMonth * target) / 100);
    const kpiAchievedPct =
      totalLeadsMonth > 0
        ? Math.round((enrolledMonth / totalLeadsMonth) * 1000) / 10
        : 0;

    return {
      user,
      documents,
      salary: {
        records: salaryRecords,
        baseSalary: user.baseSalary || 0,
        hourlyRate: user.hourlyRate || 0,
        /** Ставка этого месяца по сетке (персонального процента больше нет). */
        bonusPercent: bonus.percent,
        /** Ставка, которая применяется к объёму этого месяца. */
        bonusPercentEffective: bonus.percent,
        /** Всегда 'BAND'. */
        bonusSource: bonus.source,
        /** Полоса объёма этого месяца. */
        bonusBand: {
          key: bonus.band.key,
          minAmount: bonus.band.minAmount,
          maxAmount: bonus.band.maxAmount, // null = без верхней границы
          percent: bonus.band.percent,
        },
        /** Объём (одобренные платежи, в сомони) за календарный месяц. */
        bonusVolume: Math.round(bonusVolume.volume * 100) / 100,
        bonusPeriodStart: bonusVolume.periodStart,
        bonusPeriodEnd: bonusVolume.periodEnd,
        /** Набрано / ставка / до следующей ставки — полоска прогресса. */
        bonusProgress: managerBonusProgress(bonusVolume),
      },
      penalties: {
        list: penalties,
        pendingTotal: pendingPenaltiesAmount._sum.amount || 0,
      },
      // «Продажи» — по правилу зарплаты (common/manager-sales.ts);
      // ручные приходы — отдельно (monthOtherIncome), валюты — monthOther.
      sales: (({ m: salesMonth, y: salesYear }) => ({
        monthAmount: salesMonth.deals,
        monthCount: salesMonth.dealsCount,
        monthOther: salesMonth.nonTjs,
        monthOtherIncome: salesMonth.other,
        monthOtherIncomeCount: salesMonth.otherCount,
        yearAmount: salesYear.deals,
        yearCount: salesYear.dealsCount,
        yearOther: salesYear.nonTjs,
        yearOtherIncome: salesYear.other,
      }))({ m: salesMonthMap.get(id)!, y: salesYearMap.get(id)! }),
      attendance: {
        workedMinutes: timeMonth._sum.totalMinutes || 0,
        lateMinutes: timeMonth._sum.lateMinutes || 0,
        daysWorked: timeMonth._count,
      },
      kpi: {
        targetPct: target,
        totalLeadsMonth,
        ownClientsMonth,
        enrolledMonth,
        requiredClosed,
        achievedPct: kpiAchievedPct,
        onTrack: enrolledMonth >= requiredClosed,
      },
      dailyReports: dailyReportsThisMonth,
    };
  }

  async addDocument(userId: string, doc: {
    type: string;
    url: string;
    originalName?: string;
    size?: number;
    comment?: string;
  }) {
    await this.findOne(userId);
    const VALID = ['PASSPORT', 'PHOTO', 'CONTRACT', 'DIPLOMA', 'OFFER', 'OTHER'];
    const t = (doc.type || 'OTHER').toUpperCase();
    if (!VALID.includes(t)) throw new BadRequestException('Неверный тип документа');
    return this.prisma.userDocument.create({
      data: {
        userId,
        type: t as any,
        url: doc.url,
        originalName: doc.originalName,
        size: doc.size,
        comment: doc.comment?.trim() || null,
      },
    });
  }

  async deleteDocument(userId: string, documentId: string) {
    const doc = await this.prisma.userDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc) throw new NotFoundException('Документ не найден');
    if (doc.userId !== userId) {
      throw new BadRequestException('Этот документ не принадлежит указанному сотруднику');
    }
    return this.prisma.userDocument.delete({ where: { id: documentId } });
  }

  /**
   * Обновить мета-данные документа (тип, комментарий). Сам файл не
   * меняется — для замены файла нужен delete + upload. Закрывает
   * "U" в CRUD по ТЗ §1.
   */
  async updateDocument(
    userId: string,
    documentId: string,
    patch: { type?: string; comment?: string },
  ) {
    const doc = await this.prisma.userDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc) throw new NotFoundException('Документ не найден');
    if (doc.userId !== userId) {
      throw new BadRequestException('Этот документ не принадлежит указанному сотруднику');
    }
    const VALID = ['PASSPORT', 'PHOTO', 'CONTRACT', 'DIPLOMA', 'OFFER', 'OTHER'];
    const data: any = {};
    if (patch.type !== undefined) {
      const t = patch.type.toUpperCase();
      if (!VALID.includes(t)) throw new BadRequestException('Неверный тип документа');
      data.type = t;
    }
    if (patch.comment !== undefined) {
      data.comment = patch.comment?.trim() || null;
    }
    return this.prisma.userDocument.update({ where: { id: documentId }, data });
  }

  // ===== Точечный доступ к данным сотрудника =====

  /**
   * Может ли viewer смотреть полный профиль targetId:
   *  - ADMIN — всегда
   *  - сам сотрудник — свой профиль
   *  - есть активный DataAccessGrant
   */
  /** Выдать доступ к данным targetUserId пользователю grantedToId. */
  async grantAccess(grantedToId: string, targetUserId: string, grantedById: string) {
    if (grantedToId === targetUserId) {
      throw new BadRequestException('Сотрудник и так видит свои данные');
    }
    const [grantee, target] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: grantedToId } }),
      this.prisma.user.findUnique({ where: { id: targetUserId } }),
    ]);
    if (!grantee || !target) throw new NotFoundException('Пользователь не найден');
    return this.prisma.dataAccessGrant.upsert({
      where: { grantedToId_targetUserId: { grantedToId, targetUserId } },
      create: { grantedToId, targetUserId, grantedById },
      update: {},
    });
  }

  async revokeAccess(grantedToId: string, targetUserId: string) {
    await this.prisma.dataAccessGrant.deleteMany({
      where: { grantedToId, targetUserId },
    });
    return { ok: true };
  }

  /** Список тех, кому выдан доступ к данным targetUserId. */
  async listGrantsForTarget(targetUserId: string) {
    const grants = await this.prisma.dataAccessGrant.findMany({
      where: { targetUserId },
      include: {
        grantedTo: { select: { id: true, fullName: true, email: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return grants.map((g) => ({
      id: g.id,
      grantedTo: g.grantedTo,
      createdAt: g.createdAt,
    }));
  }

  async create(dto: CreateUserDto, actor?: { id: string; role?: string; roles?: string[]; hasCustomRole?: boolean }) {
    const email = (dto.email || '').trim().toLowerCase();
    const rawPassword = (dto.password || '').trim();

    // Раньше роль принималась любой: бухгалтер создавал второй аккаунт
    // FOUNDER и получал доступ ко всему. Роль «Основатель» не выдаётся
    // через API вообще (основатель в системе один — сидер), кастомную роль
    // назначает только основатель, оклады задают основатель/админ/бухгалтер.
    const level = UsersService.actorLevel(actor);
    if (dto.role === 'FOUNDER') {
      throw new ForbiddenException('Роль «Основатель» назначить нельзя');
    }
    if (dto.customRoleId && level !== 'founder') {
      throw new ForbiddenException('Кастомную роль назначает только основатель');
    }
    if (level === 'custom') {
      if (dto.role !== 'SALES_MANAGER' && dto.role !== 'CLIENT_MANAGER') {
        throw new ForbiddenException('Можно создать только менеджера');
      }
      const payFields = ['baseSalary', 'hourlyRate', 'bonusPercent', 'kpiTargetPct', 'kpiAutoStepPct', 'kpiMaxPct'] as const;
      if (payFields.some((f) => (dto as any)[f] !== undefined)) {
        throw new ForbiddenException('Оклад и KPI задают основатель, админ или бухгалтер');
      }
    }

    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email уже занят');

    // Если FOUNDER при создании сразу указал кастомную роль — проверим
    // что она существует и активна. Без этой проверки в БД мог уехать
    // мёртвый customRoleId (роль удалили / выключили).
    let customRoleId: string | null = null;
    if (dto.customRoleId) {
      const role = await this.prisma.customRole.findUnique({
        where: { id: dto.customRoleId },
        select: { id: true, isActive: true },
      });
      if (!role) throw new BadRequestException('Кастомная роль не найдена');
      if (!role.isActive) throw new BadRequestException('Кастомная роль отключена');
      customRoleId = role.id;
    }

    const password = await bcrypt.hash(rawPassword, 10);

    // Принимаем salary/HR поля сразу при создании — иначе FOUNDER вынужден
    // делать второй вызов PATCH /users/:id чтобы выставить bonusPercent,
    // baseSalary, hourlyRate и т.п. Те же поля принимает update.
    const data: any = {
      email, password, fullName: dto.fullName, role: dto.role,
      customRoleId,
    };
    if (dto.phone !== undefined) data.phone = dto.phone?.trim() || null;
    if (dto.passportNo !== undefined) data.passportNo = dto.passportNo?.trim() || null;
    if (dto.hiredAt !== undefined) data.hiredAt = dto.hiredAt ? new Date(dto.hiredAt) : null;
    if (dto.baseSalary !== undefined) data.baseSalary = dto.baseSalary;
    if (dto.hourlyRate !== undefined) data.hourlyRate = dto.hourlyRate;
    // bonusPercent больше не пишем: персональный процент отменён, бонус у
    // всех по одной сетке (common/bonus-bands.ts).
    if (dto.kpiTargetPct !== undefined) data.kpiTargetPct = dto.kpiTargetPct;
    if (dto.kpiAutoStepPct !== undefined) data.kpiAutoStepPct = dto.kpiAutoStepPct;
    if (dto.kpiMaxPct !== undefined) data.kpiMaxPct = dto.kpiMaxPct;

    const user = await this.prisma.user.create({
      data,
      select: {
        id: true, email: true, fullName: true, role: true, createdAt: true,
        customRoleId: true,
        baseSalary: true, hourlyRate: true, bonusPercent: true,
        customRole: { select: { id: true, name: true, isActive: true } },
      },
    });
    return user;
  }

  async update(id: string, dto: UpdateUserDto, requester?: { id: string; role?: string; roles?: string[]; hasCustomRole?: boolean }) {
    const target = await this.findOne(id);

    // Роль меняет только основатель (как PUT /users/:id/roles), «Основатель»
    // не выдаётся вообще. Оклады/KPI, пароль и email чужого сотрудника —
    // основатель, админ, бухгалтер; кастомная роль правит только карточку.
    if (requester) {
      const level = UsersService.actorLevel(requester);
      const isSelf = requester.id === id;
      if (dto.role !== undefined && dto.role !== target.role) {
        if (dto.role === 'FOUNDER') throw new ForbiddenException('Роль «Основатель» назначить нельзя');
        if (level !== 'founder') throw new ForbiddenException('Роль меняет только основатель');
      }
      if (level === 'custom') {
        const locked = ['baseSalary', 'hourlyRate', 'bonusPercent', 'kpiTargetPct', 'kpiAutoStepPct', 'kpiMaxPct', 'email'] as const;
        if (locked.some((f) => (dto as any)[f] !== undefined)) {
          throw new ForbiddenException('Оклад, KPI и email меняют основатель, админ или бухгалтер');
        }
        if (dto.password && !isSelf) {
          throw new ForbiddenException('Пароль сотрудника меняют основатель, админ или бухгалтер');
        }
      }
    }

    // КРИТИЧНАЯ ЗАЩИТА: аккаунт FOUNDER может править ТОЛЬКО сам FOUNDER.
    // Без этой проверки любой ADMIN/ACCOUNTANT мог бы сменить пароль
    // основателю и захватить контроль над системой через PATCH /users/<founder_id>.
    if (isFounder(target as any) && requester) {
      const isRequesterFounder = requester.role === 'FOUNDER' || (requester.roles || []).includes('FOUNDER');
      const isSelf = requester.id === target.id;
      if (!isRequesterFounder && !isSelf) {
        throw new ForbiddenException('Аккаунт FOUNDER может править только сам FOUNDER');
      }
    }

    const data: any = {};
    // DTO уже tримит/лоуэркейсит через @Transform — здесь повторно
    // нормализуем только как страховка (на случай если кто-то когда-то
    // вызовет сервис не через HTTP-pipeline, например из тестов или сидера).
    if (dto.email) data.email = dto.email.trim().toLowerCase();
    if (dto.fullName) data.fullName = dto.fullName.trim();
    if (dto.phone !== undefined) data.phone = dto.phone?.trim() || null;
    if (dto.passportNo !== undefined) data.passportNo = dto.passportNo?.trim() || null;
    if (dto.hiredAt !== undefined) data.hiredAt = dto.hiredAt ? new Date(dto.hiredAt) : null;
    if (dto.baseSalary !== undefined) data.baseSalary = dto.baseSalary;
    if (dto.hourlyRate !== undefined) data.hourlyRate = dto.hourlyRate;
    // bonusPercent больше не пишем: персональный процент отменён, бонус у
    // всех по одной сетке (common/bonus-bands.ts).
    if (dto.kpiTargetPct !== undefined) data.kpiTargetPct = dto.kpiTargetPct;
    if (dto.kpiAutoStepPct !== undefined) data.kpiAutoStepPct = dto.kpiAutoStepPct;
    if (dto.kpiMaxPct !== undefined) data.kpiMaxPct = dto.kpiMaxPct;

    // Защита: если меняем роль с ADMIN на не-ADMIN — убедимся что это
    // не последний ADMIN. Иначе систему некому будет администрировать.
    if (dto.role && dto.role !== 'ADMIN' && target.role === 'ADMIN') {
      // Мульти-роли (ТЗ §2): юзер с ADMIN в roles[] тоже считается админом.
      // Без OR на roles[] эта защита блокировала легитимный сценарий, когда
      // у компании primary-ADMIN один, но есть юзер с ADMIN как secondary.
      const adminCount = await this.prisma.user.count({
        where: {
          OR: [
            { role: 'ADMIN' },
            { roles: { has: 'ADMIN' } },
          ],
        },
      });
      if (adminCount <= 1) {
        throw new BadRequestException(
          'Нельзя понизить роль последнего администратора. Сначала создай другого ADMIN.',
        );
      }
    }
    // То же для FOUNDER — он один в системе. isFounder() учитывает
    // мульти-роли (FOUNDER в primary ИЛИ в roles[]).
    if (dto.role && dto.role !== 'FOUNDER' && isFounder(target as any)) {
      // FOUNDER может быть и в roles[] (multi-role grant). Считаем общее
      // число «эффективных FOUNDER» — единственный быть не должен.
      const founderCount = await this.prisma.user.count({
        where: {
          OR: [
            { role: 'FOUNDER' },
            { roles: { has: 'FOUNDER' } },
          ],
        },
      });
      if (founderCount <= 1) {
        throw new BadRequestException('Нельзя снять роль с единственного FOUNDER.');
      }
    }
    if (dto.role) data.role = dto.role;

    let passwordToVerify: string | null = null;
    if (dto.password) {
      const trimmed = dto.password.trim();
      data.password = await bcrypt.hash(trimmed, 10);
      passwordToVerify = trimmed;
    }

    const user = await this.prisma.user.update({
      where: { id },
      data,
      // Включаем password в результат ТОЛЬКО для self-проверки ниже,
      // потом скрываем перед возвратом клиенту.
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        phone: true,
        passportNo: true,
        hiredAt: true,
        baseSalary: true,
        hourlyRate: true,
        bonusPercent: true,
        kpiTargetPct: true,
        kpiAutoStepPct: true,
        kpiMaxPct: true,
        createdAt: true,
        password: passwordToVerify ? true : false,
      } as any,
    });

    // Sanity-check: если пользователь сменил пароль — сразу проверяем что
    // bcrypt.compare с тем же паролем даёт true. Если нет — значит запись
    // в БД не сохранилась корректно (transaction issue, пишущий триггер,
    // и т.п.). Тогда явно бросаем ошибку, чтобы admin увидел проблему,
    // а не получил ложный «успех».
    if (passwordToVerify) {
      const stored = (user as any).password as string | undefined;
      const ok = stored ? await bcrypt.compare(passwordToVerify, stored) : false;
      if (!ok) {
        this.logger.error(
          `Password verify failed after update for user ${id} — stored hash does not match the new password`,
        );
        throw new InternalServerErrorException(
          'Не удалось сохранить новый пароль. Попробуйте ещё раз.',
        );
      }
      this.logger.log(`Password updated and verified for user ${id} (${user.email})`);
    }

    // Если admin сменил primary role — шлём realtime kick, как в setRoles
    // (ТЗ §2 «права передаются основателем»). Иначе у target в JWT остаётся
    // старая роль, новые права применятся только после релогина.
    if (dto.role && (!requester || requester.id !== id)) {
      this.realtime.emitUser(id, 'user:roles-updated', {
        role: (user as any).role,
        roles: (user as any).roles || [],
      });
    }

    // Когда admin меняет user'у пароль через этот endpoint — текущий JWT
    // у юзера ещё валиден, без kick он продолжает работать со старой
    // сессией ~7 дней. Это разрывает смысл смены пароля (особенно
    // important когда admin меняет пароль для блокировки подозрительной
    // активности). Эмитим тот же realtime event, что и при смене роли —
    // фронт делает logout, юзер вынужден залогиниться новым паролем.
    if (dto.password && (!requester || requester.id !== id)) {
      // Старые сессии закрываем сразу: иначе тот, кто знал старый пароль,
      // оставался в системе до истечения токена.
      await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      this.realtime.emitUser(id, 'user:roles-updated', {
        reason: 'password-changed-by-admin',
      });
      this.realtime.disconnectUser(id, 'password-changed');
    }

    // Скрываем password из ответа клиенту; присутствие — только основателю
    // через /users/presence.
    const { password: _omit, lastSeenAt: _seen, lastLoginAt: _login, ...safe } = user as any;
    return safe;
  }

  /**
   * «Уволить» вместо удаления. Раньше DELETE стирал сотрудника каскадом —
   * вместе с выплаченными зарплатами, штрафами, учётом времени, документами
   * и сообщениями. Теперь: isActive=false, все сессии отозваны, сокет
   * отключён, из распределения лидов и назначений он пропадает. История
   * остаётся; вернуть — restore().
   */
  async remove(id: string, requester?: { id: string; role?: string; roles?: string[] }) {
    return this.dismiss(id, requester);
  }

  /**
   * Что числится за сотрудником и кому это можно передать — для окна
   * «Уволить» и кнопки «Передать дела» у уже уволенного.
   */
  async handoverInfo(id: string) {
    const target = await this.findOne(id);
    const [counts, targets, candidates] = await Promise.all([
      handoverCounts(this.prisma, id),
      autoTargets(this.prisma, id),
      this.prisma.user.findMany({
        where: { isActive: true, id: { not: id } },
        select: { id: true, fullName: true, role: true, roles: true },
        orderBy: { fullName: 'asc' },
      }),
    ]);
    return {
      user: { id: target.id, fullName: target.fullName, isActive: target.isActive },
      counts,
      total: handoverTotal(counts),
      autoTargets: targets,
      candidates,
    };
  }

  /**
   * Передать дела уже уволенного сотрудника (уволенные до появления
   * передачи — их заявки, студенты и задачи так и висят на них).
   */
  async handoverDismissed(id: string, requester: { id: string }, body: any) {
    const target = await this.findOne(id);
    if (target.isActive) {
      throw new BadRequestException('Сотрудник работает — дела передаются при увольнении');
    }
    const { mode, toUserId } = parseHandover(body);
    await validateHandoverTarget(this.prisma, id, toUserId);
    const handover = await this.prisma.$transaction(
      (tx) => performHandover(tx, id, { mode, toUserId, actorId: requester?.id ?? null }),
      { timeout: 60_000, maxWait: 10_000 },
    );
    this.logger.log(`Handover of ${id} (${mode}${toUserId ? ' → ' + toUserId : ''}) by ${requester?.id ?? 'system'}`);
    return { ok: true, handover };
  }

  async dismiss(id: string, requester?: { id: string; role?: string; roles?: string[] }, body?: any) {
    const target = await this.findOne(id);

    if (isFounder(target as any)) {
      throw new ForbiddenException('Основателя уволить нельзя');
    }
    if (!target.isActive) {
      throw new BadRequestException('Сотрудник уже уволен');
    }
    // Нельзя уволить последнего действующего администратора.
    const isAdminTarget = target.role === 'ADMIN' || ((target as any).roles || []).includes('ADMIN');
    if (isAdminTarget) {
      const adminCount = await this.prisma.user.count({
        where: { isActive: true, OR: [{ role: 'ADMIN' }, { roles: { has: 'ADMIN' } }] },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Нельзя уволить последнего администратора');
      }
    }

    // Кому передать дела: выбранному сотруднику (USER) или по нагрузке
    // (AUTO — по умолчанию, в т.ч. для старого DELETE /users/:id).
    const { mode, toUserId } = parseHandover(body);
    await validateHandoverTarget(this.prisma, id, toUserId);

    // Передача дел, увольнение и отзыв сессий — одной транзакцией:
    // «уволен, а заявки всё ещё на нём» получиться не может.
    const handover = await this.prisma.$transaction(
      async (tx) => {
        const result = await performHandover(tx, id, { mode, toUserId, actorId: requester?.id ?? null });
        await tx.user.update({ where: { id }, data: { isActive: false } });
        await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        return result;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    // Мгновенно выкидываем из открытых вкладок: событие → фронт делает logout,
    // затем рвём сокеты (сокет больше не получает ни одного события).
    this.realtime.emitUser(id, 'user:deleted', { reason: 'dismissed' });
    this.realtime.disconnectUser(id, 'dismissed');
    // Списки у остальных (заявки, студенты, задачи, чат) обновятся сами.
    this.realtime.emitStaff('user:dismissed', { userId: id });
    this.logger.log(`User ${id} dismissed by ${requester?.id ?? 'system'} (handover ${mode}${toUserId ? ' → ' + toUserId : ''})`);
    return { ok: true, isActive: false, handover };
  }

  /** Вернуть уволенного сотрудника (войти он сможет заново). */
  async restore(id: string) {
    await this.findOne(id);
    await this.prisma.user.update({ where: { id }, data: { isActive: true } });
    return { ok: true, isActive: true };
  }

  /**
   * FOUNDER задаёт список дополнительных ролей сотрудника (User.roles[]).
   * Первая роль в массиве становится primary (User.role) для UI/историч.
   * проверок. Если массив пустой — выставляется default SALES_MANAGER.
   * FOUNDER нельзя добавить через этот endpoint (он единственный, только сидер).
   */
  async setRoles(targetId: string, requestedRoles: any[], byFounderId: string) {
    const VALID: any[] = ['ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'CLIENT_MANAGER'];
    const cleaned: any[] = Array.from(
      new Set(requestedRoles.filter((r) => VALID.includes(r))),
    );
    if (cleaned.length === 0) cleaned.push('SALES_MANAGER');

    const target = await this.findOne(targetId);
    // FOUNDER не разжаловать. Чтобы передать FOUNDER, сначала нужно вручную
    // создать ещё одного FOUNDER через seed/cli — endpoint не позволяет.
    // isFounder() — primary или roles[]; раньше primary-only пропускал
    // юзера с FOUNDER в secondary roles[] (другой FOUNDER мог его понизить).
    if (isFounder(target as any) && targetId !== byFounderId) {
      throw new BadRequestException('Нельзя изменить роли другого FOUNDER через этот endpoint');
    }
    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: {
        role: cleaned[0],
        roles: cleaned,
      },
      select: {
        id: true, email: true, fullName: true, role: true, roles: true,
      },
    });

    // По ТЗ §2 «права передаются основателем» — после смены ролей юзер
    // должен сразу получить новые права. JWT уже подписан старыми ролями,
    // backend RolesGuard читает из JWT, поэтому **до релогина** обновление
    // не применится. Шлём realtime-уведомление в комнату пользователя,
    // фронт показывает toast «права обновлены, перелогиньтесь» и форсит
    // logout через несколько секунд.
    if (targetId !== byFounderId) {
      this.realtime.emitUser(targetId, 'user:roles-updated', {
        role: updated.role,
        roles: updated.roles,
      });
    }

    return updated;
  }

  /**
   * Привязка / отвязка custom-роли (ТЗ-доработка). Только FOUNDER.
   * customRoleId=null убирает привязку — юзер работает по базовым ролям.
   */
  async setCustomRole(targetId: string, customRoleId: string | null) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Пользователь не найден');

    if (customRoleId) {
      const role = await this.prisma.customRole.findUnique({ where: { id: customRoleId } });
      if (!role) throw new BadRequestException('Кастомная роль не найдена');
      if (!role.isActive) throw new BadRequestException('Кастомная роль отключена');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { customRoleId },
      select: {
        id: true, email: true, fullName: true, role: true, roles: true,
        customRoleId: true,
        customRole: { select: { id: true, name: true, permissions: true } },
      },
    });
    // Permissions берутся из БД при validate каждого JWT —
    // изменения применятся со следующего запроса. realtime-уведомление
    // нужно чтобы Sidebar фронта перерисовался без F5.
    this.realtime.emitUser(targetId, 'user:roles-updated', {
      role: updated.role,
      roles: updated.roles,
      customRoleId: updated.customRoleId,
      customRole: updated.customRole,
    });
    return updated;
  }

  /**
   * Массовое чтение зарплатных полей — для вкладки «Зарплата» в /settings.
   * FOUNDER видит всех сотрудников + их baseSalary/hourlyRate/bonusPercent.
   * FOUNDER исключаем — у него своя оплата вне системы.
   *
   * overtimeMultiplier больше НЕ отдаём: настройка существовала только ради
   * переработки, которая убрана. Колонка User.overtimeMultiplier осталась
   * в схеме со своими значениями, но не читается и не редактируется.
   */
  async listSalarySettings() {
    const users = await this.prisma.user.findMany({
      // Уволенным оклад не настраивают — их в списке нет.
      where: { role: { not: 'FOUNDER' as any }, isActive: true },
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
      select: {
        id: true, fullName: true, email: true, role: true,
        baseSalary: true, hourlyRate: true,
        customRole: { select: { id: true, name: true } },
      },
    });
    // По ТЗ: «почасовая» считается автоматически = oklad / monthHours.
    // monthHours = сумма (end-start-lunch) по всем рабочим дням ТЕКУЩЕГО
    // месяца из effective schedule сотрудника. Обед НЕ считается.
    // График сейчас один на компанию (личных нет — см. getEffectiveScheduleForUser),
    // поэтому часы месяца считаем ОДИН раз, а не по сотруднику: раньше на
    // 40 сотрудников это было 40 одинаковых расчётов и ~6 с ожидания.
    const now = new Date();
    const { monthHours, workdays } = await this.settings.computeMonthlyWorkHoursForUser(users[0]?.id ?? '', now);
    return Promise.all(
      users.map(async (u) => {
        const computedHourly = u.baseSalary && monthHours > 0
          ? Math.round((u.baseSalary / monthHours) * 100) / 100
          : 0;
        return {
          ...u,
          monthHours,
          workdays,
          computedHourly,
        };
      }),
    );
  }

  /** Точечная правка зарплатных полей. FOUNDER-only через гард на
   *  controller. Все поля опц. — отправляются только те что меняются. */
  async updateSalary(targetId: string, dto: {
    baseSalary?: number;
    hourlyRate?: number;
  }) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, roles: true },
    });
    if (!target) throw new NotFoundException('Пользователь не найден');
    if (isFounder(target as any)) {
      throw new BadRequestException('Зарплату FOUNDER нельзя редактировать через систему');
    }

    const num = (v: any, name: string, max: number) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new BadRequestException(`${name}: должно быть числом`);
      if (n < 0) throw new BadRequestException(`${name}: не может быть отрицательным`);
      if (n > max) throw new BadRequestException(`${name}: слишком большое значение (макс. ${max})`);
      return n;
    };

    const data: any = {};
    if (dto.baseSalary !== undefined) data.baseSalary = num(dto.baseSalary, 'baseSalary', 1_000_000);
    if (dto.hourlyRate !== undefined) data.hourlyRate = num(dto.hourlyRate, 'hourlyRate', 100_000);
    // bonusPercent не принимаем: персональный процент отменён, бонус у всех
    // по сетке (common/bonus-bands.ts). Колонка в БД осталась, не читается.
    // overtimeMultiplier намеренно не принимаем: переработка убрана,
    // множитель больше ни на что не влияет (колонка в БД сохранена).

    return this.prisma.user.update({
      where: { id: targetId },
      data,
      select: {
        id: true, fullName: true, email: true, role: true,
        baseSalary: true, hourlyRate: true,
      },
    });
  }
}
