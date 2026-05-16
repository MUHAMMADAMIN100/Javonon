import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private prisma: PrismaService) {}

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
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
    });
    return users;
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
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
        phone: true,
        passportNo: true,
        hiredAt: true,
        baseSalary: true,
        hourlyRate: true,
        bonusPercent: true,
        kpiTargetPct: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const yearStart = new Date(now.getFullYear(), 0, 1);

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
          date: { gte: monthStart, lte: monthEnd },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transaction.aggregate({
        where: {
          managerId: id,
          type: 'INCOME',
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
    const VALID = ['PASSPORT', 'CONTRACT', 'DIPLOMA', 'OTHER'];
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

  // ===== Точечный доступ к данным сотрудника =====

  /**
   * Может ли viewer смотреть полный профиль targetId:
   *  - ADMIN — всегда
   *  - сам сотрудник — свой профиль
   *  - есть активный DataAccessGrant
   */
  async canViewProfile(viewerId: string, viewerRole: string, targetId: string) {
    if (viewerRole === 'ADMIN') return true;
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

    const password = await bcrypt.hash(rawPassword, 10);
    const user = await this.prisma.user.create({
      data: { email, password, fullName: dto.fullName, role: dto.role },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
    });
    return user;
  }

  async update(id: string, dto: UpdateUserDto) {
    const target = await this.findOne(id);
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

    // Защита: если меняем роль с ADMIN на не-ADMIN — убедимся что это
    // не последний ADMIN. Иначе систему некому будет администрировать.
    if (dto.role && dto.role !== 'ADMIN' && target.role === 'ADMIN') {
      const adminCount = await this.prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        throw new BadRequestException(
          'Нельзя понизить роль последнего администратора. Сначала создай другого ADMIN.',
        );
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

    // Скрываем password из ответа клиенту
    const { password: _omit, ...safe } = user as any;
    return safe;
  }

  async remove(id: string) {
    const target = await this.findOne(id);
    // Защита: нельзя удалить последнего ADMIN
    if (target.role === 'ADMIN') {
      const adminCount = await this.prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        throw new BadRequestException(
          'Нельзя удалить последнего администратора',
        );
      }
    }
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }
}
