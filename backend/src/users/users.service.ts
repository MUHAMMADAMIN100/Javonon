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
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isElevated, isFounder } from '../auth/role-utils';
import { tjStartOfMonth, tjEndOfMonth, tjYMD } from '../common/tj-time';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    private settings: SettingsService,
  ) {}

  async findAll(filters: { search?: string } = {}) {
    const search = (filters.search || '').trim();
    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { fullName: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, fullName: true, role: true, createdAt: true,
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
      salesMonthAgg,
      salesYearAgg,
      timeMonth,
      enrolledMonth,
      dailyReportsThisMonth,
      totalLeadsMonth,
      ownClientsMonth,
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
      this.prisma.transaction.aggregate({
        where: {
          managerId: id,
          type: 'INCOME',
          // Bug #25: исключаем reversed INCOME (CANCEL сделки / ручной refund),
          // иначе профиль показывает завышенные «продажи за месяц».
          reversedAt: null,
          date: { gte: monthStart, lte: monthEnd },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transaction.aggregate({
        where: {
          managerId: id,
          type: 'INCOME',
          reversedAt: null,
          date: { gte: yearStart },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.timeEntry.aggregate({
        where: {
          userId: id,
          date: { gte: monthStart, lte: monthEnd },
        },
        _sum: { totalMinutes: true, lateMinutes: true, overtimeMinutes: true },
        _count: true,
      }),
      this.prisma.application.count({
        where: {
          managerId: id,
          status: 'ENROLLED',
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
    ]);

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
        bonusPercent: user.bonusPercent || 0,
      },
      penalties: {
        list: penalties,
        pendingTotal: pendingPenaltiesAmount._sum.amount || 0,
      },
      sales: {
        monthAmount: salesMonthAgg._sum.amount || 0,
        monthCount: salesMonthAgg._count,
        yearAmount: salesYearAgg._sum.amount || 0,
        yearCount: salesYearAgg._count,
      },
      attendance: {
        workedMinutes: timeMonth._sum.totalMinutes || 0,
        lateMinutes: timeMonth._sum.lateMinutes || 0,
        overtimeMinutes: timeMonth._sum.overtimeMinutes || 0,
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
  async canViewProfile(
    viewerId: string,
    viewerRole: string,
    targetId: string,
    viewerRoles?: string[],
  ) {
    // Elevated (FOUNDER/ADMIN/ACCOUNTANT с мульти-роли). Раньше строго
    // `viewerRole === 'ADMIN'` — FOUNDER не мог открыть чужой профиль,
    // secondary-ADMIN/ACCOUNTANT тоже обходился.
    if (isElevated({ role: viewerRole, roles: viewerRoles } as any)) return true;
    if (viewerId === targetId) return true;
    const grant = await this.prisma.dataAccessGrant.findUnique({
      where: { grantedToId_targetUserId: { grantedToId: viewerId, targetUserId: targetId } },
    });
    return !!grant;
  }

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

  async create(dto: CreateUserDto) {
    const email = (dto.email || '').trim().toLowerCase();
    const rawPassword = (dto.password || '').trim();

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
    if (dto.bonusPercent !== undefined) data.bonusPercent = dto.bonusPercent;
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

  async update(id: string, dto: UpdateUserDto, requester?: { id: string; role?: string; roles?: string[] }) {
    const target = await this.findOne(id);

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
    if (dto.bonusPercent !== undefined) data.bonusPercent = dto.bonusPercent;
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
      this.realtime.emitUser(id, 'user:roles-updated', {
        reason: 'password-changed-by-admin',
      });
    }

    // Скрываем password из ответа клиенту
    const { password: _omit, ...safe } = user as any;
    return safe;
  }

  async remove(id: string, requester?: { id: string; role?: string; roles?: string[] }) {
    const target = await this.findOne(id);

    // FOUNDER аккаунт может удалить только сам FOUNDER (через CLI/сидер).
    if (isFounder(target as any) && requester) {
      const isRequesterFounder = requester.role === 'FOUNDER' || (requester.roles || []).includes('FOUNDER');
      if (!isRequesterFounder) {
        throw new ForbiddenException('Удалить FOUNDER может только FOUNDER');
      }
    }

    // Защита: нельзя удалить последнего ADMIN
    if (target.role === 'ADMIN') {
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
          'Нельзя удалить последнего администратора',
        );
      }
    }
    // То же для FOUNDER — isFounder() учитывает мульти-роли.
    if (isFounder(target as any)) {
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
        throw new BadRequestException('Нельзя удалить единственного FOUNDER');
      }
    }
    // Шлём kick ПЕРЕД delete (после уже не сможем emit — у пользователя
    // удалена сессия в БД, гейтвей всё равно дойдёт по WS), чтобы Bob,
    // залогиненный в браузере, моментально получил logout. Без этого его
    // JWT работал бы до истечения (~7 дней) — «удалённый» сотрудник
    // продолжает иметь доступ.
    this.realtime.emitUser(id, 'user:deleted', { reason: 'removed-by-admin' });
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
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
   * FOUNDER видит всех сотрудников + их baseSalary/hourlyRate/bonusPercent/
   * overtimeMultiplier. FOUNDER исключаем — у него своя оплата вне системы.
   */
  async listSalarySettings() {
    const users = await this.prisma.user.findMany({
      where: { role: { not: 'FOUNDER' as any } },
      orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
      select: {
        id: true, fullName: true, email: true, role: true,
        baseSalary: true, hourlyRate: true, bonusPercent: true,
        overtimeMultiplier: true,
        customRole: { select: { id: true, name: true } },
      },
    });
    // По ТЗ: «почасовая» считается автоматически = oklad / monthHours.
    // monthHours = сумма (end-start-lunch) по всем рабочим дням ТЕКУЩЕГО
    // месяца из effective schedule сотрудника. Обед НЕ считается.
    const now = new Date();
    return Promise.all(
      users.map(async (u) => {
        const { monthHours, workdays } = await this.settings.computeMonthlyWorkHoursForUser(u.id, now);
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
    bonusPercent?: number;
    overtimeMultiplier?: number;
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
    if (dto.bonusPercent !== undefined) {
      const p = num(dto.bonusPercent, 'bonusPercent', 100);
      data.bonusPercent = p;
    }
    if (dto.overtimeMultiplier !== undefined) {
      const m = num(dto.overtimeMultiplier, 'overtimeMultiplier', 10);
      data.overtimeMultiplier = m;
    }

    return this.prisma.user.update({
      where: { id: targetId },
      data,
      select: {
        id: true, fullName: true, email: true, role: true,
        baseSalary: true, hourlyRate: true, bonusPercent: true,
        overtimeMultiplier: true,
      },
    });
  }
}
